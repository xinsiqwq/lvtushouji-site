import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Pause,
  Play,
  RefreshCw,
  Repeat2,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import { formatArcadeScore, type ArcadeGameProps } from '../arcade-catalog';
import { arcadeSfx } from '../arcade-sfx';

type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
type Rotation = 0 | 1 | 2 | 3;
type GameStatus = 'idle' | 'playing' | 'paused' | 'gameover';

interface ActivePiece {
  type: PieceType;
  rot: Rotation;
  x: number;
  y: number;
}

interface LineFlash {
  rows: number[];
  elapsedMs: number;
  durationMs: number;
}

interface HardDropBeam {
  columns: { x: number; startVr: number; endVr: number }[];
  fill: string;
  hi: string;
  elapsedMs: number;
  durationMs: number;
}

interface LockSheen {
  cells: [number, number][];
  elapsedMs: number;
  durationMs: number;
}

interface CrystalParticle {
  x: number; // grid units (0..COLS)
  y: number; // visible row units (0..VISIBLE_ROWS)
  vx: number;
  vy: number;
  size: number; // fraction of cell
  rot: number;
  vrot: number;
  fill: string;
  hi: string;
  elapsedMs: number;
  durationMs: number;
}

interface CalloutBadge {
  title: string;
  subtitle?: string;
  accent: 'default' | 'gold' | 'terracotta';
  elapsedMs: number;
  durationMs: number;
}

interface TetrisHudState {
  status: GameStatus;
  score: number;
  lines: number;
  level: number;
  hold: PieceType | null;
  canHold: boolean;
  next: PieceType[];
  combo: number;
  b2b: boolean;
  dangerActive: boolean;
  lastCallout: string | null;
}

const COLS = 10;
const VISIBLE_ROWS = 20;
const BUFFER_ROWS = 2;
const TOTAL_ROWS = VISIBLE_ROWS + BUFFER_ROWS;
const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 15;
const DAS_MS = 145;
const ARR_MS = 42;
const SOFT_DROP_INTERVAL_MS = 45;
const MAX_REPORTED_SCORE = 2_000_000;

const PIECE_TYPES: readonly PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

const PIECE_PALETTE: Record<
  PieceType,
  {
    fill: string;
    core: string;
    hi: string;
    midHi: string;
    lo: string;
    deepLo: string;
    stroke: string;
    glow: string;
    label: string;
  }
> = {
  I: {
    fill: '#4794bf',
    core: '#2c688c',
    hi: '#9ad4f5',
    midHi: '#6cb3db',
    lo: '#255573',
    deepLo: '#16354a',
    stroke: '#a8dcf7',
    glow: 'rgba(138, 198, 240, 0.24)',
    label: '轨道冰蓝',
  },
  O: {
    fill: '#c49d46',
    core: '#947126',
    hi: '#f2d994',
    midHi: '#dbb863',
    lo: '#755618',
    deepLo: '#4a350d',
    stroke: '#f5e1a4',
    glow: 'rgba(224, 188, 102, 0.24)',
    label: '金星砂金',
  },
  T: {
    fill: '#8667bd',
    core: '#5c418f',
    hi: '#ccb5f2',
    midHi: '#a487d6',
    lo: '#483073',
    deepLo: '#2d1c4a',
    stroke: '#d6c4f5',
    glow: 'rgba(164, 135, 214, 0.24)',
    label: '星云紫灰',
  },
  S: {
    fill: '#479476',
    core: '#2c6951',
    hi: '#96dbc0',
    midHi: '#67b596',
    lo: '#21523f',
    deepLo: '#133327',
    stroke: '#a8e3cc',
    glow: 'rgba(103, 181, 150, 0.24)',
    label: '极光苔绿',
  },
  Z: {
    fill: '#bf594d',
    core: '#8f392f',
    hi: '#f0a299',
    midHi: '#d97a6f',
    lo: '#732920',
    deepLo: '#4a1711',
    stroke: '#f2b1aa',
    glow: 'rgba(217, 122, 111, 0.24)',
    label: '火星赤赭',
  },
  J: {
    fill: '#486bb5',
    core: '#2d4a8a',
    hi: '#9ab6f0',
    midHi: '#6d8ed4',
    lo: '#223a70',
    deepLo: '#142347',
    stroke: '#aec6f5',
    glow: 'rgba(122, 160, 232, 0.24)',
    label: '深海靛蓝',
  },
  L: {
    fill: '#c27a3e',
    core: '#8f5320',
    hi: '#f0bb8b',
    midHi: '#d9965b',
    lo: '#733e13',
    deepLo: '#4a2609',
    stroke: '#f5c79d',
    glow: 'rgba(217, 150, 91, 0.24)',
    label: '铜琥珀',
  },
};

// Standard SRS piece orientations (row 0 = top, +y = down)
const SHAPES: Record<PieceType, Record<Rotation, readonly (readonly [number, number])[]>> = {
  I: {
    0: [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ],
    1: [
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
    ],
    2: [
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
    ],
    3: [
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ],
  },
  O: {
    0: [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
    1: [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
    2: [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
    3: [
      [1, 0],
      [2, 0],
      [1, 1],
      [2, 1],
    ],
  },
  T: {
    0: [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    1: [
      [1, 0],
      [1, 1],
      [2, 1],
      [1, 2],
    ],
    2: [
      [0, 1],
      [1, 1],
      [2, 1],
      [1, 2],
    ],
    3: [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, 2],
    ],
  },
  S: {
    0: [
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
    ],
    1: [
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
    ],
    2: [
      [1, 1],
      [2, 1],
      [0, 2],
      [1, 2],
    ],
    3: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 2],
    ],
  },
  Z: {
    0: [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
    ],
    1: [
      [2, 0],
      [1, 1],
      [2, 1],
      [1, 2],
    ],
    2: [
      [0, 1],
      [1, 1],
      [1, 2],
      [2, 2],
    ],
    3: [
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
    ],
  },
  J: {
    0: [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    1: [
      [1, 0],
      [2, 0],
      [1, 1],
      [1, 2],
    ],
    2: [
      [0, 1],
      [1, 1],
      [2, 1],
      [2, 2],
    ],
    3: [
      [1, 0],
      [1, 1],
      [0, 2],
      [1, 2],
    ],
  },
  L: {
    0: [
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ],
    1: [
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 2],
    ],
    2: [
      [0, 1],
      [1, 1],
      [2, 1],
      [0, 2],
    ],
    3: [
      [0, 0],
      [1, 0],
      [1, 1],
      [1, 2],
    ],
  },
};

// Standard SRS wall kick tables adapted to +y = down grid coordinates
const JLSTZ_KICKS: Record<string, readonly (readonly [number, number])[]> = {
  '0>1': [
    [0, 0],
    [-1, 0],
    [-1, -1],
    [0, 2],
    [-1, 2],
  ],
  '1>0': [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, -2],
    [1, -2],
  ],
  '1>2': [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, -2],
    [1, -2],
  ],
  '2>1': [
    [0, 0],
    [-1, 0],
    [-1, -1],
    [0, 2],
    [-1, 2],
  ],
  '2>3': [
    [0, 0],
    [1, 0],
    [1, -1],
    [0, 2],
    [1, 2],
  ],
  '3>2': [
    [0, 0],
    [-1, 0],
    [-1, 1],
    [0, -2],
    [-1, -2],
  ],
  '3>0': [
    [0, 0],
    [-1, 0],
    [-1, 1],
    [0, -2],
    [-1, -2],
  ],
  '0>3': [
    [0, 0],
    [1, 0],
    [1, -1],
    [0, 2],
    [1, 2],
  ],
};

const I_KICKS: Record<string, readonly (readonly [number, number])[]> = {
  '0>1': [
    [0, 0],
    [-2, 0],
    [1, 0],
    [-2, 1],
    [1, -2],
  ],
  '1>0': [
    [0, 0],
    [2, 0],
    [-1, 0],
    [2, -1],
    [-1, 2],
  ],
  '1>2': [
    [0, 0],
    [-1, 0],
    [2, 0],
    [-1, -2],
    [2, 1],
  ],
  '2>1': [
    [0, 0],
    [1, 0],
    [-2, 0],
    [1, 2],
    [-2, -1],
  ],
  '2>3': [
    [0, 0],
    [2, 0],
    [-1, 0],
    [2, -1],
    [-1, 2],
  ],
  '3>2': [
    [0, 0],
    [-2, 0],
    [1, 0],
    [-2, 1],
    [1, -2],
  ],
  '3>0': [
    [0, 0],
    [1, 0],
    [-2, 0],
    [1, 2],
    [-2, -1],
  ],
  '0>3': [
    [0, 0],
    [-1, 0],
    [2, 0],
    [-1, -2],
    [2, 1],
  ],
};

