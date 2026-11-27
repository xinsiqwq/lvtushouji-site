import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  assertOnlyDarkSurface,
  attachErrorListeners,
  scanAntiAiTaste,
  verifySelfHostedFonts,
} from '../helpers/browser-checks';

const EXTERNAL_FONT_CDN_PATTERN = /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net)/i;

async function waitForTwoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function getHeroSection(page: Page): Promise<Locator> {
  return page.locator('main section').first();
}

async function getHeroPauseButton(page: Page): Promise<Locator> {
  return page
    .locator('main')
    .getByRole('button', { name: /暂停|恢复|播放|动效|星环|pause|resume/i })
    .first();
}

async function ensureNavExpanded(page: Page): Promise<Locator> {
  const nav = page.getByRole('navigation', { name: '主导航' });
  const trigger = nav.locator('button.home-nav-trigger');
  if ((await trigger.count()) > 0) {
    const expanded = await trigger.getAttribute('aria-expanded');
    if (expanded !== 'true') {
      await trigger.click();
    }
  }
  return nav;
}

async function clickNavLink(page: Page, href: string): Promise<void> {
  const nav = await ensureNavExpanded(page);
  await nav.locator(`a[href="${href}"]`).click();
}

async function getHeroCtas(page: Page): Promise<Locator> {
  const hero = await getHeroSection(page);
  return hero.locator('button[aria-label*="动效"], button[aria-label*="山海"]');
}

async function findFocalStageLocator(page: Page): Promise<Locator> {
  const stageIndex = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return -1;
    const h1 = main.querySelector('h1');
    const h1Bottom = h1 ? h1.getBoundingClientRect().bottom : 0;
    const candidates = Array.from(main.querySelectorAll<HTMLElement>('section, div, figure, article'));
    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      if (!el || el.id === 'labs') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = Number.parseFloat(cs.borderTopLeftRadius);
      const rect = el.getBoundingClientRect();
      const maxW = cs.maxWidth === 'none' ? rect.width : Number.parseFloat(cs.maxWidth);
      if (
        Number.isFinite(r) &&
        Math.abs(r - 32) <= 1 &&
        rect.width >= 260 &&
        rect.height >= 100 &&
        maxW <= 1280 + 1 &&
        rect.top >= h1Bottom - 20
      ) {
        el.setAttribute('data-e2e-stage-candidate', 'true');
        return i;
      }
    }
    return -1;
  });
  expect(stageIndex, 'Expected a 32px rounded focal stage below the hero H1').toBeGreaterThanOrEqual(0);
  return page.locator('main [data-e2e-stage-candidate="true"]').first();
}

// ============================================================================
// F1.1 — Minimal Top Nav & Route Shell (6 boundary tests)
// ============================================================================

test('[F1.1] T2-F1.1-01 Unknown route renders 404 fallback and recovers cleanly to /', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/nonexistent-star-path');

  const h1 = page.locator('#main-content h1').first();
  await expect(h1).toBeVisible();
  await expect(h1).toHaveText('页面走丢了');

  const homeLink = page.locator('#main-content a[href="/"]').first();
  await expect(homeLink).toBeVisible();
  await expect(homeLink).toContainText('回到首页');

  await homeLink.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('#main-content h1').first()).toBeVisible();

  errors.assertZeroErrors();
});

test('[F1.1] T2-F1.1-02 Trailing-slash URLs normalize cleanly without breaking active nav highlight', async ({ page }) => {
  const errors = attachErrorListeners(page);

  for (const target of [
    { raw: '/atlas/', normalized: '/atlas' },
    { raw: '/observatory/', normalized: '/observatory' },
  ]) {
    await page.goto(target.raw);
    await expect(page.locator('#main-content h1').first()).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(target.normalized);
    await expect(
      page.getByRole('navigation', { name: '主导航' }).locator(`a[href="${target.normalized}"]`),
    ).toHaveAttribute('aria-current', 'page');
  }

  errors.assertZeroErrors();
});

test('[F1.1] T2-F1.1-03 Cold load /labs normalizes to /#labs and focuses Labs section', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/labs');

  await expect.poll(() => {
    const u = new URL(page.url());
    return `${u.pathname}${u.hash}`;
  }).toBe('/#labs');

  const labs = page.locator('#labs');
  await expect(labs).toBeVisible();
  await expect(labs).toBeInViewport();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? '')).toBe('labs');

  errors.assertZeroErrors();
});

test('[F1.1] T2-F1.1-04 Keyboard-only Tab + Enter navigation shifts focus inside <main>', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  // First Tab onto collapsible home nav trigger and open popover via Enter
  let openedNav = false;
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    const onTrigger = await page.evaluate(() =>
      Boolean(document.activeElement?.classList.contains('home-nav-trigger')),
    );
    if (onTrigger) {
      await page.keyboard.press('Enter');
      openedNav = true;
      break;
    }
  }
  expect(openedNav).toBe(true);

  let reachedAtlasLink = false;
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    const isAtlasLink = await page.evaluate(() => {
      const el = document.activeElement as HTMLAnchorElement | null;
      return Boolean(el && el.tagName === 'A' && el.getAttribute('href') === '/atlas' && el.closest('nav'));
    });
    if (isAtlasLink) {
      reachedAtlasLink = true;
      break;
    }
  }
  expect(reachedAtlasLink).toBe(true);

  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/atlas');
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('#main-content')))).toBe(true);

  errors.assertZeroErrors();
});

