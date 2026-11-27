import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import {
  AlertTriangle,
  Archive,
  Camera,
  CheckCircle2,
  Download,
  Frame,
  Image as ImageIcon,
  Layers,
  ShieldCheck,
  SlidersHorizontal,
  Stamp,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { exifTakenAt, formatDay } from '../../../../shared/dates';
import { useRouter } from '../../../lib/router';
import {
  consumeToolkitHandoff,
  peekToolkitHandoff,
  type ToolkitMediaHandoff,
} from '../color/media-handoff';

type DarkroomMode = 'compress' | 'frame';
type OutputFormat = 'image/webp' | 'image/jpeg' | 'image/png';
type MatTheme = 'bone' | 'charcoal';
type MatPadding = 'compact' | 'standard' | 'gallery';

interface ParsedExifInfo {
  hasGps: boolean;
  lat: number | null;
  lng: number | null;
  make: string;
  model: string;
  lens: string;
  focalLength: string;
  aperture: string;
  shutter: string;
  iso: string;
  takenAt: string | null;
  orientation: number;
  tagCount: number;
}

interface BatchImageItem {
  id: string;
  file: File;
  previewUrl: string;
  origWidth: number;
  origHeight: number;
  exif: ParsedExifInfo;
  status: 'processing' | 'done' | 'error';
  errorMsg?: string;
  outputBlob?: Blob;
  outputUrl?: string;
  outputWidth?: number;
  outputHeight?: number;
  outputExt?: string;
}

interface FramePhotoState {
  name: string;
  url: string;
  isOwnedUrl: boolean;
  isSample: boolean;
  img: HTMLImageElement;
  width: number;
  height: number;
  exif: ParsedExifInfo;
}

const EDGE_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '原尺寸', value: 0 },
  { label: '2400px', value: 2400 },
  { label: '1600px', value: 1600 },
  { label: '1200px', value: 1200 },
  { label: '800px', value: 800 },
];

const FORMAT_OPTIONS: ReadonlyArray<{ label: string; value: OutputFormat; ext: string }> = [
  { label: 'WebP', value: 'image/webp', ext: 'webp' },
  { label: 'JPEG', value: 'image/jpeg', ext: 'jpg' },
  { label: 'PNG', value: 'image/png', ext: 'png' },
];

const PADDING_OPTIONS: ReadonlyArray<{ label: string; value: MatPadding; ratio: number }> = [
  { label: '紧凑', value: 'compact', ratio: 0.045 },
  { label: '标准', value: 'standard', ratio: 0.072 },
  { label: '画廊宽边', value: 'gallery', ratio: 0.105 },
];

const SAMPLE_PHOTOS: ReadonlyArray<{
  label: string;
  url: string;
  filename: string;
  place: string;
  caption: string;
  camera: string;
  specs: string;
  date: string;
}> = [
  {
    label: '雪山晨雾',
    url: '/demo/mountain.jpg',
    filename: 'demo-mountain.jpg',
    place: '川西 · 折多山垭口',
    caption: '云影沿雪线缓慢退去，晨光落在冷峻的山脊与静止的空气里。',
    camera: 'FUJIFILM X-T5 · XF 35mm f/1.4',
    specs: '35mm · f/4.0 · 1/640s · ISO 160',
    date: '2026.10.18',
  },
  {
    label: '高原湖泊',
    url: '/demo/lake.jpg',
    filename: 'demo-lake.jpg',
    place: '新疆 · 赛里木湖畔',
    caption: '风停之前的十分钟，湖面把一整片低垂的云色完整收进水底。',
    camera: 'SONY ILCE-7M4 · FE 24-70mm GM II',
    specs: '50mm · f/5.6 · 1/500s · ISO 100',
    date: '2026.09.06',
  },
];

const EMPTY_EXIF: ParsedExifInfo = {
  hasGps: false,
  lat: null,
  lng: null,
  make: '',
  model: '',
  lens: '',
  focalLength: '',
  aperture: '',
  shutter: '',
  iso: '',
  takenAt: null,
  orientation: 1,
  tagCount: 0,
};

function todayDotDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatShutter(exposureTime: unknown): string {
  if (typeof exposureTime !== 'number' || !Number.isFinite(exposureTime) || exposureTime <= 0) {
    return '';
  }
  if (exposureTime >= 1) return `${Number(exposureTime.toFixed(1))}s`;
  const denom = Math.round(1 / exposureTime);
  return denom > 0 ? `1/${denom}s` : '';
}

function formatCoordShort(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? 'E' : 'W'}`;
}

function composeCameraLabel(exif: ParsedExifInfo): string {
  const make = exif.make.trim();
  const model = exif.model.trim();
  let body = '';
  if (make && model) {
    body = model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
  } else {
    body = model || make;
  }
  return [body, exif.lens.trim()].filter(Boolean).join(' · ');
}

function composeSpecsLabel(exif: ParsedExifInfo): string {
  return [
    exif.focalLength,
    exif.aperture,
    exif.shutter,
    exif.iso ? `ISO ${exif.iso}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function sanitizeBaseName(filename: string): string {
  const stripped = filename.replace(/\.[^.]+$/, '').trim();
  return stripped.replace(/[\\/:*?"<>|]+/g, '-') || 'image';
}

function extFromMime(mime: string, fallbackExt: string): string {
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  return fallbackExt;
}

async function parseExifSafely(source: Blob): Promise<ParsedExifInfo> {
  try {
    const exifrMod = await import('exifr');
    const parseFn = exifrMod.parse ?? exifrMod.default?.parse;
    if (typeof parseFn !== 'function') return { ...EMPTY_EXIF };

    const tags = (await parseFn(source, {
      reviveValues: false,
      translateKeys: true,
      translateValues: false,
      gps: true,
      tiff: true,
      exif: true,
    })) as Record<string, unknown> | null;

    if (!tags) return { ...EMPTY_EXIF };

    let parsedLat = typeof tags.latitude === 'number' ? tags.latitude : NaN;
    let parsedLng = typeof tags.longitude === 'number' ? tags.longitude : NaN;

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      try {
        const gpsFn = exifrMod.gps ?? exifrMod.default?.gps;
        if (typeof gpsFn === 'function') {
          const gps = await gpsFn(source);
          if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
            parsedLat = gps.latitude;
            parsedLng = gps.longitude;
          }
        }
      } catch {
        // Ignore GPS fallback error
      }
    }

    const hasGps =
      Number.isFinite(parsedLat) &&
      Number.isFinite(parsedLng) &&
      Math.abs(parsedLat) <= 90 &&
      Math.abs(parsedLng) <= 180;

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

    const orientation =
      typeof tags.Orientation === 'number' && Number.isInteger(tags.Orientation)
        ? tags.Orientation
        : 1;

    const make = typeof tags.Make === 'string' ? tags.Make.trim() : '';
    const model = typeof tags.Model === 'string' ? tags.Model.trim() : '';
    const lens = typeof tags.LensModel === 'string' ? tags.LensModel.trim() : '';
    const focalLength =
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
        ? String(Math.round(isoVal))
        : '';

    return {
      hasGps,
      lat: hasGps ? Number(parsedLat.toFixed(6)) : null,
      lng: hasGps ? Number(parsedLng.toFixed(6)) : null,
      make,
      model,
      lens,
      focalLength,
      aperture,
      shutter,
      iso,
      takenAt,
      orientation,
      tagCount: Object.keys(tags).length,
    };
  } catch {
    return { ...EMPTY_EXIF };
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('影像解码失败，请确认文件未损坏。'));
    img.src = src;
  });
}