function createEmptyBoard(): (PieceType | null)[][] {
  return Array.from({ length: TOTAL_ROWS }, () => Array<PieceType | null>(COLS).fill(null));
}

function createShuffledBag(): PieceType[] {
  const bag: PieceType[] = [...PIECE_TYPES];
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }
  return bag;
}

function gravityIntervalMs(level: number): number {
  const clamped = Math.max(1, Math.min(20, level));
  return Math.max(55, Math.round(Math.pow(0.8 - (clamped - 1) * 0.007, clamped - 1) * 1000));
}

function collides(
  board: (PieceType | null)[][],
  type: PieceType,
  rot: Rotation,
  px: number,
  py: number,
): boolean {
  const cells = SHAPES[type][rot];
  for (let i = 0; i < cells.length; i += 1) {
    const cx = px + cells[i][0];
    const cy = py + cells[i][1];
    if (cx < 0 || cx >= COLS || cy >= TOTAL_ROWS) return true;
    if (cy >= 0 && board[cy][cx] !== null) return true;
  }
  return false;
}

function computeGhostY(board: (PieceType | null)[][], piece: ActivePiece): number {
  let gy = piece.y;
  while (!collides(board, piece.type, piece.rot, piece.x, gy + 1)) {
    gy += 1;
  }
  return gy;
}

function isTopDangerActive(board: (PieceType | null)[][]): boolean {
  for (let r = BUFFER_ROWS; r < BUFFER_ROWS + 4; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      if (board[r][c] !== null) return true;
    }
  }
  return false;
}