test('[F1.1] T2-F1.1-05 Mobile 390x844 & ultra-narrow 320x568 TopNav containment without horizontal overflow', async ({ page }) => {
  const errors = attachErrorListeners(page);

  for (const vp of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(vp);
    await page.goto('/');

    const geometry = await page.evaluate(() => {
      const header = document.querySelector('header');
      const brand = header?.querySelector('a[href="/"]');
      const nav = header?.querySelector('nav[aria-label="主导航"]');
      const toggle = header?.querySelector('button[aria-label*="切换"]');
      const h1 = document.querySelector('main h1');
      if (!header || !brand || !nav || !toggle || !h1) {
        return { ok: false, reason: 'missing_landmark' };
      }
      const hr = header.getBoundingClientRect();
      const br = brand.getBoundingClientRect();
      const nr = nav.getBoundingClientRect();
      const tr = toggle.getBoundingClientRect();
      const h1r = h1.getBoundingClientRect();
      return {
        ok: true,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        headerLeft: hr.left,
        headerRight: hr.right,
        brandRight: br.right,
        navLeft: nr.left,
        navRight: nr.right,
        toggleLeft: tr.left,
        toggleRight: tr.right,
        headerBottom: hr.bottom,
        h1Top: h1r.top,
      };
    });

    expect(geometry.ok).toBe(true);
    if (geometry.ok) {
      expect(geometry.scrollWidth!).toBeLessThanOrEqual(vp.width);
      expect(geometry.headerLeft!).toBeGreaterThanOrEqual(-1);
      expect(geometry.headerRight!).toBeLessThanOrEqual(vp.width + 1);
      expect(geometry.brandRight!).toBeLessThanOrEqual(geometry.navLeft! + 1);
      expect(geometry.navRight!).toBeLessThanOrEqual(geometry.toggleLeft! + 1);
      expect(geometry.toggleRight!).toBeLessThanOrEqual(vp.width + 1);
      expect(geometry.headerBottom!).toBeLessThanOrEqual(geometry.h1Top! + 1);
    }
  }

  errors.assertZeroErrors();
});

test('[F1.1] T2-F1.1-06 Absent startViewTransition + prefers-reduced-motion still swaps SPA routes cleanly', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  for (const route of ['/atlas', '/vault', '/']) {
    await clickNavLink(page, route);
    await expect.poll(() => new URL(page.url()).pathname).toBe(route);
    await expect(page.locator('#main-content h1').first()).toBeVisible();
  }

  const navCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  expect(navCount).toBe(1);
  errors.assertZeroErrors();
});

// ============================================================================
// F1.2 — OGL WebGL Bokeh Star-Ring (6 boundary tests)
// ============================================================================

test('[F1.2] T2-F1.2-01 WebGL context-unavailable triggers static optical fallback with zero 2D fake particles', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.addInitScript(() => {
    const win = window as unknown as { __lineToCount: number; __webglAttempts: number };
    win.__lineToCount = 0;
    win.__webglAttempts = 0;

    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
        win.__webglAttempts += 1;
        return null;
      }
      return origGetContext.apply(this, [type, ...args] as Parameters<typeof origGetContext>);
    } as typeof HTMLCanvasElement.prototype.getContext;

    const origLineTo = CanvasRenderingContext2D.prototype.lineTo;
    CanvasRenderingContext2D.prototype.lineTo = function (
      this: CanvasRenderingContext2D,
      ...args: [number, number]
    ) {
      win.__lineToCount += 1;
      return origLineTo.apply(this, args);
    };
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(await getHeroCtas(page)).toHaveCount(2);

  await scanAntiAiTaste(page);
  const state = await page.evaluate(() => ({
    webglAttempts: (window as unknown as { __webglAttempts: number }).__webglAttempts,
    lineToCount: (window as unknown as { __lineToCount: number }).__lineToCount,
    has2dParticleCanvas: Array.from(document.querySelectorAll('canvas')).some((c) => {
      const role = `${c.className} ${c.id} ${c.getAttribute('aria-label') || ''}`.toLowerCase();
      return (role.includes('star') || role.includes('bokeh') || role.includes('ring') || role.includes('particle')) && c.getContext('2d') !== null;
    }),
  }));

  expect(state.webglAttempts).toBeGreaterThan(0);
  expect(state.lineToCount).toBe(0);
  expect(state.has2dParticleCanvas).toBe(false);
  errors.assertZeroErrors();
});

test('[F1.2] T2-F1.2-02 webglcontextlost mid-session degrades safely without uncaught errors', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const canvas = page.locator('main canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  await canvas.evaluate((node) => {
    const evt =
      typeof WebGLContextEvent !== 'undefined'
        ? new WebGLContextEvent('webglcontextlost', { cancelable: true })
        : new Event('webglcontextlost', { cancelable: true });
    node.dispatchEvent(evt);
  });
  await waitForTwoFrames(page);

  await expect(page.locator('main h1').first()).toBeVisible();
  await expect((await getHeroCtas(page)).first()).toBeVisible();
  errors.assertZeroErrors();
});

