import crypto from 'node:crypto';
import path from 'node:path';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import {
  createBinaryChunkPayload,
  createExiflessJpeg,
  createSyntheticExifJpeg,
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
import { auditLocalOnlyBoundary } from '../helpers/local-guard';

test.describe.configure({ mode: 'serial' });

const OBSERVATORY_DARK_LOCATOR = '.deep-space, [data-only-dark], .observatory-viewport';
const REPO_ROOT = path.resolve(process.cwd());

let seqCounter = 0;
let ipSeq = 0;
const usedTestIps = new Set<string>();

function uniqueId(testInfo: TestInfo, prefix: string): string {
  seqCounter += 1;
  const proj = testInfo.project.name.replace(/[^a-z0-9]/gi, '');
  return `${prefix}-${proj}-${Date.now()}-${seqCounter}`;
}

function uniqueTestIp(testInfo: TestInfo, slot: number): string {
  const projIdx = Math.max(
    0,
    ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'].indexOf(testInfo.project.name),
  );
  for (let attempt = 0; attempt < 500; attempt += 1) {
    ipSeq += 1;
    const seed =
      Math.floor(Date.now() / 100) +
      projIdx * 53 +
      testInfo.parallelIndex * 17 +
      slot * 19 +
      ipSeq +
      attempt;
    const net = seed % 2 === 0 ? '203.0.113' : '198.51.100';
    const host = (seed % 230) + 10;
    const ip = `${net}.${host}`;
    if (!usedTestIps.has(ip)) {
      usedTestIps.add(ip);
      return ip;
    }
  }
  return `198.51.100.${(ipSeq % 200) + 20}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeSqlHexLiterals(sqlText: string): string {
  return sqlText.replace(/CAST\(X'([0-9A-Fa-f]*)'\s+AS\s+TEXT\)/gi, (_match, hex: string) =>
    Buffer.from(hex, 'hex').toString('utf8'),
  );
}

function extractCompletedVaultFileId(
  doneData: Record<string, unknown>,
  initFileId?: string,
): string {
  const nested = doneData.file as { id?: unknown } | undefined;
  const raw = nested?.id ?? doneData.fileId ?? doneData.id ?? initFileId;
  if (typeof raw !== 'string' || !raw) {
    throw new Error(`completeVaultUpload did not return a valid fileId: ${JSON.stringify(doneData)}`);
  }
  return raw;
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

function usageCounterMap(
  counters: Array<{ key: string; value: number }>,
): Map<string, number> {
  return new Map(counters.map((c) => [c.key, c.value]));
}

function counterByPrefix(map: Map<string, number>, prefix: string): number {
  let total = 0;
  for (const [k, v] of map.entries()) {
    if (k === prefix || k.startsWith(`${prefix}:`)) {
      total += v;
    }
  }
  return total;
}

async function uploadAtlasPhoto(
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

async function seedJourney(
  api: ApiClient,
  testInfo: TestInfo,
  opts: {
    prefix: string;
    title?: string;
    subtitle?: string;
    startDate?: string;
    endDate?: string;
    visibility: 'public' | 'private';
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
): Promise<{ journeyId: string; mediaIds: string[]; title: string }> {
  const tag = uniqueId(testInfo, opts.prefix);
  const mediaIds: string[] = [];
  const stopsPayload: Array<Record<string, unknown>> = [];

  for (let sIdx = 0; sIdx < opts.stops.length; sIdx += 1) {
    const stopSpec = opts.stops[sIdx]!;
    const stopMediaIds: string[] = [];
    const photoSpecs = stopSpec.photos ?? [{ lat: stopSpec.lat, lng: stopSpec.lng }];
    for (let pIdx = 0; pIdx < photoSpecs.length; pIdx += 1) {
      const pSpec = photoSpecs[pIdx]!;
      const rawBuf = pSpec.exifless
        ? appendJpegComment(
            createExiflessJpeg(pSpec.width ?? 240, pSpec.height ?? 160),
            `${tag}-s${sIdx}-p${pIdx}`,
          )
        : appendJpegComment(
            createSyntheticExifJpeg({
              width: 240,
              height: 160,
              lat: stopSpec.lat,
              lng: stopSpec.lng,
              takenAt: `${stopSpec.date.replace(/-/g, ':')} 20:30:00`,
              model: `X-T5-${tag}`,
              ...pSpec,
            }),
            `${tag}-s${sIdx}-p${pIdx}`,
          );
      const uploaded = await uploadAtlasPhoto(api, rawBuf, `${tag}-${sIdx}-${pIdx}.jpg`, {
        caption: pSpec.caption ?? `${stopSpec.name} ${sIdx + 1}`,
      });
      const mid = String(uploaded.id);
      stopMediaIds.push(mid);
      mediaIds.push(mid);
    }

    stopsPayload.push({
      id: `stop-${tag}-${sIdx}`,
      name: stopSpec.name,
      region: stopSpec.region ?? '云南',
      date: stopSpec.date,
      lat: stopSpec.lat,
      lng: stopSpec.lng,
      note: stopSpec.note,
      mediaIds: stopMediaIds,
    });
  }

  const journeyId = `journey-${tag}`;
  const title = opts.title ?? `旅程-${tag}`;
  const firstStop = opts.stops[0];
  const lastStop = opts.stops[opts.stops.length - 1];
  const saveRes = await api.saveJourney({
    id: journeyId,
    title,
    subtitle: opts.subtitle ?? '山海与星野手记',
    startDate: opts.startDate ?? firstStop?.date ?? '2026-10-01',
    endDate: opts.endDate ?? lastStop?.date ?? '2026-10-03',
    visibility: opts.visibility,
    coverId: mediaIds[0] ?? null,
    stops: stopsPayload,
    createdAt: new Date().toISOString(),
  });
  expect([200, 201]).toContain(saveRes.status);
  return { journeyId, mediaIds, title };
}

async function cleanupAtlasRecords(
  api: ApiClient,
  journeyIds: string[],
  mediaIds: string[],
): Promise<void> {
  for (const jid of journeyIds) {
    await api.trashItem('journey', jid).catch(() => undefined);
  }
  for (const mid of mediaIds) {
    await api.trashItem('media', mid).catch(() => undefined);
  }
}

async function cleanupVaultRecords(
  api: ApiClient,
  shareIds: string[],
  fileIds: string[],
): Promise<void> {
  for (const sid of shareIds) {
    await api.revokeVaultShare(sid).catch(() => undefined);
  }
  for (const fid of fileIds) {
    await api.trashItem('vault_file', fid).catch(() => undefined);
  }
}

async function openAtlasAndFocusJourney(
  page: Page,
  journeyTitle: string,
  expectedStopName?: string,
): Promise<void> {
  await page.goto('/atlas', { waitUntil: 'domcontentloaded' });
  await page.locator('#main-content h1, #main-content canvas').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  const titleMatcher = new RegExp(escapeRegExp(journeyTitle));
  const journeyVisible = await page.getByText(titleMatcher).first().isVisible().catch(() => false);
  if (!journeyVisible) {
    const switcher = page
      .getByRole('button', { name: titleMatcher })
      .or(page.getByRole('tab', { name: titleMatcher }))
      .first();
    if ((await switcher.count()) > 0) {
      await switcher.click();
    } else {
      const selectEl = page.locator('#main-content select').first();
      if ((await selectEl.count()) > 0) {
        const optionValue = await selectEl.evaluate((node, title) => {
          const opt = Array.from((node as HTMLSelectElement).options).find((o) =>
            o.text.includes(title),
          );
          return opt?.value ?? null;
        }, journeyTitle);
        if (optionValue) {
          await selectEl.selectOption(optionValue);
        }
      }
    }
  } else {
    const switcherBtn = page.getByRole('button', { name: titleMatcher }).first();
    if (await switcherBtn.isVisible().catch(() => false)) {
      await switcherBtn.click();
    }
  }
  await expect(page.getByText(titleMatcher).first()).toBeVisible({ timeout: 15_000 });
  if (expectedStopName) {
    const stopLoc = page.getByText(expectedStopName).first();
    if (!(await stopLoc.isVisible().catch(() => false))) {
      await ensureAtlasDrawerExpandedIfNeeded(page, stopLoc);
    }
    await expect(stopLoc).toBeVisible({ timeout: 15_000 });
  }
}

async function ensureAtlasDrawerExpandedIfNeeded(
  page: Page,
  targetLocator: Locator,
): Promise<void> {
  if (await targetLocator.isVisible().catch(() => false)) {
    return;
  }
  const drawerToggle = page
    .locator('#main-content')
    .getByRole('button', { name: /展开|收起|手记|站点|抽屉/ })
    .first();
  if (await drawerToggle.isVisible().catch(() => false)) {
    await drawerToggle.click();
    await expect(targetLocator).toBeVisible({ timeout: 10_000 });
  }
}

async function loginAdminInPage(page: Page, baseURL: string): Promise<ApiClient> {
  const api = createApiClient(baseURL);
  await api.ensureAdminSession();
  const password = process.env.E2E_ADMIN_PASSWORD || 'AtlasVaultStarlight2026!';
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await page.locator('#main-content h1').waitFor({ state: 'visible', timeout: 10_000 });

  const pwInput = page
    .locator('#main-content input[type="password"], #main-content input[name="password"]')
    .first();
  const authedMarker = page
    .locator('#main-content')
    .getByRole('button', { name: /退出|备份|导出|保存/ })
    .or(page.locator('#main-content').getByText(/累计上传|用量监控|安全策略|待定位|密匣上传/))
    .first();
  const placeholderMarker = page
    .locator('#main-content')
    .getByText(/将在这里汇聚/)
    .first();

  await expect(pwInput.or(authedMarker).or(placeholderMarker).first()).toBeVisible({
    timeout: 10_000,
  });

  if (await pwInput.isVisible().catch(() => false)) {
    await pwInput.fill(password);
    const submitBtn = page
      .locator('#main-content')
      .getByRole('button', { name: /登录|进入|解锁|确认/ })
      .first();
    await submitBtn.click();
    await expect(pwInput).toBeHidden({ timeout: 10_000 });
    await expect(authedMarker).toBeVisible({ timeout: 10_000 });
  }
  return api;
}

async function setPageColorScheme(page: Page, target: 'light' | 'dark'): Promise<void> {
  const toggleBtn = page
    .locator('button[aria-label="切换至浅色模式"], button[aria-label="切换至深色模式"]')
    .first();
  await expect(toggleBtn).toBeVisible();
  const expectedAria = target === 'dark' ? '切换至浅色模式' : '切换至深色模式';
  const currentAria = await toggleBtn.getAttribute('aria-label');
  if (currentAria !== expectedAria) {
    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute('aria-label', expectedAria);
  }
}

async function expectThemeState(page: Page, expected: 'light' | 'dark'): Promise<void> {
  const toggleBtn = page
    .locator('button[aria-label="切换至浅色模式"], button[aria-label="切换至深色模式"]')
    .first();
  const expectedAria = expected === 'dark' ? '切换至浅色模式' : '切换至深色模式';
  await expect(toggleBtn).toHaveAttribute('aria-label', expectedAria);

  const state = await page.evaluate(() => ({
    systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    scheme: localStorage.getItem('travel:color-scheme'),
    meta: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? null,
    theme: document.documentElement.dataset.theme ?? null,
    rootBg: getComputedStyle(document.documentElement).backgroundColor,
  }));

  const matchesSystem = (expected === 'dark') === state.systemDark;
  if (matchesSystem) {
    expect(state.scheme).toBeNull();
    expect(state.meta).toBe('light dark');
    expect(state.theme).toBeNull();
  } else {
    expect(state.scheme).toBe(expected);
    expect(state.meta).toBe(expected);
    expect(state.theme).toBe(expected);
  }
  expect(state.rootBg).toBe(expected === 'dark' ? 'rgb(19, 19, 20)' : 'rgb(255, 255, 255)');
}

test.describe('Tier 3: Cross-Feature Pairwise Interactions (F1.1–F5.5)', () => {
  test(
    '[F1.1][F1.6] TopNav View Transitions × Light/Dark color-scheme Persistence',
    { tag: ['@tier3', '@F1.1', '@F1.6'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        await page.goto('/');
        await setPageColorScheme(page, 'dark');
        await expectThemeState(page, 'dark');

        for (const [label, expectedPath] of [
          ['旅图', '/atlas'],
          ['观星台', '/observatory'],
          ['密匣', '/vault'],
        ] as const) {
          await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: label }).click();
          await expect(page).toHaveURL(new RegExp(`${expectedPath}$`));
          await expectThemeState(page, 'dark');
        }

        await page.reload();
        await expectThemeState(page, 'dark');

        await setPageColorScheme(page, 'light');
        await expectThemeState(page, 'light');

        await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '旅图' }).click();
        await expect(page).toHaveURL(/\/atlas$/);
        await expectThemeState(page, 'light');
        await page.reload();
        await expectThemeState(page, 'light');
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F1.1][F1.7] Multi-Route Shell × Self-Hosted WOFF2 Fonts & Immutable Cache',
    { tag: ['@tier3', '@F1.1', '@F1.7'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      const fontResponses: Array<{ url: string; cacheControl: string }> = [];
      page.on('response', (res) => {
        if (res.url().includes('/fonts/') && res.url().endsWith('.woff2')) {
          fontResponses.push({
            url: res.url(),
            cacheControl: res.headers()['cache-control'] ?? '',
          });
        }
      });

      try {
        await page.goto('/');
        const homeFonts = await verifySelfHostedFonts(page);
        expect(homeFonts.loadedFamilies.length).toBeGreaterThan(0);
        expect(homeFonts.h1FontWeight).toBe('500');

        for (const route of ['/atlas', '/observatory', '/vault', '/admin']) {
          await page.goto(route);
          const subFonts = await verifySelfHostedFonts(page, {
            requireH1: false,
            checkLetterSpacing: false,
          });
          expect(subFonts.loadedFamilies.length).toBeGreaterThan(0);
          if (subFonts.h1FontFamily) {
            expect(subFonts.h1FontFamily.toLowerCase()).not.toContain('microsoft yahei');
          }
        }

        expect(fontResponses.length).toBeGreaterThan(0);
        for (const item of fontResponses) {
          expect(item.cacheControl.toLowerCase()).toContain('immutable');
        }
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F1.2][F1.6] OGL WebGL Bokeh Star-Ring × Day/Night Studio Gradient & Interaction',
    { tag: ['@tier3', '@F1.2', '@F1.6'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        await page.goto('/');
        await setPageColorScheme(page, 'light');
        await expectThemeState(page, 'light');

        const heroCanvas = page.locator('canvas').first();
        await expect(heroCanvas).toBeVisible();
        const isNot2d = await heroCanvas.evaluate(
          (node) => (node as HTMLCanvasElement).getContext('2d') === null,
        );
        expect(isNot2d).toBe(true);

        const lightBg = await page.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        );
        expect(lightBg).toBe('rgb(255, 255, 255)');
        expect(lightBg).not.toBe('rgb(7, 9, 13)');

        await setPageColorScheme(page, 'dark');
        await expectThemeState(page, 'dark');
        const darkBg = await page.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        );
        expect(darkBg).toBe('rgb(19, 19, 20)');
        expect(darkBg).not.toBe(lightBg);
        expect(darkBg).not.toBe('rgb(7, 9, 13)');

        const box = await heroCanvas.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
          await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
        }
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F1.2][F1.4] OGL Bokeh Pause & Reduced-Motion × Scroll-Driven 32px Focal Stage',
    { tag: ['@tier3', '@F1.2', '@F1.4'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        await page.goto('/');
        const pauseBtn = page
          .getByRole('button', { name: /暂停|恢复|星环|动效/ })
          .first();
        await expect(pauseBtn).toBeVisible();
        await pauseBtn.click();

        const pressedAfterPause = await pauseBtn.getAttribute('aria-pressed');
        const labelAfterPause = (await pauseBtn.textContent()) || (await pauseBtn.getAttribute('aria-label')) || '';
        expect(pressedAfterPause === 'true' || /恢复|继续|已暂停/.test(labelAfterPause)).toBe(true);

        await page.evaluate(() => {
          const targetY = Math.max(400, document.documentElement.scrollHeight - window.innerHeight);
          window.scrollTo({ top: targetY, behavior: 'auto' });
        });
        const scrollInfo = await page.evaluate(() => {
          const main = document.querySelector('main');
          const candidates = main
            ? Array.from(main.querySelectorAll<HTMLElement>('.scroll-focal-stage, section, div, figure'))
            : [];
          const stageEl =
            main?.querySelector<HTMLElement>('.scroll-focal-stage') ??
            candidates.find((el) => {
              if (el.id === 'labs') return false;
              const cs = getComputedStyle(el);
              return cs.borderTopLeftRadius === '32px';
            }) ??
            null;
          const stageCs = stageEl ? getComputedStyle(stageEl) : null;
          const stageRect = stageEl ? stageEl.getBoundingClientRect() : null;
          const stageMaxWidth = stageCs
            ? stageCs.maxWidth === 'none'
              ? (stageRect?.width ?? 0)
              : Number.parseFloat(stageCs.maxWidth)
            : 0;
          return {
            scrollY: window.scrollY,
            canScroll: document.documentElement.scrollHeight > window.innerHeight,
            overflowX: document.documentElement.scrollWidth <= window.innerWidth,
            hasStage: Boolean(stageEl),
            borderRadius: stageCs?.borderTopLeftRadius ?? '',
            maxWidth: stageMaxWidth,
          };
        });
        if (scrollInfo.canScroll) {
          expect(scrollInfo.scrollY).toBeGreaterThan(0);
        }
        expect(scrollInfo.overflowX).toBe(true);
        expect(scrollInfo.hasStage).toBe(true);
        expect(scrollInfo.borderRadius).toBe('32px');
        expect(scrollInfo.maxWidth).toBeLessThanOrEqual(1280);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.reload();
        await expect(page.locator('h1').first()).toBeVisible();
        errors.assertZeroErrors();
      } finally {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        errors.detach();
      }
    },
  );

  test(
    '[F1.3][F1.5] Hero H1 & Two Pill CTAs × Bio, Module Entrances & Labs Slot',
    { tag: ['@tier3', '@F1.3', '@F1.5'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        await page.goto('/');
        const h1 = page.locator('h1').first();
        await expect(h1).toBeVisible();
        const h1Style = await h1.evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            fontWeight: cs.fontWeight,
            fontSize: Number.parseFloat(cs.fontSize),
            letterSpacing: cs.letterSpacing === 'normal' ? 0 : Number.parseFloat(cs.letterSpacing),
          };
        });
        expect(h1Style.fontWeight).toBe('500');
        expect(Math.abs(h1Style.letterSpacing - -0.03 * h1Style.fontSize)).toBeLessThanOrEqual(0.75);

        await expect(page.getByRole('link', { name: /打开旅图/ }).first()).toBeVisible();
        await expect(page.getByRole('link', { name: /进入观星台/ }).first()).toBeVisible();
        await expect(page.locator('#labs')).toBeVisible();

        const antiAi = await scanAntiAiTaste(page);
        expect(antiAi.violations).toEqual([]);
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F1.3][F1.1] Hero Pill CTAs × Client Router Focus Management & URL Sync',
    { tag: ['@tier3', '@F1.3', '@F1.1'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        await page.goto('/');
        await page.getByRole('link', { name: /打开旅图/ }).first().click();
        await expect(page).toHaveURL(/\/atlas$/);
        await expect(page.locator('#main-content h1')).toBeVisible();

        const focusedTagAfterAtlas = await page.evaluate(() => ({
          tag: document.activeElement?.tagName ?? '',
          inMain: Boolean(document.activeElement?.closest('#main-content')),
        }));
        expect(focusedTagAfterAtlas.inMain || focusedTagAfterAtlas.tag === 'H1').toBe(true);

        await page.goBack();
        await expect(page).toHaveURL(/\/$/);

        await page.getByRole('link', { name: /进入观星台/ }).first().click();
        await expect(page).toHaveURL(/\/observatory$/);
        await expect(page.locator('#main-content h1')).toBeVisible();
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F1.4][F1.7] 32px Focal Stage × Desktop & Mobile Responsive Typography',
    { tag: ['@tier3', '@F1.4', '@F1.7'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        for (const vp of [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(vp);
          await page.goto('/');
          const fonts = await verifySelfHostedFonts(page);
          expect(fonts.loadedFamilies.length).toBeGreaterThan(0);

          const layoutCheck = await page.evaluate(() => {
            const overflow = document.documentElement.scrollWidth <= window.innerWidth;
            const rounded32 = Array.from(document.querySelectorAll('section, div, figure')).some(
              (el) => getComputedStyle(el).borderTopLeftRadius === '32px',
            );
            return { overflow, rounded32 };
          });
          expect(layoutCheck.overflow).toBe(true);
          expect(layoutCheck.rounded32).toBe(true);
        }
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F1.6][F2.4] Day/Night Switch × Atlas Bone-White Paper Cards & Warm Ochre Postmarks',
    { tag: ['@tier3', '@F1.6', '@F2.4'] },
    async ({ page, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const errors = attachErrorListeners(page);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 'paper',
          visibility: 'public',
          stops: [
            {
              name: '大理古城',
              date: '2026-10-08',
              lat: 25.692,
              lng: 100.163,
              note: '石板路在暮色里慢慢亮起来，远山还有一层薄云。',
              photos: [{ focalLength: 35, fNumber: 2.8, iso: 400 }],
            },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await openAtlasAndFocusJourney(page, seeded.title, '大理古城');
        await setPageColorScheme(page, 'light');
        const photoImg = page.locator('img[src*="/api/files/"]').first();
        await ensureAtlasDrawerExpandedIfNeeded(page, photoImg);
        await expect(photoImg).toBeVisible();

        const lightPalette = await page.evaluate(() => {
          const bgs = new Set<string>();
          const colors = new Set<string>();
          document.querySelectorAll('article, figure, time, span, div').forEach((el) => {
            const cs = getComputedStyle(el);
            bgs.add(cs.backgroundColor);
            colors.add(cs.color);
          });
          return {
            hasBoneWhite: bgs.has('rgb(250, 248, 244)'),
            hasLightOchre: colors.has('rgb(154, 91, 66)') || bgs.has('rgb(154, 91, 66)'),
          };
        });
        expect(lightPalette.hasBoneWhite).toBe(true);
        expect(lightPalette.hasLightOchre).toBe(true);

        await setPageColorScheme(page, 'dark');
        const darkPalette = await page.evaluate(() => {
          const bgs = new Set<string>();
          const colors = new Set<string>();
          document.querySelectorAll('article, figure, time, span, div').forEach((el) => {
            const cs = getComputedStyle(el);
            bgs.add(cs.backgroundColor);
            colors.add(cs.color);
          });
          return {
            hasDarkMat: bgs.has('rgb(34, 36, 39)'),
            hasDarkOchre: colors.has('rgb(214, 159, 135)') || bgs.has('rgb(214, 159, 135)'),
          };
        });
        expect(darkPalette.hasDarkMat).toBe(true);
        expect(darkPalette.hasDarkOchre).toBe(true);
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlasRecords(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F1.6][F2.5] Page Light Mode × Darkroom <dialog closedby="any"> only dark',
    { tag: ['@tier3', '@F1.6', '@F2.5'] },
    async ({ page, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const errors = attachErrorListeners(page);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 'darkroom',
          visibility: 'public',
          stops: [
            {
              name: '香格里拉',
              date: '2026-10-09',
              lat: 27.826,
              lng: 99.707,
              note: '草甸风很轻。',
            },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await openAtlasAndFocusJourney(page, seeded.title, '香格里拉');
        await setPageColorScheme(page, 'light');
        const thumbBtn = page.locator('button:has(img[src*="/api/files/"]), a:has(img[src*="/api/files/"])').first();
        await ensureAtlasDrawerExpandedIfNeeded(page, thumbBtn);
        await thumbBtn.click();

        const dialog = page.locator('dialog[open]').first();
        await expect(dialog).toBeVisible();
        await assertOnlyDarkSurface(dialog);
        expect(await dialog.getAttribute('closedby')).toBe('any');

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlasRecords(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F1.6][F3.2] Page Light Mode × Observatory only dark #0B0C0E Viewport',
    { tag: ['@tier3', '@F1.6', '@F3.2'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        await page.goto('/observatory');
        await setPageColorScheme(page, 'light');

        const obsSurface = page.locator(OBSERVATORY_DARK_LOCATOR).first();
        await expect(obsSurface).toBeVisible();
        await assertOnlyDarkSurface(obsSurface);

        await expectThemeState(page, 'light');
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F2.1][F2.2] Atlas Split Layout (Desktop & Mobile Drawer) × Offline GeoJSON Map Fallback',
    { tag: ['@tier3', '@F2.1', '@F2.2'] },
    async ({ page, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const errors = attachErrorListeners(page);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const cfg = await api.getAtlasConfig();
        expect(cfg.status).toBe(200);
        expect(cfg.data.tiandituConfigured).toBe(false);

        const seeded = await seedJourney(api, testInfo, {
          prefix: 'layout',
          visibility: 'public',
          stops: [
            { name: '昆明翠湖', date: '2026-10-01', lat: 25.048, lng: 102.705, note: '秋日薄雾' },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await page.setViewportSize({ width: 1440, height: 900 });
        await openAtlasAndFocusJourney(page, seeded.title, '昆明翠湖');
        const mapCanvas = page.locator('canvas.maplibregl-canvas, canvas').first();
        await expect(mapCanvas).toBeVisible();
        const desktopMapBox = await mapCanvas.boundingBox();
        expect(desktopMapBox).not.toBeNull();
        if (desktopMapBox) {
          expect(desktopMapBox.width).toBeGreaterThan(700);
          expect(desktopMapBox.width).toBeLessThan(1050);
          expect(desktopMapBox.height).toBeGreaterThan(350);
        }

        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(300);
        const mobileMapBox = await mapCanvas.boundingBox();
        expect(mobileMapBox).not.toBeNull();
        if (mobileMapBox) {
          expect(mobileMapBox.height).toBeGreaterThan(180);
          expect(mobileMapBox.width).toBeGreaterThan(300);
        }
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlasRecords(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F2.2][F2.3] MapLibre 2.5D Offline GeoJSON × Bezier Track & Manual Takeover',
    { tag: ['@tier3', '@F2.2', '@F2.3'] },
    async ({ page, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const errors = attachErrorListeners(page);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 'bezier',
          visibility: 'public',
          stops: [
            { name: '昆明起点', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '出发' },
            { name: '大理中站', date: '2026-10-02', lat: 25.60, lng: 100.26, note: '洱海边' },
            { name: '丽江终点', date: '2026-10-03', lat: 26.85, lng: 100.22, note: '雪山脚下' },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await page.setViewportSize({ width: 1440, height: 900 });
        await openAtlasAndFocusJourney(page, seeded.title, '昆明起点');

        const playbackBtn = page.getByRole('button', { name: /沿途回放/ }).first();
        await expect(playbackBtn).toBeVisible();
        await playbackBtn.click();

        const pauseBtn = page.getByRole('button', { name: /暂停回放|暂停/ }).first();
        await expect(pauseBtn).toBeVisible();

        const mapCanvas = page.locator('canvas.maplibregl-canvas, canvas').first();
        const box = await mapCanvas.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.45, { steps: 5 });
          await page.mouse.up();
        }

        await expect(page.getByRole('button', { name: /沿途回放/ }).first()).toBeVisible();
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlasRecords(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F2.3][F2.5] Active Bezier Playback × Darkroom <dialog> Open/Dismiss & Focus Restore',
    { tag: ['@tier3', '@F2.3', '@F2.5'] },
    async ({ page, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const errors = attachErrorListeners(page);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 'play-dialog',
          visibility: 'public',
          stops: [
            { name: '站一', date: '2026-10-01', lat: 25.04, lng: 102.71, note: '第一站' },
            { name: '站二', date: '2026-10-02', lat: 25.60, lng: 100.26, note: '第二站' },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await openAtlasAndFocusJourney(page, seeded.title, '站一');
        await page.getByRole('button', { name: /沿途回放/ }).first().click();

        const triggerBtn = page.locator('button:has(img[src*="/api/files/"])').first();
        await ensureAtlasDrawerExpandedIfNeeded(page, triggerBtn);
        await expect(triggerBtn).toBeVisible();
        await triggerBtn.click();

        const dialog = page.locator('dialog[open]').first();
        await expect(dialog).toBeVisible();
        await assertOnlyDarkSurface(dialog);

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();

        const focusRestored = await triggerBtn.evaluate((el) => document.activeElement === el);
        expect(focusRestored).toBe(true);
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlasRecords(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F2.4][F2.5] Bone-White Card 600px Thumb × Darkroom 1600px Preview, Zoom & Arrow Nav',
    { tag: ['@tier3', '@F2.4', '@F2.5'] },
    async ({ page, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const errors = attachErrorListeners(page);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 'zoom-nav',
          visibility: 'public',
          stops: [
            {
              name: '双图站点',
              date: '2026-10-10',
              lat: 25.6065,
              lng: 100.2676,
              note: '横图与竖图都保持原比例',
              photos: [
                { width: 320, height: 200, caption: '横幅山景' },
                { width: 200, height: 320, caption: '竖幅星夜' },
              ],
            },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await openAtlasAndFocusJourney(page, seeded.title, '双图站点');
        const firstThumb = page.locator('img[src*="/api/files/"]').first();
        await ensureAtlasDrawerExpandedIfNeeded(page, firstThumb);
        await assertImageAspectRatioPreserved(firstThumb);

        await page.locator('button:has(img[src*="/api/files/"])').first().click();
        const dialog = page.locator('dialog[open]').first();
        await expect(dialog).toBeVisible();

        const lightImg = dialog.locator('img').first();
        await assertImageAspectRatioPreserved(lightImg);

        const zoomInBtn = dialog.getByRole('button', { name: /放大|\+/ }).first();
        if ((await zoomInBtn.count()) > 0) {
          await zoomInBtn.click();
          const transform = await lightImg.evaluate((el) => getComputedStyle(el).transform);
          expect(transform).not.toBe('none');
        }

        const initialSrc = await lightImg.getAttribute('src');
        await page.keyboard.press('ArrowRight');
        await expect(lightImg).not.toHaveAttribute('src', initialSrc ?? '');
        await assertImageAspectRatioPreserved(lightImg);

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlasRecords(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F2.6][F2.4] EXIF Orientation 5–8 Swap × Aspect Ratio Preservation',
    { tag: ['@tier3', '@F2.6', '@F2.4'] },
    async ({ page, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      const errors = attachErrorListeners(page);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        await loginAdminInPage(page, baseURL ?? 'http://127.0.0.1:5173');
        const tag = uniqueId(testInfo, 'orient6');
        const rotatedJpeg = appendJpegComment(
          createSyntheticExifJpeg({
            width: 320,
            height: 180,
            orientation: 6,
            lat: 25.04,
            lng: 102.71,
            focalLength: 50,
            fNumber: 1.8,
            iso: 200,
          }),
          tag,
        );

        const fileInput = page
          .locator('#main-content input[type="file"][accept*="image"]')
          .first();
        let hasImageInput = await fileInput
          .waitFor({ state: 'attached', timeout: 3000 })
          .then(() => true)
          .catch(() => false);
        if (!hasImageInput) {
          const atlasTab = page
            .locator('#main-content')
            .getByRole('button', { name: /旅图|影像|导入/ })
            .or(page.locator('#main-content').getByRole('tab', { name: /旅图|影像|导入/ }))
            .first();
          if (await atlasTab.isVisible().catch(() => false)) {
            await atlasTab.click();
            hasImageInput = await fileInput
              .waitFor({ state: 'attached', timeout: 3000 })
              .then(() => true)
              .catch(() => false);
          }
        }
        const isM1Placeholder = await page
          .locator('#main-content')
          .getByText(/将在这里汇聚/)
          .isVisible()
          .catch(() => false);

        let uploadedId: string | null = null;
        if (hasImageInput && !isM1Placeholder) {
          const uploadResPromise = page.waitForResponse(
            (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
            { timeout: 15_000 },
          );
          await fileInput.setInputFiles({
            name: `${tag}.jpg`,
            mimeType: 'image/jpeg',
            buffer: rotatedJpeg,
          });
          const confirmUploadBtn = page
            .locator('#main-content')
            .getByRole('button', { name: /上传|保存影像|提交/ })
            .first();
          if ((await confirmUploadBtn.count()) > 0 && (await confirmUploadBtn.isVisible())) {
            await confirmUploadBtn.click();
          }
          const uploadRes = await uploadResPromise;
          expect([200, 201]).toContain(uploadRes.status());
          const body = (await uploadRes.json()) as { media?: Array<Record<string, unknown>>; id?: string };
          uploadedId = String(body.media?.[0]?.id ?? body.id ?? '');
        } else if (isM1Placeholder) {
          const uploaded = await uploadAtlasPhoto(api, rotatedJpeg, `${tag}.jpg`, {
            lat: 25.04,
            lng: 102.71,
            caption: '竖构图旋转校正',
          });
          uploadedId = String(uploaded.id);
        } else {
          throw new Error('AdminPage hydrated without an Atlas image file input[accept*="image"].');
        }
        expect(uploadedId).toBeTruthy();
        if (uploadedId) createdMedia.push(uploadedId);

        const jid = `journey-${tag}`;
        const journeyTitle = `方向校验-${tag}`;
        const jRes = await api.saveJourney({
          id: jid,
          title: journeyTitle,
          subtitle: 'Orientation 6 旋转测试',
          startDate: '2026-10-12',
          endDate: '2026-10-12',
          visibility: 'public',
          coverId: uploadedId,
          stops: [
            {
              id: `stop-${tag}`,
              name: '滇池边',
              region: '云南',
              date: '2026-10-12',
              lat: 25.04,
              lng: 102.71,
              note: 'Orientation 6 应呈竖构图',
              mediaIds: uploadedId ? [uploadedId] : [],
            },
          ],
          createdAt: new Date().toISOString(),
        });
        expect([200, 201]).toContain(jRes.status);
        createdJourneys.push(jid);

        await openAtlasAndFocusJourney(page, journeyTitle, '滇池边');
        const img = page.locator(`img[src*="${uploadedId}"]`).first();
        await ensureAtlasDrawerExpandedIfNeeded(page, img);
        await assertImageAspectRatioPreserved(img);
        const dims = await img.evaluate((node) => {
          const el = node as HTMLImageElement;
          return { w: el.naturalWidth, h: el.naturalHeight };
        });
        expect(dims.h).toBeGreaterThan(dims.w);
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlasRecords(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F2.6][F2.7] EXIF-less Photo (omitGps) × Pending Geolocation Queue & Public Publish',
    { tag: ['@tier3', '@F2.6', '@F2.7'] },
    async ({ baseURL }, testInfo) => {
      const adminApi = createApiClient(baseURL);
      const visitorApi = createApiClient(baseURL);
      await adminApi.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const tag = uniqueId(testInfo, 'nogps');
        const exifless = appendJpegComment(createExiflessJpeg(240, 160), tag);
        const media = await uploadAtlasPhoto(adminApi, exifless, `${tag}.jpg`, {
          caption: '无 GPS 待定位测试',
        });
        const mediaId = String(media.id);
        createdMedia.push(mediaId);

        expect(media.lat).toBeNull();
        expect(media.lng).toBeNull();
        expect(media.confirmed).toBe(false);

        const publicBefore = await visitorApi.getLibrary();
        expect(publicBefore.status).toBe(200);
        const beforeMedia = (publicBefore.data.media as Array<Record<string, unknown>>) ?? [];
        expect(beforeMedia.some((m) => m.id === mediaId)).toBe(false);

        const patchRes = await adminApi.patchMedia({
          id: mediaId,
          lat: 36.6512,
          lng: 101.7782,
          confirmed: true,
          caption: '已确认西宁坐标',
        });
        expect([200, 204]).toContain(patchRes.status);

        const jid = `journey-${tag}`;
        const jRes = await adminApi.saveJourney({
          id: jid,
          title: `待定位确认-${tag}`,
          subtitle: '手动补全坐标后公开',
          startDate: '2026-10-14',
          endDate: '2026-10-14',
          visibility: 'public',
          coverId: mediaId,
          stops: [
            {
              id: `stop-${tag}`,
              name: '西宁',
              region: '青海',
              date: '2026-10-14',
              lat: 36.6512,
              lng: 101.7782,
              note: '已手动确认坐标',
              mediaIds: [mediaId],
            },
          ],
          createdAt: new Date().toISOString(),
        });
        expect([200, 201]).toContain(jRes.status);
        createdJourneys.push(jid);

        const publicAfter = await visitorApi.getLibrary();
        const afterMedia = (publicAfter.data.media as Array<Record<string, unknown>>) ?? [];
        expect(afterMedia.some((m) => m.id === mediaId && m.confirmed === true)).toBe(true);
      } finally {
        await cleanupAtlasRecords(adminApi, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F2.7][F5.2] Journey Visibility (private vs public) × Auth Cookie & /api/files/:id Gate',
    { tag: ['@tier3', '@F2.7', '@F5.2'] },
    async ({ baseURL }, testInfo) => {
      const adminApi = createApiClient(baseURL);
      const visitorApi = createApiClient(baseURL);
      await adminApi.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const priv = await seedJourney(adminApi, testInfo, {
          prefix: 'priv-gate',
          visibility: 'private',
          stops: [{ name: '私密站点', date: '2026-10-05', lat: 30.65, lng: 104.06, note: '仅管理员可见' }],
        });
        createdJourneys.push(priv.journeyId);
        createdMedia.push(...priv.mediaIds);

        const pub = await seedJourney(adminApi, testInfo, {
          prefix: 'pub-gate',
          visibility: 'public',
          stops: [{ name: '公开站点', date: '2026-10-06', lat: 30.67, lng: 104.08, note: '访客可见' }],
        });
        createdJourneys.push(pub.journeyId);
        createdMedia.push(...pub.mediaIds);

        const visitorLib = await visitorApi.getLibrary();
        expect(visitorLib.status).toBe(200);
        const visJourneys = (visitorLib.data.journeys as Array<Record<string, unknown>>) ?? [];
        expect(visJourneys.some((j) => j.id === pub.journeyId)).toBe(true);
        expect(visJourneys.some((j) => j.id === priv.journeyId)).toBe(false);
        expect((visitorLib.data.access as { role?: string } | undefined)?.role).toBe('visitor');

        const privMediaId = priv.mediaIds[0]!;
        const pubMediaId = pub.mediaIds[0]!;
        const unauthedPrivFile = await visitorApi.getFile(privMediaId, { variant: 'thumbnail' });
        expect([401, 403, 404]).toContain(unauthedPrivFile.status);

        const unauthedPubFile = await visitorApi.getFile(pubMediaId, { variant: 'thumbnail' });
        expect(unauthedPubFile.status).toBe(200);

        const authedPrivFile = await adminApi.getFile(privMediaId, { variant: 'thumbnail' });
        expect(authedPrivFile.status).toBe(200);
      } finally {
        await cleanupAtlasRecords(adminApi, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F2.4][F3.3] Atlas Card EXIF takenAt & GPS × "回望此地当夜星空" Link Contract',
    { tag: ['@tier3', '@F2.4', '@F3.3'] },
    async ({ page, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const errors = attachErrorListeners(page);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 'starlink',
          visibility: 'public',
          stops: [
            {
              name: '丽江玉龙雪山',
              date: '2026-10-15',
              lat: 26.855,
              lng: 100.227,
              note: '山谷夜空极清透',
              photos: [{ takenAt: '2026-10-15T22:15:00+08:00' }],
            },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await openAtlasAndFocusJourney(page, seeded.title, '丽江玉龙雪山');
        const skyLink = page.getByRole('link', { name: /回望此地当夜星空/ }).first();
        await ensureAtlasDrawerExpandedIfNeeded(page, skyLink);
        await expect(skyLink).toBeVisible();
        await skyLink.click();

        await expect(page).toHaveURL(/\/observatory\?/);
        const parsed = new URL(page.url());
        expect(Number(parsed.searchParams.get('lat'))).toBeCloseTo(26.855, 2);
        expect(Number(parsed.searchParams.get('lng'))).toBeCloseTo(100.227, 2);
        expect(parsed.searchParams.get('time') ?? '').toContain('2026-10-15');
        expect(parsed.searchParams.get('place') ?? '').toContain('丽江');
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlasRecords(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[F3.3][F3.1] Observatory URL Params × Same-Origin Stellarium & BrightStarChart Fallback',
    { tag: ['@tier3', '@F3.3', '@F3.1'] },
    async ({ page, baseURL }) => {
      const errors = attachErrorListeners(page);
      const thirdPartyRequests: string[] = [];
      const expectedOrigin = new URL(baseURL ?? 'http://127.0.0.1:5173').origin;

      page.on('request', (req) => {
        const url = req.url();
        if (url.startsWith('http://') || url.startsWith('https://')) {
          if (new URL(url).origin !== expectedOrigin) {
            thirdPartyRequests.push(url);
          }
        }
      });

      try {
        await page.goto(
          '/observatory?lat=25.6065&lng=100.2676&time=2026-10-15T21:30:00%2B08:00&place=%E5%A4%A7%E7%90%86',
        );
        await expect(page.locator(OBSERVATORY_DARK_LOCATOR).first()).toBeVisible();

        const fallbackToggle = page.getByRole('button', { name: /简版方位图|方位图|切换/ }).first();
        if ((await fallbackToggle.count()) > 0) {
          await fallbackToggle.click();
        }
        const chartOrIframe = page.locator('svg[role="img"], iframe[src*="/stellarium/"]').first();
        await expect(chartOrIframe).toBeVisible();

        expect(thirdPartyRequests).toEqual([]);
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F3.1][F3.2] Observatory Search & Layers × 19:00 → 04:00 Midnight Rollover',
    { tag: ['@tier3', '@F3.1', '@F3.2'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        await page.goto(
          '/observatory?lat=25.6065&lng=100.2676&time=2026-10-15T20:00:00%2B08:00&place=%E5%A4%A7%E7%90%86',
        );

        const slider = page.getByRole('slider').first();
        await expect(slider).toBeVisible();
        const maxVal = (await slider.getAttribute('max')) ?? '540';
        await slider.fill(maxVal);

        const pageText = await page.locator(OBSERVATORY_DARK_LOCATOR).first().innerText();
        expect(pageText).toMatch(/0[0-4]:\d{2}|2026-10-16/);

        const searchInput = page
          .locator('input[type="search"], input[aria-label*="搜索"], input[placeholder*="搜索"]')
          .first();
        await expect(searchInput).toBeVisible();
        await searchInput.fill('Orion');
        await page.waitForTimeout(200);
        await searchInput.fill('猎户座');
        await page.waitForTimeout(200);
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F3.2][F5.1] Observatory Lazy Chunk Isolation × Route Leave Cleanup',
    { tag: ['@tier3', '@F3.2', '@F5.1'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      const loadedScripts: string[] = [];
      page.on('response', (res) => {
        if (res.request().resourceType() === 'script' || res.url().includes('/stellarium/')) {
          loadedScripts.push(res.url());
        }
      });

      try {
        await page.goto('/');
        await page.waitForTimeout(400);
        const onHome = loadedScripts.filter(
          (u) =>
            u.includes('vendor-maplibre') ||
            u.includes('vendor-astronomy') ||
            u.includes('/stellarium/'),
        );
        expect(onHome).toEqual([]);

        await page.goto('/observatory');
        await page.waitForTimeout(400);
        await expect(page.locator(OBSERVATORY_DARK_LOCATOR).first()).toBeVisible();

        await page.goto('/vault');
        await expect(page.locator('h1').first()).toBeVisible();
        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[F4.1][F4.3] Vault 6-Char Capsule (Enter, Trim/Case) × Note, SVG QR & Revocation Tombstone',
    { tag: ['@tier3', '@F4.1', '@F4.3'] },
    async ({ page, baseURL }, testInfo) => {
      const adminApi = createApiClient(baseURL);
      await adminApi.ensureAdminSession();
      const errors = attachErrorListeners(page);
      const shareIds: string[] = [];
      const fileIds: string[] = [];

      try {
        const tag = uniqueId(testInfo, 'qr-revoke');
        const payload = createBinaryChunkPayload(4096, 11);
        const initRes = await adminApi.initVaultUpload({
          name: `${tag}.bin`,
          mime: 'application/octet-stream',
          size: payload.buffer.byteLength,
          sha256: payload.sha256,
          totalChunks: 1,
        });
        expect(initRes.status).toBe(200);
        const chunkRes = await adminApi.uploadVaultChunk(initRes.data.uploadId, 0, payload.buffer);
        expect(chunkRes.status).toBe(200);
        const doneRes = await adminApi.completeVaultUpload(initRes.data.uploadId);
        expect(doneRes.status).toBe(200);
        const fileId = extractCompletedVaultFileId(doneRes.data, initRes.data.fileId);
        fileIds.push(fileId);

        const shareRes = await adminApi.createVaultShare({
          fileId,
          expiresIn: 3600,
          maxDownloads: 2,
          passcode: 'Ab3X9z',
          note: '山海手记样本',
        });
        expect([200, 201]).toContain(shareRes.status);
        const shareId = String((shareRes.data as { id?: string; share?: { id?: string } }).share?.id ?? shareRes.data.id);
        shareIds.push(shareId);

        await page.goto('/vault');
        const input = page.getByRole('textbox').first();
        await expect(input).toBeVisible();
        await input.fill(' ab3x9z ');
        await input.press('Enter');

        await expect(page.getByText(`${tag}.bin`)).toBeVisible();
        await expect(page.getByText('山海手记样本')).toBeVisible();
        const qrSvg = page.locator('svg[viewBox]').first();
        await expect(qrSvg).toBeVisible();

        const revokeRes = await adminApi.revokeVaultShare(shareId);
        expect(revokeRes.status).toBe(200);

        const afterRevoke = await createApiClient(baseURL).redeemVault('Ab3X9z');
        expect([403, 410]).toContain(afterRevoke.status);
        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupVaultRecords(adminApi, shareIds, fileIds);
      }
    },
  );

  test(
    '[F4.2][F4.3] Vault Multi-Chunk Upload (Private Default) × Byte-Range Download & Last Exhaustion',
    { tag: ['@tier3', '@F4.2', '@F4.3'] },
    async ({ baseURL }, testInfo) => {
      const adminApi = createApiClient(baseURL);
      const visitorApi = createApiClient(baseURL);
      await adminApi.ensureAdminSession();
      const shareIds: string[] = [];
      const fileIds: string[] = [];

      try {
        const tag = uniqueId(testInfo, 'chunks');
        const chunkSize = 64 * 1024;
        const payload = createBinaryChunkPayload(chunkSize * 3, 29);

        const initRes = await adminApi.initVaultUpload({
          name: `${tag}.bin`,
          mime: 'application/octet-stream',
          size: payload.buffer.byteLength,
          sha256: payload.sha256,
          totalChunks: 3,
        });
        expect(initRes.status).toBe(200);

        for (let idx = 0; idx < 3; idx += 1) {
          const slice = payload.buffer.subarray(idx * chunkSize, (idx + 1) * chunkSize);
          const putRes = await adminApi.uploadVaultChunk(initRes.data.uploadId, idx, slice);
          expect(putRes.status).toBe(200);
        }

        const completeRes = await adminApi.completeVaultUpload(initRes.data.uploadId);
        expect(completeRes.status).toBe(200);
        const fileRecord = (completeRes.data.file ?? completeRes.data) as Record<string, unknown>;
        const fileId = extractCompletedVaultFileId(completeRes.data, initRes.data.fileId);
        fileIds.push(fileId);
        expect(fileRecord.visibility).toBe('private');

        const shareRes = await adminApi.createVaultShare({
          fileId,
          expiresIn: 3600,
          maxDownloads: 1,
          passcode: 'R7N2M4',
          note: '分片归档',
        });
        expect([200, 201]).toContain(shareRes.status);
        const shareId = String((shareRes.data as { id?: string; share?: { id?: string } }).share?.id ?? shareRes.data.id);
        shareIds.push(shareId);

        const redeem = await visitorApi.redeemVault('R7N2M4');
        expect(redeem.status).toBe(200);
        const ticketPath = redeem.data.downloadUrl;
        const ticketId = ticketPath.split('/').pop() ?? '';
        expect(ticketId.length).toBeGreaterThan(0);

        const headRes = await visitorApi.downloadVaultTicket(ticketId, { method: 'HEAD' });
        expect(headRes.status).toBe(200);
        expect(headRes.headers.get('accept-ranges')).toBe('bytes');
        expect(headRes.headers.get('x-content-type-options')).toBe('nosniff');
        expect(headRes.headers.get('cache-control') ?? '').toContain('no-store');

        const rangeRes = await visitorApi.downloadVaultTicket(ticketId, { range: 'bytes=0-1023' });
        expect(rangeRes.status).toBe(206);
        expect(rangeRes.buffer.byteLength).toBe(1024);

        const fullRes = await visitorApi.downloadVaultTicket(ticketId);
        expect(fullRes.status).toBe(200);
        const downloadedSha = crypto.createHash('sha256').update(fullRes.buffer).digest('hex');
        expect(downloadedSha).toBe(payload.sha256);

        const exhausted = await visitorApi.redeemVault('R7N2M4');
        expect([403, 410]).toContain(exhausted.status);
      } finally {
        await cleanupVaultRecords(adminApi, shareIds, fileIds);
      }
    },
  );

  test(
    '[F5.2][F4.1] Rate-Limit Isolation (Vault Redeem vs Admin Login) & Origin/CSRF Guard',
    { tag: ['@tier3', '@F5.2', '@F4.1'] },
    async ({ baseURL }, testInfo) => {
      const adminApi = createApiClient(baseURL);
      await adminApi.ensureAdminSession();
      const shareIds: string[] = [];
      const fileIds: string[] = [];

      try {
        const tag = uniqueId(testInfo, 'ratelimit');
        const payload = createBinaryChunkPayload(2048, 37);
        const initRes = await adminApi.initVaultUpload({
          name: `${tag}.bin`,
          mime: 'application/octet-stream',
          size: payload.buffer.byteLength,
          sha256: payload.sha256,
          totalChunks: 1,
        });
        expect(initRes.status).toBe(200);
        await adminApi.uploadVaultChunk(initRes.data.uploadId, 0, payload.buffer);
        const doneRes = await adminApi.completeVaultUpload(initRes.data.uploadId);
        expect(doneRes.status).toBe(200);
        const fileId = extractCompletedVaultFileId(doneRes.data, initRes.data.fileId);
        fileIds.push(fileId);

        const shareRes = await adminApi.createVaultShare({
          fileId,
          expiresIn: 3600,
          maxDownloads: 3,
          passcode: 'V9T4K2',
        });
        shareIds.push(String((shareRes.data as { id?: string; share?: { id?: string } }).share?.id ?? shareRes.data.id));

        const vaultIp = uniqueTestIp(testInfo, 1);
        const adminOkIp = uniqueTestIp(testInfo, 2);
        const loginAttackIp = uniqueTestIp(testInfo, 3);
        const legitRedeemIp = uniqueTestIp(testInfo, 4);

        const vaultAttacker = createApiClient(baseURL);
        let sawVault429 = false;
        for (let i = 0; i < 15; i += 1) {
          const bad = await vaultAttacker.redeemVault(`BAD00${i % 10}`, undefined, {
            headers: { 'CF-Connecting-IP': vaultIp },
          });
          if (bad.status === 429) {
            sawVault429 = true;
            break;
          }
        }
        expect(sawVault429).toBe(true);

        const isolatedAdmin = createApiClient(baseURL);
        const loginOk = await isolatedAdmin.postAuth(
          { action: 'login', password: process.env.E2E_ADMIN_PASSWORD || 'AtlasVaultStarlight2026!' },
          { headers: { 'CF-Connecting-IP': adminOkIp } },
        );
        expect(loginOk.status).toBe(200);
        expect(loginOk.data.authenticated).toBe(true);

        const loginAttacker = createApiClient(baseURL);
        let sawLogin429 = false;
        for (let i = 0; i < 8; i += 1) {
          const badLogin = await loginAttacker.postAuth(
            { action: 'login', password: 'WrongPassword123!' },
            { headers: { 'CF-Connecting-IP': loginAttackIp } },
          );
          if (badLogin.status === 429) {
            sawLogin429 = true;
            break;
          }
        }
        expect(sawLogin429).toBe(true);

        const legitimateRedeem = await createApiClient(baseURL).redeemVault('V9T4K2', undefined, {
          headers: { 'CF-Connecting-IP': legitRedeemIp },
        });
        expect(legitimateRedeem.status).toBe(200);

        const noOrigin = await adminApi.patchSecurity({ retentionDays: 30 }, { origin: null });
        expect(noOrigin.status).toBe(403);
        const noCsrf = await adminApi.patchSecurity({ retentionDays: 30 }, { csrfToken: null });
        expect(noCsrf.status).toBe(403);
      } finally {
        await cleanupVaultRecords(adminApi, shareIds, fileIds);
      }
    },
  );

  test(
    '[F5.2][F5.3] Rejected Unauthenticated/CSRF Mutations × R2 Cost Quota Protection',
    { tag: ['@tier3', '@F5.2', '@F5.3'] },
    async ({ baseURL }) => {
      const adminApi = createApiClient(baseURL);
      const anonApi = createApiClient(baseURL);
      await adminApi.ensureAdminSession();

      const beforeRes = await adminApi.getAdminUsage();
      expect(beforeRes.status).toBe(200);
      const beforeMap = usageCounterMap(beforeRes.data.counters);
      const beforeUploadBytes = beforeMap.get('r2-upload-bytes:lifetime') ?? 0;
      const beforeClassA = counterByPrefix(beforeMap, 'r2-class-a');

      const r1 = await anonApi.initVaultUpload({
        name: 'unauth.bin',
        mime: 'application/octet-stream',
        size: 1024,
        sha256: '0'.repeat(64),
        totalChunks: 1,
      });
      expect(r1.status).toBe(401);

      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), 'unauth.jpg');
      const r2 = await anonApi.uploadMedia(form);
      expect(r2.status).toBe(401);

      const r3 = await adminApi.saveJourney({ id: 'csrf-reject', title: 'blocked' }, { csrfToken: null });
      expect(r3.status).toBe(403);

      const afterRes = await adminApi.getAdminUsage();
      expect(afterRes.status).toBe(200);
      const afterMap = usageCounterMap(afterRes.data.counters);
      expect(afterMap.get('r2-upload-bytes:lifetime') ?? 0).toBe(beforeUploadBytes);
      expect(counterByPrefix(afterMap, 'r2-class-a')).toBe(beforeClassA);
    },
  );

  test(
    '[F5.3][F4.2] D1 Atomic Cost Metering × Vault Chunk Abort Non-Refund & >16 MiB Rejection',
    { tag: ['@tier3', '@F5.3', '@F4.2'] },
    async ({ baseURL }, testInfo) => {
      const adminApi = createApiClient(baseURL);
      await adminApi.ensureAdminSession();

      const tag = uniqueId(testInfo, 'cost-abort');
      const beforeRes = await adminApi.getAdminUsage();
      expect(beforeRes.status).toBe(200);
      const beforeMap = usageCounterMap(beforeRes.data.counters);
      const beforeBytes = beforeMap.get('r2-upload-bytes:lifetime') ?? 0;
      const beforeClassA = counterByPrefix(beforeMap, 'r2-class-a');

      const chunkA = createBinaryChunkPayload(4096, 41);
      const chunkB = createBinaryChunkPayload(4096, 42);
      const combinedSha = crypto
        .createHash('sha256')
        .update(Buffer.concat([chunkA.buffer, chunkB.buffer]))
        .digest('hex');

      const initRes = await adminApi.initVaultUpload({
        name: `${tag}.bin`,
        mime: 'application/octet-stream',
        size: 8192,
        sha256: combinedSha,
        totalChunks: 2,
      });
      expect(initRes.status).toBe(200);
      expect((await adminApi.uploadVaultChunk(initRes.data.uploadId, 0, chunkA.buffer)).status).toBe(200);
      expect((await adminApi.uploadVaultChunk(initRes.data.uploadId, 1, chunkB.buffer)).status).toBe(200);

      const abortRes = await adminApi.abortVaultUpload(initRes.data.uploadId);
      expect(abortRes.status).toBe(200);

      const afterAbort = await adminApi.getAdminUsage();
      const afterAbortMap = usageCounterMap(afterAbort.data.counters);
      expect(afterAbortMap.get('r2-upload-bytes:lifetime') ?? 0).toBe(beforeBytes + 8192);
      expect(counterByPrefix(afterAbortMap, 'r2-class-a')).toBeGreaterThan(beforeClassA);

      const oversizedBytes = (16 << 20) + 64;
      const oversizeInit = await adminApi.initVaultUpload({
        name: `${tag}-oversize.bin`,
        mime: 'application/octet-stream',
        size: oversizedBytes,
        sha256: 'a'.repeat(64),
        totalChunks: 1,
      });
      if (oversizeInit.status === 200) {
        const oversizePut = await adminApi.uploadVaultChunk(
          oversizeInit.data.uploadId,
          0,
          Buffer.alloc(oversizedBytes),
        );
        expect([400, 413]).toContain(oversizePut.status);
        await adminApi.abortVaultUpload(oversizeInit.data.uploadId).catch(() => undefined);
      } else {
        expect([400, 413]).toContain(oversizeInit.status);
      }
    },
  );

  test(
    '[F5.4][F5.5] Backup ZIP (cloudflare-1) SHA-256 & Trash/Restore Guards × Local-Only Boundary',
    { tag: ['@tier3', '@F5.4', '@F5.5'] },
    async ({ baseURL }, testInfo) => {
      const audit = auditLocalOnlyBoundary(REPO_ROOT);
      expect(audit.ok).toBe(true);
      expect(audit.wranglerSummary.workersDev).toBe(false);
      expect(audit.wranglerSummary.previewUrls).toBe(false);
      expect(audit.wranglerSummary.d1Remotes).toEqual([false]);
      expect(audit.wranglerSummary.r2Remotes).toEqual([false]);

      const adminApi = createApiClient(baseURL);
      await adminApi.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(adminApi, testInfo, {
          prefix: 'backup-guard',
          visibility: 'public',
          stops: [{ name: '备份测试站', date: '2026-10-18', lat: 24.88, lng: 102.83, note: 'ZIP 校验' }],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);
        const mediaId = seeded.mediaIds[0]!;

        const backupRes = await adminApi.getAdminBackup();
        expect(backupRes.status).toBe(200);
        expect(backupRes.headers.get('content-type') ?? '').toContain('application/zip');

        const archive = unzipSync(new Uint8Array(backupRes.buffer));
        expect(archive['library.sql']).toBeDefined();
        expect(archive['README.txt']).toBeDefined();
        expect(archive['manifest.json']).toBeDefined();

        const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
          version: string;
          files: Array<{ path: string; size: number; sha256: string }>;
        };
        expect(manifest.version).toBe('cloudflare-1');
        for (const entry of manifest.files) {
          const bytes = archive[entry.path];
          expect(bytes).toBeDefined();
          if (bytes) {
            expect(bytes.byteLength).toBe(entry.size);
            const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
            expect(actualSha).toBe(entry.sha256);
          }
        }

        const sqlText = strFromU8(archive['library.sql']!);
        const decodedSql = decodeSqlHexLiterals(sqlText);
        expect(decodedSql).toContain(seeded.journeyId);
        expect(decodedSql).not.toContain('security_sessions');
        expect(decodedSql).not.toContain('usage_limits');
        expect(decodedSql).not.toContain('SESSION_SECRET');

        const blockedMediaTrash = await adminApi.trashItem('media', mediaId);
        expect(blockedMediaTrash.status).toBe(409);

        const trashJourneyRes = await adminApi.trashItem('journey', seeded.journeyId);
        expect(trashJourneyRes.status).toBe(200);
        const journeyTrashKey = String(trashJourneyRes.data.key);

        const trashMediaRes = await adminApi.trashItem('media', mediaId);
        expect(trashMediaRes.status).toBe(200);
        const mediaTrashKey = String(trashMediaRes.data.key);

        const blockedJourneyRestore = await adminApi.restoreItem(journeyTrashKey);
        expect(blockedJourneyRestore.status).toBe(409);

        expect((await adminApi.restoreItem(mediaTrashKey)).status).toBe(200);
        expect((await adminApi.restoreItem(journeyTrashKey)).status).toBe(200);
      } finally {
        await cleanupAtlasRecords(adminApi, createdJourneys, createdMedia);
      }
    },
  );
});
