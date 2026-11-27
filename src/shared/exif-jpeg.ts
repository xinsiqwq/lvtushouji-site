import { exifTakenAt } from './dates';
import type { ExifSummary } from './types';

export type ExtractedJpegExif = {
  exif?: ExifSummary;
  takenAt?: string | null;
  lat?: number | null;
  lng?: number | null;
};

type TiffReader = {
  base: number;
  end: number;
  littleEndian: boolean;
  u16(offset: number): number | null;
  u32(offset: number): number | null;
  ascii(valueOffset: number, count: number): string | null;
  rational(valueOffset: number): number | null;
};

function createTiffReader(bytes: Uint8Array, base: number, littleEndian: boolean): TiffReader {
  const end = bytes.byteLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const inRange = (offset: number, length: number): boolean =>
    offset >= base && offset + length <= end;

  const u16 = (offset: number): number | null =>
    inRange(offset, 2) ? view.getUint16(offset, littleEndian) : null;

  const u32 = (offset: number): number | null =>
    inRange(offset, 4) ? view.getUint32(offset, littleEndian) : null;

  const ascii = (valueOffset: number, count: number): string | null => {
    if (count <= 0 || !inRange(valueOffset, count)) return null;
    let text = '';
    for (let i = 0; i < count; i += 1) {
      const ch = bytes[valueOffset + i] ?? 0;
      if (ch === 0) break;
      text += String.fromCharCode(ch);
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const rational = (valueOffset: number): number | null => {
    const num = u32(valueOffset);
    const den = u32(valueOffset + 4);
    if (num === null || den === null || den === 0) return null;
    const val = num / den;
    return Number.isFinite(val) ? val : null;
  };

  return { base, end, littleEndian, u16, u32, ascii, rational };
}

function readIfdEntries(
  reader: TiffReader,
  ifdOffset: number,
  onEntry: (tag: number, type: number, count: number, valueOffset: number) => void,
): void {
  const ifdPos = reader.base + ifdOffset;
  const count = reader.u16(ifdPos);
  if (count === null || count <= 0 || count > 256) return;

  for (let i = 0; i < count; i += 1) {
    const entryPos = ifdPos + 2 + i * 12;
    const tag = reader.u16(entryPos);
    const type = reader.u16(entryPos + 2);
    const valCount = reader.u32(entryPos + 4);
    if (tag === null || type === null || valCount === null) break;

    const unitSize = type === 1 || type === 2 || type === 7 ? 1 : type === 3 ? 2 : type === 4 || type === 9 ? 4 : type === 5 || type === 10 ? 8 : 0;
    if (unitSize === 0) continue;

    const totalSize = unitSize * valCount;
    let valueOffset = entryPos + 8;
    if (totalSize > 4) {
      const ptr = reader.u32(entryPos + 8);
      if (ptr === null) continue;
      valueOffset = reader.base + ptr;
    }

    onEntry(tag, type, valCount, valueOffset);
  }
}

function formatShutter(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds < 1) {
    const denom = Math.round(1 / seconds);
    if (denom >= 2) return `1/${denom}s`;
  }
  return `${Number(seconds.toFixed(2))}s`;
}

function readDmsCoord(reader: TiffReader, valueOffset: number, count: number): number | null {
  if (count < 3) return null;
  const deg = reader.rational(valueOffset);
  const min = reader.rational(valueOffset + 8);
  const sec = reader.rational(valueOffset + 16);
  if (deg === null || min === null || sec === null) return null;
  const decimal = deg + min / 60 + sec / 3600;
  return Number.isFinite(decimal) ? decimal : null;
}

/** Parse standard JPEG APP1 EXIF metadata (camera, shutter, focal length, takenAt, GPS). */
export function extractJpegExif(bytes: Uint8Array): ExtractedJpegExif {
  if (bytes.byteLength < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return {};
  }

  let offset = 2;
  let tiffBase = -1;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset]!;
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) continue;
    if (offset + 2 > bytes.byteLength) break;

    const segLen = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segLen < 2 || offset + segLen > bytes.byteLength) break;

    if (
      marker === 0xe1 &&
      segLen >= 16 &&
      bytes[offset + 2] === 0x45 && // E
      bytes[offset + 3] === 0x78 && // x
      bytes[offset + 4] === 0x69 && // i
      bytes[offset + 5] === 0x66 && // f
      bytes[offset + 6] === 0x00 &&
      bytes[offset + 7] === 0x00
    ) {
      tiffBase = offset + 8;
      break;
    }

    offset += segLen;
  }

  if (tiffBase < 0 || tiffBase + 8 > bytes.byteLength) {
    return {};
  }

  const endian0 = bytes[tiffBase];
  const endian1 = bytes[tiffBase + 1];
  let littleEndian: boolean;
  if (endian0 === 0x49 && endian1 === 0x49) {
    littleEndian = true;
  } else if (endian0 === 0x4d && endian1 === 0x4d) {
    littleEndian = false;
  } else {
    return {};
  }

  const reader = createTiffReader(bytes, tiffBase, littleEndian);
  if (reader.u16(tiffBase + 2) !== 42) return {};
  const ifd0Offset = reader.u32(tiffBase + 4);
  if (ifd0Offset === null) return {};

  const exifSummary: ExifSummary = {};
  let exifIfdOffset: number | null = null;
  let gpsIfdOffset: number | null = null;

  readIfdEntries(reader, ifd0Offset, (tag, _type, count, valOff) => {
    if (tag === 0x010f) {
      const make = reader.ascii(valOff, count);
      if (make) exifSummary.make = make;
    } else if (tag === 0x0110) {
      const model = reader.ascii(valOff, count);
      if (model) exifSummary.model = model;
    } else if (tag === 0x8769) {
      exifIfdOffset = reader.u32(valOff);
    } else if (tag === 0x8825) {
      gpsIfdOffset = reader.u32(valOff);
    }
  });

  let rawDateTimeOriginal: string | null = null;
  let rawOffsetTimeOriginal: string | null = null;

  if (exifIfdOffset !== null && exifIfdOffset > 0) {
    readIfdEntries(reader, exifIfdOffset, (tag, type, count, valOff) => {
      if (tag === 0x829a) {
        const exp = reader.rational(valOff);
        if (exp !== null) {
          const formatted = formatShutter(exp);
          if (formatted) exifSummary.shutter = formatted;
        }
      } else if (tag === 0x829d) {
        const fnum = reader.rational(valOff);
        if (fnum !== null && fnum > 0) {
          exifSummary.aperture = `f/${Number(fnum.toFixed(1))}`;
        }
      } else if (tag === 0x8827) {
        const iso = type === 4 ? reader.u32(valOff) : reader.u16(valOff);
        if (iso !== null && iso > 0 && iso <= 1_000_000) {
          exifSummary.iso = iso;
        }
      } else if (tag === 0x9003) {
        rawDateTimeOriginal = reader.ascii(valOff, count);
      } else if (tag === 0x9011) {
        rawOffsetTimeOriginal = reader.ascii(valOff, count);
      } else if (tag === 0x920a) {
        const focal = reader.rational(valOff);
        if (focal !== null && focal > 0) {
          exifSummary.focalLength = `${Number(focal.toFixed(1))}mm`;
        }
      } else if (tag === 0xa434) {
        const lens = reader.ascii(valOff, count);
        if (lens) exifSummary.lens = lens;
      }
    });
  }

  const gps: {
    latAbs: number | null;
    latRef: string | null;
    lngAbs: number | null;
    lngRef: string | null;
  } = { latAbs: null, latRef: null, lngAbs: null, lngRef: null };

  if (gpsIfdOffset !== null && gpsIfdOffset > 0) {
    readIfdEntries(reader, gpsIfdOffset, (tag, _type, count, valOff) => {
      if (tag === 0x0001) {
        gps.latRef = reader.ascii(valOff, count);
      } else if (tag === 0x0002) {
        gps.latAbs = readDmsCoord(reader, valOff, count);
      } else if (tag === 0x0003) {
        gps.lngRef = reader.ascii(valOff, count);
      } else if (tag === 0x0004) {
        gps.lngAbs = readDmsCoord(reader, valOff, count);
      }
    });
  }

  let lat: number | null = null;
  let lng: number | null = null;
  if (gps.latAbs !== null && gps.lngAbs !== null) {
    const signedLat = gps.latRef?.toUpperCase().startsWith('S')
      ? -Math.abs(gps.latAbs)
      : Math.abs(gps.latAbs);
    const signedLng = gps.lngRef?.toUpperCase().startsWith('W')
      ? -Math.abs(gps.lngAbs)
      : Math.abs(gps.lngAbs);
    if (Math.abs(signedLat) <= 90 && Math.abs(signedLng) <= 180) {
      lat = Number(signedLat.toFixed(6));
      lng = Number(signedLng.toFixed(6));
    }
  }

  const takenAt = rawDateTimeOriginal ? exifTakenAt(rawDateTimeOriginal, rawOffsetTimeOriginal) : null;
  const hasExifFields = Object.keys(exifSummary).length > 0;

  return {
    ...(hasExifFields ? { exif: exifSummary } : {}),
    ...(takenAt ? { takenAt } : {}),
    ...(lat !== null && lng !== null ? { lat, lng } : {}),
  };
}
