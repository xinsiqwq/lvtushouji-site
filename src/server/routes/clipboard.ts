import { Hono } from 'hono';
import { ApiError } from '../../shared/errors';
import type { ClipboardClaimResponse, ClipboardCreateResponse } from '../../shared/types';
import { object } from '../../shared/validators';
import { countRateLimit, timingSafeEqualText } from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';

export const clipboardRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

type ClipboardDropRow = {
  code: string;
  content: string;
  destroy_hash: string;
  burn_after_read: number;
  views: number;
  max_views: number;
  expires_at: string;
  created_at: string;
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_CONTENT_BYTES = 32 * 1024;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_400;
const DEFAULT_TTL_SECONDS = 3_600;
const MIN_MAX_VIEWS = 1;
const MAX_MAX_VIEWS = 20;
const DEFAULT_MAX_VIEWS = 10;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteCount = 24): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

function generateDropCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += CODE_ALPHABET.charAt((random[i] ?? 0) & 31);
  }
  return code;
}

function normalizeCodeParam(raw: string | undefined): string {
  const trimmed = (raw || '').trim();
  if (!/^[A-Za-z0-9]{6}$/.test(trimmed)) {
    throw new ApiError('闪传口令必须为 6 位字母或数字', 400);
  }
  return trimmed.toUpperCase();
}

