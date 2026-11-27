import { Hono } from 'hono';
import { ApiError } from '../../shared/errors';
import { CLOUD_MEDIA_LIMITS } from '../../shared/media-formats';
import type { VaultFileRecord, VaultShareSummary } from '../../shared/types';
import { date, id, object, passcode, text } from '../../shared/validators';
import { COST_LIMITS, MAX_PUT_BYTES } from '../middleware/cost-limits';
import {
  countRateLimit,
  hmacHex,
  requireCloudAdmin,
  timingSafeEqualText,
} from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';

export const vaultRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

type VaultUploadRow = {
  id: string;
  file_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  total_chunks: number;
  received_chunks: string;
  state: 'uploading' | 'completed' | 'aborted';
  created_at: string;
  updated_at: string;
};

type VaultFileRow = {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  r2_key: string;
  chunk_count: number;
  visibility: 'private' | 'shared';
  created_at: string;
};

type VaultShareRow = {
  id: string;
  file_id: string;
  passcode_hash: string;
  passcode_salt: string;
  passcode_lookup: string;
  note: string;
  max_downloads: number;
  downloads: number;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  prior_expires_at: string | null;
};

type VaultTicketRow = {
  id: string;
  share_id: string;
  file_id: string;
  expires_at: string;
};

const encoder = new TextEncoder();
const PASSCODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SAFE_INLINE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'text/plain',
  'text/markdown',
  'application/json',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
]);

const hex = (value: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(value)].map((v) => v.toString(16).padStart(2, '0')).join('');

const randomHex = (bytes = 16): string => hex(crypto.getRandomValues(new Uint8Array(bytes)));

function generatePasscode(): string {
  const random = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += PASSCODE_ALPHABET.charAt((random[i] ?? 0) % PASSCODE_ALPHABET.length);
  }
  return out;
}

async function derivePasscodeDigest(
  normalizedCode: string,
  salt: string,
  secret: string,
): Promise<string> {
  const peppered = await hmacHex(secret, `vault-passcode:${normalizedCode}`);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(peppered),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return hex(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100_000 },
      key,
      256,
    ),
  );
}

function mapVaultFile(row: VaultFileRow): VaultFileRecord {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    sha256: row.sha256,
    r2Key: row.r2_key,
    chunkCount: Number(row.chunk_count),
    visibility: row.visibility,
    createdAt: row.created_at,
  };
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

