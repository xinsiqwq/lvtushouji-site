import type {
  AuthStatus,
  DeviceInfo,
  NetworkLookup,
  SecurityEvent,
  SecurityPolicy,
  SecuritySnapshot,
  VisitorSummary,
} from '../../shared/types';
import type { AppBindings, CloudContext } from '../types';

export class CloudSecurityError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'CloudSecurityError';
  }
}

type SubtleWithTimingSafe = SubtleCrypto & {
  timingSafeEqual(a: BufferSource, b: BufferSource): boolean;
};

const DEFAULT_POLICY: SecurityPolicy = {
  recordingEnabled: true,
  retentionDays: 30,
  requestsPerMinute: 180,
  allowVisitorMessages: false,
};

const SESSION_MS = 12 * 3600_000;
const IDLE_MS = 30 * 60_000;
const encoder = new TextEncoder();
const metadata = new WeakMap<
  CloudContext,
  { kind?: SecurityEvent['kind']; reasons: string[]; skipVisit?: boolean }
>();
const lastSweep = new WeakMap<D1Database, number>();

const clean = (value: unknown, max = 200): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';

const iso = (value: number): string => new Date(value).toISOString();

const hex = (value: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(value)].map((v) => v.toString(16).padStart(2, '0')).join('');

const randomHex = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));