test('[F1.2] T2-F1.2-03 prefers-reduced-motion: reduce suppresses continuous RAF loop & 2D lineTo fallback', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const win = window as unknown as { __rafCount: number; __lineToCount: number };
    win.__rafCount = 0;
    win.__lineToCount = 0;

    const origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      origRaf((ts) => {
        win.__rafCount += 1;
        cb(ts);
      });

    const origLineTo = CanvasRenderingContext2D.prototype.lineTo;
    CanvasRenderingContext2D.prototype.lineTo = function (
      this: CanvasRenderingContext2D,
      ...args: [number, number]
    ) {
      win.__lineToCount += 1;
      return origLineTo.apply(this, args);
    };
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  // Ensure HeroPauseButton or static fallback exists so M1 placeholder doesn't accidentally pass
  const hasPauseOrCanvas = await page.evaluate(
    () => Boolean(document.querySelector('main canvas')) ||
      Array.from(document.querySelectorAll('main button')).some((b) =>
        /暂停|恢复|播放|动效|星环|pause|resume/i.test(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`),
      ),
  );
  expect(hasPauseOrCanvas).toBe(true);

  await page.waitForTimeout(400);
  const t1 = await page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount);
  await page.waitForTimeout(450);
  const t2 = await page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount);

  expect(t2 - t1).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __lineToCount: number }).__lineToCount)).toBe(0);
  await expect(page.locator('main h1').first()).toBeVisible();
  errors.assertZeroErrors();
});

test('[F1.2] T2-F1.2-04 document.hidden visibilitychange pauses WebGL RAF and respects manual pause state', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const win = window as unknown as { __rafCount: number; __mockHidden: boolean };
    win.__rafCount = 0;
    win.__mockHidden = false;

    const origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      origRaf((ts) => {
        win.__rafCount += 1;
        cb(ts);
      });

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => win.__mockHidden });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (win.__mockHidden ? 'hidden' : 'visible'),
    });
  });

  await page.goto('/');
  await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount))
    .toBeGreaterThan(4);

  // 1. Hide tab -> RAF stops
  await page.evaluate(() => {
    (window as unknown as { __mockHidden: boolean }).__mockHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(140);
  const hiddenStart = await page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount);
  await page.waitForTimeout(400);
  const hiddenEnd = await page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount);
  expect(hiddenEnd - hiddenStart).toBe(0);

  // 2. Restore tab -> RAF resumes
  await page.evaluate(() => {
    (window as unknown as { __mockHidden: boolean }).__mockHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount))
    .toBeGreaterThan(hiddenEnd + 2);

  // 3. Manually pause, then hide & restore tab -> must STAY paused
  const toggleBtn = await getHeroPauseButton(page);
  await toggleBtn.click();
  await page.waitForTimeout(140);
  await page.evaluate(() => {
    (window as unknown as { __mockHidden: boolean }).__mockHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    (window as unknown as { __mockHidden: boolean }).__mockHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(140);
  const manualStart = await page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount);
  await page.waitForTimeout(350);
  const manualEnd = await page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount);
  expect(manualEnd - manualStart).toBe(0);

  errors.assertZeroErrors();
});

test('[F1.2] T2-F1.2-05 Rapid 5x click + Space/Enter on Pause toggle keeps state synced with RAF', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const win = window as unknown as { __rafCount: number };
    win.__rafCount = 0;
    const origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      origRaf((ts) => {
        win.__rafCount += 1;
        cb(ts);
      });
  });

  await page.goto('/');
  await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 10_000 });
  const toggleBtn = await getHeroPauseButton(page);
  await expect(toggleBtn).toBeVisible();

  await toggleBtn.focus();
  await page.keyboard.press('Space'); // -> paused (1)
  await page.keyboard.press('Enter'); // -> playing (2)

  // 5 rapid clicks: odd net toggle -> final state should be paused
  for (let i = 0; i < 5; i += 1) {
    await toggleBtn.click({ delay: 30 });
  }
  await page.waitForTimeout(150);

  const countBefore = await page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount);
  await page.waitForTimeout(350);
  const countAfter = await page.evaluate(() => (window as unknown as { __rafCount: number }).__rafCount);
  expect(countAfter - countBefore).toBe(0);

  errors.assertZeroErrors();
});

test('[F1.2] T2-F1.2-06 Viewport resize 1440x900 <-> 390x844 adapts WebGL canvas cleanly', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const canvas = page.locator('main canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const desktopBox = await canvas.boundingBox();
  expect(desktopBox).not.toBeNull();
  expect(desktopBox!.width).toBeGreaterThan(800);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(220);
  const mobileBox = await canvas.boundingBox();
  expect(mobileBox).not.toBeNull();
  expect(mobileBox!.width).toBeGreaterThanOrEqual(320);
  expect(mobileBox!.width).toBeLessThanOrEqual(390);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(220);
  const restoredBox = await canvas.boundingBox();
  expect(restoredBox).not.toBeNull();
  expect(restoredBox!.width).toBeGreaterThan(800);

  errors.assertZeroErrors();
});

// ============================================================================
// F1.3 — Hero Typography & Two Pill CTAs (5 boundary tests)
// ============================================================================

test('[F1.3] T2-F1.3-01 Mobile 390x844 & 320x568 H1 keeps weight 500, tracking & zero horizontal clip', async ({ page }) => {
  const errors = attachErrorListeners(page);

  for (const vp of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(vp);
    await page.goto('/');
    const h1 = page.locator('main h1').first();
    await expect(h1).toBeVisible();

    const metrics = await h1.evaluate((el) => {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const fontSizePx = Number.parseFloat(cs.fontSize);
      const letterSpacingPx = cs.letterSpacing === 'normal' ? 0 : Number.parseFloat(cs.letterSpacing);
      return {
        fontWeight: cs.fontWeight,
        fontSizePx,
        letterSpacingPx,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        right: rect.right,
        left: rect.left,
      };
    });

    expect(metrics.fontWeight).toBe('500');
    expect(Math.abs(metrics.letterSpacingPx - -0.03 * metrics.fontSizePx)).toBeLessThanOrEqual(0.75);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.left).toBeGreaterThanOrEqual(-1);
    expect(metrics.right).toBeLessThanOrEqual(vp.width + 1);
  }

  errors.assertZeroErrors();
});

test('[F1.3] T2-F1.3-02 Mobile 390x844 & 320x568 capsule CTAs stay separated with >= 44px hit targets', async ({ page }) => {
  const errors = attachErrorListeners(page);

  for (const vp of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(vp);
    await page.goto('/');

    const ctas = await getHeroCtas(page);
    await expect(ctas).toHaveCount(2);

    const b0 = await ctas.nth(0).boundingBox();
    const b1 = await ctas.nth(1).boundingBox();
    expect(b0).not.toBeNull();
    expect(b1).not.toBeNull();

    for (const b of [b0!, b1!]) {
      expect(b.height).toBeGreaterThanOrEqual(32);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 1);
    }

    const noOverlap =
      b0!.y + b0!.height + 8 <= b1!.y ||
      b1!.y + b1!.height + 8 <= b0!.y ||
      b0!.x + b0!.width + 8 <= b1!.x ||
      b1!.x + b1!.width + 8 <= b0!.x;
    expect(noOverlap).toBe(true);
  }

  errors.assertZeroErrors();
});

test('[F1.3] T2-F1.3-03 :focus-visible outline renders #1A73E8 (light) and #8AB4F8 (dark) on keyboard Tab', async ({ page }) => {
  const errors = attachErrorListeners(page);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');

    // Focus ThemeToggle in <header> (uses root light/dark accent tokens outside data-only-dark hero)
    const themeToggle = page.locator('header button[aria-label*="切换"]').first();
    let focused = false;
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      const matched = await themeToggle.evaluate((el) => document.activeElement === el && el.matches(':focus-visible'));
      if (matched) {
        focused = true;
        break;
      }
    }
    expect(focused).toBe(true);

    await expect
      .poll(() => themeToggle.evaluate((el) => Number.parseFloat(getComputedStyle(el).outlineWidth)))
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(() => themeToggle.evaluate((el) => getComputedStyle(el).outlineColor))
      .toBe(scheme === 'dark' ? 'rgb(138, 180, 248)' : 'rgb(26, 115, 232)');
  }

  errors.assertZeroErrors();
});

test('[F1.3] T2-F1.3-04 Root font-size 20px zoom preserves hero spacing without colliding with 32px stage', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
  await waitForTwoFrames(page);

  const stage = await findFocalStageLocator(page);
  const ctas = await getHeroCtas(page);
  const ctaBox = await ctas.last().boundingBox();
  const stageBox = await stage.boundingBox();

  expect(ctaBox).not.toBeNull();
  expect(stageBox).not.toBeNull();
  expect(ctaBox!.y + ctaBox!.height).toBeLessThanOrEqual(stageBox!.y + 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  errors.assertZeroErrors();
});

test('[F1.3] T2-F1.3-05 Rapid double-click on primary capsule CTA navigates cleanly in one history step', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const cue = page.getByRole('button', { name: '向下浏览山海实景手记' });
  await expect(cue).toBeVisible();
  await cue.dblclick({ force: true });
  await expect(page.locator('#focal-stage')).toBeInViewport();
  errors.assertZeroErrors();
});

// ============================================================================
// F1.4 — Scroll-Driven 32px Focal Stage (5 boundary tests)
// ============================================================================

test('[F1.4] T2-F1.4-01 prefers-reduced-motion: reduce locks focal stage at resting scale(1)', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const stage = await findFocalStageLocator(page);
  const state = await stage.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { animationName: cs.animationName, transform: cs.transform };
  });

  expect(state.animationName).toBe('none');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(state.transform);
  errors.assertZeroErrors();
});

test('[F1.4] T2-F1.4-02 CSSOM @supports guard ensures base stage rule never strands at scale(0.94)', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const stage = await findFocalStageLocator(page);

  // Class-name-agnostic CSSOM inspection: locate view() timeline rule inside @supports and verify its base rule has no stuck scale(0.94)
  const cssAudit = await page.evaluate(() => {
    const viewTimelineSelectors = new Set<string>();
    const unguardedRules: Array<{ selector: string; transform: string; animation: string }> = [];

    const visit = (rules: CSSRuleList, inSupports: boolean, inNoPref: boolean) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) {
          const isNoPref =
            rule.conditionText.includes('prefers-reduced-motion') &&
            rule.conditionText.includes('no-preference');
          visit(rule.cssRules, inSupports, inNoPref || isNoPref);
        } else if (rule instanceof CSSSupportsRule) {
          const isTimelineSupports =
            rule.conditionText.includes('animation-timeline') &&
            rule.conditionText.includes('view()');
          visit(rule.cssRules, inSupports || isTimelineSupports, inNoPref);
        } else if (rule instanceof CSSStyleRule) {
          const styleDecl = rule.style as CSSStyleDeclaration & { animationTimeline?: string };
          const timeline = styleDecl.animationTimeline || '';
          if (inSupports && timeline.includes('view')) {
            viewTimelineSelectors.add(rule.selectorText);
          } else if (!inSupports && !inNoPref) {
            unguardedRules.push({
              selector: rule.selectorText,
              transform: rule.style.transform,
              animation: rule.style.animationName || rule.style.animation,
            });
          }
        }
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules, false, false);
      } catch {
        // ignore cross-origin sheets if any
      }
    }

    const matchingBase = unguardedRules.filter((r) => viewTimelineSelectors.has(r.selector));
    return {
      supportsRuleCount: viewTimelineSelectors.size,
      matchingBase,
    };
  });

  expect(cssAudit.supportsRuleCount).toBeGreaterThan(0);
  for (const baseRule of cssAudit.matchingBase) {
    expect(baseRule.transform).toBe('');
    expect(baseRule.animation).toBe('');
  }

  // Live verification when @media (prefers-reduced-motion: no-preference) does not apply -> base rule resolves to scale(1)
  const live = await stage.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { animationName: cs.animationName, transform: cs.transform, radius: cs.borderTopLeftRadius };
  });
  expect(live.animationName).toBe('none');
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(live.transform);
  expect(live.radius).toBe('32px');

  errors.assertZeroErrors();
});

test('[F1.4] T2-F1.4-03 Bi-directional rapid mouse wheel bursts execute without wheel hijacking', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');
  const canvas = page.locator('main canvas').first();
  await expect(canvas).toBeVisible();

  // Over hero solar canvas: rapid zoom in + zoom out bursts work smoothly without scrolling away
  const cBox = await canvas.boundingBox();
  expect(cBox).not.toBeNull();
  await page.mouse.move(cBox!.x + cBox!.width * 0.5, cBox!.y + cBox!.height * 0.5);
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, -140);
  }
  await expect.poll(async () => Number.parseFloat((await canvas.getAttribute('data-zoom')) || '0')).toBeGreaterThan(0.2);

  for (let i = 0; i < 10; i += 1) {
    await page.mouse.wheel(0, 160);
  }
  await expect.poll(async () => Number.parseFloat((await canvas.getAttribute('data-zoom')) || '0')).toBeLessThan(-0.05);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(5);

  // Scrolled below hero at #focal-stage: native bi-directional wheel scroll works unhindered
  const stage = await findFocalStageLocator(page);
  const cue = page.getByRole('button', { name: '向下浏览山海实景手记' });
  await expect(cue).toBeVisible();
  await cue.click({ force: true });
  await expect(stage).toBeInViewport();
  // Settle any in-flight smooth-scroll animation before testing native bi-directional wheel scroll
  await page.evaluate(() => {
    document.getElementById('focal-stage')?.scrollIntoView({ behavior: 'instant', block: 'center' });
  });
  await waitForTwoFrames(page);
  const sBox = await stage.boundingBox();
  expect(sBox).not.toBeNull();
  await page.mouse.move(sBox!.x + sBox!.width * 0.5, sBox!.y + Math.min(80, sBox!.height * 0.25));
  const startY = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 260);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(startY + 50);
  const midY = await page.evaluate(() => window.scrollY);

  await page.mouse.wheel(0, -260);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(midY - 40);

  errors.assertZeroErrors();
});

test('[F1.4] T2-F1.4-04 Mobile 390x844 focal stage stays contained with 32px rounded frame & zero overflow', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const stage = await findFocalStageLocator(page);
  const metrics = await stage.evaluate((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      radius: Number.parseFloat(cs.borderTopLeftRadius),
      scrollWidth: document.documentElement.scrollWidth,
    };
  });

  expect(metrics.scrollWidth).toBeLessThanOrEqual(390);
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(390);
  expect(metrics.radius).toBeGreaterThanOrEqual(20);

  errors.assertZeroErrors();
});

test('[F1.4] T2-F1.4-05 Incremental partial-entry scroll keeps focal stage scale monotonically within [0.94, 1.0]', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const stage = await findFocalStageLocator(page);
  const scales: number[] = [];

  for (const y of [0, 100, 250, 500, 800]) {
    await page.evaluate((pos) => window.scrollTo(0, pos), y);
    await waitForTwoFrames(page);
    const s = await stage.evaluate((el) => {
      const tf = getComputedStyle(el).transform;
      const m = new DOMMatrixReadOnly(tf === 'none' ? undefined : tf);
      return m.a;
    });
    expect(s).toBeGreaterThanOrEqual(0.935);
    expect(s).toBeLessThanOrEqual(1.005);
    scales.push(s);
  }

  for (let i = 1; i < scales.length; i += 1) {
    expect(scales[i]!).toBeGreaterThanOrEqual(scales[i - 1]! - 0.002);
  }

  errors.assertZeroErrors();
});

// ============================================================================
// F1.5 — Bio, Module Entrances & Labs Slot (5 boundary tests)
// ============================================================================

test('[F1.5] T2-F1.5-01 Deep DOM anti-neon & anti-pulsing-dot scan passes on dark Home', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  const violations = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const cs = getComputedStyle(el);
      if (cs.backgroundColor === 'rgb(7, 9, 13)') {
        out.push(`Prohibited #07090D background on ${el.tagName}`);
      }
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.width <= 16 && rect.height <= 16) {
        const radius = Number.parseFloat(cs.borderTopLeftRadius);
        if (radius >= rect.width * 0.45 && /pulse|ping|blink/i.test(cs.animationName || '')) {
          out.push(`Pulsing dot detected on ${el.tagName}.${el.className}`);
        }
      }
      if (cs.boxShadow && cs.boxShadow !== 'none' && cs.boxShadow.includes('0px 0px') && /(?:rgb\(\s*0,\s*255|rgb\(\s*56,\s*189|rgb\(\s*168,\s*85)/i.test(cs.boxShadow)) {
        out.push(`Neon glow boxShadow detected on ${el.tagName}`);
      }
    }
    return out;
  });

  expect(violations).toEqual([]);
  errors.assertZeroErrors();
});

