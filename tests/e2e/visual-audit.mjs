#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';
const DEFAULT_OUT_DIR = path.join(__dirname, '.artifacts', 'visual-audit');
const EXTERNAL_FONT_CDN_RE = /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net)/i;

function parseArgs(argv) {
  let baseURL = DEFAULT_BASE_URL;
  let outDir = DEFAULT_OUT_DIR;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === '--base-url' && argv[i + 1]) {
      baseURL = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--base-url=')) {
      baseURL = arg.slice('--base-url='.length);
    } else if (arg === '--out-dir' && argv[i + 1]) {
      outDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--out-dir=')) {
      outDir = path.resolve(arg.slice('--out-dir='.length));
    }
  }

  return { baseURL, outDir };
}

const PROFILES = [
  {
    id: 'desktop-light',
    viewportType: 'desktop',
    theme: 'light',
    contextOptions: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  },
  {
    id: 'desktop-dark',
    viewportType: 'desktop',
    theme: 'dark',
    contextOptions: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  },
  {
    id: 'mobile-light',
    viewportType: 'mobile',
    theme: 'light',
    contextOptions: {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      colorScheme: 'light',
    },
  },
  {
    id: 'mobile-dark',
    viewportType: 'mobile',
    theme: 'dark',
    contextOptions: {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      colorScheme: 'dark',
    },
  },
];

const ROUTES = [
  { slug: 'home', path: '/' },
  { slug: 'atlas', path: '/atlas' },
  { slug: 'observatory', path: '/observatory' },
  { slug: 'vault', path: '/vault' },
];

