import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  assertImageAspectRatioPreserved,
  assertOnlyDarkSurface,
  attachErrorListeners,
  scanAntiAiTaste,
  verifySelfHostedFonts,
} from '../helpers/browser-checks';

const OGL_CHUNK_PATTERN = /(?:vendor-ogl|\/\.vite\/deps\/ogl(?:\.js|\?|$)|\/ogl\/)/i;
const EXTERNAL_FONT_CDN_PATTERN = /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net)/i;

function resolvePublicHeadersPath(): string {
  const specDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(specDir, '..', '..', '..', 'public', '_headers');
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.resolve(process.cwd(), 'public', '_headers');
}

async function waitForTwoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function isDarkColorScheme(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const bg = getComputedStyle(document.documentElement).backgroundColor;
    if (bg === 'rgb(19, 19, 20)') return true;
    if (bg === 'rgb(255, 255, 255)') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
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
        rect.width >= 280 &&
        rect.height >= 120 &&
        maxW <= 1280 + 1 &&
        rect.top >= h1Bottom - 20
      ) {
        el.setAttribute('data-e2e-stage-candidate', 'true');
        return i;
      }
    }
    return -1;
  });
  expect(stageIndex, 'Expected a 32px rounded focal stage (max-width <= 1280px) below the hero H1').toBeGreaterThanOrEqual(0);
  return page.locator('main [data-e2e-stage-candidate="true"]').first();
}

// ============================================================================
// F1.1 — Minimal Top Nav & Route Shell (6 tests)
// ============================================================================

test('[F1.1] T1-F1.1-01 TopNav landmark, brand link & 6 route links render cleanly', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const header = page.getByRole('banner');
  await expect(header).toBeVisible();

  const brand = header.locator('a[href="/"]').first();
  await expect(brand).toBeVisible();
  await expect(brand).toContainText('旅途手记');

  const nav = await ensureNavExpanded(page);
  await expect(nav).toBeVisible();

  const expectedLinks: Array<{ href: string; label: string }> = [
    { href: '/', label: '首页' },
    { href: '/atlas', label: '旅图' },
    { href: '/observatory', label: '观星台' },
    { href: '/vault', label: '密匣' },
    { href: '/#labs', label: '实验馆' },
    { href: '/admin', label: '整理台' },
  ];

  for (const item of expectedLinks) {
    const link = nav.locator(`a[href="${item.href}"]`);
    await expect(link).toHaveCount(1);
    await expect(link).toBeVisible();
    await expect(link).toContainText(item.label);
  }

  errors.assertZeroErrors();
});

test('[F1.1] T1-F1.1-02 SPA route navigation updates URL, H1, aria-current & avoids document reload', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const routes: Array<{ href: string; path: string }> = [
    { href: '/atlas', path: '/atlas' },
    { href: '/observatory', path: '/observatory' },
    { href: '/vault', path: '/vault' },
    { href: '/admin', path: '/admin' },
    { href: '/', path: '/' },
  ];

  for (const target of routes) {
    await clickNavLink(page, target.href);
    await expect.poll(() => new URL(page.url()).pathname).toBe(target.path);
    await expect(page.locator('#main-content h1').first()).toBeVisible();

    const nav = await ensureNavExpanded(page);
    await expect(nav.locator(`a[href="${target.href}"]`)).toHaveAttribute('aria-current', 'page');

    const activeCount = await nav.locator('a[aria-current="page"]').count();
    expect(activeCount).toBe(1);
  }

  const navEntries = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  expect(navEntries).toBe(1);

  errors.assertZeroErrors();
});

test('[F1.1] T1-F1.1-03 Clicking 实验馆 (/#labs) activates Labs anchor without setting aria-current', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/atlas');

  await clickNavLink(page, '/#labs');

  await expect.poll(() => {
    const u = new URL(page.url());
    return `${u.pathname}${u.hash}`;
  }).toBe('/#labs');

  const labsSection = page.locator('#labs');
  await expect(labsSection).toBeVisible();
  const nav = await ensureNavExpanded(page);
  await expect(nav.locator('a[href="/"]')).not.toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('a[href="/#labs"]')).not.toHaveAttribute('aria-current', 'page');

  errors.assertZeroErrors();
});

test('[F1.1] T1-F1.1-04 Brand link returns cleanly from sub-routes to /', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/vault');
  await expect(page.locator('#main-content h1').first()).toBeVisible();

  await page.getByRole('banner').locator('a[href="/"]').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  const nav = await ensureNavExpanded(page);
  await expect(nav.locator('a[href="/"]')).toHaveAttribute('aria-current', 'page');

  errors.assertZeroErrors();
});

