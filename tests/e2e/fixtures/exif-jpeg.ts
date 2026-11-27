import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

export interface SyntheticExifJpegOptions {
  width?: number;
  height?: number;
  lat?: number | null;
  lng?: number | null;
  omitGps?: boolean;
  takenAt?: string | null;
  offsetTime?: string;
  make?: string;
  model?: string;
  focalLength?: number;
  fNumber?: number;
  exposureTime?: number;
  iso?: number;
  orientation?: number;
}

export const DEMO_IMAGE_PATHS = {
  road: 'C:\\Users\\asus\\Desktop\\aaa\\public\\demo\\road.jpg',
  mountain: 'C:\\Users\\asus\\Desktop\\aaa\\public\\demo\\mountain.jpg',
  lake: 'C:\\Users\\asus\\Desktop\\aaa\\public\\demo\\lake.jpg',
  forest: 'C:\\Users\\asus\\Desktop\\aaa\\public\\demo\\forest.jpg',
} as const;

export type DemoImageName = keyof typeof DEMO_IMAGE_PATHS;

export function assertDemoImagesExist(): void {
  const missing: string[] = [];
  for (const [name, filePath] of Object.entries(DEMO_IMAGE_PATHS)) {
    if (!fs.existsSync(filePath)) {
      missing.push(`${name}: ${filePath}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Demo images missing on disk:\n${missing.join('\n')}`);
  }
}

export function readDemoImage(name: DemoImageName): Buffer {
  const filePath = DEMO_IMAGE_PATHS[name];
  if (!fs.existsSync(filePath)) {
    throw new Error(`Demo image '${name}' not found at ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

// ---------------------------------------------------------------------------
// Baseline 4:4:4 JPEG Encoder (ITU-T T.81 Annex K standard tables)
// ---------------------------------------------------------------------------

const ZIGZAG_ORDER = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

const STD_LUMA_QUANT = new Uint8Array([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);

const STD_CHROMA_QUANT = new Uint8Array([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]);

const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// Minimal AC Huffman tables (EOB symbol 0x00 at length 2/2) + full standard Annex K fallback symbols
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

interface HuffCode {
  code: number;
  len: number;
}

function buildHuffTable(bits: number[], vals: number[]): Map<number, HuffCode> {
  const table = new Map<number, HuffCode>();
  let code = 0;
  let valIdx = 0;
  for (let len = 1; len <= 16; len += 1) {
    const count = bits[len - 1] ?? 0;
    for (let i = 0; i < count; i += 1) {
      const sym = vals[valIdx++]!;
      table.set(sym, { code, len });
      code += 1;
    }
    code <<= 1;
  }
  return table;
}

const DC_LUMA_HUFF = buildHuffTable(DC_LUMA_BITS, DC_LUMA_VALS);
const DC_CHROMA_HUFF = buildHuffTable(DC_CHROMA_BITS, DC_CHROMA_VALS);
const AC_LUMA_HUFF = buildHuffTable(AC_LUMA_BITS, AC_LUMA_VALS);
const AC_CHROMA_HUFF = buildHuffTable(AC_CHROMA_BITS, AC_CHROMA_VALS);

function bitLength(n: number): number {
  let abs = Math.abs(n);
  let len = 0;
  while (abs > 0) {
    abs >>= 1;
    len += 1;
  }
  return len;
}

function encodeDhtSegment(tableClass: number, tableId: number, bits: number[], vals: number[]): Buffer {
  const length = 2 + 1 + 16 + vals.length;
  const buf = Buffer.allocUnsafe(2 + length);
  buf[0] = 0xff;
  buf[1] = 0xc4;
  buf.writeUInt16BE(length, 2);
  buf[4] = (tableClass << 4) | (tableId & 0x0f);
  for (let i = 0; i < 16; i += 1) {
    buf[5 + i] = bits[i] ?? 0;
  }
  for (let i = 0; i < vals.length; i += 1) {
    buf[21 + i] = vals[i]!;
  }
  return buf;
}

function encodeDqtSegment(tableId: number, quant: Uint8Array): Buffer {
  const buf = Buffer.allocUnsafe(2 + 2 + 1 + 64);
  buf[0] = 0xff;
  buf[1] = 0xdb;
  buf.writeUInt16BE(2 + 1 + 64, 2);
  buf[4] = tableId & 0x0f;
  for (let i = 0; i < 64; i += 1) {
    buf[5 + i] = quant[ZIGZAG_ORDER[i]!]!;
  }
  return buf;
}

function encodeBaselineJpeg(width: number, height: number, appSegment: Buffer): Buffer {
  if (!Number.isInteger(width) || width < 1 || width > 65535) {
    throw new RangeError(`JPEG width must be an integer in [1, 65535], got ${width}`);
  }
  if (!Number.isInteger(height) || height < 1 || height > 65535) {
    throw new RangeError(`JPEG height must be an integer in [1, 65535], got ${height}`);
  }

  const soi = Buffer.from([0xff, 0xd8]);
  const dqtY = encodeDqtSegment(0, STD_LUMA_QUANT);
  const dqtC = encodeDqtSegment(1, STD_CHROMA_QUANT);

  // SOF0 (Baseline DCT, 8-bit, 3 components 4:4:4)
  const sof0 = Buffer.from([
    0xff, 0xc0, 0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ]);

  const dhtDcY = encodeDhtSegment(0, 0, DC_LUMA_BITS, DC_LUMA_VALS);
  const dhtAcY = encodeDhtSegment(1, 0, AC_LUMA_BITS, AC_LUMA_VALS);
  const dhtDcC = encodeDhtSegment(0, 1, DC_CHROMA_BITS, DC_CHROMA_VALS);
  const dhtAcC = encodeDhtSegment(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS);

  // SOS (Start of Scan)
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x0c,
    0x03,
    0x01, 0x00,
    0x02, 0x11,
    0x03, 0x11,
    0x00, 0x3f, 0x00,
  ]);

  // Entropy-coded data: smooth gradient across 8x8 MCUs (DC-only + AC EOB)
  const scanBytes: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;

  const writeBits = (code: number, len: number) => {
    bitBuf = (bitBuf << len) | (code & ((1 << len) - 1));
    bitCount += len;
    while (bitCount >= 8) {
      bitCount -= 8;
      const byte = (bitBuf >> bitCount) & 0xff;
      scanBytes.push(byte);
      if (byte === 0xff) {
        scanBytes.push(0x00); // JPEG byte stuffing
      }
      bitBuf &= (1 << bitCount) - 1;
    }
  };

  const writeDcBlock = (
    dcDiff: number,
    dcHuff: Map<number, HuffCode>,
    acHuff: Map<number, HuffCode>,
  ) => {
    const size = bitLength(dcDiff);
    const dcCode = dcHuff.get(size)!;
    writeBits(dcCode.code, dcCode.len);
    if (size > 0) {
      const mantissa = dcDiff >= 0 ? dcDiff : dcDiff + (1 << size) - 1;
      writeBits(mantissa, size);
    }
    // AC EOB (symbol 0x00)
    const eob = acHuff.get(0x00)!;
    writeBits(eob.code, eob.len);
  };

  const blocksX = Math.ceil(width / 8);
  const blocksY = Math.ceil(height / 8);
  let prevDcY = 0;
  let prevDcCb = 0;
  let prevDcCr = 0;

  for (let by = 0; by < blocksY; by += 1) {
    const ty = blocksY > 1 ? by / (blocksY - 1) : 0.5;
    for (let bx = 0; bx < blocksX; bx += 1) {
      const tx = blocksX > 1 ? bx / (blocksX - 1) : 0.5;
      const r = Math.round(48 + 160 * tx);
      const g = Math.round(72 + 120 * ty);
      const b = Math.round(140 + 80 * (1 - tx));

      const yVal = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      const cbVal = -0.168736 * r - 0.331264 * g + 0.5 * b;
      const crVal = 0.5 * r - 0.418688 * g - 0.081312 * b;

      // Forward DCT DC coefficient for constant block is 8 * sample; quantized by Q[0]
      const qDcY = Math.round((8 * yVal) / STD_LUMA_QUANT[0]!);
      const qDcCb = Math.round((8 * cbVal) / STD_CHROMA_QUANT[0]!);
      const qDcCr = Math.round((8 * crVal) / STD_CHROMA_QUANT[0]!);

      writeDcBlock(qDcY - prevDcY, DC_LUMA_HUFF, AC_LUMA_HUFF);
      writeDcBlock(qDcCb - prevDcCb, DC_CHROMA_HUFF, AC_CHROMA_HUFF);
      writeDcBlock(qDcCr - prevDcCr, DC_CHROMA_HUFF, AC_CHROMA_HUFF);

      prevDcY = qDcY;
      prevDcCb = qDcCb;
      prevDcCr = qDcCr;
    }
  }

  // Pad remaining bits in final byte with 1s per JPEG spec
  if (bitCount > 0) {
    const padLen = 8 - bitCount;
    writeBits((1 << padLen) - 1, padLen);
  }

  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([
    soi,
    appSegment,
    dqtY,
    dqtC,
    sof0,
    dhtDcY,
    dhtAcY,
    dhtDcC,
    dhtAcC,
    sos,
    Buffer.from(scanBytes),
    eoi,
  ]);
}

// ---------------------------------------------------------------------------
// EXIF / TIFF Binary Builder (Little-Endian II*\0)
// ---------------------------------------------------------------------------

interface IfdEntrySpec {
  tag: number;
  type: 1 | 2 | 3 | 4 | 5; // BYTE=1, ASCII=2, SHORT=3, LONG=4, RATIONAL=5
  count: number;
  data: Buffer;
}

function asciiEntry(tag: number, value: string): IfdEntrySpec {
  const data = Buffer.from(`${value}\0`, 'ascii');
  return { tag, type: 2, count: data.length, data };
}

function shortEntry(tag: number, value: number): IfdEntrySpec {
  const data = Buffer.allocUnsafe(2);
  data.writeUInt16LE(value & 0xffff, 0);
  return { tag, type: 3, count: 1, data };
}

function longEntry(tag: number, value: number): IfdEntrySpec {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(value >>> 0, 0);
  return { tag, type: 4, count: 1, data };
}

function byteEntry(tag: number, bytes: number[]): IfdEntrySpec {
  return { tag, type: 1, count: bytes.length, data: Buffer.from(bytes) };
}

function toRational(value: number, maxDen = 1_000_000): [number, number] {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`EXIF RATIONAL must be non-negative finite number, got ${value}`);
  }
  if (value === 0) return [0, 1];
  if (Number.isInteger(value) && value <= 0xffffffff) {
    return [value, 1];
  }
  // Continued fraction approximation
  let h1 = 1;
  let h0 = 0;
  let k1 = 0;
  let k0 = 1;
  let b = value;
  for (let i = 0; i < 32; i += 1) {
    const a = Math.floor(b);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen || h2 > 0xffffffff) break;
    h0 = h1;
    h1 = h2;
    k0 = k1;
    k1 = k2;
    const frac = b - a;
    if (frac < 1e-12) break;
    b = 1 / frac;
  }
  if (k1 === 0) return [Math.round(value), 1];
  return [h1 >>> 0, k1 >>> 0];
}

function rationalEntry(tag: number, pairs: Array<[number, number]>): IfdEntrySpec {
  const data = Buffer.allocUnsafe(pairs.length * 8);
  for (let i = 0; i < pairs.length; i += 1) {
    const [num, den] = pairs[i]!;
    data.writeUInt32LE(num >>> 0, i * 8);
    data.writeUInt32LE(den >>> 0, i * 8 + 4);
  }
  return { tag, type: 5, count: pairs.length, data };
}

function decimalToDms(absDegrees: number): Array<[number, number]> {
  let deg = Math.floor(absDegrees);
  const remMin = (absDegrees - deg) * 60;
  let min = Math.floor(remMin);
  let secScaled = Math.round((remMin - min) * 60 * 10_000);
  if (secScaled >= 600_000) {
    secScaled -= 600_000;
    min += 1;
  }
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }
  return [
    [deg, 1],
    [min, 1],
    [secScaled, 10_000],
  ];
}

function serializeIfd(entries: IfdEntrySpec[], baseOffset: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const tableSize = 2 + sorted.length * 12 + 4;
  const outOfLineChunks: Buffer[] = [];
  let cursor = baseOffset + tableSize;

  const table = Buffer.alloc(tableSize);
  table.writeUInt16LE(sorted.length, 0);

  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i]!;
    const off = 2 + i * 12;
    table.writeUInt16LE(entry.tag, off);
    table.writeUInt16LE(entry.type, off + 2);
    table.writeUInt32LE(entry.count, off + 4);

    if (entry.data.length <= 4) {
      entry.data.copy(table, off + 8);
    } else {
      table.writeUInt32LE(cursor >>> 0, off + 8);
      const paddedLen = entry.data.length % 2 === 1 ? entry.data.length + 1 : entry.data.length;
      const chunk = Buffer.alloc(paddedLen);
      entry.data.copy(chunk, 0);
      outOfLineChunks.push(chunk);
      cursor += paddedLen;
    }
  }

  // Next IFD offset = 0
  table.writeUInt32LE(0, 2 + sorted.length * 12);
  return Buffer.concat([table, ...outOfLineChunks]);
}

function normalizeTakenAt(
  takenAt: string | null | undefined,
  explicitOffset?: string,
): { exifDateTime: string | null; offsetTime?: string } {
  if (takenAt === null) {
    return { exifDateTime: null, offsetTime: explicitOffset };
  }
  const raw = takenAt ?? '2026:10:01 20:30:00';

  // Already EXIF format: YYYY:MM:DD HH:MM:SS
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    return { exifDateTime: raw, offsetTime: explicitOffset };
  }

  // ISO8601 e.g. 2026-10-01T20:30:00+08:00 or 2026-10-01T12:30:00Z or 2026-10-01T20:30:00
  const isoMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/i,
  );
  if (isoMatch) {
    const [, y, m, d, hh, mm, ss, tz] = isoMatch;
    const parsedOffset = tz ? (tz.toUpperCase() === 'Z' ? '+00:00' : tz) : undefined;
    return {
      exifDateTime: `${y}:${m}:${d} ${hh}:${mm}:${ss}`,
      offsetTime: explicitOffset ?? parsedOffset,
    };
  }

  throw new Error(`Unsupported takenAt format '${raw}'. Expected 'YYYY:MM:DD HH:MM:SS' or ISO8601.`);
}

function buildExifApp1Segment(opts: SyntheticExifJpegOptions): Buffer {
  const make = opts.make ?? 'FUJIFILM';
  const model = opts.model ?? 'X-T5';
  const orientation = opts.orientation ?? 1;
  const focalLength = opts.focalLength ?? 35;
  const fNumber = opts.fNumber ?? 2.8;
  const exposureTime = opts.exposureTime ?? 1 / 250;
  const iso = opts.iso ?? 400;
  const { exifDateTime, offsetTime } = normalizeTakenAt(opts.takenAt, opts.offsetTime);

  const hasGps = !opts.omitGps && opts.lat !== null && opts.lng !== null;

  const lat = opts.lat === undefined ? 25.6065 : opts.lat;
  const lng = opts.lng === undefined ? 100.2676 : opts.lng;

  if (hasGps) {
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new RangeError(`Invalid latitude: ${lat}`);
    }
    if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new RangeError(`Invalid longitude: ${lng}`);
    }
  }

  const exifEntries: IfdEntrySpec[] = [
    rationalEntry(0x829a, [toRational(exposureTime)]),
    rationalEntry(0x829d, [toRational(fNumber)]),
    shortEntry(0x8827, iso),
    rationalEntry(0x920a, [toRational(focalLength)]),
  ];
  if (exifDateTime) {
    exifEntries.push(asciiEntry(0x9003, exifDateTime));
  }
  if (offsetTime) {
    exifEntries.push(asciiEntry(0x9011, offsetTime));
  }

  const makeIfd0Entries = (exifOffset: number, gpsOffset: number | null): IfdEntrySpec[] => {
    const entries: IfdEntrySpec[] = [
      asciiEntry(0x010f, make),
      asciiEntry(0x0110, model),
      shortEntry(0x0112, orientation),
      longEntry(0x8769, exifOffset),
    ];
    if (exifDateTime) {
      entries.push(asciiEntry(0x0132, exifDateTime));
    }
    if (gpsOffset !== null) {
      entries.push(longEntry(0x8825, gpsOffset));
    }
    return entries;
  };

  // Pass 1: measure IFD0 size with placeholder offsets
  const tiffHeader = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const placeholderIfd0 = serializeIfd(makeIfd0Entries(0, hasGps ? 0 : null), 8);
  const exifOffset = 8 + placeholderIfd0.length;
  const exifBytes = serializeIfd(exifEntries, exifOffset);

  let gpsOffset: number | null = null;
  let gpsBytes: Buffer = Buffer.alloc(0);

  if (hasGps && typeof lat === 'number' && typeof lng === 'number') {
    gpsOffset = exifOffset + exifBytes.length;
    const gpsEntries: IfdEntrySpec[] = [
      byteEntry(0x0000, [2, 2, 0, 0]),
      asciiEntry(0x0001, lat < 0 ? 'S' : 'N'),
      rationalEntry(0x0002, decimalToDms(Math.abs(lat))),
      asciiEntry(0x0003, lng < 0 ? 'W' : 'E'),
      rationalEntry(0x0004, decimalToDms(Math.abs(lng))),
    ];
    gpsBytes = serializeIfd(gpsEntries, gpsOffset);
  }

  const ifd0Bytes = serializeIfd(makeIfd0Entries(exifOffset, gpsOffset), 8);
  const tiffPayload = Buffer.concat([tiffHeader, ifd0Bytes, exifBytes, gpsBytes]);
  const exifHeader = Buffer.from('Exif\0\0', 'ascii');
  const segmentLen = 2 + exifHeader.length + tiffPayload.length;
  if (segmentLen > 65535) {
    throw new RangeError(`APP1 EXIF segment exceeds 65535 bytes: ${segmentLen}`);
  }
  const app1Prefix = Buffer.from([0xff, 0xe1, (segmentLen >> 8) & 0xff, segmentLen & 0xff]);
  return Buffer.concat([app1Prefix, exifHeader, tiffPayload]);
}

export function createSyntheticExifJpeg(options: SyntheticExifJpegOptions = {}): Buffer {
  const width = options.width ?? 160;
  const height = options.height ?? 120;
  const app1 = buildExifApp1Segment(options);
  return encodeBaselineJpeg(width, height, app1);
}

export function createExiflessJpeg(width = 160, height = 120): Buffer {
  // Standard 18-byte APP0 (JFIF 1.01) segment with zero APP1 / EXIF / GPS bytes
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01,
    0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  return encodeBaselineJpeg(width, height, app0);
}

// ---------------------------------------------------------------------------
// Synthetic PNG Generator (zero native dependencies, node:zlib only)
// ---------------------------------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length >>> 0, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = zlib.crc32(crcInput) >>> 0;
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

export function createSyntheticPng(width = 160, height = 120): Buffer {
  if (!Number.isInteger(width) || width < 1 || width > 65535) {
    throw new RangeError(`PNG width must be an integer in [1, 65535], got ${width}`);
  }
  if (!Number.isInteger(height) || height < 1 || height > 65535) {
    throw new RangeError(`PNG height must be an integer in [1, 65535], got ${height}`);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = 1 + width * 4;
  const raw = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter None
    const ty = height > 1 ? y / (height - 1) : 0.5;
    for (let x = 0; x < width; x += 1) {
      const tx = width > 1 ? x / (width - 1) : 0.5;
      const pxOff = rowOff + 1 + x * 4;
      raw[pxOff] = Math.round(32 + 180 * tx);
      raw[pxOff + 1] = Math.round(64 + 140 * ty);
      raw[pxOff + 2] = Math.round(160 + 80 * (1 - tx));
      raw[pxOff + 3] = 255;
    }
  }

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Deterministic Binary Chunk Payload Generator (Vault chunked upload tests)
// ---------------------------------------------------------------------------

export function createBinaryChunkPayload(
  sizeBytes: number,
  seed = 1,
): { buffer: Buffer; sha256: string } {
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError(`sizeBytes must be a non-negative integer, got ${sizeBytes}`);
  }
  const buffer = Buffer.allocUnsafe(sizeBytes);
  let state = seed >>> 0;
  const nextU32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };

  const fullWords = Math.floor(sizeBytes / 4);
  for (let i = 0; i < fullWords; i += 1) {
    buffer.writeUInt32LE(nextU32(), i * 4);
  }
  const rem = sizeBytes % 4;
  if (rem > 0) {
    const tail = nextU32();
    const base = fullWords * 4;
    for (let j = 0; j < rem; j += 1) {
      buffer[base + j] = (tail >>> (j * 8)) & 0xff;
    }
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { buffer, sha256 };
}
