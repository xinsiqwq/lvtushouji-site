import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type FormEvent,
  type LazyExoticComponent,
  type MouseEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Award,
  Blocks,
  ChevronDown,
  Crosshair,
  Disc,
  Flag,
  Flame,
  Gamepad2,
  Grid2x2,
  Keyboard,
  Layers,
  Orbit,
  Radio,
  RefreshCw,
  Shield,
  Swords,
  Target,
  Trophy,
  Volume2,
  VolumeX,
  Waypoints,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type {
  ArenaGameMode,
  ArenaLobbySummary,
  ArenaMapId,
  ArenaMatchRecord,
  ArenaMatchesResponse,
  ArenaRoomsListResponse,
} from '../../../shared/types';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { useRouter } from '../../lib/router';
import {
  ARCADE_GAMES,
  formatArcadeDuration,
  formatArcadeScore,
  getArcadeGameMeta,
  isArcadeGameId,
  type ArcadeGameId,
  type ArcadeGameProps,
  type ArcadeRunResult,
} from './arcade-catalog';
import { getArcadeMuted, setArcadeMuted } from './arcade-sfx';
import {
  formatArcadeTimestamp,
  readLocalBests,
  recordLocalBest,
  type ArcadeLocalBests,
} from './arcade-store';
import { ScoreBoardPanel } from './ScoreBoardPanel';

const DinoRunnerGame = lazy(() => import('./games/DinoRunnerGame'));
const StarSnakeGame = lazy(() => import('./games/StarSnakeGame'));
const GravityTetrisGame = lazy(() => import('./games/GravityTetrisGame'));
const Cosmos2048Game = lazy(() => import('./games/Cosmos2048Game'));
const MinimalMinesweeperGame = lazy(() => import('./games/MinimalMinesweeperGame'));
const OrbitBreakoutGame = lazy(() => import('./games/OrbitBreakoutGame'));

const GAME_COMPONENTS: Record<ArcadeGameId, LazyExoticComponent<ComponentType<ArcadeGameProps>>> = {
  dino: DinoRunnerGame,
  snake: StarSnakeGame,
  tetris: GravityTetrisGame,
  '2048': Cosmos2048Game,
  minesweeper: MinimalMinesweeperGame,
  breakout: OrbitBreakoutGame,
};

const GAME_ICONS: Record<ArcadeGameId, LucideIcon> = {
  dino: Zap,
  snake: Waypoints,
  tetris: Blocks,
  '2048': Grid2x2,
  minesweeper: Flag,
  breakout: Disc,
};

type GameAccentSpec = {
  color: string;
  motif: string;
};

const GAME_ACCENTS: Record<ArcadeGameId, GameAccentSpec> = {
  dino: { color: '#c96a48', motif: '火星地平线' },
  snake: { color: '#4f8ce8', motif: '深空星轨' },
  tetris: { color: '#4b9aa8', motif: '黑曜重力井' },
  '2048': { color: '#c6934b', motif: '天体演化' },
  minesweeper: { color: '#a6634b', motif: '精密雷区' },
  breakout: { color: '#5c7ce0', motif: '光学棱镜' },
};

function formatArenaModeLabel(mode: ArenaGameMode): string {
  switch (mode) {
    case 'deathmatch':
      return '团队死斗';
    case 'armsrace':
      return '军备竞赛';
    case 'retake':
      return '残局回防';
    default:
      return '5v5 爆破竞技';
  }
}

function formatArenaMapLabel(mapId: ArenaMapId | undefined): string {
  switch (mapId) {
    case 'frost':
      return '极地科研站';
    case 'harbor':
      return '黄昏货运港';
    case 'mars':
      return '赤岩前哨';
    default:
      return '炽沙小镇';
  }
}

function formatArenaWinnerLabel(winner: ArenaMatchRecord['winnerTeam']): string {
  if (winner === 'red') return 'T 方胜';
  if (winner === 'blue') return 'CT 方胜';
  return '平局';
}

function isArenaLobbyLive(phase: ArenaLobbySummary['phase']): boolean {
  return phase === 'live' || phase === 'freeze' || phase === 'round_over';
}

function resolveActiveGame(search: string): ArcadeGameId {
  const params = new URLSearchParams(search);
  const raw = (params.get('game') || '').trim().toLowerCase();
  return isArcadeGameId(raw) ? raw : 'dino';
}

function GameLoadingSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={`正在载入${label}`}
      className="flex min-h-[380px] flex-col items-center justify-center rounded-[18px] border border-hairline bg-paper/60 p-8 text-center"
    >
      <Gamepad2 className="h-6 w-6 text-ink-muted" aria-hidden="true" />
      <p className="mt-3 mb-0 text-[14px] text-ink-muted">正在预热「{label}」机台……</p>
    </div>
  );
}

