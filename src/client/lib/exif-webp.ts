import { exifTakenAt } from '../../shared/dates';
import type { ExifSummary } from '../../shared/types';

export type ProcessedAtlasImage = {
  file: File;
  thumbnail: Blob;
  preview: Blob;
  width: number;
  height: number;
  takenAt: string | null;
  lat: number | null;
  lng: number | null;
  confirmed: boolean;
  exif?: ExifSummary;
};

function formatShutter(exposureTime: unknown): string | undefined {
  if (typeof exposureTime !== 'number' || !Number.isFinite(exposureTime) || exposureTime <= 0) {
    return undefined;
  }
  if (exposureTime >= 1) return `${Number(exposureTime.toFixed(1))}s`;
  const denom = Math.round(1 / exposureTime);
  return denom > 0 ? `1/${denom}s` : undefined;
}

function parseIsoWithOptionalOffset(raw: unknown, offsetRaw: unknown): string | null {
  if (typeof raw === 'string') {
    const exifFormatted = exifTakenAt(raw, offsetRaw);
    if (exifFormatted) return exifFormatted;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw) && Number.isFinite(Date.parse(raw))) {
      return raw;
    }
    return null;
  }
  if (raw instanceof Date && Number.isFinite(raw.getTime())) {
    return raw.toISOString();
  }
  return null;
}

async function encodeScaledWebp(
  bitmap: ImageBitmap,
  orientation: number,
  maxEdge: number,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const needsSwap = orientation === 6 || orientation === 8 || orientation === 5 || orientation === 7;
  // Detect whether createImageBitmap already applied EXIF orientation to dimensions.
  // If browser didn't apply it (or ignored orientation), rotate explicitly onto canvas.
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  const naturalLongest = Math.max(srcW, srcH);
  const scale = naturalLongest > 0 ? Math.min(1, maxEdge / naturalLongest) : 1;

  const targetW = Math.max(1, Math.round(srcW * scale));
  const targetH = Math.max(1, Math.round(srcH * scale));

  const outW = needsSwap && srcW > srcH ? targetH : targetW;
  const outH = needsSwap && srcW > srcH ? targetW : targetH;
  const shouldManualRotate = needsSwap && srcW > srcH;

  const drawToCanvas = async (canvas: HTMLCanvasElement | OffscreenCanvas, ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
    ctx.save();
    if (shouldManualRotate) {
      if (orientation === 6) {
        ctx.translate(outW, 0);
        ctx.rotate(Math.PI / 2);
      } else if (orientation === 8) {
        ctx.translate(0, outH);
        ctx.rotate(-Math.PI / 2);
      }
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    } else {
      ctx.drawImage(bitmap, 0, 0, outW, outH);
    }
    ctx.restore();
  };

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      await drawToCanvas(canvas, ctx);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
      if (blob.type === 'image/webp') {
        return { blob, width: outW, height: outH };
      }
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D 编码');
  await drawToCanvas(canvas, ctx);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('WebP 编码失败'))),
      'image/webp',
      quality,
    );
  });
  return { blob, width: outW, height: outH };
}

/** Lazy-loads exifr, extracts authentic EXIF/GPS (without fabricating missing coords), handles orientation 6/8, and encodes 600px/1600px WebP variants without upscaling. */
export async function processAtlasImage(file: File): Promise<ProcessedAtlasImage> {
  const exifrMod = await import('exifr');
  const parseExif = exifrMod.parse ?? exifrMod.default?.parse;

  let tags: Record<string, unknown> | null = null;
  try {
    tags =
      (await parseExif(file, {
        reviveValues: false,
        translateKeys: true,
        translateValues: false,
        gps: true,
        tiff: true,
        exif: true,
      })) ?? null;
  } catch {
    tags = null;
  }

  let lat: number | null = null;
  let lng: number | null = null;
  if (tags) {
    let parsedLat = typeof tags.latitude === 'number' ? tags.latitude : NaN;
    let parsedLng = typeof tags.longitude === 'number' ? tags.longitude : NaN;

    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      try {
        const gpsFn = exifrMod.gps ?? exifrMod.default?.gps;
        if (typeof gpsFn === 'function') {
          const gps = await gpsFn(file);
          if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
            parsedLat = gps.latitude;
            parsedLng = gps.longitude;
          }
        }
      } catch {
        /* Ignore GPS fallback failure. */
      }
    }

    if (
      Number.isFinite(parsedLat) &&
      Number.isFinite(parsedLng) &&
      Math.abs(parsedLat) <= 90 &&
      Math.abs(parsedLng) <= 180
    ) {
      lat = Number(parsedLat.toFixed(6));
      lng = Number(parsedLng.toFixed(6));
    }
  }

  const rawDate = tags?.DateTimeOriginal ?? tags?.CreateDate ?? tags?.ModifyDate;
  const rawOffset =
    tags?.OffsetTimeOriginal ?? tags?.OffsetTimeDigitized ?? tags?.OffsetTime ?? undefined;
  const takenAt = parseIsoWithOptionalOffset(rawDate, rawOffset);

  const orientation =
    typeof tags?.Orientation === 'number' && Number.isInteger(tags.Orientation)
      ? tags.Orientation
      : 1;

  const exif: ExifSummary = {};
  if (tags) {
    if (typeof tags.Make === 'string' && tags.Make.trim()) exif.make = tags.Make.trim();
    if (typeof tags.Model === 'string' && tags.Model.trim()) exif.model = tags.Model.trim();
    if (typeof tags.LensModel === 'string' && tags.LensModel.trim()) exif.lens = tags.LensModel.trim();
    if (typeof tags.FocalLength === 'number' && Number.isFinite(tags.FocalLength) && tags.FocalLength > 0) {
      exif.focalLength = `${Math.round(tags.FocalLength)}mm`;
    }
    if (typeof tags.FNumber === 'number' && Number.isFinite(tags.FNumber) && tags.FNumber > 0) {
      exif.aperture = `f/${Number(tags.FNumber.toFixed(1))}`;
    }
    const shutter = formatShutter(tags.ExposureTime);
    if (shutter) exif.shutter = shutter;
    const isoVal = tags.ISO ?? tags.ISOSpeedRatings;
    if (typeof isoVal === 'number' && Number.isFinite(isoVal) && isoVal > 0) {
      exif.iso = Math.round(isoVal);
    }
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  try {
    const thumb = await encodeScaledWebp(bitmap, orientation, 600, 0.82);
    const preview = await encodeScaledWebp(bitmap, orientation, 1600, 0.86);

    return {
      file,
      thumbnail: thumb.blob,
      preview: preview.blob,
      width: preview.width,
      height: preview.height,
      takenAt,
      lat,
      lng,
      confirmed: lat !== null && lng !== null,
      ...(Object.keys(exif).length > 0 ? { exif } : {}),
    };
  } finally {
    bitmap.close();
  }
}
