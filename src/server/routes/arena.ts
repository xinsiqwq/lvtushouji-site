import { Hono } from 'hono';
import {
  generateRoomCode,
  normalizeRoomCode,
  sanitizeArenaPlayerName,
  sanitizeRoomName,
} from '../../shared/arena-utils';
import { ApiError } from '../../shared/errors';
import type {
  ArenaAdminSnapshotResponse,
  ArenaBotDifficulty,
  ArenaCreateRoomResponse,
  ArenaGameMode,
  ArenaLobbySummary,
  ArenaMatchPlayerStat,
  ArenaMatchRecord,
  ArenaMatchesResponse,
  ArenaPhase,
  ArenaRoomsListResponse,
  ArenaTeam,
} from '../../shared/types';
import { id, object } from '../../shared/validators';
import { deleteArenaLobbyRow, insertArenaMatchAndPrune } from '../arena/ArenaRoomDO';
import { countRateLimit, requireCloudAdmin } from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';

export const arenaRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

type ArenaLobbyRow = {
  code: string;
  name: string;
  host_name: string;
  mode: string;
  is_public: number;
  phase: string;
  human_count: number;
  max_humans: number;
  bot_count: number;
  bot_difficulty: string;
  rounds_to_win: number;
  target_kills: number;
  score_red: number;
  score_blue: number;
  created_at: string;
  updated_at: string;
};

type ArenaMatchRow = {
  id: string;
  room_code: string;
  source: 'online' | 'solo';
  mode: string;
  winner_team: string;
  score_red: number;
  score_blue: number;
  mvp_name: string;
  mvp_kills: number;
  mvp_deaths: number;
  mvp_headshots: number;
  duration_ms: number;
  player_count: number;
  bot_count: number;
  players_json: string;
  visitor_id: string;
  created_at: string;
};

const STALE_LOBBY_MS = 35 * 60 * 1000;
const STALE_EMPTY_LOBBY_MS = 5 * 60 * 1000;
const MAX_ROOM_HUMANS = 10;

function parseMode(raw: unknown, fallback: ArenaGameMode = 'elimination'): ArenaGameMode {
  if (raw === undefined || raw === null) return fallback;
  if (raw === 'elimination' || raw === 'deathmatch') return raw;
  throw new ApiError('对局模式必须为 elimination 或 deathmatch', 400);
}

function parseDifficulty(
  raw: unknown,
  fallback: ArenaBotDifficulty = 'veteran',
): ArenaBotDifficulty {
  if (raw === undefined || raw === null) return fallback;
  if (raw === 'rookie' || raw === 'veteran' || raw === 'commander') return raw;
  throw new ApiError('AI 难度必须为 rookie、veteran 或 commander', 400);
}

function parseIntInRange(
  raw: unknown,
  label: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  if ((raw === undefined || raw === null) && fallback !== undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new ApiError(`${label}必须为 ${min}～${max} 的整数`, 400);
  }
  return raw;
}