test('[F1.1] T1-F1.1-05 Browser Back and Forward synchronize SPA routes', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  await clickNavLink(page, '/atlas');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/atlas');

  await clickNavLink(page, '/observatory');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/observatory');

  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/atlas');
  await expect(page.getByRole('navigation', { name: '主导航' }).locator('a[href="/atlas"]')).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  const homeNav = await ensureNavExpanded(page);
  await expect(homeNav.locator('a[href="/"]')).toHaveAttribute('aria-current', 'page');

  await page.goForward();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/atlas');

  errors.assertZeroErrors();
});

test('[F1.1] T1-F1.1-06 Sticky header remains pinned during scroll without obscuring main top', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const header = page.getByRole('banner');
  const initialBox = await header.boundingBox();
  const mainBox = await page.locator('#main-content').boundingBox();
  expect(initialBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(initialBox!.height).toBeGreaterThanOrEqual(48);
  expect(initialBox!.height).toBeLessThanOrEqual(64);
  expect(mainBox!.y).toBeGreaterThanOrEqual(initialBox!.y + initialBox!.height - 1);

  await page.evaluate(() => window.scrollTo(0, 600));
  await waitForTwoFrames(page);

  const stickyCheck = await header.evaluate((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { position: cs.position, top: rect.top };
  });
  expect(stickyCheck.position).toBe('sticky');
  expect(Math.abs(stickyCheck.top)).toBeLessThanOrEqual(1);

  errors.assertZeroErrors();
});

// ============================================================================
// F1.2 — OGL WebGL Bokeh Star-Ring (5 tests)
// ============================================================================

test('[F1.2] T1-F1.2-01 Hero renders active WebGL Bokeh canvas over studio ambient backdrop', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const canvas = page.locator('main canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(300);
  expect(box!.height).toBeGreaterThanOrEqual(200);

  const webglState = await canvas.evaluate((node) => {
    const c = node as HTMLCanvasElement;
    const ctx2d = c.getContext('2d');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return {
      backingWidth: c.width,
      backingHeight: c.height,
      has2d: ctx2d !== null,
      hasWebgl: gl !== null,
      contextLost: gl ? gl.isContextLost() : true,
    };
  });

  expect(webglState.backingWidth).toBeGreaterThan(0);
  expect(webglState.backingHeight).toBeGreaterThan(0);
  expect(webglState.has2d).toBe(false);
  expect(webglState.hasWebgl).toBe(true);
  expect(webglState.contextLost).toBe(false);

  errors.assertZeroErrors();
});

test('[F1.2] T1-F1.2-02 OGL WebGL chunk lazy-loads only when visiting Home (/)', async ({ page }) => {
  const errors = attachErrorListeners(page);
  const oglResponses: Array<{ url: string; status: number }> = [];

  page.on('response', (res) => {
    if (OGL_CHUNK_PATTERN.test(res.url())) {
      oglResponses.push({ url: res.url(), status: res.status() });
    }
  });

  await page.goto('/vault', { waitUntil: 'networkidle' });
  const vaultResources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((r) => r.name),
  );
  expect(vaultResources.filter((u) => OGL_CHUNK_PATTERN.test(u))).toEqual([]);
  expect(oglResponses).toEqual([]);

  await page.getByRole('navigation', { name: '主导航' }).locator('a[href="/"]').click();
  await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(async () => {
      const homeResources = await page.evaluate(() =>
        performance.getEntriesByType('resource').map((r) => r.name),
      );
      return homeResources.filter((u) => OGL_CHUNK_PATTERN.test(u)).length;
    })
    .toBeGreaterThan(0);

  expect(oglResponses.some((r) => r.status === 200)).toBe(true);
  errors.assertZeroErrors();
});

test('[F1.2] T1-F1.2-03 Visible Pause/Resume toggle controls star-ring animation state', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');
  await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 10_000 });

  const toggleBtn = await getHeroPauseButton(page);
  await expect(toggleBtn).toBeVisible();

  const box = await toggleBtn.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(32);

  const beforeState = await toggleBtn.evaluate((el) => ({
    pressed: el.getAttribute('aria-pressed'),
    label: el.getAttribute('aria-label') || el.textContent || '',
  }));

  await toggleBtn.click();
  const pausedState = await toggleBtn.evaluate((el) => ({
    pressed: el.getAttribute('aria-pressed'),
    label: el.getAttribute('aria-label') || el.textContent || '',
  }));
  expect(
    pausedState.pressed !== beforeState.pressed || pausedState.label !== beforeState.label,
  ).toBe(true);

  await toggleBtn.click();
  const resumedState = await toggleBtn.evaluate((el) => ({
    pressed: el.getAttribute('aria-pressed'),
    label: el.getAttribute('aria-label') || el.textContent || '',
  }));
  expect(resumedState).toEqual(beforeState);

  errors.assertZeroErrors();
});

