export type HslBandId =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'magenta';

export const HSL_BAND_IDS: readonly HslBandId[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'magenta',
] as const;

export interface HslBandMeta {
  id: HslBandId;
  label: string;
  centerHue: number;
  swatch: string;
}

export const HSL_BAND_META: readonly HslBandMeta[] = [
  { id: 'red', label: '红', centerHue: 0, swatch: '#d94848' },
  { id: 'orange', label: '橙', centerHue: 30, swatch: '#df7b38' },
  { id: 'yellow', label: '黄', centerHue: 60, swatch: '#d9b43a' },
  { id: 'green', label: '绿', centerHue: 120, swatch: '#4a9e66' },
  { id: 'cyan', label: '青', centerHue: 180, swatch: '#3c9ea8' },
  { id: 'blue', label: '蓝', centerHue: 235, swatch: '#4272c4' },
  { id: 'purple', label: '紫', centerHue: 280, swatch: '#7f5cc2' },
  { id: 'magenta', label: '品红', centerHue: 325, swatch: '#c2548e' },
] as const;

export interface HslAdjustment {
  /** Hue shift in degrees: -30..30 */
  hue: number;
  /** Saturation shift: -100..100 */
  sat: number;
  /** Luminance shift: -100..100 */
  lum: number;
}

export interface GradeParams {
  /** Exposure compensation in EV: -2..2 */
  exposure: number;
  /** S-curve contrast: -100..100 */
  contrast: number;
  /** Highlight recovery/lift: -100..100 */
  highlights: number;
  /** Shadow lift/crush: -100..100 */
  shadows: number;
  /** White point: -100..100 */
  whites: number;
  /** Black point: -100..100 */
  blacks: number;
  /** Color temperature (cool -> warm): -100..100 */
  temperature: number;
  /** Tint (green -> magenta): -100..100 */
  tint: number;
  /** Vibrance (skin-tone protected saturation): -100..100 */
  vibrance: number;
  /** Global saturation: -100..100 */
  saturation: number;
  /** Film matte black lift: 0..100 */
  fade: number;
  /** Edge vignette darkening: 0..100 */
  vignette: number;
  /** Film grain intensity: 0..100 */
  grain: number;
  /** Split toning highlight hue: 0..360 */
  splitHighlightHue: number;
  /** Split toning highlight saturation: 0..100 */
  splitHighlightSat: number;
  /** Split toning shadow hue: 0..360 */
  splitShadowHue: number;
  /** Split toning shadow saturation: 0..100 */
  splitShadowSat: number;
  /** 8-band selective HSL adjustments */
  hsl: Record<HslBandId, HslAdjustment>;
}

export type GradeParamsPatch = Partial<Omit<GradeParams, 'hsl'>> & {
  hsl?: Partial<Record<HslBandId, Partial<HslAdjustment>>>;
};

function createDefaultHsl(): Record<HslBandId, HslAdjustment> {
  return {
    red: { hue: 0, sat: 0, lum: 0 },
    orange: { hue: 0, sat: 0, lum: 0 },
    yellow: { hue: 0, sat: 0, lum: 0 },
    green: { hue: 0, sat: 0, lum: 0 },
    cyan: { hue: 0, sat: 0, lum: 0 },
    blue: { hue: 0, sat: 0, lum: 0 },
    purple: { hue: 0, sat: 0, lum: 0 },
    magenta: { hue: 0, sat: 0, lum: 0 },
  };
}

export const DEFAULT_GRADE_PARAMS: GradeParams = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  fade: 0,
  vignette: 0,
  grain: 0,
  splitHighlightHue: 0,
  splitHighlightSat: 0,
  splitShadowHue: 0,
  splitShadowSat: 0,
  hsl: createDefaultHsl(),
};