clipboardRoutes.post('/', async (c) => {
  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');

  const contentType = c.req.header('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError('闪传创建请求必须使用 JSON', 400);
  }

  const limits = await Promise.all([
    countRateLimit(costEnv, `clipboard:create:visitor:${ctx.visitorId}`, 15 * 60_000, 20),
    countRateLimit(costEnv, `clipboard:create:ip:${ctx.address}`, 15 * 60_000, 30),
  ]);
  if (limits.some(Boolean)) {
    throw new ApiError('创建闪传过于频繁，请稍后再试', 429);
  }

  const rawBody = await c.req.json().catch(() => null);
  const body = object(rawBody);

  if (typeof body.content !== 'string' || body.content.trim().length === 0) {
    throw new ApiError('闪传文本内容不能为空', 400);
  }
  const content = body.content;
  const sizeBytes = encoder.encode(content).byteLength;
  if (sizeBytes > MAX_CONTENT_BYTES) {
    throw new ApiError('闪传内容超过 32 KiB 上限', 413);
  }

  let burnAfterRead = false;
  if (body.burnAfterRead !== undefined) {
    if (typeof body.burnAfterRead !== 'boolean') {
      throw new ApiError('阅后即焚参数必须为布尔值', 400);
    }
    burnAfterRead = body.burnAfterRead;
  }

  let maxViews = DEFAULT_MAX_VIEWS;
  if (burnAfterRead) {
    maxViews = 1;
  } else if (body.maxViews !== undefined && body.maxViews !== null) {
    if (
      typeof body.maxViews !== 'number' ||
      !Number.isInteger(body.maxViews) ||
      body.maxViews < MIN_MAX_VIEWS ||
      body.maxViews > MAX_MAX_VIEWS
    ) {
      throw new ApiError('最大提取次数需为 1～20 的整数', 400);
    }
    maxViews = body.maxViews;
  }

  let expiresInSeconds = DEFAULT_TTL_SECONDS;
  if (body.expiresInSeconds !== undefined && body.expiresInSeconds !== null) {
    if (
      typeof body.expiresInSeconds !== 'number' ||
      !Number.isInteger(body.expiresInSeconds) ||
      body.expiresInSeconds < MIN_TTL_SECONDS ||
      body.expiresInSeconds > MAX_TTL_SECONDS
    ) {
      throw new ApiError('有效期需为 60～86400 秒的整数', 400);
    }
    expiresInSeconds = body.expiresInSeconds;
  }

  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + expiresInSeconds * 1000).toISOString();

  // Opportunistic sweep of expired rows
  await costEnv.DB.prepare('DELETE FROM clipboard_drops WHERE expires_at <= ?').bind(createdAt).run();

  const destroyToken = randomHex(24);
  const destroyHash = await sha256Hex(destroyToken);

  let code = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateDropCode();
    const res = await costEnv.DB.prepare(
      `INSERT OR IGNORE INTO clipboard_drops
         (code, content, destroy_hash, burn_after_read, views, max_views, expires_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    )
      .bind(
        candidate,
        content,
        destroyHash,
        burnAfterRead ? 1 : 0,
        maxViews,
        expiresAt,
        createdAt,
      )
      .run();
    if ((res.meta.changes ?? 0) > 0) {
      code = candidate;
      break;
    }
  }

  if (!code) {
    throw new ApiError('生成闪传口令冲突，请稍后重试', 503);
  }

  const response: ClipboardCreateResponse = {
    code,
    destroyToken,
    expiresAt,
    burnAfterRead,
    maxViews,
    sizeBytes,
  };
  return c.json(response, 201);
});

clipboardRoutes.get('/:code', async (c) => {
  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');

  const limits = await Promise.all([
    countRateLimit(costEnv, `clipboard:claim:visitor:${ctx.visitorId}`, 15 * 60_000, 40),
    countRateLimit(costEnv, `clipboard:claim:ip:${ctx.address}`, 15 * 60_000, 60),
  ]);
  if (limits.some(Boolean)) {
    throw new ApiError('提取尝试过于频繁，请稍后再试', 429);
  }

  const code = normalizeCodeParam(c.req.param('code'));
  const row = await costEnv.DB.prepare('SELECT * FROM clipboard_drops WHERE code=?')
    .bind(code)
    .first<ClipboardDropRow>();

  if (!row) {
    return c.json({ error: '闪传口令不存在或已失效' }, 404);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  if (Date.parse(row.expires_at) <= nowMs || row.expires_at <= nowIso) {
    await costEnv.DB.prepare('DELETE FROM clipboard_drops WHERE code=?').bind(code).run();
    return c.json({ error: '闪传口令不存在或已失效' }, 404);
  }

  const updated = await costEnv.DB.prepare(
    `UPDATE clipboard_drops
     SET views = views + 1
     WHERE code = ? AND expires_at > ? AND views < max_views
     RETURNING views`,
  )
    .bind(code, nowIso)
    .first<{ views: number }>();

  if (!updated) {
    return c.json({ error: '闪传口令不存在或已失效' }, 404);
  }

  const newViews = Number(updated.views);
  const maxViews = Number(row.max_views);
  const burnAfterRead = Number(row.burn_after_read) === 1;
  const burned = burnAfterRead || newViews >= maxViews;
  const remainingViews = burned ? 0 : Math.max(0, maxViews - newViews);

  if (burned) {
    await costEnv.DB.prepare('DELETE FROM clipboard_drops WHERE code=?').bind(code).run();
  }

  const response: ClipboardClaimResponse = {
    code: row.code,
    content: row.content,
    burnAfterRead,
    remainingViews,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    burned,
  };
  return c.json(response, 200);
});

clipboardRoutes.delete('/:code', async (c) => {
  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');
  const code = normalizeCodeParam(c.req.param('code'));

  const row = await costEnv.DB.prepare('SELECT code, destroy_hash FROM clipboard_drops WHERE code=?')
    .bind(code)
    .first<{ code: string; destroy_hash: string }>();
  if (!row) {
    return c.json({ error: '闪传口令不存在或已失效' }, 404);
  }

  if (!ctx.authenticated) {
    const supplied = (c.req.header('x-destroy-token') || '').trim();
    if (!supplied) {
      throw new ApiError('缺少销毁凭证', 403);
    }
    const suppliedHash = await sha256Hex(supplied);
    if (!(await timingSafeEqualText(suppliedHash, row.destroy_hash))) {
      throw new ApiError('销毁凭证无效', 403);
    }
  }

  await costEnv.DB.prepare('DELETE FROM clipboard_drops WHERE code=?').bind(code).run();
  return c.json({ ok: true, code }, 200);
});
