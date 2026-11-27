import { Hono } from 'hono';
import { ApiError } from '../../shared/errors';
import { extractJpegExif } from '../../shared/exif-jpeg';
import { CLOUD_MEDIA_LIMITS, SUPPORTED_FORMATS } from '../../shared/media-formats';
import {
  DEFAULT_SITE_SETTINGS,
  type ExifSummary,
  type Journey,
  type Library,
  type Media,
  type SiteSettings,
  type Stop,
} from '../../shared/types';
import { coordinates, date, id, object, text } from '../../shared/validators';
import { requireCloudAdmin, timingSafeEqualText } from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';

export const atlasRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{12,48}$/;

type MediaRow = {
  id: string;
  data: string;
  original: string;
  thumbnail: string;
  preview: string;
  hash: string | null;
};

const TIANDITU_LAYERS = new Set(['vec_w', 'cva_w', 'img_w', 'cia_w', 'ter_w', 'cta_w']);

function parseSiteSettings(data?: string): SiteSettings {
  if (!data) return { ...DEFAULT_SITE_SETTINGS };
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_SITE_SETTINGS };
    }
    return { ...DEFAULT_SITE_SETTINGS, ...(parsed as Partial<SiteSettings>) };
  } catch {
    return { ...DEFAULT_SITE_SETTINGS };
  }
}

async function matchesShareToken(journey: Journey, shareParam: string): Promise<boolean> {
  if (!shareParam || journey.visibility !== 'private') return false;
  if (typeof journey.shareToken !== 'string' || !SHARE_TOKEN_RE.test(journey.shareToken)) {
    return false;
  }
  return timingSafeEqualText(journey.shareToken, shareParam);
}

function isMediaInHomeShowcase(settings: SiteSettings, mediaId: string): boolean {
  if (!Array.isArray(settings.homeShowcase)) return false;
  const prefix = `/api/files/${mediaId}`;
  return settings.homeShowcase.some(
    (frame) =>
      frame &&
      typeof frame === 'object' &&
      (frame.mediaId === mediaId ||
        frame.src === prefix ||
        (typeof frame.src === 'string' && frame.src.startsWith(`${prefix}?`))),
  );
}

function sniffImageKind(bytes: Uint8Array, ext: string): { mime: string; kind: Media['kind']; ext: string } | null {
  if (bytes.length < 4) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', kind: 'image', ext: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { mime: 'image/png', kind: 'image', ext: 'png' };
  }
  // GIF: GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { mime: 'image/gif', kind: 'image', ext: 'gif' };
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: 'image/webp', kind: 'image', ext: 'webp' };
  }
  // ISO BMFF (AVIF / HEIC / MP4 / MOV)
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', kind: 'image', ext: 'avif' };
    if (['heic', 'heix', 'hevc', 'mif1'].includes(brand)) {
      return { mime: 'image/heic', kind: 'image', ext: 'heic' };
    }
    if (['qt  '].includes(brand) || ext === 'mov') {
      return { mime: 'video/quicktime', kind: 'video', ext: 'mov' };
    }
    return { mime: 'video/mp4', kind: 'video', ext: 'mp4' };
  }
  // WebM: 1A 45 DF A3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mime: 'video/webm', kind: 'video', ext: 'webm' };
  }
  // Text formats only when extension explicitly matches
  const matched = SUPPORTED_FORMATS.find((f) => (f.ext as readonly string[]).includes(ext));
  if (matched && (matched.kind === 'document' || matched.kind === 'file')) {
    if (ext === 'pdf' && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return { mime: matched.mime, kind: 'file', ext };
    }
    if (ext === 'zip' && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      return { mime: matched.mime, kind: 'file', ext };
    }
  }
  return null;
}

function parseImageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
  if (mime === 'image/png' && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === 'image/gif' && bytes.length >= 10) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (len < 2 || offset + 2 + len > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
        const h = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const w = (bytes[offset + 7] << 8) | bytes[offset + 8];
        if (w > 0 && h > 0) return { width: w, height: h };
      }
      offset += 2 + len;
    }
  }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === 'VP8X') {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width: w, height: h };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      const w = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const h = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >> 14) & 0x3fff) + 1;
      return { width: w, height: h };
    }
  }
  return { width: 1200, height: 800 };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseExifInput(raw: unknown): ExifSummary | undefined {
  if (!raw) return undefined;
  const obj =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return null;
          }
        })()
      : raw;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const src = obj as Record<string, unknown>;
  const out: ExifSummary = {};
  if (typeof src.make === 'string' && src.make.trim()) out.make = src.make.trim().slice(0, 80);
  if (typeof src.model === 'string' && src.model.trim()) out.model = src.model.trim().slice(0, 80);
  if (typeof src.lens === 'string' && src.lens.trim()) out.lens = src.lens.trim().slice(0, 120);
  if (typeof src.focalLength === 'string' && src.focalLength.trim()) {
    out.focalLength = src.focalLength.trim().slice(0, 30);
  }
  if (typeof src.aperture === 'string' && src.aperture.trim()) {
    out.aperture = src.aperture.trim().slice(0, 30);
  }
  if (typeof src.shutter === 'string' && src.shutter.trim()) {
    out.shutter = src.shutter.trim().slice(0, 30);
  }
  if (typeof src.iso === 'number' && Number.isFinite(src.iso) && src.iso > 0) {
    out.iso = Math.round(src.iso);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseSingleByteRange(
  header: string | null | undefined,
  total: number,
): { start: number; end: number } | 'none' | 'invalid' {
  if (!header) return 'none';
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || total <= 0) return 'invalid';
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'invalid';
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) {
      return 'invalid';
    }
    end = Math.min(end, total - 1);
  }
  return { start, end };
}

function contentTypeForKey(key: string, fallbackMime: string): string {
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.png')) return 'image/png';
  return fallbackMime || 'application/octet-stream';
}