async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = request.headers.get('content-length');
  const declared =
    contentLengthHeader !== null ? Number(contentLengthHeader) : Number.NaN;
  const maxDrainBytes = maxBytes + 8 * 1024 * 1024;
  let overLimit = Number.isFinite(declared) && declared > maxBytes;

  const reader = request.body?.getReader();
  if (!reader) {
    if (overLimit) {
      throw new ApiError('单个分片超过 16 MiB 上限', 413);
    }
    return new Uint8Array(0);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        overLimit = true;
      }
      if (overLimit) {
        if (total > maxDrainBytes) {
          await reader.cancel();
          break;
        }
        continue;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (overLimit) {
    throw new ApiError('单个分片超过 16 MiB 上限', 413);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

class VaultHttpError extends ApiError {
  constructor(
    message: string,
    status: number,
    public code: string,
  ) {
    super(message, status);
  }
}

vaultRoutes.post('/redeem', async (c) => {
  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');

  const contentType = c.req.header('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError('提取请求必须使用 JSON', 400);
  }

  const rawBody = await c.req.json().catch(() => null);
  const body = object(rawBody);
  const rawCode = passcode(body.code);
  const normalized = rawCode.toLowerCase();

  let requestId = '';
  if (body.requestId !== undefined && body.requestId !== null && body.requestId !== '') {
    if (typeof body.requestId !== 'string' || body.requestId.trim().length > 128) {
      throw new ApiError('请求标识无效', 400);
    }
    requestId = body.requestId.trim();
  }

  const limits = await Promise.all([
    countRateLimit(costEnv, `vault:redeem:visitor:${ctx.visitorId}`, 15 * 60_000, 10),
    countRateLimit(costEnv, `vault:redeem:ip:${ctx.address}`, 15 * 60_000, 12),
  ]);
  if (limits.some(Boolean)) {
    throw new ApiError('提取尝试过于频繁，请稍后再试', 429);
  }

  const lookup = await hmacHex(costEnv.SESSION_SECRET, `vault-code:${normalized}`);
  const candidates = await costEnv.DB.prepare(
    'SELECT * FROM vault_shares WHERE passcode_lookup=? ORDER BY rowid DESC',
  )
    .bind(lookup)
    .all<VaultShareRow>();

  let matchedShare: VaultShareRow | null = null;
  for (const row of candidates.results) {
    const computed = await derivePasscodeDigest(normalized, row.passcode_salt, costEnv.SESSION_SECRET);
    if (await timingSafeEqualText(computed, row.passcode_hash)) {
      matchedShare = row;
      break;
    }
  }

  if (!matchedShare) {
    return c.json({ error: '提取口令无效或分享已失效' }, 401);
  }

  if (matchedShare.revoked_at !== null) {
    return c.json({ error: '该分享已被撤销', code: 'share_revoked' }, 403);
  }

  const nowIso = new Date().toISOString();
  if (Date.parse(matchedShare.expires_at) <= Date.now()) {
    return c.json({ error: '该分享已过期', code: 'share_expired' }, 410);
  }

  const fileRow = await costEnv.DB.prepare('SELECT * FROM vault_files WHERE id=?')
    .bind(matchedShare.file_id)
    .first<VaultFileRow>();
  if (!fileRow) {
    return c.json({ error: '分享关联的文件已不存在', code: 'share_revoked' }, 404);
  }

  const origin = new URL(c.req.url).origin;

  if (requestId) {
    const deterministicTicketId = (
      await hmacHex(costEnv.SESSION_SECRET, `vault-ticket:${matchedShare.id}:${requestId}`)
    ).slice(0, 32);

    const existingTicket = await costEnv.DB.prepare(
      'SELECT * FROM vault_tickets WHERE id=? AND share_id=?',
    )
      .bind(deterministicTicketId, matchedShare.id)
      .first<VaultTicketRow>();

    if (existingTicket) {
      const remainingDownloads = Math.max(
        0,
        Number(matchedShare.max_downloads) - Number(matchedShare.downloads),
      );
      return c.json({
        ticketId: existingTicket.id,
        downloadUrl: `/api/vault/download/${existingTicket.id}`,
        fileName: fileRow.name,
        fileSize: Number(fileRow.size),
        size: Number(fileRow.size),
        fileMime: fileRow.mime,
        mime: fileRow.mime,
        note: matchedShare.note,
        remainingDownloads,
        expiresAt: matchedShare.expires_at,
        shareUrl: `${origin}/vault`,
      });
    }
  }

  const updated = await costEnv.DB.prepare(
    `UPDATE vault_shares
     SET downloads = downloads + 1
     WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND downloads < max_downloads
     RETURNING downloads, max_downloads`,
  )
    .bind(matchedShare.id, nowIso)
    .first<{ downloads: number; max_downloads: number }>();

  if (!updated) {
    return c.json({ error: '提取次数已用尽或分享已过期', code: 'ticket_exhausted' }, 403);
  }

  const ticketId = requestId
    ? (
        await hmacHex(costEnv.SESSION_SECRET, `vault-ticket:${matchedShare.id}:${requestId}`)
      ).slice(0, 32)
    : `vt_${randomHex(16)}`;

  const ticketExpiresMs = Math.min(
    Date.parse(matchedShare.expires_at),
    Date.now() + 24 * 3600_000,
  );
  const ticketExpiresAt = new Date(ticketExpiresMs).toISOString();

  await costEnv.DB.batch([
    costEnv.DB.prepare(
      'INSERT OR IGNORE INTO vault_tickets (id, share_id, file_id, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(ticketId, matchedShare.id, fileRow.id, ticketExpiresAt),
    costEnv.DB.prepare('DELETE FROM security_limits WHERE key=? OR key=?').bind(
      `vault:redeem:visitor:${ctx.visitorId}`,
      `vault:redeem:ip:${ctx.address}`,
    ),
  ]);

  const remainingDownloads = Math.max(
    0,
    Number(updated.max_downloads) - Number(updated.downloads),
  );

  return c.json({
    ticketId,
    downloadUrl: `/api/vault/download/${ticketId}`,
    fileName: fileRow.name,
    fileSize: Number(fileRow.size),
    size: Number(fileRow.size),
    fileMime: fileRow.mime,
    mime: fileRow.mime,
    note: matchedShare.note,
    remainingDownloads,
    expiresAt: matchedShare.expires_at,
    shareUrl: `${origin}/vault`,
  });
});

vaultRoutes.on(['GET', 'HEAD'], '/download/:ticketId', async (c) => {
  const ticketId = id(c.req.param('ticketId'));
  const costEnv = c.get('costEnv');

  const ticket = await costEnv.DB.prepare('SELECT * FROM vault_tickets WHERE id=?')
    .bind(ticketId)
    .first<VaultTicketRow>();
  if (!ticket) {
    return c.json({ error: '提取票据无效或不存在' }, 404);
  }

  const share = await costEnv.DB.prepare('SELECT * FROM vault_shares WHERE id=?')
    .bind(ticket.share_id)
    .first<VaultShareRow>();
  if (!share) {
    return c.json({ error: '分享记录不存在', code: 'share_revoked' }, 404);
  }
  if (share.revoked_at !== null) {
    return c.json({ error: '该分享已被撤销', code: 'share_revoked' }, 403);
  }
  if (Date.parse(share.expires_at) <= Date.now() || Date.parse(ticket.expires_at) <= Date.now()) {
    return c.json({ error: '该分享或提取票据已过期', code: 'share_expired' }, 403);
  }

  const fileRow = await costEnv.DB.prepare('SELECT * FROM vault_files WHERE id=?')
    .bind(ticket.file_id)
    .first<VaultFileRow>();
  if (!fileRow) {
    return c.json({ error: '文件不存在' }, 404);
  }

  const totalSize = Number(fileRow.size);
  const chunkCount = Math.max(1, Number(fileRow.chunk_count));
  const safeName = fileRow.name.replace(/["\r\n]/g, '_');
  const inlineRequested = c.req.query('inline') === '1';
  const baseMime = (fileRow.mime || '').split(';')[0]!.trim().toLowerCase();
  const allowInline = inlineRequested && SAFE_INLINE_MIMES.has(baseMime);

  const headers = new Headers({
    'Content-Type': fileRow.mime || 'application/octet-stream',
    'Content-Disposition': `${allowInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (allowInline) {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  }

  const parsedRange = parseSingleByteRange(c.req.header('range'), totalSize);
  if (parsedRange === 'invalid') {
    headers.set('Content-Range', `bytes */${totalSize}`);
    return new Response(null, { status: 416, headers });
  }

  if (c.req.method === 'HEAD') {
    if (parsedRange === 'none') {
      headers.set('Content-Length', String(totalSize));
      return new Response(null, { status: 200, headers });
    }
    const len = parsedRange.end - parsedRange.start + 1;
    headers.set('Content-Length', String(len));
    headers.set('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
    return new Response(null, { status: 206, headers });
  }

  if (chunkCount === 1) {
    if (parsedRange !== 'none') {
      const len = parsedRange.end - parsedRange.start + 1;
      const obj = await costEnv.MEDIA.get(fileRow.r2_key, {
        range: { offset: parsedRange.start, length: len },
      });
      if (!obj) return c.json({ error: '文件存储内容缺失' }, 404);
      headers.set('Content-Length', String(len));
      headers.set('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
      return new Response(obj.body, { status: 206, headers });
    }

    const obj = await costEnv.MEDIA.get(fileRow.r2_key);
    if (!obj) return c.json({ error: '文件存储内容缺失' }, 404);
    headers.set('Content-Length', String(obj.size));
    return new Response(obj.body, { status: 200, headers });
  }

  // Multi-chunk streaming assembly across vault/{fileId}/part-0..N-1
  const reqStart = parsedRange === 'none' ? 0 : parsedRange.start;
  const reqEnd = parsedRange === 'none' ? totalSize - 1 : parsedRange.end;
  const responseLength = reqEnd - reqStart + 1;

  const partKeys = Array.from({ length: chunkCount }, (_, i) => `vault/${fileRow.id}/part-${i}`);
  const partHeads = await Promise.all(partKeys.map((key) => costEnv.MEDIA.head(key)));
  for (let i = 0; i < partHeads.length; i += 1) {
    if (!partHeads[i]) {
      return c.json({ error: `文件分片缺失 (${i})` }, 404);
    }
  }

  const slices: Array<{ key: string; offset: number; length: number }> = [];
  let cursor = 0;
  for (let i = 0; i < partKeys.length; i += 1) {
    const partSize = partHeads[i]!.size;
    const partStart = cursor;
    const partEnd = cursor + partSize - 1;
    cursor += partSize;
    if (partEnd < reqStart || partStart > reqEnd) continue;
    const sliceStart = Math.max(partStart, reqStart) - partStart;
    const sliceEnd = Math.min(partEnd, reqEnd) - partStart;
    slices.push({
      key: partKeys[i]!,
      offset: sliceStart,
      length: sliceEnd - sliceStart + 1,
    });
  }

  let sliceIdx = 0;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (activeReader) {
            const { done, value } = await activeReader.read();
            if (!done && value) {
              controller.enqueue(value);
              return;
            }
            activeReader.releaseLock();
            activeReader = null;
          }
          if (sliceIdx >= slices.length) {
            controller.close();
            return;
          }
          const slice = slices[sliceIdx++]!;
          const obj = await costEnv.MEDIA.get(slice.key, {
            range: { offset: slice.offset, length: slice.length },
          });
          if (!obj) {
            throw new Error(`Missing vault part ${slice.key}`);
          }
          activeReader = obj.body.getReader();
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      if (activeReader) {
        await activeReader.cancel().catch(() => {});
        activeReader = null;
      }
    },
  });

  headers.set('Content-Length', String(responseLength));
  if (parsedRange !== 'none') {
    headers.set('Content-Range', `bytes ${reqStart}-${reqEnd}/${totalSize}`);
    return new Response(stream, { status: 206, headers });
  }
  return new Response(stream, { status: 200, headers });
});

vaultRoutes.post('/uploads/init', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');
  const body = object(await c.req.json().catch(() => null));

  const name = text(body.name, '文件名', 200, true);
  const mime =
    body.mime !== undefined ? text(body.mime, '文件类型', 120, true) : 'application/octet-stream';
  if (typeof body.size !== 'number' || !Number.isSafeInteger(body.size) || body.size < 1) {
    throw new ApiError('文件大小必须为正整数', 400);
  }
  const size = body.size;

  if (typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(body.sha256.trim())) {
    throw new ApiError('文件 SHA-256 校验值格式无效', 400);
  }
  const sha256 = body.sha256.trim().toLowerCase();

  if (
    typeof body.totalChunks !== 'number' ||
    !Number.isInteger(body.totalChunks) ||
    body.totalChunks < 1 ||
    body.totalChunks > 4096
  ) {
    throw new ApiError('分片总数必须为 1～4096 的整数', 400);
  }
  const totalChunks = body.totalChunks;

  // Non-poisoning lifetime upload budget pre-check before touching R2 or counters
  const usageRow = await costEnv.DB.prepare('SELECT value FROM usage_limits WHERE key=?')
    .bind('r2-upload-bytes:lifetime')
    .first<{ value: number }>();
  const currentUploadBytes = Number(usageRow?.value ?? 0);
  if (currentUploadBytes + size > COST_LIMITS.uploadBytes) {
    throw new ApiError('累计上传容量已接近或达到 2 GiB 免费限额，本次初始化已拒绝', 507);
  }

  const uploadId = `vu_${randomHex(12)}`;
  const fileId = `vf_${randomHex(12)}`;
  const now = new Date().toISOString();

  await costEnv.DB.prepare(
    `INSERT INTO vault_uploads (id, file_id, name, mime, size, sha256, total_chunks, received_chunks, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'uploading', ?, ?)`,
  )
    .bind(uploadId, fileId, name, mime, size, sha256, totalChunks, now, now)
    .run();

  return c.json(
    {
      uploadId,
      fileId,
      chunkSize: CLOUD_MEDIA_LIMITS.maxChunkBytes,
    },
    200,
  );
});

vaultRoutes.put('/uploads/:uploadId/chunk', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');
  const uploadId = id(c.req.param('uploadId'));

  const rawIdx = c.req.header('x-chunk-index') ?? '';
  if (!/^\d+$/.test(rawIdx.trim())) {
    throw new ApiError('分片索引 X-Chunk-Index 无效', 400);
  }
  const chunkIndex = Number(rawIdx.trim());

  const upload = await costEnv.DB.prepare('SELECT * FROM vault_uploads WHERE id=?')
    .bind(uploadId)
    .first<VaultUploadRow>();
  if (!upload) {
    throw new ApiError('上传会话不存在', 404);
  }
  if (upload.state !== 'uploading') {
    throw new ApiError('上传会话已结束或已取消', 409);
  }
  if (chunkIndex < 0 || chunkIndex >= Number(upload.total_chunks)) {
    throw new ApiError('分片索引超出总分片范围', 400);
  }

  const bytes = await readBoundedBytes(c.req.raw, MAX_PUT_BYTES);
  const partKey = `vault/${upload.file_id}/part-${chunkIndex}`;

  await costEnv.MEDIA.put(partKey, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });

  const existing = JSON.parse(upload.received_chunks || '[]') as number[];
  const nextSet = new Set<number>(existing);
  nextSet.add(chunkIndex);
  const receivedChunks = [...nextSet].sort((a, b) => a - b);

  await costEnv.DB.prepare(
    "UPDATE vault_uploads SET received_chunks=?, updated_at=? WHERE id=? AND state='uploading'",
  )
    .bind(JSON.stringify(receivedChunks), new Date().toISOString(), uploadId)
    .run();

  return c.json({
    uploadId,
    chunkIndex,
    receivedChunks,
  });
});

vaultRoutes.post('/uploads/:uploadId/complete', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');
  const uploadId = id(c.req.param('uploadId'));

  const upload = await costEnv.DB.prepare('SELECT * FROM vault_uploads WHERE id=?')
    .bind(uploadId)
    .first<VaultUploadRow>();
  if (!upload) {
    throw new ApiError('上传会话不存在', 404);
  }
  if (upload.state !== 'uploading') {
    throw new ApiError('上传会话已结束或已取消', 409);
  }

  const received = new Set<number>(JSON.parse(upload.received_chunks || '[]') as number[]);
  const totalChunks = Number(upload.total_chunks);
  for (let i = 0; i < totalChunks; i += 1) {
    if (!received.has(i)) {
      throw new ApiError(`缺少第 ${i + 1} 个分片，请重试上传缺失分片`, 400);
    }
  }

  const now = new Date().toISOString();
  const r2Key = `vault/${upload.file_id}/part-0`;
  const fileRecord: VaultFileRecord = {
    id: upload.file_id,
    name: upload.name,
    mime: upload.mime,
    size: Number(upload.size),
    sha256: upload.sha256,
    r2Key,
    chunkCount: totalChunks,
    visibility: 'private',
    createdAt: now,
  };

  await costEnv.DB.batch([
    costEnv.DB.prepare(
      `INSERT INTO vault_files (id, name, mime, size, sha256, r2_key, chunk_count, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'private', ?)`,
    ).bind(
      fileRecord.id,
      fileRecord.name,
      fileRecord.mime,
      fileRecord.size,
      fileRecord.sha256,
      fileRecord.r2Key,
      fileRecord.chunkCount,
      fileRecord.createdAt,
    ),
    costEnv.DB.prepare("UPDATE vault_uploads SET state='completed', updated_at=? WHERE id=?").bind(
      now,
      uploadId,
    ),
  ]);

  return c.json({ file: fileRecord, fileId: fileRecord.id }, 200);
});

vaultRoutes.delete('/uploads/:uploadId', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');
  const uploadId = id(c.req.param('uploadId'));

  const upload = await costEnv.DB.prepare('SELECT * FROM vault_uploads WHERE id=?')
    .bind(uploadId)
    .first<VaultUploadRow>();
  if (!upload) {
    throw new ApiError('上传会话不存在', 404);
  }

  if (upload.state === 'uploading') {
    await costEnv.DB.prepare(
      "UPDATE vault_uploads SET state='aborted', updated_at=? WHERE id=?",
    )
      .bind(new Date().toISOString(), uploadId)
      .run();

    const received = JSON.parse(upload.received_chunks || '[]') as number[];
    if (received.length > 0) {
      const keys = received.map((idx) => `vault/${upload.file_id}/part-${idx}`);
      await costEnv.MEDIA.delete(keys).catch(() => {});
    }
  }

  return c.json({ ok: true, uploadId });
});

vaultRoutes.get('/shares', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;

  const [shareRows, fileRows] = await Promise.all([
    db
      .prepare(
        `SELECT s.*, f.name AS file_name, f.size AS file_size, f.mime AS file_mime
         FROM vault_shares s
         LEFT JOIN vault_files f ON f.id = s.file_id
         ORDER BY s.rowid DESC`,
      )
      .all<VaultShareRow & { file_name: string | null; file_size: number | null; file_mime: string | null }>(),
    db.prepare('SELECT * FROM vault_files ORDER BY created_at DESC, rowid DESC').all<VaultFileRow>(),
  ]);

  const shares: VaultShareSummary[] = shareRows.results.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    fileName: r.file_name ?? '已移入回收站文件',
    fileSize: Number(r.file_size ?? 0),
    fileMime: r.file_mime ?? 'application/octet-stream',
    note: r.note,
    maxDownloads: Number(r.max_downloads),
    downloads: Number(r.downloads),
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  }));

  return c.json({
    shares,
    files: fileRows.results.map(mapVaultFile),
  });
});

vaultRoutes.post('/shares', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');
  const body = object(await c.req.json().catch(() => null));

  const fileId = id(body.fileId);
  const fileRow = await costEnv.DB.prepare('SELECT * FROM vault_files WHERE id=?')
    .bind(fileId)
    .first<VaultFileRow>();
  if (!fileRow) {
    throw new ApiError('要分享的密匣文件不存在', 404);
  }

  if (
    typeof body.maxDownloads !== 'number' ||
    !Number.isInteger(body.maxDownloads) ||
    body.maxDownloads < 1 ||
    body.maxDownloads > 999
  ) {
    throw new ApiError('最大下载次数需为 1～999 的整数', 400);
  }
  const maxDownloads = body.maxDownloads;

  let expiresAt: string;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') {
    const parsedIso = date(body.expiresAt, '过期时间', false)!;
    if (Date.parse(parsedIso) <= Date.now()) {
      throw new ApiError('过期时间必须晚于当前时刻', 400);
    }
    expiresAt = new Date(Date.parse(parsedIso)).toISOString();
  } else {
    const expiresIn = body.expiresIn !== undefined ? body.expiresIn : 86_400;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 365 * 86_400) {
      throw new ApiError('分享有效期必须为正数秒（最长 365 天）', 400);
    }
    expiresAt = new Date(Date.now() + Math.round(expiresIn * 1000)).toISOString();
  }

  const rawCode =
    body.passcode !== undefined && body.passcode !== null && String(body.passcode).trim() !== ''
      ? passcode(body.passcode)
      : generatePasscode();
  const normalizedCode = rawCode.toLowerCase();

  const note = body.note !== undefined ? text(body.note, '附言', 200, false) : '';

  const salt = randomHex(16);
  const passcodeLookup = await hmacHex(costEnv.SESSION_SECRET, `vault-code:${normalizedCode}`);
  const passcodeHash = await derivePasscodeDigest(normalizedCode, salt, costEnv.SESSION_SECRET);

  const shareId = `vs_${randomHex(12)}`;
  const createdAt = new Date().toISOString();

  await costEnv.DB.batch([
    costEnv.DB.prepare(
      `INSERT INTO vault_shares (id, file_id, passcode_hash, passcode_salt, passcode_lookup, note, max_downloads, downloads, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      shareId,
      fileId,
      passcodeHash,
      salt,
      passcodeLookup,
      note,
      maxDownloads,
      expiresAt,
      createdAt,
    ),
    costEnv.DB.prepare("UPDATE vault_files SET visibility='shared' WHERE id=?").bind(fileId),
  ]);

  const summary: VaultShareSummary = {
    id: shareId,
    fileId,
    fileName: fileRow.name,
    fileSize: Number(fileRow.size),
    fileMime: fileRow.mime,
    note,
    maxDownloads,
    downloads: 0,
    expiresAt,
    createdAt,
    revokedAt: null,
  };

  return c.json({ share: summary, passcode: rawCode }, 201);
});

vaultRoutes.post('/shares/:id/revoke', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const costEnv = c.get('costEnv');
  const shareId = id(c.req.param('id'));

  const share = await costEnv.DB.prepare('SELECT * FROM vault_shares WHERE id=?')
    .bind(shareId)
    .first<VaultShareRow>();
  if (!share) {
    throw new ApiError('分享记录不存在', 404);
  }

  const revokedAt = share.revoked_at ?? new Date().toISOString();
  await costEnv.DB.prepare(
    'UPDATE vault_shares SET revoked_at = COALESCE(revoked_at, ?), prior_expires_at = COALESCE(prior_expires_at, expires_at) WHERE id=?',
  )
    .bind(revokedAt, shareId)
    .run();

  return c.json({ ok: true, id: shareId, revokedAt });
});
