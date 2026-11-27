import { evaluateLut3D } from './cube-lut';
import type { GradeParams, LogProfileSpec, Lut3D } from './grade-types';
import { evaluateGradePixelCpu } from './webgl-color-pipeline';

type Mat3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

interface PrimariesXY {
  rx: number;
  ry: number;
  gx: number;
  gy: number;
  bx: number;
  by: number;
  wx: number;
  wy: number;
}

function invertMat3(m: Mat3): Mat3 {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];

  const c00 = e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 = d * h - e * g;
  const c10 = -(b * i - c * h);
  const c11 = a * i - c * g;
  const c12 = -(a * h - b * g);
  const c20 = b * f - c * e;
  const c21 = -(a * f - c * d);
  const c22 = a * e - b * d;

  const det = a * c00 + b * c01 + c * c02;
  return [
    [c00 / det, c10 / det, c20 / det],
    [c01 / det, c11 / det, c21 / det],
    [c02 / det, c12 / det, c22 / det],
  ];
}

function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
    }
  }
  return [out[0], out[1], out[2]];
}

function mulMat3Vec(m: Mat3, r: number, g: number, b: number): [number, number, number] {
  return [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ];
}

/**
 * Derive exact RGB -> CIE XYZ 3×3 matrix from published CIE 1931 xy chromaticity primaries & white point.
 * Guarantee: white (1, 1, 1) maps identically to target white point; gamut-to-gamut matrix rows sum to 1.0.
 */
function rgbToXyzFromPrimaries(p: PrimariesXY): Mat3 {
  const Xr = p.rx / p.ry;
  const Yr = 1;
  const Zr = (1 - p.rx - p.ry) / p.ry;

  const Xg = p.gx / p.gy;
  const Yg = 1;
  const Zg = (1 - p.gx - p.gy) / p.gy;

  const Xb = p.bx / p.by;
  const Yb = 1;
  const Zb = (1 - p.bx - p.by) / p.by;

  const P: Mat3 = [
    [Xr, Xg, Xb],
    [Yr, Yg, Yb],
    [Zr, Zg, Zb],
  ];

  const Xw = p.wx / p.wy;
  const Yw = 1;
  const Zw = (1 - p.wx - p.wy) / p.wy;

  const Pinv = invertMat3(P);
  const [Sr, Sg, Sb] = mulMat3Vec(Pinv, Xw, Yw, Zw);

  return [
    [Xr * Sr, Xg * Sg, Xb * Sb],
    [Yr * Sr, Yg * Sg, Yb * Sb],
    [Zr * Sr, Zg * Sg, Zb * Sb],
  ];
}

// D65 Standard Illuminant
const D65 = { wx: 0.3127, wy: 0.329 };

// Official Published CIE 1931 xy Primaries
const PRIMARIES_REC709: PrimariesXY = {
  rx: 0.64,
  ry: 0.33,
  gx: 0.3,
  gy: 0.6,
  bx: 0.15,
  by: 0.06,
  ...D65,
};

// ITU-R BT.2020 (Nikon N-Log, Leica L-Log, Apple Log)
const PRIMARIES_BT2020: PrimariesXY = {
  rx: 0.708,
  ry: 0.292,
  gx: 0.17,
  gy: 0.797,
  bx: 0.131,
  by: 0.046,
  ...D65,
};

// DJI D-Gamut (DJI Cinema Color System White Paper, 2017)
const PRIMARIES_DJI_DGAMUT: PrimariesXY = {
  rx: 0.71,
  ry: 0.31,
  gx: 0.21,
  gy: 0.88,
  bx: 0.09,
  by: -0.08,
  ...D65,
};

// Sony S-Gamut3.Cine (Sony Technical Summary for S-Gamut3.Cine/S-Log3)
const PRIMARIES_SONY_SGAMUT3_CINE: PrimariesXY = {
  rx: 0.766,
  ry: 0.275,
  gx: 0.225,
  gy: 0.8,
  bx: 0.089,
  by: -0.087,
  ...D65,
};

// Sony S-Gamut3 & S-Gamut (Sony Technical Summary)
const PRIMARIES_SONY_SGAMUT3: PrimariesXY = {
  rx: 0.73,
  ry: 0.28,
  gx: 0.14,
  gy: 0.855,
  bx: 0.1,
  by: -0.05,
  ...D65,
};