const digestHex = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function timingSafeEqualText(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const subtle = crypto.subtle as SubtleWithTimingSafe;
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(leftDigest, rightDigest);
  }
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function cookieValue(request: Request, name: string): string {
  const matches = (request.headers.get('cookie') || '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
}

export const isHttpsRequest = (request: Request): boolean => {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
};

export const formatCookie = (
  name: string,
  value: string,
  seconds: number,
  isHttps: boolean,
): string =>
  `${name}=${value}; Path=/;${isHttps ? ' Secure;' : ''} HttpOnly; SameSite=Strict; Max-Age=${seconds}`;

function parseDevice(request: Request): DeviceInfo {
  const ua = clean(request.headers.get('user-agent'), 512);
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /Firefox\//i.test(ua)
      ? 'Firefox'
      : /Chrome\//i.test(ua)
        ? 'Chrome'
        : /Safari\//i.test(ua)
          ? 'Safari'
          : /curl|wget|python|bot|spider/i.test(ua)
            ? '自动化客户端'
            : '未知';
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Android/i.test(ua)
      ? 'Android'
      : /iPhone|iPad/i.test(ua)
        ? 'iOS'
        : /Macintosh/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '未知';
  const type: DeviceInfo['type'] = /curl|wget|python|bot|spider/i.test(ua)
    ? 'script'
    : /iPad|Tablet/i.test(ua)
      ? 'tablet'
      : /Mobi|Android|iPhone/i.test(ua)
        ? 'mobile'
        : ua
          ? 'desktop'
          : 'unknown';
  return {
    browser,
    os,
    type,
    userAgent: ua,
    language: clean(request.headers.get('accept-language'), 100),
  };
}

function normalizeIp(value: string): string {
  if (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value.split('.').every((v) => Number(v) <= 255 && String(Number(v)) === v)
  ) {
    return value;
  }
  if (/^[a-f\d:]+$/i.test(value) && value.includes(':')) {
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch {
      /* Not an IPv6 literal. */
    }
  }
  throw new CloudSecurityError('无效的 IP 地址');
}

export function clientAddress(request: Request): string {
  // Cloudflare overwrites CF-Connecting-IP at the edge; never trust X-Forwarded-For.
  return normalizeIp(request.headers.get('CF-Connecting-IP') || '127.0.0.1');
}

function publicIp(address: string): boolean {
  if (address.includes('.')) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 31 && c === 196) ||
          (b === 52 && c === 193) ||
          (b === 88 && c === 99) ||
          (b === 175 && c === 48))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const [left, right] = address.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const groups =
    right === undefined
      ? head
      : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  const value = BigInt('0x' + groups.map((v) => v.padStart(4, '0')).join(''));
  const prefix = (base: string, bits: number) =>
    value >> BigInt(128 - bits) === BigInt(base) >> BigInt(128 - bits);
  return (
    prefix('0x20000000000000000000000000000000', 3) &&
    !prefix('0x20010000000000000000000000000000', 23) &&
    !prefix('0x20010db8000000000000000000000000', 32) &&
    !prefix('0x20020000000000000000000000000000', 16) &&
    !prefix('0x3fff0000000000000000000000000000', 20)
  );
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloudSecurityError('请求内容必须是对象');
  }
  return value as Record<string, unknown>;
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new CloudSecurityError('请求必须使用 JSON', 415);
  }
  if (Number(request.headers.get('content-length') || 0) > 16384) {
    throw new CloudSecurityError('请求内容过大', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new CloudSecurityError('缺少请求内容');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) {
        await reader.cancel();
        throw new CloudSecurityError('请求内容过大', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return asObject(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof CloudSecurityError) throw error;
    throw new CloudSecurityError('无效的 JSON 请求');
  }
}

export function noteSecurityEvent(
  ctx: CloudContext,
  kind: SecurityEvent['kind'],
  reason: string,
): void {
  const entry = metadata.get(ctx) || { reasons: [] };
  entry.kind = kind;
  entry.reasons.push(reason);
  metadata.set(ctx, entry);
}

function deny(ctx: CloudContext, message: string, status = 403): never {
  noteSecurityEvent(ctx, 'blocked', message);
  throw new CloudSecurityError(message, status);
}

const getSetting = (env: Pick<AppBindings, 'DB'>, key: string) =>
  env.DB.prepare('SELECT value FROM security_settings WHERE key=?').bind(key).first<string>('value');

export async function countRateLimit(
  env: Pick<AppBindings, 'DB'>,
  key: string,
  durationMs: number,
  maximum: number,
): Promise<boolean> {
  const now = Date.now();
  const count = await env.DB.prepare(
    `INSERT INTO security_limits(key,start,count) VALUES (?,?,1)
     ON CONFLICT(key) DO UPDATE SET
       start = CASE WHEN start<=? THEN excluded.start ELSE start END,
       count = CASE WHEN start<=? THEN 1 ELSE count+1 END
     RETURNING count`,
  )
    .bind(key, now, now - durationMs, now - durationMs)
    .first<number>('count');
  return Number(count) > maximum;
}

export async function beginCloudRequest(request: Request, env: AppBindings): Promise<CloudContext> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new CloudSecurityError('服务尚未完成安全配置', 503);
  }
  const https = isHttpsRequest(request);
  const address = clientAddress(request);
  const [password, storedPolicy] = await Promise.all([
    getSetting(env, 'password'),
    getSetting(env, 'policy'),
  ]);

  const [raw, signature] = cookieValue(request, 'travel_visitor').split('.');
  const validVisitor =
    /^[a-f0-9]{64}$/.test(raw || '') &&
    /^[a-f0-9]{64}$/.test(signature || '') &&
    (await timingSafeEqualText(signature, await hmacHex(env.SESSION_SECRET, `visitor:${raw}`)));
  const visitorRaw = validVisitor ? raw : randomHex();

  const ctx: CloudContext = {
    configured: !!password,
    authenticated: false,
    sessionId: null,
    csrfToken: null,
    visitorId: await digestHex(visitorRaw),
    address,
    policy: { ...DEFAULT_POLICY, ...(storedPolicy ? JSON.parse(storedPolicy) : {}) },
    cookies: [],
  };
  metadata.set(ctx, { reasons: [] });

  if (!validVisitor) {
    ctx.cookies.push(
      formatCookie(
        'travel_visitor',
        `${visitorRaw}.${await hmacHex(env.SESSION_SECRET, `visitor:${visitorRaw}`)}`,
        90 * 86400,
        https,
      ),
    );
  }

  const token = cookieValue(request, 'travel_session');
  if (ctx.configured && /^[a-f0-9]{64}$/.test(token)) {
    const now = Date.now();
    const session = await env.DB.prepare(
      'SELECT id FROM security_sessions WHERE token_hash=? AND expires_at>? AND last_seen>?',
    )
      .bind(await digestHex(token), now, now - IDLE_MS)
      .first<{ id: string }>();

    if (session) {
      ctx.authenticated = true;
      ctx.sessionId = session.id;
      ctx.csrfToken = await hmacHex(env.SESSION_SECRET, `csrf:${session.id}`);
      const reqUrl = new URL(request.url);
      const isPassivePoll =
        request.method === 'GET' &&
        (reqUrl.pathname === '/api/security/auth' ||
          (reqUrl.pathname === '/api/admin/cloudflare/status' && reqUrl.searchParams.get('poll') === '1'));
      if (!isPassivePoll) {
        await env.DB.prepare('UPDATE security_sessions SET last_seen=? WHERE id=?')
          .bind(now, session.id)
          .run();
      }
    }
  }

  try {
    if (!ctx.authenticated) {
      const blocked = await env.DB.prepare(
        "SELECT id FROM security_blocks WHERE (type='visitor' AND value=?) OR (type='ip' AND value=?)",
      )
        .bind(ctx.visitorId, address)
        .first();
      if (blocked) deny(ctx, '此访问已被限制');

      const limits = await Promise.all([
        countRateLimit(env, `request:visitor:${ctx.visitorId}`, 60_000, ctx.policy.requestsPerMinute),
        countRateLimit(env, `request:ip:${address}`, 60_000, ctx.policy.requestsPerMinute * 3),
      ]);
      if (limits.some(Boolean)) deny(ctx, '请求过于频繁，请稍后再试', 429);
    }
  } catch (error) {
    if (error instanceof CloudSecurityError) {
      await finishCloudResponse(request, env, ctx, new Response(null, { status: error.status }));
    }
    throw error;
  }

  return ctx;
}

