import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createExiflessJpeg } from '../fixtures/exif-jpeg';
import { createApiClient } from '../helpers/api-client';
import { assertOnlyDarkSurface, attachErrorListeners } from '../helpers/browser-checks';

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

async function getPageBackgroundLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const parseRgb = (css: string): [number, number, number] | null => {
      const m = css.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?/i);
      if (!m) return null;
      const alpha = m[4] !== undefined ? Number(m[4]) : 1;
      if (alpha === 0) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    };
    const bodyRgb = parseRgb(getComputedStyle(document.body).backgroundColor);
    const htmlRgb = parseRgb(getComputedStyle(document.documentElement).backgroundColor);
    const rgb = bodyRgb ?? htmlRgb ?? [255, 255, 255];
    const toLin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLin(rgb[0]) + 0.7152 * toLin(rgb[1]) + 0.0722 * toLin(rgb[2]);
  });
}

function getObservationTimeSlider(page: Page): Locator {
  return page
    .getByRole('slider', { name: /时刻|观测时间|时间|19:00|夜/ })
    .or(page.locator('input[type="range"]'))
    .first();
}

async function setObservationTimeSliderFraction(slider: Locator, fraction: number): Promise<void> {
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

// ===========================================================================
// F3.1 — Stellarium Fault Degradation, Firewall, Spoofing & Lifecycle (5 Tests)
// ===========================================================================
test.describe('Tier 2 — Observatory F3.1: Fault Degradation & Bridge Security', () => {
  test('T2-F3.1-01 WASM fetch failure degrades calmly to BrightStarChart (E10)', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await page.route('**/stellarium/vendor/stellarium-web-engine.wasm*', async (route) => {
      await route.fulfill({ status: 500, body: 'WASM unavailable' });
    });

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      const alertBox = page.locator('[role="alert"]').first();
      await expect(alertBox).toBeVisible({ timeout: 20_000 });
      const alertText = (await alertBox.innerText()).trim();
      expect(alertText).toMatch(/\p{Script=Han}{4,}/u);
      expect(alertText).toMatch(/星图|加载|方位图|稍后|重试/);
      expect(alertText).not.toMatch(/TypeError|ReferenceError|WASM unavailable|HTTP 500/i);
      await expect(page.getByRole('button', { name: /重新加载星图/ }).first()).toBeVisible();

      const fallbackBtn = page.getByRole('button', { name: /查看简版方位图|简版星图/ }).first();
      await expect(fallbackBtn).toBeVisible();
      await fallbackBtn.click();

      const svg = page.locator('svg[role="img"][aria-label*="亮星"], svg[viewBox="0 0 640 640"]').first();
      await expect(svg).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => svg.locator('circle').count(), { timeout: 10_000 }).toBeGreaterThan(100);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.1-02 star-tile failure error recovery & retry ("重新加载星图") restores ready state', async ({ page }) => {
    test.setTimeout(75_000);
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);
    let blockTiles = true;

    await page.route('**/stellarium/data/stars/Norder0/**', async (route) => {
      if (blockTiles) {
        await route.fulfill({ status: 404, body: 'Not Found' });
        return;
      }
      await route.continue();
    });

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      const retryBtn = page.getByRole('button', { name: /重新加载星图/ }).first();
      await expect(retryBtn).toBeVisible({ timeout: 40_000 });
      const prevSession = await getActiveSkySession(page);

      blockTiles = false;
      await retryBtn.click();
      await expect
        .poll(
          async () => {
            const cur = await getActiveSkySession(page);
            return Boolean(cur) && (!prevSession || cur !== prevSession);
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await waitForStellariumReady(page);
      expect(errors.pageErrors).toEqual([]);
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.1-03 strict firewall: zero third-party network requests across Stellarium & BrightStarChart', async ({ page }) => {
    const errors = attachErrorListeners(page);
    const blockedThirdParty: string[] = [];
    await installSkyBridgeSpy(page);

    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/i, async (route) => {
      blockedThirdParty.push(route.request().url());
      await route.abort('failed');
    });

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      const searchInput = page.getByRole('textbox', { name: /搜索天体/ }).or(page.getByPlaceholder(/找一颗星|搜索天体/)).first();
      await searchInput.fill('织女一');
      await page.getByRole('button', { name: /星座线/ }).first().click();

      const slider = getObservationTimeSlider(page);
      await setObservationTimeSliderFraction(slider, 0.5);

      await page.getByRole('button', { name: /简版方位图|简版星图|亮星图/ }).first().click();
      await expect(page.locator('svg[viewBox="0 0 640 640"]').first()).toBeVisible({ timeout: 15_000 });

      expect(blockedThirdParty).toEqual([]);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.1-04 postMessage spoofing (wrong session & forged fatal error) is rejected', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="/stellarium/"]') as HTMLIFrameElement | null;
        iframe?.contentWindow?.postMessage(
          {
            source: 'travel-sky-host',
            session: 'forged-wrong-session-id',
            command: 'view',
            payload: { yaw: 10, pitch: 10, fov: 12 },
          },
          window.location.origin,
        );

        window.postMessage(
          {
            source: 'travel-sky-engine',
            session: 'forged-wrong-session-id',
            type: 'error',
            fatal: true,
            error: { code: 'forged', message: 'Forged fatal error' },
          },
          window.location.origin,
        );
      });

      await page.waitForTimeout(400);
      const st = await getLatestSkyState(page);
      expect(Math.round(Number(st?.fov ?? 85))).not.toBe(12);
      await expect(page.getByText('Forged fatal error')).toHaveCount(0);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.1-05 tab hidden (visibilitychange) pauses RAF loop and route leave unmounts iframe', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      const activeSession = await waitForStellariumReady(page);
      expect((await getLatestSkyState(page))?.paused).toBe(false);

      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect
        .poll(async () => (await getLatestSkyState(page))?.paused, { timeout: 5_000 })
        .toBe(true);

      const pausedEventCount = (await getSkyEvents(page)).filter(
        (ev) => ev.session === activeSession && ev.type === 'state',
      ).length;
      await page.waitForTimeout(300);
      const afterPauseWaitCount = (await getSkyEvents(page)).filter(
        (ev) => ev.session === activeSession && ev.type === 'state',
      ).length;
      expect(afterPauseWaitCount).toBe(pausedEventCount);

      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect
        .poll(async () => (await getLatestSkyState(page))?.paused, { timeout: 5_000 })
        .toBe(false);

      const vaultLink = page.getByRole('link', { name: /密匣|Vault/i }).first();
      await expect(vaultLink).toBeVisible();
      await vaultLink.click();
      await expect(page).toHaveURL(/\/vault/);
      await expect.poll(() => page.frames().length, { timeout: 5_000 }).toBe(1);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });
});