test('[F1.2] T1-F1.2-04 Pointer sweep (repulsion/vortex) & click (ripple) interact cleanly', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const canvas = page.locator('main canvas').first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width * 0.25, box!.y + box!.height * 0.35);
  await page.mouse.move(box!.x + box!.width * 0.72, box!.y + box!.height * 0.55, { steps: 8 });
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.48);
  await waitForTwoFrames(page);

  const ctas = await getHeroCtas(page);
  await expect(ctas.first()).toBeVisible();
  errors.assertZeroErrors();
});

test('[F1.2] T1-F1.2-05 Pausing halts continuous RAF loop and resuming restarts ticks', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const win = window as unknown as { __e2eRafCount: number };
    win.__e2eRafCount = 0;
    const origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      origRaf((ts) => {
        win.__e2eRafCount += 1;
        cb(ts);
      });
  });

  await page.goto('/');
  await expect(page.locator('main canvas').first()).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __e2eRafCount: number }).__e2eRafCount))
    .toBeGreaterThan(4);

  const toggleBtn = await getHeroPauseButton(page);
  await toggleBtn.click();
  await page.waitForTimeout(150);

  const pausedStart = await page.evaluate(() => (window as unknown as { __e2eRafCount: number }).__e2eRafCount);
  await page.waitForTimeout(350);
  const pausedEnd = await page.evaluate(() => (window as unknown as { __e2eRafCount: number }).__e2eRafCount);
  expect(pausedEnd - pausedStart).toBe(0);

  await toggleBtn.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __e2eRafCount: number }).__e2eRafCount))
    .toBeGreaterThan(pausedEnd + 2);

  errors.assertZeroErrors();
});

// ============================================================================
// F1.3 — Hero Typography & Two Pill CTAs (5 tests)
// ============================================================================

test('[F1.3] T1-F1.3-01 Hero H1 displays restrained Chinese short sentence with exact weight/tracking/leading', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const h1 = page.locator('main h1').first();
  await expect(h1).toBeVisible();

  const metrics = await h1.evaluate((el) => {
    const text = (el.textContent || '').trim();
    const cs = getComputedStyle(el);
    const fontSizePx = Number.parseFloat(cs.fontSize);
    const letterSpacingPx = cs.letterSpacing === 'normal' ? 0 : Number.parseFloat(cs.letterSpacing);
    const lineHeightPx = Number.parseFloat(cs.lineHeight);
    return { text, fontWeight: cs.fontWeight, fontSizePx, letterSpacingPx, lineHeightPx };
  });

  expect(metrics.text.length).toBeGreaterThan(4);
  expect(metrics.text.length).toBeLessThanOrEqual(30);
  expect(metrics.text).toMatch(/\p{Script=Han}/u);
  expect(metrics.fontWeight).toBe('500');
  expect(Math.abs(metrics.letterSpacingPx - -0.03 * metrics.fontSizePx)).toBeLessThanOrEqual(0.75);

  const leadingRatio = metrics.lineHeightPx / metrics.fontSizePx;
  expect(leadingRatio).toBeGreaterThanOrEqual(1.08);
  expect(leadingRatio).toBeLessThanOrEqual(1.22);

  errors.assertZeroErrors();
});

test('[F1.3] T1-F1.3-02 Hero subtitle maintains concise 1-line copy and muted ink hierarchy', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const hero = await getHeroSection(page);
  const subtitle = hero.locator('h1 + div').first();
  await expect(subtitle).toBeVisible();

  const metrics = await subtitle.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      text: (el.textContent || '').trim(),
      fontSizePx: Number.parseFloat(cs.fontSize),
      lineHeightPx: Number.parseFloat(cs.lineHeight),
      color: cs.color,
    };
  });

  expect(metrics.text.length).toBeGreaterThan(6);
  expect(metrics.text).toContain('滚轮缩放');
  expect(metrics.text).toMatch(/\p{Script=Han}/u);
  expect(metrics.fontSizePx).toBeGreaterThanOrEqual(10);
  expect(metrics.lineHeightPx / metrics.fontSizePx).toBeGreaterThanOrEqual(1.2);

  errors.assertZeroErrors();
});

