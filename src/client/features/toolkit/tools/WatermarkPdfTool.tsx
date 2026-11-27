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
  ArrowDown,
  ArrowUp,
  Download,
  FileText,
  Image as ImageIcon,
  Layers,
  ShieldCheck,
  Stamp,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  buildJpegPdfBlob,
  renderSourceToPdfPage,
  type PdfPageMode,
} from './pdf-builder';

type ToolSubMode = 'watermark' | 'stitch';
type WatermarkTone = 'ink' | 'postmark' | 'white';
type StitchDirection = 'vertical' | 'horizontal';
type StitchScaleMode = 'normalize' | 'natural';

interface LoadedDocumentSource {
  name: string;
  url: string;
  isOwnedUrl: boolean;
  isMock: boolean;
  img: HTMLImageElement;
  width: number;
  height: number;
}

interface StitchImageItem {
  id: string;
  name: string;
  url: string;
  isOwnedUrl: boolean;
  img: HTMLImageElement;
  width: number;
  height: number;
}

const WATERMARK_PRESETS: ReadonlyArray<string> = [
  '仅供办理宽带业务使用，他用无效',
  '仅供入职身份核验使用，他用无效',
  '仅供房屋租赁备案使用，复印无效',
  '仅供银行开户实名核验使用',
  '内部审阅样件 · 请勿二次传播',
];

const WATERMARK_TONES: ReadonlyArray<{
  id: WatermarkTone;
  label: string;
  hex: string;
  swatchBorder: string;
}> = [
  { id: 'ink', label: '石墨深灰', hex: '#1F1F1F', swatchBorder: 'rgba(255,255,255,0.2)' },
  { id: 'postmark', label: '暖赭印泥', hex: '#9A5B42', swatchBorder: 'rgba(255,255,255,0.2)' },
  { id: 'white', label: '纯白反色', hex: '#FFFFFF', swatchBorder: 'rgba(31,31,31,0.25)' },
];

const STITCH_BG_OPTIONS: ReadonlyArray<{
  label: string;
  hex: string;
  rgb: [number, number, number];
}> = [
  { label: '纯白', hex: '#FFFFFF', rgb: [255, 255, 255] },
  { label: '骨白纸', hex: '#FAF8F4', rgb: [250, 248, 244] },
  { label: '暗房黑', hex: '#181A1D', rgb: [24, 26, 29] },
];

const PDF_MODE_OPTIONS: ReadonlyArray<{ value: PdfPageMode; label: string }> = [
  { value: 'a4-auto', label: 'A4 自动横竖' },
  { value: 'a4-portrait', label: 'A4 标准竖版' },
  { value: 'fit-image', label: '自适应原图画幅' },
];

function todayDashDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'document';
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法解码影像文件。'));
    img.src = src;
  });
}

/**
 * Generates a synthetic, non-sensitive ID / document specimen locally on Canvas
 * so users can inspect watermark density, angle, and readability before picking a private scan.
 */
