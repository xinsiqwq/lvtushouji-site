// Pure-TypeScript ISO/IEC 18004 QR Code SVG generator (Byte mode, ECC Level L, Versions 1..14).
// Zero external dependencies and zero network calls.

export type QrDotStyle = 'square' | 'rounded' | 'dots';

export type QrStyledSvgOptions = {
  quietZone?: number;
  dotStyle?: QrDotStyle;
  fgColor?: string;
  bgColor?: string;
};

export type QrStyledSvgResult = {
  svgMarkup: string;
  viewBox: string;
  dimension: number;
};

export const QR_MAX_BYTE_CAPACITY = 458;

// ISO/IEC 18004 Byte mode capacity at ECC Level L (Versions 1..14)
const VERSION_CAPACITY_L = [
  0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458,
];
const VERSION_TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581,
];
const VERSION_ECC_PER_BLOCK_L = [
  0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30,
];
const VERSION_BLOCKS_L: readonly (readonly [number, number])[][] = [
  [],
  [[1, 19]],
  [[1, 34]],
  [[1, 55]],
  [[1, 80]],
  [[1, 108]],
  [[2, 68]],
  [[2, 78]],
  [[2, 97]],
  [[2, 116]],
  [
    [2, 68],
    [2, 69],
  ],
  [[4, 81]],
  [
    [2, 92],
    [2, 93],
  ],
  [[4, 107]],
  [
    [3, 115],
    [1, 116],
  ],
];

const ALIGNMENT_CENTERS: readonly number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a]! + GF_LOG[b]!) % 255]!;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsGeneratorPoly(eccLen);
  const res = new Uint8Array(eccLen);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i]! ^ res[0]!;
    res.copyWithin(0, 1);
    res[eccLen - 1] = 0;
    for (let j = 0; j < eccLen; j += 1) {
      res[j] ^= gfMul(gen[j + 1]!, factor);
    }
  }
  return res;
}

function pickVersion(byteLen: number): number {
  for (let v = 1; v < VERSION_CAPACITY_L.length; v += 1) {
    if (byteLen <= VERSION_CAPACITY_L[v]!) return v;
  }
  throw new Error(`QR payload exceeds version 14 byte capacity (${QR_MAX_BYTE_CAPACITY} bytes)`);
}

function encodeDataCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const blocksSpec = VERSION_BLOCKS_L[version]!;
  const totalDataCodewords = blocksSpec.reduce((sum, [cnt, dc]) => sum + cnt * dc, 0);
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  };

  // Byte mode indicator (0100) + 8-bit char count (versions 1..9) or 16-bit (versions 10..26)
  pushBits(0b0100, 4);
  pushBits(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = totalDataCodewords * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < termLen; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(totalDataCodewords);
  for (let i = 0; i < bits.length / 8; i += 1) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) {
      byte = (byte << 1) | (bits[i * 8 + b] ?? 0);
    }
    codewords[i] = byte;
  }

  let padIdx = bits.length / 8;
  let padToggle = 0;
  while (padIdx < totalDataCodewords) {
    codewords[padIdx++] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }
  return codewords;
}

function buildFinalCodewords(data: Uint8Array, version: number): Uint8Array {
  const eccLen = VERSION_ECC_PER_BLOCK_L[version]!;
  const groups = VERSION_BLOCKS_L[version]!;
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];

  let offset = 0;
  for (const [count, dc] of groups) {
    for (let i = 0; i < count; i += 1) {
      const slice = data.subarray(offset, offset + dc);
      offset += dc;
      dataBlocks.push(slice);
      eccBlocks.push(rsRemainder(slice, eccLen));
    }
  }

  const out: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const blk of dataBlocks) {
      if (i < blk.length) out.push(blk[i]!);
    }
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (const blk of eccBlocks) {
      out.push(blk[i]!);
    }
  }
  if (out.length !== VERSION_TOTAL_CODEWORDS[version]) {
    throw new Error(`Unexpected QR codeword count for version ${version}`);
  }
  return new Uint8Array(out);
}

