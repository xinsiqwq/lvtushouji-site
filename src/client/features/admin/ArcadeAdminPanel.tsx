import { useCallback, useEffect, useMemo, useState } from 'react';
import { Crosshair, Radio, RefreshCw, RotateCcw, Trash2, Trophy, XCircle } from 'lucide-react';
import type {
  ArcadeGameId,
  ArcadeScoreEntry,
  ArenaAdminSnapshotResponse,
  ArenaGameMode,
  ArenaLobbySummary,
  ArenaMatchRecord,
  ArenaPhase,
} from '../../../shared/types';
import { apiJson } from '../../lib/api';
import {
  ARCADE_GAMES,
  formatArcadeDuration,
  formatArcadeScore,
  getArcadeGameMeta,
} from '../arcade/arcade-catalog';
import {
  deleteAdminArcadeScore,
  fetchAdminArcadeScores,
  formatArcadeMetaTags,
  formatArcadeTimestamp,
  resetAdminArcadeScores,
} from '../arcade/arcade-store';

type ArcadeAdminPanelProps = {
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
};

type GameFilter = 'all' | ArcadeGameId;
type ResetConfirmScope = null | 'current' | 'all';

function createEmptyCounts(): Record<ArcadeGameId, number> {
  return {
    dino: 0,
    snake: 0,
    tetris: 0,
    '2048': 0,
    minesweeper: 0,
    breakout: 0,
  };
}

function formatScoreWithUnit(gameId: ArcadeGameId, score: number): string {
  const formatted = formatArcadeScore(gameId, score);
  const meta = getArcadeGameMeta(gameId);
  return meta.sortDirection === 'asc' ? formatted : `${formatted} ${meta.scoreUnit}`;
}

function formatArenaMode(mode: ArenaGameMode): string {
  return mode === 'deathmatch' ? '团队死斗' : '5v5 爆破竞技';
}

function formatArenaPhase(phase: ArenaPhase): string {
  switch (phase) {
    case 'lobby':
      return '大厅集结';
    case 'freeze':
      return '开局准备';
    case 'live':
      return '交战中';
    case 'round_over':
      return '回合结算';
    case 'match_over':
      return '已完局';
  }
}

function formatArenaWinner(winner: ArenaMatchRecord['winnerTeam']): string {
  if (winner === 'red') return 'T 方（红）胜';
  if (winner === 'blue') return 'CT 方（蓝）胜';
  return '平局';
}

const EMPTY_ARENA_COUNTS: ArenaAdminSnapshotResponse['counts'] = {
  activeLobbies: 0,
  publicLobbies: 0,
  activeHumans: 0,
  archivedMatches: 0,
};

