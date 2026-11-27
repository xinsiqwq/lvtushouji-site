import { env, SELF } from 'cloudflare:test';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './test-db';
import type { AppBindings } from '../../src/server/types';
import type {
  ArcadeAdminScoresResponse,
  ArcadeGameId,
  ArcadeLeaderboardResponse,
  ArcadeScoreEntry,
  ArcadeSubmitResponse,
} from '../../src/shared/types';

const ORIGIN = 'http://127.0.0.1:5173';

async function clearArcade() {
  await resetTestDatabase(env.DB);
  await env.DB.prepare('DELETE FROM arcade_scores').run();
}

async function setupAdmin() {
  const res = await SELF.fetch(`${ORIGIN}/api/security/auth`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-travel-setup-token': (env as unknown as AppBindings).SETUP_TOKEN!,
    },
    body: JSON.stringify({ action: 'setup', password: 'arcade-admin-password-2026' }),
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

function adminHeaders(auth: { cookies: string; csrfToken: string }, withJson = true) {
  return {
    origin: ORIGIN,
    cookie: auth.cookies,
    'x-travel-csrf': auth.csrfToken,
    ...(withJson ? { 'content-type': 'application/json' } : {}),
  };
}

describe('Phase 3 Mars Arcade Leaderboard API (/api/arcade & /api/admin/arcade)', () => {
  beforeEach(async () => {
    await clearArcade();
  });

  afterEach(async () => {
    await env.DB.prepare('DELETE FROM arcade_scores').run();
  });

  it('submits desc scores, ranks Top 10 cleanly, strips XSS chars from playerName, and never leaks visitor_id publicly', async () => {
    const submit1 = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        gameId: 'dino',
        playerName: '  <Mars>Pilot  ',
        score: 420,
        durationMs: 32500,
        meta: { maxSpeed: 12.5 },
      }),
    });
    expect(submit1.status).toBe(201);
    const body1 = (await submit1.json()) as ArcadeSubmitResponse;
    expect(body1.entry.playerName).toBe('MarsPilot');
    expect(body1.rank).toBe(1);
    expect(body1.madeTop10).toBe(true);
    expect(body1.entry.visitorPrefix).toBeUndefined();
    expect(JSON.stringify(body1)).not.toContain('visitor_id');
    expect(JSON.stringify(body1)).not.toContain('visitorPrefix');

    const submit2 = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        gameId: 'dino',
        playerName: '星际漫游者',
        score: 1280,
        durationMs: 91000,
        meta: { maxSpeed: 18 },
      }),
    });
    expect(submit2.status).toBe(201);
    const body2 = (await submit2.json()) as ArcadeSubmitResponse;
    expect(body2.rank).toBe(1);
    expect(body2.leaderboard.map((e) => e.score)).toEqual([1280, 420]);

    // Public single-game GET
    const getSingle = await SELF.fetch(`${ORIGIN}/api/arcade/scores?gameId=dino`);
    expect(getSingle.status).toBe(200);
    const rawSingle = await getSingle.text();
    expect(rawSingle).not.toContain('visitorPrefix');
    expect(rawSingle).not.toContain('visitor_id');
    const single = JSON.parse(rawSingle) as ArcadeLeaderboardResponse;
    expect(single.gameId).toBe('dino');
    expect(single.sortDirection).toBe('desc');
    expect(single.entries.map((e) => e.playerName)).toEqual(['星际漫游者', 'MarsPilot']);

    // Public all-games GET
    const getAll = await SELF.fetch(`${ORIGIN}/api/arcade/scores`);
    expect(getAll.status).toBe(200);
    const allJson = (await getAll.json()) as { leaderboards: Record<ArcadeGameId, ArcadeScoreEntry[]> };
    expect(allJson.leaderboards.dino).toHaveLength(2);
    expect(allJson.leaderboards.tetris).toEqual([]);
    expect(allJson.leaderboards.minesweeper).toEqual([]);
  });

  it('ranks minesweeper scores ASC by completion milliseconds (lower time is better)', async () => {
    const slow = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        gameId: 'minesweeper',
        playerName: 'Steady',
        score: 48200,
        durationMs: 48200,
        meta: { difficulty: 'beginner', mines: 10 },
      }),
    });
    expect(slow.status).toBe(201);
    expect(((await slow.json()) as ArcadeSubmitResponse).rank).toBe(1);

    const fast = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        gameId: 'minesweeper',
        playerName: 'Swift',
        score: 14320,
        durationMs: 14320,
        meta: { difficulty: 'beginner', mines: 10 },
      }),
    });
    expect(fast.status).toBe(201);
    const fastBody = (await fast.json()) as ArcadeSubmitResponse;
    expect(fastBody.rank).toBe(1);
    expect(fastBody.leaderboard.map((e) => [e.playerName, e.score])).toEqual([
      ['Swift', 14320],
      ['Steady', 48200],
    ]);

    const getMine = await SELF.fetch(`${ORIGIN}/api/arcade/scores?gameId=minesweeper`);
    const mineJson = (await getMine.json()) as ArcadeLeaderboardResponse;
    expect(mineJson.sortDirection).toBe('asc');
    expect(mineJson.entries.map((e) => e.score)).toEqual([14320, 48200]);
  });

  it('rejects out-of-bounds scores, invalid gameId/playerName/meta, and missing Origin', async () => {
    // Missing Origin -> 403
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ gameId: 'dino', playerName: 'A', score: 100 }),
        })
      ).status,
    ).toBe(403);

    const invalidCases = [
      { gameId: 'invalid', playerName: 'A', score: 100 },
      { gameId: 'dino', playerName: '   <>  ', score: 100 },
      { gameId: 'dino', playerName: 'a'.repeat(17), score: 100 },
      { gameId: 'dino', playerName: 'A', score: 0 },
      { gameId: 'dino', playerName: 'A', score: 1_000_000 },
      { gameId: 'dino', playerName: 'A', score: 12.5 },
      { gameId: 'snake', playerName: 'A', score: 50_001 },
      { gameId: '2048', playerName: 'A', score: 2 },
      { gameId: 'minesweeper', playerName: 'A', score: 999 },
      { gameId: 'minesweeper', playerName: 'A', score: 3_600_001 },
      { gameId: 'breakout', playerName: 'A', score: 500_001 },
      { gameId: 'tetris', playerName: 'A', score: 100, durationMs: -1 },
      { gameId: 'tetris', playerName: 'A', score: 100, meta: { nested: { bad: true } } },
      {
        gameId: 'tetris',
        playerName: 'A',
        score: 100,
        meta: {
          k1: 'x'.repeat(120),
          k2: 'x'.repeat(120),
          k3: 'x'.repeat(120),
          k4: 'x'.repeat(120),
          k5: 'x'.repeat(120),
        },
      },
    ];

    for (const payload of invalidCases) {
      const res = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    }
  });

  it('prunes scores beyond Top 50 per game while keeping exact ranking and Top 10 intact', async () => {
    // Seed 50 snake scores: 100, 200, ..., 5000
    const stmts = Array.from({ length: 50 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO arcade_scores (id, game_id, player_name, score, duration_ms, meta_json, visitor_id, created_at)
         VALUES (?, 'snake', ?, ?, 10000, '{}', 'seedvisitor123456', ?)`,
      ).bind(
        `seed_${i}`,
        `P${i + 1}`,
        (i + 1) * 100,
        new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
      ),
    );
    await env.DB.batch(stmts);

    // Submit a new #1 score (9999) -> rank 1, madeTop10=true, total rows stays 50 (score 100 pruned)
    const topRes = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'snake', playerName: 'Champion', score: 9999, durationMs: 60000 }),
    });
    expect(topRes.status).toBe(201);
    const topBody = (await topRes.json()) as ArcadeSubmitResponse;
    expect(topBody.rank).toBe(1);
    expect(topBody.madeTop10).toBe(true);
    expect(topBody.leaderboard).toHaveLength(10);
    expect(topBody.leaderboard[0]!.score).toBe(9999);

    const count1 = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt, MIN(score) AS minScore FROM arcade_scores WHERE game_id='snake'",
    ).first<{ cnt: number; minScore: number }>();
    expect(Number(count1?.cnt)).toBe(50);
    expect(Number(count1?.minScore)).toBe(200);

    // Submit a low score (50) -> rank 51, madeTop10=false, pruned immediately so count stays 50
    const lowRes = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'snake', playerName: 'Rookie', score: 50, durationMs: 2000 }),
    });
    expect(lowRes.status).toBe(201);
    const lowBody = (await lowRes.json()) as ArcadeSubmitResponse;
    expect(lowBody.rank).toBe(51);
    expect(lowBody.madeTop10).toBe(false);

    const count2 = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM arcade_scores WHERE game_id='snake'",
    ).first<{ cnt: number }>();
    expect(Number(count2?.cnt)).toBe(50);
  });

  it('enforces per-visitor submit rate limit (20 per 15 min -> 429)', async () => {
    let visitorCookie = '';
    for (let i = 0; i < 20; i += 1) {
      const res = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          ...(visitorCookie ? { cookie: visitorCookie } : {}),
        },
        body: JSON.stringify({ gameId: 'breakout', playerName: `R${i}`, score: 100 + i }),
      });
      expect(res.status).toBe(201);
      if (!visitorCookie) {
        const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('travel_visitor='));
        if (setCookie) visitorCookie = setCookie.split(';')[0]!;
      }
    }

    const blocked = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        cookie: visitorCookie,
      },
      body: JSON.stringify({ gameId: 'breakout', playerName: 'Over', score: 500 }),
    });
    expect(blocked.status).toBe(429);
  });

  it('protects admin moderation endpoints, exposes only 8-char visitorPrefix, supports delete/reset, and backs up arcade_scores', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/admin/arcade/scores`)).status).toBe(401);

    const s1 = await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'tetris', playerName: 'TetMaster', score: 15000, durationMs: 120000 }),
    });
    const entry1 = ((await s1.json()) as ArcadeSubmitResponse).entry;

    await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: '2048', playerName: 'Supernova', score: 20480, durationMs: 180000 }),
    });
    await SELF.fetch(`${ORIGIN}/api/arcade/scores`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'dino', playerName: 'Runner', score: 888, durationMs: 45000 }),
    });

    const auth = await setupAdmin();

    // Admin list returns counts + visitorPrefix (8 chars)
    const adminListRes = await SELF.fetch(`${ORIGIN}/api/admin/arcade/scores`, {
      headers: { cookie: auth.cookies },
    });
    expect(adminListRes.status).toBe(200);
    const adminList = (await adminListRes.json()) as ArcadeAdminScoresResponse;
    expect(adminList.entries).toHaveLength(3);
    expect(adminList.counts.tetris).toBe(1);
    expect(adminList.counts['2048']).toBe(1);
    expect(adminList.counts.dino).toBe(1);
    expect(adminList.counts.snake).toBe(0);
    for (const item of adminList.entries) {
      expect(item.visitorPrefix).toMatch(/^[a-f0-9]{8}$/);
    }

    // Backup includes arcade_scores table & rows
    const backupRes = await SELF.fetch(`${ORIGIN}/api/admin/backup`, {
      headers: { cookie: auth.cookies },
    });
    expect(backupRes.status).toBe(200);
    const files = unzipSync(new Uint8Array(await backupRes.arrayBuffer()));
    const sqlText = new TextDecoder().decode(files['library.sql']);
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS arcade_scores');
    expect(sqlText).toContain('INSERT INTO arcade_scores');

    // Delete single entry
    const delRes = await SELF.fetch(`${ORIGIN}/api/admin/arcade/scores/${entry1.id}`, {
      method: 'DELETE',
      headers: adminHeaders(auth, false),
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true, id: entry1.id });

    // Deleting missing entry -> 404
    const missingDel = await SELF.fetch(`${ORIGIN}/api/admin/arcade/scores/${entry1.id}`, {
      method: 'DELETE',
      headers: adminHeaders(auth, false),
    });
    expect(missingDel.status).toBe(404);

    // Reset single game ('2048') -> leaves 'dino' intact
    const resetOne = await SELF.fetch(`${ORIGIN}/api/admin/arcade/scores/reset`, {
      method: 'POST',
      headers: adminHeaders(auth),
      body: JSON.stringify({ gameId: '2048' }),
    });
    expect(resetOne.status).toBe(200);
    expect(await resetOne.json()).toEqual({ ok: true, deleted: 1 });

    // Reset all -> removes remaining 'dino'
    const resetAll = await SELF.fetch(`${ORIGIN}/api/admin/arcade/scores/reset`, {
      method: 'POST',
      headers: adminHeaders(auth),
      body: JSON.stringify({ all: true }),
    });
    expect(resetAll.status).toBe(200);
    expect(await resetAll.json()).toEqual({ ok: true, deleted: 1 });
  });
});