async function encodeCleanImage(
  file: Blob,
  orientation: number,
  maxEdge: number,
  format: OutputFormat,
  quality: number,
): Promise<{ blob: Blob; origWidth: number; origHeight: number; width: number; height: number }> {
  let bitmap: ImageBitmap | null = null;
  let fallbackImg: HTMLImageElement | null = null;
  let tempUrl: string | null = null;

  try {
    if (typeof createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        bitmap = await createImageBitmap(file);
      }
    }
  } catch {
    bitmap = null;
  }

  try {
    let srcW: number;
    let srcH: number;
    if (bitmap) {
      srcW = bitmap.width;
      srcH = bitmap.height;
    } else {
      tempUrl = URL.createObjectURL(file);
      fallbackImg = await loadImageElement(tempUrl);
      srcW = fallbackImg.naturalWidth || fallbackImg.width;
      srcH = fallbackImg.naturalHeight || fallbackImg.height;
    }

    const needsSwap =
      orientation === 6 || orientation === 8 || orientation === 5 || orientation === 7;
    const shouldManualRotate = Boolean(bitmap && needsSwap && srcW > srcH);

    const naturalW = shouldManualRotate ? srcH : srcW;
    const naturalH = shouldManualRotate ? srcW : srcH;
    const longest = Math.max(naturalW, naturalH);
    const scale = maxEdge > 0 && longest > maxEdge ? maxEdge / longest : 1;

    const targetW = Math.max(1, Math.round(srcW * scale));
    const targetH = Math.max(1, Math.round(srcH * scale));
    const outW = shouldManualRotate ? targetH : targetW;
    const outH = shouldManualRotate ? targetW : targetH;

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 Canvas 2D 编码。');

    if (format === 'image/jpeg') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, outW, outH);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    if (shouldManualRotate && bitmap) {
      if (orientation === 6) {
        ctx.translate(outW, 0);
        ctx.rotate(Math.PI / 2);
      } else if (orientation === 8) {
        ctx.translate(0, outH);
        ctx.rotate(-Math.PI / 2);
      }
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    } else if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, outW, outH);
    } else if (fallbackImg) {
      ctx.drawImage(fallbackImg, 0, 0, outW, outH);
    }
    ctx.restore();

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (res) => (res ? resolve(res) : reject(new Error('画布导出失败，请尝试缩小尺寸或更换格式。'))),
        format,
        format === 'image/png' ? undefined : quality,
      );
    });

    return {
      blob,
      origWidth: naturalW,
      origHeight: naturalH,
      width: outW,
      height: outH,
    };
  } finally {
    bitmap?.close();
    if (tempUrl) URL.revokeObjectURL(tempUrl);
  }
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function wrapEditorialLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  const paragraphs = cleaned.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    let current = '';
    for (const ch of para) {
      const candidate = current + ch;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current.trimEnd());
        current = ch.trimStart();
        if (lines.length >= maxLines) break;
      } else {
        current = candidate;
      }
    }
    if (lines.length < maxLines && current) {
      lines.push(current.trimEnd());
    }
    if (lines.length >= maxLines) break;
  }

  return lines.slice(0, maxLines);
}

function drawCircularPostmark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  dateLabel: string,
  topText: string,
  bottomText: string,
  sansStack: string,
  monoStack: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-7 * Math.PI) / 180);

  // Subtle postal cancellation waves on the left edge
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = Math.max(1, radius * 0.025);
  for (let row = -1; row <= 1; row += 1) {
    const wy = row * radius * 0.28;
    ctx.beginPath();
    for (let step = 0; step <= 24; step += 1) {
      const t = step / 24;
      const wx = -radius * 1.65 + t * radius * 0.56;
      const wave = Math.sin(t * Math.PI * 3) * radius * 0.055;
      if (step === 0) ctx.moveTo(wx, wy + wave);
      else ctx.lineTo(wx, wy + wave);
    }
    ctx.stroke();
  }

  // Outer solid double ring
  ctx.globalAlpha = 0.86;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.8, radius * 0.044);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(1, radius * 0.02);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.87, 0, Math.PI * 2);
  ctx.stroke();

  // Horizontal date band rules
  const bandHalf = radius * 0.24;
  const chordHalf = Math.sqrt(Math.max(0, (radius * 0.86) ** 2 - bandHalf ** 2));
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = Math.max(1, radius * 0.022);
  ctx.beginPath();
  ctx.moveTo(-chordHalf, -bandHalf);
  ctx.lineTo(chordHalf, -bandHalf);
  ctx.moveTo(-chordHalf, bandHalf);
  ctx.lineTo(chordHalf, bandHalf);
  ctx.stroke();

  // Top & bottom stamp labels
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const safeTop = (topText.trim() || '旅途手记').slice(0, 8);
  ctx.font = `500 ${Math.round(radius * 0.22)}px ${sansStack}`;
  ctx.fillText(safeTop, 0, -radius * 0.54, radius * 1.28);

  const safeDate = (dateLabel.trim() || todayDotDate()).slice(0, 12);
  ctx.font = `600 ${Math.round(radius * 0.24)}px ${monoStack}`;
  ctx.fillText(safeDate, 0, radius * 0.015, chordHalf * 1.88);

  const safeBottom = (bottomText.trim() || '暗房冲印').slice(0, 8);
  ctx.font = `400 ${Math.round(radius * 0.19)}px ${sansStack}`;
  ctx.globalAlpha = 0.78;
  ctx.fillText(safeBottom, 0, radius * 0.55, radius * 1.24);

  ctx.restore();
}

interface FrameRenderConfig {
  img: HTMLImageElement;
  matTheme: MatTheme;
  paddingMode: MatPadding;
  showPostmark: boolean;
  showExifStrip: boolean;
  place: string;
  caption: string;
  cameraText: string;
  specsText: string;
  dateText: string;
  maxPhotoEdge: number;
}