// ===========================================================================
// F3.2 — Light Mode #0B0C0E, Midnight Rollover, BVA Coords & Search (6 Tests)
// ===========================================================================
test.describe('Tier 2 — Observatory F3.2: Theme Isolation, Time Slider & Validation', () => {
  test('T2-F3.2-01 #0B0C0E only-dark invariance in Light Mode across Stellarium & BrightStarChart (E4)', async ({ page }) => {
    const errors = attachErrorListeners(page);

    try {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });

      // Ensure outer document surface is genuinely in Light Mode (luminance > 0.5)
      if ((await getPageBackgroundLuminance(page)) <= 0.5) {
        const themeBtn = page.getByRole('button', { name: /浅色|深色|昼|夜|主题|外观|模式/ }).first();
        await expect(themeBtn).toBeVisible();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if ((await getPageBackgroundLuminance(page)) > 0.5) break;
          await themeBtn.click();
          await page.waitForTimeout(200);
        }
      }
      await expect.poll(() => getPageBackgroundLuminance(page), { timeout: 5_000 }).toBeGreaterThan(0.5);

      const darkStellarium = await assertOnlyDarkSurface(page, 'rgb(11, 12, 14)');
      expect(darkStellarium.backgroundColor).toBe('rgb(11, 12, 14)');

      await page.getByRole('button', { name: /简版方位图|简版星图|亮星图/ }).first().click();
      await expect(page.locator('svg[viewBox="0 0 640 640"]').first()).toBeVisible({ timeout: 15_000 });
      const darkBright = await assertOnlyDarkSurface(page, 'rgb(11, 12, 14)');
      expect(darkBright.backgroundColor).toBe('rgb(11, 12, 14)');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.2-02 time slider midnight rollover (23:55 -> 00:15 advances +1 day, and reverse) (E11)', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto(
        '/observatory?lat=39.9042&lng=116.4074&time=2026-10-15T23:55:00%2B08:00&place=Beijing',
        { waitUntil: 'domcontentloaded' },
      );
      await waitForStellariumReady(page);

      const slider = getObservationTimeSlider(page);
      await expect(slider).toBeVisible();

      // Slide past midnight to 00:15 (315 / 540)
      await setObservationTimeSliderFraction(slider, 315 / 540);
      await expect(page.locator('body')).toContainText(/2026[-./]10[-./]16/);
      await expect(page.locator('body')).toContainText('00:15');
      await pollSkyDateNear(page, '2026-10-16T00:15:00+08:00');

      // Slide back before midnight to 23:30 (270 / 540)
      await setObservationTimeSliderFraction(slider, 270 / 540);
      await expect(page.locator('body')).toContainText(/2026[-./]10[-./]15/);
      await expect(page.locator('body')).toContainText('23:30');
      await pollSkyDateNear(page, '2026-10-15T23:30:00+08:00');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.2-03 time slider exact endpoint boundaries (19:00 min & 04:00 max = +9h)', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto(
        '/observatory?lat=39.9042&lng=116.4074&time=2026-10-15T21:30:00%2B08:00&place=Beijing',
        { waitUntil: 'domcontentloaded' },
      );
      await waitForStellariumReady(page);

      const slider = getObservationTimeSlider(page);
      await setObservationTimeSliderFraction(slider, 0);
      await expect(page.locator('body')).toContainText('19:00');
      const tMin = await pollSkyDateNear(page, '2026-10-15T19:00:00+08:00');

      await setObservationTimeSliderFraction(slider, 1);
      await expect(page.locator('body')).toContainText('04:00');
      const tMax = await pollSkyDateNear(page, '2026-10-16T04:00:00+08:00');

      const diffMs = tMax - tMin;
      expect(Math.abs(diffMs - 9 * 3600 * 1000)).toBeLessThan(120_000);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.2-04 invalid lat/lng BVA (+/-90.0001, +/-180.0001, empty) rejected vs valid poles (-90, -180)/(90, 180)', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      const coordToggle = page.getByRole('button', { name: /位置|坐标|设置位置/ }).first();
      if (await coordToggle.isVisible().catch(() => false)) {
        const latVisible = await page.getByLabel(/观测纬度|纬度/).first().isVisible().catch(() => false);
        if (!latVisible) await coordToggle.click();
      }

      const latInput = page.getByLabel(/观测纬度|纬度/).first();
      const lngInput = page.getByLabel(/观测经度|经度/).first();
      const applyBtn = page.getByRole('button', { name: /应用坐标|确定|应用/ }).first();
      const errorNotice = page
        .locator('[role="alert"], [role="status"]')
        .filter({ hasText: /有效|范围|超出|无效|格式|-90|180|请/ })
        .first();

      for (const [badLat, badLng] of [
        ['95', '116'],
        ['-95', '0'],
        ['39.9', '185'],
        ['90.0001', '116'],
        ['-90.5', '0'],
        ['39.9', '180.0001'],
        ['39.9', '-180.5'],
        ['', '116'],
      ]) {
        await latInput.fill(badLat!);
        await lngInput.fill(badLng!);
        await applyBtn.click();
        await expect(errorNotice).toBeVisible({ timeout: 5_000 });
        await expect
          .poll(async () => {
            const st = await getLatestSkyState(page);
            return (
              Math.abs(Number(st?.lat ?? 0) - 39.9042) < 0.05 &&
              Math.abs(Number(st?.lng ?? 0) - 116.4074) < 0.05
            );
          })
          .toBe(true);
      }

      // Exact valid boundary (-90, -180) and (90, 180)
      await latInput.fill('-90');
      await lngInput.fill('-180');
      await applyBtn.click();
      await expect
        .poll(
          async () => {
            const st = await getLatestSkyState(page);
            return Math.round(Number(st?.lat ?? 0)) === -90 && Math.round(Number(st?.lng ?? 0)) === -180;
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      await latInput.fill('90');
      await lngInput.fill('180');
      await applyBtn.click();
      await expect
        .poll(
          async () => {
            const st = await getLatestSkyState(page);
            return Math.round(Number(st?.lat ?? 0)) === 90 && Math.round(Number(st?.lng ?? 0)) === 180;
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      // Verify BrightStarChart mode also validates invalid coordinates cleanly
      await page.getByRole('button', { name: /简版方位图|简版星图|亮星图/ }).first().click();
      await expect(page.locator('svg[viewBox="0 0 640 640"]').first()).toBeVisible({ timeout: 15_000 });
      if (await coordToggle.isVisible().catch(() => false)) {
        const latVisible = await page.getByLabel(/观测纬度|纬度/).first().isVisible().catch(() => false);
        if (!latVisible) await coordToggle.click();
      }
      for (const [badLat, badLng] of [
        ['95', '116'],
        ['39.9', '185'],
      ]) {
        await page.getByLabel(/观测纬度|纬度/).first().fill(badLat!);
        await page.getByLabel(/观测经度|经度/).first().fill(badLng!);
        await page.getByRole('button', { name: /应用坐标|确定|应用/ }).first().click();
        await expect(errorNotice).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('body')).not.toContainText(new RegExp(`${badLat}°\\s*[NS]|${badLng}°\\s*[EW]`));
      }

      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.2-05 search corner cases: nonexistent HIP, CN aliases (水瓶座/射手座) & Escape precedence', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto('/observatory', { waitUntil: 'domcontentloaded' });
      await waitForStellariumReady(page);

      const searchInput = page.getByRole('textbox', { name: /搜索天体/ }).or(page.getByPlaceholder(/找一颗星|搜索天体/)).first();
      const dropdown = page.locator('[role="listbox"], [role="list"]').first();

      // Alias search: 水瓶座 -> 宝瓶座
      await searchInput.click();
      await searchInput.fill('水瓶座');
      await expect(dropdown).toBeVisible({ timeout: 5_000 });
      await expect(dropdown).toContainText(/宝瓶座|Aquarius/i);

      // Escape closes dropdown cleanly without breaking viewer
      await page.keyboard.press('Escape');
      await expect(dropdown).toBeHidden({ timeout: 3_000 });
      await expect(page.locator('iframe[src*="/stellarium/"]').first()).toBeVisible();

      // Alias search: 射手座 -> 人马座
      await searchInput.click();
      await searchInput.fill('射手座');
      await expect(dropdown).toBeVisible({ timeout: 5_000 });
      await expect(dropdown).toContainText(/人马座|Sagittarius/i);

      // Nonexistent query shows calm empty hint in dropdown/status container (not generic body)
      await searchInput.click();
      await searchInput.fill('不存在的星体XYZ');
      await expect(
        page.locator('[role="listbox"], [role="list"], [role="status"], [role="alert"]').first(),
      ).toContainText(/未找到|没有找到|没有匹配|无匹配/);

      // Raw nonexistent HIP ID emits status notice without changing selected target or crashing
      const prevSelected = (await getLatestSkyState(page))?.selected ?? null;
      await searchInput.fill('HIP 999999999');
      await searchInput.press('Enter');
      await expect(
        page.locator('[role="status"], [role="alert"]').filter({ hasText: /没有找到|未找到|没有匹配/ }).first(),
      ).toBeVisible({ timeout: 5_000 });
      const afterSelected = (await getLatestSkyState(page))?.selected ?? null;
      expect(JSON.stringify(afterSelected)).not.toContain('999999999');
      expect(afterSelected).toEqual(prevSelected);
      await expect(page.locator('iframe[src*="/stellarium/"]').first()).toBeVisible();
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.2-06 below-horizon target warning ("地平线下") & fov/pitch clamping', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      // 01:00 local midnight in Beijing -> Sun is deep below the horizon
      await page.goto(
        '/observatory?lat=39.9042&lng=116.4074&time=2026-10-15T01:00:00%2B08:00&place=Beijing',
        { waitUntil: 'domcontentloaded' },
      );
      await waitForStellariumReady(page);

      const searchInput = page.getByRole('textbox', { name: /搜索天体/ }).or(page.getByPlaceholder(/找一颗星|搜索天体/)).first();
      await searchInput.fill('太阳');
      const sunBtn = page
        .locator('[role="listbox"] [role="option"], [role="list"] button, aside button')
        .filter({ hasText: /太阳|Sun/i })
        .first();
      await sunBtn.click();

      const panel = page.locator('[aria-live="polite"]').first();
      await expect(panel).toContainText(/地平线下/);

      // Repeated zoom out should clamp FOV <= 150
      const zoomOut = page.getByRole('button', { name: /缩小星图|缩小/ }).first();
      for (let i = 0; i < 10; i += 1) {
        await zoomOut.click();
      }
      await page.waitForTimeout(300);
      const st = await getLatestSkyState(page);
      expect(Number(st?.fov ?? 85)).toBeLessThanOrEqual(150);
      expect(Number(st?.fov ?? 85)).toBeGreaterThanOrEqual(2);
      expect(Number(st?.pitch ?? 0)).toBeGreaterThanOrEqual(-89);
      expect(Number(st?.pitch ?? 0)).toBeLessThanOrEqual(89);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });
});

