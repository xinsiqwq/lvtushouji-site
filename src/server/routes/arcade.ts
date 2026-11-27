import { Hono } from 'hono';
import { ApiError } from '../../shared/errors';
import type {
  ArcadeAdminScoresResponse,
  ArcadeGameId,
  ArcadeLeaderboardResponse,
  ArcadeScoreEntry,
  ArcadeSubmitResponse,
} from '../../shared/types';
import { id, object } from '../../shared/validators';
import { countRateLimit, requireCloudAdmin } from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';

export const arcadeRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

type ArcadeScoreRow = {
  id: string;
  game_id: ArcadeGameId;
  player_name: string;
  score: number;
  duration_ms: number;
  meta_json: string;
  visitor_id: string;
  created_at: string;
};

type GameRule = {
  sortDirection: 'desc' | 'asc';
  minScore: number;
  maxScore: number;
};

const GAME_RULES: Record<ArcadeGameId, GameRule> = {
  dino: { sortDirection: 'desc', minScore: 1, maxScore: 999_999 },
  snake: { sortDirection: 'desc', minScore: 1, maxScore: 50_000 },
  tetris: { sortDirection: 'desc', minScore: 1, maxScore: 2_000_000 },
  '2048': { sortDirection: 'desc', minScore: 4, maxScore: 4_000_000 },
  minesweeper: { sortDirection: 'asc', minScore: 1_000, maxScore: 3_600_000 },
  breakout: { sortDirection: 'desc', minScore: 1, maxScore: 500_000 },
};

const ALL_GAME_IDS: readonly ArcadeGameId[] = [
  'dino',
  'snake',
  'tetris',
  '2048',
  'minesweeper',
  'breakout',
];

const MAX_META_BYTES = 512;
const MAX_DURATION_MS = 86_400_000;
const TOP_PUBLIC_LIMIT = 10;
const MAX_STORED_PER_GAME = 50;

const encoder = new TextEncoder();

function parseGameId(value: unknown): ArcadeGameId {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(GAME_RULES, value)) {
    return value as ArcadeGameId;
  }
  throw new ApiError('无效的游戏标识', 400);
}

function sanitizePlayerName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError('玩家代号需为 1～16 个字符', 400);
  }
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const charCount = [...cleaned].length;
  if (charCount < 1 || charCount > 16) {
    throw new ApiError('玩家代号需为 1～16 个字符', 400);
  }
  return cleaned;
}

function sanitizeMeta(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('成绩附加信息必须为扁平对象', 400);
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  const entries = Object.entries(src);
  if (entries.length > 16) {
    throw new ApiError('成绩附加信息字段过多', 400);
  }
  for (const [rawKey, rawVal] of entries) {
    const key = rawKey.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
    if (!key || key.length > 32) {
      throw new ApiError('成绩附加信息键名无效', 400);
    }
    if (typeof rawVal === 'string') {
      out[key] = rawVal.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 120);
    } else if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
      out[key] = rawVal;
    } else if (typeof rawVal === 'boolean') {
      out[key] = rawVal;
    } else {
      throw new ApiError('成绩附加信息仅支持字符串、有限数字或布尔值', 400);
    }
  }
  if (encoder.encode(JSON.stringify(out)).byteLength > MAX_META_BYTES) {
    throw new ApiError('成绩附加信息超过 512 字节限制', 400);
  }
  return out;
}

function parseStoredMeta(raw: string): Record<string, string | number | boolean> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string | number | boolean>;
    }
  } catch {
    /* Fall back to empty object */
  }
  return {};
}

function mapScoreRow(row: ArcadeScoreRow, includeVisitorPrefix: boolean): ArcadeScoreEntry {
  const entry: ArcadeScoreEntry = {
    id: row.id,
    gameId: row.game_id,
    playerName: row.player_name,
    score: Number(row.score),
    durationMs: Number(row.duration_ms),
    meta: parseStoredMeta(row.meta_json),
    createdAt: row.created_at,
  };
  if (includeVisitorPrefix) {
    entry.visitorPrefix = (row.visitor_id || '').slice(0, 8);
  }
  return entry;
}

