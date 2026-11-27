import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
} from 'react';
import {
  ArrowLeftRight,
  Check,
  CheckCircle2,
  Copy,
  Image as ImageIcon,
  Palette,
  Pipette,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  XCircle,
} from 'lucide-react';

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface OklchColor {
  l: number; // 0..1
  c: number; // 0..~0.4
  h: number; // 0..360
}

interface PaletteSwatch {
  rgb: RgbColor;
  hex: string;
  rgbCss: string;
  hslCss: string;
  oklchCss: string;
  sharePct: number;
}

interface ContrastPreset {
  label: string;
  note: string;
  fg: string;
  bg: string;
}

const SAMPLE_IMAGES: ReadonlyArray<{ label: string; url: string }> = [
  { label: '雪山', url: '/demo/mountain.jpg' },
  { label: '高原湖', url: '/demo/lake.jpg' },
  { label: '林间', url: '/demo/forest.jpg' },
  { label: '公路', url: '/demo/road.jpg' },
];

const SITE_PRESETS: ReadonlyArray<ContrastPreset> = [
  { label: '日光纸感', note: '骨白纸 × 墨黑正文', fg: '#1F1F1F', bg: '#FAF8F4' },
  { label: '深夜暗房', note: '暗房底 × 浅灰正文', fg: '#E3E3E3', bg: '#131314' },
  { label: '骨白邮戳', note: '骨白纸 × 暖赭印泥', fg: '#9A5B42', bg: '#FAF8F4' },
  { label: '谷歌蓝链', note: '纯白页 × 克制蓝', fg: '#1A73E8', bg: '#FFFFFF' },
  { label: '深空星穹', note: '观星暗底 × 极光蓝', fg: '#8AB4F8', bg: '#0B0C0E' },
];

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex({ r, g, b }: RgbColor): string {
  const toHex = (v: number) => clampByte(v).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function parseHexToRgb(input: string): RgbColor | null {
  const cleaned = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return {
      r: parseInt(cleaned[0] + cleaned[0], 16),
      g: parseInt(cleaned[1] + cleaned[1], 16),
      b: parseInt(cleaned[2] + cleaned[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return {
      r: parseInt(cleaned.slice(0, 2), 16),
      g: parseInt(cleaned.slice(2, 4), 16),
      b: parseInt(cleaned.slice(4, 6), 16),
    };
  }
  return null;
}

function rgbToHsl({ r, g, b }: RgbColor): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta > 1e-6) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === rn) {
      h = 60 * (((gn - bn) / delta) % 6);
    } else if (max === gn) {
      h = 60 * ((bn - rn) / delta + 2);
    } else {
      h = 60 * ((rn - gn) / delta + 4);
    }
    if (h < 0) h += 360;
  }

  return {
    h: Math.round(h) % 360,
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

function srgbChannelToLinear(channel255: number): number {
  const c = Math.max(0, Math.min(1, channel255 / 255));
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Exact WCAG 2.1 relative luminance (IEC 61966-2-1 sRGB linearization). */
function relativeLuminance(rgb: RgbColor): number {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Exact WCAG 2.1 contrast ratio in [1, 21]. */
function wcagContrastRatio(a: RgbColor, b: RgbColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Exact Björn Ottosson sRGB -> OKLab -> OKLCH conversion. */
function rgbToOklch(rgb: RgbColor): OklchColor {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  const L = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const A = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const B = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;

  const C = Math.hypot(A, B);
  const H = C < 1e-4 ? 0 : (((Math.atan2(B, A) * 180) / Math.PI) + 360) % 360;

  return {
    l: Math.max(0, Math.min(1, L)),
    c: Math.max(0, C),
    h: H,
  };
}

function formatColorFormats(rgb: RgbColor): {
  hex: string;
  rgbCss: string;
  hslCss: string;
  oklchCss: string;
} {
  const hex = rgbToHex(rgb);
  const rgbCss = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  const hsl = rgbToHsl(rgb);
  const hslCss = `hsl(${hsl.h}deg ${hsl.s}% ${hsl.l}%)`;
  const oklch = rgbToOklch(rgb);
  const oklchCss = `oklch(${oklch.l.toFixed(3)} ${oklch.c.toFixed(3)} ${oklch.h.toFixed(1)})`;
  return { hex, rgbCss, hslCss, oklchCss };
}

function readableInkOn(bg: RgbColor): string {
  const white: RgbColor = { r: 255, g: 255, b: 255 };
  const dark: RgbColor = { r: 24, g: 26, b: 29 };
  return wcagContrastRatio(white, bg) >= wcagContrastRatio(dark, bg) ? '#FFFFFF' : '#181A1D';
}

/** Shifts foreground toward black or white minimally until contrast >= targetRatio (default 4.55). */
function suggestCompliantForeground(fg: RgbColor, bg: RgbColor, targetRatio = 4.55): string | null {
  if (wcagContrastRatio(fg, bg) >= targetRatio) return null;

  const bgLum = relativeLuminance(bg);
  // Pick the direction (black vs white) that can achieve higher maximum contrast
  const toDark: RgbColor = { r: 15, g: 16, b: 18 };
  const toLight: RgbColor = { r: 250, g: 250, b: 248 };
  const darkMax = wcagContrastRatio(toDark, bg);
  const lightMax = wcagContrastRatio(toLight, bg);
  const target = bgLum > 0.18 && darkMax >= targetRatio ? toDark : lightMax >= darkMax ? toLight : toDark;

  if (wcagContrastRatio(target, bg) < targetRatio) {
    return rgbToHex(target);
  }

  let lo = 0;
  let hi = 1;
  let best = target;
  for (let step = 0; step < 18; step += 1) {
    const mid = (lo + hi) / 2;
    const candidate: RgbColor = {
      r: clampByte(fg.r + (target.r - fg.r) * mid),
      g: clampByte(fg.g + (target.g - fg.g) * mid),
      b: clampByte(fg.b + (target.b - fg.b) * mid),
    };
    if (wcagContrastRatio(candidate, bg) >= targetRatio) {
      best = candidate;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return rgbToHex(best);
}

/** Redmean perceptual color distance squared — fast, smooth, and great for clustering. */
function perceptualDistSq(a: RgbColor, b: RgbColor): number {
  const rMean = (a.r + b.r) * 0.5;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return (
    (2 + rMean / 256) * dr * dr +
    4 * dg * dg +
    (2 + (255 - rMean) / 256) * db * db
  );
}

interface ColorBox {
  pixels: RgbColor[];
}

function boxRange(pixels: RgbColor[]): { channel: 'r' | 'g' | 'b'; span: number } {
  let minR = 255,
    maxR = 0,
    minG = 255,
    maxG = 0,
    minB = 255,
    maxB = 0;
  for (const p of pixels) {
    if (p.r < minR) minR = p.r;
    if (p.r > maxR) maxR = p.r;
    if (p.g < minG) minG = p.g;
    if (p.g > maxG) maxG = p.g;
    if (p.b < minB) minB = p.b;
    if (p.b > maxB) maxB = p.b;
  }
  const spanR = maxR - minR;
  const spanG = maxG - minG;
  const spanB = maxB - minB;
  if (spanR >= spanG && spanR >= spanB) return { channel: 'r', span: spanR };
  if (spanG >= spanR && spanG >= spanB) return { channel: 'g', span: spanG };
  return { channel: 'b', span: spanB };
}

function averageColor(pixels: RgbColor[]): RgbColor {
  if (pixels.length === 0) return { r: 128, g: 128, b: 128 };
  let sr = 0,
    sg = 0,
    sb = 0;
  for (const p of pixels) {
    sr += p.r;
    sg += p.g;
    sb += p.b;
  }
  const n = pixels.length;
  return { r: clampByte(sr / n), g: clampByte(sg / n), b: clampByte(sb / n) };
}

/**
 * Extracts 6 perceptually distinct dominant palette swatches via Median-Cut seeding + K-Means refinement.
 */
function extractDistinctPalette(img: HTMLImageElement, targetCount = 6): PaletteSwatch[] {
  const natW = img.naturalWidth || img.width;
  const natH = img.naturalHeight || img.height;
  if (natW <= 0 || natH <= 0) return [];

  const maxEdge = 128;
  const scale = Math.min(1, maxEdge / Math.max(natW, natH));
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const pixels: RgbColor[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  }
  if (pixels.length === 0) return [];

  // Stage 1: Median-Cut into up to 16 candidate buckets
  const boxes: ColorBox[] = [{ pixels }];
  const seedLimit = 16;
  while (boxes.length < seedLimit) {
    let bestIdx = -1;
    let bestScore = 0;
    let bestChannel: 'r' | 'g' | 'b' = 'r';

    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.pixels.length < 4) continue;
      const { channel, span } = boxRange(box.pixels);
      if (span <= 4) continue;
      const score = span * Math.sqrt(box.pixels.length);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        bestChannel = channel;
      }
    }

    if (bestIdx === -1) break;
    const target = boxes.splice(bestIdx, 1)[0];
    target.pixels.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(target.pixels.length / 2);
    boxes.push({ pixels: target.pixels.slice(0, mid) });
    boxes.push({ pixels: target.pixels.slice(mid) });
  }

  // Stage 2: Select up to `targetCount` distinct seeds balancing dominance and perceptual distance
  const candidates = boxes
    .filter((b) => b.pixels.length > 0)
    .map((b) => ({ color: averageColor(b.pixels), count: b.pixels.length }))
    .sort((a, b) => b.count - a.count);

  const centroids: RgbColor[] = [];
  if (candidates.length > 0) {
    centroids.push(candidates[0].color);
  }
  while (centroids.length < targetCount && centroids.length < candidates.length) {
    let bestCand: { color: RgbColor; count: number } | null = null;
    let bestUtility = -1;

    for (const cand of candidates) {
      let minDistSq = Infinity;
      for (const chosen of centroids) {
        const d = perceptualDistSq(cand.color, chosen);
        if (d < minDistSq) minDistSq = d;
      }
      if (minDistSq < 120) continue; // Skip near-duplicate seed
      const utility = Math.sqrt(minDistSq) * Math.pow(cand.count, 0.32);
      if (utility > bestUtility) {
        bestUtility = utility;
        bestCand = cand;
      }
    }

    if (!bestCand) break;
    centroids.push(bestCand.color);
  }

  if (centroids.length === 0) return [];

  // Stage 3: 6 iterations of K-Means refinement over sampled pixels
  const k = centroids.length;
  let counts = new Array<number>(k).fill(0);

  for (let iter = 0; iter < 6; iter += 1) {
    const sumR = new Array<number>(k).fill(0);
    const sumG = new Array<number>(k).fill(0);
    const sumB = new Array<number>(k).fill(0);
    counts = new Array<number>(k).fill(0);

    for (let i = 0; i < pixels.length; i += 1) {
      const p = pixels[i];
      let bestK = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const d = perceptualDistSq(p, centroids[c]);
        if (d < bestD) {
          bestD = d;
          bestK = c;
        }
      }
      sumR[bestK] += p.r;
      sumG[bestK] += p.g;
      sumB[bestK] += p.b;
      counts[bestK] += 1;
    }

    for (let c = 0; c < k; c += 1) {
      if (counts[c] > 0) {
        centroids[c] = {
          r: clampByte(sumR[c] / counts[c]),
          g: clampByte(sumG[c] / counts[c]),
          b: clampByte(sumB[c] / counts[c]),
        };
      }
    }
  }

  const totalPixels = counts.reduce((acc, n) => acc + n, 0) || 1;
  const swatches: PaletteSwatch[] = [];
  const seenHex = new Set<string>();

  const paired = centroids
    .map((rgb, idx) => ({ rgb, count: counts[idx] }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);

  for (const item of paired) {
    const formats = formatColorFormats(item.rgb);
    if (seenHex.has(formats.hex)) continue;
    seenHex.add(formats.hex);
    swatches.push({
      rgb: item.rgb,
      ...formats,
      sharePct: (item.count / totalPixels) * 100,
    });
  }

  return swatches.slice(0, targetCount);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('影像解码失败。'));
    img.src = src;
  });
}

