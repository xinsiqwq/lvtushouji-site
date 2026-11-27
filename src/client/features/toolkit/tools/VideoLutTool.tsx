import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clapperboard,
  Download,
  Eye,
  FileCode2,
  Film,
  FolderOpen,
  Layers,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  SlidersHorizontal,
  SplitSquareHorizontal,
  Stamp,
  Star,
  Trash2,
  Upload,
  Video,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useRouter } from '../../../lib/router';
import {
  DEFAULT_GRADE_PARAMS,
  blendGradeParams,
  cloneGradeParams,
  type GradeParams,
  type GradePreset,
  type LogBrand,
  type LogProfileSpec,
  type Lut3D,
} from '../color/grade-types';
import { parseCubeLut, serializeCubeLut } from '../color/cube-lut';
import { GRADE_PRESETS } from '../color/grade-presets';
import {
  LOG_PROFILES,
  bakeCombinedCubeLut33,
  getLogProfileLut33,
} from '../color/log-profiles';
import { setToolkitHandoff } from '../color/media-handoff';
import { WebGLColorPipeline } from '../color/webgl-color-pipeline';

type BrandFilter = 'all' | LogBrand;
type ExportResolution = 'source' | '1080p' | '720p';
type ExportBitrate = 'high' | 'standard';

interface PreAdjustState {
  exposure: number;
  temperature: number;
  tint: number;
  contrast: number;
  highlights: number;
  shadows: number;
  saturation: number;
}

interface CustomBaseLutEntry {
  id: string;
  title: string;
  fileName: string;
  size: number;
  lut: Lut3D;
}

interface FavoriteCubeMeta {
  id: string;
  title: string;
  fileName: string;
  size: number;
  savedAt: number;
}

interface VideoSourceInfo {
  mode: 'demo' | 'local';
  name: string;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

interface HistogramSnapshot {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  max: number;
  blackClipPct: number;
  whiteClipPct: number;
}

interface ExportMimeOption {
  mime: string;
  ext: 'mp4' | 'webm';
  label: string;
}

const DEFAULT_PRE_ADJUST: PreAdjustState = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  saturation: 0,
};

const DEMO_WIDTH = 1280;
const DEMO_HEIGHT = 720;
const DEMO_DURATION = 8;
const FAVORITES_STORAGE_KEY = 'lvtushouji:video-lut-favorites:v1';

const BRAND_FILTERS: ReadonlyArray<{ id: BrandFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'dji', label: 'DJI 大疆' },
  { id: 'insta360', label: 'Insta360 影石' },
  { id: 'sony', label: 'Sony 索尼' },
  { id: 'nikon', label: 'Nikon 尼康' },
  { id: 'leica', label: 'Leica 徕卡' },
  { id: 'other', label: 'Apple · 佳能 · 松下' },
];

const EXPORT_MIME_CANDIDATES: readonly ExportMimeOption[] = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264)' },
  { mime: 'video/mp4', ext: 'mp4', label: 'MP4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WebM (VP9)' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WebM (VP8)' },
  { mime: 'video/webm', ext: 'webm', label: 'WebM' },
];

const FEATURED_LOOK_PATTERNS: ReadonlyArray<{ keywords: string[]; shortLabel: string }> = [
  { keywords: ['classic chrome', 'chrome'], shortLabel: '富士 Classic Chrome' },
  { keywords: ['青橙', 'teal'], shortLabel: '青橙电影' },
  { keywords: ['cinestill', '800t'], shortLabel: 'CineStill 800T' },
  { keywords: ['portra', '400'], shortLabel: 'Kodak Portra 400' },
  { keywords: ['黑金', '夜景'], shortLabel: '黑金都市夜景' },
  { keywords: ['日系', '清透'], shortLabel: '日系清透' },
];

const COLOR_CHECKER_LINEAR: ReadonlyArray<{
  label: string;
  rgb: [number, number, number];
}> = [
  { label: '深肤', rgb: [0.16, 0.085, 0.055] },
  { label: '自然肤', rgb: [0.42, 0.24, 0.165] },
  { label: '蓝天', rgb: [0.095, 0.21, 0.44] },
  { label: '林绿', rgb: [0.09, 0.175, 0.075] },
  { label: '湖青', rgb: [0.12, 0.34, 0.36] },
  { label: '暖橙', rgb: [0.56, 0.24, 0.065] },
  { label: '朱红', rgb: [0.44, 0.075, 0.08] },
  { label: '18%灰', rgb: [0.18, 0.18, 0.18] },
];

const GRAY_RAMP_LINEAR = [0.015, 0.06, 0.18, 0.48, 1.15] as const;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function sanitizeFileSlug(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return base.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 48) || 'video-lut';
}

function pickBestExportMime(): ExportMimeOption | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  for (const candidate of EXPORT_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate.mime)) {
        return candidate;
      }
    } catch {
      // Ignore probe error
    }
  }
  return null;
}

function computeExportDimensions(
  srcW: number,
  srcH: number,
  preset: ExportResolution,
): { width: number; height: number } {
  const safeW = Math.max(2, Math.round(srcW));
  const safeH = Math.max(2, Math.round(srcH));
  if (preset === 'source') {
    return {
      width: Math.max(2, Math.floor(safeW / 2) * 2),
      height: Math.max(2, Math.floor(safeH / 2) * 2),
    };
  }
  const targetShort = preset === '1080p' ? 1080 : 720;
  const targetLong = preset === '1080p' ? 1920 : 1280;
  const isLandscape = safeW >= safeH;
  const maxW = isLandscape ? targetLong : targetShort;
  const maxH = isLandscape ? targetShort : targetLong;
  const scale = Math.min(1, maxW / safeW, maxH / safeH);
  return {
    width: Math.max(2, Math.floor((safeW * scale) / 2) * 2),
    height: Math.max(2, Math.floor((safeH * scale) / 2) * 2),
  };
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 12000);
}

/**
 * Encodes scene-linear reflectance into authentic Sony S-Log3 0..1 normalized code values
 * (black floor ~0.093, 18% grey = 0.411, 90% white = 0.612, sunlit snow ~0.68).
 */
function encodeSLog3Channel(linear: number): number {
  const v = Math.max(0, linear);
  if (v >= 0.01125) {
    const code = 420 + Math.log10((v + 0.01) / (0.18 + 0.01)) * 261.5;
    return clamp(code / 1023, 0, 1);
  }
  const code = (v * (171.2102946929 - 95)) / 0.01125 + 95;
  return clamp(code / 1023, 0, 1);
}