export function cloneGradeParams(params: GradeParams = DEFAULT_GRADE_PARAMS): GradeParams {
  return {
    exposure: params.exposure,
    contrast: params.contrast,
    highlights: params.highlights,
    shadows: params.shadows,
    whites: params.whites,
    blacks: params.blacks,
    temperature: params.temperature,
    tint: params.tint,
    vibrance: params.vibrance,
    saturation: params.saturation,
    fade: params.fade,
    vignette: params.vignette,
    grain: params.grain,
    splitHighlightHue: params.splitHighlightHue,
    splitHighlightSat: params.splitHighlightSat,
    splitShadowHue: params.splitShadowHue,
    splitShadowSat: params.splitShadowSat,
    hsl: {
      red: { ...params.hsl.red },
      orange: { ...params.hsl.orange },
      yellow: { ...params.hsl.yellow },
      green: { ...params.hsl.green },
      cyan: { ...params.hsl.cyan },
      blue: { ...params.hsl.blue },
      purple: { ...params.hsl.purple },
      magenta: { ...params.hsl.magenta },
    },
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpHue(baseHue: number, targetHue: number, baseSat: number, targetSat: number, t: number): number {
  if (t <= 0) return ((baseHue % 360) + 360) % 360;
  if (t >= 1) return ((targetHue % 360) + 360) % 360;
  if (baseSat <= 0.001 && targetSat > 0.001) return ((targetHue % 360) + 360) % 360;
  if (targetSat <= 0.001 && baseSat > 0.001) return ((baseHue % 360) + 360) % 360;
  let diff = ((targetHue - baseHue + 540) % 360) - 180;
  if (diff < -180) diff += 360;
  return (((baseHue + diff * t) % 360) + 360) % 360;
}

/**
 * Resolve a partial grade patch onto a base (defaults to DEFAULT_GRADE_PARAMS).
 */
export function resolveGradeParams(
  patch?: GradeParamsPatch | GradeParams | null,
  base: GradeParams = DEFAULT_GRADE_PARAMS,
): GradeParams {
  if (!patch) return cloneGradeParams(base);
  const out = cloneGradeParams(base);
  if (patch.exposure !== undefined) out.exposure = patch.exposure;
  if (patch.contrast !== undefined) out.contrast = patch.contrast;
  if (patch.highlights !== undefined) out.highlights = patch.highlights;
  if (patch.shadows !== undefined) out.shadows = patch.shadows;
  if (patch.whites !== undefined) out.whites = patch.whites;
  if (patch.blacks !== undefined) out.blacks = patch.blacks;
  if (patch.temperature !== undefined) out.temperature = patch.temperature;
  if (patch.tint !== undefined) out.tint = patch.tint;
  if (patch.vibrance !== undefined) out.vibrance = patch.vibrance;
  if (patch.saturation !== undefined) out.saturation = patch.saturation;
  if (patch.fade !== undefined) out.fade = patch.fade;
  if (patch.vignette !== undefined) out.vignette = patch.vignette;
  if (patch.grain !== undefined) out.grain = patch.grain;
  if (patch.splitHighlightHue !== undefined) out.splitHighlightHue = patch.splitHighlightHue;
  if (patch.splitHighlightSat !== undefined) out.splitHighlightSat = patch.splitHighlightSat;
  if (patch.splitShadowHue !== undefined) out.splitShadowHue = patch.splitShadowHue;
  if (patch.splitShadowSat !== undefined) out.splitShadowSat = patch.splitShadowSat;
  if (patch.hsl) {
    for (const band of HSL_BAND_IDS) {
      const bandPatch = patch.hsl[band];
      if (!bandPatch) continue;
      if (bandPatch.hue !== undefined) out.hsl[band].hue = bandPatch.hue;
      if (bandPatch.sat !== undefined) out.hsl[band].sat = bandPatch.sat;
      if (bandPatch.lum !== undefined) out.hsl[band].lum = bandPatch.lum;
    }
  }
  return out;
}

/**
 * Blend `base` toward `preset` (full GradeParams or partial preset patch) by `strength01` (clamped 0..1).
 * Unspecified fields in a partial `preset` preserve their values in `base`.
 */
export function blendGradeParams(
  base: GradeParams,
  preset: GradeParamsPatch | GradeParams,
  strength01: number,
): GradeParams {
  const t = Math.max(0, Math.min(1, Number.isFinite(strength01) ? strength01 : 0));
  if (t <= 0) return cloneGradeParams(base);

  const target = resolveGradeParams(preset, base);
  if (t >= 1) return target;

  const hsl = createDefaultHsl();
  for (const band of HSL_BAND_IDS) {
    hsl[band] = {
      hue: lerp(base.hsl[band].hue, target.hsl[band].hue, t),
      sat: lerp(base.hsl[band].sat, target.hsl[band].sat, t),
      lum: lerp(base.hsl[band].lum, target.hsl[band].lum, t),
    };
  }

  return {
    exposure: lerp(base.exposure, target.exposure, t),
    contrast: lerp(base.contrast, target.contrast, t),
    highlights: lerp(base.highlights, target.highlights, t),
    shadows: lerp(base.shadows, target.shadows, t),
    whites: lerp(base.whites, target.whites, t),
    blacks: lerp(base.blacks, target.blacks, t),
    temperature: lerp(base.temperature, target.temperature, t),
    tint: lerp(base.tint, target.tint, t),
    vibrance: lerp(base.vibrance, target.vibrance, t),
    saturation: lerp(base.saturation, target.saturation, t),
    fade: lerp(base.fade, target.fade, t),
    vignette: lerp(base.vignette, target.vignette, t),
    grain: lerp(base.grain, target.grain, t),
    splitHighlightHue: lerpHue(
      base.splitHighlightHue,
      target.splitHighlightHue,
      base.splitHighlightSat,
      target.splitHighlightSat,
      t,
    ),
    splitHighlightSat: lerp(base.splitHighlightSat, target.splitHighlightSat, t),
    splitShadowHue: lerpHue(
      base.splitShadowHue,
      target.splitShadowHue,
      base.splitShadowSat,
      target.splitShadowSat,
      t,
    ),
    splitShadowSat: lerp(base.splitShadowSat, target.splitShadowSat, t),
    hsl,
  };
}

export type GradePresetCategory = 'film' | 'cinema' | 'practical';

export interface GradePreset {
  id: string;
  name: string;
  subtitle: string;
  category: GradePresetCategory;
  reference: string;
  summary: string;
  bestFor: string[];
  params: GradeParamsPatch;
}

export interface BeginnerGuideItem {
  id: string;
  problem: string;
  diagnosis: string;
  recommendedPresetIds: string[];
  tip: string;
}

export interface Lut3D {
  title: string;
  size: number;
  /** RGB interleaved Float32Array of length size*size*size*3, red-fastest order per Adobe Cube spec */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

export type LogBrand = 'dji' | 'insta360' | 'sony' | 'nikon' | 'leica' | 'other';

export interface LogProfileSpec {
  id: string;
  brand: LogBrand;
  brandLabel: string;
  name: string;
  gamut: string;
  cameras: string;
  reference: string;
  description: string;
  defaultExposure: number;
}