export default function ArcadePage() {
  const { search, navigate } = useRouter();
  const activeGameId = useMemo(() => resolveActiveGame(search), [search]);
  const activeMeta = useMemo(() => getArcadeGameMeta(activeGameId), [activeGameId]);
  const activeAccent = GAME_ACCENTS[activeGameId];
  const ActiveIcon = GAME_ICONS[activeGameId];
  const ActiveGame = GAME_COMPONENTS[activeGameId];

  const [muted, setMuted] = useState<boolean>(() => getArcadeMuted());
  const [localBests, setLocalBests] = useState<ArcadeLocalBests>(() => readLocalBests());
  const [pendingRun, setPendingRun] = useState<ArcadeRunResult | null>(null);
  const [isNewLocalBest, setIsNewLocalBest] = useState(false);

  // Quietly probe active public 3D Sandstorm rooms & recent matches for the Phase 4 flagship launch card
  const [arenaPublicCount, setArenaPublicCount] = useState<number | null>(null);
  const [arenaPublicRooms, setArenaPublicRooms] = useState<ArenaLobbySummary[]>([]);
  const [arenaMatches, setArenaMatches] = useState<ArenaMatchRecord[]>([]);
  const [arenaMatchesLoading, setArenaMatchesLoading] = useState(true);
  const [arenaRefreshing, setArenaRefreshing] = useState(false);
  const [arenaMatchesExpanded, setArenaMatchesExpanded] = useState(false);
  const [expandedMatchIds, setExpandedMatchIds] = useState<Record<string, boolean>>({});
  const [arenaRoomInput, setArenaRoomInput] = useState('');
  const [arenaRoomError, setArenaRoomError] = useState('');

  const toggleMatchScoreboard = (matchId: string) => {
    setExpandedMatchIds((prev) => ({
      ...prev,
      [matchId]: !prev[matchId],
    }));
  };

  const loadArenaTelemetry = useCallback(async (silent = false) => {
    if (silent) {
      setArenaRefreshing(true);
    } else {
      setArenaMatchesLoading(true);
    }
    try {
      const [roomsRes, matchesRes] = await Promise.allSettled([
        fetch('/api/arena/rooms', { cache: 'no-store', credentials: 'same-origin' }),
        fetch('/api/arena/matches?limit=8', { cache: 'no-store', credentials: 'same-origin' }),
      ]);

      if (roomsRes.status === 'fulfilled' && roomsRes.value.ok) {
        const data = (await roomsRes.value.json().catch(() => null)) as ArenaRoomsListResponse | null;
        if (data) {
          const rooms = Array.isArray(data.rooms) ? data.rooms : [];
          setArenaPublicRooms(rooms.slice(0, 3));
          setArenaPublicCount(
            typeof data.totalPublic === 'number' && Number.isFinite(data.totalPublic)
              ? data.totalPublic
              : rooms.length,
          );
        }
      }

      if (matchesRes.status === 'fulfilled' && matchesRes.value.ok) {
        const data = (await matchesRes.value.json().catch(() => null)) as ArenaMatchesResponse | null;
        if (data && Array.isArray(data.matches)) {
          setArenaMatches(data.matches);
        }
      }
    } catch {
      // Silent fallback when offline or before server restart
    } finally {
      setArenaMatchesLoading(false);
      setArenaRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadArenaTelemetry(false);
  }, [loadArenaTelemetry]);

  const handleJoinArenaRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = arenaRoomInput.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (cleaned.length !== 6) {
      setArenaRoomError('请输入 6 位字母或数字房间码');
      return;
    }
    setArenaRoomError('');
    navigate(`/arcade/arena?room=${encodeURIComponent(cleaned)}`);
  };

  // Clear pending run banner when switching games
  useEffect(() => {
    setPendingRun(null);
    setIsNewLocalBest(false);
  }, [activeGameId]);

  const handleToggleMuted = () => {
    setMuted((prev) => {
      const next = !prev;
      setArcadeMuted(next);
      return next;
    });
  };

  const handleSelectGame = (nextId: ArcadeGameId) => {
    if (nextId === activeGameId) return;
    const params = new URLSearchParams(search);
    params.set('game', nextId);
    navigate(`/arcade?${params.toString()}`, { replace: true });
  };

  const handleRunFinished = useCallback(
    (result: ArcadeRunResult) => {
      if (!Number.isFinite(result.score) || result.score <= 0) {
        return;
      }
      const recorded = recordLocalBest(activeGameId, result.score);
      setLocalBests((prev) => ({
        ...prev,
        [activeGameId]: recorded.best,
      }));
      setPendingRun(result);
      setIsNewLocalBest(recorded.isNewBest);
    },
    [activeGameId],
  );

  const handleScoreSubmitted = useCallback(() => {
    setPendingRun(null);
    setIsNewLocalBest(false);
  }, []);

  const handleSpaLink = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  const rawBest = localBests[activeGameId];
  const currentBest = typeof rawBest === 'number' && Number.isFinite(rawBest) ? rawBest : null;

  return (
    <div className="relative min-h-[calc(100dvh_-_var(--nav-height))] overflow-x-clip">
      <CelestialFieldBackdrop variant="subtle-header" />

      <div className="relative z-10 mx-auto max-w-[1320px] px-4 py-7 sm:px-6 sm:py-10">
        {/* Mars Masthead */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="tabular-nums-mono text-[12px] tracking-[0.08em] text-ink-muted">
              火星轨道 · Mars · 1.52 AU
            </div>
            <h1 tabIndex={-1} className="display-h1 mt-2 text-[30px] text-ink sm:text-[40px]">
              游乐竞技场
            </h1>
            <p className="font-editorial-serif mt-2.5 mb-0 max-w-[680px] text-[15px] leading-relaxed text-ink-muted">
              六款纯本地高帧率独立街机，支持键盘与触屏操控；刷新个人纪录后可一键登临全站双轨英雄榜。
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleToggleMuted}
              aria-pressed={muted}
              aria-label={muted ? '开启街机音效' : '静音街机音效'}
              className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 rounded-full border border-hairline bg-surface px-4 text-[13px] font-medium text-ink transition-colors hover:border-hairline-strong hover:bg-surface-hover"
            >
              {muted ? (
                <VolumeX className="h-4 w-4 text-ink-muted" aria-hidden="true" />
              ) : (
                <Volume2 className="h-4 w-4 text-accent" aria-hidden="true" />
              )}
              <span>{muted ? '音效已静音' : '合成音效开'}</span>
            </button>
          </div>
        </header>

        {/* Precision 6-Game Selector Strip */}
        <nav
          aria-label="街机游戏选择"
          className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        >
          {ARCADE_GAMES.map((game) => {
            const Icon = GAME_ICONS[game.id];
            const accent = GAME_ACCENTS[game.id];
            const active = game.id === activeGameId;
            const gameBest = localBests[game.id];
            const hasBest = typeof gameBest === 'number' && Number.isFinite(gameBest) && gameBest > 0;

            const cardStyle: CSSProperties | undefined = active
              ? {
                  borderColor: `color-mix(in srgb, ${accent.color} 44%, var(--color-hairline-strong))`,
                }
              : undefined;

            const plinthStyle: CSSProperties = {
              backgroundColor: `color-mix(in srgb, ${accent.color} ${active ? '16%' : '9%'}, transparent)`,
              borderColor: `color-mix(in srgb, ${accent.color} ${active ? '34%' : '18%'}, transparent)`,
              color: accent.color,
            };

            return (
              <button
                key={game.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => handleSelectGame(game.id)}
                style={cardStyle}
                className={[
                  'group relative flex min-w-0 cursor-pointer flex-col justify-between overflow-hidden rounded-[20px] border px-3.5 pt-4 pb-3.5 text-left transition-[transform,border-color,background-color,box-shadow] duration-200 ease-out',
                  active
                    ? '-translate-y-0.5 bg-paper text-ink shadow-sm'
                    : 'border-hairline bg-surface text-ink-muted hover:-translate-y-px hover:border-hairline-strong hover:bg-surface-hover hover:text-ink',
                ].join(' ')}
              >
                {/* Top Calibrated Hue Trim */}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-x-0 top-0 h-[2.5px] transition-opacity duration-200 ${
                    active ? 'opacity-100' : 'opacity-45 group-hover:opacity-90'
                  }`}
                  style={{
                    background: active
                      ? `linear-gradient(90deg, ${accent.color} 0%, color-mix(in srgb, ${accent.color} 48%, transparent) 100%)`
                      : `color-mix(in srgb, ${accent.color} 68%, transparent)`,
                  }}
                />

                {/* Icon Plinth + Status / Category */}
                <div className="flex items-center justify-between gap-2">
                  <span
                    aria-hidden="true"
                    style={plinthStyle}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border transition-transform duration-200 group-hover:scale-[1.03]"
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>

                  {active ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-surface/90 px-2 py-0.5 text-[10.5px] font-medium text-ink">
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: accent.color }}
                      />
                      <span>运行中</span>
                    </span>
                  ) : (
                    <span className="truncate text-[11px] text-ink-muted">{game.category}</span>
                  )}
                </div>

                {/* Title & Motif */}
                <div className="mt-3 min-w-0">
                  <div className="truncate text-[14px] font-medium text-ink">{game.shortName}</div>
                  <div className="mt-0.5 truncate text-[11px] text-ink-muted">{accent.motif}</div>
                </div>

                {/* Personal Best Tabular Pill */}
                <div
                  className={[
                    'tabular-nums-mono mt-2.5 flex items-center justify-between gap-1.5 rounded-[10px] border px-2.5 py-1 text-[11.5px]',
                    active
                      ? 'border-hairline bg-surface/85 text-ink'
                      : 'border-hairline/80 bg-page/65 text-ink-muted',
                  ].join(' ')}
                >
                  <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-muted">
                    <Trophy className="h-3 w-3 shrink-0 opacity-75" aria-hidden="true" />
                    <span>{hasBest ? '最佳' : '纪录'}</span>
                  </span>
                  <span className={`truncate font-medium ${hasBest ? 'text-ink' : 'text-ink-muted'}`}>
                    {hasBest ? formatArcadeScore(game.id, gameBest) : '待首局'}
                  </span>
                </div>
              </button>
            );
          })}
        </nav>

        {/* Main 12-Column Instrument Cabinet & Dual-Track Leaderboard Grid */}
        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start">
          {/* Left / Main Precision Arcade Cabinet (8 cols on desktop) */}
          <section
            aria-label={activeMeta.name}
            className="min-w-0 overflow-hidden rounded-[26px] border border-hairline-strong bg-surface shadow-sm lg:col-span-8"
          >
            {/* Top Instrument Accent Trim */}
            <div
              aria-hidden="true"
              className="h-[3px] w-full"
              style={{
                background: `linear-gradient(90deg, ${activeAccent.color} 0%, color-mix(in srgb, ${activeAccent.color} 42%, transparent) 60%, transparent 100%)`,
              }}
            />

            {/* Integrated Cabinet Header */}
            <div className="flex flex-col gap-3.5 border-b border-hairline bg-paper/95 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex min-w-0 items-start gap-3.5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${activeAccent.color} 15%, transparent)`,
                    borderColor: `color-mix(in srgb, ${activeAccent.color} 32%, transparent)`,
                    color: activeAccent.color,
                  }}
                >
                  <ActiveIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                </span>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="m-0 text-[18px] font-medium text-ink sm:text-[20px]">
                      {activeMeta.name}
                    </h2>
                    <span className="rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11.5px] text-ink-muted">
                      {activeMeta.category}
                    </span>
                    <span className="rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11.5px] text-postmark">
                      {activeMeta.sortDirection === 'asc' ? '按通关用时排名' : '按最高分排名'}
                    </span>
                  </div>
                  <p className="mt-1 mb-0 text-[13.5px] leading-relaxed text-ink-muted">
                    {activeMeta.summary}
                  </p>
                </div>
              </div>

              {/* Recessed Cabinet Telemetry Readout */}
              <div className="flex shrink-0 items-center justify-between gap-3 rounded-[14px] border border-hairline bg-surface/90 px-3.5 py-2 sm:min-w-[148px] sm:flex-col sm:items-end sm:justify-center sm:gap-0.5">
                <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <span>本地个人最佳</span>
                  {isNewLocalBest && currentBest !== null && (
                    <span className="rounded-full border border-hairline bg-paper px-1.5 py-0 text-[10px] font-medium text-postmark">
                      刷新
                    </span>
                  )}
                </div>
                <div className="tabular-nums-mono text-[16px] font-medium text-ink">
                  {currentBest !== null ? formatArcadeScore(activeGameId, currentBest) : '尚未记录'}
                </div>
              </div>
            </div>

            {/* Recessed Playfield Bay */}
            <div className="min-w-0 overflow-x-clip bg-surface p-3.5 sm:p-5">
              <ErrorBoundary resetKey={activeGameId}>
                <Suspense fallback={<GameLoadingSkeleton label={activeMeta.name} />}>
                  <ActiveGame
                    onRunFinished={handleRunFinished}
                    bestScore={currentBest}
                    muted={muted}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>

            {/* Integrated Bottom Controls Rail */}
            <div className="flex flex-col gap-2 border-t border-hairline bg-paper/80 px-4 py-3 text-[12.5px] leading-relaxed text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex min-w-0 items-start gap-2">
                <Keyboard
                  className="mt-0.5 h-4 w-4 shrink-0 text-postmark"
                  aria-hidden="true"
                />
                <p className="m-0 min-w-0">
                  <span className="font-medium text-ink">操控提示：</span>
                  {activeMeta.controlsHint}
                </p>
              </div>
              <span className="tabular-nums-mono shrink-0 text-[11.5px] text-ink-muted/85">
                {activeAccent.motif} · 纯本地运行
              </span>
            </div>
          </section>

          {/* Right Dual-Track Leaderboard Column (4 cols on desktop, non-sticky for zero scroll overlap) */}
          <div className="min-w-0 lg:col-span-4">
            <ScoreBoardPanel
              gameId={activeGameId}
              localBest={currentBest}
              pendingRun={pendingRun}
              isNewLocalBest={isNewLocalBest}
              onScoreSubmitted={handleScoreSubmitted}
            />
          </div>
        </div>

        {/* Phase 4 Flagship Launch Card: 3D Tactical Shooter SANDSTORM */}
        <section
          aria-label="3D 战术射击 · 沙暴行动 SANDSTORM"
          className="mt-8 overflow-hidden rounded-[26px] border border-hairline-strong bg-paper shadow-sm"
        >
          <div
            aria-hidden="true"
            className="h-[3px] w-full"
            style={{
              background:
                'linear-gradient(90deg, #c96a48 0%, #d4a056 56%, color-mix(in srgb, #d4a056 18%, transparent) 100%)',
            }}
          />
          <div className="p-5 sm:p-7">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border"
                    style={{
                      backgroundColor: 'color-mix(in srgb, #c96a48 15%, transparent)',
                      borderColor: 'color-mix(in srgb, #c96a48 34%, transparent)',
                      color: '#c96a48',
                    }}
                  >
                    <Crosshair className="h-[18px] w-[18px]" aria-hidden="true" />
                  </span>
                  <h2 className="m-0 text-[18px] font-medium text-ink sm:text-[21px]">
                    3D 战术射击 · 沙暴行动 SANDSTORM
                  </h2>
                  <span
                    className="tabular-nums-mono rounded-full border px-2.5 py-0.5 text-[11px] font-medium"
                    style={{
                      backgroundColor: 'color-mix(in srgb, #c96a48 12%, transparent)',
                      borderColor: 'color-mix(in srgb, #c96a48 34%, transparent)',
                      color: '#c96a48',
                    }}
                  >
                    v3.0 · 火星主场
                  </span>
                </div>

                <p className="font-editorial-serif mt-3 mb-0 max-w-[820px] text-[14.5px] leading-relaxed text-ink-muted">
                  四大 96m×96m 程序化 PBR 战术战场（炽沙小镇 / 极地科研站 / 黄昏货运港 / 火星主场「赤岩前哨」），支持火星 0.48g 低重力与天候声景；收录 FAMAS、AK-47、M4A1-S、AWP 与蝴蝶/爪子刀等 17 款主战武器 × 9 款 3D 武器皮肤、StatTrak 生涯击杀计数、燃烧弹（烟雾弹可灭火）、Z 键 3D 战术标点与第一人称观战；畅玩 5v5 爆破竞技、团队死斗、军备竞赛、残局回防与靶场 2.0，并支持 Cloudflare Durable Objects 6 位房号 64Hz 云端联机。
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2 lg:flex-col lg:items-end">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] font-medium text-accent">
                  <Radio className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="tabular-nums-mono">
                    {arenaPublicCount === null
                      ? '云端联机大厅就绪'
                      : arenaPublicCount > 0
                        ? `活跃公开房间 ${arenaPublicCount} 间`
                        : '当前公开房间 0 间 · 可立即开房'}
                  </span>
                </span>
                <span className="tabular-nums-mono text-[11.5px] text-ink-muted">
                  64Hz DO 云端中继 · 零 D1 Tick
                </span>
              </div>
            </div>

            {/* Primary Launch Actions & 6-Char Room Direct Connect */}
            <div className="mt-5 flex flex-col gap-3 border-t border-hairline pt-5 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap items-center gap-2.5">
                <a
                  href="/arcade/arena"
                  onClick={handleSpaLink('/arcade/arena')}
                  className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]"
                >
                  <Crosshair className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>进入沙暴行动</span>
                </a>
                <a
                  href="/arcade/arena?map=mars&autostart=1"
                  onClick={handleSpaLink('/arcade/arena?map=mars&autostart=1')}
                  className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
                  style={{
                    borderColor: 'color-mix(in srgb, #c96a48 42%, var(--color-hairline))',
                    backgroundColor: 'color-mix(in srgb, #c96a48 10%, var(--color-surface))',
                    color: '#c96a48',
                  }}
                >
                  <Orbit className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>火星主场 · 赤岩前哨</span>
                </a>
                <a
                  href="/arcade/arena?mode=comp&autostart=1"
                  onClick={handleSpaLink('/arcade/arena?mode=comp&autostart=1')}
                  className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
                >
                  <Shield className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>5v5 爆破竞技</span>
                </a>
                <a
                  href="/arcade/arena?mode=tdm&autostart=1"
                  onClick={handleSpaLink('/arcade/arena?mode=tdm&autostart=1')}
                  className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
                >
                  <Swords className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>团队死斗</span>
                </a>
                <a
                  href="/arcade/arena?mode=armsrace&autostart=1"
                  onClick={handleSpaLink('/arcade/arena?mode=armsrace&autostart=1')}
                  className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
                >
                  <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>军备竞赛</span>
                </a>
                <a
                  href="/arcade/arena?mode=retake&autostart=1"
                  onClick={handleSpaLink('/arcade/arena?mode=retake&autostart=1')}
                  className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
                >
                  <Flame className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>残局回防</span>
                </a>
                <a
                  href="/arcade/arena?mode=range&autostart=1"
                  onClick={handleSpaLink('/arcade/arena?mode=range&autostart=1')}
                  className="pill-cta-secondary min-h-[40px] px-4 text-[13px]"
                >
                  <Target className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>压枪靶场</span>
                </a>
              </div>

              <div className="min-w-0">
                <form
                  onSubmit={handleJoinArenaRoom}
                  className="flex items-center gap-2 rounded-full border border-hairline-strong bg-surface p-1 pl-3.5 transition-colors focus-within:border-accent"
                >
                  <input
                    type="text"
                    value={arenaRoomInput}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
                      setArenaRoomInput(next);
                      if (arenaRoomError) setArenaRoomError('');
                    }}
                    maxLength={6}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="输入 6 位沙暴房间码直连"
                    placeholder="输入 6 位房号直连"
                    className="tabular-nums-mono min-w-0 flex-1 bg-transparent py-1.5 text-[13.5px] tracking-[0.12em] text-ink outline-none placeholder:tracking-normal placeholder:text-ink-muted sm:w-40 sm:flex-none"
                  />
                  <button
                    type="submit"
                    className="min-h-[34px] shrink-0 cursor-pointer rounded-full bg-cta-bg px-4 text-[12.5px] font-medium text-cta-text transition-opacity hover:opacity-90"
                  >
                    直连房间
                  </button>
                </form>
                {arenaRoomError && (
                  <p role="alert" className="mt-1.5 mb-0 pl-3 text-[12px] text-postmark">
                    {arenaRoomError}
                  </p>
                )}
              </div>
            </div>

            {/* Active Public Rooms Quick Join Pills (when available) */}
            {arenaPublicRooms.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-ink-muted">公开大厅直达：</span>
                {arenaPublicRooms.map((room) => (
                  <a
                    key={room.code}
                    href={`/arcade/arena?room=${encodeURIComponent(room.code)}`}
                    onClick={handleSpaLink(`/arcade/arena?room=${encodeURIComponent(room.code)}`)}
                    className="inline-flex min-h-[30px] items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink no-underline transition-colors hover:border-hairline-strong hover:bg-surface-hover"
                  >
                    <span className="tabular-nums-mono font-medium text-accent">{room.code}</span>
                    <span className="rounded-full border border-hairline bg-paper px-1.5 py-0 text-[10.5px] text-ink-muted">
                      {formatArenaMapLabel(room.mapId)}
                    </span>
                    <span className="max-w-[130px] truncate">{room.name}</span>
                    {isArenaLobbyLive(room.phase) && (
                      <span className="tabular-nums-mono rounded-full bg-paper px-1.5 py-0 text-[10.5px] font-medium text-postmark">
                        T {room.scoreRed}:{room.scoreBlue} CT
                      </span>
                    )}
                    <span className="tabular-nums-mono text-[11px] text-ink-muted">
                      {room.humanCount}/{room.maxHumans}
                    </span>
                  </a>
                ))}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {[
                '4 张 96m×96m PBR 地图 · 含火星「赤岩前哨」',
                '17 款主战武器 × 9 款 3D 皮肤 · StatTrak',
                '燃烧弹与烟雾灭火 · Z 键 3D 战术标点',
                '爆破 · 死斗 · 军备竞赛 · 残局回防 · 靶场 2.0',
                'Durable Objects 6 位房号 64Hz 云端联机',
              ].map((tag) => (
                <span
                  key={tag}
                  className="tabular-nums-mono inline-flex items-center rounded-full border border-hairline bg-surface px-3 py-1 text-[11.5px] text-ink-muted"
                >
                  {tag}
                </span>
              ))}
            </div>

            {/* Recent Sandstorm Cloud Matches Honor Wall */}
            <div className="mt-5 border-t border-hairline pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Award className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                  <h3 className="m-0 text-[15px] font-medium text-ink">
                    近期云端战报 · 荣誉墙
                  </h3>
                  {arenaMatches.length > 0 && (
                    <span className="tabular-nums-mono rounded-full border border-hairline bg-surface px-2.5 py-0.5 text-[11px] text-ink-muted">
                      {arenaMatches.length} 局
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => void loadArenaTelemetry(true)}
                  disabled={arenaMatchesLoading || arenaRefreshing}
                  className="inline-flex min-h-[32px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink transition-colors hover:border-hairline-strong hover:bg-surface-hover disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${arenaRefreshing ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  <span>刷新战报</span>
                </button>
              </div>

              {arenaMatchesLoading ? (
                <p className="mt-3 mb-0 text-[13px] text-ink-muted">正在读取近期沙暴行动战报……</p>
              ) : arenaMatches.length === 0 ? (
                <div className="mt-3 rounded-[16px] border border-hairline bg-surface px-4 py-4 text-[13px] leading-relaxed text-ink-muted">
                  完成一局「沙暴行动」爆破竞技、团队死斗、军备竞赛或残局回防后，地图、比分、全员战绩表与本场 MVP 将自动归档于此。
                </div>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    {(arenaMatchesExpanded ? arenaMatches : arenaMatches.slice(0, 4)).map(
                      (match) => {
                        const isDetailOpen = Boolean(expandedMatchIds[match.id]);
                        const sortedPlayers = isDetailOpen
                          ? [...match.players].sort((a, b) => {
                              if (a.team !== b.team) return a.team === 'red' ? -1 : 1;
                              return b.kills - a.kills || b.damage - a.damage || b.score - a.score;
                            })
                          : [];

                        return (
                          <article
                            key={match.id}
                            className="rounded-[16px] border border-hairline bg-surface p-3.5 sm:p-4"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="rounded-full border border-hairline bg-paper px-2 py-0.5 text-[11px] text-ink">
                                  {match.source === 'online' ? '云端联机' : '单人 AI'}
                                </span>
                                <span
                                  className="rounded-full border border-hairline bg-paper px-2 py-0.5 text-[11px] font-medium"
                                  style={
                                    match.mapId === 'mars'
                                      ? {
                                          borderColor: 'color-mix(in srgb, #c96a48 38%, transparent)',
                                          color: '#c96a48',
                                        }
                                      : undefined
                                  }
                                >
                                  {formatArenaMapLabel(match.mapId)}
                                </span>
                                <span className="tabular-nums-mono text-[12px] font-medium text-accent">
                                  {match.roomCode}
                                </span>
                                <span className="text-[12px] text-ink-muted">
                                  {formatArenaModeLabel(match.mode)}
                                </span>
                              </div>
                              <span className="text-[12px] font-medium text-postmark">
                                {formatArenaWinnerLabel(match.winnerTeam)}
                              </span>
                            </div>

                            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                              <div className="tabular-nums-mono text-[15px] font-semibold text-ink">
                                T {match.scoreRed} : {match.scoreBlue} CT
                              </div>
                              <div className="tabular-nums-mono text-[12px] text-ink-muted">
                                <span className="font-medium text-ink">MVP {match.mvpName}</span>
                                {' · '}
                                {match.mvpKills} 杀 / {match.mvpDeaths} 死 · 爆头{' '}
                                {match.mvpHeadshots}
                              </div>
                            </div>

                            <div className="tabular-nums-mono mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-hairline pt-2 text-[11.5px] text-ink-muted">
                              <span>
                                {match.playerCount} 真人 · {match.botCount} Bot
                              </span>
                              <span>{formatArcadeDuration(match.durationMs)}</span>
                              <span>{formatArcadeTimestamp(match.createdAt, true)}</span>
                              {match.players.length > 0 && (
                                <button
                                  type="button"
                                  aria-expanded={isDetailOpen}
                                  aria-controls={`arena-match-board-${match.id}`}
                                  onClick={() => toggleMatchScoreboard(match.id)}
                                  className="ml-auto inline-flex min-h-[26px] cursor-pointer items-center gap-1 rounded-full border border-hairline bg-paper px-2.5 text-[11px] font-medium text-ink transition-colors hover:border-hairline-strong hover:bg-surface-hover"
                                >
                                  <span>
                                    {isDetailOpen ? '收起战绩' : `全员战绩 (${match.players.length})`}
                                  </span>
                                  <ChevronDown
                                    className={`h-3 w-3 transition-transform duration-150 ${
                                      isDetailOpen ? 'rotate-180' : ''
                                    }`}
                                    aria-hidden="true"
                                  />
                                </button>
                              )}
                            </div>

                            {isDetailOpen && sortedPlayers.length > 0 && (
                              <div
                                id={`arena-match-board-${match.id}`}
                                className="mt-2.5 overflow-x-auto rounded-[12px] border border-hairline bg-paper/80"
                              >
                                <table className="w-full border-collapse text-left text-[11.5px]">
                                  <thead>
                                    <tr className="border-b border-hairline text-[10.5px] text-ink-muted">
                                      <th className="py-1.5 pr-2 pl-2.5 font-medium">阵营 / 玩家</th>
                                      <th className="px-2 py-1.5 text-right font-medium">K/D/A</th>
                                      <th className="px-2 py-1.5 text-right font-medium">爆头</th>
                                      <th className="px-2 py-1.5 text-right font-medium">伤害</th>
                                      <th className="py-1.5 pr-2.5 pl-2 text-right font-medium">积分</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-hairline/70">
                                    {sortedPlayers.map((player) => (
                                      <tr key={`${match.id}-${player.id}`}>
                                        <td className="py-1.5 pr-2 pl-2.5 whitespace-nowrap">
                                          <div className="flex items-center gap-1.5">
                                            <span
                                              className="inline-flex w-6 shrink-0 items-center justify-center rounded px-1 py-0 text-[10px] font-semibold"
                                              style={
                                                player.team === 'red'
                                                  ? {
                                                      backgroundColor:
                                                        'color-mix(in srgb, #c96a48 16%, transparent)',
                                                      color: '#c96a48',
                                                    }
                                                  : {
                                                      backgroundColor:
                                                        'color-mix(in srgb, #4f8ce8 16%, transparent)',
                                                      color: '#4f8ce8',
                                                    }
                                              }
                                            >
                                              {player.team === 'red' ? 'T' : 'CT'}
                                            </span>
                                            <span className="max-w-[120px] truncate font-medium text-ink">
                                              {player.name}
                                            </span>
                                            {player.isBot && (
                                              <span className="rounded bg-surface px-1 text-[9.5px] text-ink-muted">
                                                AI
                                              </span>
                                            )}
                                          </div>
                                        </td>
                                        <td className="tabular-nums-mono px-2 py-1.5 text-right whitespace-nowrap text-ink">
                                          {player.kills}/{player.deaths}/{player.assists}
                                        </td>
                                        <td className="tabular-nums-mono px-2 py-1.5 text-right whitespace-nowrap text-ink-muted">
                                          {player.headshots}
                                        </td>
                                        <td className="tabular-nums-mono px-2 py-1.5 text-right whitespace-nowrap text-ink-muted">
                                          {player.damage}
                                        </td>
                                        <td className="tabular-nums-mono py-1.5 pr-2.5 pl-2 text-right font-medium whitespace-nowrap text-ink">
                                          {player.score}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </article>
                        );
                      },
                    )}
                  </div>

                  {arenaMatches.length > 4 && (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => setArenaMatchesExpanded((prev) => !prev)}
                        className="inline-flex min-h-[32px] cursor-pointer items-center rounded-full border border-hairline bg-surface px-3.5 text-[12px] text-ink transition-colors hover:border-hairline-strong hover:bg-surface-hover"
                      >
                        {arenaMatchesExpanded ? '收起战报' : `展开全部 ${arenaMatches.length} 局`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </section>

        {/* Calm Bottom Return Bar */}
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-[13px] text-ink-muted">
          <a
            href="/"
            onClick={handleSpaLink('/')}
            className="inline-flex items-center gap-1.5 text-ink-muted no-underline transition-colors hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>返回太阳系首页</span>
          </a>
          <div className="flex flex-wrap items-center gap-4">
            <a
              href="/explore/mars"
              onClick={handleSpaLink('/explore/mars')}
              className="inline-flex items-center gap-1 text-ink-muted no-underline transition-colors hover:text-ink"
            >
              <span>火星实时星历</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
            <a
              href="/toolkit"
              onClick={handleSpaLink('/toolkit')}
              className="inline-flex items-center gap-1 text-accent no-underline hover:underline"
            >
              <span>前往水星工具台</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
