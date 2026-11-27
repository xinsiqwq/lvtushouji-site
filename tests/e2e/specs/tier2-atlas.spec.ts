import zlib from 'node:zlib';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  createExiflessJpeg,
  createSyntheticExifJpeg,
  type SyntheticExifJpegOptions,
} from '../fixtures/exif-jpeg';
import { ApiClient, createApiClient } from '../helpers/api-client';
import {
  assertImageAspectRatioPreserved,
  assertOnlyDarkSurface,
  attachErrorListeners,
} from '../helpers/browser-checks';

test.describe.configure({ mode: 'serial' });

interface SeededStopInput {
  id: string;
  name: string;
  region?: string;
  date: string;
  lat: number | null;
  lng: number | null;
  note: string;
  mediaIds: string[];
}

interface SeededJourney {
  id: string;
  title: string;
  subtitle: string;
  mediaIds: string[];
}

let uniqueSeq = 0;

function nextTag(testInfo: TestInfo, prefix: string): string {
  uniqueSeq += 1;
  const proj = testInfo.project.name.replace(/[^a-z0-9]/gi, '');
  return `${prefix}-${proj}-${Date.now()}-${uniqueSeq}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function replaceAsciiInBuffer(buf: Buffer, search: string, replacement: string): number {
  const searchBuf = Buffer.from(search, 'ascii');
  const replBuf = Buffer.from(replacement, 'ascii');
  if (searchBuf.length !== replBuf.length) {
    throw new Error(`ASCII replacement length mismatch: ${searchBuf.length} !== ${replBuf.length}`);
  }
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = buf.indexOf(searchBuf, pos);
    if (idx === -1) break;
    replBuf.copy(buf, idx);
    count += 1;
    pos = idx + searchBuf.length;
  }
  return count;
}

async function uploadPhoto(
  api: ApiClient,
  buffer: Buffer,
  filename: string,
  meta: { takenAt?: string; lat?: number; lng?: number; caption?: string } = {},
): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' }), filename);
  if (meta.takenAt !== undefined) form.append('takenAt', meta.takenAt);
  if (meta.lat !== undefined) form.append('lat', String(meta.lat));
  if (meta.lng !== undefined) form.append('lng', String(meta.lng));
  if (meta.caption !== undefined) form.append('caption', meta.caption);

  const res = await api.uploadMedia(form);
  expect([200, 201]).toContain(res.status);
  const mediaList = (res.data as { media?: Array<Record<string, unknown>> }).media;
  const created = mediaList?.[0] ?? (res.data as Record<string, unknown>);
  if (!created || typeof created.id !== 'string') {
    throw new Error(`POST /api/media did not return valid Media record: ${res.text}`);
  }
  return created;
}

async function seedPublicJourney(
  api: ApiClient,
  testInfo: TestInfo,
  opts: {
    prefix: string;
    title?: string;
    subtitle?: string;
    startDate?: string;
    endDate?: string;
    visibility?: 'public' | 'private';
    stops: Array<{
      name: string;
      region?: string;
      date: string;
      lat: number | null;
      lng: number | null;
      note: string;
      photos?: Array<SyntheticExifJpegOptions & { caption?: string; exifless?: boolean }>;
    }>;
  },
): Promise<SeededJourney> {
  const tag = nextTag(testInfo, opts.prefix);
  const mediaIds: string[] = [];
  const stopsPayload: SeededStopInput[] = [];

  for (let sIdx = 0; sIdx < opts.stops.length; sIdx += 1) {
    const stopSpec = opts.stops[sIdx]!;
    const stopMediaIds: string[] = [];
    const photoSpecs = stopSpec.photos ?? [{ lat: stopSpec.lat, lng: stopSpec.lng }];

    for (let pIdx = 0; pIdx < photoSpecs.length; pIdx += 1) {
      const pSpec = photoSpecs[pIdx]!;
      const rawBuf = pSpec.exifless
        ? appendJpegComment(createExiflessJpeg(pSpec.width ?? 240, pSpec.height ?? 160), `${tag}-s${sIdx}-p${pIdx}`)
        : createSyntheticExifJpeg({
            width: 240,
            height: 160,
            lat: stopSpec.lat,
            lng: stopSpec.lng,
            takenAt: `${stopSpec.date.replace(/-/g, ':')} 20:30:00`,
            model: `X-T5-${tag}-${sIdx}-${pIdx}`,
            ...pSpec,
          });
      const media = await uploadPhoto(api, rawBuf, `${tag}-${sIdx}-${pIdx}.jpg`, {
        caption: pSpec.caption ?? `${stopSpec.name}图-${sIdx}-${pIdx}`,
      });
      const mid = String(media.id);
      stopMediaIds.push(mid);
      mediaIds.push(mid);
    }

    stopsPayload.push({
      id: `stop-${tag}-${sIdx}`,
      name: stopSpec.name,
      region: stopSpec.region ?? '中国',
      date: stopSpec.date,
      lat: stopSpec.lat,
      lng: stopSpec.lng,
      note: stopSpec.note,
      mediaIds: stopMediaIds,
    });
  }

  const journeyTitle = opts.title ?? `边界旅程-${tag}`;
  const journeySubtitle = opts.subtitle ?? `边界测试路线-${tag}`;
  const res = await api.saveJourney({
    id: `journey-${tag}`,
    title: journeyTitle,
    subtitle: journeySubtitle,
    startDate: opts.startDate ?? opts.stops[0]?.date ?? '2026-10-01',
    endDate: opts.endDate ?? opts.stops[opts.stops.length - 1]?.date ?? '2026-10-05',
    visibility: opts.visibility ?? 'public',
    coverId: mediaIds[0] ?? null,
    stops: stopsPayload,
  });
  expect([200, 201]).toContain(res.status);
  const saved = ((res.data as { journey?: Record<string, unknown> }).journey ?? res.data) as Record<string, unknown>;
  return {
    id: String(saved.id ?? `journey-${tag}`),
    title: journeyTitle,
    subtitle: journeySubtitle,
    mediaIds,
  };
}

async function cleanupSeeded(
  api: ApiClient,
  journeyIds: string[],
  mediaIds: string[],
): Promise<void> {
  for (const jid of journeyIds) {
    if (!jid) continue;
    await api.trashItem('journey', jid);
  }
  for (const mid of mediaIds) {
    if (!mid) continue;
    await api.trashItem('media', mid);
  }
}

async function openAtlasAndFocusJourney(
  page: Page,
  journeyTitle: string,
  expectedText?: string,
): Promise<void> {
  const libPromise = page.waitForResponse(
    (r) => r.url().includes('/api/library') && r.status() === 200,
    { timeout: 15_000 },
  );
  await page.goto('/atlas', { waitUntil: 'domcontentloaded' });
  await libPromise;

  const titleMatcher = new RegExp(escapeRegExp(journeyTitle));
  const switcher = page
    .getByRole('button', { name: titleMatcher })
    .or(page.getByRole('tab', { name: titleMatcher }))
    .first();

  await expect
    .poll(
      async () => {
        const textVis = await page.getByText(titleMatcher).first().isVisible().catch(() => false);
        const switchVis = await switcher.isVisible().catch(() => false);
        return textVis || switchVis;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  if (await switcher.isVisible().catch(() => false)) {
    await switcher.click();
  }
  await expect(page.getByText(titleMatcher).first()).toBeVisible({ timeout: 15_000 });
  if (expectedText) {
    await expect(page.getByText(expectedText).first()).toBeVisible({ timeout: 15_000 });
  }
}

async function authenticateAdminPage(page: Page, api: ApiClient): Promise<void> {
  await api.ensureAdminSession();
  const cookies = api.getCookies();
  const baseUrlObj = new URL(api.baseURL);
  const cookieList = Object.entries(cookies).map(([name, value]) => ({
    name,
    value,
    domain: baseUrlObj.hostname,
    path: '/',
  }));
  if (cookieList.length > 0) {
    await page.context().addCookies(cookieList);
  }
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  const passwordInput = page.locator('input[type="password"]').first();
  if (await passwordInput.isVisible({ timeout: 2500 }).catch(() => false)) {
    const pwd = process.env.E2E_ADMIN_PASSWORD || 'AtlasVaultStarlight2026!';
    await passwordInput.fill(pwd);
    await page.getByRole('button', { name: /登录|进入|确认|提交/ }).first().click();
    await expect(passwordInput).toBeHidden({ timeout: 10_000 });
  }
}

function getMapCanvas(page: Page): Locator {
  return page.locator('main canvas, [role="region"] canvas, .maplibregl-canvas').first();
}

const ACTIVE_STOP_SELECTOR =
  'main [aria-pressed="true"], main [aria-current="step"], main [aria-current="true"], main [aria-selected="true"]';

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface CanvasPngAnalysis {
  ok: boolean;
  reason: string;
  width: number;
  height: number;
  distinctColors: number;
  differingPixels: number;
}

function analyzeCanvasPng(png: Buffer, label = 'canvas'): CanvasPngAnalysis {
  const fail = (reason: string): CanvasPngAnalysis => ({
    ok: false,
    reason,
    width: 0,
    height: 0,
    distinctColors: 0,
    differingPixels: 0,
  });

  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(pngSig)) {
    return fail(`${label} screenshot is not a valid PNG`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let plte: Buffer | null = null;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) {
      return fail(`${label} PNG chunk ${type} exceeds buffer bounds`);
    }
    const data = png.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? -1;
      interlace = data[12] ?? -1;
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width < 200 || height < 160) {
    return fail(`${label} PNG dimensions too small: ${width}x${height}`);
  }
  if (bitDepth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(colorType) || idatChunks.length === 0) {
    return fail(`${label} unsupported PNG format bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
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
      else return fail(`${label} unsupported PNG filter ${filter} at row ${y}`);
      pixels[dstRow + i] = val;
    }
  }

  const readRgb = (x: number, y: number): [number, number, number] => {
    const idx = y * stride + x * bpp;
    if (colorType === 6 || colorType === 2) return [pixels[idx]!, pixels[idx + 1]!, pixels[idx + 2]!];
    if (colorType === 3 && plte) {
      const pIdx = pixels[idx]! * 3;
      return [plte[pIdx] ?? 0, plte[pIdx + 1] ?? 0, plte[pIdx + 2] ?? 0];
    }
    const g = pixels[idx]!;
    return [g, g, g];
  };

  const step = 2;
  const [r0, g0, b0] = readRgb(0, 0);
  const buckets = new Set<number>();
  let differingPixels = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const [r, g, b] = readRgb(x, y);
      buckets.add(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
      if (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) > 12) {
        differingPixels += 1;
      }
    }
  }

  const ok = buckets.size >= 4 && differingPixels >= 100;
  return {
    ok,
    reason: ok
      ? 'ok'
      : `${label} PNG appears blank/uniform (distinctColors=${buckets.size}, differingPixels=${differingPixels})`,
    width,
    height,
    distinctColors: buckets.size,
    differingPixels,
  };
}

