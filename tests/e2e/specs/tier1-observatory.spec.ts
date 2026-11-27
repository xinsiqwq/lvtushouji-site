import zlib from 'node:zlib';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createExiflessJpeg, createSyntheticExifJpeg } from '../fixtures/exif-jpeg';
import { ApiClient, createApiClient } from '../helpers/api-client';
import {
  assertOnlyDarkSurface,
  attachErrorListeners,
  scanAntiAiTaste,
} from '../helpers/browser-checks';

interface SkyMessageRecord {
  type?: string;
  session?: string;
  payload?: Record<string, unknown>;
  state?: Record<string, unknown>;
  [key: string]: unknown;
}

let uniqueSeq = 0;

function nextTag(testInfo: TestInfo, prefix: string): string {
  uniqueSeq += 1;
  const proj = testInfo.project.name.replace(/[^a-z0-9]/gi, '');
  return `${prefix}-${proj}-${Date.now()}-${uniqueSeq}`;
}

function appendJpegComment(jpeg: Buffer, comment: string): Buffer {
  const textBytes = Buffer.from(comment, 'utf8');
  const len = 2 + textBytes.length;
  const com = Buffer.allocUnsafe(4 + textBytes.length);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(len, 2);
  textBytes.copy(com, 4);
  return Buffer.concat([jpeg.subarray(0, 2), com, jpeg.subarray(2)]);
}

async function installSkyBridgeSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as { __skyEvents?: unknown[] };
    win.__skyEvents = [];
    window.addEventListener('message', (event) => {
      const iframe = document.querySelector('iframe[src*="/stellarium/"]') as HTMLIFrameElement | null;
      const sourceMatches = !iframe?.contentWindow || event.source === iframe.contentWindow;
      if (
        event.origin === window.location.origin &&
        sourceMatches &&
        event.data &&
        typeof event.data === 'object' &&
        (event.data as { source?: string }).source === 'travel-sky-engine'
      ) {
        win.__skyEvents!.push(event.data);
      }
    });
  });
}

async function getActiveSkySession(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const iframe = document.querySelector(
      'iframe[src*="/stellarium/index.html?session="]',
    ) as HTMLIFrameElement | null;
    const src = iframe?.getAttribute('src');
    if (!src) return null;
    return new URL(src, window.location.origin).searchParams.get('session');
  });
}

async function getSkyEvents(page: Page): Promise<SkyMessageRecord[]> {
  return page.evaluate(() => {
    const win = window as unknown as { __skyEvents?: SkyMessageRecord[] };
    return win.__skyEvents ?? [];
  });
}

function extractStateFields(ev: SkyMessageRecord): Record<string, unknown> {
  if (ev.payload && typeof ev.payload === 'object') return ev.payload;
  if (ev.state && typeof ev.state === 'object') return ev.state;
  return ev;
}

async function getLatestSkyState(page: Page): Promise<Record<string, unknown> | null> {
  const activeSession = await getActiveSkySession(page);
  if (!activeSession) return null;
  const events = await getSkyEvents(page);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.session === activeSession && (ev.type === 'state' || ev.type === 'ready')) {
      return extractStateFields(ev);
    }
  }
  return null;
}

