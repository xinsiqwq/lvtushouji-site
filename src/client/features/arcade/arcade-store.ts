import type {
  ArcadeAdminScoresResponse,
  ArcadeGameId,
  ArcadeLeaderboardResponse,
  ArcadeScoreEntry,
  ArcadeSubmitResponse,
} from '../../../shared/types';
import { apiJson } from '../../lib/api';
import { ARCADE_GAMES, isArcadeGameId, isBetterArcadeScore } from './arcade-catalog';

const ARCADE_BEST_STORAGE_KEY = 'lvtushouji:arcade-best:v1';
const ARCADE_CALLSIGN_STORAGE_KEY = 'lvtushouji:arcade-callsign:v1';

export type ArcadeLocalBests = Partial<Record<ArcadeGameId, number>>;

export type ArcadeSubmitPayload = {
  gameId: ArcadeGameId;
  playerName: string;
  score: number;
  durationMs: number;
  meta?: Record<string, string | number | boolean>;
};

export function sanitizeCallsign(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 16);
}

export function readLocalBests(): ArcadeLocalBests {
  const result: ArcadeLocalBests = {};
  if (typeof window === 'undefined') return result;
  try {
    const raw = window.localStorage.getItem(ARCADE_BEST_STORAGE_KEY);
    if (!raw) return result;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return result;
    for (const game of ARCADE_GAMES) {
      const value = (parsed as Record<string, unknown>)[game.id];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        result[game.id] = Math.round(value);
      }
    }
  } catch {
    /* Ignore malformed storage payload */
  }
  return result;
}

function writeLocalBests(bests: ArcadeLocalBests): void {
  if (typeof window === 'undefined') return;
  try {
    const serializable: ArcadeLocalBests = {};
    for (const game of ARCADE_GAMES) {
      const val = bests[game.id];
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        serializable[game.id] = Math.round(val);
      }
    }
    window.localStorage.setItem(ARCADE_BEST_STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    /* Storage quota or private mode */
  }
}

export function recordLocalBest(
  gameId: ArcadeGameId,
  score: number,
): { best: number; isNewBest: boolean } {
  const bests = readLocalBests();
  const current = typeof bests[gameId] === 'number' ? bests[gameId] : null;
  const candidate = Number.isFinite(score) ? Math.round(score) : 0;

  if (isBetterArcadeScore(gameId, candidate, current)) {
    bests[gameId] = candidate;
    writeLocalBests(bests);
    return { best: candidate, isNewBest: true };
  }

  return {
    best: current ?? Math.max(0, candidate),
    isNewBest: false,
  };
}

export function readSavedCallsign(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(ARCADE_CALLSIGN_STORAGE_KEY);
    if (!raw) return '';
    return sanitizeCallsign(raw);
  } catch {
    return '';
  }
}

export function saveCallsign(name: string): void {
  if (typeof window === 'undefined') return;
  const cleaned = sanitizeCallsign(name);
  try {
    if (!cleaned) {
      window.localStorage.removeItem(ARCADE_CALLSIGN_STORAGE_KEY);
    } else {
      window.localStorage.setItem(ARCADE_CALLSIGN_STORAGE_KEY, cleaned);
    }
  } catch {
    /* Ignore storage write failure */
  }
}

export async function fetchArcadeLeaderboard(gameId: ArcadeGameId): Promise<ArcadeScoreEntry[]> {
  if (!isArcadeGameId(gameId)) return [];
  const res = await apiJson<ArcadeLeaderboardResponse>(
    `/api/arcade/scores?gameId=${encodeURIComponent(gameId)}`,
    { cache: 'no-store' },
  );
  return Array.isArray(res.entries) ? res.entries : [];
}

export async function submitArcadeScore(
  payload: ArcadeSubmitPayload,
): Promise<ArcadeSubmitResponse> {
  const cleanedName = sanitizeCallsign(payload.playerName);
  return apiJson<ArcadeSubmitResponse>('/api/arcade/scores', {
    method: 'POST',
    json: {
      gameId: payload.gameId,
      playerName: cleanedName,
      score: Math.round(payload.score),
      durationMs: Math.max(0, Math.round(payload.durationMs)),
      ...(payload.meta ? { meta: payload.meta } : {}),
    },
  });
}

export async function fetchAdminArcadeScores(): Promise<ArcadeAdminScoresResponse> {
  return apiJson<ArcadeAdminScoresResponse>('/api/admin/arcade/scores', {
    cache: 'no-store',
  });
}

export async function deleteAdminArcadeScore(id: string): Promise<{ ok: boolean; id: string }> {
  return apiJson<{ ok: boolean; id: string }>(
    `/api/admin/arcade/scores/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

export async function resetAdminArcadeScores(
  payload: { gameId?: ArcadeGameId; all?: boolean },
): Promise<{ ok: boolean; deleted: number }> {
  return apiJson<{ ok: boolean; deleted: number }>('/api/admin/arcade/scores/reset', {
    method: 'POST',
    json: payload,
  });
}

const DIFFICULTY_LABELS: Record<string, string> = {
  beginner: '初级',
  easy: '初级',
  intermediate: '中级',
  medium: '中级',
  expert: '高级',
  hard: '高级',
};

const SNAKE_MODE_LABELS: Record<string, string> = {
  classic: '经典边界',
  walls: '经典边界',
  wrap: '星轨穿墙',
  portal: '星轨穿墙',
  orbit: '星轨穿墙',
};

export function formatArcadeMetaTags(
  gameId: ArcadeGameId,
  meta?: Record<string, string | number | boolean> | null,
): string[] {
  if (!meta || typeof meta !== 'object') return [];
  const tags: string[] = [];

  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue;

    if (key === 'difficulty') {
      const str = String(value);
      tags.push(DIFFICULTY_LABELS[str.toLowerCase()] ?? str);
    } else if (key === 'mines' && typeof value === 'number') {
      tags.push(`${value} 雷`);
    } else if (key === 'level' && typeof value === 'number') {
      tags.push(gameId === 'breakout' ? `第 ${value} 关` : `Lv.${value}`);
    } else if (key === 'lines' && typeof value === 'number') {
      tags.push(`消行 ${value}`);
    } else if (key === 'maxTile' && (typeof value === 'number' || typeof value === 'string')) {
      tags.push(`最高 ${value}`);
    } else if (key === 'mode') {
      const str = String(value);
      tags.push(SNAKE_MODE_LABELS[str.toLowerCase()] ?? str);
    } else if (key === 'length' && typeof value === 'number') {
      tags.push(`体长 ${value}`);
    } else if (key === 'maxSpeed' && (typeof value === 'number' || typeof value === 'string')) {
      const formatted = typeof value === 'number' ? value.toFixed(1) : value;
      tags.push(`极速 ${formatted}`);
    } else if (key === 'bricksCleared' && typeof value === 'number') {
      tags.push(`击碎 ${value} 砖`);
    } else if (typeof value === 'boolean') {
      if (value) tags.push(key);
    } else {
      tags.push(`${key} ${String(value)}`);
    }

    if (tags.length >= 3) break;
  }

  return tags;
}

export function formatArcadeTimestamp(iso: string, compact = false): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso || '—';
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  if (compact) {
    return `${mm}-${dd} ${hh}:${min}`;
  }
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
