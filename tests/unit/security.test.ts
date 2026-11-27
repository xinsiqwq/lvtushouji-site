import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './test-db';
import app from '../../src/server/index';
import {
  beginCloudRequest,
  finishCloudResponse,
  handleCloudSecurity,
  requireCloudAdmin,
  timingSafeEqualText,
} from '../../src/server/middleware/security';
import type { AppBindings, CloudContext } from '../../src/server/types';

const PASSWORD = 'long-enough-test-password';
const HTTPS_ORIGIN = 'https://travel.example';

function createCallHelper(customEnv?: AppBindings) {
  const targetEnv = customEnv ?? (env as unknown as AppBindings);
  const jar = new Map<string, string>();

  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
    origin = HTTPS_ORIGIN,
  ) {
    const request = new Request(origin + path, {
      method,
      headers: {
        origin,
        'CF-Connecting-IP': '8.8.8.8',
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    let ctx: CloudContext | undefined;
    let response: Response;
    try {
      ctx = await beginCloudRequest(request, targetEnv);
      response =
        (await handleCloudSecurity(request, targetEnv, ctx)) ??
        new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
    } catch (error) {
      response = Response.json(
        { error: (error as Error).message },
        { status: (error as { status?: number }).status || 500 },
      );
    }
    if (ctx) {
      response = await finishCloudResponse(request, targetEnv, ctx, response);
    }
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx);
      const val = pair.slice(idx + 1);
      if (val === '') jar.delete(name);
      else jar.set(name, val);
    }
    return { response, body: (await response.json()) as Record<string, unknown>, ctx };
  }

  async function setup() {
    const res = await call(
      '/api/security/auth',
      'POST',
      { action: 'setup', password: PASSWORD },
      { 'x-travel-setup-token': targetEnv.SETUP_TOKEN! },
    );
    expect(res.response.status).toBe(200);
    return res.body as { csrfToken: string; sessionId: string };
  }

  return { jar, call, setup, env: targetEnv };
}

