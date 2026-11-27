import { DurableObject } from 'cloudflare:workers';
import { sanitizeArenaPlayerName, sanitizeRoomName } from '../../shared/arena-utils';
import type {
  ArenaBotDifficulty,
  ArenaGameMode,
  ArenaLobbySummary,
  ArenaMatchRecord,
  ArenaPhase,
} from '../../shared/types';
import { ensureSchema } from '../db/schema';
import type { AppBindings } from '../types';

const ROOM_MAX_TTL_MS = 30 * 60 * 1000; // 30-minute hard lifetime ceiling
const EMPTY_ROOM_IDLE_MS = 90 * 1000; // 90s idle reclaim after last human leaves
const MAX_ROOM_HUMANS = 10; // Supports 5v5 Sandstorm
const MAX_SANDSTORM_HOST_MESSAGES_PER_SEC = 800;
const MAX_SANDSTORM_GUEST_MESSAGES_PER_SEC = 220;
const MAX_SANDSTORM_PENDING_MESSAGES_PER_SEC = 20;
const MAX_SANDSTORM_TEXT_BYTES = 65_536;
const ARCHIVE_COOLDOWN_MS = 5_000;
const MAX_ARCHIVED_MATCHES = 100;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type RoomMeta = {
  code: string;
  name: string;
  hostName: string;
  mode: ArenaGameMode;
  isPublic: boolean;
  maxHumans: number;
  botCount: number;
  botDifficulty: ArenaBotDifficulty;
  roundsToWin: number;
  targetKills: number;
  createdAt: string;
  expiresAt: number;
};

type SandstormSocketAttachment = {
  kind: 'sandstorm';
  pid: number;
  role: 'pending' | 'host' | 'guest';
  name: string;
  visitorId: string;
  connectedAt: number;
};

type InitRoomPayload = {
  code: string;
  name: string;
  hostName: string;
  mode: ArenaGameMode;
  isPublic: boolean;
  maxHumans: number;
  botCount: number;
  botDifficulty: ArenaBotDifficulty;
  roundsToWin: number;
  targetKills: number;
};

type RateBucket = {
  windowStart: number;
  count: number;
  warned: boolean;
};

function isSandstormAttachment(att: unknown): att is SandstormSocketAttachment {
  return Boolean(
    att &&
      typeof att === 'object' &&
      (att as SandstormSocketAttachment).kind === 'sandstorm' &&
      typeof (att as SandstormSocketAttachment).pid === 'number',
  );
}

function normalizeSandstormPhase(raw: unknown): ArenaPhase {
  return raw === 'freeze' ||
    raw === 'live' ||
    raw === 'round_over' ||
    raw === 'match_over'
    ? raw
    : 'lobby';
}

