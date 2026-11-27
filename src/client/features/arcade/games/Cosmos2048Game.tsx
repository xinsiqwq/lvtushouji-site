import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, RefreshCw, Send, Undo2 } from 'lucide-react';
import { useTheme } from '../../../lib/theme';
import { formatArcadeScore, type ArcadeGameProps } from '../arcade-catalog';
import { arcadeSfx } from '../arcade-sfx';

type Direction = 'up' | 'down' | 'left' | 'right';
type GameStatus = 'playing' | 'gameover';

interface TileModel {
  id: number;
  value: number;
  row: number;
  col: number;
  isNew?: boolean;
  isMerged?: boolean;
  mergedFrom?: readonly TileModel[];
}

interface BoardSnapshot {
  tiles: TileModel[];
  score: number;
  moves: number;
  maxTile: number;
}

interface ScorePopup {
  id: number;
  delta: number;
}

interface GameState {
  tiles: TileModel[];
  score: number;
  moves: number;
  maxTile: number;
  status: GameStatus;
  hasReached2048: boolean;
  show2048Banner: boolean;
  undoSnapshot: BoardSnapshot | null;
  moveSeq: number;
}

interface TierSpec {
  tierIndex: number;
  label: string;
  lightBg: string;
  lightInk: string;
  lightBorder: string;
  darkBg: string;
  darkInk: string;
  darkBorder: string;
  ringColor: string;
  swatch: string;
}

const GRID_SIZE = 4;
const MAX_REPORTED_SCORE = 4_000_000;
const SWIPE_THRESHOLD_PX = 24;

const EVOLUTION_TIERS: Record<number, TierSpec> = {
  2: {
    tierIndex: 0,
    label: '星尘',
    lightBg: '#faf8f4',
    lightInk: '#1f1f1f',
    lightBorder: 'rgba(31, 31, 31, 0.11)',
    darkBg: '#272a30',
    darkInk: '#e3e3e3',
    darkBorder: 'rgba(227, 227, 227, 0.11)',
    ringColor: 'rgba(138, 180, 248, 0.5)',
    swatch: '#9aa0a6',
  },
  4: {
    tierIndex: 1,
    label: '微粒',
    lightBg: '#efe7d8',
    lightInk: '#1f1f1f',
    lightBorder: 'rgba(31, 31, 31, 0.13)',
    darkBg: '#323640',
    darkInk: '#edf0f5',
    darkBorder: 'rgba(227, 227, 227, 0.15)',
    ringColor: 'rgba(180, 198, 224, 0.58)',
    swatch: '#c8b89d',
  },
  8: {
    tierIndex: 2,
    label: '陨石',
    lightBg: '#ceb99d',
    lightInk: '#1c1813',
    lightBorder: 'rgba(31, 31, 31, 0.15)',
    darkBg: '#5b4e40',
    darkInk: '#f6f0e6',
    darkBorder: 'rgba(235, 215, 190, 0.24)',
    ringColor: 'rgba(214, 178, 134, 0.65)',
    swatch: '#b89b78',
  },
  16: {
    tierIndex: 3,
    label: '卫星',
    lightBg: '#b3c2d2',
    lightInk: '#151a21',
    lightBorder: 'rgba(22, 27, 34, 0.15)',
    darkBg: '#3d4b5d',
    darkInk: '#eef4fc',
    darkBorder: 'rgba(180, 206, 235, 0.26)',
    ringColor: 'rgba(160, 194, 228, 0.68)',
    swatch: '#8da6c2',
  },
  32: {
    tierIndex: 4,
    label: '岩星',
    lightBg: '#9a5136',
    lightInk: '#ffffff',
    lightBorder: 'rgba(255, 255, 255, 0.2)',
    darkBg: '#9a5136',
    darkInk: '#ffffff',
    darkBorder: 'rgba(230, 170, 145, 0.32)',
    ringColor: 'rgba(214, 140, 110, 0.72)',
    swatch: '#c96a48',
  },
  64: {
    tierIndex: 5,
    label: '冰巨星',
    lightBg: '#2b6b94',
    lightInk: '#ffffff',
    lightBorder: 'rgba(255, 255, 255, 0.2)',
    darkBg: '#2b6b94',
    darkInk: '#ffffff',
    darkBorder: 'rgba(145, 204, 240, 0.34)',
    ringColor: 'rgba(116, 188, 235, 0.72)',
    swatch: '#4c96c4',
  },
  128: {
    tierIndex: 6,
    label: '气巨星',
    lightBg: '#8c5f22',
    lightInk: '#ffffff',
    lightBorder: 'rgba(255, 255, 255, 0.22)',
    darkBg: '#8c5f22',
    darkInk: '#ffffff',
    darkBorder: 'rgba(235, 195, 125, 0.36)',
    ringColor: 'rgba(224, 176, 98, 0.76)',
    swatch: '#c48d3f',
  },
  256: {
    tierIndex: 7,
    label: '褐矮星',
    lightBg: '#6b3e2e',
    lightInk: '#faf4ef',
    lightBorder: 'rgba(255, 255, 255, 0.2)',
    darkBg: '#6b3e2e',
    darkInk: '#faf4ef',
    darkBorder: 'rgba(218, 165, 140, 0.34)',
    ringColor: 'rgba(214, 159, 135, 0.76)',
    swatch: '#9a5b42',
  },
  512: {
    tierIndex: 8,
    label: '红矮星',
    lightBg: '#992d36',
    lightInk: '#ffffff',
    lightBorder: 'rgba(255, 255, 255, 0.22)',
    darkBg: '#992d36',
    darkInk: '#ffffff',
    darkBorder: 'rgba(240, 145, 152, 0.36)',
    ringColor: 'rgba(235, 118, 126, 0.8)',
    swatch: '#c4454f',
  },
  1024: {
    tierIndex: 9,
    label: '蓝巨星',
    lightBg: '#1e4c96',
    lightInk: '#ffffff',
    lightBorder: 'rgba(255, 255, 255, 0.24)',
    darkBg: '#1e4c96',
    darkInk: '#ffffff',
    darkBorder: 'rgba(138, 180, 248, 0.48)',
    ringColor: 'rgba(138, 180, 248, 0.86)',
    swatch: '#4a85e0',
  },
  2048: {
    tierIndex: 10,
    label: '超新星',
    lightBg: '#d9a438',
    lightInk: '#171512',
    lightBorder: 'rgba(255, 243, 204, 0.75)',
    darkBg: '#dfb04b',
    darkInk: '#141310',
    darkBorder: 'rgba(255, 238, 186, 0.72)',
    ringColor: 'rgba(245, 206, 108, 0.92)',
    swatch: '#e0b04b',
  },
  4096: {
    tierIndex: 11,
    label: '中子星',
    lightBg: '#32366a',
    lightInk: '#f0f3ff',
    lightBorder: 'rgba(195, 205, 255, 0.42)',
    darkBg: '#3a3e7a',
    darkInk: '#f0f3ff',
    darkBorder: 'rgba(186, 198, 255, 0.5)',
    ringColor: 'rgba(176, 190, 255, 0.86)',
    swatch: '#6b72c2',
  },
  8192: {
    tierIndex: 12,
    label: '黑洞',
    lightBg: '#0b0c0e',
    lightInk: '#eef2f9',
    lightBorder: '#d69f87',
    darkBg: '#07080a',
    darkInk: '#eef2f9',
    darkBorder: '#d69f87',
    ringColor: 'rgba(214, 159, 135, 0.9)',
    swatch: '#d69f87',
  },
};

