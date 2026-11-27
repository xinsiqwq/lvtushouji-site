import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Award, CheckCircle2, RefreshCw, Send, Trophy } from 'lucide-react';
import type { ArcadeScoreEntry, ArcadeSubmitResponse } from '../../../shared/types';
import {
  formatArcadeDuration,
  formatArcadeScore,
  getArcadeGameMeta,
  type ArcadeGameId,
  type ArcadeRunResult,
} from './arcade-catalog';
import {
  fetchArcadeLeaderboard,
  formatArcadeMetaTags,
  formatArcadeTimestamp,
  readSavedCallsign,
  sanitizeCallsign,
  saveCallsign,
  submitArcadeScore,
} from './arcade-store';

export type ScoreBoardPanelProps = {
  gameId: ArcadeGameId;
  localBest: number | null;
  pendingRun: ArcadeRunResult | null;
  isNewLocalBest: boolean;
  onScoreSubmitted?: () => void;
};

function formatScoreWithUnit(gameId: ArcadeGameId, score: number): string {
  const formatted = formatArcadeScore(gameId, score);
  const meta = getArcadeGameMeta(gameId);
  return meta.sortDirection === 'asc' ? formatted : `${formatted} ${meta.scoreUnit}`;
}

type PodiumVisuals = {
  rowClass: string;
  rowStyle?: CSSProperties;
  badgeClass: string;
  badgeStyle?: CSSProperties;
  scoreClass: string;
};

function getPodiumVisuals(rank: number, isHighlighted: boolean): PodiumVisuals {
  const highlightRing = isHighlighted
    ? 'ring-1 ring-accent/55 border-accent/60'
    : '';

  if (rank === 1) {
    return {
      rowClass: [
        'border transition-[transform,background-color,border-color,box-shadow] duration-200 ease-out hover:-translate-y-[1px]',
        highlightRing,
      ].join(' '),
      rowStyle: {
        borderColor: isHighlighted
          ? undefined
          : 'light-dark(rgba(181, 134, 48, 0.42), rgba(226, 189, 106, 0.38))',
        backgroundColor:
          'light-dark(color-mix(in srgb, #c89b3c 7%, var(--color-paper)), color-mix(in srgb, #e2bd6a 7%, var(--color-paper)))',
        boxShadow:
          'inset 0 1px 0 light-dark(rgba(255, 246, 220, 0.85), rgba(242, 211, 138, 0.16))',
      },
      badgeClass:
        'tabular-nums-mono inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border text-[11.5px] font-semibold',
      badgeStyle: {
        borderColor: 'light-dark(rgba(181, 134, 48, 0.48), rgba(226, 189, 106, 0.45))',
        backgroundColor:
          'light-dark(rgba(200, 155, 60, 0.15), rgba(226, 189, 106, 0.15))',
        color: 'light-dark(#7c5712, #eccb7f)',
        boxShadow:
          'inset 0 1px 0 light-dark(rgba(255, 250, 232, 0.9), rgba(247, 224, 165, 0.22))',
      },
      scoreClass: 'tabular-nums-mono shrink-0 text-right text-[14px] font-semibold text-ink',
    };
  }

  if (rank === 2) {
    return {
      rowClass: [
        'border transition-[transform,background-color,border-color,box-shadow] duration-200 ease-out hover:-translate-y-[1px]',
        highlightRing,
      ].join(' '),
      rowStyle: {
        borderColor: isHighlighted
          ? undefined
          : 'light-dark(rgba(110, 124, 144, 0.34), rgba(182, 194, 210, 0.3))',
        backgroundColor:
          'light-dark(color-mix(in srgb, #7c8da3 6%, var(--color-paper)), color-mix(in srgb, #b8c4d4 6%, var(--color-paper)))',
        boxShadow:
          'inset 0 1px 0 light-dark(rgba(255, 255, 255, 0.85), rgba(226, 234, 244, 0.14))',
      },
      badgeClass:
        'tabular-nums-mono inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border text-[11.5px] font-semibold',
      badgeStyle: {
        borderColor: 'light-dark(rgba(110, 124, 144, 0.4), rgba(182, 194, 210, 0.38))',
        backgroundColor:
          'light-dark(rgba(124, 141, 163, 0.14), rgba(184, 196, 212, 0.14))',
        color: 'light-dark(#455160, #d4dce7)',
        boxShadow:
          'inset 0 1px 0 light-dark(rgba(255, 255, 255, 0.8), rgba(235, 241, 248, 0.18))',
      },
      scoreClass: 'tabular-nums-mono shrink-0 text-right text-[13.5px] font-semibold text-ink',
    };
  }

  if (rank === 3) {
    return {
      rowClass: [
        'border transition-[transform,background-color,border-color,box-shadow] duration-200 ease-out hover:-translate-y-[1px]',
        highlightRing,
      ].join(' '),
      rowStyle: {
        borderColor: isHighlighted
          ? undefined
          : 'color-mix(in srgb, var(--color-postmark) 38%, transparent)',
        backgroundColor: 'color-mix(in srgb, var(--color-postmark) 7%, var(--color-paper))',
        boxShadow:
          'inset 0 1px 0 light-dark(rgba(255, 244, 238, 0.78), rgba(214, 159, 135, 0.14))',
      },
      badgeClass:
        'tabular-nums-mono inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border text-[11.5px] font-semibold text-postmark',
      badgeStyle: {
        borderColor: 'color-mix(in srgb, var(--color-postmark) 44%, transparent)',
        backgroundColor: 'color-mix(in srgb, var(--color-postmark) 14%, transparent)',
      },
      scoreClass: 'tabular-nums-mono shrink-0 text-right text-[13.5px] font-semibold text-ink',
    };
  }

  return {
    rowClass: [
      'border transition-[transform,background-color,border-color] duration-200 ease-out hover:-translate-y-[0.5px] hover:bg-surface-hover/55',
      isHighlighted
        ? 'ring-1 ring-accent/55 border-accent/60 bg-paper'
        : 'border-hairline bg-paper/80 hover:border-hairline-strong',
    ].join(' '),
    badgeClass:
      'tabular-nums-mono inline-flex h-6.5 w-7 shrink-0 items-center justify-center rounded-[8px] border border-hairline bg-surface text-[11px] font-medium text-ink-muted',
    scoreClass: 'tabular-nums-mono shrink-0 text-right text-[13px] font-semibold text-ink',
  };
}

