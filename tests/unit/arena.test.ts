import { env, SELF } from 'cloudflare:test';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './test-db';
import type { AppBindings } from '../../src/server/types';
import {
  ARENA_ROOM_CODE_ALPHABET,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  sanitizeArenaPlayerName,
  sanitizeRoomName,
} from '../../src/shared/arena-utils';
import type {
  ArenaAdminSnapshotResponse,
  ArenaCreateRoomResponse,
  ArenaMatchesResponse,
  ArenaRoomsListResponse,
} from '../../src/shared/types';

const ORIGIN = 'http://127.0.0.1:5173';

async function clearArenaTables() {
  await resetTestDatabase(env.DB);
  await env.DB.prepare('DELETE FROM arena_lobbies').run();
  await env.DB.prepare('DELETE FROM arena_matches').run();
}

async function setupAdmin() {
  const res = await SELF.fetch(`${ORIGIN}/api/security/auth`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-travel-setup-token': (env as unknown as AppBindings).SETUP_TOKEN!,
    },
    body: JSON.stringify({ action: 'setup', password: 'arena-admin-password-2026' }),
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

class RawWsRecorder {
  readonly ws: WebSocket;
  readonly frames: string[] = [];
  closed = false;
  private waiters: Array<(frame: string) => void> = [];
  private closeWaiters: Array<() => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.accept();
    ws.addEventListener('message', (evt) => {
      if (typeof evt.data !== 'string') return;
      this.frames.push(evt.data);
      const pending = this.waiters;
      this.waiters = [];
      for (const fn of pending) fn(evt.data);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      const pending = this.closeWaiters;
      this.closeWaiters = [];
      for (const fn of pending) fn();
    });
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  async waitForFrame(predicate: (frame: string) => boolean, timeoutMs = 5000): Promise<string> {
    const hit = this.frames.find(predicate);
    if (hit !== undefined) return hit;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for Sandstorm WS frame`));
      }, timeoutMs);
      const check = (frame: string) => {
        if (predicate(frame)) {
          clearTimeout(timer);
          resolve(frame);
        } else {
          this.waiters.push(check);
        }
      };
      this.waiters.push(check);
    });
  }

  async waitForClose(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebSocket close`));
      }, timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    try {
      this.ws.close(1000, 'sandstorm-test-done');
    } catch {
      /* Already closed */
    }
  }
}

describe('Phase 4 SANDSTORM Utilities & Hardened Helpers', () => {
  it('generates and normalizes 6-char room codes and sanitizes player/room names safely', () => {
    for (let i = 0; i < 20; i += 1) {
      const code = generateRoomCode();
      expect(code).toHaveLength(6);
      expect(isValidRoomCode(code)).toBe(true);
      for (const ch of code) {
        expect(ARENA_ROOM_CODE_ALPHABET).toContain(ch);
      }
    }

    expect(normalizeRoomCode(' ab-c 23x ')).toBe('ABC23X');
    expect(normalizeRoomCode('12345')).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();

    expect(sanitizeArenaPlayerName('  <script>特勤\u0007  ')).toBe('script特勤');
    expect(sanitizeArenaPlayerName('   ')).toBe('火星特勤');
    expect(sanitizeArenaPlayerName('0123456789ABCDEFGH')).toBe('0123456789ABCDEF');

    expect(sanitizeRoomName(undefined)).toBe('沙暴行动房间');
    expect(sanitizeRoomName('  <沙暴>对战室\u0000  ')).toBe('沙暴对战室');
  });
});

