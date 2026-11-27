import { Hono } from 'hono';
import { ApiError } from '../shared/errors';
import { ensureSchema } from './db/schema';
import { enforceCloudRequestLimit, withCostLimits } from './middleware/cost-limits';
import {
  authorizeCloudMutation,
  beginCloudRequest,
  CloudSecurityError,
  finishCloudResponse,
  isHttpsRequest,
} from './middleware/security';
import { adminRoutes } from './routes/admin';
import { arcadeRoutes } from './routes/arcade';
import { arenaRoutes } from './routes/arena';
import { atlasRoutes } from './routes/atlas';
import { authRoutes } from './routes/auth';
import { clipboardRoutes } from './routes/clipboard';
import { cloudflareRoutes } from './routes/cloudflare';
import { projectsRoutes } from './routes/projects';
import { vaultRoutes } from './routes/vault';
import type { AppBindings, AppVariables } from './types';

export { ArenaRoomDO } from './arena/ArenaRoomDO';

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const CSP_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'sha256-Wu8yh8Y+JyrAH3BeQPQ7nVKhV7x191dMIG8H9wYsE+4='",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
].join('; ');

function applySecurityHeaders(response: Response, request: Request): Response {
  if (response.status === 101) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  if (!headers.has('Referrer-Policy')) {
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  const pathname = new URL(request.url).pathname;
  if (pathname === '/__setup' || pathname.startsWith('/api/')) {
    headers.set('Cache-Control', 'no-store');
    if (pathname === '/__setup' && response.status !== 403) {
      headers.set('Referrer-Policy', 'no-referrer');
    }
  }
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), payment=(), usb=(), geolocation=(self)',
  );
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', CSP_POLICY);
  }
  if (isHttpsRequest(request)) {
    headers.set('Strict-Transport-Security', 'max-age=15552000');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (
    url.protocol === 'http:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    url.protocol = 'https:';
    return applySecurityHeaders(
      new Response(null, { status: 308, headers: { Location: url.toString() } }),
      c.req.raw,
    );
  }

  const path = url.pathname;
  if (path !== '/__setup' && !path.startsWith('/api/')) {
    if (c.env.ASSETS) {
      const assetRes = await c.env.ASSETS.fetch(c.req.raw);
      return applySecurityHeaders(assetRes, c.req.raw);
    }
    return applySecurityHeaders(c.json({ error: 'Not Found' }, 404), c.req.raw);
  }

  await ensureSchema(c.env.DB);
  const costEnv = withCostLimits(c.env);
  c.set('costEnv', costEnv);

  const isAdminEscapePath = path === '/api/security/auth' || path.startsWith('/api/admin/');
  await enforceCloudRequestLimit(costEnv, { allowAdminOverflow: isAdminEscapePath });
  if (!costEnv.SESSION_SECRET || costEnv.SESSION_SECRET.length < 32) {
    throw new ApiError('云端安全配置尚未完成', 503);
  }

  if (path === '/__setup') {
    await next();
    c.res = applySecurityHeaders(c.res, c.req.raw);
    return;
  }

  const ctx = await beginCloudRequest(c.req.raw, costEnv);
  c.set('cloudCtx', ctx);
  await authorizeCloudMutation(c.req.raw, ctx);

  await next();

  const finished = await finishCloudResponse(c.req.raw, costEnv, ctx, c.res);
  c.res = applySecurityHeaders(finished, c.req.raw);
});

app.route('/', authRoutes);
app.route('/', projectsRoutes);
app.route('/', arcadeRoutes);
app.route('/', arenaRoutes);
app.route('/api/admin/cloudflare', cloudflareRoutes);
app.route('/api/admin', adminRoutes);
app.route('/', atlasRoutes);
app.route('/api/vault', vaultRoutes);
app.route('/api/clipboard', clipboardRoutes);

app.all('/api/*', (c) => {
  return c.json({ error: '未找到接口' }, 404);
});

app.onError(async (error, c) => {
  const known = error instanceof ApiError || error instanceof CloudSecurityError;
  const status = known ? error.status : 503;
  const message = known ? error.message : '云端服务暂时无法完成请求，请稍后重试';
  let response: Response = Response.json({ error: message }, { status });

  const path = new URL(c.req.url).pathname;
  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');
  if (path.startsWith('/api/') && costEnv && ctx) {
    try {
      response = await finishCloudResponse(c.req.raw, costEnv, ctx, response);
    } catch {
      response = Response.json({ error: '云端服务额度或存储暂不可用，请稍后重试' }, { status: 503 });
    }
  }
  return applySecurityHeaders(response, c.req.raw);
});

export default app;
