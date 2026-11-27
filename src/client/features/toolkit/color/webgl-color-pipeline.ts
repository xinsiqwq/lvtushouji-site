import { evaluateLut3D, packLut3DTo2DAtlas, resampleLut3D } from './cube-lut';
import {
  DEFAULT_GRADE_PARAMS,
  HSL_BAND_IDS,
  type GradeParams,
  type Lut3D,
} from './grade-types';

export type ColorMediaSource =
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | ImageBitmap;

export interface RenderOptions {
  params: GradeParams;
  baseLutStrength: number;
  creativeLutStrength: number;
  /**
   * Optional Before/After split-screen divider position in [0, 1].
   * Left of `splitPosition` (`uv.x < splitPosition`) renders Original (Before);
   * Right of `splitPosition` (`uv.x >= splitPosition`) renders Graded (After).
   * Omit (`undefined`) for full Graded view.
   */
  splitPosition?: number;
  /** When true, bypasses all LUTs & grading to display raw source pixels. */
  showOriginal?: boolean;
}

export interface HistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  max: number;
}

export interface RenderImageToBlobOptions {
  params: GradeParams;
  baseLut?: Lut3D | null;
  baseLutStrength?: number;
  creativeLut?: Lut3D | null;
  creativeLutStrength?: number;
  mime?: 'image/jpeg' | 'image/png' | 'image/webp';
  quality?: number;
}

const PI = Math.PI;