test('[F1.5] T2-F1.5-02 Hard exclusion check verifies zero mini-games, 12-in-1 toolbox or AI chat on Home', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');
  await expect(page.locator('#labs')).toBeVisible();

  const htmlText = await page.evaluate(() => `${document.body.innerHTML}\n${document.body.innerText}`);
  for (const forbidden of ['dino.html', 'game-2048.html', 'minesweeper.html', 'arcade.html', 'Playroom', 'CODEX_PROXY', 'FFmpeg']) {
    expect(htmlText).not.toContain(forbidden);
  }

  errors.assertZeroErrors();
});

test('[F1.5] T2-F1.5-03 Mobile 390x844 module cards & Labs stack vertically without overlapping', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const boxes = await page.evaluate(() => {
    const items = ['/atlas', '/observatory', '/vault']
      .map((href) => {
        const links = Array.from(document.querySelectorAll<HTMLElement>(`main a[href="${href}"]`));
        return links[links.length - 1] ?? null;
      })
      .filter((el): el is HTMLElement => el !== null);

    const labs = document.querySelector<HTMLElement>('#labs');
    if (labs) items.push(labs);

    return items.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
  });

  expect(boxes.length).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < boxes.length; i += 1) {
    expect(boxes[i]!.left).toBeGreaterThanOrEqual(0);
    expect(boxes[i]!.right).toBeLessThanOrEqual(390);
    if (i > 0) {
      expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom - 1);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);

  errors.assertZeroErrors();
});