const TIER_MILESTONES = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;

function getTierSpec(value: number): TierSpec {
  if (EVOLUTION_TIERS[value]) return EVOLUTION_TIERS[value];
  return {
    tierIndex: 12,
    label: '奇点',
    lightBg: '#0b0c0e',
    lightInk: '#f2f6ff',
    lightBorder: '#8ab4f8',
    darkBg: '#07080a',
    darkInk: '#f2f6ff',
    darkBorder: '#8ab4f8',
    ringColor: 'rgba(138, 180, 248, 0.9)',
    swatch: '#8ab4f8',
  };
}

function getTierIndexFromValue(value: number): number {
  if (value <= 2) return 0;
  return Math.max(0, Math.min(12, Math.round(Math.log2(value)) - 1));
}

/**
 * Calibrated pure-SVG celestial micro-atlas backdrop rendered behind tile numbers.
 * Deliberately restrained opacity and open center framing keep typography crisp in Light & Dark.
 */
function CelestialEmblem({ value, isDark }: { value: number; isDark: boolean }) {
  const lightStroke = isDark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(31, 31, 31, 0.14)';
  const lightDot = isDark ? 'rgba(255, 255, 255, 0.32)' : 'rgba(31, 31, 31, 0.2)';

  // 2 星尘: subtle micro stardust speckles
  if (value === 2) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle cx="18" cy="20" r="1.6" fill={lightDot} />
        <circle cx="82" cy="24" r="1.2" fill={lightDot} />
        <circle cx="24" cy="80" r="1.1" fill={lightDot} />
        <circle cx="78" cy="76" r="1.8" fill={lightDot} />
        <circle cx="86" cy="52" r="0.9" fill={lightDot} />
        <circle cx="14" cy="54" r="0.9" fill={lightDot} />
      </svg>
    );
  }

  // 4 微粒: proto-planetary dust cluster & faint arc
  if (value === 4) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="38" fill="none" stroke={lightStroke} strokeWidth="0.9" strokeDasharray="3 5" />
        <circle cx="20" cy="22" r="2" fill={lightDot} />
        <circle cx="80" cy="20" r="1.5" fill={lightDot} />
        <circle cx="79" cy="81" r="2.1" fill={lightDot} />
        <circle cx="22" cy="77" r="1.4" fill={lightDot} />
      </svg>
    );
  }

  // 8 陨石: gentle crater arcs & rocky crescent contour
  if (value === 8) {
    const stroke = isDark ? 'rgba(255, 244, 230, 0.2)' : 'rgba(28, 24, 19, 0.14)';
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle cx="84" cy="18" r="18" fill="none" stroke={stroke} strokeWidth="1.2" />
        <circle cx="18" cy="84" r="13" fill="none" stroke={stroke} strokeWidth="1" />
        <circle cx="22" cy="20" r="4.5" fill="none" stroke={stroke} strokeWidth="1" />
        <circle cx="77" cy="80" r="3.2" fill="none" stroke={stroke} strokeWidth="1" />
      </svg>
    );
  }

  // 16 卫星: graceful crescent moon silhouette + crater rim arc
  if (value === 16) {
    const fill = isDark ? 'rgba(235, 244, 255, 0.14)' : 'rgba(21, 26, 33, 0.1)';
    const stroke = isDark ? 'rgba(235, 244, 255, 0.22)' : 'rgba(21, 26, 33, 0.14)';
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <path
          d="M 80 12 A 14 14 0 1 0 88 32 A 10.5 10.5 0 1 1 80 12 Z"
          fill={fill}
        />
        <path
          d="M 8 76 Q 28 90 52 92"
          fill="none"
          stroke={stroke}
          strokeWidth="1.1"
          strokeLinecap="round"
        />
        <circle cx="18" cy="22" r="5" fill="none" stroke={stroke} strokeWidth="1" />
      </svg>
    );
  }

  // 32 岩星: tilted Martian atmospheric terrain bands
  if (value === 32) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <g transform="rotate(-18 50 50)">
          <rect x="-15" y="10" width="130" height="8" fill="rgba(255, 230, 215, 0.11)" />
          <rect x="-15" y="25" width="130" height="4" fill="rgba(255, 230, 215, 0.08)" />
          <rect x="-15" y="74" width="130" height="6" fill="rgba(20, 8, 4, 0.16)" />
          <rect x="-15" y="85" width="130" height="9" fill="rgba(255, 220, 200, 0.09)" />
        </g>
        <circle cx="82" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="1" />
      </svg>
    );
  }

  // 64 冰巨星: Neptune tilted icy atmospheric ribbons + faint polar ring
  if (value === 64) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <g transform="rotate(-22 50 50)">
          <rect x="-15" y="8" width="130" height="7" fill="rgba(186, 232, 255, 0.14)" />
          <rect x="-15" y="22" width="130" height="3.5" fill="rgba(255, 255, 255, 0.11)" />
          <rect x="-15" y="75" width="130" height="5" fill="rgba(8, 28, 46, 0.2)" />
          <rect x="-15" y="86" width="130" height="7" fill="rgba(186, 232, 255, 0.12)" />
        </g>
        <ellipse
          cx="50"
          cy="50"
          rx="44"
          ry="16"
          transform="rotate(-22 50 50)"
          fill="none"
          stroke="rgba(195, 235, 255, 0.2)"
          strokeWidth="1"
        />
      </svg>
    );
  }

  // 128 气巨星: dual-layer soft nebula glow + fine orbital arc
  if (value === 128) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="42" fill="rgba(255, 224, 160, 0.08)" />
        <circle cx="50" cy="50" r="32" fill="none" stroke="rgba(255, 224, 160, 0.18)" strokeWidth="1" />
        <ellipse
          cx="50"
          cy="50"
          rx="46"
          ry="18"
          transform="rotate(-24 50 50)"
          fill="none"
          stroke="rgba(255, 236, 195, 0.28)"
          strokeWidth="1.2"
        />
        <circle cx="88" cy="33" r="2.3" fill="rgba(255, 240, 200, 0.55)" />
      </svg>
    );
  }

  // 256 褐矮星: warm dual nebula halo + inclined orbital ellipse
  if (value === 256) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="44" fill="rgba(235, 178, 148, 0.09)" />
        <circle cx="50" cy="50" r="35" fill="none" stroke="rgba(235, 178, 148, 0.22)" strokeWidth="1" />
        <ellipse
          cx="50"
          cy="50"
          rx="45"
          ry="19"
          transform="rotate(24 50 50)"
          fill="none"
          stroke="rgba(246, 206, 184, 0.28)"
          strokeWidth="1.15"
        />
        <circle cx="14" cy="34" r="2.2" fill="rgba(250, 220, 202, 0.55)" />
      </svg>
    );
  }

  // 512 红矮星: stellar corona ring + crisp 4-point optical diffraction spikes
  if (value === 512) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="39" fill="none" stroke="rgba(255, 210, 212, 0.24)" strokeWidth="1.2" />
        <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255, 190, 194, 0.13)" strokeWidth="3.5" />
        {/* Outer edge diffraction ticks */}
        <path
          d="M50 3 L51.4 16 L48.6 16 Z M50 97 L51.4 84 L48.6 84 Z M3 50 L16 51.4 L16 48.6 Z M97 50 L84 51.4 L84 48.6 Z"
          fill="rgba(255, 228, 228, 0.45)"
        />
      </svg>
    );
  }

  // 1024 蓝巨星: intense sapphire corona double-ring + crisp 8-point diffraction star spikes
  if (value === 1024) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(168, 206, 255, 0.34)" strokeWidth="1.3" />
        <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(138, 180, 248, 0.16)" strokeWidth="4" />
        <path
          d="M50 2 L51.5 17 L48.5 17 Z M50 98 L51.5 83 L48.5 83 Z M2 50 L17 51.5 L17 48.5 Z M98 50 L83 51.5 L83 48.5 Z"
          fill="rgba(218, 236, 255, 0.62)"
        />
        <path
          d="M14 14 L23 23 M86 14 L77 23 M14 86 L23 77 M86 86 L77 77"
          stroke="rgba(190, 220, 255, 0.38)"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // 2048 超新星: solar gold corona ring + specular sunburst compass ticks
  if (value === 2048) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle cx="50" cy="50" r="41" fill="none" stroke="rgba(255, 250, 232, 0.56)" strokeWidth="1.5" />
        <circle cx="50" cy="50" r="45.5" fill="none" stroke="rgba(23, 21, 18, 0.14)" strokeWidth="1" />
        <path
          d="M50 3 V14 M50 86 V97 M3 50 H14 M86 50 H97 M16 16 L24 24 M84 16 L76 24 M16 84 L24 76 M84 84 L76 76"
          stroke="rgba(255, 252, 238, 0.62)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // 4096 中子星: tilted bipolar pulsar jets + dipole magnetic field arcs
  if (value === 4096) {
    return (
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <g transform="rotate(-32 50 50)">
          {/* Twin collimated relativistic pulsar rays */}
          <polygon points="48,2 52,2 50.6,24 49.4,24" fill="rgba(210, 222, 255, 0.52)" />
          <polygon points="49.4,76 50.6,76 52,98 48,98" fill="rgba(210, 222, 255, 0.52)" />
          {/* Magnetic dipole field loops */}
          <ellipse cx="32" cy="50" rx="18" ry="26" fill="none" stroke="rgba(186, 200, 255, 0.25)" strokeWidth="1.1" />
          <ellipse cx="68" cy="50" rx="18" ry="26" fill="none" stroke="rgba(186, 200, 255, 0.25)" strokeWidth="1.1" />
        </g>
        <circle cx="50" cy="50" r="41" fill="none" stroke="rgba(200, 212, 255, 0.28)" strokeWidth="1" />
      </svg>
    );
  }

  // 8192 黑洞 & higher: obsidian event-horizon core + tilted fiery terracotta-gold accretion disk
  return (
    <svg
      viewBox="0 0 100 100"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      {/* Tilted fiery gold-terracotta accretion disk */}
      <ellipse
        cx="50"
        cy="50"
        rx="46"
        ry="15"
        transform="rotate(-22 50 50)"
        fill="none"
        stroke="rgba(214, 159, 135, 0.62)"
        strokeWidth="3.2"
      />
      <ellipse
        cx="50"
        cy="50"
        rx="42"
        ry="12"
        transform="rotate(-22 50 50)"
        fill="none"
        stroke="rgba(240, 204, 126, 0.55)"
        strokeWidth="1.2"
      />
      {/* Event-horizon obsidian core + fine photon ring */}
      <circle cx="50" cy="50" r="26" fill="#060709" />
      <circle cx="50" cy="50" r="27" fill="none" stroke="rgba(242, 204, 132, 0.48)" strokeWidth="1.1" />
      <circle cx="50" cy="50" r="32" fill="none" stroke="rgba(138, 180, 248, 0.22)" strokeWidth="0.9" />
    </svg>
  );
}