function clamp(v: number, lo: number, hi: number): number {
  if (v <= lo) return lo;
  if (v >= hi) return hi;
  return v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function srgbToLinearChannel(c: number): number {
  const v = Math.max(0, c);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgbChannel(c: number): number {
  const v = Math.max(0, c);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const l = (maxC + minC) * 0.5;
  const d = maxC - minC;
  if (d < 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - maxC - minC) : d / (maxC + minC);
  let h = 0;
  if (maxC === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  } else if (maxC === g) {
    h = ((b - r) / d + 2) * 60;
  } else {
    h = ((r - g) / d + 4) * 60;
  }
  return [((h % 360) + 360) % 360, clamp01(s), clamp01(l)];
}

function hue2rgb(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 1e-6) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (((h % 360) + 360) % 360) / 360;
  return [
    clamp01(hue2rgb(p, q, hk + 1 / 3)),
    clamp01(hue2rgb(p, q, hk)),
    clamp01(hue2rgb(p, q, hk - 1 / 3)),
  ];
}

function hueToPureRgb(hueDeg: number): [number, number, number] {
  return hslToRgb(hueDeg, 1, 0.5);
}

/**
 * Raised-cosine partition-of-unity weight for an HSL band centered at `centerDeg`
 * between adjacent band centers `prevDeg` and `nextDeg`.
 */
function bandWeight(h: number, prevDeg: number, centerDeg: number, nextDeg: number): number {
  const spanL = (((centerDeg - prevDeg) % 360) + 360) % 360;
  const spanR = (((nextDeg - centerDeg) % 360) + 360) % 360;
  let d = (((h - centerDeg + 540) % 360) - 180);
  if (d < -180) d += 360;
  if (d >= -spanL && d <= 0) {
    const t = 1 + d / spanL;
    return 0.5 - 0.5 * Math.cos(PI * t);
  }
  if (d > 0 && d <= spanR) {
    const t = 1 - d / spanR;
    return 0.5 - 0.5 * Math.cos(PI * t);
  }
  return 0;
}

const HSL_BAND_RING: readonly { id: (typeof HSL_BAND_IDS)[number]; prev: number; center: number; next: number }[] = [
  { id: 'red', prev: 325, center: 0, next: 30 },
  { id: 'orange', prev: 0, center: 30, next: 60 },
  { id: 'yellow', prev: 30, center: 60, next: 120 },
  { id: 'green', prev: 60, center: 120, next: 180 },
  { id: 'cyan', prev: 120, center: 180, next: 235 },
  { id: 'blue', prev: 180, center: 235, next: 280 },
  { id: 'purple', prev: 235, center: 280, next: 325 },
  { id: 'magenta', prev: 280, center: 325, next: 360 },
];

function hasAnyHslAdjustment(params: GradeParams): boolean {
  for (const band of HSL_BAND_IDS) {
    const adj = params.hsl[band];
    if (
      Math.abs(adj.hue) > 1e-5 ||
      Math.abs(adj.sat) > 1e-5 ||
      Math.abs(adj.lum) > 1e-5
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Point-wise CPU color grading matching the WebGL fragment shader math.
 * Used for baking exact 33³ `.cube` exports and Canvas2D fallback rendering.
 * (Spatial effects `vignette` and `grain` are intentionally excluded from point-wise color evaluation.)
 */
export function evaluateGradePixelCpu(
  rIn: number,
  gIn: number,
  bIn: number,
  params: GradeParams = DEFAULT_GRADE_PARAMS,
): [number, number, number] {
  let r = clamp01(rIn);
  let g = clamp01(gIn);
  let b = clamp01(bIn);

  const needLinear =
    Math.abs(params.exposure) > 1e-5 ||
    Math.abs(params.temperature) > 1e-5 ||
    Math.abs(params.tint) > 1e-5;

  if (needLinear) {
    let lr = srgbToLinearChannel(r);
    let lg = srgbToLinearChannel(g);
    let lb = srgbToLinearChannel(b);

    if (Math.abs(params.exposure) > 1e-5) {
      const expScale = Math.pow(2, params.exposure);
      lr *= expScale;
      lg *= expScale;
      lb *= expScale;
    }

    if (Math.abs(params.temperature) > 1e-5 || Math.abs(params.tint) > 1e-5) {
      const t = params.temperature / 100;
      const m = params.tint / 100;
      const gR = Math.pow(2, t * 0.28 + m * 0.08);
      const gG = Math.pow(2, -m * 0.16);
      const gB = Math.pow(2, -t * 0.3 + m * 0.08);
      const lumGain = 0.2126 * gR + 0.7152 * gG + 0.0722 * gB;
      lr *= gR / lumGain;
      lg *= gG / lumGain;
      lb *= gB / lumGain;
    }

    r = linearToSrgbChannel(lr);
    g = linearToSrgbChannel(lg);
    b = linearToSrgbChannel(lb);
  }

  // Tonal zones: shadows, highlights, blacks, whites
  if (
    Math.abs(params.shadows) > 1e-5 ||
    Math.abs(params.highlights) > 1e-5 ||
    Math.abs(params.blacks) > 1e-5 ||
    Math.abs(params.whites) > 1e-5
  ) {
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const l = clamp01(lum);
    const wShadow = (1 - smoothstep(0, 0.55, l)) * (1 - l);
    const wHigh = smoothstep(0.35, 1, l) * l;
    const wBlack = Math.pow(1 - l, 3);
    const wWhite = Math.pow(l, 2.5);

    const delta =
      (params.shadows / 100) * 0.42 * wShadow +
      (params.highlights / 100) * 0.38 * wHigh +
      (params.blacks / 100) * 0.22 * wBlack +
      (params.whites / 100) * 0.22 * wWhite;

    if (Math.abs(delta) > 1e-6) {
      const newLum = Math.max(0, lum + delta);
      const ratio = lum > 1e-4 ? newLum / lum : 0;
      const sr = lum > 1e-4 ? r * ratio : newLum;
      const sg = lum > 1e-4 ? g * ratio : newLum;
      const sb = lum > 1e-4 ? b * ratio : newLum;
      r = mix(r + delta, sr, 0.7);
      g = mix(g + delta, sg, 0.7);
      b = mix(b + delta, sb, 0.7);
    }
  }

  r = clamp01(r);
  g = clamp01(g);
  b = clamp01(b);

  // Smooth S-curve contrast
  if (Math.abs(params.contrast) > 1e-5) {
    const k = params.contrast / 100;
    if (k > 0) {
      const w = k * 0.65;
      r = mix(r, r * r * (3 - 2 * r), w);
      g = mix(g, g * g * (3 - 2 * g), w);
      b = mix(b, b * b * (3 - 2 * b), w);
    } else {
      const s = 1 + k * 0.55;
      r = 0.5 + (r - 0.5) * s;
      g = 0.5 + (g - 0.5) * s;
      b = 0.5 + (b - 0.5) * s;
    }
    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);
  }

  // 8-band selective HSL (runs before global saturation so B&W presets preserve color-filter luminance)
  if (hasAnyHslAdjustment(params)) {
    const [h, s, l] = rgbToHsl(r, g, b);
    const chromaMask = smoothstep(0.02, 0.14, s);
    if (chromaMask > 1e-5) {
      let dH = 0;
      let dS = 0;
      let dL = 0;
      for (const band of HSL_BAND_RING) {
        const w = bandWeight(h, band.prev, band.center, band.next);
        if (w <= 0) continue;
        const adj = params.hsl[band.id];
        dH += w * adj.hue;
        dS += w * adj.sat;
        dL += w * adj.lum;
      }
      const nh = (((h + dH * chromaMask) % 360) + 360) % 360;
      const ns = clamp01(s * Math.max(0, 1 + (dS / 100) * chromaMask));
      const nl = clamp01(
        l + (dL / 100) * 0.35 * chromaMask * (1 - Math.abs(2 * l - 1) * 0.5),
      );
      [r, g, b] = hslToRgb(nh, ns, nl);
    }
  }

  // Vibrance (skin-tone protected saturation)
  if (Math.abs(params.vibrance) > 1e-5) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC > 1e-5 ? (maxC - minC) / maxC : 0;
    const skinW =
      clamp01((r - g) * 3) *
      clamp01((g - b) * 3) *
      smoothstep(0.05, 0.25, sat);
    const vib = (params.vibrance / 100) * (1 - sat * 0.65) * (1 - 0.55 * skinW);
    const factor = Math.max(0, 1 + vib);
    r = clamp01(mix(luma, r, factor));
    g = clamp01(mix(luma, g, factor));
    b = clamp01(mix(luma, b, factor));
  }

  // Global saturation
  if (Math.abs(params.saturation) > 1e-5) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const factor = Math.max(0, 1 + params.saturation / 100);
    r = clamp01(mix(luma, r, factor));
    g = clamp01(mix(luma, g, factor));
    b = clamp01(mix(luma, b, factor));
  }

  // Split toning (Pegtop soft-light shadows & highlights)
  if (params.splitShadowSat > 1e-4 || params.splitHighlightSat > 1e-4) {
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (params.splitShadowSat > 1e-4) {
      const [tr, tg, tb] = hueToPureRgb(params.splitShadowHue);
      const wSh = (1 - smoothstep(0.12, 0.62, l)) * (params.splitShadowSat / 100) * 0.34;
      const sr = (1 - 2 * tr) * r * r + 2 * tr * r;
      const sg = (1 - 2 * tg) * g * g + 2 * tg * g;
      const sb = (1 - 2 * tb) * b * b + 2 * tb * b;
      r = clamp01(mix(r, sr, wSh) + (tr - 0.5) * 0.06 * wSh);
      g = clamp01(mix(g, sg, wSh) + (tg - 0.5) * 0.06 * wSh);
      b = clamp01(mix(b, sb, wSh) + (tb - 0.5) * 0.06 * wSh);
    }
    if (params.splitHighlightSat > 1e-4) {
      const [tr, tg, tb] = hueToPureRgb(params.splitHighlightHue);
      const wHi = smoothstep(0.38, 0.88, l) * (params.splitHighlightSat / 100) * 0.34;
      const hr = (1 - 2 * tr) * r * r + 2 * tr * r;
      const hg = (1 - 2 * tg) * g * g + 2 * tg * g;
      const hb = (1 - 2 * tb) * b * b + 2 * tb * b;
      r = clamp01(mix(r, hr, wHi));
      g = clamp01(mix(g, hg, wHi));
      b = clamp01(mix(b, hb, wHi));
    }
  }

  // Film matte fade black lift
  if (params.fade > 1e-4) {
    const lift = (params.fade / 100) * 0.14;
    r = clamp01(r + lift * (1 - r) * (1 - r));
    g = clamp01(g + lift * (1 - g) * (1 - g));
    b = clamp01(b + lift * (1 - b) * (1 - b));
  }

  return [r, g, b];
}

const VERTEX_SHADER_SRC = `
attribute vec2 aPosition;
attribute vec2 aUv;
varying vec2 vUv;

void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 vUv;

uniform sampler2D uSourceTex;
uniform sampler2D uBaseLutTex;
uniform sampler2D uCreativeLutTex;

uniform float uHasBaseLut;
uniform float uBaseLutSize;
uniform float uBaseLutStrength;
uniform vec3 uBaseLutMin;
uniform vec3 uBaseLutMax;

uniform float uHasCreativeLut;
uniform float uCreativeLutSize;
uniform float uCreativeLutStrength;
uniform vec3 uCreativeLutMin;
uniform vec3 uCreativeLutMax;

uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTemperature;
uniform float uTint;
uniform float uVibrance;
uniform float uSaturation;
uniform float uFade;
uniform float uVignette;
uniform float uGrain;
uniform float uSplitHighlightHue;
uniform float uSplitHighlightSat;
uniform float uSplitShadowHue;
uniform float uSplitShadowSat;

uniform float uHasHsl;
uniform vec3 uHslRed;
uniform vec3 uHslOrange;
uniform vec3 uHslYellow;
uniform vec3 uHslGreen;
uniform vec3 uHslCyan;
uniform vec3 uHslBlue;
uniform vec3 uHslPurple;
uniform vec3 uHslMagenta;

uniform float uSplitPos;
uniform float uShowOriginal;
uniform vec2 uResolution;

const float PI = 3.14159265359;
const vec3 LUMA_COEFF = vec3(0.2126, 0.7152, 0.0722);

float srgbToLinear1(float c) {
  float v = max(0.0, c);
  return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}

vec3 srgbToLinear(vec3 c) {
  return vec3(srgbToLinear1(c.r), srgbToLinear1(c.g), srgbToLinear1(c.b));
}

float linearToSrgb1(float c) {
  float v = max(0.0, c);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

vec3 linearToSrgb(vec3 c) {
  return vec3(linearToSrgb1(c.r), linearToSrgb1(c.g), linearToSrgb1(c.b));
}

vec3 sampleLut3D(sampler2D lutTex, float lutSize, vec3 rgb, vec3 dMin, vec3 dMax) {
  vec3 norm = clamp((rgb - dMin) / max(dMax - dMin, vec3(1e-5)), 0.0, 1.0);
  float maxIdx = lutSize - 1.0;
  float blueF = norm.b * maxIdx;
  float slice0 = floor(blueF);
  float slice1 = min(maxIdx, slice0 + 1.0);
  float fracB = blueF - slice0;

  float width = lutSize * lutSize;
  float uOffset = (norm.r * maxIdx + 0.5) / width;
  float v = (norm.g * maxIdx + 0.5) / lutSize;

  vec2 uv0 = vec2(slice0 / lutSize + uOffset, v);
  vec2 uv1 = vec2(slice1 / lutSize + uOffset, v);

  vec3 c0 = texture2D(lutTex, uv0).rgb;
  vec3 c1 = texture2D(lutTex, uv1).rgb;
  return mix(c0, c1, fracB);
}

vec3 rgbToHsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float l = (maxC + minC) * 0.5;
  float d = maxC - minC;
  if (d < 1e-5) {
    return vec3(0.0, 0.0, l);
  }
  float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
  float h = 0.0;
  if (maxC == c.r) {
    h = ((c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0)) * 60.0;
  } else if (maxC == c.g) {
    h = ((c.b - c.r) / d + 2.0) * 60.0;
  } else {
    h = ((c.r - c.g) / d + 4.0) * 60.0;
  }
  return vec3(mod(h + 360.0, 360.0), clamp(s, 0.0, 1.0), clamp(l, 0.0, 1.0));
}

float hue2rgb(float p, float q, float tIn) {
  float t = tIn;
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hslToRgb(vec3 hsl) {
  float h = hsl.x;
  float s = hsl.y;
  float l = hsl.z;
  if (s <= 1e-5) {
    return vec3(l);
  }
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  float hk = mod(h + 360.0, 360.0) / 360.0;
  return clamp(vec3(
    hue2rgb(p, q, hk + 1.0 / 3.0),
    hue2rgb(p, q, hk),
    hue2rgb(p, q, hk - 1.0 / 3.0)
  ), 0.0, 1.0);
}

float bandWeight(float h, float prevDeg, float centerDeg, float nextDeg) {
  float spanL = mod(centerDeg - prevDeg + 360.0, 360.0);
  float spanR = mod(nextDeg - centerDeg + 360.0, 360.0);
  float d = mod(h - centerDeg + 540.0, 360.0) - 180.0;
  if (d >= -spanL && d <= 0.0) {
    float t = 1.0 + d / spanL;
    return 0.5 - 0.5 * cos(PI * t);
  }
  if (d > 0.0 && d <= spanR) {
    float t = 1.0 - d / spanR;
    return 0.5 - 0.5 * cos(PI * t);
  }
  return 0.0;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 src = texture2D(uSourceTex, vUv);
  if (uShowOriginal > 0.5 || vUv.x < uSplitPos) {
    gl_FragColor = vec4(src.rgb, src.a);
    return;
  }

  vec3 c = clamp(src.rgb, 0.0, 1.0);

  // Stage 1: Base / Log technical 3D LUT
  if (uHasBaseLut > 0.5 && uBaseLutStrength > 0.0001) {
    vec3 lut1 = sampleLut3D(uBaseLutTex, uBaseLutSize, c, uBaseLutMin, uBaseLutMax);
    c = mix(c, lut1, clamp(uBaseLutStrength, 0.0, 1.0));
  }

  // Stage 2: Exposure & White Balance in linear light
  if (abs(uExposure) > 1e-5 || abs(uTemperature) > 1e-5 || abs(uTint) > 1e-5) {
    vec3 lin = srgbToLinear(c);
    if (abs(uExposure) > 1e-5) {
      lin *= pow(2.0, uExposure);
    }
    if (abs(uTemperature) > 1e-5 || abs(uTint) > 1e-5) {
      float t = uTemperature / 100.0;
      float m = uTint / 100.0;
      vec3 gain = vec3(
        pow(2.0, t * 0.28 + m * 0.08),
        pow(2.0, -m * 0.16),
        pow(2.0, -t * 0.30 + m * 0.08)
      );
      float lumGain = dot(gain, LUMA_COEFF);
      lin *= gain / max(lumGain, 1e-4);
    }
    c = linearToSrgb(lin);
  }

  // Tonal zones: shadows, highlights, blacks, whites
  if (abs(uShadows) > 1e-5 || abs(uHighlights) > 1e-5 || abs(uBlacks) > 1e-5 || abs(uWhites) > 1e-5) {
    float lum = dot(c, LUMA_COEFF);
    float l = clamp(lum, 0.0, 1.0);
    float wShadow = (1.0 - smoothstep(0.0, 0.55, l)) * (1.0 - l);
    float wHigh = smoothstep(0.35, 1.0, l) * l;
    float wBlack = pow(1.0 - l, 3.0);
    float wWhite = pow(l, 2.5);

    float delta =
      (uShadows / 100.0) * 0.42 * wShadow +
      (uHighlights / 100.0) * 0.38 * wHigh +
      (uBlacks / 100.0) * 0.22 * wBlack +
      (uWhites / 100.0) * 0.22 * wWhite;

    if (abs(delta) > 1e-6) {
      float newLum = max(0.0, lum + delta);
      vec3 scaled = lum > 1e-4 ? c * (newLum / lum) : vec3(newLum);
      vec3 added = c + vec3(delta);
      c = mix(added, scaled, 0.7);
    }
  }

  c = clamp(c, 0.0, 1.0);

  // Smooth S-curve contrast
  if (abs(uContrast) > 1e-5) {
    float k = uContrast / 100.0;
    if (k > 0.0) {
      vec3 sc = c * c * (3.0 - 2.0 * c);
      c = mix(c, sc, k * 0.65);
    } else {
      c = vec3(0.5) + (c - vec3(0.5)) * (1.0 + k * 0.55);
    }
    c = clamp(c, 0.0, 1.0);
  }

  // 8-band selective HSL
  if (uHasHsl > 0.5) {
    vec3 hsl = rgbToHsl(c);
    float chromaMask = smoothstep(0.02, 0.14, hsl.y);
    if (chromaMask > 1e-5) {
      vec3 adj =
        uHslRed * bandWeight(hsl.x, 325.0, 0.0, 30.0) +
        uHslOrange * bandWeight(hsl.x, 0.0, 30.0, 60.0) +
        uHslYellow * bandWeight(hsl.x, 30.0, 60.0, 120.0) +
        uHslGreen * bandWeight(hsl.x, 60.0, 120.0, 180.0) +
        uHslCyan * bandWeight(hsl.x, 120.0, 180.0, 235.0) +
        uHslBlue * bandWeight(hsl.x, 180.0, 235.0, 280.0) +
        uHslPurple * bandWeight(hsl.x, 235.0, 280.0, 325.0) +
        uHslMagenta * bandWeight(hsl.x, 280.0, 325.0, 360.0);

      hsl.x = mod(hsl.x + adj.x * chromaMask + 360.0, 360.0);
      hsl.y = clamp(hsl.y * max(0.0, 1.0 + (adj.y / 100.0) * chromaMask), 0.0, 1.0);
      hsl.z = clamp(hsl.z + (adj.z / 100.0) * 0.35 * chromaMask * (1.0 - abs(2.0 * hsl.z - 1.0) * 0.5), 0.0, 1.0);
      c = hslToRgb(hsl);
    }
  }

  // Vibrance (skin-tone protected)
  if (abs(uVibrance) > 1e-5) {
    float luma = dot(c, LUMA_COEFF);
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float sat = maxC > 1e-5 ? (maxC - minC) / maxC : 0.0;
    float skinW = clamp((c.r - c.g) * 3.0, 0.0, 1.0) *
      clamp((c.g - c.b) * 3.0, 0.0, 1.0) *
      smoothstep(0.05, 0.25, sat);
    float vib = (uVibrance / 100.0) * (1.0 - sat * 0.65) * (1.0 - 0.55 * skinW);
    c = clamp(mix(vec3(luma), c, max(0.0, 1.0 + vib)), 0.0, 1.0);
  }

  // Global saturation
  if (abs(uSaturation) > 1e-5) {
    float luma = dot(c, LUMA_COEFF);
    c = clamp(mix(vec3(luma), c, max(0.0, 1.0 + uSaturation / 100.0)), 0.0, 1.0);
  }

  // Split toning
  if (uSplitShadowSat > 1e-4 || uSplitHighlightSat > 1e-4) {
    float l = dot(c, LUMA_COEFF);
    if (uSplitShadowSat > 1e-4) {
      vec3 shTint = hslToRgb(vec3(uSplitShadowHue, 1.0, 0.5));
      float wSh = (1.0 - smoothstep(0.12, 0.62, l)) * (uSplitShadowSat / 100.0) * 0.34;
      vec3 sl = (1.0 - 2.0 * shTint) * c * c + 2.0 * shTint * c;
      c = clamp(mix(c, sl, wSh) + (shTint - vec3(0.5)) * 0.06 * wSh, 0.0, 1.0);
    }
    if (uSplitHighlightSat > 1e-4) {
      vec3 hiTint = hslToRgb(vec3(uSplitHighlightHue, 1.0, 0.5));
      float wHi = smoothstep(0.38, 0.88, l) * (uSplitHighlightSat / 100.0) * 0.34;
      vec3 sl = (1.0 - 2.0 * hiTint) * c * c + 2.0 * hiTint * c;
      c = clamp(mix(c, sl, wHi), 0.0, 1.0);
    }
  }

  // Film matte fade
  if (uFade > 1e-4) {
    float lift = (uFade / 100.0) * 0.14;
    vec3 inv = vec3(1.0) - c;
    c = clamp(c + lift * inv * inv, 0.0, 1.0);
  }

  // Stage 3: Creative 3D LUT
  if (uHasCreativeLut > 0.5 && uCreativeLutStrength > 0.0001) {
    vec3 lut2 = sampleLut3D(uCreativeLutTex, uCreativeLutSize, c, uCreativeLutMin, uCreativeLutMax);
    c = mix(c, lut2, clamp(uCreativeLutStrength, 0.0, 1.0));
  }

  // Vignette (spatial)
  if (uVignette > 1e-4) {
    float dist = length(vUv - vec2(0.5));
    float vig = 1.0 - (uVignette / 100.0) * 0.65 * smoothstep(0.28, 0.82, dist);
    c *= vig;
  }

  // Organic film grain (spatial, midtone-weighted)
  if (uGrain > 1e-4) {
    vec2 px = floor(vUv * max(uResolution, vec2(1.0)));
    float n1 = hash12(px + vec2(17.1, 31.7));
    float n2 = hash12(px * 0.73 + vec2(91.3, 11.9));
    float grainNoise = (n1 + n2 - 1.0) * 0.5;
    float luma = dot(c, LUMA_COEFF);
    float midWeight = 1.0 - abs(2.0 * luma - 1.0) * 0.65;
    c = clamp(c + vec3(grainNoise * (uGrain / 100.0) * 0.16 * midWeight), 0.0, 1.0);
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}
`;

function getSourceDimensions(source: ColorMediaSource): { width: number; height: number } {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return {
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height,
    };
  }
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return {
      width: source.videoWidth,
      height: source.videoHeight,
    };
  }
  return {
    width: source.width,
    height: source.height,
  };
}