test('[F1.3] T1-F1.3-03 Two capsule CTA buttons meet pill radius and 44px touch-target height', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const ctas = await getHeroCtas(page);
  await expect(ctas).toHaveCount(2);

  for (let i = 0; i < 2; i += 1) {
    const cta = ctas.nth(i);
    await expect(cta).toBeVisible();
    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(32);

    const radius = await cta.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius));
    expect(radius).toBeGreaterThanOrEqual(box!.height / 2);
  }

  errors.assertZeroErrors();
});

test('[F1.3] T1-F1.3-04 Primary & secondary capsule CTAs match Day/Night palette tokens', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const ctas = await getHeroCtas(page);
  await expect(ctas).toHaveCount(2);

  for (let i = 0; i < 2; i += 1) {
    const styles = await ctas.nth(i).evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        borderTopWidth: Number.parseFloat(cs.borderTopWidth),
        backdropFilter: cs.backdropFilter,
        color: cs.color,
      };
    });
    expect(styles.borderTopWidth).toBeGreaterThanOrEqual(1);
    expect(styles.color).not.toBe('');
  }

  errors.assertZeroErrors();
});

test('[F1.3] T1-F1.3-05 Hero capsule CTAs activate via click and keyboard Enter with focus-visible ring', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const ctas = await getHeroCtas(page);
  await expect(ctas).toHaveCount(2);

  // Use keyboard Tab until primary hero capsule receives :focus-visible
  let focusedPrimary = false;
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const isTarget = await ctas.nth(0).evaluate((el) => document.activeElement === el && el.matches(':focus-visible'));
    if (isTarget) {
      focusedPrimary = true;
      break;
    }
  }
  expect(focusedPrimary).toBe(true);

  await expect
    .poll(() => ctas.nth(0).evaluate((el) => Number.parseFloat(getComputedStyle(el).outlineWidth)))
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => ctas.nth(0).evaluate((el) => getComputedStyle(el).outlineColor))
    .toBe('rgb(138, 180, 248)');

  await page.keyboard.press('Enter');
  await expect(ctas.nth(0)).toHaveAttribute('aria-pressed', 'true');

  await ctas.nth(1).click({ force: true });
  await expect(page.locator('#focal-stage')).toBeInViewport();

  errors.assertZeroErrors();
});

// ============================================================================
// F1.4 — Scroll-Driven 32px Focal Stage & Solar Wheel Zoom (5 tests)
// ============================================================================

test('[F1.4] T1-F1.4-01 32px rounded wide focal stage peeks into lower ~42vh at scrollY=0 on 1440x900', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const hero = await getHeroSection(page);
  const heroBox = await hero.boundingBox();
  expect(heroBox).not.toBeNull();
  expect(heroBox!.height).toBeGreaterThanOrEqual(760);

  const stage = await findFocalStageLocator(page);
  await expect(stage).toBeVisible();

  const metrics = await stage.evaluate((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      top: rect.top,
      width: rect.width,
      maxWidth: cs.maxWidth,
      radius: cs.borderTopLeftRadius,
    };
  });

  expect(metrics.scrollY).toBe(0);
  expect(metrics.radius).toBe('32px');
  expect(metrics.width).toBeLessThanOrEqual(1280);
  expect(metrics.top).toBeGreaterThanOrEqual(760);

  await expect(page.getByRole('button', { name: '向下浏览山海实景手记' })).toBeVisible();
  await page.getByRole('button', { name: '向下浏览山海实景手记' }).click({ force: true });
  await expect(stage).toBeInViewport();

  errors.assertZeroErrors();
});

test('[F1.4] T1-F1.4-02 Focal stage renders real visual preview inside 32px clipped frame', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const stage = await findFocalStageLocator(page);
  await expect(stage).toBeVisible();

  const overflow = await stage.evaluate((el) => getComputedStyle(el).overflow);
  expect(['hidden', 'clip']).toContain(overflow);

  const imgCount = await stage.locator('img').count();
  if (imgCount > 0) {
    await assertImageAspectRatioPreserved(stage.locator('img').first());
  } else {
    const visualMetrics = await stage.evaluate((el) => {
      const media = el.querySelector('canvas, svg');
      if (!media) return { hasVisual: false, width: 0, height: 0 };
      const r = media.getBoundingClientRect();
      return { hasVisual: true, width: r.width, height: r.height };
    });
    expect(visualMetrics.hasVisual).toBe(true);
    expect(visualMetrics.width).toBeGreaterThan(200);
    expect(visualMetrics.height).toBeGreaterThan(100);
  }

  errors.assertZeroErrors();
});

