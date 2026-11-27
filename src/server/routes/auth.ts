import { Hono } from 'hono';
import {
  clientAddress,
  countRateLimit,
  formatCookie,
  handleCloudSecurity,
  isHttpsRequest,
  timingSafeEqualText,
} from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';

export const authRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const SETUP_IP_LIMIT = 10;
const SETUP_WINDOW_MS = 15 * 60_000;

authRoutes.get('/__setup', async (c) => {
  const ip = clientAddress(c.req.raw);
  const db = c.get('costEnv')?.DB ?? c.env.DB;
  if (await countRateLimit({ DB: db }, `setup:ip:${ip}`, SETUP_WINDOW_MS, SETUP_IP_LIMIT)) {
    return c.json(
      { error: '初始化请求过于频繁，请 15 分钟后重试' },
      429,
      { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    );
  }

  const token = new URL(c.req.raw.url).searchParams.get('token') || '';
  const expected = c.env.SETUP_TOKEN || '';
  const matches = expected.length >= 32 && (await timingSafeEqualText(token, expected));
  const existingPassword = await db.prepare(
    "SELECT value FROM security_settings WHERE key='password'",
  ).first();

  if (!matches || existingPassword) {
    return c.json(
      { error: '初始化链接无效或已使用' },
      403,
      { 'Cache-Control': 'no-store' },
    );
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: '/admin',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': formatCookie('travel_setup', token, 600, isHttpsRequest(c.req.raw)),
    },
  });
});

authRoutes.all('/api/security', async (c) => {
  const response = await handleCloudSecurity(c.req.raw, c.get('costEnv'), c.get('cloudCtx'));
  return response ?? c.json({ error: '未找到接口' }, 404);
});

authRoutes.all('/api/security/*', async (c) => {
  const response = await handleCloudSecurity(c.req.raw, c.get('costEnv'), c.get('cloudCtx'));
  return response ?? c.json({ error: '未找到接口' }, 404);
});