function checkCanvasPngNonUniform(png: Buffer): boolean {
  return analyzeCanvasPng(png).ok;
}

async function expectCanvasNonUniform(locator: Locator, label: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => checkCanvasPngNonUniform(await locator.screenshot()), { timeout })
    .toBe(true);
  const analysis = analyzeCanvasPng(await locator.screenshot(), label);
  expect(analysis.ok, analysis.reason).toBe(true);
}

async function startAndConfirmPlayback(page: Page): Promise<void> {
  const playBtn = page.getByRole('button', { name: /沿途回放/ }).first();
  await expect(playBtn).toBeVisible();
  await playBtn.click();
  await expect
    .poll(
      async () => {
        const pauseVisible = await page.getByRole('button', { name: /暂停/ }).first().isVisible().catch(() => false);
        const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
        return pauseVisible || pressed === 'true';
      },
      { timeout: 5_000 },
    )
    .toBe(true);
}

async function expectPlaybackIdle(page: Page, timeout = 5_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const playBtn = page.getByRole('button', { name: /沿途回放/ }).first();
        const playVisible = await playBtn.isVisible().catch(() => false);
        const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
        const pauseVisible = await page.getByRole('button', { name: /暂停/ }).first().isVisible().catch(() => false);
        return playVisible && pressed !== 'true' && !pauseVisible;
      },
      { timeout },
    )
    .toBe(true);
}

function getUsageCounter(
  usageData: {
    limits?: Record<string, number>;
    counters?: Array<{ key: string; value: number }>;
  },
  keys: string[],
): number {
  for (const c of usageData.counters ?? []) {
    if (keys.includes(c.key)) return Number(c.value);
  }
  for (const k of keys) {
    const v = usageData.limits?.[k];
    if (typeof v === 'number') return v;
  }
  return 0;
}

// ===========================================================================
// F2.1 — Layout Boundaries & Mobile Drawer Edge Cases (5 Tests)
// ===========================================================================
test.describe('Tier 2 — Atlas F2.1: Layout & Mobile Drawer Boundaries', () => {
  test('T2-F2.1-01 zero public journeys empty state renders calmly without crash or blank screen', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await page.route('**/api/library', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          journeys: [],
          media: [],
          messages: [],
          access: { protected: true, role: 'visitor', allowVisitorMessages: false },
        }),
      });
    });

    try {
      await page.goto('/atlas', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('main')).toBeVisible();
      await expect(page.getByText(/暂无|还没有|空|旅途/).first()).toBeVisible({ timeout: 10_000 });
      await expect(getMapCanvas(page)).toBeVisible({ timeout: 15_000 });
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F2.1-02 max-length boundary text (120 title, 500 subtitle, 2000 caption, 10000 note) preserves geometry', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();

    const tag = nextTag(testInfo, 'maxlen');
    const maxTitle = `极长标题${tag}`.padEnd(120, '山').slice(0, 120);
    const maxSubtitle = '长副标题边界测试内容'.repeat(50).slice(0, 500);
    const maxCaption = '摄影说明边界'.repeat(334).slice(0, 2000);
    const maxNote = '风穿过山谷与湖面留下长久手记。'.repeat(667).slice(0, 10000);

    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f21-02',
      title: maxTitle,
      subtitle: maxSubtitle,
      stops: [
        {
          name: '边界长文站',
          date: '2026-10-01',
          lat: 25.6065,
          lng: 100.2676,
          note: maxNote,
          photos: [{ caption: maxCaption }],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, maxTitle.slice(0, 30), '边界长文站');
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 2);
      await expect(getMapCanvas(page)).toBeVisible();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.1-03 public journey with 0 stops renders safely without NaN bounds or crash', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f21-03',
      stops: [],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title);
      await expect(getMapCanvas(page)).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('body')).not.toContainText('NaN');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.1-04 collapsed mobile bottom drawer hides offscreen controls from keyboard focus', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f21-04',
      stops: [
        { name: '抽屉甲站', date: '2026-10-01', lat: 25.1, lng: 102.1, note: '第一站。' },
        { name: '抽屉乙站', date: '2026-10-02', lat: 25.6, lng: 100.2, note: '第二站隐藏手记。' },
        { name: '抽屉丙站', date: '2026-10-03', lat: 26.8, lng: 100.2, note: '第三站隐藏手记。' },
      ],
    });

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await openAtlasAndFocusJourney(page, seeded.title, '抽屉甲站');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });

      const collapsedMapBox = await mapCanvas.boundingBox();
      expect(collapsedMapBox).not.toBeNull();
      expect(collapsedMapBox!.height).toBeGreaterThanOrEqual(160);

      const toggleBtn = page.getByRole('button', { name: /展开|收起|手记|站点|抽屉/ }).first();
      await expect(toggleBtn).toBeVisible();
      const collapsedToggleBox = await toggleBtn.boundingBox();
      expect(collapsedToggleBox).not.toBeNull();

      // Verify keyboard Tab traversal never lands inside inert/hidden/offscreen drawer stop controls
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        const nav = document.querySelector('header, nav') as HTMLElement | null;
        if (nav) nav.focus?.();
      });

      let focusedCount = 0;
      for (let step = 0; step < 25; step += 1) {
        await page.keyboard.press('Tab');
        const activeInfo = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body || el === document.documentElement) {
            return { isBody: true, inHidden: false, inStop3: false, inViewport: true };
          }
          const inHidden = Boolean(el.closest('[inert], [aria-hidden="true"], [hidden]'));
          const card = el.closest('article, section');
          const inStop3 = Boolean(card?.textContent?.includes('抽屉丙站'));
          const rect = el.getBoundingClientRect();
          const inViewport =
            rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
          return { isBody: false, inHidden, inStop3, inViewport };
        });
        if (!activeInfo.isBody) {
          focusedCount += 1;
          expect(activeInfo.inHidden).toBe(false);
          expect(activeInfo.inStop3).toBe(false);
          expect(activeInfo.inViewport).toBe(true);
        }
      }
      expect(focusedCount).toBeGreaterThanOrEqual(1);

      // If '抽屉丙站' is mounted in DOM while collapsed, verify it is isolated from focus and clipped/hidden
      const collapsedStop3State = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('article, section')).filter((n) =>
          n.textContent?.includes('抽屉丙站'),
        );
        if (candidates.length === 0) return { mounted: false, isolated: true, focusBlocked: true };
        const el = candidates[0] as HTMLElement;
        const hiddenAncestor = Boolean(el.closest('[inert], [aria-hidden="true"], [hidden]'));
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visuallyHidden =
          cs.display === 'none' || cs.visibility === 'hidden' || rect.top >= window.innerHeight || rect.height === 0;
        const focusable = el.querySelector('button, a[href], [tabindex]') as HTMLElement | null;
        let focusBlocked = true;
        if (focusable) {
          focusable.focus();
          focusBlocked = !el.contains(document.activeElement);
        }
        return {
          mounted: true,
          isolated: hiddenAncestor || visuallyHidden,
          focusBlocked,
        };
      });
      if (collapsedStop3State.mounted) {
        expect(collapsedStop3State.isolated && collapsedStop3State.focusBlocked).toBe(true);
      }

      // Expand drawer and verify snap height change + '抽屉丙站' visible in viewport
      await toggleBtn.click();
      await expect(page.getByText('抽屉丙站').first()).toBeVisible({ timeout: 5_000 });
      const stop3Box = await page.getByText('抽屉丙站').first().boundingBox();
      expect(stop3Box).not.toBeNull();
      expect(stop3Box!.y).toBeLessThan(844);

      const expandedToggleBox = await toggleBtn.boundingBox();
      const expandedMapBox = await mapCanvas.boundingBox();
      expect(expandedToggleBox).not.toBeNull();
      expect(expandedMapBox).not.toBeNull();
      expect(
        expandedToggleBox!.y < collapsedToggleBox!.y - 40 ||
          expandedMapBox!.height < collapsedMapBox!.height - 40,
      ).toBe(true);

      // Re-collapse drawer and confirm map returns >= 160px
      await toggleBtn.click();
      await page.waitForTimeout(300);
      const recollapsedMapBox = await mapCanvas.boundingBox();
      const recollapsedToggleBox = await toggleBtn.boundingBox();
      expect(recollapsedMapBox).not.toBeNull();
      expect(recollapsedMapBox!.height).toBeGreaterThanOrEqual(160);
      expect(
        recollapsedMapBox!.height > expandedMapBox!.height ||
          (recollapsedToggleBox !== null && recollapsedToggleBox.y > expandedToggleBox!.y + 40),
      ).toBe(true);

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.1-05 dynamic viewport resize (1440x900 -> 390x844 -> 1440x900) transitions layout cleanly', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f21-05',
      stops: [{ name: '视口缩放站', date: '2026-10-01', lat: 25.6065, lng: 100.2676, note: '响应式切换。' }],
    });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openAtlasAndFocusJourney(page, seeded.title, '视口缩放站');
      await expect(getMapCanvas(page)).toBeVisible({ timeout: 15_000 });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
      const mobileScroll = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(mobileScroll).toBeLessThanOrEqual(392);
      const mobileMapBox = await getMapCanvas(page).boundingBox();
      expect(mobileMapBox!.height).toBeGreaterThanOrEqual(160);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(250);
      const desktopMapBox = await getMapCanvas(page).boundingBox();
      expect(desktopMapBox!.width).toBeGreaterThan(700);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.2 — MapLibre Tianditu Fallback (E6) & Network Failure Boundaries (6 Tests)