function renderGalleryFrameCanvas(canvas: HTMLCanvasElement, cfg: FrameRenderConfig): void {
  const natW = cfg.img.naturalWidth || cfg.img.width;
  const natH = cfg.img.naturalHeight || cfg.img.height;
  if (natW <= 0 || natH <= 0) return;

  const longest = Math.max(natW, natH);
  const scale = cfg.maxPhotoEdge > 0 && longest > cfg.maxPhotoEdge ? cfg.maxPhotoEdge / longest : 1;
  const photoW = Math.max(240, Math.round(natW * scale));
  const photoH = Math.max(180, Math.round(natH * scale));

  const padSpec = PADDING_OPTIONS.find((p) => p.value === cfg.paddingMode) ?? PADDING_OPTIONS[1];
  const refSide = Math.max(photoW, photoH);
  const padX = Math.max(28, Math.round(refSide * padSpec.ratio));
  const padTop = padX;

  const isBone = cfg.matTheme === 'bone';
  const matBg = isBone ? '#FAF8F4' : '#1E2023';
  const inkPrimary = isBone ? '#1F1F1F' : '#E8E6E1';
  const inkMuted = isBone ? '#5F6368' : '#9AA0A6';
  const postmarkColor = isBone ? '#9A5B42' : '#D69F87';
  const frameRule = isBone ? 'rgba(31, 31, 31, 0.11)' : 'rgba(232, 230, 225, 0.13)';
  const apertureShadow = isBone ? 'rgba(31, 31, 31, 0.12)' : 'rgba(0, 0, 0, 0.45)';

  const sansStack = "'Inter', 'Noto Sans SC', 'PingFang SC', ui-sans-serif, system-ui, sans-serif";
  const serifStack = "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', Georgia, serif";
  const monoStack = "'JetBrains Mono', ui-monospace, Consolas, monospace";

  // Proportional typographic scale driven by card content width
  const unit = Math.max(12, Math.min(photoW * 0.025, refSide * 0.022));
  const placeFontSize = Math.round(unit * 1.48);
  const captionFontSize = Math.round(unit * 1.02);
  const captionLineHeight = Math.round(captionFontSize * 1.62);
  const exifFontSize = Math.round(unit * 0.82);

  const hasPlace = cfg.place.trim().length > 0;
  const hasCaption = cfg.caption.trim().length > 0;
  const hasCamera = cfg.cameraText.trim().length > 0;
  const hasSpecs = cfg.specsText.trim().length > 0;
  const hasExifRow = cfg.showExifStrip && (hasCamera || hasSpecs);

  const stampRadius = cfg.showPostmark ? Math.round(Math.min(photoW * 0.11, unit * 3.1)) : 0;
  const textMaxW = cfg.showPostmark
    ? Math.max(photoW * 0.52, photoW - stampRadius * 2.55)
    : photoW;

  // Measure caption lines on a temporary measurement state
  const tmpCtx = canvas.getContext('2d');
  if (!tmpCtx) return;
  tmpCtx.font = `400 ${captionFontSize}px ${serifStack}`;
  const captionLines = hasCaption ? wrapEditorialLines(tmpCtx, cfg.caption, textMaxW, 2) : [];

  const plinthGapTop = Math.round(Math.max(padTop * 0.72, unit * 2.1));
  let textBlockH = 0;
  if (hasPlace) textBlockH += Math.round(placeFontSize * 1.3);
  if (captionLines.length > 0) {
    textBlockH += (hasPlace ? Math.round(unit * 0.55) : 0) + captionLines.length * captionLineHeight;
  }

  const stampBlockH = cfg.showPostmark ? stampRadius * 2.15 : 0;
  const upperPlinthH = Math.max(textBlockH, stampBlockH, unit * 2.4);
  const exifBlockH = hasExifRow ? Math.round(unit * 2.4 + exifFontSize * 1.4) : 0;
  const padBottom = Math.max(padTop, Math.round(padTop * 0.92));

  const totalW = photoW + padX * 2;
  const totalH = padTop + photoH + plinthGapTop + upperPlinthH + exifBlockH + padBottom;

  canvas.width = totalW;
  canvas.height = totalH;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // 1. Matte card fill
  ctx.fillStyle = matBg;
  ctx.fillRect(0, 0, totalW, totalH);

  // Subtle archival outer border inset
  const inset = Math.max(10, Math.round(padX * 0.34));
  ctx.strokeStyle = frameRule;
  ctx.lineWidth = Math.max(1, Math.round(unit * 0.06));
  ctx.strokeRect(inset, inset, totalW - inset * 2, totalH - inset * 2);

  // 2. Photograph aperture with restrained matte edge
  ctx.save();
  ctx.shadowColor = apertureShadow;
  ctx.shadowBlur = Math.round(unit * 0.75);
  ctx.shadowOffsetY = Math.round(unit * 0.18);
  ctx.fillStyle = isBone ? '#EAE6DE' : '#121417';
  ctx.fillRect(padX, padTop, photoW, photoH);
  ctx.restore();

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cfg.img, padX, padTop, photoW, photoH);

  // Hairline museum mat bevel around photo
  ctx.strokeStyle = isBone ? 'rgba(31, 31, 31, 0.10)' : 'rgba(255, 255, 255, 0.10)';
  ctx.lineWidth = Math.max(1, Math.round(unit * 0.055));
  ctx.strokeRect(padX + 0.5, padTop + 0.5, photoW - 1, photoH - 1);

  // 3. Caption & place block on left
  const plinthTop = padTop + photoH + plinthGapTop;
  let cursorY = plinthTop;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  if (hasPlace) {
    ctx.fillStyle = inkPrimary;
    ctx.font = `500 ${placeFontSize}px ${sansStack}`;
    ctx.fillText(cfg.place.trim(), padX, cursorY, textMaxW);
    cursorY += Math.round(placeFontSize * 1.32);
  }

  if (captionLines.length > 0) {
    if (hasPlace) cursorY += Math.round(unit * 0.35);
    ctx.fillStyle = inkMuted;
    ctx.font = `400 ${captionFontSize}px ${serifStack}`;
    for (const line of captionLines) {
      ctx.fillText(line, padX, cursorY, textMaxW);
      cursorY += captionLineHeight;
    }
  }

  // 4. Circular terracotta date postmark stamp on right
  if (cfg.showPostmark && stampRadius > 0) {
    const stampCx = padX + photoW - stampRadius * 1.06;
    const stampCy = plinthTop + Math.max(stampRadius, upperPlinthH * 0.48);
    const shortPlace = cfg.place.trim().split(/[·•\s,/]+/).filter(Boolean)[0] || '暗房冲印';
    drawCircularPostmark(
      ctx,
      stampCx,
      stampCy,
      stampRadius,
      postmarkColor,
      cfg.dateText.trim() || todayDotDate(),
      '旅途手记',
      shortPlace,
      sansStack,
      monoStack,
    );
  }

  // 5. Crisp EXIF strip at bottom
  if (hasExifRow) {
    const ruleY = plinthTop + upperPlinthH + Math.round(unit * 0.95);
    ctx.beginPath();
    ctx.moveTo(padX, ruleY);
    ctx.lineTo(padX + photoW, ruleY);
    ctx.strokeStyle = frameRule;
    ctx.lineWidth = Math.max(1, Math.round(unit * 0.055));
    ctx.stroke();

    const exifY = ruleY + Math.round(unit * 0.95);
    ctx.font = `400 ${exifFontSize}px ${monoStack}`;
    ctx.textBaseline = 'top';

    const leftText = cfg.cameraText.trim();
    const rightText = cfg.specsText.trim();
    const combinedNeed =
      (leftText ? ctx.measureText(leftText).width : 0) +
      (rightText ? ctx.measureText(rightText).width : 0) +
      unit * 2;

    if (leftText && rightText && combinedNeed <= photoW) {
      ctx.fillStyle = inkPrimary;
      ctx.textAlign = 'left';
      ctx.fillText(leftText, padX, exifY);

      ctx.fillStyle = inkMuted;
      ctx.textAlign = 'right';
      ctx.fillText(rightText, padX + photoW, exifY);
    } else {
      const merged = [leftText, rightText].filter(Boolean).join('  /  ');
      ctx.fillStyle = inkMuted;
      ctx.textAlign = 'left';
      ctx.fillText(merged, padX, exifY, photoW);
    }
  }
}

