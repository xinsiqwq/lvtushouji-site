import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
  Shield,
} from 'lucide-react';
import type { ArcadeGameProps } from '../arcade-catalog';
import { arcadeSfx } from '../arcade-sfx';

type GameStatus = 'ready' | 'playing' | 'paused' | 'gameover';
type PowerUpKind = 'multiball' | 'wide' | 'pierce' | 'life';

interface Brick {
  id: number;
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  hitFlash: number;
}

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  docked: boolean;
  dockOffset: number;
  wallHitsSinceBrick: number;
  trail: { x: number; y: number }[];
}

interface PowerUpCapsule {
  kind: PowerUpKind;
  x: number;
  y: number;
  w: number;
  h: number;
  vy: number;
}

interface BrickParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
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
}

interface PaddleHitFlash {
  offsetX: number; // relative to paddleX
  life: number;
  maxLife: number;
}

interface FloatingNotice {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
  bold?: boolean;
}

interface LevelFormation {
  name: string;
  rows: readonly string[];
}

const LOGICAL_W = 640;
const LOGICAL_H = 460;
const PADDLE_Y = 424;
const PADDLE_H = 12;
const PADDLE_BASE_W = 106;
const PADDLE_WIDE_W = 154;
const PADDLE_SPEED = 560;
const BALL_RADIUS = 6.5;
const MAX_PADDLE_ANGLE = (62 * Math.PI) / 180;
const MIN_VERTICAL_RATIO = Math.sin((14 * Math.PI) / 180);
const WIDE_DURATION = 14;
const PIERCE_DURATION = 9;
const MAX_LIVES = 5;
const MAX_BALLS = 6;

const BRICK_COLS = 10;
const BRICK_PAD_X = 28;
const BRICK_TOP_Y = 54;
const BRICK_GAP = 6;
const BRICK_W = (LOGICAL_W - BRICK_PAD_X * 2 - BRICK_GAP * (BRICK_COLS - 1)) / BRICK_COLS; // 53
const BRICK_H = 20;

const LEVEL_FORMATIONS: readonly LevelFormation[] = [
  {
    name: '太阳系拱门',
    rows: [
      '..112211..',
      '.12233221.',
      '121....121',
      '11..22..11',
      '1..1111..1',
      '..1....1..',
    ],
  },
  {
    name: '轨道环阵',
    rows: [
      '..222222..',
      '.21111112.',
      '21..33..12',
      '21.3223.12',
      '21..33..12',
      '.21111112.',
      '..111111..',
    ],
  },
  {
    name: '双星翼阵',
    rows: [
      '321....123',
      '.321..123.',
      '..321123..',
      '.21122112.',
      '21..11..12',
      '1...11...1',
    ],
  },
  {
    name: '火星峡谷堡垒',
    rows: [
      '3333..3333',
      '2112..2112',
      '2132112312',
      '2112222112',
      '1111..1111',
      '..221122..',
    ],
  },
  {
    name: '日冕星阵',
    rows: [
      '....33....',
      '..223322..',
      '.21322312.',
      '3122332213',
      '.21322312.',
      '..221122..',
      '11..11..11',
    ],
  },
];

const POWERUP_META: Record<
  PowerUpKind,
  { badge: string; label: string; bg: string; border: string; text: string; glow: string }
> = {
  multiball: {
    badge: '×3',
    label: '多球分裂',
    bg: '#18253a',
    border: '#8ab4f8',
    text: '#dceaff',
    glow: 'rgba(138, 180, 248, 0.28)',
  },
  wide: {
    badge: '宽板',
    label: '宽幅磁板',
    bg: '#321f19',
    border: '#d69f87',
    text: '#f4e2d9',
    glow: 'rgba(214, 159, 135, 0.28)',
  },
  pierce: {
    badge: '穿透',
    label: '穿透光束',
    bg: '#322917',
    border: '#e8c47a',
    text: '#fcf0d2',
    glow: 'rgba(232, 196, 122, 0.3)',
  },
  life: {
    badge: '+1',
    label: '额外护盾',
    bg: '#182c22',
    border: '#86c59c',
    text: '#d8f2e1',
    glow: 'rgba(134, 197, 156, 0.28)',
  },
};

const BRICK_STYLES: Record<
  number,
  { fill: string; litBevel: string; shadeBevel: string; top: string; border: string }