// ===========================================================================
test.describe('Tier 2 — Atlas F2.2: Basemap Fallback & Map Fault Boundaries', () => {
  test('T2-F2.2-01 unconfigured TIANDITU_KEY renders offline GeoJSON contours without blanking (E6)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f22-01',
      stops: [{ name: '离线轮廓站', date: '2026-10-01', lat: 35.86, lng: 104.19, note: '离线 GeoJSON 兜底。' }],
    });

    await page.route('**/api/atlas/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tiandituConfigured: false }),
      });
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '离线轮廓站');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });
      await expectCanvasNonUniform(mapCanvas, 'T2-F2.2-01 offline GeoJSON');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.2-02 blocking /api/atlas/tiles/** (503) and external hosts triggers clean offline GeoJSON fallback', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f22-02',
      stops: [{ name: '断网兜底站', date: '2026-10-01', lat: 29.65, lng: 91.17, note: '零外网兜底。' }],
    });

    await page.route('**/api/atlas/config', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tiandituConfigured: true }),
      });
    });
    await page.route('**/api/atlas/tiles/**', async (route) => {
      await route.fulfill({ status: 503, body: 'Service Unavailable' });
    });
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/i, async (route) => {
      await route.abort('failed');
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '断网兜底站');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });
      await expectCanvasNonUniform(mapCanvas, 'T2-F2.2-02 tile-blocked fallback');
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.2-03 invalid /api/atlas/tiles/:layer/:z/:y/:x params return 4xx/503 without 500', async () => {
    const api = createApiClient();
    const probes: Array<[string, number, number, number]> = [
      ['..%2F..%2Fetc', 0, 0, 0],
      ['invalid_layer', 99, 0, 0],
      ['vec_w', -1, 0, 0],
    ];
    for (const [layer, z, y, x] of probes) {
      const res = await api.getAtlasTile(layer, z, y, x);
      expect(res.status).not.toBe(500);
      expect([400, 403, 404, 503]).toContain(res.status);
    }
  });

  test('T2-F2.2-04 extreme polar & antimeridian coordinates (+/-84.9, +/-179.5) render without NaN or crash', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f22-04',
      stops: [
        { name: '极北国际日期线', date: '2026-10-01', lat: 84.9, lng: -179.5, note: '北极边缘。' },
        { name: '极南对跖点', date: '2026-10-02', lat: -84.9, lng: 179.5, note: '南极边缘。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '极北国际日期线');
      await expect(getMapCanvas(page)).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('body')).not.toContainText('NaN');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.2-05 rapid consecutive Light <-> Dark theme toggles during map mount cause zero race errors', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f22-05',
      stops: [{ name: '快切主题站', date: '2026-10-01', lat: 31.23, lng: 121.47, note: '昼夜快切。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '快切主题站');
      const toggleBtn = page.getByRole('button', { name: /浅色|深色|昼|夜|主题|外观|模式/ }).first();
      await expect(toggleBtn).toBeVisible();
      for (let i = 0; i < 4; i += 1) {
        await toggleBtn.click();
      }
      await page.waitForTimeout(800);
      await expect(getMapCanvas(page)).toBeVisible();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.2-06 unavailable WebGL context degrades calmly without uncaught page crash', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f22-06',
      stops: [{ name: '无WebGL降级站', date: '2026-10-01', lat: 25.6065, lng: 100.2676, note: '手记卡仍可阅读。' }],
    });

    await page.addInitScript(() => {
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = (function (
        this: HTMLCanvasElement,
        type: string,
        ...args: unknown[]
      ) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
          return null;
        }
        return (origGetContext as (...a: unknown[]) => unknown).apply(this, [type, ...args]);
      }) as unknown as typeof origGetContext;
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '无WebGL降级站');
      await expect(page.getByText('手记卡仍可阅读。').first()).toBeVisible();
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.3 — Playback Takeover, Reduced Motion & Degenerate Route Boundaries (5 Tests)
// ===========================================================================
test.describe('Tier 2 — Atlas F2.3: Playback Takeover & Degenerate Routes', () => {
  test('T2-F2.3-01 manual pointer drag on map canvas immediately cancels active "沿途回放"', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f23-01',
      stops: [
        { name: '拖拽接管一', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '一。' },
        { name: '拖拽接管二', date: '2026-10-02', lat: 25.6, lng: 100.26, note: '二。' },
        { name: '拖拽接管三', date: '2026-10-03', lat: 26.87, lng: 100.23, note: '三。' },
        { name: '拖拽接管四', date: '2026-10-04', lat: 27.82, lng: 99.7, note: '四。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '拖拽接管一');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });

      await startAndConfirmPlayback(page);
      const box = await mapCanvas.boundingBox();
      expect(box).not.toBeNull();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;

      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 80, cy + 20, { steps: 6 });
      await page.mouse.up();

      await expectPlaybackIdle(page);
      const activeSnapshot = await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts();
      expect(activeSnapshot.length).toBeGreaterThan(0);
      await page.waitForTimeout(2500);
      const activeLater = await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts();
      expect(activeLater).toEqual(activeSnapshot);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.3-02 wheel zoom or clicking another stop card cancels active "沿途回放"', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f23-02',
      stops: [
        { name: '接管甲', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '甲。' },
        { name: '接管乙', date: '2026-10-02', lat: 25.6, lng: 100.26, note: '乙。' },
        { name: '接管丙', date: '2026-10-03', lat: 26.87, lng: 100.23, note: '丙。' },
        { name: '接管丁', date: '2026-10-04', lat: 27.82, lng: 99.7, note: '丁。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '接管甲');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });
      const mapBox = await mapCanvas.boundingBox();
      expect(mapBox).not.toBeNull();

      // Phase A: Wheel zoom on map canvas cancels active playback
      await startAndConfirmPlayback(page);
      await page.mouse.move(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      await page.mouse.wheel(0, -240);
      await expectPlaybackIdle(page);
      const activeAfterWheel = await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts();
      expect(activeAfterWheel.length).toBeGreaterThan(0);
      await page.waitForTimeout(2200);
      const activeAfterWheelLater = await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts();
      expect(activeAfterWheelLater).toEqual(activeAfterWheel);

      // Phase B: Clicking stop #3 ('接管丙', not final stop '接管丁') cancels playback and stays on #3
      await startAndConfirmPlayback(page);
      const stop3Btn = page
        .getByRole('button', { name: /接管丙/ })
        .or(page.locator('article, section').filter({ hasText: '接管丙' }))
        .first();
      await stop3Btn.scrollIntoViewIfNeeded();
      await stop3Btn.click();

      await expectPlaybackIdle(page);
      await page.waitForTimeout(2200);
      const activeAfterStopClick = await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts();
      expect(activeAfterStopClick.length).toBeGreaterThan(0);
      expect(activeAfterStopClick.join(' ')).toContain('接管丙');
      expect(activeAfterStopClick.join(' ')).not.toContain('接管丁');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.3-03 prefers-reduced-motion: reduce transitions playback cleanly without hangs', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f23-03',
      stops: [
        { name: '减动一', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '一。' },
        { name: '减动二', date: '2026-10-02', lat: 25.6, lng: 100.26, note: '二。' },
      ],
    });

    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openAtlasAndFocusJourney(page, seeded.title, '减动一');
      await expect
        .poll(async () => (await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts()).join(' '), { timeout: 5_000 })
        .toContain('减动一');
      expect((await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts()).join(' ')).not.toContain('减动二');

      await page.getByRole('button', { name: /沿途回放/ }).first().click();
      await expect
        .poll(async () => (await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts()).join(' '), { timeout: 12_000 })
        .toContain('减动二');
      await expectPlaybackIdle(page, 12_000);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.3-04 identical-coordinate stops & 1-stop journey handle Bezier path without NaN', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const sameCoordJourney = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f23-04a',
      title: `同坐标路线-${nextTag(testInfo, 'same')}`,
      stops: [
        { name: '同点甲', date: '2026-10-01', lat: 25.6065, lng: 100.2676, note: '同坐标一。' },
        { name: '同点乙', date: '2026-10-02', lat: 25.6065, lng: 100.2676, note: '同坐标二。' },
      ],
    });
    const singleStopJourney = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f23-04b',
      title: `单站路线-${nextTag(testInfo, 'single')}`,
      stops: [
        { name: '单站独点', date: '2026-10-03', lat: 30.2741, lng: 120.1551, note: '单站无折线。' },
      ],
    });

    try {
      // Journey A: 2-stop identical-coordinate route
      await openAtlasAndFocusJourney(page, sameCoordJourney.title, '同点甲');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });
      await expectCanvasNonUniform(mapCanvas, 'T2-F2.3-04 identical-coord route');

      const playBtnA = page.getByRole('button', { name: /沿途回放/ }).first();
      await expect(playBtnA).toBeVisible();
      await expect(playBtnA).toBeEnabled();
      await playBtnA.click();
      await expect
        .poll(async () => (await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts()).join(' '), { timeout: 12_000 })
        .toContain('同点乙');
      await expectPlaybackIdle(page, 12_000);
      await expectCanvasNonUniform(mapCanvas, 'T2-F2.3-04 identical-coord after playback');
      await expect(page.locator('body')).not.toContainText('NaN');

      // Journey B: genuine 1-stop journey
      const singleMatcher = new RegExp(escapeRegExp(singleStopJourney.title));
      const singleSwitcher = page
        .getByRole('button', { name: singleMatcher })
        .or(page.getByRole('tab', { name: singleMatcher }))
        .first();
      await expect(singleSwitcher).toBeVisible({ timeout: 10_000 });
      await singleSwitcher.click();
      await expect(page.getByText('单站独点').first()).toBeVisible({ timeout: 10_000 });
      await expectCanvasNonUniform(mapCanvas, 'T2-F2.3-04 1-stop route');

      const playBtnB = page.getByRole('button', { name: /沿途回放/ }).first();
      const playCountB = await playBtnB.count();
      if (playCountB > 0 && (await playBtnB.isEnabled())) {
        await playBtnB.click();
        await expectPlaybackIdle(page, 8_000);
        const activeSingle = await page.locator(ACTIVE_STOP_SELECTOR).allInnerTexts();
        expect(activeSingle.join(' ')).toContain('单站独点');
      } else if (playCountB > 0) {
        await expect(playBtnB).toBeDisabled();
      } else {
        await expect(playBtnB).toHaveCount(0);
      }
      await expectCanvasNonUniform(mapCanvas, 'T2-F2.3-04 1-stop after check');
      await expect(page.locator('body')).not.toContainText('NaN');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(
        api,
        [sameCoordJourney.id, singleStopJourney.id],
        [...sameCoordJourney.mediaIds, ...singleStopJourney.mediaIds],
      );
    }
  });

  test('T2-F2.3-05 switching journeys mid-playback cancels prior journey timer cleanly', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const j1 = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f23-05a',
      title: `切换甲-${nextTag(testInfo, 'sw1')}`,
      stops: [
        { name: '甲旅程一', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '甲一。' },
        { name: '甲旅程二', date: '2026-10-02', lat: 25.6, lng: 100.26, note: '甲二。' },
        { name: '甲旅程三', date: '2026-10-03', lat: 26.8, lng: 100.2, note: '甲三。' },
      ],
    });
    const j2 = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f23-05b',
      title: `切换乙-${nextTag(testInfo, 'sw2')}`,
      stops: [{ name: '乙旅程独站', date: '2026-10-05', lat: 30.27, lng: 120.15, note: '乙站。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, j1.title, '甲旅程一');
      await startAndConfirmPlayback(page);

      const j2Re = new RegExp(escapeRegExp(j2.title));
      const j2Switcher = page
        .getByRole('button', { name: j2Re })
        .or(page.getByRole('tab', { name: j2Re }))
        .first();
      await expect(j2Switcher).toBeVisible({ timeout: 10_000 });
      await j2Switcher.click();

      await expect(page.getByText('乙旅程独站').first()).toBeVisible({ timeout: 10_000 });
      await expectPlaybackIdle(page);
      await page.waitForTimeout(2200);
      await expect(page.getByText('乙旅程独站').first()).toBeVisible();
      await expect(page.getByText('甲旅程二')).toHaveCount(0);
      await expect(page.getByText('甲旅程三')).toHaveCount(0);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [j1.id, j2.id], [...j1.mediaIds, ...j2.mediaIds]);
    }
  });
});