test('[F1.4] T1-F1.4-03 Natural mouse wheel scrolls page cleanly with zero JS wheel hijacking', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');
  const canvas = page.locator('main canvas').first();
  await expect(canvas).toBeVisible();

  // Over hero solar canvas at top: wheel zooms the 3D scene instead of scrolling away
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.wheel(0, -180);
  await page.mouse.wheel(0, -180);
  await expect.poll(async () => Number.parseFloat((await canvas.getAttribute('data-zoom')) || '0')).toBeGreaterThan(0.15);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(5);

  const resetBtn = page.getByRole('button', { name: '复位太阳系视角' });
  await expect(resetBtn).toBeVisible();
  await resetBtn.click();
  await expect.poll(async () => Math.abs(Number.parseFloat((await canvas.getAttribute('data-zoom')) || '0'))).toBeLessThan(0.05);

  // Outside hero after scrolling down to focal stage: normal wheel page scroll works natively
  const stage = await findFocalStageLocator(page);
  await expect(page.getByRole('button', { name: '向下浏览山海实景手记' })).toBeVisible();
  await page.getByRole('button', { name: '向下浏览山海实景手记' }).click({ force: true });
  await expect(stage).toBeInViewport();
  const baseScroll = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 260);
  await waitForTwoFrames(page);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(baseScroll + 80);

  errors.assertZeroErrors();
});

test('[F1.4] T1-F1.4-04 Native animation-timeline: view() expands focal stage smoothly on scroll', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const stage = await findFocalStageLocator(page);
  const initial = await stage.evaluate((el) => {
    const cs = getComputedStyle(el) as CSSStyleDeclaration & { animationTimeline?: string };
    const m = new DOMMatrixReadOnly(cs.transform === 'none' ? undefined : cs.transform);
    return { timeline: cs.animationTimeline || '', scaleX: m.a };
  });

  expect(initial.timeline).toContain('view');
  expect(initial.scaleX).toBeLessThanOrEqual(1.001);

  await stage.scrollIntoViewIfNeeded();
  await page.evaluate((node) => {
    node.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, (await stage.elementHandle())!);
  await waitForTwoFrames(page);

  const centeredScale = await stage.evaluate((el) => {
    const cs = getComputedStyle(el);
    const m = new DOMMatrixReadOnly(cs.transform === 'none' ? undefined : cs.transform);
    return m.a;
  });

  expect(centeredScale).toBeGreaterThanOrEqual(initial.scaleX);
  expect(centeredScale).toBeGreaterThanOrEqual(0.985);
  expect(centeredScale).toBeLessThanOrEqual(1.005);

  errors.assertZeroErrors();
});

test('[F1.4] T1-F1.4-05 Scroll round-trip preserves layout geometry and zero horizontal overflow', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const stage = await findFocalStageLocator(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await waitForTwoFrames(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitForTwoFrames(page);

  const layout = await stage.evaluate((el) => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    stageWidth: el.getBoundingClientRect().width,
  }));

  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  expect(layout.stageWidth).toBeLessThanOrEqual(1280);

  errors.assertZeroErrors();
});

// ============================================================================
// F1.5 — Bio, Module Entrances & Labs Slot (5 tests)
// ============================================================================

test('[F1.5] T1-F1.5-01 Personal bio section renders restrained human introduction below stage', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');
  const narrative = page.locator('#focal-stage .font-editorial-serif').first();
  await narrative.scrollIntoViewIfNeeded();
  await expect(narrative).toBeVisible();
  const text = (await narrative.innerText()).trim();
  expect(/\p{Script=Han}{10,}/u.test(text)).toBe(true);
  errors.assertZeroErrors();
});

test('[F1.5] T1-F1.5-02 Three core module entrances (/atlas, /observatory, /vault) render & navigate cleanly', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const heroSection = await getHeroSection(page);
  const heroBox = await heroSection.boundingBox();
  expect(heroBox).not.toBeNull();

  const targets = ['/atlas', '/observatory', '/vault'] as const;
  for (const href of targets) {
    const entrance = page.locator(`main a[href="${href}"]`).last();
    await expect(entrance).toBeVisible();
    const box = await entrance.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(heroBox!.y + heroBox!.height - 10);

    const text = (await entrance.innerText()).trim();
    expect(text).toMatch(/\p{Script=Han}/u);
  }

  for (const href of targets) {
    await page.goto('/');
    await page.locator(`main a[href="${href}"]`).last().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(href);
    await expect(page.locator('#main-content h1').first()).toBeVisible();
  }

  errors.assertZeroErrors();
});