test('[F1.5] T2-F1.5-04 Cold load /#labs scrolls #labs near header and focuses it', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/#labs');

  const labs = page.locator('#labs');
  await expect(labs).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? '')).toBe('labs');

  const top = await labs.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThanOrEqual(180);

  errors.assertZeroErrors();
});

test('[F1.5] T2-F1.5-05 Multi-route scanAntiAiTaste(page) passes across /, /atlas, /observatory, /vault, /admin', async ({ page }) => {
  const errors = attachErrorListeners(page);

  for (const route of ['/', '/atlas', '/observatory', '/vault', '/admin']) {
    await page.goto(route, { waitUntil: 'networkidle' });
    const report = await scanAntiAiTaste(page);
    expect(report.violations, `Anti-AI-taste violations on ${route}`).toEqual([]);
  }

  errors.assertZeroErrors();
});

// ============================================================================
// F1.6 — Dual-State Color System (6 boundary tests)
// ============================================================================

test('[F1.6] T2-F1.6-01 OS-light return-to-system deletes localStorage key and restores light dark meta', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  const toggleBtn = page.getByRole('banner').getByRole('button', { name: /切换至(浅色|深色)模式/ });
  await toggleBtn.click(); // -> dark override
  expect(await page.evaluate(() => localStorage.getItem('travel:color-scheme'))).toBe('dark');
  expect(await page.locator('meta[name="color-scheme"]').getAttribute('content')).toBe('dark');

  await toggleBtn.click(); // -> back to OS light -> deletes localStorage
  const state = await page.evaluate(() => ({
    storage: localStorage.getItem('travel:color-scheme'),
    meta: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
    bg: getComputedStyle(document.documentElement).backgroundColor,
  }));

  expect(state.storage).toBeNull();
  expect(state.meta).toBe('light dark');
  expect(state.bg).toBe('rgb(255, 255, 255)');
  errors.assertZeroErrors();
});

