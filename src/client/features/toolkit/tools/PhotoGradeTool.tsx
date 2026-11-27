import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeftRight,
  BookmarkPlus,
  Check,
  Compass,
  Download,
  Eye,
  FileDown,
  FileUp,
  Frame,
  Image as ImageIcon,
  Layers,
  Palette,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { exifTakenAt } from '../../../../shared/dates';
import { useRouter } from '../../../lib/router';
import { parseCubeLut, serializeCubeLut } from '../color/cube-lut';
import { BEGINNER_GUIDES, GRADE_PRESETS } from '../color/grade-presets';
import {
  DEFAULT_GRADE_PARAMS,
  HSL_BAND_IDS,
  HSL_BAND_META,
  blendGradeParams,
  cloneGradeParams,
  resolveGradeParams,
  type GradeParams,
  type GradeParamsPatch,
  type GradePreset,
  type GradePresetCategory,
  type HslAdjustment,
  type HslBandId,
  type Lut3D,
} from '../color/grade-types';
import { bakeCombinedCubeLut33 } from '../color/log-profiles';
import {
  consumeToolkitHandoff,
  setToolkitHandoff,
  type ToolkitMediaHandoff,
} from '../color/media-handoff';
import { WebGLColorPipeline, type HistogramData } from '../color/webgl-color-pipeline';

type PresetFilterTab = 'all' | GradePresetCategory | 'custom';
type StudioTab = 'light' | 'color' | 'hsl' | 'finish';
type ExportMime = 'image/jpeg' | 'image/png' | 'image/webp';

interface SamplePhotoDef {
  id: string;
  label: string;
  url: string;
  fileName: string;
  place: string;
  caption: string;
  exifSummary: string;
  takenAt: string;
}

interface LoadedPhoto {
  name: string;
  url: string;
  isOwnedUrl: boolean;
  sampleId?: string;
  img: HTMLImageElement;
  width: number;
  height: number;
  place?: string;
  caption?: string;
  exifSummary?: string;
  takenAt?: string | null;
}

interface CustomGradePreset {
  id: string;
  name: string;
  note: string;
  createdAt: number;
  params: GradeParams;
}

const CUSTOM_PRESETS_STORAGE_KEY = 'lvtushouji:grade-presets:v1';

const SAMPLE_PHOTOS: readonly SamplePhotoDef[] = [
  {
    id: 'mountain',
    label: '雪山',
    url: '/demo/mountain.jpg',
    fileName: 'mountain.jpg',
    place: '川西 · 折多山垭口',
    caption: '云影沿雪线缓慢退去，晨光落在冷峻的山脊与静止的空气里。',
    exifSummary: 'FUJIFILM X-T5 · XF 35mm f/1.4 · 35mm · f/4.0 · 1/640s · ISO 160',
    takenAt: '2026-10-18T07:40:00+08:00',
  },
  {
    id: 'lake',
    label: '高原湖',
    url: '/demo/lake.jpg',
    fileName: 'lake.jpg',
    place: '新疆 · 赛里木湖畔',
    caption: '风停之前的十分钟，湖面把一整片低垂的云色完整收进水底。',
    exifSummary: 'SONY ILCE-7M4 · FE 24-70mm GM II · 50mm · f/5.6 · 1/500s · ISO 100',
    takenAt: '2026-09-06T17:15:00+08:00',
  },
  {
    id: 'road',
    label: '荒原公路',
    url: '/demo/road.jpg',
    fileName: 'road.jpg',
    place: '青海 · 荒原公路',
    caption: '午后笔直的柏油路切开戈壁与远山，风把光影拉得很长。',
    exifSummary: 'RICOH GR IIIx · 26.1mm f/2.8 · 40mm · f/5.6 · 1/1000s · ISO 100',
    takenAt: '2026-08-12T15:30:00+08:00',
  },
  {
    id: 'forest',
    label: '松林',
    url: '/demo/forest.jpg',
    fileName: 'forest.jpg',
    place: '川西 · 云杉松林',
    caption: '潮湿空气渗进针叶间隙，林间光斑在湿润的苔藓上缓慢移动。',
    exifSummary: 'LEICA Q3 · Summilux 28mm f/1.7 · 28mm · f/2.8 · 1/320s · ISO 200',
    takenAt: '2026-11-02T09:20:00+08:00',
  },
];

const EXPORT_FORMAT_OPTIONS: ReadonlyArray<{
  mime: ExportMime;
  label: string;
  ext: string;
  quality?: number;
}> = [
  { mime: 'image/jpeg', label: 'JPEG 94%', ext: 'jpg', quality: 0.94 },
  { mime: 'image/png', label: 'PNG 无损', ext: 'png' },
  { mime: 'image/webp', label: 'WebP 92%', ext: 'webp', quality: 0.92 },
];

const CATEGORY_LABELS: Record<GradePresetCategory, string> = {
  film: '经典胶片',
  cinema: '电影纪实',
  practical: '实用场景',
};