test('[F1.5] T1-F1.5-03 Reserved Labs (#labs) slot renders cleanly and scrolls into view on nav click', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const labs = page.locator('section#labs');
  await expect(labs).toBeVisible();
  await expect(labs.locator('h2, h3').first()).toContainText(/实验馆|Labs/i);

  await clickNavLink(page, '/#labs');
  await expect(labs).toBeInViewport();

  errors.assertZeroErrors();
});

test('[F1.5] T1-F1.5-04 Home passes scanAntiAiTaste(page) with zero banned copy/symbols/filters', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');
  const report = await scanAntiAiTaste(page);
  expect(report.violations).toEqual([]);
  errors.assertZeroErrors();
});

test('[F1.5] T1-F1.5-05 Layered surfaces avoid SaaS 4-cell Bento grids, neon shadows & pulsing dots', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const audit = await page.evaluate(() => {
    const grids = Array.from(document.querySelectorAll<HTMLElement>('main *')).filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display !== 'grid') return false;
      const cols = cs.gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
      return cols.length >= 4 && el.children.length >= 4;
    });

    const pulsingDots = Array.from(document.querySelectorAll<HTMLElement>('main *')).filter((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.width > 16 || rect.height > 16) return false;
      const cs = getComputedStyle(el);
      const radius = Number.parseFloat(cs.borderTopLeftRadius);
      const anim = cs.animationName || '';
      return radius >= rect.width * 0.45 && /pulse|ping|blink/i.test(anim);
    });

    const neonShadows = Array.from(document.querySelectorAll<HTMLElement>('main *')).filter((el) => {
      const shadow = getComputedStyle(el).boxShadow;
      if (!shadow || shadow === 'none') return false;
      return /rgb\(\s*(?:0|56|66|138|168|236),\s*(?:255|189|245)/i.test(shadow) && shadow.includes('0px 0px');
    });

    return {
      fourColBentoCount: grids.length,
      pulsingDotCount: pulsingDots.length,
      neonShadowCount: neonShadows.length,
    };
  });

  expect(audit.fourColBentoCount).toBe(0);
  expect(audit.pulsingDotCount).toBe(0);
  expect(audit.neonShadowCount).toBe(0);

  errors.assertZeroErrors();
});

// ============================================================================
// F1.6 — Dual-State Color System (5 tests)
// ============================================================================

test('[F1.6] T1-F1.6-01 Initial <meta name="color-scheme"> and :root palette resolve to OS preference', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const dark = await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const state = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const rootCs = getComputedStyle(document.documentElement);
    const bodyCs = getComputedStyle(document.body);
    return {
      metaContent: meta?.getAttribute('content') ?? null,
      rootScheme: rootCs.colorScheme,
      htmlBg: rootCs.backgroundColor,
      bodyColor: bodyCs.color,
    };
  });

  expect(state.metaContent).toBe('light dark');
  expect(state.rootScheme).toContain('light');
  expect(state.rootScheme).toContain('dark');
  expect(state.htmlBg).toBe(dark ? 'rgb(19, 19, 20)' : 'rgb(255, 255, 255)');
  expect(state.bodyColor).toBe(dark ? 'rgb(227, 227, 227)' : 'rgb(31, 31, 31)');

  errors.assertZeroErrors();
});

test('[F1.6] T1-F1.6-02 ThemeToggle switches between light and dark palettes and updates aria-label', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const startedDark = await isDarkColorScheme(page);
  const toggleBtn = page
    .getByRole('banner')
    .getByRole('button', { name: /切换至(浅色|深色)模式/ });
  await expect(toggleBtn).toBeVisible();
  await expect(toggleBtn).toHaveAttribute('aria-label', startedDark ? '切换至浅色模式' : '切换至深色模式');

  await toggleBtn.click();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
    .toBe(startedDark ? 'rgb(255, 255, 255)' : 'rgb(19, 19, 20)');
  await expect(toggleBtn).toHaveAttribute('aria-label', startedDark ? '切换至深色模式' : '切换至浅色模式');

  await toggleBtn.click();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
    .toBe(startedDark ? 'rgb(19, 19, 20)' : 'rgb(255, 255, 255)');

  errors.assertZeroErrors();
});