describe('Phase 4 SANDSTORM Durable Object 64Hz Relay, Anti-Spoof & Admin Control', () => {
  beforeEach(async () => {
    await clearArenaTables();
  });

  afterEach(async () => {
    await env.DB.prepare('DELETE FROM arena_lobbies').run();
    await env.DB.prepare('DELETE FROM arena_matches').run();
  });

  it('relays 64Hz M-map snapshots across 10-player DO room above 320 msg/s with zero D1 ticks, issues host-only archiveToken, and prevents spoofed online matches', async () => {
    // 1. Create a 10-player (5v5) public Sandstorm room
    const createRes = await SELF.fetch(`${ORIGIN}/api/arena/rooms`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '沙暴行动测试房',
        hostName: '沙暴房主',
        mode: 'elimination',
        isPublic: true,
        maxHumans: 10,
        botCount: 4,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as ArenaCreateRoomResponse;
    expect(created.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(created.room.maxHumans).toBe(10);

    // 2. Listed in public rooms + rejects missing upgrade (426) / foreign origin (403)
    const roomsRes = await SELF.fetch(`${ORIGIN}/api/arena/rooms`);
    expect(roomsRes.status).toBe(200);
    const roomsBody = (await roomsRes.json()) as ArenaRoomsListResponse;
    expect(roomsBody.rooms.some((r) => r.code === created.code)).toBe(true);

    const noUpgrade = await SELF.fetch(`${ORIGIN}/api/arena/ws?room=${created.code}`, {
      headers: { origin: ORIGIN },
    });
    expect(noUpgrade.status).toBe(426);

    const badOrigin = await SELF.fetch(`${ORIGIN}/api/arena/ws?room=${created.code}`, {
      headers: { upgrade: 'websocket', origin: 'https://evil.example' },
    });
    expect(badOrigin.status).toBe(403);

    // 3. Connect Host, Guest 1, Guest 2
    const wsHostRes = await SELF.fetch(
      `${ORIGIN}/api/arena/ws?room=${created.code}&proto=sandstorm`,
      { headers: { upgrade: 'websocket', origin: ORIGIN } },
    );
    expect(wsHostRes.status).toBe(101);
    const host = new RawWsRecorder(wsHostRes.webSocket!);

    const wsGuest1Res = await SELF.fetch(
      `${ORIGIN}/api/arena/ws?room=${created.code}&proto=sandstorm`,
      { headers: { upgrade: 'websocket', origin: ORIGIN } },
    );
    expect(wsGuest1Res.status).toBe(101);
    const guest1 = new RawWsRecorder(wsGuest1Res.webSocket!);

    // Also confirm /ws accepts sockets cleanly even without explicit &proto=sandstorm
    const wsGuest2Res = await SELF.fetch(
      `${ORIGIN}/api/arena/ws?room=${created.code}`,
      { headers: { upgrade: 'websocket', origin: ORIGIN } },
    );
    expect(wsGuest2Res.status).toBe(101);
    const guest2 = new RawWsRecorder(wsGuest2Res.webSocket!);

    let dupHost: RawWsRecorder | null = null;
    try {
      // Host hello -> 0|{"t":"welcome",...,archiveToken}
      host.sendRaw(JSON.stringify({ t: 'hello', role: 'host', name: '沙暴房主' }));
      const hostWelcomeRaw = await host.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"welcome"'),
      );
      const hostWelcome = JSON.parse(hostWelcomeRaw.slice(2)) as {
        t: string;
        id: number;
        role: string;
        code: string;
        archiveToken?: string;
      };
      expect(hostWelcome.t).toBe('welcome');
      expect(hostWelcome.role).toBe('host');
      expect(hostWelcome.code).toBe(created.code);
      expect(hostWelcome.id).toBeGreaterThanOrEqual(1);
      expect(typeof hostWelcome.archiveToken).toBe('string');
      expect(hostWelcome.archiveToken!.length).toBeGreaterThanOrEqual(16);

      // Duplicate host rejected
      const wsDupRes = await SELF.fetch(
        `${ORIGIN}/api/arena/ws?room=${created.code}&proto=sandstorm`,
        { headers: { upgrade: 'websocket', origin: ORIGIN } },
      );
      expect(wsDupRes.status).toBe(101);
      dupHost = new RawWsRecorder(wsDupRes.webSocket!);
      dupHost.sendRaw(JSON.stringify({ t: 'hello', role: 'host', name: '冒牌房主' }));
      const dupErr = await dupHost.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"error"'),
      );
      expect(dupErr).toContain('房间已有房主');

      // Guest 1 & Guest 2 hello -> archiveToken must NEVER be exposed to guests
      guest1.sendRaw(JSON.stringify({ t: 'hello', role: 'guest', name: '沙暴一号' }));
      const g1WelcomeRaw = await guest1.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"welcome"'),
      );
      const g1Welcome = JSON.parse(g1WelcomeRaw.slice(2)) as {
        t: string;
        id: number;
        role: string;
        host: string | null;
        code: string;
        archiveToken?: string;
      };
      expect(g1Welcome.role).toBe('guest');
      expect(g1Welcome.host).toBe('沙暴房主');
      expect(g1Welcome.archiveToken).toBeUndefined();
      await host.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"join"') && f.includes(`"id":${g1Welcome.id}`),
      );

      guest2.sendRaw(JSON.stringify({ t: 'hello', role: 'guest', name: '沙暴二号' }));
      const g2WelcomeRaw = await guest2.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"welcome"'),
      );
      const g2Welcome = JSON.parse(g2WelcomeRaw.slice(2)) as {
        id: number;
        role: string;
        archiveToken?: string;
      };
      expect(g2Welcome.role).toBe('guest');
      expect(g2Welcome.archiveToken).toBeUndefined();
      await host.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"join"') && f.includes(`"id":${g2Welcome.id}`),
      );

      // Host `*|` broadcast (`start`) -> persisted in DO SQLite & synced to D1 as `'live'`
      host.sendRaw('*|' + JSON.stringify({ t: 'start', opts: { mode: 'comp' } }));
      await guest1.waitForFrame((f) => f === `${hostWelcome.id}|{"t":"start","opts":{"mode":"comp"}}`);
      await guest2.waitForFrame((f) => f === `${hostWelcome.id}|{"t":"start","opts":{"mode":"comp"}}`);

      await new Promise((r) => setTimeout(r, 80));
      const lobbyBeforeSnapshots = await env.DB.prepare(
        'SELECT phase, human_count, updated_at FROM arena_lobbies WHERE code = ?',
      )
        .bind(created.code)
        .first<{ phase: string; human_count: number; updated_at: string }>();
      expect(lobbyBeforeSnapshots?.phase).toBe('live');
      expect(lobbyBeforeSnapshots?.human_count).toBe(3);

      // Verify DO /status reads persisted `'live'` phase from SQLite state
      const statusRes = await (env as unknown as AppBindings).ARENA_ROOM.getByName(
        `room:${created.code}`,
      ).fetch('https://arena.internal/status');
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as { room: { phase: string } };
      expect(statusBody.room.phase).toBe('live');

      // Host `<pid>|` unicast & Guest -> Host `in` relay
      host.sendRaw(`${g1Welcome.id}|` + JSON.stringify({ t: 'unicast_sync', seq: 42 }));
      const uni1 = await guest1.waitForFrame((f) => f.includes('"t":"unicast_sync"'));
      expect(uni1).toBe(`${hostWelcome.id}|{"t":"unicast_sync","seq":42}`);

      guest1.sendRaw(JSON.stringify({ t: 'in', seq: 9, fw: 1, rt: 0 }));
      const relayedIn = await host.waitForFrame(
        (f) => f.startsWith(`${g1Welcome.id}|`) && f.includes('"t":"in"'),
      );
      expect(relayedIn).toBe(`${g1Welcome.id}|{"t":"in","seq":9,"fw":1,"rt":0}`);

      // High-frequency Host burst (> 320 frames in < 1s) using single-broadcast `M` map:
      // Must NOT trigger rate limiting ("消息频率过高") and must produce ZERO D1 writes
      for (let tk = 1; tk <= 340; tk += 1) {
        host.sendRaw(
          '*|' +
            JSON.stringify({
              t: 's',
              tk,
              A: [[1, 0, 1, 0, 0, 0]],
              M: {
                [g1Welcome.id]: { rp: 0, cb: 1, bt: 15, ev: [] },
                [g2Welcome.id]: { rp: 0, cb: 1, bt: 15, ev: [] },
              },
            }),
        );
      }
      await guest1.waitForFrame((f) => f.includes('"t":"s"') && f.includes('"tk":340'));
      await guest2.waitForFrame((f) => f.includes('"t":"s"') && f.includes('"tk":340'));
      expect(host.frames.some((f) => f.includes('消息频率过高'))).toBe(false);
      expect(guest2.frames.some((f) => f.includes('"t":"unicast_sync"'))).toBe(false);

      // Verify ZERO D1 writes during high-frequency snapshot burst
      const lobbyAfterSnapshots = await env.DB.prepare(
        'SELECT updated_at FROM arena_lobbies WHERE code = ?',
      )
        .bind(created.code)
        .first<{ updated_at: string }>();
      expect(lobbyAfterSnapshots?.updated_at).toBe(lobbyBeforeSnapshots?.updated_at);

      // Online match anti-spoofing BEFORE host closes: missing -> 403, wrong -> 403, valid -> 201, replay -> 429
      const sampleMatchPayload = {
        roomCode: created.code,
        source: 'online' as const,
        mode: 'elimination' as const,
        winnerTeam: 'blue' as const,
        scoreRed: 5,
        scoreBlue: 8,
        mvpName: '沙暴房主',
        mvpKills: 18,
        mvpDeaths: 6,
        mvpHeadshots: 9,
        durationMs: 245000,
        playerCount: 10,
        botCount: 0,
        players: [
          {
            id: 'p_1',
            name: '沙暴房主',
            team: 'blue' as const,
            isBot: false,
            kills: 18,
            deaths: 6,
            assists: 3,
            headshots: 9,
            damage: 1920,
            score: 360,
          },
        ],
      };

      const missingTokenRes = await SELF.fetch(`${ORIGIN}/api/arena/matches`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(sampleMatchPayload),
      });
      expect(missingTokenRes.status).toBe(403);

      const wrongTokenRes = await SELF.fetch(`${ORIGIN}/api/arena/matches`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...sampleMatchPayload,
          archiveToken: '00000000000000000000000000000000',
        }),
      });
      expect(wrongTokenRes.status).toBe(403);

      const validArchiveRes = await SELF.fetch(`${ORIGIN}/api/arena/matches`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...sampleMatchPayload,
          archiveToken: hostWelcome.archiveToken,
        }),
      });
      expect(validArchiveRes.status).toBe(201);

      const replayArchiveRes = await SELF.fetch(`${ORIGIN}/api/arena/matches`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...sampleMatchPayload,
          archiveToken: hostWelcome.archiveToken,
        }),
      });
      expect(replayArchiveRes.status).toBe(429);

      // Host leaves mid-match (`phase === 'live'`) while Guest 1 & Guest 2 stay connected:
      // Must broadcast hostleft (to exit 3D match), promote Guest 1 with fresh archiveToken, notify Guest 2 hostup, and sync D1!
      host.close();
      await guest1.waitForFrame((f) => f === '0|{"t":"hostleft"}');
      await guest2.waitForFrame((f) => f === '0|{"t":"hostleft"}');

      const promotedG1Raw = await guest1.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"promoted"'),
      );
      const promotedG1 = JSON.parse(promotedG1Raw.slice(2)) as {
        t: string;
        id: number;
        code: string;
        archiveToken: string;
        wasLive: boolean;
        peers: Array<{ id: number; name: string }>;
      };
      expect(promotedG1.id).toBe(g1Welcome.id);
      expect(promotedG1.code).toBe(created.code);
      expect(promotedG1.wasLive).toBe(true);
      expect(typeof promotedG1.archiveToken).toBe('string');
      expect(promotedG1.archiveToken.length).toBeGreaterThanOrEqual(16);
      expect(promotedG1.archiveToken).not.toBe(hostWelcome.archiveToken);
      expect(promotedG1.peers).toEqual([{ id: g2Welcome.id, name: '沙暴二号' }]);

      const hostUpG2Raw = await guest2.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"hostup"'),
      );
      const hostUpG2 = JSON.parse(hostUpG2Raw.slice(2)) as {
        t: string;
        name: string;
        hostId: number;
      };
      expect(hostUpG2.name).toBe('沙暴一号');
      expect(hostUpG2.hostId).toBe(g1Welcome.id);

      await new Promise((r) => setTimeout(r, 80));
      const lobbyAfterMigration = await env.DB.prepare(
        'SELECT host_name, phase, human_count FROM arena_lobbies WHERE code = ?',
      )
        .bind(created.code)
        .first<{ host_name: string; phase: string; human_count: number }>();
      expect(lobbyAfterMigration?.host_name).toBe('沙暴一号');
      expect(lobbyAfterMigration?.phase).toBe('lobby');
      expect(lobbyAfterMigration?.human_count).toBe(2);

      // Departed host token MUST be invalidated after rotation
      const oldHostTokenAfterMigration = await SELF.fetch(`${ORIGIN}/api/arena/matches`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...sampleMatchPayload,
          archiveToken: hostWelcome.archiveToken,
        }),
      });
      expect(oldHostTokenAfterMigration.status).toBe(403);

      // Next, while in lobby phase (`wasLive === false`), close promoted Guest 1 -> Guest 2 promoted with fresh token (no duplicate hostleft)
      const hostLeftCountBefore = guest2.frames.filter((f) => f === '0|{"t":"hostleft"}').length;
      guest1.close();
      const promotedG2Raw = await guest2.waitForFrame(
        (f) => f.startsWith('0|') && f.includes('"t":"promoted"'),
      );
      const promotedG2 = JSON.parse(promotedG2Raw.slice(2)) as {
        id: number;
        archiveToken: string;
        wasLive: boolean;
        peers: Array<{ id: number; name: string }>;
      };
      expect(promotedG2.id).toBe(g2Welcome.id);
      expect(promotedG2.wasLive).toBe(false);
      expect(promotedG2.peers).toEqual([]);
      expect(promotedG2.archiveToken).not.toBe(promotedG1.archiveToken);
      expect(guest2.frames.filter((f) => f === '0|{"t":"hostleft"}').length).toBe(
        hostLeftCountBefore,
      );

      // Promoted Guest 2's fresh archiveToken works cleanly (lastArchiveAt reset on migration)
      const g2ArchiveRes = await SELF.fetch(`${ORIGIN}/api/arena/matches`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...sampleMatchPayload,
          archiveToken: promotedG2.archiveToken,
        }),
      });
      expect(g2ArchiveRes.status).toBe(201);
    } finally {
      dupHost?.close();
      host.close();
      guest1.close();
      guest2.close();
      await new Promise((r) => setTimeout(r, 80));
    }
  });

  it('archives solo matches, supports admin force-close room (DELETE /api/admin/arena/rooms/:code), includes arena_matches in SQL backup, and protects admin routes', async () => {
    // 1. Submit solo match without archiveToken -> 201
    const postMatch = await SELF.fetch(`${ORIGIN}/api/arena/matches`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        roomCode: 'SOLO99',
        source: 'solo',
        mode: 'elimination',
        winnerTeam: 'red',
        scoreRed: 5,
        scoreBlue: 2,
        mvpName: '沙暴神射',
        mvpKills: 9,
        mvpDeaths: 2,
        mvpHeadshots: 5,
        durationMs: 142000,
        playerCount: 1,
        botCount: 4,
        players: [
          {
            id: 'h1',
            name: '沙暴神射',
            team: 'red',
            isBot: false,
            kills: 9,
            deaths: 2,
            assists: 1,
            headshots: 5,
            damage: 980,
            score: 185,
          },
          {
            id: 'b1',
            name: '沙暴-AI',
            team: 'blue',
            isBot: true,
            kills: 2,
            deaths: 5,
            assists: 0,
            headshots: 1,
            damage: 240,
            score: 40,
          },
        ],
      }),
    });
    expect(postMatch.status).toBe(201);
    const saved = (await postMatch.json()) as { match: { id: string; mvpName: string } };
    expect(saved.match.mvpName).toBe('沙暴神射');

    // 2. Public matches list never leaks visitor_id / visitorPrefix
    const publicMatchesRes = await SELF.fetch(`${ORIGIN}/api/arena/matches`);
    expect(publicMatchesRes.status).toBe(200);
    const rawPublic = await publicMatchesRes.text();
    expect(rawPublic).not.toContain('visitor_id');
    expect(rawPublic).not.toContain('visitorPrefix');
    const publicMatches = JSON.parse(rawPublic) as ArenaMatchesResponse;
    expect(publicMatches.matches).toHaveLength(1);
    expect(publicMatches.matches[0]?.id).toBe(saved.match.id);

    // 3. Unauthenticated admin endpoints return 401
    expect((await SELF.fetch(`${ORIGIN}/api/admin/arena/snapshot`)).status).toBe(401);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/admin/arena/rooms/ABC234`, {
          method: 'DELETE',
          headers: { origin: ORIGIN },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/admin/arena/matches/${saved.match.id}`, {
          method: 'DELETE',
          headers: { origin: ORIGIN },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/admin/arena/matches/reset`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ all: true }),
        })
      ).status,
    ).toBe(401);

    // 4. Create active lobby & connect host WS so we can test admin force-close
    const auth = await setupAdmin();
    const createRes = await SELF.fetch(`${ORIGIN}/api/arena/rooms`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '待查封房间',
        hostName: '测试房主',
        mode: 'deathmatch',
        isPublic: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const roomCreated = (await createRes.json()) as ArenaCreateRoomResponse;

    const wsRes = await SELF.fetch(
      `${ORIGIN}/api/arena/ws?room=${roomCreated.code}&proto=sandstorm`,
      { headers: { upgrade: 'websocket', origin: ORIGIN } },
    );
    expect(wsRes.status).toBe(101);
    const hostWs = new RawWsRecorder(wsRes.webSocket!);

    try {
      hostWs.sendRaw(JSON.stringify({ t: 'hello', role: 'host', name: '测试房主' }));
      await hostWs.waitForFrame((f) => f.startsWith('0|') && f.includes('"t":"welcome"'));

      const snapBeforeClose = (await (
        await SELF.fetch(`${ORIGIN}/api/admin/arena/snapshot`, {
          headers: adminHeaders(auth, false),
        })
      ).json()) as ArenaAdminSnapshotResponse;
      expect(snapBeforeClose.lobbies.some((l) => l.code === roomCreated.code)).toBe(true);

      const closeRoomRes = await SELF.fetch(
        `${ORIGIN}/api/admin/arena/rooms/${roomCreated.code}`,
        {
          method: 'DELETE',
          headers: adminHeaders(auth, false),
        },
      );
      expect(closeRoomRes.status).toBe(200);
      await hostWs.waitForFrame((f) => f.includes('管理员已关闭房间'));
      await hostWs.waitForClose();

      const snapAfterClose = (await (
        await SELF.fetch(`${ORIGIN}/api/admin/arena/snapshot`, {
          headers: adminHeaders(auth, false),
        })
      ).json()) as ArenaAdminSnapshotResponse;
      expect(snapAfterClose.lobbies.some((l) => l.code === roomCreated.code)).toBe(false);

      // 5. Authenticated admin backup includes arena_matches and excludes arena_lobbies
      const backupRes = await SELF.fetch(`${ORIGIN}/api/admin/backup`, {
        headers: adminHeaders(auth, false),
      });
      expect(backupRes.status).toBe(200);
      const zipBytes = new Uint8Array(await backupRes.arrayBuffer());
      const files = unzipSync(zipBytes);
      const sqlText = new TextDecoder().decode(files['library.sql']);
      expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS arena_matches');
      expect(sqlText).toContain('INSERT INTO arena_matches');
      expect(sqlText).toContain('e6b299e69ab4e7a59ee5b084'); // UTF-8 hex for '沙暴神射'
      expect(sqlText).not.toContain('CREATE TABLE IF NOT EXISTS arena_lobbies');

      // 6. Single delete & bulk reset
      const delRes = await SELF.fetch(`${ORIGIN}/api/admin/arena/matches/${saved.match.id}`, {
        method: 'DELETE',
        headers: adminHeaders(auth, false),
      });
      expect(delRes.status).toBe(200);

      const afterDel = (await (
        await SELF.fetch(`${ORIGIN}/api/admin/arena/snapshot`, {
          headers: adminHeaders(auth, false),
        })
      ).json()) as ArenaAdminSnapshotResponse;
      expect(afterDel.matches).toHaveLength(0);

      const resetRes = await SELF.fetch(`${ORIGIN}/api/admin/arena/matches/reset`, {
        method: 'POST',
        headers: adminHeaders(auth),
        body: JSON.stringify({ all: true }),
      });
      expect(resetRes.status).toBe(200);
    } finally {
      hostWs.close();
      await new Promise((r) => setTimeout(r, 80));
    }
  });
});