function isSourceReady(source: ColorMediaSource): boolean {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return source.complete && (source.naturalWidth > 0 || source.width > 0);
  }
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0;
  }
  return source.width > 0 && source.height > 0;
}

interface UniformMap {
  uSourceTex: WebGLUniformLocation | null;
  uBaseLutTex: WebGLUniformLocation | null;
  uCreativeLutTex: WebGLUniformLocation | null;
  uHasBaseLut: WebGLUniformLocation | null;
  uBaseLutSize: WebGLUniformLocation | null;
  uBaseLutStrength: WebGLUniformLocation | null;
  uBaseLutMin: WebGLUniformLocation | null;
  uBaseLutMax: WebGLUniformLocation | null;
  uHasCreativeLut: WebGLUniformLocation | null;
  uCreativeLutSize: WebGLUniformLocation | null;
  uCreativeLutStrength: WebGLUniformLocation | null;
  uCreativeLutMin: WebGLUniformLocation | null;
  uCreativeLutMax: WebGLUniformLocation | null;
  uExposure: WebGLUniformLocation | null;
  uContrast: WebGLUniformLocation | null;
  uHighlights: WebGLUniformLocation | null;
  uShadows: WebGLUniformLocation | null;
  uWhites: WebGLUniformLocation | null;
  uBlacks: WebGLUniformLocation | null;
  uTemperature: WebGLUniformLocation | null;
  uTint: WebGLUniformLocation | null;
  uVibrance: WebGLUniformLocation | null;
  uSaturation: WebGLUniformLocation | null;
  uFade: WebGLUniformLocation | null;
  uVignette: WebGLUniformLocation | null;
  uGrain: WebGLUniformLocation | null;
  uSplitHighlightHue: WebGLUniformLocation | null;
  uSplitHighlightSat: WebGLUniformLocation | null;
  uSplitShadowHue: WebGLUniformLocation | null;
  uSplitShadowSat: WebGLUniformLocation | null;
  uHasHsl: WebGLUniformLocation | null;
  uHslRed: WebGLUniformLocation | null;
  uHslOrange: WebGLUniformLocation | null;
  uHslYellow: WebGLUniformLocation | null;
  uHslGreen: WebGLUniformLocation | null;
  uHslCyan: WebGLUniformLocation | null;
  uHslBlue: WebGLUniformLocation | null;
  uHslPurple: WebGLUniformLocation | null;
  uHslMagenta: WebGLUniformLocation | null;
  uSplitPos: WebGLUniformLocation | null;
  uShowOriginal: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('无法创建 WebGL 着色器对象');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(`WebGL 着色器编译失败：${log}`);
  }
  return shader;
}

function createLinearTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Seed 1x1 neutral black texel so texture unit is always complete
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 255]),
  );
  return tex;
}

/**
 * Real-time WebGL1/WebGL2 GPU color grading & dual 3D LUT pipeline (with safe Canvas2D fallback).
 * Zero external dependencies.
 */
export class WebGLColorPipeline {
  readonly canvas: HTMLCanvasElement;
  readonly backend: 'webgl2' | 'webgl' | 'canvas2d';

  private gl: WebGLRenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private sourceTex: WebGLTexture | null = null;
  private baseLutTex: WebGLTexture | null = null;
  private creativeLutTex: WebGLTexture | null = null;
  private uniforms: UniformMap | null = null;
  private maxTextureSize = 4096;

  private currentSource: ColorMediaSource | null = null;
  private hasSource = false;
  private sourceWidth = 0;
  private sourceHeight = 0;

  private baseLut: Lut3D | null = null;
  private baseLutUploadedSize = 0;
  private creativeLut: Lut3D | null = null;
  private creativeLutUploadedSize = 0;

  private histCanvas: HTMLCanvasElement | null = null;
  private histCtx: CanvasRenderingContext2D | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const attrs: WebGLContextAttributes = {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    };

    let gl: WebGLRenderingContext | null = null;
    let backend: 'webgl2' | 'webgl' | 'canvas2d' = 'canvas2d';