async function fetchGameScores(
  db: D1Database,
  gameId: ArcadeGameId,
  limit: number,
  includeVisitorPrefix: boolean,
): Promise<ArcadeScoreEntry[]> {
  const dir = GAME_RULES[gameId].sortDirection === 'asc' ? 'ASC' : 'DESC';
  const rows = await db
    .prepare(
      `SELECT id, game_id, player_name, score, duration_ms, meta_json, visitor_id, created_at
       FROM arcade_scores
       WHERE game_id = ?
       ORDER BY score ${dir}, created_at ASC, rowid ASC
       LIMIT ?`,
    )
    .bind(gameId, limit)
    .all<ArcadeScoreRow>();
  return rows.results.map((row) => mapScoreRow(row, includeVisitorPrefix));
}

arcadeRoutes.get('/api/arcade/scores', async (c) => {
  const db = c.get('costEnv').DB;
  const rawGameId = c.req.query('gameId');

  if (rawGameId !== undefined && rawGameId !== '') {
    const gameId = parseGameId(rawGameId);
    const entries = await fetchGameScores(db, gameId, TOP_PUBLIC_LIMIT, false);
    const response: ArcadeLeaderboardResponse = {
      gameId,
      sortDirection: GAME_RULES[gameId].sortDirection,
      entries,
    };
    return c.json(response);
  }

  const lists = await Promise.all(
    ALL_GAME_IDS.map(async (gid) => [gid, await fetchGameScores(db, gid, TOP_PUBLIC_LIMIT, false)] as const),
  );
  const leaderboards = Object.fromEntries(lists) as Record<ArcadeGameId, ArcadeScoreEntry[]>;
  return c.json({ leaderboards });
});