// ===========================================================================
// F3.3 — Spacetime Link Validation, Unlocated Stop Guard & Leap Rollover (5 Tests)
// ===========================================================================
test.describe('Tier 2 — Observatory F3.3: Spacetime URL & Unlocated Stop Guards', () => {
  test('T2-F3.3-01 malformed/out-of-range URL lat/lng falls back to Beijing (39.9042, 116.4074)', async ({ page }) => {
    const errors = attachErrorListeners(page);

    try {
      for (const badUrl of [
        '/observatory?lat=95&lng=120',
        '/observatory?lat=abc&lng=xyz',
        '/observatory?lat=30',
        '/observatory?lat=NaN&lng=Infinity',
      ]) {
        await page.goto(badUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toContainText(/39\.9042/);
        await expect(page.locator('body')).toContainText(/116\.4074/);
      }
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.3-02 invalid URL time fallback & XSS-safe place rendering', async ({ page }) => {
    const errors = attachErrorListeners(page);
    let dialogFired = false;
    page.on('dialog', async (d) => {
      dialogFired = true;
      await d.dismiss();
    });

    try {
      await page.goto(
        '/observatory?lat=31.23&lng=121.47&time=invalid-iso&place=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%20%E9%9D%92%E6%B5%B7%E6%B9%96',
        { waitUntil: 'domcontentloaded' },
      );
      await expect(page.locator('body')).toContainText('青海湖');
      await expect(page.locator('body')).toContainText(/31\.23/);
      await expect(page.locator('body')).not.toContainText('Invalid Date');
      expect(dialogFired).toBe(false);
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });

  test('T2-F3.3-03 unlocated Atlas stop (lat: null, lng: null) guards "回望此地当夜星空"', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't2-f33-03');
    const buf = appendJpegComment(createExiflessJpeg(200, 150), tag);
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), `${tag}.jpg`);
    const mRes = await api.uploadMedia(form);
    const media = (mRes.data as { media?: Array<Record<string, unknown>> }).media?.[0];
    const mediaId = String(media?.id ?? '');
    expect(mediaId).toBeTruthy();

    await page.route('**/api/library', async (route) => {
      const resp = await route.fetch();
      const json = (await resp.json()) as {
        journeys: Array<Record<string, unknown>>;
        media: Array<Record<string, unknown>>;
      };
      json.journeys.unshift({
        id: `unlocated-${tag}`,
        title: `未定位拦截-${tag}`,
        subtitle: '无坐标阻断',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        visibility: 'public',
        coverId: mediaId,
        stops: [
          {
            id: `stop-${tag}`,
            name: '待确认站',
            region: '未知',
            date: '2026-10-01',
            lat: null,
            lng: null,
            note: '缺少经纬度。',
            mediaIds: [mediaId],
          },
        ],
      });
      if (media) json.media.push(media);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
    });

    try {
      await openAtlasAndSelectJourney(page, `未定位拦截-${tag}`, '待确认站');
      const card = page.locator('article, section').filter({ hasText: '待确认站' }).first();
      await expect(card).toBeVisible();

      const badLinks = page.locator('a[href*="/observatory"]');
      const badLinkCount = await badLinks.count();
      for (let i = 0; i < badLinkCount; i += 1) {
        const href = await badLinks.nth(i).getAttribute('href');
        expect(href).not.toMatch(/(?:lat|lng)=(?:null|NaN|undefined)/i);
      }

      const skyAction = card
        .getByRole('link', { name: /回望此地当夜星空|查看当夜星空/ })
        .or(card.getByRole('button', { name: /回望此地当夜星空|查看当夜星空/ }));

      const count = await skyAction.count();
      if (count === 0) {
        await expect(card.getByText(/回望此地当夜星空|查看当夜星空/)).toHaveCount(0);
      } else {
        const firstAction = skyAction.first();
        const tagName = await firstAction.evaluate((el) => el.tagName);
        const isDisabled = await firstAction.isDisabled().catch(() => false);
        const ariaDisabled = await firstAction.getAttribute('aria-disabled');
        if (tagName === 'A') {
          const href = await firstAction.getAttribute('href');
          expect(isDisabled || ariaDisabled === 'true' || !href).toBe(true);
        } else if (!isDisabled && ariaDisabled !== 'true') {
          await firstAction.click();
          expect(page.url()).toMatch(/\/atlas/);
          expect(page.url()).not.toMatch(/\/observatory/);
          await expect(card.locator('[role="status"], [role="alert"]').first()).toBeVisible({ timeout: 5_000 });
        } else {
          expect(isDisabled || ariaDisabled === 'true').toBe(true);
        }
      }
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await api.trashItem('media', mediaId);
    }
  });

  test('T2-F3.3-04 partial/corrupt stop coordinates (lat: 25.6, lng: null) guarded on Atlas', async ({ page }, testInfo) => {
    const errors = attachErrorListeners(page);
    const api = createApiClient();
    await api.ensureAdminSession();
    const tag = nextTag(testInfo, 't2-f33-04');
    const buf = appendJpegComment(createExiflessJpeg(200, 150), tag);
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), `${tag}.jpg`);
    const mRes = await api.uploadMedia(form);
    const media = (mRes.data as { media?: Array<Record<string, unknown>> }).media?.[0];
    const mediaId = String(media?.id ?? '');
    expect(mediaId).toBeTruthy();

    await page.route('**/api/library', async (route) => {
      const resp = await route.fetch();
      const json = (await resp.json()) as {
        journeys: Array<Record<string, unknown>>;
        media: Array<Record<string, unknown>>;
      };
      json.journeys.unshift({
        id: `partial-${tag}`,
        title: `残缺坐标-${tag}`,
        subtitle: '单轴缺失',
        startDate: '2026-10-01',
        endDate: '2026-10-01',
        visibility: 'public',
        coverId: mediaId,
        stops: [
          {
            id: `stop-${tag}`,
            name: '缺经度站',
            region: '未知',
            date: '2026-10-01',
            lat: 25.6,
            lng: null,
            note: '经度残缺。',
            mediaIds: [mediaId],
          },
        ],
      });
      if (media) json.media.push(media);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
    });

    try {
      await openAtlasAndSelectJourney(page, `残缺坐标-${tag}`, '缺经度站');
      const card = page.locator('article, section').filter({ hasText: '缺经度站' }).first();
      await expect(card).toBeVisible();

      const links = page.locator('a[href*="/observatory"]');
      const linkCount = await links.count();
      for (let i = 0; i < linkCount; i += 1) {
        const href = await links.nth(i).getAttribute('href');
        expect(href).not.toMatch(/(?:lat|lng)=(?:null|NaN|undefined)/i);
      }

      const skyAction = card
        .getByRole('link', { name: /回望此地当夜星空|查看当夜星空/ })
        .or(card.getByRole('button', { name: /回望此地当夜星空|查看当夜星空/ }));
      const count = await skyAction.count();
      if (count === 0) {
        await expect(card.getByText(/回望此地当夜星空|查看当夜星空/)).toHaveCount(0);
      } else {
        const firstAction = skyAction.first();
        const tagName = await firstAction.evaluate((el) => el.tagName);
        const isDisabled = await firstAction.isDisabled().catch(() => false);
        const ariaDisabled = await firstAction.getAttribute('aria-disabled');
        if (tagName === 'A') {
          const href = await firstAction.getAttribute('href');
          expect(isDisabled || ariaDisabled === 'true' || !href).toBe(true);
        } else if (!isDisabled && ariaDisabled !== 'true') {
          await firstAction.click();
          expect(page.url()).toMatch(/\/atlas/);
          expect(page.url()).not.toMatch(/\/observatory/);
          await expect(card.locator('[role="status"], [role="alert"]').first()).toBeVisible({ timeout: 5_000 });
        } else {
          expect(isDisabled || ariaDisabled === 'true').toBe(true);
        }
      }
      errors.assertZeroErrors();
    } finally {
      errors.detach();
      await api.trashItem('media', mediaId);
    }
  });

  test('T2-F3.3-05 leap-day (2024-02-29) & negative timezone offset (-05:00) midnight rollover -> 2024-03-01', async ({ page }) => {
    const errors = attachErrorListeners(page);
    await installSkyBridgeSpy(page);

    try {
      await page.goto(
        '/observatory?lat=40.7128&lng=-74.0060&time=2024-02-29T23:55:00-05:00&place=New+York',
        { waitUntil: 'domcontentloaded' },
      );
      await waitForStellariumReady(page);

      await expect(page.locator('body')).toContainText('New York');
      await expect(page.locator('body')).toContainText(/40\.7128°\s*N/);
      await expect(page.locator('body')).toContainText(/74\.0060°\s*W/);

      const slider = getObservationTimeSlider(page);
      await setObservationTimeSliderFraction(slider, 315 / 540); // 00:15
      await expect(page.locator('body')).toContainText(/2024[-./]03[-./]01/);
      await expect(page.locator('body')).toContainText('00:15');
      await pollSkyDateNear(page, '2024-03-01T00:15:00-05:00');
      errors.assertZeroErrors();
    } finally {
      errors.detach();
    }
  });
});