    try {
      const gl2 = canvas.getContext('webgl2', attrs) as WebGLRenderingContext | null;
      if (gl2) {
        gl = gl2;
        backend = 'webgl2';
      } else {
        const gl1 = (canvas.getContext('webgl', attrs) ||
          canvas.getContext('experimental-webgl', attrs)) as WebGLRenderingContext | null;
        if (gl1) {
          gl = gl1;
          backend = 'webgl';
        }
      }
    } catch {
      gl = null;
    }

    if (gl) {
      try {
        this.gl = gl;
        this.initWebGL(gl);
        this.backend = backend;
        return;
      } catch {
        this.cleanupWebGL();
        this.gl = null;
      }
    }

    this.backend = 'canvas2d';
    this.ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  }

  private initWebGL(gl: WebGLRenderingContext): void {
    this.maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('无法创建 WebGL 程序');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'Unknown link error';
      gl.deleteProgram(program);
      throw new Error(`WebGL 程序链接失败：${log}`);
    }

    this.program = program;
    gl.useProgram(program);

    // Full-screen triangle strip: [x, y, u, v]
    const quad = new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      -1, 1, 0, 1,
      1, 1, 1, 1,
    ]);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('无法创建顶点缓冲区');
    this.quadBuffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(program, 'aPosition');
    const aUv = gl.getAttribLocation(program, 'aUv');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    this.sourceTex = createLinearTexture(gl);
    this.baseLutTex = createLinearTexture(gl);
    this.creativeLutTex = createLinearTexture(gl);

    const loc = (name: string) => gl.getUniformLocation(program, name);
    this.uniforms = {
      uSourceTex: loc('uSourceTex'),
      uBaseLutTex: loc('uBaseLutTex'),
      uCreativeLutTex: loc('uCreativeLutTex'),
      uHasBaseLut: loc('uHasBaseLut'),
      uBaseLutSize: loc('uBaseLutSize'),
      uBaseLutStrength: loc('uBaseLutStrength'),
      uBaseLutMin: loc('uBaseLutMin'),
      uBaseLutMax: loc('uBaseLutMax'),
      uHasCreativeLut: loc('uHasCreativeLut'),
      uCreativeLutSize: loc('uCreativeLutSize'),
      uCreativeLutStrength: loc('uCreativeLutStrength'),
      uCreativeLutMin: loc('uCreativeLutMin'),
      uCreativeLutMax: loc('uCreativeLutMax'),
      uExposure: loc('uExposure'),
      uContrast: loc('uContrast'),
      uHighlights: loc('uHighlights'),
      uShadows: loc('uShadows'),
      uWhites: loc('uWhites'),
      uBlacks: loc('uBlacks'),
      uTemperature: loc('uTemperature'),
      uTint: loc('uTint'),
      uVibrance: loc('uVibrance'),
      uSaturation: loc('uSaturation'),
      uFade: loc('uFade'),
      uVignette: loc('uVignette'),
      uGrain: loc('uGrain'),
      uSplitHighlightHue: loc('uSplitHighlightHue'),
      uSplitHighlightSat: loc('uSplitHighlightSat'),
      uSplitShadowHue: loc('uSplitShadowHue'),
      uSplitShadowSat: loc('uSplitShadowSat'),
      uHasHsl: loc('uHasHsl'),
      uHslRed: loc('uHslRed'),
      uHslOrange: loc('uHslOrange'),
      uHslYellow: loc('uHslYellow'),
      uHslGreen: loc('uHslGreen'),
      uHslCyan: loc('uHslCyan'),
      uHslBlue: loc('uHslBlue'),
      uHslPurple: loc('uHslPurple'),
      uHslMagenta: loc('uHslMagenta'),
      uSplitPos: loc('uSplitPos'),
      uShowOriginal: loc('uShowOriginal'),
      uResolution: loc('uResolution'),
    };

    gl.uniform1i(this.uniforms.uSourceTex, 0);
    gl.uniform1i(this.uniforms.uBaseLutTex, 1);
    gl.uniform1i(this.uniforms.uCreativeLutTex, 2);
  }

  /**
   * Upload or refresh the source media frame (image, canvas, video frame, or ImageBitmap).
   */
  setSource(source: ColorMediaSource): void {
    if (this.disposed || !isSourceReady(source)) return;
    const { width, height } = getSourceDimensions(source);
    if (width <= 0 || height <= 0) return;

    this.currentSource = source;
    this.sourceWidth = width;
    this.sourceHeight = height;
    this.hasSource = true;

    if (this.canvas.width === 0 || this.canvas.height === 0) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    if (this.gl && this.sourceTex) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  private uploadLutToTexture(
    lut: Lut3D | null,
    tex: WebGLTexture | null,
    unitOffset: number,
  ): number {
    if (!lut || !this.gl || !tex) return 0;
    const gl = this.gl;
    // Ensure (N * N) fits within GPU MAX_TEXTURE_SIZE (e.g. downsample 65³ to 33³ if maxTex < 4225)
    let uploadLut = lut;
    if (lut.size * lut.size > this.maxTextureSize) {
      const safeSize = Math.min(33, Math.floor(Math.sqrt(this.maxTextureSize)));
      uploadLut = resampleLut3D(lut, Math.max(17, safeSize));
    }
    const atlas = packLut3DTo2DAtlas(uploadLut);
    gl.activeTexture(gl.TEXTURE0 + unitOffset);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      atlas.width,
      atlas.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      atlas.pixels,
    );
    return atlas.size;
  }

  /** Set Stage-1 Log / Technical Base 3D LUT. */
  setBaseLut(lut: Lut3D | null): void {
    if (this.disposed) return;
    this.baseLut = lut;
    this.baseLutUploadedSize = this.uploadLutToTexture(lut, this.baseLutTex, 1);
  }

  /** Set Stage-2 Creative `.cube` 3D LUT. */
  setCreativeLut(lut: Lut3D | null): void {
    if (this.disposed) return;
    this.creativeLut = lut;
    this.creativeLutUploadedSize = this.uploadLutToTexture(lut, this.creativeLutTex, 2);
  }

  /** Render current source with active Base LUT, GradeParams, Creative LUT, and optional split wipe. */
  render(opts: RenderOptions): void {
    if (this.disposed || !this.hasSource) return;

    if (this.gl && this.program && this.uniforms) {
      this.renderWebGL(opts);
    } else if (this.ctx2d && this.currentSource) {
      this.renderCanvas2DFallback(opts);
    }
  }

  private renderWebGL(opts: RenderOptions): void {
    const gl = this.gl!;
    const u = this.uniforms!;
    const p = opts.params;

    const w = this.canvas.width || this.sourceWidth || 1;
    const h = this.canvas.height || this.sourceHeight || 1;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.baseLutTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.creativeLutTex);

    const hasBase = this.baseLut !== null && this.baseLutUploadedSize >= 2;
    gl.uniform1f(u.uHasBaseLut, hasBase ? 1 : 0);
    gl.uniform1f(u.uBaseLutSize, hasBase ? this.baseLutUploadedSize : 2);
    gl.uniform1f(u.uBaseLutStrength, clamp01(opts.baseLutStrength));
    if (this.baseLut) {
      gl.uniform3fv(u.uBaseLutMin, this.baseLut.domainMin);
      gl.uniform3fv(u.uBaseLutMax, this.baseLut.domainMax);
    } else {
      gl.uniform3f(u.uBaseLutMin, 0, 0, 0);
      gl.uniform3f(u.uBaseLutMax, 1, 1, 1);
    }

    const hasCreative = this.creativeLut !== null && this.creativeLutUploadedSize >= 2;
    gl.uniform1f(u.uHasCreativeLut, hasCreative ? 1 : 0);
    gl.uniform1f(u.uCreativeLutSize, hasCreative ? this.creativeLutUploadedSize : 2);
    gl.uniform1f(u.uCreativeLutStrength, clamp01(opts.creativeLutStrength));
    if (this.creativeLut) {
      gl.uniform3fv(u.uCreativeLutMin, this.creativeLut.domainMin);
      gl.uniform3fv(u.uCreativeLutMax, this.creativeLut.domainMax);
    } else {
      gl.uniform3f(u.uCreativeLutMin, 0, 0, 0);
      gl.uniform3f(u.uCreativeLutMax, 1, 1, 1);
    }

    gl.uniform1f(u.uExposure, p.exposure);
    gl.uniform1f(u.uContrast, p.contrast);
    gl.uniform1f(u.uHighlights, p.highlights);
    gl.uniform1f(u.uShadows, p.shadows);
    gl.uniform1f(u.uWhites, p.whites);
    gl.uniform1f(u.uBlacks, p.blacks);
    gl.uniform1f(u.uTemperature, p.temperature);
    gl.uniform1f(u.uTint, p.tint);
    gl.uniform1f(u.uVibrance, p.vibrance);
    gl.uniform1f(u.uSaturation, p.saturation);
    gl.uniform1f(u.uFade, p.fade);
    gl.uniform1f(u.uVignette, p.vignette);
    gl.uniform1f(u.uGrain, p.grain);
    gl.uniform1f(u.uSplitHighlightHue, p.splitHighlightHue);
    gl.uniform1f(u.uSplitHighlightSat, p.splitHighlightSat);
    gl.uniform1f(u.uSplitShadowHue, p.splitShadowHue);
    gl.uniform1f(u.uSplitShadowSat, p.splitShadowSat);

    const anyHsl = hasAnyHslAdjustment(p);
    gl.uniform1f(u.uHasHsl, anyHsl ? 1 : 0);
    gl.uniform3f(u.uHslRed, p.hsl.red.hue, p.hsl.red.sat, p.hsl.red.lum);
    gl.uniform3f(u.uHslOrange, p.hsl.orange.hue, p.hsl.orange.sat, p.hsl.orange.lum);
    gl.uniform3f(u.uHslYellow, p.hsl.yellow.hue, p.hsl.yellow.sat, p.hsl.yellow.lum);
    gl.uniform3f(u.uHslGreen, p.hsl.green.hue, p.hsl.green.sat, p.hsl.green.lum);
    gl.uniform3f(u.uHslCyan, p.hsl.cyan.hue, p.hsl.cyan.sat, p.hsl.cyan.lum);
    gl.uniform3f(u.uHslBlue, p.hsl.blue.hue, p.hsl.blue.sat, p.hsl.blue.lum);
    gl.uniform3f(u.uHslPurple, p.hsl.purple.hue, p.hsl.purple.sat, p.hsl.purple.lum);
    gl.uniform3f(u.uHslMagenta, p.hsl.magenta.hue, p.hsl.magenta.sat, p.hsl.magenta.lum);

    const splitPos =
      opts.splitPosition === undefined ? -1 : clamp01(opts.splitPosition);
    gl.uniform1f(u.uSplitPos, splitPos);
    gl.uniform1f(u.uShowOriginal, opts.showOriginal ? 1 : 0);
    gl.uniform2f(u.uResolution, w, h);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private renderCanvas2DFallback(opts: RenderOptions): void {
    const ctx = this.ctx2d!;
    const source = this.currentSource!;
    const w = this.canvas.width || this.sourceWidth || 1;
    const h = this.canvas.height || this.sourceHeight || 1;
    ctx.drawImage(source, 0, 0, w, h);

    if (opts.showOriginal) return;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const splitX =
      opts.splitPosition === undefined ? -1 : Math.floor(clamp01(opts.splitPosition) * w);
    const baseStr = clamp01(opts.baseLutStrength);
    const creativeStr = clamp01(opts.creativeLutStrength);
    const vigStr = (opts.params.vignette / 100) * 0.65;

    for (let y = 0; y < h; y++) {
      const v = y / Math.max(1, h - 1);
      for (let x = 0; x < w; x++) {
        if (x < splitX) continue;
        const idx = (y * w + x) * 4;
        let r = data[idx] / 255;
        let g = data[idx + 1] / 255;
        let b = data[idx + 2] / 255;

        if (this.baseLut && baseStr > 0.0001) {
          const [lr, lg, lb] = evaluateLut3D(this.baseLut, r, g, b);
          r = mix(r, lr, baseStr);
          g = mix(g, lg, baseStr);
          b = mix(b, lb, baseStr);
        }

        [r, g, b] = evaluateGradePixelCpu(r, g, b, opts.params);

        if (this.creativeLut && creativeStr > 0.0001) {
          const [cr, cg, cb] = evaluateLut3D(this.creativeLut, r, g, b);
          r = mix(r, cr, creativeStr);
          g = mix(g, cg, creativeStr);
          b = mix(b, cb, creativeStr);
        }

        if (vigStr > 1e-4) {
          const u = x / Math.max(1, w - 1);
          const dist = Math.hypot(u - 0.5, v - 0.5);
          const vig = 1 - vigStr * smoothstep(0.28, 0.82, dist);
          r *= vig;
          g *= vig;
          b *= vig;
        }

        data[idx] = Math.round(clamp01(r) * 255);
        data[idx + 1] = Math.round(clamp01(g) * 255);
        data[idx + 2] = Math.round(clamp01(b) * 255);
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Compute a fast 64-bin RGB + Luma histogram from the currently rendered canvas
   * via a downscaled offscreen sample (avoids full-resolution GPU stalls).
   */
  computeHistogram(sampleWidth = 160): HistogramData {
    const bins = 64;
    const r = new Uint32Array(bins);
    const g = new Uint32Array(bins);
    const b = new Uint32Array(bins);
    const luma = new Uint32Array(bins);

    if (this.disposed || this.canvas.width === 0 || this.canvas.height === 0) {
      return { r, g, b, luma, max: 1 };
    }

    const w = Math.max(16, Math.min(sampleWidth, this.canvas.width));
    const h = Math.max(
      16,
      Math.round((w * this.canvas.height) / Math.max(1, this.canvas.width)),
    );

    if (!this.histCanvas && typeof document !== 'undefined') {
      this.histCanvas = document.createElement('canvas');
      this.histCtx = this.histCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this.histCanvas || !this.histCtx) {
      return { r, g, b, luma, max: 1 };
    }

    if (this.histCanvas.width !== w || this.histCanvas.height !== h) {
      this.histCanvas.width = w;
      this.histCanvas.height = h;
    }

    this.histCtx.drawImage(this.canvas, 0, 0, w, h);
    const pixels = this.histCtx.getImageData(0, 0, w, h).data;

    for (let i = 0; i < pixels.length; i += 4) {
      const rv = pixels[i];
      const gv = pixels[i + 1];
      const bv = pixels[i + 2];
      const lv = Math.round(0.2126 * rv + 0.7152 * gv + 0.0722 * bv);
      r[rv >> 2] += 1;
      g[gv >> 2] += 1;
      b[bv >> 2] += 1;
      luma[lv >> 2] += 1;
    }

    let max = 1;
    for (let i = 0; i < bins; i++) {
      if (r[i] > max) max = r[i];
      if (g[i] > max) max = g[i];
      if (b[i] > max) max = b[i];
      if (luma[i] > max) max = luma[i];
    }

    return { r, g, b, luma, max };
  }

  /**
   * Render a source image / frame at FULL native resolution offscreen and export to Blob.
   */
  async renderImageToBlob(
    source: ColorMediaSource,
    opts: RenderImageToBlobOptions,
  ): Promise<Blob> {
    if (!isSourceReady(source)) {
      throw new Error('图像尚未加载完成，无法导出成片');
    }
    const { width, height } = getSourceDimensions(source);
    if (width <= 0 || height <= 0) {
      throw new Error('源图像尺寸无效，无法导出成片');
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;

    const exportPipe = new WebGLColorPipeline(offscreen);
    try {
      const activeBaseLut = opts.baseLut === undefined ? this.baseLut : opts.baseLut;
      const activeCreativeLut =
        opts.creativeLut === undefined ? this.creativeLut : opts.creativeLut;

      exportPipe.setSource(source);
      if (activeBaseLut) exportPipe.setBaseLut(activeBaseLut);
      if (activeCreativeLut) exportPipe.setCreativeLut(activeCreativeLut);
      exportPipe.render({
        params: opts.params,
        baseLutStrength: opts.baseLutStrength ?? (activeBaseLut ? 1 : 0),
        creativeLutStrength: opts.creativeLutStrength ?? (activeCreativeLut ? 1 : 0),
      });

      const mime = opts.mime ?? 'image/jpeg';
      const quality = opts.quality ?? 0.94;

      const blob = await new Promise<Blob | null>((resolve) => {
        offscreen.toBlob((result) => resolve(result), mime, quality);
      });
      if (!blob) {
        throw new Error('浏览器画布导出失败，请尝试切换导出格式');
      }
      return blob;
    } finally {
      exportPipe.dispose(true);
    }
  }

  private cleanupWebGL(loseContext = false): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.sourceTex) gl.deleteTexture(this.sourceTex);
    if (this.baseLutTex) gl.deleteTexture(this.baseLutTex);
    if (this.creativeLutTex) gl.deleteTexture(this.creativeLutTex);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.program) gl.deleteProgram(this.program);
    if (loseContext) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.sourceTex = null;
    this.baseLutTex = null;
    this.creativeLutTex = null;
    this.quadBuffer = null;
    this.program = null;
    this.uniforms = null;
  }

  dispose(loseContext = false): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupWebGL(loseContext);
    this.gl = null;
    this.ctx2d = null;
    this.currentSource = null;
    this.baseLut = null;
    this.creativeLut = null;
    this.histCanvas = null;
    this.histCtx = null;
  }
}
