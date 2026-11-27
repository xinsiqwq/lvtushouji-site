import type { ConsoleMessage, Locator, Page } from '@playwright/test';

export interface ErrorListenerHandle {
  consoleErrors: string[];
  pageErrors: string[];
  assertZeroErrors: () => void;
  clear: () => void;
  detach: () => void;
}

export function attachErrorListeners(page: Page): ErrorListenerHandle {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      const locStr = loc.url ? ` (${loc.url}:${loc.lineNumber ?? 0})` : '';
      consoleErrors.push(`${msg.text()}${locStr}`);
    }
  };

  const onPageError = (err: Error) => {
    pageErrors.push(err.stack || err.message || String(err));
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  return {
    consoleErrors,
    pageErrors,
    assertZeroErrors() {
      const problems: string[] = [];
      if (consoleErrors.length > 0) {
        problems.push(`Console errors (${consoleErrors.length}):\n  - ${consoleErrors.join('\n  - ')}`);
      }
      if (pageErrors.length > 0) {
        problems.push(`Uncaught page errors (${pageErrors.length}):\n  - ${pageErrors.join('\n  - ')}`);
      }
      if (problems.length > 0) {
        throw new Error(problems.join('\n'));
      }
    },
    clear() {
      consoleErrors.length = 0;
      pageErrors.length = 0;
    },
    detach() {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

export interface FontVerificationOptions {
  h1Selector?: string;
  requireH1?: boolean;
  checkLetterSpacing?: boolean;
  expectedFamilies?: string[];
}

export interface FontVerificationResult {
  loadedFamilies: string[];
  h1FontFamily: string | null;
  h1FontWeight: string | null;
  h1FontSizePx: number | null;
  h1LetterSpacingPx: number | null;
}

function normalizeFontFamilyName(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
}

export async function verifySelfHostedFonts(
  page: Page,
  options: FontVerificationOptions = {},
): Promise<FontVerificationResult> {
  const h1Selector = options.h1Selector ?? 'h1';
  const requireH1 = options.requireH1 ?? true;
  const checkLetterSpacing = options.checkLetterSpacing ?? true;
  const checkHanFallback = !(options.expectedFamilies && options.expectedFamilies.length > 0);

  const audit = await page.evaluate(
    async ({ h1Selector: sel, checkHanFallback: shouldCheckHan }) => {
      await document.fonts.ready;

      const loadedFaces = Array.from(document.fonts)
        .filter((f) => f.status === 'loaded')
        .map((f) => ({
          family: f.family,
          weight: f.weight,
          style: f.style,
        }));

      const h1 = document.querySelector(sel);
      if (!h1) {
        return {
          loadedFaces,
          hasH1: false,
          h1FontFamily: null,
          h1FontWeight: null,
          h1FontSizePx: null,
          h1LetterSpacingPx: null,
          h1FontCheckPassed: false,
          h1HanSample: '',
          hanFontCheckPassed: true,
          hanFallbackDetected: false,
        };
      }

      const cs = getComputedStyle(h1);
      const firstStackItem = cs.fontFamily.split(',')[0] ?? '';
      const fontSizePx = Number.parseFloat(cs.fontSize);
      const letterSpacingPx =
        cs.letterSpacing === 'normal' ? 0 : Number.parseFloat(cs.letterSpacing);

      let h1FontCheckPassed = false;
      try {
        h1FontCheckPassed = document.fonts.check(`${cs.fontWeight} ${cs.fontSize} ${firstStackItem}`);
      } catch {
        h1FontCheckPassed = false;
      }

      const h1Text = (h1.textContent || '').trim();
      const hanMatches = h1Text.match(/\p{Script=Han}/gu) ?? [];
      const h1HanSample = Array.from(new Set(hanMatches)).slice(0, 12).join('');
      let hanFontCheckPassed = true;
      let hanFallbackDetected = false;

      if (shouldCheckHan && h1HanSample.length > 0) {
        const loadedNormSet = new Set(
          loadedFaces.map((f) => f.family.trim().replace(/^["']|["']$/g, '').toLowerCase()),
        );
        const rawStackItems = cs.fontFamily
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const loadedStackItems = rawStackItems.filter((item) =>
          loadedNormSet.has(item.replace(/^["']|["']$/g, '').toLowerCase()),
        );

        if (loadedStackItems.length === 0) {
          hanFontCheckPassed = false;
        } else {
          const loadedStackCss = loadedStackItems.join(', ');
          try {
            hanFontCheckPassed = document.fonts.check(
              `${cs.fontWeight} ${cs.fontSize} ${loadedStackCss}`,
              h1HanSample,
            );
          } catch {
            hanFontCheckPassed = false;
          }

          const renderSample = (fontSpec: string): Uint8ClampedArray | null => {
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

          const samePixels = (a: Uint8ClampedArray | null, b: Uint8ClampedArray | null): boolean => {
            if (!a || !b || a.length !== b.length) return false;
            for (let i = 0; i < a.length; i += 1) {
              if (a[i] !== b[i]) return false;
            }
            return true;
          };

          const sampleSize = '36px';
          const pxSerif = renderSample(`${cs.fontWeight} ${sampleSize} serif`);
          const pxSans = renderSample(`${cs.fontWeight} ${sampleSize} sans-serif`);
          const pxMono = renderSample(`${cs.fontWeight} ${sampleSize} monospace`);
          const pxLoadedSerif = renderSample(`${cs.fontWeight} ${sampleSize} ${loadedStackCss}, serif`);
          const pxLoadedSans = renderSample(`${cs.fontWeight} ${sampleSize} ${loadedStackCss}, sans-serif`);
          const pxLoadedMono = renderSample(`${cs.fontWeight} ${sampleSize} ${loadedStackCss}, monospace`);

          const genericFallbacksDiffer = !samePixels(pxSerif, pxSans) || !samePixels(pxSerif, pxMono);
          if (
            genericFallbacksDiffer &&
            samePixels(pxLoadedSerif, pxSerif) &&
            samePixels(pxLoadedSans, pxSans) &&
            samePixels(pxLoadedMono, pxMono)
          ) {
            hanFallbackDetected = true;
          }
        }
      }

      return {
        loadedFaces,
        hasH1: true,
        h1FontFamily: cs.fontFamily,
        h1FontWeight: cs.fontWeight,
        h1FontSizePx: Number.isFinite(fontSizePx) ? fontSizePx : null,
        h1LetterSpacingPx: Number.isFinite(letterSpacingPx) ? letterSpacingPx : null,
        h1FontCheckPassed,
        h1HanSample,
        hanFontCheckPassed,
        hanFallbackDetected,
      };
    },
    { h1Selector, checkHanFallback },
  );

  const loadedFamilies = Array.from(
    new Set(audit.loadedFaces.map((f) => f.family.replace(/^["']|["']$/g, ''))),
  );

  if (loadedFamilies.length === 0) {
    throw new Error('Expected at least one self-hosted @font-face to be loaded in document.fonts, found 0.');
  }

  if (options.expectedFamilies && options.expectedFamilies.length > 0) {
    const loadedNormalized = new Set(loadedFamilies.map(normalizeFontFamilyName));
    const missing = options.expectedFamilies.filter(
      (fam) => !loadedNormalized.has(normalizeFontFamilyName(fam)),
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing expected loaded font families: [${missing.join(', ')}]. Loaded: [${loadedFamilies.join(', ')}]`,
      );
    }
  }

  if (requireH1 && !audit.hasH1) {
    throw new Error(`Expected heading element matching '${h1Selector}' for font verification, but none was found.`);
  }

  if (audit.hasH1 && audit.h1FontFamily !== null) {
    const stack = audit.h1FontFamily.split(',').map(normalizeFontFamilyName).filter(Boolean);
    const primary = stack[0] ?? '';

    if (
      primary.includes('microsoft yahei') ||
      primary.includes('微软雅黑') ||
      primary.includes('simsun') ||
      primary.includes('arial')
    ) {
      throw new Error(`H1 primary font resolved to prohibited system fallback '${audit.h1FontFamily}'.`);
    }

    const loadedNormalized = new Set(loadedFamilies.map(normalizeFontFamilyName));
    const matchedLoaded = stack.some((item) => loadedNormalized.has(item));
    if (!matchedLoaded || !audit.h1FontCheckPassed) {
      throw new Error(
        `H1 font-family '${audit.h1FontFamily}' did not resolve to any loaded self-hosted WOFF2 font (${loadedFamilies.join(', ')}).`,
      );
    }
    if (checkHanFallback && audit.h1HanSample.length > 0 && (!audit.hanFontCheckPassed || audit.hanFallbackDetected)) {
      throw new Error(
        `H1 contains Han characters ("${audit.h1HanSample}") that fell back to system fonts instead of a loaded self-hosted WOFF2 font (stack: '${audit.h1FontFamily}', loaded: [${loadedFamilies.join(', ')}]).`,
      );
    }

    if (audit.h1FontWeight !== '500') {
      throw new Error(`Expected H1 font-weight to be '500', got '${audit.h1FontWeight}'.`);
    }

    if (
      checkLetterSpacing &&
      audit.h1FontSizePx !== null &&
      audit.h1LetterSpacingPx !== null
    ) {
      const expectedPx = -0.03 * audit.h1FontSizePx;
      if (Math.abs(audit.h1LetterSpacingPx - expectedPx) > 0.75) {
        throw new Error(
          `Expected H1 letter-spacing ~ -0.03em (${expectedPx.toFixed(2)}px), got ${audit.h1LetterSpacingPx.toFixed(2)}px.`,
        );
      }
    }
  }

  return {
    loadedFamilies,
    h1FontFamily: audit.h1FontFamily,
    h1FontWeight: audit.h1FontWeight,
    h1FontSizePx: audit.h1FontSizePx,
    h1LetterSpacingPx: audit.h1LetterSpacingPx,
  };
}

export interface AntiAiTasteReport {
  violations: string[];
}

export async function scanAntiAiTaste(page: Page): Promise<AntiAiTasteReport> {
  const report = await page.evaluate(async () => {
    const violations: string[] = [];

    const textSources: string[] = [];
    if (document.body) {
      textSources.push(document.body.innerText || '');
    }
    const attrElements = document.querySelectorAll('[aria-label], [title], [placeholder]');
    for (const el of attrElements) {
      for (const attr of ['aria-label', 'title', 'placeholder']) {
        const val = el.getAttribute(attr);
        if (val) textSources.push(val);
      }
    }

    const combinedText = textSources.join('\n');

    // 1. Banned AI decorative emoji/symbols
    const symbolMatch = combinedText.match(/[✦✨🚀]/gu);
    if (symbolMatch) {
      violations.push(`Banned decorative symbol(s) found: ${Array.from(new Set(symbolMatch)).join(' ')}`);
    }

    // 2. Numbered monospace kickers (e.g. "01 / ATLAS", "02 / VAULT")
    const kickerMatch = combinedText.match(/\b0[1-9]\s*\/\s*[A-Z]{2,}\b/g);
    if (kickerMatch) {
      violations.push(`Banned numbered kicker(s) found: ${Array.from(new Set(kickerMatch)).join(', ')}`);
    }

    // 3. Sci-fi jargon redlines
    for (const bannedPhrase of ['密钥解封', '时空遥测协议', '量子传输']) {
      if (combinedText.includes(bannedPhrase)) {
        violations.push(`Banned sci-fi copy found: "${bannedPhrase}"`);
      }
    }

    // 4. Tacky #07090D (rgb(7, 9, 13)) background check + neon/spotlight borders
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const cs = getComputedStyle(el);
      if (cs.backgroundColor === 'rgb(7, 9, 13)') {
        violations.push(`Prohibited #07090D background on <${el.tagName.toLowerCase()}>`);
        break;
      }
    }

    // 5. Fullscreen SVG liquid-glass displacement filter check
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const viewportArea = vw * vh;
    const displacementFilterIds = new Set<string>();
    let hasFullscreenFeDisplacement = false;

    for (const disp of document.querySelectorAll('feDisplacementMap')) {
      const filter = disp.closest('filter');
      if (filter && filter.id) {
        displacementFilterIds.add(filter.id);
      }
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
      const extractFilterHashIds = (filterValue: string): string[] => {
        if (!filterValue || filterValue === 'none') return [];
        const ids: string[] = [];
        const urlRegex = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
        let match: RegExpExecArray | null;
        while ((match = urlRegex.exec(filterValue)) !== null) {
          const rawUrl = match[2]?.trim() ?? '';
          const hashIdx = rawUrl.indexOf('#');
          if (hashIdx >= 0) {
            const frag = rawUrl.slice(hashIdx + 1);
            if (frag) {
              ids.push(frag);
              try {
                const decoded = decodeURIComponent(frag);
                if (decoded !== frag) ids.push(decoded);
              } catch {
                // ignore malformed URI escape
              }
            }
          }
        }
        return ids;
      };

      for (const el of allElements) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number.parseFloat(cs.opacity) <= 0) {
          continue;
        }
        const rect = el.getBoundingClientRect();
        const interW = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
        const interH = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
        if (interW * interH < viewportArea * 0.5) {
          continue;
        }
        const backdropFilter = (cs as CSSStyleDeclaration & { backdropFilter?: string }).backdropFilter ?? '';
        const referencedIds = [
          ...extractFilterHashIds(cs.filter),
          ...extractFilterHashIds(backdropFilter),
        ];
        if (referencedIds.some((id) => displacementFilterIds.has(id))) {
          hasFullscreenFeDisplacement = true;
          break;
        }
      }
    }

    if (hasFullscreenFeDisplacement) {
      violations.push('Prohibited fullscreen SVG <feDisplacementMap> liquid-glass filter detected');
    }

    // 6. Particle canvas must NOT be a 2D lineTo fake particle canvas.
    // Wait one animation frame first so lazy WebGL initialization can claim its context before probing.
    await new Promise<void>((resolve) => {
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
      const role = `${canvas.className} ${canvas.id} ${canvas.getAttribute('data-testid') || ''} ${canvas.getAttribute('aria-label') || ''}`.toLowerCase();
      if (role.includes('star') || role.includes('bokeh') || role.includes('ring') || role.includes('particle')) {
        // If WebGL/WebGL2 context was already initialized on this canvas, getContext('2d') returns null.
        const ctx2d = canvas.getContext('2d');
        if (ctx2d !== null) {
          violations.push(`Particle canvas <canvas class="${canvas.className}"> initialized with 2D context instead of WebGL GLSL`);
        }
      }
    }

    return { violations };
  });

  if (report.violations.length > 0) {
    throw new Error(`Anti-AI-taste scan failed:\n- ${report.violations.join('\n- ')}`);
  }

  return report;
}

function parseRgbColor(cssColor: string): [number, number, number] | null {
  const match = cssColor.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function isPage(input: Locator | Page): input is Page {
  return typeof (input as Page).goto === 'function' && typeof (input as Page).mainFrame === 'function';
}

export async function assertOnlyDarkSurface(
  locatorOrPage: Locator | Page,
  expectedBg = 'rgb(11, 12, 14)',
): Promise<{ colorScheme: string; backgroundColor: string; color: string; luminance: number }> {
  const target: Locator = isPage(locatorOrPage)
    ? locatorOrPage.locator('[data-only-dark], dialog[open], .observatory-viewport').first()
    : locatorOrPage;

  const count = await target.count();
  if (count === 0) {
    throw new Error('assertOnlyDarkSurface: target element was not found in the DOM.');
  }

  const styles = await target.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      colorScheme: cs.colorScheme,
      backgroundColor: cs.backgroundColor,
      color: cs.color,
    };
  });

  // Chromium serializes `color-scheme: only dark` as `"dark only"` per CSSOM spec.
  const schemeTokens = styles.colorScheme.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const isOnlyDark =
    schemeTokens.includes('dark') &&
    schemeTokens.includes('only') &&
    !schemeTokens.includes('light');

  if (!isOnlyDark) {
    throw new Error(
      `Expected computed color-scheme to enforce 'only dark' ('dark only'), got '${styles.colorScheme}'.`,
    );
  }

  if (styles.backgroundColor !== expectedBg) {
    throw new Error(
      `Expected only-dark surface backgroundColor '${expectedBg}', got '${styles.backgroundColor}'.`,
    );
  }

  const rgb = parseRgbColor(styles.color);
  if (!rgb) {
    throw new Error(`Could not parse computed text color '${styles.color}'.`);
  }
  const luminance = relativeLuminance(rgb);
  if (luminance <= 0.35) {
    throw new Error(
      `Expected readable light foreground color on #0B0C0E surface (luminance > 0.35), got '${styles.color}' (luminance ${luminance.toFixed(3)}).`,
    );
  }

  return {
    ...styles,
    luminance,
  };
}

export async function assertImageAspectRatioPreserved(
  imgLocator: Locator,
  tolerance = 0.03,
): Promise<{ naturalRatio: number; renderedRatio: number; relativeError: number }> {
  await imgLocator.waitFor({ state: 'visible', timeout: 10_000 });

  const dims = await imgLocator.evaluate(async (node) => {
    const img = node as HTMLImageElement;
    if (!img.complete) {
      await new Promise<void>((resolve, reject) => {
        const onLoad = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(`Image failed to load: ${img.currentSrc || img.src}`));
        };
        const cleanup = () => {
          img.removeEventListener('load', onLoad);
          img.removeEventListener('error', onError);
        };
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onError);
      });
    }
    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    };
  });

  if (dims.naturalWidth <= 0 || dims.naturalHeight <= 0) {
    throw new Error(
      `Image has invalid natural dimensions (${dims.naturalWidth}x${dims.naturalHeight}).`,
    );
  }

  const box = await imgLocator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error('Image boundingBox is null or has zero dimensions.');
  }

  const naturalRatio = dims.naturalWidth / dims.naturalHeight;
  const renderedRatio = box.width / box.height;
  const relativeError = Math.abs(naturalRatio - renderedRatio) / naturalRatio;

  if (relativeError > tolerance) {
    throw new Error(
      `Image aspect ratio distorted: natural ${dims.naturalWidth}x${dims.naturalHeight} (${naturalRatio.toFixed(4)}) vs rendered ${box.width.toFixed(1)}x${box.height.toFixed(1)} (${renderedRatio.toFixed(4)}), relative error ${(relativeError * 100).toFixed(2)}% > ${(tolerance * 100).toFixed(2)}%.`,
    );
  }

  return {
    naturalRatio,
    renderedRatio,
    relativeError,
  };
}