atlasRoutes.get('/api/library', async (c) => {
  const db = c.get('costEnv').DB;
  const ctx = c.get('cloudCtx');

  const [journeyRows, mediaRows, settingsRow] = await Promise.all([
    db.prepare('SELECT data FROM journeys ORDER BY rowid DESC').all<{ data: string }>(),
    db.prepare('SELECT data FROM media ORDER BY rowid DESC').all<{ data: string }>(),
    db.prepare("SELECT data FROM admin_settings WHERE key='site'").first<{ data: string }>(),
  ]);

  let journeys = journeyRows.results.map((r) => JSON.parse(r.data) as Journey);
  let media = mediaRows.results.map((r) => JSON.parse(r.data) as Media);

  if (!ctx.authenticated) {
    const rawShare = c.req.query('share')?.trim() || '';
    const shareParam = SHARE_TOKEN_RE.test(rawShare) ? rawShare : '';

    const visibleJourneys: Journey[] = [];
    for (const journey of journeys) {
      if (journey.visibility === 'public' || (await matchesShareToken(journey, shareParam))) {
        visibleJourneys.push(journey);
      }
    }

    const visibleMediaIds = new Set<string>();
    for (const journey of visibleJourneys) {
      if (journey.coverId) visibleMediaIds.add(journey.coverId);
      for (const stop of journey.stops) {
        for (const mediaId of stop.mediaIds) {
          visibleMediaIds.add(mediaId);
        }
      }
    }
    journeys = visibleJourneys.map(({ shareToken: _hidden, ...safeJourney }) => safeJourney);
    media = media.filter((m) => visibleMediaIds.has(m.id));
  }

  journeys.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const settings = parseSiteSettings(settingsRow?.data);

  const library: Library = {
    journeys,
    media,
    settings,
    access: {
      protected: true,
      role: ctx.authenticated ? 'owner' : 'visitor',
    },
  };

  const body = JSON.stringify(library);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const etag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}"`;
  const unchanged = (c.req.header('if-none-match') || '')
    .split(',')
    .some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);

  return new Response(unchanged ? null : body, {
    status: unchanged ? 304 : 200,
    headers: {
      ETag: etag,
      Vary: 'Cookie',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
});

atlasRoutes.get('/api/atlas/config', (c) => {
  return c.json({ tiandituConfigured: Boolean(c.env.TIANDITU_KEY) });
});

atlasRoutes.get('/api/atlas/tiles/:layer/:z/:y/:x', async (c) => {
  const layer = c.req.param('layer');
  const zRaw = c.req.param('z');
  const yRaw = c.req.param('y');
  const xRaw = c.req.param('x');

  if (!TIANDITU_LAYERS.has(layer)) {
    throw new ApiError('不支持的地图图层', 400);
  }
  if (!/^\d+$/.test(zRaw) || !/^\d+$/.test(yRaw) || !/^\d+$/.test(xRaw)) {
    throw new ApiError('无效的瓦片坐标', 400);
  }
  const z = Number(zRaw);
  const y = Number(yRaw);
  const x = Number(xRaw);
  const maxCoord = 2 ** z;
  if (z < 0 || z > 18 || x < 0 || y < 0 || x >= maxCoord || y >= maxCoord) {
    throw new ApiError('瓦片坐标超出范围', 400);
  }

  const key = c.env.TIANDITU_KEY?.trim();
  if (!key) {
    return c.json({ error: '未配置天地图密钥' }, 503);
  }

  const tileMatrixSet = 'w';
  const upstreamUrl = `https://t0.tianditu.gov.cn/${layer}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer.slice(0, 3)}&STYLE=default&TILEMATRIXSET=${tileMatrixSet}&FORMAT=tiles&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(6000),
      headers: { Accept: 'image/*' },
    });
    if (!res.ok) {
      return c.json({ error: '地图瓦片服务暂不可用' }, 502);
    }
    const contentType = res.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) {
      return c.json({ error: '地图瓦片响应格式无效' }, 502);
    }
    const body = await res.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return c.json({ error: '地图瓦片请求超时' }, 504);
  }
});

atlasRoutes.on(['GET', 'HEAD'], '/api/files/:mediaId', async (c) => {
  const mediaId = id(c.req.param('mediaId'));
  const variantRaw = c.req.query('variant') || 'preview';
  if (!['thumbnail', 'preview', 'original'].includes(variantRaw)) {
    throw new ApiError('无效的媒体规格参数', 400);
  }
  const variant = variantRaw as 'thumbnail' | 'preview' | 'original';
  const download = c.req.query('download') === '1';

  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');

  const row = await costEnv.DB.prepare('SELECT * FROM media WHERE id=?').bind(mediaId).first<MediaRow>();
  if (!row) {
    throw new ApiError('影像不存在', 404);
  }

  if (!ctx.authenticated) {
    const rawShare = c.req.query('share')?.trim() || '';
    const shareParam = SHARE_TOKEN_RE.test(rawShare) ? rawShare : '';
    const [journeyRows, settingsRow] = await Promise.all([
      costEnv.DB.prepare('SELECT data FROM journeys').all<{ data: string }>(),
      costEnv.DB.prepare("SELECT data FROM admin_settings WHERE key='site'").first<{ data: string }>(),
    ]);
    const allJourneys = journeyRows.results.map((r) => JSON.parse(r.data) as Journey);
    const settings = parseSiteSettings(settingsRow?.data);

    let visible = isMediaInHomeShowcase(settings, mediaId);
    if (!visible) {
      for (const journey of allJourneys) {
        const referencesMedia =
          journey.coverId === mediaId || journey.stops.some((s) => s.mediaIds.includes(mediaId));
        if (!referencesMedia) continue;
        if (journey.visibility === 'public' || (await matchesShareToken(journey, shareParam))) {
          visible = true;
          break;
        }
      }
    }
    if (!visible) {
      throw new ApiError('影像不存在', 404);
    }
  }

  const mediaRecord = JSON.parse(row.data) as Media;
  const key =
    variant === 'thumbnail' ? row.thumbnail : variant === 'original' ? row.original : row.preview;

  const head = await costEnv.MEDIA.head(key);
  if (!head) {
    throw new ApiError('媒体文件不存在', 404);
  }

  const contentType = contentTypeForKey(key, mediaRecord.mime);
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (download) {
    const ext = key.endsWith('.webp') ? '.webp' : '';
    const safeName = `${mediaRecord.name.replace(/["\r\n]/g, '_')}${ext && !mediaRecord.name.endsWith(ext) ? ext : ''}`;
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  }

  const rangeHeader = c.req.header('range');
  const parsedRange = parseSingleByteRange(rangeHeader, head.size);
  if (parsedRange === 'invalid') {
    headers.set('Content-Range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }

  if (c.req.method === 'HEAD') {
    if (parsedRange === 'none') {
      headers.set('Content-Length', String(head.size));
      return new Response(null, { status: 200, headers });
    }
    const len = parsedRange.end - parsedRange.start + 1;
    headers.set('Content-Length', String(len));
    headers.set('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${head.size}`);
    return new Response(null, { status: 206, headers });
  }

  if (parsedRange !== 'none') {
    const len = parsedRange.end - parsedRange.start + 1;
    const obj = await costEnv.MEDIA.get(key, {
      range: { offset: parsedRange.start, length: len },
    });
    if (!obj) throw new ApiError('媒体文件不存在', 404);
    headers.set('Content-Length', String(len));
    headers.set('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${head.size}`);
    return new Response(obj.body, { status: 206, headers });
  }

  const obj = await costEnv.MEDIA.get(key);
  if (!obj) throw new ApiError('媒体文件不存在', 404);
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});

atlasRoutes.post('/api/media', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');

  const contentType = c.req.header('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new ApiError('媒体上传必须使用 multipart/form-data', 415);
  }

  const form = await c.req.formData();
  const entries = form.getAll('files').filter((item): item is File => item instanceof File);
  if (entries.length === 0) {
    throw new ApiError('请选择至少一个要上传的文件', 400);
  }
  if (entries.length > 20) {
    throw new ApiError('单次最多上传 20 个文件', 400);
  }

  const thumbEntry = form.get('thumbnail');
  const previewEntry = form.get('preview');
  const thumbFile = thumbEntry instanceof File ? thumbEntry : null;
  const previewFile = previewEntry instanceof File ? previewEntry : null;
  if (entries.length > 1 && (thumbFile || previewFile)) {
    throw new ApiError('附带缩略图/预览图时每次仅支持上传单个主文件', 400);
  }

  const rawLat = form.get('lat');
  const rawLng = form.get('lng');
  let coords: { lat: number | null; lng: number | null } = { lat: null, lng: null };
  if (
    typeof rawLat === 'string' &&
    rawLat.trim() !== '' &&
    typeof rawLng === 'string' &&
    rawLng.trim() !== ''
  ) {
    coords = coordinates(Number(rawLat), Number(rawLng), false);
  } else if (
    (typeof rawLat === 'string' && rawLat.trim() !== '') ||
    (typeof rawLng === 'string' && rawLng.trim() !== '')
  ) {
    throw new ApiError('经纬度必须成对填写', 400);
  }

  const rawTakenAt = form.get('takenAt');
  const takenAt =
    typeof rawTakenAt === 'string' && rawTakenAt.trim() !== ''
      ? date(rawTakenAt.trim(), '拍摄时间', false)
      : null;

  const rawCaption = form.get('caption');
  const caption =
    typeof rawCaption === 'string' ? text(rawCaption, '影像说明', 2000, false) : '';

  const confirmedParam = form.get('confirmed');
  const explicitConfirmed = confirmedParam === 'true' || confirmedParam === '1';
  const confirmed =
    coords.lat !== null && coords.lng !== null && (confirmedParam === null ? true : explicitConfirmed);

  const parsedExif = parseExifInput(form.get('exif'));
  const rawWidth = Number(form.get('width'));
  const rawHeight = Number(form.get('height'));

  const created: Media[] = [];

  for (const file of entries) {
    if (file.size <= 0) {
      throw new ApiError('上传文件不能为空', 400);
    }
    if (file.size > CLOUD_MEDIA_LIMITS.maxFileBytes) {
      throw new ApiError('文件大小超过 16 MiB 单文件限制', 413);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > CLOUD_MEDIA_LIMITS.maxFileBytes) {
      throw new ApiError('文件大小超过 16 MiB 单文件限制', 413);
    }

    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const detected = sniffImageKind(bytes, ext);
    if (!detected) {
      throw new ApiError('文件格式或内容签名不受支持', 415);
    }

    const embedded = detected.mime === 'image/jpeg' ? extractJpegExif(bytes) : {};
    const effectiveTakenAt = takenAt ?? embedded.takenAt ?? null;
    const effectiveLat = coords.lat ?? embedded.lat ?? null;
    const effectiveLng = coords.lng ?? embedded.lng ?? null;
    const effectiveConfirmed =
      effectiveLat !== null &&
      effectiveLng !== null &&
      (confirmedParam === null ? true : explicitConfirmed);
    const effectiveExif = parsedExif ?? embedded.exif;

    const hash = await sha256Hex(bytes);
    const existing = await costEnv.DB.prepare('SELECT data FROM media WHERE hash=?')
      .bind(hash)
      .first<{ data: string }>();
    if (existing) {
      created.push(JSON.parse(existing.data) as Media);
      continue;
    }

    const mediaId = `m_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const originalKey = `atlas/${mediaId}/original.${detected.ext}`;
    let thumbnailKey = originalKey;
    let previewKey = originalKey;

    await costEnv.MEDIA.put(originalKey, bytes, {
      httpMetadata: { contentType: detected.mime },
    });

    if (thumbFile && thumbFile.size > 0) {
      if (thumbFile.size > CLOUD_MEDIA_LIMITS.maxFileBytes) {
        throw new ApiError('缩略图大小超过 16 MiB 限制', 413);
      }
      const thumbBytes = new Uint8Array(await thumbFile.arrayBuffer());
      const thumbKind = sniffImageKind(thumbBytes, 'webp');
      if (!thumbKind || thumbKind.mime !== 'image/webp') {
        throw new ApiError('缩略图必须为有效的 WebP 格式', 415);
      }
      thumbnailKey = `atlas/${mediaId}/thumb-600.webp`;
      await costEnv.MEDIA.put(thumbnailKey, thumbBytes, {
        httpMetadata: { contentType: 'image/webp' },
      });
    }

    if (previewFile && previewFile.size > 0) {
      if (previewFile.size > CLOUD_MEDIA_LIMITS.maxFileBytes) {
        throw new ApiError('预览图大小超过 16 MiB 限制', 413);
      }
      const prevBytes = new Uint8Array(await previewFile.arrayBuffer());
      const prevKind = sniffImageKind(prevBytes, 'webp');
      if (!prevKind || prevKind.mime !== 'image/webp') {
        throw new ApiError('预览图必须为有效的 WebP 格式', 415);
      }
      previewKey = `atlas/${mediaId}/preview-1600.webp`;
      await costEnv.MEDIA.put(previewKey, prevBytes, {
        httpMetadata: { contentType: 'image/webp' },
      });
    }

    const parsedDims = parseImageDimensions(bytes, detected.mime);
    const width =
      Number.isInteger(rawWidth) && rawWidth > 0 && rawWidth <= 20_000 ? rawWidth : parsedDims.width;
    const height =
      Number.isInteger(rawHeight) && rawHeight > 0 && rawHeight <= 20_000
        ? rawHeight
        : parsedDims.height;

    const record: Media = {
      hash,
      id: mediaId,
      name: text(file.name || `${mediaId}.${detected.ext}`, '文件名', 160, true),
      url: `/api/files/${mediaId}?variant=preview`,
      thumbnail: `/api/files/${mediaId}?variant=thumbnail`,
      preview: `/api/files/${mediaId}?variant=preview`,
      width,
      height,
      kind: detected.kind,
      mime: detected.mime,
      size: bytes.byteLength,
      takenAt: effectiveTakenAt,
      lat: effectiveLat,
      lng: effectiveLng,
      confirmed: effectiveConfirmed,
      caption,
      ...(effectiveExif ? { exif: effectiveExif } : {}),
    };

    await costEnv.DB.prepare(
      'INSERT INTO media (id, data, original, thumbnail, preview, hash) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(mediaId, JSON.stringify(record), originalKey, thumbnailKey, previewKey, hash)
      .run();

    created.push(record);
  }

  return c.json({ media: created }, 201);
});

atlasRoutes.patch('/api/media', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');
  const rawBody = await c.req.json().catch(() => null);

  const items = Array.isArray(rawBody)
    ? rawBody
    : rawBody && typeof rawBody === 'object' && Array.isArray((rawBody as { updates?: unknown }).updates)
      ? ((rawBody as { updates: unknown[] }).updates)
      : [rawBody];

  if (items.length === 0 || items.length > 100) {
    throw new ApiError('请提供 1～100 条有效媒体更新', 400);
  }

  const updated: Media[] = [];
  for (const rawItem of items) {
    const patch = object(rawItem);
    const mediaId = id(patch.id);
    const row = await costEnv.DB.prepare('SELECT data FROM media WHERE id=?')
      .bind(mediaId)
      .first<{ data: string }>();
    if (!row) {
      throw new ApiError('影像不存在', 404);
    }

    const current = JSON.parse(row.data) as Media;
    const nextLat = patch.lat !== undefined ? patch.lat : current.lat;
    const nextLng = patch.lng !== undefined ? patch.lng : current.lng;
    const coords = coordinates(nextLat, nextLng, true);

    const nextTakenAt =
      patch.takenAt !== undefined ? date(patch.takenAt, '拍摄时间', true) : current.takenAt;
    const nextCaption =
      patch.caption !== undefined ? text(patch.caption, '影像说明', 2000, false) : current.caption;
    const nextConfirmed =
      patch.confirmed !== undefined
        ? Boolean(patch.confirmed) && coords.lat !== null && coords.lng !== null
        : current.confirmed && coords.lat !== null && coords.lng !== null;
    const nextExif = patch.exif !== undefined ? parseExifInput(patch.exif) : current.exif;

    const merged: Media = {
      ...current,
      lat: coords.lat,
      lng: coords.lng,
      takenAt: nextTakenAt,
      caption: nextCaption,
      confirmed: nextConfirmed,
      ...(nextExif ? { exif: nextExif } : {}),
    };

    await costEnv.DB.prepare('UPDATE media SET data=? WHERE id=?')
      .bind(JSON.stringify(merged), mediaId)
      .run();
    updated.push(merged);
  }

  if (Array.isArray(rawBody)) {
    return c.json({ media: updated });
  }
  return c.json({ media: updated[0] });
});

atlasRoutes.post('/api/journeys', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');
  const body = object(await c.req.json().catch(() => null));

  const journeyId = body.id !== undefined ? id(body.id) : `journey_${crypto.randomUUID().slice(0, 8)}`;
  const title = text(body.title, '旅程标题', 120, true);
  const subtitle =
    body.subtitle !== undefined ? text(body.subtitle, '旅程副标题', 500, false) : '';
  const startDate = date(body.startDate, '开始日期', false)!;
  const endDate = date(body.endDate, '结束日期', false)!;
  if (startDate.slice(0, 10) > endDate.slice(0, 10)) {
    throw new ApiError('结束日期不能早于开始日期', 400);
  }

  const visibility = body.visibility === 'public' ? 'public' : body.visibility === 'private' ? 'private' : null;
  if (!visibility) {
    throw new ApiError('旅程可见性必须为 public 或 private', 400);
  }

  let coverId: string | null = null;
  if (body.coverId !== undefined && body.coverId !== null && body.coverId !== '') {
    coverId = id(body.coverId);
  }

  let sortOrder = 0;
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
      throw new ApiError('排序权重必须为有效数字', 400);
    }
    sortOrder = Math.round(body.sortOrder);
  }

  let requestedShareToken: string | null | undefined;
  if (body.shareToken !== undefined) {
    if (body.shareToken === null || body.shareToken === '') {
      requestedShareToken = null;
    } else if (typeof body.shareToken === 'string' && SHARE_TOKEN_RE.test(body.shareToken)) {
      requestedShareToken = body.shareToken;
    } else {
      throw new ApiError('同行私密分享令牌需为 12～48 位字母、数字、下划线或连字符', 400);
    }
  }

  if (!Array.isArray(body.stops)) {
    throw new ApiError('站点列表必须为数组', 400);
  }
  if (body.stops.length > 200) {
    throw new ApiError('单段旅程最多包含 200 个站点', 400);
  }

  const seenStopIds = new Set<string>();
  const referencedMediaIds = new Set<string>();
  if (coverId) referencedMediaIds.add(coverId);

  const stops: Stop[] = body.stops.map((rawStop) => {
    const s = object(rawStop);
    const stopId = id(s.id);
    if (seenStopIds.has(stopId)) {
      throw new ApiError(`存在重复站点标识: ${stopId}`, 400);
    }
    seenStopIds.add(stopId);

    const stopName = text(s.name, '站点名称', 120, true);
    const region = s.region !== undefined ? text(s.region, '地区', 120, false) : '';
    const stopDate = date(s.date, '站点日期', false)!;
    const stopCoords = coordinates(s.lat, s.lng, false);
    const note = s.note !== undefined ? text(s.note, '站点手记', 10000, false) : '';

    if (!Array.isArray(s.mediaIds)) {
      throw new ApiError('站点关联影像列表必须为数组', 400);
    }
    const mediaIds = s.mediaIds.map((m) => {
      const mid = id(m);
      referencedMediaIds.add(mid);
      return mid;
    });

    return {
      id: stopId,
      name: stopName,
      region,
      lat: stopCoords.lat!,
      lng: stopCoords.lng!,
      date: stopDate,
      note,
      mediaIds,
    };
  });

  if (referencedMediaIds.size > 0) {
    const existingRows = await costEnv.DB.prepare('SELECT id FROM media').all<{ id: string }>();
    const existingSet = new Set(existingRows.results.map((r) => r.id));
    for (const ref of referencedMediaIds) {
      if (!existingSet.has(ref)) {
        throw new ApiError(`引用的影像不存在: ${ref}`, 404);
      }
    }
  }

  const existingRow = await costEnv.DB.prepare('SELECT data FROM journeys WHERE id=?')
    .bind(journeyId)
    .first<{ data: string }>();
  const existingJourney = existingRow ? (JSON.parse(existingRow.data) as Journey) : null;
  const existingCreatedAt = existingJourney ? existingJourney.createdAt : new Date().toISOString();
  const effectiveShareToken =
    requestedShareToken !== undefined ? requestedShareToken : (existingJourney?.shareToken ?? null);

  const journey: Journey = {
    id: journeyId,
    title,
    subtitle,
    startDate,
    endDate,
    visibility,
    coverId,
    stops,
    createdAt: existingCreatedAt,
    sortOrder,
    ...(effectiveShareToken ? { shareToken: effectiveShareToken } : { shareToken: null }),
  };

  await costEnv.DB.prepare(
    'INSERT INTO journeys (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
  )
    .bind(journeyId, JSON.stringify(journey))
    .run();

  return c.json({ journey });
});
