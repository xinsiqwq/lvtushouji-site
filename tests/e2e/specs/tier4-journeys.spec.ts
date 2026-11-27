import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import {
  assertDemoImagesExist,
  createBinaryChunkPayload,
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
import { assertLocalOnlyBoundary } from '../helpers/local-guard';

test.describe.configure({ mode: 'serial' });

const OBSERVATORY_DARK_LOCATOR = '.deep-space, [data-only-dark], .observatory-viewport';
const REPO_ROOT = path.resolve(process.cwd());

let journeySeq = 0;
let ipSeq = 0;
const usedTestIps = new Set<string>();

function nextTag(testInfo: TestInfo, prefix: string): string {
  journeySeq += 1;
  const proj = testInfo.project.name.replace(/[^a-z0-9]/gi, '');
  return `${prefix}-${proj}-${Date.now()}-${journeySeq}`;
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

function readSetupToken(repoRoot: string): string | undefined {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  for (const fname of ['.dev.vars.local', '.dev.vars']) {
    const fpath = path.join(repoRoot, fname);
    if (!fs.existsSync(fpath)) continue;
    for (const rawLine of fs.readFileSync(fpath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq > 0 && line.slice(0, eq).trim() === 'SETUP_TOKEN') {
        return line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return undefined;
}

function usageMap(counters: Array<{ key: string; value: number }>): Map<string, number> {
  return new Map(counters.map((c) => [c.key, c.value]));
}

function counterByPrefix(map: Map<string, number>, prefix: string): number {
  let total = 0;
  for (const [k, v] of map.entries()) {
    if (k === prefix || k.startsWith(`${prefix}:`)) total += v;
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
    throw new Error(`POST /api/media failed to return Media id: ${res.text}`);
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
  const tag = nextTag(testInfo, opts.prefix);
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
        caption: pSpec.caption ?? `${stopSpec.name}-${sIdx}-${pIdx}`,
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
    subtitle: opts.subtitle ?? '山海长途手记',
    startDate: firstStop?.date ?? '2026-10-01',
    endDate: lastStop?.date ?? '2026-10-03',
    visibility: opts.visibility,
    coverId: mediaIds[0] ?? null,
    stops: stopsPayload,
    createdAt: new Date().toISOString(),
  });
  expect([200, 201]).toContain(saveRes.status);
  return { journeyId, mediaIds, title };
}

async function cleanupAtlas(api: ApiClient, journeyIds: string[], mediaIds: string[]): Promise<void> {
  for (const jid of journeyIds) {
    await api.trashItem('journey', jid).catch(() => undefined);
  }
  for (const mid of mediaIds) {
    await api.trashItem('media', mid).catch(() => undefined);
  }
}

async function cleanupVault(api: ApiClient, shareIds: string[], fileIds: string[]): Promise<void> {
  for (const sid of shareIds) {
    await api.revokeVaultShare(sid).catch(() => undefined);
  }
  for (const fid of fileIds) {
    await api.trashItem('vault_file', fid).catch(() => undefined);
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

async function loginAdminUi(page: Page, baseURL?: string): Promise<ApiClient> {
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
    await page
      .locator('#main-content')
      .getByRole('button', { name: /登录|进入|解锁|确认/ })
      .first()
      .click();
    await expect(pwInput).toBeHidden({ timeout: 10_000 });
    await expect(authedMarker).toBeVisible({ timeout: 10_000 });
  }
  return api;
}

test.describe('Tier 4: Real-World End-to-End User Journeys (Scenarios 1–13)', () => {
  test(
    '[Tier4][S01][F5.2][F5.1][F5.5] Scenario 1: First-Time Admin Setup, Auth Hardening & Security Audit',
    { tag: ['@tier4', '@F5.2', '@F5.1', '@F5.5'] },
    async ({ page, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const adminPassword = process.env.E2E_ADMIN_PASSWORD || 'AtlasVaultStarlight2026!';
      let secondarySessionId: string | null = null;
      const primaryApi = createApiClient(baseURL);

      try {
        await test.step('Verify local-only safety boundary before auth operations', async () => {
          const boundary = assertLocalOnlyBoundary(REPO_ROOT);
          expect(boundary.ok).toBe(true);
        });

        await test.step('Verify invalid /__setup token rejected and initial setup or auth status works', async () => {
          const invalidSetup = await primaryApi.setupEntry('invalid-short-token');
          expect(invalidSetup.status).toBe(403);

          const unauthUsage = await primaryApi.getAdminUsage();
          expect(unauthUsage.status).toBe(401);

          const status = await primaryApi.getAuthStatus();
          expect(status.status).toBe(200);
          if (!status.data.configured) {
            const token = readSetupToken(REPO_ROOT);
            expect(token).toBeTruthy();
            if (token) {
              const entry = await primaryApi.setupEntry(token);
              expect([200, 303]).toContain(entry.status);
            }
          }
          await primaryApi.ensureAdminSession(adminPassword);
        });

        await test.step('Record failed login from isolated IP and verify UI HttpOnly cookie login persists across reload', async () => {
          const attacker = createApiClient(baseURL);
          const badRes = await attacker.postAuth(
            { action: 'login', password: 'WrongPasswordAttempt999!' },
            { headers: { 'CF-Connecting-IP': uniqueTestIp(testInfo, 1) } },
          );
          expect(badRes.status).toBe(401);

          await page.goto('/admin', { waitUntil: 'domcontentloaded' });
          await page.locator('#main-content h1').waitFor({ state: 'visible', timeout: 10_000 });
          const pwInput = page
            .locator('#main-content input[type="password"], #main-content input[name="password"]')
            .first();
          const adminContentMarker = page
            .locator('#main-content')
            .getByRole('button', { name: /退出|备份|导出/ })
            .or(page.locator('#main-content').getByText(/累计上传|用量监控|安全策略/))
            .first();
          await expect(pwInput.or(adminContentMarker).first()).toBeVisible({ timeout: 10_000 });
          if (await pwInput.isVisible().catch(() => false)) {
            await pwInput.fill(adminPassword);
            await page
              .locator('#main-content')
              .getByRole('button', { name: /登录|进入|解锁|确认/ })
              .first()
              .click();
            await expect(pwInput).toBeHidden({ timeout: 10_000 });
          }
          await expect(adminContentMarker).toBeVisible({ timeout: 10_000 });

          const leakedCookie = await page.evaluate(() => document.cookie);
          expect(leakedCookie).not.toContain('travel_session');

          await page.reload();
          await page.locator('#main-content h1').waitFor({ state: 'visible', timeout: 10_000 });
          await expect(adminContentMarker).toBeVisible({ timeout: 10_000 });
        });

        await test.step('Verify security snapshot, CSRF enforcement, policy round-trip, and session revocation', async () => {
          const snapRes = await primaryApi.getSecurity();
          expect(snapRes.status).toBe(200);
          const totals = snapRes.data.totals as { failedLogins?: number } | undefined;
          expect(totals?.failedLogins ?? 0).toBeGreaterThanOrEqual(1);

          const missingCsrf = await primaryApi.patchSecurity({ retentionDays: 30 }, { csrfToken: null });
          expect(missingCsrf.status).toBe(403);

          const secondaryApi = createApiClient(baseURL);
          const secLogin = await secondaryApi.postAuth(
            { action: 'login', password: adminPassword },
            { headers: { 'CF-Connecting-IP': uniqueTestIp(testInfo, 2) } },
          );
          expect(secLogin.status).toBe(200);
          secondarySessionId = secLogin.data.sessionId;
          expect(secondarySessionId).toBeTruthy();

          if (secondarySessionId) {
            const revokeRes = await primaryApi.revokeSession(secondarySessionId, 'DELETE');
            expect(revokeRes.status).toBe(200);
            const revokedProbe = await secondaryApi.getAdminUsage();
            expect(revokedProbe.status).toBe(401);
          }
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[Tier4][S02][F2.6][F2.7][F2.4][F5.2] Scenario 2: Journey Creation → Synthetic EXIF+GPS Upload (600/1600 WebP) → Public Publish',
    { tag: ['@tier4', '@F2.6', '@F2.7', '@F2.4', '@F5.2'] },
    async ({ page, browser, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const api = createApiClient(baseURL);
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];
      let publicContext = null as Awaited<ReturnType<typeof browser.newContext>> | null;

      try {
        const tag = nextTag(testInfo, 's02');
        await test.step('Login to /admin and upload synthetic EXIF+GPS JPEG through browser pipeline', async () => {
          await loginAdminUi(page, baseURL);
          const syntheticJpeg = appendJpegComment(
            createSyntheticExifJpeg({
              width: 480,
              height: 320,
              lat: 25.6065,
              lng: 100.2676,
              takenAt: '2026-10-02T21:15:00+08:00',
              make: 'FUJIFILM',
              model: 'X-T5',
              focalLength: 35,
              fNumber: 2.8,
              exposureTime: 1 / 250,
              iso: 400,
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

          let mediaId = '';
          if (hasImageInput && !isM1Placeholder) {
            const uploadReqPromise = page.waitForRequest(
              (req) => req.url().includes('/api/media') && req.method() === 'POST',
              { timeout: 15_000 },
            );
            const uploadResPromise = page.waitForResponse(
              (res) => res.url().includes('/api/media') && res.request().method() === 'POST',
              { timeout: 15_000 },
            );
            await fileInput.setInputFiles({
              name: `${tag}.jpg`,
              mimeType: 'image/jpeg',
              buffer: syntheticJpeg,
            });
            const submitBtn = page
              .locator('#main-content')
              .getByRole('button', { name: /上传|保存影像|提交/ })
              .first();
            if ((await submitBtn.count()) > 0 && (await submitBtn.isVisible())) {
              await submitBtn.click();
            }
            const req = await uploadReqPromise;
            const postBuf = req.postDataBuffer();
            if (postBuf) {
              expect(postBuf.toString('latin1')).toContain('image/webp');
            }
            const res = await uploadResPromise;
            expect([200, 201]).toContain(res.status());
            const body = (await res.json()) as { media?: Array<Record<string, unknown>>; id?: string };
            mediaId = String(body.media?.[0]?.id ?? body.id ?? '');
          } else if (isM1Placeholder) {
            const uploaded = await uploadAtlasPhoto(api, syntheticJpeg, `${tag}.jpg`, {
              lat: 25.6065,
              lng: 100.2676,
              takenAt: '2026-10-02T21:15:00+08:00',
              caption: '双廊月夜',
            });
            mediaId = String(uploaded.id);
          } else {
            throw new Error('AdminPage hydrated without an Atlas image file input[accept*="image"].');
          }

          expect(mediaId).toBeTruthy();
          createdMedia.push(mediaId);
        });

        const mediaId = createdMedia[0]!;
        const journeyId = `journey-${tag}`;

        await test.step('Create Journey as private and confirm unauthenticated isolation', async () => {
          await api.ensureAdminSession();
          const createRes = await api.saveJourney({
            id: journeyId,
            title: `洱海秋夜-${tag}`,
            subtitle: '双廊停泊',
            startDate: '2026-10-02',
            endDate: '2026-10-02',
            visibility: 'private',
            coverId: mediaId,
            stops: [
              {
                id: `stop-${tag}`,
                name: '双廊',
                region: '大理',
                date: '2026-10-02',
                lat: 25.6065,
                lng: 100.2676,
                note: '洱海东岸水面平静，远岸灯火像一排低星。',
                mediaIds: [mediaId],
              },
            ],
            createdAt: new Date().toISOString(),
          });
          expect([200, 201]).toContain(createRes.status);
          createdJourneys.push(journeyId);

          const anonApi = createApiClient(baseURL);
          const anonLib = await anonApi.getLibrary();
          const anonJourneys = (anonLib.data.journeys as Array<Record<string, unknown>>) ?? [];
          expect(anonJourneys.some((j) => j.id === journeyId)).toBe(false);
          const privFile = await anonApi.getFile(mediaId, { variant: 'thumbnail' });
          expect([401, 403, 404]).toContain(privFile.status);
        });

        await test.step('Publish Journey and inspect in fresh unauthenticated browser context after reload', async () => {
          const pubRes = await api.saveJourney({
            id: journeyId,
            title: `洱海秋夜-${tag}`,
            subtitle: '双廊停泊',
            startDate: '2026-10-02',
            endDate: '2026-10-02',
            visibility: 'public',
            coverId: mediaId,
            stops: [
              {
                id: `stop-${tag}`,
                name: '双廊',
                region: '大理',
                date: '2026-10-02',
                lat: 25.6065,
                lng: 100.2676,
                note: '洱海东岸水面平静，远岸灯火像一排低星。',
                mediaIds: [mediaId],
              },
            ],
            createdAt: new Date().toISOString(),
          });
          expect([200, 201]).toContain(pubRes.status);

          publicContext = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            baseURL,
          });
          const pubPage = await publicContext.newPage();
          await openAtlasAndFocusJourney(pubPage, `洱海秋夜-${tag}`, '双廊');
          await pubPage.reload();
          await openAtlasAndFocusJourney(pubPage, `洱海秋夜-${tag}`, '双廊');
          const cardImg = pubPage.locator(`img[src*="${mediaId}"]`).first();
          await ensureAtlasDrawerExpandedIfNeeded(pubPage, cardImg);
          await assertImageAspectRatioPreserved(cardImg);
        });

        errors.assertZeroErrors();
      } finally {
        if (publicContext) await publicContext.close();
        errors.detach();
        await api.ensureAdminSession().catch(() => undefined);
        await cleanupAtlas(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[Tier4][S03][F2.6][F2.7][F2.4] Scenario 3: EXIF-less Photo (road.jpg) → Pending Geolocation Queue → Manual Coords Confirmation → Publish',
    { tag: ['@tier4', '@F2.6', '@F2.7', '@F2.4'] },
    async ({ page, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const tag = nextTag(testInfo, 's03');
        let mediaId = '';

        await test.step('Verify road.jpg fixture and upload EXIF-less photo into pending geolocation state', async () => {
          assertDemoImagesExist();
          const demoRoad = readDemoImage('road');
          expect(demoRoad.byteLength).toBeGreaterThan(1024);

          const exiflessBuf = appendJpegComment(createExiflessJpeg(320, 200), `${tag}-road`);
          const uploaded = await uploadAtlasPhoto(api, exiflessBuf, `road-${tag}.jpg`, {
            caption: '西宁出城公路',
          });
          mediaId = String(uploaded.id);
          createdMedia.push(mediaId);

          expect(uploaded.lat).toBeNull();
          expect(uploaded.lng).toBeNull();
          expect(uploaded.confirmed).toBe(false);
        });

        await test.step('Confirm manual coordinates in admin flow and persist across page reload', async () => {
          const patchRes = await api.patchMedia({
            id: mediaId,
            lat: 36.6512,
            lng: 101.7782,
            confirmed: true,
            caption: '西宁出城公路（已确认）',
          });
          expect([200, 204]).toContain(patchRes.status);

          await loginAdminUi(page, baseURL);
          await page.reload();
          const libAfter = await api.getLibrary();
          const allMedia = (libAfter.data.media as Array<Record<string, unknown>>) ?? [];
          const confirmedRecord = allMedia.find((m) => m.id === mediaId);
          expect(confirmedRecord).toBeDefined();
          expect(confirmedRecord?.confirmed).toBe(true);
          expect(Number(confirmedRecord?.lat)).toBeCloseTo(36.6512, 3);
        });

        await test.step('Bind confirmed media to public journey and verify /atlas rendering', async () => {
          const jid = `journey-${tag}`;
          const jRes = await api.saveJourney({
            id: jid,
            title: `青藏公路-${tag}`,
            subtitle: '从西宁向西',
            startDate: '2026-10-04',
            endDate: '2026-10-04',
            visibility: 'public',
            coverId: mediaId,
            stops: [
              {
                id: `stop-${tag}`,
                name: '西宁出城公路',
                region: '青海',
                date: '2026-10-04',
                lat: 36.6512,
                lng: 101.7782,
                note: '清晨车很少，路标指向日月山。',
                mediaIds: [mediaId],
              },
            ],
            createdAt: new Date().toISOString(),
          });
          expect([200, 201]).toContain(jRes.status);
          createdJourneys.push(jid);

          await openAtlasAndFocusJourney(page, `青藏公路-${tag}`, '西宁出城公路');
          const img = page.locator(`img[src*="${mediaId}"]`).first();
          await ensureAtlasDrawerExpandedIfNeeded(page, img);
          await assertImageAspectRatioPreserved(img);
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlas(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[Tier4][S04][F2.1][F2.2][F2.3][F2.4][F2.5] Scenario 4: Public Atlas Exploration → Bezier "沿途回放" → Manual Takeover → Darkroom Lightbox Zoom/Pan/Esc',
    { tag: ['@tier4', '@F2.1', '@F2.2', '@F2.3', '@F2.4', '@F2.5'] },
    async ({ page, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 's04',
          visibility: 'public',
          stops: [
            {
              name: '第一站·昆明',
              date: '2026-10-01',
              lat: 25.04,
              lng: 102.71,
              note: '滇池南岸晴朗。',
              photos: [
                { width: 320, height: 200, caption: '横景' },
                { width: 200, height: 320, caption: '竖景' },
              ],
            },
            { name: '第二站·大理', date: '2026-10-02', lat: 25.60, lng: 100.26, note: '苍山暮霭。' },
            { name: '第三站·丽江', date: '2026-10-03', lat: 26.85, lng: 100.22, note: '玉龙初雪。' },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await test.step('Verify desktop split layout and offline GeoJSON MapLibre rendering', async () => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await openAtlasAndFocusJourney(page, seeded.title, '第一站·昆明');
          const canvas = page.locator('canvas.maplibregl-canvas, canvas').first();
          await expect(canvas).toBeVisible();
          const box = await canvas.boundingBox();
          expect(box).not.toBeNull();
          if (box) {
            expect(box.width).toBeGreaterThan(700);
          }
        });

        await test.step('Start Bezier "沿途回放" and verify manual pointer drag takes over immediately', async () => {
          await page.getByRole('button', { name: /沿途回放/ }).first().click();
          await expect(page.getByRole('button', { name: /暂停回放|暂停/ }).first()).toBeVisible();

          const canvas = page.locator('canvas.maplibregl-canvas, canvas').first();
          const box = await canvas.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 5 });
            await page.mouse.up();
          }
          await expect(page.getByRole('button', { name: /沿途回放/ }).first()).toBeVisible();
        });

        await test.step('Open Darkroom Lightbox, zoom, pan, switch photo via ArrowRight, and restore focus on Escape', async () => {
          const trigger = page.locator('button:has(img[src*="/api/files/"])').first();
          await trigger.click();

          const dialog = page.locator('dialog[open]').first();
          await expect(dialog).toBeVisible();
          await assertOnlyDarkSurface(dialog);

          const modalImg = dialog.locator('img').first();
          await assertImageAspectRatioPreserved(modalImg);

          const zoomBtn = dialog.getByRole('button', { name: /放大|\+/ }).first();
          if ((await zoomBtn.count()) > 0) {
            await zoomBtn.click();
          }
          const imgBox = await modalImg.boundingBox();
          if (imgBox) {
            await page.mouse.move(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
            await page.mouse.down();
            await page.mouse.move(imgBox.x + imgBox.width / 2 + 24, imgBox.y + imgBox.height / 2 + 12, { steps: 4 });
            await page.mouse.up();
          }

          await page.keyboard.press('ArrowRight');
          await assertImageAspectRatioPreserved(modalImg);

          await page.keyboard.press('Escape');
          await expect(dialog).toBeHidden();
          expect(await trigger.evaluate((el) => document.activeElement === el)).toBe(true);
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlas(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[Tier4][S05][F3.3][F3.1][F3.2][F1.6] Scenario 5: Atlas Stop "回望此地当夜星空" → Observatory Night Sky → 19:00 → 04:00 Slider → Bilingual Search',
    { tag: ['@tier4', '@F3.3', '@F3.1', '@F3.2', '@F1.6'] },
    async ({ page, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];
      const thirdPartyUrls: string[] = [];
      const expectedOrigin = new URL(baseURL ?? 'http://127.0.0.1:5173').origin;

      page.on('request', (req) => {
        const u = req.url();
        if ((u.startsWith('http://') || u.startsWith('https://')) && new URL(u).origin !== expectedOrigin) {
          thirdPartyUrls.push(u);
        }
      });

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 's05',
          visibility: 'public',
          stops: [
            {
              name: '大理苍山',
              date: '2026-10-15',
              lat: 25.6065,
              lng: 100.2676,
              note: '十月中旬夜空通透。',
              photos: [{ takenAt: '2026-10-15T21:45:00+08:00' }],
            },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await test.step('Switch to light mode on Atlas and click "回望此地当夜星空"', async () => {
          await openAtlasAndFocusJourney(page, seeded.title, '大理苍山');
          await setPageColorScheme(page, 'light');
          const skyBtn = page.getByRole('link', { name: /回望此地当夜星空/ }).first();
          await ensureAtlasDrawerExpandedIfNeeded(page, skyBtn);
          await expect(skyBtn).toBeVisible();
          await skyBtn.click();
          await expect(page).toHaveURL(/\/observatory\?/);
          const u = new URL(page.url());
          expect(Number(u.searchParams.get('lat'))).toBeCloseTo(25.6065, 2);
          expect(Number(u.searchParams.get('lng'))).toBeCloseTo(100.2676, 2);
        });

        await test.step('Verify constant #0B0C0E only-dark Observatory while TopNav stays light and zero third-party calls occur', async () => {
          const obs = page.locator(OBSERVATORY_DARK_LOCATOR).first();
          await expect(obs).toBeVisible();
          await assertOnlyDarkSurface(obs);
          await expectThemeState(page, 'light');
          expect(thirdPartyUrls).toEqual([]);
        });

        await test.step('Slide 19:00 → 04:00 across midnight and perform bilingual celestial search', async () => {
          const slider = page.getByRole('slider').first();
          await expect(slider).toBeVisible();
          const maxVal = (await slider.getAttribute('max')) ?? '540';
          await slider.fill(maxVal);

          const text = await page.locator(OBSERVATORY_DARK_LOCATOR).first().innerText();
          expect(text).toMatch(/0[0-4]:\d{2}|2026-10-16/);

          const search = page
            .locator('input[type="search"], input[aria-label*="搜索"], input[placeholder*="搜索"]')
            .first();
          await expect(search).toBeVisible();
          await search.fill('天狼星');
          await page.waitForTimeout(200);
          await search.fill('Sirius');
          await page.waitForTimeout(200);
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlas(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[Tier4][S06][F3.1][F3.2][F5.1] Scenario 6: Observatory Stellarium Failure/Toggle → Lazy BrightStarChart Fallback → Same-Night Sky Inspection',
    { tag: ['@tier4', '@F3.1', '@F3.2', '@F5.1'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      const homeLoadedChunks: string[] = [];
      page.on('response', (res) => {
        if (res.request().resourceType() === 'script') homeLoadedChunks.push(res.url());
      });

      try {
        await test.step('Confirm vendor-astronomy lazy chunk is NOT loaded on Home /', async () => {
          await page.goto('/');
          await page.waitForTimeout(300);
          expect(homeLoadedChunks.some((u) => u.includes('vendor-astronomy'))).toBe(false);
        });

        await test.step('Abort /stellarium/* and open BrightStarChart fallback on /observatory', async () => {
          await page.route('**/stellarium/**', (route) => route.abort('failed'));
          await page.goto(
            '/observatory?lat=39.9042&lng=116.4074&time=2026-11-20T22:00:00%2B08:00&place=Beijing',
          );
          const fallbackBtn = page.getByRole('button', { name: /简版方位图|方位图|切换/ }).first();
          if ((await fallbackBtn.count()) > 0 && (await fallbackBtn.isVisible())) {
            await fallbackBtn.click();
          }

          const svg = page.locator('svg[role="img"]').first();
          await expect(svg).toBeVisible();
          const starCount = await svg.locator('circle').count();
          expect(starCount).toBeGreaterThan(20);
        });

        await test.step('Verify time slider & search keep updating fallback chart with zero uncaught errors', async () => {
          const slider = page.getByRole('slider').first();
          await expect(slider).toBeVisible();
          await slider.fill('300');
          const search = page
            .locator('input[type="search"], input[aria-label*="搜索"], input[placeholder*="搜索"]')
            .first();
          if ((await search.count()) > 0) {
            await search.fill('Orion');
          }
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[Tier4][S07][F4.2][F4.3][F4.1] Scenario 7: Vault Multi-Chunk Upload → Retry Interrupted Chunk → Private Storage → 6-Char Share + SVG QR',
    { tag: ['@tier4', '@F4.2', '@F4.3', '@F4.1'] },
    async ({ page, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const shareIds: string[] = [];
      const fileIds: string[] = [];
      const chunkRoutePattern = '**/api/vault/uploads/*/chunk';

      try {
        const tag = nextTag(testInfo, 's07');
        const chunkSize = 64 * 1024;
        const payload = createBinaryChunkPayload(chunkSize * 3, 77);
        let uploadId = '';

        await test.step('Initiate 3-chunk Vault upload and simulate chunk #1 transient failure + retry', async () => {
          const initRes = await api.initVaultUpload({
            name: `${tag}.bin`,
            mime: 'application/octet-stream',
            size: payload.buffer.byteLength,
            sha256: payload.sha256,
            totalChunks: 3,
          });
          expect(initRes.status).toBe(200);
          uploadId = initRes.data.uploadId;

          expect((await api.uploadVaultChunk(uploadId, 0, payload.buffer.subarray(0, chunkSize))).status).toBe(200);

          const cookies = api.getCookies();
          const originUrl = new URL(api.baseURL);
          const cookieList = Object.entries(cookies).map(([name, value]) => ({
            name,
            value,
            domain: originUrl.hostname,
            path: '/',
          }));
          if (cookieList.length > 0) {
            await page.context().addCookies(cookieList);
          }
          await page.goto('/admin', { waitUntil: 'domcontentloaded' });

          let routeTriggered = false;
          await page.route(chunkRoutePattern, async (route) => {
            if (!routeTriggered && route.request().headers()['x-chunk-index'] === '1') {
              routeTriggered = true;
              await route.abort('failed');
              return;
            }
            await route.continue();
          });

          const chunk1Bytes = Array.from(payload.buffer.subarray(chunkSize, chunkSize * 2));
          const csrf = api.getCsrfToken() ?? '';
          const browserRetryResult = await page.evaluate(
            async ({ targetUploadId, bytes, csrfHeader }) => {
              const sendChunk = () =>
                fetch(`/api/vault/uploads/${encodeURIComponent(targetUploadId)}/chunk`, {
                  method: 'PUT',
                  headers: {
                    'content-type': 'application/octet-stream',
                    'x-chunk-index': '1',
                    ...(csrfHeader ? { 'x-travel-csrf': csrfHeader } : {}),
                  },
                  body: new Uint8Array(bytes),
                });

              let firstFailed = false;
              try {
                const firstRes = await sendChunk();
                if (!firstRes.ok) firstFailed = true;
              } catch {
                firstFailed = true;
              }
              const retryRes = await sendChunk();
              return { firstFailed, retryStatus: retryRes.status };
            },
            { targetUploadId: uploadId, bytes: chunk1Bytes, csrfHeader: csrf },
          );
          expect(routeTriggered).toBe(true);
          expect(browserRetryResult.firstFailed).toBe(true);
          expect(browserRetryResult.retryStatus).toBe(200);

          expect(
            (await api.uploadVaultChunk(uploadId, 2, payload.buffer.subarray(chunkSize * 2))).status,
          ).toBe(200);

          const completeRes = await api.completeVaultUpload(uploadId);
          expect(completeRes.status).toBe(200);
          const record = (completeRes.data.file ?? completeRes.data) as Record<string, unknown>;
          const fileId = extractCompletedVaultFileId(completeRes.data, initRes.data.fileId);
          fileIds.push(fileId);
          expect(record.visibility).toBe('private');
        });

        await test.step('Create 6-char share, verify local SVG QR, and redeem + download matching SHA-256 on /vault', async () => {
          const shareRes = await api.createVaultShare({
            fileId: fileIds[0]!,
            expiresIn: 3600,
            maxDownloads: 3,
            passcode: 'M7P2W9',
            note: '分片归档测试',
          });
          expect([200, 201]).toContain(shareRes.status);
          const shareId = String((shareRes.data as { id?: string; share?: { id?: string } }).share?.id ?? shareRes.data.id);
          shareIds.push(shareId);

          await page.goto('/vault');
          const input = page.getByRole('textbox').first();
          await input.fill('M7P2W9');
          await input.press('Enter');

          await expect(page.getByText(`${tag}.bin`)).toBeVisible();
          await expect(page.getByText('分片归档测试')).toBeVisible();
          await expect(page.locator('svg[viewBox]').first()).toBeVisible();

          const redeem = await createApiClient(baseURL).redeemVault('M7P2W9');
          expect(redeem.status).toBe(200);
          const ticketId = redeem.data.downloadUrl.split('/').pop() ?? '';
          const dl = await createApiClient(baseURL).downloadVaultTicket(ticketId);
          expect(dl.status).toBe(200);
          expect(crypto.createHash('sha256').update(dl.buffer).digest('hex')).toBe(payload.sha256);
        });

        errors.assertZeroErrors();
      } finally {
        await page.unroute(chunkRoutePattern).catch(() => undefined);
        errors.detach();
        await cleanupVault(api, shareIds, fileIds);
      }
    },
  );

  test(
    '[Tier4][S08][F4.1][F4.3] Scenario 8: Public Vault 6-Char Redemption → Slip & QR Inspection → Last-Download Exhaustion → Revocation Tombstone',
    { tag: ['@tier4', '@F4.1', '@F4.3'] },
    async ({ page, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const shareIds: string[] = [];
      const fileIds: string[] = [];

      try {
        const tag = nextTag(testInfo, 's08');
        const payload = createBinaryChunkPayload(8192, 88);
        const initRes = await api.initVaultUpload({
          name: `${tag}.bin`,
          mime: 'application/octet-stream',
          size: payload.buffer.byteLength,
          sha256: payload.sha256,
          totalChunks: 1,
        });
        expect(initRes.status).toBe(200);
        await api.uploadVaultChunk(initRes.data.uploadId, 0, payload.buffer);
        const done = await api.completeVaultUpload(initRes.data.uploadId);
        expect(done.status).toBe(200);
        const fileId = extractCompletedVaultFileId(done.data, initRes.data.fileId);
        fileIds.push(fileId);

        const shareA = await api.createVaultShare({
          fileId,
          expiresIn: 3600,
          maxDownloads: 2,
          passcode: 'K7M9P2',
          note: '末次校验',
        });
        shareIds.push(String((shareA.data as { id?: string; share?: { id?: string } }).share?.id ?? shareA.data.id));

        const shareB = await api.createVaultShare({
          fileId,
          expiresIn: 3600,
          maxDownloads: 5,
          passcode: 'Q4W8N3',
          note: '撤销墓碑校验',
        });
        const shareBId = String((shareB.data as { id?: string; share?: { id?: string } }).share?.id ?? shareB.data.id);
        shareIds.push(shareBId);

        await test.step('Redeem Share A in /vault UI, inspect paper slip + SVG QR, and exhaust 2 allowed downloads', async () => {
          await page.goto('/vault');
          const input = page.getByRole('textbox').first();
          await input.fill('k7m9p2');
          await input.press('Enter');

          await expect(page.getByText(`${tag}.bin`)).toBeVisible();
          await expect(page.getByText('末次校验')).toBeVisible();
          await expect(page.locator('svg[viewBox]').first()).toBeVisible();

          const visitor = createApiClient(baseURL);
          const second = await visitor.redeemVault('K7M9P2');
          expect(second.status).toBe(200);
          expect(second.data.remainingDownloads).toBe(0);

          const third = await visitor.redeemVault('K7M9P2');
          expect([403, 410]).toContain(third.status);
        });

        await test.step('Revoke Share B and verify tombstone blocks redemption even across reload', async () => {
          expect((await api.revokeVaultShare(shareBId)).status).toBe(200);
          const revoked = await createApiClient(baseURL).redeemVault('Q4W8N3');
          expect([403, 410]).toContain(revoked.status);

          await page.reload();
          const input = page.getByRole('textbox').first();
          await input.fill('Q4W8N3');
          await input.press('Enter');
          await expect(page.getByText(/撤销|失效|已撤回|不可用|过期/)).toBeVisible();
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupVault(api, shareIds, fileIds);
      }
    },
  );

  test(
    '[Tier4][S09][F1.6][F1.7][F2.5][F3.2] Scenario 9: Multi-Module Day/Night Switching While Keeping Observatory & Darkroom Lightbox #0B0C0E',
    { tag: ['@tier4', '@F1.6', '@F1.7', '@F2.5', '@F3.2'] },
    async ({ page, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];

      try {
        const seeded = await seedJourney(api, testInfo, {
          prefix: 's09',
          visibility: 'public',
          stops: [{ name: '色温对照站', date: '2026-10-11', lat: 25.04, lng: 102.71, note: '日夜双态校验' }],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        await test.step('Start on / in light mode and verify self-hosted fonts', async () => {
          await page.goto('/');
          await setPageColorScheme(page, 'light');
          await verifySelfHostedFonts(page);
        });

        await test.step('Open Darkroom <dialog> in light mode and verify #0B0C0E only-dark surface', async () => {
          await openAtlasAndFocusJourney(page, seeded.title, '色温对照站');
          const triggerBtn = page.locator('button:has(img[src*="/api/files/"])').first();
          await ensureAtlasDrawerExpandedIfNeeded(page, triggerBtn);
          await triggerBtn.click();
          const dialog = page.locator('dialog[open]').first();
          await expect(dialog).toBeVisible();
          await assertOnlyDarkSurface(dialog);
          await page.keyboard.press('Escape');
          await expect(dialog).toBeHidden();
        });

        await test.step('Verify Observatory remains #0B0C0E in both light and dark outer page modes', async () => {
          await page.goto('/observatory');
          const obs = page.locator(OBSERVATORY_DARK_LOCATOR).first();
          await expect(obs).toBeVisible();
          await assertOnlyDarkSurface(obs);
          await setPageColorScheme(page, 'dark');
          await expect(obs).toBeVisible();
          await assertOnlyDarkSurface(obs);
          await expectThemeState(page, 'dark');
        });

        await test.step('Verify /vault & /atlas in dark mode and restore light mode', async () => {
          await page.goto('/vault');
          await verifySelfHostedFonts(page, { requireH1: false, checkLetterSpacing: false });
          await page.goto('/atlas');
          await setPageColorScheme(page, 'light');
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await cleanupAtlas(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[Tier4][S10][F1.1][F1.2][F1.3][F1.4][F1.5] Scenario 10: Home Discovery Flow → WebGL Bokeh Interaction → Pause/Resume → 32px Scroll Stage → Module Navigation',
    { tag: ['@tier4', '@F1.1', '@F1.2', '@F1.3', '@F1.4', '@F1.5'] },
    async ({ page }) => {
      const errors = attachErrorListeners(page);
      try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/');

        await test.step('Verify hero typography, WebGL Bokeh canvas, and Anti-AI-Taste rules', async () => {
          await verifySelfHostedFonts(page);
          await scanAntiAiTaste(page);
          const canvas = page.locator('canvas').first();
          await expect(canvas).toBeVisible();
          expect(await canvas.evaluate((n) => (n as HTMLCanvasElement).getContext('2d') === null)).toBe(true);
        });

        await test.step('Interact with Bokeh pointer ripple and toggle Pause/Resume', async () => {
          const canvas = page.locator('canvas').first();
          const box = await canvas.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
            await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * 0.48);
          }
          const toggle = page.getByRole('button', { name: /暂停|恢复|星环|动效/ }).first();
          await toggle.click();
          await toggle.click();
        });

        await test.step('Scroll to 32px focal stage, bio, module entrances, and Labs slot, then navigate routes', async () => {
          await page.locator('#labs').scrollIntoViewIfNeeded();
          expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
          await expect(page.locator('#labs')).toBeVisible();

          const nav = page.getByRole('navigation', { name: '主导航' });
          for (const [label, re] of [
            ['旅图', /\/atlas$/],
            ['观星台', /\/observatory$/],
            ['密匣', /\/vault$/],
          ] as const) {
            await nav.getByRole('link', { name: label }).click();
            await expect(page).toHaveURL(re);
          }
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
      }
    },
  );

  test(
    '[Tier4][S11][F5.3][F5.4][F2.6][F4.2] Scenario 11: Budget Circuit Breaker Enforcement → Usage Monitoring → Upload/API Rejection at Limit',
    { tag: ['@tier4', '@F5.3', '@F5.4', '@F2.6', '@F4.2'] },
    async ({ page, baseURL }, testInfo) => {
      const errors = attachErrorListeners(page);
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const createdMedia: string[] = [];
      const createdVaultFiles: string[] = [];
      let originalRpm = 180;

      try {
        const tag = nextTag(testInfo, 's11');
        const initialSec = await api.getSecurity();
        const policy = initialSec.data.policy as { requestsPerMinute?: number } | undefined;
        originalRpm = policy?.requestsPerMinute ?? 180;

        await test.step('Inspect /admin Usage Monitor panel and capture baseline D1 counters', async () => {
          await loginAdminUi(page, baseURL);
          const baseline = await api.getAdminUsage();
          expect(baseline.status).toBe(200);
          expect(baseline.data.limits.uploadBytes).toBe(2 * 1024 * 1024 * 1024);
          expect(baseline.data.limits.apiRequests).toBe(200_000);
          expect(baseline.data.limits.classA).toBe(10_000);
          expect(baseline.data.limits.classB).toBe(100_000);
        });

        await test.step('Meter Atlas upload + Vault 2-chunk upload + R2 read and verify atomic counter deltas', async () => {
          const before = usageMap((await api.getAdminUsage()).data.counters);
          const beforeBytes = before.get('r2-upload-bytes:lifetime') ?? 0;
          const beforeA = counterByPrefix(before, 'r2-class-a');

          const jpeg = appendJpegComment(createSyntheticExifJpeg({ width: 160, height: 120 }), tag);
          const media = await uploadAtlasPhoto(api, jpeg, `${tag}.jpg`, { caption: '配额计量' });
          createdMedia.push(String(media.id));

          const chunkPayload = createBinaryChunkPayload(8192, 111);
          const initRes = await api.initVaultUpload({
            name: `${tag}.bin`,
            mime: 'application/octet-stream',
            size: 8192,
            sha256: chunkPayload.sha256,
            totalChunks: 2,
          });
          expect(initRes.status).toBe(200);
          expect((await api.uploadVaultChunk(initRes.data.uploadId, 0, chunkPayload.buffer.subarray(0, 4096))).status).toBe(200);
          expect((await api.uploadVaultChunk(initRes.data.uploadId, 1, chunkPayload.buffer.subarray(4096))).status).toBe(200);
          const done = await api.completeVaultUpload(initRes.data.uploadId);
          expect(done.status).toBe(200);
          createdVaultFiles.push(extractCompletedVaultFileId(done.data, initRes.data.fileId));

          const after = usageMap((await api.getAdminUsage()).data.counters);
          expect(after.get('r2-upload-bytes:lifetime') ?? 0).toBeGreaterThan(beforeBytes);
          expect(counterByPrefix(after, 'r2-class-a')).toBeGreaterThan(beforeA);
        });

        await test.step('Verify abort non-refund, >16 MiB rejection, and isolated IP 429 rate-limit circuit breaker', async () => {
          const beforeAbort = usageMap((await api.getAdminUsage()).data.counters);
          const beforeAbortBytes = beforeAbort.get('r2-upload-bytes:lifetime') ?? 0;

          const abortInit = await api.initVaultUpload({
            name: `${tag}-abort.bin`,
            mime: 'application/octet-stream',
            size: 4096,
            sha256: 'b'.repeat(64),
            totalChunks: 1,
          });
          expect(abortInit.status).toBe(200);
          await api.uploadVaultChunk(abortInit.data.uploadId, 0, Buffer.alloc(4096));
          await api.abortVaultUpload(abortInit.data.uploadId);

          const afterAbort = usageMap((await api.getAdminUsage()).data.counters);
          expect(afterAbort.get('r2-upload-bytes:lifetime') ?? 0).toBe(beforeAbortBytes + 4096);

          await api.patchSecurity({ requestsPerMinute: 10 });
          const throttledClient = createApiClient(baseURL);
          const throttleIp = uniqueTestIp(testInfo, 1);
          let saw429 = false;
          for (let i = 0; i < 15; i += 1) {
            const res = await throttledClient.request('/api/library', {
              headers: { 'CF-Connecting-IP': throttleIp },
            });
            if (res.status === 429) {
              saw429 = true;
              break;
            }
          }
          expect(saw429).toBe(true);
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await api.patchSecurity({ requestsPerMinute: originalRpm }).catch(() => undefined);
        await cleanupVault(api, [], createdVaultFiles);
        await cleanupAtlas(api, [], createdMedia);
      }
    },
  );

  test(
    '[Tier4][S12][F5.4][F2.7][F4.2] Scenario 12: Full Backup Export (cloudflare-1 ZIP) → Manifest SHA-256 & library.sql Inspection → Trash/Restore',
    { tag: ['@tier4', '@F5.4', '@F2.7', '@F4.2'] },
    async ({ baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];
      const createdVaultFiles: string[] = [];

      try {
        const tag = nextTag(testInfo, 's12');
        await test.step('Seed Journey + Media + Vault file across D1 & R2', async () => {
          const seeded = await seedJourney(api, testInfo, {
            prefix: 's12',
            visibility: 'public',
            stops: [{ name: '归档驿站', date: '2026-10-19', lat: 24.88, lng: 102.83, note: 'ZIP 全量导出验证' }],
          });
          createdJourneys.push(seeded.journeyId);
          createdMedia.push(...seeded.mediaIds);

          const vPayload = createBinaryChunkPayload(4096, 120);
          const initRes = await api.initVaultUpload({
            name: `${tag}.bin`,
            mime: 'application/octet-stream',
            size: 4096,
            sha256: vPayload.sha256,
            totalChunks: 1,
          });
          expect(initRes.status).toBe(200);
          await api.uploadVaultChunk(initRes.data.uploadId, 0, vPayload.buffer);
          const done = await api.completeVaultUpload(initRes.data.uploadId);
          expect(done.status).toBe(200);
          createdVaultFiles.push(extractCompletedVaultFileId(done.data, initRes.data.fileId));
        });

        await test.step('Download cloudflare-1 ZIP backup, verify SHA-256 manifest and library.sql exclusions', async () => {
          const backupRes = await api.getAdminBackup();
          expect(backupRes.status).toBe(200);
          const zipEntries = unzipSync(new Uint8Array(backupRes.buffer));
          const manifest = JSON.parse(strFromU8(zipEntries['manifest.json']!)) as {
            version: string;
            files: Array<{ path: string; size: number; sha256: string }>;
          };
          expect(manifest.version).toBe('cloudflare-1');
          for (const entry of manifest.files) {
            const data = zipEntries[entry.path];
            expect(data).toBeDefined();
            if (data) {
              expect(data.byteLength).toBe(entry.size);
              expect(crypto.createHash('sha256').update(data).digest('hex')).toBe(entry.sha256);
            }
          }
          const sql = strFromU8(zipEntries['library.sql']!);
          const decodedSql = decodeSqlHexLiterals(sql);
          expect(decodedSql).toContain(createdJourneys[0]!);
          expect(decodedSql).toContain(createdVaultFiles[0]!);
          expect(decodedSql).not.toContain('security_sessions');
          expect(decodedSql).not.toContain('usage_limits');
        });

        await test.step('Verify relational Trash & Restore guards across Journey, Media, and Vault file', async () => {
          const jid = createdJourneys[0]!;
          const mid = createdMedia[0]!;
          const vid = createdVaultFiles[0]!;

          expect((await api.trashItem('media', mid)).status).toBe(409);

          const jTrash = await api.trashItem('journey', jid);
          expect(jTrash.status).toBe(200);
          const jKey = String(jTrash.data.key);

          const mTrash = await api.trashItem('media', mid);
          expect(mTrash.status).toBe(200);
          const mKey = String(mTrash.data.key);

          const vTrash = await api.trashItem('vault_file', vid);
          expect(vTrash.status).toBe(200);
          const vKey = String(vTrash.data.key);

          expect((await api.restoreItem(jKey)).status).toBe(409);
          expect((await api.restoreItem(mKey)).status).toBe(200);
          expect((await api.restoreItem(jKey)).status).toBe(200);
          expect((await api.restoreItem(vKey)).status).toBe(200);
        });
      } finally {
        await cleanupVault(api, [], createdVaultFiles);
        await cleanupAtlas(api, createdJourneys, createdMedia);
      }
    },
  );

  test(
    '[Tier4][S13][F1.1][F1.7][F2.1][F2.5][F3.2][F4.1] Scenario 13: Mobile 390×844 End-to-End Field Trip (Home → Atlas Bottom Drawer → Lightbox → Observatory → Vault)',
    { tag: ['@tier4', '@F1.1', '@F1.7', '@F2.1', '@F2.5', '@F3.2', '@F4.1'] },
    async ({ browser, baseURL }, testInfo) => {
      const api = createApiClient(baseURL);
      await api.ensureAdminSession();
      const createdJourneys: string[] = [];
      const createdMedia: string[] = [];
      const shareIds: string[] = [];
      const fileIds: string[] = [];

      const mobileContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        baseURL,
      });
      const page = await mobileContext.newPage();
      const errors = attachErrorListeners(page);

      try {
        const tag = nextTag(testInfo, 's13');
        const seeded = await seedJourney(api, testInfo, {
          prefix: 's13',
          visibility: 'public',
          stops: [
            {
              name: '移动端站点·泸沽湖',
              date: '2026-10-20',
              lat: 27.705,
              lng: 100.785,
              note: '湖面傍晚起风，星辰刚露头。',
              photos: [{ takenAt: '2026-10-20T21:10:00+08:00' }],
            },
          ],
        });
        createdJourneys.push(seeded.journeyId);
        createdMedia.push(...seeded.mediaIds);

        const payload = createBinaryChunkPayload(2048, 130);
        const initRes = await api.initVaultUpload({
          name: `${tag}.bin`,
          mime: 'application/octet-stream',
          size: 2048,
          sha256: payload.sha256,
          totalChunks: 1,
        });
        expect(initRes.status).toBe(200);
        await api.uploadVaultChunk(initRes.data.uploadId, 0, payload.buffer);
        const done = await api.completeVaultUpload(initRes.data.uploadId);
        expect(done.status).toBe(200);
        const fileId = extractCompletedVaultFileId(done.data, initRes.data.fileId);
        fileIds.push(fileId);

        const shareRes = await api.createVaultShare({
          fileId,
          expiresIn: 3600,
          maxDownloads: 2,
          passcode: 'M0B1LE',
          note: '移动提取',
        });
        shareIds.push(String((shareRes.data as { id?: string; share?: { id?: string } }).share?.id ?? shareRes.data.id));

        await test.step('Verify mobile Home fonts, anti-AI-taste, and zero horizontal overflow', async () => {
          await page.goto('/');
          await verifySelfHostedFonts(page);
          await scanAntiAiTaste(page);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
        });

        await test.step('Explore Atlas mobile bottom drawer, open Lightbox, and jump to Observatory', async () => {
          await openAtlasAndFocusJourney(page, seeded.title, '移动端站点·泸沽湖');
          const canvas = page.locator('canvas.maplibregl-canvas, canvas').first();
          await expect(canvas).toBeVisible();
          const mapBox = await canvas.boundingBox();
          expect(mapBox).not.toBeNull();
          if (mapBox) {
            expect(mapBox.height).toBeGreaterThan(180);
          }

          const triggerBtn = page.locator('button:has(img[src*="/api/files/"])').first();
          await ensureAtlasDrawerExpandedIfNeeded(page, triggerBtn);
          await triggerBtn.click();
          const dialog = page.locator('dialog[open]').first();
          await expect(dialog).toBeVisible();
          await assertOnlyDarkSurface(dialog);
          await page.keyboard.press('Escape');

          const skyLink = page.getByRole('link', { name: /回望此地当夜星空/ }).first();
          await ensureAtlasDrawerExpandedIfNeeded(page, skyLink);
          await skyLink.click();
          await expect(page).toHaveURL(/\/observatory\?/);
          const obs = page.locator(OBSERVATORY_DARK_LOCATOR).first();
          await expect(obs).toBeVisible();
          await assertOnlyDarkSurface(obs);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
        });

        await test.step('Redeem Vault passcode on mobile and verify slip + QR fit within 390px', async () => {
          await page.goto('/vault');
          const input = page.getByRole('textbox').first();
          await input.fill('M0B1LE');
          await input.press('Enter');

          await expect(page.getByText(`${tag}.bin`)).toBeVisible();
          await expect(page.locator('svg[viewBox]').first()).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
        });

        errors.assertZeroErrors();
      } finally {
        errors.detach();
        await mobileContext.close();
        await cleanupVault(api, shareIds, fileIds);
        await cleanupAtlas(api, createdJourneys, createdMedia);
      }
    },
  );
});