function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function PiecePreview({
  type,
  dimmed = false,
  compact = false,
}: {
  type: PieceType | null;
  dimmed?: boolean;
  compact?: boolean;
}) {
  if (!type) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl border border-hairline bg-paper/60 ${
          compact ? 'h-9 w-12' : 'h-12 w-[68px]'
        }`}
      >
        <span className="tabular-nums-mono text-[11px] text-ink-muted">—</span>
      </div>
    );
  }

  const cells = SHAPES[type][0];
  let minX = 4;
  let maxX = 0;
  let minY = 4;
  let maxY = 0;
  for (const [cx, cy] of cells) {
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const palette = PIECE_PALETTE[type];
  const cellSize = compact ? 9.5 : 13;
  const gap = 1.5;
  const b = compact ? 1.8 : 2.5;
  const svgW = w * cellSize + (w - 1) * gap;
  const svgH = h * cellSize + (h - 1) * gap;

  return (
    <div
      className={`flex items-center justify-center rounded-xl border border-hairline bg-[#0b0c0e] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-opacity ${
        compact ? 'h-9 w-12' : 'h-12 w-[68px]'
      } ${dimmed ? 'opacity-40' : 'opacity-100'}`}
    >
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        aria-label={palette.label}
        role="img"
      >
        {cells.map(([cx, cy], idx) => {
          const rx = (cx - minX) * (cellSize + gap);
          const ry = (cy - minY) * (cellSize + gap);
          const s = cellSize;
          return (
            <g key={idx}>
              {/* Obsidian crystal base */}
              <rect x={rx} y={ry} width={s} height={s} rx={1.6} fill={palette.fill} />
              {/* Top specular chamfer facet */}
              <polygon
                points={`${rx},${ry} ${rx + s},${ry} ${rx + s - b},${ry + b} ${rx + b},${ry + b}`}
                fill={palette.hi}
                fillOpacity={0.78}
              />
              {/* Left chamfer facet */}
              <polygon
                points={`${rx},${ry} ${rx + b},${ry + b} ${rx + b},${ry + s - b} ${rx},${ry + s}`}
                fill={palette.midHi}
                fillOpacity={0.62}
              />
              {/* Right shadow facet */}
              <polygon
                points={`${rx + s},${ry} ${rx + s},${ry + s} ${rx + s - b},${ry + s - b} ${rx + s - b},${ry + b}`}
                fill={palette.lo}
                fillOpacity={0.82}
              />
              {/* Bottom deep shadow facet */}
              <polygon
                points={`${rx},${ry + s} ${rx + b},${ry + s - b} ${rx + s - b},${ry + s - b} ${rx + s},${ry + s}`}
                fill={palette.deepLo}
                fillOpacity={0.92}
              />
              {/* Recessed inner crystal lattice core */}
              <rect
                x={rx + b}
                y={ry + b}
                width={s - b * 2}
                height={s - b * 2}
                rx={0.8}
                fill={palette.core}
              />
              {/* Diagonal glass glint */}
              <polygon
                points={`${rx + b},${ry + b} ${rx + s - b},${ry + b} ${rx + b},${ry + s - b}`}
                fill="#ffffff"
                fillOpacity={0.14}
              />
              {/* Outer fine crystal rim */}
              <rect
                x={rx + 0.35}
                y={ry + 0.35}
                width={s - 0.7}
                height={s - 0.7}
                rx={1.5}
                fill="none"
                stroke={palette.stroke}
                strokeOpacity={0.5}
                strokeWidth={0.7}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface EngineState {
  status: GameStatus;
  board: (PieceType | null)[][];
  bag: PieceType[];
  active: ActivePiece | null;
  hold: PieceType | null;
  canHold: boolean;
  score: number;
  lines: number;
  level: number;
  combo: number;
  b2b: boolean;
  fallAccumMs: number;
  lockTimerMs: number;
  lockResets: number;
  lowestY: number;
  lastActionWasRotate: boolean;
  startTimeMs: number;
  pausedAccumMs: number;
  pauseStartedMs: number | null;
  lineFlashes: LineFlash[];
  hardDropBeams: HardDropBeam[];
  lockSheens: LockSheen[];
  particles: CrystalParticle[];
  boardBounceY: number;
  boardBounceVel: number;
  dangerActive: boolean;
  callout: CalloutBadge | null;
  runReported: boolean;
}

function createInitialEngine(): EngineState {
  const bag = [...createShuffledBag(), ...createShuffledBag()];
  return {
    status: 'idle',
    board: createEmptyBoard(),
    bag,
    active: null,
    hold: null,
    canHold: true,
    score: 0,
    lines: 0,
    level: 1,
    combo: -1,
    b2b: false,
    fallAccumMs: 0,
    lockTimerMs: 0,
    lockResets: 0,
    lowestY: 0,
    lastActionWasRotate: false,
    startTimeMs: 0,
    pausedAccumMs: 0,
    pauseStartedMs: null,
    lineFlashes: [],
    hardDropBeams: [],
    lockSheens: [],
    particles: [],
    boardBounceY: 0,
    boardBounceVel: 0,
    dangerActive: false,
    callout: null,
    runReported: false,
  };
}

export default function GravityTetrisGame({
  onRunFinished,
  bestScore,
  muted,
}: ArcadeGameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<EngineState>(createInitialEngine());
  const onRunFinishedRef = useRef(onRunFinished);
  const mutedRef = useRef(muted);

  const heldMoveRef = useRef<{
    dir: -1 | 1 | 0;
    elapsedMs: number;
    repeatMs: number;
    softDrop: boolean;
    softDropMs: number;
  }>({
    dir: 0,
    elapsedMs: 0,
    repeatMs: 0,
    softDrop: false,
    softDropMs: 0,
  });

  const touchRepeatRef = useRef<number | null>(null);

  const [hud, setHud] = useState<TetrisHudState>(() => ({
    status: 'idle',
    score: 0,
    lines: 0,
    level: 1,
    hold: null,
    canHold: true,
    next: engineRef.current.bag.slice(0, 3),
    combo: -1,
    b2b: false,
    dangerActive: false,
    lastCallout: null,
  }));

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

  const syncHud = useCallback(() => {
    const s = engineRef.current;
    setHud({
      status: s.status,
      score: s.score,
      lines: s.lines,
      level: s.level,
      hold: s.hold,
      canHold: s.canHold,
      next: s.bag.slice(0, 3),
      combo: s.combo,
      b2b: s.b2b,
      dangerActive: s.dangerActive,
      lastCallout: s.callout ? s.callout.title : null,
    });
  }, []);

  const clearHeldInputs = useCallback(() => {
    heldMoveRef.current = {
      dir: 0,
      elapsedMs: 0,
      repeatMs: 0,
      softDrop: false,
      softDropMs: 0,
    };
  }, []);

  const triggerGameOver = useCallback(() => {
    const s = engineRef.current;
    if (s.status === 'gameover') return;
    s.status = 'gameover';
    clearHeldInputs();
    playSound(arcadeSfx.gameOver);
    syncHud();
    if (!s.runReported) {
      s.runReported = true;
      const now = performance.now();
      const durationMs = Math.max(0, Math.round(now - s.startTimeMs - s.pausedAccumMs));
      const reportedScore = Math.min(MAX_REPORTED_SCORE, Math.max(0, Math.round(s.score)));
      onRunFinishedRef.current({
        score: reportedScore,
        durationMs,
        meta: {
          lines: s.lines,
          level: s.level,
        },
      });
    }
  }, [clearHeldInputs, playSound, syncHud]);

  const refillBag = (s: EngineState) => {
    while (s.bag.length < 7) {
      s.bag.push(...createShuffledBag());
    }
  };

  const spawnPiece = useCallback(
    (forcedType?: PieceType): boolean => {
      const s = engineRef.current;
      refillBag(s);
      const nextType = forcedType ?? (s.bag.shift() as PieceType);
      refillBag(s);

      const spawnX = 3;
      const preferredY = nextType === 'I' ? BUFFER_ROWS - 1 : BUFFER_ROWS;
      let spawnY = preferredY;

      if (collides(s.board, nextType, 0, spawnX, spawnY)) {
        if (!collides(s.board, nextType, 0, spawnX, spawnY - 1)) {
          spawnY -= 1;
        } else {
          s.active = { type: nextType, rot: 0, x: spawnX, y: preferredY };
          triggerGameOver();
          return false;
        }
      }

      s.active = { type: nextType, rot: 0, x: spawnX, y: spawnY };
      s.fallAccumMs = 0;
      s.lockTimerMs = 0;
      s.lockResets = 0;
      s.lowestY = spawnY;
      s.lastActionWasRotate = false;
      return true;
    },
    [triggerGameOver],
  );

  const lockActivePiece = useCallback(
    (fromHardDrop = false) => {
      const s = engineRef.current;
      const piece = s.active;
      if (!piece || s.status !== 'playing') return;

      // 3-corner T-Spin check before writing piece into board
      let isTSpin = false;
      if (piece.type === 'T' && s.lastActionWasRotate) {
        const cx = piece.x + 1;
        const cy = piece.y + 1;
        const corners: readonly [number, number][] = [
          [cx - 1, cy - 1],
          [cx + 1, cy - 1],
          [cx - 1, cy + 1],
          [cx + 1, cy + 1],
        ];
        let occupied = 0;
        for (const [kx, ky] of corners) {
          if (kx < 0 || kx >= COLS || ky >= TOTAL_ROWS) {
            occupied += 1;
          } else if (ky >= 0 && s.board[ky][kx] !== null) {
            occupied += 1;
          }
        }
        isTSpin = occupied >= 3;
      }

      const cells = SHAPES[piece.type][piece.rot];
      const lockedVisibleCells: [number, number][] = [];
      let allAboveVisible = true;
      for (const [dx, dy] of cells) {
        const gx = piece.x + dx;
        const gy = piece.y + dy;
        if (gy >= BUFFER_ROWS) {
          allAboveVisible = false;
          lockedVisibleCells.push([gx, gy - BUFFER_ROWS]);
        }
        if (gy >= 0 && gy < TOTAL_ROWS && gx >= 0 && gx < COLS) {
          s.board[gy][gx] = piece.type;
        }
      }

      if (allAboveVisible) {
        s.active = null;
        triggerGameOver();
        return;
      }

      // Trigger crisp platinum sheen across locked crystal blocks
      if (lockedVisibleCells.length > 0) {
        s.lockSheens.push({
          cells: lockedVisibleCells,
          elapsedMs: 0,
          durationMs: 260,
        });
      }

      // Detect full rows
      const clearedRows: number[] = [];
      for (let r = 0; r < TOTAL_ROWS; r += 1) {
        if (s.board[r].every((cell) => cell !== null)) {
          clearedRows.push(r);
        }
      }

      const clearedCount = clearedRows.length;
      if (clearedCount > 0) {
        const clearedVisibleRows = clearedRows
          .map((r) => r - BUFFER_ROWS)
          .filter((vr) => vr >= 0);

        s.lineFlashes.push({
          rows: clearedVisibleRows,
          elapsedMs: 0,
          durationMs: 260,
        });

        // Spawn crystal shard particles from every cleared tile before collapsing
        if (!prefersReducedMotion()) {
          for (const r of clearedRows) {
            const vr = r - BUFFER_ROWS;
            if (vr < 0) continue;
            for (let c = 0; c < COLS; c += 1) {
              const cellType = s.board[r][c];
              if (!cellType) continue;
              const palette = PIECE_PALETTE[cellType];
              const shardCount = clearedCount >= 4 ? 4 : 3;
              for (let k = 0; k < shardCount; k += 1) {
                const angle =
                  (Math.random() - 0.5) * Math.PI * 1.15 - Math.PI * 0.5 + (c - 4.5) * 0.08;
                const speed = 2.4 + Math.random() * 4.8;
                s.particles.push({
                  x: c + 0.25 + Math.random() * 0.5,
                  y: vr + 0.25 + Math.random() * 0.5,
                  vx: Math.cos(angle) * speed,
                  vy: Math.sin(angle) * speed - 0.8,
                  size: 0.16 + Math.random() * 0.18,
                  rot: Math.random() * Math.PI * 2,
                  vrot: (Math.random() - 0.5) * 11,
                  fill: palette.fill,
                  hi: palette.hi,
                  elapsedMs: 0,
                  durationMs: 360 + Math.random() * 240,
                });
              }
            }
          }
          if (s.particles.length > 160) {
            s.particles.splice(0, s.particles.length - 160);
          }
        }

        const remaining = s.board.filter((_, r) => !clearedRows.includes(r));
        while (remaining.length < TOTAL_ROWS) {
          remaining.unshift(Array<PieceType | null>(COLS).fill(null));
        }
        s.board = remaining;

        if (clearedCount >= 4 && !fromHardDrop && !prefersReducedMotion()) {
          s.boardBounceY = Math.max(s.boardBounceY, 2.2);
          s.boardBounceVel = Math.max(s.boardBounceVel, 28);
        }
      }

      s.dangerActive = isTopDangerActive(s.board);

      // Scoring: Guideline Base + T-Spin + B2B + Combo
      let basePoints = 0;
      let calloutTitle = '';
      let calloutAccent: CalloutBadge['accent'] = 'default';
      const isDifficultClear = (isTSpin && clearedCount > 0) || clearedCount === 4;

      if (isTSpin) {
        calloutAccent = 'terracotta';
        if (clearedCount === 0) {
          basePoints = 400;
          calloutTitle = 'T-SPIN';
        } else if (clearedCount === 1) {
          basePoints = 800;
          calloutTitle = 'T-SPIN SINGLE';
        } else if (clearedCount === 2) {
          basePoints = 1200;
          calloutTitle = 'T-SPIN DOUBLE';
        } else {
          basePoints = 1600;
          calloutTitle = 'T-SPIN TRIPLE';
        }
      } else if (clearedCount === 1) {
        basePoints = 100;
        calloutTitle = 'SINGLE';
      } else if (clearedCount === 2) {
        basePoints = 300;
        calloutTitle = 'DOUBLE';
      } else if (clearedCount === 3) {
        basePoints = 500;
        calloutTitle = 'TRIPLE';
        calloutAccent = 'gold';
      } else if (clearedCount === 4) {
        basePoints = 800;
        calloutTitle = 'TETRIS';
        calloutAccent = 'gold';
      }

      let gained = basePoints * s.level;
      let b2bTriggered = false;

      if (clearedCount > 0) {
        if (isDifficultClear && s.b2b) {
          gained = Math.round(gained * 1.5);
          b2bTriggered = true;
        }
        s.b2b = isDifficultClear;
        s.combo += 1;
        if (s.combo >= 1) {
          gained += 50 * s.combo * s.level;
        }
        s.lines += clearedCount;
        s.level = Math.floor(s.lines / 10) + 1;

        if (fromHardDrop) {
          playSound(arcadeSfx.thud);
        }
        if (s.combo >= 1) {
          playSound(() => arcadeSfx.combo(s.combo));
        } else if (clearedCount === 4 || isTSpin) {
          playSound(arcadeSfx.win);
        } else {
          playSound(arcadeSfx.clear);
        }
      } else {
        s.combo = -1;
        if (fromHardDrop) {
          playSound(arcadeSfx.thud);
        } else if (isTSpin) {
          playSound(arcadeSfx.pickup);
        } else {
          playSound(arcadeSfx.bounce);
        }
      }

      if (gained > 0) {
        s.score = Math.min(MAX_REPORTED_SCORE, s.score + gained);
      }

      if (calloutTitle) {
        const subParts: string[] = [];
        if (b2bTriggered) subParts.push('B2B ×1.5');
        if (s.combo >= 1) subParts.push(`COMBO ×${s.combo}`);
        subParts.push(`+${gained}`);
        s.callout = {
          title: calloutTitle,
          subtitle: subParts.join(' · '),
          accent: calloutAccent,
          elapsedMs: 0,
          durationMs: 1250,
        };
      }

      s.canHold = true;
      s.active = null;
      spawnPiece();
      syncHud();
    },
    [playSound, spawnPiece, syncHud, triggerGameOver],
  );

  const tryMoveHorizontal = useCallback(
    (dx: -1 | 1): boolean => {
      const s = engineRef.current;
      const piece = s.active;
      if (!piece || s.status !== 'playing') return false;
      if (collides(s.board, piece.type, piece.rot, piece.x + dx, piece.y)) {
        return false;
      }
      piece.x += dx;
      s.lastActionWasRotate = false;
      if (collides(s.board, piece.type, piece.rot, piece.x, piece.y + 1)) {
        if (s.lockResets < MAX_LOCK_RESETS) {
          s.lockTimerMs = 0;
          s.lockResets += 1;
        }
      }
      playSound(arcadeSfx.click);
      return true;
    },
    [playSound],
  );

  const tryStepDown = useCallback(
    (isSoftDrop: boolean): boolean => {
      const s = engineRef.current;
      const piece = s.active;
      if (!piece || s.status !== 'playing') return false;
      if (collides(s.board, piece.type, piece.rot, piece.x, piece.y + 1)) {
        return false;
      }
      piece.y += 1;
      s.fallAccumMs = 0;
      s.lastActionWasRotate = false;
      if (piece.y > s.lowestY) {
        s.lowestY = piece.y;
        s.lockResets = 0;
        s.lockTimerMs = 0;
      }
      if (isSoftDrop) {
        s.score = Math.min(MAX_REPORTED_SCORE, s.score + 1);
        syncHud();
      }
      return true;
    },
    [syncHud],
  );

  const tryRotate = useCallback(
    (dir: 1 | -1): boolean => {
      const s = engineRef.current;
      const piece = s.active;
      if (!piece || s.status !== 'playing') return false;
      const nextRot = (((piece.rot + dir) % 4 + 4) % 4) as Rotation;
      if (piece.type === 'O') {
        piece.rot = nextRot;
        return true;
      }
      const key = `${piece.rot}>${nextRot}`;
      const kickTable = piece.type === 'I' ? I_KICKS[key] : JLSTZ_KICKS[key];
      const kicks = kickTable ?? ([[0, 0]] as const);

      for (let i = 0; i < kicks.length; i += 1) {
        const [kx, ky] = kicks[i];
        if (!collides(s.board, piece.type, nextRot, piece.x + kx, piece.y + ky)) {
          piece.x += kx;
          piece.y += ky;
          piece.rot = nextRot;
          s.lastActionWasRotate = true;
          if (piece.y > s.lowestY) {
            s.lowestY = piece.y;
            s.lockResets = 0;
            s.lockTimerMs = 0;
          } else if (collides(s.board, piece.type, piece.rot, piece.x, piece.y + 1)) {
            if (s.lockResets < MAX_LOCK_RESETS) {
              s.lockTimerMs = 0;
              s.lockResets += 1;
            }
          }
          playSound(arcadeSfx.click);
          return true;
        }
      }
      return false;
    },
    [playSound],
  );

  const hardDrop = useCallback(() => {
    const s = engineRef.current;
    const piece = s.active;
    if (!piece || s.status !== 'playing') return;
    const startY = piece.y;
    const gy = computeGhostY(s.board, piece);
    const dist = Math.max(0, gy - startY);

    if (dist > 0) {
      // Build per-column vertical beam bounds for crisp hard-drop trail
      const colRanges = new Map<number, { startVr: number; endVr: number }>();
      const cells = SHAPES[piece.type][piece.rot];
      for (const [dx, dy] of cells) {
        const col = piece.x + dx;
        const topVr = Math.max(0, startY + dy - BUFFER_ROWS);
        const botVr = Math.min(VISIBLE_ROWS, gy + dy - BUFFER_ROWS + 1);
        const existing = colRanges.get(col);
        if (!existing) {
          colRanges.set(col, { startVr: topVr, endVr: botVr });
        } else {
          existing.startVr = Math.min(existing.startVr, topVr);
          existing.endVr = Math.max(existing.endVr, botVr);
        }
      }

      const palette = PIECE_PALETTE[piece.type];
      s.hardDropBeams.push({
        columns: Array.from(colRanges.entries()).map(([x, r]) => ({
          x,
          startVr: r.startVr,
          endVr: r.endVr,
        })),
        fill: palette.fill,
        hi: palette.hi,
        elapsedMs: 0,
        durationMs: 240,
      });

      piece.y = gy;
      s.lastActionWasRotate = false;
      s.score = Math.min(MAX_REPORTED_SCORE, s.score + dist * 2);
    }

    // Damped 3-4px gravity-well seat bounce
    if (!prefersReducedMotion()) {
      s.boardBounceY = 3.6;
      s.boardBounceVel = 46;
    }

    lockActivePiece(true);
  }, [lockActivePiece]);

  const holdCurrentPiece = useCallback(() => {
    const s = engineRef.current;
    const piece = s.active;
    if (!piece || s.status !== 'playing' || !s.canHold) return;
    const currentType = piece.type;
    const previousHold = s.hold;
    s.hold = currentType;
    s.canHold = false;
    playSound(arcadeSfx.pickup);
    if (previousHold) {
      spawnPiece(previousHold);
    } else {
      spawnPiece();
    }
    syncHud();
  }, [playSound, spawnPiece, syncHud]);

  const startNewRun = useCallback(() => {
    clearHeldInputs();
    const fresh = createInitialEngine();
    fresh.status = 'playing';
    fresh.startTimeMs = performance.now();
    engineRef.current = fresh;
    if (stageRef.current) {
      stageRef.current.style.transform = '';
    }
    spawnPiece();
    playSound(arcadeSfx.pickup);
    syncHud();
  }, [clearHeldInputs, playSound, spawnPiece, syncHud]);

  const togglePause = useCallback(() => {
    const s = engineRef.current;
    if (s.status === 'playing') {
      s.status = 'paused';
      s.pauseStartedMs = performance.now();
      clearHeldInputs();
      syncHud();
    } else if (s.status === 'paused') {
      if (s.pauseStartedMs !== null) {
        s.pausedAccumMs += performance.now() - s.pauseStartedMs;
        s.pauseStartedMs = null;
      }
      s.status = 'playing';
      syncHud();
    }
  }, [clearHeldInputs, syncHud]);

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableElement(document.activeElement)) return;
      const s = engineRef.current;

      if (
        (e.code === 'KeyP' || e.code === 'Escape') &&
        (s.status === 'playing' || s.status === 'paused')
      ) {
        if (!e.repeat) {
          e.preventDefault();
          togglePause();
        }
        return;
      }

      if (s.status !== 'playing') return;

      const isArrowOrSpace =
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === ' ' ||
        e.code === 'Space';

      if (isArrowOrSpace) {
        e.preventDefault();
      }

      if (e.key === 'ArrowLeft' || e.code === 'KeyA') {
        if (!e.repeat) {
          tryMoveHorizontal(-1);
          heldMoveRef.current.dir = -1;
          heldMoveRef.current.elapsedMs = 0;
          heldMoveRef.current.repeatMs = 0;
        }
      } else if (e.key === 'ArrowRight' || e.code === 'KeyD') {
        if (!e.repeat) {
          tryMoveHorizontal(1);
          heldMoveRef.current.dir = 1;
          heldMoveRef.current.elapsedMs = 0;
          heldMoveRef.current.repeatMs = 0;
        }
      } else if (e.key === 'ArrowDown' || e.code === 'KeyS') {
        if (!e.repeat) {
          tryStepDown(true);
          heldMoveRef.current.softDrop = true;
          heldMoveRef.current.softDropMs = 0;
        }
      } else if (e.code === 'Space' || e.key === ' ') {
        if (!e.repeat) {
          hardDrop();
        }
      } else if (e.key === 'ArrowUp' || e.code === 'KeyX') {
        if (!e.repeat) {
          tryRotate(1);
        }
      } else if (e.code === 'KeyZ') {
        if (!e.repeat) {
          tryRotate(-1);
        }
      } else if (e.code === 'KeyC' || e.key === 'Shift') {
        if (!e.repeat) {
          holdCurrentPiece();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowLeft' || e.code === 'KeyA') && heldMoveRef.current.dir === -1) {
        heldMoveRef.current.dir = 0;
      } else if ((e.key === 'ArrowRight' || e.code === 'KeyD') && heldMoveRef.current.dir === 1) {
        heldMoveRef.current.dir = 0;
      } else if (e.key === 'ArrowDown' || e.code === 'KeyS') {
        heldMoveRef.current.softDrop = false;
      }
    };

    const handleBlur = () => {
      clearHeldInputs();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [
    clearHeldInputs,
    hardDrop,
    holdCurrentPiece,
    togglePause,
    tryMoveHorizontal,
    tryRotate,
    tryStepDown,
  ]);

  // Main requestAnimationFrame loop + Faceted Obsidian Crystal Renderer
  useEffect(() => {
    let rafId = 0;
    let lastTs = performance.now();

    const drawCrystalTile = (
      ctx: CanvasRenderingContext2D,
      gx: number,
      gy: number,
      cellSize: number,
      type: PieceType,
      options?: { alpha?: number; lockRatio?: number; isActive?: boolean },
    ) => {
      const alpha = options?.alpha ?? 1;
      const lockRatio = options?.lockRatio ?? 0;
      const isActive = options?.isActive ?? false;
      const palette = PIECE_PALETTE[type];
      const pad = Math.max(1, cellSize * 0.045);
      const x = gx * cellSize + pad;
      const y = gy * cellSize + pad;
      const size = cellSize - pad * 2;
      const bevel = Math.max(2.4, size * 0.19);
      const radius = Math.max(1.8, size * 0.11);

      ctx.save();
      ctx.globalAlpha = alpha;

      // Subtle restrained ambient aura behind current falling crystal piece
      if (isActive) {
        ctx.save();
        ctx.shadowColor = palette.glow;
        ctx.shadowBlur = Math.max(6, cellSize * 0.36);
        ctx.fillStyle = palette.fill;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, size - 2, size - 2, radius);
        ctx.fill();
        ctx.restore();
      }

      // Clip inside crisp rounded crystal profile
      ctx.beginPath();
      ctx.roundRect(x, y, size, size, radius);
      ctx.clip();

      // Base mineral body
      ctx.fillStyle = palette.fill;
      ctx.fillRect(x, y, size, size);

      // Top bright specular chamfer facet
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x + size - bevel, y + bevel);
      ctx.lineTo(x + bevel, y + bevel);
      ctx.closePath();
      ctx.fillStyle = palette.hi;
      ctx.globalAlpha = alpha * 0.82;
      ctx.fill();

      // Left sunlit chamfer facet
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + bevel, y + bevel);
      ctx.lineTo(x + bevel, y + size - bevel);
      ctx.lineTo(x, y + size);
      ctx.closePath();
      ctx.fillStyle = palette.midHi;
      ctx.globalAlpha = alpha * 0.65;
      ctx.fill();

      // Right shaded chamfer facet
      ctx.beginPath();
      ctx.moveTo(x + size, y);
      ctx.lineTo(x + size, y + size);
      ctx.lineTo(x + size - bevel, y + size - bevel);
      ctx.lineTo(x + size - bevel, y + bevel);
      ctx.closePath();
      ctx.fillStyle = palette.lo;
      ctx.globalAlpha = alpha * 0.84;
      ctx.fill();

      // Bottom deep shadow chamfer facet
      ctx.beginPath();
      ctx.moveTo(x, y + size);
      ctx.lineTo(x + bevel, y + size - bevel);
      ctx.lineTo(x + size - bevel, y + size - bevel);
      ctx.lineTo(x + size, y + size);
      ctx.closePath();
      ctx.fillStyle = palette.deepLo;
      ctx.globalAlpha = alpha * 0.94;
      ctx.fill();

      // Embedded inner crystal lattice face
      const innerX = x + bevel;
      const innerY = y + bevel;
      const innerSize = Math.max(2, size - bevel * 2);
      const coreGrad = ctx.createLinearGradient(innerX, innerY, innerX + innerSize, innerY + innerSize);
      coreGrad.addColorStop(0, palette.fill);
      coreGrad.addColorStop(1, palette.core);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = coreGrad;
      ctx.fillRect(innerX, innerY, innerSize, innerSize);

      // Subtle diagonal glass specular reflection band
      ctx.beginPath();
      ctx.moveTo(x + size * 0.08, y);
      ctx.lineTo(x + size * 0.56, y);
      ctx.lineTo(x, y + size * 0.56);
      ctx.lineTo(x, y + size * 0.08);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = alpha * 0.14;
      ctx.fill();

      // Fine inner crystal facet frame + center micro-lattice diamond
      ctx.globalAlpha = alpha * 0.45;
      ctx.strokeStyle = palette.hi;
      ctx.lineWidth = 0.85;
      ctx.strokeRect(innerX + 0.4, innerY + 0.4, innerSize - 0.8, innerSize - 0.8);

      const cx = x + size / 2;
      const cy = y + size / 2;
      const d = Math.max(1.5, innerSize * 0.16);
      ctx.beginPath();
      ctx.moveTo(cx, cy - d);
      ctx.lineTo(cx + d, cy);
      ctx.lineTo(cx, cy + d);
      ctx.lineTo(cx - d, cy);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = alpha * 0.24;
      ctx.fill();

      // Lock-delay platinum highlight tension when grounded
      if (lockRatio > 0.04) {
        ctx.globalAlpha = alpha * Math.min(0.36, lockRatio * 0.36);
        ctx.fillStyle = '#f2f6ff';
        ctx.fillRect(x, y, size, size);
      }

      ctx.restore();

      // Crisp outer optical crystal rim
      ctx.save();
      ctx.globalAlpha = alpha * (isActive ? 0.82 : 0.58);
      ctx.strokeStyle = palette.stroke;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.roundRect(x + 0.45, y + 0.45, size - 0.9, size - 0.9, radius);
      ctx.stroke();
      ctx.restore();
    };

    const drawGhostCell = (
      ctx: CanvasRenderingContext2D,
      gx: number,
      gy: number,
      cellSize: number,
      type: PieceType,
    ) => {
      const palette = PIECE_PALETTE[type];
      const pad = Math.max(1.5, cellSize * 0.075);
      const x = gx * cellSize + pad;
      const y = gy * cellSize + pad;
      const size = cellSize - pad * 2;
      const arm = Math.max(3.5, size * 0.24);

      ctx.save();
      // Restrained tinted core fill
      ctx.fillStyle = palette.fill;
      ctx.globalAlpha = 0.11;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, size - 2, size - 2, 2);
      ctx.fill();

      // Fine dashed optical outline
      ctx.globalAlpha = 0.46;
      ctx.strokeStyle = palette.stroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([2.5, 2.5]);
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      ctx.setLineDash([]);

      // Four crisp optical corner calibration brackets
      ctx.globalAlpha = 0.88;
      ctx.strokeStyle = palette.hi;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      // Top-left
      ctx.moveTo(x, y + arm);
      ctx.lineTo(x, y);
      ctx.lineTo(x + arm, y);
      // Top-right
      ctx.moveTo(x + size - arm, y);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x + size, y + arm);
      // Bottom-right
      ctx.moveTo(x + size, y + size - arm);
      ctx.lineTo(x + size, y + size);
      ctx.lineTo(x + size - arm, y + size);
      // Bottom-left
      ctx.moveTo(x + arm, y + size);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x, y + size - arm);
      ctx.stroke();
      ctx.restore();
    };

    const drawFrame = (now: number) => {
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!canvas || !stage) return;

      const rect = stage.getBoundingClientRect();
      const logicalW = Math.max(180, Math.floor(rect.width));
      const logicalH = logicalW * 2;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      const targetW = Math.round(logicalW * dpr);
      const targetH = Math.round(logicalH * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cell = logicalW / COLS;
      const s = engineRef.current;

      // Deep obsidian gravity-well backdrop
      const bgGrad = ctx.createLinearGradient(0, 0, 0, logicalH);
      bgGrad.addColorStop(0, '#0e1015');
      bgGrad.addColorStop(0.55, '#0b0c0e');
      bgGrad.addColorStop(1, '#07080b');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, logicalW, logicalH);

      // Subtle gravitational well depth field at bottom
      const wellGrad = ctx.createRadialGradient(
        logicalW / 2,
        logicalH * 1.04,
        logicalW * 0.08,
        logicalW / 2,
        logicalH * 1.04,
        logicalW * 0.88,
      );
      wellGrad.addColorStop(0, 'rgba(138, 180, 248, 0.095)');
      wellGrad.addColorStop(0.55, 'rgba(138, 180, 248, 0.025)');
      wellGrad.addColorStop(1, 'rgba(138, 180, 248, 0)');
      ctx.fillStyle = wellGrad;
      ctx.fillRect(0, 0, logicalW, logicalH);

      // Crisp 10x20 grid hairlines
      ctx.strokeStyle = 'rgba(227, 227, 227, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < COLS; c += 1) {
        const x = Math.round(c * cell) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, logicalH);
      }
      for (let r = 1; r < VISIBLE_ROWS; r += 1) {
        const y = Math.round(r * cell) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(logicalW, y);
      }
      ctx.stroke();

      // Calibrated depth guide lines every 5 rows
      ctx.strokeStyle = 'rgba(138, 180, 248, 0.11)';
      ctx.beginPath();
      for (let r = 5; r < VISIBLE_ROWS; r += 5) {
        const y = Math.round(r * cell) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(logicalW, y);
      }
      ctx.stroke();

      // Subtle top-4 breathing terracotta danger horizon when stack approaches ceiling
      if (s.dangerActive && (s.status === 'playing' || s.status === 'paused')) {
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.0052);
        const dangerY = Math.round(4 * cell) + 0.5;

        const dangerGrad = ctx.createLinearGradient(0, 0, 0, 4 * cell);
        dangerGrad.addColorStop(0, `rgba(201, 106, 72, ${(0.06 + pulse * 0.07).toFixed(3)})`);
        dangerGrad.addColorStop(1, 'rgba(201, 106, 72, 0)');
        ctx.fillStyle = dangerGrad;
        ctx.fillRect(0, 0, logicalW, 4 * cell);

        ctx.save();
        ctx.strokeStyle = `rgba(214, 159, 135, ${(0.34 + pulse * 0.44).toFixed(3)})`;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(0, dangerY);
        ctx.lineTo(logicalW, dangerY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Crisp terracotta vernier wall ticks on danger horizon
        ctx.fillStyle = `rgba(214, 159, 135, ${(0.55 + pulse * 0.4).toFixed(3)})`;
        ctx.fillRect(0, dangerY - 3, 4, 6);
        ctx.fillRect(logicalW - 4, dangerY - 3, 4, 6);
        ctx.restore();
      }

      // Hard-drop vertical light beams (behind pieces for clean depth)
      for (const beam of s.hardDropBeams) {
        const progress = Math.min(1, beam.elapsedMs / beam.durationMs);
        const easeOut = 1 - Math.pow(progress, 1.7);
        for (const col of beam.columns) {
          const bx = col.x * cell;
          const by = col.startVr * cell;
          const bh = Math.max(0, (col.endVr - col.startVr) * cell);
          if (bh <= 0) continue;

          ctx.save();
          const beamGrad = ctx.createLinearGradient(0, by, 0, by + bh);
          beamGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
          beamGrad.addColorStop(0.55, beam.fill);
          beamGrad.addColorStop(1, beam.hi);

          ctx.globalAlpha = easeOut * 0.32;
          ctx.fillStyle = beamGrad;
          ctx.fillRect(bx + 1.5, by, cell - 3, bh);

          // Crisp vertical luminous filament edges
          ctx.globalAlpha = easeOut * 0.55;
          ctx.fillStyle = beam.hi;
          ctx.fillRect(bx + 1.5, by + bh * 0.25, 1, bh * 0.75);
          ctx.fillRect(bx + cell - 2.5, by + bh * 0.25, 1, bh * 0.75);
          ctx.restore();
        }
      }

      // Idle sculpted crystal silhouette so initial canvas is rich & non-blank
      if (s.status === 'idle') {
        const cx = logicalW / 2;
        const cy = logicalH * 0.42;
        ctx.save();
        ctx.strokeStyle = 'rgba(138, 180, 248, 0.17)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 2.25, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(227, 227, 227, 0.09)';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 3.45, 0, Math.PI * 2);
        ctx.stroke();

        const previewCells: readonly [number, number][] = [
          [4, 7],
          [3, 8],
          [4, 8],
          [5, 8],
        ];
        for (const [px, py] of previewCells) {
          drawCrystalTile(ctx, px, py, cell, 'T', { alpha: 0.34 });
        }
        ctx.restore();
      }

      // Locked board faceted crystal tiles
      for (let r = BUFFER_ROWS; r < TOTAL_ROWS; r += 1) {
        const vr = r - BUFFER_ROWS;
        for (let c = 0; c < COLS; c += 1) {
          const t = s.board[r][c];
          if (t) {
            drawCrystalTile(ctx, c, vr, cell, t);
          }
        }
      }

      // Brief platinum lock sheen sweep across freshly locked blocks
      for (const sheen of s.lockSheens) {
        const progress = Math.min(1, sheen.elapsedMs / sheen.durationMs);
        const sweep = -0.6 + progress * 2.2;
        const alpha = Math.sin(progress * Math.PI) * 0.62;
        for (const [gx, vr] of sheen.cells) {
          const pad = Math.max(1, cell * 0.045);
          const x = gx * cell + pad;
          const y = vr * cell + pad;
          const size = cell - pad * 2;

          ctx.save();
          ctx.beginPath();
          ctx.roundRect(x, y, size, size, Math.max(1.8, size * 0.11));
          ctx.clip();

          const grad = ctx.createLinearGradient(
            x + size * (sweep - 0.45),
            y + size * (sweep - 0.45),
            x + size * (sweep + 0.45),
            y + size * (sweep + 0.45),
          );
          grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
          grad.addColorStop(0.5, `rgba(244, 248, 255, ${alpha.toFixed(3)})`);
          grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = grad;
          ctx.fillRect(x, y, size, size);
          ctx.restore();
        }
      }

      // Active piece + Optical Corner-Bracket Ghost Preview
      if (s.active && (s.status === 'playing' || s.status === 'paused')) {
        const piece = s.active;
        const ghostY = computeGhostY(s.board, piece);
        const cells = SHAPES[piece.type][piece.rot];

        if (ghostY > piece.y) {
          for (const [dx, dy] of cells) {
            const gx = piece.x + dx;
            const gy = ghostY + dy - BUFFER_ROWS;
            if (gy < 0 || gy >= VISIBLE_ROWS) continue;
            drawGhostCell(ctx, gx, gy, cell, piece.type);
          }
        }

        const isGrounded = collides(s.board, piece.type, piece.rot, piece.x, piece.y + 1);
        const lockRatio = isGrounded ? Math.min(1, s.lockTimerMs / LOCK_DELAY_MS) : 0;

        for (const [dx, dy] of cells) {
          const gx = piece.x + dx;
          const gy = piece.y + dy - BUFFER_ROWS;
          if (gy < 0 || gy >= VISIBLE_ROWS) continue;
          drawCrystalTile(ctx, gx, gy, cell, piece.type, {
            alpha: 1,
            lockRatio,
            isActive: true,
          });
        }

        // Lock delay progress hairline at bottom edge of well
        if (isGrounded && lockRatio > 0) {
          ctx.save();
          ctx.fillStyle = 'rgba(138, 180, 248, 0.78)';
          const barW = logicalW * (1 - lockRatio);
          ctx.fillRect((logicalW - barW) / 2, logicalH - 2.5, barW, 2.5);
          ctx.restore();
        }
      }

      // Line-clear horizontal energy sweep waves
      for (const flash of s.lineFlashes) {
        const progress = Math.min(1, flash.elapsedMs / flash.durationMs);
        const alpha = (1 - progress) * 0.85;
        const sweepWidth = logicalW * Math.min(1, 0.25 + progress * 1.15);
        const sx = (logicalW - sweepWidth) / 2;

        ctx.save();
        for (const vr of flash.rows) {
          const y = vr * cell;
          const h = cell * (1 - progress * 0.58);
          const cy = y + (cell - h) / 2;

          const rowGrad = ctx.createLinearGradient(sx, 0, sx + sweepWidth, 0);
          rowGrad.addColorStop(0, 'rgba(138, 180, 248, 0)');
          rowGrad.addColorStop(0.2, `rgba(227, 237, 252, ${(alpha * 0.85).toFixed(3)})`);
          rowGrad.addColorStop(0.5, `rgba(255, 255, 255, ${alpha.toFixed(3)})`);
          rowGrad.addColorStop(0.8, `rgba(227, 237, 252, ${(alpha * 0.85).toFixed(3)})`);
          rowGrad.addColorStop(1, 'rgba(138, 180, 248, 0)');
          ctx.fillStyle = rowGrad;
          ctx.fillRect(sx, cy, sweepWidth, h);

          // Fine central laser filament
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
          ctx.fillRect(0, y + cell / 2 - 0.75, logicalW, 1.5);
        }
        ctx.restore();
      }

      // Line-clear scattered crystal shard particles
      for (const p of s.particles) {
        const progress = Math.min(1, p.elapsedMs / p.durationMs);
        const alpha = (1 - progress) * 0.9;
        const px = p.x * cell;
        const py = p.y * cell;
        const sz = p.size * cell * (1 - progress * 0.35);

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(p.rot);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.fill;
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
        ctx.fillStyle = p.hi;
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.38);
        ctx.restore();
      }

      // Floating action callout pill (TETRIS / T-SPIN / B2B / COMBO)
      if (s.callout && s.status === 'playing') {
        const progress = Math.min(1, s.callout.elapsedMs / s.callout.durationMs);
        const alpha =
          progress < 0.14 ? progress / 0.14 : Math.max(0, 1 - (progress - 0.56) / 0.44);
        const lift = progress * 16;
        const centerX = logicalW / 2;
        const baseY = logicalH * 0.19 - lift;

        const titleSize = Math.max(11, Math.round(cell * 0.48));
        const subSize = Math.max(9.5, Math.round(cell * 0.35));
        const borderColor =
          s.callout.accent === 'gold'
            ? 'rgba(242, 217, 148, 0.55)'
            : s.callout.accent === 'terracotta'
              ? 'rgba(214, 159, 135, 0.58)'
              : 'rgba(138, 180, 248, 0.45)';
        const accentColor =
          s.callout.accent === 'gold'
            ? '#f2d994'
            : s.callout.accent === 'terracotta'
              ? '#e3a188'
              : '#8ab4f8';

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `600 ${titleSize}px "JetBrains Mono", ui-monospace, monospace`;
        const titleW = ctx.measureText(s.callout.title).width;
        ctx.font = `500 ${subSize}px "JetBrains Mono", ui-monospace, monospace`;
        const subW = s.callout.subtitle ? ctx.measureText(s.callout.subtitle).width : 0;

        const pillW = Math.min(logicalW - 16, Math.max(titleW, subW) + 24);
        const pillH = s.callout.subtitle ? titleSize + subSize + 18 : titleSize + 14;
        const pillX = centerX - pillW / 2;
        const pillY = baseY - titleSize - 6;

        ctx.fillStyle = 'rgba(11, 12, 14, 0.84)';
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 10);
        ctx.fill();

        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.font = `600 ${titleSize}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.fillStyle = '#f0f2f5';
        ctx.fillText(s.callout.title, centerX, baseY);

        if (s.callout.subtitle) {
          ctx.font = `500 ${subSize}px "JetBrains Mono", ui-monospace, monospace`;
          ctx.fillStyle = accentColor;
          ctx.fillText(s.callout.subtitle, centerX, baseY + subSize + 5);
        }
        ctx.restore();
      }
    };

    const tick = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - lastTs));
      const dtSec = dt / 1000;
      lastTs = now;
      const s = engineRef.current;

      if (s.status === 'playing' && s.active) {
        // Horizontal DAS/ARR processing
        const held = heldMoveRef.current;
        if (held.dir !== 0) {
          held.elapsedMs += dt;
          if (held.elapsedMs >= DAS_MS) {
            held.repeatMs += dt;
            while (held.repeatMs >= ARR_MS) {
              held.repeatMs -= ARR_MS;
              if (!tryMoveHorizontal(held.dir)) break;
            }
          }
        }

        // Soft drop repeat
        if (held.softDrop) {
          held.softDropMs += dt;
          while (held.softDropMs >= SOFT_DROP_INTERVAL_MS) {
            held.softDropMs -= SOFT_DROP_INTERVAL_MS;
            if (!tryStepDown(true)) break;
          }
        }

        // Gravity & Lock Delay
        if (s.active) {
          const grounded = collides(s.board, s.active.type, s.active.rot, s.active.x, s.active.y + 1);
          if (grounded) {
            s.lockTimerMs += dt;
            if (s.lockTimerMs >= LOCK_DELAY_MS) {
              lockActivePiece(false);
            }
          } else {
            s.lockTimerMs = 0;
            const interval = gravityIntervalMs(s.level);
            s.fallAccumMs += dt;
            while (s.fallAccumMs >= interval && s.active) {
              s.fallAccumMs -= interval;
              if (!tryStepDown(false)) {
                break;
              }
            }
          }
        }
      }

      // Critically-damped spring update for gravity-well frame bounce
      if (Math.abs(s.boardBounceY) > 0.02 || Math.abs(s.boardBounceVel) > 0.05) {
        const springK = 360;
        const damping = 26;
        const accel = -springK * s.boardBounceY - damping * s.boardBounceVel;
        s.boardBounceVel += accel * dtSec;
        s.boardBounceY += s.boardBounceVel * dtSec;
        if (Math.abs(s.boardBounceY) < 0.04 && Math.abs(s.boardBounceVel) < 0.15) {
          s.boardBounceY = 0;
          s.boardBounceVel = 0;
        }
        if (stageRef.current) {
          stageRef.current.style.transform =
            s.boardBounceY === 0 ? '' : `translate3d(0, ${s.boardBounceY.toFixed(2)}px, 0)`;
        }
      }

      // Advance visual timers & particles
      if (s.lineFlashes.length > 0) {
        s.lineFlashes = s.lineFlashes
          .map((f) => ({ ...f, elapsedMs: f.elapsedMs + dt }))
          .filter((f) => f.elapsedMs < f.durationMs);
      }
      if (s.hardDropBeams.length > 0) {
        s.hardDropBeams = s.hardDropBeams
          .map((b) => ({ ...b, elapsedMs: b.elapsedMs + dt }))
          .filter((b) => b.elapsedMs < b.durationMs);
      }
      if (s.lockSheens.length > 0) {
        s.lockSheens = s.lockSheens
          .map((sh) => ({ ...sh, elapsedMs: sh.elapsedMs + dt }))
          .filter((sh) => sh.elapsedMs < sh.durationMs);
      }
      if (s.particles.length > 0) {
        const nextParticles: CrystalParticle[] = [];
        for (const p of s.particles) {
          const elapsedMs = p.elapsedMs + dt;
          if (elapsedMs >= p.durationMs) continue;
          const vy = p.vy + 14 * dtSec;
          nextParticles.push({
            ...p,
            x: p.x + p.vx * dtSec,
            y: p.y + vy * dtSec,
            vx: p.vx * (1 - 1.6 * dtSec),
            vy,
            rot: p.rot + p.vrot * dtSec,
            elapsedMs,
          });
        }
        s.particles = nextParticles;
      }
      if (s.callout) {
        s.callout.elapsedMs += dt;
        if (s.callout.elapsedMs >= s.callout.durationMs) {
          s.callout = null;
        }
      }

      drawFrame(now);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [lockActivePiece, tryMoveHorizontal, tryStepDown]);

  // Clean up touch repeat interval on unmount
  useEffect(() => {
    return () => {
      if (touchRepeatRef.current !== null) {
        window.clearInterval(touchRepeatRef.current);
      }
    };
  }, []);

  const stopTouchRepeat = useCallback(() => {
    if (touchRepeatRef.current !== null) {
      window.clearInterval(touchRepeatRef.current);
      touchRepeatRef.current = null;
    }
  }, []);

  const startTouchRepeat = useCallback(
    (action: () => void, intervalMs = 65) => {
      stopTouchRepeat();
      action();
      touchRepeatRef.current = window.setInterval(action, intervalMs);
    },
    [stopTouchRepeat],
  );

  return (
    <div className="flex w-full max-w-full flex-col gap-3">
      {/* Top Telemetry Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex flex-col">
            <span className="text-[11px] text-ink-muted">当前得分</span>
            <span className="tabular-nums-mono text-lg font-semibold leading-tight text-ink">
              {formatArcadeScore('tetris', hud.score)}
            </span>
          </div>
          <div className="h-7 w-px bg-hairline" />
          <div className="flex flex-col">
            <span className="text-[11px] text-ink-muted">消行 / 等级</span>
            <span className="tabular-nums-mono text-sm font-medium leading-tight text-ink">
              {hud.lines} 行 · Lv.{hud.level}
            </span>
          </div>
          {bestScore !== null && bestScore > 0 ? (
            <>
              <div className="hidden h-7 w-px bg-hairline sm:block" />
              <div className="hidden flex-col sm:flex">
                <span className="text-[11px] text-ink-muted">本地最佳</span>
                <span className="tabular-nums-mono text-sm font-medium leading-tight text-accent">
                  {formatArcadeScore('tetris', bestScore)}
                </span>
              </div>
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {hud.status === 'playing' || hud.status === 'paused' ? (
            <button
              type="button"
              onClick={togglePause}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
            >
              {hud.status === 'paused' ? (
                <Play className="h-3.5 w-3.5" />
              ) : (
                <Pause className="h-3.5 w-3.5" />
              )}
              <span>{hud.status === 'paused' ? '继续' : '暂停'}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={startNewRun}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{hud.status === 'idle' ? '开始' : '重开'}</span>
          </button>
        </div>
      </div>

      {/* Mobile Compact Hold & Next-3 Strip (visible < sm) */}
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-3 py-2 sm:hidden">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-ink-muted">暂存</span>
          <PiecePreview type={hud.hold} dimmed={!hud.canHold} compact />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-ink-muted">下三块</span>
          <div className="flex items-center gap-1">
            {hud.next.slice(0, 3).map((t, idx) => (
              <PiecePreview key={idx} type={t} compact />
            ))}
          </div>
        </div>
      </div>

      {/* Main Playfield + Side Telemetry Panels */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-12">
        {/* Desktop Left Rail: Hold & Tactical Readout */}
        <div className="hidden flex-col gap-3 sm:col-span-3 sm:flex">
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-hairline bg-surface p-3">
            <div className="flex w-full items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">暂存</span>
              <span className="tabular-nums-mono text-[10px] text-ink-muted">C / Shift</span>
            </div>
            <PiecePreview type={hud.hold} dimmed={!hud.canHold} />
          </div>

          <div className="flex flex-col gap-2 rounded-2xl border border-hairline bg-surface p-3">
            <span className="text-xs font-medium text-ink-muted">重力状态</span>
            <div className="flex items-center justify-between text-xs">
              <span className="text-ink-muted">连击</span>
              <span className="tabular-nums-mono font-medium text-ink">
                {hud.combo >= 1 ? `×${hud.combo}` : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-ink-muted">B2B</span>
              <span
                className={`tabular-nums-mono font-medium ${
                  hud.b2b ? 'text-accent' : 'text-ink-muted'
                }`}
              >
                {hud.b2b ? '激活' : '待机'}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-ink-muted">落速</span>
              <span className="tabular-nums-mono font-medium text-ink">
                {gravityIntervalMs(hud.level)}ms
              </span>
            </div>
            {hud.dangerActive ? (
              <div className="mt-0.5 rounded-lg border border-postmark/35 bg-postmark/10 px-2 py-1 text-center text-[10px] font-medium text-postmark">
                顶界警戒
              </div>
            ) : null}
          </div>
        </div>

        {/* Center DPR Canvas Gravity Well */}
        <div className="flex justify-center sm:col-span-6">
          <div
            ref={stageRef}
            data-only-dark="true"
            className="deep-space relative aspect-[1/2] w-full max-w-[260px] overflow-hidden rounded-2xl border border-hairline-strong shadow-[0_8px_28px_rgba(0,0,0,0.22)] will-change-transform sm:max-w-[290px]"
          >
            <canvas
              ref={canvasRef}
              className="block h-full w-full"
              aria-label="俄罗斯方块重力井棋盘"
            />

            {/* Idle / Paused / Gameover Overlays */}
            {hud.status === 'idle' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/74 px-5 text-center backdrop-blur-[2px]">
                <h3 className="text-base font-medium text-[#e3e3e3]">俄罗斯方块 · 重力井</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-[#9aa0a6]">
                  标准 SRS 踢墙 · 7-Bag 序列 · 500ms 锁定缓冲与 T-Spin 精准计分
                </p>
                <button
                  type="button"
                  onClick={startNewRun}
                  className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
                >
                  <Play className="h-4 w-4" />
                  <span>开始对局</span>
                </button>
              </div>
            ) : null}

            {hud.status === 'paused' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/80 px-5 text-center backdrop-blur-[2px]">
                <span className="text-base font-medium text-[#e3e3e3]">已暂停</span>
                <p className="mt-1 text-xs text-[#9aa0a6]">按 P 或点击继续恢复重力下落</p>
                <button
                  type="button"
                  onClick={togglePause}
                  className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
                >
                  <Play className="h-4 w-4" />
                  <span>继续对局</span>
                </button>
              </div>
            ) : null}

            {hud.status === 'gameover' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/85 px-5 text-center backdrop-blur-[3px]">
                <span className="text-xs font-medium text-[#8ab4f8]">重力井满载</span>
                <div className="tabular-nums-mono mt-1.5 text-3xl font-semibold text-[#e3e3e3]">
                  {formatArcadeScore('tetris', hud.score)}
                </div>
                <p className="tabular-nums-mono mt-1 text-xs text-[#9aa0a6]">
                  消除 {hud.lines} 行 · 抵达 Lv.{hud.level}
                </p>
                <button
                  type="button"
                  onClick={startNewRun}
                  className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span>再来一局</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Desktop Right Rail: Next 3 Queue */}
        <div className="hidden flex-col gap-3 sm:col-span-3 sm:flex">
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-hairline bg-surface p-3">
            <span className="w-full text-left text-xs font-medium text-ink-muted">下三个方块</span>
            <div className="flex flex-col items-center gap-2">
              {hud.next.slice(0, 3).map((t, idx) => (
                <PiecePreview key={idx} type={t} />
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-hairline bg-surface p-3 text-[11px] leading-relaxed text-ink-muted">
            <div className="flex justify-between">
              <span>移动</span>
              <span className="tabular-nums-mono text-ink">← →</span>
            </div>
            <div className="flex justify-between">
              <span>顺/逆旋</span>
              <span className="tabular-nums-mono text-ink">↑ X / Z</span>
            </div>
            <div className="flex justify-between">
              <span>软/瞬降</span>
              <span className="tabular-nums-mono text-ink">↓ / 空格</span>
            </div>
            <div className="flex justify-between">
              <span>暂存/暂停</span>
              <span className="tabular-nums-mono text-ink">C / P</span>
            </div>
          </div>
        </div>
      </div>

      {/* Touch Control Pad (mobile-first) */}
      <div className="grid grid-cols-4 gap-2 rounded-2xl border border-hairline bg-surface p-2.5 sm:hidden">
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            startTouchRepeat(() => tryMoveHorizontal(-1), 65);
          }}
          onPointerUp={stopTouchRepeat}
          onPointerLeave={stopTouchRepeat}
          onPointerCancel={stopTouchRepeat}
          className="flex h-12 flex-col items-center justify-center rounded-xl border border-hairline bg-paper text-ink active:bg-surface-hover"
          aria-label="向左移动"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="text-[10px] text-ink-muted">左移</span>
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            tryRotate(1);
          }}
          className="flex h-12 flex-col items-center justify-center rounded-xl border border-hairline bg-paper text-ink active:bg-surface-hover"
          aria-label="顺时针旋转"
        >
          <RotateCw className="h-4 w-4" />
          <span className="text-[10px] text-ink-muted">旋转</span>
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            startTouchRepeat(() => tryMoveHorizontal(1), 65);
          }}
          onPointerUp={stopTouchRepeat}
          onPointerLeave={stopTouchRepeat}
          onPointerCancel={stopTouchRepeat}
          className="flex h-12 flex-col items-center justify-center rounded-xl border border-hairline bg-paper text-ink active:bg-surface-hover"
          aria-label="向右移动"
        >
          <ArrowRight className="h-4 w-4" />
          <span className="text-[10px] text-ink-muted">右移</span>
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            holdCurrentPiece();
          }}
          className="flex h-12 flex-col items-center justify-center rounded-xl border border-hairline bg-paper text-ink active:bg-surface-hover"
          aria-label="暂存当前方块"
        >
          <Repeat2 className="h-4 w-4" />
          <span className="text-[10px] text-ink-muted">暂存</span>
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            tryRotate(-1);
          }}
          className="flex h-11 items-center justify-center gap-1 rounded-xl border border-hairline bg-paper text-xs font-medium text-ink active:bg-surface-hover"
          aria-label="逆时针旋转"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>逆旋</span>
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            startTouchRepeat(() => tryStepDown(true), 55);
          }}
          onPointerUp={stopTouchRepeat}
          onPointerLeave={stopTouchRepeat}
          onPointerCancel={stopTouchRepeat}
          className="flex h-11 items-center justify-center gap-1 rounded-xl border border-hairline bg-paper text-xs font-medium text-ink active:bg-surface-hover"
          aria-label="缓降"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          <span>缓降</span>
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            hardDrop();
          }}
          className="col-span-2 flex h-11 items-center justify-center gap-1.5 rounded-xl bg-cta-bg text-xs font-medium text-cta-text active:opacity-90"
          aria-label="瞬降锁定"
        >
          <ArrowDownToLine className="h-4 w-4" />
          <span>瞬降锁定</span>
        </button>
      </div>
    </div>
  );
}