export function ScoreBoardPanel({
  gameId,
  localBest,
  pendingRun,
  isNewLocalBest,
  onScoreSubmitted,
}: ScoreBoardPanelProps) {
  const gameMeta = getArcadeGameMeta(gameId);

  const [entries, setEntries] = useState<ArcadeScoreEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [callsign, setCallsign] = useState<string>(() => readSavedCallsign());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submittedRun, setSubmittedRun] = useState<ArcadeRunResult | null>(null);
  const [submitOutcome, setSubmitOutcome] = useState<ArcadeSubmitResponse | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const loadLeaderboard = useCallback(
    async (silent = false) => {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setLoadError('');
      try {
        const list = await fetchArcadeLeaderboard(gameId);
        setEntries(list);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '全站榜单加载失败，请稍后重试。');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [gameId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setSubmitError('');
    setSubmittedRun(null);
    setSubmitOutcome(null);
    setHighlightedId(null);

    fetchArcadeLeaderboard(gameId)
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : '全站榜单加载失败，请稍后重试。');
          setEntries([]);
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
  }, [gameId]);

  useEffect(() => {
    if (pendingRun && pendingRun !== submittedRun) {
      setSubmitError('');
      setSubmitOutcome(null);
    }
  }, [pendingRun, submittedRun]);

  const isRunEligible =
    pendingRun !== null && Number.isFinite(pendingRun.score) && pendingRun.score > 0;
  const isCurrentRunSubmitted = pendingRun !== null && submittedRun === pendingRun;
  const pendingMetaTags = pendingRun ? formatArcadeMetaTags(gameId, pendingRun.meta) : [];

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pendingRun || !isRunEligible || isCurrentRunSubmitted || submitting) return;

    const cleanedName = sanitizeCallsign(callsign);
    if (!cleanedName) {
      setSubmitError('请输入 1–16 字的玩家代号。');
      return;
    }

    setSubmitting(true);
    setSubmitError('');
    try {
      saveCallsign(cleanedName);
      setCallsign(cleanedName);

      const response = await submitArcadeScore({
        gameId,
        playerName: cleanedName,
        score: Math.round(pendingRun.score),
        durationMs: Math.max(0, Math.round(pendingRun.durationMs)),
        meta: pendingRun.meta,
      });

      setSubmittedRun(pendingRun);
      setSubmitOutcome(response);
      setHighlightedId(response.entry.id);
      if (Array.isArray(response.leaderboard)) {
        setEntries(response.leaderboard);
      } else {
        void loadLeaderboard(true);
      }
      onScoreSubmitted?.();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '提交成绩失败，请稍后再试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside aria-label="成绩与全站英雄榜" className="space-y-4">
      {/* Personal Best Card */}
      <section className="relative overflow-hidden rounded-[20px] border border-hairline bg-surface">
        <div
          aria-hidden="true"
          className="h-[2px] w-full"
          style={{
            background:
              isNewLocalBest && localBest !== null
                ? 'linear-gradient(90deg, #c99a3e 0%, var(--color-postmark) 58%, transparent 100%)'
                : 'linear-gradient(90deg, color-mix(in srgb, var(--color-postmark) 48%, transparent) 0%, transparent 72%)',
          }}
        />
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink-muted">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border border-hairline bg-paper">
                  <Award className="h-3.5 w-3.5 text-postmark" aria-hidden="true" />
                </span>
                <span>本地个人最佳</span>
              </div>
              <div className="tabular-nums-mono mt-2.5 text-[28px] leading-tight font-semibold tracking-tight text-ink">
                {localBest !== null ? formatScoreWithUnit(gameId, localBest) : '暂无纪录'}
              </div>
            </div>

            {isNewLocalBest && localBest !== null && (
              <span
                className="shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] font-medium text-postmark"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-postmark) 42%, transparent)',
                  backgroundColor: 'color-mix(in srgb, var(--color-postmark) 10%, var(--color-paper))',
                }}
              >
                刷新最佳
              </span>
            )}
          </div>

          <p className="mt-2.5 mb-0 text-[12.5px] leading-relaxed text-ink-muted">
            {gameMeta.sortDirection === 'asc'
              ? '保存在当前浏览器本地；极简扫雷按通关用时升序排名，用时越短名次越靠前。'
              : `保存在当前浏览器本地；${gameMeta.shortName}按单局分值降序排名。`}
          </p>
        </div>
      </section>

      {/* Pending Run Submit Form OR Post-Submit Rank Confirmation */}
      {isRunEligible && pendingRun && !isCurrentRunSubmitted ? (
        <section className="relative overflow-hidden rounded-[20px] border border-hairline bg-paper">
          <div
            aria-hidden="true"
            className="h-[2.5px] w-full"
            style={{
              background: isNewLocalBest
                ? 'linear-gradient(90deg, #c99a3e 0%, var(--color-postmark) 52%, var(--color-accent) 100%)'
                : 'linear-gradient(90deg, var(--color-accent) 0%, color-mix(in srgb, var(--color-accent) 28%, transparent) 78%, transparent 100%)',
            }}
          />
          <div className="p-5">
            <div className="rounded-[14px] border border-hairline bg-surface/80 px-3.5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-medium text-ink">本局结算成绩</span>
                  {isNewLocalBest && (
                    <span className="rounded-full bg-paper px-2 py-0.5 text-[11px] font-medium text-postmark">
                      新个人纪录
                    </span>
                  )}
                </div>
                <span className="tabular-nums-mono text-[20px] font-semibold tracking-tight text-accent">
                  {formatScoreWithUnit(gameId, pendingRun.score)}
                </span>
              </div>

              {(pendingMetaTags.length > 0 ||
                (pendingRun.durationMs > 0 && gameMeta.sortDirection !== 'asc')) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-muted">
                  {pendingRun.durationMs > 0 && gameMeta.sortDirection !== 'asc' && (
                    <span className="tabular-nums-mono rounded-full border border-hairline bg-paper px-2.5 py-0.5">
                      耗时 {formatArcadeDuration(pendingRun.durationMs)}
                    </span>
                  )}
                  {pendingMetaTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-hairline bg-paper px-2.5 py-0.5"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-3">
              <label className="block text-[12.5px] text-ink-muted">
                玩家代号（1–16 字）
                <input
                  type="text"
                  value={callsign}
                  onChange={(e) => {
                    setCallsign(e.target.value.slice(0, 16));
                    if (submitError) setSubmitError('');
                  }}
                  maxLength={16}
                  autoComplete="nickname"
                  placeholder="输入你的代号，例如 旅人零七"
                  disabled={submitting}
                  className="mt-1.5 block w-full rounded-[12px] border border-hairline bg-surface px-3.5 py-2.5 text-[14px] text-ink transition-[border-color,box-shadow] placeholder:text-ink-muted/70 focus:border-accent focus:ring-2 focus:ring-accent/15 focus:outline-none disabled:opacity-60"
                />
              </label>

              <button
                type="submit"
                disabled={submitting}
                className="pill-cta-primary inline-flex w-full items-center justify-center gap-2 transition-[transform,opacity] duration-150 hover:-translate-y-[0.5px] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{submitting ? '正在提交榜单…' : '登上全站英雄榜'}</span>
              </button>

              {submitError && (
                <p role="alert" className="mb-0 text-[12.5px] text-postmark">
                  {submitError}
                </p>
              )}
            </form>
          </div>
        </section>
      ) : submitOutcome ? (
        <section
          role="status"
          className="relative overflow-hidden rounded-[20px] border border-hairline bg-paper"
        >
          <div
            aria-hidden="true"
            className="h-[2.5px] w-full"
            style={{
              background: submitOutcome.madeTop10
                ? 'linear-gradient(90deg, var(--color-accent) 0%, #c99a3e 65%, transparent 100%)'
                : 'linear-gradient(90deg, var(--color-accent) 0%, transparent 88%)',
            }}
          />
          <div className="flex items-start gap-3 p-4 text-[13px] text-ink">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-hairline bg-surface">
              <CheckCircle2 className="h-4 w-4 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0 leading-relaxed">
              <div className="flex flex-wrap items-center gap-2 font-medium">
                <span>
                  {submitOutcome.madeTop10
                    ? `已登上全站英雄榜 · 第 ${submitOutcome.rank} 名`
                    : `成绩已入库 · 当前全站第 ${submitOutcome.rank} 名`}
                </span>
              </div>
              <div className="mt-0.5 text-[12px] text-ink-muted">
                代号「{submitOutcome.entry.playerName}」成绩{' '}
                <span className="tabular-nums-mono font-medium text-ink">
                  {formatScoreWithUnit(gameId, submitOutcome.entry.score)}
                </span>{' '}
                已提交，再来一局即可继续刷新。
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* Global Top 10 Leaderboard */}
      <section className="rounded-[20px] border border-hairline bg-surface p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold text-ink">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border border-hairline bg-paper">
                <Trophy className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              </span>
              <span className="truncate">全站前十英雄榜</span>
            </h2>
            <p className="mt-1 mb-0 text-[12px] text-ink-muted">
              {gameMeta.name} · {gameMeta.sortDirection === 'asc' ? '最短用时优先' : '最高分值优先'}
            </p>
          </div>

          <button
            type="button"
            onClick={() => void loadLeaderboard(true)}
            disabled={loading || refreshing}
            aria-label="刷新全站榜单"
            className="inline-flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-[12px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-50"
          >
            <RefreshCw
              className={['h-3.5 w-3.5', loading || refreshing ? 'animate-spin' : ''].join(' ')}
              aria-hidden="true"
            />
            <span>刷新</span>
          </button>
        </div>

        <div className="mt-4">
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2, 3].map((idx) => (
                <div
                  key={idx}
                  className="h-12 rounded-[14px] border border-hairline bg-paper/70"
                />
              ))}
            </div>
          ) : loadError ? (
            <div className="rounded-[14px] border border-hairline bg-paper px-4 py-4 text-[13px] text-postmark">
              <p className="m-0">{loadError}</p>
              <button
                type="button"
                onClick={() => void loadLeaderboard(false)}
                className="mt-2.5 rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink transition-colors hover:bg-surface-hover"
              >
                重新加载
              </button>
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-[14px] border border-hairline bg-paper px-4 py-7 text-center text-[13px] text-ink-muted">
              暂无上榜纪录，成为第一位登榜玩家
            </div>
          ) : (
            <ol className="m-0 list-none space-y-2 p-0">
              {entries.slice(0, 10).map((entry, index) => {
                const rank = index + 1;
                const metaTags = formatArcadeMetaTags(gameId, entry.meta);
                const isHighlighted = highlightedId === entry.id;
                const visuals = getPodiumVisuals(rank, isHighlighted);

                return (
                  <li
                    key={entry.id}
                    style={visuals.rowStyle}
                    className={[
                      'flex items-center justify-between gap-3 rounded-[14px] px-3 py-2.5',
                      visuals.rowClass,
                    ].join(' ')}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        style={visuals.badgeStyle}
                        className={visuals.badgeClass}
                        aria-label={`第 ${rank} 名`}
                      >
                        {rank <= 3 ? `#${rank}` : rank}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-medium text-ink">
                            {entry.playerName}
                          </span>
                          {isHighlighted && (
                            <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                              新上榜
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-muted">
                          <span className="tabular-nums-mono">
                            {formatArcadeTimestamp(entry.createdAt, true)}
                          </span>
                          {metaTags.length > 0 && (
                            <span className="truncate">{metaTags.join(' · ')}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className={visuals.scoreClass}>
                      {formatScoreWithUnit(gameId, entry.score)}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </aside>
  );
}

export default ScoreBoardPanel;