function ratioToScalePercent(ratio: number): number {
  const clamped = Math.max(1, Math.min(21, ratio));
  return (Math.log(clamped) / Math.log(21)) * 100;
}

export default function ColorContrastTool() {
  // Object URL registry for clean revocation on unmount
  const ownedUrlsRef = useRef<Set<string>>(new Set());
  const trackUrl = useCallback((url: string) => {
    ownedUrlsRef.current.add(url);
    return url;
  }, []);
  const releaseUrl = useCallback((url: string | undefined) => {
    if (!url) return;
    if (ownedUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      ownedUrlsRef.current.delete(url);
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const url of ownedUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      ownedUrlsRef.current.clear();
    };
  }, []);

  // ===================== SECTION A: Image Optical Palette =====================
  const [imageSrc, setImageSrc] = useState<string>('');
  const [imageLabel, setImageLabel] = useState<string>('');
  const [isOwnedSrc, setIsOwnedSrc] = useState<boolean>(false);
  const [swatches, setSwatches] = useState<PaletteSwatch[]>([]);
  const [pickedPixel, setPickedPixel] = useState<PaletteSwatch | null>(null);
  const [paletteLoading, setPaletteLoading] = useState<boolean>(false);
  const [paletteError, setPaletteError] = useState<string>('');
  const [isDraggingImg, setIsDraggingImg] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pickerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentOwnedUrlRef = useRef<string | undefined>(undefined);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const copyValue = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for restricted clipboard contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        ta.remove();
      }
    }
    setCopiedKey(key);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopiedKey(''), 1500);
  }, []);

  const analyzeImageSource = useCallback(
    async (src: string, label: string, owned: boolean) => {
      setPaletteLoading(true);
      setPaletteError('');
      setPickedPixel(null);
      try {
        const img = await loadImage(src);
        const extracted = extractDistinctPalette(img, 6);

        // Cache scaled bitmap on hidden picker canvas for instant click-eyedropper
        const pCanvas = document.createElement('canvas');
        const maxPickEdge = 640;
        const scale = Math.min(1, maxPickEdge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        pCanvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
        pCanvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
        const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
        if (pCtx) {
          pCtx.drawImage(img, 0, 0, pCanvas.width, pCanvas.height);
          pickerCanvasRef.current = pCanvas;
        }

        if (currentOwnedUrlRef.current && currentOwnedUrlRef.current !== src) {
          releaseUrl(currentOwnedUrlRef.current);
        }
        currentOwnedUrlRef.current = owned ? src : undefined;

        setImageSrc(src);
        setImageLabel(label);
        setIsOwnedSrc(owned);
        setSwatches(extracted);
      } catch {
        if (owned) releaseUrl(src);
        setPaletteError('无法读取或解析该影像，请更换 JPG / PNG / WebP 图片重试。');
      } finally {
        setPaletteLoading(false);
      }
    },
    [releaseUrl],
  );

  // Auto-load local sample photo on mount so the 6-color optical palette is immediately live
  useEffect(() => {
    void analyzeImageSource(SAMPLE_IMAGES[0].url, `示例：${SAMPLE_IMAGES[0].label}`, false);
  }, [analyzeImageSource]);

  const handleFilePick = (file: File) => {
    if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(file.name)) {
      setPaletteError('请选取本地影像文件（JPG / PNG / WebP）。');
      return;
    }
    const objUrl = trackUrl(URL.createObjectURL(file));
    void analyzeImageSource(objUrl, file.name, true);
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) handleFilePick(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingImg(false);
    const file = event.dataTransfer.files?.[0];
    if (file) handleFilePick(file);
  };

  const handleImageEyedrop = (event: MouseEvent<HTMLImageElement>) => {
    const canvas = pickerCanvasRef.current;
    if (!canvas) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const nx = Math.max(0, Math.min(0.999, (event.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(0.999, (event.clientY - rect.top) / rect.height));
    const px = Math.floor(nx * canvas.width);
    const py = Math.floor(ny * canvas.height);

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const pixel = ctx.getImageData(px, py, 1, 1).data;
    const rgb: RgbColor = { r: pixel[0], g: pixel[1], b: pixel[2] };
    setPickedPixel({
      rgb,
      ...formatColorFormats(rgb),
      sharePct: 0,
    });
  };

  // ===================== SECTION B: WCAG Day/Night Contrast Ruler =====================
  const [fgHex, setFgHex] = useState<string>('#1F1F1F');
  const [bgHex, setBgHex] = useState<string>('#FAF8F4');
  const [fgInput, setFgInput] = useState<string>('#1F1F1F');
  const [bgInput, setBgInput] = useState<string>('#FAF8F4');

  const applyFg = useCallback((hex: string) => {
    const parsed = parseHexToRgb(hex);
    if (!parsed) return;
    const normalized = rgbToHex(parsed);
    setFgHex(normalized);
    setFgInput(normalized);
  }, []);

  const applyBg = useCallback((hex: string) => {
    const parsed = parseHexToRgb(hex);
    if (!parsed) return;
    const normalized = rgbToHex(parsed);
    setBgHex(normalized);
    setBgInput(normalized);
  }, []);

  const swapColors = () => {
    const nextFg = bgHex;
    const nextBg = fgHex;
    setFgHex(nextFg);
    setFgInput(nextFg);
    setBgHex(nextBg);
    setBgInput(nextBg);
  };

  const fgRgb = useMemo(() => parseHexToRgb(fgHex) ?? { r: 31, g: 31, b: 31 }, [fgHex]);
  const bgRgb = useMemo(() => parseHexToRgb(bgHex) ?? { r: 250, g: 248, b: 244 }, [bgHex]);
  const fgFormats = useMemo(() => formatColorFormats(fgRgb), [fgRgb]);
  const bgFormats = useMemo(() => formatColorFormats(bgRgb), [bgRgb]);

  const contrast = useMemo(() => {
    const fgLum = relativeLuminance(fgRgb);
    const bgLum = relativeLuminance(bgRgb);
    const ratio = wcagContrastRatio(fgRgb, bgRgb);
    return {
      fgLum,
      bgLum,
      ratio,
      aaNormal: ratio >= 4.5,
      aaLarge: ratio >= 3.0,
      aaaNormal: ratio >= 7.0,
      aaaLarge: ratio >= 4.5,
      suggestedFg: suggestCompliantForeground(fgRgb, bgRgb, 4.55),
    };
  }, [fgRgb, bgRgb]);

  const handleHexTextChange = (target: 'fg' | 'bg', raw: string) => {
    if (target === 'fg') {
      setFgInput(raw);
      const parsed = parseHexToRgb(raw);
      if (parsed) setFgHex(rgbToHex(parsed));
    } else {
      setBgInput(raw);
      const parsed = parseHexToRgb(raw);
      if (parsed) setBgHex(rgbToHex(parsed));
    }
  };

  const handleHexTextBlur = (target: 'fg' | 'bg') => {
    if (target === 'fg') setFgInput(fgHex);
    else setBgInput(bgHex);
  };

  return (
    <div className="min-w-0 space-y-7 rounded-[24px] border border-hairline bg-surface p-4 sm:p-6">
      {/* ===================== SECTION A: Optical Image Palette ===================== */}
      <section aria-labelledby="optical-palette-heading" className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Palette className="h-4 w-4 text-postmark" aria-hidden="true" />
            <h3 id="optical-palette-heading" className="m-0 text-[16px] font-medium text-ink">
              影像取色板
            </h3>
            <span className="inline-flex items-center gap-1 rounded-full border border-hairline bg-paper px-2.5 py-0.5 text-[11.5px] text-postmark">
              <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>纯本地处理 · 影像永不离开设备</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {SAMPLE_IMAGES.map((sample) => {
              const active = !isOwnedSrc && imageSrc === sample.url;
              return (
                <button
                  key={sample.url}
                  type="button"
                  aria-pressed={active}
                  onClick={() => void analyzeImageSource(sample.url, `示例：${sample.label}`, false)}
                  className={[
                    'rounded-full border px-3 py-1 text-[12px] transition-colors',
                    active
                      ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                      : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                  ].join(' ')}
                >
                  示例：{sample.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="pill-cta-secondary min-h-[32px] px-3.5 text-[12px]"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>上传本地照片</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleInputChange}
              className="sr-only"
            />
          </div>
        </div>

        {/* Image Preview + Color Ribbon */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
          {/* Left: Dropzone & Click-to-Eyedrop Image */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingImg(true);
            }}
            onDragLeave={() => setIsDraggingImg(false)}
            onDrop={handleDrop}
            className={[
              'min-w-0 rounded-[20px] border p-3.5 transition-colors',
              isDraggingImg
                ? 'border-dashed border-accent bg-surface-hover'
                : 'border-hairline bg-paper',
            ].join(' ')}
          >
            {imageSrc ? (
              <div className="space-y-3">
                <div className="relative overflow-hidden rounded-[14px] border border-hairline bg-surface">
                  <img
                    src={imageSrc}
                    alt={imageLabel || '取色样本影像'}
                    onClick={handleImageEyedrop}
                    className="block max-h-[290px] w-full cursor-crosshair object-contain"
                  />
                </div>

                {/* Proportional Optical Film Strip */}
                {swatches.length > 0 && (
                  <div
                    aria-label="主色占比色带"
                    className="flex h-4 w-full overflow-hidden rounded-full border border-hairline"
                  >
                    {swatches.map((sw) => (
                      <div
                        key={sw.hex}
                        title={`${sw.hex} (${sw.sharePct.toFixed(1)}%)`}
                        style={{
                          backgroundColor: sw.hex,
                          width: `${Math.max(5, sw.sharePct)}%`,
                        }}
                      />
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-muted">
                  <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                    <ImageIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{imageLabel}</span>
                  </span>
                  <span className="text-[11.5px]">支持拖拽替换任意照片</span>
                </div>

                {/* Single-Pixel Eyedropper Readout */}
                {pickedPixel && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-hairline bg-surface px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="h-7 w-7 shrink-0 rounded-[8px] border border-hairline-strong"
                        style={{ backgroundColor: pickedPixel.hex }}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                          <Pipette className="h-3 w-3" aria-hidden="true" />
                          <span>单点吸色</span>
                        </div>
                        <div className="tabular-nums-mono text-[12.5px] font-medium text-ink">
                          {pickedPixel.hex} · {pickedPixel.oklchCss}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => applyFg(pickedPixel.hex)}
                        className="rounded-full border border-hairline bg-paper px-2.5 py-1 text-[11.5px] text-ink hover:border-hairline-strong"
                      >
                        设为前景
                      </button>
                      <button
                        type="button"
                        onClick={() => applyBg(pickedPixel.hex)}
                        className="rounded-full border border-hairline bg-paper px-2.5 py-1 text-[11.5px] text-ink hover:border-hairline-strong"
                      >
                        设为背景
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-[240px] flex-col items-center justify-center text-center text-[13px] text-ink-muted">
                {paletteLoading ? '正在提取光学主色...' : '拖入图片提取主色板'}
              </div>
            )}

            {paletteError && (
              <div
                role="alert"
                className="mt-3 rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[12.5px] text-postmark"
              >
                {paletteError}
              </div>
            )}
          </div>

          {/* Right: 6 Distinct Swatch Cards */}
          <div className="min-w-0">
            {paletteLoading && swatches.length === 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <div
                    key={n}
                    className="h-[154px] rounded-[18px] border border-hairline bg-paper"
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {swatches.map((sw, idx) => {
                  const inkOnSwatch = readableInkOn(sw.rgb);
                  const copyRows: ReadonlyArray<{ tag: string; val: string; key: string }> = [
                    { tag: 'HEX', val: sw.hex, key: `${idx}-hex` },
                    { tag: 'RGB', val: sw.rgbCss, key: `${idx}-rgb` },
                    { tag: 'HSL', val: sw.hslCss, key: `${idx}-hsl` },
                    { tag: 'OKLCH', val: sw.oklchCss, key: `${idx}-oklch` },
                  ];

                  return (
                    <article
                      key={sw.hex}
                      className="min-w-0 overflow-hidden rounded-[18px] border border-hairline bg-paper"
                    >
                      {/* Swatch Header Bar */}
                      <div
                        className="flex items-end justify-between px-3.5 py-3"
                        style={{ backgroundColor: sw.hex, color: inkOnSwatch }}
                      >
                        <button
                          type="button"
                          onClick={() => void copyValue(sw.hex, `${idx}-hex`)}
                          className="tabular-nums-mono inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-[15px] font-medium text-inherit"
                          title="点击复制 HEX"
                        >
                          <span>{sw.hex}</span>
                          {copiedKey === `${idx}-hex` ? (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Copy className="h-3 w-3 opacity-75" aria-hidden="true" />
                          )}
                        </button>
                        <span className="tabular-nums-mono text-[11.5px] opacity-85">
                          {sw.sharePct.toFixed(1)}%
                        </span>
                      </div>

                      {/* Format Copy List */}
                      <div className="space-y-1 px-3 py-2.5">
                        {copyRows.slice(1).map((row) => {
                          const isCopied = copiedKey === row.key;
                          return (
                            <button
                              key={row.key}
                              type="button"
                              onClick={() => void copyValue(row.val, row.key)}
                              className="flex w-full items-center justify-between gap-2 rounded-[8px] px-1.5 py-1 text-left transition-colors hover:bg-surface"
                            >
                              <span className="tabular-nums-mono shrink-0 text-[10.5px] text-ink-muted">
                                {row.tag}
                              </span>
                              <span className="tabular-nums-mono min-w-0 truncate text-[11.5px] text-ink">
                                {isCopied ? '已复制' : row.val}
                              </span>
                            </button>
                          );
                        })}

                        {/* Quick Apply to Contrast Checker */}
                        <div className="flex gap-1.5 border-t border-hairline pt-2">
                          <button
                            type="button"
                            onClick={() => applyFg(sw.hex)}
                            className="flex-1 rounded-full border border-hairline bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                          >
                            设为前景
                          </button>
                          <button
                            type="button"
                            onClick={() => applyBg(sw.hex)}
                            className="flex-1 rounded-full border border-hairline bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                          >
                            设为背景
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ===================== SECTION B: WCAG Day/Night Contrast Ruler ===================== */}
      <section
        aria-labelledby="wcag-ruler-heading"
        className="space-y-5 border-t border-hairline pt-7"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-accent" aria-hidden="true" />
            <h3 id="wcag-ruler-heading" className="m-0 text-[16px] font-medium text-ink">
              WCAG 2.1 日 / 夜对比度测算尺
            </h3>
          </div>

          {/* Site Token Presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            {SITE_PRESETS.map((preset) => {
              const active =
                fgHex.toUpperCase() === preset.fg.toUpperCase() &&
                bgHex.toUpperCase() === preset.bg.toUpperCase();
              return (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={active}
                  title={preset.note}
                  onClick={() => {
                    applyFg(preset.fg);
                    applyBg(preset.bg);
                  }}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors',
                    active
                      ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                      : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                  ].join(' ')}
                >
                  <span
                    className="inline-flex h-3 w-3 shrink-0 overflow-hidden rounded-full border border-black/20"
                    aria-hidden="true"
                  >
                    <span className="h-full w-1/2" style={{ backgroundColor: preset.bg }} />
                    <span className="h-full w-1/2" style={{ backgroundColor: preset.fg }} />
                  </span>
                  <span>{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Color Pickers + Swap Bar */}
        <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {/* Foreground Card */}
          <div className="min-w-0 rounded-[18px] border border-hairline bg-paper p-4">
            <div className="flex items-center justify-between text-[12px] text-ink-muted">
              <span>前景色 · 文字与图标</span>
              <span className="tabular-nums-mono">相对亮度 Y = {contrast.fgLum.toFixed(4)}</span>
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <label className="relative h-11 w-11 shrink-0 cursor-pointer overflow-hidden rounded-[12px] border border-hairline-strong">
                <input
                  type="color"
                  aria-label="选择前景色"
                  value={fgHex}
                  onChange={(e) => applyFg(e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
                <span className="block h-full w-full" style={{ backgroundColor: fgHex }} />
              </label>
              <input
                type="text"
                aria-label="前景色 HEX"
                value={fgInput}
                onChange={(e) => handleHexTextChange('fg', e.target.value)}
                onBlur={() => handleHexTextBlur('fg')}
                maxLength={7}
                className="tabular-nums-mono min-w-0 flex-1 rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[15px] font-medium uppercase text-ink"
              />
            </div>
            <div className="tabular-nums-mono mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
              <span>{fgFormats.rgbCss}</span>
              <span>{fgFormats.oklchCss}</span>
            </div>
          </div>

          {/* Swap Button */}
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={swapColors}
              aria-label="互换前景色与背景色"
              className="pill-cta-secondary min-h-[42px] px-4 text-[12.5px] md:h-11 md:w-11 md:p-0"
            >
              <ArrowLeftRight className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="md:sr-only">互换前景色与背景色</span>
            </button>
          </div>

          {/* Background Card */}
          <div className="min-w-0 rounded-[18px] border border-hairline bg-paper p-4">
            <div className="flex items-center justify-between text-[12px] text-ink-muted">
              <span>背景色 · 纸面与画布</span>
              <span className="tabular-nums-mono">相对亮度 Y = {contrast.bgLum.toFixed(4)}</span>
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <label className="relative h-11 w-11 shrink-0 cursor-pointer overflow-hidden rounded-[12px] border border-hairline-strong">
                <input
                  type="color"
                  aria-label="选择背景色"
                  value={bgHex}
                  onChange={(e) => applyBg(e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
                <span className="block h-full w-full" style={{ backgroundColor: bgHex }} />
              </label>
              <input
                type="text"
                aria-label="背景色 HEX"
                value={bgInput}
                onChange={(e) => handleHexTextChange('bg', e.target.value)}
                onBlur={() => handleHexTextBlur('bg')}
                maxLength={7}
                className="tabular-nums-mono min-w-0 flex-1 rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[15px] font-medium uppercase text-ink"
              />
            </div>
            <div className="tabular-nums-mono mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
              <span>{bgFormats.rgbCss}</span>
              <span>{bgFormats.oklchCss}</span>
            </div>
          </div>
        </div>

        {/* Contrast Scoreboard + Live Typography Sample Card */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          {/* Left: Ratio Ruler & WCAG Pass/Fail Matrix */}
          <div className="min-w-0 space-y-4 rounded-[20px] border border-hairline bg-paper p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="text-[12px] text-ink-muted">WCAG 2.1 对比度比值</div>
                <div
                  data-testid="wcag-contrast-ratio"
                  className="tabular-nums-mono mt-1 text-[34px] font-medium leading-none tracking-[-0.03em] text-ink sm:text-[40px]"
                >
                  {contrast.ratio.toFixed(2)} : 1
                </div>
              </div>
              <span
                className={[
                  'inline-flex items-center rounded-full border px-3 py-1 text-[12px] font-medium',
                  contrast.aaaNormal
                    ? 'border-accent/35 bg-surface text-accent'
                    : contrast.aaNormal
                      ? 'border-hairline-strong bg-surface text-ink'
                      : 'border-postmark/35 bg-surface text-postmark',
                ].join(' ')}
              >
                {contrast.aaaNormal
                  ? '增强级 AAA 通行'
                  : contrast.aaNormal
                    ? '标准级 AA 通行'
                    : contrast.aaLarge
                      ? '仅大号字达标'
                      : '对比度不足'}
              </span>
            </div>

            {/* Logarithmic Optical Scale Bar */}
            <div className="pt-1">
              <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-surface">
                <div
                  className="h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${ratioToScalePercent(contrast.ratio)}%`,
                    backgroundColor: contrast.aaNormal
                      ? 'var(--color-accent)'
                      : 'var(--color-postmark)',
                  }}
                />
                {[3, 4.5, 7].map((mark) => (
                  <span
                    key={mark}
                    className="absolute top-0 bottom-0 w-px bg-ink/30"
                    style={{ left: `${ratioToScalePercent(mark)}%` }}
                    aria-hidden="true"
                  />
                ))}
              </div>
              <div className="tabular-nums-mono mt-1.5 flex justify-between text-[11px] text-ink-muted">
                <span>1:1</span>
                <span>3.0 (AA 大字)</span>
                <span>4.5 (AA 正文)</span>
                <span>7.0 (AAA)</span>
                <span>21:1</span>
              </div>
            </div>

            {/* 4 WCAG Compliance Pills */}
            <div className="grid grid-cols-2 gap-2.5">
              {(
                [
                  { label: 'AA 正文', req: '≥ 4.5 : 1', pass: contrast.aaNormal },
                  { label: 'AA 大号字', req: '≥ 3.0 : 1', pass: contrast.aaLarge },
                  { label: 'AAA 正文', req: '≥ 7.0 : 1', pass: contrast.aaaNormal },
                  { label: 'AAA 大号字', req: '≥ 4.5 : 1', pass: contrast.aaaLarge },
                ] as const
              ).map((rule) => (
                <div
                  key={rule.label}
                  className="flex items-center justify-between gap-2 rounded-[14px] border border-hairline bg-surface px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium text-ink">{rule.label}</div>
                    <div className="tabular-nums-mono text-[11px] text-ink-muted">{rule.req}</div>
                  </div>
                  <span
                    className={[
                      'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium',
                      rule.pass
                        ? 'bg-accent/12 text-accent'
                        : 'bg-postmark/12 text-postmark',
                    ].join(' ')}
                  >
                    {rule.pass ? (
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{rule.pass ? '通过' : '未通过'}</span>
                  </span>
                </div>
              ))}
            </div>

            {/* Gentle AA Auto-Adjust Suggestion when AA Normal fails */}
            {!contrast.aaNormal && contrast.suggestedFg && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-hairline bg-surface px-3.5 py-2.5 text-[12px]">
                <span className="text-ink-muted">
                  当前正文对比度低于 4.5:1，建议将前景色微调至{' '}
                  <strong className="tabular-nums-mono font-medium text-ink">
                    {contrast.suggestedFg}
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() => contrast.suggestedFg && applyFg(contrast.suggestedFg)}
                  className="rounded-full border border-hairline-strong bg-paper px-3 py-1 text-[11.5px] font-medium text-ink transition-colors hover:bg-surface-hover"
                >
                  一键达标 AA
                </button>
              </div>
            )}
          </div>

          {/* Right: Live Editorial Typography Sample Card */}
          <div
            className="flex min-w-0 flex-col justify-between rounded-[20px] border border-hairline p-6 transition-colors sm:p-7"
            style={{ backgroundColor: bgHex, color: fgHex }}
          >
            <div>
              <div className="tabular-nums-mono text-[12px] opacity-75">
                实时排版可读性样本 · {fgHex} / {bgHex}
              </div>
              <h4 className="mt-2.5 mb-0 text-[22px] font-medium leading-snug tracking-[-0.02em] sm:text-[25px]">
                山谷雾气散开后的第一束日光
              </h4>
              <p className="font-editorial-serif mt-3 mb-0 text-[15px] leading-[1.85] opacity-90">
                在纸感浅底与暗房深底之间切换阅读时，稳定的亮度层级与克制的字重比装饰元素更能减轻长时间凝视屏幕的视觉疲劳。
              </p>
              <p className="tabular-nums-mono mt-3 mb-0 text-[12.5px] opacity-75">
                30.0482° N · 101.9624° E · 35mm · f/4.0 · 1/640s · ISO 160
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-current/15 pt-5">
              <span
                className="inline-flex min-h-[38px] items-center rounded-full px-4 text-[13px] font-medium"
                style={{ backgroundColor: fgHex, color: bgHex }}
              >
                主要操作按钮
              </span>
              <span
                className="inline-flex min-h-[38px] items-center rounded-full border px-4 text-[13px] font-medium"
                style={{ borderColor: fgHex, color: fgHex }}
              >
                次级描边按钮
              </span>
              <span className="ml-auto text-[12.5px] underline underline-offset-4">
                正文内嵌链接
              </span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