export function requireCloudAdmin(ctx: CloudContext): void {
  if (!ctx.configured || !ctx.authenticated || !ctx.sessionId) {
    deny(
      ctx,
      ctx.configured ? '请先登录管理后台' : '请先通过安全初始化入口设置管理口令',
      401,
    );
  }
}

export async function authorizeCloudMutation(request: Request, ctx: CloudContext): Promise<void> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(request.headers.get('origin') || '').origin === new URL(request.url).origin;
  } catch {
    /* Missing or invalid origin. */
  }
  if (!sameOrigin) deny(ctx, '请求来源校验失败');
  if (ctx.authenticated) {
    const suppliedCsrf = request.headers.get('x-travel-csrf') || '';
    if (!ctx.csrfToken || !(await timingSafeEqualText(suppliedCsrf, ctx.csrfToken))) {
      deny(ctx, '安全校验失败，请刷新后重试');
    }
  }
}

const authStatus = (ctx: CloudContext): AuthStatus => ({
  configured: ctx.configured,
  authenticated: ctx.authenticated,
  sessionId: ctx.sessionId,
  csrfToken: ctx.csrfToken,
});

function passwordValue(value: unknown, isNew: boolean): string {
  if (typeof value !== 'string' || value.length > 256 || value.length < (isNew ? 8 : 1)) {
    throw new CloudSecurityError(isNew ? '口令长度需为 8～256 个字符' : '请输入口令');
  }
  return value;
}

async function derivePasswordDigest(
  password: string,
  salt: string,
  secret: string,
): Promise<string> {
  const peppered = await hmacHex(secret, `password:${password}`);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(peppered),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return hex(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100000 },
      key,
      256,
    ),
  );
}