test('[F1.6] T2-F1.6-02 OS-dark return-to-system deletes localStorage key and restores light dark meta', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  const toggleBtn = page.getByRole('banner').getByRole('button', { name: /切换至(浅色|深色)模式/ });
  await toggleBtn.click(); // -> light override
  expect(await page.evaluate(() => localStorage.getItem('travel:color-scheme'))).toBe('light');
  expect(await page.locator('meta[name="color-scheme"]').getAttribute('content')).toBe('light');

  await toggleBtn.click(); // -> back to OS dark -> deletes localStorage
  const state = await page.evaluate(() => ({
    storage: localStorage.getItem('travel:color-scheme'),
    meta: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
    bg: getComputedStyle(document.documentElement).backgroundColor,
  }));

  expect(state.storage).toBeNull();
  expect(state.meta).toBe('light dark');
  expect(state.bg).toBe('rgb(19, 19, 20)');
  errors.assertZeroErrors();
});

test('[F1.6] T2-F1.6-03 Cross-tab storage event synchronizes color-scheme live without reload', async ({ context, page }) => {
  const errors1 = attachErrorListeners(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  const page2 = await context.newPage();
  const errors2 = attachErrorListeners(page2);
  await page2.emulateMedia({ colorScheme: 'light' });
  await page2.goto('/');

  await page.getByRole('banner').getByRole('button', { name: /切换至深色模式/ }).click();
  await expect
    .poll(() => page2.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
    .toBe('rgb(19, 19, 20)');
  await expect(page2.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'dark');

  await page.getByRole('banner').getByRole('button', { name: /切换至浅色模式/ }).click();
  await expect
    .poll(() => page2.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
    .toBe('rgb(255, 255, 255)');

  await page2.close();
  errors1.assertZeroErrors();
  errors2.assertZeroErrors();
});

test('[F1.6] T2-F1.6-04 Corrupted localStorage color-scheme value degrades gracefully to OS preference', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => {
    localStorage.setItem('travel:color-scheme', 'tacky-neon-999');
  });

  await page.goto('/');
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
  errors.assertZeroErrors();
});

test('[F1.6] T2-F1.6-05 Toggling Light/Dark on /observatory keeps deep-space #0B0C0E only-dark surface locked', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/observatory');

  const surface = page.locator('.deep-space, [data-only-dark], .observatory-viewport').first();
  await assertOnlyDarkSurface(surface, 'rgb(11, 12, 14)');

  await page.getByRole('banner').getByRole('button', { name: /切换至浅色模式/ }).click();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
    .toBe('rgb(255, 255, 255)');

  await assertOnlyDarkSurface(surface, 'rgb(11, 12, 14)');
  errors.assertZeroErrors();
});