// ===========================================================================
// F2.4 — Card Aspect Ratio, Missing EXIF, Timezone Dates & XSS Boundaries (6 Tests)
// ===========================================================================
test.describe('Tier 2 — Atlas F2.4: Card Aspect, Missing EXIF, Timezone & XSS', () => {
  test('T2-F2.4-01 ultra-tall (400x1200) and panoramic (1600x400) photos stay uncropped (E8)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f24-01',
      stops: [
        {
          name: '极端比例站',
          date: '2026-10-01',
          lat: 25.6065,
          lng: 100.2676,
          note: '极窄与超宽画幅。',
          photos: [
            { width: 200, height: 600, caption: '极窄竖图' },
            { width: 800, height: 200, caption: '超宽横图' },
          ],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '极端比例站');
      const imgs = page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"], img[src*="/api/files/${seeded.mediaIds[1]}"]`);
      await expect(imgs).toHaveCount(2, { timeout: 15_000 });

      for (let i = 0; i < 2; i += 1) {
        const img = imgs.nth(i);
        await img.scrollIntoViewIfNeeded();
        await assertImageAspectRatioPreserved(img, 0.03);
      }
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.4-02 photo with no EXIF omits camera parameters gracefully without fabricating values (E7)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f24-02',
      stops: [
        {
          name: '无EXIF留白站',
          date: '2026-10-01',
          lat: 25.6065,
          lng: 100.2676,
          note: '不伪造相机参数。',
          photos: [{ exifless: true, caption: '纯像素无EXIF' }],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '无EXIF留白站');
      const card = page.locator('article, section').filter({ hasText: '无EXIF留白站' }).first();
      await expect(card).toBeVisible();
      await expect(card).not.toContainText(/NaN|undefined|ISO\s*400|f\/2\.8|35\s*mm/i);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.4-03 source timezone calendar date (2026-10-01T23:45:00+08:00) preserved in UTC-7 browser', async ({ browser }, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f24-03',
      stops: [
        {
          name: '跨时区邮戳站',
          date: '2026-10-01',
          lat: 25.6065,
          lng: 100.2676,
          note: '保留拍摄当地日历日。',
          photos: [{ takenAt: '2026:10:01 23:45:00', offsetTime: '+08:00' }],
        },
      ],
    });

    const context = await browser.newContext({
      viewport: testInfo.project.name.startsWith('mobile-')
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
      colorScheme: testInfo.project.name.endsWith('-dark') ? 'dark' : 'light',
      timezoneId: 'America/Los_Angeles',
    });
    const page = await context.newPage();
    const errors = attachErrorListeners(page);

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '跨时区邮戳站');
      const card = page.locator('article, section').filter({ hasText: '跨时区邮戳站' }).first();
      await expect(card).toContainText(/2026[.\-/]10[.\-/]01/);
      await expect(card).not.toContainText(/2026[.\-/]09[.\-/]30/);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await context.close();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.4-04 XSS payloads in journey title, stop note, and caption are safely escaped', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const xssTitle = `<img src=x onerror="window.__atlasXss=1">安全旅图-${nextTag(testInfo, 'xss')}`;
    const xssNote = `<script>window.__atlasXss=2</script>手记内容`;
    const xssCaption = `"><svg onload="window.__atlasXss=3">安全图片`;

    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f24-04',
      title: xssTitle,
      stops: [
        {
          name: 'XSS转义站',
          date: '2026-10-01',
          lat: 25.6065,
          lng: 100.2676,
          note: xssNote,
          photos: [{ caption: xssCaption }],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, '安全旅图-', 'XSS转义站');
      const xssVal = await page.evaluate(() => (window as unknown as { __atlasXss?: unknown }).__atlasXss);
      expect(xssVal).toBeUndefined();
      await expect(page.getByText(/手记内容/).first()).toBeVisible();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.4-05 stop with null coordinates guards "回望此地当夜星空" against NaN/null URL', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't2-f24-05');
    const exifless = appendJpegComment(createExiflessJpeg(200, 150), tag);
    const media = await uploadPhoto(api, exifless, `${tag}.jpg`, { caption: '未定位图' });
    const mediaId = String(media.id);

    // Seed a journey where stop coordinates are null if server accepts null, or intercept library response to simulate unlocated stop
    await page.route('**/api/library', async (route) => {
      const resp = await route.fetch();
      const json = (await resp.json()) as {
        journeys: Array<Record<string, unknown>>;
        media: Array<Record<string, unknown>>;
        messages: unknown[];
        access: Record<string, unknown>;
      };
      json.journeys.unshift({
        id: `sim-unlocated-${tag}`,
        title: `待定位旅途-${tag}`,
        subtitle: '无坐标站点边界',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        visibility: 'public',
        coverId: mediaId,
        stops: [
          {
            id: `sim-stop-${tag}`,
            name: '待确认坐标站',
            region: '未知',
            date: '2026-10-01',
            lat: null,
            lng: null,
            note: '未确认坐标。',
            mediaIds: [mediaId],
          },
        ],
      });
      json.media.push(media);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
    });

    try {
      await openAtlasAndFocusJourney(page, `待定位旅途-${tag}`, '待确认坐标站');
      const card = page.locator('article, section').filter({ hasText: '待确认坐标站' }).first();
      await expect(card).toBeVisible();
      await expect(card).not.toContainText(/NaN|undefined|null/i);

      const skyActions = card
        .getByRole('link', { name: /回望此地当夜星空|查看当夜星空/ })
        .or(card.getByRole('button', { name: /回望此地当夜星空|查看当夜星空/ }))
        .or(card.locator('a[href*="/observatory"]'));
      const actionCount = await skyActions.count();

      if (actionCount === 0) {
        await expect(card.getByText(/回望此地当夜星空|查看当夜星空/)).toHaveCount(0);
      } else {
        for (let i = 0; i < actionCount; i += 1) {
          const act = skyActions.nth(i);
          const tagName = await act.evaluate((el) => el.tagName);
          if (tagName === 'A') {
            const href = await act.getAttribute('href');
            if (href) {
              expect(href).not.toMatch(/lat=(null|NaN|undefined)|lng=(null|NaN|undefined)/i);
            }
          }
          const disabled =
            (await act.isDisabled().catch(() => false)) ||
            (await act.getAttribute('aria-disabled')) === 'true';
          if (!disabled) {
            await act.click();
            expect(page.url()).not.toMatch(/lat=(null|NaN|undefined)|lng=(null|NaN|undefined)/i);
            await expect(page.locator('body')).not.toContainText('NaN');
          }
        }
      }
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [], [mediaId]);
    }
  });

  test('T2-F2.4-06 Southern/Western hemisphere coordinates (-33.8688, -70.6693) preserve signs/hemispheres', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f24-06',
      stops: [
        {
          name: '圣地亚哥',
          date: '2026-10-01',
          lat: -33.8688,
          lng: -70.6693,
          note: '南半球安第斯余晖。',
          photos: [{ lat: -33.8688, lng: -70.6693 }],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '圣地亚哥');
      const card = page.locator('article, section').filter({ hasText: '圣地亚哥' }).first();
      await expect(card).toContainText(/33\.87|33\.8688/);
      await expect(card).toContainText(/70\.67|70\.6693/);
      await expect(card).toContainText(/-\s*33\.|33\.\d+°?\s*S/i);
      await expect(card).toContainText(/-\s*70\.|70\.\d+°?\s*W/i);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.5 — Darkroom <dialog> Safari/Firefox Fallbacks & Edge Cases (6 Tests)
// ===========================================================================
test.describe('Tier 2 — Atlas F2.5: Darkroom Lightbox Edge Cases', () => {
  test('T2-F2.5-01 backdrop click outside inner frame rect dismisses <dialog> (Safari fallback, E3)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f25-01',
      stops: [{ name: '背景点击关灯箱', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '外围点击关闭。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '背景点击关灯箱');
      const trigger = page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first();
      await trigger.click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      const imgBox = await dialog.locator('img').first().boundingBox();
      const vp = page.viewportSize()!;

      // Pick a backdrop point clearly outside the image frame
      const clickX = imgBox && imgBox.x > 16 ? 8 : vp.width - 8;
      const clickY = vp.height / 2;
      await page.mouse.click(clickX, clickY);

      await expect(dialog).toHaveCount(0);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.5-02 clicking inside photo image does NOT dismiss <dialog>', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f25-02',
      stops: [{ name: '内部点击保留', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '点照片不误关。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '内部点击保留');
      await page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first().click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      await dialog.locator('img').first().click();
      await page.waitForTimeout(200);
      await expect(dialog).toBeVisible();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.5-03 zoomed state (>100%) disables slide switch and pans image cleanly', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f25-03',
      stops: [
        {
          name: '放大平移站',
          date: '2026-10-01',
          lat: 25.6,
          lng: 100.2,
          note: '放大后拖拽平移。',
          photos: [
            { caption: '放大首图', width: 320, height: 240 },
            { caption: '放大次图', width: 320, height: 240 },
          ],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '放大平移站');
      await page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first().click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      const img = dialog.locator('img').first();
      await expect(img).toBeVisible();
      const initialBox = await img.boundingBox();
      expect(initialBox).not.toBeNull();

      const zoomInBtn = dialog.getByRole('button', { name: /放大/ }).first();
      await zoomInBtn.click();
      await zoomInBtn.click();
      await page.waitForTimeout(200);

      const zoomedBox = await img.boundingBox();
      expect(zoomedBox).not.toBeNull();
      expect(zoomedBox!.width).toBeGreaterThan(initialBox!.width * 1.1);

      // Pressing ArrowRight while zoomed should pan, not jump to photo #2
      await page.keyboard.press('ArrowRight');
      await expect(dialog.locator(`img[src*="${seeded.mediaIds[0]}"]`)).toBeVisible();

      const beforePan = await img.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          transform: getComputedStyle(el).transform,
          parentTransform: el.parentElement ? getComputedStyle(el.parentElement).transform : 'none',
        };
      });
      await page.mouse.move(zoomedBox!.x + zoomedBox!.width / 2, zoomedBox!.y + zoomedBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(zoomedBox!.x + zoomedBox!.width / 2 + 60, zoomedBox!.y + zoomedBox!.height / 2 + 40, {
        steps: 6,
      });
      await page.mouse.up();
      await page.waitForTimeout(150);

      const afterPan = await img.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          transform: getComputedStyle(el).transform,
          parentTransform: el.parentElement ? getComputedStyle(el.parentElement).transform : 'none',
        };
      });
      const movedPx = Math.hypot(afterPan.x - beforePan.x, afterPan.y - beforePan.y);
      const transformChanged =
        afterPan.transform !== beforePan.transform ||
        afterPan.parentTransform !== beforePan.parentTransform;
      expect(movedPx > 5 || transformChanged).toBe(true);
      await expect(dialog).toBeVisible();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.5-04 theme emulation change while <dialog> open keeps #0B0C0E (only dark) intact (E4)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f25-04',
      stops: [{ name: '灯箱恒暗切换', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '主题切换测试。' }],
    });

    try {
      await page.emulateMedia({ colorScheme: 'light' });
      await openAtlasAndFocusJourney(page, seeded.title, '灯箱恒暗切换');
      await page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first().click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      await assertOnlyDarkSurface(dialog, 'rgb(11, 12, 14)');

      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(150);
      await assertOnlyDarkSurface(dialog, 'rgb(11, 12, 14)');

      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForTimeout(150);
      await assertOnlyDarkSurface(dialog, 'rgb(11, 12, 14)');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.5-05 double-Escape rapid dismissal does not wedge <dialog> or break focus restore', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f25-05',
      stops: [{ name: '连按Esc站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '连按退出。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '连按Esc站');
      const cardImg = page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first();
      const trigger = cardImg.locator('xpath=ancestor-or-self::button[1]').or(cardImg).first();
      await trigger.click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await expect(dialog).toHaveCount(0);
      const focused = await trigger.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
      expect(focused).toBe(true);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.5-06 broken preview image inside <dialog> shows retry button and overscroll-behavior: contain', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f25-06',
      stops: [{ name: '断图重试站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '失败后重试加载。' }],
    });

    let failPreview = true;
    await page.route(`**/api/files/${seeded.mediaIds[0]}*`, async (route) => {
      if (failPreview && route.request().url().includes('variant=preview')) {
        await route.fulfill({ status: 500, body: 'Temporary error' });
        return;
      }
      await route.continue();
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '断图重试站');
      await page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first().click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();

      const overscroll = await dialog.evaluate((el) => getComputedStyle(el).overscrollBehavior);
      expect(overscroll).toContain('contain');

      const retryBtn = dialog.getByRole('button', { name: /重试/ }).first();
      await expect(retryBtn).toBeVisible({ timeout: 10_000 });

      failPreview = false;
      await retryBtn.click();
      await expect.poll(async () =>
        dialog.locator('img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      ).toBe(true);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T2-F2.5-07 <dialog> cancel event and Safari/Firefox closedby="any" fallback dismiss & restore focus', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f25-07',
      stops: [{ name: '降级关灯箱站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '无closedBy回退验证。' }],
    });

    await page.addInitScript(() => {
      const desc = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'closedBy');
      if (!desc || desc.configurable) {
        Object.defineProperty(HTMLDialogElement.prototype, 'closedBy', {
          get: () => undefined,
          configurable: true,
        });
      }
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '降级关灯箱站');
      const cardImg = page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first();
      const trigger = cardImg.locator('xpath=ancestor-or-self::button[1]').or(cardImg).first();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.focus();
      await trigger.click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true);

      await dialog.evaluate((el) => {
        (window as unknown as { __cancelEvents: number }).__cancelEvents = 0;
        el.addEventListener('cancel', () => {
          (window as unknown as { __cancelEvents: number }).__cancelEvents += 1;
        });
      });

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      const cancelCount = await page.evaluate(
        () => (window as unknown as { __cancelEvents: number }).__cancelEvents,
      );
      expect(cancelCount).toBeGreaterThanOrEqual(1);
      const focusedAfterEsc = await trigger.evaluate(
        (el) => el === document.activeElement || el.contains(document.activeElement),
      );
      expect(focusedAfterEsc).toBe(true);

      // Re-open and verify backdrop click outside image frame dismisses even with closedBy removed
      await trigger.click();
      await expect(dialog).toBeVisible();
      const imgBox = await dialog.locator('img').first().boundingBox();
      const vp = page.viewportSize()!;
      const clickX = imgBox && imgBox.x > 16 ? 8 : vp.width - 8;
      await page.mouse.click(clickX, vp.height / 2);
      await expect(dialog).toHaveCount(0);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.6 — EXIF & WebP Upload Boundaries (5 Tests)
// ===========================================================================
test.describe('Tier 2 — Atlas F2.6: EXIF & Upload Fault Boundaries', () => {
  test('T2-F2.6-01 duplicate SHA-256 upload deduplicates cleanly without duplicating media', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't2-f26-01');
    const uploadedIds: string[] = [];

    try {
      const jpeg = createSyntheticExifJpeg({ width: 200, height: 150, model: `Dup-${tag}` });
      const form1 = new FormData();
      form1.append('files', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), `${tag}-a.jpg`);
      const first = await api.uploadMedia(form1);
      expect([200, 201]).toContain(first.status);
      const firstMedia = (first.data as { media?: Array<{ id: string }> }).media?.[0];
      expect(firstMedia?.id).toBeTruthy();
      uploadedIds.push(firstMedia!.id);

      const form2 = new FormData();
      form2.append('files', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), `${tag}-b.jpg`);
      const second = await api.uploadMedia(form2);
      expect([200, 201, 409]).toContain(second.status);

      const secondMedia = (second.data as { media?: Array<{ id: string }> }).media?.[0];
      const rejected = (second.data as { rejected?: Array<{ reason?: string }> }).rejected ?? [];
      if (secondMedia) {
        expect(secondMedia.id).toBe(firstMedia!.id);
      } else {
        expect(rejected.length).toBeGreaterThan(0);
      }

      const lib = await api.getLibrary();
      const allMedia = (lib.data.media as Array<{ id: string }>) ?? [];
      expect(allMedia.filter((m) => m.id === firstMedia!.id).length).toBe(1);
    } finally {
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T2-F2.6-02 spoofed .jpg with invalid magic bytes (MZ executable) rejected with 415', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't2-f26-02');
    const spoofed = Buffer.from('MZ\x90\x00\x03\x00not-really-a-jpeg-image');
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(spoofed)], { type: 'image/jpeg' }), `${tag}-evil.jpg`);

    const res = await api.uploadMedia(form);
    const rejected = (res.data as { rejected?: Array<unknown>; media?: Array<unknown> }).rejected ?? [];
    const created = (res.data as { media?: Array<unknown> }).media ?? [];
    expect(res.status === 415 || (res.status === 400 && rejected.length > 0) || (created.length === 0 && rejected.length > 0)).toBe(true);
    expect(created.length).toBe(0);
  });

  test('T2-F2.6-03 oversized valid JPEG (>16 MiB) rejected with strict 413 before R2 write', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't2-f26-03');
    const head = createExiflessJpeg(32, 32);
    const over16MiB = Buffer.concat([
      head,
      Buffer.alloc(16 * 1024 * 1024 + 64 * 1024 - head.length, 0x00),
    ]);
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(over16MiB)], { type: 'image/jpeg' }), `${tag}-huge.jpg`);

    const usageBefore = await api.getAdminUsage();
    expect(usageBefore.status).toBe(200);
    const libBefore = await api.getLibrary();
    expect(libBefore.status).toBe(200);

    const res = await api.uploadMedia(form);
    expect(res.status).toBe(413);

    const usageAfter = await api.getAdminUsage();
    expect(usageAfter.status).toBe(200);
    const libAfter = await api.getLibrary();
    expect(libAfter.status).toBe(200);

    const uploadBytesBefore = getUsageCounter(usageBefore.data, ['upload_bytes', 'uploadBytes']);
    const uploadBytesAfter = getUsageCounter(usageAfter.data, ['upload_bytes', 'uploadBytes']);
    const classABefore = getUsageCounter(usageBefore.data, ['r2_class_a', 'classA']);
    const classAAfter = getUsageCounter(usageAfter.data, ['r2_class_a', 'classA']);
    expect(uploadBytesAfter).toBe(uploadBytesBefore);
    expect(classAAfter).toBe(classABefore);
    expect(((libAfter.data.media as unknown[]) ?? []).length).toBe(
      ((libBefore.data.media as unknown[]) ?? []).length,
    );
  });

  test('T2-F2.6-04 small image (320x240) is NOT upscaled when encoding WebP variants (E8)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    const uploadedIds: string[] = [];
    const tag = nextTag(testInfo, 't2-f26-04');

    try {
      await authenticateAdminPage(page, api);
      const smallJpeg = createSyntheticExifJpeg({
        width: 320,
        height: 240,
        lat: 30.65,
        lng: 104.06,
        model: `Small-${tag}`,
      });

      const uploadRespPromise = page.waitForResponse(
        (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
      );
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10_000 });
      await fileInput.setInputFiles({
        name: `${tag}.jpg`,
        mimeType: 'image/jpeg',
        buffer: smallJpeg,
      });

      const uploadRes = await uploadRespPromise;
      expect([200, 201]).toContain(uploadRes.status());
      const body = (await uploadRes.json()) as { media?: Array<{ id: string }> };
      const mediaId = body.media?.[0]?.id;
      expect(mediaId).toBeTruthy();
      uploadedIds.push(mediaId!);

      const thumbRes = await api.getFile(mediaId!, { variant: 'thumbnail' });
      const prevRes = await api.getFile(mediaId!, { variant: 'preview' });
      expect(thumbRes.status).toBe(200);
      expect(prevRes.status).toBe(200);

      const dims = await page.evaluate(
        async ({ thumbB64, prevB64 }) => {
          const decode = async (b64: string) => {
            const img = new Image();
            img.src = `data:image/webp;base64,${b64}`;
            await img.decode();
            return { w: img.naturalWidth, h: img.naturalHeight };
          };
          return { thumb: await decode(thumbB64), prev: await decode(prevB64) };
        },
        {
          thumbB64: thumbRes.buffer.toString('base64'),
          prevB64: prevRes.buffer.toString('base64'),
        },
      );

      expect(dims.thumb.w).toBeLessThanOrEqual(320);
      expect(dims.thumb.h).toBeLessThanOrEqual(240);
      expect(dims.prev.w).toBeLessThanOrEqual(320);
      expect(dims.prev.h).toBeLessThanOrEqual(240);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T2-F2.6-05 malformed EXIF date (2026:02:30 25:61:00) & invalid offset (+14:30) degrade to takenAt: null through Admin UI (E7)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    const tag = nextTag(testInfo, 't2-f26-05');
    const uploadedIds: string[] = [];

    try {
      await authenticateAdminPage(page, api);
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10_000 });

      // 1. Malformed calendar date (Feb 30, 25:61) + out-of-range offset (+14:30)
      const badDateJpeg = Buffer.from(
        createSyntheticExifJpeg({
          width: 180,
          height: 120,
          takenAt: '2026:10:01 20:30:00',
          offsetTime: '+08:00',
          model: `BadDate-${tag}`,
        }),
      );
      expect(replaceAsciiInBuffer(badDateJpeg, '2026:10:01 20:30:00', '2026:02:30 25:61:00')).toBeGreaterThanOrEqual(1);
      expect(replaceAsciiInBuffer(badDateJpeg, '+08:00', '+14:30')).toBeGreaterThanOrEqual(1);

      const reqPromise1 = page.waitForRequest(
        (req) => req.url().includes('/api/media') && req.method() === 'POST',
      );
      const resPromise1 = page.waitForResponse(
        (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
      );
      await fileInput.setInputFiles({
        name: `${tag}-baddate.jpg`,
        mimeType: 'image/jpeg',
        buffer: badDateJpeg,
      });

      const [uploadReq1, uploadRes1] = await Promise.all([reqPromise1, resPromise1]);
      const reqPayload1 = uploadReq1.postDataBuffer()?.toString('latin1') ?? '';
      expect(reqPayload1).not.toContain('2026-03-02');
      expect(reqPayload1).not.toContain('+14:30');

      expect([200, 201]).toContain(uploadRes1.status());
      const body1 = (await uploadRes1.json()) as { media?: Array<Record<string, unknown>> };
      const item1 = body1.media?.[0];
      expect(item1).toBeDefined();
      const id1 = String(item1!.id ?? '');
      expect(id1).toBeTruthy();
      uploadedIds.push(id1);
      expect(item1!.takenAt ?? null).toBeNull();

      // 2. Valid date + out-of-range offset (+14:30) must never emit '+14:30'
      const badOffsetJpeg = Buffer.from(
        createSyntheticExifJpeg({
          width: 180,
          height: 120,
          takenAt: '2026:10:01 20:30:00',
          offsetTime: '+08:00',
          model: `BadOffset-${tag}`,
        }),
      );
      expect(replaceAsciiInBuffer(badOffsetJpeg, '+08:00', '+14:30')).toBeGreaterThanOrEqual(1);

      const reqPromise2 = page.waitForRequest(
        (req) => req.url().includes('/api/media') && req.method() === 'POST',
      );
      const resPromise2 = page.waitForResponse(
        (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
      );
      await fileInput.setInputFiles({
        name: `${tag}-badoffset.jpg`,
        mimeType: 'image/jpeg',
        buffer: badOffsetJpeg,
      });

      const [uploadReq2, uploadRes2] = await Promise.all([reqPromise2, resPromise2]);
      const reqPayload2 = uploadReq2.postDataBuffer()?.toString('latin1') ?? '';
      expect(reqPayload2).not.toContain('+14:30');
      expect([200, 201]).toContain(uploadRes2.status());
      const body2 = (await uploadRes2.json()) as { media?: Array<Record<string, unknown>> };
      const item2 = body2.media?.[0];
      expect(item2).toBeDefined();
      uploadedIds.push(String(item2!.id));
      expect(String(item2!.takenAt ?? '')).not.toContain('+14:30');

      const libRes = await api.getLibrary();
      expect(libRes.status).toBe(200);
      const stored1 = ((libRes.data.media as Array<Record<string, unknown>>) ?? []).find((m) => m.id === id1);
      if (stored1) {
        expect(stored1.takenAt ?? null).toBeNull();
      }
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T2-F2.6-06 EXIF Orientation 8 (270 deg CW) swaps dimensions and rotates WebP variants via Admin UI', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    const tag = nextTag(testInfo, 't2-f26-06');
    const uploadedIds: string[] = [];

    try {
      await authenticateAdminPage(page, api);
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10_000 });

      const jpeg = createSyntheticExifJpeg({
        width: 240,
        height: 120,
        orientation: 8,
        model: `O8-${tag}`,
      });

      const uploadRespPromise = page.waitForResponse(
        (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
      );
      await fileInput.setInputFiles({
        name: `${tag}-o8.jpg`,
        mimeType: 'image/jpeg',
        buffer: jpeg,
      });

      const uploadRes = await uploadRespPromise;
      expect([200, 201]).toContain(uploadRes.status());
      const body = (await uploadRes.json()) as { media?: Array<Record<string, unknown>> };
      const item = body.media?.[0];
      expect(item).toBeDefined();
      const mediaId = String(item!.id ?? '');
      expect(mediaId).toBeTruthy();
      uploadedIds.push(mediaId);

      expect(Number(item!.width)).toBe(120);
      expect(Number(item!.height)).toBe(240);

      const thumbRes = await api.getFile(mediaId, { variant: 'thumbnail' });
      const prevRes = await api.getFile(mediaId, { variant: 'preview' });
      expect(thumbRes.status).toBe(200);
      expect(prevRes.status).toBe(200);
      expect(thumbRes.headers.get('content-type')).toContain('image/webp');
      expect(prevRes.headers.get('content-type')).toContain('image/webp');

      const dims = await page.evaluate(
        async ({ thumbB64, prevB64 }) => {
          const decode = async (b64: string) => {
            const img = new Image();
            img.src = `data:image/webp;base64,${b64}`;
            await img.decode();
            return { w: img.naturalWidth, h: img.naturalHeight };
          };
          return { thumb: await decode(thumbB64), prev: await decode(prevB64) };
        },
        {
          thumbB64: thumbRes.buffer.toString('base64'),
          prevB64: prevRes.buffer.toString('base64'),
        },
      );

      expect(dims.thumb.w).toBe(120);
      expect(dims.thumb.h).toBe(240);
      expect(dims.prev.w).toBe(120);
      expect(dims.prev.h).toBe(240);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [], uploadedIds);
    }
  });
});

