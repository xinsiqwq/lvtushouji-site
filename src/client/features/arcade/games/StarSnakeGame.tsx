import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
  Zap,
} from 'lucide-react';
import type { ArcadeGameProps } from '../arcade-catalog';
import { arcadeSfx } from '../arcade-sfx';

type GameStatus = 'ready' | 'playing' | 'paused' | 'gameover';
type SnakeMode = 'classic' | 'wrap';
type Direction = 'up' | 'down' | 'left' | 'right';

interface GridPos {
  x: number;
  y: number;
}

interface BonusStar {
  x: number;
  y: number;
  remaining: number;
  duration: number;
}

interface SparkParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  life: number;
  maxLife: number;
}

interface ShockRing {
  x: number;
  y: number;
  r: number;
  maxR: number;
  color: string;
  life: number;
  maxLife: number;
  lineWidth: number;
}

interface PortalPulse {
  edge: 'left' | 'right' | 'top' | 'bottom';
  pos: number; // pixel coordinate along the edge
  life: number;
  maxLife: number;
}

interface ScorePopup {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

interface BgStar {
  x: number;
  y: number;
  r: number;
  phase: number;
  driftX: number;
  driftY: number;
  alpha: number;
}

const GRID_SIZE = 20;
const LOGICAL_SIZE = 560;
const CELL = LOGICAL_SIZE / GRID_SIZE; // 28px
const BASE_TICK_SEC = 0.145;
const MIN_TICK_SEC = 0.086;
const BONUS_DURATION_SEC = 7.5;

const DIR_VECTORS: Record<Direction, GridPos> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE_DIR: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable
  );
}

function createInitialSegments(): GridPos[] {
  return [
    { x: 10, y: 10 },
    { x: 9, y: 10 },
    { x: 8, y: 10 },
    { x: 7, y: 10 },
  ];
}

function createBgStars(): BgStar[] {
  const stars: BgStar[] = [];
  let seed = 8831;
  const nextRand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 64; i += 1) {
    const drifting = i % 3 === 0;
    stars.push({
      x: nextRand() * LOGICAL_SIZE,
      y: nextRand() * LOGICAL_SIZE,
      r: 0.6 + nextRand() * 1.15,
      phase: nextRand() * Math.PI * 2,
      driftX: drifting ? (nextRand() - 0.5) * 4.5 : 0,
      driftY: drifting ? (nextRand() - 0.5) * 4.5 : 0,
      alpha: 0.18 + nextRand() * 0.42,
    });
  }
  return stars;
}

function findEmptyCell(occupied: readonly GridPos[], extra?: GridPos | null): GridPos | null {
  const used = new Set<number>();
  for (const p of occupied) {
    used.add(p.y * GRID_SIZE + p.x);
  }
  if (extra) {
    used.add(extra.y * GRID_SIZE + extra.x);
  }
  const free: GridPos[] = [];
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      if (!used.has(y * GRID_SIZE + x)) {
        free.push({ x, y });
      }
    }
  }
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)];
}

function wrapDelta(prev: number, curr: number): number {
  let d = curr - prev;
  if (d > 1) d -= GRID_SIZE;
  if (d < -1) d += GRID_SIZE;
  return d;
}

function wrapCoord(v: number): number {
  return ((v % GRID_SIZE) + GRID_SIZE) % GRID_SIZE;
}