export default function ImageDarkroomTool() {
  const { search } = useRouter();
  const [mode, setMode] = useState<DarkroomMode>(() =>
    peekToolkitHandoff('image') ? 'frame' : 'compress',
  );

  // Track every created object URL for strict cleanup on unmount / replacement
  const trackedUrlsRef = useRef<Set<string>>(new Set());
  const registerUrl = useCallback((url: string) => {
    trackedUrlsRef.current.add(url);
    return url;
  }, []);
  const releaseUrl = useCallback((url: string | undefined) => {
    if (!url) return;
    if (trackedUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      trackedUrlsRef.current.delete(url);
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const url of trackedUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      trackedUrlsRef.current.clear();
    };
  }, []);

  // ===================== MODE A: Batch Compress & Privacy Strip =====================
  const [items, setItems] = useState<BatchImageItem[]>([]);
  const [maxEdge, setMaxEdge] = useState<number>(1600);
  const [format, setFormat] = useState<OutputFormat>('image/webp');
  const [quality, setQuality] = useState<number>(0.86);
  const [isDraggingBatch, setIsDraggingBatch] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string>('');
  const batchInputRef = useRef<HTMLInputElement | null>(null);
  const encodeGenRef = useRef<number>(0);

  const addBatchFiles = useCallback(
    async (fileList: File[]) => {
      const imageFiles = fileList.filter(
        (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(f.name),
      );
      if (imageFiles.length === 0) {
        setBatchMessage('请选择 JPG、PNG、WebP 等本地影像文件。');
        return;
      }
      setBatchMessage('');

      const newItems: BatchImageItem[] = imageFiles.map((file, idx) => ({
        id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        previewUrl: registerUrl(URL.createObjectURL(file)),
        origWidth: 0,
        origHeight: 0,
        exif: { ...EMPTY_EXIF },
        status: 'processing',
      }));

      setItems((prev) => [...prev, ...newItems]);

      const currentGen = encodeGenRef.current;
      const fmtDef = FORMAT_OPTIONS.find((f) => f.value === format) ?? FORMAT_OPTIONS[0];

      await Promise.all(
        newItems.map(async (entry) => {
          const exif = await parseExifSafely(entry.file);
          try {
            const encoded = await encodeCleanImage(
              entry.file,
              exif.orientation,
              maxEdge,
              format,
              quality,
            );
            if (encodeGenRef.current !== currentGen) return;
            const outUrl = registerUrl(URL.createObjectURL(encoded.blob));
            const actualExt = extFromMime(encoded.blob.type, fmtDef.ext);

            setItems((prev) =>
              prev.map((item) => {
                if (item.id !== entry.id) return item;
                if (item.outputUrl) releaseUrl(item.outputUrl);
                return {
                  ...item,
                  exif,
                  origWidth: encoded.origWidth,
                  origHeight: encoded.origHeight,
                  status: 'done',
                  outputBlob: encoded.blob,
                  outputUrl: outUrl,
                  outputWidth: encoded.width,
                  outputHeight: encoded.height,
                  outputExt: actualExt,
                  errorMsg: undefined,
                };
              }),
            );
          } catch (err) {
            if (encodeGenRef.current !== currentGen) return;
            setItems((prev) =>
              prev.map((item) =>
                item.id === entry.id
                  ? {
                      ...item,
                      exif,
                      status: 'error',
                      errorMsg: err instanceof Error ? err.message : '影像重编码失败',
                    }
                  : item,
              ),
            );
          }
        }),
      );
    },
    [format, maxEdge, quality, registerUrl, releaseUrl],
  );

  // Re-encode existing queue whenever compression controls change
  const itemsRef = useRef<BatchImageItem[]>(items);
  itemsRef.current = items;

  useEffect(() => {
    if (itemsRef.current.length === 0) return;
    const gen = ++encodeGenRef.current;
    const timer = window.setTimeout(() => {
      const snapshot = itemsRef.current;
      if (snapshot.length === 0) return;

      setItems((prev) => prev.map((it) => ({ ...it, status: 'processing', errorMsg: undefined })));
      const fmtDef = FORMAT_OPTIONS.find((f) => f.value === format) ?? FORMAT_OPTIONS[0];

      void Promise.all(
        snapshot.map(async (entry) => {
          try {
            const encoded = await encodeCleanImage(
              entry.file,
              entry.exif.orientation,
              maxEdge,
              format,
              quality,
            );
            if (encodeGenRef.current !== gen) return;
            const outUrl = registerUrl(URL.createObjectURL(encoded.blob));
            const actualExt = extFromMime(encoded.blob.type, fmtDef.ext);
            setItems((prev) =>
              prev.map((item) => {
                if (item.id !== entry.id) return item;
                if (item.outputUrl) releaseUrl(item.outputUrl);
                return {
                  ...item,
                  origWidth: encoded.origWidth,
                  origHeight: encoded.origHeight,
                  status: 'done',
                  outputBlob: encoded.blob,
                  outputUrl: outUrl,
                  outputWidth: encoded.width,
                  outputHeight: encoded.height,
                  outputExt: actualExt,
                  errorMsg: undefined,
                };
              }),
            );
          } catch (err) {
            if (encodeGenRef.current !== gen) return;
            setItems((prev) =>
              prev.map((item) =>
                item.id === entry.id
                  ? {
                      ...item,
                      status: 'error',
                      errorMsg: err instanceof Error ? err.message : '重新编码失败',
                    }
                  : item,
              ),
            );
          }
        }),
      );
    }, 160);

    return () => window.clearTimeout(timer);
  }, [maxEdge, format, quality, registerUrl, releaseUrl]);

  const handleBatchInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (files.length > 0) void addBatchFiles(files);
  };

  const handleBatchDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingBatch(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void addBatchFiles(files);
  };

  const handleLoadBatchSamples = async () => {
    setBatchMessage('');
    try {
      const loaded: File[] = [];
      for (const sample of SAMPLE_PHOTOS) {
        const res = await fetch(sample.url);
        if (!res.ok) continue;
        const blob = await res.blob();
        loaded.push(new File([blob], sample.filename, { type: blob.type || 'image/jpeg' }));
      }
      if (loaded.length > 0) {
        await addBatchFiles(loaded);
      }
    } catch {
      setBatchMessage('加载本地示例照片失败，请直接拖入你的图片。');
    }
  };

  const removeBatchItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((it) => it.id === id);
      if (target) {
        releaseUrl(target.previewUrl);
        releaseUrl(target.outputUrl);
      }
      return prev.filter((it) => it.id !== id);
    });
  };

  const clearBatchItems = () => {
    for (const it of items) {
      releaseUrl(it.previewUrl);
      releaseUrl(it.outputUrl);
    }
    setItems([]);
    setBatchMessage('');
  };

  const downloadSingleItem = (item: BatchImageItem) => {
    if (!item.outputBlob) return;
    const ext = item.outputExt || 'webp';
    const filename = `${sanitizeBaseName(item.file.name)}-clean.${ext}`;
    triggerBlobDownload(item.outputBlob, filename);
  };

  const downloadAllAsZip = async () => {
    const readyItems = items.filter((it) => it.status === 'done' && it.outputBlob);
    if (readyItems.length === 0) return;
    if (readyItems.length === 1) {
      downloadSingleItem(readyItems[0]);
      return;
    }

    setIsZipping(true);
    setBatchMessage('');
    try {
      const { zipSync } = await import('fflate');
      const archive: Record<string, [Uint8Array, { level: 0 }]> = {};
      const usedNames = new Map<string, number>();

      for (const item of readyItems) {
        if (!item.outputBlob) continue;
        const base = `${sanitizeBaseName(item.file.name)}-clean`;
        const ext = item.outputExt || 'webp';
        let candidate = `${base}.${ext}`;
        const count = usedNames.get(candidate) ?? 0;
        if (count > 0) {
          candidate = `${base}-${count + 1}.${ext}`;
        }
        usedNames.set(`${base}.${ext}`, count + 1);

        const bytes = new Uint8Array(await item.outputBlob.arrayBuffer());
        archive[candidate] = [bytes, { level: 0 }];
      }

      const zipped = zipSync(archive);
      const buffer = zipped.buffer.slice(
        zipped.byteOffset,
        zipped.byteOffset + zipped.byteLength,
      ) as ArrayBuffer;
      const zipBlob = new Blob([buffer], { type: 'application/zip' });
      const stamp = todayDotDate().replaceAll('.', '');
      triggerBlobDownload(zipBlob, `darkroom-clean-${stamp}.zip`);
    } catch {
      setBatchMessage('打包 ZIP 失败，请尝试逐张下载。');
    } finally {
      setIsZipping(false);
    }
  };

  const batchSummary = useMemo(() => {
    let origBytes = 0;
    let outBytes = 0;
    let doneCount = 0;
    let gpsCount = 0;
    let exifFileCount = 0;

    for (const item of items) {
      origBytes += item.file.size;
      if (item.exif.hasGps) gpsCount += 1;
      if (item.exif.hasGps || item.exif.tagCount > 0) exifFileCount += 1;
      if (item.status === 'done' && item.outputBlob) {
        outBytes += item.outputBlob.size;
        doneCount += 1;
      }
    }

    const savedBytes = origBytes - outBytes;
    const savedPct = origBytes > 0 && doneCount > 0 ? (savedBytes / origBytes) * 100 : 0;
    return {
      total: items.length,
      doneCount,
      origBytes,
      outBytes,
      savedBytes,
      savedPct,
      gpsCount,
      exifFileCount,
    };
  }, [items]);

  // ===================== MODE B: Bone-White Postmark Mat Framing =====================
  const [framePhoto, setFramePhoto] = useState<FramePhotoState | null>(null);
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameError, setFrameError] = useState('');
  const [handoffNotice, setHandoffNotice] = useState('');
  const [isDraggingFrame, setIsDraggingFrame] = useState(false);

  const [matTheme, setMatTheme] = useState<MatTheme>('bone');
  const [paddingMode, setPaddingMode] = useState<MatPadding>('standard');
  const [showPostmark, setShowPostmark] = useState(true);
  const [showExifStrip, setShowExifStrip] = useState(true);
  const [placeText, setPlaceText] = useState(SAMPLE_PHOTOS[0].place);
  const [captionText, setCaptionText] = useState(SAMPLE_PHOTOS[0].caption);
  const [cameraText, setCameraText] = useState(SAMPLE_PHOTOS[0].camera);
  const [specsText, setSpecsText] = useState(SAMPLE_PHOTOS[0].specs);
  const [dateText, setDateText] = useState(SAMPLE_PHOTOS[0].date);
  const [exportFormat, setExportFormat] = useState<'image/png' | 'image/jpeg'>('image/jpeg');
  const [isExportingFrame, setIsExportingFrame] = useState(false);

  const frameInputRef = useRef<HTMLInputElement | null>(null);
  const framePreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const framePhotoRef = useRef<FramePhotoState | null>(null);
  framePhotoRef.current = framePhoto;
  const frameLoadSeqRef = useRef<number>(0);
  const pendingHandoffRef = useRef<ToolkitMediaHandoff | null>(null);

  const loadSampleIntoFrame = useCallback(
    async (sampleIndex: number) => {
      const sample = SAMPLE_PHOTOS[sampleIndex] ?? SAMPLE_PHOTOS[0];
      const seq = ++frameLoadSeqRef.current;
      pendingHandoffRef.current = null;
      setFrameLoading(true);
      setFrameError('');
      setHandoffNotice('');
      try {
        const img = await loadImageElement(sample.url);
        if (frameLoadSeqRef.current !== seq) return;
        if (framePhotoRef.current?.isOwnedUrl) {
          releaseUrl(framePhotoRef.current.url);
        }
        setFramePhoto({
          name: sample.filename,
          url: sample.url,
          isOwnedUrl: false,
          isSample: true,
          img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          exif: { ...EMPTY_EXIF },
        });
        setPlaceText(sample.place);
        setCaptionText(sample.caption);
        setCameraText(sample.camera);
        setSpecsText(sample.specs);
        setDateText(sample.date);
      } catch {
        if (frameLoadSeqRef.current !== seq) return;
        setFrameError('加载示例样片失败，请拖入本地照片。');
      } finally {
        if (frameLoadSeqRef.current === seq) {
          setFrameLoading(false);
        }
      }
    },
    [releaseUrl],
  );

  const loadLocalFileIntoFrame = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|avif|gif)$/i.test(file.name)) {
        setFrameError('请选取 JPG、PNG 或 WebP 影像文件。');
        return;
      }
      const seq = ++frameLoadSeqRef.current;
      pendingHandoffRef.current = null;
      setFrameLoading(true);
      setFrameError('');
      setHandoffNotice('');
      const objUrl = registerUrl(URL.createObjectURL(file));
      try {
        const [img, exif] = await Promise.all([loadImageElement(objUrl), parseExifSafely(file)]);
        if (frameLoadSeqRef.current !== seq) {
          releaseUrl(objUrl);
          return;
        }
        if (framePhotoRef.current?.isOwnedUrl) {
          releaseUrl(framePhotoRef.current.url);
        }
        setFramePhoto({
          name: file.name,
          url: objUrl,
          isOwnedUrl: true,
          isSample: false,
          img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          exif,
        });

        const cam = composeCameraLabel(exif);
        const specs = composeSpecsLabel(exif);
        const exifDate = exif.takenAt ? formatDay(exif.takenAt) : '';
        setCameraText(cam || '未知机身（可手动填写）');
        setSpecsText(specs || `${img.naturalWidth}×${img.naturalHeight} px`);
        setDateText(exifDate || todayDotDate());
        if (exif.hasGps && exif.lat !== null && exif.lng !== null) {
          setPlaceText(formatCoordShort(exif.lat, exif.lng));
        } else {
          setPlaceText(sanitizeBaseName(file.name).slice(0, 20));
        }
        setCaptionText('');
      } catch (err) {
        releaseUrl(objUrl);
        if (frameLoadSeqRef.current !== seq) return;
        setFrameError(err instanceof Error ? err.message : '读取本地影像失败。');
      } finally {
        if (frameLoadSeqRef.current === seq) {
          setFrameLoading(false);
        }
      }
    },
    [registerUrl, releaseUrl],
  );

  // Consume cross-tool media handoffs (e.g. from PhotoGradeTool or VideoLutTool) on mount
  // or URL search updates (?handoff=1), resilient to React 19 StrictMode double-effects.
  useEffect(() => {
    const incoming = consumeToolkitHandoff('image');
    if (incoming) {
      pendingHandoffRef.current = incoming;
    }
    const handoff = pendingHandoffRef.current;
    if (!handoff) return;

    let cancelled = false;
    const seq = ++frameLoadSeqRef.current;
    setMode('frame');
    setFrameLoading(true);
    setFrameError('');
    setHandoffNotice(
      `已接收来自「${handoff.sourceLabel || '暗房工具'}」的成片，可直接微调装裱后导出。`,
    );

    const fileName = handoff.fileName?.trim() || 'darkroom-handoff.png';
    const handoffFile =
      handoff.blob instanceof File
        ? handoff.blob
        : new File([handoff.blob], fileName, { type: handoff.blob.type || 'image/png' });
    const objUrl = registerUrl(URL.createObjectURL(handoffFile));

    void Promise.all([loadImageElement(objUrl), parseExifSafely(handoffFile)])
      .then(([img, exif]) => {
        if (cancelled || frameLoadSeqRef.current !== seq) {
          releaseUrl(objUrl);
          return;
        }
        pendingHandoffRef.current = null;
        if (framePhotoRef.current?.isOwnedUrl && framePhotoRef.current.url !== objUrl) {
          releaseUrl(framePhotoRef.current.url);
        }
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        setFramePhoto({
          name: fileName,
          url: objUrl,
          isOwnedUrl: true,
          isSample: false,
          img,
          width,
          height,
          exif,
        });

        const cam = composeCameraLabel(exif);
        const specs = composeSpecsLabel(exif);
        const handoffExif = handoff.exifSummary?.trim() || '';
        if (cam) {
          setCameraText(cam);
          setSpecsText(specs || handoffExif || `${width}×${height} px`);
        } else if (handoffExif) {
          setCameraText(handoffExif);
          setSpecsText(`${width}×${height} px`);
        } else {
          setCameraText(handoff.sourceLabel?.trim() || '暗房成片');
          setSpecsText(`${width}×${height} px`);
        }

        const rawHandoffDate = handoff.takenAt?.trim() || '';
        const handoffDay =
          formatDay(rawHandoffDate) ||
          (/^\d{4}\.\d{2}\.\d{2}$/.test(rawHandoffDate) ? rawHandoffDate : '');
        const exifDay = exif.takenAt ? formatDay(exif.takenAt) : '';
        setDateText(handoffDay || exifDay || todayDotDate());

        if (handoff.place?.trim()) {
          setPlaceText(handoff.place.trim());
        } else if (exif.hasGps && exif.lat !== null && exif.lng !== null) {
          setPlaceText(formatCoordShort(exif.lat, exif.lng));
        } else {
          setPlaceText(sanitizeBaseName(fileName).slice(0, 20));
        }

        setCaptionText(handoff.caption?.trim() ?? '');
      })
      .catch((err) => {
        if (cancelled || frameLoadSeqRef.current !== seq) {
          releaseUrl(objUrl);
          return;
        }
        pendingHandoffRef.current = null;
        releaseUrl(objUrl);
        setFrameError(err instanceof Error ? err.message : '载入跨工具成片失败。');
      })
      .finally(() => {
        if (!cancelled && frameLoadSeqRef.current === seq) {
          setFrameLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (pendingHandoffRef.current === handoff) {
        releaseUrl(objUrl);
      }
    };
  }, [search, registerUrl, releaseUrl]);

  // Lazily initialize default sample photo when user switches into Mode B
  useEffect(() => {
    if (
      mode === 'frame' &&
      !framePhotoRef.current &&
      !frameLoading &&
      !pendingHandoffRef.current &&
      !peekToolkitHandoff('image')
    ) {
      void loadSampleIntoFrame(0);
    }
  }, [mode, frameLoading, loadSampleIntoFrame]);

  // Redraw live gallery mat preview whenever any framing parameter changes
  useEffect(() => {
    if (mode !== 'frame' || !framePhoto || !framePreviewCanvasRef.current) return;
    let cancelled = false;

    const draw = () => {
      if (cancelled || !framePreviewCanvasRef.current) return;
      renderGalleryFrameCanvas(framePreviewCanvasRef.current, {
        img: framePhoto.img,
        matTheme,
        paddingMode,
        showPostmark,
        showExifStrip,
        place: placeText,
        caption: captionText,
        cameraText,
        specsText,
        dateText,
        maxPhotoEdge: 1400,
      });
    };

    draw();
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(draw);
    }

    return () => {
      cancelled = true;
    };
  }, [
    mode,
    framePhoto,
    matTheme,
    paddingMode,
    showPostmark,
    showExifStrip,
    placeText,
    captionText,
    cameraText,
    specsText,
    dateText,
  ]);

  const handleFrameInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void loadLocalFileIntoFrame(file);
  };

  const handleFrameDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingFrame(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadLocalFileIntoFrame(file);
  };

  const handleExportFrame = async () => {
    if (!framePhoto) return;
    setIsExportingFrame(true);
    setFrameError('');
    try {
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        await document.fonts.ready;
      }
      const offscreen = document.createElement('canvas');
      renderGalleryFrameCanvas(offscreen, {
        img: framePhoto.img,
        matTheme,
        paddingMode,
        showPostmark,
        showExifStrip,
        place: placeText,
        caption: captionText,
        cameraText,
        specsText,
        dateText,
        maxPhotoEdge: 3600,
      });

      const blob = await new Promise<Blob>((resolve, reject) => {
        offscreen.toBlob(
          (res) => (res ? resolve(res) : reject(new Error('导出冲印件失败，请尝试切换格式。'))),
          exportFormat,
          exportFormat === 'image/jpeg' ? 0.94 : undefined,
        );
      });

      const ext = exportFormat === 'image/png' ? 'png' : 'jpg';
      const base = sanitizeBaseName(framePhoto.name);
      triggerBlobDownload(blob, `${base}-mounted.${ext}`);
    } catch (err) {
      setFrameError(err instanceof Error ? err.message : '导出冲印件失败。');
    } finally {
      setIsExportingFrame(false);
    }
  };

  return (
    <div className="min-w-0 space-y-5 rounded-[24px] border border-hairline bg-surface p-4 sm:p-6">
      {/* Mode Switch & Explicit Privacy Strip */}
      <div className="flex flex-col gap-3 border-b border-hairline pb-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Sub-mode Segmented Pill */}
        <div
          role="tablist"
          aria-label="影像暗房模式"
          className="inline-flex w-full shrink-0 rounded-full border border-hairline bg-paper p-1 sm:w-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'compress'}
            onClick={() => setMode('compress')}
            className={[
              'flex flex-1 items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors sm:flex-initial',
              mode === 'compress'
                ? 'bg-cta-bg text-cta-text'
                : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>批量压缩与抹除隐私</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'frame'}
            onClick={() => setMode('frame')}
            className={[
              'flex flex-1 items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors sm:flex-initial',
              mode === 'frame'
                ? 'bg-cta-bg text-cta-text'
                : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            <Frame className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>骨白邮戳装裱台</span>
          </button>
        </div>

        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 py-1 text-[12px] text-postmark">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>纯本地处理 · 影像永不离开设备</span>
        </span>
      </div>

      {/* ===================== MODE A VIEW ===================== */}
      {mode === 'compress' && (
        <div className="space-y-5">
          {/* Controls Strip */}
          <div className="grid grid-cols-1 gap-4 rounded-[20px] border border-hairline bg-paper p-4 sm:p-5 lg:grid-cols-3">
            {/* Max Edge */}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-muted">
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                <span>最大长边尺寸（绝不放大原图）</span>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {EDGE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={maxEdge === opt.value}
                    onClick={() => setMaxEdge(opt.value)}
                    className={[
                      'tabular-nums-mono rounded-full border px-3 py-1 text-[12px] transition-colors',
                      maxEdge === opt.value
                        ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                        : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                    ].join(' ')}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Output Format */}
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-ink-muted">输出编码格式</div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {FORMAT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={format === opt.value}
                    onClick={() => setFormat(opt.value)}
                    className={[
                      'tabular-nums-mono rounded-full border px-3.5 py-1 text-[12px] transition-colors',
                      format === opt.value
                        ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                        : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                    ].join(' ')}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 mb-0 text-[11.5px] text-ink-muted">
                经 Canvas 像素重编码后，所有 GPS、相机型号与拍摄时间 EXIF 均被彻底剥离。
              </p>
            </div>

            {/* Quality Slider */}
            <div className="min-w-0">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-medium text-ink-muted">导出画质</span>
                <span className="tabular-nums-mono font-medium text-ink">
                  {format === 'image/png' ? 'PNG 无损' : `${Math.round(quality * 100)}%`}
                </span>
              </div>
              <input
                type="range"
                aria-label="导出画质"
                min={50}
                max={98}
                step={2}
                disabled={format === 'image/png'}
                value={Math.round(quality * 100)}
                onChange={(e) => setQuality(Number(e.target.value) / 100)}
                className="mt-3 w-full cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
              />
              <div className="tabular-nums-mono mt-1 flex justify-between text-[11px] text-ink-muted">
                <span>50% 极致轻量</span>
                <span>86% 暗房推荐</span>
                <span>98% 高保真</span>
              </div>
            </div>
          </div>

          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingBatch(true);
            }}
            onDragLeave={() => setIsDraggingBatch(false)}
            onDrop={handleBatchDrop}
            className={[
              'rounded-[20px] border border-dashed p-6 text-center transition-colors sm:p-8',
              isDraggingBatch
                ? 'border-accent bg-surface-hover'
                : 'border-hairline-strong bg-paper/75 hover:bg-paper',
            ].join(' ')}
          >
            <input
              ref={batchInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleBatchInputChange}
              className="sr-only"
            />
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-paper text-ink-muted">
              <Upload className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="mt-3 mb-0 text-[15px] font-medium text-ink">
              拖入多张照片至此，或点击选取本地影像
            </p>
            <p className="mt-1 mb-0 text-[12.5px] text-ink-muted">
              支持 JPG / PNG / WebP 批量处理，自动扫描并警示隐藏的 GPS 位置与设备信息
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => batchInputRef.current?.click()}
                className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]"
              >
                <ImageIcon className="h-4 w-4" aria-hidden="true" />
                <span>选取多张照片</span>
              </button>
              <button
                type="button"
                onClick={() => void handleLoadBatchSamples()}
                className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
              >
                <span>加载示例旅图体验</span>
              </button>
            </div>
          </div>

          {batchMessage && (
            <div
              role="status"
              className="rounded-[14px] border border-hairline bg-paper px-4 py-3 text-[13px] text-postmark"
            >
              {batchMessage}
            </div>
          )}

          {/* Batch Summary & List */}
          {items.length > 0 && (
            <div className="space-y-4">
              {/* Metrics Summary Strip */}
              <div className="flex flex-col gap-4 rounded-[20px] border border-hairline bg-paper p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:items-center sm:gap-6">
                  <div>
                    <div className="text-[11.5px] text-ink-muted">处理队列</div>
                    <div className="tabular-nums-mono mt-0.5 text-[15px] font-medium text-ink">
                      {batchSummary.doneCount} / {batchSummary.total} 张
                    </div>
                  </div>
                  <div>
                    <div className="text-[11.5px] text-ink-muted">体积变化</div>
                    <div className="tabular-nums-mono mt-0.5 text-[15px] font-medium text-ink">
                      {formatBytes(batchSummary.origBytes)} → {formatBytes(batchSummary.outBytes)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11.5px] text-ink-muted">空间节省</div>
                    <div
                      className={[
                        'tabular-nums-mono mt-0.5 text-[15px] font-medium',
                        batchSummary.savedBytes >= 0 ? 'text-accent' : 'text-postmark',
                      ].join(' ')}
                    >
                      {batchSummary.doneCount > 0
                        ? `${batchSummary.savedBytes >= 0 ? '-' : '+'}${Math.abs(batchSummary.savedPct).toFixed(1)}%`
                        : '计算中'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11.5px] text-ink-muted">隐私抹除</div>
                    <div className="tabular-nums-mono mt-0.5 text-[15px] font-medium text-postmark">
                      {batchSummary.gpsCount > 0
                        ? `清零 ${batchSummary.gpsCount} 处 GPS`
                        : batchSummary.exifFileCount > 0
                          ? `清零 ${batchSummary.exifFileCount} 份 EXIF`
                          : '全部洁净'}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={batchSummary.doneCount === 0 || isZipping}
                    onClick={() => void downloadAllAsZip()}
                    className="pill-cta-primary min-h-[40px] px-4 text-[13px] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {items.length > 1 ? (
                      <Archive className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    <span>
                      {isZipping
                        ? '正在打包 ZIP...'
                        : items.length > 1
                          ? `打包下载 ZIP (${batchSummary.doneCount})`
                          : '下载洁净影像'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={clearBatchItems}
                    className="pill-cta-secondary min-h-[40px] px-3.5 text-[13px]"
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>清空</span>
                  </button>
                </div>
              </div>

              {/* Per-Image Results */}
              <div className="space-y-3">
                {items.map((item) => {
                  const outSize = item.outputBlob?.size ?? 0;
                  const diffPct =
                    item.status === 'done' && item.file.size > 0
                      ? ((item.file.size - outSize) / item.file.size) * 100
                      : 0;
                  const camSummary = composeCameraLabel(item.exif);

                  return (
                    <article
                      key={item.id}
                      className="flex flex-col gap-3 rounded-[18px] border border-hairline bg-paper p-3.5 sm:flex-row sm:items-center sm:justify-between sm:p-4"
                    >
                      <div className="flex min-w-0 items-start gap-3.5">
                        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-[12px] border border-hairline bg-paper">
                          <img
                            src={item.outputUrl || item.previewUrl}
                            alt={item.file.name}
                            className="h-full w-full object-cover"
                          />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="max-w-full truncate text-[14px] font-medium text-ink">
                              {item.file.name}
                            </span>
                            {item.outputExt && (
                              <span className="tabular-nums-mono rounded-full border border-hairline bg-paper px-2 py-0.5 text-[11px] text-ink-muted">
                                .{item.outputExt}
                              </span>
                            )}
                          </div>

                          <div className="tabular-nums-mono mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
                            {item.origWidth > 0 && item.outputWidth ? (
                              <span>
                                {item.origWidth}×{item.origHeight} → {item.outputWidth}×
                                {item.outputHeight}
                              </span>
                            ) : null}
                            <span>
                              {formatBytes(item.file.size)}
                              {item.status === 'done' ? ` → ${formatBytes(outSize)}` : ' · 处理中'}
                            </span>
                            {item.status === 'done' && (
                              <span
                                className={
                                  diffPct >= 0 ? 'font-medium text-accent' : 'font-medium text-postmark'
                                }
                              >
                                {diffPct >= 0
                                  ? `节省 ${diffPct.toFixed(1)}%`
                                  : `增加 ${Math.abs(diffPct).toFixed(1)}%`}
                              </span>
                            )}
                          </div>

                          {/* Privacy EXIF Status Line */}
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                            {item.status === 'error' ? (
                              <span className="inline-flex items-center gap-1 text-postmark">
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span>{item.errorMsg || '处理失败'}</span>
                              </span>
                            ) : item.exif.hasGps && item.exif.lat !== null && item.exif.lng !== null ? (
                              <span className="inline-flex items-center gap-1 text-postmark">
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span className="tabular-nums-mono">
                                  原图含 GPS ({formatCoordShort(item.exif.lat, item.exif.lng)}) · 已彻底抹除
                                </span>
                              </span>
                            ) : item.exif.tagCount > 0 ? (
                              <span className="inline-flex items-center gap-1 text-ink-muted">
                                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                                <span>
                                  原图含设备 EXIF{camSummary ? `（${camSummary}）` : ''} · 导出后已清零
                                </span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-ink-muted">
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                                <span>未检出 GPS / 设备元数据 · 重编码后保持洁净</span>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={item.status !== 'done'}
                          onClick={() => downloadSingleItem(item)}
                          className="pill-cta-secondary min-h-[36px] px-3.5 text-[12.5px] disabled:opacity-40"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>下载</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`移除 ${item.file.name}`}
                          onClick={() => removeBatchItem(item.id)}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-paper text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===================== MODE B VIEW: Postmark Gallery Framing ===================== */}
      {mode === 'frame' && (
        <div className="space-y-4">
          {handoffNotice && (
            <div
              role="status"
              className="flex items-center justify-between gap-3 rounded-[16px] border border-hairline bg-paper px-4 py-2.5 text-[13px] text-ink"
            >
              <div className="flex min-w-0 items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="min-w-0 break-words">{handoffNotice}</span>
              </div>
              <button
                type="button"
                aria-label="关闭接收提示"
                onClick={() => setHandoffNotice('')}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)]">
          {/* Left: High-Res Live Canvas Stage */}
          <div className="min-w-0 space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingFrame(true);
              }}
              onDragLeave={() => setIsDraggingFrame(false)}
              onDrop={handleFrameDrop}
              className={[
                'flex min-h-[340px] flex-col items-center justify-center rounded-[22px] border p-4 transition-colors sm:p-6',
                isDraggingFrame
                  ? 'border-dashed border-accent bg-surface-hover'
                  : 'border-hairline bg-page/75',
              ].join(' ')}
            >
              {frameLoading ? (
                <div className="py-16 text-[13.5px] text-ink-muted">正在读取影像与 EXIF 信息...</div>
              ) : framePhoto ? (
                <canvas
                  ref={framePreviewCanvasRef}
                  aria-label="骨白邮戳装裱实时预览画布"
                  className="block h-auto max-h-[66vh] w-auto max-w-full rounded-[10px] border border-hairline shadow-sm"
                />
              ) : (
                <div className="py-16 text-center text-[13.5px] text-ink-muted">
                  拖入一张照片开始暗房装裱
                </div>
              )}
            </div>

            {/* Bottom Stage Utility Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-hairline bg-paper px-4 py-2.5 text-[12px] text-ink-muted">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums-mono">
                  {framePhoto
                    ? `${framePhoto.width} × ${framePhoto.height} px`
                    : '未载入影像'}
                </span>
                {framePhoto?.isSample && (
                  <span className="rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11px] text-ink-muted">
                    示例样片 · 可直接拖入你的照片替换
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {SAMPLE_PHOTOS.map((s, idx) => (
                  <button
                    key={s.url}
                    type="button"
                    onClick={() => void loadSampleIntoFrame(idx)}
                    className="rounded-full border border-hairline bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                  >
                    示例：{s.label}
                  </button>
                ))}
              </div>
            </div>

            {frameError && (
              <div
                role="alert"
                className="rounded-[14px] border border-hairline bg-paper px-4 py-3 text-[13px] text-postmark"
              >
                {frameError}
              </div>
            )}
          </div>

          {/* Right: Framing Parameters & Export Panel */}
          <div className="min-w-0 space-y-4 rounded-[22px] border border-hairline bg-paper p-4 sm:p-5">
            <input
              ref={frameInputRef}
              type="file"
              accept="image/*"
              onChange={handleFrameInputChange}
              className="sr-only"
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
                <Camera className="h-4 w-4 text-postmark" aria-hidden="true" />
                <span>冲印与装裱参数</span>
              </div>
              <button
                type="button"
                onClick={() => frameInputRef.current?.click()}
                className="pill-cta-secondary min-h-[34px] px-3.5 text-[12.5px]"
              >
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                <span>更换本地照片</span>
              </button>
            </div>

            {/* Mat Color & Padding */}
            <div className="space-y-3">
              <div>
                <div className="text-[12px] text-ink-muted">卡纸底色</div>
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    aria-pressed={matTheme === 'bone'}
                    onClick={() => setMatTheme('bone')}
                    className={[
                      'flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[12px] transition-colors',
                      matTheme === 'bone'
                        ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                        : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                    ].join(' ')}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/20"
                      style={{ backgroundColor: '#FAF8F4' }}
                      aria-hidden="true"
                    />
                    <span>骨白纸</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={matTheme === 'charcoal'}
                    onClick={() => setMatTheme('charcoal')}
                    className={[
                      'flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[12px] transition-colors',
                      matTheme === 'charcoal'
                        ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                        : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                    ].join(' ')}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/25"
                      style={{ backgroundColor: '#1E2023' }}
                      aria-hidden="true"
                    />
                    <span>炭黑暗房</span>
                  </button>
                </div>
              </div>

              <div>
                <div className="text-[12px] text-ink-muted">留白比例</div>
                <div className="mt-1.5 flex gap-2">
                  {PADDING_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={paddingMode === opt.value}
                      onClick={() => setPaddingMode(opt.value)}
                      className={[
                        'flex-1 shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                        paddingMode === opt.value
                          ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                          : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                      ].join(' ')}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Stamp & EXIF Toggles */}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={showPostmark}
                onClick={() => setShowPostmark((v) => !v)}
                className={[
                  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors',
                  showPostmark
                    ? 'border-postmark/40 bg-surface font-medium text-postmark'
                    : 'border-hairline bg-surface text-ink-muted',
                ].join(' ')}
              >
                <Stamp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>圆形日期邮戳：{showPostmark ? '开启' : '关闭'}</span>
              </button>
              <button
                type="button"
                aria-pressed={showExifStrip}
                onClick={() => setShowExifStrip((v) => !v)}
                className={[
                  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors',
                  showExifStrip
                    ? 'border-accent/40 bg-surface font-medium text-accent'
                    : 'border-hairline bg-surface text-ink-muted',
                ].join(' ')}
              >
                <span>底部 EXIF 条：{showExifStrip ? '开启' : '关闭'}</span>
              </button>
            </div>

            {/* Text Fields */}
            <div className="space-y-3 border-t border-hairline pt-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
                <label className="block min-w-0">
                  <span className="text-[12px] text-ink-muted">拍摄地名</span>
                  <input
                    type="text"
                    value={placeText}
                    onChange={(e) => setPlaceText(e.target.value)}
                    placeholder="例：川西 · 折多山垭口"
                    className="mt-1 w-full rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-muted/60"
                  />
                </label>

                <label className="block min-w-0">
                  <span className="text-[12px] text-ink-muted">邮戳日期</span>
                  <input
                    type="text"
                    value={dateText}
                    onChange={(e) => setDateText(e.target.value)}
                    placeholder="2026.11.24"
                    className="tabular-nums-mono mt-1 w-full rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[13px] text-ink"
                  />
                </label>
              </div>

              <label className="block min-w-0">
                <span className="text-[12px] text-ink-muted">手记题跋（1–2 行思源宋体）</span>
                <textarea
                  rows={2}
                  value={captionText}
                  onChange={(e) => setCaptionText(e.target.value)}
                  placeholder="记下按下快门那一刻的光线、风声或心情..."
                  className="font-editorial-serif mt-1 w-full resize-none rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-muted/60"
                />
              </label>

              {showExifStrip && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block min-w-0">
                    <span className="text-[12px] text-ink-muted">机身与镜头</span>
                    <input
                      type="text"
                      value={cameraText}
                      onChange={(e) => setCameraText(e.target.value)}
                      placeholder="自动读取 EXIF 或手动输入"
                      className="tabular-nums-mono mt-1 w-full rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[12px] text-ink"
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="text-[12px] text-ink-muted">光学曝光参数</span>
                    <input
                      type="text"
                      value={specsText}
                      onChange={(e) => setSpecsText(e.target.value)}
                      placeholder="35mm · f/2.8 · 1/500s · ISO 100"
                      className="tabular-nums-mono mt-1 w-full rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[12px] text-ink"
                    />
                  </label>
                </div>
              )}
            </div>

            {/* Export Controls */}
            <div className="space-y-2.5 border-t border-hairline pt-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-ink-muted">冲印导出格式</span>
                <div className="inline-flex rounded-full border border-hairline bg-surface p-0.5">
                  <button
                    type="button"
                    aria-pressed={exportFormat === 'image/jpeg'}
                    onClick={() => setExportFormat('image/jpeg')}
                    className={[
                      'tabular-nums-mono rounded-full px-3 py-1 text-[11.5px] transition-colors',
                      exportFormat === 'image/jpeg'
                        ? 'bg-cta-bg font-medium text-cta-text'
                        : 'text-ink-muted hover:text-ink',
                    ].join(' ')}
                  >
                    JPEG 94%
                  </button>
                  <button
                    type="button"
                    aria-pressed={exportFormat === 'image/png'}
                    onClick={() => setExportFormat('image/png')}
                    className={[
                      'tabular-nums-mono rounded-full px-3 py-1 text-[11.5px] transition-colors',
                      exportFormat === 'image/png'
                        ? 'bg-cta-bg font-medium text-cta-text'
                        : 'text-ink-muted hover:text-ink',
                    ].join(' ')}
                  >
                    PNG 无损
                  </button>
                </div>
              </div>

              <button
                type="button"
                disabled={!framePhoto || isExportingFrame}
                onClick={() => void handleExportFrame()}
                className="pill-cta-primary w-full min-h-[42px] text-[14px] disabled:opacity-45"
              >
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{isExportingFrame ? '正在高分辨率冲印...' : '导出全分辨率装裱冲印件'}</span>
              </button>
            </div>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