function mapLobbyRow(row: ArenaLobbyRow): ArenaLobbySummary {
  const phase: ArenaPhase =
    row.phase === 'freeze' ||
    row.phase === 'live' ||
    row.phase === 'round_over' ||
    row.phase === 'match_over'
      ? row.phase
      : 'lobby';

  return {
    code: row.code,
    name: row.name,
    hostName: row.host_name,
    mode: row.mode === 'deathmatch' ? 'deathmatch' : 'elimination',
    isPublic: Number(row.is_public) === 1,
    phase,
    humanCount: Number(row.human_count),
    maxHumans: Number(row.max_humans),
    botCount: Number(row.bot_count),
    botDifficulty:
      row.bot_difficulty === 'rookie' || row.bot_difficulty === 'commander'
        ? row.bot_difficulty
        : 'veteran',
    roundsToWin: Number(row.rounds_to_win),
    targetKills: Number(row.target_kills),
    scoreRed: Number(row.score_red),
    scoreBlue: Number(row.score_blue),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMatchRow(row: ArenaMatchRow, includeVisitorPrefix: boolean): ArenaMatchRecord {
  let players: ArenaMatchPlayerStat[] = [];
  try {
    const parsed = JSON.parse(row.players_json) as unknown;
    if (Array.isArray(parsed)) {
      players = parsed as ArenaMatchPlayerStat[];
    }
  } catch {
    players = [];
  }

  const winnerTeam: ArenaTeam | 'draw' =
    row.winner_team === 'red' || row.winner_team === 'blue' ? row.winner_team : 'draw';

  const record: ArenaMatchRecord = {
    id: row.id,
    roomCode: row.room_code,
    source: row.source === 'online' ? 'online' : 'solo',
    mode: row.mode === 'deathmatch' ? 'deathmatch' : 'elimination',
    winnerTeam,
    scoreRed: Number(row.score_red),
    scoreBlue: Number(row.score_blue),
    mvpName: row.mvp_name,
    mvpKills: Number(row.mvp_kills),
    mvpDeaths: Number(row.mvp_deaths),
    mvpHeadshots: Number(row.mvp_headshots),
    durationMs: Number(row.duration_ms),
    playerCount: Number(row.player_count),
    botCount: Number(row.bot_count),
    players,
    createdAt: row.created_at,
  };

  if (includeVisitorPrefix && row.visitor_id) {
    record.visitorPrefix = row.visitor_id.slice(0, 8);
  }
  return record;
}

async function sweepStaleLobbies(db: D1Database): Promise<void> {
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_LOBBY_MS).toISOString();
  const emptyCutoff = new Date(now - STALE_EMPTY_LOBBY_MS).toISOString();
  await db
    .prepare(
      'DELETE FROM arena_lobbies WHERE updated_at <= ? OR (human_count <= 0 AND updated_at <= ?)',
    )
    .bind(staleCutoff, emptyCutoff)
    .run();
}

arenaRoutes.get('/api/arena/rooms', async (c) => {
  const db = c.get('costEnv').DB;
  await sweepStaleLobbies(db);
  const rows = await db
    .prepare(
      'SELECT * FROM arena_lobbies WHERE is_public = 1 ORDER BY human_count DESC, updated_at DESC LIMIT 30',
    )
    .all<ArenaLobbyRow>();
  const rooms = rows.results.map(mapLobbyRow);
  const response: ArenaRoomsListResponse = {
    rooms,
    totalPublic: rooms.length,
  };
  return c.json(response);
});

arenaRoutes.post('/api/arena/rooms', async (c) => {
  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');

  const contentType = c.req.header('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError('创建房间请求必须使用 JSON', 400);
  }

  const limits = await Promise.all([
    countRateLimit(costEnv, `arena:create:visitor:${ctx.visitorId}`, 15 * 60_000, 12),
    countRateLimit(costEnv, `arena:create:ip:${ctx.address}`, 15 * 60_000, 24),
  ]);
  if (limits.some(Boolean)) {
    throw new ApiError('创建房间过于频繁，请稍后再试', 429);
  }

  const rawBody = await c.req.json().catch(() => null);
  const body = object(rawBody ?? {});

  const name = sanitizeRoomName(body.name, '沙暴行动房间');
  const hostName = sanitizeArenaPlayerName(body.hostName, '火星特勤');
  const mode = parseMode(body.mode, 'elimination');
  let isPublic = true;
  if (body.isPublic !== undefined) {
    if (typeof body.isPublic !== 'boolean') {
      throw new ApiError('公开房间标识必须为布尔值', 400);
    }
    isPublic = body.isPublic;
  }
  const maxHumans = parseIntInRange(body.maxHumans, '人数上限', 2, MAX_ROOM_HUMANS, MAX_ROOM_HUMANS);
  const botCount = parseIntInRange(body.botCount, 'AI 数量', 0, 10, 4);
  const botDifficulty = parseDifficulty(body.botDifficulty, 'veteran');
  const roundsToWin = parseIntInRange(body.roundsToWin, '获胜回合数', 1, 9, 5);
  const targetKills = parseIntInRange(body.targetKills, '目标击杀数', 1, 50, 25);

  await sweepStaleLobbies(costEnv.DB);

  let createdRoom: ArenaLobbySummary | null = null;
  let roomCode = '';

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = generateRoomCode();
    const stub = costEnv.ARENA_ROOM.getByName(`room:${candidate}`);
    const initRes = await stub.fetch('https://arena.internal/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: candidate,
        name,
        hostName,
        mode,
        isPublic,
        maxHumans,
        botCount,
        botDifficulty,
        roundsToWin,
        targetKills,
      }),
    });

    if (initRes.status === 409) {
      continue;
    }
    if (!initRes.ok) {
      const errData = (await initRes.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(errData.error || '创建房间失败', initRes.status);
    }
    const json = (await initRes.json()) as { room: ArenaLobbySummary };
    createdRoom = json.room;
    roomCode = candidate;
    break;
  }

  if (!createdRoom || !roomCode) {
    throw new ApiError('生成房间码冲突，请稍后重试', 503);
  }

  const response: ArenaCreateRoomResponse = {
    code: roomCode,
    room: createdRoom,
    wsPath: `/api/arena/ws?room=${roomCode}`,
  };
  return c.json(response, 201);
});