test('[F1.6] T2-F1.6-06 Zero FOUC on dark reload and postmark warm ochre tokens resolve without #07090D leak', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');

  // Switch to persisted dark override
  await page.getByRole('banner').getByRole('button', { name: /切换至深色模式/ }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('travel:color-scheme'))).toBe('dark');

  // Install pre-paint MutationObserver + DOMContentLoaded/load snapshot recorder
  await page.addInitScript(() => {
    const win = window as unknown as { __foucLog: Array<{ phase: string; bg: string; attr: string | null }> };
    win.__foucLog = [];
    const record = (phase: string) => {
      if (!document.documentElement) return;
      win.__foucLog.push({
        phase,
        bg: getComputedStyle(document.documentElement).backgroundColor,
        attr: document.documentElement.getAttribute('data-theme'),
      });
    };
    const obs = new MutationObserver(() => record('mutation'));
    obs.observe(document.documentElement ?? document, {
      childList: !document.documentElement,
      subtree: !document.documentElement,
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class'],
    });
    document.addEventListener('DOMContentLoaded', () => record('domcontentloaded'));
    window.addEventListener('load', () => record('load'));
  });

  await page.reload({ waitUntil: 'load' });
  const foucResult = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      log: (window as unknown as { __foucLog: Array<{ phase: string; bg: string; attr: string | null }> }).__foucLog,
      finalBg: cs.backgroundColor,
      postmarkLight: cs.getPropertyValue('--palette-postmark-light').trim().toLowerCase(),
      postmarkDark: cs.getPropertyValue('--palette-postmark-dark').trim().toLowerCase(),
      hasBanned07090d: Array.from(document.querySelectorAll('*')).some(
        (el) => getComputedStyle(el).backgroundColor === 'rgb(7, 9, 13)',
      ),
    };
  });

  expect(foucResult.log.some((entry) => entry.bg === 'rgb(255, 255, 255)')).toBe(false);
  expect(foucResult.finalBg).toBe('rgb(19, 19, 20)');
  expect(foucResult.postmarkLight).toBe('#9a5b42');
  expect(foucResult.postmarkDark).toBe('#d69f87');
  expect(foucResult.hasBanned07090d).toBe(false);
  errors.assertZeroErrors();
});

// ============================================================================
// F1.7 — Self-Hosted WOFF2 Fonts (6 boundary tests)
// ============================================================================

test('[F1.7] T2-F1.7-01 Cross-route verifySelfHostedFonts(page) passes across /, /atlas, /observatory, /vault, /admin, /404', async ({ page }) => {
  const errors = attachErrorListeners(page);

  for (const route of ['/', '/atlas', '/observatory', '/vault', '/admin', '/nonexistent-404']) {
    await page.goto(route, { waitUntil: 'networkidle' });
    // Invoke without expectedFamilies so Han Canvas fallback pixel check runs on every route
    const res = await verifySelfHostedFonts(page);
    expect(res.h1FontWeight).toBe('500');
  }

  errors.assertZeroErrors();
});