async function waitForStellariumReady(page: Page): Promise<string> {
  const iframe = page.locator('iframe[src*="/stellarium/index.html?session="]').first();
  await expect(iframe).toBeVisible({ timeout: 20_000 });
  const activeSession = await getActiveSkySession(page);
  expect(activeSession).toBeTruthy();

  await expect
    .poll(
      async () => {
        const events = await getSkyEvents(page);
        return events.some((ev) => {
          const s = extractStateFields(ev);
          return ev.session === activeSession && s.ready === true && s.starsLoaded === true;
        });
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return activeSession!;
}

async function pollSkyDateNear(
  page: Page,
  expectedIso: string,
  toleranceMs = 120_000,
  timeout = 8_000,
): Promise<number> {
  const expectedMs = Date.parse(expectedIso);
  let matchedMs = Number.NaN;
  await expect
    .poll(
      async () => {
        const st = await getLatestSkyState(page);
        const dateStr = typeof st?.date === 'string' ? st.date : '';
        const ms = Date.parse(dateStr);
        if (!Number.isFinite(ms)) return false;
        matchedMs = ms;
        return Math.abs(ms - expectedMs) < toleranceMs;
      },
      { timeout },
    )
    .toBe(true);
  return matchedMs;
}

async function openAtlasAndSelectJourney(
  page: Page,
  journeyTitle: string,
  stopName: string,
): Promise<void> {
  const libPromise = page.waitForResponse(
    (r) => r.url().includes('/api/library') && r.status() === 200,
    { timeout: 15_000 },
  );
  await page.goto('/atlas', { waitUntil: 'domcontentloaded' });
  await libPromise;

  const escaped = journeyTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleMatcher = new RegExp(escaped);
  const switchBtn = page
    .getByRole('button', { name: titleMatcher })
    .or(page.getByRole('tab', { name: titleMatcher }))
    .first();

  await expect
    .poll(
      async () => {
        const switchVis = await switchBtn.isVisible().catch(() => false);
        const stopVis = await page.getByText(stopName).first().isVisible().catch(() => false);
        return switchVis || stopVis;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  if (await switchBtn.isVisible().catch(() => false)) {
    await switchBtn.click();
  }
  await expect(page.getByText(stopName).first()).toBeVisible({ timeout: 15_000 });
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface SkyPngAnalysis {
  ok: boolean;
  reason: string;
}

function analyzeSkyCanvasPng(png: Buffer, label = 'skyCanvas'): SkyPngAnalysis {
  const fail = (reason: string): SkyPngAnalysis => ({ ok: false, reason });
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(pngSig)) {
    return fail(`${label} is not a valid PNG`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) return fail(`${label} truncated PNG chunk ${type}`);
    const data = png.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? -1;
      interlace = data[12] ?? -1;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width <= 200 || height <= 200) {
    return fail(`${label} unexpected dimensions ${width}x${height}`);
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType) || idatChunks.length === 0) {
    return fail(`${label} unsupported PNG format bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  if (inflated.length < height * (1 + stride)) {
    return fail(`${label} inflated PNG buffer truncated`);
  }

  const pixels = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y += 1) {
    const srcRow = y * (1 + stride);
    const filter = inflated[srcRow]!;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;
    for (let i = 0; i < stride; i += 1) {
      const raw = inflated[srcRow + 1 + i]!;
      const a = i >= bpp ? pixels[dstRow + i - bpp]! : 0;
      const b = y > 0 ? pixels[prevRow + i]! : 0;
      const c = y > 0 && i >= bpp ? pixels[prevRow + i - bpp]! : 0;
      let val: number;
      if (filter === 0) val = raw;
      else if (filter === 1) val = (raw + a) & 0xff;
      else if (filter === 2) val = (raw + b) & 0xff;
      else if (filter === 3) val = (raw + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (raw + paethPredictor(a, b, c)) & 0xff;
      else return fail(`${label} unsupported PNG filter ${filter}`);
      pixels[dstRow + i] = val;
    }
  }

  const distinct = new Set<number>();
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  let nonBlackPixels = 0;

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const idx = y * stride + x * bpp;
      const r = pixels[idx]!;
      const g = pixels[idx + 1]!;
      const b = pixels[idx + 2]!;
      distinct.add(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
      if (r > 18 || g > 18 || b > 18) nonBlackPixels += 1;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
  }

  const maxChannelSpan = Math.max(maxR - minR, maxG - minG, maxB - minB);
  const ok = distinct.size > 16 && maxChannelSpan > 20 && nonBlackPixels > 50;
  return {
    ok,
    reason: ok
      ? 'ok'
      : `${label} rendered solid/empty canvas (distinct=${distinct.size}, span=${maxChannelSpan}, nonBlack=${nonBlackPixels})`,
  };
}

function checkSkyCanvasPngNonUniform(png: Buffer): boolean {
  return analyzeSkyCanvasPng(png).ok;
}

async function expectSkyCanvasNonUniform(locator: Locator, label: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => checkSkyCanvasPngNonUniform(await locator.screenshot()), { timeout })
    .toBe(true);
  const analysis = analyzeSkyCanvasPng(await locator.screenshot(), label);
  expect(analysis.ok, analysis.reason).toBe(true);
}

function circularAngleDiff(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

async function setObservationSliderFraction(slider: Locator, fraction: number): Promise<void> {
  await slider.evaluate((el: HTMLInputElement, frac: number) => {
    const min = Number.parseFloat(el.min || '0');
    const max = Number.parseFloat(el.max || '540');
    const step = Number.parseFloat(el.step || '1');
    const raw = min + (max - min) * Math.max(0, Math.min(1, frac));
    const snapped = Number.isFinite(step) && step > 0 ? Math.round((raw - min) / step) * step + min : raw;
    const clamped = Math.max(min, Math.min(max, snapped));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, String(clamped));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, fraction);
}

function getObservationTimeSlider(page: Page): Locator {
  return page
    .getByRole('slider', { name: /时刻|观测时间|时间|19:00|夜/ })
    .or(page.locator('input[type="range"]'))
    .first();
}

async function seedAtlasStopAndOpen(
  api: ApiClient,
  testInfo: TestInfo,
  stop: {
    name: string;
    date: string;
    lat: number;
    lng: number;
    takenAt?: string;
    offsetTime?: string;
    exifless?: boolean;
  },
): Promise<{ journeyId: string; mediaId: string; title: string }> {
  const tag = nextTag(testInfo, 'obs-seed');
  const buf = stop.exifless
    ? appendJpegComment(createExiflessJpeg(240, 160), tag)
    : createSyntheticExifJpeg({
        width: 240,
        height: 160,
        lat: stop.lat,
        lng: stop.lng,
        takenAt: stop.takenAt ?? `${stop.date.replace(/-/g, ':')} 21:45:00`,
        offsetTime: stop.offsetTime ?? '+08:00',
        model: `X-T5-${tag}`,
      });

  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), `${tag}.jpg`);
  const mediaRes = await api.uploadMedia(form);
  expect([200, 201]).toContain(mediaRes.status);
  const mediaId = String((mediaRes.data as { media?: Array<{ id: string }> }).media?.[0]?.id ?? '');
  expect(mediaId).toBeTruthy();

  const title = `观星联动-${tag}`;
  const journeyId = `journey-${tag}`;
  const jRes = await api.saveJourney({
    id: journeyId,
    title,
    subtitle: '联动测试路线',
    startDate: stop.date,
    endDate: stop.date,
    visibility: 'public',
    coverId: mediaId,
    stops: [
      {
        id: `stop-${tag}`,
        name: stop.name,
        region: '中国',
        date: stop.date,
        lat: stop.lat,
        lng: stop.lng,
        note: '夜空联动手记。',
        mediaIds: [mediaId],
      },
    ],
  });
  expect([200, 201]).toContain(jRes.status);
  return { journeyId, mediaId, title };
}

// ===========================================================================
// F3.1 — Same-Origin Stellarium WASM + BrightStarChart Fallback (5 Tests)
// ===========================================================================
test.describe('Tier 1 — Observatory F3.1: Stellarium WASM & BrightStarChart', () => {
  test('T1-F3.1-01 lazy chunk loading & same-origin Stellarium WASM bootstrap with zero 3P requests', async ({ page }) => {
    const errors = attachErrorListeners(page);
    const homeUrls: string[] = [];
    const obsUrls: string[] = [];
    const thirdPartyUrls: string[] = [];
    let onObservatory = false;

    await installSkyBridgeSpy(page);

    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const parsed = new URL(url);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
          thirdPartyUrls.push(url);
        }
      }
      if (onObservatory) obsUrls.push(url);
      else homeUrls.push(url);
    });

    try {
      await page.goto('/', { waitUntil: 'networkidle' });
      expect(homeUrls.some((u) => /stellarium|astronomy-engine|hyg-bright/i.test(u))).toBe(false);

      onObservatory = true;
      const obsNav = page.getByRole('link', { name: /星图|观星|Observatory/i }).first();
      await obsNav.click();
      await expect(page).toHaveURL(/\/observatory/);

      await waitForStellariumReady(page);

      expect(obsUrls.some((u) => u.includes('stellarium-web-engine.wasm'))).toBe(true);
      const baseStarTiles = obsUrls.filter((u) => /\/stellarium\/data\/stars\/Norder0\/.*\.eph/i.test(u));
      expect(baseStarTiles.length).toBeGreaterThanOrEqual(12);
      expect(thirdPartyUrls).toEqual([]);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.1-02 Stellarium WebGL canvas renders & loading overlay dismisses', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      const frame = page.frameLocator('iframe[src*="/stellarium/"]');
      const skyCanvas = frame.locator('canvas').first();
      await expect(skyCanvas).toBeVisible();
      const box = await skyCanvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(200);
      expect(box!.height).toBeGreaterThan(200);

      await expect(frame.locator('[role="status"]:visible')).toHaveCount(0, { timeout: 15_000 });

      await expectSkyCanvasNonUniform(skyCanvas, 'T1-F3.1-02 Stellarium starfield');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.1-03 on-demand BrightStarChart 923-star SVG chunk loads & renders cleanly', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);
    const initialUrls: string[] = [];
    const postClickUrls: string[] = [];
    const thirdPartyUrls: string[] = [];
    let afterSwitchClick = false;

    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const parsed = new URL(url);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
          thirdPartyUrls.push(url);
        }
      }
      if (afterSwitchClick) postClickUrls.push(url);
      else initialUrls.push(url);
    });

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);
      expect(initialUrls.some((u) => /BrightStarChart|hyg-bright|astronomy-engine/i.test(u))).toBe(false);

      const switchBtn = page.getByRole('button', { name: /简版方位图|简版星图|亮星图/ }).first();
      await expect(switchBtn).toBeVisible({ timeout: 15_000 });
      afterSwitchClick = true;
      await switchBtn.click();

      const svg = page.locator('svg[role="img"][aria-label*="亮星"], svg[viewBox="0 0 640 640"]').first();
      await expect(svg).toBeVisible({ timeout: 15_000 });
      await expect(svg).toContainText(/北|N/);
      await expect(svg).toContainText(/南|S/);
      await expect(svg).toContainText(/天顶/);

      await expect.poll(async () => svg.locator('circle').count(), { timeout: 10_000 }).toBeGreaterThan(100);
      expect(thirdPartyUrls).toEqual([]);
      expect(postClickUrls.some((u) => /\.(?:[cm]?js|tsx?|json)(?:\?|$)/i.test(u))).toBe(true);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.1-04 BrightStarChart star selection, keyboard list, rotation & zoom sliders', async ({ page }) => {
    const errors = attachErrorListeners(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /简版方位图|简版星图|亮星图/ }).first().click();

      const svg = page.locator('svg[role="img"][aria-label*="亮星"], svg[viewBox="0 0 640 640"]').first();
      await expect(svg).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => svg.locator('circle').count(), { timeout: 10_000 }).toBeGreaterThan(100);

      const summary = page.locator('details summary').filter({ hasText: /地平线上方/ }).first();
      await summary.click();
      const firstStarBtn = page.locator('details button').first();
      await expect(firstStarBtn).toBeVisible();
      await firstStarBtn.click();

      const detailPanel = page.locator('[aria-live="polite"]').first();
      await expect(detailPanel).toContainText(/高度角|高度/);
      await expect(detailPanel).toContainText(/方位角|方位/);

      const offCenterIdx = await svg.evaluate((el) => {
        const circles = Array.from(el.querySelectorAll('circle'));
        for (let i = 0; i < circles.length; i += 1) {
          const cx = Number.parseFloat(circles[i]!.getAttribute('cx') ?? '320');
          if (Number.isFinite(cx) && Math.abs(cx - 320) > 20) return i;
        }
        return -1;
      });
      expect(offCenterIdx).toBeGreaterThanOrEqual(0);
      const trackedCircle = svg.locator('circle').nth(offCenterIdx);

      const beforePos = await trackedCircle.getAttribute('cx');
      const rotSlider = page
        .getByRole('slider', { name: /旋转|方位|角度/ })
        .or(page.locator('input[type="range"][max="360"]'))
        .first();
      await rotSlider.fill('90');
      const afterPos = await trackedCircle.getAttribute('cx');
      expect(afterPos).not.toBe(beforePos);

      const zoomSlider = page
        .getByRole('slider', { name: /缩放|放大/ })
        .or(page.locator('input[type="range"][max="2.5"]'))
        .first();
      await expect(zoomSlider).toBeVisible();
      const beforeZoomCx = await trackedCircle.getAttribute('cx');
      await zoomSlider.fill('1.5');
      await expect
        .poll(async () => {
          const afterZoomCx = await trackedCircle.getAttribute('cx');
          const readout = (await page.locator('body').innerText()).includes('1.5');
          return afterZoomCx !== beforeZoomCx || readout;
        })
        .toBe(true);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.1-05 switching back from BrightStarChart to Stellarium WASM remounts cleanly', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      const initialSession = await waitForStellariumReady(page);
      const initialSrc = await page.locator('iframe[src*="/stellarium/"]').first().getAttribute('src');

      await page.getByRole('button', { name: /简版方位图|简版星图|亮星图/ }).first().click();
      await expect(page.locator('svg[viewBox="0 0 640 640"]').first()).toBeVisible({ timeout: 15_000 });

      await page.getByRole('button', { name: /回到沉浸星图|沉浸星图|实景星图/ }).first().click();
      const remountedIframe = page.locator('iframe[src*="/stellarium/index.html?session="]').first();
      await expect(remountedIframe).toBeVisible({ timeout: 15_000 });
      const newSrc = await remountedIframe.getAttribute('src');
      expect(newSrc).not.toBe(initialSrc);

      const newSession = await getActiveSkySession(page);
      expect(newSession).toBeTruthy();
      expect(newSession).not.toBe(initialSession);

      const readySession = await waitForStellariumReady(page);
      expect(readySession).toBe(newSession);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });
});

// ===========================================================================
// F3.2 — Observatory HUD, Search & 19:00 -> 04:00 Time Slider (6 Tests)
// ===========================================================================
test.describe('Tier 1 — Observatory F3.2: HUD, Bilingual Search & Time Slider', () => {
  test('T1-F3.2-01 #0B0C0E only-dark surface, 32px viewport radius & anti-AI-taste scan', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      const darkSurface = await assertOnlyDarkSurface(page, 'rgb(11, 12, 14)');
      expect(darkSurface.backgroundColor).toBe('rgb(11, 12, 14)');
      expect(darkSurface.luminance).toBeGreaterThan(0.35);

      const viewport = page.locator('[data-only-dark], .observatory-viewport, main section').first();
      const radius = await viewport.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
      if (testInfo.project.name.startsWith('desktop-')) {
        expect(radius).toBeGreaterThanOrEqual(30);
      }

      const aiReport = await scanAntiAiTaste(page);
      expect(aiReport.violations).toEqual([]);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.2-02 bilingual celestial search (stars, constellations, planets) & clear selection', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      const searchInput = page.getByRole('textbox', { name: /搜索天体/ }).or(page.getByPlaceholder(/找一颗星|搜索天体/)).first();
      await expect(searchInput).toBeVisible();

      const queries: Array<{ query: string; panelRe: RegExp; selectedRe: RegExp }> = [
        { query: '天狼星', panelRe: /天狼星|Sirius/i, selectedRe: /天狼星|Sirius/i },
        { query: 'Sirius', panelRe: /天狼星|Sirius/i, selectedRe: /天狼星|Sirius/i },
        { query: '猎户座', panelRe: /猎户座|Orion/i, selectedRe: /猎户座|Orion/i },
        { query: 'Orion', panelRe: /猎户座|Orion/i, selectedRe: /猎户座|Orion/i },
        { query: '土星', panelRe: /土星|Saturn/i, selectedRe: /土星|Saturn/i },
      ];

      for (const item of queries) {
        await searchInput.click();
        await searchInput.fill(item.query);
        const firstResult = page
          .locator('[role="listbox"] [role="option"], [role="list"] button, aside button')
          .filter({ hasText: new RegExp(item.query, 'i') })
          .first();
        await expect(firstResult).toBeVisible({ timeout: 5_000 });
        await firstResult.click();

        const panel = page.locator('[aria-live="polite"]').first();
        await expect(panel).toContainText(item.panelRe);
        await expect(panel).toContainText(/高度/);
        await expect(panel).toContainText(/方位/);

        await expect
          .poll(
            async () => {
              const st = await getLatestSkyState(page);
              const sel = st?.selected as { id?: string; name?: string } | null | undefined;
              const combined = `${sel?.id ?? ''} ${sel?.name ?? ''}`;
              return item.selectedRe.test(combined);
            },
            { timeout: 5_000 },
          )
          .toBe(true);
      }

      const clearBtn = page.getByRole('button', { name: /取消天体选择/ }).first();
      await expect(clearBtn).toBeVisible();
      await clearBtn.click();

      await expect
        .poll(async () => {
          const st = await getLatestSkyState(page);
          return st?.selected ?? null;
        })
        .toBeNull();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.2-03 independent layer toggles (constellations, labels, grid, ground, atmosphere)', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      const layers = [
        { key: 'constellations', matcher: /星座线/ },
        { key: 'labels', matcher: /天体名/ },
        { key: 'grid', matcher: /方位网|网格/ },
        { key: 'ground', matcher: /地景/ },
        { key: 'atmosphere', matcher: /大气/ },
      ] as const;

      const baseSt = await getLatestSkyState(page);
      expect(baseSt).not.toBeNull();
      const baseCam = {
        yaw: Number(baseSt!.yaw ?? 180),
        pitch: Number(baseSt!.pitch ?? 42),
        fov: Number(baseSt!.fov ?? 85),
      };

      for (const layer of layers) {
        const btn = page.getByRole('button', { name: layer.matcher }).first();
        await expect(btn).toBeVisible();
        const beforePressed = await btn.getAttribute('aria-pressed');
        const beforeState = await getLatestSkyState(page);
        expect(beforeState).not.toBeNull();
        const beforeVal = Boolean(beforeState![layer.key]);

        const otherPressedBefore = await Promise.all(
          layers
            .filter((l) => l.key !== layer.key)
            .map(async (l) => ({
              key: l.key,
              pressed: await page.getByRole('button', { name: l.matcher }).first().getAttribute('aria-pressed'),
              val: Boolean(beforeState![l.key]),
            })),
        );

        await btn.click();
        await expect(btn).toHaveAttribute('aria-pressed', beforePressed === 'true' ? 'false' : 'true');

        await expect
          .poll(async () => Boolean((await getLatestSkyState(page))?.[layer.key]), { timeout: 5_000 })
          .toBe(!beforeVal);

        const afterState = await getLatestSkyState(page);
        expect(afterState).not.toBeNull();
        for (const other of otherPressedBefore) {
          const otherBtn = page.getByRole('button', { name: layers.find((l) => l.key === other.key)!.matcher }).first();
          await expect(otherBtn).toHaveAttribute('aria-pressed', other.pressed ?? 'false');
          expect(Boolean(afterState![other.key])).toBe(other.val);
        }

        expect(circularAngleDiff(Number(afterState!.yaw ?? 0), baseCam.yaw)).toBeLessThan(1);
        expect(Math.abs(Number(afterState!.pitch ?? 0) - baseCam.pitch)).toBeLessThan(1);
        expect(Math.abs(Number(afterState!.fov ?? 0) - baseCam.fov)).toBeLessThan(1);
      }
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.2-04 camera zoom, drag, keyboard pan & reset ("回到南方天空")', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      const zoomIn = page.getByRole('button', { name: /放大星图|放大/ }).first();
      await zoomIn.click();
      await expect
        .poll(async () => Number((await getLatestSkyState(page))?.fov ?? 85), { timeout: 5_000 })
        .toBeLessThan(85);
      const fovAfterZoomIn = Number((await getLatestSkyState(page))?.fov ?? 85);

      const iframe = page.locator('iframe[src*="/stellarium/"]').first();
      const box = await iframe.boundingBox();
      expect(box).not.toBeNull();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;

      // Mouse wheel zoom changes FOV
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, 240);
      await expect
        .poll(
          async () => Math.abs(Number((await getLatestSkyState(page))?.fov ?? fovAfterZoomIn) - fovAfterZoomIn),
          { timeout: 5_000 },
        )
        .toBeGreaterThan(0.5);

      // Pointer drag changes yaw or pitch
      const beforeDrag = await getLatestSkyState(page);
      const yawBeforeDrag = Number(beforeDrag?.yaw ?? 180);
      const pitchBeforeDrag = Number(beforeDrag?.pitch ?? 42);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 120, cy - 45, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(
          async () => {
            const st = await getLatestSkyState(page);
            const dy = circularAngleDiff(Number(st?.yaw ?? yawBeforeDrag), yawBeforeDrag);
            const dp = Math.abs(Number(st?.pitch ?? pitchBeforeDrag) - pitchBeforeDrag);
            return dy > 2 || dp > 2;
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      // Keyboard ArrowRight / ArrowUp pan changes both yaw and pitch
      const beforeKeys = await getLatestSkyState(page);
      const yawBeforeKeys = Number(beforeKeys?.yaw ?? 180);
      const pitchBeforeKeys = Number(beforeKeys?.pitch ?? 42);
      const skyCanvas = page.frameLocator('iframe[src*="/stellarium/"]').locator('canvas').first();
      await skyCanvas.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await expect
        .poll(
          async () => {
            const st = await getLatestSkyState(page);
            const dy = circularAngleDiff(Number(st?.yaw ?? yawBeforeKeys), yawBeforeKeys);
            const dp = Math.abs(Number(st?.pitch ?? pitchBeforeKeys) - pitchBeforeKeys);
            return dy > 2 && dp > 2;
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      const resetBtn = page.getByRole('button', { name: /回到南方天空|重置视角/ }).first();
      await resetBtn.click();
      await expect
        .poll(
          async () => {
            const st = await getLatestSkyState(page);
            return {
              yaw: Math.round(Number(st?.yaw ?? 0)),
              pitch: Math.round(Number(st?.pitch ?? 0)),
              fov: Math.round(Number(st?.fov ?? 0)),
            };
          },
          { timeout: 8_000 },
        )
        .toEqual({ yaw: 180, pitch: 42, fov: 85 });

      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.2-05 19:00 -> 04:00 diurnal observation slider drives sky motion', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      const activeSession = await waitForStellariumReady(page);

      const slider = getObservationTimeSlider(page);
      await expect(slider).toBeVisible();

      const countSessionStateEvents = async () => {
        const events = await getSkyEvents(page);
        return events.filter((ev) => ev.session === activeSession && ev.type === 'state').length;
      };
      const prevCount = await countSessionStateEvents();
      const prevDate = String((await getLatestSkyState(page))?.date ?? '');

      await setObservationSliderFraction(slider, 0); // 19:00
      await expect(page.locator('body')).toContainText('19:00');

      let t19 = Number.NaN;
      await expect
        .poll(
          async () => {
            const cnt = await countSessionStateEvents();
            const st = await getLatestSkyState(page);
            const dateStr = String(st?.date ?? '');
            const parsed = Date.parse(dateStr);
            if (!Number.isFinite(parsed) || cnt <= prevCount) return false;
            if (prevDate && dateStr === prevDate && !dateStr.includes('19:00')) return false;
            t19 = parsed;
            return true;
          },
          { timeout: 8_000 },
        )
        .toBe(true);

      await setObservationSliderFraction(slider, 3.5 / 9); // 22:30
      await expect(page.locator('body')).toContainText('22:30');
      await expect
        .poll(
          async () => {
            const st = await getLatestSkyState(page);
            const ms = Date.parse(String(st?.date ?? ''));
            return Number.isFinite(ms) && Math.abs(ms - t19 - 3.5 * 3600_000) < 120_000;
          },
          { timeout: 8_000 },
        )
        .toBe(true);

      await setObservationSliderFraction(slider, 1); // 04:00
      await expect(page.locator('body')).toContainText('04:00');
      await expect
        .poll(
          async () => {
            const st = await getLatestSkyState(page);
            const ms = Date.parse(String(st?.date ?? ''));
            return Number.isFinite(ms) && Math.abs(ms - t19 - 9 * 3600_000) < 120_000;
          },
          { timeout: 8_000 },
        )
        .toBe(true);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.2-06 default Beijing (39.9042, 116.4074) & valid coordinate update', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      await expect(page.locator('body')).toContainText(/39\.9042/);
      await expect(page.locator('body')).toContainText(/116\.4074/);

      const coordToggle = page.getByRole('button', { name: /位置|坐标|设置位置/ }).first();
      if (await coordToggle.isVisible().catch(() => false)) {
        const latVisible = await page.getByLabel(/观测纬度|纬度/).first().isVisible().catch(() => false);
        if (!latVisible) await coordToggle.click();
      }

      const latInput = page.getByLabel(/观测纬度|纬度/).first();
      const lngInput = page.getByLabel(/观测经度|经度/).first();
      await latInput.fill('31.2304');
      await lngInput.fill('121.4737');
      await page.getByRole('button', { name: /应用坐标|确定|应用/ }).first().click();

      await expect(page.locator('body')).toContainText(/31\.2304/);
      await expect(page.locator('body')).toContainText(/121\.4737/);
      await expect
        .poll(async () => Number((await getLatestSkyState(page))?.lat ?? 0), { timeout: 5_000 })
        .toBeCloseTo(31.2304, 2);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });
});

// ===========================================================================
// F3.3 — Atlas -> Observatory "回望此地当夜星空" Spacetime Link (5 Tests)
// ===========================================================================
test.describe('Tier 1 — Observatory F3.3: Atlas -> Observatory Spacetime Link', () => {
  test('T1-F3.3-01 Atlas "回望此地当夜星空" passes EXIF (lat, lng, time, place) to Observatory', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    await installSkyBridgeSpy(page);

    const seeded = await seedAtlasStopAndOpen(api, testInfo, {
      name: '大理苍山',
      date: '2026-10-01',
      lat: 25.6065,
      lng: 100.2676,
      takenAt: '2026:10:01 21:45:00',
      offsetTime: '+08:00',
    });

    try {
      await openAtlasAndSelectJourney(page, seeded.title, '大理苍山');

      const link = page
        .getByRole('link', { name: /回望此地当夜星空|查看当夜星空/ })
        .or(page.getByRole('button', { name: /回望此地当夜星空|查看当夜星空/ }))
        .first();
      await link.scrollIntoViewIfNeeded();
      await link.click();

      await expect(page).toHaveURL(/\/observatory\?/);
      const url = new URL(page.url());
      expect(url.searchParams.get('time')).toContain('21:45');

      await waitForStellariumReady(page);
      await expect(page.locator('body')).toContainText('大理苍山');
      await expect(page.locator('body')).toContainText(/25\.6065/);
      await expect(page.locator('body')).toContainText(/100\.2676/);
      await expect(page.locator('body')).toContainText(/2026[-./]10[-./]01/);
      await expect(page.locator('body')).toContainText('21:45');
      await pollSkyDateNear(page, '2026-10-01T21:45:00+08:00');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await api.trashItem('journey', seeded.journeyId);
      await api.trashItem('media', seeded.mediaId);
    }
  });

  test('T1-F3.3-02 date-only Atlas stop defaults spacetime link to 21:30', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();

    const seeded = await seedAtlasStopAndOpen(api, testInfo, {
      name: '济南大明湖',
      date: '2026-08-15',
      lat: 36.6512,
      lng: 117.1201,
      exifless: true,
    });

    try {
      await openAtlasAndSelectJourney(page, seeded.title, '济南大明湖');

      const link = page
        .getByRole('link', { name: /回望此地当夜星空|查看当夜星空/ })
        .or(page.getByRole('button', { name: /回望此地当夜星空|查看当夜星空/ }))
        .first();
      await link.scrollIntoViewIfNeeded();
      await link.click();

      await expect(page).toHaveURL(/\/observatory\?/);
      const url = new URL(page.url());
      expect(Number(url.searchParams.get('lat'))).toBeCloseTo(36.6512, 3);
      expect(Number(url.searchParams.get('lng'))).toBeCloseTo(117.1201, 3);
      expect(url.searchParams.get('time')).toContain('2026-08-15');
      expect(url.searchParams.get('time')).toContain('21:30');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await api.trashItem('journey', seeded.journeyId);
      await api.trashItem('media', seeded.mediaId);
    }
  });

  test('T1-F3.3-03 direct deep-link /observatory?lat=...&lng=...&time=...&place=... (Southern Hemisphere)', async ({ page }) => {
    const errors = attachErrorListeners(page);
    const thirdPartyUrls: string[] = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.startsWith('http://') || u.startsWith('https://')) {
        const parsed = new URL(u);
        if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
          thirdPartyUrls.push(u);
        }
      }
    });
    await installSkyBridgeSpy(page);

    try {
      await page.goto(
        '/observatory?lat=-33.8688&lng=151.2093&time=2026-07-10T22:00:00%2B10:00&place=Sydney',
        { waitUntil: 'domcontentloaded' },
      );
      await waitForStellariumReady(page);

      await expect(page.locator('body')).toContainText('Sydney');
      await expect(page.locator('body')).toContainText(/33\.8688°\s*S/);
      await expect(page.locator('body')).toContainText(/151\.2093°\s*E/);

      const st = await getLatestSkyState(page);
      expect(Number(st?.lat)).toBeCloseTo(-33.8688, 2);
      expect(Number(st?.lng)).toBeCloseTo(151.2093, 2);
      expect(Date.parse(String(st?.date ?? ''))).toBe(Date.parse('2026-07-10T12:00:00.000Z'));
      expect(thirdPartyUrls).toEqual([]);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.3-04 spacetime link state preserved when switching to BrightStarChart mode', async ({ page }) => {
    const errors = attachErrorListeners(page);

    try {
      await page.goto(
        '/observatory?lat=30.2741&lng=120.1551&time=2026-11-05T20:15:00%2B08:00&place=%E6%9D%AD%E5%B7%9E%E8%A5%BF%E6%B9%96',
        { waitUntil: 'domcontentloaded' },
      );

      await page.getByRole('button', { name: /简版方位图|简版星图|亮星图/ }).first().click();
      const svg = page.locator('svg[viewBox="0 0 640 640"]').first();
      await expect(svg).toBeVisible({ timeout: 15_000 });

      await expect(page.locator('body')).toContainText('杭州西湖');
      await expect(page.locator('body')).toContainText(/30\.2741/);
      await expect(page.locator('body')).toContainText(/120\.1551/);
      await expect(page.locator('body')).toContainText(/2026[-./]11[-./]05/);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F3.3-05 clean round-trip Atlas -> Observatory -> Atlas unmounts Stellarium iframe cleanly', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    await installSkyBridgeSpy(page);

    const seeded = await seedAtlasStopAndOpen(api, testInfo, {
      name: '往返站点',
      date: '2026-10-01',
      lat: 25.6065,
      lng: 100.2676,
    });

    try {
      await openAtlasAndSelectJourney(page, seeded.title, '往返站点');

      await page
        .getByRole('link', { name: /回望此地当夜星空|查看当夜星空/ })
        .or(page.getByRole('button', { name: /回望此地当夜星空|查看当夜星空/ }))
        .first()
        .click();

      await expect(page).toHaveURL(/\/observatory/);
      await waitForStellariumReady(page);
      expect(page.frames().length).toBeGreaterThan(1);

      await page.goBack();
      await expect(page).toHaveURL(/\/atlas/);
      await expect.poll(() => page.frames().length, { timeout: 5_000 }).toBe(1);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await api.trashItem('journey', seeded.journeyId);
      await api.trashItem('media', seeded.mediaId);
    }
  });
});