async function handleAuthAction(
  request: Request,
  env: AppBindings,
  ctx: CloudContext,
  value: Record<string, unknown>,
): Promise<AuthStatus> {
  noteSecurityEvent(ctx, 'auth', '管理身份验证');
  const https = isHttpsRequest(request);
  const action = value.action === 'change' ? 'password' : value.action;
  if (!['setup', 'login', 'logout', 'password'].includes(String(action))) {
    throw new CloudSecurityError('无效的登录操作');
  }
  if (action === 'logout' || action === 'password') requireCloudAdmin(ctx);

  if (action === 'logout') {
    await env.DB.prepare('DELETE FROM security_sessions WHERE id=?').bind(ctx.sessionId).run();
    ctx.authenticated = false;
    ctx.sessionId = null;
    ctx.csrfToken = null;
    ctx.cookies.push(formatCookie('travel_session', '', 0, https));
    return authStatus(ctx);
  }

  if (action === 'setup') {
    if (ctx.configured) throw new CloudSecurityError('管理口令已经设置', 409);
    const suppliedToken =
      request.headers.get('x-travel-setup-token') || cookieValue(request, 'travel_setup');
    if (
      !env.SETUP_TOKEN ||
      env.SETUP_TOKEN.length < 32 ||
      !(await timingSafeEqualText(suppliedToken, env.SETUP_TOKEN))
    ) {
      throw new CloudSecurityError('初始化入口无效，请使用部署时生成的安全链接', 403);
    }
  } else if (!ctx.configured) {
    throw new CloudSecurityError('请先设置管理口令', 409);
  }

  const suppliedPassword = passwordValue(
    action === 'password' ? value.oldPassword : value.password,
    action === 'setup',
  );
  const newPassword =
    action === 'password' ? passwordValue(value.newPassword, true) : suppliedPassword;

  const limits = await Promise.all([
    countRateLimit(env, `login:visitor:${ctx.visitorId}`, 15 * 60_000, 5),
    countRateLimit(env, `login:ip:${ctx.address}`, 15 * 60_000, 5),
  ]);
  if (limits.some(Boolean)) {
    throw new CloudSecurityError('登录尝试过于频繁，请 15 分钟后重试', 429);
  }

  const stored = await getSetting(env, 'password');
  if (action !== 'setup') {
    let valid = false;
    if (stored) {
      const encoded = JSON.parse(stored) as { algorithm: string; salt: string; digest: string };
      if (encoded.algorithm === 'pbkdf2-sha256-v1') {
        const computed = await derivePasswordDigest(suppliedPassword, encoded.salt, env.SESSION_SECRET);
        valid = await timingSafeEqualText(computed, encoded.digest);
      }
    }
    if (!valid) throw new CloudSecurityError('口令错误', 401);
  }

  let nextPassword = stored ?? '';
  if (action !== 'login') {
    const salt = randomHex();
    nextPassword = JSON.stringify({
      algorithm: 'pbkdf2-sha256-v1',
      iterations: 100000,
      salt,
      digest: await derivePasswordDigest(newPassword, salt, env.SESSION_SECRET),
    });
  }

  const sessionId = crypto.randomUUID();
  const token = randomHex();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  if (action === 'setup') {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO security_settings(key,value) VALUES ('password',?)").bind(
        nextPassword,
      ),
    );
  }
  if (action === 'password') {
    statements.push(
      env.DB.prepare("UPDATE security_settings SET value=? WHERE key='password' AND value=?").bind(
        nextPassword,
        stored,
      ),
    );
  }
  if (action !== 'login') {
    statements.push(
      env.DB.prepare(
        "DELETE FROM security_sessions WHERE EXISTS (SELECT 1 FROM security_settings WHERE key='password' AND value=?)",
      ).bind(nextPassword),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO security_sessions(id,token_hash,visitor_id,created_at,last_seen,expires_at,address,device)
       SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM security_settings WHERE key='password' AND value=?)`,
    ).bind(
      sessionId,
      await digestHex(token),
      ctx.visitorId,
      now,
      now,
      now + SESSION_MS,
      ctx.address,
      JSON.stringify(parseDevice(request)),
      nextPassword,
    ),
  );

  const results = await env.DB.batch(statements);
  if (!results[results.length - 1]?.meta.changes) {
    throw new CloudSecurityError(
      action === 'setup' ? '管理口令已经设置' : '口令已改变，请重新登录',
      409,
    );
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM security_limits WHERE key=? OR key=?').bind(
      `login:visitor:${ctx.visitorId}`,
      `login:ip:${ctx.address}`,
    ),
    env.DB.prepare(
      'DELETE FROM security_sessions WHERE id NOT IN (SELECT id FROM security_sessions ORDER BY created_at DESC,rowid DESC LIMIT 20)',
    ),
  ]);

  ctx.configured = true;
  ctx.authenticated = true;
  ctx.sessionId = sessionId;
  ctx.csrfToken = await hmacHex(env.SESSION_SECRET, `csrf:${sessionId}`);
  ctx.cookies.push(formatCookie('travel_session', token, SESSION_MS / 1000, https));
  if (action === 'setup') ctx.cookies.push(formatCookie('travel_setup', '', 0, https));
  return authStatus(ctx);
}

type VisitorRow = {
  id: string;
  first_seen: number;
  last_seen: number;
  address: string;
  address_source: 'signed-proxy';
  device: string;
  authenticated: number;
  client_info: string | null;
  requests: number;
  denied: number;
  reasons: string;
};

async function summaries(env: AppBindings, visitorId?: string): Promise<VisitorSummary[]> {
  const query = `SELECT v.*,count(e.id) requests,coalesce(sum(CASE WHEN e.status>=400 THEN 1 ELSE 0 END),0) denied,json_group_array(json_extract(e.data,'$.reasons')) reasons FROM security_visitors v LEFT JOIN security_events e ON e.visitor_id=v.id ${visitorId ? 'WHERE v.id=?' : ''} GROUP BY v.id ORDER BY v.last_seen DESC LIMIT 80`;
  const statement = env.DB.prepare(query);
  const rows = await (visitorId ? statement.bind(visitorId) : statement).all<VisitorRow>();
  const blocks = (
    await env.DB.prepare('SELECT type,value FROM security_blocks').all<{
      type: string;
      value: string;
    }>()
  ).results;

  return rows.results.map((row) => ({
    id: row.id,
    firstSeen: iso(row.first_seen),
    lastSeen: iso(row.last_seen),
    address: row.address,
    addressSource: row.address_source,
    device: JSON.parse(row.device) as DeviceInfo,
    requests: Number(row.requests),
    denied: Number(row.denied),
    reasons: [
      ...new Set(
        (JSON.parse(row.reasons) as unknown[]).flat().filter((v): v is string => typeof v === 'string'),
      ),
    ].slice(0, 12),
    blocked: blocks.some((b) => (b.type === 'visitor' ? b.value === row.id : b.value === row.address)),
    authenticated: !!row.authenticated,
    clientInfo: row.client_info ? (JSON.parse(row.client_info) as VisitorSummary['clientInfo']) : null,
  }));
}

async function securitySnapshot(env: AppBindings, ctx: CloudContext): Promise<SecuritySnapshot> {
  const now = Date.now();
  const [visitors, events, sessions, blocks, counts] = await Promise.all([
    summaries(env),
    env.DB.prepare('SELECT data FROM security_events ORDER BY at DESC,rowid DESC LIMIT 200').all<{
      data: string;
    }>(),
    env.DB.prepare(
      'SELECT * FROM security_sessions WHERE expires_at>? AND last_seen>? ORDER BY created_at DESC',
    )
      .bind(now, now - IDLE_MS)
      .all<{
        id: string;
        created_at: number;
        last_seen: number;
        expires_at: number;
        address: string;
        device: string;
      }>(),
    env.DB.prepare('SELECT * FROM security_blocks ORDER BY created_at DESC').all<{
      id: string;
      type: 'visitor' | 'ip';
      value: string;
      reason: string;
      created_at: number;
    }>(),
    env.DB.prepare(
      "SELECT count(*) requests,count(DISTINCT visitor_id) visitors,coalesce(sum(CASE WHEN status>=400 THEN 1 ELSE 0 END),0) denied,coalesce(sum(CASE WHEN kind='auth' AND status>=400 THEN 1 ELSE 0 END),0) failedLogins FROM security_events",
    ).first<SecuritySnapshot['totals']>(),
  ]);

  return {
    auth: authStatus(ctx),
    policy: ctx.policy,
    visitors,
    events: events.results.map((e) => JSON.parse(e.data) as SecurityEvent),
    sessions: sessions.results.map((s) => ({
      id: s.id,
      createdAt: iso(s.created_at),
      lastSeen: iso(s.last_seen),
      expiresAt: iso(s.expires_at),
      address: s.address,
      device: JSON.parse(s.device) as DeviceInfo,
      current: s.id === ctx.sessionId,
    })),
    blocks: blocks.results.map((b) => ({
      id: b.id,
      type: b.type,
      value: b.value,
      reason: b.reason,
      createdAt: iso(b.created_at),
    })),
    totals: counts ?? { requests: 0, visitors: 0, denied: 0, failedLogins: 0 },
    sourceMode: 'signed-proxy',
    proxyConfigured: true,
  };
}

export async function handleCloudSecurity(
  request: Request,
  env: AppBindings,
  ctx: CloudContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/security' && !path.startsWith('/api/security/')) return null;
  await authorizeCloudMutation(request, ctx);

  const method = request.method.toUpperCase();
  if (path === '/api/security/auth') {
    if (method === 'GET') return Response.json(authStatus(ctx));
    if (method === 'POST') {
      return Response.json(await handleAuthAction(request, env, ctx, await readBoundedJson(request)));
    }
  } else if (path === '/api/security/visit' && method === 'POST') {
    if (
      request.headers.get('dnt') === '1' ||
      request.headers.get('sec-gpc') === '1' ||
      !ctx.policy.recordingEnabled
    ) {
      metadata.set(ctx, { reasons: [], skipVisit: true });
      return Response.json({ ok: true, skipped: true });
    }
    const value = await readBoundedJson(request);
    const size = (input: unknown) => {
      const v = asObject(input);
      return {
        width: Math.max(0, Math.min(16384, Math.round(Number(v.width) || 0))),
        height: Math.max(0, Math.min(16384, Math.round(Number(v.height) || 0))),
      };
    };
    const info = {
      timezone: clean(value.timezone, 80),
      language: clean(value.language, 80),
      viewport: size(value.viewport),
      screen: size(value.screen),
      chapter: clean(value.chapter, 120),
    };
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO security_visitors(id,first_seen,last_seen,address,address_source,device,authenticated,client_info)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET client_info=excluded.client_info,last_seen=excluded.last_seen`,
    )
      .bind(
        ctx.visitorId,
        now,
        now,
        ctx.address,
        'signed-proxy',
        JSON.stringify(parseDevice(request)),
        Number(ctx.authenticated),
        JSON.stringify(info),
      )
      .run();
    noteSecurityEvent(ctx, 'visit', '访问页面');
    return Response.json({ ok: true });
  } else {
    requireCloudAdmin(ctx);
    if (path === '/api/security' && method === 'GET') {
      return Response.json(await securitySnapshot(env, ctx));
    }
    if (path === '/api/security' && method === 'PATCH') {
      const value = await readBoundedJson(request);
      const next = { ...ctx.policy };
      for (const key of ['recordingEnabled', 'allowVisitorMessages'] as const) {
        if (value[key] !== undefined) {
          if (typeof value[key] !== 'boolean') {
            throw new CloudSecurityError('策略开关必须为布尔值');
          }
          next[key] = value[key];
        }
      }
      if (value.retentionDays !== undefined) {
        if (![7, 30, 90].includes(value.retentionDays as number)) {
          throw new CloudSecurityError('保留期限仅支持 7、30 或 90 天');
        }
        next.retentionDays = value.retentionDays as SecurityPolicy['retentionDays'];
      }
      if (value.requestsPerMinute !== undefined) {
        if (
          !Number.isInteger(value.requestsPerMinute) ||
          Number(value.requestsPerMinute) < 10 ||
          Number(value.requestsPerMinute) > 600
        ) {
          throw new CloudSecurityError('每分钟请求上限需为 10～600 的整数');
        }
        next.requestsPerMinute = Number(value.requestsPerMinute);
      }
      await env.DB.prepare(
        "INSERT INTO security_settings(key,value) VALUES ('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
        .bind(JSON.stringify(next))
        .run();
      ctx.policy = next;
      noteSecurityEvent(ctx, 'policy', '更新安全策略');
      return Response.json(next);
    }
    if (path === '/api/security/visitor' && method === 'GET') {
      const id = new URL(request.url).searchParams.get('id') || '';
      if (!/^[a-f0-9]{64}$/.test(id)) throw new CloudSecurityError('无效的访客标识');
      const visitor = (await summaries(env, id))[0];
      if (!visitor) throw new CloudSecurityError('访客记录不存在', 404);
      const all = (
        await env.DB.prepare('SELECT data FROM security_events WHERE visitor_id=? ORDER BY at ASC,rowid ASC')
          .bind(id)
          .all<{ data: string }>()
      ).results.map((e) => JSON.parse(e.data) as SecurityEvent);
      visitor.reasons = [...new Set(all.flatMap((e) => e.reasons))].slice(0, 12);
      return Response.json({
        visitor,
        events: all.slice(-200).reverse(),
        addresses: [...new Set(all.map((e) => e.address))],
        browserChanges: all
          .slice(1)
          .filter(
            (e, i) => e.device.browser !== all[i].device.browser || e.device.os !== all[i].device.os,
          ).length,
      });
    }
    if (path === '/api/security/block' && ['POST', 'DELETE'].includes(method)) {
      const value = await readBoundedJson(request);
      const action = method === 'DELETE' ? 'unblock' : value.action;
      if (
        !['block', 'unblock'].includes(String(action)) ||
        !['visitor', 'ip'].includes(String(value.type)) ||
        typeof value.value !== 'string'
      ) {
        throw new CloudSecurityError('无效的封禁操作');
      }
      let target = value.value;
      if (value.type === 'visitor') {
        if (!/^[a-f0-9]{64}$/.test(target)) throw new CloudSecurityError('无效的访客标识');
        if (target === ctx.visitorId) throw new CloudSecurityError('不能限制当前管理会话的访客');
      } else {
        target = normalizeIp(target);
        if (!publicIp(target)) throw new CloudSecurityError('不能封禁回环、私网或保留地址');
        if (target === ctx.address) throw new CloudSecurityError('不能限制当前管理会话的 IP 地址');
      }
      if (action === 'unblock') {
        await env.DB.prepare('DELETE FROM security_blocks WHERE type=? AND value=?')
          .bind(value.type, target)
          .run();
      } else {
        await env.DB.prepare(
          'INSERT INTO security_blocks(id,type,value,reason,created_at) VALUES (?,?,?,?,?) ON CONFLICT(type,value) DO UPDATE SET reason=excluded.reason',
        )
          .bind(crypto.randomUUID(), value.type, target, clean(value.reason, 240), Date.now())
          .run();
      }
      noteSecurityEvent(ctx, 'policy', action === 'block' ? '添加封禁规则' : '解除封禁规则');
      return Response.json({ ok: true });
    }
    if (path === '/api/security/sessions' && ['POST', 'DELETE'].includes(method)) {
      const value = await readBoundedJson(request);
      if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) {
        throw new CloudSecurityError('无效的会话标识');
      }
      await env.DB.prepare('DELETE FROM security_sessions WHERE id=?').bind(value.id).run();
      if (value.id === ctx.sessionId) {
        ctx.authenticated = false;
        ctx.sessionId = null;
        ctx.csrfToken = null;
        ctx.cookies.push(formatCookie('travel_session', '', 0, isHttpsRequest(request)));
      }
      noteSecurityEvent(ctx, 'policy', '撤销管理会话');
      return Response.json({ ok: true });
    }
    if (path === '/api/security/lookup' && method === 'POST') {
      const value = await readBoundedJson(request);
      if (typeof value.address !== 'string' || value.address.length > 45) {
        throw new CloudSecurityError('请输入有效的 IPv4 或 IPv6 地址');
      }
      const address = normalizeIp(value.address);
      const isPublic = publicIp(address);
      const result: NetworkLookup = {
        address,
        checkedAt: iso(Date.now()),
        addressClass: isPublic ? '公网单播地址' : '私网、保留或特殊用途地址',
        publicAddress: isPublic,
        network: null,
        route: null,
        reverseDns: [],
        sources: [
          {
            name: 'Cloudflare Workers',
            url: 'https://developers.cloudflare.com/workers/',
            status: 'unavailable',
            detail: '当前云端不执行网络归属和反向 DNS 查询。',
          },
        ],
        limitations: [
          '仅按特殊用途地址范围进行本地分类；未查询网络归属，不能据此判断访客位置或个人身份。',
        ],
      };
      return Response.json(result);
    }
  }

  throw new CloudSecurityError('不支持此请求方法或接口', 405);
}