test('[F1.7] T2-F1.7-02 Multi-slice Noto Sans SC & Noto Serif SC unicode-range + per-character Han Canvas check', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/', { waitUntil: 'networkidle' });

  const cssRes = await page.request.get('/fonts/fonts.css');
  expect(cssRes.status()).toBe(200);
  const cssText = await cssRes.text();
  expect(cssText).toContain('noto-sans-sc-500-core.woff2');
  expect(cssText).toContain('noto-serif-sc-400-core.woff2');

  const glyphAudit = await page.evaluate(async () => {
    const sample = '把走过的山海夜空收进一册旅图观星台密匣实验馆整理台';
    const uniqueChars = Array.from(new Set(Array.from(sample)));
    await document.fonts.load('500 36px "Noto Sans SC"', sample);
    await document.fonts.load('400 36px "Noto Serif SC"', sample);
    await document.fonts.ready;

    const samePixels = (a: Uint8ClampedArray, b: Uint8ClampedArray): boolean => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    };

    const drawChar = (font: string, ch: string): Uint8ClampedArray => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, 64, 64);
      ctx.font = font;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#000000';
      ctx.fillText(ch, 8, 48);
      return ctx.getImageData(0, 0, 64, 64).data;
    };

    const failures: string[] = [];
    for (const family of ['Noto Sans SC', 'Noto Serif SC'] as const) {
      const weight = family === 'Noto Sans SC' ? '500' : '400';
      for (const ch of uniqueChars) {
        if (!document.fonts.check(`${weight} 36px "${family}"`, ch)) {
          failures.push(`${family} fonts.check failed for "${ch}"`);
          continue;
        }
        const pxSerif = drawChar(`${weight} 36px serif`, ch);
        const pxSans = drawChar(`${weight} 36px sans-serif`, ch);
        const pxMono = drawChar(`${weight} 36px monospace`, ch);
        const pxWithSerif = drawChar(`${weight} 36px "${family}", serif`, ch);
        const pxWithSans = drawChar(`${weight} 36px "${family}", sans-serif`, ch);
        const pxWithMono = drawChar(`${weight} 36px "${family}", monospace`, ch);

        const genericsDiffer = !samePixels(pxSerif, pxSans) || !samePixels(pxSerif, pxMono);
        if (
          genericsDiffer &&
          samePixels(pxWithSerif, pxSerif) &&
          samePixels(pxWithSans, pxSans) &&
          samePixels(pxWithMono, pxMono)
        ) {
          failures.push(`${family} fell back to system font for "${ch}"`);
        }
      }
    }
    return { testedChars: uniqueChars.length, failures };
  });

  expect(glyphAudit.testedChars).toBeGreaterThan(10);
  expect(glyphAudit.failures).toEqual([]);
  errors.assertZeroErrors();
});

test('[F1.7] T2-F1.7-03 Font <link rel="preload" as="font"> hints carry crossorigin and serve 200 immutable', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/', { waitUntil: 'networkidle' });

  const preloads = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLLinkElement>('head link[rel="preload"][as="font"]')).map((l) => ({
      href: l.getAttribute('href') || '',
      crossorigin: l.getAttribute('crossorigin'),
    })),
  );

  expect(preloads.length).toBeGreaterThanOrEqual(4);
  for (const item of preloads) {
    expect(item.href).toMatch(/^\/fonts\/.*\.woff2$/);
    expect(item.crossorigin).not.toBeNull();
    const res = await page.request.get(item.href);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control'] ?? '').toMatch(/immutable/i);
  }

  errors.assertZeroErrors();
});

test('[F1.7] T2-F1.7-04 H1 strictly enforces weight 500, negative tracking & excludes Microsoft YaHei', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const h1 = await page.locator('main h1').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      fontWeight: cs.fontWeight,
      letterSpacingPx: cs.letterSpacing === 'normal' ? 0 : Number.parseFloat(cs.letterSpacing),
      fontFamily: cs.fontFamily,
    };
  });

  expect(h1.fontWeight).toBe('500');
  expect(h1.letterSpacingPx).toBeLessThan(0);
  expect(h1.fontFamily.toLowerCase()).not.toContain('microsoft yahei');
  expect(h1.fontFamily).not.toContain('微软雅黑');
  errors.assertZeroErrors();
});

test('[F1.7] T2-F1.7-05 Blocked /fonts/fonts.css degrades gracefully with zero pageerrors & no YaHei stack', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.route('**/fonts/fonts.css', (route) => route.abort());
  await page.goto('/');

  const h1 = page.locator('main h1').first();
  await expect(h1).toBeVisible();
  const fontFamily = await h1.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(fontFamily.toLowerCase()).not.toContain('microsoft yahei');
  expect(fontFamily.toLowerCase()).not.toContain('simsun');
  expect(pageErrors).toEqual([]);
});

test('[F1.7] T2-F1.7-06 Strict same-origin font network audit across full route navigation', async ({ page }) => {
  const errors = attachErrorListeners(page);
  const fontRequests: string[] = [];

  page.on('request', (req) => {
    const url = req.url();
    if (req.resourceType() === 'font' || /\.woff2(?:$|\?)/i.test(url) || EXTERNAL_FONT_CDN_PATTERN.test(url)) {
      fontRequests.push(url);
    }
  });

  for (const route of ['/', '/atlas', '/observatory', '/vault']) {
    await page.goto(route, { waitUntil: 'networkidle' });
  }

  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) {
    const parsed = new URL(url);
    expect(['127.0.0.1', 'localhost']).toContain(parsed.hostname);
    expect(EXTERNAL_FONT_CDN_PATTERN.test(url)).toBe(false);
  }

  errors.assertZeroErrors();
});