arenaRoutes.get('/api/arena/ws', async (c) => {
  const upgrade = (c.req.header('upgrade') || '').toLowerCase();
  if (upgrade !== 'websocket') {
    return c.json({ error: '需要 WebSocket 升级连接' }, 426);
  }

  const originHeader = c.req.header('origin') || '';
  let sameOrigin = false;
  try {
    sameOrigin = new URL(originHeader).origin === new URL(c.req.url).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    return c.json({ error: 'WebSocket 请求来源校验失败' }, 403);
  }

  const code = normalizeRoomCode(c.req.query('room'));
  if (!code) {
    return c.json({ error: '无效的 6 位房间码' }, 400);
  }

  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');
  const stub = costEnv.ARENA_ROOM.getByName(`room:${code}`);

  const forwardUrl = new URL('https://arena.internal/ws');
  for (const key of ['name', 'team', 'primaryWeapon', 'proto'] as const) {
    const val = c.req.query(key);
    if (val) forwardUrl.searchParams.set(key, val);
  }

  const headers = new Headers(c.req.raw.headers);
  headers.set('x-arena-visitor-id', ctx.visitorId);

  return stub.fetch(
    new Request(forwardUrl.toString(), {
      method: 'GET',
      headers,
    }),
  );
});

arenaRoutes.get('/api/arena/matches', async (c) => {
  const db = c.get('costEnv').DB;
  const rawLimit = Number(c.req.query('limit') ?? 20);
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(50, rawLimit) : 20;

  const rows = await db
    .prepare('SELECT * FROM arena_matches ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .bind(limit)
    .all<ArenaMatchRow>();

  const response: ArenaMatchesResponse = {
    matches: rows.results.map((r) => mapMatchRow(r, false)),
  };
  return c.json(response);
});

arenaRoutes.post('/api/arena/matches', async (c) => {
  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');

  const contentType = c.req.header('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError('战报提交必须使用 JSON', 400);
  }

  const limits = await Promise.all([
    countRateLimit(costEnv, `arena:match:visitor:${ctx.visitorId}`, 15 * 60_000, 20),
    countRateLimit(costEnv, `arena:match:ip:${ctx.address}`, 15 * 60_000, 40),
  ]);
  if (limits.some(Boolean)) {
    throw new ApiError('战报提交过于频繁，请稍后再试', 429);
  }

  const body = object(await c.req.json().catch(() => null));
  const mode = parseMode(body.mode);
  const winnerTeam =
    body.winnerTeam === 'red' || body.winnerTeam === 'blue' || body.winnerTeam === 'draw'
      ? body.winnerTeam
      : null;
  if (!winnerTeam) {
    throw new ApiError('胜方阵营必须为 red、blue 或 draw', 400);
  }

  const scoreRed = parseIntInRange(body.scoreRed, '红队比分', 0, 100);
  const scoreBlue = parseIntInRange(body.scoreBlue, '蓝队比分', 0, 100);
  const mvpName = sanitizeArenaPlayerName(body.mvpName, '火星特勤');
  const mvpKills = parseIntInRange(body.mvpKills, 'MVP 击杀数', 0, 200);
  const mvpDeaths = parseIntInRange(body.mvpDeaths, 'MVP 阵亡数', 0, 200);
  const mvpHeadshots = parseIntInRange(body.mvpHeadshots, 'MVP 爆头数', 0, mvpKills);
  const durationMs = parseIntInRange(body.durationMs, '对局时长', 0, 3_600_000);
  const playerCount = parseIntInRange(body.playerCount, '玩家人数', 1, MAX_ROOM_HUMANS);
  const botCount = parseIntInRange(body.botCount, 'AI 数量', 0, 10);

  if (!Array.isArray(body.players) || body.players.length < 1 || body.players.length > 18) {
    throw new ApiError('对局玩家统计必须包含 1～18 条记录', 400);
  }

  const players: ArenaMatchPlayerStat[] = body.players.map((raw, idx) => {
    const p = object(raw);
    const team: ArenaTeam | null = p.team === 'red' || p.team === 'blue' ? p.team : null;
    if (!team) throw new ApiError('玩家阵营无效', 400);
    if (typeof p.isBot !== 'boolean') throw new ApiError('玩家 AI 标识无效', 400);
    const kills = parseIntInRange(p.kills, '击杀数', 0, 200);
    const deaths = parseIntInRange(p.deaths, '阵亡数', 0, 200);
    const assists = parseIntInRange(p.assists, '助攻数', 0, 200);
    const headshots = parseIntInRange(p.headshots, '爆头数', 0, kills);
    const damage = parseIntInRange(p.damage, '总伤害', 0, 100_000);
    const score = parseIntInRange(p.score, '个人积分', 0, 2_000);
    const playerId =
      typeof p.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(p.id) ? p.id : `p_${idx + 1}`;
    return {
      id: playerId,
      name: sanitizeArenaPlayerName(p.name, `特勤${idx + 1}`),
      team,
      isBot: p.isBot,
      kills,
      deaths,
      assists,
      headshots,
      damage,
      score,
    };
  });

  const isOnline = body.source === 'online';
  let roomCode = 'SOLO01';

  if (isOnline) {
    const normalizedOnlineCode = normalizeRoomCode(body.roomCode);
    if (!normalizedOnlineCode) {
      throw new ApiError('线上战报必须提供有效的 6 位房间码', 400);
    }
    if (
      typeof body.archiveToken !== 'string' ||
      body.archiveToken.length < 16 ||
      body.archiveToken.length > 128
    ) {
      throw new ApiError('线上战报校验失败，仅联机房主可提交线上战报', 403);
    }

    const verifyStub = costEnv.ARENA_ROOM.getByName(`room:${normalizedOnlineCode}`);
    const verifyRes = await verifyStub.fetch('https://arena.internal/verify-archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: body.archiveToken }),
    });
    if (!verifyRes.ok) {
      const errData = (await verifyRes.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(
        errData.error || '线上战报校验失败',
        verifyRes.status === 429 ? 429 : 403,
      );
    }
    roomCode = normalizedOnlineCode;
  } else {
    roomCode = normalizeRoomCode(body.roomCode) ?? 'SOLO01';
  }

  const matchSource: 'online' | 'solo' = isOnline ? 'online' : 'solo';
  const matchId = `am_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const createdAt = new Date().toISOString();

  const record: ArenaMatchRecord = {
    id: matchId,
    roomCode,
    source: matchSource,
    mode,
    winnerTeam,
    scoreRed,
    scoreBlue,
    mvpName,
    mvpKills,
    mvpDeaths,
    mvpHeadshots,
    durationMs,
    playerCount,
    botCount,
    players,
    createdAt,
  };

  await insertArenaMatchAndPrune(costEnv.DB, record, ctx.visitorId);
  return c.json({ match: record }, 201);
});

arenaRoutes.get('/api/admin/arena/snapshot', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;

  await sweepStaleLobbies(db);
  const [lobbyRows, matchRows] = await Promise.all([
    db
      .prepare('SELECT * FROM arena_lobbies ORDER BY human_count DESC, updated_at DESC LIMIT 50')
      .all<ArenaLobbyRow>(),
    db
      .prepare('SELECT * FROM arena_matches ORDER BY created_at DESC, rowid DESC LIMIT 100')
      .all<ArenaMatchRow>(),
  ]);

  const lobbies = lobbyRows.results.map(mapLobbyRow);
  const matches = matchRows.results.map((r) => mapMatchRow(r, true));

  const response: ArenaAdminSnapshotResponse = {
    lobbies,
    matches,
    counts: {
      activeLobbies: lobbies.length,
      publicLobbies: lobbies.filter((l) => l.isPublic).length,
      activeHumans: lobbies.reduce((sum, l) => sum + l.humanCount, 0),
      archivedMatches: matches.length,
    },
  };
  return c.json(response);
});

arenaRoutes.delete('/api/admin/arena/rooms/:code', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const code = normalizeRoomCode(c.req.param('code'));
  if (!code) {
    throw new ApiError('无效的 6 位房间码', 400);
  }
  const costEnv = c.get('costEnv');
  const stub = costEnv.ARENA_ROOM.getByName(`room:${code}`);
  await stub.fetch('https://arena.internal/destroy', { method: 'POST' });
  await deleteArenaLobbyRow(costEnv.DB, code);
  return c.json({ ok: true, code });
});

arenaRoutes.delete('/api/admin/arena/matches/:id', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;
  const matchId = id(c.req.param('id'));

  const existing = await db
    .prepare('SELECT id FROM arena_matches WHERE id = ?')
    .bind(matchId)
    .first<{ id: string }>();
  if (!existing) {
    throw new ApiError('战报记录不存在', 404);
  }

  await db.prepare('DELETE FROM arena_matches WHERE id = ?').bind(matchId).run();
  return c.json({ ok: true, id: matchId });
});

arenaRoutes.post('/api/admin/arena/matches/reset', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;
  const body = object(await c.req.json().catch(() => null));

  if (body.all === true) {
    const res = await db.prepare('DELETE FROM arena_matches').run();
    return c.json({ ok: true, deleted: Number(res.meta.changes ?? 0) });
  }
  if (body.source === 'online' || body.source === 'solo') {
    const res = await db
      .prepare('DELETE FROM arena_matches WHERE source = ?')
      .bind(body.source)
      .run();
    return c.json({ ok: true, deleted: Number(res.meta.changes ?? 0) });
  }
  throw new ApiError('请指定要清理的战报来源（online/solo）或设置 all: true', 400);
});