describe('security middleware & auth routes', () => {
  beforeEach(async () => {
    await resetTestDatabase(env.DB);
  });

  it('timingSafeEqualText compares equal and unequal strings accurately', async () => {
    expect(await timingSafeEqualText('secret-abc', 'secret-abc')).toBe(true);
    expect(await timingSafeEqualText('secret-abc', 'secret-abd')).toBe(false);
    expect(await timingSafeEqualText('short', 'much-longer-string')).toBe(false);
  });

  it('initial setup is fail-closed, origin-checked, requires setup token, and never logs secrets', async () => {
    const f = createCallHelper();
    const status = await f.call('/api/security/auth');
    expect(status.body.configured).toBe(false);
    expect(() => requireCloudAdmin(status.ctx!)).toThrow(/登录|初始化/);
    expect((await f.call('/api/security')).response.status).toBe(401);
    expect(
      (await f.call('/api/security/auth', 'POST', { action: 'setup', password: PASSWORD }))
        .response.status,
    ).toBe(403);
    expect(
      (
        await f.call(
          '/api/security/auth',
          'POST',
          { action: 'setup', password: PASSWORD },
          { 'x-travel-setup-token': f.env.SETUP_TOKEN!, origin: 'https://evil.example' },
        )
      ).response.status,
    ).toBe(403);

    f.jar.set('travel_setup', f.env.SETUP_TOKEN!);
    const created = await f.call('/api/security/auth', 'POST', {
      action: 'setup',
      password: PASSWORD,
    });
    expect(created.response.status).toBe(200);
    expect(created.body.authenticated).toBe(true);
    expect(created.body.csrfToken).toBeTruthy();

    const setCookies = created.response.headers.getSetCookie();
    expect(
      setCookies.some(
        (c) =>
          /travel_session=/.test(c) &&
          /Secure/.test(c) &&
          /HttpOnly/.test(c) &&
          /SameSite=Strict/.test(c),
      ),
    ).toBe(true);

    // Repeating setup returns 409
    expect(
      (
        await f.call(
          '/api/security/auth',
          'POST',
          { action: 'setup', password: PASSWORD },
          { 'x-travel-csrf': String(created.body.csrfToken) },
        )
      ).response.status,
    ).toBe(409);

    const stored = await env.DB.prepare(
      "SELECT value FROM security_settings WHERE key='password'",
    ).first<string>('value');
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(PASSWORD);

    const events = await env.DB.prepare('SELECT data FROM security_events').all();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(f.env.SETUP_TOKEN!);
    expect(serialized).not.toContain(PASSWORD);
  });

  it('omits Secure cookie attribute on http://127.0.0.1 local dev', async () => {
    const f = createCallHelper();
    const res = await f.call(
      '/api/security/auth',
      'POST',
      { action: 'setup', password: PASSWORD },
      { 'x-travel-setup-token': f.env.SETUP_TOKEN! },
      'http://127.0.0.1:5173',
    );
    expect(res.response.status).toBe(200);
    const sessionCookie = res.response.headers
      .getSetCookie()
      .find((c) => c.startsWith('travel_session='));
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).not.toContain('Secure');
  });

  it('concurrent setup creates exactly one admin session', async () => {
    const f = createCallHelper();
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        f.call(
          '/api/security/auth',
          'POST',
          { action: 'setup', password: PASSWORD },
          { 'x-travel-setup-token': f.env.SETUP_TOKEN! },
        ),
      ),
    );
    expect(outcomes.map((r) => r.response.status).sort()).toEqual([200, 409]);
    expect(
      await env.DB.prepare('SELECT count(*) count FROM security_sessions').first('count'),
    ).toBe(1);
  });

  it('requires CSRF + Origin, revokes sessions on password change, and preserves idle expiry on auth GET', async () => {
    const f = createCallHelper();
    const auth = await f.setup();
    const firstSession = f.jar.get('travel_session')!;

    // Note: handleCloudSecurity checks authorizeCloudMutation inside routes or middleware;
    // test via SELF.fetch for full Hono pipeline AND direct call
    const csrfRes = await SELF.fetch('https://travel.example/api/security', {
      method: 'PATCH',
      headers: {
        origin: 'https://travel.example',
        'content-type': 'application/json',
        cookie: `travel_session=${firstSession}; travel_visitor=${f.jar.get('travel_visitor')}`,
      },
      body: JSON.stringify({ retentionDays: 7 }),
    });
    expect(csrfRes.status).toBe(403);

    const evilOriginRes = await SELF.fetch('https://travel.example/api/security', {
      method: 'PATCH',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: `travel_session=${firstSession}; travel_visitor=${f.jar.get('travel_visitor')}`,
      },
      body: JSON.stringify({ retentionDays: 7 }),
    });
    expect(evilOriginRes.status).toBe(403);

    const validPatch = await SELF.fetch('https://travel.example/api/security', {
      method: 'PATCH',
      headers: {
        origin: 'https://travel.example',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: `travel_session=${firstSession}; travel_visitor=${f.jar.get('travel_visitor')}`,
      },
      body: JSON.stringify({ retentionDays: 7 }),
    });
    expect(validPatch.status).toBe(200);
    expect(((await validPatch.json()) as { retentionDays: number }).retentionDays).toBe(7);

    const changed = await f.call(
      '/api/security/auth',
      'POST',
      { action: 'password', oldPassword: PASSWORD, newPassword: `${PASSWORD}-new` },
      { 'x-travel-csrf': auth.csrfToken },
    );
    expect(changed.response.status).toBe(200);
    expect(changed.body.sessionId).not.toBe(auth.sessionId);

    const newSession = f.jar.get('travel_session')!;
    f.jar.set('travel_session', firstSession);
    expect((await f.call('/api/security/auth')).body.authenticated).toBe(false);

    f.jar.set('travel_session', newSession);
    const lastSeen = Date.now() - 60_000;
    await env.DB.prepare('UPDATE security_sessions SET last_seen=? WHERE id=?')
      .bind(lastSeen, changed.body.sessionId)
      .run();
    expect((await f.call('/api/security/auth')).body.authenticated).toBe(true);
    expect(
      await env.DB.prepare('SELECT last_seen FROM security_sessions WHERE id=?')
        .bind(changed.body.sessionId)
        .first('last_seen'),
    ).toBe(lastSeen);

    await env.DB.prepare('UPDATE security_sessions SET last_seen=?')
      .bind(Date.now() - 31 * 60_000)
      .run();
    expect((await f.call('/api/security/auth')).body.authenticated).toBe(false);
    expect((await f.call('/api/security')).response.status).toBe(401);
  });

  it('enforces persistent 5-attempt / 15-min login rate limit across cleared visitor cookies', async () => {
    const f = createCallHelper();
    const auth = await f.setup();
    const logout = await f.call(
      '/api/security/auth',
      'POST',
      { action: 'logout' },
      { 'x-travel-csrf': auth.csrfToken },
    );
    expect(logout.body.authenticated).toBe(false);

    for (let i = 0; i < 5; i++) {
      f.jar.clear();
      expect(
        (await f.call('/api/security/auth', 'POST', { action: 'login', password: 'wrong' }))
          .response.status,
      ).toBe(401);
    }
    f.jar.clear();
    expect(
      (await f.call('/api/security/auth', 'POST', { action: 'login', password: PASSWORD }))
        .response.status,
    ).toBe(429);
  });

  it('handles SESSION_SECRET < 32 with 503 and survives D1 audit outage', async () => {
    const weakEnv = { ...(env as unknown as AppBindings), SESSION_SECRET: 'short' };
    const f = createCallHelper(weakEnv);
    expect((await f.call('/api/security/auth')).response.status).toBe(503);

    const normalEnv = env as unknown as AppBindings;
    const req = new Request(`${HTTPS_ORIGIN}/api/security/auth`, {
      headers: { 'CF-Connecting-IP': '8.8.8.8' },
    });
    const ctx = await beginCloudRequest(req, normalEnv);
    const failingEnv = {
      ...normalEnv,
      DB: {
        prepare: normalEnv.DB.prepare.bind(normalEnv.DB),
        batch: async () => {
          throw new Error('D1 quota exhausted');
        },
      } as unknown as D1Database,
    };
    const res = await finishCloudResponse(
      req,
      failingEnv,
      ctx,
      Response.json({ error: 'denied' }, { status: 401 }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('x-travel-audit')).toBe('unavailable');
  });

  it('runs full /__setup redirect and auth cookie lifecycle through SELF.fetch Worker', async () => {
    const badSetup = await SELF.fetch('http://127.0.0.1:5173/__setup?token=wrong');
    expect(badSetup.status).toBe(403);

    const setupRedirect = await SELF.fetch(
      `http://127.0.0.1:5173/__setup?token=${(env as unknown as AppBindings).SETUP_TOKEN}`,
      { redirect: 'manual' },
    );
    expect(setupRedirect.status).toBe(303);
    expect(setupRedirect.headers.get('location')).toBe('/admin');
    expect(setupRedirect.headers.get('referrer-policy')).toBe('no-referrer');

    const setupCookie = setupRedirect.headers
      .getSetCookie()
      .find((c: string) => c.startsWith('travel_setup='))!
      .split(';')[0];

    const completed = await SELF.fetch('http://127.0.0.1:5173/api/security/auth', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        cookie: setupCookie,
      },
      body: JSON.stringify({ action: 'setup', password: PASSWORD }),
    });
    expect(completed.status).toBe(200);
    const authJson = (await completed.json()) as { authenticated: boolean; csrfToken: string };
    expect(authJson.authenticated).toBe(true);

    const sessionCookies = completed.headers
      .getSetCookie()
      .filter((c: string) => !c.includes('Max-Age=0'))
      .map((c: string) => c.split(';')[0])
      .join('; ');

    const check = await SELF.fetch('http://127.0.0.1:5173/api/security/auth', {
      headers: { cookie: sessionCookies },
    });
    expect(((await check.json()) as { authenticated: boolean }).authenticated).toBe(true);
  });

  it('enforces per-IP rate limiting on GET /__setup without logging tokens to security_events', async () => {
    const setupToken = (env as unknown as AppBindings).SETUP_TOKEN!;
    for (let i = 0; i < 10; i++) {
      const attempt = await SELF.fetch('http://127.0.0.1:5173/__setup?token=wrong');
      expect(attempt.status).toBe(403);
      expect(attempt.headers.get('cache-control')).toBe('no-store');
      expect(attempt.headers.get('x-content-type-options')).toBe('nosniff');
      expect(attempt.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    }

    const throttled = await SELF.fetch(`http://127.0.0.1:5173/__setup?token=${setupToken}`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': '198.51.100.77' },
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('cache-control')).toBe('no-store');
    expect(throttled.headers.get('x-content-type-options')).toBe('nosniff');
    expect(throttled.headers.get('referrer-policy')).toBe('no-referrer');
    expect(throttled.headers.getSetCookie().some((c) => c.startsWith('travel_setup='))).toBe(false);

    const otherIp = await app.fetch(
      new Request(`http://127.0.0.1:5173/__setup?token=${setupToken}`, {
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
      }),
      env as unknown as AppBindings,
    );
    expect(otherIp.status).toBe(303);

    expect(
      await env.DB.prepare('SELECT count(*) count FROM security_events').first('count'),
    ).toBe(0);

    const limitRows = await env.DB.prepare('SELECT key FROM security_limits').all<{ key: string }>();
    const keys = limitRows.results.map((r) => r.key);
    expect(keys).toContain('setup:ip:127.0.0.1');
    expect(keys).toContain('setup:ip:203.0.113.10');
    expect(JSON.stringify(keys)).not.toContain(setupToken);
  });
});