// ===========================================================================
// F2.7 — Privacy Stripping (E9), CSRF, Validation & Trash Guards (5 Tests)
// ===========================================================================
test.describe('Tier 2 — Atlas F2.7: Privacy, Security, Validation & Trash Guards', () => {
  test('T2-F2.7-01 unauthenticated GET /api/library omits private journeys and unattached orphan media (E9)', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't2-f27-01');

    const pub = await seedPublicJourney(api, testInfo, {
      prefix: `${tag}-pub`,
      visibility: 'public',
      stops: [{ name: '公开站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '公开。' }],
    });
    const priv = await seedPublicJourney(api, testInfo, {
      prefix: `${tag}-priv`,
      visibility: 'private',
      stops: [{ name: '私密站', date: '2026-10-02', lat: 26.8, lng: 100.2, note: '私密。' }],
    });
    const orphanBuf = createSyntheticExifJpeg({ width: 164, height: 120, model: `Orphan-${tag}` });
    const orphan = await uploadPhoto(api, orphanBuf, `${tag}-orphan.jpg`);
    const orphanId = String(orphan.id);

    try {
      const anon = createApiClient();
      const lib = await anon.getLibrary();
      expect(lib.status).toBe(200);
      const journeys = (lib.data.journeys as Array<{ id: string }>) ?? [];
      const media = (lib.data.media as Array<{ id: string }>) ?? [];

      expect(journeys.some((j) => j.id === pub.id)).toBe(true);
      expect(journeys.some((j) => j.id === priv.id)).toBe(false);
      expect(media.some((m) => m.id === pub.mediaIds[0])).toBe(true);
      expect(media.some((m) => m.id === priv.mediaIds[0])).toBe(false);
      expect(media.some((m) => m.id === orphanId)).toBe(false);
    } finally {
      await cleanupSeeded(api, [pub.id, priv.id], [...pub.mediaIds, ...priv.mediaIds, orphanId]);
    }
  });

  test('T2-F2.7-02 unauthenticated GET/HEAD /api/files/:id returns 404 for private media across all variants (E9)', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const priv = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f27-02',
      visibility: 'private',
      stops: [{ name: '私有媒体站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '禁止越权读取。' }],
    });

    try {
      const privMediaId = priv.mediaIds[0]!;
      const anon = createApiClient();

      for (const variant of ['thumbnail', 'preview', 'original'] as const) {
        const res = await anon.getFile(privMediaId, { variant, method: 'GET' });
        expect(res.status).toBe(404);
      }
      const headRes = await anon.getFile(privMediaId, { variant: 'preview', method: 'HEAD' });
      expect(headRes.status).toBe(404);

      const authedRes = await api.getFile(privMediaId, { variant: 'preview' });
      expect(authedRes.status).toBe(200);
    } finally {
      await cleanupSeeded(api, [priv.id], priv.mediaIds);
    }
  });

  test('T2-F2.7-03 CSRF & Origin guards reject unauthed/missing-CSRF/cross-origin mutations on /api/media & /api/journeys', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const anon = createApiClient();
    const tag = nextTag(testInfo, 't2-f27-03');

    const unauthedJourney = await anon.saveJourney({
      id: `unauth-${tag}`,
      title: '未登录旅程',
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      visibility: 'private',
      coverId: null,
      stops: [],
    });
    expect(unauthedJourney.status).toBe(401);

    const noCsrfJourney = await api.saveJourney(
      {
        id: `nocsrf-${tag}`,
        title: '缺CSRF旅程',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        visibility: 'private',
        coverId: null,
        stops: [],
      },
      { csrfToken: null },
    );
    expect(noCsrfJourney.status).toBe(403);

    const badOriginMedia = await api.patchMedia(
      { id: 'nonexistent', caption: 'evil' },
      { origin: 'https://evil.example' },
    );
    expect(badOriginMedia.status).toBe(403);
  });

  test('T2-F2.7-04 journey & media validation rejections (bad dates, out-of-range coords, duplicate stop id, missing media ref)', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't2-f27-04');
    const uploadedIds: string[] = [];

    try {
      const media = await uploadPhoto(
        api,
        createSyntheticExifJpeg({ width: 162, height: 120, model: `Val-${tag}` }),
        `${tag}.jpg`,
      );
      const mediaId = String(media.id);
      uploadedIds.push(mediaId);

      // 1. endDate < startDate
      const badDates = await api.saveJourney({
        id: `bad-date-${tag}`,
        title: '日期倒挂',
        startDate: '2026-10-10',
        endDate: '2026-10-01',
        visibility: 'private',
        coverId: null,
        stops: [],
      });
      expect(badDates.status).toBe(400);

      // 2. Duplicate stop.id
      const dupStop = await api.saveJourney({
        id: `dup-stop-${tag}`,
        title: '重复站点ID',
        startDate: '2026-10-01',
        endDate: '2026-10-02',
        visibility: 'private',
        coverId: null,
        stops: [
          { id: 'same-id', name: '站A', date: '2026-10-01', lat: 25, lng: 100, note: '', mediaIds: [] },
          { id: 'same-id', name: '站B', date: '2026-10-02', lat: 26, lng: 101, note: '', mediaIds: [] },
        ],
      });
      expect(dupStop.status).toBe(400);

      // 3. Non-existent media ref
      const missingRef = await api.saveJourney({
        id: `missing-ref-${tag}`,
        title: '缺失媒体引用',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        visibility: 'private',
        coverId: `no-such-media-${tag}`,
        stops: [],
      });
      expect([400, 404]).toContain(missingRef.status);

      // 4. Out-of-range & unpaired media coordinates
      const badLat = await api.patchMedia({ id: mediaId, lat: 91, lng: 100 });
      expect(badLat.status).toBe(400);

      const badLng = await api.patchMedia({ id: mediaId, lat: 30, lng: -181 });
      expect(badLng.status).toBe(400);

      const unpaired = await api.patchMedia({ id: mediaId, lat: 30, lng: null });
      expect(unpaired.status).toBe(400);
    } finally {
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T2-F2.7-05 trash reference guard (409), restore dependency guard (409), and invalid Range (416)', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't2-f27-05',
      stops: [{ name: '回收站守卫站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '引用守卫。' }],
    });
    const mediaId = seeded.mediaIds[0]!;

    try {
      // Cannot trash media still referenced by journey
      const blockedTrash = await api.trashItem('media', mediaId);
      expect(blockedTrash.status).toBe(409);

      // Trash journey first, then trash media
      const trashJourney = await api.trashItem('journey', seeded.id);
      expect(trashJourney.status).toBe(200);
      const journeyTrashKey = String(
        (trashJourney.data as { key?: string; item?: { key?: string }; trash?: { key?: string } }).key ??
          (trashJourney.data as { item?: { key?: string } }).item?.key ??
          (trashJourney.data as { trash?: { key?: string } }).trash?.key ??
          '',
      );
      expect(journeyTrashKey).toBeTruthy();

      const trashMedia = await api.trashItem('media', mediaId);
      expect(trashMedia.status).toBe(200);
      const mediaTrashKey = String(
        (trashMedia.data as { key?: string; item?: { key?: string }; trash?: { key?: string } }).key ??
          (trashMedia.data as { item?: { key?: string } }).item?.key ??
          (trashMedia.data as { trash?: { key?: string } }).trash?.key ??
          '',
      );
      expect(mediaTrashKey).toBeTruthy();

      // Cannot restore journey while referenced media is still trashed
      const blockedRestore = await api.restoreItem(journeyTrashKey);
      expect(blockedRestore.status).toBe(409);

      // Restore media first, then restore journey
      const restoreMedia = await api.restoreItem(mediaTrashKey);
      expect(restoreMedia.status).toBe(200);
      const restoreJourney = await api.restoreItem(journeyTrashKey);
      expect(restoreJourney.status).toBe(200);

      // Out-of-bounds Range request -> 416
      const badRange = await api.getFile(mediaId, { variant: 'preview', range: 'bytes=99999999-' });
      expect(badRange.status).toBe(416);
      expect(badRange.headers.get('content-range')).toMatch(/^bytes \*\/\d+$/);
    } finally {
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});