let globalTileId = 1;
function nextTileId(): number {
  globalTileId += 1;
  return globalTileId;
}

let globalPopupId = 1;
function nextPopupId(): number {
  globalPopupId += 1;
  return globalPopupId;
}

function stripTransient(tiles: readonly TileModel[]): TileModel[] {
  return tiles.map((t) => ({
    id: t.id,
    value: t.value,
    row: t.row,
    col: t.col,
  }));
}

function buildMatrix(tiles: readonly TileModel[]): (TileModel | null)[][] {
  const grid: (TileModel | null)[][] = Array.from({ length: GRID_SIZE }, () =>
    Array<TileModel | null>(GRID_SIZE).fill(null),
  );
  for (const tile of tiles) {
    grid[tile.row][tile.col] = tile;
  }
  return grid;
}

function spawnRandomTile(tiles: readonly TileModel[]): TileModel | null {
  const occupied = new Set(tiles.map((t) => `${t.row},${t.col}`));
  const empty: [number, number][] = [];
  for (let r = 0; r < GRID_SIZE; r += 1) {
    for (let c = 0; c < GRID_SIZE; c += 1) {
      if (!occupied.has(`${r},${c}`)) {
        empty.push([r, c]);
      }
    }
  }
  if (empty.length === 0) return null;
  const [row, col] = empty[Math.floor(Math.random() * empty.length)];
  const value = Math.random() < 0.9 ? 2 : 4;
  return {
    id: nextTileId(),
    value,
    row,
    col,
    isNew: true,
  };
}