function buildMatrix(version: number, codewords: Uint8Array): { size: number; modules: Uint8Array } {
  const size = version * 4 + 17;
  const grid = new Int8Array(size * size).fill(-1);
  const reserved = new Uint8Array(size * size);

  const setModule = (r: number, c: number, dark: boolean, lock = true) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    grid[r * size + c] = dark ? 1 : 0;
    if (lock) reserved[r * size + c] = 1;
  };

  const drawFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setModule(r, c, inOuter && (inBorder || inCenter), true);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setModule(6, i, dark, true);
    setModule(i, 6, dark, true);
  }

  // Alignment patterns
  const centers = ALIGNMENT_CENTERS[version] ?? [];
  for (const cr of centers) {
    for (const cc of centers) {
      if (reserved[cr * size + cc]) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setModule(cr + dr, cc + dc, dark, true);
        }
      }
    }
  }

  // Reserve format info + dark module
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      reserved[8 * size + i] = 1;
      reserved[i * size + 8] = 1;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8 * size + (size - 1 - i)] = 1;
    reserved[(size - 1 - i) * size + 8] = 1;
  }
  setModule(size - 8, 8, true, true);

  // Reserve version info for version >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setModule(a, b, dark, true);
      setModule(b, a, dark, true);
    }
  }

  // Place data bits (mask 0: (r + c) % 2 === 0)
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const r = up ? size - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx;
        if (reserved[r * size + c]) continue;
        let bit = false;
        if (bitIndex < totalBits) {
          const cw = codewords[bitIndex >>> 3]!;
          bit = ((cw >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex += 1;
        }
        const masked = bit !== ((r + c) % 2 === 0);
        grid[r * size + c] = masked ? 1 : 0;
      }
    }
    up = !up;
  }

  // Format information for ECC Level L (01) + Mask 0 (000) -> 0b01000 = 8
  const fmtData = 0b01_000;
  let rem = fmtData << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i;
  }
  const formatBits = ((fmtData << 10) | rem) ^ 0x5412;

  for (let i = 0; i < 15; i += 1) {
    const dark = ((formatBits >>> i) & 1) === 1;
    if (i < 6) grid[8 * size + i] = dark ? 1 : 0;
    else if (i < 8) grid[8 * size + (i + 1)] = dark ? 1 : 0;
    else grid[8 * size + (size - 15 + i)] = dark ? 1 : 0;

    if (i < 8) grid[(size - 1 - i) * size + 8] = dark ? 1 : 0;
    else if (i < 9) grid[7 * size + 8] = dark ? 1 : 0;
    else grid[(14 - i) * size + 8] = dark ? 1 : 0;
  }

  const modules = new Uint8Array(size * size);
  for (let i = 0; i < modules.length; i += 1) {
    modules[i] = grid[i] === 1 ? 1 : 0;
  }
  return { size, modules };
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isInsideFinder(r: number, c: number, size: number): boolean {
  const topLeft = r < 7 && c < 7;
  const topRight = r < 7 && c >= size - 7;
  const bottomLeft = r >= size - 7 && c < 7;
  return topLeft || topRight || bottomLeft;
}

function roundedRectPath(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.min(radius, w / 2, h / 2);
  const f = (n: number) => Number(n.toFixed(3));
  const x0 = f(x);
  const y0 = f(y);
  const rw = f(w - 2 * r);
  const rh = f(h - 2 * r);
  const rr = f(r);
  return `M${f(x0 + rr)},${y0}h${rw}a${rr},${rr} 0 0 1 ${rr},${rr}v${rh}a${rr},${rr} 0 0 1 -${rr},${rr}h-${rw}a${rr},${rr} 0 0 1 -${rr},-${rr}v-${rh}a${rr},${rr} 0 0 1 ${rr},-${rr}z`;
}

function circlePath(cx: number, cy: number, radius: number): string {
  const f = (n: number) => Number(n.toFixed(3));
  const r = f(radius);
  const d = f(radius * 2);
  return `M${f(cx - radius)},${f(cy)}a${r},${r} 0 1 0 ${d},0a${r},${r} 0 1 0 -${d},0z`;
}

export function generateQrMatrix(value: string): { size: number; modules: Uint8Array } {
  const bytes = new TextEncoder().encode(value || ' ');
  const version = pickVersion(bytes.length);
  const data = encodeDataCodewords(bytes, version);
  const finalCw = buildFinalCodewords(data, version);
  return buildMatrix(version, finalCw);
}

export function qrToSvgPath(value: string, quietZone = 2): { viewBox: string; path: string; dimension: number } {
  const { size, modules } = generateQrMatrix(value);
  const dim = size + quietZone * 2;
  const parts: string[] = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r * size + c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  return {
    viewBox: `0 0 ${dim} ${dim}`,
    path: parts.join(''),
    dimension: dim,
  };
}

