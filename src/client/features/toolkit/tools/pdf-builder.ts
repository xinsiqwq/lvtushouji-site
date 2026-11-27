/**
 * Pure TypeScript ISO PDF 1.4 builder embedding JPEG images as /DCTDecode XObjects.
 * Zero external dependencies; runs 100% offline in the browser or Node.
 */

export interface PdfImagePage {
  jpegBytes: Uint8Array;
  widthPx: number;
  heightPx: number;
}

export type PdfPageMode = 'fit-image' | 'a4-portrait' | 'a4-auto';

export interface PdfBuildOptions {
  pageMode?: PdfPageMode;
  marginPt?: number;
  backgroundRgb?: [number, number, number];
  title?: string;
}

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

const textEncoder = new TextEncoder();

function encodeAscii(str: string): Uint8Array {
  return textEncoder.encode(str);
}

function formatPdfNum(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function escapePdfLiteralString(input: string): string {
  // Keep pure ASCII for PDF DocEncoding metadata safety
  const asciiOnly = input.replace(/[^\x20-\x7E]/g, '').slice(0, 96);
  return asciiOnly
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
}

interface ParsedJpegInfo {
  width: number;
  height: number;
  components: number;
}

/**
 * Inspects JPEG SOF0/SOF1/SOF2 markers to verify dimensions and channel count.
 * Falls back cleanly to caller-provided pixel dimensions and 3-channel RGB.
 */
function parseJpegHeader(bytes: Uint8Array, fallbackW: number, fallbackH: number): ParsedJpegInfo {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;

      // Standalone markers without length
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        continue;
      }
      if (offset + 2 > bytes.length) break;
      const segmentLen = (bytes[offset] << 8) | bytes[offset + 1];
      if (segmentLen < 2 || offset + segmentLen > bytes.length) break;

      // Start Of Frame markers (baseline / extended / progressive)
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 8 <= bytes.length) {
          const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
          const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
          const components = bytes[offset + 7];
          if (width > 0 && height > 0 && (components === 1 || components === 3 || components === 4)) {
            return { width, height, components };
          }
        }
        break;
      }

      offset += segmentLen;
    }
  }

  return {
    width: Math.max(1, Math.round(fallbackW)),
    height: Math.max(1, Math.round(fallbackH)),
    components: 3,
  };
}

function colorSpaceForComponents(components: number): string {
  if (components === 1) return '/DeviceGray';
  if (components === 4) return '/DeviceCMYK';
  return '/DeviceRGB';
}

function computePageLayout(
  imgW: number,
  imgH: number,
  pageMode: PdfPageMode,
  marginPt: number,
): {
  pageW: number;
  pageH: number;
  drawX: number;
  drawY: number;
  drawW: number;
  drawH: number;
} {
  const safeW = Math.max(1, imgW);
  const safeH = Math.max(1, imgH);
  const margin = Math.max(0, Math.min(120, marginPt));

  if (pageMode === 'fit-image') {
    // Normalize page width around A4 width (595.28 pt) so mixed-DPI screenshots open comfortably
    // while keeping very tall/wide pages well within PDF 1.4 limits (14400 pt max).
    const baseTargetW = A4_WIDTH_PT;
    let drawW = baseTargetW - margin * 2;
    let drawH = (drawW * safeH) / safeW;

    const maxPageExtent = 12000;
    if (drawH + margin * 2 > maxPageExtent) {
      const shrink = (maxPageExtent - margin * 2) / drawH;
      drawW *= shrink;
      drawH *= shrink;
    }

    const pageW = Math.max(72, drawW + margin * 2);
    const pageH = Math.max(72, drawH + margin * 2);
    return {
      pageW,
      pageH,
      drawX: margin,
      drawY: margin,
      drawW,
      drawH,
    };
  }

  const landscape = pageMode === 'a4-auto' && safeW > safeH * 1.08;
  const pageW = landscape ? A4_HEIGHT_PT : A4_WIDTH_PT;
  const pageH = landscape ? A4_WIDTH_PT : A4_HEIGHT_PT;
  const availW = Math.max(36, pageW - margin * 2);
  const availH = Math.max(36, pageH - margin * 2);
  const scale = Math.min(availW / safeW, availH / safeH);
  const drawW = safeW * scale;
  const drawH = safeH * scale;
  const drawX = (pageW - drawW) / 2;
  const drawY = (pageH - drawH) / 2;

  return { pageW, pageH, drawX, drawY, drawW, drawH };
}

function formatPdfCreationDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * Builds a complete, ISO PDF 1.4 compliant multi-page PDF binary embedding each image as a /DCTDecode JPEG XObject.
 */
