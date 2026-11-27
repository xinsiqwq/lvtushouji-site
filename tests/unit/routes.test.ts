import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './test-db';
import app from '../../src/server/index';
import { COST_LIMITS, currentUsageMonth } from '../../src/server/middleware/cost-limits';
import type { AppBindings } from '../../src/server/types';
import { DEFAULT_SITE_SETTINGS } from '../../src/shared/types';

async function setupAdminSession() {
  const res = await SELF.fetch('http://127.0.0.1:5173/api/security/auth', {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:5173',
      'content-type': 'application/json',
      'x-travel-setup-token': (env as unknown as AppBindings).SETUP_TOKEN!,
    },
    body: JSON.stringify({ action: 'setup', password: 'route-test-password-123' }),
  });
  expect(res.status).toBe(200);
  const cookies = res.headers
    .getSetCookie()
    .filter((c: string) => !c.includes('Max-Age=0'))
    .map((c: string) => c.split(';')[0])
    .join('; ');
  const json = (await res.json()) as { csrfToken: string };
  return { cookies, csrfToken: json.csrfToken };
}

describe('Hono routes & isolation smoke tests', () => {
  beforeEach(async () => {
    await resetTestDatabase(env.DB);
  });

  it('filters private journeys/media on unauthed /api/library and returns ETag 304', async () => {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO journeys (id,data) VALUES (?,?)').bind(
        'pub1',
        JSON.stringify({
          id: 'pub1',
          title: '公开旅程',
          subtitle: '',
          startDate: '2026-09-01',
          endDate: '2026-09-02',
          visibility: 'public',
          coverId: 'm_pub',
          stops: [{ id: 's1', name: '站1', region: '', lat: 30, lng: 100, date: '2026-09-01', note: '', mediaIds: ['m_pub'] }],
          createdAt: '2026-09-02T00:00:00Z',
        }),
      ),
      env.DB.prepare('INSERT INTO journeys (id,data) VALUES (?,?)').bind(
        'priv1',
        JSON.stringify({
          id: 'priv1',
          title: '私密旅程',
          subtitle: '',
          startDate: '2026-09-03',
          endDate: '2026-09-04',
          visibility: 'private',
          coverId: 'm_priv',
          stops: [],
          createdAt: '2026-09-04T00:00:00Z',
        }),
      ),
      env.DB.prepare(
        'INSERT INTO media (id,data,original,thumbnail,preview,hash) VALUES (?,?,?,?,?,?)',
      ).bind(
        'm_pub',
        JSON.stringify({ id: 'm_pub', name: 'pub.jpg' }),
        'atlas/m_pub/original.jpg',
        'atlas/m_pub/thumb-600.webp',
        'atlas/m_pub/preview-1600.webp',
        'h1',
      ),
      env.DB.prepare(
        'INSERT INTO media (id,data,original,thumbnail,preview,hash) VALUES (?,?,?,?,?,?)',
      ).bind(
        'm_priv',
        JSON.stringify({ id: 'm_priv', name: 'priv.jpg' }),
        'atlas/m_priv/original.jpg',
        'atlas/m_priv/thumb-600.webp',
        'atlas/m_priv/preview-1600.webp',
        'h2',
      ),
    ]);

    const res = await SELF.fetch('http://127.0.0.1:5173/api/library');
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();

    const body = (await res.json()) as {
      journeys: Array<{ id: string }>;
      media: Array<{ id: string }>;
      access: { role: string };
    };
    expect(body.access.role).toBe('visitor');
    expect(body.journeys.map((j) => j.id)).toEqual(['pub1']);
    expect(body.media.map((m) => m.id)).toEqual(['m_pub']);

    const cached = await SELF.fetch('http://127.0.0.1:5173/api/library', {
      headers: { 'if-none-match': etag! },
    });
    expect(cached.status).toBe(304);
  });

  it('guards admin endpoints with 401/403 and supports usage, settings, trash, and restore', async () => {
    expect((await SELF.fetch('http://127.0.0.1:5173/api/admin/usage')).status).toBe(401);
    expect((await SELF.fetch('http://127.0.0.1:5173/api/atlas/config')).status).toBe(200);

    const auth = await setupAdminSession();

    // Missing Origin/CSRF -> 403
    const noOrigin = await SELF.fetch('http://127.0.0.1:5173/api/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: auth.cookies },
      body: JSON.stringify({ title: '旅途手记·改', tagline: '新的副标' }),
    });
    expect(noOrigin.status).toBe(403);

    const noCsrf = await SELF.fetch('http://127.0.0.1:5173/api/admin/settings', {
      method: 'PATCH',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        cookie: auth.cookies,
      },
      body: JSON.stringify({ title: '旅途手记·改', tagline: '新的副标' }),
    });
    expect(noCsrf.status).toBe(403);

    const patched = await SELF.fetch('http://127.0.0.1:5173/api/admin/settings', {
      method: 'PATCH',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: auth.cookies,
      },
      body: JSON.stringify({ title: '旅途手记·改', tagline: '新的副标' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { title: string }).title).toBe('旅途手记·改');

    const usageRes = await SELF.fetch('http://127.0.0.1:5173/api/admin/usage', {
      headers: { cookie: auth.cookies },
    });
    expect(usageRes.status).toBe(200);
    const usageJson = (await usageRes.json()) as {
      limits: { apiRequests: number };
      counters: Array<{ key: string; value: number }>;
    };
    expect(usageJson.limits.apiRequests).toBe(200_000);
    expect(usageJson.counters.some((c) => c.key.startsWith('api-requests:'))).toBe(true);

    // Trash and restore a vault_file
    await env.DB.prepare(
      'INSERT INTO vault_files (id,name,mime,size,sha256,r2_key,chunk_count,visibility,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
      .bind('vf_trash', 'note.txt', 'text/plain', 12, 'abc', 'vault/vf_trash/part-0', 1, 'private', '2026-11-20T00:00:00Z')
      .run();

    const trashed = await SELF.fetch('http://127.0.0.1:5173/api/admin/trash', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: auth.cookies,
      },
      body: JSON.stringify({ kind: 'vault_file', id: 'vf_trash' }),
    });
    expect(trashed.status).toBe(200);
    const trashItem = (await trashed.json()) as { key: string; kind: string };
    expect(trashItem.kind).toBe('vault_file');
    expect(await env.DB.prepare('SELECT id FROM vault_files WHERE id=?').bind('vf_trash').first()).toBeNull();

    const restored = await SELF.fetch('http://127.0.0.1:5173/api/admin/restore', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: auth.cookies,
      },
      body: JSON.stringify({ key: trashItem.key }),
    });
    expect(restored.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM vault_files WHERE id=?').bind('vf_trash').first()).not.toBeNull();
  });

  it('protects vault admin routes with 401 and supports upload, share, redeem, download, and revocation', async () => {
    const wrongRedeem = await SELF.fetch('http://127.0.0.1:5173/api/vault/redeem', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(wrongRedeem.status).toBe(401);

    const unauthedUploadInit = await SELF.fetch('http://127.0.0.1:5173/api/vault/uploads/init', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(unauthedUploadInit.status).toBe(401);

    const auth = await setupAdminSession();
    const payload = new TextEncoder().encode('hello-vault-unit');
    const sha = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', payload)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');

    const initRes = await SELF.fetch('http://127.0.0.1:5173/api/vault/uploads/init', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: auth.cookies,
      },
      body: JSON.stringify({
        name: 'note.txt',
        mime: 'text/plain',
        size: payload.byteLength,
        sha256: sha,
        totalChunks: 1,
      }),
    });
    expect(initRes.status).toBe(200);
    const { uploadId } = (await initRes.json()) as { uploadId: string };

    const chunkRes = await SELF.fetch(`http://127.0.0.1:5173/api/vault/uploads/${uploadId}/chunk`, {
      method: 'PUT',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/octet-stream',
        'x-chunk-index': '0',
        'x-travel-csrf': auth.csrfToken,
        cookie: auth.cookies,
      },
      body: payload,
    });
    expect(chunkRes.status).toBe(200);

    const completeRes = await SELF.fetch(`http://127.0.0.1:5173/api/vault/uploads/${uploadId}/complete`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: auth.cookies,
      },
      body: JSON.stringify({}),
    });
    expect(completeRes.status).toBe(200);
    const { fileId } = (await completeRes.json()) as { fileId: string };

    const shareRes = await SELF.fetch('http://127.0.0.1:5173/api/vault/shares', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: auth.cookies,
      },
      body: JSON.stringify({ fileId, maxDownloads: 2, expiresIn: 3600, passcode: 'Ab12Xy' }),
    });
    expect(shareRes.status).toBe(201);
    const { share } = (await shareRes.json()) as { share: { id: string } };

    const redeemRes = await SELF.fetch('http://127.0.0.1:5173/api/vault/redeem', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ab12xy', requestId: 'unit-req-1' }),
    });
    expect(redeemRes.status).toBe(200);
    const { downloadUrl } = (await redeemRes.json()) as { downloadUrl: string };

    const dlRes = await SELF.fetch(`http://127.0.0.1:5173${downloadUrl}`);
    expect(dlRes.status).toBe(200);
    expect(await dlRes.text()).toBe('hello-vault-unit');

    const revokeRes = await SELF.fetch(`http://127.0.0.1:5173/api/vault/shares/${share.id}/revoke`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'x-travel-csrf': auth.csrfToken,
        cookie: auth.cookies,
      },
      body: JSON.stringify({}),
    });
    expect(revokeRes.status).toBe(200);

    const blockedRedeem = await SELF.fetch('http://127.0.0.1:5173/api/vault/redeem', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'Ab12Xy' }),
    });
    expect(blockedRedeem.status).toBe(403);
  });

  it('sets Cache-Control: no-store and nosniff on pre-ctx 429, 503, and 400 API/setup error responses', async () => {
    await env.DB.prepare('INSERT INTO usage_limits (key, value) VALUES (?, ?)')
      .bind(`api-requests:${currentUsageMonth()}`, COST_LIMITS.apiRequests)
      .run();

    const api429 = await SELF.fetch('http://127.0.0.1:5173/api/library');
    expect(api429.status).toBe(429);
    expect(api429.headers.get('cache-control')).toBe('no-store');
    expect(api429.headers.get('x-content-type-options')).toBe('nosniff');

    const setup429 = await SELF.fetch('http://127.0.0.1:5173/__setup?token=test');
    expect(setup429.status).toBe(429);
    expect(setup429.headers.get('cache-control')).toBe('no-store');
    expect(setup429.headers.get('x-content-type-options')).toBe('nosniff');
    expect(setup429.headers.get('referrer-policy')).toBe('no-referrer');

    const adminEscapeAuth = await SELF.fetch('http://127.0.0.1:5173/api/security/auth');
    expect(adminEscapeAuth.status).toBe(200);

    await env.DB.prepare('DELETE FROM usage_limits').run();

    const weakEnv = {
      ...(env as unknown as AppBindings),
      SESSION_SECRET: 'short',
    } as AppBindings;
    const api503 = await app.fetch(new Request('http://127.0.0.1:5173/api/library'), weakEnv);
    expect(api503.status).toBe(503);
    expect(api503.headers.get('cache-control')).toBe('no-store');
    expect(api503.headers.get('x-content-type-options')).toBe('nosniff');

    const setup503 = await app.fetch(new Request('http://127.0.0.1:5173/__setup?token=test'), weakEnv);
    expect(setup503.status).toBe(503);
    expect(setup503.headers.get('cache-control')).toBe('no-store');
    expect(setup503.headers.get('x-content-type-options')).toBe('nosniff');
    expect(setup503.headers.get('referrer-policy')).toBe('no-referrer');

    const badIp400 = await app.fetch(
      new Request('http://127.0.0.1:5173/api/library', {
        headers: { 'CF-Connecting-IP': 'not-an-ip' },
      }),
      env as unknown as AppBindings,
    );
    expect(badIp400.status).toBe(400);
    expect(badIp400.headers.get('cache-control')).toBe('no-store');
    expect(badIp400.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('falls back to DEFAULT_SITE_SETTINGS when admin_settings JSON is malformed or non-object', async () => {
    await env.DB.prepare("INSERT INTO admin_settings (key, data) VALUES ('site', ?)")
      .bind('{invalid-json')
      .run();

    const malformedRes = await SELF.fetch('http://127.0.0.1:5173/api/library');
    expect(malformedRes.status).toBe(200);
    expect(((await malformedRes.json()) as { settings: unknown }).settings).toEqual(
      DEFAULT_SITE_SETTINGS,
    );

    await env.DB.prepare("UPDATE admin_settings SET data=? WHERE key='site'").bind('[]').run();
    const arrayRes = await SELF.fetch('http://127.0.0.1:5173/api/library');
    expect(arrayRes.status).toBe(200);
    expect(((await arrayRes.json()) as { settings: unknown }).settings).toEqual(
      DEFAULT_SITE_SETTINGS,
    );
  });
});