function timingSafeEqualText(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function syncArenaLobbyRow(
  db: D1Database,
  summary: ArenaLobbySummary,
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO arena_lobbies (
         code, name, host_name, mode, is_public, phase, human_count, max_humans,
         bot_count, bot_difficulty, rounds_to_win, target_kills, score_red, score_blue,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name,
         host_name = excluded.host_name,
         mode = excluded.mode,
         is_public = excluded.is_public,
         phase = excluded.phase,
         human_count = excluded.human_count,
         max_humans = excluded.max_humans,
         bot_count = excluded.bot_count,
         bot_difficulty = excluded.bot_difficulty,
         rounds_to_win = excluded.rounds_to_win,
         target_kills = excluded.target_kills,
         score_red = excluded.score_red,
         score_blue = excluded.score_blue,
         updated_at = excluded.updated_at`,
    )
    .bind(
      summary.code,
      summary.name,
      summary.hostName,
      summary.mode,
      summary.isPublic ? 1 : 0,
      summary.phase,
      summary.humanCount,
      summary.maxHumans,
      summary.botCount,
      summary.botDifficulty,
      summary.roundsToWin,
      summary.targetKills,
      summary.scoreRed,
      summary.scoreBlue,
      summary.createdAt,
      summary.updatedAt,
    )
    .run();
}

export async function deleteArenaLobbyRow(db: D1Database, code: string): Promise<void> {
  await ensureSchema(db);
  await db.prepare('DELETE FROM arena_lobbies WHERE code = ?').bind(code).run();
}

export async function insertArenaMatchAndPrune(
  db: D1Database,
  record: ArenaMatchRecord,
  visitorId: string,
): Promise<void> {
  await ensureSchema(db);
  await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO arena_matches (
           id, room_code, source, mode, winner_team, score_red, score_blue,
           mvp_name, mvp_kills, mvp_deaths, mvp_headshots, duration_ms,
           player_count, bot_count, players_json, visitor_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.roomCode,
        record.source,
        record.mode,
        record.winnerTeam,
        record.scoreRed,
        record.scoreBlue,
        record.mvpName,
        record.mvpKills,
        record.mvpDeaths,
        record.mvpHeadshots,
        record.durationMs,
        record.playerCount,
        record.botCount,
        JSON.stringify(record.players),
        visitorId,
        record.createdAt,
      ),
    db
      .prepare(
        `DELETE FROM arena_matches
         WHERE id NOT IN (
           SELECT id FROM arena_matches
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         )`,
      )
      .bind(MAX_ARCHIVED_MATCHES),
  ]);
}

function isOpenSocket(ws: WebSocket): boolean {
  return ws.readyState === 1;
}

export class ArenaRoomDO extends DurableObject<AppBindings> {
  private meta: RoomMeta | null = null;
  private rateLimits = new Map<string, RateBucket>();
  private sandstormPhase: ArenaPhase = 'lobby';
  private archiveToken = '';
  private lastArchiveAt = 0;

  constructor(ctx: DurableObjectState, env: AppBindings) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_meta (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          code TEXT NOT NULL,
          name TEXT NOT NULL,
          host_name TEXT NOT NULL,
          mode TEXT NOT NULL,
          is_public INTEGER NOT NULL,
          max_humans INTEGER NOT NULL,
          bot_count INTEGER NOT NULL,
          bot_difficulty TEXT NOT NULL,
          rounds_to_win INTEGER NOT NULL,
          target_kills INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sandstorm_state (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          next_pid INTEGER NOT NULL DEFAULT 1,
          phase TEXT NOT NULL DEFAULT 'lobby',
          archive_token TEXT NOT NULL DEFAULT '',
          last_archive_at INTEGER NOT NULL DEFAULT 0
        )
      `);

      const cols = new Set(
        this.ctx.storage.sql
          .exec<{ name: string }>('PRAGMA table_info(sandstorm_state)')
          .toArray()
          .map((col) => col.name),
      );
      if (!cols.has('phase')) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE sandstorm_state ADD COLUMN phase TEXT NOT NULL DEFAULT 'lobby'",
        );
      }
      if (!cols.has('archive_token')) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE sandstorm_state ADD COLUMN archive_token TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!cols.has('last_archive_at')) {
        this.ctx.storage.sql.exec(
          'ALTER TABLE sandstorm_state ADD COLUMN last_archive_at INTEGER NOT NULL DEFAULT 0',
        );
      }

      this.loadStateFromSqlite();
    });
  }

  private allocateSandstormPid(): number {
    const rows = this.ctx.storage.sql
      .exec<{ next_pid: number }>('SELECT next_pid FROM sandstorm_state WHERE id = 1')
      .toArray();
    const current = rows[0] ? Math.max(1, Number(rows[0].next_pid)) : 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO sandstorm_state (id, next_pid, phase, archive_token, last_archive_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET next_pid = excluded.next_pid`,
      current + 1,
      this.sandstormPhase,
      this.archiveToken,
      this.lastArchiveAt,
    );
    return current;
  }

  private loadStateFromSqlite(): void {
    const rows = this.ctx.storage.sql
      .exec<{
        code: string;
        name: string;
        host_name: string;
        mode: string;
        is_public: number;
        max_humans: number;
        bot_count: number;
        bot_difficulty: string;
        rounds_to_win: number;
        target_kills: number;
        created_at: string;
        expires_at: number;
      }>('SELECT * FROM room_meta WHERE id = 1')
      .toArray();

    const row = rows[0];
    if (!row) {
      this.meta = null;
      this.sandstormPhase = 'lobby';
      this.archiveToken = '';
      this.lastArchiveAt = 0;
      return;
    }

    this.meta = {
      code: row.code,
      name: row.name,
      hostName: row.host_name,
      mode: row.mode === 'deathmatch' ? 'deathmatch' : 'elimination',
      isPublic: Number(row.is_public) === 1,
      maxHumans: Math.max(2, Math.min(MAX_ROOM_HUMANS, Number(row.max_humans) || MAX_ROOM_HUMANS)),
      botCount: Math.max(0, Math.min(10, Number(row.bot_count) || 0)),
      botDifficulty:
        row.bot_difficulty === 'rookie' || row.bot_difficulty === 'commander'
          ? row.bot_difficulty
          : 'veteran',
      roundsToWin: Math.max(1, Math.min(9, Number(row.rounds_to_win) || 5)),
      targetKills: Math.max(1, Math.min(50, Number(row.target_kills) || 25)),
      createdAt: row.created_at,
      expiresAt: Number(row.expires_at),
    };

    const stateRows = this.ctx.storage.sql
      .exec<{
        phase: string;
        archive_token: string;
        last_archive_at: number;
      }>('SELECT phase, archive_token, last_archive_at FROM sandstorm_state WHERE id = 1')
      .toArray();
    const state = stateRows[0];
    if (state) {
      this.sandstormPhase = normalizeSandstormPhase(state.phase);
      this.archiveToken = typeof state.archive_token === 'string' ? state.archive_token : '';
      this.lastArchiveAt = Math.max(0, Number(state.last_archive_at) || 0);
    } else {
      this.sandstormPhase = 'lobby';
      this.archiveToken = '';
      this.lastArchiveAt = 0;
    }
  }

  private saveMetaToSqlite(): void {
    if (!this.meta) return;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO room_meta (
         id, code, name, host_name, mode, is_public, max_humans, bot_count,
         bot_difficulty, rounds_to_win, target_kills, created_at, expires_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.meta.code,
      this.meta.name,
      this.meta.hostName,
      this.meta.mode,
      this.meta.isPublic ? 1 : 0,
      this.meta.maxHumans,
      this.meta.botCount,
      this.meta.botDifficulty,
      this.meta.roundsToWin,
      this.meta.targetKills,
      this.meta.createdAt,
      this.meta.expiresAt,
    );
  }

  private saveSandstormStateToSqlite(): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO sandstorm_state (id, next_pid, phase, archive_token, last_archive_at)
       VALUES (1, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         phase = excluded.phase,
         archive_token = excluded.archive_token,
         last_archive_at = excluded.last_archive_at`,
      this.sandstormPhase,
      this.archiveToken,
      this.lastArchiveAt,
    );
  }

  private readAttachment(ws: WebSocket): SandstormSocketAttachment | null {
    try {
      const att = ws.deserializeAttachment();
      return isSandstormAttachment(att) ? att : null;
    } catch {
      return null;
    }
  }

  private getOpenSandstormSockets(): WebSocket[] {
    const tagged = this.ctx.getWebSockets('sandstorm').filter(isOpenSocket);
    if (tagged.length > 0) return tagged;
    return this.ctx.getWebSockets().filter((ws) => isOpenSocket(ws) && this.readAttachment(ws) !== null);
  }

  private buildSandstormLobbySummary(excludeWs?: WebSocket): ArenaLobbySummary | null {
    if (!this.meta) return null;
    let humanCount = 0;
    let hostName = this.meta.hostName;
    for (const ws of this.getOpenSandstormSockets()) {
      if (excludeWs && ws === excludeWs) continue;
      const att = this.readAttachment(ws);
      if (!att) continue;
      if (att.role === 'host' || att.role === 'guest') {
        humanCount += 1;
        if (att.role === 'host') hostName = att.name;
      }
    }

    return {
      code: this.meta.code,
      name: this.meta.name,
      hostName,
      mode: this.meta.mode,
      isPublic: this.meta.isPublic,
      phase: humanCount === 0 ? 'lobby' : this.sandstormPhase,
      humanCount,
      maxHumans: this.meta.maxHumans,
      botCount: this.meta.botCount,
      botDifficulty: this.meta.botDifficulty,
      roundsToWin: this.meta.roundsToWin,
      targetKills: this.meta.targetKills,
      scoreRed: 0,
      scoreBlue: 0,
      createdAt: this.meta.createdAt,
      updatedAt: new Date().toISOString(),
    };
  }

  private async syncSandstormLobbyToD1(excludeWs?: WebSocket): Promise<void> {
    const summary = this.buildSandstormLobbySummary(excludeWs);
    if (!summary) return;
    try {
      await syncArenaLobbyRow(this.env.DB, summary);
    } catch {
      /* Avoid interrupting live relay on transient D1 error */
    }
  }

  private sendRawText(ws: WebSocket, payload: string): void {
    if (!isOpenSocket(ws)) return;
    try {
      ws.send(payload);
    } catch {
      /* Socket closed mid-send */
    }
  }

  private sendSandstormSys(ws: WebSocket, obj: Record<string, unknown>): void {
    this.sendRawText(ws, '0|' + JSON.stringify(obj));
  }

  private async destroyRoom(reason = '房间已关闭'): Promise<void> {
    const code = this.meta?.code ?? null;
    for (const ws of this.ctx.getWebSockets()) {
      if (isOpenSocket(ws)) {
        this.sendSandstormSys(ws, { t: 'error', msg: reason });
      }
      try {
        ws.close(1000, reason);
      } catch {
        /* Already closed */
      }
    }
    this.rateLimits.clear();
    this.meta = null;
    this.sandstormPhase = 'lobby';
    this.archiveToken = '';
    this.lastArchiveAt = 0;
    try {
      this.ctx.storage.sql.exec('DELETE FROM room_meta');
      this.ctx.storage.sql.exec('DELETE FROM sandstorm_state');
      await this.ctx.storage.deleteAlarm();
    } catch {
      /* Ignore cleanup error */
    }
    if (code) {
      try {
        await deleteArenaLobbyRow(this.env.DB, code);
      } catch {
        /* Ignore D1 cleanup error */
      }
    }
  }

  private checkRateLimit(
    key: string,
    maxPerSec: number,
  ): { allowed: boolean; shouldWarn: boolean } {
    const now = Date.now();
    const bucket = this.rateLimits.get(key);
    if (!bucket || now - bucket.windowStart >= 1000) {
      this.rateLimits.set(key, { windowStart: now, count: 1, warned: false });
      return { allowed: true, shouldWarn: false };
    }
    bucket.count += 1;
    if (bucket.count > maxPerSec) {
      const shouldWarn = !bucket.warned;
      bucket.warned = true;
      return { allowed: false, shouldWarn };
    }
    return { allowed: true, shouldWarn: false };
  }

  async alarm(): Promise<void> {
    if (!this.meta) {
      this.loadStateFromSqlite();
    }
    const sockets = this.getOpenSandstormSockets();
    if (!this.meta || Date.now() >= this.meta.expiresAt || sockets.length === 0) {
      await this.destroyRoom('房间超时自动回收');
      return;
    }
    // Still active and within 30-min lifetime: schedule hard expiration alarm
    await this.ctx.storage.setAlarm(this.meta.expiresAt);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/init') {
      const now = Date.now();
      if (!this.meta) {
        this.loadStateFromSqlite();
      }
      if (this.meta && now < this.meta.expiresAt) {
        return Response.json({ error: '房间码已存在' }, { status: 409 });
      }

      const payload = (await request.json().catch(() => null)) as InitRoomPayload | null;
      if (!payload || typeof payload.code !== 'string') {
        return Response.json({ error: '无效的房间初始化参数' }, { status: 400 });
      }

      const createdAt = new Date(now).toISOString();
      const expiresAt = now + ROOM_MAX_TTL_MS;

      this.meta = {
        code: payload.code.toUpperCase(),
        name: sanitizeRoomName(payload.name),
        hostName: sanitizeArenaPlayerName(payload.hostName),
        mode: payload.mode === 'deathmatch' ? 'deathmatch' : 'elimination',
        isPublic: Boolean(payload.isPublic),
        maxHumans: Math.max(
          2,
          Math.min(MAX_ROOM_HUMANS, Math.round(payload.maxHumans || MAX_ROOM_HUMANS)),
        ),
        botCount: Math.max(0, Math.min(10, Math.round(payload.botCount ?? 4))),
        botDifficulty:
          payload.botDifficulty === 'rookie' || payload.botDifficulty === 'commander'
            ? payload.botDifficulty
            : 'veteran',
        roundsToWin: Math.max(1, Math.min(9, Math.round(payload.roundsToWin ?? 5))),
        targetKills: Math.max(1, Math.min(50, Math.round(payload.targetKills ?? 25))),
        createdAt,
        expiresAt,
      };
      this.sandstormPhase = 'lobby';
      this.archiveToken = '';
      this.lastArchiveAt = 0;

      this.saveMetaToSqlite();
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO sandstorm_state (id, next_pid, phase, archive_token, last_archive_at) VALUES (1, 1, 'lobby', '', 0)",
      );
      // Idle reclaim if creator never joins within 90s; refreshed on WS connect
      await this.ctx.storage.setAlarm(Math.min(expiresAt, now + EMPTY_ROOM_IDLE_MS));
      await this.syncSandstormLobbyToD1();

      const summary = this.buildSandstormLobbySummary()!;
      return Response.json({ room: summary }, { status: 201 });
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      if (!this.meta) {
        this.loadStateFromSqlite();
      }
      if (!this.meta || Date.now() >= this.meta.expiresAt) {
        return Response.json({ error: '房间不存在或已过期' }, { status: 404 });
      }
      return Response.json({ room: this.buildSandstormLobbySummary() });
    }

    if (request.method === 'POST' && url.pathname === '/verify-archive') {
      if (!this.meta || !this.archiveToken) {
        this.loadStateFromSqlite();
      }
      if (!this.meta || Date.now() >= this.meta.expiresAt || !this.archiveToken) {
        return Response.json({ error: '线上战报校验失败，房间不存在或已过期' }, { status: 403 });
      }

      const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
      const providedToken = typeof body?.token === 'string' ? body.token : '';
      if (!providedToken || !timingSafeEqualText(providedToken, this.archiveToken)) {
        return Response.json(
          { error: '线上战报校验失败，仅联机房主可提交线上战报' },
          { status: 403 },
        );
      }

      const now = Date.now();
      if (this.lastArchiveAt > 0 && now - this.lastArchiveAt < ARCHIVE_COOLDOWN_MS) {
        return Response.json(
          { error: '同一房间战报提交过于频繁，请稍后再试' },
          { status: 429 },
        );
      }

      this.lastArchiveAt = now;
      this.saveSandstormStateToSqlite();
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/destroy') {
      await this.destroyRoom('管理员已关闭房间');
      return Response.json({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/ws') {
      if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
        return Response.json({ error: '需要 WebSocket 升级连接' }, { status: 426 });
      }

      if (!this.meta) {
        this.loadStateFromSqlite();
      }
      if (!this.meta || Date.now() >= this.meta.expiresAt) {
        return Response.json({ error: '房间不存在或已过期' }, { status: 404 });
      }

      if (this.getOpenSandstormSockets().length >= this.meta.maxHumans) {
        return Response.json({ error: '房间人数已满' }, { status: 409 });
      }

      const pid = this.allocateSandstormPid();
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ['sandstorm']);

      const attachment: SandstormSocketAttachment = {
        kind: 'sandstorm',
        pid,
        role: 'pending',
        name: sanitizeArenaPlayerName(url.searchParams.get('name'), '玩家'),
        visitorId: request.headers.get('x-arena-visitor-id') || '',
        connectedAt: Date.now(),
      };
      server.serializeAttachment(attachment);
      await this.ctx.storage.setAlarm(this.meta.expiresAt);

      return new Response(null, { status: 101, webSocket: client });
    }

    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  private async handleSandstormMessage(
    ws: WebSocket,
    att: SandstormSocketAttachment,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!this.meta) {
      this.loadStateFromSqlite();
    }
    if (!this.meta || Date.now() >= this.meta.expiresAt) {
      this.sendSandstormSys(ws, { t: 'error', msg: '房间已关闭或过期' });
      try {
        ws.close(1000, 'room_closed');
      } catch {
        /* ignore */
      }
      return;
    }

    const limit =
      att.role === 'host'
        ? MAX_SANDSTORM_HOST_MESSAGES_PER_SEC
        : att.role === 'guest'
          ? MAX_SANDSTORM_GUEST_MESSAGES_PER_SEC
          : MAX_SANDSTORM_PENDING_MESSAGES_PER_SEC;
    const rate = this.checkRateLimit(`ss:${att.pid}`, limit);
    if (!rate.allowed) {
      if (rate.shouldWarn) {
        this.sendSandstormSys(ws, { t: 'error', msg: '消息频率过高' });
      }
      return;
    }

    const textPayload =
      typeof message === 'string' ? message : textDecoder.decode(message);
    if (textPayload.length > MAX_SANDSTORM_TEXT_BYTES) return;
    if (
      textPayload.length > 21_845 &&
      textEncoder.encode(textPayload).byteLength > MAX_SANDSTORM_TEXT_BYTES
    ) {
      return;
    }

    // 1. Handshake phase (pending -> host | guest)
    if (att.role === 'pending') {
      let parsed: Record<string, unknown> | null = null;
      try {
        const raw = JSON.parse(textPayload) as unknown;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          parsed = raw as Record<string, unknown>;
        }
      } catch {
        parsed = null;
      }

      if (!parsed || parsed.t !== 'hello' || (parsed.role !== 'host' && parsed.role !== 'guest')) {
        this.sendSandstormSys(ws, { t: 'error', msg: '握手消息无效' });
        try {
          ws.close(1008, 'invalid_hello');
        } catch {
          /* ignore */
        }
        return;
      }

      const name = sanitizeArenaPlayerName(parsed.name, '玩家');
      const peers = this.getOpenSandstormSockets();

      if (parsed.role === 'host') {
        let existingHost = false;
        const guests: Array<{ ws: WebSocket; att: SandstormSocketAttachment }> = [];
        for (const peerWs of peers) {
          if (peerWs === ws) continue;
          const peerAtt = this.readAttachment(peerWs);
          if (!peerAtt) continue;
          if (peerAtt.role === 'host') {
            existingHost = true;
            break;
          }
          if (peerAtt.role === 'guest') {
            guests.push({ ws: peerWs, att: peerAtt });
          }
        }

        if (existingHost) {
          this.sendSandstormSys(ws, { t: 'error', msg: '房间已有房主，请选择加入房间' });
          try {
            ws.close(1008, 'host_exists');
          } catch {
            /* ignore */
          }
          return;
        }

        const nextAtt: SandstormSocketAttachment = { ...att, role: 'host', name };
        ws.serializeAttachment(nextAtt);
        this.meta.hostName = name;
        this.saveMetaToSqlite();
        if (!this.archiveToken) {
          this.archiveToken = crypto.randomUUID().replace(/-/g, '');
          this.saveSandstormStateToSqlite();
        }

        this.sendSandstormSys(ws, {
          t: 'welcome',
          id: att.pid,
          role: 'host',
          code: this.meta.code,
          archiveToken: this.archiveToken,
        });
        for (const g of guests) {
          this.sendSandstormSys(ws, { t: 'join', id: g.att.pid, name: g.att.name });
          this.sendSandstormSys(g.ws, { t: 'hostup', name });
        }
        await this.syncSandstormLobbyToD1();
        return;
      }

      // Guest handshake (archiveToken is NEVER exposed to guests)
      const nextAtt: SandstormSocketAttachment = { ...att, role: 'guest', name };
      ws.serializeAttachment(nextAtt);

      let hostWs: WebSocket | null = null;
      let hostAtt: SandstormSocketAttachment | null = null;
      for (const peerWs of peers) {
        if (peerWs === ws) continue;
        const peerAtt = this.readAttachment(peerWs);
        if (peerAtt && peerAtt.role === 'host') {
          hostWs = peerWs;
          hostAtt = peerAtt;
          break;
        }
      }

      this.sendSandstormSys(ws, {
        t: 'welcome',
        id: att.pid,
        role: 'guest',
        host: hostAtt ? hostAtt.name : null,
        code: this.meta.code,
      });
      if (hostWs) {
        this.sendSandstormSys(hostWs, { t: 'join', id: att.pid, name });
      }
      await this.syncSandstormLobbyToD1();
      return;
    }

    // 2. Host -> guest(s) relay (64Hz zero-D1-tick fast path!)
    if (att.role === 'host') {
      const sep = textPayload.indexOf('|');
      if (sep < 1) return;
      const to = textPayload.slice(0, sep);
      const bodyJson = textPayload.slice(sep + 1);
      const framed = `${att.pid}|${bodyJson}`;

      // Zero-parse fast path for 64Hz `"t":"s"` snapshots & rosters; only inspect rare lobby/start/end control broadcasts
      if (
        to === '*' &&
        (bodyJson.includes('"t":"lobby"') ||
          bodyJson.includes('"t":"start"') ||
          bodyJson.includes('"t":"end"'))
      ) {
        try {
          const ctrl = JSON.parse(bodyJson) as {
            t?: string;
            ing?: boolean;
            opts?: { mode?: string };
          };
          let nextPhase: ArenaPhase | null = null;
          if (ctrl.t === 'start') nextPhase = 'live';
          else if (ctrl.t === 'end') nextPhase = 'lobby';
          else if (ctrl.t === 'lobby') nextPhase = ctrl.ing ? 'live' : 'lobby';

          let nextMode: ArenaGameMode | null = null;
          if (ctrl.opts?.mode === 'comp') nextMode = 'elimination';
          else if (ctrl.opts?.mode === 'tdm') nextMode = 'deathmatch';

          let dirty = false;
          let stateDirty = false;
          if (nextPhase && nextPhase !== this.sandstormPhase) {
            this.sandstormPhase = nextPhase;
            stateDirty = true;
            dirty = true;
          }
          if (stateDirty) {
            this.saveSandstormStateToSqlite();
          }
          if (nextMode && nextMode !== this.meta.mode) {
            this.meta.mode = nextMode;
            this.saveMetaToSqlite();
            dirty = true;
          }
          if (dirty) {
            this.ctx.waitUntil(this.syncSandstormLobbyToD1());
          }
        } catch {
          /* Non-JSON body; relay untouched */
        }
      }

      if (to === '*') {
        for (const peerWs of this.getOpenSandstormSockets()) {
          if (peerWs === ws) continue;
          const peerAtt = this.readAttachment(peerWs);
          if (peerAtt && peerAtt.role === 'guest') {
            this.sendRawText(peerWs, framed);
          }
        }
      } else {
        const targetPid = Number(to);
        if (!Number.isInteger(targetPid) || targetPid <= 0) return;
        for (const peerWs of this.getOpenSandstormSockets()) {
          if (peerWs === ws) continue;
          const peerAtt = this.readAttachment(peerWs);
          if (peerAtt && peerAtt.role === 'guest' && peerAtt.pid === targetPid) {
            this.sendRawText(peerWs, framed);
            break;
          }
        }
      }
      return;
    }

    // 3. Guest -> host relay (128-tick zero-D1-tick fast path!)
    const framed = `${att.pid}|${textPayload}`;
    for (const peerWs of this.getOpenSandstormSockets()) {
      if (peerWs === ws) continue;
      const peerAtt = this.readAttachment(peerWs);
      if (peerAtt && peerAtt.role === 'host') {
        this.sendRawText(peerWs, framed);
        break;
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = this.readAttachment(ws);
    if (!att) {
      this.sendSandstormSys(ws, { t: 'error', msg: '连接上下文无效' });
      try {
        ws.close(1008, 'invalid_attachment');
      } catch {
        /* ignore */
      }
      return;
    }
    await this.handleSandstormMessage(ws, att, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleSocketDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleSocketDisconnect(ws);
  }

  private async handleSocketDisconnect(ws: WebSocket): Promise<void> {
    const att = this.readAttachment(ws);
    if (att) {
      this.rateLimits.delete(`ss:${att.pid}`);
    }
    try {
      if (ws.readyState !== 3) {
        ws.close(1000, '连接已关闭');
      }
    } catch {
      /* ignore */
    }

    const remaining = this.getOpenSandstormSockets().filter((s) => s !== ws);
    let stateDirty = false;

    if (att?.role === 'host') {
      const wasLive = this.sandstormPhase !== 'lobby';
      if (wasLive) {
        this.sandstormPhase = 'lobby';
        stateDirty = true;
      }

      const remainingGuests: Array<{ ws: WebSocket; att: SandstormSocketAttachment }> = [];
      for (const peerWs of remaining) {
        const peerAtt = this.readAttachment(peerWs);
        if (peerAtt && peerAtt.role === 'guest') {
          remainingGuests.push({ ws: peerWs, att: peerAtt });
        }
      }
      remainingGuests.sort(
        (a, b) => a.att.connectedAt - b.att.connectedAt || a.att.pid - b.att.pid,
      );

      if (wasLive) {
        for (const g of remainingGuests) {
          this.sendSandstormSys(g.ws, { t: 'hostleft' });
        }
      }

      if (remainingGuests.length > 0 && this.meta) {
        const nextHost = remainingGuests[0]!;
        const otherGuests = remainingGuests.slice(1);

        nextHost.ws.serializeAttachment({ ...nextHost.att, role: 'host' });
        this.meta.hostName = nextHost.att.name;
        this.saveMetaToSqlite();

        this.archiveToken = crypto.randomUUID().replace(/-/g, '');
        this.lastArchiveAt = 0;
        stateDirty = true;

        this.sendSandstormSys(nextHost.ws, {
          t: 'promoted',
          id: nextHost.att.pid,
          code: this.meta.code,
          archiveToken: this.archiveToken,
          wasLive,
          peers: otherGuests.map((g) => ({ id: g.att.pid, name: g.att.name })),
        });

        for (const g of otherGuests) {
          this.sendSandstormSys(g.ws, {
            t: 'hostup',
            name: nextHost.att.name,
            hostId: nextHost.att.pid,
          });
        }
      }
    } else if (att?.role === 'guest') {
      for (const peerWs of remaining) {
        const peerAtt = this.readAttachment(peerWs);
        if (peerAtt && peerAtt.role === 'host') {
          this.sendSandstormSys(peerWs, { t: 'leave', id: att.pid });
          break;
        }
      }
    }

    if (remaining.length === 0 && this.meta) {
      if (this.sandstormPhase !== 'lobby') {
        this.sandstormPhase = 'lobby';
        stateDirty = true;
      }
      const nextAlarm = Math.min(this.meta.expiresAt, Date.now() + EMPTY_ROOM_IDLE_MS);
      await this.ctx.storage.setAlarm(nextAlarm);
    }

    if (stateDirty) {
      this.saveSandstormStateToSqlite();
    }

    await this.syncSandstormLobbyToD1(ws);
  }
}