function logCss(rLin: number, gLin: number, bLin: number, alpha = 1): string {
  const r = Math.round(encodeSLog3Channel(rLin) * 255);
  const g = Math.round(encodeSLog3Channel(gLin) * 255);
  const b = Math.round(encodeSLog3Channel(bLin) * 255);
  if (alpha >= 0.999) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

/**
 * Draws an animated procedural scene encoded in authentic flat Log gamma (S-Log3 transfer curve):
 * drifting alpine sky, golden-hour sunlit snow ridges, pine slope, shimmering lake reflections,
 * plus an unobtrusive DIT ColorChecker + 18% grey calibration strip for immediate Before/After inspection.
 */
function drawSyntheticLogFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  timeSec: number,
): void {
  const phase = ((timeSec % DEMO_DURATION) / DEMO_DURATION) * Math.PI * 2;
  const driftX = Math.sin(phase) * width * 0.045;
  const sunShiftX = Math.sin(phase) * width * 0.025;
  const sunShiftY = Math.cos(phase) * height * 0.012;
  const horizonY = height * 0.62;

  // 1. Alpine sky encoded in flat Log curve
  const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
  skyGrad.addColorStop(0, logCss(0.055, 0.145, 0.44));
  skyGrad.addColorStop(0.45, logCss(0.14, 0.28, 0.56));
  skyGrad.addColorStop(0.78, logCss(0.48, 0.44, 0.42));
  skyGrad.addColorStop(1, logCss(1.05, 0.64, 0.32));
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, width, horizonY + 2);

  // 2. Low golden sun atmospheric bloom
  const sunX = width * 0.68 + sunShiftX;
  const sunY = horizonY - height * 0.16 + sunShiftY;
  const sunGlow = ctx.createRadialGradient(sunX, sunY, width * 0.01, sunX, sunY, width * 0.34);
  sunGlow.addColorStop(0, logCss(2.2, 1.65, 0.95, 0.92));
  sunGlow.addColorStop(0.22, logCss(1.35, 0.78, 0.36, 0.55));
  sunGlow.addColorStop(0.6, logCss(0.68, 0.38, 0.22, 0.18));
  sunGlow.addColorStop(1, logCss(0.2, 0.24, 0.35, 0));
  ctx.fillStyle = sunGlow;
  ctx.fillRect(0, 0, width, horizonY + 4);

  // 3. Soft drifting high-altitude clouds
  ctx.save();
  for (let i = 0; i < 4; i += 1) {
    const cx = width * (0.18 + i * 0.23) + driftX * (0.7 + i * 0.22);
    const cy = height * (0.18 + (i % 2) * 0.11);
    const rx = width * (0.14 + (i % 3) * 0.03);
    const ry = height * 0.036;
    const cloudGrad = ctx.createLinearGradient(cx, cy - ry, cx, cy + ry);
    cloudGrad.addColorStop(0, logCss(1.55, 1.32, 1.02, 0.68));
    cloudGrad.addColorStop(1, logCss(0.32, 0.34, 0.44, 0.2));
    ctx.fillStyle = cloudGrad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 4. Distant snow-capped peaks (cool shadow side + warm sunlit ridge)
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  ctx.lineTo(width * 0.12, height * 0.41);
  ctx.lineTo(width * 0.24, height * 0.48);
  ctx.lineTo(width * 0.39, height * 0.29);
  ctx.lineTo(width * 0.52, height * 0.45);
  ctx.lineTo(width * 0.67, height * 0.33);
  ctx.lineTo(width * 0.84, height * 0.46);
  ctx.lineTo(width, height * 0.38);
  ctx.lineTo(width, horizonY);
  ctx.closePath();
  const farPeakGrad = ctx.createLinearGradient(0, height * 0.28, 0, horizonY);
  farPeakGrad.addColorStop(0, logCss(1.55, 1.48, 1.56));
  farPeakGrad.addColorStop(0.45, logCss(0.24, 0.29, 0.42));
  farPeakGrad.addColorStop(1, logCss(0.08, 0.11, 0.18));
  ctx.fillStyle = farPeakGrad;
  ctx.fill();

  // Sunlit snow faces on right-facing slopes
  const drawSunFace = (pts: ReadonlyArray<[number, number]>, r: number, g: number, b: number) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = logCss(r, g, b, 0.85);
    ctx.fill();
  };
  drawSunFace(
    [
      [width * 0.39, height * 0.29],
      [width * 0.465, height * 0.41],
      [width * 0.415, height * 0.445],
    ],
    1.75,
    1.34,
    0.88,
  );
  drawSunFace(
    [
      [width * 0.67, height * 0.33],
      [width * 0.76, height * 0.43],
      [width * 0.70, height * 0.455],
    ],
    1.85,
    1.38,
    0.92,
  );

  // 5. Mid-ground dark conifer mountain ridge (tests shadow detail & foliage green)
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  ctx.lineTo(0, height * 0.51);
  ctx.lineTo(width * 0.17, height * 0.46);
  ctx.lineTo(width * 0.31, height * 0.55);
  ctx.lineTo(width * 0.48, height * 0.49);
  ctx.lineTo(width * 0.64, height * 0.57);
  ctx.lineTo(width * 0.82, height * 0.49);
  ctx.lineTo(width, height * 0.54);
  ctx.lineTo(width, horizonY);
  ctx.closePath();
  const midRidgeGrad = ctx.createLinearGradient(0, height * 0.45, 0, horizonY);
  midRidgeGrad.addColorStop(0, logCss(0.055, 0.125, 0.07));
  midRidgeGrad.addColorStop(1, logCss(0.02, 0.048, 0.032));
  ctx.fillStyle = midRidgeGrad;
  ctx.fill();

  // 6. Calm alpine lake reflection + shimmering water ripples
  const lakeGrad = ctx.createLinearGradient(0, horizonY, 0, height);
  lakeGrad.addColorStop(0, logCss(0.42, 0.34, 0.28));
  lakeGrad.addColorStop(0.28, logCss(0.09, 0.19, 0.32));
  lakeGrad.addColorStop(0.75, logCss(0.035, 0.095, 0.17));
  lakeGrad.addColorStop(1, logCss(0.015, 0.035, 0.065));
  ctx.fillStyle = lakeGrad;
  ctx.fillRect(0, horizonY, width, height - horizonY);

  // Shimmering sun-path reflections on water
  for (let i = 0; i < 18; i += 1) {
    const t = i / 17;
    const ry = horizonY + 8 + t * (height - horizonY - 20);
    const wave = Math.sin(phase * 2 + i * 1.15) * (10 + t * 24);
    const rw = width * (0.04 + t * 0.12);
    const rh = Math.max(1.5, 2 + t * 3.5);
    ctx.fillStyle = logCss(1.25 - t * 0.55, 0.78 - t * 0.35, 0.36 - t * 0.12, 0.34 - t * 0.14);
    ctx.fillRect(sunX - rw * 0.5 + wave, ry, rw, rh);
  }

  // 7. Foreground dark rock shoreline on left
  ctx.beginPath();
  ctx.moveTo(0, height);
  ctx.lineTo(0, height * 0.74);
  ctx.quadraticCurveTo(width * 0.14, height * 0.77, width * 0.28, height);
  ctx.closePath();
  ctx.fillStyle = logCss(0.012, 0.014, 0.016);
  ctx.fill();

  // 8. Minimal DIT ColorChecker + 5-step grayscale calibration strip (bottom-right)
  const pad = Math.round(width * 0.022);
  const sw = Math.round(width * 0.033);
  const sh = Math.round(height * 0.042);
  const gap = Math.max(3, Math.round(width * 0.004));
  const chartW = COLOR_CHECKER_LINEAR.length * sw + (COLOR_CHECKER_LINEAR.length - 1) * gap + 16;
  const chartH = sh * 2 + gap + 24;
  const chartX = width - pad - chartW;
  const chartY = height - pad - chartH;

  ctx.fillStyle = logCss(0.03, 0.032, 0.036, 0.78);
  ctx.fillRect(chartX, chartY, chartW, chartH);
  ctx.strokeStyle = logCss(0.28, 0.28, 0.28, 0.45);
  ctx.lineWidth = 1;
  ctx.strokeRect(chartX + 0.5, chartY + 0.5, chartW - 1, chartH - 1);

  COLOR_CHECKER_LINEAR.forEach((patch, idx) => {
    const px = chartX + 8 + idx * (sw + gap);
    const py = chartY + 8;
    ctx.fillStyle = logCss(patch.rgb[0], patch.rgb[1], patch.rgb[2]);
    ctx.fillRect(px, py, sw, sh);
  });

  // Grayscale exposure ramp + skin-tone gradient bar on row 2
  const rampCount = GRAY_RAMP_LINEAR.length;
  const rampW = Math.floor((chartW - 16 - (rampCount - 1) * gap) / rampCount);
  GRAY_RAMP_LINEAR.forEach((val, idx) => {
    const rx = chartX + 8 + idx * (rampW + gap);
    const ry = chartY + 8 + sh + gap;
    ctx.fillStyle = logCss(val, val, val);
    ctx.fillRect(rx, ry, rampW, sh);
  });

  // Subtle scene slate text (top-left, encoded in neutral Log white)
  ctx.font = `500 ${Math.max(11, Math.round(width * 0.0115))}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = logCss(0.52, 0.52, 0.52, 0.85);
  ctx.fillText(
    `LOG GAMMA TEST · 18% GREY 41% IRE · TC ${formatTimecode(timeSec)}`,
    pad,
    pad + 12,
  );
}

function loadFavoriteMetas(): FavoriteCubeMeta[] {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is FavoriteCubeMeta =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as FavoriteCubeMeta).id === 'string' &&
          typeof (item as FavoriteCubeMeta).title === 'string' &&
          typeof (item as FavoriteCubeMeta).size === 'number',
      )
      .slice(0, 8);
  } catch {
    return [];
  }
}

function persistFavoriteMetas(items: FavoriteCubeMeta[]): void {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(items.slice(0, 8)));
  } catch {
    // Ignore storage quota errors
  }
}

function buildHistogramPath(bins: Uint32Array, maxVal: number, width: number, height: number): string {
  const n = bins.length;
  if (n === 0 || maxVal <= 0) return '';
  const stepX = width / Math.max(1, n - 1);
  let d = `M 0 ${height}`;
  for (let i = 0; i < n; i += 1) {
    const norm = Math.sqrt(Math.min(1, bins[i] / maxVal));
    const x = i * stepX;
    const y = height - norm * (height - 4);
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  d += ` L ${width} ${height} Z`;
  return d;
}

function buildHistogramStroke(bins: Uint32Array, maxVal: number, width: number, height: number): string {
  const n = bins.length;
  if (n === 0 || maxVal <= 0) return '';
  const stepX = width / Math.max(1, n - 1);
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const norm = Math.sqrt(Math.min(1, bins[i] / maxVal));
    const x = i * stepX;
    const y = height - norm * (height - 4);
    d += `${i === 0 ? 'M' : ' L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

function combinePreAndCreativePreset(
  pre: PreAdjustState,
  creativePreset: GradePreset | null,
  creativePresetStrengthPct: number,
): GradeParams {
  const base = creativePreset
    ? blendGradeParams(
        DEFAULT_GRADE_PARAMS,
        creativePreset.params,
        clamp(creativePresetStrengthPct / 100, 0, 1),
      )
    : cloneGradeParams(DEFAULT_GRADE_PARAMS);

  return {
    ...base,
    exposure: clamp(base.exposure + pre.exposure, -2, 2),
    temperature: clamp(base.temperature + pre.temperature, -100, 100),
    tint: clamp(base.tint + pre.tint, -100, 100),
    contrast: clamp(base.contrast + pre.contrast, -100, 100),
    highlights: clamp(base.highlights + pre.highlights, -100, 100),
    shadows: clamp(base.shadows + pre.shadows, -100, 100),
    saturation: clamp(base.saturation + pre.saturation, -100, 100),
  };
}

export default function VideoLutTool() {
  const { navigate } = useRouter();

  // Default profile: DJI D-Log M or Sony S-Log3.Cine (whichever exists first)
  const initialProfileId = useMemo(() => {
    const preferred =
      LOG_PROFILES.find((p) => p.id === 'sony-slog3-cine') ??
      LOG_PROFILES.find((p) => p.id === 'dji-dlog-m') ??
      LOG_PROFILES[0];
    return preferred?.id ?? 'sony-slog3-cine';
  }, []);

  // Video source state
  const [sourceInfo, setSourceInfo] = useState<VideoSourceInfo>({
    mode: 'demo',
    name: '内置 Log 模拟灰片样片',
    width: DEMO_WIDTH,
    height: DEMO_HEIGHT,
    duration: DEMO_DURATION,
    hasAudio: false,
  });
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [isDraggingVideo, setIsDraggingVideo] = useState(false);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLooping, setIsLooping] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<0.5 | 1>(1);

  // Split-screen & before/after compare
  const [splitEnabled, setSplitEnabled] = useState(true);
  const [splitPosition, setSplitPosition] = useState(0.5);
  const [showOriginal, setShowOriginal] = useState(false);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);

  // Stage 1: Official Log Profile or Custom .cube Base LUT
  const [brandFilter, setBrandFilter] = useState<BrandFilter>('all');
  const [selectedProfileId, setSelectedProfileId] = useState<string>(initialProfileId);
  const [customBaseEntry, setCustomBaseEntry] = useState<CustomBaseLutEntry | null>(null);
  const [sessionBaseLuts, setSessionBaseLuts] = useState<Record<string, CustomBaseLutEntry>>({});
  const [favoriteMetas, setFavoriteMetas] = useState<FavoriteCubeMeta[]>(() =>
    typeof window !== 'undefined' ? loadFavoriteMetas() : [],
  );
  const [baseLutStrength, setBaseLutStrength] = useState(100);
  const [baseCubeError, setBaseCubeError] = useState('');
  const [isDraggingBaseCube, setIsDraggingBaseCube] = useState(false);

  // Stage 1.5: Pre-exposure & WB correction
  const [preAdjust, setPreAdjust] = useState<PreAdjustState>({ ...DEFAULT_PRE_ADJUST });

  // Stage 2: Creative look overlay (preset and/or 2nd .cube)
  const [creativePresetId, setCreativePresetId] = useState<string>('');
  const [creativePresetStrength, setCreativePresetStrength] = useState(72);
  const [creativeCubeLut, setCreativeCubeLut] = useState<Lut3D | null>(null);
  const [creativeCubeName, setCreativeCubeName] = useState('');
  const [creativeCubeStrength, setCreativeCubeStrength] = useState(75);
  const [creativeCubeError, setCreativeCubeError] = useState('');

  // Monitor & histogram state
  const [webglError, setWebglError] = useState('');
  const [histogram, setHistogram] = useState<HistogramSnapshot | null>(null);

  // Export state
  const [exportResolution, setExportResolution] = useState<ExportResolution>('source');
  const [exportBitrate, setExportBitrate] = useState<ExportBitrate>('high');
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatusNote, setExportStatusNote] = useState('');
  const [exportError, setExportError] = useState('');
  const [exportedBadge, setExportedBadge] = useState('');
  const [isCapturingFrame, setIsCapturingFrame] = useState(false);
  const [actionNotice, setActionNotice] = useState('');

  // DOM & engine refs
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const baseCubeInputRef = useRef<HTMLInputElement | null>(null);
  const creativeCubeInputRef = useRef<HTMLInputElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipelineRef = useRef<WebGLColorPipeline | null>(null);
  const localVideoUrlRef = useRef<string | null>(null);
  const demoTimeRef = useRef(0);
  const lastFrameTickRef = useRef(0);
  const lastHistTickRef = useRef(0);
  const lastUiTimeTickRef = useRef(0);
  const exportAbortRef = useRef<{ aborted: boolean; stop: () => void } | null>(null);

  // Latest render parameters in a ref for smooth 60fps loop without recreating rAF loops
  const activeProfile: LogProfileSpec | undefined = useMemo(
    () => LOG_PROFILES.find((p) => p.id === selectedProfileId) ?? LOG_PROFILES[0],
    [selectedProfileId],
  );

  const activeBaseLut: Lut3D | null = useMemo(() => {
    if (customBaseEntry) return customBaseEntry.lut;
    if (!activeProfile) return null;
    return getLogProfileLut33(activeProfile.id);
  }, [customBaseEntry, activeProfile]);

  const activeCreativePreset: GradePreset | null = useMemo(
    () => GRADE_PRESETS.find((p) => p.id === creativePresetId) ?? null,
    [creativePresetId],
  );

  const effectiveGradeParams: GradeParams = useMemo(
    () => combinePreAndCreativePreset(preAdjust, activeCreativePreset, creativePresetStrength),
    [preAdjust, activeCreativePreset, creativePresetStrength],
  );

  const filteredProfiles = useMemo(() => {
    if (brandFilter === 'all') return LOG_PROFILES;
    return LOG_PROFILES.filter((p) => p.brand === brandFilter);
  }, [brandFilter]);

  const featuredCreativePresets = useMemo(() => {
    const matched: Array<{ preset: GradePreset; label: string }> = [];
    const seen = new Set<string>();
    for (const pattern of FEATURED_LOOK_PATTERNS) {
      const found = GRADE_PRESETS.find((p) => {
        if (seen.has(p.id)) return false;
        const hay = `${p.id} ${p.name} ${p.subtitle} ${p.reference}`.toLowerCase();
        return pattern.keywords.some((kw) => hay.includes(kw));
      });
      if (found) {
        seen.add(found.id);
        matched.push({ preset: found, label: pattern.shortLabel });
      }
    }
    if (matched.length < 4) {
      for (const preset of GRADE_PRESETS) {
        if (matched.length >= 6) break;
        if (!seen.has(preset.id)) {
          seen.add(preset.id);
          matched.push({ preset, label: preset.name });
        }
      }
    }
    return matched;
  }, []);

  const bestExportMime = useMemo(() => pickBestExportMime(), []);

  const targetExportDims = useMemo(
    () => computeExportDimensions(sourceInfo.width, sourceInfo.height, exportResolution),
    [sourceInfo.width, sourceInfo.height, exportResolution],
  );

  const stage1DisplayLabel = customBaseEntry
    ? `自定义 .cube · ${customBaseEntry.title}`
    : activeProfile?.name ?? 'Log 还原';

  const renderStateRef = useRef({
    params: effectiveGradeParams,
    baseLutStrength,
    creativeLutStrength: creativeCubeLut ? creativeCubeStrength : 0,
    splitEnabled,
    splitPosition,
    showOriginal,
    mode: sourceInfo.mode,
    isPlaying,
    isLooping,
    playbackRate,
    isExportingVideo,
  });

  renderStateRef.current = {
    params: effectiveGradeParams,
    baseLutStrength,
    creativeLutStrength: creativeCubeLut ? creativeCubeStrength : 0,
    splitEnabled,
    splitPosition,
    showOriginal,
    mode: sourceInfo.mode,
    isPlaying,
    isLooping,
    playbackRate,
    isExportingVideo,
  };

  // Update histogram snapshot from pipeline
  const sampleHistogram = useCallback((pipeline: WebGLColorPipeline) => {
    try {
      const raw = pipeline.computeHistogram(160);
      let total = 0;
      for (let i = 0; i < raw.luma.length; i += 1) {
        total += raw.luma[i];
      }
      const lowBins = (raw.luma[0] ?? 0) + (raw.luma[1] ?? 0);
      const highBins =
        (raw.luma[raw.luma.length - 1] ?? 0) + (raw.luma[raw.luma.length - 2] ?? 0);
      const blackClipPct = total > 0 ? (lowBins / total) * 100 : 0;
      const whiteClipPct = total > 0 ? (highBins / total) * 100 : 0;
      setHistogram({
        r: raw.r,
        g: raw.g,
        b: raw.b,
        luma: raw.luma,
        max: raw.max,
        blackClipPct,
        whiteClipPct,
      });
    } catch {
      // Non-fatal histogram skip
    }
  }, []);

  // Render a single frame into the monitor WebGL canvas
  const renderMonitorFrame = useCallback(
    (forceHistogram = false) => {
      const pipeline = pipelineRef.current;
      const glCanvas = glCanvasRef.current;
      if (!pipeline || !glCanvas) return;

      const st = renderStateRef.current;
      let sourceEl: HTMLCanvasElement | HTMLVideoElement | null = null;
      let targetW = DEMO_WIDTH;
      let targetH = DEMO_HEIGHT;

      if (st.mode === 'demo') {
        let demoCanvas = demoCanvasRef.current;
        if (!demoCanvas) {
          demoCanvas = document.createElement('canvas');
          demoCanvas.width = DEMO_WIDTH;
          demoCanvas.height = DEMO_HEIGHT;
          demoCanvasRef.current = demoCanvas;
        }
        const ctx = demoCanvas.getContext('2d');
        if (ctx) {
          drawSyntheticLogFrame(ctx, DEMO_WIDTH, DEMO_HEIGHT, demoTimeRef.current);
        }
        sourceEl = demoCanvas;
      } else {
        const video = videoElRef.current;
        if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
          return;
        }
        // Cap live preview texture size to 1440px wide for smooth 60fps on 4K files
        const scale = Math.min(1, 1440 / Math.max(video.videoWidth, video.videoHeight));
        targetW = Math.max(2, Math.round(video.videoWidth * scale));
        targetH = Math.max(2, Math.round(video.videoHeight * scale));
        sourceEl = video;
      }

      if (!sourceEl) return;

      if (glCanvas.width !== targetW || glCanvas.height !== targetH) {
        glCanvas.width = targetW;
        glCanvas.height = targetH;
      }

      pipeline.setSource(sourceEl);
      pipeline.render({
        params: st.params,
        baseLutStrength: st.baseLutStrength / 100,
        creativeLutStrength: st.creativeLutStrength / 100,
        splitPosition: st.splitEnabled && !st.showOriginal ? st.splitPosition : undefined,
        showOriginal: st.showOriginal,
      });

      const now = performance.now();
      if (forceHistogram || now - lastHistTickRef.current >= 140) {
        lastHistTickRef.current = now;
        sampleHistogram(pipeline);
      }
    },
    [sampleHistogram],
  );

  // Initialize WebGL pipeline on mount
  useEffect(() => {
    const canvas = glCanvasRef.current;
    if (!canvas) return;
    canvas.width = DEMO_WIDTH;
    canvas.height = DEMO_HEIGHT;

    let pipeline: WebGLColorPipeline | null = null;
    try {
      pipeline = new WebGLColorPipeline(canvas);
      pipelineRef.current = pipeline;
      setWebglError('');
    } catch (err) {
      pipelineRef.current = null;
      setWebglError(
        err instanceof Error
          ? err.message
          : '当前浏览器环境不支持 WebGL 实时渲染，请检查硬件加速设置。',
      );
      return;
    }

    return () => {
      pipeline?.dispose();
      pipelineRef.current = null;
    };
  }, []);

  // Sync Stage 1 & Stage 2 3D LUTs to WebGL pipeline
  useEffect(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline) return;
    pipeline.setBaseLut(activeBaseLut);
    renderMonitorFrame(true);
  }, [activeBaseLut, renderMonitorFrame]);

  useEffect(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline) return;
    pipeline.setCreativeLut(creativeCubeLut);
    renderMonitorFrame(true);
  }, [creativeCubeLut, renderMonitorFrame]);

  // Re-render immediately whenever grading sliders or split position change (even while paused)
  useEffect(() => {
    renderMonitorFrame(true);
  }, [
    effectiveGradeParams,
    baseLutStrength,
    creativeCubeStrength,
    splitEnabled,
    splitPosition,
    showOriginal,
    sourceInfo.mode,
    renderMonitorFrame,
  ]);

  // Clean up local object URL & active export on unmount
  useEffect(() => {
    return () => {
      if (exportAbortRef.current) {
        exportAbortRef.current.stop();
        exportAbortRef.current = null;
      }
      if (localVideoUrlRef.current) {
        URL.revokeObjectURL(localVideoUrlRef.current);
        localVideoUrlRef.current = null;
      }
    };
  }, []);

  // Main 60fps animation / video frame loop
  useEffect(() => {
    let rafId = 0;
    let vfcId = 0;
    let cancelled = false;
    lastFrameTickRef.current = performance.now();

    const stepDemo = (now: number) => {
      if (cancelled) return;
      const st = renderStateRef.current;
      const dt = Math.min(0.1, Math.max(0, (now - lastFrameTickRef.current) / 1000));
      lastFrameTickRef.current = now;

      if (st.mode === 'demo' && st.isPlaying && !st.isExportingVideo) {
        let nextTime = demoTimeRef.current + dt * st.playbackRate;
        if (nextTime >= DEMO_DURATION) {
          if (st.isLooping) {
            nextTime %= DEMO_DURATION;
          } else {
            nextTime = DEMO_DURATION;
            setIsPlaying(false);
          }
        }
        demoTimeRef.current = nextTime;
        renderMonitorFrame(false);
        if (now - lastUiTimeTickRef.current >= 80) {
          lastUiTimeTickRef.current = now;
          setCurrentTime(nextTime);
        }
      }
      rafId = window.requestAnimationFrame(stepDemo);
    };

    const video = videoElRef.current;
    const hasVfc =
      sourceInfo.mode === 'local' &&
      video &&
      typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown })
        .requestVideoFrameCallback === 'function';

    if (sourceInfo.mode === 'demo') {
      renderMonitorFrame(true);
      rafId = window.requestAnimationFrame(stepDemo);
    } else if (hasVfc && video) {
      const videoWithVfc = video as HTMLVideoElement & {
        requestVideoFrameCallback: (cb: () => void) => number;
        cancelVideoFrameCallback: (id: number) => void;
      };
      const onVideoFrame = () => {
        if (cancelled) return;
        if (!renderStateRef.current.isExportingVideo) {
          renderMonitorFrame(false);
          const now = performance.now();
          if (now - lastUiTimeTickRef.current >= 80) {
            lastUiTimeTickRef.current = now;
            setCurrentTime(video.currentTime);
          }
        }
        vfcId = videoWithVfc.requestVideoFrameCallback(onVideoFrame);
      };
      vfcId = videoWithVfc.requestVideoFrameCallback(onVideoFrame);
    } else if (sourceInfo.mode === 'local') {
      const stepLocalRaf = () => {
        if (cancelled) return;
        const vid = videoElRef.current;
        if (vid && !vid.paused && !renderStateRef.current.isExportingVideo) {
          renderMonitorFrame(false);
          const now = performance.now();
          if (now - lastUiTimeTickRef.current >= 80) {
            lastUiTimeTickRef.current = now;
            setCurrentTime(vid.currentTime);
          }
        }
        rafId = window.requestAnimationFrame(stepLocalRaf);
      };
      rafId = window.requestAnimationFrame(stepLocalRaf);
    }

    return () => {
      cancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (vfcId && video) {
        const videoWithVfc = video as HTMLVideoElement & {
          cancelVideoFrameCallback?: (id: number) => void;
        };
        videoWithVfc.cancelVideoFrameCallback?.(vfcId);
      }
    };
  }, [sourceInfo.mode, localVideoUrl, renderMonitorFrame]);

  // Sync video element properties when playback controls change
  useEffect(() => {
    const video = videoElRef.current;
    if (!video || sourceInfo.mode !== 'local') return;
    video.loop = isLooping;
    video.muted = isMuted;
    video.playbackRate = playbackRate;
  }, [isLooping, isMuted, playbackRate, sourceInfo.mode]);

  // Load built-in synthetic Log demo clip
  const loadDemoClip = useCallback(() => {
    if (localVideoUrlRef.current) {
      URL.revokeObjectURL(localVideoUrlRef.current);
      localVideoUrlRef.current = null;
    }
    setLocalVideoUrl(null);
    setSourceError('');
    setActionNotice('');
    setExportError('');
    demoTimeRef.current = 0;
    setCurrentTime(0);
    setSourceInfo({
      mode: 'demo',
      name: '内置 Log 模拟灰片样片',
      width: DEMO_WIDTH,
      height: DEMO_HEIGHT,
      duration: DEMO_DURATION,
      hasAudio: false,
    });
    setIsPlaying(true);
  }, []);

  // Load local video file via URL.createObjectURL
  const loadLocalVideoFile = useCallback((file: File) => {
    const looksLikeVideo =
      file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv|ogv)$/i.test(file.name);
    if (!looksLikeVideo) {
      setSourceError('请选择本地视频文件（支持 MP4、MOV、WebM 等浏览器可解码格式）。');
      return;
    }

    setSourceError('');
    setActionNotice('');
    setExportError('');
    setExportedBadge('');

    const nextUrl = URL.createObjectURL(file);
    if (localVideoUrlRef.current) {
      URL.revokeObjectURL(localVideoUrlRef.current);
    }
    localVideoUrlRef.current = nextUrl;
    setLocalVideoUrl(nextUrl);
    setCurrentTime(0);
    setSourceInfo({
      mode: 'local',
      name: file.name,
      width: 1920,
      height: 1080,
      duration: 0,
      hasAudio: true,
    });
  }, []);

  const handleVideoInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) loadLocalVideoFile(file);
  };

  const handleVideoDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingVideo(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (/\.cube$/i.test(file.name)) {
      void handleBaseCubeFile(file);
      return;
    }
    loadLocalVideoFile(file);
  };

  const handleLocalVideoLoadedMetadata = () => {
    const video = videoElRef.current;
    if (!video) return;
    const vw = video.videoWidth || 1920;
    const vh = video.videoHeight || 1080;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;

    // Best-effort check for audio tracks
    const vidAny = video as HTMLVideoElement & {
      mozHasAudio?: boolean;
      webkitAudioDecodedByteCount?: number;
      audioTracks?: { length: number };
    };
    const detectedAudio =
      vidAny.audioTracks !== undefined
        ? vidAny.audioTracks.length > 0
        : vidAny.mozHasAudio !== undefined
          ? vidAny.mozHasAudio
          : true;

    setSourceInfo((prev) => ({
      ...prev,
      mode: 'local',
      width: vw,
      height: vh,
      duration: dur,
      hasAudio: detectedAudio,
    }));
    video.loop = isLooping;
    video.muted = isMuted;
    video.playbackRate = playbackRate;
    void video
      .play()
      .then(() => {
        setIsPlaying(true);
        renderMonitorFrame(true);
      })
      .catch(() => {
        setIsPlaying(false);
        renderMonitorFrame(true);
      });
  };

  const handleLocalVideoError = () => {
    setSourceError(
      '浏览器无法直接解码该视频封装或 10-bit 编码（如部分 ProRes / H.265 4:2:2）。可转码为 H.264 MP4 后导入，或直接导出下方 33³ .cube 到剪映 / DaVinci Resolve 批处理。',
    );
    setIsPlaying(false);
  };

  // Transport controls
  const handleTogglePlay = () => {
    if (isExportingVideo) return;
    if (sourceInfo.mode === 'demo') {
      if (!isPlaying && demoTimeRef.current >= DEMO_DURATION - 0.05) {
        demoTimeRef.current = 0;
        setCurrentTime(0);
      }
      lastFrameTickRef.current = performance.now();
      setIsPlaying((prev) => !prev);
      return;
    }
    const video = videoElRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      if (video.ended) video.currentTime = 0;
      void video
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: ChangeEvent<HTMLInputElement>) => {
    const target = Number(e.target.value);
    if (!Number.isFinite(target)) return;
    setCurrentTime(target);
    if (sourceInfo.mode === 'demo') {
      demoTimeRef.current = clamp(target, 0, DEMO_DURATION);
      renderMonitorFrame(true);
      return;
    }
    const video = videoElRef.current;
    if (video) {
      video.currentTime = clamp(target, 0, sourceInfo.duration || 0);
    }
  };

  // Split divider pointer interaction
  const updateSplitFromClientX = useCallback((clientX: number) => {
    const box = stageBoxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (rect.width <= 0) return;
    const next = clamp((clientX - rect.left) / rect.width, 0.04, 0.96);
    setSplitPosition(next);
  }, []);

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitEnabled || showOriginal) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingSplit(true);
    updateSplitFromClientX(e.clientX);
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingSplit) return;
    updateSplitFromClientX(e.clientX);
  };

  const handleStagePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingSplit) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingSplit(false);
  };

  // Custom Stage 1 Base .cube import & favorites
  const handleBaseCubeFile = useCallback(async (file: File) => {
    setBaseCubeError('');
    try {
      const text = await file.text();
      const parsed = parseCubeLut(text, file.name.replace(/\.cube$/i, ''));
      const id = `${parsed.title}::${parsed.size}`;
      const entry: CustomBaseLutEntry = {
        id,
        title: parsed.title,
        fileName: file.name,
        size: parsed.size,
        lut: parsed,
      };
      setCustomBaseEntry(entry);
      setSessionBaseLuts((prev) => ({ ...prev, [id]: entry }));
      setBaseLutStrength(100);
      setActionNotice(`已载入自定义还原 LUT「${parsed.title}」(${parsed.size}³)。`);
    } catch (err) {
      setBaseCubeError(err instanceof Error ? err.message : '解析 .cube 文件失败。');
    }
  }, []);

  const handleBaseCubeInput = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void handleBaseCubeFile(file);
  };

  const handleBaseCubeDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingBaseCube(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleBaseCubeFile(file);
  };

  const isCurrentBaseFavorited = Boolean(
    customBaseEntry && favoriteMetas.some((f) => f.id === customBaseEntry.id),
  );

  const toggleFavoriteCurrentBase = () => {
    if (!customBaseEntry) return;
    setFavoriteMetas((prev) => {
      const exists = prev.some((f) => f.id === customBaseEntry.id);
      const next = exists
        ? prev.filter((f) => f.id !== customBaseEntry.id)
        : [
            {
              id: customBaseEntry.id,
              title: customBaseEntry.title,
              fileName: customBaseEntry.fileName,
              size: customBaseEntry.size,
              savedAt: Date.now(),
            },
            ...prev,
          ].slice(0, 8);
      persistFavoriteMetas(next);
      return next;
    });
  };

  const recallFavoriteCube = (fav: FavoriteCubeMeta) => {
    const inSession = sessionBaseLuts[fav.id];
    if (inSession) {
      setCustomBaseEntry(inSession);
      setBaseCubeError('');
      setActionNotice(`已切换至收藏 LUT「${fav.title}」(${fav.size}³)。`);
    } else {
      setBaseCubeError(`「${fav.title}」来自上次会话记录，请重新选择本地 ${fav.fileName} 载入。`);
      baseCubeInputRef.current?.click();
    }
  };

  const removeFavoriteCube = (id: string) => {
    setFavoriteMetas((prev) => {
      const next = prev.filter((f) => f.id !== id);
      persistFavoriteMetas(next);
      return next;
    });
  };

  // Custom Stage 2 Creative .cube import
  const handleCreativeCubeInput = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCreativeCubeError('');
    try {
      const text = await file.text();
      const parsed = parseCubeLut(text, file.name.replace(/\.cube$/i, ''));
      setCreativeCubeLut(parsed);
      setCreativeCubeName(`${parsed.title} (${parsed.size}³)`);
      setCreativeCubeStrength(75);
    } catch (err) {
      setCreativeCubeError(err instanceof Error ? err.message : '解析二级风格 .cube 失败。');
    }
  };

  // Profile selection
  const handleSelectProfile = (profile: LogProfileSpec) => {
    setSelectedProfileId(profile.id);
    setCustomBaseEntry(null);
    setBaseCubeError('');
  };

  const handleResetPreAdjust = () => {
    setPreAdjust({ ...DEFAULT_PRE_ADJUST });
  };

  // Action ②: Full-resolution still frame capture + cross-tool handoffs
  const captureFullResStillBlob = useCallback(async (): Promise<Blob> => {
    const pipeline = pipelineRef.current;
    if (!pipeline) {
      throw new Error('WebGL 渲染引擎未就绪。');
    }

    let sourceCanvas: HTMLCanvasElement;
    if (sourceInfo.mode === 'demo') {
      const c = document.createElement('canvas');
      c.width = DEMO_WIDTH;
      c.height = DEMO_HEIGHT;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('无法创建样片帧画布。');
      drawSyntheticLogFrame(ctx, DEMO_WIDTH, DEMO_HEIGHT, demoTimeRef.current);
      sourceCanvas = c;
    } else {
      const video = videoElRef.current;
      if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        throw new Error('视频画面尚未加载完成，请稍后再试。');
      }
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('无法创建全分辨率截帧画布。');
      ctx.drawImage(video, 0, 0, c.width, c.height);
      sourceCanvas = c;
    }

    return pipeline.renderImageToBlob(sourceCanvas, {
      params: effectiveGradeParams,
      baseLut: activeBaseLut,
      baseLutStrength: baseLutStrength / 100,
      creativeLut: creativeCubeLut,
      creativeLutStrength: creativeCubeLut ? creativeCubeStrength / 100 : 0,
      mime: 'image/png',
    });
  }, [
    sourceInfo.mode,
    effectiveGradeParams,
    activeBaseLut,
    baseLutStrength,
    creativeCubeLut,
    creativeCubeStrength,
  ]);

  const handleSaveFramePng = async () => {
    setIsCapturingFrame(true);
    setActionNotice('');
    setExportError('');
    try {
      const blob = await captureFullResStillBlob();
      const baseSlug = sanitizeFileSlug(sourceInfo.name);
      const tcSlug = formatTimecode(currentTime).replace(':', '-');
      const fileName = `${baseSlug}-rec709-${tcSlug}.png`;
      triggerBlobDownload(blob, fileName);
      setActionNotice(
        `已保存高清静帧 ${fileName}（${sourceInfo.width}×${sourceInfo.height} PNG）。`,
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '截取高清静帧失败。');
    } finally {
      setIsCapturingFrame(false);
    }
  };

  const handleHandoffFrame = async (target: 'grade' | 'image') => {
    setIsCapturingFrame(true);
    setActionNotice('');
    setExportError('');
    try {
      const blob = await captureFullResStillBlob();
      const baseSlug = sanitizeFileSlug(sourceInfo.name);
      const tcSlug = formatTimecode(currentTime).replace(':', '-');
      const lookNote = activeCreativePreset ? ` + ${activeCreativePreset.name}` : '';
      const stageSummary = `${stage1DisplayLabel}${lookNote} · TC ${formatTimecode(currentTime)}`;

      setToolkitHandoff({
        target,
        blob,
        fileName: `${baseSlug}-frame-${tcSlug}.png`,
        sourceLabel: `Log 视频 LUT 还原（${stage1DisplayLabel}）`,
        place: sourceInfo.mode === 'demo' ? 'Log 模拟灰片静帧' : baseSlug.slice(0, 20),
        caption: stageSummary,
        exifSummary: `${sourceInfo.width}×${sourceInfo.height} · ${stage1DisplayLabel}`,
        createdAt: Date.now(),
      });

      navigate(`/toolkit?tool=${target}&handoff=1`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '截帧联动失败，请重试。');
    } finally {
      setIsCapturingFrame(false);
    }
  };

  // Action ③: Export combined 33³ .cube LUT
  const handleExportCombinedCube = () => {
    setExportError('');
    try {
      const profileSlug = customBaseEntry
        ? sanitizeFileSlug(customBaseEntry.title)
        : activeProfile?.id ?? 'log-rec709';
      const lookPart = activeCreativePreset ? `-${sanitizeFileSlug(activeCreativePreset.id)}` : '';
      const title = `${stage1DisplayLabel}${activeCreativePreset ? ` + ${activeCreativePreset.name}` : ''}`;

      const baked = bakeCombinedCubeLut33({
        logProfileId: customBaseEntry ? null : activeProfile?.id ?? null,
        baseLut: customBaseEntry ? customBaseEntry.lut : null,
        baseStrength: baseLutStrength / 100,
        grade: effectiveGradeParams,
        creativeLut: creativeCubeLut,
        creativeStrength: creativeCubeLut ? creativeCubeStrength / 100 : 0,
        title,
      });

      const cubeText = serializeCubeLut(baked, title);
      const blob = new Blob([cubeText], { type: 'text/plain;charset=utf-8' });
      const fileName = `${profileSlug}${lookPart}-33.cube`;
      triggerBlobDownload(blob, fileName);
      setActionNotice(
        `已导出标准 33³ 合并 LUT（${fileName}），可直接拖入剪映 / DaVinci Resolve / Premiere。`,
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '生成合并 .cube 文件失败。');
    }
  };

  // Action ①: Local real-time WebGL video export with audio track
  const handleCancelVideoExport = () => {
    if (exportAbortRef.current) {
      exportAbortRef.current.stop();
    }
  };

  const handleExportVideo = async () => {
    if (isExportingVideo) return;
    setExportError('');
    setActionNotice('');
    setExportedBadge('');

    const mimeChoice = pickBestExportMime();
    if (!mimeChoice || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      setExportError(
        '当前浏览器不支持本地 MediaRecorder 视频封装导出，建议导出下方 33³ .cube 或高清静帧。',
      );
      return;
    }

    const { width: outW, height: outH } = targetExportDims;
    const videoBitsPerSecond = exportBitrate === 'high' ? 16_000_000 : 8_000_000;

    // Pause preview playback while exporting
    if (sourceInfo.mode === 'local' && videoElRef.current && !videoElRef.current.paused) {
      videoElRef.current.pause();
      setIsPlaying(false);
    }

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = outW;
    exportCanvas.height = outH;

    let exportPipeline: WebGLColorPipeline | null = null;
    let exportVideo: HTMLVideoElement | null = null;
    let audioCtx: AudioContext | null = null;
    let recorder: MediaRecorder | null = null;
    let combinedStream: MediaStream | null = null;
    let rafHandle = 0;

    const abortControl = {
      aborted: false,
      stop: () => {
        abortControl.aborted = true;
        if (rafHandle) window.cancelAnimationFrame(rafHandle);
        if (exportVideo) {
          exportVideo.pause();
        }
        if (recorder && recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // Ignore stop race
          }
        }
      },
    };
    exportAbortRef.current = abortControl;

    setIsExportingVideo(true);
    setExportProgress(0);
    setExportStatusNote('正在初始化本地 WebGL 编码管线...');

    try {
      exportPipeline = new WebGLColorPipeline(exportCanvas);
      exportPipeline.setBaseLut(activeBaseLut);
      exportPipeline.setCreativeLut(creativeCubeLut);

      const canvasStream = exportCanvas.captureStream(30);
      const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

      const renderOpts = {
        params: effectiveGradeParams,
        baseLutStrength: baseLutStrength / 100,
        creativeLutStrength: creativeCubeLut ? creativeCubeStrength / 100 : 0,
      };

      if (sourceInfo.mode === 'local' && localVideoUrl) {
        exportVideo = document.createElement('video');
        exportVideo.src = localVideoUrl;
        exportVideo.playsInline = true;
        exportVideo.muted = false;
        exportVideo.volume = 1;
        exportVideo.preload = 'auto';

        await new Promise<void>((resolve, reject) => {
          if (!exportVideo) return reject(new Error('导出视频节点初始化失败。'));
          const onLoaded = () => {
            cleanup();
            resolve();
          };
          const onErr = () => {
            cleanup();
            reject(new Error('无法读取本地视频流用于导出。'));
          };
          const cleanup = () => {
            exportVideo?.removeEventListener('loadeddata', onLoaded);
            exportVideo?.removeEventListener('error', onErr);
          };
          exportVideo.addEventListener('loadeddata', onLoaded);
          exportVideo.addEventListener('error', onErr);
          exportVideo.load();
        });

        if (abortControl.aborted) {
          throw new Error('ABORTED');
        }

        exportVideo.currentTime = 0;
        await new Promise<void>((resolve) => {
          if (!exportVideo) return resolve();
          const onSeeked = () => {
            exportVideo?.removeEventListener('seeked', onSeeked);
            resolve();
          };
          exportVideo.addEventListener('seeked', onSeeked, { once: true });
          window.setTimeout(resolve, 300);
        });

        // Attach audio track safely via AudioContext -> MediaStreamDestination
        const AudioCtxCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtxCtor && sourceInfo.hasAudio) {
          try {
            audioCtx = new AudioCtxCtor();
            if (audioCtx.state === 'suspended') {
              await audioCtx.resume();
            }
            const sourceNode = audioCtx.createMediaElementSource(exportVideo);
            const destNode = audioCtx.createMediaStreamDestination();
            sourceNode.connect(destNode);
            for (const audioTrack of destNode.stream.getAudioTracks()) {
              tracks.push(audioTrack);
            }
          } catch {
            // Proceed video-only if audio graph cannot attach
          }
        }
      }

      combinedStream = new MediaStream(tracks);
      const chunks: BlobPart[] = [];

      recorder = new MediaRecorder(combinedStream, {
        mimeType: mimeChoice.mime,
        videoBitsPerSecond,
      });

      const recordedBlobPromise = new Promise<Blob>((resolve, reject) => {
        if (!recorder) return reject(new Error('编码器不可用。'));
        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) chunks.push(ev.data);
        };
        recorder.onerror = () => reject(new Error('本地视频编码过程发生错误。'));
        recorder.onstop = () => {
          if (abortControl.aborted) {
            reject(new Error('ABORTED'));
            return;
          }
          resolve(new Blob(chunks, { type: mimeChoice.mime }));
        };
      });

      recorder.start(250);

      if (sourceInfo.mode === 'local' && exportVideo) {
        const vid = exportVideo;
        const totalDur = Math.max(0.1, vid.duration || sourceInfo.duration || 1);
        setExportStatusNote(`正在逐帧还原并封装 ${mimeChoice.label}...`);

        const finished = new Promise<void>((resolve, reject) => {
          const onEnded = () => {
            cleanup();
            resolve();
          };
          const onErr = () => {
            cleanup();
            reject(new Error('视频播放解码中断。'));
          };
          const cleanup = () => {
            vid.removeEventListener('ended', onEnded);
            vid.removeEventListener('error', onErr);
          };
          vid.addEventListener('ended', onEnded);
          vid.addEventListener('error', onErr);
        });

        await vid.play();

        const pumpVideoFrame = () => {
          if (abortControl.aborted || vid.ended) return;
          if (exportPipeline && vid.readyState >= 2) {
            exportPipeline.setSource(vid);
            exportPipeline.render(renderOpts);
            const pct = clamp((vid.currentTime / totalDur) * 100, 0, 99);
            setExportProgress(pct);
          }
          rafHandle = window.requestAnimationFrame(pumpVideoFrame);
        };
        rafHandle = window.requestAnimationFrame(pumpVideoFrame);

        await finished;
        if (rafHandle) window.cancelAnimationFrame(rafHandle);

        if (!abortControl.aborted && exportPipeline) {
          exportPipeline.setSource(vid);
          exportPipeline.render(renderOpts);
          setExportProgress(100);
        }
      } else {
        // Synthetic Log Demo real-time export
        const demoSourceCanvas = document.createElement('canvas');
        demoSourceCanvas.width = outW;
        demoSourceCanvas.height = outH;
        const demoCtx = demoSourceCanvas.getContext('2d');
        if (!demoCtx) throw new Error('无法初始化样片导出画布。');

        setExportStatusNote(`正在渲染 ${DEMO_DURATION}s 样片并封装 ${mimeChoice.label}...`);
        const startedAt = performance.now();

        await new Promise<void>((resolve) => {
          const stepExportDemo = (now: number) => {
            if (abortControl.aborted) {
              resolve();
              return;
            }
            const elapsedSec = (now - startedAt) / 1000;
            const clampedTime = Math.min(DEMO_DURATION, elapsedSec);
            drawSyntheticLogFrame(demoCtx, outW, outH, clampedTime);
            if (exportPipeline) {
              exportPipeline.setSource(demoSourceCanvas);
              exportPipeline.render(renderOpts);
            }
            setExportProgress(clamp((clampedTime / DEMO_DURATION) * 100, 0, 100));
            if (elapsedSec >= DEMO_DURATION) {
              resolve();
              return;
            }
            rafHandle = window.requestAnimationFrame(stepExportDemo);
          };
          rafHandle = window.requestAnimationFrame(stepExportDemo);
        });
      }

      if (!abortControl.aborted && recorder.state !== 'inactive') {
        setExportStatusNote('正在完成封装写入...');
        recorder.stop();
      }

      const outputBlob = await recordedBlobPromise;
      const baseSlug = sanitizeFileSlug(sourceInfo.name);
      const profileSlug = customBaseEntry
        ? sanitizeFileSlug(customBaseEntry.title)
        : activeProfile?.id ?? 'rec709';
      const fileName = `${baseSlug}-${profileSlug}.${mimeChoice.ext}`;
      triggerBlobDownload(outputBlob, fileName);
      setExportedBadge(`${mimeChoice.ext.toUpperCase()} · ${outW}×${outH}`);
      setActionNotice(
        `已完成本地还原视频导出：${fileName}（${(outputBlob.size / (1024 * 1024)).toFixed(2)} MB，格式 ${mimeChoice.label}）。`,
      );
    } catch (err) {
      if (err instanceof Error && err.message === 'ABORTED') {
        setActionNotice('已取消本地视频导出。');
      } else {
        setExportError(err instanceof Error ? err.message : '本地视频导出失败，请重试。');
      }
    } finally {
      if (rafHandle) window.cancelAnimationFrame(rafHandle);
      exportAbortRef.current = null;
      if (combinedStream) {
        combinedStream.getTracks().forEach((t) => t.stop());
      }
      if (audioCtx) {
        void audioCtx.close().catch(() => {});
      }
      if (exportVideo) {
        exportVideo.pause();
        exportVideo.removeAttribute('src');
        exportVideo.load();
      }
      exportPipeline?.dispose(true);
      setIsExportingVideo(false);
      setExportStatusNote('');
    }
  };

  // Pre-adjustment slider config
  const preSliders: ReadonlyArray<{
    key: keyof PreAdjustState;
    label: string;
    min: number;
    max: number;
    step: number;
    leftHint: string;
    rightHint: string;
    format: (v: number) => string;
  }> = useMemo(
    () => [
      {
        key: 'exposure',
        label: '曝光 EV',
        min: -2,
        max: 2,
        step: 0.05,
        leftHint: '压暗',
        rightHint: '提亮',
        format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`,
      },
      {
        key: 'temperature',
        label: '色温',
        min: -100,
        max: 100,
        step: 1,
        leftHint: '偏冷蓝',
        rightHint: '偏暖黄',
        format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
      },
      {
        key: 'tint',
        label: '色调',
        min: -100,
        max: 100,
        step: 1,
        leftHint: '偏绿',
        rightHint: '偏洋红',
        format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
      },
      {
        key: 'contrast',
        label: '对比度',
        min: -100,
        max: 100,
        step: 1,
        leftHint: '柔和',
        rightHint: '硬朗',
        format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
      },
      {
        key: 'highlights',
        label: '高光',
        min: -100,
        max: 100,
        step: 1,
        leftHint: '拉回过曝',
        rightHint: '通透提亮',
        format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
      },
      {
        key: 'shadows',
        label: '阴影',
        min: -100,
        max: 100,
        step: 1,
        leftHint: '压实黑位',
        rightHint: '提亮暗部',
        format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
      },
      {
        key: 'saturation',
        label: '饱和度',
        min: -100,
        max: 100,
        step: 1,
        leftHint: '克制褪色',
        rightHint: '浓郁鲜活',
        format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
      },
    ],
    [],
  );

  // Waveform exposure diagnostic text
  const scopeStatus = useMemo(() => {
    if (!histogram) return { tone: 'neutral' as const, label: '示波采样就绪' };
    if (histogram.whiteClipPct > 5.5) {
      return { tone: 'warn' as const, label: '高光接近裁切 · 可拉回高光或降 EV' };
    }
    if (histogram.blackClipPct > 8.5) {
      return { tone: 'warn' as const, label: '暗部偏沉 · 可适度提亮阴影' };
    }
    return { tone: 'ok' as const, label: '高光与黑位分布均衡' };
  }, [histogram]);

  const aspectRatioCss = useMemo(() => {
    const ratio = sourceInfo.width > 0 && sourceInfo.height > 0 ? sourceInfo.width / sourceInfo.height : 16 / 9;
    return clamp(ratio, 0.75, 2.4);
  }, [sourceInfo.width, sourceInfo.height]);

  return (
    <div className="min-w-0 space-y-5">
      {/* Hidden local file inputs & offscreen decoded video element */}
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/*,.mp4,.mov,.webm,.m4v"
        onChange={handleVideoInputChange}
        className="sr-only"
      />
      <input
        ref={baseCubeInputRef}
        type="file"
        accept=".cube,text/plain"
        onChange={handleBaseCubeInput}
        className="sr-only"
      />
      <input
        ref={creativeCubeInputRef}
        type="file"
        accept=".cube,text/plain"
        onChange={(e) => void handleCreativeCubeInput(e)}
        className="sr-only"
      />
      <video
        ref={videoElRef}
        src={localVideoUrl ?? undefined}
        playsInline
        preload="auto"
        onLoadedMetadata={handleLocalVideoLoadedMetadata}
        onLoadedData={() => renderMonitorFrame(true)}
        onSeeked={() => renderMonitorFrame(true)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          if (!isLooping) setIsPlaying(false);
        }}
        onError={handleLocalVideoError}
        className="pointer-events-none fixed -left-[9999px] top-0 h-px w-px opacity-0"
      />

      {/* Top Video Source Loader Bar */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingVideo(true);
        }}
        onDragLeave={() => setIsDraggingVideo(false)}
        onDrop={handleVideoDrop}
        className={[
          'flex flex-col gap-3 rounded-[22px] border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between sm:px-5',
          isDraggingVideo
            ? 'border-dashed border-accent bg-surface-hover'
            : 'border-hairline bg-paper',
        ].join(' ')}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-ink">
              <Film className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              <span className="truncate">{sourceInfo.name}</span>
            </span>
            <span className="rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11px] text-ink-muted whitespace-nowrap shrink-0">
              {sourceInfo.mode === 'demo' ? '实时合成灰片' : '本地文件直读'}
            </span>
          </div>
          <div className="tabular-nums-mono flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
            <span>
              {sourceInfo.width} × {sourceInfo.height}
            </span>
            <span>时长 {formatTimecode(sourceInfo.duration)}</span>
            <span>{sourceInfo.mode === 'demo' ? 'S-Log3 基准曲线' : sourceInfo.hasAudio ? '含原音轨' : '无音轨'}</span>
            <span className="text-postmark">拖入 MP4 / MOV / WebM 或 .cube 文件即可本地载入</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => videoInputRef.current?.click()}
            className="pill-cta-primary min-h-[38px] shrink-0 whitespace-nowrap px-4 text-[13px]"
          >
            <Upload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>选择本地 Log 视频</span>
          </button>
          <button
            type="button"
            onClick={loadDemoClip}
            aria-pressed={sourceInfo.mode === 'demo'}
            className={[
              'inline-flex min-h-[38px] shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[12.5px] transition-colors',
              sourceInfo.mode === 'demo'
                ? 'border-accent/40 bg-surface font-medium text-accent'
                : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
            ].join(' ')}
          >
            <Clapperboard className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>载入内置 Log 模拟灰片样片</span>
          </button>
        </div>
      </div>

      {sourceError && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[16px] border border-hairline bg-paper px-4 py-3 text-[13px] text-postmark"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{sourceError}</span>
        </div>
      )}

      {/* Main Responsive Workbench: Left Monitor + Exports | Right Profile & 2-Stage Grading */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start">
        {/* ================= LEFT COLUMN: 60fps WebGL Monitor + Local Export ================= */}
        <div className="min-w-0 space-y-4 lg:col-span-7 lg:sticky lg:top-[76px] lg:max-h-[calc(100dvh-96px)] lg:overflow-y-auto lg:pr-1">
          {/* 60fps WebGL Video Monitor (Constant Deep-Space Darkroom Stage) */}
          <div
            data-only-dark="true"
            className="deep-space min-w-0 rounded-[24px] border border-hairline p-3.5 sm:p-4"
          >
            {/* Monitor Status Header */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11.5px] font-medium text-ink">
                  {stage1DisplayLabel}
                </span>
                {activeCreativePreset && (
                  <span className="truncate rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11.5px] text-accent">
                    + {activeCreativePreset.name}
                  </span>
                )}
                {creativeCubeLut && (
                  <span className="truncate rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11.5px] text-postmark">
                    + {creativeCubeLut.title}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={splitEnabled}
                  onClick={() => setSplitEnabled((v) => !v)}
                  className={[
                    'inline-flex min-h-[30px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[11.5px] transition-colors',
                    splitEnabled
                      ? 'border-accent/50 bg-surface-hover font-medium text-accent'
                      : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  <SplitSquareHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>分屏对比</span>
                </button>
                <button
                  type="button"
                  onPointerDown={() => setShowOriginal(true)}
                  onPointerUp={() => setShowOriginal(false)}
                  onPointerLeave={() => setShowOriginal(false)}
                  onPointerCancel={() => setShowOriginal(false)}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') setShowOriginal(true);
                  }}
                  onKeyUp={() => setShowOriginal(false)}
                  className={[
                    'inline-flex min-h-[30px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[11.5px] transition-colors select-none',
                    showOriginal
                      ? 'border-postmark/60 bg-surface-hover font-medium text-postmark'
                      : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>按住看原片</span>
                </button>
              </div>
            </div>

            {/* Interactive WebGL Viewport */}
            <div
              ref={stageBoxRef}
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerUp}
              onPointerCancel={handleStagePointerUp}
              style={{ aspectRatio: String(aspectRatioCss) }}
              className={[
                'relative mx-auto flex max-h-[54vh] w-full items-center justify-center overflow-hidden rounded-[16px] border border-hairline bg-[#07080a] select-none',
                splitEnabled && !showOriginal ? 'cursor-ew-resize touch-none' : '',
              ].join(' ')}
            >
              {webglError ? (
                <div className="px-6 py-10 text-center text-[13px] text-postmark">{webglError}</div>
              ) : (
                <canvas
                  ref={glCanvasRef}
                  aria-label="Log 视频 LUT 实时监看画布"
                  className="block h-full w-full object-contain"
                />
              )}

              {/* Before / After Corner Labels & Draggable Hairline */}
              {!webglError && splitEnabled && !showOriginal && (
                <>
                  <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-0.5 text-[11px] text-[#e3e3e3]">
                    Log 灰片
                  </span>
                  <span className="pointer-events-none absolute right-2.5 top-2.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-0.5 text-[11px] text-[#8ab4f8]">
                    Rec.709 还原
                  </span>
                  <div
                    aria-hidden="true"
                    style={{ left: `${splitPosition * 100}%` }}
                    className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-white/85 shadow-[0_0_8px_rgba(0,0,0,0.85)]"
                  >
                    <div className="absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-[#14161a]/90 text-[#e3e3e3]">
                      <SplitSquareHorizontal className="h-3.5 w-3.5" />
                    </div>
                  </div>
                </>
              )}

              {!webglError && showOriginal && (
                <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-full border border-white/20 bg-black/70 px-2.5 py-0.5 text-[11px] text-[#d69f87]">
                  原片预览 · Log 灰片
                </span>
              )}
            </div>

            {/* Transport Controls */}
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                aria-label={isPlaying ? '暂停播放' : '开始播放'}
                disabled={isExportingVideo}
                onClick={handleTogglePlay}
                className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover disabled:opacity-40"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Play className="h-4 w-4 translate-x-[1px]" aria-hidden="true" />
                )}
              </button>

              <div className="flex min-w-[140px] flex-1 items-center gap-2.5">
                <input
                  type="range"
                  aria-label="时间轴进度"
                  min={0}
                  max={Math.max(0.1, sourceInfo.duration || DEMO_DURATION)}
                  step={0.02}
                  value={Math.min(currentTime, sourceInfo.duration || DEMO_DURATION)}
                  disabled={isExportingVideo}
                  onChange={handleSeek}
                  className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent"
                />
                <span className="tabular-nums-mono shrink-0 text-[12px] text-ink-muted">
                  {formatTimecode(currentTime)} / {formatTimecode(sourceInfo.duration || DEMO_DURATION)}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={isLooping}
                  onClick={() => setIsLooping((v) => !v)}
                  title="循环播放"
                  className={[
                    'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[11.5px] transition-colors',
                    isLooping
                      ? 'border-accent/45 bg-surface-hover text-accent'
                      : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  <Repeat className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>循环</span>
                </button>

                <button
                  type="button"
                  aria-pressed={isMuted}
                  disabled={sourceInfo.mode === 'demo'}
                  onClick={() => setIsMuted((v) => !v)}
                  title={sourceInfo.mode === 'demo' ? '内置样片无音轨' : isMuted ? '取消静音' : '静音'}
                  className={[
                    'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors disabled:opacity-35',
                    isMuted
                      ? 'border-postmark/45 bg-surface-hover text-postmark'
                      : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  {isMuted ? (
                    <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setPlaybackRate((r) => (r === 1 ? 0.5 : 1))}
                  className="tabular-nums-mono inline-flex h-8 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-full border border-hairline bg-surface px-2.5 text-[11.5px] text-ink transition-colors hover:bg-surface-hover"
                >
                  {playbackRate === 1 ? '1x' : '0.5x'}
                </button>
              </div>
            </div>

            {/* Live Compact RGB + Luma Waveform / Histogram Scope */}
            <div className="mt-3 rounded-[14px] border border-hairline bg-[#0f1115] px-3 py-2.5">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-2 text-ink-muted">
                  <span className="font-medium text-ink">RGB + 亮度示波</span>
                  <span className="tabular-nums-mono text-[10.5px] opacity-80">
                    0% · 50% · 100% IRE
                  </span>
                </div>
                <span
                  className={[
                    'tabular-nums-mono text-[11px]',
                    scopeStatus.tone === 'warn'
                      ? 'text-postmark'
                      : scopeStatus.tone === 'ok'
                        ? 'text-accent'
                        : 'text-ink-muted',
                  ].join(' ')}
                >
                  {scopeStatus.label}
                </span>
              </div>

              <div className="relative h-[54px] w-full overflow-hidden rounded-[8px] bg-[#090a0d]">
                <svg
                  viewBox="0 0 256 54"
                  preserveAspectRatio="none"
                  aria-label="RGB 与亮度实时直方图示波"
                  className="block h-full w-full"
                >
                  {/* IRE guide lines */}
                  <line x1="64" y1="0" x2="64" y2="54" stroke="rgba(227,227,227,0.08)" strokeWidth="1" />
                  <line x1="128" y1="0" x2="128" y2="54" stroke="rgba(227,227,227,0.12)" strokeWidth="1" />
                  <line x1="192" y1="0" x2="192" y2="54" stroke="rgba(227,227,227,0.08)" strokeWidth="1" />

                  {histogram && histogram.max > 0 && (
                    <>
                      <path
                        d={buildHistogramPath(histogram.luma, histogram.max, 256, 54)}
                        fill="rgba(227, 227, 227, 0.16)"
                      />
                      <path
                        d={buildHistogramStroke(histogram.r, histogram.max, 256, 54)}
                        fill="none"
                        stroke="rgba(232, 108, 108, 0.85)"
                        strokeWidth="1.2"
                      />
                      <path
                        d={buildHistogramStroke(histogram.g, histogram.max, 256, 54)}
                        fill="none"
                        stroke="rgba(104, 198, 134, 0.85)"
                        strokeWidth="1.2"
                      />
                      <path
                        d={buildHistogramStroke(histogram.b, histogram.max, 256, 54)}
                        fill="none"
                        stroke="rgba(122, 174, 245, 0.88)"
                        strokeWidth="1.2"
                      />
                    </>
                  )}
                </svg>
              </div>
            </div>
          </div>

          {/* Three Practical Local Export Actions Card */}
          <div className="min-w-0 space-y-4 rounded-[22px] border border-hairline bg-paper p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                <Download className="h-4 w-4 text-accent" aria-hidden="true" />
                <span>本地导出与跨工具联动</span>
              </div>
              <span className="tabular-nums-mono text-[11.5px] text-postmark">
                100% 本地完成 · 零服务器上传
              </span>
            </div>

            {actionNotice && (
              <div className="flex items-start gap-2 rounded-[14px] border border-accent/30 bg-surface px-3.5 py-2.5 text-[12.5px] text-ink">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="min-w-0 flex-1">{actionNotice}</span>
                <button
                  type="button"
                  aria-label="关闭提示"
                  onClick={() => setActionNotice('')}
                  className="shrink-0 text-ink-muted hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {exportError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-[14px] border border-postmark/35 bg-surface px-3.5 py-2.5 text-[12.5px] text-postmark"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{exportError}</span>
              </div>
            )}

            {/* Action ①: Local Video Export with Audio */}
            <div className="space-y-3 rounded-[16px] border border-hairline bg-surface/65 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                  <Video className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>本地导出还原视频（含音轨）</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="tabular-nums-mono rounded-full border border-hairline bg-paper px-2.5 py-0.5 text-[11px] text-ink-muted">
                    {bestExportMime ? bestExportMime.label : '浏览器不支持封装'}
                  </span>
                  {exportedBadge && (
                    <span className="tabular-nums-mono rounded-full border border-accent/40 bg-paper px-2.5 py-0.5 text-[11px] text-accent">
                      已导出 {exportedBadge}
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div className="min-w-0">
                  <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-ink-muted">
                    <span>导出分辨率</span>
                    <span className="tabular-nums-mono">
                      {targetExportDims.width}×{targetExportDims.height}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { id: 'source', label: '原视频分辨率' },
                        { id: '1080p', label: '1080p' },
                        { id: '720p', label: '720p' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={isExportingVideo}
                        aria-pressed={exportResolution === opt.id}
                        onClick={() => setExportResolution(opt.id)}
                        className={[
                          'shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-45',
                          exportResolution === opt.id
                            ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                            : 'border-hairline bg-paper text-ink-muted hover:text-ink',
                        ].join(' ')}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="mb-1.5 text-[11.5px] text-ink-muted">编码码率</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        { id: 'high', label: '高画质 16 Mbps' },
                        { id: 'standard', label: '标准 8 Mbps' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={isExportingVideo}
                        aria-pressed={exportBitrate === opt.id}
                        onClick={() => setExportBitrate(opt.id)}
                        className={[
                          'tabular-nums-mono shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-45',
                          exportBitrate === opt.id
                            ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                            : 'border-hairline bg-paper text-ink-muted hover:text-ink',
                        ].join(' ')}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {isExportingVideo ? (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-ink">{exportStatusNote || '正在渲染导出...'}</span>
                    <span className="tabular-nums-mono font-medium text-accent">
                      {Math.round(exportProgress)}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-paper">
                    <div
                      style={{ width: `${Math.max(2, exportProgress)}%` }}
                      className="h-full rounded-full bg-accent transition-[width] duration-150"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleCancelVideoExport}
                      className="pill-cta-secondary min-h-[34px] shrink-0 whitespace-nowrap px-3.5 text-[12px]"
                    >
                      <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>取消导出</span>
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={Boolean(webglError) || !bestExportMime}
                  onClick={() => void handleExportVideo()}
                  className="pill-cta-primary min-h-[40px] w-full text-[13.5px] disabled:opacity-40"
                >
                  <Video className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    本地导出还原视频（{bestExportMime ? bestExportMime.ext.toUpperCase() : '暂不支持'}）
                  </span>
                </button>
              )}
            </div>

            {/* Action ②: Still Frame PNG & Cross-Tool Handoff */}
            <div className="space-y-2.5 rounded-[16px] border border-hairline bg-surface/65 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                  <Camera className="h-3.5 w-3.5 text-postmark" aria-hidden="true" />
                  <span>截取当前还原高清静帧与跨工具联动</span>
                </div>
                <span className="tabular-nums-mono text-[11px] text-ink-muted">
                  全分辨率 {sourceInfo.width}×{sourceInfo.height} PNG
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isCapturingFrame || Boolean(webglError)}
                  onClick={() => void handleSaveFramePng()}
                  className="pill-cta-secondary min-h-[36px] flex-1 shrink-0 whitespace-nowrap px-3.5 text-[12.5px] disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>保存当前帧 PNG</span>
                </button>
                <button
                  type="button"
                  disabled={isCapturingFrame || Boolean(webglError)}
                  onClick={() => void handleHandoffFrame('grade')}
                  className="pill-cta-secondary min-h-[36px] flex-1 shrink-0 whitespace-nowrap px-3.5 text-[12.5px] disabled:opacity-40"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                  <span>截帧送去精调</span>
                </button>
                <button
                  type="button"
                  disabled={isCapturingFrame || Boolean(webglError)}
                  onClick={() => void handleHandoffFrame('image')}
                  className="pill-cta-secondary min-h-[36px] flex-1 shrink-0 whitespace-nowrap px-3.5 text-[12.5px] disabled:opacity-40"
                >
                  <Stamp className="h-3.5 w-3.5 shrink-0 text-postmark" aria-hidden="true" />
                  <span>截帧送去邮戳装裱</span>
                </button>
              </div>
            </div>

            {/* Action ③: Combined 33³ .cube Export */}
            <div className="flex flex-col gap-3 rounded-[16px] border border-hairline bg-surface/65 p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                  <FileCode2 className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>导出合并 33³ .cube 文件</span>
                </div>
                <p className="mt-1 mb-0 text-[12px] leading-relaxed text-ink-muted">
                  将一级还原、前置校正与二级风格烘焙为标准 33³ 立方表，供剪映 / DaVinci Resolve / Premiere 10-bit 批处理。
                </p>
              </div>
              <button
                type="button"
                onClick={handleExportCombinedCube}
                className="pill-cta-secondary min-h-[38px] shrink-0 whitespace-nowrap px-4 text-[12.5px]"
              >
                <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>导出合并 33³ .cube</span>
              </button>
            </div>
          </div>
        </div>

        {/* ================= RIGHT COLUMN: Stage 1 Log Profiles + Stage 2 Grading ================= */}
        <div className="min-w-0 space-y-5 lg:col-span-5">
          {/* Card 1: Official Log Profile Selector + Custom Base .cube */}
          <div className="min-w-0 space-y-3.5 rounded-[22px] border border-hairline bg-paper p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                <Layers className="h-4 w-4 text-accent" aria-hidden="true" />
                <span>按设备与品牌选官方 Log 模板</span>
              </div>
              <span className="rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11px] text-ink-muted whitespace-nowrap shrink-0">
                {customBaseEntry ? '自定义 .cube 还原' : '公开白皮书曲线'}
              </span>
            </div>

            {/* Brand Filter Pills */}
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="按相机品牌筛选 Log 曲线">
              {BRAND_FILTERS.map((brand) => {
                const active = brandFilter === brand.id;
                return (
                  <button
                    key={brand.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setBrandFilter(brand.id)}
                    className={[
                      'shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-3 py-1 text-[12px] transition-colors',
                      active
                        ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                        : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                    ].join(' ')}
                  >
                    {brand.label}
                  </button>
                );
              })}
            </div>

            {/* Profile Cards */}
            <div className="max-h-[308px] space-y-2 overflow-y-auto pr-1">
              {filteredProfiles.map((profile) => {
                const selected = !customBaseEntry && activeProfile?.id === profile.id;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => handleSelectProfile(profile)}
                    className={[
                      'block w-full cursor-pointer rounded-[16px] border p-3 text-left transition-colors',
                      selected
                        ? 'border-accent bg-surface shadow-2xs'
                        : 'border-hairline bg-surface/55 hover:border-hairline-strong hover:bg-surface',
                    ].join(' ')}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="text-[13.5px] font-medium text-ink">{profile.name}</span>
                      <span className="tabular-nums-mono rounded-full border border-hairline bg-paper px-2 py-0.5 text-[10.5px] text-ink-muted">
                        {profile.gamut}
                      </span>
                    </div>
                    <div className="tabular-nums-mono mt-1 text-[11.5px] text-accent">
                      适用机型：{profile.cameras}
                    </div>
                    <p className="mt-1 mb-0 text-[11.5px] leading-relaxed text-ink-muted">
                      {profile.description}
                    </p>
                    <div className="mt-1 text-[10.5px] text-ink-muted/80">
                      依据：{profile.reference}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Import Custom Base .cube Dropzone & Favorites */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingBaseCube(true);
              }}
              onDragLeave={() => setIsDraggingBaseCube(false)}
              onDrop={handleBaseCubeDrop}
              className={[
                'space-y-2.5 rounded-[16px] border p-3 transition-colors',
                isDraggingBaseCube
                  ? 'border-dashed border-accent bg-surface-hover'
                  : 'border-hairline bg-surface/55',
              ].join(' ')}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-ink">导入自定义还原 .cube</div>
                  <div className="text-[11px] text-ink-muted">
                    支持官方或第三方 17³ / 33³ / 65³ 3D LUT 替代一级还原
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => baseCubeInputRef.current?.click()}
                  className="pill-cta-secondary min-h-[32px] shrink-0 whitespace-nowrap px-3 text-[12px]"
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>导入 .cube</span>
                </button>
              </div>

              {customBaseEntry && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-accent/35 bg-paper px-3 py-2 text-[12px]">
                  <div className="min-w-0">
                    <span className="font-medium text-ink">{customBaseEntry.title}</span>
                    <span className="tabular-nums-mono ml-2 text-[11px] text-ink-muted">
                      {customBaseEntry.size}³
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={toggleFavoriteCurrentBase}
                      aria-pressed={isCurrentBaseFavorited}
                      className={[
                        'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[11px] transition-colors',
                        isCurrentBaseFavorited
                          ? 'border-postmark/45 bg-surface text-postmark'
                          : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                      ].join(' ')}
                    >
                      <Star className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>{isCurrentBaseFavorited ? '已收藏' : '收藏'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCustomBaseEntry(null)}
                      className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-hairline bg-surface px-2.5 text-[11px] text-ink-muted hover:text-ink"
                    >
                      <X className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>恢复内置</span>
                    </button>
                  </div>
                </div>
              )}

              {favoriteMetas.length > 0 && (
                <div className="space-y-1.5 pt-0.5">
                  <div className="text-[11px] text-ink-muted">已收藏的自定义 .cube</div>
                  <div className="flex flex-wrap gap-1.5">
                    {favoriteMetas.map((fav) => {
                      const cached = Boolean(sessionBaseLuts[fav.id]);
                      const isActive = customBaseEntry?.id === fav.id;
                      return (
                        <div
                          key={fav.id}
                          className={[
                            'inline-flex items-center overflow-hidden rounded-full border text-[11px]',
                            isActive
                              ? 'border-accent bg-paper text-accent'
                              : 'border-hairline bg-paper text-ink-muted',
                          ].join(' ')}
                        >
                          <button
                            type="button"
                            onClick={() => recallFavoriteCube(fav)}
                            title={cached ? '点击立即切换' : '点击重新选取本地文件载入'}
                            className="cursor-pointer px-2.5 py-1 hover:text-ink"
                          >
                            {fav.title} ({fav.size}³)
                          </button>
                          <button
                            type="button"
                            aria-label={`删除收藏 ${fav.title}`}
                            onClick={() => removeFavoriteCube(fav.id)}
                            className="cursor-pointer border-l border-hairline px-1.5 py-1 text-ink-muted hover:text-postmark"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {baseCubeError && (
                <div role="alert" className="text-[12px] text-postmark">
                  {baseCubeError}
                </div>
              )}
            </div>

            {/* Stage 1 Restoration Strength Slider */}
            <div className="border-t border-hairline pt-3">
              <div className="flex items-center justify-between text-[12.5px]">
                <label htmlFor="lut-base-strength" className="font-medium text-ink">
                  一级技术还原强度
                </label>
                <button
                  type="button"
                  onDoubleClick={() => setBaseLutStrength(100)}
                  title="双击恢复 100%"
                  className="tabular-nums-mono cursor-pointer text-[12px] text-accent"
                >
                  {baseLutStrength}%
                </button>
              </div>
              <input
                id="lut-base-strength"
                type="range"
                min={0}
                max={100}
                step={1}
                value={baseLutStrength}
                onChange={(e) => setBaseLutStrength(Number(e.target.value))}
                className="mt-1.5 h-1.5 w-full cursor-pointer accent-accent"
              />
            </div>
          </div>

          {/* Card 2: Pre-Adjustments + Stage 2 Creative Look Overlay */}
          <div className="min-w-0 space-y-4 rounded-[22px] border border-hairline bg-paper p-4 sm:p-5">
            {/* Pre-exposure & WB correction */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                  <SlidersHorizontal className="h-4 w-4 text-postmark" aria-hidden="true" />
                  <span>前置曝光与白平衡矫正</span>
                </div>
                <button
                  type="button"
                  onClick={handleResetPreAdjust}
                  className="inline-flex min-h-[28px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-hairline bg-surface px-2.5 text-[11.5px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                >
                  <RotateCcw className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>一键归零</span>
                </button>
              </div>

              <div className="space-y-2.5">
                {preSliders.map((slider) => {
                  const val = preAdjust[slider.key];
                  return (
                    <div key={slider.key} className="space-y-1">
                      <div className="flex items-center justify-between text-[12px]">
                        <label htmlFor={`lut-pre-${slider.key}`} className="text-ink">
                          {slider.label}
                        </label>
                        <button
                          type="button"
                          onDoubleClick={() =>
                            setPreAdjust((prev) => ({ ...prev, [slider.key]: 0 }))
                          }
                          title="双击归零"
                          className="tabular-nums-mono cursor-pointer text-[11.5px] text-ink-muted hover:text-accent"
                        >
                          {slider.format(val)}
                        </button>
                      </div>
                      <input
                        id={`lut-pre-${slider.key}`}
                        type="range"
                        min={slider.min}
                        max={slider.max}
                        step={slider.step}
                        value={val}
                        onChange={(e) =>
                          setPreAdjust((prev) => ({
                            ...prev,
                            [slider.key]: Number(e.target.value),
                          }))
                        }
                        className="h-1.5 w-full cursor-pointer accent-accent"
                      />
                      <div className="flex justify-between text-[10.5px] text-ink-muted/75">
                        <span>{slider.leftHint}</span>
                        <span>{slider.rightHint}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Stage 2: Optional Creative Look Overlay */}
            <div className="space-y-3 border-t border-hairline pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[14px] font-medium text-ink">二级电影风格叠加（可选）</div>
                <span className="text-[11px] text-ink-muted">在 Rec.709 还原之上叠加</span>
              </div>

              {/* Quick Creative Chips */}
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  aria-pressed={creativePresetId === ''}
                  onClick={() => setCreativePresetId('')}
                  className={[
                    'shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                    creativePresetId === ''
                      ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                      : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  无叠加（纯标准 Rec.709）
                </button>
                {featuredCreativePresets.map(({ preset, label }) => {
                  const active = creativePresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setCreativePresetId(preset.id)}
                      className={[
                        'shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                        active
                          ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                          : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                      ].join(' ')}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {/* Full Preset Dropdown */}
              <label className="block min-w-0">
                <span className="text-[11.5px] text-ink-muted">全部 20 套胶片与电影风格</span>
                <select
                  value={creativePresetId}
                  onChange={(e) => setCreativePresetId(e.target.value)}
                  className="mt-1 w-full rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[12.5px] text-ink"
                >
                  <option value="">无叠加（纯标准 Rec.709）</option>
                  {GRADE_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name} · {preset.subtitle}
                    </option>
                  ))}
                </select>
              </label>

              {activeCreativePreset && (
                <div className="space-y-2 rounded-[14px] border border-hairline bg-surface/65 p-3">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="font-medium text-ink">
                      风格强度 · {activeCreativePreset.name}
                    </span>
                    <span className="tabular-nums-mono text-accent">{creativePresetStrength}%</span>
                  </div>
                  <input
                    type="range"
                    aria-label="二级电影风格预设强度"
                    min={0}
                    max={100}
                    step={1}
                    value={creativePresetStrength}
                    onChange={(e) => setCreativePresetStrength(Number(e.target.value))}
                    className="h-1.5 w-full cursor-pointer accent-accent"
                  />
                  <p className="mb-0 text-[11.5px] leading-relaxed text-ink-muted">
                    {activeCreativePreset.summary}
                  </p>
                </div>
              )}

              {/* Optional 2nd Creative .cube LUT */}
              <div className="space-y-2 rounded-[14px] border border-hairline bg-surface/55 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12px] font-medium text-ink">
                    叠加二级风格 .cube（可选）
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => creativeCubeInputRef.current?.click()}
                      className="pill-cta-secondary min-h-[30px] shrink-0 whitespace-nowrap px-3 text-[11.5px]"
                    >
                      <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{creativeCubeLut ? '更换风格 .cube' : '导入风格 .cube'}</span>
                    </button>
                    {creativeCubeLut && (
                      <button
                        type="button"
                        aria-label="移除二级风格 .cube"
                        onClick={() => {
                          setCreativeCubeLut(null);
                          setCreativeCubeName('');
                        }}
                        className="inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-full border border-hairline bg-paper text-ink-muted hover:text-postmark"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {creativeCubeLut && (
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between text-[11.5px]">
                      <span className="truncate text-ink">{creativeCubeName}</span>
                      <span className="tabular-nums-mono shrink-0 text-accent">
                        {creativeCubeStrength}%
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="二级风格 .cube 强度"
                      min={0}
                      max={100}
                      step={1}
                      value={creativeCubeStrength}
                      onChange={(e) => setCreativeCubeStrength(Number(e.target.value))}
                      className="h-1.5 w-full cursor-pointer accent-accent"
                    />
                  </div>
                )}

                {creativeCubeError && (
                  <div role="alert" className="text-[12px] text-postmark">
                    {creativeCubeError}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