export async function finishCloudResponse(
  request: Request,
  env: AppBindings,
  ctx: CloudContext,
  response: Response,
): Promise<Response> {
  const isWebSocketUpgrade = response.status === 101;
  const result = isWebSocketUpgrade
    ? response
    : new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
  if (!isWebSocketUpgrade) {
    for (const value of ctx.cookies) {
      result.headers.append('set-cookie', value);
    }
    result.headers.set('x-content-type-options', 'nosniff');
    result.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    result.headers.set('cache-control', 'no-store');
  }

  const info = metadata.get(ctx);
  const now = Date.now();
  const path = new URL(request.url).pathname;
  const kind = info?.kind || (result.status >= 400 ? 'blocked' : 'access');
  const polling =
    request.method === 'GET' &&
    (path.startsWith('/api/security') || path === '/api/admin/cloudflare/status') &&
    result.status < 400 &&
    !info?.kind;

  const statements: D1PreparedStatement[] = [];
  if (
    !polling &&
    !info?.skipVisit &&
    (ctx.policy.recordingEnabled || ['auth', 'policy', 'blocked'].includes(kind))
  ) {
    let referrer = '';
    try {
      const ref = new URL(request.headers.get('referer') || '');
      if (['http:', 'https:'].includes(ref.protocol)) {
        referrer = clean(`${ref.origin}${ref.pathname}`, 512);
      }
    } catch {
      /* Omit invalid referrer. */
    }
    const event: SecurityEvent = {
      id: crypto.randomUUID(),
      at: iso(now),
      visitorId: ctx.visitorId,
      sessionId: ctx.sessionId,
      address: ctx.address,
      addressSource: 'signed-proxy',
      forwardedClaim: '',
      method: request.method,
      path: clean(path, 512),
      status: result.status,
      kind,
      reasons: info?.reasons || [],
      referrer,
      device: parseDevice(request),
    };
    statements.push(
      env.DB.prepare(
        `INSERT INTO security_visitors(id,first_seen,last_seen,address,address_source,device,authenticated)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen=excluded.last_seen,
           address=excluded.address,
           address_source=excluded.address_source,
           device=excluded.device,
           authenticated=excluded.authenticated`,
      ).bind(
        ctx.visitorId,
        now,
        now,
        ctx.address,
        'signed-proxy',
        JSON.stringify(event.device),
        Number(ctx.authenticated),
      ),
      env.DB.prepare(
        'INSERT INTO security_events(id,at,visitor_id,status,kind,data) VALUES (?,?,?,?,?,?)',
      ).bind(event.id, now, ctx.visitorId, result.status, kind, JSON.stringify(event)),
    );
  }

  const shouldSweep = now - (lastSweep.get(env.DB) || 0) > 60_000 || info?.kind === 'policy';
  if (shouldSweep) {
    statements.push(
      env.DB.prepare('DELETE FROM security_sessions WHERE expires_at<=? OR last_seen<=?').bind(
        now,
        now - IDLE_MS,
      ),
      env.DB.prepare('DELETE FROM security_events WHERE at<?').bind(
        now - ctx.policy.retentionDays * 86400_000,
      ),
      env.DB.prepare(
        'DELETE FROM security_events WHERE rowid NOT IN (SELECT rowid FROM security_events ORDER BY at DESC,rowid DESC LIMIT 5000)',
      ),
      env.DB.prepare(
        'DELETE FROM security_visitors WHERE last_seen<? AND id NOT IN (SELECT visitor_id FROM security_events) AND id NOT IN (SELECT visitor_id FROM security_sessions)',
      ).bind(now - ctx.policy.retentionDays * 86400_000),
      env.DB.prepare(
        'DELETE FROM security_visitors WHERE id NOT IN (SELECT visitor_id FROM security_events) AND id NOT IN (SELECT visitor_id FROM security_sessions) AND rowid NOT IN (SELECT rowid FROM security_visitors ORDER BY last_seen DESC LIMIT 5000)',
      ),
      env.DB.prepare('DELETE FROM security_limits WHERE start<?').bind(now - 86400_000),
      env.DB.prepare(
        "DELETE FROM security_limits WHERE key LIKE 'request:%' AND rowid NOT IN (SELECT rowid FROM security_limits WHERE key LIKE 'request:%' ORDER BY start DESC,rowid DESC LIMIT 20000)",
      ),
    );
  }

  if (statements.length) {
    try {
      await env.DB.batch(statements);
      if (shouldSweep) lastSweep.set(env.DB, now);
    } catch {
      if (!isWebSocketUpgrade) {
        result.headers.set('x-travel-audit', 'unavailable');
      }
    }
  }

  return result;
}