arcadeRoutes.post('/api/arcade/scores', async (c) => {
  const costEnv = c.get('costEnv');
  const ctx = c.get('cloudCtx');

  const contentType = c.req.header('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError('成绩提交请求必须使用 JSON', 400);
  }

  const limits = await Promise.all([
    countRateLimit(costEnv, `arcade:submit:visitor:${ctx.visitorId}`, 15 * 60_000, 20),
    countRateLimit(costEnv, `arcade:submit:ip:${ctx.address}`, 15 * 60_000, 40),
  ]);
  if (limits.some(Boolean)) {
    throw new ApiError('成绩提交过于频繁，请稍后再试', 429);
  }

  const rawBody = await c.req.json().catch(() => null);
  const body = object(rawBody);

  const gameId = parseGameId(body.gameId);
  const rule = GAME_RULES[gameId];
  const playerName = sanitizePlayerName(body.playerName);

  if (
    typeof body.score !== 'number' ||
    !Number.isInteger(body.score) ||
    body.score < rule.minScore ||
    body.score > rule.maxScore
  ) {
    throw new ApiError(`成绩数值超出允许范围（${rule.minScore}～${rule.maxScore}）`, 400);
  }
  const score = body.score;

  let durationMs = 0;
  if (body.durationMs !== undefined && body.durationMs !== null) {
    if (
      typeof body.durationMs !== 'number' ||
      !Number.isInteger(body.durationMs) ||
      body.durationMs < 0 ||
      body.durationMs > MAX_DURATION_MS
    ) {
      throw new ApiError('对局时长无效', 400);
    }
    durationMs = body.durationMs;
  }

  const meta = sanitizeMeta(body.meta);
  const metaJson = JSON.stringify(meta);
  const entryId = `as_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const createdAt = new Date().toISOString();

  await costEnv.DB.prepare(
    `INSERT INTO arcade_scores (id, game_id, player_name, score, duration_ms, meta_json, visitor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(entryId, gameId, playerName, score, durationMs, metaJson, ctx.visitorId, createdAt)
    .run();

  const dir = rule.sortDirection === 'asc' ? 'ASC' : 'DESC';
  const orderedIds = await costEnv.DB.prepare(
    `SELECT id FROM arcade_scores WHERE game_id = ? ORDER BY score ${dir}, created_at ASC, rowid ASC`,
  )
    .bind(gameId)
    .all<{ id: string }>();

  const rankIndex = orderedIds.results.findIndex((row) => row.id === entryId);
  const rank = rankIndex >= 0 ? rankIndex + 1 : orderedIds.results.length + 1;
  const madeTop10 = rank <= TOP_PUBLIC_LIMIT;

  if (orderedIds.results.length > MAX_STORED_PER_GAME) {
    await costEnv.DB.prepare(
      `DELETE FROM arcade_scores
       WHERE game_id = ?
         AND id NOT IN (
           SELECT id FROM arcade_scores
           WHERE game_id = ?
           ORDER BY score ${dir}, created_at ASC, rowid ASC
           LIMIT ?
         )`,
    )
      .bind(gameId, gameId, MAX_STORED_PER_GAME)
      .run();
  }

  const leaderboard = await fetchGameScores(costEnv.DB, gameId, TOP_PUBLIC_LIMIT, false);
  const entry: ArcadeScoreEntry = {
    id: entryId,
    gameId,
    playerName,
    score,
    durationMs,
    meta,
    createdAt,
  };

  const response: ArcadeSubmitResponse = {
    entry,
    rank,
    madeTop10,
    leaderboard,
  };
  return c.json(response, 201);
});

arcadeRoutes.get('/api/admin/arcade/scores', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;
  const rawGameId = c.req.query('gameId');
  const filterGameId =
    rawGameId !== undefined && rawGameId !== '' ? parseGameId(rawGameId) : null;

  const [countRows, perGameLists] = await Promise.all([
    db
      .prepare('SELECT game_id, COUNT(*) AS cnt FROM arcade_scores GROUP BY game_id')
      .all<{ game_id: string; cnt: number }>(),
    Promise.all(
      (filterGameId ? [filterGameId] : ALL_GAME_IDS).map((gid) =>
        fetchGameScores(db, gid, MAX_STORED_PER_GAME, true),
      ),
    ),
  ]);

  const counts: Record<ArcadeGameId, number> = {
    dino: 0,
    snake: 0,
    tetris: 0,
    '2048': 0,
    minesweeper: 0,
    breakout: 0,
  };
  for (const row of countRows.results) {
    if (Object.prototype.hasOwnProperty.call(counts, row.game_id)) {
      counts[row.game_id as ArcadeGameId] = Number(row.cnt);
    }
  }

  const entries = perGameLists.flat();
  const response: ArcadeAdminScoresResponse = { entries, counts };
  return c.json(response);
});

arcadeRoutes.delete('/api/admin/arcade/scores/:id', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;
  const scoreId = id(c.req.param('id'));

  const existing = await db
    .prepare('SELECT id FROM arcade_scores WHERE id=?')
    .bind(scoreId)
    .first<{ id: string }>();
  if (!existing) {
    throw new ApiError('榜单记录不存在', 404);
  }

  await db.prepare('DELETE FROM arcade_scores WHERE id=?').bind(scoreId).run();
  return c.json({ ok: true, id: scoreId }, 200);
});

arcadeRoutes.post('/api/admin/arcade/scores/reset', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;
  const body = object(await c.req.json().catch(() => null));

  if (body.all === true) {
    const res = await db.prepare('DELETE FROM arcade_scores').run();
    return c.json({ ok: true, deleted: Number(res.meta.changes ?? 0) }, 200);
  }
  if (body.gameId !== undefined && body.gameId !== null && body.gameId !== '') {
    const gameId = parseGameId(body.gameId);
    const res = await db.prepare('DELETE FROM arcade_scores WHERE game_id=?').bind(gameId).run();
    return c.json({ ok: true, deleted: Number(res.meta.changes ?? 0) }, 200);
  }
  throw new ApiError('请指定要清空的游戏标识或设置 all: true', 400);
});
