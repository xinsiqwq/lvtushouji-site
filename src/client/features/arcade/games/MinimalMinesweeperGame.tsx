import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Flag, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useTheme } from '../../../lib/theme';
import { formatArcadeScore, type ArcadeGameProps } from '../arcade-catalog';
import { arcadeSfx } from '../arcade-sfx';

type DifficultyId = 'beginner' | 'intermediate' | 'expert';
type GameStatus = 'idle' | 'playing' | 'won' | 'lost';
type InputMode = 'reveal' | 'flag';

interface DifficultyPreset {
  id: DifficultyId;
  label: string;
  specLabel: string;
  cols: number;
  rows: number;
  mines: number;
}

interface CellState {
  row: number;
  col: number;
  hasMine: boolean;
  adjacent: number;
  revealed: boolean;
  flagged: boolean;
  exploded: boolean;
  revealDelayMs: number;
  victoryFlagDelayMs: number;
}

interface ChordPreviewState {
  keys: ReadonlySet<string>;
  ready: boolean;
}

const PRESETS: readonly DifficultyPreset[] = [
  { id: 'beginner', label: '初级', specLabel: '9×9 · 10 雷', cols: 9, rows: 9, mines: 10 },
  {
    id: 'intermediate',
    label: '中级',
    specLabel: '16×16 · 40 雷',
    cols: 16,
    rows: 16,
    mines: 40,
  },
  { id: 'expert', label: '高级', specLabel: '30×16 · 99 雷', cols: 30, rows: 16, mines: 99 },
];

const NUMBER_COLORS_LIGHT: Record<number, string> = {
  1: '#1a5fb4',
  2: '#23704b',
  3: '#b53830',
  4: '#4f3b8c',
  5: '#8a3c24',
  6: '#187075',
  7: '#262626',
  8: '#5f6368',
};

const NUMBER_COLORS_DARK: Record<number, string> = {
  1: '#7ab3f8',
  2: '#6ec996',
  3: '#eb7c73',
  4: '#b09cf0',
  5: '#e09b72',
  6: '#63c6cc',
  7: '#e3e3e3',
  8: '#9aa0a6',
};

const MAX_MINESWEEPER_MS = 3_600_000;
const MIN_MINESWEEPER_MS = 1_000;
const EMPTY_PREVIEW: ChordPreviewState = { keys: new Set(), ready: false };

function createEmptyGrid(rows: number, cols: number): CellState[][] {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => ({
      row,
      col,
      hasMine: false,
      adjacent: 0,
      revealed: false,
      flagged: false,
      exploded: false,
      revealDelayMs: 0,
      victoryFlagDelayMs: 0,
    })),
  );
}

function cloneGrid(grid: readonly (readonly CellState[])[]): CellState[][] {
  return grid.map((row) => row.map((cell) => ({ ...cell })));
}

function getNeighbors(rows: number, cols: number, r: number, c: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        out.push([nr, nc]);
      }
    }
  }
  return out;
}

/**
 * Places mines strictly AFTER the player's first cell reveal,
 * guaranteeing that (safeR, safeC) and all 8 surrounding cells are mine-free.
 */
function placeMinesSafely(
  grid: CellState[][],
  rows: number,
  cols: number,
  mines: number,
  safeR: number,
  safeC: number,
): void {
  const candidates: [number, number][] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (Math.abs(r - safeR) <= 1 && Math.abs(c - safeC) <= 1) {
        grid[r][c].flagged = false;
        continue;
      }
      candidates.push([r, c]);
    }
  }

  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
  }

  const count = Math.min(mines, candidates.length);
  for (let i = 0; i < count; i += 1) {
    const [mr, mc] = candidates[i];
    grid[mr][mc].hasMine = true;
  }

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (grid[r][c].hasMine) {
        grid[r][c].adjacent = 0;
        continue;
      }
      let adj = 0;
      for (const [nr, nc] of getNeighbors(rows, cols, r, c)) {
        if (grid[nr][nc].hasMine) adj += 1;
      }
      grid[r][c].adjacent = adj;
    }
  }
}