> = {
  1: {
    fill: '#a65336',
    litBevel: '#df8b69',
    shadeBevel: '#632c1b',
    top: '#e59a7a',
    border: 'rgba(229, 154, 122, 0.36)',
  },
  2: {
    fill: '#3c5a86',
    litBevel: '#8ab4f8',
    shadeBevel: '#223552',
    top: '#9bc0fb',
    border: 'rgba(138, 180, 248, 0.38)',
  },
  3: {
    fill: '#936e30',
    litBevel: '#f0cf88',
    shadeBevel: '#583f18',
    top: '#f4d99b',
    border: 'rgba(232, 196, 122, 0.45)',
  },
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function getLevelBallSpeed(level: number): number {
  return Math.min(540, 340 + (level - 1) * 24);
}

function getDockedAimAngle(paddleX: number, paddleW: number, dockOffset: number): number {
  const center = paddleX + paddleW * 0.5 + dockOffset;
  const norm = clamp((center - LOGICAL_W * 0.5) / (LOGICAL_W * 0.44), -1, 1);
  // Subtle default angle offset so centered launch still has lively diagonal pitch
  const angled = norm * 0.56;
  return Math.abs(angled) < 0.1 ? (angled >= 0 ? 0.14 : -0.14) : angled;
}

function enforceMinPitch(ball: Ball, targetSpeed: number): void {
  const speed = Math.hypot(ball.vx, ball.vy) || targetSpeed;
  let vx = (ball.vx / speed) * targetSpeed;
  let vy = (ball.vy / speed) * targetSpeed;
  const minVy = targetSpeed * MIN_VERTICAL_RATIO;
  if (Math.abs(vy) < minVy) {
    const signY = vy === 0 ? -1 : Math.sign(vy);
    const signX = vx === 0 ? 1 : Math.sign(vx);
    vy = signY * minVy;
    vx = signX * Math.sqrt(Math.max(1, targetSpeed * targetSpeed - vy * vy));
  }
  ball.vx = vx;
  ball.vy = vy;
}

function buildLevelBricks(level: number): { bricks: Brick[]; formationName: string } {
  const idx = (level - 1) % LEVEL_FORMATIONS.length;
  const loopCycle = Math.floor((level - 1) / LEVEL_FORMATIONS.length);
  const formation = LEVEL_FORMATIONS[idx];
  const bricks: Brick[] = [];
  let nextId = 1;

  for (let r = 0; r < formation.rows.length; r += 1) {
    const rowStr = formation.rows[r];
    for (let c = 0; c < Math.min(BRICK_COLS, rowStr.length); c += 1) {
      const ch = rowStr[c];
      if (ch === '.' || ch === ' ') continue;
      const baseHp = Number(ch);
      if (!Number.isFinite(baseHp) || baseHp <= 0) continue;
      const bonusHp = loopCycle > 0 && (r + c) % 2 === 0 ? Math.min(1, loopCycle) : 0;
      const hp = Math.min(3, baseHp + bonusHp);
      bricks.push({
        id: nextId,
        col: c,
        row: r,
        x: BRICK_PAD_X + c * (BRICK_W + BRICK_GAP),
        y: BRICK_TOP_Y + r * (BRICK_H + BRICK_GAP),
        w: BRICK_W,
        h: BRICK_H,
        hp,
        maxHp: hp,
        hitFlash: 0,
      });
      nextId += 1;
    }
  }

  return { bricks, formationName: formation.name };
}

function createDockedBall(paddleX: number, paddleW: number): Ball {
  return {
    x: paddleX + paddleW * 0.5,
    y: PADDLE_Y - BALL_RADIUS - 1,
    vx: 0,
    vy: 0,
    radius: BALL_RADIUS,
    docked: true,
    dockOffset: 0,
    wallHitsSinceBrick: 0,
    trail: [],
  };
}

function createInitialBreakoutState() {
  const initial = buildLevelBricks(1);
  const paddleX = (LOGICAL_W - PADDLE_BASE_W) * 0.5;
  return {
    status: 'ready' as GameStatus,
    level: 1,
    formationName: initial.formationName,
    score: 0,
    lives: 3,
    bricksCleared: 0,
    combo: 0,
    paddleX,
    paddleW: PADDLE_BASE_W,
    targetPaddleW: PADDLE_BASE_W,
    paddleRecoilY: 0,
    paddleHits: [] as PaddleHitFlash[],
    moveLeft: false,
    moveRight: false,
    bricks: initial.bricks,
    balls: [createDockedBall(paddleX, PADDLE_BASE_W)],
    capsules: [] as PowerUpCapsule[],
    particles: [] as BrickParticle[],
    rings: [] as ShockRing[],
    notices: [] as FloatingNotice[],
    wideTimer: 0,
    pierceTimer: 0,
    shieldFlash: 0,
    warpSweep: -1, // 0..1 horizontal orbital sweep on level clear
    shakeAmp: 0,
    activePlayMs: 0,
    animTime: 0,
    runReported: false,
    gameOverAtMs: 0,
    lastHudSync: 0,
  };
}

export default function OrbitBreakoutGame({ onRunFinished, bestScore, muted }: ArcadeGameProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const onRunFinishedRef = useRef(onRunFinished);
  onRunFinishedRef.current = onRunFinished;

  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const [status, setStatus] = useState<GameStatus>('ready');
  const [hudScore, setHudScore] = useState(0);
  const [hudLevel, setHudLevel] = useState(1);
  const [hudFormation, setHudFormation] = useState(LEVEL_FORMATIONS[0].name);
  const [hudLives, setHudLives] = useState(3);
  const [hudBricksCleared, setHudBricksCleared] = useState(0);
  const [wideLeft, setWideLeft] = useState(0);
  const [pierceLeft, setPierceLeft] = useState(0);
  const [ballDocked, setBallDocked] = useState(true);
  const [levelBanner, setLevelBanner] = useState<string | null>(null);
  const [leftPressed, setLeftPressed] = useState(false);
  const [rightPressed, setRightPressed] = useState(false);

  const stateRef = useRef<ReturnType<typeof createInitialBreakoutState> | null>(null);
  if (stateRef.current === null) {
    stateRef.current = createInitialBreakoutState();
  }

  const playSound = useCallback(
    (kind: 'bounce' | 'pickup' | 'clear' | 'win' | 'gameOver' | 'click' | 'crack' | 'warp') => {
      if (mutedRef.current) return;
      arcadeSfx[kind]();
    },
    [],
  );

  const playComboSound = useCallback((step: number) => {
    if (mutedRef.current) return;
    arcadeSfx.combo(step);
  }, []);

  const launchDockedBalls = useCallback(() => {
    const s = stateRef.current!;
    if (s.status !== 'playing') return;
    const speed = getLevelBallSpeed(s.level);
    let launched = false;
    for (const ball of s.balls) {
      if (!ball.docked) continue;
      ball.docked = false;
      const launchAngle = getDockedAimAngle(s.paddleX, s.paddleW, ball.dockOffset);
      ball.vx = speed * Math.sin(launchAngle);
      ball.vy = -speed * Math.cos(launchAngle);
      enforceMinPitch(ball, speed);
      launched = true;
    }
    if (launched) {
      s.paddleRecoilY = 2.4;
      setBallDocked(false);
      playSound('bounce');
    }
  }, [playSound]);

  const startNewRun = useCallback(() => {
    const s = stateRef.current!;
    const lvl1 = buildLevelBricks(1);
    s.status = 'playing';
    s.level = 1;
    s.formationName = lvl1.formationName;
    s.score = 0;
    s.lives = 3;
    s.bricksCleared = 0;
    s.combo = 0;
    s.paddleW = PADDLE_BASE_W;
    s.targetPaddleW = PADDLE_BASE_W;
    s.paddleX = (LOGICAL_W - PADDLE_BASE_W) * 0.5;
    s.paddleRecoilY = 0;
    s.paddleHits = [];
    s.moveLeft = false;
    s.moveRight = false;
    s.bricks = lvl1.bricks;
    s.balls = [createDockedBall(s.paddleX, s.paddleW)];
    s.capsules = [];
    s.particles = [];
    s.rings = [];
    s.notices = [];
    s.wideTimer = 0;
    s.pierceTimer = 0;
    s.shieldFlash = 0;
    s.warpSweep = -1;
    s.shakeAmp = 0;
    s.activePlayMs = 0;
    s.runReported = false;
    s.lastHudSync = 0;

    setHudScore(0);
    setHudLevel(1);
    setHudFormation(lvl1.formationName);
    setHudLives(3);
    setHudBricksCleared(0);
    setWideLeft(0);
    setPierceLeft(0);
    setBallDocked(true);
    setLevelBanner(`轨道 01 · ${lvl1.formationName}`);
    setLeftPressed(false);
    setRightPressed(false);
    setStatus('playing');

    stageRef.current?.focus({ preventScroll: true });
    playSound('click');
  }, [playSound]);

  const togglePause = useCallback(() => {
    const s = stateRef.current!;
    if (s.status === 'playing') {
      s.status = 'paused';
      s.moveLeft = false;
      s.moveRight = false;
      setLeftPressed(false);
      setRightPressed(false);
      setStatus('paused');
    } else if (s.status === 'paused') {
      s.status = 'playing';
      setStatus('playing');
      stageRef.current?.focus({ preventScroll: true });
    }
  }, []);

  // Auto-hide level banner
  useEffect(() => {
    if (!levelBanner) return;
    const t = window.setTimeout(() => setLevelBanner(null), 1500);
    return () => window.clearTimeout(t);
  }, [levelBanner]);

  // Keyboard & visibility listeners
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextInputFocused()) return;
      const s = stateRef.current!;
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

      if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        s.moveLeft = true;
        setLeftPressed(true);
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        s.moveRight = true;
        setRightPressed(true);
      } else if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        if (!e.repeat) launchDockedBalls();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const s = stateRef.current!;
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
        s.moveLeft = false;
        setLeftPressed(false);
      } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
        s.moveRight = false;
        setRightPressed(false);
      }
    };

    const onVisibilityChange = () => {
      const s = stateRef.current!;
      if (document.hidden && s.status === 'playing') {
        s.status = 'paused';
        s.moveLeft = false;
        s.moveRight = false;
        setLeftPressed(false);
        setRightPressed(false);
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
  }, [launchDockedBalls, startNewRun, togglePause]);

  // Main sub-stepped 60-120fps physics & render RAF loop
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

    const spawnSparksAt = (x: number, y: number, color: string, count: number, spreadW = 6) => {
      const s = stateRef.current!;
      for (let i = 0; i < count; i += 1) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 48 + Math.random() * 145;
        s.particles.push({
          x: x + (Math.random() - 0.5) * spreadW,
          y: y + (Math.random() - 0.5) * 6,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 42,
          size: 2.0 + Math.random() * 2.4,
          color,
          life: 0,
          maxLife: 0.28 + Math.random() * 0.26,
        });
      }
      if (s.particles.length > 120) {
        s.particles.splice(0, s.particles.length - 120);
      }
    };

    const spawnShockRing = (x: number, y: number, maxR: number, color: string) => {
      const s = stateRef.current!;
      s.rings.push({
        x,
        y,
        r: 5,
        maxR,
        color,
        life: 0,
        maxLife: 0.32,
      });
      if (s.rings.length > 16) {
        s.rings.shift();
      }
    };

    const spawnNotice = (x: number, y: number, text: string, color: string, bold = false) => {
      const s = stateRef.current!;
      s.notices.push({
        x: clamp(x, 42, LOGICAL_W - 42),
        y: clamp(y, 28, LOGICAL_H - 36),
        text,
        color,
        life: 0,
        maxLife: 0.85,
        bold,
      });
    };

    const maybeDropPowerUp = (brick: Brick) => {
      const s = stateRef.current!;
      if (s.capsules.length >= 3) return;
      if (Math.random() > 0.24) return;

      const roll = Math.random();
      let kind: PowerUpKind;
      if (roll < 0.34) {
        kind = 'multiball';
      } else if (roll < 0.64) {
        kind = 'wide';
      } else if (roll < 0.86) {
        kind = 'pierce';
      } else {
        kind = s.lives < MAX_LIVES ? 'life' : 'multiball';
      }

      s.capsules.push({
        kind,
        x: brick.x + brick.w * 0.5 - 26,
        y: brick.y + brick.h * 0.5 - 10,
        w: 52,
        h: 21,
        vy: 132 + Math.min(48, s.level * 5),
      });
    };

    const applyPowerUp = (cap: PowerUpCapsule) => {
      const s = stateRef.current!;
      s.score += 25;
      const meta = POWERUP_META[cap.kind];
      const cx = cap.x + cap.w * 0.5;
      spawnNotice(cx, PADDLE_Y - 14, meta.label, meta.border, true);
      spawnShockRing(cx, PADDLE_Y, 34, meta.border);
      spawnSparksAt(cx, PADDLE_Y, meta.border, 8, 16);
      playSound('pickup');

      if (cap.kind === 'wide') {
        s.wideTimer = WIDE_DURATION;
        s.targetPaddleW = PADDLE_WIDE_W;
        setWideLeft(Math.ceil(WIDE_DURATION));
      } else if (cap.kind === 'pierce') {
        s.pierceTimer = PIERCE_DURATION;
        setPierceLeft(Math.ceil(PIERCE_DURATION));
      } else if (cap.kind === 'life') {
        if (s.lives < MAX_LIVES) {
          s.lives += 1;
          setHudLives(s.lives);
        } else {
          s.score += 100;
        }
        s.shieldFlash = 0.65;
      } else if (cap.kind === 'multiball') {
        const speed = getLevelBallSpeed(s.level);
        const source = s.balls.find((b) => !b.docked) ?? s.balls[0];
        if (source) {
          if (source.docked) {
            source.docked = false;
            setBallDocked(false);
            source.vx = speed * 0.2;
            source.vy = -speed * 0.98;
            enforceMinPitch(source, speed);
          }
          const baseAngle = Math.atan2(source.vy, source.vx);
          const offsets = [-0.42, 0.42];
          for (const delta of offsets) {
            if (s.balls.length >= MAX_BALLS) break;
            const ang = baseAngle + delta;
            const child: Ball = {
              x: source.x,
              y: source.y,
              vx: Math.cos(ang) * speed,
              vy: Math.sin(ang) * speed,
              radius: BALL_RADIUS,
              docked: false,
              dockOffset: 0,
              wallHitsSinceBrick: 0,
              trail: [],
            };
            enforceMinPitch(child, speed);
            s.balls.push(child);
          }
        }
      }
    };

    const advanceToNextLevel = () => {
      const s = stateRef.current!;
      const clearBonus = 150 * s.level;
      s.score += clearBonus;
      s.level += 1;
      const built = buildLevelBricks(s.level);
      s.formationName = built.formationName;
      s.bricks = built.bricks;
      s.capsules = [];
      s.combo = 0;
      s.warpSweep = 0;
      s.balls = [createDockedBall(s.paddleX, s.paddleW)];

      setHudScore(s.score);
      setHudLevel(s.level);
      setHudFormation(built.formationName);
      setBallDocked(true);
      setLevelBanner(
        `进入第 ${String(s.level).padStart(2, '0')} 轨道 · ${built.formationName} (+${clearBonus})`,
      );
      playSound('warp');
    };

    const handleBrickDamage = (brick: Brick, isPiercing: boolean) => {
      const s = stateRef.current!;
      const style = BRICK_STYLES[brick.hp] ?? BRICK_STYLES[1];
      const cx = brick.x + brick.w * 0.5;
      const cy = brick.y + brick.h * 0.5;

      brick.hp = isPiercing ? 0 : brick.hp - 1;
      brick.hitFlash = 0.14;

      if (brick.hp <= 0) {
        s.bricksCleared += 1;
        s.combo += 1;
        const pts = 20 * brick.maxHp + 5 * Math.min(s.combo, 12);
        s.score += pts;
        spawnSparksAt(cx, cy, style.litBevel, 10, brick.w * 0.65);
        spawnShockRing(cx, cy, brick.maxHp >= 2 ? 34 : 24, style.litBevel);

        // Multi-HP armored brick break triggers crisp damped micro-shake
        if (brick.maxHp >= 2) {
          s.shakeAmp = Math.max(s.shakeAmp, brick.maxHp === 3 ? 4.4 : 2.6);
        }

        if (s.combo >= 2) {
          spawnNotice(
            cx,
            brick.y + 4,
            `×${s.combo}  +${pts}`,
            s.combo >= 4 ? '#f4d99b' : '#8ab4f8',
            true,
          );
          playComboSound(s.combo - 1);
        } else {
          playSound('clear');
        }
        maybeDropPowerUp(brick);
      } else {
        // Armored brick cracked without shattering -> crisp crystalline crack SFX + shards
        s.score += 10;
        spawnSparksAt(cx, cy, style.litBevel, 5, brick.w * 0.45);
        s.shakeAmp = Math.max(s.shakeAmp, 1.4);
        playSound('crack');
      }
    };

    const stepSimulation = (dt: number) => {
      const s = stateRef.current!;
      s.animTime += dt;

      // Damped screen shake & elastic paddle recoil recovery
      if (s.shakeAmp > 0.04) {
        s.shakeAmp *= Math.exp(-dt * 16);
      } else {
        s.shakeAmp = 0;
      }

      if (s.paddleRecoilY > 0.02) {
        s.paddleRecoilY *= Math.exp(-dt * 20);
      } else {
        s.paddleRecoilY = 0;
      }

      // Level-clear horizontal warp light sweep
      if (s.warpSweep >= 0) {
        s.warpSweep += dt * 1.9;
        if (s.warpSweep > 1.25) s.warpSweep = -1;
      }

      // Update paddle hit flashes
      for (let i = s.paddleHits.length - 1; i >= 0; i -= 1) {
        const h = s.paddleHits[i];
        h.life += dt;
        if (h.life >= h.maxLife) s.paddleHits.splice(i, 1);
      }

      // Update debris, shockwaves & floating notices
      for (let i = s.particles.length - 1; i >= 0; i -= 1) {
        const p = s.particles[i];
        p.life += dt;
        if (p.life >= p.maxLife) {
          s.particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 340 * dt;
      }

      for (let i = s.rings.length - 1; i >= 0; i -= 1) {
        const ring = s.rings[i];
        ring.life += dt;
        if (ring.life >= ring.maxLife) {
          s.rings.splice(i, 1);
          continue;
        }
        const prog = ring.life / ring.maxLife;
        ring.r = 5 + (ring.maxR - 5) * (1 - Math.pow(1 - prog, 2.3));
      }

      for (let i = s.notices.length - 1; i >= 0; i -= 1) {
        const n = s.notices[i];
        n.life += dt;
        if (n.life >= n.maxLife) {
          s.notices.splice(i, 1);
          continue;
        }
        n.y -= 30 * dt;
      }

      if (s.shieldFlash > 0) {
        s.shieldFlash = Math.max(0, s.shieldFlash - dt);
      }

      if (s.status !== 'playing') return;

      s.activePlayMs += dt * 1000;

      // Timed power-up countdowns
      if (s.wideTimer > 0) {
        s.wideTimer = Math.max(0, s.wideTimer - dt);
        if (s.wideTimer === 0) {
          s.targetPaddleW = PADDLE_BASE_W;
        }
      }
      if (s.pierceTimer > 0) {
        s.pierceTimer = Math.max(0, s.pierceTimer - dt);
      }

      // Smooth paddle width easing (preserving paddle center)
      const prevW = s.paddleW;
      s.paddleW += (s.targetPaddleW - s.paddleW) * Math.min(1, dt * 12);
      if (Math.abs(s.paddleW - prevW) > 0.01) {
        s.paddleX -= (s.paddleW - prevW) * 0.5;
      }

      // Keyboard paddle velocity
      const dir = (s.moveRight ? 1 : 0) - (s.moveLeft ? 1 : 0);
      if (dir !== 0) {
        s.paddleX += dir * PADDLE_SPEED * dt;
      }
      s.paddleX = clamp(s.paddleX, 8, LOGICAL_W - s.paddleW - 8);

      // Decay brick hit flashes
      for (const b of s.bricks) {
        if (b.hitFlash > 0) b.hitFlash = Math.max(0, b.hitFlash - dt);
      }

      // Sub-stepped continuous ball physics
      const targetSpeed = getLevelBallSpeed(s.level);
      const isPiercing = s.pierceTimer > 0;
      const maxDisp = targetSpeed * dt;
      const subSteps = Math.max(1, Math.ceil(maxDisp / (BALL_RADIUS * 0.42)));
      const subDt = dt / subSteps;

      for (let step = 0; step < subSteps; step += 1) {
        for (let bi = s.balls.length - 1; bi >= 0; bi -= 1) {
          const ball = s.balls[bi];
          if (ball.docked) {
            ball.x = clamp(
              s.paddleX + s.paddleW * 0.5 + ball.dockOffset,
              s.paddleX + 14,
              s.paddleX + s.paddleW - 14,
            );
            ball.y = PADDLE_Y - ball.radius - 1;
            continue;
          }

          ball.x += ball.vx * subDt;
          ball.y += ball.vy * subDt;

          // Left / right walls
          if (ball.x - ball.radius < 0) {
            ball.x = ball.radius;
            ball.vx = Math.abs(ball.vx);
            ball.wallHitsSinceBrick += 1;
            if (ball.wallHitsSinceBrick >= 6) {
              ball.vy += Math.sign(ball.vy || 1) * 28;
              ball.wallHitsSinceBrick = 0;
            }
            enforceMinPitch(ball, targetSpeed);
            playSound('bounce');
          } else if (ball.x + ball.radius > LOGICAL_W) {
            ball.x = LOGICAL_W - ball.radius;
            ball.vx = -Math.abs(ball.vx);
            ball.wallHitsSinceBrick += 1;
            if (ball.wallHitsSinceBrick >= 6) {
              ball.vy += Math.sign(ball.vy || 1) * 28;
              ball.wallHitsSinceBrick = 0;
            }
            enforceMinPitch(ball, targetSpeed);
            playSound('bounce');
          }

          // Top wall
          if (ball.y - ball.radius < 0) {
            ball.y = ball.radius;
            ball.vy = Math.abs(ball.vy);
            enforceMinPitch(ball, targetSpeed);
            playSound('bounce');
          }

          // Paddle reflection (-62° .. +62° continuous steering + 3px downward recoil + contact spark)
          if (
            ball.vy > 0 &&
            ball.y + ball.radius >= PADDLE_Y &&
            ball.y - ball.radius <= PADDLE_Y + PADDLE_H &&
            ball.x + ball.radius >= s.paddleX - 2 &&
            ball.x - ball.radius <= s.paddleX + s.paddleW + 2
          ) {
            const paddleCenter = s.paddleX + s.paddleW * 0.5;
            const hitOffset = clamp((ball.x - paddleCenter) / (s.paddleW * 0.5), -1, 1);
            const angle = hitOffset * MAX_PADDLE_ANGLE;
            ball.vx = targetSpeed * Math.sin(angle);
            ball.vy = -targetSpeed * Math.cos(angle);
            ball.y = PADDLE_Y - ball.radius - 0.5;
            ball.wallHitsSinceBrick = 0;
            s.combo = 0;
            s.paddleRecoilY = 3.2;
            s.paddleHits.push({
              offsetX: clamp(ball.x - s.paddleX, 6, s.paddleW - 6),
              life: 0,
              maxLife: 0.24,
            });
            spawnSparksAt(ball.x, PADDLE_Y, isPiercing ? '#f4d99b' : '#8ab4f8', 6, 4);
            playSound('bounce');
          }

          // Brick collisions (circle vs AABB)
          for (let k = s.bricks.length - 1; k >= 0; k -= 1) {
            const brick = s.bricks[k];
            const closestX = clamp(ball.x, brick.x, brick.x + brick.w);
            const closestY = clamp(ball.y, brick.y, brick.y + brick.h);
            const dx = ball.x - closestX;
            const dy = ball.y - closestY;
            const distSq = dx * dx + dy * dy;

            if (distSq <= ball.radius * ball.radius) {
              ball.wallHitsSinceBrick = 0;

              if (!isPiercing) {
                const overlapLeft = ball.x + ball.radius - brick.x;
                const overlapRight = brick.x + brick.w - (ball.x - ball.radius);
                const overlapTop = ball.y + ball.radius - brick.y;
                const overlapBottom = brick.y + brick.h - (ball.y - ball.radius);
                const minOverlapX = Math.min(overlapLeft, overlapRight);
                const minOverlapY = Math.min(overlapTop, overlapBottom);

                if (minOverlapX < minOverlapY) {
                  ball.vx = overlapLeft < overlapRight ? -Math.abs(ball.vx) : Math.abs(ball.vx);
                  ball.x =
                    overlapLeft < overlapRight
                      ? brick.x - ball.radius - 0.2
                      : brick.x + brick.w + ball.radius + 0.2;
                } else {
                  ball.vy = overlapTop < overlapBottom ? -Math.abs(ball.vy) : Math.abs(ball.vy);
                  ball.y =
                    overlapTop < overlapBottom
                      ? brick.y - ball.radius - 0.2
                      : brick.y + brick.h + ball.radius + 0.2;
                }
                enforceMinPitch(ball, targetSpeed);
              }

              handleBrickDamage(brick, isPiercing);
              if (brick.hp <= 0) {
                s.bricks.splice(k, 1);
              }

              if (!isPiercing) {
                break;
              }
            }
          }

          // Lost ball below floor
          if (ball.y - ball.radius > LOGICAL_H + 12) {
            s.balls.splice(bi, 1);
          }
        }
      }

      // Record sleek motion trails
      for (const ball of s.balls) {
        if (!ball.docked) {
          ball.trail.push({ x: ball.x, y: ball.y });
          if (ball.trail.length > 11) ball.trail.shift();
        } else if (ball.trail.length > 0) {
          ball.trail.length = 0;
        }
      }

      // Falling power-up capsules
      for (let i = s.capsules.length - 1; i >= 0; i -= 1) {
        const cap = s.capsules[i];
        cap.y += cap.vy * dt;
        const caught =
          cap.y + cap.h >= PADDLE_Y &&
          cap.y <= PADDLE_Y + PADDLE_H + 6 &&
          cap.x + cap.w >= s.paddleX &&
          cap.x <= s.paddleX + s.paddleW;
        if (caught) {
          applyPowerUp(cap);
          s.capsules.splice(i, 1);
          continue;
        }
        if (cap.y > LOGICAL_H + 24) {
          s.capsules.splice(i, 1);
        }
      }

      // Check level completion
      if (s.bricks.length === 0) {
        advanceToNextLevel();
        return;
      }

      // Check life loss / game over when all balls are gone
      if (s.balls.length === 0) {
        s.lives -= 1;
        s.combo = 0;
        s.wideTimer = 0;
        s.pierceTimer = 0;
        s.targetPaddleW = PADDLE_BASE_W;
        s.shakeAmp = 5.5;
        setHudLives(Math.max(0, s.lives));
        setWideLeft(0);
        setPierceLeft(0);

        if (s.lives <= 0) {
          s.status = 'gameover';
          s.gameOverAtMs = performance.now();
          s.moveLeft = false;
          s.moveRight = false;
          setLeftPressed(false);
          setRightPressed(false);
          setHudScore(s.score);
          setHudBricksCleared(s.bricksCleared);
          setStatus('gameover');
          playSound('gameOver');

          if (!s.runReported) {
            s.runReported = true;
            onRunFinishedRef.current({
              score: Math.max(0, Math.round(s.score)),
              durationMs: Math.max(0, Math.round(s.activePlayMs)),
              meta: {
                level: s.level,
                bricksCleared: s.bricksCleared,
              },
            });
          }
          return;
        }

        s.balls.push(createDockedBall(s.paddleX, s.paddleW));
        setBallDocked(true);
        playSound('click');
      }

      // Throttled HUD sync
      const now = performance.now();
      if (now - s.lastHudSync > 70) {
        s.lastHudSync = now;
        setHudScore(s.score);
        setHudBricksCleared(s.bricksCleared);
        setWideLeft(s.wideTimer > 0 ? Math.ceil(s.wideTimer) : 0);
        setPierceLeft(s.pierceTimer > 0 ? Math.ceil(s.pierceTimer) : 0);
      }
    };

    const drawPrismBrick = (brick: Brick) => {
      const style = BRICK_STYLES[brick.hp] ?? BRICK_STYLES[1];
      const { x, y, w, h } = brick;

      ctx.save();

      // Subtle architectural bottom drop shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 2.2, w, h, 4);
      ctx.fill();

      // Main prism body
      ctx.fillStyle = brick.hitFlash > 0 ? '#f2efe9' : style.fill;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 4);
      ctx.fill();

      // 4-edge optical directional bevels (top + left lit, bottom + right shaded)
      if (brick.hitFlash <= 0) {
        // Top lit bevel
        ctx.fillStyle = style.litBevel;
        ctx.globalAlpha = 0.65;
        ctx.beginPath();
        ctx.moveTo(x + 2, y + 1);
        ctx.lineTo(x + w - 2, y + 1);
        ctx.lineTo(x + w - 4.5, y + 3.4);
        ctx.lineTo(x + 4.5, y + 3.4);
        ctx.closePath();
        ctx.fill();

        // Left lit bevel
        ctx.globalAlpha = 0.34;
        ctx.beginPath();
        ctx.moveTo(x + 1, y + 2);
        ctx.lineTo(x + 3.4, y + 4);
        ctx.lineTo(x + 3.4, y + h - 4);
        ctx.lineTo(x + 1, y + h - 2);
        ctx.closePath();
        ctx.fill();

        // Bottom shaded bevel
        ctx.fillStyle = style.shadeBevel;
        ctx.globalAlpha = 0.72;
        ctx.beginPath();
        ctx.moveTo(x + 2, y + h - 1);
        ctx.lineTo(x + w - 2, y + h - 1);
        ctx.lineTo(x + w - 4.5, y + h - 3.6);
        ctx.lineTo(x + 4.5, y + h - 3.6);
        ctx.closePath();
        ctx.fill();

        // Right shaded bevel
        ctx.globalAlpha = 0.48;
        ctx.beginPath();
        ctx.moveTo(x + w - 1, y + 2);
        ctx.lineTo(x + w - 3.4, y + 4);
        ctx.lineTo(x + w - 3.4, y + h - 4);
        ctx.lineTo(x + w - 1, y + h - 2);
        ctx.closePath();
        ctx.fill();

        // Diagonal optical glass sheen band inside clipped brick
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, w - 2, h - 2, 3.5);
        ctx.clip();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.085)';
        ctx.beginPath();
        ctx.moveTo(x + w * 0.14, y);
        ctx.lineTo(x + w * 0.42, y);
        ctx.lineTo(x + w * 0.24, y + h);
        ctx.lineTo(x - w * 0.04, y + h);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // Crisp structural border hairline
      ctx.globalAlpha = 1;
      ctx.strokeStyle = brick.hitFlash > 0 ? '#ffffff' : style.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4);
      ctx.stroke();

      // Corner metallic micro-rivets on 3-HP Titanium Gold bricks
      if (brick.maxHp === 3 && brick.hitFlash <= 0) {
        ctx.fillStyle = 'rgba(250, 236, 203, 0.55)';
        const inset = 4.6;
        for (const rx of [x + inset, x + w - inset]) {
          for (const ry of [y + inset, y + h - inset]) {
            ctx.beginPath();
            ctx.arc(rx, ry, 1.05, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Structural fracture cracks when multi-HP brick has taken armor damage
      const damage = brick.maxHp - brick.hp;
      if (damage > 0 && brick.hitFlash <= 0) {
        ctx.strokeStyle = 'rgba(11, 12, 14, 0.72)';
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(x + w * 0.28, y + 1.5);
        ctx.lineTo(x + w * 0.4, y + h * 0.48);
        ctx.lineTo(x + w * 0.32, y + h * 0.88);
        if (damage >= 2) {
          ctx.moveTo(x + w * 0.4, y + h * 0.48);
          ctx.lineTo(x + w * 0.64, y + h * 0.36);
          ctx.lineTo(x + w * 0.74, y + h - 2);
        }
        ctx.stroke();

        // Thin bright fracture edge highlight
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(x + w * 0.295, y + 2);
        ctx.lineTo(x + w * 0.415, y + h * 0.48);
        ctx.stroke();
      }

      // Crisp durability pips for multi-HP bricks
      if (brick.maxHp > 1 && brick.hitFlash <= 0) {
        const pipGap = 6;
        const totalW = (brick.hp - 1) * pipGap;
        const startX = x + w * 0.5 - totalW * 0.5;
        const pipY = y + h * 0.56;
        ctx.fillStyle = 'rgba(245, 241, 234, 0.85)';
        for (let i = 0; i < brick.hp; i += 1) {
          ctx.beginPath();
          ctx.arc(startX + i * pipGap, pipY, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    };

    const drawCapsuleIcon = (kind: PowerUpKind, ix: number, iy: number, color: string) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      if (kind === 'multiball') {
        ctx.beginPath();
        ctx.arc(ix, iy - 2.3, 1.6, 0, Math.PI * 2);
        ctx.arc(ix - 2.4, iy + 2, 1.6, 0, Math.PI * 2);
        ctx.arc(ix + 2.4, iy + 2, 1.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (kind === 'wide') {
        ctx.beginPath();
        ctx.moveTo(ix - 4.2, iy);
        ctx.lineTo(ix + 4.2, iy);
        ctx.moveTo(ix - 2.4, iy - 2.2);
        ctx.lineTo(ix - 4.4, iy);
        ctx.lineTo(ix - 2.4, iy + 2.2);
        ctx.moveTo(ix + 2.4, iy - 2.2);
        ctx.lineTo(ix + 4.4, iy);
        ctx.lineTo(ix + 2.4, iy + 2.2);
        ctx.stroke();
      } else if (kind === 'pierce') {
        ctx.beginPath();
        ctx.moveTo(ix, iy - 4.2);
        ctx.lineTo(ix + 3.2, iy);
        ctx.lineTo(ix, iy + 4.2);
        ctx.lineTo(ix - 3.2, iy);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(ix - 3.5, iy);
        ctx.lineTo(ix + 3.5, iy);
        ctx.moveTo(ix, iy - 3.5);
        ctx.lineTo(ix, iy + 3.5);
        ctx.stroke();
      }
      ctx.restore();
    };

    const drawAimPreview = (ball: Ball, paddleX: number, paddleW: number, pierceOn: boolean) => {
      const angle = getDockedAimAngle(paddleX, paddleW, ball.dockOffset);
      const dx = Math.sin(angle);
      const dy = -Math.cos(angle);
      const startX = ball.x;
      const startY = ball.y - ball.radius - 1;
      const totalLen = 135;

      // Compute optional wall bounce segment along the aim ray
      let tWall = Infinity;
      if (dx < -0.001) tWall = (BALL_RADIUS - startX) / dx;
      else if (dx > 0.001) tWall = (LOGICAL_W - BALL_RADIUS - startX) / dx;
      const tTop = (BALL_RADIUS - startY) / dy;
      const tHit = Math.min(tWall, tTop);

      ctx.save();
      ctx.strokeStyle = pierceOn
        ? 'rgba(232, 196, 122, 0.48)'
        : 'rgba(138, 180, 248, 0.44)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -stateRef.current!.animTime * 22;

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      if (tHit > 0 && tHit < totalLen) {
        const hx = startX + dx * tHit;
        const hy = startY + dy * tHit;
        ctx.lineTo(hx, hy);
        const rem = totalLen - tHit;
        const rx = tWall <= tTop ? -dx : dx;
        const ry = tTop < tWall ? -dy : dy;
        ctx.lineTo(hx + rx * rem, hy + ry * rem);
      } else {
        ctx.lineTo(startX + dx * totalLen, startY + dy * totalLen);
      }
      ctx.stroke();

      // Subtle target reticle pip at tip of aim ray
      const tipX = tHit > 0 && tHit < totalLen ? startX + dx * tHit : startX + dx * totalLen;
      const tipY = tHit > 0 && tHit < totalLen ? startY + dy * tHit : startY + dy * totalLen;
      ctx.setLineDash([]);
      ctx.fillStyle = pierceOn ? 'rgba(232, 196, 122, 0.6)' : 'rgba(138, 180, 248, 0.55)';
      ctx.beginPath();
      ctx.arc(tipX, tipY, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const render = () => {
      const s = stateRef.current!;
      const cw = canvas.width;
      const ch = canvas.height;
      if (cw === 0 || ch === 0) return;

      ctx.save();
      ctx.scale(cw / LOGICAL_W, ch / LOGICAL_H);

      // Damped micro screen shake
      if (s.shakeAmp > 0) {
        const sx = (Math.random() - 0.5) * 2 * s.shakeAmp;
        const sy = (Math.random() - 0.5) * 2 * s.shakeAmp;
        ctx.translate(sx, sy);
      }

      // Calibrated deep-space darkroom field
      ctx.fillStyle = '#0b0c0e';
      ctx.fillRect(-10, -10, LOGICAL_W + 20, LOGICAL_H + 20);

      const bg = ctx.createRadialGradient(
        LOGICAL_W * 0.5,
        110,
        30,
        LOGICAL_W * 0.5,
        LOGICAL_H * 0.5,
        420,
      );
      bg.addColorStop(0, '#141a26');
      bg.addColorStop(1, '#0b0c0e');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

      // Subtle concentric orbital astrolabe guide arcs + subtle corner scale marks
      ctx.save();
      ctx.strokeStyle = 'rgba(227, 227, 227, 0.04)';
      ctx.lineWidth = 1;
      for (const rad of [140, 235, 330]) {
        ctx.beginPath();
        ctx.arc(LOGICAL_W * 0.5, LOGICAL_H + 30, rad, Math.PI, 0);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(227, 227, 227, 0.08)';
      ctx.beginPath();
      ctx.moveTo(14, 14);
      ctx.lineTo(24, 14);
      ctx.moveTo(14, 14);
      ctx.lineTo(14, 24);
      ctx.moveTo(LOGICAL_W - 14, 14);
      ctx.lineTo(LOGICAL_W - 24, 14);
      ctx.moveTo(LOGICAL_W - 14, 14);
      ctx.lineTo(LOGICAL_W - 14, 24);
      ctx.stroke();
      ctx.restore();

      // Subtle shield flash arc on +1 life pickup
      if (s.shieldFlash > 0) {
        ctx.strokeStyle = `rgba(134, 197, 156, ${(s.shieldFlash * 0.85).toFixed(3)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(12, LOGICAL_H - 6);
        ctx.lineTo(LOGICAL_W - 12, LOGICAL_H - 6);
        ctx.stroke();
      }

      // Faceted Optical Prism Bricks
      for (const brick of s.bricks) {
        drawPrismBrick(brick);
      }

      // Falling power-up capsules with soft halo + crisp geometric vector icon
      ctx.font = '600 11px "Inter", "Noto Sans SC", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const cap of s.capsules) {
        const meta = POWERUP_META[cap.kind];
        const cx = cap.x + cap.w * 0.5;
        const cy = cap.y + cap.h * 0.5;

        ctx.save();
        // Soft calm radial aura
        const halo = ctx.createRadialGradient(cx, cy, 4, cx, cy, 24);
        halo.addColorStop(0, meta.glow);
        halo.addColorStop(1, 'rgba(11, 12, 14, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(cx, cy, 24, 0, Math.PI * 2);
        ctx.fill();

        // Capsule chassis
        ctx.fillStyle = meta.bg;
        ctx.strokeStyle = meta.border;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.roundRect(cap.x, cap.y, cap.w, cap.h, 10.5);
        ctx.fill();
        ctx.stroke();

        // Geometric icon + short badge
        drawCapsuleIcon(cap.kind, cap.x + 12.5, cy, meta.border);
        ctx.fillStyle = meta.text;
        ctx.fillText(meta.badge, cap.x + 21.5, cy + 0.5);
        ctx.restore();
      }

      // Sculpted Aerospace Magnetic Paddle (with 3px downward recoil on ball impact)
      const py = PADDLE_Y + s.paddleRecoilY;
      ctx.save();
      // Subtle under-paddle floor shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.roundRect(s.paddleX + 2, py + 4, s.paddleW - 4, PADDLE_H, 6);
      ctx.fill();

      // Main metallic capsule body
      const paddleGrad = ctx.createLinearGradient(s.paddleX, py, s.paddleX, py + PADDLE_H);
      if (s.wideTimer > 0) {
        paddleGrad.addColorStop(0, '#edd0c2');
        paddleGrad.addColorStop(0.55, '#c4866c');
        paddleGrad.addColorStop(1, '#7a4531');
      } else {
        paddleGrad.addColorStop(0, '#f0f4fa');
        paddleGrad.addColorStop(0.55, '#b6c1d1');
        paddleGrad.addColorStop(1, '#6f7c90');
      }
      ctx.fillStyle = paddleGrad;
      ctx.beginPath();
      ctx.roundRect(s.paddleX, py, s.paddleW, PADDLE_H, 6);
      ctx.fill();

      // Left & Right Magnetic Pole End-Caps with subtle glow
      const capW = 9;
      const poleColor = s.wideTimer > 0 ? '#e59a7a' : '#8ab4f8';
      ctx.fillStyle = poleColor;
      ctx.beginPath();
      ctx.roundRect(s.paddleX, py, capW, PADDLE_H, [6, 2, 2, 6]);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(s.paddleX + s.paddleW - capW, py, capW, PADDLE_H, [2, 6, 6, 2]);
      ctx.fill();

      // Top chamfer optical highlight
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fillRect(s.paddleX + capW + 2, py + 1.2, s.paddleW - (capW + 2) * 2, 1.5);

      // Center precision calibration reticle notch & scale ticks
      const midX = s.paddleX + s.paddleW * 0.5;
      ctx.fillStyle = s.pierceTimer > 0 ? '#f4d99b' : '#1a73e8';
      ctx.fillRect(midX - 9, py + 4, 18, 2.5);
      ctx.fillStyle = 'rgba(11, 12, 14, 0.45)';
      ctx.fillRect(midX - 18, py + 4, 1.5, 4);
      ctx.fillRect(midX + 16.5, py + 4, 1.5, 4);

      // Contact impact hotspot flashes on paddle surface
      for (const hit of s.paddleHits) {
        const a = Math.max(0, 1 - hit.life / hit.maxLife);
        const hx = s.paddleX + hit.offsetX;
        const glow = ctx.createRadialGradient(hx, py + 2, 1, hx, py + 2, 18);
        glow.addColorStop(0, `rgba(255, 255, 255, ${(a * 0.9).toFixed(3)})`);
        glow.addColorStop(1, 'rgba(138, 180, 248, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(hx, py + 2, 18, 0, Math.PI * 2);
        ctx.fill();
      }

      // Live wide-paddle remaining bar integrated under paddle
      if (s.wideTimer > 0) {
        const ratio = clamp(s.wideTimer / WIDE_DURATION, 0, 1);
        ctx.fillStyle = 'rgba(214, 159, 135, 0.85)';
        ctx.fillRect(s.paddleX + 8, py + PADDLE_H + 3.5, (s.paddleW - 16) * ratio, 2);
      }
      ctx.restore();

      // Balls, live reflection aim preview & comet trails
      const pierceOn = s.pierceTimer > 0;
      for (const ball of s.balls) {
        if (ball.docked && s.status === 'playing') {
          drawAimPreview(ball, s.paddleX, s.paddleW, pierceOn);
        }

        // Silky fading comet trail (blazing gold-terracotta in pierce beam mode)
        for (let i = 0; i < ball.trail.length; i += 1) {
          const pt = ball.trail[i];
          const frac = (i + 1) / (ball.trail.length + 1);
          if (pierceOn) {
            ctx.fillStyle =
              i % 2 === 0
                ? `rgba(244, 217, 155, ${(frac * 0.42).toFixed(3)})`
                : `rgba(201, 106, 72, ${(frac * 0.36).toFixed(3)})`;
          } else {
            ctx.fillStyle = `rgba(138, 180, 248, ${(frac * 0.28).toFixed(3)})`;
          }
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, ball.radius * (0.38 + frac * 0.56), 0, Math.PI * 2);
          ctx.fill();
        }

        // Subtle luminous halo around ball
        const bGlow = ctx.createRadialGradient(
          ball.x,
          ball.y,
          ball.radius * 0.4,
          ball.x,
          ball.y,
          ball.radius * (pierceOn ? 2.6 : 1.9),
        );
        bGlow.addColorStop(
          0,
          pierceOn ? 'rgba(232, 196, 122, 0.42)' : 'rgba(138, 180, 248, 0.22)',
        );
        bGlow.addColorStop(1, 'rgba(11, 12, 14, 0)');
        ctx.fillStyle = bGlow;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius * (pierceOn ? 2.6 : 1.9), 0, Math.PI * 2);
        ctx.fill();

        // Crisp ball core + specular dot
        ctx.fillStyle = pierceOn ? '#f6d892' : '#f4f1ea';
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ball.x - 1.8, ball.y - 1.8, 1.8, 0, Math.PI * 2);
        ctx.fill();

        if (pierceOn) {
          ctx.strokeStyle = 'rgba(229, 141, 103, 0.85)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(ball.x, ball.y, ball.radius + 2.3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Expanding radial shockwave light rings on brick breaks & pickups
      for (const ring of s.rings) {
        const a = Math.max(0, 1 - ring.life / ring.maxLife);
        ctx.save();
        ctx.globalAlpha = a * 0.72;
        ctx.strokeStyle = ring.color;
        ctx.lineWidth = 1.6 * (0.4 + a * 0.6);
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Gravity-affected prism shard particles
      for (const p of s.particles) {
        const a = Math.max(0, 1 - p.life / p.maxLife);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
      }
      ctx.globalAlpha = 1;

      // Floating combo & pickup notices
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const n of s.notices) {
        const a = Math.max(0, 1 - n.life / n.maxLife);
        ctx.font = n.bold
          ? '600 13px "JetBrains Mono", "Inter", "Noto Sans SC", sans-serif'
          : '500 12px "Inter", "Noto Sans SC", system-ui, sans-serif';
        ctx.globalAlpha = a;
        ctx.fillStyle = n.color;
        ctx.fillText(n.text, n.x, n.y);
      }
      ctx.globalAlpha = 1;

      // Crisp horizontal orbital warp sweep on level clear
      if (s.warpSweep >= 0 && s.warpSweep <= 1.2) {
        const sx = s.warpSweep * LOGICAL_W;
        const wg = ctx.createLinearGradient(sx - 120, 0, sx + 30, 0);
        wg.addColorStop(0, 'rgba(138, 180, 248, 0)');
        wg.addColorStop(0.75, 'rgba(138, 180, 248, 0.22)');
        wg.addColorStop(0.92, 'rgba(244, 217, 155, 0.34)');
        wg.addColorStop(1, 'rgba(244, 217, 155, 0)');
        ctx.fillStyle = wg;
        ctx.fillRect(sx - 120, 0, 150, LOGICAL_H);
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
  }, [playComboSound, playSound]);

  const movePaddleToClientX = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    const s = stateRef.current!;
    if (!canvas || s.status !== 'playing') return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const logicalX = ((clientX - rect.left) / rect.width) * LOGICAL_W;
    s.paddleX = clamp(logicalX - s.paddleW * 0.5, 8, LOGICAL_W - s.paddleW - 8);
  }, []);

  const displayBest = Math.max(bestScore ?? 0, hudScore);
  const hasDockedBall = status === 'playing' && ballDocked;

  return (
    <div className="flex w-full max-w-full flex-col gap-3 overflow-hidden">
      {/* Compact HUD Bar */}
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
          <div className="flex items-center gap-1.5 text-xs">
            <span className="tabular-nums-mono rounded-full border border-hairline bg-surface px-2 py-0.5 font-medium text-ink">
              L{String(hudLevel).padStart(2, '0')}
            </span>
            <span className="hidden text-ink-muted sm:inline">{hudFormation}</span>
          </div>
          <div
            className="flex items-center gap-1 text-xs text-ink-muted"
            aria-label={`剩余护盾 ${hudLives}`}
          >
            <Shield className="h-3.5 w-3.5 text-postmark" />
            <span className="tabular-nums-mono font-medium text-ink">{hudLives}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {wideLeft > 0 ? (
            <span className="tabular-nums-mono rounded-full border border-postmark/40 bg-postmark/15 px-2 py-0.5 text-[11px] font-medium text-postmark">
              宽板 {wideLeft}s
            </span>
          ) : null}
          {pierceLeft > 0 ? (
            <span className="tabular-nums-mono rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
              穿透 {pierceLeft}s
            </span>
          ) : null}
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
            onClick={startNewRun}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover"
            aria-label="重新开始"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Deep-Space Breakout Stage */}
      <div
        ref={stageRef}
        tabIndex={0}
        role="application"
        aria-label="轨道打砖块游戏画布"
        data-only-dark="true"
        className="deep-space relative mx-auto w-full max-w-[640px] overflow-hidden rounded-[20px] border border-hairline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="relative aspect-[640/460] w-full">
          <canvas
            ref={canvasRef}
            onPointerMove={(e) => {
              if (e.pointerType === 'mouse' || e.buttons > 0) {
                movePaddleToClientX(e.clientX);
              }
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              if (stateRef.current?.status === 'playing') {
                movePaddleToClientX(e.clientX);
                launchDockedBalls();
              }
            }}
            className="block h-full w-full cursor-pointer touch-none select-none"
          />

          {/* Level Announcement Pill */}
          {levelBanner && status === 'playing' ? (
            <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-[#0b0c0e]/85 px-3 py-1 text-xs font-medium whitespace-nowrap text-[#e8c47a] backdrop-blur-sm">
              {levelBanner}
            </div>
          ) : null}

          {/* Launch prompt when ball is docked */}
          {hasDockedBall && !levelBanner ? (
            <div className="pointer-events-none absolute bottom-12 left-1/2 -translate-x-1/2 rounded-full border border-white/12 bg-[#0b0c0e]/75 px-3 py-1 text-[11px] text-[#c7cdd6]">
              移动挡板瞄准，按空格或点击画布发射弹球
            </div>
          ) : null}

          {/* Ready Overlay */}
          {status === 'ready' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/56 px-5 text-center backdrop-blur-[1.5px]">
              <p className="text-base font-medium tracking-tight text-[#f2efe9] sm:text-lg">
                轨道打砖块
              </p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-[#c7cdd6]">
                5 套手工几何轨道阵型循环递进，挡板边缘精准控角（-62° 至 +62°），拾取 ×3 多球、宽板、穿透与额外护盾胶囊。
              </p>
              <button
                type="button"
                onClick={startNewRun}
                className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>启动轨道</span>
              </button>
            </div>
          ) : null}

          {/* Pause Overlay */}
          {status === 'paused' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/70 px-4 text-center backdrop-blur-xs">
              <p className="text-base font-medium text-[#f2efe9]">轨道拦截已暂停</p>
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
                  onClick={startNewRun}
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
              <p className="text-sm font-medium text-[#d69f87]">护盾耗尽</p>
              <p className="tabular-nums-mono mt-0.5 text-2xl font-semibold text-[#f2efe9]">
                {hudScore.toLocaleString('en-US')} 分
              </p>
              <p className="mt-0.5 text-xs text-[#9aa0a6]">
                抵达第 <span className="tabular-nums-mono text-[#e3e3e3]">{hudLevel}</span> 轨道 · 击碎{' '}
                <span className="tabular-nums-mono text-[#e3e3e3]">{hudBricksCleared}</span> 块砖阵
              </p>
              <button
                type="button"
                onClick={startNewRun}
                className="mt-3.5 inline-flex min-h-[40px] items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
              >
                <RotateCcw className="h-4 w-4" />
                <span>再来一局</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Responsive Mobile & Keyboard Helper Bar */}
      <div className="mx-auto grid w-full max-w-[640px] grid-cols-3 gap-2">
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            if (stateRef.current) stateRef.current.moveLeft = true;
            setLeftPressed(true);
          }}
          onPointerUp={() => {
            if (stateRef.current) stateRef.current.moveLeft = false;
            setLeftPressed(false);
          }}
          onPointerLeave={() => {
            if (stateRef.current) stateRef.current.moveLeft = false;
            setLeftPressed(false);
          }}
          onPointerCancel={() => {
            if (stateRef.current) stateRef.current.moveLeft = false;
            setLeftPressed(false);
          }}
          className={`flex min-h-[44px] touch-none select-none items-center justify-center gap-1 rounded-[14px] border text-sm font-medium transition-colors ${
            leftPressed
              ? 'border-accent bg-accent/15 text-ink'
              : 'border-hairline bg-paper text-ink hover:bg-surface-hover'
          }`}
        >
          <ChevronLeft className="h-4 w-4" />
          <span>左移</span>
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            if (stateRef.current?.status === 'playing') {
              launchDockedBalls();
            } else {
              startNewRun();
            }
          }}
          className="flex min-h-[44px] touch-none select-none items-center justify-center rounded-[14px] border border-hairline bg-surface text-sm font-medium text-ink hover:bg-surface-hover active:scale-[0.98]"
        >
          {status === 'playing' ? '发射弹球' : '开始游戏'}
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            if (stateRef.current) stateRef.current.moveRight = true;
            setRightPressed(true);
          }}
          onPointerUp={() => {
            if (stateRef.current) stateRef.current.moveRight = false;
            setRightPressed(false);
          }}
          onPointerLeave={() => {
            if (stateRef.current) stateRef.current.moveRight = false;
            setRightPressed(false);
          }}
          onPointerCancel={() => {
            if (stateRef.current) stateRef.current.moveRight = false;
            setRightPressed(false);
          }}
          className={`flex min-h-[44px] touch-none select-none items-center justify-center gap-1 rounded-[14px] border text-sm font-medium transition-colors ${
            rightPressed
              ? 'border-accent bg-accent/15 text-ink'
              : 'border-hairline bg-paper text-ink hover:bg-surface-hover'
          }`}
        >
          <span>右移</span>
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