// Canon Cinema Gamut (Canon Log 3 / Cinema Gamut White Paper)
const PRIMARIES_CANON_CINEMA: PrimariesXY = {
  rx: 0.74,
  ry: 0.27,
  gx: 0.17,
  gy: 1.14,
  bx: 0.08,
  by: -0.1,
  ...D65,
};

// Panasonic V-Gamut (Panasonic V-Log/V-Gamut Reference Manual Rev. 1.0)
const PRIMARIES_PANASONIC_VGAMUT: PrimariesXY = {
  rx: 0.73,
  ry: 0.28,
  gx: 0.165,
  gy: 0.84,
  bx: 0.1,
  by: -0.03,
  ...D65,
};

const XYZ_TO_REC709 = invertMat3(rgbToXyzFromPrimaries(PRIMARIES_REC709));

function gamutToRec709Matrix(src: PrimariesXY): Mat3 {
  return mulMat3(XYZ_TO_REC709, rgbToXyzFromPrimaries(src));
}

const IDENTITY_MAT3: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const MAT_BT2020_TO_709 = gamutToRec709Matrix(PRIMARIES_BT2020);
const MAT_DGAMUT_TO_709 = gamutToRec709Matrix(PRIMARIES_DJI_DGAMUT);
const MAT_SGAMUT3_CINE_TO_709 = gamutToRec709Matrix(PRIMARIES_SONY_SGAMUT3_CINE);
const MAT_SGAMUT3_TO_709 = gamutToRec709Matrix(PRIMARIES_SONY_SGAMUT3);
const MAT_CANON_CINEMA_TO_709 = gamutToRec709Matrix(PRIMARIES_CANON_CINEMA);
const MAT_VGAMUT_TO_709 = gamutToRec709Matrix(PRIMARIES_PANASONIC_VGAMUT);

// ===================== Official Published Log EOTFs (Log [0..1] -> Scene-Linear, 18% grey = 0.18) =====================

/** DJI D-Log (White Paper on D-Log and D-Gamut of DJI Cinema Color System, 2017) */
function eotfDjiDlog(y: number): number {
  if (y <= 0.14) {
    return (y - 0.0929) / 6.025;
  }
  return (Math.pow(10, (y - 0.584555) / 0.256663) - 0.0108) / 0.9892;
}

/**
 * DJI D-Log M (10-bit quasi-Log Rec.709 profile: Osmo Pocket 3 / Mini 4 Pro / Air 3 / Action 4·5 Pro).
 * C1-continuous quasi-log curve anchored to 18% grey at y = 0.390, black floor ~0.035, ~4.8 stops highlight headroom.
 */
function eotfDjiDlogM(y: number): number {
  const yCut = 0.080643;
  if (y <= yCut) {
    return (y - 0.03514) / 4.5503;
  }
  return Math.pow(10, (y - 0.686412) / 0.44) - 0.032;
}

/**
 * Insta360 I-Log (Rec.709 flat Log profile: Ace Pro / Ace Pro 2 / X4 / GO 3S).
 * C1-continuous quasi-log curve anchored to 18% grey at y = 0.400, black floor ~0.046, ~5.0 stops highlight headroom.
 */
function eotfInsta360Ilog(y: number): number {
  const yCut = 0.093614;
  if (y <= yCut) {
    return (y - 0.046184) / 4.743;
  }
  return Math.pow(10, (y - 0.683004) / 0.415) - 0.028;
}

/** Sony S-Log3 (Sony Technical Summary for S-Gamut3.Cine/S-Log3 and S-Gamut3/S-Log3, 2014) */
function eotfSonySlog3(y: number): number {
  const cv = y * 1023.0;
  if (cv >= 171.2102946929) {
    return Math.pow(10, (cv - 420.0) / 261.5) * (0.18 + 0.01) - 0.01;
  }
  return ((cv - 95.0) * 0.01125) / (171.2102946929 - 95.0);
}

/** Sony S-Log2 (Sony S-Log2 Technical Summary, normalized IRE [0..1], 18% grey ≈ 32.3% IRE) */
function eotfSonySlog2(y: number): number {
  const offset = 0.030001222851889303;
  const scale90 = (0.9 * 219.0) / 155.0;
  if (y < offset) {
    return ((y - offset) / 3.53881278538813) * scale90;
  }
  return (Math.pow(10, (y - 0.616596 - 0.03) / 0.432699) - 0.037584) * scale90;
}