function buildMockSpecimenDataUrl(): string {
  const w = 1200;
  const h = 760;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const sans = "'Inter', 'Noto Sans SC', 'PingFang SC', ui-sans-serif, system-ui, sans-serif";
  const mono = "'JetBrains Mono', ui-monospace, Consolas, monospace";

  // Subtle paper-slate studio desk backdrop
  ctx.fillStyle = '#EEF1F6';
  ctx.fillRect(0, 0, w, h);

  // Card shadow & body
  const cardX = 96;
  const cardY = 80;
  const cardW = w - 192;
  const cardH = h - 160;

  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.10)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = '#FAF8F4';
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 28);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(31, 31, 31, 0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 28);
  ctx.stroke();

  // Subtle geometric security guilloche arcs
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 28);
  ctx.clip();
  ctx.strokeStyle = 'rgba(26, 115, 232, 0.08)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 9; i += 1) {
    ctx.beginPath();
    ctx.arc(cardX + cardW - 140, cardY + cardH + 60, 180 + i * 32, Math.PI, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Card header
  ctx.fillStyle = '#1A73E8';
  ctx.font = `600 22px ${sans}`;
  ctx.fillText('本地安全水印测试样张 · 模拟证件卡片', cardX + 56, cardY + 74);

  ctx.beginPath();
  ctx.moveTo(cardX + 56, cardY + 98);
  ctx.lineTo(cardX + cardW - 56, cardY + 98);
  ctx.strokeStyle = 'rgba(31, 31, 31, 0.10)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Left synthetic metadata rows
  const rows: ReadonlyArray<[string, string]> = [
    ['持证人姓名', '林旅途（示意样本）'],
    ['签发类别', '通用实名核验演示件'],
    ['有效期限', '2026.01.01 — 2036.01.01'],
    ['登记编号', 'SPECIMEN-2026-0042-LOCAL'],
    ['隐私提示', '请拖入您的真实证件扫描件替换本样张'],
  ];

  let ry = cardY + 162;
  for (const [label, value] of rows) {
    ctx.fillStyle = '#5F6368';
    ctx.font = `400 18px ${sans}`;
    ctx.fillText(label, cardX + 56, ry);

    ctx.fillStyle = '#1F1F1F';
    ctx.font =
      label === '登记编号' || label === '有效期限'
        ? `500 21px ${mono}`
        : `500 22px ${sans}`;
    ctx.fillText(value, cardX + 190, ry);
    ry += 72;
  }

  // Right portrait placeholder frame
  const photoX = cardX + cardW - 266;
  const photoY = cardY + 144;
  const photoW = 204;
  const photoH = 264;
  ctx.fillStyle = '#E4E9F1';
  ctx.beginPath();
  ctx.roundRect(photoX, photoY, photoW, photoH, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(31, 31, 31, 0.10)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Silhouette icon inside portrait box
  ctx.fillStyle = '#B8C4D4';
  ctx.beginPath();
  ctx.arc(photoX + photoW / 2, photoY + 96, 40, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(photoX + photoW / 2, photoY + 236, 76, Math.PI * 1.12, Math.PI * 1.88);
  ctx.fill();

  ctx.fillStyle = '#5F6368';
  ctx.font = `400 15px ${mono}`;
  ctx.textAlign = 'center';
  ctx.fillText('SAMPLE PHOTO', photoX + photoW / 2, photoY + photoH + 34);
  ctx.textAlign = 'left';

  return canvas.toDataURL('image/png');
}

interface WatermarkRenderParams {
  img: HTMLImageElement;
  text: string;
  angleDeg: number;
  opacity: number;
  fontSizeScale: number; // 14..64 normalized to a 1200px reference longest edge
  spacingFactor: number; // 1.0..2.6
  colorHex: string;
  maxEdge: number; // 0 for full resolution
}

function renderWatermarkedCanvas(canvas: HTMLCanvasElement, params: WatermarkRenderParams): void {
  const natW = params.img.naturalWidth || params.img.width;
  const natH = params.img.naturalHeight || params.img.height;
  if (natW <= 0 || natH <= 0) return;

  const longest = Math.max(natW, natH);
  const scale = params.maxEdge > 0 && longest > params.maxEdge ? params.maxEdge / longest : 1;
  const w = Math.max(1, Math.round(natW * scale));
  const h = Math.max(1, Math.round(natH * scale));

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(params.img, 0, 0, w, h);

  const label = params.text.trim();
  if (!label) return;

  // Normalize font size against output longest edge so preview & full-res export match identically
  const outLongest = Math.max(w, h);
  const fontPx = Math.max(10, Math.round((params.fontSizeScale / 1200) * outLongest));
  const sans = "'Inter', 'Noto Sans SC', 'PingFang SC', ui-sans-serif, system-ui, sans-serif";

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((params.angleDeg * Math.PI) / 180);
  ctx.font = `500 ${fontPx}px ${sans}`;
  ctx.fillStyle = params.colorHex;
  ctx.globalAlpha = Math.max(0.05, Math.min(0.85, params.opacity));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Subtle opposite-contrast outline ONLY when white ink is selected so it stays legible over light paper
  if (params.colorHex.toUpperCase() === '#FFFFFF') {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = Math.max(2, Math.round(fontPx * 0.12));
  }

  const textWidth = Math.max(fontPx * 2, ctx.measureText(label).width);
  const stepX = Math.max(textWidth + fontPx * 1.4, textWidth * (0.9 + params.spacingFactor * 0.45));
  const stepY = Math.max(fontPx * 2.4, fontPx * (1.8 + params.spacingFactor * 1.65));

  const diag = Math.hypot(w, h) * 0.65;
  let rowIndex = 0;
  for (let y = -diag; y <= diag; y += stepY) {
    const staggerX = rowIndex % 2 === 1 ? stepX * 0.5 : 0;
    for (let x = -diag - stepX; x <= diag + stepX; x += stepX) {
      ctx.fillText(label, x + staggerX, y);
    }
    rowIndex += 1;
  }

  ctx.restore();
}

interface StitchLayoutResult {
  width: number;
  height: number;
  clamped: boolean;
  placements: Array<{
    item: StitchImageItem;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
}

const MAX_STITCH_CANVAS_EXTENT = 16000;

function computeStitchLayout(
  items: ReadonlyArray<StitchImageItem>,
  direction: StitchDirection,
  scaleMode: StitchScaleMode,
  gap: number,
  maxPreviewExtent = 0,
): StitchLayoutResult {
  if (items.length === 0) {
    return { width: 0, height: 0, clamped: false, placements: [] };
  }

  const safeGap = Math.max(0, Math.round(gap));
  let baseWidths: number[] = [];
  let baseHeights: number[] = [];

  if (direction === 'vertical') {
    // Normalize to median/capped width (max 2000px for crisp manageable exports)
    const targetW =
      scaleMode === 'normalize'
        ? Math.min(2000, Math.max(...items.map((it) => it.width)))
        : Math.max(...items.map((it) => it.width));

    baseWidths = items.map((it) => (scaleMode === 'normalize' ? targetW : it.width));
    baseHeights = items.map((it, idx) =>
      scaleMode === 'normalize' ? Math.max(1, Math.round((it.height * baseWidths[idx]) / it.width)) : it.height,
    );
  } else {
    const targetH =
      scaleMode === 'normalize'
        ? Math.min(2000, Math.max(...items.map((it) => it.height)))
        : Math.max(...items.map((it) => it.height));

    baseHeights = items.map((it) => (scaleMode === 'normalize' ? targetH : it.height));
    baseWidths = items.map((it, idx) =>
      scaleMode === 'normalize' ? Math.max(1, Math.round((it.width * baseHeights[idx]) / it.height)) : it.width,
    );
  }

  let totalW: number;
  let totalH: number;
  if (direction === 'vertical') {
    totalW = Math.max(...baseWidths) + safeGap * 2;
    totalH = baseHeights.reduce((acc, h) => acc + h, 0) + safeGap * (items.length + 1);
  } else {
    totalW = baseWidths.reduce((acc, w) => acc + w, 0) + safeGap * (items.length + 1);
    totalH = Math.max(...baseHeights) + safeGap * 2;
  }

  const limit = maxPreviewExtent > 0 ? maxPreviewExtent : MAX_STITCH_CANVAS_EXTENT;
  const maxDim = Math.max(totalW, totalH);
  const clamped = maxPreviewExtent === 0 && maxDim > MAX_STITCH_CANVAS_EXTENT;
  const shrink = maxDim > limit ? limit / maxDim : 1;

  const finalW = Math.max(1, Math.round(totalW * shrink));
  const finalH = Math.max(1, Math.round(totalH * shrink));
  const scaledGap = safeGap * shrink;

  const placements: StitchLayoutResult['placements'] = [];
  if (direction === 'vertical') {
    let cursorY = scaledGap;
    for (let i = 0; i < items.length; i += 1) {
      const w = Math.max(1, Math.round(baseWidths[i] * shrink));
      const h = Math.max(1, Math.round(baseHeights[i] * shrink));
      const x = Math.round((finalW - w) / 2);
      placements.push({ item: items[i], x, y: Math.round(cursorY), w, h });
      cursorY += h + scaledGap;
    }
  } else {
    let cursorX = scaledGap;
    for (let i = 0; i < items.length; i += 1) {
      const w = Math.max(1, Math.round(baseWidths[i] * shrink));
      const h = Math.max(1, Math.round(baseHeights[i] * shrink));
      const y = Math.round((finalH - h) / 2);
      placements.push({ item: items[i], x: Math.round(cursorX), y, w, h });
      cursorX += w + scaledGap;
    }
  }

  return { width: finalW, height: finalH, clamped, placements };
}

function paintStitchCanvas(
  canvas: HTMLCanvasElement,
  layout: StitchLayoutResult,
  bgHex: string,
): void {
  if (layout.width <= 0 || layout.height <= 0) return;
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (const p of layout.placements) {
    ctx.drawImage(p.item.img, p.x, p.y, p.w, p.h);
  }
}

export default function WatermarkPdfTool() {
  const [subMode, setSubMode] = useState<ToolSubMode>('watermark');

  // Strict object URL registry for zero memory leaks
  const ownedUrlsRef = useRef<Set<string>>(new Set());
  const trackUrl = useCallback((url: string) => {
    ownedUrlsRef.current.add(url);
    return url;
  }, []);
  const releaseUrl = useCallback((url: string | undefined) => {
    if (!url) return;
    if (ownedUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      ownedUrlsRef.current.delete(url);
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const url of ownedUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      ownedUrlsRef.current.clear();
    };
  }, []);

  // ===================== MODE A: ID Security Watermark =====================
  const [docSource, setDocSource] = useState<LoadedDocumentSource | null>(null);
  const [wmText, setWmText] = useState<string>(WATERMARK_PRESETS[0]);
  const [appendDate, setAppendDate] = useState<boolean>(false);
  const [angleDeg, setAngleDeg] = useState<number>(-28);
  const [opacityPct, setOpacityPct] = useState<number>(24);
  const [fontSizeScale, setFontSizeScale] = useState<number>(28);
  const [spacingFactor, setSpacingFactor] = useState<number>(1.55);
  const [tone, setTone] = useState<WatermarkTone>('postmark');
  const [isDraggingWm, setIsDraggingWm] = useState<boolean>(false);
  const [wmError, setWmError] = useState<string>('');
  const [exportingWm, setExportingWm] = useState<boolean>(false);

  const wmInputRef = useRef<HTMLInputElement | null>(null);
  const wmCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const docSourceRef = useRef<LoadedDocumentSource | null>(null);
  docSourceRef.current = docSource;

  const effectiveWmText = useMemo(() => {
    const base = wmText.trim();
    if (!base) return '';
    return appendDate ? `${base} · ${todayDashDate()}` : base;
  }, [wmText, appendDate]);

  const activeToneHex = useMemo(
    () => WATERMARK_TONES.find((t) => t.id === tone)?.hex ?? '#9A5B42',
    [tone],
  );

  const loadMockSpecimen = useCallback(async () => {
    setWmError('');
    try {
      const dataUrl = buildMockSpecimenDataUrl();
      if (!dataUrl) return;
      const img = await loadImage(dataUrl);
      if (docSourceRef.current?.isOwnedUrl) {
        releaseUrl(docSourceRef.current.url);
      }
      setDocSource({
        name: 'specimen-id-card.png',
        url: dataUrl,
        isOwnedUrl: false,
        isMock: true,
        img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    } catch {
      setWmError('初始化示意样张失败，请直接拖入本地图片。');
    }
  }, [releaseUrl]);

  const loadLocalDocument = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|bmp)$/i.test(file.name)) {
        setWmError('请选取 JPG、PNG 或 WebP 格式的证件或扫描件。');
        return;
      }
      setWmError('');
      const objUrl = trackUrl(URL.createObjectURL(file));
      try {
        const img = await loadImage(objUrl);
        if (docSourceRef.current?.isOwnedUrl) {
          releaseUrl(docSourceRef.current.url);
        }
        setDocSource({
          name: file.name,
          url: objUrl,
          isOwnedUrl: true,
          isMock: false,
          img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        });
      } catch (err) {
        releaseUrl(objUrl);
        setWmError(err instanceof Error ? err.message : '读取影像失败。');
      }
    },
    [releaseUrl, trackUrl],
  );

  // Initialize synthetic specimen once on mount so preview is immediately interactive
  useEffect(() => {
    if (!docSourceRef.current) {
      void loadMockSpecimen();
    }
  }, [loadMockSpecimen]);

  // Live preview render
  useEffect(() => {
    if (subMode !== 'watermark' || !docSource || !wmCanvasRef.current) return;
    renderWatermarkedCanvas(wmCanvasRef.current, {
      img: docSource.img,
      text: effectiveWmText,
      angleDeg,
      opacity: opacityPct / 100,
      fontSizeScale,
      spacingFactor,
      colorHex: activeToneHex,
      maxEdge: 1400,
    });
  }, [
    subMode,
    docSource,
    effectiveWmText,
    angleDeg,
    opacityPct,
    fontSizeScale,
    spacingFactor,
    activeToneHex,
  ]);

  const handleWmFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void loadLocalDocument(file);
  };

  const handleWmDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingWm(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadLocalDocument(file);
  };

  const exportWatermarkedImage = async (mime: 'image/png' | 'image/jpeg') => {
    if (!docSource) return;
    setExportingWm(true);
    setWmError('');
    try {
      const offscreen = document.createElement('canvas');
      renderWatermarkedCanvas(offscreen, {
        img: docSource.img,
        text: effectiveWmText,
        angleDeg,
        opacity: opacityPct / 100,
        fontSizeScale,
        spacingFactor,
        colorHex: activeToneHex,
        maxEdge: 0,
      });

      const blob = await new Promise<Blob>((resolve, reject) => {
        offscreen.toBlob(
          (res) => (res ? resolve(res) : reject(new Error('导出带水印图像失败。'))),
          mime,
          mime === 'image/jpeg' ? 0.94 : undefined,
        );
      });

      const ext = mime === 'image/png' ? 'png' : 'jpg';
      triggerDownload(blob, `${sanitizeFilename(docSource.name)}-watermarked.${ext}`);
    } catch (err) {
      setWmError(err instanceof Error ? err.message : '导出失败。');
    } finally {
      setExportingWm(false);
    }
  };

  // ===================== MODE B: Seamless Stitch & Offline PDF =====================
  const [stitchItems, setStitchItems] = useState<StitchImageItem[]>([]);
  const [direction, setDirection] = useState<StitchDirection>('vertical');
  const [scaleMode, setScaleMode] = useState<StitchScaleMode>('normalize');
  const [gapPx, setGapPx] = useState<number>(12);
  const [bgHex, setBgHex] = useState<string>('#FFFFFF');
  const [pdfPageMode, setPdfPageMode] = useState<PdfPageMode>('a4-auto');
  const [isDraggingStitch, setIsDraggingStitch] = useState<boolean>(false);
  const [stitchError, setStitchError] = useState<string>('');
  const [stitchNotice, setStitchNotice] = useState<string>('');
  const [exportingStitch, setExportingStitch] = useState<boolean>(false);

  const stitchInputRef = useRef<HTMLInputElement | null>(null);
  const stitchPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const addStitchFiles = useCallback(
    async (files: File[]) => {
      const valid = files.filter(
        (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp)$/i.test(f.name),
      );
      if (valid.length === 0) {
        setStitchError('请选取 JPG、PNG 或 WebP 图像。');
        return;
      }
      setStitchError('');
      setStitchNotice('');

      const added: StitchImageItem[] = [];
      for (let i = 0; i < valid.length; i += 1) {
        const file = valid[i];
        const url = trackUrl(URL.createObjectURL(file));
        try {
          const img = await loadImage(url);
          added.push({
            id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            url,
            isOwnedUrl: true,
            img,
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
          });
        } catch {
          releaseUrl(url);
        }
      }

      if (added.length > 0) {
        setStitchItems((prev) => [...prev, ...added]);
      } else {
        setStitchError('所选文件无法作为影像解码。');
      }
    },
    [releaseUrl, trackUrl],
  );

  const loadSampleStitchSet = useCallback(async () => {
    setStitchError('');
    setStitchNotice('');
    const samples = [
      { url: '/demo/mountain.jpg', name: '01-mountain.jpg' },
      { url: '/demo/lake.jpg', name: '02-lake.jpg' },
    ];
    try {
      const loaded: StitchImageItem[] = [];
      for (let i = 0; i < samples.length; i += 1) {
        const img = await loadImage(samples[i].url);
        loaded.push({
          id: `sample-${Date.now()}-${i}`,
          name: samples[i].name,
          url: samples[i].url,
          isOwnedUrl: false,
          img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        });
      }
      setStitchItems((prev) => [...prev, ...loaded]);
    } catch {
      setStitchError('加载示例图组失败，请拖入本地图片。');
    }
  }, []);

  const moveStitchItem = (index: number, delta: -1 | 1) => {
    setStitchItems((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const removeStitchItem = (id: string) => {
    setStitchItems((prev) => {
      const found = prev.find((it) => it.id === id);
      if (found?.isOwnedUrl) releaseUrl(found.url);
      return prev.filter((it) => it.id !== id);
    });
  };

  const clearStitchItems = () => {
    for (const item of stitchItems) {
      if (item.isOwnedUrl) releaseUrl(item.url);
    }
    setStitchItems([]);
    setStitchError('');
    setStitchNotice('');
  };

  const fullStitchLayout = useMemo(
    () => computeStitchLayout(stitchItems, direction, scaleMode, gapPx, 0),
    [stitchItems, direction, scaleMode, gapPx],
  );

  const previewStitchLayout = useMemo(
    () => computeStitchLayout(stitchItems, direction, scaleMode, gapPx, 1600),
    [stitchItems, direction, scaleMode, gapPx],
  );

  // Paint live stitch preview whenever order or settings change
  useEffect(() => {
    if (subMode !== 'stitch' || stitchItems.length === 0 || !stitchPreviewCanvasRef.current) return;
    paintStitchCanvas(stitchPreviewCanvasRef.current, previewStitchLayout, bgHex);
  }, [subMode, stitchItems.length, previewStitchLayout, bgHex]);

  const handleStitchFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (files.length > 0) void addStitchFiles(files);
  };

  const handleStitchDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingStitch(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void addStitchFiles(files);
  };

  const handleExportLongImage = async (mime: 'image/png' | 'image/jpeg') => {
    if (stitchItems.length === 0) return;
    setExportingStitch(true);
    setStitchError('');
    setStitchNotice('');
    try {
      const offscreen = document.createElement('canvas');
      paintStitchCanvas(offscreen, fullStitchLayout, bgHex);

      const blob = await new Promise<Blob>((resolve, reject) => {
        offscreen.toBlob(
          (res) => (res ? resolve(res) : reject(new Error('长图编码失败，请尝试缩小图片数量或导出多页 PDF。'))),
          mime,
          mime === 'image/jpeg' ? 0.92 : undefined,
        );
      });

      const ext = mime === 'image/png' ? 'png' : 'jpg';
      const stamp = todayDashDate().replaceAll('-', '');
      triggerDownload(blob, `stitched-${direction}-${stamp}.${ext}`);
      setStitchNotice(
        `已导出 ${fullStitchLayout.width}×${fullStitchLayout.height} px ${ext.toUpperCase()} 长图。`,
      );
    } catch (err) {
      setStitchError(err instanceof Error ? err.message : '长图导出失败。');
    } finally {
      setExportingStitch(false);
    }
  };

  const handleExportPdf = async () => {
    if (stitchItems.length === 0) return;
    setExportingStitch(true);
    setStitchError('');
    setStitchNotice('');
    try {
      const bgDef = STITCH_BG_OPTIONS.find((b) => b.hex === bgHex) ?? STITCH_BG_OPTIONS[0];
      const pages = [];
      for (const item of stitchItems) {
        const page = await renderSourceToPdfPage(item.img, {
          maxEdge: 2400,
          quality: 0.9,
          backgroundColor: bgDef.hex,
        });
        pages.push(page);
      }

      const pdfBlob = buildJpegPdfBlob(pages, {
        pageMode: pdfPageMode,
        marginPt: pdfPageMode === 'fit-image' ? 0 : 28,
        backgroundRgb: bgDef.rgb,
        title: `Merged ${pages.length} Pages`,
      });

      const stamp = todayDashDate().replaceAll('-', '');
      triggerDownload(pdfBlob, `offline-document-${stamp}.pdf`);
      setStitchNotice(`已本地合成 ${pages.length} 页 ISO PDF 1.4 文档（零外部依赖）。`);
    } catch (err) {
      setStitchError(err instanceof Error ? err.message : '离线 PDF 合成失败。');
    } finally {
      setExportingStitch(false);
    }
  };

  return (
    <div className="min-w-0 space-y-5 rounded-[24px] border border-hairline bg-surface p-4 sm:p-6">
      {/* Sub-mode Toggle & Explicit Privacy Strip */}
      <div className="flex flex-col gap-3 border-b border-hairline pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="水印与文档模式"
          className="inline-flex w-full shrink-0 rounded-full border border-hairline bg-paper p-1 sm:w-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subMode === 'watermark'}
            onClick={() => setSubMode('watermark')}
            className={[
              'flex flex-1 items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors sm:flex-initial',
              subMode === 'watermark'
                ? 'bg-cta-bg text-cta-text'
                : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            <Stamp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>证件防盗水印</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subMode === 'stitch'}
            onClick={() => setSubMode('stitch')}
            className={[
              'flex flex-1 items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors sm:flex-initial',
              subMode === 'stitch'
                ? 'bg-cta-bg text-cta-text'
                : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>长图拼接 &amp; PDF</span>
          </button>
        </div>

        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 py-1 text-[12px] text-postmark">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>纯本地处理 · 影像永不离开设备</span>
        </span>
      </div>

      {/* ===================== MODE A: ID Security Watermark ===================== */}
      {subMode === 'watermark' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
          {/* Left: Live Watermark Canvas */}
          <div className="min-w-0 space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingWm(true);
              }}
              onDragLeave={() => setIsDraggingWm(false)}
              onDrop={handleWmDrop}
              className={[
                'flex min-h-[320px] flex-col items-center justify-center rounded-[22px] border p-4 transition-colors sm:p-6',
                isDraggingWm
                  ? 'border-dashed border-accent bg-surface-hover'
                  : 'border-hairline bg-page/75',
              ].join(' ')}
            >
              {docSource ? (
                <canvas
                  ref={wmCanvasRef}
                  aria-label="证件防盗水印实时预览画布"
                  className="block h-auto max-h-[62vh] w-auto max-w-full rounded-[12px] border border-hairline shadow-xs"
                />
              ) : (
                <div className="py-12 text-[13.5px] text-ink-muted">正在准备画布...</div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-hairline bg-paper px-4 py-2.5 text-[12px] text-ink-muted">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums-mono">
                  {docSource ? `${docSource.width} × ${docSource.height} px` : '--'}
                </span>
                {docSource?.isMock && (
                  <span className="rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11px]">
                    本地合成示意样张 · 拖入真实扫描件即可替换
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void loadMockSpecimen()}
                className="rounded-full border border-hairline bg-surface px-2.5 py-1 text-[11.5px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
              >
                恢复示意样张
              </button>
            </div>

            {wmError && (
              <div
                role="alert"
                className="rounded-[14px] border border-hairline bg-paper px-4 py-3 text-[13px] text-postmark"
              >
                {wmError}
              </div>
            )}
          </div>

          {/* Right: Watermark Controls */}
          <div className="min-w-0 space-y-4 rounded-[22px] border border-hairline bg-paper p-4 sm:p-5">
            <input
              ref={wmInputRef}
              type="file"
              accept="image/*"
              onChange={handleWmFileChange}
              className="sr-only"
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13.5px] font-medium text-ink">水印样式与防盗参数</span>
              <button
                type="button"
                onClick={() => wmInputRef.current?.click()}
                className="pill-cta-secondary min-h-[36px] px-3.5 text-[12.5px]"
              >
                <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                <span>选取证件 / 合同</span>
              </button>
            </div>

            {/* Watermark Text + Presets */}
            <div className="space-y-2">
              <label className="block">
                <span className="text-[12px] text-ink-muted">水印用途文案</span>
                <input
                  type="text"
                  value={wmText}
                  onChange={(e) => setWmText(e.target.value)}
                  placeholder="例如：仅供办理宽带业务使用，他用无效"
                  className="mt-1 w-full rounded-[12px] border border-hairline bg-surface px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-muted/60"
                />
              </label>

              <div className="flex flex-wrap gap-1.5">
                {WATERMARK_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setWmText(preset)}
                    className={[
                      'rounded-full border px-2.5 py-1 text-left text-[11.5px] transition-colors',
                      wmText === preset
                        ? 'border-accent/40 bg-surface font-medium text-accent'
                        : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                    ].join(' ')}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <label className="inline-flex cursor-pointer items-center gap-2 pt-1 text-[12.5px] text-ink-muted">
                <input
                  type="checkbox"
                  checked={appendDate}
                  onChange={(e) => setAppendDate(e.target.checked)}
                  className="h-4 w-4 rounded accent-accent"
                />
                <span>自动附加今日日期（{todayDashDate()}）</span>
              </label>
            </div>

            {/* Sliders */}
            <div className="space-y-3.5 border-t border-hairline pt-3.5">
              <div>
                <div className="flex justify-between text-[12px]">
                  <span className="text-ink-muted">倾斜角度</span>
                  <span className="tabular-nums-mono font-medium text-ink">{angleDeg}°</span>
                </div>
                <input
                  type="range"
                  aria-label="倾斜角度"
                  min={-45}
                  max={45}
                  step={1}
                  value={angleDeg}
                  onChange={(e) => setAngleDeg(Number(e.target.value))}
                  className="mt-1.5 w-full cursor-pointer accent-accent"
                />
              </div>

              <div>
                <div className="flex justify-between text-[12px]">
                  <span className="text-ink-muted">不透明度</span>
                  <span className="tabular-nums-mono font-medium text-ink">{opacityPct}%</span>
                </div>
                <input
                  type="range"
                  aria-label="不透明度"
                  min={8}
                  max={65}
                  step={1}
                  value={opacityPct}
                  onChange={(e) => setOpacityPct(Number(e.target.value))}
                  className="mt-1.5 w-full cursor-pointer accent-accent"
                />
              </div>

              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div>
                  <div className="flex justify-between text-[12px]">
                    <span className="text-ink-muted">相对字号</span>
                    <span className="tabular-nums-mono font-medium text-ink">{fontSizeScale} px</span>
                  </div>
                  <input
                    type="range"
                    aria-label="相对字号"
                    min={14}
                    max={64}
                    step={1}
                    value={fontSizeScale}
                    onChange={(e) => setFontSizeScale(Number(e.target.value))}
                    className="mt-1.5 w-full cursor-pointer accent-accent"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[12px]">
                    <span className="text-ink-muted">平铺间距</span>
                    <span className="tabular-nums-mono font-medium text-ink">
                      {spacingFactor.toFixed(2)}×
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="平铺间距"
                    min={100}
                    max={260}
                    step={5}
                    value={Math.round(spacingFactor * 100)}
                    onChange={(e) => setSpacingFactor(Number(e.target.value) / 100)}
                    className="mt-1.5 w-full cursor-pointer accent-accent"
                  />
                </div>
              </div>

              {/* Color Swatches */}
              <div>
                <div className="text-[12px] text-ink-muted">水印色彩</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {WATERMARK_TONES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={tone === t.id}
                      onClick={() => setTone(t.id)}
                      className={[
                        'inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                        tone === t.id
                          ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                          : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                      ].join(' ')}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: t.hex,
                          border: `1px solid ${t.swatchBorder}`,
                        }}
                        aria-hidden="true"
                      />
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Export Buttons */}
            <div className="grid grid-cols-1 gap-2.5 border-t border-hairline pt-3.5 sm:grid-cols-2">
              <button
                type="button"
                disabled={!docSource || exportingWm}
                onClick={() => void exportWatermarkedImage('image/png')}
                className="pill-cta-primary min-h-[42px] px-4 text-[13.5px] disabled:opacity-45"
              >
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>下载无损 PNG</span>
              </button>
              <button
                type="button"
                disabled={!docSource || exportingWm}
                onClick={() => void exportWatermarkedImage('image/jpeg')}
                className="pill-cta-secondary min-h-[42px] px-4 text-[13.5px] disabled:opacity-45"
              >
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>下载高清 JPEG</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== MODE B: Multi-Image Stitch & Offline PDF ===================== */}
      {subMode === 'stitch' && (
        <div className="space-y-5">
          {/* Upload Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingStitch(true);
            }}
            onDragLeave={() => setIsDraggingStitch(false)}
            onDrop={handleStitchDrop}
            className={[
              'rounded-[20px] border border-dashed p-5 text-center transition-colors sm:p-7',
              isDraggingStitch
                ? 'border-accent bg-surface-hover'
                : 'border-hairline-strong bg-paper/75 hover:bg-paper',
            ].join(' ')}
          >
            <input
              ref={stitchInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleStitchFileChange}
              className="sr-only"
            />
            <p className="m-0 text-[15px] font-medium text-ink">
              拖入多张截图、扫描页或照片，自由排序拼接长图或合成 PDF
            </p>
            <p className="mt-1 mb-0 text-[12.5px] text-ink-muted">
              离线 PDF 采用纯 TypeScript ISO PDF 1.4 编码器直接封装 JPEG XObject，零外链依赖
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => stitchInputRef.current?.click()}
                className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]"
              >
                <ImageIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>添加多张图片</span>
              </button>
              <button
                type="button"
                onClick={() => void loadSampleStitchSet()}
                className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
              >
                <span>添加示例图组</span>
              </button>
              {stitchItems.length > 0 && (
                <button
                  type="button"
                  onClick={clearStitchItems}
                  className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>清空队列</span>
                </button>
              )}
            </div>
          </div>

          {stitchError && (
            <div
              role="alert"
              className="rounded-[14px] border border-hairline bg-paper px-4 py-3 text-[13px] text-postmark"
            >
              {stitchError}
            </div>
          )}

          {stitchNotice && (
            <div
              role="status"
              className="rounded-[14px] border border-hairline bg-paper px-4 py-3 text-[13px] text-accent"
            >
              {stitchNotice}
            </div>
          )}

          {stitchItems.length > 0 && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.15fr)]">
              {/* Left: Reorder Queue + Controls */}
              <div className="min-w-0 space-y-4">
                {/* Layout & PDF Controls */}
                <div className="space-y-4 rounded-[20px] border border-hairline bg-paper p-4 sm:p-5">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <div className="text-[12px] text-ink-muted">拼接方向</div>
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          type="button"
                          aria-pressed={direction === 'vertical'}
                          onClick={() => setDirection('vertical')}
                          className={[
                            'flex-1 rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                            direction === 'vertical'
                              ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                              : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                          ].join(' ')}
                        >
                          纵向长图
                        </button>
                        <button
                          type="button"
                          aria-pressed={direction === 'horizontal'}
                          onClick={() => setDirection('horizontal')}
                          className={[
                            'flex-1 rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                            direction === 'horizontal'
                              ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                              : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                          ].join(' ')}
                        >
                          横向长卷
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="text-[12px] text-ink-muted">尺寸对齐</div>
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          type="button"
                          aria-pressed={scaleMode === 'normalize'}
                          onClick={() => setScaleMode('normalize')}
                          className={[
                            'flex-1 rounded-full border px-2.5 py-1.5 text-[12px] transition-colors',
                            scaleMode === 'normalize'
                              ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                              : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                          ].join(' ')}
                        >
                          等宽 / 等高对齐
                        </button>
                        <button
                          type="button"
                          aria-pressed={scaleMode === 'natural'}
                          onClick={() => setScaleMode('natural')}
                          className={[
                            'flex-1 rounded-full border px-2.5 py-1.5 text-[12px] transition-colors',
                            scaleMode === 'natural'
                              ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                              : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                          ].join(' ')}
                        >
                          原始居中
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                    <div>
                      <div className="flex justify-between text-[12px]">
                        <span className="text-ink-muted">图间缝隙</span>
                        <span className="tabular-nums-mono font-medium text-ink">
                          {gapPx === 0 ? '0px 无缝' : `${gapPx}px`}
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label="图间缝隙"
                        min={0}
                        max={64}
                        step={4}
                        value={gapPx}
                        onChange={(e) => setGapPx(Number(e.target.value))}
                        className="mt-1.5 w-full cursor-pointer accent-accent"
                      />
                    </div>

                    <div>
                      <div className="text-[12px] text-ink-muted">画布底色</div>
                      <div className="mt-1.5 flex gap-1.5">
                        {STITCH_BG_OPTIONS.map((bg) => (
                          <button
                            key={bg.hex}
                            type="button"
                            aria-pressed={bgHex === bg.hex}
                            onClick={() => setBgHex(bg.hex)}
                            className={[
                              'inline-flex flex-1 items-center justify-center gap-1 rounded-full border px-2 py-1.5 text-[11.5px] transition-colors',
                              bgHex === bg.hex
                                ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                                : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                            ].join(' ')}
                          >
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/20"
                              style={{ backgroundColor: bg.hex }}
                              aria-hidden="true"
                            />
                            <span>{bg.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-hairline pt-3">
                    <div className="text-[12px] text-ink-muted">多页 PDF 页面规格</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {PDF_MODE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          aria-pressed={pdfPageMode === opt.value}
                          onClick={() => setPdfPageMode(opt.value)}
                          className={[
                            'rounded-full border px-3 py-1 text-[12px] transition-colors',
                            pdfPageMode === opt.value
                              ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                              : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                          ].join(' ')}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Export Action Row */}
                  <div className="space-y-2 border-t border-hairline pt-3.5">
                    <button
                      type="button"
                      disabled={exportingStitch}
                      onClick={() => void handleExportPdf()}
                      className="pill-cta-primary w-full min-h-[42px] text-[13.5px] disabled:opacity-45"
                    >
                      <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>
                        {exportingStitch
                          ? '正在封装文档...'
                          : `合成离线多页 PDF（共 ${stitchItems.length} 页）`}
                      </span>
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={exportingStitch}
                        onClick={() => void handleExportLongImage('image/png')}
                        className="pill-cta-secondary min-h-[40px] px-3 text-[12.5px] disabled:opacity-45"
                      >
                        <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>导出长图 PNG</span>
                      </button>
                      <button
                        type="button"
                        disabled={exportingStitch}
                        onClick={() => void handleExportLongImage('image/jpeg')}
                        className="pill-cta-secondary min-h-[40px] px-3 text-[12.5px] disabled:opacity-45"
                      >
                        <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>导出长图 JPEG</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Reorderable Item List */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-1 text-[12px] text-ink-muted">
                    <span>排序列表（决定拼接顺序与 PDF 页序）</span>
                    <span className="tabular-nums-mono">{stitchItems.length} 张</span>
                  </div>
                  <div className="max-h-[360px] space-y-2 overflow-y-auto pr-0.5">
                    {stitchItems.map((item, idx) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 rounded-[14px] border border-hairline bg-paper p-2.5"
                      >
                        <span className="tabular-nums-mono flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper text-[11.5px] font-medium text-ink-muted">
                          {idx + 1}
                        </span>
                        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-[8px] border border-hairline bg-paper">
                          <img
                            src={item.url}
                            alt={item.name}
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-ink">
                            {item.name}
                          </div>
                          <div className="tabular-nums-mono text-[11.5px] text-ink-muted">
                            {item.width} × {item.height} px
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            disabled={idx === 0}
                            aria-label={`上移 ${item.name}`}
                            onClick={() => moveStitchItem(idx, -1)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-paper text-ink-muted transition-colors hover:text-ink disabled:opacity-35"
                          >
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === stitchItems.length - 1}
                            aria-label={`下移 ${item.name}`}
                            onClick={() => moveStitchItem(idx, 1)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-paper text-ink-muted transition-colors hover:text-ink disabled:opacity-35"
                          >
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`移除 ${item.name}`}
                            onClick={() => removeStitchItem(item.id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-paper text-ink-muted transition-colors hover:text-postmark"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right: Live Stitched Preview Stage */}
              <div className="min-w-0 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[12px] text-ink-muted">
                  <span>实时长图拼接预览</span>
                  <span className="tabular-nums-mono">
                    导出尺寸约 {fullStitchLayout.width} × {fullStitchLayout.height} px
                    {fullStitchLayout.clamped ? '（已自动限幅保护内存）' : ''}
                  </span>
                </div>
                <div className="max-h-[620px] overflow-auto rounded-[22px] border border-hairline bg-page/75 p-4">
                  <div className="flex min-h-[260px] items-start justify-center">
                    <canvas
                      ref={stitchPreviewCanvasRef}
                      aria-label="多图长图拼接实时预览画布"
                      className={
                        direction === 'vertical'
                          ? 'block h-auto w-full max-w-[460px] rounded-[8px] border border-hairline shadow-xs'
                          : 'block h-[260px] w-auto max-w-none rounded-[8px] border border-hairline shadow-xs'
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