const STUDIO_TABS: ReadonlyArray<{
  id: StudioTab;
  label: string;
  icon: typeof Sun;
}> = [
  { id: 'light', label: '基础光影', icon: Sun },
  { id: 'color', label: '色彩平衡', icon: Palette },
  { id: 'hsl', label: 'HSL 八色', icon: Layers },
  { id: 'finish', label: '质感与分离', icon: SlidersHorizontal },
];

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sanitizeBaseName(filename: string): string {
  const stripped = filename.replace(/\.[^.]+$/, '').trim();
  return stripped.replace(/[\\/:*?"<>|]+/g, '-') || 'photo';
}

function formatShutter(exposureTime: unknown): string {
  if (typeof exposureTime !== 'number' || !Number.isFinite(exposureTime) || exposureTime <= 0) {
    return '';
  }
  if (exposureTime >= 1) return `${Number(exposureTime.toFixed(1))}s`;
  const denom = Math.round(1 / exposureTime);
  return denom > 0 ? `1/${denom}s` : '';
}

async function parseQuickExif(
  blob: Blob,
): Promise<{ exifSummary: string; takenAt: string | null }> {
  try {
    const exifrMod = await import('exifr');
    const parseFn = exifrMod.parse ?? exifrMod.default?.parse;
    if (typeof parseFn !== 'function') return { exifSummary: '', takenAt: null };

    const tags = (await parseFn(blob, {
      reviveValues: false,
      translateKeys: true,
      translateValues: false,
      tiff: true,
      exif: true,
    })) as Record<string, unknown> | null;

    if (!tags) return { exifSummary: '', takenAt: null };

    const make = typeof tags.Make === 'string' ? tags.Make.trim() : '';
    const model = typeof tags.Model === 'string' ? tags.Model.trim() : '';
    const lens = typeof tags.LensModel === 'string' ? tags.LensModel.trim() : '';

    let body = '';
    if (make && model) {
      body = model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
    } else {
      body = model || make;
    }

    const focal =
      typeof tags.FocalLength === 'number' && Number.isFinite(tags.FocalLength) && tags.FocalLength > 0
        ? `${Math.round(tags.FocalLength)}mm`
        : '';
    const aperture =
      typeof tags.FNumber === 'number' && Number.isFinite(tags.FNumber) && tags.FNumber > 0
        ? `f/${Number(tags.FNumber.toFixed(1))}`
        : '';
    const shutter = formatShutter(tags.ExposureTime);
    const isoVal = tags.ISO ?? tags.ISOSpeedRatings;
    const iso =
      typeof isoVal === 'number' && Number.isFinite(isoVal) && isoVal > 0
        ? `ISO ${Math.round(isoVal)}`
        : '';

    const rawDate = tags.DateTimeOriginal ?? tags.CreateDate ?? tags.ModifyDate;
    const rawOffset = tags.OffsetTimeOriginal ?? tags.OffsetTimeDigitized ?? tags.OffsetTime;
    let takenAt: string | null = null;
    if (typeof rawDate === 'string') {
      takenAt = exifTakenAt(rawDate, rawOffset);
      if (!takenAt && /^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
        takenAt = rawDate;
      }
    } else if (rawDate instanceof Date && Number.isFinite(rawDate.getTime())) {
      takenAt = rawDate.toISOString();
    }

    const exifSummary = [body, lens, focal, aperture, shutter, iso].filter(Boolean).join(' · ');
    return { exifSummary, takenAt };
  } catch {
    return { exifSummary: '', takenAt: null };
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法解码影像文件，请确认照片未损坏。'));
    img.src = src;
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function loadSavedCustomPresets(): CustomGradePreset[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CustomGradePreset[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!name) continue;
      const id =
        typeof rec.id === 'string' && rec.id.trim()
          ? rec.id.trim()
          : `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const note = typeof rec.note === 'string' ? rec.note.trim() : '';
      const createdAt =
        typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt)
          ? rec.createdAt
          : Date.now();
      const params = resolveGradeParams(
        rec.params && typeof rec.params === 'object' ? (rec.params as GradeParamsPatch) : null,
      );
      out.push({ id, name: name.slice(0, 32), note: note.slice(0, 80), createdAt, params });
    }
    return out;
  } catch {
    return [];
  }
}

function saveCustomPresetsToStorage(presets: CustomGradePreset[]): void {
  try {
    window.localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

function isHslBandEdited(adj: HslAdjustment): boolean {
  return (
    Math.abs(adj.hue) > 0.01 || Math.abs(adj.sat) > 0.01 || Math.abs(adj.lum) > 0.01
  );
}

function isGradeDefault(p: GradeParams): boolean {
  if (
    Math.abs(p.exposure) > 0.005 ||
    Math.abs(p.contrast) > 0.1 ||
    Math.abs(p.highlights) > 0.1 ||
    Math.abs(p.shadows) > 0.1 ||
    Math.abs(p.whites) > 0.1 ||
    Math.abs(p.blacks) > 0.1 ||
    Math.abs(p.temperature) > 0.1 ||
    Math.abs(p.tint) > 0.1 ||
    Math.abs(p.vibrance) > 0.1 ||
    Math.abs(p.saturation) > 0.1 ||
    Math.abs(p.fade) > 0.1 ||
    Math.abs(p.vignette) > 0.1 ||
    Math.abs(p.grain) > 0.1 ||
    Math.abs(p.splitHighlightSat) > 0.1 ||
    Math.abs(p.splitShadowSat) > 0.1
  ) {
    return false;
  }
  return HSL_BAND_IDS.every((id) => !isHslBandEdited(p.hsl[id]));
}

function buildHistogramPath(bins: Uint32Array, ceiling: number, width = 256, height = 64): string {
  const n = bins.length;
  if (n === 0 || ceiling <= 0) return `M 0 ${height} L ${width} ${height} Z`;
  const parts: string[] = [`M 0 ${height}`];
  for (let i = 0; i < n; i += 1) {
    const x = n === 1 ? 0 : (i / (n - 1)) * width;
    const norm = clamp(bins[i] / ceiling, 0, 1);
    const y = height - norm * (height - 4);
    parts.push(`L ${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  parts.push(`L ${width} ${height} Z`);
  return parts.join(' ');
}

function computeRobustCeiling(hist: HistogramData): number {
  const vals: number[] = [];
  for (let i = 1; i < hist.luma.length - 1; i += 1) {
    vals.push(hist.luma[i], hist.r[i], hist.g[i], hist.b[i]);
  }
  if (vals.length === 0) return Math.max(1, hist.max);
  vals.sort((a, b) => a - b);
  const p97 = vals[Math.floor(vals.length * 0.97)] ?? hist.max;
  return Math.max(1, p97 * 1.12, hist.max * 0.25);
}

interface GradeSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  leftHint: string;
  rightHint: string;
  formatValue: (v: number) => string;
  onChange: (next: number) => void;
  hueSpectrum?: boolean;
}

function GradeSlider({
  label,
  value,
  min,
  max,
  step = 1,
  defaultValue = 0,
  leftHint,
  rightHint,
  formatValue,
  onChange,
  hueSpectrum = false,
}: GradeSliderProps) {
  const isModified = Math.abs(value - defaultValue) > (step < 1 ? 0.005 : 0.4);

  const handleReset = () => {
    if (isModified) onChange(defaultValue);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            onDoubleClick={handleReset}
            title="双击数值可快速归零"
            className="cursor-default select-none text-[12.5px] font-medium text-ink"
          >
            {label}
          </span>
          {hueSpectrum && (
            <span
              className="h-3 w-3 shrink-0 rounded-full border border-hairline-strong"
              style={{ backgroundColor: `hsl(${Math.round(value)}, 72%, 54%)` }}
              aria-hidden="true"
            />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isModified && (
            <button
              type="button"
              onClick={handleReset}
              aria-label={`重置${label}`}
              title={`重置${label}`}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onDoubleClick={handleReset}
            title="双击归零"
            className={[
              'tabular-nums-mono min-w-[54px] rounded-[6px] px-1.5 py-0.5 text-right text-[12px] transition-colors',
              isModified
                ? 'bg-surface font-medium text-accent'
                : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            {formatValue(value)}
          </button>
        </div>
      </div>

      {hueSpectrum && (
        <div
          className="h-1.5 w-full rounded-full border border-hairline"
          style={{
            background:
              'linear-gradient(90deg, #d94848 0%, #df9b38 17%, #4aa660 33%, #3ca6b3 50%, #4472c8 67%, #975cc6 83%, #d94848 100%)',
          }}
          aria-hidden="true"
        />
      )}

      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-5 w-full cursor-pointer accent-[var(--color-accent)]"
      />

      <div className="flex items-center justify-between text-[10.5px] text-ink-muted/85">
        <span>{leftHint}</span>
        <span>{rightHint}</span>
      </div>
    </div>
  );
}

export default function PhotoGradeTool() {
  const { search, navigate } = useRouter();

  // Track created object URLs for strict cleanup
  const ownedUrlsRef = useRef<Set<string>>(new Set());
  const registerUrl = useCallback((url: string) => {
    ownedUrlsRef.current.add(url);
    return url;
  }, []);
  const releaseUrl = useCallback((url?: string) => {
    if (!url) return;
    if (ownedUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      ownedUrlsRef.current.delete(url);
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const u of ownedUrlsRef.current) {
        URL.revokeObjectURL(u);
      }
      ownedUrlsRef.current.clear();
    };
  }, []);

  // Image & handoff state
  const [photo, setPhoto] = useState<LoadedPhoto | null>(null);
  const [photoLoading, setPhotoLoading] = useState<boolean>(true);
  const [photoError, setPhotoError] = useState<string>('');
  const [isDraggingPhoto, setIsDraggingPhoto] = useState<boolean>(false);
  const [handoffNotice, setHandoffNotice] = useState<string>('');
  const pendingHandoffRef = useRef<ToolkitMediaHandoff | null>(null);
  const hasInitializedPhotoRef = useRef<boolean>(false);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  // Beginner problem guide
  const [activeGuideId, setActiveGuideId] = useState<string | null>(null);

  // Grading parameters & preset state
  const [params, setParams] = useState<GradeParams>(() => cloneGradeParams(DEFAULT_GRADE_PARAMS));
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [activePresetName, setActivePresetName] = useState<string>('');
  const [activePresetPatch, setActivePresetPatch] = useState<GradeParamsPatch | null>(null);
  const [presetStrength, setPresetStrength] = useState<number>(100);
  const [presetModified, setPresetModified] = useState<boolean>(false);

  // Custom .cube 3D LUT state
  const [creativeLut, setCreativeLut] = useState<Lut3D | null>(null);
  const creativeLutRef = useRef<Lut3D | null>(null);
  creativeLutRef.current = creativeLut;
  const [creativeLutStrength, setCreativeLutStrength] = useState<number>(85);
  const [lutMessage, setLutMessage] = useState<string>('');
  const cubeInputRef = useRef<HTMLInputElement | null>(null);

  // Custom local presets (localStorage)
  const [customPresets, setCustomPresets] = useState<CustomGradePreset[]>(() =>
    loadSavedCustomPresets(),
  );
  const [presetCategory, setPresetCategory] = useState<PresetFilterTab>('all');
  const [newPresetName, setNewPresetName] = useState<string>('');
  const [newPresetNote, setNewPresetNote] = useState<string>('');
  const [presetFeedback, setPresetFeedback] = useState<string>('');
  const jsonImportRef = useRef<HTMLInputElement | null>(null);
  const presetNameInputRef = useRef<HTMLInputElement | null>(null);

  // Parameter studio tabs & active HSL color band
  const [studioTab, setStudioTab] = useState<StudioTab>('light');
  const [activeHslBand, setActiveHslBand] = useState<HslBandId>('blue');

  // Preview stage interactive controls
  const [splitEnabled, setSplitEnabled] = useState<boolean>(false);
  const [splitPosition, setSplitPosition] = useState<number>(0.5);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [showOriginalHold, setShowOriginalHold] = useState<boolean>(false);
  const [webglError, setWebglError] = useState<string>('');
  const [histogram, setHistogram] = useState<HistogramData | null>(null);

  // Export & handoff state
  const [exportFormat, setExportFormat] = useState<ExportMime>('image/jpeg');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isHandingOff, setIsHandingOff] = useState<boolean>(false);
  const [exportFeedback, setExportFeedback] = useState<string>('');

  // WebGL canvas & pipeline refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const splitOverlayRef = useRef<HTMLDivElement | null>(null);
  const pipelineRef = useRef<WebGLColorPipeline | null>(null);
  const rafRenderRef = useRef<number | null>(null);
  const lastHistTimeRef = useRef<number>(0);
  const trailingHistTimerRef = useRef<number | null>(null);

  // Lookup map for built-in presets
  const presetById = useMemo(() => {
    const map = new Map<string, GradePreset>();
    for (const p of GRADE_PRESETS) {
      map.set(p.id, p);
    }
    return map;
  }, []);

  const activeGuide = useMemo(
    () => BEGINNER_GUIDES.find((g) => g.id === activeGuideId) ?? null,
    [activeGuideId],
  );

  // Replace loaded photo safely, revoking previous owned object URL
  const commitPhoto = useCallback(
    (next: LoadedPhoto) => {
      hasInitializedPhotoRef.current = true;
      setPhoto((prev) => {
        if (prev?.isOwnedUrl && prev.url !== next.url) {
          releaseUrl(prev.url);
        }
        return next;
      });
      setPhotoError('');
      setPhotoLoading(false);
    },
    [releaseUrl],
  );

  const loadSamplePhoto = useCallback(
    async (sample: SamplePhotoDef, clearHandoff = true) => {
      setPhotoLoading(true);
      setPhotoError('');
      if (clearHandoff) setHandoffNotice('');
      try {
        const img = await loadImageElement(sample.url);
        commitPhoto({
          name: sample.fileName,
          url: sample.url,
          isOwnedUrl: false,
          sampleId: sample.id,
          img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          place: sample.place,
          caption: sample.caption,
          exifSummary: sample.exifSummary,
          takenAt: sample.takenAt,
        });
      } catch (err) {
        setPhotoError(err instanceof Error ? err.message : '示例影像载入失败。');
        setPhotoLoading(false);
      }
    },
    [commitPhoto],
  );

  const loadLocalPhotoFile = useCallback(
    async (file: File) => {
      if (
        !file.type.startsWith('image/') &&
        !/\.(jpe?g|png|webp|avif|bmp|gif)$/i.test(file.name)
      ) {
        setPhotoError('请选择 JPG、PNG、WebP 等本地照片文件。');
        return;
      }
      setPhotoLoading(true);
      setPhotoError('');
      setHandoffNotice('');

      const url = registerUrl(URL.createObjectURL(file));
      try {
        const [img, exif] = await Promise.all([loadImageElement(url), parseQuickExif(file)]);
        commitPhoto({
          name: file.name,
          url,
          isOwnedUrl: true,
          img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          exifSummary: exif.exifSummary || undefined,
          takenAt: exif.takenAt,
        });
      } catch (err) {
        releaseUrl(url);
        setPhotoError(err instanceof Error ? err.message : '本地照片读取失败。');
        setPhotoLoading(false);
      }
    },
    [commitPhoto, registerUrl, releaseUrl],
  );

  // Initial mount & cross-tool handoff receiver (StrictMode-safe!)
  useEffect(() => {
    let cancelled = false;
    const incoming = consumeToolkitHandoff('grade');
    if (incoming) {
      pendingHandoffRef.current = incoming;
    }

    const activeHandoff = pendingHandoffRef.current;
    if (activeHandoff) {
      setPhotoLoading(true);
      setPhotoError('');
      const url = registerUrl(URL.createObjectURL(activeHandoff.blob));
      void (async () => {
        try {
          const img = await loadImageElement(url);
          if (cancelled) {
            releaseUrl(url);
            return;
          }
          pendingHandoffRef.current = null;
          commitPhoto({
            name: activeHandoff.fileName || 'log-frame.png',
            url,
            isOwnedUrl: true,
            img,
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
            place: activeHandoff.place,
            caption: activeHandoff.caption,
            exifSummary: activeHandoff.exifSummary,
            takenAt: activeHandoff.takenAt ?? null,
          });
          setHandoffNotice(
            activeHandoff.sourceLabel
              ? `已接收来自 Log 视频的静帧画面（${activeHandoff.sourceLabel}），可直接套用配色或精调后送入装裱。`
              : '已接收来自 Log 视频的静帧画面，可直接套用配色或精调后送入装裱。',
          );
        } catch {
          releaseUrl(url);
          if (!cancelled) {
            pendingHandoffRef.current = null;
            void loadSamplePhoto(SAMPLE_PHOTOS[0], false);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    if (!hasInitializedPhotoRef.current) {
      setPhotoLoading(true);
      void (async () => {
        try {
          const sample = SAMPLE_PHOTOS[0];
          const img = await loadImageElement(sample.url);
          if (cancelled) {
            return;
          }
          commitPhoto({
            name: sample.fileName,
            url: sample.url,
            isOwnedUrl: false,
            sampleId: sample.id,
            img,
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
            place: sample.place,
            caption: sample.caption,
            exifSummary: sample.exifSummary,
            takenAt: sample.takenAt,
          });
        } catch (err) {
          if (!cancelled) {
            setPhotoError(err instanceof Error ? err.message : '默认示例影像载入失败。');
            setPhotoLoading(false);
          }
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [search, commitPhoto, loadSamplePhoto, registerUrl, releaseUrl]);

  // Dispose WebGL pipeline cleanly on unmount
  useEffect(() => {
    return () => {
      if (rafRenderRef.current !== null) {
        window.cancelAnimationFrame(rafRenderRef.current);
      }
      if (trailingHistTimerRef.current !== null) {
        window.clearTimeout(trailingHistTimerRef.current);
      }
      pipelineRef.current?.dispose();
      pipelineRef.current = null;
    };
  }, []);

  // Ensure WebGL pipeline exists & upload source texture when photo changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !photo) return;

    const longest = Math.max(photo.width, photo.height);
    const maxPreviewEdge = 1440;
    const scale = longest > maxPreviewEdge ? maxPreviewEdge / longest : 1;
    const targetW = Math.max(1, Math.round(photo.width * scale));
    const targetH = Math.max(1, Math.round(photo.height * scale));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    try {
      if (!pipelineRef.current) {
        pipelineRef.current = new WebGLColorPipeline(canvas);
      }
      pipelineRef.current.setSource(photo.img);
      pipelineRef.current.setCreativeLut(creativeLutRef.current);
      setWebglError('');
    } catch (err) {
      setWebglError(
        err instanceof Error
          ? err.message
          : '当前浏览器环境未启用 WebGL 渲染，请开启硬件加速后重试。',
      );
    }
  }, [photo]);

  // Sync creative LUT texture whenever it changes
  useEffect(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline) return;
    try {
      pipeline.setCreativeLut(creativeLut);
    } catch {
      // Ignore if pipeline not ready
    }
  }, [creativeLut]);

  // Render live frame + throttled histogram update
  useEffect(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline || !photo || webglError) return;

    if (rafRenderRef.current !== null) {
      window.cancelAnimationFrame(rafRenderRef.current);
    }

    rafRenderRef.current = window.requestAnimationFrame(() => {
      rafRenderRef.current = null;
      const activePipeline = pipelineRef.current;
      if (!activePipeline) return;

      activePipeline.render({
        params,
        baseLutStrength: 0,
        creativeLutStrength: creativeLut ? creativeLutStrength / 100 : 0,
        splitPosition: splitEnabled ? splitPosition : undefined,
        showOriginal: showOriginalHold,
      });

      const refreshHist = () => {
        const p = pipelineRef.current;
        if (!p) return;
        try {
          setHistogram(p.computeHistogram(160));
          lastHistTimeRef.current = performance.now();
        } catch {
          // Ignore transient readPixels errors
        }
      };

      const elapsed = performance.now() - lastHistTimeRef.current;
      if (elapsed >= 65) {
        refreshHist();
      } else {
        if (trailingHistTimerRef.current !== null) {
          window.clearTimeout(trailingHistTimerRef.current);
        }
        trailingHistTimerRef.current = window.setTimeout(() => {
          trailingHistTimerRef.current = null;
          refreshHist();
        }, 70);
      }
    });
  }, [
    photo,
    params,
    creativeLut,
    creativeLutStrength,
    splitEnabled,
    splitPosition,
    showOriginalHold,
    webglError,
  ]);

  // Preset application helpers
  const applyBuiltinPreset = useCallback((preset: GradePreset, strength = 100) => {
    const clamped = clamp(Math.round(strength), 0, 100);
    setActivePresetId(preset.id);
    setActivePresetName(preset.name);
    setActivePresetPatch(preset.params);
    setPresetStrength(clamped);
    setPresetModified(false);
    setParams(blendGradeParams(DEFAULT_GRADE_PARAMS, preset.params, clamped / 100));
  }, []);

  const applyCustomPreset = useCallback((preset: CustomGradePreset, strength = 100) => {
    const clamped = clamp(Math.round(strength), 0, 100);
    setActivePresetId(preset.id);
    setActivePresetName(preset.name);
    setActivePresetPatch(preset.params);
    setPresetStrength(clamped);
    setPresetModified(false);
    setParams(blendGradeParams(DEFAULT_GRADE_PARAMS, preset.params, clamped / 100));
  }, []);

  const handlePresetStrengthChange = useCallback(
    (nextStrength: number) => {
      const clamped = clamp(Math.round(nextStrength), 0, 100);
      setPresetStrength(clamped);
      if (activePresetPatch) {
        setPresetModified(false);
        setParams(blendGradeParams(DEFAULT_GRADE_PARAMS, activePresetPatch, clamped / 100));
      }
    },
    [activePresetPatch],
  );

  // Manual parameter mutations
  const updateScalarParam = useCallback(
    <K extends Exclude<keyof GradeParams, 'hsl'>>(key: K, value: GradeParams[K]) => {
      setParams((prev) => ({ ...prev, [key]: value }));
      if (activePresetId) setPresetModified(true);
    },
    [activePresetId],
  );

  const updateHslParam = useCallback(
    (band: HslBandId, field: keyof HslAdjustment, value: number) => {
      setParams((prev) => ({
        ...prev,
        hsl: {
          ...prev.hsl,
          [band]: {
            ...prev.hsl[band],
            [field]: value,
          },
        },
      }));
      if (activePresetId) setPresetModified(true);
    },
    [activePresetId],
  );

  const resetHslBand = useCallback(
    (band: HslBandId) => {
      setParams((prev) => ({
        ...prev,
        hsl: {
          ...prev.hsl,
          [band]: { hue: 0, sat: 0, lum: 0 },
        },
      }));
      if (activePresetId) setPresetModified(true);
    },
    [activePresetId],
  );

  const resetAllHsl = useCallback(() => {
    setParams((prev) => ({
      ...prev,
      hsl: cloneGradeParams(DEFAULT_GRADE_PARAMS).hsl,
    }));
    if (activePresetId) setPresetModified(true);
  }, [activePresetId]);

  const handleResetAll = useCallback(() => {
    setParams(cloneGradeParams(DEFAULT_GRADE_PARAMS));
    setActivePresetId(null);
    setActivePresetName('');
    setActivePresetPatch(null);
    setPresetStrength(100);
    setPresetModified(false);
    setCreativeLut(null);
    setCreativeLutStrength(85);
    setLutMessage('');
    setExportFeedback('');
  }, []);

  // File drop & file input handlers
  const handlePhotoInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadLocalPhotoFile(file);
    e.target.value = '';
  };

  const handleStageDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingPhoto(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (/\.cube$/i.test(file.name)) {
      void handleCubeFile(file);
      return;
    }
    void loadLocalPhotoFile(file);
  };

  // Custom .cube 3D LUT import
  const handleCubeFile = useCallback(async (file: File) => {
    setLutMessage('');
    try {
      const text = await file.text();
      const parsed = parseCubeLut(text, sanitizeBaseName(file.name));
      setCreativeLut(parsed);
      setCreativeLutStrength(85);
      setLutMessage(`已载入 3D LUT「${parsed.title}」（${parsed.size}³ 网格）。`);
    } catch (err) {
      setLutMessage(err instanceof Error ? err.message : '.cube 文件解析失败，请确认格式有效。');
    }
  }, []);

  const handleCubeInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleCubeFile(file);
    e.target.value = '';
  };

  // Export 33³ .cube LUT
  const handleExportCube33 = useCallback(() => {
    const title = activePresetName ? `Lvtushouji ${activePresetName}` : 'Lvtushouji Custom Grade';
    const lut33 = bakeCombinedCubeLut33({
      grade: params,
      creativeLut,
      creativeStrength: creativeLut ? creativeLutStrength / 100 : 0,
      title,
    });
    const cubeText = serializeCubeLut(lut33, title);
    const blob = new Blob([cubeText], { type: 'text/plain;charset=utf-8' });
    const slug = sanitizeBaseName(activePresetName || 'custom-grade');
    triggerDownload(blob, `${slug}-33.cube`);
    setPresetFeedback('已导出标准 33³ .cube LUT，可直接导入剪映、达芬奇或 Premiere 使用。');
  }, [activePresetName, params, creativeLut, creativeLutStrength]);

  // Custom local presets CRUD + JSON import/export
  const handleSaveCustomPreset = () => {
    const trimmed = newPresetName.trim();
    if (!trimmed) {
      setPresetFeedback('请先为自定义配方输入名称。');
      return;
    }
    const created: CustomGradePreset = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed.slice(0, 32),
      note: newPresetNote.trim().slice(0, 80),
      createdAt: Date.now(),
      params: cloneGradeParams(params),
    };
    const nextList = [created, ...customPresets];
    setCustomPresets(nextList);
    saveCustomPresetsToStorage(nextList);
    setActivePresetId(created.id);
    setActivePresetName(created.name);
    setActivePresetPatch(created.params);
    setPresetStrength(100);
    setPresetModified(false);
    setNewPresetName('');
    setNewPresetNote('');
    setPresetFeedback(`已将「${created.name}」保存至本地我的预设。`);
  };

  const handleDeleteCustomPreset = (id: string) => {
    const nextList = customPresets.filter((item) => item.id !== id);
    setCustomPresets(nextList);
    saveCustomPresetsToStorage(nextList);
    if (activePresetId === id) {
      setActivePresetId(null);
      setActivePresetName('');
      setActivePresetPatch(null);
    }
  };

  const handleExportPresetsJson = () => {
    const payload = {
      schema: 'lvtushouji-grade-presets-v1',
      exportedAt: new Date().toISOString(),
      presets: customPresets,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    triggerDownload(blob, 'lvtushouji-grade-presets.json');
    setPresetFeedback(`已导出 ${customPresets.length} 套本地预设 JSON。`);
  };

  const handleImportPresetsJson = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { presets?: unknown }).presets)
          ? (parsed as { presets: unknown[] }).presets
          : [];
      const imported: CustomGradePreset[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        if (!name) continue;
        imported.push({
          id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: name.slice(0, 32),
          note: typeof rec.note === 'string' ? rec.note.trim().slice(0, 80) : '',
          createdAt: Date.now(),
          params: resolveGradeParams(
            rec.params && typeof rec.params === 'object' ? (rec.params as GradeParamsPatch) : null,
          ),
        });
      }
      if (imported.length === 0) {
        setPresetFeedback('未在 JSON 文件中找到有效的调色预设条目。');
        return;
      }
      const merged = [...imported, ...customPresets];
      setCustomPresets(merged);
      saveCustomPresetsToStorage(merged);
      setPresetCategory('custom');
      setPresetFeedback(`已导入 ${imported.length} 套自定义调色预设。`);
    } catch {
      setPresetFeedback('预设 JSON 解析失败，请确认文件内容完整。');
    }
  };

  // Interactive Before/After Split-Screen Pointer Events
  const updateSplitFromClientX = useCallback((clientX: number) => {
    const el = splitOverlayRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((clientX - rect.left) / rect.width, 0.02, 0.98);
    setSplitPosition(ratio);
  }, []);

  const handleSplitPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitEnabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingSplit(true);
    updateSplitFromClientX(e.clientX);
  };

  const handleSplitPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingSplit) return;
    updateSplitFromClientX(e.clientX);
  };

  const handleSplitPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDraggingSplit) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDraggingSplit(false);
  };

  const handleSplitKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!splitEnabled) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setSplitPosition((p) => clamp(p - 0.03, 0.02, 0.98));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setSplitPosition((p) => clamp(p + 0.03, 0.02, 0.98));
    }
  };

  // Full-resolution export
  const handleExportImage = async () => {
    if (!photo || !pipelineRef.current || isExporting) return;
    const fmt =
      EXPORT_FORMAT_OPTIONS.find((item) => item.mime === exportFormat) ?? EXPORT_FORMAT_OPTIONS[0];
    setIsExporting(true);
    setExportFeedback('');
    try {
      const blob = await pipelineRef.current.renderImageToBlob(photo.img, {
        params,
        creativeLut,
        creativeLutStrength: creativeLut ? creativeLutStrength / 100 : 0,
        mime: fmt.mime,
        quality: fmt.quality,
      });
      const base = sanitizeBaseName(photo.name);
      const tag = activePresetName ? sanitizeBaseName(activePresetName) : 'graded';
      triggerDownload(blob, `${base}-${tag}.${fmt.ext}`);
      setExportFeedback(
        `已导出全分辨率成片（${photo.width}×${photo.height} · ${formatBytes(blob.size)}）。`,
      );
    } catch (err) {
      setExportFeedback(err instanceof Error ? err.message : '全分辨率成片导出失败。');
    } finally {
      setIsExporting(false);
    }
  };

  // Cross-tool handoff to #1 ImageDarkroomTool (Mode B Bone-White Postmark Framing)
  const handleSendToPostmarkFrame = async () => {
    if (!photo || !pipelineRef.current || isHandingOff) return;
    setIsHandingOff(true);
    setExportFeedback('');
    try {
      const blob = await pipelineRef.current.renderImageToBlob(photo.img, {
        params,
        creativeLut,
        creativeLutStrength: creativeLut ? creativeLutStrength / 100 : 0,
        mime: 'image/jpeg',
        quality: 0.95,
      });
      const base = sanitizeBaseName(photo.name);
      const tag = activePresetName ? sanitizeBaseName(activePresetName) : 'graded';
      setToolkitHandoff({
        target: 'image',
        blob,
        fileName: `${base}-${tag}.jpg`,
        sourceLabel: '暗房一键调色',
        place: photo.place,
        caption: photo.caption,
        exifSummary: photo.exifSummary,
        takenAt: photo.takenAt ?? null,
        createdAt: Date.now(),
      });
      navigate('/toolkit?tool=image&handoff=1');
    } catch (err) {
      setExportFeedback(err instanceof Error ? err.message : '传递至装裱台失败，请先尝试本地导出。');
      setIsHandingOff(false);
    }
  };

  // Filtered built-in presets
  const filteredBuiltinPresets = useMemo(() => {
    if (presetCategory === 'all') return GRADE_PRESETS;
    if (presetCategory === 'custom') return [];
    return GRADE_PRESETS.filter((p) => p.category === presetCategory);
  }, [presetCategory]);

  const categoryCounts = useMemo(() => {
    let film = 0;
    let cinema = 0;
    let practical = 0;
    for (const p of GRADE_PRESETS) {
      if (p.category === 'film') film += 1;
      else if (p.category === 'cinema') cinema += 1;
      else practical += 1;
    }
    return {
      all: GRADE_PRESETS.length,
      film,
      cinema,
      practical,
      custom: customPresets.length,
    };
  }, [customPresets.length]);

  // Histogram SVG paths & tonal distribution
  const histogramView = useMemo(() => {
    if (!histogram) return null;
    const ceiling = computeRobustCeiling(histogram);
    let shadowSum = 0;
    let midSum = 0;
    let highSum = 0;
    const len = histogram.luma.length;
    const sCut = Math.floor(len * 0.25);
    const hCut = Math.floor(len * 0.75);
    for (let i = 0; i < len; i += 1) {
      const v = histogram.luma[i];
      if (i < sCut) shadowSum += v;
      else if (i >= hCut) highSum += v;
      else midSum += v;
    }
    const total = Math.max(1, shadowSum + midSum + highSum);
    return {
      lumaPath: buildHistogramPath(histogram.luma, ceiling),
      rPath: buildHistogramPath(histogram.r, ceiling),
      gPath: buildHistogramPath(histogram.g, ceiling),
      bPath: buildHistogramPath(histogram.b, ceiling),
      shadowPct: Math.round((shadowSum / total) * 100),
      midPct: Math.round((midSum / total) * 100),
      highPct: Math.round((highSum / total) * 100),
    };
  }, [histogram]);

  const hasEdits = useMemo(
    () => !isGradeDefault(params) || Boolean(creativeLut && creativeLutStrength > 0),
    [params, creativeLut, creativeLutStrength],
  );

  const activeBandMeta =
    HSL_BAND_META.find((b) => b.id === activeHslBand) ?? HSL_BAND_META[5];
  const activeBandValue = params.hsl[activeHslBand];

  return (
    <div className="min-w-0 space-y-5">
      {/* Hidden file inputs */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        onChange={handlePhotoInputChange}
        className="sr-only"
      />
      <input
        ref={cubeInputRef}
        type="file"
        accept=".cube,.txt"
        onChange={handleCubeInputChange}
        className="sr-only"
      />
      <input
        ref={jsonImportRef}
        type="file"
        accept="application/json,.json"
        onChange={(e) => void handleImportPresetsJson(e)}
        className="sr-only"
      />

      {/* Quiet Handoff Banner (when receiving a grabbed frame from #10 Log Video) */}
      {handoffNotice && (
        <div
          role="status"
          className="panel-fade-in flex items-start justify-between gap-3 rounded-[18px] border border-postmark/35 bg-paper px-4 py-3 text-[13px] text-ink"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <Frame className="mt-0.5 h-4 w-4 shrink-0 text-postmark" aria-hidden="true" />
            <span className="leading-relaxed">{handoffNotice}</span>
          </div>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setHandoffNotice('')}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* 1. Top Sample & Local Photo Loader Bar */}
      <div className="flex flex-col gap-3 rounded-[22px] border border-hairline bg-surface p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-muted">
            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-postmark" aria-hidden="true" />
            <span>快速样片</span>
          </span>
          {SAMPLE_PHOTOS.map((sample) => {
            const active = photo?.sampleId === sample.id;
            return (
              <button
                key={sample.id}
                type="button"
                aria-pressed={active}
                onClick={() => void loadSamplePhoto(sample)}
                className={[
                  'inline-flex min-h-[34px] shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 text-[12.5px] transition-colors',
                  active
                    ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                    : 'border-hairline bg-paper text-ink-muted hover:border-hairline-strong hover:text-ink',
                ].join(' ')}
              >
                {sample.label}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {photo && (
            <span className="tabular-nums-mono hidden text-[12px] text-ink-muted xl:inline">
              {photo.width} × {photo.height} px
            </span>
          )}
          <button
            type="button"
            onClick={() => photoInputRef.current?.click()}
            className="pill-cta-secondary min-h-[38px] shrink-0 whitespace-nowrap px-4 text-[13px]"
          >
            <Upload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>上传本地照片</span>
          </button>
        </div>
      </div>

      {/* 2. Beginner-Friendly Guided Strip (新手按痛点选方案) */}
      <section
        aria-label="新手按痛点选方案"
        className="rounded-[22px] border border-hairline bg-paper p-4 sm:p-5"
      >
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <div className="flex items-center gap-2">
            <Compass className="h-4 w-4 shrink-0 text-postmark" aria-hidden="true" />
            <h3 className="m-0 text-[15px] font-medium text-ink">新手按痛点选方案</h3>
          </div>
          <p className="m-0 text-[12.5px] text-ink-muted">
            不用背参数术语，直接点选画面当下最困扰的问题
          </p>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {BEGINNER_GUIDES.map((guide) => {
            const active = activeGuideId === guide.id;
            return (
              <button
                key={guide.id}
                type="button"
                aria-expanded={active}
                onClick={() => setActiveGuideId((curr) => (curr === guide.id ? null : guide.id))}
                className={[
                  'inline-flex min-h-[34px] shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 text-[12.5px] transition-colors',
                  active
                    ? 'border-accent/50 bg-accent/10 font-medium text-accent'
                    : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                ].join(' ')}
              >
                {guide.problem}
              </button>
            );
          })}
        </div>

        {activeGuide && (
          <div className="panel-fade-in mt-3.5 rounded-[16px] border border-hairline bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="text-[13px] font-medium text-ink">
                  画面诊断 · {activeGuide.problem}
                </div>
                <p className="font-editorial-serif m-0 text-[13.5px] leading-relaxed text-ink-muted">
                  {activeGuide.diagnosis}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveGuideId(null)}
                aria-label="收起场景诊断"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-paper text-ink-muted transition-colors hover:text-ink"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-ink-muted">一键套用推荐：</span>
              {activeGuide.recommendedPresetIds.map((presetId) => {
                const preset = presetById.get(presetId);
                if (!preset) return null;
                const applied = activePresetId === preset.id && !presetModified;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyBuiltinPreset(preset, 100)}
                    className={[
                      'inline-flex min-h-[34px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[12.5px] transition-colors',
                      applied
                        ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                        : 'border-hairline-strong bg-paper text-ink hover:border-accent hover:text-accent',
                    ].join(' ')}
                  >
                    {applied && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                    <span>{preset.name}</span>
                    <span className="text-[11px] opacity-75">· {preset.reference}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-3 rounded-[12px] border border-hairline bg-paper/75 px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
              <span className="font-medium text-postmark">微调建议：</span>
              <span>{activeGuide.tip}</span>
            </div>
          </div>
        )}
      </section>

      {/* 3 & 5. Main Darkroom Workbench: Left WebGL Preview + Right Parameter Studio */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start">
        {/* LEFT COLUMN: Calibrated Darkroom Stage + Live Histogram + Export & Handoff */}
        <div className="min-w-0 space-y-4 lg:col-span-7 lg:sticky lg:top-[76px] lg:max-h-[calc(100dvh-96px)] lg:overflow-y-auto lg:pr-1">
          {/* Calibrated Darkroom Stage (data-only-dark="true") */}
          <div
            data-only-dark="true"
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingPhoto(true);
            }}
            onDragLeave={() => setIsDraggingPhoto(false)}
            onDrop={handleStageDrop}
            className={[
              'deep-space overflow-hidden rounded-[24px] border transition-colors',
              isDraggingPhoto ? 'border-dashed border-[#8ab4f8]' : 'border-hairline',
            ].join(' ')}
          >
            {/* Stage Top Control Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#14161a] px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-[12px]">
                <span className="truncate font-medium text-[#e3e3e3]">
                  {photo ? photo.name : '暗房预览台'}
                </span>
                {activePresetName && (
                  <span className="shrink-0 rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[11px] text-[#d69f87]">
                    {activePresetName}
                    {presetModified ? ' · 已微调' : ` · ${presetStrength}%`}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={splitEnabled}
                  onClick={() => setSplitEnabled((v) => !v)}
                  className={[
                    'inline-flex min-h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[12px] transition-colors',
                    splitEnabled
                      ? 'border-[#8ab4f8]/60 bg-[#8ab4f8]/15 font-medium text-[#8ab4f8]'
                      : 'border-white/15 bg-white/5 text-[#e3e3e3] hover:bg-white/10',
                  ].join(' ')}
                >
                  <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>分屏对比</span>
                </button>

                <button
                  type="button"
                  onPointerDown={() => setShowOriginalHold(true)}
                  onPointerUp={() => setShowOriginalHold(false)}
                  onPointerLeave={() => setShowOriginalHold(false)}
                  onPointerCancel={() => setShowOriginalHold(false)}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') setShowOriginalHold(true);
                  }}
                  onKeyUp={() => setShowOriginalHold(false)}
                  className={[
                    'inline-flex min-h-[30px] shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[12px] transition-colors',
                    showOriginalHold
                      ? 'border-[#d69f87]/70 bg-[#d69f87]/20 font-medium text-[#e3e3e3]'
                      : 'border-white/15 bg-white/5 text-[#e3e3e3] hover:bg-white/10',
                  ].join(' ')}
                >
                  <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>按住对比原图</span>
                </button>

                <button
                  type="button"
                  disabled={!hasEdits && !activePresetId}
                  onClick={handleResetAll}
                  className="inline-flex min-h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-white/15 bg-white/5 px-3 text-[12px] text-[#9aa0a6] transition-colors hover:bg-white/10 hover:text-[#e3e3e3] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>一键重置</span>
                </button>
              </div>
            </div>

            {/* Canvas Viewport */}
            <div className="relative flex min-h-[240px] items-center justify-center p-3 sm:min-h-[300px] sm:p-4">
              {photoLoading && !photo && (
                <div className="py-16 text-[13px] text-[#9aa0a6]">正在解码暗房影像...</div>
              )}

              {photoError && (
                <div role="alert" className="py-12 text-center text-[13px] text-[#d69f87]">
                  {photoError}
                </div>
              )}

              {photo && !webglError && (
                <div
                  ref={splitOverlayRef}
                  onPointerDown={handleSplitPointerDown}
                  onPointerMove={handleSplitPointerMove}
                  onPointerUp={handleSplitPointerUp}
                  onPointerCancel={handleSplitPointerUp}
                  onKeyDown={handleSplitKeyDown}
                  role={splitEnabled ? 'slider' : undefined}
                  tabIndex={splitEnabled ? 0 : undefined}
                  aria-label={splitEnabled ? '原图与调色分屏对比位置' : undefined}
                  aria-valuemin={splitEnabled ? 0 : undefined}
                  aria-valuemax={splitEnabled ? 100 : undefined}
                  aria-valuenow={splitEnabled ? Math.round(splitPosition * 100) : undefined}
                  className={[
                    'relative inline-flex max-w-full items-center justify-center leading-none',
                    splitEnabled ? 'cursor-ew-resize touch-none select-none' : '',
                  ].join(' ')}
                >
                  <canvas
                    ref={canvasRef}
                    aria-label="暗房一键调色 WebGL 实时预览画布"
                    style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
                    className="block h-auto max-h-[46vh] w-auto max-w-full rounded-[10px] border border-white/10 shadow-sm"
                  />

                  {/* Holding original badge */}
                  {showOriginalHold && (
                    <span className="pointer-events-none absolute top-3 left-3 rounded-full border border-white/25 bg-[#0b0c0e]/80 px-2.5 py-1 text-[11px] font-medium text-[#e3e3e3]">
                      原图对照中
                    </span>
                  )}

                  {/* Draggable Before/After Split Divider */}
                  {splitEnabled && !showOriginalHold && (
                    <>
                      <span className="pointer-events-none absolute top-3 left-3 rounded-full border border-white/20 bg-[#0b0c0e]/75 px-2.5 py-0.5 text-[11px] text-[#e3e3e3]">
                        原图
                      </span>
                      <span className="pointer-events-none absolute top-3 right-3 rounded-full border border-white/20 bg-[#0b0c0e]/75 px-2.5 py-0.5 text-[11px] text-[#e3e3e3]">
                        调色后
                      </span>
                      <div
                        aria-hidden="true"
                        style={{ left: `${(splitPosition * 100).toFixed(2)}%` }}
                        className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-white/85 shadow-[0_0_6px_rgba(0,0,0,0.8)]"
                      >
                        <div className="absolute top-1/2 left-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-[#0b0c0e]/85 text-[#e3e3e3] shadow-md">
                          <ArrowLeftRight className="h-3.5 w-3.5" />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {photo && webglError && (
                <div className="space-y-3 text-center">
                  <img
                    src={photo.url}
                    alt={photo.name}
                    className="mx-auto block h-auto max-h-[50vh] w-auto max-w-full rounded-[10px] border border-white/10"
                  />
                  <p className="m-0 text-[12.5px] text-[#d69f87]">{webglError}</p>
                </div>
              )}
            </div>

            {/* Stage Footer Metadata Strip */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-[#14161a] px-4 py-2 text-[11.5px] text-[#9aa0a6]">
              <span className="tabular-nums-mono truncate">
                {photo
                  ? photo.exifSummary
                    ? `${photo.width}×${photo.height} · ${photo.exifSummary}`
                    : `${photo.width}×${photo.height} px · 可拖入本地照片或 .cube 文件`
                  : '等待载入照片'}
              </span>
              {creativeLut && (
                <span className="tabular-nums-mono shrink-0 text-[#8ab4f8]">
                  3D LUT: {creativeLut.title} ({creativeLut.size}³ · {creativeLutStrength}%)
                </span>
              )}
            </div>
          </div>

          {/* Live Compact RGB + Luma Histogram */}
          <div className="rounded-[18px] border border-hairline bg-page/70 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
              <div className="flex items-center gap-3">
                <span className="font-medium text-ink">实时 RGB + 亮度直方图</span>
                <span className="inline-flex items-center gap-2 text-ink-muted">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-[#d9534f]" aria-hidden="true" />R
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-[#4caf72]" aria-hidden="true" />G
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-[#4a8be8]" aria-hidden="true" />B
                  </span>
                </span>
              </div>

              {histogramView && (
                <div className="tabular-nums-mono flex items-center gap-2.5 text-[11px] text-ink-muted">
                  <span>暗部 {histogramView.shadowPct}%</span>
                  <span>中调 {histogramView.midPct}%</span>
                  <span>高光 {histogramView.highPct}%</span>
                </div>
              )}
            </div>

            <div className="mt-2 overflow-hidden rounded-[10px] border border-hairline bg-surface/80">
              <svg
                viewBox="0 0 256 64"
                preserveAspectRatio="none"
                role="img"
                aria-label="影像 RGB 与亮度实时直方图"
                className="block h-[64px] w-full text-ink"
              >
                <line x1="64" y1="0" x2="64" y2="64" stroke="currentColor" strokeOpacity="0.1" strokeWidth="1" />
                <line x1="128" y1="0" x2="128" y2="64" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
                <line x1="192" y1="0" x2="192" y2="64" stroke="currentColor" strokeOpacity="0.1" strokeWidth="1" />
                {histogramView && (
                  <>
                    <path d={histogramView.lumaPath} fill="currentColor" fillOpacity="0.14" />
                    <path
                      d={histogramView.rPath}
                      fill="#d9534f"
                      fillOpacity="0.22"
                      stroke="#d9534f"
                      strokeOpacity="0.72"
                      strokeWidth="1"
                    />
                    <path
                      d={histogramView.gPath}
                      fill="#4caf72"
                      fillOpacity="0.2"
                      stroke="#4caf72"
                      strokeOpacity="0.72"
                      strokeWidth="1"
                    />
                    <path
                      d={histogramView.bPath}
                      fill="#4a8be8"
                      fillOpacity="0.22"
                      stroke="#4a8be8"
                      strokeOpacity="0.75"
                      strokeWidth="1"
                    />
                  </>
                )}
              </svg>
            </div>
          </div>

          {/* 6. Export & Cross-Tool Handoff Bar */}
          <div className="space-y-3 rounded-[22px] border border-hairline bg-paper p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-ink">成片导出与跨工具流转</span>
              <div className="inline-flex flex-wrap rounded-full border border-hairline bg-surface p-0.5">
                {EXPORT_FORMAT_OPTIONS.map((opt) => {
                  const active = exportFormat === opt.mime;
                  return (
                    <button
                      key={opt.mime}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setExportFormat(opt.mime)}
                      className={[
                        'tabular-nums-mono whitespace-nowrap rounded-full px-3 py-1 text-[11.5px] transition-colors',
                        active
                          ? 'bg-cta-bg font-medium text-cta-text'
                          : 'text-ink-muted hover:text-ink',
                      ].join(' ')}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                disabled={!photo || Boolean(webglError) || isExporting}
                onClick={() => void handleExportImage()}
                className="pill-cta-primary min-h-[42px] w-full whitespace-nowrap px-4 text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{isExporting ? '正在全分辨率渲染...' : '导出全分辨率成片'}</span>
              </button>

              <button
                type="button"
                disabled={!photo || Boolean(webglError) || isHandingOff}
                onClick={() => void handleSendToPostmarkFrame()}
                className="pill-cta-secondary min-h-[42px] w-full whitespace-nowrap px-4 text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Frame className="h-4 w-4 shrink-0 text-postmark" aria-hidden="true" />
                <span>{isHandingOff ? '正在送入装裱台...' : '送入骨白邮戳装裱'}</span>
              </button>
            </div>

            {exportFeedback && (
              <div role="status" className="text-[12px] text-postmark">
                {exportFeedback}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Preset Strength + Custom .cube + 4-Tab Parameter Studio */}
        <div className="min-w-0 space-y-4 lg:col-span-5">
          {/* Active Preset Master Strength + Custom .cube LUT Control Card */}
          <div className="space-y-3.5 rounded-[22px] border border-hairline bg-paper p-4 sm:p-5">
            {/* Master Preset Strength */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[12.5px] font-medium text-ink">预设强度</span>
                  <span className="ml-2 truncate text-[12px] text-ink-muted">
                    {activePresetName ? `当前：${activePresetName}` : '未选配方（请在下方挑选）'}
                  </span>
                </div>
                <span className="tabular-nums-mono shrink-0 text-[12px] font-medium text-accent">
                  {activePresetPatch ? `${presetStrength}%` : '—'}
                </span>
              </div>
              <input
                type="range"
                aria-label="预设强度"
                min={0}
                max={100}
                step={1}
                disabled={!activePresetPatch}
                value={presetStrength}
                onChange={(e) => handlePresetStrengthChange(Number(e.target.value))}
                className="h-5 w-full cursor-pointer accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>

            {/* Custom .cube 3D LUT Import & Blend */}
            <div className="space-y-2 border-t border-hairline pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-ink">外部 3D LUT（.cube）</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => cubeInputRef.current?.click()}
                    className="inline-flex min-h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink transition-colors hover:border-hairline-strong"
                  >
                    <FileUp className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                    <span>导入 .cube LUT</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleExportCube33}
                    className="inline-flex min-h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                  >
                    <FileDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>导出 33³ .cube</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPresetCategory('custom');
                      window.requestAnimationFrame(() => {
                        presetNameInputRef.current?.scrollIntoView({
                          behavior: 'smooth',
                          block: 'center',
                        });
                        presetNameInputRef.current?.focus();
                      });
                    }}
                    className="inline-flex min-h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5 shrink-0 text-postmark" aria-hidden="true" />
                    <span>存为我的预设</span>
                  </button>
                </div>
              </div>

              {creativeLut && (
                <div className="space-y-1.5 rounded-[14px] border border-hairline bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate text-[12px] font-medium text-ink">
                      {creativeLut.title}
                      <span className="tabular-nums-mono ml-1.5 text-[11px] font-normal text-ink-muted">
                        ({creativeLut.size}³)
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="tabular-nums-mono text-[12px] text-accent">
                        {creativeLutStrength}%
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setCreativeLut(null);
                          setLutMessage('');
                        }}
                        className="inline-flex items-center gap-1 rounded-full border border-hairline bg-paper px-2.5 py-0.5 text-[11px] text-ink-muted hover:text-ink"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                        <span>清除</span>
                      </button>
                    </div>
                  </div>
                  <input
                    type="range"
                    aria-label="自定义 .cube LUT 强度"
                    min={0}
                    max={100}
                    step={1}
                    value={creativeLutStrength}
                    onChange={(e) => setCreativeLutStrength(Number(e.target.value))}
                    className="h-5 w-full cursor-pointer accent-[var(--color-accent)]"
                  />
                </div>
              )}

              {lutMessage && <p className="m-0 text-[11.5px] text-postmark">{lutMessage}</p>}
            </div>
          </div>

          {/* 5. Four-Tab Parameter Studio */}
          <div className="rounded-[22px] border border-hairline bg-paper p-4 sm:p-5">
            {/* 4-Tab Segmented Navigation */}
            <div
              role="tablist"
              aria-label="调色参数分组"
              className="grid grid-cols-2 gap-1.5 rounded-[16px] border border-hairline bg-surface p-1 sm:grid-cols-4"
            >
              {STUDIO_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = studioTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setStudioTab(tab.id)}
                    className={[
                      'inline-flex min-h-[34px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[12px] px-2.5 text-[12px] transition-colors',
                      active
                        ? 'bg-cta-bg font-medium text-cta-text'
                        : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                    ].join(' ')}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-1.5 text-right text-[11px] text-ink-muted/80">
              双击任意参数数值可快速归零
            </div>

            {/* Tab 1: 基础光影 */}
            {studioTab === 'light' && (
              <div className="mt-3 space-y-3.5">
                <GradeSlider
                  label="曝光 EV"
                  value={params.exposure}
                  min={-2}
                  max={2}
                  step={0.05}
                  leftHint="压暗整体"
                  rightHint="提亮画面"
                  formatValue={(v) => `${v > 0.005 ? '+' : ''}${v.toFixed(2)} EV`}
                  onChange={(v) => updateScalarParam('exposure', v)}
                />
                <GradeSlider
                  label="对比度"
                  value={params.contrast}
                  min={-100}
                  max={100}
                  leftHint="柔和低反差"
                  rightHint="硬朗层次"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('contrast', v)}
                />
                <GradeSlider
                  label="高光"
                  value={params.highlights}
                  min={-100}
                  max={100}
                  leftHint="拉回过曝天空"
                  rightHint="增强亮部通透"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('highlights', v)}
                />
                <GradeSlider
                  label="阴影"
                  value={params.shadows}
                  min={-100}
                  max={100}
                  leftHint="压沉暗部轮廓"
                  rightHint="救回暗部细节"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('shadows', v)}
                />
                <GradeSlider
                  label="白色色阶"
                  value={params.whites}
                  min={-100}
                  max={100}
                  leftHint="收敛高光白点"
                  rightHint="拉开极白通透"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('whites', v)}
                />
                <GradeSlider
                  label="黑色色阶"
                  value={params.blacks}
                  min={-100}
                  max={100}
                  leftHint="沉实纯黑底"
                  rightHint="提亮最暗灰阶"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('blacks', v)}
                />
              </div>
            )}

            {/* Tab 2: 色彩平衡 */}
            {studioTab === 'color' && (
              <div className="mt-3 space-y-4">
                <GradeSlider
                  label="色温"
                  value={params.temperature}
                  min={-100}
                  max={100}
                  leftHint="偏冷清蓝"
                  rightHint="偏暖日光黄"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('temperature', v)}
                />
                <GradeSlider
                  label="色调"
                  value={params.tint}
                  min={-100}
                  max={100}
                  leftHint="偏胶片青绿"
                  rightHint="偏晚霞品红"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('tint', v)}
                />
                <GradeSlider
                  label="自然饱和度"
                  value={params.vibrance}
                  min={-100}
                  max={100}
                  leftHint="减淡平淡色"
                  rightHint="护肤色提鲜"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('vibrance', v)}
                />
                <GradeSlider
                  label="饱和度"
                  value={params.saturation}
                  min={-100}
                  max={100}
                  leftHint="褪至纯黑白"
                  rightHint="全局增艳"
                  formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                  onChange={(v) => updateScalarParam('saturation', v)}
                />
              </div>
            )}

            {/* Tab 3: HSL 八色 */}
            {studioTab === 'hsl' && (
              <div className="mt-3 space-y-4">
                {/* 8 Circular Color Chips */}
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                  {HSL_BAND_META.map((band) => {
                    const active = activeHslBand === band.id;
                    const edited = isHslBandEdited(params.hsl[band.id]);
                    return (
                      <button
                        key={band.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setActiveHslBand(band.id)}
                        className={[
                          'relative flex flex-col items-center gap-1 rounded-[12px] border py-2 text-[11px] transition-colors',
                          active
                            ? 'border-accent bg-surface font-medium text-ink'
                            : 'border-hairline bg-surface/50 text-ink-muted hover:border-hairline-strong hover:text-ink',
                        ].join(' ')}
                      >
                        <span
                          className={[
                            'h-5 w-5 rounded-full border border-black/15',
                            active ? 'ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-surface)]' : '',
                          ].join(' ')}
                          style={{ backgroundColor: band.swatch }}
                          aria-hidden="true"
                        />
                        <span className="whitespace-nowrap">{band.label}</span>
                        {edited && (
                          <span
                            aria-hidden="true"
                            className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-accent"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Active Band Sliders */}
                <div className="space-y-3.5 rounded-[16px] border border-hairline bg-surface/70 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                      <span
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: activeBandMeta.swatch }}
                        aria-hidden="true"
                      />
                      <span>当前通道：{activeBandMeta.label}色</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!isHslBandEdited(activeBandValue)}
                        onClick={() => resetHslBand(activeHslBand)}
                        className="rounded-full border border-hairline bg-paper px-2.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
                      >
                        重置此色
                      </button>
                      <button
                        type="button"
                        onClick={resetAllHsl}
                        className="rounded-full border border-hairline bg-paper px-2.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:text-ink"
                      >
                        全部归零
                      </button>
                    </div>
                  </div>

                  <GradeSlider
                    label="色相"
                    value={activeBandValue.hue}
                    min={-30}
                    max={30}
                    step={1}
                    leftHint="向相邻冷/前色偏移"
                    rightHint="向相邻暖/后色偏移"
                    formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}°`}
                    onChange={(v) => updateHslParam(activeHslBand, 'hue', v)}
                  />
                  <GradeSlider
                    label="饱和度"
                    value={activeBandValue.sat}
                    min={-100}
                    max={100}
                    step={1}
                    leftHint="降低该色浓艳度"
                    rightHint="增强该色纯度"
                    formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                    onChange={(v) => updateHslParam(activeHslBand, 'sat', v)}
                  />
                  <GradeSlider
                    label="明度"
                    value={activeBandValue.lum}
                    min={-100}
                    max={100}
                    step={1}
                    leftHint="压暗变深邃"
                    rightHint="提亮更清透"
                    formatValue={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                    onChange={(v) => updateHslParam(activeHslBand, 'lum', v)}
                  />
                </div>
              </div>
            )}

            {/* Tab 4: 质感与分离 */}
            {studioTab === 'finish' && (
              <div className="mt-3 space-y-4">
                <div className="space-y-3 rounded-[16px] border border-hairline bg-surface/65 p-3.5">
                  <div className="text-[12px] font-medium text-ink">色调分离（高光 / 阴影）</div>
                  <GradeSlider
                    label="高光偏色色相"
                    value={params.splitHighlightHue}
                    min={0}
                    max={360}
                    step={1}
                    leftHint="暖红 / 金黄"
                    rightHint="青蓝 / 品红"
                    formatValue={(v) => `${Math.round(v)}°`}
                    hueSpectrum
                    onChange={(v) => updateScalarParam('splitHighlightHue', v)}
                  />
                  <GradeSlider
                    label="高光偏色强度"
                    value={params.splitHighlightSat}
                    min={0}
                    max={100}
                    step={1}
                    leftHint="中性纯白"
                    rightHint="高光染色"
                    formatValue={(v) => `${Math.round(v)}%`}
                    onChange={(v) => updateScalarParam('splitHighlightSat', v)}
                  />
                  <div className="border-t border-hairline pt-2.5">
                    <GradeSlider
                      label="阴影偏色色相"
                      value={params.splitShadowHue}
                      min={0}
                      max={360}
                      step={1}
                      leftHint="暖红 / 琥珀"
                      rightHint="电影青 / 深蓝"
                      formatValue={(v) => `${Math.round(v)}°`}
                      hueSpectrum
                      onChange={(v) => updateScalarParam('splitShadowHue', v)}
                    />
                  </div>
                  <GradeSlider
                    label="阴影偏色强度"
                    value={params.splitShadowSat}
                    min={0}
                    max={100}
                    step={1}
                    leftHint="中性纯黑"
                    rightHint="暗部染色"
                    formatValue={(v) => `${Math.round(v)}%`}
                    onChange={(v) => updateScalarParam('splitShadowSat', v)}
                  />
                </div>

                <div className="space-y-3.5">
                  <GradeSlider
                    label="胶片褪色黑位 Fade"
                    value={params.fade}
                    min={0}
                    max={100}
                    step={1}
                    leftHint="扎实黑位"
                    rightHint="复古灰黑空气感"
                    formatValue={(v) => `${Math.round(v)}`}
                    onChange={(v) => updateScalarParam('fade', v)}
                  />
                  <GradeSlider
                    label="暗角 Vignette"
                    value={params.vignette}
                    min={0}
                    max={100}
                    step={1}
                    leftHint="四角均匀"
                    rightHint="聚焦中心主体"
                    formatValue={(v) => `${Math.round(v)}`}
                    onChange={(v) => updateScalarParam('vignette', v)}
                  />
                  <GradeSlider
                    label="胶片颗粒 Grain"
                    value={params.grain}
                    min={0}
                    max={100}
                    step={1}
                    leftHint="数码纯净"
                    rightHint="卤化银质感"
                    formatValue={(v) => `${Math.round(v)}`}
                    onChange={(v) => updateScalarParam('grain', v)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 4. Real-World Presets Gallery & Custom Local Presets */}
      <section
        aria-label="真实调色配方库"
        className="space-y-4 rounded-[24px] border border-hairline bg-surface p-4 sm:p-6"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="m-0 text-[16px] font-medium text-ink">暗房调色配方库</h3>
            <p className="mt-0.5 mb-0 text-[12.5px] text-ink-muted">
              20 套基于胶片模拟、电影纪实与常见外拍痛点校准的实测方案，支持 0–100% 强度平滑混合
            </p>
          </div>

          {/* Category Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'all', label: '全部', count: categoryCounts.all },
                { id: 'film', label: '经典胶片', count: categoryCounts.film },
                { id: 'cinema', label: '电影纪实', count: categoryCounts.cinema },
                { id: 'practical', label: '实用场景', count: categoryCounts.practical },
                { id: 'custom', label: '我的预设', count: categoryCounts.custom },
              ] as const
            ).map((tab) => {
              const active = presetCategory === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setPresetCategory(tab.id)}
                  className={[
                    'inline-flex min-h-[34px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[12.5px] transition-colors',
                    active
                      ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                      : 'border-hairline bg-paper text-ink-muted hover:border-hairline-strong hover:text-ink',
                  ].join(' ')}
                >
                  <span>{tab.label}</span>
                  <span className="tabular-nums-mono text-[11px] opacity-75">{tab.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {presetFeedback && (
          <div
            role="status"
            className="rounded-[14px] border border-hairline bg-paper px-3.5 py-2.5 text-[12.5px] text-postmark"
          >
            {presetFeedback}
          </div>
        )}

        {/* Built-in Presets Grid */}
        {presetCategory !== 'custom' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredBuiltinPresets.map((preset) => {
              const active = activePresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => applyBuiltinPreset(preset, 100)}
                  className={[
                    'group flex min-w-0 flex-col justify-between rounded-[18px] border p-4 text-left transition-colors',
                    active
                      ? 'border-accent bg-paper shadow-2xs'
                      : 'border-hairline bg-paper/80 hover:border-hairline-strong hover:bg-paper',
                  ].join(' ')}
                >
                  <div className="min-w-0 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[14px] font-medium text-ink">
                            {preset.name}
                          </span>
                          {active && (
                            <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[11.5px] text-postmark">
                          {preset.reference}
                        </div>
                      </div>
                      <span className="shrink-0 whitespace-nowrap rounded-full border border-hairline bg-surface px-2 py-0.5 text-[10.5px] text-ink-muted">
                        {CATEGORY_LABELS[preset.category]}
                      </span>
                    </div>

                    <p className="font-editorial-serif m-0 line-clamp-2 text-[12.5px] leading-relaxed text-ink-muted">
                      {preset.summary}
                    </p>
                  </div>

                  <div className="mt-3 truncate border-t border-hairline pt-2 text-[11px] text-ink-muted">
                    适用：{preset.bestFor.join(' · ')}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Custom Local Presets Panel (我的预设) */}
        {presetCategory === 'custom' && (
          <div className="space-y-4">
            {/* Save Current Params Form */}
            <div className="rounded-[18px] border border-hairline bg-paper p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="block min-w-0 flex-1">
                  <span className="text-[12px] text-ink-muted">新配方名称</span>
                  <input
                    ref={presetNameInputRef}
                    type="text"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    placeholder="例：川西冷调晴雪 / 胶片人像微暖"
                    className="mt-1 w-full rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted/60"
                  />
                </label>
                <label className="block min-w-0 flex-1">
                  <span className="text-[12px] text-ink-muted">适用场景备注（选填）</span>
                  <input
                    type="text"
                    value={newPresetNote}
                    onChange={(e) => setNewPresetNote(e.target.value)}
                    placeholder="例：适合逆光日落或高原湖泊"
                    className="mt-1 w-full rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted/60"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleSaveCustomPreset}
                  className="pill-cta-primary min-h-[40px] shrink-0 whitespace-nowrap px-4 text-[13px]"
                >
                  <BookmarkPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>保存当前参数</span>
                </button>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3 text-[12px] text-ink-muted">
                <span>自定义预设仅保存在本机浏览器中，支持随时导出备份或跨设备导入。</span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => jsonImportRef.current?.click()}
                    className="inline-flex min-h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink hover:border-hairline-strong"
                  >
                    <FileUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>导入预设 JSON</span>
                  </button>
                  <button
                    type="button"
                    disabled={customPresets.length === 0}
                    onClick={handleExportPresetsJson}
                    className="inline-flex min-h-[30px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink hover:border-hairline-strong disabled:opacity-40"
                  >
                    <FileDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>导出预设 JSON</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Saved Custom Presets List */}
            {customPresets.length === 0 ? (
              <div className="rounded-[18px] border border-dashed border-hairline-strong bg-paper/60 px-6 py-10 text-center text-[13px] text-ink-muted">
                尚未保存个人配方。可在上方调整好光影、色彩与 HSL 参数后点击「保存当前参数」。
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {customPresets.map((preset) => {
                  const active = activePresetId === preset.id;
                  return (
                    <div
                      key={preset.id}
                      className={[
                        'flex min-w-0 flex-col justify-between rounded-[18px] border p-4 transition-colors',
                        active ? 'border-accent bg-paper' : 'border-hairline bg-paper/85',
                      ].join(' ')}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="truncate text-[14px] font-medium text-ink">
                            {preset.name}
                          </span>
                          <button
                            type="button"
                            aria-label={`删除预设 ${preset.name}`}
                            onClick={() => handleDeleteCustomPreset(preset.id)}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-postmark"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                        <p className="font-editorial-serif m-0 text-[12.5px] leading-relaxed text-ink-muted">
                          {preset.note || '个人暗房自定义调色配方'}
                        </p>
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2.5">
                        <span className="tabular-nums-mono text-[11px] text-ink-muted">
                          EV {preset.params.exposure >= 0 ? '+' : ''}
                          {preset.params.exposure.toFixed(2)} · 对比 {Math.round(preset.params.contrast)}
                        </span>
                        <button
                          type="button"
                          onClick={() => applyCustomPreset(preset, 100)}
                          className={[
                            'inline-flex min-h-[28px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[12px] transition-colors',
                            active
                              ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                              : 'border-hairline bg-surface text-ink hover:border-hairline-strong',
                          ].join(' ')}
                        >
                          {active && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
                          <span>{active ? '已套用' : '套用'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