/** Nikon N-Log (Nikon N-Log Specification Document Ver. 1.00, 2018) */
function eotfNikonNlog(y: number): number {
  const a = 650.0 / 1023.0;
  const b = 0.0075;
  const c = 150.0 / 1023.0;
  const d = 619.0 / 1023.0;
  const yCut = 452.0 / 1023.0;
  if (y < yCut) {
    return Math.pow(Math.max(0, y) / a, 3) - b;
  }
  return Math.exp((y - d) / c);
}

/** Leica L-Log (Leica L-Log Reference Manual, Leica Camera AG, 2022) */
function eotfLeicaLlog(y: number): number {
  if (y <= 0.138) {
    return (y - 0.09) / 8.0;
  }
  return (Math.pow(10, (y - 0.6) / 0.27) - 0.0115) / 1.3;
}

/** Apple Log (Apple Log Profile White Paper, Apple Inc., Sep 2023) */
function eotfAppleLog(y: number): number {
  const R0 = -0.05641088;
  const Rt = 0.01;
  const c = 47.28711236;
  const beta = 0.00964052;
  const gamma = 0.08550479;
  const delta = 0.69336945;
  const Pt = c * (Rt - R0) * (Rt - R0); // ~0.20855532

  if (y >= Pt) {
    return Math.pow(2, (y - delta) / gamma) - beta;
  }
  if (y >= 0) {
    return Math.sqrt(y / c) + R0;
  }
  return R0;
}

/** Canon C-Log3 (Canon Log 3 Technical Information, Canon Inc., 2016; scene reflectance R = 0.9 * in) */
function eotfCanonClog3(y: number): number {
  let lin90: number;
  if (y > 0.105357102) {
    lin90 = (Math.pow(10, (y - 0.069886632) / 0.42889912) - 1.0) / 14.98325;
  } else if (y < 0.04076162) {
    lin90 = -(Math.pow(10, (0.07623209 - y) / 0.42889912) - 1.0) / 14.98325;
  } else {
    lin90 = (y - 0.073059361) / 2.3069815;
  }
  return 0.9 * lin90;
}

/** Panasonic V-Log (Panasonic V-Log / V-Gamut Reference Manual Rev. 1.0, 2014) */
function eotfPanasonicVlog(y: number): number {
  if (y < 0.181) {
    return (y - 0.125) / 5.6;
  }
  return Math.pow(10, (y - 0.598206) / 0.241514) - 0.00873;
}

// ===================== Filmic Rec.709 Display Transform (RRT + sRGB ODT) =====================

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function linearToSrgb(v: number): number {
  const c = clamp01(v);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Strictly monotonic ACES-like filmic rational shoulder mapping:
 * - x = 0.00 -> display 0.000
 * - x = 0.18 (18% middle gray) -> display 0.435 (within 0.41..0.46 cinema/broadcast Rec.709 standard)
 * - x = 0.90 (90% diffuse white) -> display 0.830
 * - Asymptotically approaches 1.0 without harsh highlight clipping even at +8 stops.
 */
function filmicDisplayToneMap(lin: number): number {
  if (lin <= 0) return 0;
  const x = lin * 0.66;
  const mapped = (x * (2.51 * x + 0.03)) / (x * (2.51 * x + 0.59) + 0.14);
  return linearToSrgb(mapped);
}

/**
 * Luminance-preserving soft gamut mapping into Rec.709 when wide-gamut matrices
 * yield small negative components. Neutral grays (r === g === b >= 0) are untouched.
 */
function softClipRec709Linear(
  rIn: number,
  gIn: number,
  bIn: number,
): [number, number, number] {
  let r = rIn;
  let g = gIn;
  let b = bIn;
  const minC = Math.min(r, g, b);
  if (minC < 0) {
    const lum = Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b);
    if (lum <= 1e-6) {
      return [0, 0, 0];
    }
    const t = lum / (lum - minC);
    r = lum + (r - lum) * t;
    g = lum + (g - lum) * t;
    b = lum + (b - lum) * t;
  }
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
}

interface InternalLogProfile extends LogProfileSpec {
  eotf: (y: number) => number;
  matrix: Mat3;
  /** Optional linear chroma boost for quasi-log Rec.709 profiles that shoot desaturated (neutral grays unaffected) */
  linearChromaGain?: number;
}