export function qrToStyledSvg(value: string, opts: QrStyledSvgOptions = {}): QrStyledSvgResult {
  const quietZone = Math.max(0, Math.min(10, Math.round(opts.quietZone ?? 2)));
  const dotStyle: QrDotStyle = opts.dotStyle ?? 'square';
  const fgColor = escapeXmlAttr((opts.fgColor || '#1f1f1f').trim() || '#1f1f1f');
  const bgColor = escapeXmlAttr((opts.bgColor || '#ffffff').trim() || '#ffffff');

  const { size, modules } = generateQrMatrix(value);
  const dim = size + quietZone * 2;
  const viewBox = `0 0 ${dim} ${dim}`;

  if (dotStyle === 'square') {
    const parts: string[] = [];
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (modules[r * size + c]) {
          parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
        }
      }
    }
    const svgMarkup = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" shape-rendering="crispEdges">`,
      `<rect width="${dim}" height="${dim}" fill="${bgColor}"/>`,
      `<path d="${parts.join('')}" fill="${fgColor}"/>`,
      `</svg>`,
    ].join('');
    return { svgMarkup, viewBox, dimension: dim };
  }

  // Styled finder frames (outer 7x7 ring + inner 3x3 eye) keep scans fast and reliable
  const finderOrigins: readonly [number, number][] = [
    [quietZone, quietZone],
    [quietZone + size - 7, quietZone],
    [quietZone, quietZone + size - 7],
  ];
  const outerRadius = dotStyle === 'dots' ? 1.85 : 1.35;
  const holeRadius = dotStyle === 'dots' ? 1.15 : 0.85;
  const eyeRadius = dotStyle === 'dots' ? 1.5 : 0.72;

  const finderRingParts: string[] = [];
  const finderEyeParts: string[] = [];
  for (const [fx, fy] of finderOrigins) {
    finderRingParts.push(roundedRectPath(fx, fy, 7, 7, outerRadius));
    finderRingParts.push(roundedRectPath(fx + 1, fy + 1, 5, 5, holeRadius));
    if (dotStyle === 'dots') {
      finderEyeParts.push(circlePath(fx + 3.5, fy + 3.5, 1.5));
    } else {
      finderEyeParts.push(roundedRectPath(fx + 2, fy + 2, 3, 3, eyeRadius));
    }
  }

  const moduleParts: string[] = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!modules[r * size + c]) continue;
      if (isInsideFinder(r, c, size)) continue;
      const x = c + quietZone;
      const y = r + quietZone;
      if (dotStyle === 'dots') {
        moduleParts.push(circlePath(x + 0.5, y + 0.5, 0.43));
      } else {
        moduleParts.push(roundedRectPath(x + 0.04, y + 0.04, 0.92, 0.92, 0.28));
      }
    }
  }

  const svgMarkup = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" shape-rendering="geometricPrecision">`,
    `<rect width="${dim}" height="${dim}" fill="${bgColor}"/>`,
    `<path d="${finderRingParts.join('')}" fill="${fgColor}" fill-rule="evenodd"/>`,
    `<path d="${finderEyeParts.join('')}${moduleParts.join('')}" fill="${fgColor}"/>`,
    `</svg>`,
  ].join('');

  return { svgMarkup, viewBox, dimension: dim };
}

export async function renderQrToPngBlob(svgMarkup: string, pixelSize = 1024): Promise<Blob> {
  const safeSize = Math.max(128, Math.min(4096, Math.round(pixelSize)));
  const normalizedSvg = svgMarkup.replace(/<svg\b([^>]*)>/i, (full, attrs: string) => {
    const cleaned = attrs
      .replace(/\swidth="[^"]*"/gi, '')
      .replace(/\sheight="[^"]*"/gi, '');
    const hasXmlns = /\bxmlns=/.test(cleaned);
    return `<svg${hasXmlns ? '' : ' xmlns="http://www.w3.org/2000/svg"'}${cleaned} width="${safeSize}" height="${safeSize}">`;
  });

  const svgBlob = new Blob([normalizedSvg], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法将二维码矢量图渲染为位图'));
      image.src = objectUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = safeSize;
    canvas.height = safeSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('浏览器暂不支持 Canvas 2D 导出');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, safeSize, safeSize);

    const pngBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
    if (!pngBlob) {
      throw new Error('生成 PNG 文件失败');
    }
    return pngBlob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