async function writeReport(outDir, report) {
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

async function auditFontsAndH1(page, isHome) {
  return page.evaluate(async (checkLeading) => {
    const failures = [];
    await document.fonts.ready;

    const loadedFaces = Array.from(document.fonts)
      .filter((f) => f.status === 'loaded')
      .map((f) => ({ family: f.family.replace(/^["']|["']$/g, ''), weight: f.weight }));
    const loadedFamilies = Array.from(new Set(loadedFaces.map((f) => f.family)));

    if (loadedFamilies.length === 0) {
      failures.push('Expected at least one self-hosted @font-face to be loaded in document.fonts, found 0.');
    }

    const h1 = document.querySelector('h1');
    if (!h1) {
      failures.push('Expected an <h1> heading on page for typography audit, found none.');
      return {
        loadedFamilies,
        h1FontFamily: null,
        h1FontWeight: null,
        h1FontSizePx: null,
        h1LetterSpacingPx: null,
        h1LineHeightPx: null,
        h1LineHeightRatio: null,
        failures,
      };
    }

    const cs = getComputedStyle(h1);
    const firstStackItem = (cs.fontFamily.split(',')[0] ?? '').trim();
    const norm = (raw) => raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
    const primary = norm(firstStackItem);

    if (
      primary.includes('microsoft yahei') ||
      primary.includes('微软雅黑') ||
      primary.includes('simsun') ||
      primary.includes('arial')
    ) {
      failures.push(`H1 primary font resolved to prohibited system fallback '${cs.fontFamily}'.`);
    }

    const loadedNormSet = new Set(loadedFamilies.map(norm));
    const stackItems = cs.fontFamily.split(',').map((s) => s.trim()).filter(Boolean);
    const matchedLoaded = stackItems.some((item) => loadedNormSet.has(norm(item)));

    let fontCheckPassed = false;
    try {
      fontCheckPassed = document.fonts.check(`${cs.fontWeight} ${cs.fontSize} ${firstStackItem}`);
    } catch {
      fontCheckPassed = false;
    }
    if (!matchedLoaded || !fontCheckPassed) {
      failures.push(
        `H1 font-family '${cs.fontFamily}' did not resolve to any loaded self-hosted WOFF2 font ([${loadedFamilies.join(', ')}]).`,
      );
    }

    const h1Text = (h1.textContent || '').trim();
    const hanMatches = h1Text.match(/\p{Script=Han}/gu) ?? [];
    const h1HanSample = Array.from(new Set(hanMatches)).slice(0, 12).join('');

    if (h1HanSample.length > 0) {
      const loadedStackItems = stackItems.filter((item) => loadedNormSet.has(norm(item)));
      if (loadedStackItems.length === 0) {
        failures.push(`H1 Han text ("${h1HanSample}") has no loaded self-hosted font stack match.`);
      } else {
        const loadedStackCss = loadedStackItems.join(', ');
        let hanCheck = false;
        try {
          hanCheck = document.fonts.check(`${cs.fontWeight} ${cs.fontSize} ${loadedStackCss}`, h1HanSample);
        } catch {
          hanCheck = false;
        }
        const renderSample = (fontSpec) => {
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(1200, Math.max(240, h1HanSample.length * 48 + 16));
          canvas.height = 72;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.font = fontSpec;
          ctx.textBaseline = 'alphabetic';
          ctx.fillStyle = '#000000';
          ctx.fillText(h1HanSample, 4, 52);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const samePixels = (a, b) => {
          if (!a || !b || a.length !== b.length) return false;
          for (let i = 0; i < a.length; i += 1) {
            if (a[i] !== b[i]) return false;
          }
          return true;
        };
        const pxSerif = renderSample(`${cs.fontWeight} 36px serif`);
        const pxSans = renderSample(`${cs.fontWeight} 36px sans-serif`);
        const pxMono = renderSample(`${cs.fontWeight} 36px monospace`);
        const pxLoadedSerif = renderSample(`${cs.fontWeight} 36px ${loadedStackCss}, serif`);
        const pxLoadedSans = renderSample(`${cs.fontWeight} 36px ${loadedStackCss}, sans-serif`);
        const pxLoadedMono = renderSample(`${cs.fontWeight} 36px ${loadedStackCss}, monospace`);
        const genericsDiffer = !samePixels(pxSerif, pxSans) || !samePixels(pxSerif, pxMono);
        const fellBack =
          genericsDiffer &&
          samePixels(pxLoadedSerif, pxSerif) &&
          samePixels(pxLoadedSans, pxSans) &&
          samePixels(pxLoadedMono, pxMono);

        if (!hanCheck || fellBack) {
          failures.push(`H1 Han characters ("${h1HanSample}") fell back to system font instead of self-hosted WOFF2.`);
        }
      }
    }

    if (cs.fontWeight !== '500') {
      failures.push(`Expected H1 font-weight '500', got '${cs.fontWeight}'.`);
    }

    const fontSizePx = Number.parseFloat(cs.fontSize);
    const letterSpacingPx = cs.letterSpacing === 'normal' ? 0 : Number.parseFloat(cs.letterSpacing);
    if (Number.isFinite(fontSizePx) && Number.isFinite(letterSpacingPx)) {
      const expectedPx = -0.03 * fontSizePx;
      if (Math.abs(letterSpacingPx - expectedPx) > 0.75) {
        failures.push(`Expected H1 letter-spacing ~ -0.03em (${expectedPx.toFixed(2)}px), got ${letterSpacingPx.toFixed(2)}px.`);
      }
    }

    const lineHeightPx = Number.parseFloat(cs.lineHeight);
    const lineHeightRatio =
      Number.isFinite(lineHeightPx) && Number.isFinite(fontSizePx) && fontSizePx > 0
        ? Number((lineHeightPx / fontSizePx).toFixed(4))
        : null;
    if (checkLeading) {
      if (lineHeightRatio === null || lineHeightRatio < 1.08 || lineHeightRatio > 1.22) {
        failures.push(`Expected Home H1 line-height ratio ~ 1.14 ([1.08, 1.22]), got ${lineHeightRatio}.`);
      }
    }

    return {
      loadedFamilies,
      h1FontFamily: cs.fontFamily,
      h1FontWeight: cs.fontWeight,
      h1FontSizePx: Number.isFinite(fontSizePx) ? fontSizePx : null,
      h1LetterSpacingPx: Number.isFinite(letterSpacingPx) ? Number(letterSpacingPx.toFixed(3)) : null,
      h1LineHeightPx: Number.isFinite(lineHeightPx) ? Number(lineHeightPx.toFixed(3)) : null,
      h1LineHeightRatio: lineHeightRatio,
      failures,
    };
  }, isHome);
}

async function auditWebglHome(page) {
  try {
    await page.waitForFunction(
      () => {
        const c = document.querySelector('main canvas');
        const tel = window.__vaWebglTelemetry;
        return Boolean(c) && Boolean(tel) && tel.drawCalls > 0;
      },
      { timeout: 3000 },
    );
  } catch {
    // Allow evaluation below to produce exact structured diagnostics
  }

  return page.evaluate(() => {
    const failures = [];
    const canvas =
      document.querySelector('canvas[class*="star"], canvas[class*="bokeh"], canvas[id*="star"], main canvas');
    const tel = window.__vaWebglTelemetry || { contexts: 0, drawCalls: 0, contextTypes: [] };

    if (!canvas) {
      failures.push('Home page is missing a hero WebGL <canvas> element.');
      return { present: false, width: 0, height: 0, drawCalls: tel.drawCalls, contextLost: true, failures };
    }

    const rect = canvas.getBoundingClientRect();
    if (canvas.width <= 0 || canvas.height <= 0 || rect.width <= 0 || rect.height <= 0) {
      failures.push(`Hero <canvas> has zero dimensions (backing ${canvas.width}x${canvas.height}, rect ${rect.width}x${rect.height}).`);
    }

    if (canvas.getContext('2d') !== null) {
      failures.push('Hero <canvas> unexpectedly initialized a 2D context instead of WebGL.');
    }

    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const contextLost = gl ? gl.isContextLost() : true;
    if (!gl) {
      failures.push('Hero <canvas> failed to provide an active WebGL/WebGL2 context.');
    } else if (contextLost || gl.drawingBufferWidth <= 0 || gl.drawingBufferHeight <= 0) {
      failures.push(`Hero WebGL drawing buffer invalid or lost (lost=${contextLost}, ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}).`);
    }

    if (tel.drawCalls <= 0) {
      failures.push(`Expected WebGL drawCalls > 0 on Home hero canvas, observed ${tel.drawCalls}.`);
    }

    return {
      present: true,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      drawCalls: tel.drawCalls,
      contextLost,
      failures,
    };
  });
}

async function auditObservatoryOnlyDark(page) {
  return page.evaluate(() => {
    const failures = [];
    const target = document.querySelector('.deep-space, [data-only-dark], .observatory-viewport');
    if (!target) {
      failures.push('Observatory is missing an only-dark surface (.deep-space, [data-only-dark], or .observatory-viewport).');
      return { found: false, colorScheme: null, backgroundColor: null, color: null, luminance: null, failures };
    }

    const cs = getComputedStyle(target);
    const tokens = cs.colorScheme.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const isOnlyDark = tokens.includes('dark') && tokens.includes('only') && !tokens.includes('light');
    if (!isOnlyDark) {
      failures.push(`Expected Observatory color-scheme 'dark only', got '${cs.colorScheme}'.`);
    }
    if (cs.backgroundColor !== 'rgb(11, 12, 14)') {
      failures.push(`Expected Observatory backgroundColor 'rgb(11, 12, 14)' (#0B0C0E), got '${cs.backgroundColor}'.`);
    }

    const m = cs.color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    let luminance = 0;
    if (!m) {
      failures.push(`Could not parse Observatory foreground color '${cs.color}'.`);
    } else {
      const toLinear = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      luminance = 0.2126 * toLinear(Number(m[1])) + 0.7152 * toLinear(Number(m[2])) + 0.0722 * toLinear(Number(m[3]));
      if (luminance <= 0.35) {
        failures.push(`Expected readable light foreground luminance > 0.35 on #0B0C0E, got ${luminance.toFixed(3)}.`);
      }
    }

    return {
      found: true,
      colorScheme: cs.colorScheme,
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      luminance: Number(luminance.toFixed(4)),
      failures,
    };
  });
}

async function auditImagesAspectRatio(page) {
  return page.evaluate(async () => {
    const results = [];
    const failures = [];
    const imgs = Array.from(document.querySelectorAll('img'));

    for (const img of imgs) {
      const cs = getComputedStyle(img);
      const rect = img.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      if (!img.complete) {
        await new Promise((resolve) => {
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          setTimeout(done, 5000);
        });
      }
      if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
        failures.push(`Image failed to load or has zero natural dimensions: ${img.currentSrc || img.src}`);
        continue;
      }
      const naturalRatio = img.naturalWidth / img.naturalHeight;
      const renderedRatio = rect.width / rect.height;
      const relativeError = Math.abs(naturalRatio - renderedRatio) / naturalRatio;
      results.push({
        src: img.currentSrc || img.src,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        renderedWidth: Number(rect.width.toFixed(1)),
        renderedHeight: Number(rect.height.toFixed(1)),
        relativeError: Number(relativeError.toFixed(4)),
      });
      if (relativeError > 0.03) {
        failures.push(
          `Image aspect ratio distorted (${img.currentSrc || img.src}): error ${(relativeError * 100).toFixed(2)}% > 3.00%.`,
        );
      }
    }

    return { images: results, failures };
  });
}

async function auditAntiAiTaste(page) {
  return page.evaluate(async () => {
    const violations = [];
    const textSources = [];
    if (document.body) {
      textSources.push(document.body.innerText || '');
    }
    for (const el of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
      for (const attr of ['aria-label', 'title', 'placeholder']) {
        const val = el.getAttribute(attr);
        if (val) textSources.push(val);
      }
    }
    const combinedText = textSources.join('\n');

    const symbolMatch = combinedText.match(/[✦✨🚀]/gu);
    if (symbolMatch) {
      violations.push(`Banned decorative symbol(s) found: ${Array.from(new Set(symbolMatch)).join(' ')}`);
    }
    const kickerMatch = combinedText.match(/\b0[1-9]\s*\/\s*[A-Z]{2,}\b/g);
    if (kickerMatch) {
      violations.push(`Banned numbered kicker(s) found: ${Array.from(new Set(kickerMatch)).join(', ')}`);
    }
    for (const phrase of ['密钥解封', '时空遥测协议', '量子传输']) {
      if (combinedText.includes(phrase)) {
        violations.push(`Banned sci-fi copy found: "${phrase}"`);
      }
    }

    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (getComputedStyle(el).backgroundColor === 'rgb(7, 9, 13)') {
        violations.push(`Prohibited #07090D background on <${el.tagName.toLowerCase()}>`);
        break;
      }
    }

    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const viewportArea = vw * vh;
    const displacementFilterIds = new Set();
    let hasFullscreenFeDisplacement = false;

    for (const disp of document.querySelectorAll('feDisplacementMap')) {
      const filter = disp.closest('filter');
      if (filter && filter.id) displacementFilterIds.add(filter.id);
      const svg = disp.closest('svg');
      if (svg) {
        const rect = svg.getBoundingClientRect();
        if (rect.width * rect.height >= viewportArea * 0.5) {
          hasFullscreenFeDisplacement = true;
        }
      }
    }
    if (!hasFullscreenFeDisplacement && document.querySelectorAll('[style*="feDisplacementMap"]').length > 0) {
      hasFullscreenFeDisplacement = true;
    }
    if (!hasFullscreenFeDisplacement && displacementFilterIds.size > 0) {
      const extractIds = (val) => {
        if (!val || val === 'none') return [];
        const ids = [];
        const re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
        let m;
        while ((m = re.exec(val)) !== null) {
          const raw = (m[2] || '').trim();
          const idx = raw.indexOf('#');
          if (idx >= 0) {
            const frag = raw.slice(idx + 1);
            if (frag) ids.push(frag);
          }
        }
        return ids;
      };
      for (const el of allElements) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number.parseFloat(cs.opacity) <= 0) continue;
        const rect = el.getBoundingClientRect();
        const interW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
        const interH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
        if (interW * interH < viewportArea * 0.5) continue;
        const ids = [...extractIds(cs.filter), ...extractIds(cs.backdropFilter || '')];
        if (ids.some((id) => displacementFilterIds.has(id))) {
          hasFullscreenFeDisplacement = true;
          break;
        }
      }
    }
    if (hasFullscreenFeDisplacement) {
      violations.push('Prohibited fullscreen SVG <feDisplacementMap> liquid-glass filter detected.');
    }

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      requestAnimationFrame(done);
      setTimeout(done, 100);
    });
    for (const canvas of document.querySelectorAll('canvas')) {
      const role = `${canvas.className} ${canvas.id} ${canvas.getAttribute('aria-label') || ''}`.toLowerCase();
      if (role.includes('star') || role.includes('bokeh') || role.includes('ring') || role.includes('particle')) {
        if (canvas.getContext('2d') !== null) {
          violations.push(`Particle canvas <canvas class="${canvas.className}"> used 2D context instead of WebGL.`);
        }
      }
    }

    return violations;
  });
}

async function main() {
  const { baseURL, outDir } = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString();

  // Server preflight check before launching headless Chrome
  try {
    const res = await fetch(baseURL, { signal: AbortSignal.timeout(5000) });
    if (res.status >= 500) {
      const msg = `[visual-audit] Server responded with HTTP ${res.status} at ${baseURL}.`;
      console.error(msg);
      await writeReport(outDir, {
        timestamp,
        baseURL,
        error: msg,
        summary: { totalRuns: 0, passed: 0, failed: 1, screenshots: 0 },
        results: [],
      });
      process.exit(1);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const msg = `[visual-audit] Server unreachable at ${baseURL} (${reason}). Start the local dev server first.`;
    console.error(msg);
    await writeReport(outDir, {
      timestamp,
      baseURL,
      error: msg,
      summary: { totalRuns: 0, passed: 0, failed: 1, screenshots: 0 },
      results: [],
    });
    process.exit(1);
  }

  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });

  const results = [];
  let screenshotsCount = 0;

  try {
    for (const profile of PROFILES) {
      const context = await browser.newContext(profile.contextOptions);

      await context.addInitScript(() => {
        window.__vaWebglTelemetry = { contexts: 0, drawCalls: 0, contextTypes: [] };
        window.__vaWrappedContexts = window.__vaWrappedContexts || new WeakSet();
        const origGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, attrs) {
          const ctx = origGetContext.call(this, type, attrs);
          if (ctx && (type === 'webgl' || type === 'webgl2')) {
            window.__vaWebglTelemetry.contexts += 1;
            window.__vaWebglTelemetry.contextTypes.push(type);
            if (!window.__vaWrappedContexts.has(ctx)) {
              window.__vaWrappedContexts.add(ctx);
              for (const fnName of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
                if (typeof ctx[fnName] === 'function') {
                  const orig = ctx[fnName];
                  ctx[fnName] = function (...args) {
                    window.__vaWebglTelemetry.drawCalls += 1;
                    return orig.apply(this, args);
                  };
                }
              }
            }
          }
          return ctx;
        };
      });

      const page = await context.newPage();

      for (const route of ROUTES) {
        const consoleErrors = [];
        const pageErrors = [];
        const externalFontRequests = [];

        const onConsole = (msg) => {
          if (msg.type() === 'error') {
            consoleErrors.push(msg.text());
          }
        };
        const onPageError = (err) => {
          pageErrors.push(err.message || String(err));
        };
        const onRequest = (req) => {
          const url = req.url();
          if (EXTERNAL_FONT_CDN_RE.test(url)) {
            externalFontRequests.push(url);
          }
        };

        page.on('console', onConsole);
        page.on('pageerror', onPageError);
        page.on('request', onRequest);

        const failures = [];
        let screenshotName = `${route.slug}--${profile.id}.png`;
        let scrolledScreenshot = null;
        let fontsReport = null;
        let webglReport = null;
        let onlyDarkReport = null;
        let imagesReport = [];
        let antiAiViolations = [];

        try {
          await page.goto(new URL(route.path, baseURL).toString(), {
            waitUntil: 'networkidle',
            timeout: 30_000,
          });
          await page.evaluate(
            () =>
              new Promise((resolve) => {
                document.fonts.ready.then(() => {
                  requestAnimationFrame(() => requestAnimationFrame(resolve));
                });
              }),
          );
          await page.waitForTimeout(250);

          await page.screenshot({ path: path.join(outDir, screenshotName), fullPage: false });
          screenshotsCount += 1;

          if (route.path === '/') {
            const stageScrolled = await page.evaluate(async () => {
              const candidates = Array.from(document.querySelectorAll('main section, main div, main figure'));
              const stage = candidates.find((el) => {
                if (el.id === 'labs') return false;
                const cs = getComputedStyle(el);
                return Math.abs(Number.parseFloat(cs.borderTopLeftRadius) - 32) <= 1;
              });
              if (!stage && document.documentElement.scrollHeight <= window.innerHeight + 40) {
                return false;
              }
              if (stage) {
                stage.scrollIntoView({ behavior: 'instant', block: 'center' });
              } else {
                window.scrollTo(0, Math.round(window.innerHeight * 0.65));
              }
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              return true;
            });

            if (stageScrolled) {
              scrolledScreenshot = `home-scrolled--${profile.id}.png`;
              await page.screenshot({ path: path.join(outDir, scrolledScreenshot), fullPage: false });
              screenshotsCount += 1;
              await page.evaluate(() => window.scrollTo(0, 0));
            }
          }

          fontsReport = await auditFontsAndH1(page, route.path === '/');
          failures.push(...fontsReport.failures);

          if (route.path === '/') {
            webglReport = await auditWebglHome(page);
            failures.push(...webglReport.failures);
          }

          if (route.path === '/observatory') {
            onlyDarkReport = await auditObservatoryOnlyDark(page);
            failures.push(...onlyDarkReport.failures);
          }

          const imgAudit = await auditImagesAspectRatio(page);
          imagesReport = imgAudit.images;
          failures.push(...imgAudit.failures);

          antiAiViolations = await auditAntiAiTaste(page);
          failures.push(...antiAiViolations);

          if (externalFontRequests.length > 0) {
            failures.push(`External font CDN requests detected: ${externalFontRequests.join(', ')}`);
          }
          if (consoleErrors.length > 0) {
            failures.push(`Console errors (${consoleErrors.length}): ${consoleErrors.join(' | ')}`);
          }
          if (pageErrors.length > 0) {
            failures.push(`Uncaught page errors (${pageErrors.length}): ${pageErrors.join(' | ')}`);
          }
        } catch (err) {
          failures.push(`Unexpected audit exception: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          page.off('console', onConsole);
          page.off('pageerror', onPageError);
          page.off('request', onRequest);
        }

        results.push({
          profile: profile.id,
          route: route.path,
          passed: failures.length === 0,
          screenshot: screenshotName,
          scrolledScreenshot,
          fonts: fontsReport,
          webgl: webglReport,
          onlyDark: onlyDarkReport,
          images: imagesReport,
          antiAiViolations,
          externalFontRequests,
          consoleErrors,
          pageErrors,
          failures,
        });
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  const passedRuns = results.filter((r) => r.passed).length;
  const failedRuns = results.length - passedRuns;
  const report = {
    timestamp,
    baseURL,
    summary: {
      totalRuns: results.length,
      passed: passedRuns,
      failed: failedRuns,
      screenshots: screenshotsCount,
    },
    results,
  };

  const reportPath = await writeReport(outDir, report);
  console.log(
    `[visual-audit] Completed ${report.summary.totalRuns} runs: ${passedRuns} passed, ${failedRuns} failed (${screenshotsCount} screenshots). Report: ${reportPath}`,
  );
  if (failedRuns > 0) {
    for (const r of results.filter((item) => !item.passed)) {
      console.error(`  FAIL [${r.profile}] ${r.route}: ${r.failures.join('; ')}`);
    }
  }

  process.exit(failedRuns === 0 && results.length > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[visual-audit] Fatal error:', err);
  process.exit(1);
});