const INTERNAL_PROFILES: readonly InternalLogProfile[] = [
  {
    id: 'dji-dlog',
    brand: 'dji',
    brandLabel: 'DJI 大疆',
    name: 'DJI D-Log',
    gamut: 'D-Gamut → Rec.709',
    cameras: 'Mavic 3 Pro / Inspire 3 / Ronin 4D / Air 2S',
    reference: 'DJI Cinema Color System White Paper (D-Log / D-Gamut)',
    description: '大疆专业 10-bit 宽色域 Log，按官方白皮书分段 EOTF 与 D-Gamut 原色矩阵精确还原。',
    defaultExposure: 0,
    eotf: eotfDjiDlog,
    matrix: MAT_DGAMUT_TO_709,
  },
  {
    id: 'dji-dlog-m',
    brand: 'dji',
    brandLabel: 'DJI 大疆',
    name: 'DJI D-Log M',
    gamut: 'Rec.709 准 Log 还原',
    cameras: 'Osmo Pocket 3 / Mini 4 Pro / Air 3 / Action 4·5 Pro',
    reference: 'DJI D-Log M 官方 Rec.709 准 Log 曲线拟合',
    description: '专为 Pocket 3 与消费级无人机校准的 10-bit 扁平曲线（原生 Rec.709 色域，避免误套 D-Gamut 偏色）。',
    defaultExposure: 0,
    eotf: eotfDjiDlogM,
    matrix: IDENTITY_MAT3,
    linearChromaGain: 1.16,
  },
  {
    id: 'insta360-ilog',
    brand: 'insta360',
    brandLabel: 'Insta360 影石',
    name: 'Insta360 I-Log',
    gamut: 'Rec.709 还原',
    cameras: 'Ace Pro / Ace Pro 2 / X4 / GO 3S',
    reference: 'Insta360 I-Log 官方 Rec.709 还原特性拟合',
    description: '针对影石运动与全景相机的 I-Log 灰片特性，重建对比度、黑位与自然天空肤色。',
    defaultExposure: 0,
    eotf: eotfInsta360Ilog,
    matrix: IDENTITY_MAT3,
    linearChromaGain: 1.2,
  },
  {
    id: 'sony-slog3-cine',
    brand: 'sony',
    brandLabel: 'Sony 索尼',
    name: 'Sony S-Log3.Cine',
    gamut: 'S-Gamut3.Cine → Rec.709',
    cameras: 'FX3 / FX30 / A7M4 / A7S3 / A7C2 / ZV-E1',
    reference: 'Sony Technical Summary (S-Log3 / S-Gamut3.Cine)',
    description: '索尼微单与电影机最常用的 S-Log3 搭配 S-Gamut3.Cine 色域，18% 中灰精准对齐 41% IRE。',
    defaultExposure: 0,
    eotf: eotfSonySlog3,
    matrix: MAT_SGAMUT3_CINE_TO_709,
  },
  {
    id: 'sony-slog3',
    brand: 'sony',
    brandLabel: 'Sony 索尼',
    name: 'Sony S-Log3',
    gamut: 'S-Gamut3 → Rec.709',
    cameras: 'FX6 / FX9 / A1 / A7S3 / VENICE',
    reference: 'Sony Technical Summary (S-Log3 / S-Gamut3)',
    description: '标准宽色域 S-Gamut3 搭配 S-Log3 对数传递曲线，保留超高动态范围高光平滑滚降。',
    defaultExposure: 0,
    eotf: eotfSonySlog3,
    matrix: MAT_SGAMUT3_TO_709,
  },
  {
    id: 'sony-slog2',
    brand: 'sony',
    brandLabel: 'Sony 索尼',
    name: 'Sony S-Log2',
    gamut: 'S-Gamut → Rec.709',
    cameras: 'A7M3 / A6400 / A6600 / RX100 VII',
    reference: 'Sony S-Log2 Technical Summary (32% IRE 中灰)',
    description: '经典 8-bit 索尼微单 S-Log2 还原，按官方 32% IRE 中灰与 S-Gamut 原色矩阵解算。',
    defaultExposure: 0,
    eotf: eotfSonySlog2,
    matrix: MAT_SGAMUT3_TO_709,
  },
  {
    id: 'nikon-nlog',
    brand: 'nikon',
    brandLabel: 'Nikon 尼康',
    name: 'Nikon N-Log',
    gamut: 'BT.2020 → Rec.709',
    cameras: 'Z6 III / Z8 / Z9 / Zf / ZR',
    reference: 'Nikon N-Log Specification Document Ver. 1.00',
    description: '尼康官方立方/对数混合传递公式搭配 ITU-R BT.2020 广色域矩阵，还原沉稳通透影调。',
    defaultExposure: 0,
    eotf: eotfNikonNlog,
    matrix: MAT_BT2020_TO_709,
  },
  {
    id: 'leica-llog',
    brand: 'leica',
    brandLabel: 'Leica 徕卡',
    name: 'Leica L-Log',
    gamut: 'BT.2020 → Rec.709',
    cameras: 'SL2-S / SL3 / Q3',
    reference: 'Leica L-Log Reference Manual (Leica Camera AG)',
    description: '徕卡官方 L-Log 线性+对数传递函数与 BT.2020 矩阵，忠实呈现德系高光过渡与厚重暗部。',
    defaultExposure: 0,
    eotf: eotfLeicaLlog,
    matrix: MAT_BT2020_TO_709,
  },
  {
    id: 'apple-log',
    brand: 'other',
    brandLabel: 'Apple 苹果',
    name: 'Apple Log',
    gamut: 'BT.2020 → Rec.709',
    cameras: 'iPhone 15 Pro / 16 Pro (ProRes Log)',
    reference: 'Apple Log Profile White Paper (Sep 2023)',
    description: '苹果官方二次方+Log2 分段公式（48.8% IRE 中灰）搭配 BT.2020 矩阵，直出干净胶片感。',
    defaultExposure: 0,
    eotf: eotfAppleLog,
    matrix: MAT_BT2020_TO_709,
  },
  {
    id: 'canon-clog3',
    brand: 'other',
    brandLabel: 'Canon 佳能',
    name: 'Canon C-Log3',
    gamut: 'Cinema Gamut → Rec.709',
    cameras: 'EOS R5 / R5 II / R6 II / C70 / R5C',
    reference: 'Canon Log 3 Technical Information (Canon Inc.)',
    description: '佳能官方三段式 C-Log3 公式与 Cinema Gamut 电影原色矩阵，自然承接红润肤色。',
    defaultExposure: 0,
    eotf: eotfCanonClog3,
    matrix: MAT_CANON_CINEMA_TO_709,
  },
  {
    id: 'panasonic-vlog',
    brand: 'other',
    brandLabel: 'Panasonic 松下',
    name: 'Panasonic V-Log',
    gamut: 'V-Gamut → Rec.709',
    cameras: 'LUMIX S5 II / S5 IIX / GH7 / S1H',
    reference: 'Panasonic V-Log / V-Gamut Reference Manual Rev. 1.0',
    description: '松下官方 V-Log 对数公式（42.3% IRE 中灰）搭配 V-Gamut 广色域矩阵，还原精准色彩。',
    defaultExposure: 0,
    eotf: eotfPanasonicVlog,
    matrix: MAT_VGAMUT_TO_709,
  },
];