export default function StarSnakeGame({ onRunFinished, bestScore, muted }: ArcadeGameProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const onRunFinishedRef = useRef(onRunFinished);
  onRunFinishedRef.current = onRunFinished;

  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const [status, setStatus] = useState<GameStatus>('ready');
  const [mode, setMode] = useState<SnakeMode>('classic');
  const [hudScore, setHudScore] = useState(0);
  const [hudLength, setHudLength] = useState(4);
  const [boostActive, setBoostActive] = useState(false);
  const [bonusTimeLeft, setBonusTimeLeft] = useState<number | null>(null);
  const [endReason, setEndReason] = useState<'wall' | 'self' | 'victory' | null>(null);

  const swipeAnchorRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  const engineRef = useRef({
    status: 'ready' as GameStatus,
    mode: 'classic' as SnakeMode,
    segments: createInitialSegments(),
    prevSegments: createInitialSegments(),
    direction: 'right' as Direction,
    dirQueue: [] as Direction[],
    food: { x: 15, y: 10 } as GridPos,
    foodsEaten: 0,
    bonus: null as BonusStar | null,
    score: 0,
    boostHeld: false,
    boostSparkTimer: 0,
    tickAccum: 0,
    activePlayMs: 0,
    animTime: 0,
    shakeAmp: 0,
    impactFlash: 0,
    bgStars: createBgStars(),
    sparks: [] as SparkParticle[],
    rings: [] as ShockRing[],
    portalPulses: [] as PortalPulse[],
    popups: [] as ScorePopup[],
    runReported: false,
    gameOverAtMs: 0,
    lastHudSync: 0,
  });

  const playSound = useCallback(
    (kind: 'pickup' | 'merge' | 'win' | 'gameOver' | 'click' | 'warp') => {
      if (mutedRef.current) return;
      arcadeSfx[kind]();
    },
    [],
  );

  const playChime = useCallback((tier: number) => {
    if (mutedRef.current) return;
    arcadeSfx.chime(tier);
  }, []);

  const spawnSparks = useCallback((px: number, py: number, color: string, count: number, speedMult = 1) => {
    const s = engineRef.current;
    for (let i = 0; i < count; i += 1) {
      const ang = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const spd = (48 + Math.random() * 105) * speedMult;
      s.sparks.push({
        x: px,
        y: py,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        r: 1.5 + Math.random() * 2.1,
        color,
        life: 0,
        maxLife: 0.28 + Math.random() * 0.26,
      });
    }
    if (s.sparks.length > 96) {
      s.sparks.splice(0, s.sparks.length - 96);
    }
  }, []);

  const spawnShockRing = useCallback((px: number, py: number, maxR: number, color: string, lineWidth = 1.8) => {
    const s = engineRef.current;
    s.rings.push({
      x: px,
      y: py,
      r: 5,
      maxR,
      color,
      life: 0,
      maxLife: 0.38,
      lineWidth,
    });
    if (s.rings.length > 12) {
      s.rings.shift();
    }
  }, []);

  const spawnPortalPulse = useCallback((edge: PortalPulse['edge'], pos: number) => {
    const s = engineRef.current;
    s.portalPulses.push({
      edge,
      pos,
      life: 0,
      maxLife: 0.42,
    });
    if (s.portalPulses.length > 10) {
      s.portalPulses.shift();
    }
  }, []);

  const spawnPopup = useCallback((gridX: number, gridY: number, text: string, color: string) => {
    const s = engineRef.current;
    s.popups.push({
      x: Math.min(LOGICAL_SIZE - 34, Math.max(34, (gridX + 0.5) * CELL)),
      y: Math.max(24, (gridY + 0.32) * CELL),
      text,
      color,
      life: 0,
      maxLife: 0.78,
    });
  }, []);

  const startNewRun = useCallback(
    (overrideMode?: SnakeMode) => {
      const s = engineRef.current;
      const activeMode = overrideMode ?? s.mode;
      s.mode = activeMode;
      const initial = createInitialSegments();
      s.segments = initial.map((p) => ({ ...p }));
      s.prevSegments = initial.map((p) => ({ ...p }));
      s.direction = 'right';
      s.dirQueue = [];
      s.food = findEmptyCell(s.segments) ?? { x: 15, y: 10 };
      s.foodsEaten = 0;
      s.bonus = null;
      s.score = 0;
      s.boostHeld = false;
      s.boostSparkTimer = 0;
      s.tickAccum = 0;
      s.activePlayMs = 0;
      s.shakeAmp = 0;
      s.impactFlash = 0;
      s.sparks = [];
      s.rings = [];
      s.portalPulses = [];
      s.popups = [];
      s.runReported = false;
      s.status = 'playing';
      s.lastHudSync = 0;

      setMode(activeMode);
      setHudScore(0);
      setHudLength(initial.length);
      setBoostActive(false);
      setBonusTimeLeft(null);
      setEndReason(null);
      setStatus('playing');

      stageRef.current?.focus({ preventScroll: true });
      playSound('click');
    },
    [playSound],
  );

  const selectMode = useCallback(
    (nextMode: SnakeMode) => {
      const s = engineRef.current;
      if (s.status === 'playing' || s.status === 'paused') return;
      s.mode = nextMode;
      setMode(nextMode);
      playSound('click');
    },
    [playSound],
  );

  const togglePause = useCallback(() => {
    const s = engineRef.current;
    if (s.status === 'playing') {
      s.status = 'paused';
      s.boostHeld = false;
      setBoostActive(false);
      setStatus('paused');
    } else if (s.status === 'paused') {
      s.status = 'playing';
      setStatus('playing');
      stageRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const queueDirection = useCallback((nextDir: Direction) => {
    const s = engineRef.current;
    if (s.status !== 'playing') return;
    const referenceDir =
      s.dirQueue.length > 0 ? s.dirQueue[s.dirQueue.length - 1] : s.direction;
    if (nextDir === referenceDir || nextDir === OPPOSITE_DIR[referenceDir]) {
      return;
    }
    if (s.dirQueue.length < 2) {
      s.dirQueue.push(nextDir);
    }
  }, []);

  const setBoostInput = useCallback((active: boolean) => {
    const s = engineRef.current;
    const next = active && s.status === 'playing';
    s.boostHeld = next;
    setBoostActive(next);
  }, []);

  // Keyboard & visibility listeners
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextInputFocused()) return;
      const s = engineRef.current;
      const stageFocused =
        stageRef.current !== null && document.activeElement === stageRef.current;

      const isArrowOrSpace =
        e.code === 'Space' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight';

      if (isArrowOrSpace && (s.status === 'playing' || stageFocused)) {
        e.preventDefault();
      }

      if ((e.code === 'KeyP' || e.code === 'Escape') && (s.status === 'playing' || s.status === 'paused')) {
        if (!e.repeat) togglePause();
        return;
      }

      if (s.status === 'ready' || s.status === 'gameover') {
        if (
          e.code === 'Space' &&
          stageFocused &&
          !e.repeat &&
          (s.status === 'ready' || performance.now() - s.gameOverAtMs > 250)
        ) {
          startNewRun();
        }
        return;
      }

      if (s.status === 'paused') {
        if (e.code === 'Space' && stageFocused && !e.repeat) {
          togglePause();
        }
        return;
      }

      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'Space') {
        setBoostInput(true);
        return;
      }

      if (e.code === 'ArrowUp' || e.code === 'KeyW') {
        queueDirection('up');
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        queueDirection('down');
      } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        queueDirection('left');
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        queueDirection('right');
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'Space') {
        setBoostInput(false);
      }
    };

    const onVisibilityChange = () => {
      const s = engineRef.current;
      if (document.hidden && s.status === 'playing') {
        s.status = 'paused';
        s.boostHeld = false;
        setBoostActive(false);
        setStatus('paused');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queueDirection, setBoostInput, startNewRun, togglePause]);

  // Main 60-120fps interpolated Canvas RAF loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const syncSize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const targetW = Math.max(1, Math.round(rect.width * dpr));
      const targetH = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
    };

    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(canvas);

    const getCurrentTickInterval = (): number => {
      const s = engineRef.current;
      const growthSteps = Math.max(0, s.segments.length - 4);
      const base = Math.max(MIN_TICK_SEC, BASE_TICK_SEC - growthSteps * 0.0018);
      return s.boostHeld ? base * 0.5 : base;
    };

    const finishRun = (reason: 'wall' | 'self' | 'victory') => {
      const s = engineRef.current;
      s.status = 'gameover';
      s.boostHeld = false;
      s.gameOverAtMs = performance.now();

      if (reason !== 'victory') {
        s.shakeAmp = 7.2;
        s.impactFlash = 0.8;
        const head = s.segments[0];
        const hx = (head.x + 0.5) * CELL;
        const hy = (head.y + 0.5) * CELL;
        spawnSparks(hx, hy, '#e58d67', 18, 1.35);
        spawnSparks(hx, hy, '#f6d892', 8, 1.1);
        spawnShockRing(hx, hy, 38, '#e58d67', 2.0);
      }

      setBoostActive(false);
      setEndReason(reason);
      setHudScore(s.score);
      setHudLength(s.segments.length);
      setBonusTimeLeft(null);
      setStatus('gameover');
      playSound(reason === 'victory' ? 'win' : 'gameOver');

      if (!s.runReported) {
        s.runReported = true;
        onRunFinishedRef.current({
          score: Math.max(0, Math.round(s.score)),
          durationMs: Math.max(0, Math.round(s.activePlayMs)),
          meta: {
            mode: s.mode,
            length: s.segments.length,
          },
        });
      }
    };

    const advanceTick = () => {
      const s = engineRef.current;
      if (s.dirQueue.length > 0) {
        const nextDir = s.dirQueue.shift()!;
        if (nextDir !== OPPOSITE_DIR[s.direction]) {
          s.direction = nextDir;
        }
      }

      const vec = DIR_VECTORS[s.direction];
      const head = s.segments[0];
      const rawNx = head.x + vec.x;
      const rawNy = head.y + vec.y;
      let nx = rawNx;
      let ny = rawNy;

      if (s.mode === 'classic') {
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) {
          finishRun('wall');
          return;
        }
      } else {
        nx = wrapCoord(nx);
        ny = wrapCoord(ny);

        // Detect spatial portal edge warp and spawn dual border light pulses + warp SFX
        if (rawNx < 0) {
          const py = (ny + 0.5) * CELL;
          spawnPortalPulse('left', py);
          spawnPortalPulse('right', py);
          playSound('warp');
        } else if (rawNx >= GRID_SIZE) {
          const py = (ny + 0.5) * CELL;
          spawnPortalPulse('right', py);
          spawnPortalPulse('left', py);
          playSound('warp');
        } else if (rawNy < 0) {
          const px = (nx + 0.5) * CELL;
          spawnPortalPulse('top', px);
          spawnPortalPulse('bottom', px);
          playSound('warp');
        } else if (rawNy >= GRID_SIZE) {
          const px = (nx + 0.5) * CELL;
          spawnPortalPulse('bottom', px);
          spawnPortalPulse('top', px);
          playSound('warp');
        }
      }

      const eatsFood = nx === s.food.x && ny === s.food.y;
      const eatsBonus = s.bonus !== null && nx === s.bonus.x && ny === s.bonus.y;
      const willGrow = eatsFood || eatsBonus;

      // Self-collision check (tail vacates unless growing this tick)
      const checkLen = willGrow ? s.segments.length : s.segments.length - 1;
      for (let i = 0; i < checkLen; i += 1) {
        if (s.segments[i].x === nx && s.segments[i].y === ny) {
          finishRun('self');
          return;
        }
      }

      // Snapshot previous positions for smooth 60-120fps interpolation
      s.prevSegments = s.segments.map((seg) => ({ ...seg }));
      const nextSegments: GridPos[] = [{ x: nx, y: ny }, ...s.segments];
      if (!willGrow) {
        nextSegments.pop();
      } else {
        s.prevSegments.push({ ...s.prevSegments[s.prevSegments.length - 1] });
      }
      s.segments = nextSegments;

      const mult = s.boostHeld ? 1.5 : 1;

      if (eatsFood) {
        const pts = Math.round(10 * mult);
        s.score += pts;
        s.foodsEaten += 1;
        const px = (nx + 0.5) * CELL;
        const py = (ny + 0.5) * CELL;
        spawnSparks(px, py, '#e58d67', 12, 1.0);
        spawnShockRing(px, py, 32, '#e58d67', 1.7);
        spawnPopup(nx, ny, `+${pts}`, s.boostHeld ? '#e8c47a' : '#f2efe9');
        playSound('pickup');

        const nextFood = findEmptyCell(s.segments, s.bonus);
        if (!nextFood) {
          finishRun('victory');
          return;
        }
        s.food = nextFood;

        // Spawn timed golden bonus star every 4 foods eaten
        if (s.foodsEaten % 4 === 0 && s.bonus === null) {
          const bonusSpot = findEmptyCell(s.segments, s.food);
          if (bonusSpot) {
            s.bonus = {
              x: bonusSpot.x,
              y: bonusSpot.y,
              remaining: BONUS_DURATION_SEC,
              duration: BONUS_DURATION_SEC,
            };
          }
        }
      }

      if (eatsBonus && s.bonus) {
        const pts = Math.round(30 * mult);
        s.score += pts;
        const px = (nx + 0.5) * CELL;
        const py = (ny + 0.5) * CELL;
        spawnSparks(px, py, '#e8c47a', 18, 1.25);
        spawnShockRing(px, py, 44, '#e8c47a', 2.0);
        spawnPopup(nx, ny, `+${pts}`, '#e8c47a');
        playChime(s.boostHeld ? 6 : 4);
        s.bonus = null;
        setBonusTimeLeft(null);
      }

      setHudScore(s.score);
      setHudLength(s.segments.length);
    };

    const stepSimulation = (dt: number) => {
      const s = engineRef.current;
      s.animTime += dt;

      // Damped screen shake & impact flash decay
      if (s.shakeAmp > 0.05) {
        s.shakeAmp *= Math.exp(-dt * 14);
      } else {
        s.shakeAmp = 0;
      }
      if (s.impactFlash > 0) {
        s.impactFlash = Math.max(0, s.impactFlash - dt * 4.2);
      }

      // Gently drift deep-space stars
      for (const st of s.bgStars) {
        if (st.driftX !== 0 || st.driftY !== 0) {
          st.x = (st.x + st.driftX * dt + LOGICAL_SIZE) % LOGICAL_SIZE;
          st.y = (st.y + st.driftY * dt + LOGICAL_SIZE) % LOGICAL_SIZE;
        }
      }

      // Particles, shockwave rings, portal pulses & score popups
      for (let i = s.sparks.length - 1; i >= 0; i -= 1) {
        const p = s.sparks[i];
        p.life += dt;
        if (p.life >= p.maxLife) {
          s.sparks.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= Math.pow(0.16, dt);
        p.vy *= Math.pow(0.16, dt);
      }

      for (let i = s.rings.length - 1; i >= 0; i -= 1) {
        const ring = s.rings[i];
        ring.life += dt;
        if (ring.life >= ring.maxLife) {
          s.rings.splice(i, 1);
          continue;
        }
        const prog = ring.life / ring.maxLife;
        ring.r = 5 + (ring.maxR - 5) * (1 - Math.pow(1 - prog, 2.4));
      }

      for (let i = s.portalPulses.length - 1; i >= 0; i -= 1) {
        const pp = s.portalPulses[i];
        pp.life += dt;
        if (pp.life >= pp.maxLife) {
          s.portalPulses.splice(i, 1);
        }
      }

      for (let i = s.popups.length - 1; i >= 0; i -= 1) {
        const pop = s.popups[i];
        pop.life += dt;
        if (pop.life >= pop.maxLife) {
          s.popups.splice(i, 1);
          continue;
        }
        pop.y -= 28 * dt;
      }

      if (s.status !== 'playing') return;

      s.activePlayMs += dt * 1000;

      // Continuous comet stardust spray when boosting
      if (s.boostHeld && s.segments.length >= 2) {
        s.boostSparkTimer -= dt;
        if (s.boostSparkTimer <= 0) {
          s.boostSparkTimer = 0.032;
          const tail = s.segments[s.segments.length - 1];
          const mid = s.segments[Math.min(1, s.segments.length - 1)];
          const emitSeg = Math.random() < 0.65 ? tail : mid;
          s.sparks.push({
            x: (emitSeg.x + 0.5) * CELL + (Math.random() - 0.5) * 8,
            y: (emitSeg.y + 0.5) * CELL + (Math.random() - 0.5) * 8,
            vx: (Math.random() - 0.5) * 34,
            vy: (Math.random() - 0.5) * 34,
            r: 1.2 + Math.random() * 1.4,
            color: Math.random() < 0.5 ? '#8ab4f8' : '#e8c47a',
            life: 0,
            maxLife: 0.28 + Math.random() * 0.16,
          });
        }
      }

      // Timed golden bonus star countdown
      if (s.bonus) {
        s.bonus.remaining -= dt;
        if (s.bonus.remaining <= 0) {
          s.bonus = null;
          setBonusTimeLeft(null);
        } else {
          const now = performance.now();
          if (now - s.lastHudSync > 100) {
            s.lastHudSync = now;
            setBonusTimeLeft(Math.max(0, Number(s.bonus.remaining.toFixed(1))));
          }
        }
      }

      s.tickAccum += dt;
      let safety = 0;
      while (s.status === 'playing' && safety < 3) {
        const interval = getCurrentTickInterval();
        if (s.tickAccum < interval) break;
        s.tickAccum -= interval;
        advanceTick();
        safety += 1;
      }
    };

    const drawAstrolabeStar = (cx: number, cy: number, outerR: number, rot: number) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.beginPath();
      const spikes = 4;
      const innerR = outerR * 0.34;
      for (let i = 0; i < spikes * 2; i += 1) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = (i * Math.PI) / spikes;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const drawCornerReticle = (cx: number, cy: number, dx: number, dy: number) => {
      ctx.beginPath();
      // Bracket corner
      ctx.moveTo(cx + dx * 12, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * 12);
      // Inner optical cross [+]
      const mx = cx + dx * 7;
      const my = cy + dy * 7;
      ctx.moveTo(mx - 2.5, my);
      ctx.lineTo(mx + 2.5, my);
      ctx.moveTo(mx, my - 2.5);
      ctx.lineTo(mx, my + 2.5);
      ctx.stroke();
    };

    const render = () => {
      const s = engineRef.current;
      const cw = canvas.width;
      const ch = canvas.height;
      if (cw === 0 || ch === 0) return;

      ctx.save();
      ctx.scale(cw / LOGICAL_SIZE, ch / LOGICAL_SIZE);

      // Damped impact shake
      if (s.shakeAmp > 0) {
        const sx = (Math.random() - 0.5) * 2 * s.shakeAmp;
        const sy = (Math.random() - 0.5) * 2 * s.shakeAmp;
        ctx.translate(sx, sy);
      }

      // Deep space calibrated obsidian backdrop
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(-10, -10, LOGICAL_SIZE + 20, LOGICAL_SIZE + 20);

      const bgGrad = ctx.createRadialGradient(
        LOGICAL_SIZE * 0.5,
        LOGICAL_SIZE * 0.5,
        36,
        LOGICAL_SIZE * 0.5,
        LOGICAL_SIZE * 0.5,
        LOGICAL_SIZE * 0.72,
      );
      bgGrad.addColorStop(0, '#131822');
      bgGrad.addColorStop(1, '#0b0c0e');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, LOGICAL_SIZE, LOGICAL_SIZE);

      // Multi-layer subtle twinkling & slowly drifting deep-space starfield
      for (const st of s.bgStars) {
        const tw = 0.55 + 0.45 * Math.sin(s.animTime * 1.9 + st.phase);
        ctx.fillStyle = `rgba(227, 232, 245, ${(st.alpha * tw).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Precision astrolabe faint coordinate circles
      ctx.strokeStyle = 'rgba(227, 227, 227, 0.032)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(LOGICAL_SIZE * 0.5, LOGICAL_SIZE * 0.5, 112, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(LOGICAL_SIZE * 0.5, LOGICAL_SIZE * 0.5, 224, 0, Math.PI * 2);
      ctx.stroke();

      // Hairline orbital grid
      ctx.strokeStyle = 'rgba(227, 227, 227, 0.042)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < GRID_SIZE; i += 1) {
        const p = i * CELL;
        ctx.moveTo(p, 0);
        ctx.lineTo(p, LOGICAL_SIZE);
        ctx.moveTo(0, p);
        ctx.lineTo(LOGICAL_SIZE, p);
      }
      ctx.stroke();

      // Astrolabe outer coordinate scale ticks along all 4 rims
      ctx.strokeStyle =
        s.mode === 'classic'
          ? 'rgba(201, 106, 72, 0.25)'
          : 'rgba(138, 180, 248, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < GRID_SIZE; i += 1) {
        const p = i * CELL;
        const tickLen = i % 5 === 0 ? 7 : 3.5;
        ctx.moveTo(p, 0);
        ctx.lineTo(p, tickLen);
        ctx.moveTo(p, LOGICAL_SIZE);
        ctx.lineTo(p, LOGICAL_SIZE - tickLen);
        ctx.moveTo(0, p);
        ctx.lineTo(tickLen, p);
        ctx.moveTo(LOGICAL_SIZE, p);
        ctx.lineTo(LOGICAL_SIZE - tickLen, p);
      }
      ctx.stroke();

      // Quadrant calibration crosshairs
      ctx.strokeStyle = 'rgba(138, 180, 248, 0.16)';
      for (const gx of [5, 10, 15]) {
        for (const gy of [5, 10, 15]) {
          const px = gx * CELL;
          const py = gy * CELL;
          ctx.beginPath();
          ctx.moveTo(px - 4, py);
          ctx.lineTo(px + 4, py);
          ctx.moveTo(px, py - 4);
          ctx.lineTo(px, py + 4);
          ctx.stroke();
        }
      }

      // Four optical corner reticles [+]
      ctx.strokeStyle =
        s.mode === 'classic'
          ? 'rgba(214, 159, 135, 0.42)'
          : 'rgba(138, 180, 248, 0.44)';
      ctx.lineWidth = 1.2;
      drawCornerReticle(10, 10, 1, 1);
      drawCornerReticle(LOGICAL_SIZE - 10, 10, -1, 1);
      drawCornerReticle(10, LOGICAL_SIZE - 10, 1, -1);
      drawCornerReticle(LOGICAL_SIZE - 10, LOGICAL_SIZE - 10, -1, -1);

      // Perimeter mode indicator with calibrated inner atmospheric rim glow
      ctx.save();
      if (s.mode === 'classic') {
        const rimAlpha = 0.08 + 0.03 * Math.sin(s.animTime * 2.2);
        ctx.strokeStyle = `rgba(201, 106, 72, ${rimAlpha.toFixed(3)})`;
        ctx.lineWidth = 10;
        ctx.strokeRect(5, 5, LOGICAL_SIZE - 10, LOGICAL_SIZE - 10);

        ctx.strokeStyle = 'rgba(201, 106, 72, 0.65)';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, LOGICAL_SIZE - 2, LOGICAL_SIZE - 2);
      } else {
        const rimAlpha = 0.08 + 0.035 * Math.sin(s.animTime * 2.6);
        ctx.strokeStyle = `rgba(138, 180, 248, ${rimAlpha.toFixed(3)})`;
        ctx.lineWidth = 10;
        ctx.strokeRect(5, 5, LOGICAL_SIZE - 10, LOGICAL_SIZE - 10);

        ctx.strokeStyle = 'rgba(138, 180, 248, 0.58)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([8, 8]);
        ctx.lineDashOffset = -s.animTime * 16;
        ctx.strokeRect(1.5, 1.5, LOGICAL_SIZE - 3, LOGICAL_SIZE - 3);
      }
      ctx.restore();

      // Spatial portal warp light ripples along border edges
      for (const pp of s.portalPulses) {
        const prog = pp.life / pp.maxLife;
        const alpha = (1 - prog) * 0.85;
        const span = 18 + prog * 42;
        ctx.save();
        ctx.strokeStyle = `rgba(138, 180, 248, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 3.2 * (1 - prog * 0.5);
        ctx.beginPath();
        if (pp.edge === 'left') {
          ctx.moveTo(2, pp.pos - span);
          ctx.lineTo(2, pp.pos + span);
        } else if (pp.edge === 'right') {
          ctx.moveTo(LOGICAL_SIZE - 2, pp.pos - span);
          ctx.lineTo(LOGICAL_SIZE - 2, pp.pos + span);
        } else if (pp.edge === 'top') {
          ctx.moveTo(pp.pos - span, 2);
          ctx.lineTo(pp.pos + span, 2);
        } else {
          ctx.moveTo(pp.pos - span, LOGICAL_SIZE - 2);
          ctx.lineTo(pp.pos + span, LOGICAL_SIZE - 2);
        }
        ctx.stroke();

        // Soft inward arc ripple
        ctx.fillStyle = `rgba(138, 180, 248, ${(alpha * 0.25).toFixed(3)})`;
        const cx =
          pp.edge === 'left' ? 0 : pp.edge === 'right' ? LOGICAL_SIZE : pp.pos;
        const cy =
          pp.edge === 'top' ? 0 : pp.edge === 'bottom' ? LOGICAL_SIZE : pp.pos;
        ctx.beginPath();
        ctx.arc(cx, cy, 10 + prog * 26, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Regular food: pulsing dual concentric beacon rings + orbiting mini-satellite
      const fx = (s.food.x + 0.5) * CELL;
      const fy = (s.food.y + 0.5) * CELL;
      const pulse = 0.5 + 0.5 * Math.sin(s.animTime * 4.8);
      const pulse2 = 0.5 + 0.5 * Math.sin(s.animTime * 4.8 - 1.3);

      // Soft warm glow bed
      const fHalo = ctx.createRadialGradient(fx, fy, 2, fx, fy, 17);
      fHalo.addColorStop(0, 'rgba(229, 141, 103, 0.3)');
      fHalo.addColorStop(1, 'rgba(11, 12, 14, 0)');
      ctx.fillStyle = fHalo;
      ctx.beginPath();
      ctx.arc(fx, fy, 17, 0, Math.PI * 2);
      ctx.fill();

      // Dual concentric beacon rings
      ctx.strokeStyle = `rgba(229, 141, 103, ${(0.22 + pulse * 0.28).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(fx, fy, 8.8 + pulse * 2.4, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(214, 159, 135, ${(0.12 + pulse2 * 0.18).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(fx, fy, 12.2 + pulse2 * 2.2, 0, Math.PI * 2);
      ctx.stroke();

      // Orbiting mini-satellite dot
      const satAng = s.animTime * 3.1;
      const satX = fx + Math.cos(satAng) * 11.4;
      const satY = fy + Math.sin(satAng) * 11.4;
      ctx.fillStyle = '#f2d0bc';
      ctx.beginPath();
      ctx.arc(satX, satY, 1.8, 0, Math.PI * 2);
      ctx.fill();

      // Terracotta star-core
      ctx.fillStyle = '#c96a48';
      ctx.beginPath();
      ctx.arc(fx, fy, 6.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f7dfd0';
      ctx.beginPath();
      ctx.arc(fx - 1.5, fy - 1.5, 2.1, 0, Math.PI * 2);
      ctx.fill();

      // Timed Golden Bonus Star (+30 pts): rotating astrolabe star + radial countdown + soft starlight diffraction
      if (s.bonus) {
        const bx = (s.bonus.x + 0.5) * CELL;
        const by = (s.bonus.y + 0.5) * CELL;
        const ratio = Math.max(0, s.bonus.remaining / s.bonus.duration);

        const bHalo = ctx.createRadialGradient(bx, by, 2, bx, by, 22);
        bHalo.addColorStop(0, 'rgba(232, 196, 122, 0.34)');
        bHalo.addColorStop(1, 'rgba(11, 12, 14, 0)');
        ctx.fillStyle = bHalo;
        ctx.beginPath();
        ctx.arc(bx, by, 22, 0, Math.PI * 2);
        ctx.fill();

        // Delicate diffraction cross starlight
        ctx.strokeStyle = 'rgba(255, 245, 220, 0.26)';
        ctx.lineWidth = 1;
        const rayLen = 13 + Math.sin(s.animTime * 5.2) * 2.5;
        ctx.beginPath();
        ctx.moveTo(bx - rayLen, by);
        ctx.lineTo(bx + rayLen, by);
        ctx.moveTo(bx, by - rayLen);
        ctx.lineTo(bx, by + rayLen);
        ctx.stroke();

        // Radial countdown arc
        ctx.strokeStyle = 'rgba(232, 196, 122, 0.2)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, 12.6, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = '#e8c47a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, 12.6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
        ctx.stroke();

        ctx.fillStyle = '#e8c47a';
        drawAstrolabeStar(bx, by, 9.2, s.animTime * 1.45);
        ctx.fillStyle = '#fff5dc';
        drawAstrolabeStar(bx, by, 4.6, -s.animTime * 1.45 + Math.PI / 4);
      }

      // Compute smooth interpolated segment positions
      const tickInterval = getCurrentTickInterval();
      const alpha =
        s.status === 'playing'
          ? Math.min(1, Math.max(0, s.tickAccum / tickInterval))
          : 1;

      const interpPts: { x: number; y: number }[] = [];
      for (let i = 0; i < s.segments.length; i += 1) {
        const curr = s.segments[i];
        const prev = s.prevSegments[i] ?? curr;
        const dx = wrapDelta(prev.x, curr.x);
        const dy = wrapDelta(prev.y, curr.y);
        const rawX = (prev.x + dx * alpha + 0.5) * CELL;
        const rawY = (prev.y + dy * alpha + 0.5) * CELL;
        interpPts.push({
          x: ((rawX % LOGICAL_SIZE) + LOGICAL_SIZE) % LOGICAL_SIZE,
          y: ((rawY % LOGICAL_SIZE) + LOGICAL_SIZE) % LOGICAL_SIZE,
        });
      }

      // Tapered Luminous Comet Ribbon Body (pass 1: subtle soft outer comet glow)
      const total = interpPts.length;
      const boostPulse = 0.65 + 0.35 * Math.sin(s.animTime * 18);

      for (let i = total - 1; i >= 1; i -= 1) {
        const p1 = interpPts[i];
        const p2 = interpPts[i - 1];
        const t = i / Math.max(1, total - 1); // 0 head -> 1 tail
        const radius = CELL * (0.42 - t * 0.21);
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

        if (dist < CELL * 1.9) {
          // Soft luminous outer sheath
          ctx.strokeStyle = s.boostHeld
            ? `rgba(138, 180, 248, ${(0.22 * (1 - t * 0.72) * boostPulse).toFixed(3)})`
            : `rgba(214, 159, 135, ${(0.14 * (1 - t * 0.75)).toFixed(3)})`;
          ctx.lineWidth = radius * 2.75;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();

          // Core tapered comet ribbon body
          const rVal = s.boostHeld ? Math.round(212 - t * 76) : Math.round(238 - t * 94);
          const gVal = s.boostHeld ? Math.round(228 - t * 52) : Math.round(232 - t * 86);
          const bVal = s.boostHeld ? Math.round(252 - t * 24) : Math.round(224 - t * 68);
          const bodyAlpha = 0.94 - t * 0.52;
          ctx.strokeStyle = `rgba(${rVal},${gVal},${bVal},${bodyAlpha.toFixed(3)})`;
          ctx.lineWidth = radius * 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }

      // Pass 2: Luminous Star-Core Spine Line ("星核脊线") through the center of the comet body
      for (let i = total - 1; i >= 1; i -= 1) {
        const p1 = interpPts[i];
        const p2 = interpPts[i - 1];
        const t = i / Math.max(1, total - 1);
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (dist < CELL * 1.9) {
          const spineAlpha = s.boostHeld
            ? (0.95 - t * 0.55) * (0.75 + 0.25 * boostPulse)
            : 0.58 - t * 0.42;
          ctx.strokeStyle = s.boostHeld
            ? `rgba(246, 216, 146, ${spineAlpha.toFixed(3)})`
            : `rgba(229, 141, 103, ${spineAlpha.toFixed(3)})`;
          ctx.lineWidth = Math.max(1.2, (3.4 - t * 2.0) * (s.boostHeld ? 1.25 : 1));
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
      }

      // Streamlined Directional Comet Head + Food-Gazing Twin Eyes
      if (interpPts.length > 0) {
        const headPt = interpPts[0];
        const headR = CELL * 0.46;
        const lookDir = s.dirQueue[0] ?? s.direction;
        const v = DIR_VECTORS[lookDir];
        const headingAngle = Math.atan2(v.y, v.x);
        const px = -v.y;
        const py = v.x;

        // Calm orbital head halo
        const halo = ctx.createRadialGradient(
          headPt.x,
          headPt.y,
          headR * 0.35,
          headPt.x,
          headPt.y,
          headR * 2.4,
        );
        halo.addColorStop(
          0,
          s.boostHeld ? 'rgba(138, 180, 248, 0.34)' : 'rgba(229, 141, 103, 0.24)',
        );
        halo.addColorStop(1, 'rgba(11, 12, 14, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(headPt.x, headPt.y, headR * 2.4, 0, Math.PI * 2);
        ctx.fill();

        // Sculpted directional streamlined head silhouette
        ctx.save();
        ctx.translate(headPt.x, headPt.y);
        ctx.rotate(headingAngle);
        ctx.fillStyle = s.boostHeld ? '#e2eeff' : '#f5f1ea';
        ctx.beginPath();
        ctx.moveTo(headR * 1.18, 0);
        ctx.quadraticCurveTo(headR * 0.85, -headR * 0.96, -headR * 0.45, -headR * 0.92);
        ctx.arc(-headR * 0.35, 0, headR * 0.92, -Math.PI * 0.55, Math.PI * 0.55, true);
        ctx.quadraticCurveTo(headR * 0.85, headR * 0.96, headR * 1.18, 0);
        ctx.closePath();
        ctx.fill();

        // Forward optical nose crest
        ctx.fillStyle = s.boostHeld ? '#8ab4f8' : '#c96a48';
        ctx.beginPath();
        ctx.moveTo(headR * 1.05, 0);
        ctx.lineTo(headR * 0.35, -3.2);
        ctx.lineTo(headR * 0.5, 0);
        ctx.lineTo(headR * 0.35, 3.2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Compute gentle gaze shift toward nearest active target (bonus star if present, else food)
        const target = s.bonus ?? s.food;
        const tx = (target.x + 0.5) * CELL;
        const ty = (target.y + 0.5) * CELL;
        const gdx = tx - headPt.x;
        const gdy = ty - headPt.y;
        const gDist = Math.hypot(gdx, gdy) || 1;
        const gazeX = (gdx / gDist) * 1.2;
        const gazeY = (gdy / gDist) * 1.2;

        // Twin eyes with subtly food-gazing pupils
        const eyeForward = 2.8;
        const eyeSpread = 5.0;
        for (const side of [-1, 1]) {
          const ex = headPt.x + v.x * eyeForward + px * eyeSpread * side;
          const ey = headPt.y + v.y * eyeForward + py * eyeSpread * side;

          ctx.fillStyle = '#141923';
          ctx.beginPath();
          ctx.arc(ex, ey, 2.75, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = s.boostHeld ? '#8ab4f8' : '#f6d892';
          ctx.beginPath();
          ctx.arc(ex + gazeX * 0.75, ey + gazeY * 0.75, 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Expanding radial shockwave light rings
      for (const ring of s.rings) {
        const a = Math.max(0, 1 - ring.life / ring.maxLife);
        ctx.save();
        ctx.globalAlpha = a * 0.75;
        ctx.strokeStyle = ring.color;
        ctx.lineWidth = ring.lineWidth * (0.5 + a * 0.5);
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Sparks & boost stardust
      for (const p of s.sparks) {
        const a = Math.max(0, 1 - p.life / p.maxLife);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Floating score popups
      ctx.font = '600 13px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const pop of s.popups) {
        const a = Math.max(0, 1 - pop.life / pop.maxLife);
        ctx.globalAlpha = a;
        ctx.fillStyle = pop.color;
        ctx.fillText(pop.text, pop.x, pop.y);
      }
      ctx.globalAlpha = 1;

      // Brief warm impact flash on collision
      if (s.impactFlash > 0.01) {
        ctx.fillStyle = `rgba(201, 106, 72, ${(s.impactFlash * 0.16).toFixed(3)})`;
        ctx.fillRect(0, 0, LOGICAL_SIZE, LOGICAL_SIZE);
      }

      ctx.restore();
    };

    let rafId = 0;
    let lastTime = performance.now();

    const frame = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      stepSimulation(dt);
      render();
      rafId = window.requestAnimationFrame(frame);
    };

    rafId = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [playChime, playSound, spawnPopup, spawnPortalPulse, spawnShockRing, spawnSparks]);

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (engineRef.current.status !== 'playing') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    swipeAnchorRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const anchor = swipeAnchorRef.current;
    if (!anchor || anchor.pointerId !== e.pointerId) return;
    const dx = e.clientX - anchor.x;
    const dy = e.clientY - anchor.y;
    const threshold = 22;
    if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;

    if (Math.abs(dx) > Math.abs(dy)) {
      queueDirection(dx > 0 ? 'right' : 'left');
    } else {
      queueDirection(dy > 0 ? 'down' : 'up');
    }
    swipeAnchorRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  };

  const handleCanvasPointerEnd = () => {
    swipeAnchorRef.current = null;
  };

  const displayBest = Math.max(bestScore ?? 0, hudScore);
  const modeLocked = status === 'playing' || status === 'paused';

  return (
    <div className="flex w-full max-w-full flex-col gap-3 overflow-hidden">
      {/* Top HUD & Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-hairline bg-paper px-3.5 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs text-ink-muted">得分</span>
            <span className="tabular-nums-mono text-base font-semibold text-ink">
              {hudScore.toLocaleString('en-US')}
            </span>
          </div>
          <div className="h-3.5 w-px bg-hairline-strong" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs text-ink-muted">最高</span>
            <span className="tabular-nums-mono text-sm font-medium text-ink-muted">
              {displayBest.toLocaleString('en-US')}
            </span>
          </div>
          <div className="h-3.5 w-px bg-hairline-strong" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs text-ink-muted">长度</span>
            <span className="tabular-nums-mono text-sm font-medium text-ink">{hudLength}</span>
          </div>
          {boostActive ? (
            <span className="tabular-nums-mono inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
              <Zap className="h-3 w-3" />
              加速 ×1.5
            </span>
          ) : null}
          {bonusTimeLeft !== null && status === 'playing' ? (
            <span className="tabular-nums-mono rounded-full border border-postmark/35 bg-postmark/12 px-2 py-0.5 text-[11px] font-medium text-postmark">
              金星 {bonusTimeLeft.toFixed(1)}s
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Mode Toggle */}
          <div
            role="group"
            aria-label="边界模式"
            className="inline-flex rounded-full border border-hairline bg-surface p-0.5 text-xs"
          >
            <button
              type="button"
              disabled={modeLocked}
              onClick={() => selectMode('classic')}
              className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
                mode === 'classic'
                  ? 'bg-cta-bg text-cta-text'
                  : 'text-ink-muted hover:text-ink'
              } disabled:cursor-not-allowed disabled:opacity-70`}
            >
              经典边界
            </button>
            <button
              type="button"
              disabled={modeLocked}
              onClick={() => selectMode('wrap')}
              className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
                mode === 'wrap'
                  ? 'bg-cta-bg text-cta-text'
                  : 'text-ink-muted hover:text-ink'
              } disabled:cursor-not-allowed disabled:opacity-70`}
            >
              星轨穿墙
            </button>
          </div>

          {status === 'playing' || status === 'paused' ? (
            <button
              type="button"
              onClick={togglePause}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover"
              aria-label={status === 'paused' ? '继续游戏' : '暂停游戏'}
            >
              {status === 'paused' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => startNewRun()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover"
            aria-label="重新开始"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Square Deep-Space Orbital Board */}
      <div
        ref={stageRef}
        tabIndex={0}
        role="application"
        aria-label="星轨贪吃蛇游戏画布"
        data-only-dark="true"
        className="deep-space relative mx-auto w-full max-w-[480px] overflow-hidden rounded-[20px] border border-hairline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="relative aspect-square w-full">
          <canvas
            ref={canvasRef}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerEnd}
            onPointerCancel={handleCanvasPointerEnd}
            className="block h-full w-full touch-none select-none"
          />

          {/* Ready Overlay */}
          {status === 'ready' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/52 px-5 text-center backdrop-blur-[1.5px]">
              <p className="text-base font-medium tracking-tight text-[#f2efe9] sm:text-lg">
                星轨贪吃蛇
              </p>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-[#c7cdd6]">
                当前模式：{mode === 'classic' ? '经典边界（触壁结束）' : '星轨穿墙（边界无缝穿梭）'}。
                按住 Shift / 空格可双倍提速并获得 ×1.5 积分，每吃 4 枚信标触发限时 +30 分金星。
              </p>
              <button
                type="button"
                onClick={() => startNewRun()}
                className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>进入星轨</span>
              </button>
            </div>
          ) : null}

          {/* Pause Overlay */}
          {status === 'paused' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/70 px-4 text-center backdrop-blur-xs">
              <p className="text-base font-medium text-[#f2efe9]">轨道巡航已暂停</p>
              <div className="mt-3.5 flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={togglePause}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full bg-[#e3e3e3] px-4 text-xs font-medium text-[#131314]"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>继续</span>
                </button>
                <button
                  type="button"
                  onClick={() => startNewRun()}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-white/15 bg-[#14161a] px-4 text-xs font-medium text-[#e3e3e3]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>重新开始</span>
                </button>
              </div>
            </div>
          ) : null}

          {/* Game Over Overlay */}
          {status === 'gameover' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/75 px-4 text-center backdrop-blur-xs">
              <p className="text-sm font-medium text-[#d69f87]">
                {endReason === 'victory'
                  ? '全盘制霸 · 星轨圆满'
                  : endReason === 'wall'
                    ? '触碰边界护墙'
                    : '轨道自交中断'}
              </p>
              <p className="tabular-nums-mono mt-0.5 text-2xl font-semibold text-[#f2efe9]">
                {hudScore.toLocaleString('en-US')} 分
              </p>
              <p className="mt-0.5 text-xs text-[#9aa0a6]">
                {mode === 'classic' ? '经典边界' : '星轨穿墙'} · 最终长度{' '}
                <span className="tabular-nums-mono text-[#e3e3e3]">{hudLength}</span>
              </p>
              <button
                type="button"
                onClick={() => startNewRun()}
                className="mt-3.5 inline-flex min-h-[40px] items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
              >
                <RotateCcw className="h-4 w-4" />
                <span>再来一局</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Compact Mobile D-Pad + Orbital Boost Control Deck */}
      <div className="mx-auto flex w-full max-w-[480px] items-center justify-between gap-3 rounded-[16px] border border-hairline bg-paper px-3 py-2.5">
        <div className="grid grid-cols-3 gap-1.5">
          <div />
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              queueDirection('up');
            }}
            aria-label="向上转向"
            className="flex h-11 w-11 touch-none select-none items-center justify-center rounded-[12px] border border-hairline bg-surface text-ink active:bg-surface-hover"
          >
            <ChevronUp className="h-5 w-5" />
          </button>
          <div />
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              queueDirection('left');
            }}
            aria-label="向左转向"
            className="flex h-11 w-11 touch-none select-none items-center justify-center rounded-[12px] border border-hairline bg-surface text-ink active:bg-surface-hover"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              queueDirection('down');
            }}
            aria-label="向下转向"
            className="flex h-11 w-11 touch-none select-none items-center justify-center rounded-[12px] border border-hairline bg-surface text-ink active:bg-surface-hover"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              queueDirection('right');
            }}
            aria-label="向右转向"
            className="flex h-11 w-11 touch-none select-none items-center justify-center rounded-[12px] border border-hairline bg-surface text-ink active:bg-surface-hover"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-1 flex-col items-stretch gap-2">
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              setBoostInput(true);
            }}
            onPointerUp={() => setBoostInput(false)}
            onPointerLeave={() => setBoostInput(false)}
            onPointerCancel={() => setBoostInput(false)}
            className={`flex min-h-[54px] touch-none select-none flex-col items-center justify-center rounded-[14px] border px-3 text-sm font-medium transition-colors ${
              boostActive
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-hairline bg-surface text-ink hover:bg-surface-hover'
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <Zap className="h-4 w-4" />
              <span>按住加速</span>
            </span>
            <span className="tabular-nums-mono text-[11px] font-normal text-ink-muted">
              双倍速 · 得分 ×1.5
            </span>
          </button>
          <p className="text-center text-[11px] leading-tight text-ink-muted">
            画布内可直接滑动转向 · 支持 2 步转向缓冲
          </p>
        </div>
      </div>
    </div>
  );
}