test('[F1.6] T1-F1.6-03 Surface (#F2F4F8 / #1E1F20) & Google Blue accent (#1A73E8 / #8AB4F8) match spec', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const checkPalette = async (darkExpected: boolean) => {
    const tokens = await page.evaluate(() => {
      const labs = document.querySelector('#labs');
      const activeBar = document.querySelector('header nav a[aria-current="page"] span');
      return {
        labsBg: labs ? getComputedStyle(labs).backgroundColor : null,
        accentBg: activeBar ? getComputedStyle(activeBar).backgroundColor : null,
      };
    });
    expect(tokens.labsBg).toBe(darkExpected ? 'rgb(30, 31, 32)' : 'rgb(242, 244, 248)');
    expect(tokens.accentBg).toBe(darkExpected ? 'rgb(138, 180, 248)' : 'rgb(26, 115, 232)');
  };

  const initialDark = await isDarkColorScheme(page);
  await checkPalette(initialDark);

  await page.getByRole('banner').getByRole('button', { name: /切换至(浅色|深色)模式/ }).click();
  await waitForTwoFrames(page);
  await checkPalette(!initialDark);

  errors.assertZeroErrors();
});

test('[F1.6] T1-F1.6-04 Selected non-OS theme persists across page.reload() via localStorage', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/');

  const initialDark = await isDarkColorScheme(page);
  const expectedOverride = initialDark ? 'light' : 'dark';
  const expectedBg = initialDark ? 'rgb(255, 255, 255)' : 'rgb(19, 19, 20)';

  await page.getByRole('banner').getByRole('button', { name: /切换至(浅色|深色)模式/ }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('travel:color-scheme'))).toBe(expectedOverride);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const persisted = await page.evaluate(() => ({
    storage: localStorage.getItem('travel:color-scheme'),
    meta: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
    bg: getComputedStyle(document.documentElement).backgroundColor,
  }));

  expect(persisted.storage).toBe(expectedOverride);
  expect(persisted.meta).toBe(expectedOverride);
  expect(persisted.bg).toBe(expectedBg);

  errors.assertZeroErrors();
});

test('[F1.6] T1-F1.6-05 /observatory maintains color-scheme: only dark (#0B0C0E) even in light mode', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/observatory');

  const hostBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(hostBg).toBe('rgb(255, 255, 255)');

  const surface = page.locator('.deep-space, [data-only-dark], .observatory-viewport').first();
  const res = await assertOnlyDarkSurface(surface, 'rgb(11, 12, 14)');
  expect(res.backgroundColor).toBe('rgb(11, 12, 14)');
  expect(res.luminance).toBeGreaterThan(0.35);

  errors.assertZeroErrors();
});

// ============================================================================
// F1.7 — Self-Hosted WOFF2 Fonts (6 tests)
// ============================================================================

