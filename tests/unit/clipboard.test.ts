import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './test-db';
import type { AppBindings } from '../../src/server/types';
import type { ClipboardClaimResponse, ClipboardCreateResponse } from '../../src/shared/types';

const ORIGIN = 'http://127.0.0.1:5173';

async function clearClipboard() {
  await resetTestDatabase(env.DB);
  await env.DB.prepare('DELETE FROM clipboard_drops').run();
}

async function setupAdmin() {
  const res = await SELF.fetch(`${ORIGIN}/api/security/auth`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-travel-setup-token': (env as unknown as AppBindings).SETUP_TOKEN!,
    },
    body: JSON.stringify({ action: 'setup', password: 'clipboard-admin-password-2026' }),
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

describe('Phase 2 Cross-Device Clipboard API (/api/clipboard)', () => {
  beforeEach(async () => {
    await clearClipboard();
  });

  afterEach(async () => {
    await env.DB.prepare('DELETE FROM clipboard_drops').run();
  });

  it('creates a drop, hashes destroyToken in D1, claims case-insensitively, counts down maxViews, and uses zero R2 quota', async () => {
    const content = '  const note = "山海之间 · 2026";\n  console.log(note);  ';
    const createRes = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content,
        burnAfterRead: false,
        maxViews: 3,
        expiresInSeconds: 600,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as ClipboardCreateResponse;
    expect(created.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(created.destroyToken).toMatch(/^[a-f0-9]{48}$/);
    expect(created.burnAfterRead).toBe(false);
    expect(created.maxViews).toBe(3);
    expect(created.sizeBytes).toBe(new TextEncoder().encode(content).byteLength);

    // Verify D1 stores only SHA-256 hash of destroyToken, never plaintext
    const row = await env.DB.prepare('SELECT destroy_hash FROM clipboard_drops WHERE code=?')
      .bind(created.code)
      .first<{ destroy_hash: string }>();
    expect(row).not.toBeNull();
    expect(row!.destroy_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row!.destroy_hash).not.toBe(created.destroyToken);

    // 1st claim (lowercase code) -> remainingViews: 2, burned: false
    const claim1Res = await SELF.fetch(`${ORIGIN}/api/clipboard/${created.code.toLowerCase()}`);
    expect(claim1Res.status).toBe(200);
    const claim1 = (await claim1Res.json()) as ClipboardClaimResponse;
    expect(claim1.code).toBe(created.code);
    expect(claim1.content).toBe(content);
    expect(claim1.burnAfterRead).toBe(false);
    expect(claim1.remainingViews).toBe(2);
    expect(claim1.burned).toBe(false);

    // 2nd claim -> remainingViews: 1, burned: false
    const claim2Res = await SELF.fetch(`${ORIGIN}/api/clipboard/${created.code}`);
    expect(claim2Res.status).toBe(200);
    const claim2 = (await claim2Res.json()) as ClipboardClaimResponse;
    expect(claim2.remainingViews).toBe(1);
    expect(claim2.burned).toBe(false);

    // 3rd claim -> remainingViews: 0, burned: true, and auto-deleted from D1
    const claim3Res = await SELF.fetch(`${ORIGIN}/api/clipboard/${created.code}`);
    expect(claim3Res.status).toBe(200);
    const claim3 = (await claim3Res.json()) as ClipboardClaimResponse;
    expect(claim3.remainingViews).toBe(0);
    expect(claim3.burned).toBe(true);

    expect(
      await env.DB.prepare('SELECT code FROM clipboard_drops WHERE code=?').bind(created.code).first(),
    ).toBeNull();

    // 4th claim -> 404
    const claim4Res = await SELF.fetch(`${ORIGIN}/api/clipboard/${created.code}`);
    expect(claim4Res.status).toBe(404);

    // Zero R2 usage recorded
    const r2Counters = await env.DB.prepare(
      "SELECT key, value FROM usage_limits WHERE key LIKE 'r2-%'",
    ).all<{ key: string; value: number }>();
    expect(r2Counters.results).toEqual([]);
  });

  it('enforces atomic burn-after-read (forces maxViews=1, 2nd claim returns 404)', async () => {
    const createRes = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'one-time-secret-token',
        burnAfterRead: true,
        maxViews: 15, // Must be forced to 1
        expiresInSeconds: 3600,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as ClipboardCreateResponse;
    expect(created.burnAfterRead).toBe(true);
    expect(created.maxViews).toBe(1);

    const first = await SELF.fetch(`${ORIGIN}/api/clipboard/${created.code}`);
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as ClipboardClaimResponse;
    expect(firstJson.content).toBe('one-time-secret-token');
    expect(firstJson.burnAfterRead).toBe(true);
    expect(firstJson.burned).toBe(true);
    expect(firstJson.remainingViews).toBe(0);

    // Row already removed; 2nd read returns 404
    const second = await SELF.fetch(`${ORIGIN}/api/clipboard/${created.code}`);
    expect(second.status).toBe(404);
  });

  it('rejects empty content, invalid options, and payloads exceeding 32 KiB UTF-8', async () => {
    // Missing origin -> 403
    const noOrigin = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(noOrigin.status).toBe(403);

    // Empty / whitespace content -> 400
    const emptyRes = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '   \n\t  ' }),
    });
    expect(emptyRes.status).toBe(400);

    // Exact 32 KiB ASCII -> 201
    const exactRes = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'a'.repeat(32 * 1024) }),
    });
    expect(exactRes.status).toBe(201);

    // 32 KiB + 1 byte ASCII -> 413
    const overAscii = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'a'.repeat(32 * 1024 + 1) }),
    });
    expect(overAscii.status).toBe(413);

    // Multibyte UTF-8 exceeding 32 KiB (10,923 Chinese chars = 32,769 bytes) -> 413
    const overUtf8 = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '星'.repeat(10_923) }),
    });
    expect(overUtf8.status).toBe(413);

    // Invalid TTL & maxViews -> 400
    const badTtl = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ok', expiresInSeconds: 30 }),
    });
    expect(badTtl.status).toBe(400);

    const badMaxViews = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ok', maxViews: 25 }),
    });
    expect(badMaxViews.status).toBe(400);

    // Invalid code param -> 400
    const badCode = await SELF.fetch(`${ORIGIN}/api/clipboard/BAD!`);
    expect(badCode.status).toBe(400);
  });

  it('cleans up expired rows on claim and sweeps expired rows on create', async () => {
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO clipboard_drops (code, content, destroy_hash, burn_after_read, views, max_views, expires_at, created_at)
         VALUES (?, ?, ?, 0, 0, 5, ?, ?)`,
      ).bind('EXP001', 'expired-1', '0'.repeat(64), pastIso, pastIso),
      env.DB.prepare(
        `INSERT INTO clipboard_drops (code, content, destroy_hash, burn_after_read, views, max_views, expires_at, created_at)
         VALUES (?, ?, ?, 0, 0, 5, ?, ?)`,
      ).bind('EXP002', 'expired-2', '0'.repeat(64), pastIso, pastIso),
    ]);

    // Claiming EXP001 -> 404 and removes EXP001
    const expiredClaim = await SELF.fetch(`${ORIGIN}/api/clipboard/EXP001`);
    expect(expiredClaim.status).toBe(404);
    expect(
      await env.DB.prepare('SELECT code FROM clipboard_drops WHERE code=?').bind('EXP001').first(),
    ).toBeNull();

    // Creating a new drop sweeps remaining expired EXP002
    const createRes = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'fresh drop' }),
    });
    expect(createRes.status).toBe(201);
    expect(
      await env.DB.prepare('SELECT code FROM clipboard_drops WHERE code=?').bind('EXP002').first(),
    ).toBeNull();
  });

  it('verifies X-Destroy-Token on DELETE and allows authenticated admin deletion', async () => {
    const createRes = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'destroyable-text' }),
    });
    expect(createRes.status).toBe(201);
    const drop1 = (await createRes.json()) as ClipboardCreateResponse;

    // Missing token -> 403
    const noToken = await SELF.fetch(`${ORIGIN}/api/clipboard/${drop1.code}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN },
    });
    expect(noToken.status).toBe(403);

    // Wrong token -> 403
    const wrongToken = await SELF.fetch(`${ORIGIN}/api/clipboard/${drop1.code}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'x-destroy-token': 'deadbeef'.repeat(6) },
    });
    expect(wrongToken.status).toBe(403);

    // Valid token -> 200 and deleted
    const okDelete = await SELF.fetch(`${ORIGIN}/api/clipboard/${drop1.code}`, {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'x-destroy-token': drop1.destroyToken },
    });
    expect(okDelete.status).toBe(200);
    expect(await okDelete.json()).toEqual({ ok: true, code: drop1.code });
    expect((await SELF.fetch(`${ORIGIN}/api/clipboard/${drop1.code}`)).status).toBe(404);

    // Authenticated admin can delete another drop without X-Destroy-Token
    const createRes2 = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'admin-removable' }),
    });
    const drop2 = (await createRes2.json()) as ClipboardCreateResponse;
    const auth = await setupAdmin();

    const adminDel = await SELF.fetch(`${ORIGIN}/api/clipboard/${drop2.code}`, {
      method: 'DELETE',
      headers: {
        origin: ORIGIN,
        cookie: auth.cookies,
        'x-travel-csrf': auth.csrfToken,
      },
    });
    expect(adminDel.status).toBe(200);
    expect(await adminDel.json()).toEqual({ ok: true, code: drop2.code });
  });

  it('enforces per-visitor rate limits on create (20/15m) and claim (40/15m)', async () => {
    // Capture visitor cookie on first request so all requests share one visitorId
    let visitorCookie = '';
    for (let i = 0; i < 20; i += 1) {
      const res = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          ...(visitorCookie ? { cookie: visitorCookie } : {}),
        },
        body: JSON.stringify({ content: `item-${i}` }),
      });
      expect(res.status).toBe(201);
      if (!visitorCookie) {
        const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('travel_visitor='));
        if (setCookie) visitorCookie = setCookie.split(';')[0]!;
      }
    }

    // 21st create from same visitor -> 429
    const blockedCreate = await SELF.fetch(`${ORIGIN}/api/clipboard`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: visitorCookie,
      },
      body: JSON.stringify({ content: 'over-limit' }),
    });
    expect(blockedCreate.status).toBe(429);

    // 40 claim attempts -> 404 (missing code), 41st -> 429
    for (let i = 0; i < 40; i += 1) {
      const res = await SELF.fetch(`${ORIGIN}/api/clipboard/ZZZZ99`, {
        headers: { cookie: visitorCookie },
      });
      expect(res.status).toBe(404);
    }
    const blockedClaim = await SELF.fetch(`${ORIGIN}/api/clipboard/ZZZZ99`, {
      headers: { cookie: visitorCookie },
    });
    expect(blockedClaim.status).toBe(429);
  });
});