function hasAnyLegalMove(tiles: readonly TileModel[]): boolean {
  if (tiles.length < GRID_SIZE * GRID_SIZE) return true;
  const grid = buildMatrix(tiles);
  for (let r = 0; r < GRID_SIZE; r += 1) {
    for (let c = 0; c < GRID_SIZE; c += 1) {
      const cur = grid[r][c];
      if (!cur) return true;
      if (r + 1 < GRID_SIZE && grid[r + 1][c]?.value === cur.value) return true;
      if (c + 1 < GRID_SIZE && grid[r][c + 1]?.value === cur.value) return true;
    }
  }
  return false;
}

function createInitialGameState(): GameState {
  const first = spawnRandomTile([]);
  const initialTiles: TileModel[] = first ? [first] : [];
  const second = spawnRandomTile(initialTiles);
  if (second) initialTiles.push(second);
  const maxTile = initialTiles.reduce((m, t) => Math.max(m, t.value), 2);
  return {
    tiles: initialTiles,
    score: 0,
    moves: 0,
    maxTile,
    status: 'playing',
    hasReached2048: false,
    show2048Banner: false,
    undoSnapshot: null,
    moveSeq: 0,
  };
}

function slideTiles(
  currentTiles: readonly TileModel[],
  dir: Direction,
): {
  nextTiles: TileModel[];
  moved: boolean;
  gained: number;
  mergedAny: boolean;
  maxMergedValue: number;
} {
  const clean = stripTransient(currentTiles);
  const grid = buildMatrix(clean);
  const nextTiles: TileModel[] = [];
  let moved = false;
  let gained = 0;
  let mergedAny = false;
  let maxMergedValue = 0;

  const isHorizontal = dir === 'left' || dir === 'right';
  const isReverse = dir === 'right' || dir === 'down';

  for (let lineIdx = 0; lineIdx < GRID_SIZE; lineIdx += 1) {
    const line: TileModel[] = [];
    for (let step = 0; step < GRID_SIZE; step += 1) {
      const idx = isReverse ? GRID_SIZE - 1 - step : step;
      const r = isHorizontal ? lineIdx : idx;
      const c = isHorizontal ? idx : lineIdx;
      const tile = grid[r][c];
      if (tile) line.push(tile);
    }

    let writePos = 0;
    let i = 0;
    while (i < line.length) {
      const targetIdx = isReverse ? GRID_SIZE - 1 - writePos : writePos;
      const destRow = isHorizontal ? lineIdx : targetIdx;
      const destCol = isHorizontal ? targetIdx : lineIdx;

      if (i + 1 < line.length && line[i].value === line[i + 1].value) {
        const a = line[i];
        const b = line[i + 1];
        const mergedValue = a.value * 2;
        gained += mergedValue;
        mergedAny = true;
        maxMergedValue = Math.max(maxMergedValue, mergedValue);
        moved = true;

        nextTiles.push({
          id: nextTileId(),
          value: mergedValue,
          row: destRow,
          col: destCol,
          isMerged: true,
          mergedFrom: [
            { ...a, row: destRow, col: destCol },
            { ...b, row: destRow, col: destCol },
          ],
        });
        i += 2;
      } else {
        const single = line[i];
        if (single.row !== destRow || single.col !== destCol) {
          moved = true;
        }
        nextTiles.push({
          ...single,
          row: destRow,
          col: destCol,
        });
        i += 1;
      }
      writePos += 1;
    }
  }

  return { nextTiles, moved, gained, mergedAny, maxMergedValue };
}