const PROFILE_MAP = new Map<string, InternalLogProfile>(
  INTERNAL_PROFILES.map((p) => [p.id, p]),
);

const LUT33_CACHE = new Map<string, Lut3D>();

/** Public metadata catalog of all 11 authentic Log restoration profiles. */
export const LOG_PROFILES: readonly LogProfileSpec[] = INTERNAL_PROFILES.map(
  ({ eotf: _e, matrix: _m, linearChromaGain: _c, ...spec }) => spec,
);

/**
 * Evaluate an authentic Log-to-Rec.709 restoration transform directly for a single normalized RGB triplet.
 */
export function evalLogProfileRgb(
  id: string,
  rIn: number,
  gIn: number,
  bIn: number,
): [number, number, number] {
  const profile = PROFILE_MAP.get(id);
  if (!profile) {
    throw new Error(`未知的 Log 配置文件：${id}`);
  }

  // 1. Official EOTF: Log code value [0..1] -> Scene-Linear reflectance (18% gray = 0.18)
  let lr = profile.eotf(rIn);
  let lg = profile.eotf(gIn);
  let lb = profile.eotf(bIn);

  if (profile.defaultExposure !== 0) {
    const scale = Math.pow(2, profile.defaultExposure);
    lr *= scale;
    lg *= scale;
    lb *= scale;
  }

  // 2. Official 3×3 Gamut -> Rec.709 linear matrix
  [lr, lg, lb] = mulMat3Vec(profile.matrix, lr, lg, lb);

  // 3. Optional linear chroma restoration for quasi-log Rec.709 profiles (neutral grays identical)
  if (profile.linearChromaGain && profile.linearChromaGain !== 1) {
    const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    const g = profile.linearChromaGain;
    lr = lum + (lr - lum) * g;
    lg = lum + (lg - lum) * g;
    lb = lum + (lb - lum) * g;
  }

  // 4. Luminance-preserving soft gamut clip into Rec.709
  [lr, lg, lb] = softClipRec709Linear(lr, lg, lb);

  // 5. Smooth filmic display tone mapping + sRGB/Rec.709 display OETF
  return [
    filmicDisplayToneMap(lr),
    filmicDisplayToneMap(lg),
    filmicDisplayToneMap(lb),
  ];
}