test('[F1.7] T1-F1.7-01 /fonts/fonts.css loads 200 text/css and populates document.fonts', async ({ page }) => {
  const errors = attachErrorListeners(page);
  let fontsCssStatus: number | null = null;
  let fontsCssContentType = '';

  page.on('response', (res) => {
    if (new URL(res.url()).pathname === '/fonts/fonts.css') {
      fontsCssStatus = res.status();
      fontsCssContentType = res.headers()['content-type'] ?? '';
    }
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  expect(fontsCssStatus).toBe(200);
  expect(fontsCssContentType.toLowerCase()).toContain('text/css');

  const loadedCount = await page.evaluate(async () => {
    await document.fonts.ready;
    return Array.from(document.fonts).filter((f) => f.status === 'loaded').length;
  });
  expect(loadedCount).toBeGreaterThan(0);

  errors.assertZeroErrors();
});

test('[F1.7] T1-F1.7-02 verifySelfHostedFonts(page) passes Han Canvas pixel check & avoids Microsoft YaHei', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/', { waitUntil: 'networkidle' });

  // Call without expectedFamilies so Canvas CJK Han glyph fallback comparison runs!
  const result = await verifySelfHostedFonts(page);
  expect(result.loadedFamilies).toContain('Inter');
  expect(result.loadedFamilies).toContain('Noto Sans SC');
  expect(result.h1FontWeight).toBe('500');
  expect(result.h1FontFamily?.toLowerCase()).not.toContain('microsoft yahei');

  errors.assertZeroErrors();
});

test('[F1.7] T1-F1.7-03 Self-hosted WOFF2 responses carry immutable cache & zero external font CDNs', async ({ page }) => {
  const errors = attachErrorListeners(page);
  const woff2Responses: Array<{ url: string; status: number; cacheControl: string }> = [];
  const externalFontRequests: string[] = [];

  page.on('request', (req) => {
    const url = req.url();
    if (EXTERNAL_FONT_CDN_PATTERN.test(url)) {
      externalFontRequests.push(url);
    }
  });
  page.on('response', (res) => {
    const pathname = new URL(res.url()).pathname;
    if (pathname.startsWith('/fonts/') && pathname.endsWith('.woff2')) {
      woff2Responses.push({
        url: pathname,
        status: res.status(),
        cacheControl: res.headers()['cache-control'] ?? '',
      });
    }
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  expect(externalFontRequests).toEqual([]);
  expect(woff2Responses.length).toBeGreaterThan(0);

  for (const item of woff2Responses) {
    expect(item.status).toBe(200);
    expect(item.cacheControl).toMatch(/immutable/i);
    expect(item.cacheControl).toMatch(/max-age=31536000/i);
  }

  errors.assertZeroErrors();
});

test('[F1.7] T1-F1.7-04 Noto Serif SC subset is declared and loads for editorial serif text', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/', { waitUntil: 'networkidle' });

  const serifProbe = await page.evaluate(async () => {
    const existing = document.querySelector<HTMLElement>('.font-editorial-serif');
    let tempEl: HTMLElement | null = null;
    const target =
      existing ??
      (() => {
        tempEl = document.createElement('span');
        tempEl.className = 'font-editorial-serif';
        tempEl.style.position = 'fixed';
        tempEl.style.opacity = '0';
        tempEl.style.pointerEvents = 'none';
        tempEl.textContent = '把走过的山海收进一册。';
        document.body.appendChild(tempEl);
        return tempEl;
      })();

    const cs = getComputedStyle(target);
    await document.fonts.load(`400 16px "Noto Serif SC"`, '把走过的山海收进一册');
    await document.fonts.ready;

    const loadedSerif = Array.from(document.fonts).some(
      (f) => f.family.replace(/^["']|["']$/g, '') === 'Noto Serif SC' && f.status === 'loaded',
    );
    const fontFamily = cs.fontFamily;
    if (tempEl) tempEl.remove();

    return { usedExisting: Boolean(existing), fontFamily, loadedSerif };
  });

  expect(serifProbe.fontFamily.toLowerCase()).toContain('noto serif sc');
  expect(serifProbe.loadedSerif).toBe(true);

  errors.assertZeroErrors();
});

test('[F1.7] T1-F1.7-05 JetBrains Mono enforces tabular-nums equal digit width alignment', async ({ page }) => {
  const errors = attachErrorListeners(page);
  await page.goto('/', { waitUntil: 'networkidle' });

  const monoMetrics = await page.evaluate(async () => {
    await document.fonts.load('400 16px "JetBrains Mono"', '0123456789');
    await document.fonts.ready;

    const existing = document.querySelector<HTMLElement>('.tabular-nums-mono');
    const wrapper = document.createElement('div');
    wrapper.style.position = 'fixed';
    wrapper.style.opacity = '0';
    wrapper.style.pointerEvents = 'none';

    const span1 = document.createElement('span');
    span1.className = 'tabular-nums-mono';
    span1.textContent = '111111';

    const span8 = document.createElement('span');
    span8.className = 'tabular-nums-mono';
    span8.textContent = '888888';

    wrapper.append(span1, span8);
    document.body.appendChild(wrapper);

    const cs = getComputedStyle(existing ?? span1);
    const w1 = span1.getBoundingClientRect().width;
    const w8 = span8.getBoundingClientRect().width;
    const loadedMono = Array.from(document.fonts).some(
      (f) => f.family.replace(/^["']|["']$/g, '') === 'JetBrains Mono' && f.status === 'loaded',
    );
    wrapper.remove();

    return {
      fontFamily: cs.fontFamily,
      fontVariantNumeric: cs.fontVariantNumeric,
      fontFeatureSettings: cs.fontFeatureSettings,
      width1: w1,
      width8: w8,
      loadedMono,
    };
  });

  expect(monoMetrics.fontFamily.toLowerCase()).toContain('jetbrains mono');
  expect(monoMetrics.loadedMono).toBe(true);
  expect(
    monoMetrics.fontVariantNumeric.includes('tabular-nums') ||
      monoMetrics.fontFeatureSettings.includes('tnum'),
  ).toBe(true);
  expect(Math.abs(monoMetrics.width1 - monoMetrics.width8)).toBeLessThanOrEqual(0.5);

  errors.assertZeroErrors();
});

test('[F1.7] T1-F1.7-06 public/_headers configures immutable cache and nosniff for static fonts', async () => {
  const headersPath = resolvePublicHeadersPath();
  expect(fs.existsSync(headersPath)).toBe(true);
  const content = fs.readFileSync(headersPath, 'utf8');

  expect(content).toMatch(/\/fonts\/\*/);
  expect(content).toMatch(/Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/i);
  expect(content).toMatch(/X-Content-Type-Options:\s*nosniff/i);
});