function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function valueFontClass(value: number): string {
  if (value >= 1024) return 'text-lg sm:text-xl';
  if (value >= 128) return 'text-xl sm:text-2xl';
  return 'text-2xl sm:text-[28px]';
}

export default function Cosmos2048Game({
  onRunFinished,
  bestScore,
  muted,
}: ArcadeGameProps) {
  const { resolved: themeScheme } = useTheme();
  const isDark = themeScheme === 'dark';

  const [game, setGame] = useState<GameState>(() => createInitialGameState());
  const [lastSubmittedScore, setLastSubmittedScore] = useState<number | null>(null);
  const [scorePopups, setScorePopups] = useState<ScorePopup[]>([]);

  const startTimeRef = useRef<number>(performance.now());
  const onRunFinishedRef = useRef(onRunFinished);
  const mutedRef = useRef(muted);
  const lastSubmittedRef = useRef<number | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const popupTimersRef = useRef<number[]>([]);
  const gameRef = useRef<GameState>(game);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    onRunFinishedRef.current = onRunFinished;
  }, [onRunFinished]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    return () => {
      for (const timer of popupTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const playSound = useCallback((fn: () => void) => {
    if (!mutedRef.current) {
      fn();
    }
  }, []);

  const pushScorePopup = useCallback((delta: number) => {
    if (delta <= 0) return;
    const id = nextPopupId();
    setScorePopups((prev) => [...prev.slice(-3), { id, delta }]);
    const timer = window.setTimeout(() => {
      setScorePopups((prev) => prev.filter((item) => item.id !== id));
      popupTimersRef.current = popupTimersRef.current.filter((t) => t !== timer);
    }, 740);
    popupTimersRef.current.push(timer);
  }, []);

  const reportRun = useCallback((score: number, maxTile: number) => {
    const clampedScore = Math.min(MAX_REPORTED_SCORE, Math.round(score));
    if (clampedScore < 4) return;
    if (lastSubmittedRef.current === clampedScore) return;
    lastSubmittedRef.current = clampedScore;
    setLastSubmittedScore(clampedScore);
    const durationMs = Math.max(0, Math.round(performance.now() - startTimeRef.current));
    onRunFinishedRef.current({
      score: clampedScore,
      durationMs,
      meta: { maxTile },
    });
  }, []);

  const performMove = useCallback(
    (dir: Direction) => {
      const current = gameRef.current;
      if (current.status !== 'playing') return;

      const { nextTiles, moved, gained, mergedAny, maxMergedValue } = slideTiles(
        current.tiles,
        dir,
      );
      if (!moved) return;

      const spawned = spawnRandomTile(nextTiles);
      const finalTiles = spawned ? [...nextTiles, spawned] : nextTiles;
      const nextScore = Math.min(MAX_REPORTED_SCORE, current.score + gained);
      const nextMaxTile = finalTiles.reduce((m, t) => Math.max(m, t.value), current.maxTile);
      const stillPlayable = hasAnyLegalMove(finalTiles);
      const justReached2048 = !current.hasReached2048 && nextMaxTile >= 2048;

      const undoSnapshot: BoardSnapshot = {
        tiles: stripTransient(current.tiles),
        score: current.score,
        moves: current.moves,
        maxTile: current.maxTile,
      };

      const nextState: GameState = {
        tiles: finalTiles,
        score: nextScore,
        moves: current.moves + 1,
        maxTile: nextMaxTile,
        status: stillPlayable ? 'playing' : 'gameover',
        hasReached2048: current.hasReached2048 || justReached2048,
        show2048Banner: justReached2048 ? true : current.show2048Banner,
        undoSnapshot,
        moveSeq: current.moveSeq + 1,
      };

      gameRef.current = nextState;
      setGame(nextState);
      if (gained > 0) {
        pushScorePopup(gained);
      }

      if (!stillPlayable) {
        playSound(arcadeSfx.gameOver);
        reportRun(nextScore, nextMaxTile);
      } else if (justReached2048) {
        playSound(arcadeSfx.win);
      } else if (mergedAny) {
        const tierIdx = getTierIndexFromValue(maxMergedValue);
        playSound(() => arcadeSfx.chime(tierIdx));
      } else {
        playSound(arcadeSfx.click);
      }
    },
    [playSound, pushScorePopup, reportRun],
  );

  const handleUndo = useCallback(() => {
    const current = gameRef.current;
    if (!current.undoSnapshot) return;
    const snap = current.undoSnapshot;
    const reverted: GameState = {
      tiles: stripTransient(snap.tiles),
      score: snap.score,
      moves: snap.moves,
      maxTile: snap.maxTile,
      status: 'playing',
      hasReached2048: current.hasReached2048 && snap.maxTile >= 2048,
      show2048Banner: false,
      undoSnapshot: null,
      moveSeq: current.moveSeq + 1,
    };
    gameRef.current = reverted;
    setGame(reverted);
    playSound(arcadeSfx.click);
  }, [playSound]);

  const handleRestart = useCallback(() => {
    startTimeRef.current = performance.now();
    lastSubmittedRef.current = null;
    setLastSubmittedScore(null);
    setScorePopups([]);
    const fresh = createInitialGameState();
    gameRef.current = fresh;
    setGame(fresh);
    playSound(arcadeSfx.pickup);
  }, [playSound]);

  const handleManualSubmit = useCallback(() => {
    const current = gameRef.current;
    if (current.score < 4) return;
    reportRun(current.score, current.maxTile);
    playSound(arcadeSfx.pickup);
  }, [playSound, reportRun]);

  const handleContinueEndless = useCallback(() => {
    setGame((prev) => ({
      ...prev,
      show2048Banner: false,
    }));
    playSound(arcadeSfx.click);
  }, [playSound]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableElement(document.activeElement)) return;
      const current = gameRef.current;

      if ((e.code === 'KeyZ' || e.code === 'KeyU') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (current.undoSnapshot) {
          e.preventDefault();
          handleUndo();
        }
        return;
      }

      if (current.status !== 'playing') return;

      let dir: Direction | null = null;
      let isArrow = false;
      if (e.key === 'ArrowUp' || e.code === 'KeyW') {
        dir = 'up';
        isArrow = e.key === 'ArrowUp';
      } else if (e.key === 'ArrowDown' || e.code === 'KeyS') {
        dir = 'down';
        isArrow = e.key === 'ArrowDown';
      } else if (e.key === 'ArrowLeft' || e.code === 'KeyA') {
        dir = 'left';
        isArrow = e.key === 'ArrowLeft';
      } else if (e.key === 'ArrowRight' || e.code === 'KeyD') {
        dir = 'right';
        isArrow = e.key === 'ArrowRight';
      }

      if (dir) {
        if (isArrow) {
          e.preventDefault();
        }
        performMove(dir);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [handleUndo, performMove]);

  const renderableTiles = useMemo(() => {
    const list: Array<{ tile: TileModel; layer: 'ghost' | 'main' }> = [];
    for (const tile of game.tiles) {
      if (tile.mergedFrom) {
        for (const src of tile.mergedFrom) {
          list.push({ tile: src, layer: 'ghost' });
        }
      }
      list.push({ tile, layer: 'main' });
    }
    return list;
  }, [game.tiles]);

  const currentTier = getTierSpec(game.maxTile);
  const currentTierStep = getTierIndexFromValue(game.maxTile) + 1;
  const nextMilestone = TIER_MILESTONES.find((v) => v > game.maxTile) ?? null;
  const nextTier = nextMilestone ? getTierSpec(nextMilestone) : null;
  const canSubmitCurrent = game.score >= 4 && lastSubmittedScore !== game.score;

  // Compute smooth calibrated evolution progress across the 13-tier ladder (0..100%)
  const evolutionPct = useMemo(() => {
    const baseIdx = getTierIndexFromValue(game.maxTile);
    if (baseIdx >= TIER_MILESTONES.length - 1) return 100;
    const totalMass = game.tiles.reduce((sum, t) => sum + t.value, 0);
    const subProgress = Math.min(0.92, Math.max(0, (totalMass - game.maxTile) / game.maxTile));
    return Math.min(100, Math.round(((baseIdx + subProgress) / (TIER_MILESTONES.length - 1)) * 100));
  }, [game.maxTile, game.tiles]);

  return (
    <div className="flex w-full max-w-full flex-col gap-3">
      <style>{`
        @keyframes cosmos-tile-spawn {
          0% { opacity: 0; transform: scale(0.58); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes cosmos-tile-merge {
          0% { transform: scale(0.86); }
          52% { transform: scale(1.08); }
          100% { transform: scale(1); }
        }
        @keyframes cosmos-merge-ring {
          0% { opacity: 0.78; transform: scale(0.88); }
          100% { opacity: 0; transform: scale(1.26); }
        }
        @keyframes cosmos-score-float {
          0% { opacity: 0; transform: translateY(4px) scale(0.94); }
          20% { opacity: 1; transform: translateY(-2px) scale(1); }
          100% { opacity: 0; transform: translateY(-16px) scale(0.98); }
        }
        .cosmos-tile-spawn {
          animation: cosmos-tile-spawn 150ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .cosmos-tile-merge {
          animation: cosmos-tile-merge 175ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .cosmos-merge-ring {
          animation: cosmos-merge-ring 340ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .cosmos-score-float {
          animation: cosmos-score-float 720ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .cosmos-tile-spawn,
          .cosmos-tile-merge,
          .cosmos-merge-ring,
          .cosmos-score-float {
            animation: none !important;
          }
        }
      `}</style>

      {/* Top HUD & Action Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="relative flex flex-col">
            <span className="text-[11px] text-ink-muted">演化得分</span>
            <div className="relative flex items-baseline gap-1.5">
              <span className="tabular-nums-mono text-lg font-semibold leading-tight text-ink">
                {formatArcadeScore('2048', game.score)}
              </span>
              {/* Floating +N score delta indicators */}
              <span className="pointer-events-none relative inline-block h-4 min-w-[2.5rem]">
                {scorePopups.map((popup) => (
                  <span
                    key={popup.id}
                    className="cosmos-score-float tabular-nums-mono absolute left-0 top-0 text-xs font-semibold text-accent"
                  >
                    +{popup.delta}
                  </span>
                ))}
              </span>
            </div>
          </div>
          <div className="h-7 w-px bg-hairline" />
          <div className="flex flex-col">
            <span className="text-[11px] text-ink-muted">当前最高天体</span>
            <span className="tabular-nums-mono inline-flex items-center gap-1.5 text-sm font-medium leading-tight text-ink">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: currentTier.swatch }}
                aria-hidden="true"
              />
              <span>
                {game.maxTile} · {currentTier.label}
              </span>
            </span>
          </div>
          {bestScore !== null && bestScore > 0 ? (
            <>
              <div className="hidden h-7 w-px bg-hairline sm:block" />
              <div className="hidden flex-col sm:flex">
                <span className="text-[11px] text-ink-muted">本地最佳</span>
                <span className="tabular-nums-mono text-sm font-medium leading-tight text-accent">
                  {formatArcadeScore('2048', bestScore)}
                </span>
              </div>
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={handleUndo}
            disabled={!game.undoSnapshot}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Undo2 className="h-3.5 w-3.5" />
            <span>撤销一步</span>
          </button>
          <button
            type="button"
            onClick={handleRestart}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>重新开始</span>
          </button>
        </div>
      </div>

      {/* Celestial Evolution Progress Ribbon */}
      <div className="rounded-2xl border border-hairline bg-paper/80 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">天体演化进度带</span>
            <span className="tabular-nums-mono rounded-full border border-hairline bg-surface px-2 py-0.5 text-[10px] text-ink-muted">
              第 {currentTierStep} / {TIER_MILESTONES.length} 阶
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-ink-muted">
            {nextMilestone && nextTier ? (
              <span>
                下一阶：
                <strong className="tabular-nums-mono font-medium text-ink">
                  {nextMilestone} {nextTier.label}
                </strong>
              </span>
            ) : (
              <span className="font-medium text-accent">已达黑洞终极阶段</span>
            )}
            <span className="tabular-nums-mono font-medium text-accent">{evolutionPct}%</span>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${Math.max(4, evolutionPct)}%`,
              backgroundColor: currentTier.swatch,
            }}
          />
        </div>
      </div>

      {/* 2048 Supernova Celebration Banner */}
      {game.show2048Banner ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/40 bg-paper px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">已演化至 2048 · 超新星</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              可立即结算记录当前得分，或继续冲击 4096 中子星与 8192 黑洞。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleContinueEndless}
              className="inline-flex h-9 items-center rounded-full bg-cta-bg px-3.5 text-xs font-medium text-cta-text transition-opacity hover:opacity-90"
            >
              继续无尽演化
            </button>
            <button
              type="button"
              onClick={handleManualSubmit}
              disabled={!canSubmitCurrent}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3.5 text-xs font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              <span>结算提交当前成绩</span>
            </button>
          </div>
        </div>
      ) : null}

      {/* 4x4 Celestial Evolution Board */}
      <div className="mx-auto w-full max-w-[404px]">
        <div
          className="relative aspect-square w-full select-none rounded-2xl border border-hairline-strong p-2.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)] sm:p-3"
          style={{
            backgroundColor: isDark ? '#121418' : '#e4eaf2',
            touchAction: 'none',
            ['--tile-gap' as string]: '10px',
          }}
          onTouchStart={(e) => {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
          }}
          onTouchEnd={(e) => {
            if (!swipeStartRef.current || e.changedTouches.length === 0) return;
            const touch = e.changedTouches[0];
            const dx = touch.clientX - swipeStartRef.current.x;
            const dy = touch.clientY - swipeStartRef.current.y;
            swipeStartRef.current = null;
            if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_THRESHOLD_PX) return;
            if (Math.abs(dx) > Math.abs(dy)) {
              performMove(dx > 0 ? 'right' : 'left');
            } else {
              performMove(dy > 0 ? 'down' : 'up');
            }
          }}
          aria-label="2048 天体演化 4×4 棋盘"
        >
          {/* Background Empty Recessed Cells */}
          <div
            className="grid h-full w-full grid-cols-4 grid-rows-4"
            style={{ gap: 'var(--tile-gap)' }}
          >
            {Array.from({ length: 16 }).map((_, idx) => (
              <div
                key={idx}
                className="rounded-xl border"
                style={{
                  backgroundColor: isDark ? '#1a1d24' : '#f4f7fb',
                  borderColor: isDark ? 'rgba(227, 227, 227, 0.06)' : 'rgba(31, 31, 31, 0.06)',
                  boxShadow: isDark
                    ? 'inset 0 1px 2px rgba(0, 0, 0, 0.35)'
                    : 'inset 0 1px 2px rgba(31, 31, 31, 0.05)',
                }}
              />
            ))}
          </div>

          {/* Animated Tiles Layer */}
          <div className="pointer-events-none absolute inset-2.5 sm:inset-3">
            {renderableTiles.map(({ tile, layer }) => {
              const spec = getTierSpec(tile.value);
              const bg = isDark ? spec.darkBg : spec.lightBg;
              const ink = isDark ? spec.darkInk : spec.lightInk;
              const border = isDark ? spec.darkBorder : spec.lightBorder;
              const animClass =
                layer === 'main'
                  ? tile.isMerged
                    ? 'cosmos-tile-merge'
                    : tile.isNew
                      ? 'cosmos-tile-spawn'
                      : ''
                  : '';

              const isSupernova = tile.value === 2048;
              const isBlackHole = tile.value >= 8192;
              const tileShadow = isSupernova
                ? 'inset 0 1px 0 rgba(255, 252, 232, 0.65), inset 0 -1.5px 0 rgba(120, 82, 12, 0.35), 0 4px 14px rgba(217, 164, 56, 0.28)'
                : isBlackHole
                  ? 'inset 0 1px 0 rgba(214, 159, 135, 0.45), 0 4px 16px rgba(0, 0, 0, 0.5)'
                  : isDark
                    ? 'inset 0 1px 0 rgba(255, 255, 255, 0.14), inset 0 -1.5px 0 rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.28)'
                    : 'inset 0 1px 0 rgba(255, 255, 255, 0.45), inset 0 -1.5px 0 rgba(31, 31, 31, 0.1), 0 2px 5px rgba(31, 31, 31, 0.08)';

              return (
                <div
                  key={tile.id}
                  className="absolute left-0 top-0"
                  style={{
                    width: 'calc((100% - 3 * var(--tile-gap)) / 4)',
                    height: 'calc((100% - 3 * var(--tile-gap)) / 4)',
                    zIndex: layer === 'ghost' ? 1 : tile.isMerged ? 3 : 2,
                    transform: `translate3d(calc(${tile.col} * (100% + var(--tile-gap))), calc(${tile.row} * (100% + var(--tile-gap))), 0)`,
                    transition: 'transform 130ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                >
                  {/* Expanding same-hue luminous halo pulse on merge */}
                  {layer === 'main' && tile.isMerged ? (
                    <div
                      className="cosmos-merge-ring pointer-events-none absolute -inset-[2px] rounded-[14px] border-2"
                      style={{ borderColor: spec.ringColor }}
                      aria-hidden="true"
                    />
                  ) : null}

                  <div
                    className={`relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-xl border px-1 text-center ${animClass}`}
                    style={{
                      backgroundColor: bg,
                      color: ink,
                      borderColor: border,
                      boxShadow: tileShadow,
                    }}
                  >
                    <CelestialEmblem value={tile.value} isDark={isDark} />
                    <span
                      className={`tabular-nums-mono relative z-[1] font-semibold leading-none ${valueFontClass(tile.value)}`}
                    >
                      {tile.value}
                    </span>
                    <span className="relative z-[1] mt-1 truncate text-[10px] font-medium leading-none opacity-88 sm:text-[11px]">
                      {spec.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Game Over Overlay */}
          {game.status === 'gameover' ? (
            <div
              className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl px-6 text-center backdrop-blur-[3px]"
              style={{
                backgroundColor: isDark ? 'rgba(11, 12, 14, 0.84)' : 'rgba(250, 248, 244, 0.88)',
              }}
            >
              <span className="text-xs font-medium text-accent">演化达到热寂终态</span>
              <div className="tabular-nums-mono mt-1.5 text-3xl font-semibold text-ink">
                {formatArcadeScore('2048', game.score)}
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                最高演化：{game.maxTile} · {currentTier.label}（共 {game.moves} 步）
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {game.undoSnapshot ? (
                  <button
                    type="button"
                    onClick={handleUndo}
                    className="inline-flex h-10 items-center gap-1.5 rounded-full border border-hairline-strong bg-surface px-4 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    <span>撤销最后一步</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={handleRestart}
                  className="inline-flex h-10 items-center gap-1.5 rounded-full bg-cta-bg px-5 text-xs font-medium text-cta-text transition-opacity hover:opacity-90"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>重新演化</span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Run Telemetry & Active Score Submit Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-3.5 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-ink-muted">
          <span className="tabular-nums-mono">已演化 {game.moves} 步</span>
          <span aria-hidden="true">·</span>
          <span>方向键 / WASD 或在棋盘滑动</span>
        </div>

        {game.score >= 4 ? (
          <button
            type="button"
            onClick={handleManualSubmit}
            disabled={!canSubmitCurrent}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-hover disabled:cursor-default disabled:opacity-65"
          >
            {canSubmitCurrent ? (
              <>
                <Send className="h-3 w-3 text-accent" />
                <span>结算提交当前成绩</span>
              </>
            ) : (
              <>
                <Check className="h-3 w-3 text-accent" />
                <span>当前得分已结算</span>
              </>
            )}
          </button>
        ) : null}
      </div>

      {/* Compact 13-Tier Celestial Evolution Atlas Strip */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-hairline bg-paper/70 px-3 py-2">
        {TIER_MILESTONES.map((val) => {
          const reached = game.maxTile >= val;
          const isCurrent = game.maxTile === val;
          const spec = getTierSpec(val);
          return (
            <span
              key={val}
              className={`tabular-nums-mono inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-opacity ${
                isCurrent
                  ? 'border-accent/50 bg-surface font-semibold text-ink opacity-100'
                  : reached
                    ? 'border-hairline-strong bg-surface font-medium text-ink opacity-100'
                    : 'border-hairline bg-transparent text-ink-muted opacity-50'
              }`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: spec.swatch }}
                aria-hidden="true"
              />
              <span>{val}</span>
              <span>{spec.label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