export function buildJpegPdf(pages: ReadonlyArray<PdfImagePage>, options: PdfBuildOptions = {}): Uint8Array {
  if (pages.length === 0) {
    throw new Error('至少需要一张影像才能生成 PDF。');
  }

  const pageMode: PdfPageMode = options.pageMode ?? 'a4-auto';
  const marginPt = options.marginPt ?? (pageMode === 'fit-image' ? 0 : 28);
  const bg = options.backgroundRgb;
  const hasCustomBg =
    Array.isArray(bg) &&
    bg.length === 3 &&
    (bg[0] !== 255 || bg[1] !== 255 || bg[2] !== 255);

  const chunks: Uint8Array[] = [];
  let byteOffset = 0;

  const pushBytes = (data: Uint8Array) => {
    chunks.push(data);
    byteOffset += data.byteLength;
  };
  const pushStr = (text: string) => {
    pushBytes(encodeAscii(text));
  };

  // PDF 1.4 Header + binary marker bytes (>127)
  pushStr('%PDF-1.4\n');
  pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Object numbering:
  // 1 = Catalog
  // 2 = Pages
  // For page index i (0..N-1):
  //   3 + i*3     = Image XObject
  //   3 + i*3 + 1 = Page Content Stream
  //   3 + i*3 + 2 = Page Dictionary
  // 3 + N*3 = Info Dictionary
  const pageObjIds = pages.map((_, idx) => 3 + idx * 3 + 2);
  const infoObjId = 3 + pages.length * 3;
  const totalObjects = infoObjId;

  const objectOffsets: number[] = new Array(totalObjects + 1).fill(0);

  const beginObj = (objNum: number) => {
    objectOffsets[objNum] = byteOffset;
    pushStr(`${objNum} 0 obj\n`);
  };

  // 1: Catalog
  beginObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2: Pages
  beginObj(2);
  pushStr(
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`,
  );

  // Per-page objects
  for (let i = 0; i < pages.length; i += 1) {
    const item = pages[i];
    const info = parseJpegHeader(item.jpegBytes, item.widthPx, item.heightPx);
    const layout = computePageLayout(info.width, info.height, pageMode, marginPt);

    const imgObjId = 3 + i * 3;
    const contentObjId = imgObjId + 1;
    const pageObjId = imgObjId + 2;

    // Image XObject
    beginObj(imgObjId);
    const cs = colorSpaceForComponents(info.components);
    const decodeExtra = info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    pushStr(
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${decodeExtra} /Length ${item.jpegBytes.byteLength} >>\nstream\n`,
    );
    pushBytes(item.jpegBytes);
    pushStr('\nendstream\nendobj\n');

    // Page Content Stream
    const ops: string[] = [];
    if (hasCustomBg && bg) {
      const r = formatPdfNum(Math.max(0, Math.min(255, bg[0])) / 255);
      const g = formatPdfNum(Math.max(0, Math.min(255, bg[1])) / 255);
      const b = formatPdfNum(Math.max(0, Math.min(255, bg[2])) / 255);
      ops.push(`q\n${r} ${g} ${b} rg\n0 0 ${formatPdfNum(layout.pageW)} ${formatPdfNum(layout.pageH)} re f\nQ`);
    }
    ops.push(
      `q\n${formatPdfNum(layout.drawW)} 0 0 ${formatPdfNum(layout.drawH)} ${formatPdfNum(layout.drawX)} ${formatPdfNum(layout.drawY)} cm\n/Im0 Do\nQ`,
    );
    const contentBytes = encodeAscii(`${ops.join('\n')}\n`);

    beginObj(contentObjId);
    pushStr(`<< /Length ${contentBytes.byteLength} >>\nstream\n`);
    pushBytes(contentBytes);
    pushStr('endstream\nendobj\n');

    // Page Dictionary
    beginObj(pageObjId);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatPdfNum(layout.pageW)} ${formatPdfNum(layout.pageH)}] /Resources << /ProcSet [/PDF /ImageC /ImageB] /XObject << /Im0 ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`,
    );
  }

  // Info Dictionary
  const creationDate = formatPdfCreationDate(new Date());
  const titlePart = options.title ? ` /Title (${escapePdfLiteralString(options.title)})` : '';
  beginObj(infoObjId);
  pushStr(
    `<< /Producer (Lvtushouji Offline PDF Builder)${titlePart} /CreationDate (${creationDate}) >>\nendobj\n`,
  );

  // Cross-reference table (each entry strictly 20 bytes per ISO PDF 1.4)
  const xrefOffset = byteOffset;
  pushStr(`xref\n0 ${totalObjects + 1}\n`);
  pushStr('0000000000 65535 f \n');
  for (let objNum = 1; objNum <= totalObjects; objNum += 1) {
    const padded = String(objectOffsets[objNum]).padStart(10, '0');
    pushStr(`${padded} 00000 n \n`);
  }

  // Trailer
  pushStr(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info ${infoObjId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  // Merge chunks into a single Uint8Array
  const output = new Uint8Array(byteOffset);
  let writeCursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, writeCursor);
    writeCursor += chunk.byteLength;
  }
  return output;
}

/**
 * Convenience helper returning an application/pdf Blob ready for local download.
 */
export function buildJpegPdfBlob(pages: ReadonlyArray<PdfImagePage>, options: PdfBuildOptions = {}): Blob {
  const bytes = buildJpegPdf(pages, options);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Blob([buffer], { type: 'application/pdf' });
}

/**
 * Converts a loaded HTMLImageElement or HTMLCanvasElement to crisp JPEG bytes for PDF embedding.
 * Fills transparent pixels with backgroundColor (default white) so PNG alpha channels stay clean.
 */
export async function renderSourceToPdfPage(
  source: HTMLImageElement | HTMLCanvasElement,
  options: { maxEdge?: number; quality?: number; backgroundColor?: string } = {},
): Promise<PdfImagePage> {
  const srcW = source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  const srcH = source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;
  if (srcW <= 0 || srcH <= 0) {
    throw new Error('无法读取影像尺寸。');
  }

  const maxEdge = options.maxEdge ?? 2400;
  const quality = options.quality ?? 0.9;
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('浏览器不支持 Canvas 2D 渲染。');
  }

  ctx.fillStyle = options.backgroundColor ?? '#FFFFFF';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, outW, outH);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('JPEG 页面编码失败。'))),
      'image/jpeg',
      quality,
    );
  });

  const arrayBuffer = await blob.arrayBuffer();
  return {
    jpegBytes: new Uint8Array(arrayBuffer),
    widthPx: outW,
    heightPx: outH,
  };
}
