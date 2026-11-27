import zlib from 'node:zlib';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  assertDemoImagesExist,
  createExiflessJpeg,
  createSyntheticExifJpeg,
  readDemoImage,
  type SyntheticExifJpegOptions,
} from '../fixtures/exif-jpeg';
import { ApiClient, createApiClient } from '../helpers/api-client';
import {
  assertImageAspectRatioPreserved,
  assertOnlyDarkSurface,
  attachErrorListeners,
  scanAntiAiTaste,
  verifySelfHostedFonts,
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
  stopIds: string[];
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
  // Insert a standard JPEG COM (0xFF 0xFE) marker right after SOI (0xFF 0xD8)
  // so SHA-256 is unique while preserving JFIF/EXIF headers intact.
  const textBytes = Buffer.from(comment, 'utf8');
  const len = 2 + textBytes.length;
  const com = Buffer.allocUnsafe(4 + textBytes.length);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(len, 2);
  textBytes.copy(com, 4);
  return Buffer.concat([jpeg.subarray(0, 2), com, jpeg.subarray(2)]);
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
    throw new Error(`POST /api/media did not return a valid Media id: ${res.text}`);
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
      lat: number;
      lng: number;
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
        takenAt: pSpec.takenAt ?? undefined,
        caption: pSpec.caption ?? `${stopSpec.name}影像-${sIdx}-${pIdx}`,
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

  const journeyTitle = opts.title ?? `旅途手记-${tag}`;
  const journeySubtitle = opts.subtitle ?? `一段克制的实地采样路线-${tag}`;
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
  const id = String(saved.id ?? `journey-${tag}`);
  return {
    id,
    title: journeyTitle,
    subtitle: journeySubtitle,
    mediaIds,
    stopIds: stopsPayload.map((s) => s.id),
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
  expectedStopName?: string,
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
  if (expectedStopName) {
    await expect(page.getByText(expectedStopName).first()).toBeVisible({ timeout: 15_000 });
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
    const submitBtn = page.getByRole('button', { name: /登录|进入|确认|提交/ }).first();
    await submitBtn.click();
    await expect(passwordInput).toBeHidden({ timeout: 10_000 });
  }
}

function getMapCanvas(page: Page): Locator {
  return page.locator('main canvas, [role="region"] canvas, .maplibregl-canvas').first();
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

interface CanvasPngAnalysis {
  ok: boolean;
  reason: string;
  width: number;
  height: number;
  distinctColors: number;
  differingPixels: number;
  nonTransparentCount: number;
  channelSpread: number;
}

function analyzeCanvasPng(png: Buffer, label = 'canvas'): CanvasPngAnalysis {
  const fail = (reason: string): CanvasPngAnalysis => ({
    ok: false,
    reason,
    width: 0,
    height: 0,
    distinctColors: 0,
    differingPixels: 0,
    nonTransparentCount: 0,
    channelSpread: 0,
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

  const readRgba = (x: number, y: number): [number, number, number, number] => {
    const idx = y * stride + x * bpp;
    if (colorType === 6) return [pixels[idx]!, pixels[idx + 1]!, pixels[idx + 2]!, pixels[idx + 3]!];
    if (colorType === 2) return [pixels[idx]!, pixels[idx + 1]!, pixels[idx + 2]!, 255];
    if (colorType === 4) {
      const g = pixels[idx]!;
      return [g, g, g, pixels[idx + 1]!];
    }
    if (colorType === 3 && plte) {
      const pIdx = pixels[idx]! * 3;
      return [plte[pIdx] ?? 0, plte[pIdx + 1] ?? 0, plte[pIdx + 2] ?? 0, 255];
    }
    const g = pixels[idx]!;
    return [g, g, g, 255];
  };

  const step = width * height > 300_000 ? 2 : 1;
  const [r0, g0, b0, a0] = readRgba(0, 0);
  const uniqueColors = new Set<number>();
  let nonTransparentCount = 0;
  let differingPixels = 0;
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  let minA = 255;
  let maxA = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const [r, g, b, a] = readRgba(x, y);
      if (a > 0) nonTransparentCount += 1;
      uniqueColors.add(((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) + Math.abs(a - a0) >= 12) {
        differingPixels += 1;
      }
    }
  }

  const channelSpread = Math.max(maxR - minR, maxG - minG, maxB - minB, maxA - minA);
  const ok = nonTransparentCount > 0 && uniqueColors.size >= 4 && differingPixels >= 50 && channelSpread >= 12;
  return {
    ok,
    reason: ok
      ? 'ok'
      : `${label} PNG appears uniform/blank (opaque=${nonTransparentCount}, colors=${uniqueColors.size}, differing=${differingPixels}, spread=${channelSpread})`,
    width,
    height,
    distinctColors: uniqueColors.size,
    differingPixels,
    nonTransparentCount,
    channelSpread,
  };
}

function checkCanvasPngNonUniform(png: Buffer): boolean {
  return analyzeCanvasPng(png).ok;
}

async function expectCanvasNonUniform(locator: Locator, label: string, timeout = 12_000): Promise<Buffer> {
  await expect
    .poll(async () => checkCanvasPngNonUniform(await locator.screenshot()), { timeout })
    .toBe(true);
  const finalPng = await locator.screenshot();
  const analysis = analyzeCanvasPng(finalPng, label);
  expect(analysis.ok, analysis.reason).toBe(true);
  return finalPng;
}

// ===========================================================================
// F2.1 — Atlas Split Map & Journal Layout (5 Tests)
// ===========================================================================
test.describe('Tier 1 — Atlas F2.1: Split Map & Journal Layout', () => {
  test('T1-F2.1-01 desktop ~62%/38% asymmetric split vs mobile bottom drawer preserves map visibility', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f21-01',
      stops: [
        { name: '大理古城', date: '2026-10-01', lat: 25.6948, lng: 100.1616, note: '苍山风起时的青石板路。' },
        { name: '喜洲古镇', date: '2026-10-02', lat: 25.8532, lng: 100.1365, note: '稻浪边的白族照壁。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '大理古城');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });

      const mapBox = await mapCanvas.boundingBox();
      const navBox = await page.locator('header nav, nav').first().boundingBox();
      const cardEl = page.locator('article, section').filter({ hasText: '大理古城' }).first();
      const cardBox = await cardEl.boundingBox();

      expect(mapBox).not.toBeNull();
      expect(cardBox).not.toBeNull();

      if (testInfo.project.name.startsWith('desktop-')) {
        const vw = 1440;
        const mapRatio = mapBox!.width / vw;
        const panelRatio = cardBox!.width / vw;
        expect(mapRatio).toBeGreaterThanOrEqual(0.5);
        expect(mapRatio).toBeLessThanOrEqual(0.7);
        expect(panelRatio).toBeGreaterThanOrEqual(0.28);
        expect(panelRatio).toBeLessThanOrEqual(0.48);
        expect(mapBox!.x + mapBox!.width).toBeLessThanOrEqual(cardBox!.x + 24);
      } else {
        expect(mapBox!.height).toBeGreaterThanOrEqual(160);
        expect(navBox).not.toBeNull();
        expect(mapBox!.y).toBeGreaterThanOrEqual(navBox!.y + navBox!.height - 4);
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(392);
      }

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.1-02 mobile bottom drawer expand/collapse and desktop journal card scrolling', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f21-02',
      stops: [
        { name: '站点一香格里拉', date: '2026-10-01', lat: 27.8269, lng: 99.706, note: '第一站手记。' },
        { name: '站点二飞来寺', date: '2026-10-02', lat: 28.4581, lng: 98.8781, note: '第二站手记。' },
        { name: '站点三盐井', date: '2026-10-03', lat: 29.0439, lng: 98.6001, note: '第三站手记。' },
        { name: '站点四芒康垭口', date: '2026-10-04', lat: 29.6871, lng: 98.5966, note: '第四站手记到达垭口。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '站点一香格里拉');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });

      if (testInfo.project.name.startsWith('mobile-')) {
        const navBox = await page.locator('header nav, nav').first().boundingBox();
        const toggleBtn = page.getByRole('button', { name: /展开|收起|手记|站点|抽屉/ }).first();
        await expect(toggleBtn).toBeVisible();
        const initialMapBox = await mapCanvas.boundingBox();
        await toggleBtn.click();
        await page.waitForTimeout(300);
        const toggleBox = await toggleBtn.boundingBox();
        expect(navBox).not.toBeNull();
        expect(toggleBox).not.toBeNull();
        expect(toggleBox!.y).toBeGreaterThanOrEqual(navBox!.y + navBox!.height - 2);
        await expect(page.getByText('站点四芒康垭口').first()).toBeVisible();
        await toggleBtn.click();
        await page.waitForTimeout(300);
        const collapsedMapBox = await mapCanvas.boundingBox();
        expect(collapsedMapBox!.height).toBeGreaterThanOrEqual(Math.min(160, initialMapBox!.height));
      } else {
        const stop4 = page.getByText('站点四芒康垭口').first();
        await stop4.scrollIntoViewIfNeeded();
        await expect(stop4).toBeVisible();
        const mapBoxAfterScroll = await mapCanvas.boundingBox();
        expect(mapBoxAfterScroll).not.toBeNull();
        expect(mapBoxAfterScroll!.y).toBeGreaterThanOrEqual(0);
        expect(mapBoxAfterScroll!.height).toBeGreaterThan(300);
      }

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.1-03 switching between multiple public journeys updates map focus and journal cards', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const j1 = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f21-03a',
      title: `滇西北环线-${nextTag(testInfo, 'yunnan')}`,
      stops: [{ name: '丽江束河', date: '2026-09-10', lat: 26.9219, lng: 100.205, note: '云南路线手记。' }],
    });
    const j2 = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f21-03b',
      title: `青藏高原南线-${nextTag(testInfo, 'qinghai')}`,
      stops: [{ name: '青海湖黑马河', date: '2026-09-20', lat: 36.731, lng: 99.782, note: '青海路线手记。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, j1.title, '丽江束河');
      await openAtlasAndFocusJourney(page, j2.title, '青海湖黑马河');
      await expect(page.getByText(j2.subtitle).first()).toBeVisible();
      await expect(page.getByText('青海路线手记。').first()).toBeVisible();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [j1.id, j2.id], [...j1.mediaIds, ...j2.mediaIds]);
    }
  });

  test('T1-F2.1-04 clicking a stop card activates that stop and updates active state', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f21-04',
      stops: [
        { name: '昆明翠湖', date: '2026-10-01', lat: 25.049, lng: 102.704, note: '第一站翠湖。' },
        { name: '楚雄彝人古镇', date: '2026-10-02', lat: 25.032, lng: 101.528, note: '第二站楚雄。' },
        { name: '保山腾冲', date: '2026-10-03', lat: 25.021, lng: 98.491, note: '第三站腾冲。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '昆明翠湖');
      const stop2Btn = page
        .getByRole('button', { name: /楚雄彝人古镇/ })
        .or(page.locator('article, section').filter({ hasText: '楚雄彝人古镇' }))
        .first();
      await stop2Btn.scrollIntoViewIfNeeded();
      await stop2Btn.click();

      await expect.poll(async () => {
        const pressed = await stop2Btn.getAttribute('aria-pressed');
        const current = await stop2Btn.getAttribute('aria-current');
        const selected = await stop2Btn.getAttribute('aria-selected');
        return pressed === 'true' || Boolean(current && current !== 'false') || selected === 'true';
      }).toBe(true);

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.1-05 Atlas typography, self-hosted WOFF2 fonts, and anti-AI-taste scan', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f21-05',
      stops: [{ name: '大理双廊', date: '2026-10-01', lat: 25.9102, lng: 100.1912, note: '晚风吹过海面。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '大理双廊');
      const hasH1 = (await page.locator('h1').count()) > 0;
      const fontRes = await verifySelfHostedFonts(page, {
        requireH1: false,
        checkLetterSpacing: hasH1,
      });
      expect(fontRes.loadedFamilies.length).toBeGreaterThan(0);

      const report = await scanAntiAiTaste(page);
      expect(report.violations).toEqual([]);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.2 — MapLibre 2.5D + Tianditu / Offline GeoJSON Fallback (5 Tests)
// ===========================================================================
test.describe('Tier 1 — Atlas F2.2: MapLibre 2.5D & Basemap Fallback', () => {
  test('T1-F2.2-01 lazy-loads maplibre-gl chunk only on /atlas (absent on /)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const homeScripts: string[] = [];
    const atlasScripts: string[] = [];
    let onAtlas = false;

    page.on('request', (req) => {
      if (req.resourceType() === 'script') {
        if (onAtlas) atlasScripts.push(req.url());
        else homeScripts.push(req.url());
      }
    });

    try {
      await page.goto('/', { waitUntil: 'networkidle' });
      expect(homeScripts.some((u) => /maplibre/i.test(u))).toBe(false);

      onAtlas = true;
      await page.getByRole('navigation').locator('a[href="/atlas"]').first().click();
      await expect(page).toHaveURL(/\/atlas/);
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });

      const box = await mapCanvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(200);
      expect(box!.height).toBeGreaterThan(160);

      const hasWebgl = await mapCanvas.evaluate((canvas) => {
        const el = canvas as HTMLCanvasElement;
        return Boolean(el.getContext('webgl2') || el.getContext('webgl'));
      });
      expect(hasWebgl).toBe(true);
      expect(atlasScripts.length).toBeGreaterThan(0);
      expect(atlasScripts.some((u) => /(?:vendor-maplibre|maplibre|atlas)/i.test(u))).toBe(true);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T1-F2.2-02 GET /api/atlas/config reports tiandituConfigured boolean without leaking TIANDITU_KEY', async () => {
    const api = createApiClient();
    const res = await api.getAtlasConfig();
    expect(res.status).toBe(200);
    expect(typeof res.data.tiandituConfigured).toBe('boolean');
    const serialized = JSON.stringify(res.data);
    expect(serialized).not.toMatch(/tianditu_key|"tk"\s*:/i);
  });

  test('T1-F2.2-03 MapLibre interactive pan and wheel zoom keep canvas rendered cleanly', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f22-03',
      stops: [
        { name: '成都天府', date: '2026-10-01', lat: 30.6586, lng: 104.0648, note: '盆地暮色。' },
        { name: '雅安碧峰峡', date: '2026-10-02', lat: 30.0721, lng: 102.9896, note: '雨雾穿过林间。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '成都天府');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });
      const beforeShot = await expectCanvasNonUniform(mapCanvas, 'T1-F2.2-03 before pan');
      const box = await mapCanvas.boundingBox();
      expect(box).not.toBeNull();

      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 60, cy - 30, { steps: 6 });
      await page.mouse.up();
      await page.mouse.wheel(0, -180);
      await page.waitForTimeout(300);

      const shot = await mapCanvas.screenshot();
      const afterAnalysis = analyzeCanvasPng(shot, 'T1-F2.2-03 after pan/zoom');
      expect(afterAnalysis.ok, afterAnalysis.reason).toBe(true);
      expect(Buffer.compare(beforeShot, shot)).not.toBe(0);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.2-04 day/night theme toggle updates Atlas surface tokens without blanking map', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f22-04',
      stops: [{ name: '杭州西湖', date: '2026-10-01', lat: 30.241, lng: 120.148, note: '湖面渐暗。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '杭州西湖');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });

      const beforeScheme = await page.locator('meta[name="color-scheme"]').getAttribute('content');
      const beforeBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      const themeToggle = page.getByRole('button', { name: /浅色|深色|昼|夜|主题|外观|模式/ }).first();
      await expect(themeToggle).toBeVisible();
      await themeToggle.click();
      await page.waitForTimeout(300);

      const afterScheme = await page.locator('meta[name="color-scheme"]').getAttribute('content');
      const afterBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(afterBg !== beforeBg || afterScheme !== beforeScheme).toBe(true);
      await expect(mapCanvas).toBeVisible();
      await expectCanvasNonUniform(mapCanvas, 'T1-F2.2-04 after theme toggle');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.2-05 multi-stop coordinates render non-uniform map canvas and all stops remain reachable', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f22-05',
      stops: [
        { name: '北京故宫', date: '2026-10-01', lat: 39.9163, lng: 116.3972, note: '启程。' },
        { name: '大理洱海', date: '2026-10-03', lat: 25.6065, lng: 100.2676, note: '南行。' },
        { name: '拉萨布达拉', date: '2026-10-06', lat: 29.6555, lng: 91.1172, note: '高原。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '北京故宫');
      const mapCanvas = getMapCanvas(page);
      await expect(mapCanvas).toBeVisible({ timeout: 15_000 });

      // Ensure canvas actually drew non-uniform content (not a solid blank rect)
      await expectCanvasNonUniform(mapCanvas, 'T1-F2.2-05 multi-stop map');

      for (const stopName of ['北京故宫', '大理洱海', '拉萨布达拉']) {
        const stopEl = page.getByText(stopName).first();
        await stopEl.scrollIntoViewIfNeeded();
        await expect(stopEl).toBeVisible();
      }
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.3 — Bezier Flight Track & "沿途回放" Playback (5 Tests)
// ===========================================================================
test.describe('Tier 1 — Atlas F2.3: Bezier Flight Track & Playback', () => {
  test('T1-F2.3-01 clicking "沿途回放" enters active state and auto-advances to next stop', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f23-01',
      stops: [
        { name: '回放甲站', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '甲站记录。' },
        { name: '回放乙站', date: '2026-10-02', lat: 25.6, lng: 100.26, note: '乙站记录。' },
        { name: '回放丙站', date: '2026-10-03', lat: 26.87, lng: 100.23, note: '丙站记录。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '回放甲站');
      const playBtn = page.getByRole('button', { name: /沿途回放/ }).first();
      await expect(playBtn).toBeVisible();
      await playBtn.click();

      // Playback becomes active (button switches to 暂停 or aria-pressed=true) and advances past stop 1
      await expect.poll(async () => {
        const pauseVisible = await page.getByRole('button', { name: /暂停/ }).first().isVisible().catch(() => false);
        const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
        return pauseVisible || pressed === 'true';
      }, { timeout: 5_000 }).toBe(true);

      const stop2 = page.locator('[aria-pressed="true"], [aria-current]').filter({ hasText: '回放乙站' });
      const stop3 = page.locator('[aria-pressed="true"], [aria-current]').filter({ hasText: '回放丙站' });
      await expect.poll(async () => (await stop2.count()) + (await stop3.count()), { timeout: 12_000 }).toBeGreaterThan(0);

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.3-02 pausing "沿途回放" halts automatic progression at current stop', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f23-02',
      stops: [
        { name: '暂停一', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '第一站。' },
        { name: '暂停二', date: '2026-10-02', lat: 26.5, lng: 101.7, note: '第二站。' },
        { name: '暂停三', date: '2026-10-03', lat: 27.8, lng: 99.7, note: '第三站。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '暂停一');
      const playBtn = page.getByRole('button', { name: /沿途回放/ }).first();
      await expect(playBtn).toBeVisible();
      await playBtn.click();

      const pauseBtn = page.getByRole('button', { name: /暂停/ }).first();
      await expect
        .poll(
          async () => {
            const pauseVisible = await pauseBtn.isVisible().catch(() => false);
            const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
            return pauseVisible || pressed === 'true';
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      if (await pauseBtn.isVisible().catch(() => false)) {
        await pauseBtn.click();
      } else {
        await playBtn.click();
      }

      await expect
        .poll(
          async () => {
            const pauseStillVisible = await pauseBtn.isVisible().catch(() => false);
            const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
            return !pauseStillVisible && pressed !== 'true';
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      const activeStops = page
        .locator('main [aria-pressed="true"], main [aria-current="step"], main [aria-current="true"], main [aria-selected="true"]')
        .filter({ hasText: /暂停一|暂停二|暂停三/ });
      await expect.poll(async () => activeStops.count(), { timeout: 5_000 }).toBeGreaterThan(0);
      const activeSnapshot = await activeStops.allInnerTexts();
      expect(activeSnapshot.length).toBeGreaterThan(0);

      await page.waitForTimeout(2600);
      const activeAfterWait = await activeStops.allInnerTexts();
      expect(activeAfterWait).toEqual(activeSnapshot);

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.3-03 resuming playback after pause continues to remaining stops', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f23-03',
      stops: [
        { name: '续播一', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '第一站。' },
        { name: '续播二', date: '2026-10-02', lat: 26.5, lng: 101.7, note: '第二站。' },
        { name: '续播三', date: '2026-10-03', lat: 27.8, lng: 99.7, note: '第三站。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '续播一');
      const playBtn = page.getByRole('button', { name: /沿途回放/ }).first();
      await expect(playBtn).toBeVisible();
      await playBtn.click();

      const pauseBtn = page.getByRole('button', { name: /暂停/ }).first();
      await expect
        .poll(
          async () => {
            const pauseVisible = await pauseBtn.isVisible().catch(() => false);
            const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
            return pauseVisible || pressed === 'true';
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      if (await pauseBtn.isVisible().catch(() => false)) {
        await pauseBtn.click();
      } else {
        await playBtn.click();
      }

      await expect
        .poll(
          async () => {
            const pauseStillVisible = await pauseBtn.isVisible().catch(() => false);
            const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
            return !pauseStillVisible && pressed !== 'true';
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      await page.waitForTimeout(300);

      const resumeBtn = page.getByRole('button', { name: /继续|沿途回放/ }).first();
      await expect(resumeBtn).toBeVisible();
      await resumeBtn.click();

      const stop3Active = page
        .locator('main [aria-pressed="true"], main [aria-current="step"], main [aria-current="true"], main [aria-selected="true"]')
        .filter({ hasText: '续播三' });

      await expect
        .poll(
          async () => {
            const pauseVisible = await pauseBtn.isVisible().catch(() => false);
            const pressed = await resumeBtn.getAttribute('aria-pressed').catch(() => null);
            const reachedEnd = (await stop3Active.count()) > 0;
            return pauseVisible || pressed === 'true' || reachedEnd;
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      await expect.poll(async () => stop3Active.count(), { timeout: 15_000 }).toBeGreaterThan(0);

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.3-04 playback reaches final stop and returns play button to idle state', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f23-04',
      stops: [
        { name: '终点前站', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '起点。' },
        { name: '终章小站', date: '2026-10-02', lat: 25.6, lng: 100.26, note: '终点。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '终点前站');
      const playBtn = page.getByRole('button', { name: /沿途回放/ }).first();
      await expect(playBtn).toBeVisible();
      await playBtn.click();

      const pauseBtn = page.getByRole('button', { name: /暂停/ }).first();
      await expect
        .poll(
          async () => {
            const pauseVisible = await pauseBtn.isVisible().catch(() => false);
            const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
            return pauseVisible || pressed === 'true';
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      const finalStopActive = page
        .locator('main [aria-pressed="true"], main [aria-current="step"], main [aria-current="true"], main [aria-selected="true"]')
        .filter({ hasText: '终章小站' });
      await expect.poll(async () => finalStopActive.count(), { timeout: 15_000 }).toBeGreaterThan(0);

      // Once playback completes, "沿途回放" idle button returns (and pause button disappears)
      await expect(playBtn).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(
          async () => {
            const pauseVisible = await pauseBtn.isVisible().catch(() => false);
            const pressed = await playBtn.getAttribute('aria-pressed').catch(() => null);
            return !pauseVisible && pressed !== 'true';
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.3-05 clicking a stop card during idle updates active stop and route progress indicator', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f23-05',
      stops: [
        { name: '进度一', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '一。' },
        { name: '进度二', date: '2026-10-02', lat: 25.6, lng: 100.26, note: '二。' },
        { name: '进度三', date: '2026-10-03', lat: 26.87, lng: 100.23, note: '三。' },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '进度一');
      const stop3Card = page
        .getByRole('button', { name: /进度三/ })
        .or(page.locator('article, section').filter({ hasText: '进度三' }))
        .first();
      await stop3Card.scrollIntoViewIfNeeded();
      await stop3Card.click();

      await expect(page.getByText(/3\s*\/\s*3|第\s*3\s*站/).first()).toBeVisible({ timeout: 10_000 });
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.4 — Bone-White Cards, Date Postmarks & EXIF (6 Tests)
// ===========================================================================
test.describe('Tier 1 — Atlas F2.4: Bone-White Cards, Postmarks & EXIF', () => {
  test('T1-F2.4-01 natural aspect ratio preserved for landscape (3:2) and portrait (1:2) photos', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f24-01',
      stops: [
        {
          name: '双画幅站',
          date: '2026-10-01',
          lat: 25.6065,
          lng: 100.2676,
          note: '横竖画幅并置。',
          photos: [
            { width: 300, height: 200, caption: '横幅山路' },
            { width: 200, height: 400, caption: '竖幅石塔' },
          ],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '双画幅站');
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

  test('T1-F2.4-02 bone-white paper mat (#FAF8F4 light / #222427 dark) wraps photo card', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f24-02',
      stops: [{ name: '装裱卡纸站', date: '2026-10-01', lat: 25.6065, lng: 100.2676, note: '相纸留白。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '装裱卡纸站');
      const img = page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first();
      await expect(img).toBeVisible({ timeout: 15_000 });

      const expectedMat = testInfo.project.name.endsWith('-light')
        ? 'rgb(250, 248, 244)' // #FAF8F4
        : 'rgb(34, 36, 39)'; // #222427

      const matBg = await img.evaluate((node) => {
        let cur: HTMLElement | null = node.parentElement;
        while (cur) {
          const bg = getComputedStyle(cur).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            return bg;
          }
          cur = cur.parentElement;
        }
        return '';
      });
      expect(matBg).toBe(expectedMat);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.4-03 circular warm-ochre date postmark (#9A5B42 light / #D69F87 dark)', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f24-03',
      stops: [{ name: '邮戳站点', date: '2026-10-01', lat: 25.6065, lng: 100.2676, note: '秋夜邮戳。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '邮戳站点');
      const postmarkText = page.getByText(/2026[.\-/]10[.\-/]01/).first();
      await expect(postmarkText).toBeVisible({ timeout: 15_000 });

      const expectedOchre = testInfo.project.name.endsWith('-light')
        ? 'rgb(154, 91, 66)' // #9A5B42
        : 'rgb(214, 159, 135)'; // #D69F87

      const styleCheck = await postmarkText.evaluate((el) => {
        const cs = getComputedStyle(el);
        const parent = el.closest('[class], time, div, span, svg') as HTMLElement | null;
        const pcs = parent ? getComputedStyle(parent) : cs;
        const hasSvgCircle = Boolean(el.closest('svg')?.querySelector('circle') || el.querySelector('circle'));
        const radius = Number.parseFloat(pcs.borderTopLeftRadius) || Number.parseFloat(cs.borderTopLeftRadius) || 0;
        const rect = (parent ?? el).getBoundingClientRect();
        return {
          color: cs.color,
          borderColor: pcs.borderTopColor,
          hasSvgCircle,
          isCircular: hasSvgCircle || (radius >= Math.min(rect.width, rect.height) * 0.45 && rect.width > 0),
        };
      });

      expect(styleCheck.color === expectedOchre || styleCheck.borderColor === expectedOchre).toBe(true);
      expect(styleCheck.isCircular).toBe(true);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.4-04 two-line Serif note renders with self-hosted Serif font stack', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const noteText = '暮色穿过洱海云隙，\n风声停在石阶尽头。';
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f24-04',
      stops: [{ name: '宋体手记站', date: '2026-10-01', lat: 25.6065, lng: 100.2676, note: noteText }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '宋体手记站');
      const noteEl = page.getByText(/暮色穿过洱海云隙/).first();
      await expect(noteEl).toBeVisible({ timeout: 15_000 });

      const fontFamily = await noteEl.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase());
      expect(fontFamily).toMatch(/serif/);
      expect(fontFamily).not.toMatch(/^["']?microsoft yahei/);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.4-05 authentic EXIF parameters & coordinates render with tabular-nums', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f24-05',
      stops: [
        {
          name: '相机参数站',
          date: '2026-10-01',
          lat: 25.6065,
          lng: 100.2676,
          note: '记录快门与光圈。',
          photos: [{ focalLength: 35, fNumber: 2.8, exposureTime: 1 / 250, iso: 400 }],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '相机参数站');
      const card = page.locator('article, section').filter({ hasText: '相机参数站' }).first();
      await expect(card).toContainText(/35\s*mm/i);
      await expect(card).toContainText(/2\.8/);
      await expect(card).toContainText(/1\/250/);
      await expect(card).toContainText(/400/);

      const exifEl = card.getByText(/35\s*mm/i).first();
      const numericVariant = await exifEl.evaluate((el) => getComputedStyle(el).fontVariantNumeric);
      expect(numericVariant).toContain('tabular-nums');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.4-06 "回望此地当夜星空" link carries stop lat, lng, time, and place to Observatory', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f24-06',
      stops: [
        {
          name: '洱海东岸',
          date: '2026-10-01',
          lat: 25.6065,
          lng: 100.2676,
          note: '星空联动出发点。',
          photos: [{ takenAt: '2026-10-01T21:15:00+08:00', offsetTime: '+08:00' }],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '洱海东岸');
      const skyLink = page
        .getByRole('link', { name: /回望此地当夜星空|查看当夜星空/ })
        .or(page.getByRole('button', { name: /回望此地当夜星空|查看当夜星空/ }))
        .first();
      await skyLink.scrollIntoViewIfNeeded();
      await expect(skyLink).toBeVisible();

      await skyLink.click();
      await expect(page).toHaveURL(/\/observatory\?/);
      const url = new URL(page.url());
      expect(Number(url.searchParams.get('lat'))).toBeCloseTo(25.6065, 3);
      expect(Number(url.searchParams.get('lng'))).toBeCloseTo(100.2676, 3);
      const rawTime = url.searchParams.get('time');
      expect(rawTime).not.toBeNull();
      expect(rawTime!).toMatch(/^2026-10-01T(?:21:15|13:15)/);
      const expectedEpoch = Date.parse('2026-10-01T21:15:00+08:00');
      if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(rawTime!)) {
        expect(Date.parse(rawTime!)).toBe(expectedEpoch);
      } else {
        expect(rawTime!).toContain('2026-10-01T21:15');
      }
      expect(url.searchParams.get('place')).toContain('洱海东岸');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.5 — Darkroom <dialog closedby="any"> Lightbox (6 Tests)
// ===========================================================================
test.describe('Tier 1 — Atlas F2.5: Darkroom Lightbox Dialog', () => {
  test('T1-F2.5-01 clicking photo card opens native modal <dialog> with loaded image', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f25-01',
      stops: [{ name: '暗房初见', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '点击入暗房。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '暗房初见');
      const cardImg = page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first();
      await expect(cardImg).toBeVisible({ timeout: 15_000 });
      await cardImg.click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      const isModal = await dialog.evaluate((el) => el.matches(':modal'));
      expect(isModal).toBe(true);

      const dialogImg = dialog.locator('img').first();
      await expect(dialogImg).toBeVisible();
      await expect.poll(async () => dialogImg.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.5-02 darkroom <dialog> maintains #0B0C0E (color-scheme: only dark) even in Light mode', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f25-02',
      stops: [{ name: '暗房恒黑', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '日光模式下的恒黑灯箱。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '暗房恒黑');
      await page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first().click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      const darkSurface = await assertOnlyDarkSurface(dialog, 'rgb(11, 12, 14)');
      expect(darkSurface.backgroundColor).toBe('rgb(11, 12, 14)');
      expect(darkSurface.luminance).toBeGreaterThan(0.35);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.5-03 zoom in, zoom out, and reset inside darkroom <dialog>', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f25-03',
      stops: [{ name: '缩放测试', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '细节放大。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '缩放测试');
      await page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first().click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      const dialogImg = dialog.locator('img').first();
      await expect(dialogImg).toBeVisible();
      const baseBox = await dialogImg.boundingBox();
      expect(baseBox).not.toBeNull();

      const zoomInBtn = dialog.getByRole('button', { name: /放大/ }).first();
      await zoomInBtn.click();
      await page.waitForTimeout(200);
      const zoomedBox = await dialogImg.boundingBox();
      expect(zoomedBox!.width).toBeGreaterThan(baseBox!.width * 1.05);

      const zoomOutBtn = dialog.getByRole('button', { name: /缩小/ }).first();
      await zoomOutBtn.click();
      await page.waitForTimeout(200);
      const afterZoomOutBox = await dialogImg.boundingBox();
      expect(afterZoomOutBox).not.toBeNull();
      expect(afterZoomOutBox!.width).toBeLessThan(zoomedBox!.width);
      const resetBtn = dialog.getByRole('button', { name: /恢复|重置|100%/ }).first();
      if (await resetBtn.isVisible().catch(() => false)) {
        await resetBtn.click();
        await page.waitForTimeout(200);
      }
      const restoredBox = await dialogImg.boundingBox();
      expect(Math.abs(restoredBox!.width - baseBox!.width)).toBeLessThan(8);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.5-04 slide navigation via Next/Prev buttons and ArrowRight/ArrowLeft keys', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f25-04',
      stops: [
        {
          name: '双图切换站',
          date: '2026-10-01',
          lat: 25.6,
          lng: 100.2,
          note: '左右切图。',
          photos: [
            { caption: '首张山影', width: 240, height: 160 },
            { caption: '次张湖光', width: 240, height: 160 },
          ],
        },
      ],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '双图切换站');
      await page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first().click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(`img[src*="${seeded.mediaIds[0]}"]`)).toBeVisible();

      const nextBtn = dialog.getByRole('button', { name: /下一张/ }).first();
      await nextBtn.click();
      await expect(dialog.locator(`img[src*="${seeded.mediaIds[1]}"]`)).toBeVisible();

      await page.keyboard.press('ArrowLeft');
      await expect(dialog.locator(`img[src*="${seeded.mediaIds[0]}"]`)).toBeVisible();

      await page.keyboard.press('ArrowRight');
      await expect(dialog.locator(`img[src*="${seeded.mediaIds[1]}"]`)).toBeVisible();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.5-05 Escape and Close button close <dialog> and restore focus to trigger element', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f25-05',
      stops: [{ name: '焦点返回站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '原位焦点返回。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '焦点返回站');
      const cardImg = page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first();
      const trigger = cardImg.locator('xpath=ancestor-or-self::button[1]').or(cardImg).first();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.focus();
      await trigger.click();

      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      const focusedAfterEsc = await trigger.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
      expect(focusedAfterEsc).toBe(true);

      await trigger.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: /关闭/ }).first().click();
      await expect(dialog).toHaveCount(0);

      const focusedAfterCloseBtn = await trigger.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
      expect(focusedAfterCloseBtn).toBe(true);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.5-06 darkroom <dialog> requests preview variant from /api/files/:id', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f25-06',
      stops: [{ name: '预览变体站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '加载大图。' }],
    });

    try {
      await openAtlasAndFocusJourney(page, seeded.title, '预览变体站');
      const previewPromise = page.waitForResponse(
        (res) => res.url().includes(`/api/files/${seeded.mediaIds[0]}`) && res.url().includes('variant=preview'),
      );
      await page.locator(`img[src*="/api/files/${seeded.mediaIds[0]}"]`).first().click();
      const previewRes = await previewPromise;
      expect(previewRes.status()).toBe(200);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});

// ===========================================================================
// F2.6 — Atlas EXIF Parsing & Browser 600px/1600px WebP Upload (5 Tests)
// ===========================================================================
test.describe('Tier 1 — Atlas F2.6: EXIF Parsing & WebP Upload Pipeline', () => {
  test('T1-F2.6-01 Admin UI upload extracts takenAt (+offset), GPS, and camera EXIF via exifr', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    const uploadedIds: string[] = [];
    const tag = nextTag(testInfo, 't1-f26-01');

    try {
      await authenticateAdminPage(page, api);
      const jpeg = createSyntheticExifJpeg({
        width: 800,
        height: 600,
        lat: 31.2304,
        lng: 121.4737,
        takenAt: '2026:10:05 21:45:00',
        offsetTime: '+08:00',
        focalLength: 50,
        fNumber: 1.8,
        iso: 800,
        model: `X-T5-${tag}`,
      });

      const uploadRespPromise = page.waitForResponse(
        (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
      );
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10_000 });
      await fileInput.setInputFiles({
        name: `${tag}.jpg`,
        mimeType: 'image/jpeg',
        buffer: jpeg,
      });

      const uploadRes = await uploadRespPromise;
      expect([200, 201]).toContain(uploadRes.status());
      const body = (await uploadRes.json()) as { media?: Array<Record<string, unknown>> };
      const item = body.media?.[0];
      expect(item).toBeDefined();
      uploadedIds.push(String(item!.id));

      expect(Number(item!.lat)).toBeCloseTo(31.2304, 3);
      expect(Number(item!.lng)).toBeCloseTo(121.4737, 3);
      expect(String(item!.takenAt)).toContain('2026-10-05');

      await expect(page.getByText(/31\.23/).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/121\.47/).first()).toBeVisible({ timeout: 10_000 });
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T1-F2.6-02 browser encodes 600px WebP thumbnail & 1600px WebP preview preserving aspect ratio', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    const uploadedIds: string[] = [];
    const tag = nextTag(testInfo, 't1-f26-02');

    try {
      await authenticateAdminPage(page, api);
      const jpeg = createSyntheticExifJpeg({
        width: 1800,
        height: 1200,
        lat: 30.2741,
        lng: 120.1551,
        model: `X-T5-${tag}`,
      });

      const uploadRespPromise = page.waitForResponse(
        (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
      );
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10_000 });
      await fileInput.setInputFiles({
        name: `${tag}.jpg`,
        mimeType: 'image/jpeg',
        buffer: jpeg,
      });

      const uploadRes = await uploadRespPromise;
      expect([200, 201]).toContain(uploadRes.status());
      const body = (await uploadRes.json()) as { media?: Array<Record<string, unknown>> };
      const mediaId = String(body.media?.[0]?.id ?? '');
      expect(mediaId).toBeTruthy();
      uploadedIds.push(mediaId);

      const thumbRes = await api.getFile(mediaId, { variant: 'thumbnail' });
      const prevRes = await api.getFile(mediaId, { variant: 'preview' });
      expect(thumbRes.status).toBe(200);
      expect(prevRes.status).toBe(200);
      expect(thumbRes.headers.get('content-type')).toContain('image/webp');
      expect(prevRes.headers.get('content-type')).toContain('image/webp');
      expect(thumbRes.buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(thumbRes.buffer.subarray(8, 12).toString('ascii')).toBe('WEBP');
      expect(prevRes.buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(prevRes.buffer.subarray(8, 12).toString('ascii')).toBe('WEBP');

      const dims = await page.evaluate(
        async ({ thumbB64, prevB64 }) => {
          const decodeDims = async (b64: string) => {
            const img = new Image();
            img.src = `data:image/webp;base64,${b64}`;
            await img.decode();
            return { w: img.naturalWidth, h: img.naturalHeight };
          };
          return {
            thumb: await decodeDims(thumbB64),
            prev: await decodeDims(prevB64),
          };
        },
        {
          thumbB64: thumbRes.buffer.toString('base64'),
          prevB64: prevRes.buffer.toString('base64'),
        },
      );

      expect(dims.thumb.w).toBeLessThanOrEqual(600);
      expect(dims.thumb.w).toBeGreaterThanOrEqual(590);
      expect(Math.abs(dims.thumb.w / dims.thumb.h - 1.5)).toBeLessThan(0.05);
      expect(dims.prev.w).toBeLessThanOrEqual(1600);
      expect(dims.prev.w).toBeGreaterThanOrEqual(1580);
      expect(Math.abs(dims.prev.w / dims.prev.h - 1.5)).toBeLessThan(0.05);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T1-F2.6-03 EXIF-less demo road.jpg enters "待定位" queue without fabricating GPS', async ({ page }, testInfo) => {
    assertDemoImagesExist();
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    const uploadedIds: string[] = [];
    const tag = nextTag(testInfo, 't1-f26-03');

    try {
      await authenticateAdminPage(page, api);
      const roadBuf = appendJpegComment(readDemoImage('road'), tag);

      const uploadRespPromise = page.waitForResponse(
        (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
      );
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10_000 });
      await fileInput.setInputFiles({
        name: `road-${tag}.jpg`,
        mimeType: 'image/jpeg',
        buffer: roadBuf,
      });

      const uploadRes = await uploadRespPromise;
      expect([200, 201]).toContain(uploadRes.status());
      const body = (await uploadRes.json()) as { media?: Array<Record<string, unknown>> };
      const item = body.media?.[0];
      expect(item).toBeDefined();
      uploadedIds.push(String(item!.id));

      expect(item!.lat ?? null).toBeNull();
      expect(item!.lng ?? null).toBeNull();
      expect(item!.confirmed).toBe(false);
      await expect(page.getByText('待定位').first()).toBeVisible({ timeout: 10_000 });
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T1-F2.6-04 EXIF Orientation 6 & 8 swap dimensions through Admin UI upload & WebP pipeline', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    const tag = nextTag(testInfo, 't1-f26-04');
    const uploadedIds: string[] = [];

    try {
      await authenticateAdminPage(page, api);
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await expect(fileInput).toBeAttached({ timeout: 10_000 });

      for (const orientation of [6, 8] as const) {
        const jpeg = createSyntheticExifJpeg({
          width: 240,
          height: 120,
          orientation,
          model: `X-T5-${tag}-o${orientation}`,
        });

        const uploadRespPromise = page.waitForResponse(
          (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
        );
        await fileInput.setInputFiles({
          name: `${tag}-o${orientation}.jpg`,
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

        // Client exifr + Canvas rotation must yield portrait (width < height, ~0.5 aspect ratio)
        expect(Number(item!.width)).toBeLessThan(Number(item!.height));
        expect(Math.abs(Number(item!.width) / Number(item!.height) - 0.5)).toBeLessThan(0.05);

        const prevRes = await api.getFile(mediaId, { variant: 'preview' });
        expect(prevRes.status).toBe(200);
        expect(prevRes.headers.get('content-type')).toContain('image/webp');
        const prevDims = await page.evaluate(async (b64) => {
          const img = new Image();
          img.src = `data:image/webp;base64,${b64}`;
          await img.decode();
          return { w: img.naturalWidth, h: img.naturalHeight };
        }, prevRes.buffer.toString('base64'));
        expect(prevDims.w).toBeLessThan(prevDims.h);
        expect(Math.abs(prevDims.w / prevDims.h - 0.5)).toBeLessThan(0.05);
      }

      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T1-F2.6-05 authenticated POST /api/media stores SHA-256 hash & streams R2 variants with security headers', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't1-f26-05');
    const uploadedIds: string[] = [];

    try {
      const jpeg = createSyntheticExifJpeg({ width: 200, height: 150, model: `X-T5-${tag}` });
      const media = await uploadPhoto(api, jpeg, `${tag}.jpg`);
      const id = String(media.id);
      uploadedIds.push(id);

      expect(String(media.hash)).toMatch(/^[a-f0-9]{64}$/i);

      for (const variant of ['thumbnail', 'preview', 'original'] as const) {
        const fileRes = await api.getFile(id, { variant });
        expect(fileRes.status).toBe(200);
        expect(fileRes.buffer.length).toBeGreaterThan(50);
        expect(fileRes.headers.get('x-content-type-options')).toBe('nosniff');
        expect(fileRes.headers.get('cache-control')).toContain('no-store');
      }
    } finally {
      await cleanupSeeded(api, [], uploadedIds);
    }
  });
});

// ===========================================================================
// F2.7 — Journey CRUD, Visibility & Sorting + Privacy Stripping (5 Tests)
// ===========================================================================
test.describe('Tier 1 — Atlas F2.7: Journey CRUD, Visibility & Sorting', () => {
  test('T1-F2.7-01 private journey hidden from public /api/library until toggled public', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f27-01',
      visibility: 'private',
      stops: [{ name: '私密转为公开站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '可见性切换测试。' }],
    });

    try {
      const anon = createApiClient();
      const libBefore = await anon.getLibrary();
      expect(libBefore.status).toBe(200);
      const journeysBefore = (libBefore.data.journeys as Array<{ id: string }>) ?? [];
      expect(journeysBefore.some((j) => j.id === seeded.id)).toBe(false);

      const updateRes = await api.saveJourney({
        id: seeded.id,
        title: seeded.title,
        subtitle: seeded.subtitle,
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        visibility: 'public',
        coverId: seeded.mediaIds[0] ?? null,
        stops: [
          {
            id: seeded.stopIds[0]!,
            name: '私密转为公开站',
            region: '中国',
            date: '2026-10-01',
            lat: 25.6,
            lng: 100.2,
            note: '可见性切换测试。',
            mediaIds: seeded.mediaIds,
          },
        ],
      });
      expect(updateRes.status).toBe(200);

      const libAfter = await anon.getLibrary();
      const journeysAfter = (libAfter.data.journeys as Array<{ id: string }>) ?? [];
      expect(journeysAfter.some((j) => j.id === seeded.id)).toBe(true);

      await openAtlasAndFocusJourney(page, seeded.title, '私密转为公开站');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.7-02 stop sorting order persists and drives card sequence on /atlas', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f27-02',
      stops: [
        { name: '排序甲站', date: '2026-10-01', lat: 25.1, lng: 102.1, note: '甲。' },
        { name: '排序乙站', date: '2026-10-02', lat: 25.5, lng: 101.2, note: '乙。' },
        { name: '排序丙站', date: '2026-10-03', lat: 26.2, lng: 100.3, note: '丙。' },
      ],
    });

    try {
      const libRes = await api.getLibrary();
      const journeys = (libRes.data.journeys as Array<{ id: string; stops: Array<Record<string, unknown>> }>) ?? [];
      const existing = journeys.find((j) => j.id === seeded.id);
      expect(existing).toBeDefined();
      const [s0, s1, s2] = existing!.stops;
      expect(s0 && s1 && s2).toBeTruthy();

      const reorderRes = await api.saveJourney({
        id: seeded.id,
        title: seeded.title,
        subtitle: seeded.subtitle,
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        visibility: 'public',
        coverId: seeded.mediaIds[0] ?? null,
        stops: [s2!, s0!, s1!],
      });
      expect(reorderRes.status).toBe(200);

      await openAtlasAndFocusJourney(page, seeded.title, '排序丙站');
      const cardOrder = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          idxC: text.indexOf('排序丙站'),
          idxA: text.indexOf('排序甲站'),
          idxB: text.indexOf('排序乙站'),
        };
      });
      expect(cardOrder.idxC).toBeGreaterThan(-1);
      expect(cardOrder.idxA).toBeGreaterThan(cardOrder.idxC);
      expect(cardOrder.idxB).toBeGreaterThan(cardOrder.idxA);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.7-03 confirming coordinates from pending queue via PATCH /api/media', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't1-f27-03');
    const uploadedIds: string[] = [];

    try {
      const exifless = appendJpegComment(createExiflessJpeg(200, 150), tag);
      const media = await uploadPhoto(api, exifless, `${tag}.jpg`);
      const id = String(media.id);
      uploadedIds.push(id);
      expect(media.confirmed).toBe(false);

      const patchRes = await api.patchMedia({
        id,
        lat: 30.6586,
        lng: 104.0648,
        confirmed: true,
        caption: '成都夜雨已定位',
      });
      expect(patchRes.status).toBe(200);

      const patched = (patchRes.data as { media?: Record<string, unknown> }).media ?? patchRes.data;
      expect(patched.confirmed).toBe(true);
      expect(Number(patched.lat)).toBeCloseTo(30.6586, 4);
      expect(Number(patched.lng)).toBeCloseTo(104.0648, 4);
      expect(patched.caption).toBe('成都夜雨已定位');
    } finally {
      await cleanupSeeded(api, [], uploadedIds);
    }
  });

  test('T1-F2.7-04 GET /api/library ETag, 304 Not Modified, and cache invalidation on edit', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f27-04',
      stops: [{ name: '缓存站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '初始手记。' }],
    });

    try {
      const anon = createApiClient();
      const first = await anon.getLibrary();
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag');
      expect(etag).toBeTruthy();
      expect(first.headers.get('vary')).toMatch(/cookie/i);
      expect(first.headers.get('cache-control')).toContain('no-store');

      const cached = await anon.getLibrary(etag!);
      expect(cached.status).toBe(304);

      await api.saveJourney({
        id: seeded.id,
        title: `${seeded.title}-已更新`,
        subtitle: seeded.subtitle,
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        visibility: 'public',
        coverId: seeded.mediaIds[0] ?? null,
        stops: [
          {
            id: seeded.stopIds[0]!,
            name: '缓存站',
            region: '中国',
            date: '2026-10-01',
            lat: 25.6,
            lng: 100.2,
            note: '更新后手记。',
            mediaIds: seeded.mediaIds,
          },
        ],
      });

      const afterEdit = await anon.getLibrary(etag!);
      expect(afterEdit.status).toBe(200);
      expect(afterEdit.headers.get('etag')).not.toBe(etag);
    } finally {
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });

  test('T1-F2.7-05 GET /api/files/:id supports Range (206) and ?download=1 (attachment)', async ({}, testInfo) => {
    const api = createApiClient();
    await api.ensureAdminSession();
    const seeded = await seedPublicJourney(api, testInfo, {
      prefix: 't1-f27-05',
      stops: [{ name: '字节范围站', date: '2026-10-01', lat: 25.6, lng: 100.2, note: '分段读取。' }],
    });

    try {
      const mediaId = seeded.mediaIds[0]!;
      const anon = createApiClient();

      const partial = await anon.getFile(mediaId, { variant: 'preview', range: 'bytes=0-15' });
      expect(partial.status).toBe(206);
      expect(partial.buffer.length).toBe(16);
      expect(partial.headers.get('content-range')).toMatch(/^bytes 0-15\/\d+$/);
      expect(partial.headers.get('accept-ranges')).toBe('bytes');

      const dl = await anon.getFile(mediaId, { variant: 'preview', download: true });
      expect(dl.status).toBe(200);
      expect(dl.headers.get('content-disposition')).toMatch(/^attachment/i);
    } finally {
      await cleanupSeeded(api, [seeded.id], seeded.mediaIds);
    }
  });
});