/**
 * Lazily generate and cache a 33×33×33 3D LUT for a built-in Log profile.
 */
export function getLogProfileLut33(id: string): Lut3D {
  const cached = LUT33_CACHE.get(id);
  if (cached) return cached;

  const profile = PROFILE_MAP.get(id);
  if (!profile) {
    throw new Error(`未知的 Log 配置文件：${id}`);
  }

  const size = 33;
  const data = new Float32Array(size * size * size * 3);
  const denom = size - 1;

  for (let b = 0; b < size; b++) {
    const vb = b / denom;
    for (let g = 0; g < size; g++) {
      const vg = g / denom;
      for (let r = 0; r < size; r++) {
        const vr = r / denom;
        const [or, og, ob] = evalLogProfileRgb(id, vr, vg, vb);
        const idx = ((b * size + g) * size + r) * 3;
        data[idx] = or;
        data[idx + 1] = og;
        data[idx + 2] = ob;
      }
    }
  }

  const lut: Lut3D = {
    title: `${profile.name} to Rec.709`,
    size,
    data,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
  };
  LUT33_CACHE.set(id, lut);
  return lut;
}

export interface BakeCombinedLutOptions {
  logProfileId?: string | null;
  baseLut?: Lut3D | null;
  baseStrength?: number;
  grade?: GradeParams;
  creativeLut?: Lut3D | null;
  creativeStrength?: number;
  title?: string;
}

/**
 * Bake the full active color pipeline (Stage-1 Log/Base LUT -> GradeParams -> Stage-2 Creative LUT)
 * into a standard 33×33×33 `.cube`-ready `Lut3D` for export to DaVinci Resolve / Premiere / Jianying.
 */
export function bakeCombinedCubeLut33(opts: BakeCombinedLutOptions): Lut3D {
  const size = 33;
  const data = new Float32Array(size * size * size * 3);
  const denom = size - 1;

  const baseStrength = clamp01(opts.baseStrength ?? 1);
  const creativeStrength = clamp01(opts.creativeStrength ?? 1);
  const useCustomBaseLut = opts.baseLut ?? null;
  const useLogId = !useCustomBaseLut && opts.logProfileId ? opts.logProfileId : null;

  if (useLogId && !PROFILE_MAP.has(useLogId)) {
    throw new Error(`未知的 Log 配置文件：${useLogId}`);
  }

  for (let bi = 0; bi < size; bi++) {
    const b0 = bi / denom;
    for (let gi = 0; gi < size; gi++) {
      const g0 = gi / denom;
      for (let ri = 0; ri < size; ri++) {
        const r0 = ri / denom;

        let r = r0;
        let g = g0;
        let b = b0;

        // Stage 1: Base LUT or Log Profile restoration
        if (baseStrength > 1e-5) {
          if (useCustomBaseLut) {
            const [lr, lg, lb] = evaluateLut3D(useCustomBaseLut, r, g, b);
            r = r + (lr - r) * baseStrength;
            g = g + (lg - g) * baseStrength;
            b = b + (lb - b) * baseStrength;
          } else if (useLogId) {
            const [lr, lg, lb] = evalLogProfileRgb(useLogId, r, g, b);
            r = r + (lr - r) * baseStrength;
            g = g + (lg - g) * baseStrength;
            b = b + (lb - b) * baseStrength;
          }
        }

        // Stage 2: Point-wise GradeParams
        if (opts.grade) {
          [r, g, b] = evaluateGradePixelCpu(r, g, b, opts.grade);
        }

        // Stage 3: Creative 3D LUT
        if (opts.creativeLut && creativeStrength > 1e-5) {
          const [cr, cg, cb] = evaluateLut3D(opts.creativeLut, r, g, b);
          r = r + (cr - r) * creativeStrength;
          g = g + (cg - g) * creativeStrength;
          b = b + (cb - b) * creativeStrength;
        }

        const idx = ((bi * size + gi) * size + ri) * 3;
        data[idx] = clamp01(r);
        data[idx + 1] = clamp01(g);
        data[idx + 2] = clamp01(b);
      }
    }
  }

  return {
    title: opts.title ?? 'Mercury Combined 33x33x33 LUT',
    size,
    data,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
  };
}