export function ArcadeAdminPanel({ onStatus, onError }: ArcadeAdminPanelProps) {
  const [entries, setEntries] = useState<ArcadeScoreEntry[]>([]);
  const [counts, setCounts] = useState<Record<ArcadeGameId, number>>(createEmptyCounts);
  const [filter, setFilter] = useState<GameFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmScope, setConfirmScope] = useState<ResetConfirmScope>(null);
  const [resetting, setResetting] = useState(false);

  // Phase 4: SANDSTORM 3D Tactical Shooter moderation state
  const [arenaLobbies, setArenaLobbies] = useState<ArenaLobbySummary[]>([]);
  const [arenaMatches, setArenaMatches] = useState<ArenaMatchRecord[]>([]);
  const [arenaCounts, setArenaCounts] =
    useState<ArenaAdminSnapshotResponse['counts']>(EMPTY_ARENA_COUNTS);
  const [arenaLoading, setArenaLoading] = useState(true);
  const [arenaRefreshing, setArenaRefreshing] = useState(false);
  const [arenaDeletingId, setArenaDeletingId] = useState<string | null>(null);
  const [arenaClosingCode, setArenaClosingCode] = useState<string | null>(null);
  const [arenaConfirmReset, setArenaConfirmReset] = useState(false);
  const [arenaResetting, setArenaResetting] = useState(false);
  const [arenaNotice, setArenaNotice] = useState('');

  const loadScores = useCallback(
    async (silent = false) => {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      onError('');
      try {
        const res = await fetchAdminArcadeScores();
        setEntries(Array.isArray(res.entries) ? res.entries : []);
        setCounts({
          ...createEmptyCounts(),
          ...(res.counts ?? {}),
        });
      } catch (err) {
        onError(err instanceof Error ? err.message : '加载竞技榜单数据失败');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onError('');

    fetchAdminArcadeScores()
      .then((res) => {
        if (!cancelled) {
          setEntries(Array.isArray(res.entries) ? res.entries : []);
          setCounts({
            ...createEmptyCounts(),
            ...(res.counts ?? {}),
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : '加载竞技榜单数据失败');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onError]);

  const loadArenaSnapshot = useCallback(async (silent = false) => {
    if (silent) {
      setArenaRefreshing(true);
    } else {
      setArenaLoading(true);
    }
    setArenaNotice('');
    try {
      const res = await apiJson<ArenaAdminSnapshotResponse>('/api/admin/arena/snapshot', {
        cache: 'no-store',
      });
      setArenaLobbies(Array.isArray(res.lobbies) ? res.lobbies : []);
      setArenaMatches(Array.isArray(res.matches) ? res.matches : []);
      setArenaCounts({
        ...EMPTY_ARENA_COUNTS,
        ...(res.counts ?? {}),
      });
    } catch (err) {
      setArenaNotice(err instanceof Error ? err.message : '加载沙暴行动 · SANDSTORM 数据失败');
    } finally {
      setArenaLoading(false);
      setArenaRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setArenaLoading(true);
    setArenaNotice('');
    apiJson<ArenaAdminSnapshotResponse>('/api/admin/arena/snapshot', {
      cache: 'no-store',
    })
      .then((res) => {
        if (cancelled) return;
        setArenaLobbies(Array.isArray(res.lobbies) ? res.lobbies : []);
        setArenaMatches(Array.isArray(res.matches) ? res.matches : []);
        setArenaCounts({
          ...EMPTY_ARENA_COUNTS,
          ...(res.counts ?? {}),
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setArenaNotice(err instanceof Error ? err.message : '加载沙暴行动 · SANDSTORM 数据失败');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setArenaLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDeleteArenaMatch = async (match: ArenaMatchRecord) => {
    if (arenaDeletingId) return;
    setArenaDeletingId(match.id);
    onError('');
    try {
      await apiJson<{ ok: true; id: string }>(
        `/api/admin/arena/matches/${encodeURIComponent(match.id)}`,
        { method: 'DELETE' },
      );
      setArenaMatches((prev) => prev.filter((item) => item.id !== match.id));
      setArenaCounts((prev) => ({
        ...prev,
        archivedMatches: Math.max(0, prev.archivedMatches - 1),
      }));
      onStatus(`已删除沙暴行动战报（房号 ${match.roomCode} · MVP ${match.mvpName}）。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '删除沙暴行动战报失败');
    } finally {
      setArenaDeletingId(null);
    }
  };

  const handleConfirmResetArenaMatches = async () => {
    if (arenaResetting) return;
    setArenaResetting(true);
    onError('');
    try {
      const res = await apiJson<{ ok: true; deleted: number }>('/api/admin/arena/matches/reset', {
        method: 'POST',
        json: { all: true },
      });
      setArenaConfirmReset(false);
      await loadArenaSnapshot(true);
      onStatus(`已清空沙暴行动全部战报归档，共移除 ${res.deleted} 条记录。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '清空沙暴行动战报归档失败');
    } finally {
      setArenaResetting(false);
    }
  };

  const handleCloseArenaRoom = async (lobby: ArenaLobbySummary) => {
    if (arenaClosingCode) return;
    setArenaClosingCode(lobby.code);
    onError('');
    try {
      await apiJson<{ ok: true; code: string }>(
        `/api/admin/arena/rooms/${encodeURIComponent(lobby.code)}`,
        { method: 'DELETE' },
      );
      await loadArenaSnapshot(true);
      onStatus(`已强制关闭沙暴行动房间 ${lobby.code}。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '强制关闭沙暴行动房间失败');
    } finally {
      setArenaClosingCode(null);
    }
  };

  const totalCount = useMemo(
    () => ARCADE_GAMES.reduce((sum, game) => sum + (counts[game.id] ?? 0), 0),
    [counts],
  );

  const filteredEntries = useMemo(() => {
    if (filter === 'all') return entries;
    return entries.filter((entry) => entry.gameId === filter);
  }, [entries, filter]);

  const rankByEntryId = useMemo(() => {
    const perGameRank: Record<ArcadeGameId, number> = createEmptyCounts();
    const map = new Map<string, number>();
    for (const entry of entries) {
      const nextRank = (perGameRank[entry.gameId] ?? 0) + 1;
      perGameRank[entry.gameId] = nextRank;
      map.set(entry.id, nextRank);
    }
    return map;
  }, [entries]);

  const currentGameMeta = filter === 'all' ? null : getArcadeGameMeta(filter);
  const currentFilterCount = filter === 'all' ? totalCount : (counts[filter] ?? 0);

  const handleSelectFilter = (next: GameFilter) => {
    setFilter(next);
    setConfirmScope(null);
  };

  const handleDeleteEntry = async (entry: ArcadeScoreEntry) => {
    if (deletingId) return;
    setDeletingId(entry.id);
    onError('');
    try {
      await deleteAdminArcadeScore(entry.id);
      setEntries((prev) => prev.filter((item) => item.id !== entry.id));
      setCounts((prev) => ({
        ...prev,
        [entry.gameId]: Math.max(0, (prev[entry.gameId] ?? 0) - 1),
      }));
      const meta = getArcadeGameMeta(entry.gameId);
      onStatus(`已删除「${meta.shortName}」榜单中玩家「${entry.playerName}」的成绩纪录。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '删除榜单纪录失败');
    } finally {
      setDeletingId(null);
    }
  };

  const handleConfirmReset = async () => {
    if (!confirmScope || resetting) return;
    if (confirmScope === 'current' && filter === 'all') return;

    setResetting(true);
    onError('');
    try {
      const payload =
        confirmScope === 'all' ? { all: true } : { gameId: filter as ArcadeGameId };
      const res = await resetAdminArcadeScores(payload);
      setConfirmScope(null);
      await loadScores(true);
      if (confirmScope === 'all') {
        onStatus(`已清空全部竞技榜单，共移除 ${res.deleted} 条纪录。`);
      } else if (currentGameMeta) {
        onStatus(`已清空「${currentGameMeta.name}」榜单，共移除 ${res.deleted} 条纪录。`);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : '清空榜单失败');
    } finally {
      setResetting(false);
    }
  };

  return (
    <section aria-label="竞技榜单管理" className="space-y-5">
      {/* Header & Overview Card */}
      <div className="rounded-[20px] border border-hairline bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="m-0 flex items-center gap-2 text-[18px] font-semibold text-ink">
              <Trophy className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
              <span>火星游乐竞技场 · 全站榜单管理</span>
            </h2>
            <p className="mt-1.5 mb-0 text-[13.5px] text-ink-muted">
              当前共保存{' '}
              <span className="tabular-nums-mono font-medium text-ink">{totalCount}</span>{' '}
              条有效成绩纪录（每个游戏保留前 50 名）；支持按游戏筛选、逐条清理异常成绩或清空榜单。
            </p>
          </div>

          <button
            type="button"
            onClick={() => void loadScores(true)}
            disabled={loading || refreshing}
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[13px] text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            <RefreshCw
              className={['h-3.5 w-3.5', loading || refreshing ? 'animate-spin' : ''].join(' ')}
              aria-hidden="true"
            />
            <span>刷新榜单</span>
          </button>
        </div>

        {/* Game Filter Pills */}
        <div
          role="group"
          aria-label="按游戏筛选榜单"
          className="mt-5 flex flex-wrap items-center gap-2"
        >
          <button
            type="button"
            onClick={() => handleSelectFilter('all')}
            aria-pressed={filter === 'all'}
            className={[
              'inline-flex min-h-[34px] items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors',
              filter === 'all'
                ? 'bg-cta-bg font-medium text-cta-text'
                : 'border border-hairline bg-paper text-ink-muted hover:bg-surface-hover hover:text-ink',
            ].join(' ')}
          >
            <span>全部</span>
            <span className="tabular-nums-mono text-[11.5px] opacity-80">{totalCount}</span>
          </button>

          {ARCADE_GAMES.map((game) => {
            const active = filter === game.id;
            const count = counts[game.id] ?? 0;
            return (
              <button
                key={game.id}
                type="button"
                onClick={() => handleSelectFilter(game.id)}
                aria-pressed={active}
                className={[
                  'inline-flex min-h-[34px] items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors',
                  active
                    ? 'bg-cta-bg font-medium text-cta-text'
                    : 'border border-hairline bg-paper text-ink-muted hover:bg-surface-hover hover:text-ink',
                ].join(' ')}
              >
                <span>{game.shortName}</span>
                <span className="tabular-nums-mono text-[11.5px] opacity-80">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Bulk Reset Bar with 2-Step Inline Confirmation */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
          <div className="text-[12.5px] text-ink-muted">
            当前视图：
            <span className="font-medium text-ink">
              {currentGameMeta ? currentGameMeta.name : '全部 6 款游戏'}
            </span>
            {' · '}
            <span className="tabular-nums-mono font-medium text-ink">{filteredEntries.length}</span>{' '}
            条纪录
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {confirmScope ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-[14px] border border-hairline bg-paper px-3.5 py-2 text-[12.5px]"
              >
                <span className="text-postmark">
                  {confirmScope === 'all'
                    ? `确认清空全部 6 款游戏的 ${totalCount} 条纪录？此操作不可撤销。`
                    : `确认清空「${currentGameMeta?.name ?? ''}」的 ${currentFilterCount} 条纪录？`}
                </span>
                <button
                  type="button"
                  onClick={() => void handleConfirmReset()}
                  disabled={resetting}
                  className="rounded-full bg-postmark px-3 py-1 text-[12px] font-medium text-cta-text transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {resetting ? '清空中…' : '确认清空'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmScope(null)}
                  disabled={resetting}
                  className="rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            ) : (
              <>
                {filter !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setConfirmScope('current')}
                    disabled={currentFilterCount === 0 || loading}
                    className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[12.5px] text-postmark transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>清空当前游戏榜单</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setConfirmScope('all')}
                  disabled={totalCount === 0 || loading}
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[12.5px] text-postmark transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>清空全部榜单</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Entries Table / Mobile Cards */}
      <div className="rounded-[20px] border border-hairline bg-surface p-4 sm:p-5">
        {loading ? (
          <div className="py-10 text-center text-[13.5px] text-ink-muted">正在加载榜单纪录……</div>
        ) : filteredEntries.length === 0 ? (
          <div className="rounded-[14px] border border-hairline bg-paper px-4 py-10 text-center text-[13.5px] text-ink-muted">
            当前筛选条件下暂无上榜纪录。
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-left text-[13.5px]">
                <thead>
                  <tr className="border-b border-hairline text-[12px] font-medium text-ink-muted">
                    <th className="py-2.5 pr-3 pl-2">名次</th>
                    <th className="px-3 py-2.5">游戏</th>
                    <th className="px-3 py-2.5">玩家代号</th>
                    <th className="px-3 py-2.5 text-right">成绩</th>
                    <th className="px-3 py-2.5">对局详情</th>
                    <th className="px-3 py-2.5">提交时间</th>
                    <th className="px-3 py-2.5">访客前缀</th>
                    <th className="py-2.5 pr-2 pl-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {filteredEntries.map((entry) => {
                    const meta = getArcadeGameMeta(entry.gameId);
                    const rank = rankByEntryId.get(entry.id) ?? 0;
                    const tags = formatArcadeMetaTags(entry.gameId, entry.meta);
                    const isDeleting = deletingId === entry.id;

                    return (
                      <tr
                        key={entry.id}
                        className="transition-colors hover:bg-paper/70"
                      >
                        <td className="tabular-nums-mono py-3 pr-3 pl-2 text-[12.5px] text-ink-muted">
                          #{rank}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className="rounded-full border border-hairline bg-paper px-2.5 py-0.5 text-[12px] text-ink">
                            {meta.shortName}
                          </span>
                        </td>
                        <td className="max-w-[180px] truncate px-3 py-3 font-medium text-ink">
                          {entry.playerName}
                        </td>
                        <td className="tabular-nums-mono px-3 py-3 text-right font-semibold whitespace-nowrap text-ink">
                          {formatScoreWithUnit(entry.gameId, entry.score)}
                        </td>
                        <td className="px-3 py-3 text-[12px] text-ink-muted">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {entry.durationMs > 0 && meta.sortDirection !== 'asc' && (
                              <span className="tabular-nums-mono rounded-full bg-paper px-2 py-0.5">
                                {formatArcadeDuration(entry.durationMs)}
                              </span>
                            )}
                            {tags.length > 0 ? (
                              tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-full bg-paper px-2 py-0.5"
                                >
                                  {tag}
                                </span>
                              ))
                            ) : entry.durationMs <= 0 || meta.sortDirection === 'asc' ? (
                              <span>—</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="tabular-nums-mono px-3 py-3 text-[12px] whitespace-nowrap text-ink-muted">
                          {formatArcadeTimestamp(entry.createdAt)}
                        </td>
                        <td className="tabular-nums-mono px-3 py-3 text-[12px] whitespace-nowrap text-ink-muted">
                          {entry.visitorPrefix || '—'}
                        </td>
                        <td className="py-3 pr-2 pl-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => void handleDeleteEntry(entry)}
                            disabled={isDeleting}
                            aria-label={`删除 ${entry.playerName} 的成绩`}
                            className="inline-flex min-h-[30px] items-center gap-1 rounded-full border border-hairline bg-paper px-3 text-[12px] text-postmark transition-colors hover:bg-surface-hover disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>{isDeleting ? '删除中…' : '删除'}</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Stacked Cards */}
            <div className="space-y-3 md:hidden">
              {filteredEntries.map((entry) => {
                const meta = getArcadeGameMeta(entry.gameId);
                const rank = rankByEntryId.get(entry.id) ?? 0;
                const tags = formatArcadeMetaTags(entry.gameId, entry.meta);
                const isDeleting = deletingId === entry.id;

                return (
                  <article
                    key={entry.id}
                    className="rounded-[14px] border border-hairline bg-paper p-3.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="tabular-nums-mono text-[12px] font-medium text-ink-muted">
                            #{rank}
                          </span>
                          <span className="rounded-full border border-hairline bg-surface px-2 py-0.5 text-[11.5px] text-ink">
                            {meta.shortName}
                          </span>
                          <span className="truncate text-[14px] font-medium text-ink">
                            {entry.playerName}
                          </span>
                        </div>
                        <div className="tabular-nums-mono mt-1 text-[15px] font-semibold text-accent">
                          {formatScoreWithUnit(entry.gameId, entry.score)}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleDeleteEntry(entry)}
                        disabled={isDeleting}
                        aria-label={`删除 ${entry.playerName} 的成绩`}
                        className="inline-flex min-h-[32px] shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface px-3 text-[12px] text-postmark transition-colors hover:bg-surface-hover disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{isDeleting ? '删除中…' : '删除'}</span>
                      </button>
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
                      <span className="tabular-nums-mono">
                        {formatArcadeTimestamp(entry.createdAt)}
                      </span>
                      <span className="tabular-nums-mono">
                        访客 {entry.visitorPrefix || '—'}
                      </span>
                      {tags.map((tag) => (
                        <span key={tag} className="rounded-full bg-surface px-2 py-0.5">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Phase 4: SANDSTORM 3D Tactical Shooter Moderation Section */}
      <div className="space-y-4 pt-2">
        <div className="rounded-[20px] border border-hairline bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="m-0 flex items-center gap-2 text-[18px] font-semibold text-ink">
                <Crosshair className="h-5 w-5 shrink-0 text-postmark" aria-hidden="true" />
                <span>沙暴行动 · SANDSTORM（炽沙小镇 3D 战术射击）</span>
              </h2>
              <p className="mt-1.5 mb-0 text-[13.5px] text-ink-muted">
                实时检视 Cloudflare Durable Objects 64Hz 云端联机房间索引，并管理 D1 对局战报归档（自动保留最新 100 局）。
              </p>
            </div>

            <button
              type="button"
              onClick={() => void loadArenaSnapshot(true)}
              disabled={arenaLoading || arenaRefreshing}
              className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[13px] text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <RefreshCw
                className={[
                  'h-3.5 w-3.5',
                  arenaLoading || arenaRefreshing ? 'animate-spin' : '',
                ].join(' ')}
                aria-hidden="true"
              />
              <span>刷新沙暴状态</span>
            </button>
          </div>

          {/* 4 Summary Telemetry Counters */}
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-[14px] border border-hairline bg-paper px-4 py-3">
              <div className="text-[11.5px] text-ink-muted">活跃联机大厅</div>
              <div className="tabular-nums-mono mt-1 text-[20px] font-semibold text-ink">
                {arenaCounts.activeLobbies}
              </div>
            </div>
            <div className="rounded-[14px] border border-hairline bg-paper px-4 py-3">
              <div className="text-[11.5px] text-ink-muted">公开可见房间</div>
              <div className="tabular-nums-mono mt-1 text-[20px] font-semibold text-ink">
                {arenaCounts.publicLobbies}
              </div>
            </div>
            <div className="rounded-[14px] border border-hairline bg-paper px-4 py-3">
              <div className="text-[11.5px] text-ink-muted">在线真人玩家</div>
              <div className="tabular-nums-mono mt-1 text-[20px] font-semibold text-accent">
                {arenaCounts.activeHumans}
              </div>
            </div>
            <div className="rounded-[14px] border border-hairline bg-paper px-4 py-3">
              <div className="text-[11.5px] text-ink-muted">已归档战报</div>
              <div className="tabular-nums-mono mt-1 text-[20px] font-semibold text-ink">
                {arenaCounts.archivedMatches}
              </div>
            </div>
          </div>

          {arenaNotice && (
            <p
              role="alert"
              className="mt-4 mb-0 rounded-[12px] border border-hairline bg-paper px-3.5 py-2.5 text-[12.5px] text-postmark"
            >
              {arenaNotice}
            </p>
          )}

          {/* Active Lobbies Inspector */}
          <div className="mt-5 border-t border-hairline pt-4">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-ink">
              <Radio className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              <span>当前活跃大厅（{arenaLobbies.length}）</span>
            </div>

            {arenaLoading ? (
              <div className="py-4 text-[13px] text-ink-muted">正在读取活跃房间索引……</div>
            ) : arenaLobbies.length === 0 ? (
              <div className="rounded-[14px] border border-hairline bg-paper px-4 py-4 text-[13px] text-ink-muted">
                当前暂无活跃的沙暴行动联机房间。
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {arenaLobbies.map((lobby) => (
                  <article
                    key={lobby.code}
                    className="rounded-[14px] border border-hairline bg-paper p-3.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="tabular-nums-mono rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[12px] font-medium text-accent">
                        {lobby.code}
                      </span>
                      <div className="flex items-center gap-1.5 text-[11.5px]">
                        <span className="rounded-full bg-surface px-2 py-0.5 text-ink-muted">
                          {lobby.isPublic ? '公开' : '私密'}
                        </span>
                        <span className="rounded-full bg-surface px-2 py-0.5 text-postmark">
                          {formatArenaPhase(lobby.phase)}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2 truncate text-[14px] font-medium text-ink">
                      {lobby.name}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
                      <span>{formatArenaMode(lobby.mode)}</span>
                      <span className="tabular-nums-mono">
                        真人 {lobby.humanCount}/{lobby.maxHumans}
                      </span>
                      <span className="tabular-nums-mono">Bot {lobby.botCount}</span>
                    </div>
                    <div className="tabular-nums-mono mt-2 flex items-center justify-between gap-2 border-t border-hairline pt-2 text-[11.5px] text-ink-muted">
                      <span className="truncate">
                        T {lobby.scoreRed} : {lobby.scoreBlue} CT · 房主 {lobby.hostName}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCloseArenaRoom(lobby)}
                        disabled={arenaClosingCode === lobby.code}
                        aria-label={`强制关闭房间 ${lobby.code}`}
                        className="inline-flex min-h-[26px] shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface px-2.5 text-[11.5px] text-postmark transition-colors hover:bg-surface-hover disabled:opacity-50"
                      >
                        <XCircle className="h-3 w-3" aria-hidden="true" />
                        <span>{arenaClosingCode === lobby.code ? '关闭中…' : '关闭房间'}</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          {/* Arena Bulk Match Archive Reset */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
            <div className="text-[12.5px] text-ink-muted">
              沙暴行动对局归档：
              <span className="tabular-nums-mono font-medium text-ink">{arenaMatches.length}</span>{' '}
              条记录
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {arenaConfirmReset ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center gap-2 rounded-[14px] border border-hairline bg-paper px-3.5 py-2 text-[12.5px]"
                >
                  <span className="text-postmark">
                    确认清空全部 {arenaCounts.archivedMatches} 条沙暴行动战报？此操作不可撤销。
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleConfirmResetArenaMatches()}
                    disabled={arenaResetting}
                    className="rounded-full bg-postmark px-3 py-1 text-[12px] font-medium text-cta-text transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {arenaResetting ? '清空中…' : '确认清空'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setArenaConfirmReset(false)}
                    disabled={arenaResetting}
                    className="rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setArenaConfirmReset(true)}
                  disabled={arenaMatches.length === 0 || arenaLoading}
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[12.5px] text-postmark transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>清空沙暴战报归档</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Archived Arena Matches Table / Mobile Cards */}
        <div className="rounded-[20px] border border-hairline bg-surface p-4 sm:p-5">
          {arenaLoading ? (
            <div className="py-10 text-center text-[13.5px] text-ink-muted">
              正在加载沙暴行动对局战报……
            </div>
          ) : arenaMatches.length === 0 ? (
            <div className="rounded-[14px] border border-hairline bg-paper px-4 py-10 text-center text-[13.5px] text-ink-muted">
              暂无沙暴行动 · SANDSTORM 完局战报记录。
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full border-collapse text-left text-[13.5px]">
                  <thead>
                    <tr className="border-b border-hairline text-[12px] font-medium text-ink-muted">
                      <th className="py-2.5 pr-3 pl-2">来源 / 房号</th>
                      <th className="px-3 py-2.5">模式</th>
                      <th className="px-3 py-2.5">比分与胜方</th>
                      <th className="px-3 py-2.5">本场 MVP</th>
                      <th className="px-3 py-2.5">参战 / 耗时</th>
                      <th className="px-3 py-2.5">归档时间</th>
                      <th className="px-3 py-2.5">访客前缀</th>
                      <th className="py-2.5 pr-2 pl-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {arenaMatches.map((match) => {
                      const isDeleting = arenaDeletingId === match.id;
                      return (
                        <tr key={match.id} className="transition-colors hover:bg-paper/70">
                          <td className="py-3 pr-3 pl-2 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <span className="rounded-full border border-hairline bg-paper px-2 py-0.5 text-[11.5px] text-ink">
                                {match.source === 'online' ? '联机' : '单人 AI'}
                              </span>
                              <span className="tabular-nums-mono text-[12.5px] font-medium text-ink">
                                {match.roomCode}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-[12.5px] text-ink-muted">
                            {formatArenaMode(match.mode)}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <span className="tabular-nums-mono font-semibold text-ink">
                              T {match.scoreRed} : {match.scoreBlue} CT
                            </span>
                            <span className="ml-2 text-[12px] text-postmark">
                              {formatArenaWinner(match.winnerTeam)}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="font-medium text-ink">{match.mvpName}</div>
                            <div className="tabular-nums-mono text-[11.5px] text-ink-muted">
                              {match.mvpKills} 杀 / {match.mvpDeaths} 死 · 爆头 {match.mvpHeadshots}
                            </div>
                          </td>
                          <td className="tabular-nums-mono px-3 py-3 text-[12px] whitespace-nowrap text-ink-muted">
                            <div>
                              {match.playerCount} 真人 · {match.botCount} Bot
                            </div>
                            <div>{formatArcadeDuration(match.durationMs)}</div>
                          </td>
                          <td className="tabular-nums-mono px-3 py-3 text-[12px] whitespace-nowrap text-ink-muted">
                            {formatArcadeTimestamp(match.createdAt)}
                          </td>
                          <td className="tabular-nums-mono px-3 py-3 text-[12px] whitespace-nowrap text-ink-muted">
                            {match.visitorPrefix || '—'}
                          </td>
                          <td className="py-3 pr-2 pl-3 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => void handleDeleteArenaMatch(match)}
                              disabled={isDeleting}
                              aria-label={`删除房号 ${match.roomCode} 的沙暴行动战报`}
                              className="inline-flex min-h-[30px] items-center gap-1 rounded-full border border-hairline bg-paper px-3 text-[12px] text-postmark transition-colors hover:bg-surface-hover disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>{isDeleting ? '删除中…' : '删除'}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Stacked Cards */}
              <div className="space-y-3 md:hidden">
                {arenaMatches.map((match) => {
                  const isDeleting = arenaDeletingId === match.id;
                  return (
                    <article
                      key={match.id}
                      className="rounded-[14px] border border-hairline bg-paper p-3.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-full border border-hairline bg-surface px-2 py-0.5 text-[11.5px] text-ink">
                              {match.source === 'online' ? '联机' : '单人 AI'}
                            </span>
                            <span className="tabular-nums-mono text-[12.5px] font-medium text-accent">
                              {match.roomCode}
                            </span>
                            <span className="text-[12px] text-ink-muted">
                              {formatArenaMode(match.mode)}
                            </span>
                          </div>
                          <div className="tabular-nums-mono mt-1.5 text-[15px] font-semibold text-ink">
                            T {match.scoreRed} : {match.scoreBlue} CT ·{' '}
                            <span className="text-[12.5px] font-medium text-postmark">
                              {formatArenaWinner(match.winnerTeam)}
                            </span>
                          </div>
                          <div className="tabular-nums-mono mt-1 text-[12px] text-ink-muted">
                            MVP {match.mvpName}（{match.mvpKills}/{match.mvpDeaths} · 爆头{' '}
                            {match.mvpHeadshots}）
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => void handleDeleteArenaMatch(match)}
                          disabled={isDeleting}
                          aria-label={`删除房号 ${match.roomCode} 的沙暴行动战报`}
                          className="inline-flex min-h-[32px] shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface px-3 text-[12px] text-postmark transition-colors hover:bg-surface-hover disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{isDeleting ? '删除中…' : '删除'}</span>
                        </button>
                      </div>

                      <div className="tabular-nums-mono mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-muted">
                        <span>{formatArcadeTimestamp(match.createdAt)}</span>
                        <span>
                          {match.playerCount} 真人 · {match.botCount} Bot
                        </span>
                        <span>{formatArcadeDuration(match.durationMs)}</span>
                        <span>访客 {match.visitorPrefix || '—'}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