function floodReveal(
  grid: CellState[][],
  rows: number,
  cols: number,
  startR: number,
  startC: number,
): number {
  const queue: [number, number][] = [[startR, startC]];
  let newlyRevealed = 0;

  while (queue.length > 0) {
    const [r, c] = queue.shift() as [number, number];
    const cell = grid[r][c];
    if (cell.revealed || cell.flagged || cell.hasMine) continue;

    const manhattan = Math.abs(r - startR) + Math.abs(c - startC);
    cell.revealed = true;
    cell.revealDelayMs = Math.min(manhattan * 16, 180);
    newlyRevealed += 1;

    if (cell.adjacent === 0) {
      for (const [nr, nc] of getNeighbors(rows, cols, r, c)) {
        const nb = grid[nr][nc];
        if (!nb.revealed && !nb.flagged && !nb.hasMine) {
          queue.push([nr, nc]);
        }
      }
    }
  }

  return newlyRevealed;
}

function MineGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="3.4" fill="currentColor" />
      <path
        d="M8 1.5V3.5M8 12.5V14.5M1.5 8H3.5M12.5 8H14.5M3.4 3.4L4.8 4.8M11.2 11.2L12.6 12.6M12.6 3.4L11.2 4.8M4.8 11.2L3.4 12.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function MinimalMinesweeperGame({
  onRunFinished,
  bestScore,
  muted,
}: ArcadeGameProps) {
  const { resolved: themeScheme } = useTheme();
  const isDark = themeScheme === 'dark';

  const [difficulty, setDifficulty] = useState<DifficultyId>('beginner');
  const preset = useMemo(
    () => PRESETS.find((p) => p.id === difficulty) ?? PRESETS[0],
    [difficulty],
  );

  const [grid, setGrid] = useState<CellState[][]>(() =>
    createEmptyGrid(PRESETS[0].rows, PRESETS[0].cols),
  );
  const [status, setStatus] = useState<GameStatus>('idle');
  const [minesPlaced, setMinesPlaced] = useState<boolean>(false);
  const [inputMode, setInputMode] = useState<InputMode>('reveal');
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [pulseKeys, setPulseKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [chordPreview, setChordPreview] = useState<ChordPreviewState>(EMPTY_PREVIEW);

  const startTimeRef = useRef<number | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const onRunFinishedRef = useRef(onRunFinished);
  const mutedRef = useRef(muted);

  useEffect(() => {
    onRunFinishedRef.current = onRunFinished;
  }, [onRunFinished]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const playSound = useCallback((fn: () => void) => {
    if (!mutedRef.current) {
      fn();
    }
  }, []);

  // Millisecond precision timer while playing
  useEffect(() => {
    if (status !== 'playing') return;
    let rafId = 0;
    let lastPaint = 0;

    const tick = (now: number) => {
      if (startTimeRef.current !== null && now - lastPaint >= 32) {
        lastPaint = now;
        setElapsedMs(Math.max(0, performance.now() - startTimeRef.current));
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [status]);

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current !== null) {
        window.clearTimeout(pulseTimerRef.current);
      }
    };
  }, []);

  const clearChordPreview = useCallback(() => {
    setChordPreview((prev) => (prev.keys.size === 0 ? prev : EMPTY_PREVIEW));
  }, []);

  const updateChordPreview = useCallback(
    (r: number, c: number) => {
      if (status !== 'playing') {
        clearChordPreview();
        return;
      }
      const cell = grid[r]?.[c];
      if (!cell || !cell.revealed || cell.adjacent <= 0) {
        clearChordPreview();
        return;
      }
      const neighbors = getNeighbors(preset.rows, preset.cols, r, c);
      let flags = 0;
      const candidates = new Set<string>();
      for (const [nr, nc] of neighbors) {
        const nb = grid[nr][nc];
        if (nb.flagged) {
          flags += 1;
        } else if (!nb.revealed) {
          candidates.add(`${nr},${nc}`);
        }
      }
      if (candidates.size === 0) {
        clearChordPreview();
        return;
      }
      setChordPreview({ keys: candidates, ready: flags === cell.adjacent });
    },
    [clearChordPreview, grid, preset.cols, preset.rows, status],
  );

  const resetBoard = useCallback((targetPreset: DifficultyPreset) => {
    startTimeRef.current = null;
    setGrid(createEmptyGrid(targetPreset.rows, targetPreset.cols));
    setStatus('idle');
    setMinesPlaced(false);
    setElapsedMs(0);
    setPulseKeys(new Set());
    setChordPreview(EMPTY_PREVIEW);
  }, []);

  const handleSelectDifficulty = useCallback(
    (nextId: DifficultyId) => {
      const nextPreset = PRESETS.find((p) => p.id === nextId) ?? PRESETS[0];
      setDifficulty(nextPreset.id);
      resetBoard(nextPreset);
      playSound(arcadeSfx.click);
    },
    [playSound, resetBoard],
  );

  const triggerNeighborPulse = useCallback((coords: readonly [number, number][]) => {
    if (pulseTimerRef.current !== null) {
      window.clearTimeout(pulseTimerRef.current);
    }
    setPulseKeys(new Set(coords.map(([r, c]) => `${r},${c}`)));
    pulseTimerRef.current = window.setTimeout(() => {
      setPulseKeys(new Set());
      pulseTimerRef.current = null;
    }, 190);
  }, []);

  const finalizeVictoryOrContinue = useCallback(
    (nextGrid: CellState[][], currentPreset: DifficultyPreset, startedAt: number) => {
      let revealedSafe = 0;
      const totalSafe = currentPreset.rows * currentPreset.cols - currentPreset.mines;
      for (let r = 0; r < currentPreset.rows; r += 1) {
        for (let c = 0; c < currentPreset.cols; c += 1) {
          if (nextGrid[r][c].revealed && !nextGrid[r][c].hasMine) {
            revealedSafe += 1;
          }
        }
      }

      if (revealedSafe >= totalSafe) {
        for (let r = 0; r < currentPreset.rows; r += 1) {
          for (let c = 0; c < currentPreset.cols; c += 1) {
            if (nextGrid[r][c].hasMine) {
              if (!nextGrid[r][c].flagged) {
                nextGrid[r][c].victoryFlagDelayMs = Math.min((r + c) * 14, 220);
              }
              nextGrid[r][c].flagged = true;
            }
          }
        }
        const rawElapsed = Math.max(0, performance.now() - startedAt);
        const roundedMs = Math.round(rawElapsed);
        const reportedScore = Math.min(
          MAX_MINESWEEPER_MS,
          Math.max(MIN_MINESWEEPER_MS, roundedMs),
        );

        setGrid(nextGrid);
        setElapsedMs(rawElapsed);
        setStatus('won');
        setChordPreview(EMPTY_PREVIEW);
        playSound(arcadeSfx.win);

        onRunFinishedRef.current({
          score: reportedScore,
          durationMs: roundedMs,
          meta: {
            difficulty: currentPreset.id,
            mines: currentPreset.mines,
          },
        });
        return true;
      }

      setGrid(nextGrid);
      return false;
    },
    [playSound],
  );

  const triggerLoss = useCallback(
    (nextGrid: CellState[][], explodedCoords: readonly [number, number][]) => {
      for (const [er, ec] of explodedCoords) {
        nextGrid[er][ec].revealed = true;
        nextGrid[er][ec].exploded = true;
        nextGrid[er][ec].revealDelayMs = 0;
      }
      for (let r = 0; r < nextGrid.length; r += 1) {
        for (let c = 0; c < nextGrid[r].length; c += 1) {
          if (nextGrid[r][c].hasMine && !nextGrid[r][c].flagged) {
            nextGrid[r][c].revealed = true;
            nextGrid[r][c].revealDelayMs = 0;
          }
        }
      }
      if (startTimeRef.current !== null) {
        setElapsedMs(Math.max(0, performance.now() - startTimeRef.current));
      }
      setGrid(nextGrid);
      setStatus('lost');
      setChordPreview(EMPTY_PREVIEW);
      playSound(arcadeSfx.gameOver);
    },
    [playSound],
  );

  const toggleFlagAt = useCallback(
    (r: number, c: number) => {
      if (status !== 'idle' && status !== 'playing') return;
      const cell = grid[r]?.[c];
      if (!cell || cell.revealed) return;
      const nextGrid = cloneGrid(grid);
      nextGrid[r][c].flagged = !nextGrid[r][c].flagged;
      nextGrid[r][c].victoryFlagDelayMs = 0;
      setGrid(nextGrid);
      playSound(arcadeSfx.flag);
    },
    [grid, playSound, status],
  );

  const revealAt = useCallback(
    (r: number, c: number) => {
      if (status !== 'idle' && status !== 'playing') return;
      const currentCell = grid[r]?.[c];
      if (!currentCell || currentCell.revealed || currentCell.flagged) return;

      const nextGrid = cloneGrid(grid);
      let startedAt = startTimeRef.current;

      if (!minesPlaced) {
        placeMinesSafely(nextGrid, preset.rows, preset.cols, preset.mines, r, c);
        startedAt = performance.now();
        startTimeRef.current = startedAt;
        setMinesPlaced(true);
        setStatus('playing');
      }

      const target = nextGrid[r][c];
      if (target.hasMine) {
        triggerLoss(nextGrid, [[r, c]]);
        return;
      }

      const opened = floodReveal(nextGrid, preset.rows, preset.cols, r, c);
      if (opened > 0) {
        const won = finalizeVictoryOrContinue(
          nextGrid,
          preset,
          startedAt ?? performance.now(),
        );
        if (!won) {
          playSound(opened >= 6 ? arcadeSfx.thud : arcadeSfx.click);
        }
      }
    },
    [finalizeVictoryOrContinue, grid, minesPlaced, playSound, preset, status, triggerLoss],
  );

  const chordAt = useCallback(
    (r: number, c: number) => {
      if (status !== 'playing') return;
      const cell = grid[r]?.[c];
      if (!cell || !cell.revealed || cell.adjacent <= 0) return;

      const neighbors = getNeighbors(preset.rows, preset.cols, r, c);
      let flagCount = 0;
      const unrevealedUnflagged: [number, number][] = [];

      for (const [nr, nc] of neighbors) {
        const nb = grid[nr][nc];
        if (nb.flagged) {
          flagCount += 1;
        } else if (!nb.revealed) {
          unrevealedUnflagged.push([nr, nc]);
        }
      }

      if (unrevealedUnflagged.length === 0) return;
      if (flagCount !== cell.adjacent) {
        triggerNeighborPulse(unrevealedUnflagged);
        return;
      }

      const nextGrid = cloneGrid(grid);
      const detonated: [number, number][] = [];
      let totalOpened = 0;

      for (const [nr, nc] of unrevealedUnflagged) {
        if (nextGrid[nr][nc].hasMine) {
          detonated.push([nr, nc]);
        }
      }

      if (detonated.length > 0) {
        triggerLoss(nextGrid, detonated);
        return;
      }

      for (const [nr, nc] of unrevealedUnflagged) {
        totalOpened += floodReveal(nextGrid, preset.rows, preset.cols, nr, nc);
      }

      if (totalOpened > 0) {
        clearChordPreview();
        const won = finalizeVictoryOrContinue(
          nextGrid,
          preset,
          startTimeRef.current ?? performance.now(),
        );
        if (!won) {
          playSound(totalOpened >= 6 ? arcadeSfx.thud : arcadeSfx.click);
        }
      }
    },
    [
      clearChordPreview,
      finalizeVictoryOrContinue,
      grid,
      playSound,
      preset,
      status,
      triggerLoss,
      triggerNeighborPulse,
    ],
  );

  const { flagCount, revealedSafeCount } = useMemo(() => {
    let flags = 0;
    let revealedSafe = 0;
    for (let r = 0; r < grid.length; r += 1) {
      for (let c = 0; c < grid[r].length; c += 1) {
        if (grid[r][c].flagged) flags += 1;
        if (grid[r][c].revealed && !grid[r][c].hasMine) revealedSafe += 1;
      }
    }
    return { flagCount: flags, revealedSafeCount: revealedSafe };
  }, [grid]);

  const totalSafeCells = preset.rows * preset.cols - preset.mines;
  const progressPct =
    totalSafeCells > 0 ? Math.min(100, Math.round((revealedSafeCount / totalSafeCells) * 100)) : 0;
  const remainingMines = preset.mines - flagCount;
  const numberPalette = isDark ? NUMBER_COLORS_DARK : NUMBER_COLORS_LIGHT;

  const cellSizeClass =
    difficulty === 'beginner'
      ? 'h-8 w-8 text-sm sm:h-9 sm:w-9 sm:text-[15px]'
      : difficulty === 'intermediate'
        ? 'h-7 w-7 text-xs sm:h-[30px] sm:w-[30px] sm:text-sm'
        : 'h-[26px] w-[26px] text-xs sm:h-[27px] sm:w-[27px] sm:text-xs';

  return (
    <div className="flex w-full max-w-full flex-col gap-3">
      <style>{`
        .ms-keycap-light {
          background: linear-gradient(180deg, #f7f9fc 0%, #e5ebf3 100%);
          border-color: rgba(31, 31, 31, 0.14);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.94),
            inset 0 -2px 0 rgba(31, 31, 31, 0.11),
            0 1px 1px rgba(31, 31, 31, 0.06);
          transition: transform 80ms ease, background 120ms ease, border-color 120ms ease, box-shadow 80ms ease;
        }
        .ms-keycap-light:hover {
          background: linear-gradient(180deg, #ffffff 0%, #edf2f8 100%);
          border-color: rgba(31, 31, 31, 0.22);
        }
        .ms-keycap-light:active {
          transform: translateY(1px);
          box-shadow: inset 0 1px 2px rgba(31, 31, 31, 0.14);
        }

        .ms-keycap-dark {
          background: linear-gradient(180deg, #2e333e 0%, #22262f 100%);
          border-color: rgba(227, 227, 227, 0.14);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.13),
            inset 0 -2px 0 rgba(0, 0, 0, 0.48),
            0 1px 2px rgba(0, 0, 0, 0.34);
          transition: transform 80ms ease, background 120ms ease, border-color 120ms ease, box-shadow 80ms ease;
        }
        .ms-keycap-dark:hover {
          background: linear-gradient(180deg, #363c49 0%, #292e39 100%);
          border-color: rgba(227, 227, 227, 0.24);
        }
        .ms-keycap-dark:active {
          transform: translateY(1px);
          box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.52);
        }

        @keyframes ms-cell-ripple {
          0% { opacity: 0.42; transform: scale(0.88); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes ms-flag-pop {
          0% { opacity: 0; transform: scale(0.42) translateY(2px); }
          62% { opacity: 1; transform: scale(1.14) translateY(-1px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes ms-blast-ring {
          0% { opacity: 0.92; transform: scale(0.5); }
          100% { opacity: 0; transform: scale(2.15); }
        }
        @keyframes ms-victory-sheen {
          0% { box-shadow: inset 0 0 0 1px rgba(138, 180, 248, 0.65); }
          100% { box-shadow: inset 0 0 0 1px rgba(138, 180, 248, 0); }
        }
        .ms-cell-ripple {
          animation: ms-cell-ripple 155ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .ms-flag-pop {
          animation: ms-flag-pop 190ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .ms-blast-ring {
          animation: ms-blast-ring 540ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .ms-victory-sheen {
          animation: ms-victory-sheen 460ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .ms-cell-ripple,
          .ms-flag-pop,
          .ms-blast-ring,
          .ms-victory-sheen {
            animation: none !important;
          }
          .ms-keycap-light:active,
          .ms-keycap-dark:active {
            transform: none;
          }
        }
      `}</style>

      {/* Difficulty Selector & Mode Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-3.5 py-2.5">
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="扫雷难度选择"
        >
          {PRESETS.map((item) => {
            const active = item.id === difficulty;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectDifficulty(item.id)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                  active
                    ? 'border-transparent bg-cta-bg text-cta-text'
                    : 'border-hairline bg-paper text-ink hover:bg-surface-hover'
                }`}
              >
                <span>{item.label}</span>
                <span className="tabular-nums-mono hidden text-[10px] opacity-80 sm:inline">
                  {item.specLabel}
                </span>
              </button>
            );
          })}
        </div>

        {/* Mobile/Touch Reveal vs Flag Mode Toggle Pill */}
        <div className="flex items-center gap-1.5">
          <div
            className="inline-flex items-center rounded-full border border-hairline bg-paper p-0.5"
            role="group"
            aria-label="点击操作模式"
          >
            <button
              type="button"
              onClick={() => setInputMode('reveal')}
              className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors ${
                inputMode === 'reveal'
                  ? 'bg-cta-bg text-cta-text'
                  : 'text-ink-muted hover:text-ink'
              }`}
              aria-pressed={inputMode === 'reveal'}
            >
              <Crosshair className="h-3.5 w-3.5" />
              <span>翻开模式</span>
            </button>
            <button
              type="button"
              onClick={() => setInputMode('flag')}
              className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors ${
                inputMode === 'flag'
                  ? 'bg-cta-bg text-cta-text'
                  : 'text-ink-muted hover:text-ink'
              }`}
              aria-pressed={inputMode === 'flag'}
            >
              <Flag className="h-3.5 w-3.5" />
              <span>插旗模式</span>
            </button>
          </div>
        </div>
      </div>

      {/* Live Millisecond Telemetry Bar + Fine Clearing Progress Strip */}
      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="flex flex-col">
              <span className="text-[11px] text-ink-muted">剩余地雷</span>
              <span
                className={`tabular-nums-mono text-lg font-semibold leading-tight ${
                  remainingMines < 0 ? 'text-postmark' : 'text-ink'
                }`}
              >
                {remainingMines}
              </span>
            </div>
            <div className="h-7 w-px bg-hairline" />
            <div className="flex flex-col">
              <span className="text-[11px] text-ink-muted">用时</span>
              <span className="tabular-nums-mono text-lg font-semibold leading-tight text-ink">
                {formatArcadeScore('minesweeper', elapsedMs)}
              </span>
            </div>
            <div className="h-7 w-px bg-hairline" />
            <div className="flex flex-col">
              <span className="text-[11px] text-ink-muted">已排安全格</span>
              <span className="tabular-nums-mono text-sm font-medium leading-tight text-ink">
                {revealedSafeCount} / {totalSafeCells}{' '}
                <span className="text-[11px] text-ink-muted">({progressPct}%)</span>
              </span>
            </div>
            {bestScore !== null && bestScore > 0 ? (
              <>
                <div className="hidden h-7 w-px bg-hairline sm:block" />
                <div className="hidden flex-col sm:flex">
                  <span className="text-[11px] text-ink-muted">最快纪录</span>
                  <span className="tabular-nums-mono text-sm font-medium leading-tight text-accent">
                    {formatArcadeScore('minesweeper', bestScore)}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => {
              resetBoard(preset);
              playSound(arcadeSfx.click);
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>重新布雷</span>
          </button>
        </div>

        {/* Ultra-fine restrained mine-clearing progress rail */}
        <div
          className="h-[3px] w-full bg-paper/70"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="排雷完成进度"
        >
          <div
            className={`h-full transition-[width] duration-200 ${
              status === 'lost' ? 'bg-postmark' : 'bg-accent'
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Victory / Loss Status Banner */}
      {status === 'won' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-paper px-4 py-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 shrink-0 text-accent" />
            <div>
              <p className="text-sm font-medium text-ink">
                排雷完成 ·{' '}
                <span className="tabular-nums-mono text-accent">
                  {formatArcadeScore('minesweeper', elapsedMs)}
                </span>
              </p>
              <p className="text-xs text-ink-muted">
                {preset.label}（{preset.specLabel}）全部安全区域已清空，成绩已就绪可在右侧提交榜单。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => resetBoard(preset)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-cta-bg px-4 text-xs font-medium text-cta-text transition-opacity hover:opacity-90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>再来一局</span>
          </button>
        </div>
      ) : null}

      {status === 'lost' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-postmark/40 bg-paper px-4 py-3">
          <div>
            <p className="text-sm font-medium text-ink">触雷终止</p>
            <p className="tabular-nums-mono text-xs text-ink-muted">
              已安全展开 {revealedSafeCount} / {totalSafeCells} 格 · 用时{' '}
              {formatArcadeScore('minesweeper', elapsedMs)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => resetBoard(preset)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-cta-bg px-4 text-xs font-medium text-cta-text transition-opacity hover:opacity-90"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>重新布雷</span>
          </button>
        </div>
      ) : null}

      {/* Scroll-Contained Minefield Card (Zero Page Overflow Even for 30×16 Expert) */}
      <div className="w-full max-w-full overflow-hidden rounded-2xl border border-hairline bg-surface">
        <div className="w-full overflow-x-auto overscroll-x-contain p-3 sm:p-4">
          <div
            className="mx-auto grid w-fit select-none gap-[2.5px] rounded-xl border border-hairline-strong p-2 shadow-[inset_0_1px_3px_rgba(0,0,0,0.08)]"
            style={{
              gridTemplateColumns: `repeat(${preset.cols}, max-content)`,
              backgroundColor: isDark ? '#101216' : '#d8dfea',
            }}
            onContextMenu={(e) => e.preventDefault()}
            onMouseLeave={clearChordPreview}
            role="grid"
            aria-label={`极简扫雷 ${preset.label} 雷区`}
          >
            {grid.map((row) =>
              row.map((cell) => {
                const key = `${cell.row},${cell.col}`;
                const isPulsing = pulseKeys.has(key);
                const isChordCandidate = chordPreview.keys.has(key);
                const isWrongFlag = status === 'lost' && cell.flagged && !cell.hasMine;
                const isVictoryAutoFlag = status === 'won' && cell.flagged && cell.hasMine;

                const unrevealedKeycapClass = !cell.revealed
                  ? isDark
                    ? 'ms-keycap-dark'
                    : 'ms-keycap-light'
                  : '';

                let inlineStyle: React.CSSProperties;
                if (cell.exploded) {
                  inlineStyle = {
                    backgroundColor: isDark ? '#8a2d28' : '#c94a38',
                    borderColor: isDark ? '#eb8a78' : '#9a2b1f',
                    color: '#ffffff',
                  };
                } else if (cell.revealed) {
                  inlineStyle = {
                    backgroundColor: isDark ? '#15171c' : '#faf8f4',
                    borderColor: isDark
                      ? 'rgba(227, 227, 227, 0.06)'
                      : 'rgba(31, 31, 31, 0.07)',
                    boxShadow: isDark
                      ? 'inset 0 1px 2px rgba(0, 0, 0, 0.36)'
                      : 'inset 0 1px 2px rgba(31, 31, 31, 0.06)',
                    color:
                      !cell.hasMine && cell.adjacent > 0
                        ? numberPalette[cell.adjacent]
                        : isDark
                          ? '#e3e3e3'
                          : '#1f1f1f',
                    animationDelay: `${cell.revealDelayMs}ms`,
                  };
                } else if (isPulsing) {
                  inlineStyle = {
                    background: isDark ? '#323a4a' : '#cfdbee',
                    borderColor: isDark ? 'rgba(138, 180, 248, 0.65)' : 'rgba(26, 115, 232, 0.55)',
                    color: isDark ? '#e3e3e3' : '#1f1f1f',
                  };
                } else if (isChordCandidate) {
                  inlineStyle = {
                    borderColor: chordPreview.ready
                      ? isDark
                        ? 'rgba(138, 180, 248, 0.78)'
                        : 'rgba(26, 115, 232, 0.7)'
                      : isDark
                        ? 'rgba(138, 180, 248, 0.42)'
                        : 'rgba(26, 115, 232, 0.38)',
                    boxShadow: chordPreview.ready
                      ? isDark
                        ? 'inset 0 0 0 1px rgba(138, 180, 248, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.16)'
                        : 'inset 0 0 0 1px rgba(26, 115, 232, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.92)'
                      : undefined,
                    color: isDark ? '#e3e3e3' : '#1f1f1f',
                  };
                } else {
                  inlineStyle = {
                    color: isDark ? '#e3e3e3' : '#1f1f1f',
                    ...(isVictoryAutoFlag
                      ? { animationDelay: `${cell.victoryFlagDelayMs}ms` }
                      : {}),
                  };
                }

                return (
                  <button
                    key={key}
                    type="button"
                    className={`tabular-nums-mono relative flex items-center justify-center rounded-[5px] border font-semibold leading-none focus-visible:z-10 ${cellSizeClass} ${unrevealedKeycapClass} ${
                      cell.revealed ? 'ms-cell-ripple' : ''
                    } ${isVictoryAutoFlag ? 'ms-victory-sheen' : ''}`}
                    style={inlineStyle}
                    onMouseEnter={() => {
                      if (cell.revealed && cell.adjacent > 0) {
                        updateChordPreview(cell.row, cell.col);
                      } else {
                        clearChordPreview();
                      }
                    }}
                    onPointerDown={() => {
                      if (cell.revealed && cell.adjacent > 0) {
                        updateChordPreview(cell.row, cell.col);
                      }
                    }}
                    onPointerUp={clearChordPreview}
                    onPointerCancel={clearChordPreview}
                    onClick={() => {
                      if (cell.revealed) {
                        chordAt(cell.row, cell.col);
                        return;
                      }
                      if (inputMode === 'flag') {
                        toggleFlagAt(cell.row, cell.col);
                      } else {
                        revealAt(cell.row, cell.col);
                      }
                    }}
                    onDoubleClick={() => {
                      if (cell.revealed) {
                        chordAt(cell.row, cell.col);
                      }
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        if (cell.revealed) {
                          chordAt(cell.row, cell.col);
                        }
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      toggleFlagAt(cell.row, cell.col);
                    }}
                    aria-label={
                      cell.revealed
                        ? cell.hasMine
                          ? `第 ${cell.row + 1} 行第 ${cell.col + 1} 列，地雷`
                          : `第 ${cell.row + 1} 行第 ${cell.col + 1} 列，周围 ${cell.adjacent} 颗雷`
                        : cell.flagged
                          ? `第 ${cell.row + 1} 行第 ${cell.col + 1} 列，已插旗`
                          : `第 ${cell.row + 1} 行第 ${cell.col + 1} 列，未翻开`
                    }
                  >
                    {/* Radial terracotta shockwave on detonated mine */}
                    {cell.exploded ? (
                      <span
                        className="ms-blast-ring pointer-events-none absolute -inset-1 z-10 rounded-full border-2 border-[#d69f87]"
                        aria-hidden="true"
                      />
                    ) : null}

                    {isWrongFlag ? (
                      <span className="relative inline-flex items-center justify-center">
                        <Flag className="h-3 w-3 text-ink-muted opacity-45" />
                        <X className="absolute h-4 w-4 text-postmark" />
                      </span>
                    ) : cell.flagged && !cell.revealed ? (
                      <Flag
                        className="ms-flag-pop h-3.5 w-3.5 text-postmark"
                        style={
                          isVictoryAutoFlag
                            ? { animationDelay: `${cell.victoryFlagDelayMs}ms` }
                            : undefined
                        }
                      />
                    ) : cell.revealed && cell.hasMine ? (
                      <MineGlyph className="h-3.5 w-3.5" />
                    ) : cell.revealed && cell.adjacent > 0 ? (
                      <span>{cell.adjacent}</span>
                    ) : null}
                  </button>
                );
              }),
            )}
          </div>
        </div>

        {/* Footer Rule & Scroll Hint */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-paper/60 px-3.5 py-2 text-[11px] text-ink-muted">
          <span>
            首击严格保证 3×3 安全展开 · 悬停或点击数字格预览并快捷和弦展开
          </span>
          {difficulty !== 'beginner' ? (
            <span className="tabular-nums-mono text-ink">
              {preset.specLabel} · 窄屏支持卡片内左右滑动
            </span>
          ) : (
            <span className="tabular-nums-mono">{preset.specLabel}</span>
          )}
        </div>
      </div>
    </div>
  );
}
