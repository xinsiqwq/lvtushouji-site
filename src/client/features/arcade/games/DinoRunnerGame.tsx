import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pause, Play, RotateCcw } from 'lucide-react';
import type { ArcadeGameProps } from '../arcade-catalog';
import { arcadeSfx } from '../arcade-sfx';

type GameStatus = 'ready' | 'playing' | 'paused' | 'gameover';

type ObstacleKind =
  | 'spire_sm'
  | 'spire_tall'
  | 'cactus_double'
  | 'spire_triple'
  | 'drone_low'
  | 'drone_mid'
  | 'drone_high';

interface Obstacle {
  kind: ObstacleKind;
  x: number;
  y: number;
  w: number;
  h: number;
  wingPhase: number;
}

interface DustParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  kind: 'dust' | 'spark';
  color?: string;
}

interface DustRing {
  x: number;
  y: number;
  rx: number;
  maxRx: number;
  life: number;
  maxLife: number;
}

interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  len: number;
  life: number;
  maxLife: number;
}

interface FloatingCallout {
  x: number;
  y: number;
  text: string;
  life: number;
  maxLife: number;
}

interface AmbientSpeck {
  x: number;
  y: number;
  size: number;
  speedFactor: number;
  alpha: number;
}

interface DustMistBand {
  x: number;
  y: number;
  w: number;
  h: number;
  speedFactor: number;
  alpha: number;
}

interface StarPoint {
  x: number;
  y: number;
  r: number;
  phase: number;
}

interface GroundPebble {
  x: number;
  yOffset: number;
  w: number;
  h: number;
  kind: 'pebble' | 'notch';
}

interface SkyPalette {
  skyTop: [number, number, number];
  skyMid: [number, number, number];
  skyHorizon: [number, number, number];
  horizonGlow: [number, number, number];
  farMesa: [number, number, number];
  midDune: [number, number, number];
  midRim: [number, number, number];
  ground: [number, number, number];
  horizonLine: [number, number, number];
  obstacleLit: [number, number, number];
  obstacleShade: [number, number, number];
  obstacleEdge: [number, number, number];
  dinoFill: [number, number, number];
  dinoShade: [number, number, number];
  dinoAccent: [number, number, number];
  celestial: [number, number, number];
  starAlpha: number;
}

const LOGICAL_W = 760;
const LOGICAL_H = 300;
const GROUND_Y = 240;

const DINO_X = 76;
const STAND_W = 38;
const STAND_H = 48;
const DUCK_W = 54;
const DUCK_H = 28;

const BASE_SPEED = 320;
const MAX_SPEED = 780;
const GRAVITY = 2580;
const RELEASE_GRAVITY_MULT = 2.15;
const FAST_DROP_GRAVITY = 7000;
const JUMP_VELOCITY = -765;
const COYOTE_DURATION = 0.06;
const JUMP_BUFFER_DURATION = 0.08;

const PALETTES: readonly SkyPalette[] = [
  // 0: Martian Day (calibrated terracotta #c96a48)
  {
    skyTop: [44, 24, 18],
    skyMid: [128, 64, 43],
    skyHorizon: [201, 106, 72],
    horizonGlow: [236, 162, 124],
    farMesa: [96, 48, 33],
    midDune: [62, 31, 22],
    midRim: [219, 134, 98],
    ground: [34, 18, 13],
    horizonLine: [214, 159, 135],
    obstacleLit: [88, 44, 30],
    obstacleShade: [38, 19, 14],
    obstacleEdge: [232, 160, 126],
    dinoFill: [244, 238, 230],
    dinoShade: [204, 192, 180],
    dinoAccent: [201, 106, 72],
    celestial: [246, 212, 164],
    starAlpha: 0.04,
  },
  // 1: Slate Dusk
  {
    skyTop: [19, 24, 37],
    skyMid: [49, 59, 82],
    skyHorizon: [138, 86, 68],
    horizonGlow: [214, 145, 114],
    farMesa: [38, 45, 62],
    midDune: [25, 30, 42],
    midRim: [188, 126, 104],
    ground: [17, 21, 30],
    horizonLine: [154, 166, 188],
    obstacleLit: [52, 62, 84],
    obstacleShade: [24, 29, 41],
    obstacleEdge: [154, 180, 216],
    dinoFill: [234, 238, 246],
    dinoShade: [182, 192, 208],
    dinoAccent: [138, 180, 248],
    celestial: [226, 168, 132],
    starAlpha: 0.5,
  },
  // 2: Deep Space Starry Night (#0b0c0e)
  {
    skyTop: [11, 12, 14],
    skyMid: [17, 21, 31],
    skyHorizon: [28, 35, 50],
    horizonGlow: [92, 124, 174],
    farMesa: [22, 27, 38],
    midDune: [15, 19, 27],
    midRim: [108, 136, 182],
    ground: [11, 13, 19],
    horizonLine: [118, 138, 168],
    obstacleLit: [38, 49, 68],
    obstacleShade: [18, 23, 33],
    obstacleEdge: [138, 180, 248],
    dinoFill: [232, 234, 238],
    dinoShade: [172, 180, 194],
    dinoAccent: [214, 159, 135],
    celestial: [216, 228, 245],
    starAlpha: 0.96,
  },
];

const CYCLE_LABELS = ['火星白昼', '暮色地平线', '深空星夜'] as const;

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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
  alpha = 1,
): string {
  const r = Math.round(lerp(a[0], b[0], t));
  const g = Math.round(lerp(a[1], b[1], t));
  const bl = Math.round(lerp(a[2], b[2], t));
  return alpha >= 0.999 ? `rgb(${r},${g},${bl})` : `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
}

function samplePaletteAt(cyclePos: number): {
  a: SkyPalette;
  b: SkyPalette;
  t: number;
} {
  const wrapped = ((cyclePos % 3) + 3) % 3;
  const idxA = Math.floor(wrapped) % 3;
  const idxB = (idxA + 1) % 3;
  const t = wrapped - Math.floor(wrapped);
  return { a: PALETTES[idxA], b: PALETTES[idxB], t };
}

function computeTargetCycle(score: number): number {
  const band = Math.floor(score / 500);
  const rem = score % 500;
  const blend = rem > 425 ? (rem - 425) / 75 : 0;
  return band + blend;
}

function createInitialStars(): StarPoint[] {
  const stars: StarPoint[] = [];
  let seed = 4219;
  const nextRand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 52; i += 1) {
    stars.push({
      x: nextRand() * LOGICAL_W,
      y: 10 + nextRand() * (GROUND_Y - 82),
      r: 0.65 + nextRand() * 1.25,
      phase: nextRand() * Math.PI * 2,
    });
  }
  return stars;
}

function createInitialSpecks(): AmbientSpeck[] {
  const specks: AmbientSpeck[] = [];
  for (let i = 0; i < 24; i += 1) {
    specks.push({
      x: Math.random() * LOGICAL_W,
      y: 44 + Math.random() * (GROUND_Y - 48),
      size: 1.0 + Math.random() * 1.7,
      speedFactor: 0.25 + Math.random() * 0.55,
      alpha: 0.16 + Math.random() * 0.28,
    });
  }
  return specks;
}

function createInitialMistBands(): DustMistBand[] {
  return [
    { x: 40, y: GROUND_Y - 22, w: 190, h: 14, speedFactor: 0.16, alpha: 0.12 },
    { x: 310, y: GROUND_Y - 14, w: 230, h: 12, speedFactor: 0.22, alpha: 0.1 },
    { x: 580, y: GROUND_Y - 26, w: 160, h: 16, speedFactor: 0.14, alpha: 0.09 },
  ];
}

function createInitialPebbles(): GroundPebble[] {
  const pebbles: GroundPebble[] = [];
  for (let i = 0; i < 42; i += 1) {
    pebbles.push({
      x: (i / 42) * (LOGICAL_W + 64),
      yOffset: 6 + (i % 6) * 8.5,
      w: i % 3 === 0 ? 12 + (i % 4) * 5 : 2.5 + (i % 4) * 2.5,
      h: i % 3 === 0 ? 1.1 : 1.5 + (i % 2) * 0.9,
      kind: i % 3 === 0 ? 'notch' : 'pebble',
    });
  }
  return pebbles;
}

function formatPaddedScore(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(5, '0');
}

export default function DinoRunnerGame({ onRunFinished, bestScore, muted }: ArcadeGameProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const onRunFinishedRef = useRef(onRunFinished);
  onRunFinishedRef.current = onRunFinished;

  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const [status, setStatus] = useState<GameStatus>('ready');
  const [hudScore, setHudScore] = useState(0);
  const [hudSpeedMult, setHudSpeedMult] = useState('1.0');
  const [hudCycleLabel, setHudCycleLabel] = useState<(typeof CYCLE_LABELS)[number]>(
    CYCLE_LABELS[0],
  );
  const [milestoneBanner, setMilestoneBanner] = useState<number | null>(null);
  const [duckPressed, setDuckPressed] = useState(false);
  const [jumpPressed, setJumpPressed] = useState(false);

  const engineRef = useRef({
    status: 'ready' as GameStatus,
    dinoY: GROUND_Y - STAND_H,
    dinoVy: 0,
    dinoScaleX: 1,
    dinoScaleY: 1,
    grounded: true,
    ducking: false,
    wasFastDropping: false,
    jumpHeld: false,
    duckHeld: false,
    coyoteTimer: COYOTE_DURATION,
    jumpBufferTimer: 0,
    runCycle: 0,
    footDustTimer: 0,
    idleTime: 0,
    distance: 0,
    score: 0,
    lastMilestone: 0,
    speed: BASE_SPEED,
    peakSpeed: BASE_SPEED,
    activePlayMs: 0,
    cycleVisual: 0,
    farScroll: 0,
    midScroll: 0,
    groundScroll: 0,
    horizonWave: -1, // 0..1 when sweeping across horizon on 100-pt milestone
    hitstopTimer: 0,
    impactFlash: 0,
    shakeAmp: 0,
    shootingStarCooldown: 2.8,
    shootingStars: [] as ShootingStar[],
    callouts: [] as FloatingCallout[],
    dustRings: [] as DustRing[],
    nextSpawnDist: 340,
    obstacles: [] as Obstacle[],
    particles: [] as DustParticle[],
    specks: createInitialSpecks(),
    mistBands: createInitialMistBands(),
    stars: createInitialStars(),
    pebbles: createInitialPebbles(),
    gameOverAtMs: 0,
    runReported: false,
    lastHudSync: 0,
  });

  const playSound = useCallback(
    (kind: 'jump' | 'pickup' | 'gameOver' | 'click' | 'thud') => {
      if (mutedRef.current) return;
      arcadeSfx[kind]();
    },
    [],
  );

  const playComboSound = useCallback((step: number) => {
    if (mutedRef.current) return;
    arcadeSfx.combo(step);
  }, []);

  const spawnDustBurst = useCallback(
    (x: number, y: number, count: number, spread = 1, kind: 'dust' | 'spark' = 'dust') => {
      const s = engineRef.current;
      for (let i = 0; i < count; i += 1) {
        if (kind === 'spark') {
          const ang = Math.random() * Math.PI * 2;
          const spd = 85 + Math.random() * 190;
          s.particles.push({
            x: x + (Math.random() - 0.5) * 10,
            y: y + (Math.random() - 0.5) * 10,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd - 45,
            size: 1.8 + Math.random() * 2.2,
            life: 0,
            maxLife: 0.25 + Math.random() * 0.24,
            kind: 'spark',
            color: i % 2 === 0 ? '#f6d892' : '#e58d67',
          });
        } else {
          s.particles.push({
            x: x + (Math.random() - 0.5) * 18 * spread,
            y: y - Math.random() * 4,
            vx: (-55 - Math.random() * 115) * spread,
            vy: (-22 - Math.random() * 68) * spread,
            size: 1.6 + Math.random() * 2.4,
            life: 0,
            maxLife: 0.22 + Math.random() * 0.22,
            kind: 'dust',
          });
        }
      }
      if (s.particles.length > 72) {
        s.particles.splice(0, s.particles.length - 72);
      }
    },
    [],
  );

  const spawnDustRing = useCallback((x: number, y: number, maxRx: number) => {
    const s = engineRef.current;
    s.dustRings.push({
      x,
      y,
      rx: 6,
      maxRx,
      life: 0,
      maxLife: 0.28,
    });
    if (s.dustRings.length > 8) {
      s.dustRings.shift();
    }
  }, []);

  const startNewRun = useCallback(() => {
    const s = engineRef.current;
    s.status = 'playing';
    s.dinoY = GROUND_Y - STAND_H;
    s.dinoVy = 0;
    s.dinoScaleX = 1;
    s.dinoScaleY = 1;
    s.grounded = true;
    s.ducking = false;
    s.wasFastDropping = false;
    s.jumpHeld = false;
    s.duckHeld = false;
    s.coyoteTimer = COYOTE_DURATION;
    s.jumpBufferTimer = 0;
    s.runCycle = 0;
    s.footDustTimer = 0;
    s.distance = 0;
    s.score = 0;
    s.lastMilestone = 0;
    s.speed = BASE_SPEED;
    s.peakSpeed = BASE_SPEED;
    s.activePlayMs = 0;
    s.cycleVisual = 0;
    s.horizonWave = -1;
    s.hitstopTimer = 0;
    s.impactFlash = 0;
    s.shakeAmp = 0;
    s.nextSpawnDist = 360;
    s.obstacles = [];
    s.particles = [];
    s.dustRings = [];
    s.callouts = [];
    s.runReported = false;
    s.lastHudSync = 0;

    setHudScore(0);
    setHudSpeedMult('1.0');
    setHudCycleLabel(CYCLE_LABELS[0]);
    setMilestoneBanner(null);
    setDuckPressed(false);
    setJumpPressed(false);
    setStatus('playing');

    stageRef.current?.focus({ preventScroll: true });
    playSound('click');
  }, [playSound]);

  const togglePause = useCallback(() => {
    const s = engineRef.current;
    if (s.status === 'playing') {
      s.status = 'paused';
      s.jumpHeld = false;
      s.duckHeld = false;
      setJumpPressed(false);
      setDuckPressed(false);
      setStatus('paused');
    } else if (s.status === 'paused') {
      s.status = 'playing';
      setStatus('playing');
      stageRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const pressJump = useCallback(() => {
    const s = engineRef.current;
    if (s.status === 'ready') {
      startNewRun();
      engineRef.current.jumpHeld = true;
      engineRef.current.jumpBufferTimer = JUMP_BUFFER_DURATION;
      setJumpPressed(true);
      return;
    }
    if (s.status === 'gameover') {
      if (performance.now() - s.gameOverAtMs > 260) {
        startNewRun();
      }
      return;
    }
    if (s.status === 'paused') {
      togglePause();
      return;
    }
    s.jumpHeld = true;
    s.jumpBufferTimer = JUMP_BUFFER_DURATION;
    setJumpPressed(true);
  }, [startNewRun, togglePause]);

  const releaseJump = useCallback(() => {
    engineRef.current.jumpHeld = false;
    setJumpPressed(false);
  }, []);

  const setDuckInput = useCallback((active: boolean) => {
    const s = engineRef.current;
    if (s.status !== 'playing') {
      s.duckHeld = false;
      setDuckPressed(false);
      return;
    }
    s.duckHeld = active;
    setDuckPressed(active);
  }, []);

  // Keyboard & visibility listeners
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextInputFocused()) return;
      const s = engineRef.current;
      const stageFocused =
        stageRef.current !== null && document.activeElement === stageRef.current;

      const isJumpKey =
        e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW';
      const isDuckKey = e.code === 'ArrowDown' || e.code === 'KeyS';
      const isPauseKey = e.code === 'KeyP' || e.code === 'Escape';
      const isArrowOrSpace =
        e.code === 'Space' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight';

      if (isArrowOrSpace && (s.status === 'playing' || (stageFocused && (isJumpKey || isDuckKey)))) {
        e.preventDefault();
      }

      if (isPauseKey && (s.status === 'playing' || s.status === 'paused')) {
        if (!e.repeat) togglePause();
        return;
      }

      if (isJumpKey) {
        if (!e.repeat) {
          if (s.status === 'playing' || stageFocused) {
            pressJump();
          }
        }
        return;
      }

      if (isDuckKey && s.status === 'playing') {
        setDuckInput(true);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        releaseJump();
      }
      if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        setDuckInput(false);
      }
    };

    const onVisibilityChange = () => {
      const s = engineRef.current;
      if (document.hidden && s.status === 'playing') {
        s.status = 'paused';
        s.jumpHeld = false;
        s.duckHeld = false;
        setJumpPressed(false);
        setDuckPressed(false);
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
  }, [pressJump, releaseJump, setDuckInput, togglePause]);

  // Clear milestone banner after 1.1s
  useEffect(() => {
    if (milestoneBanner === null) return;
    const timer = window.setTimeout(() => setMilestoneBanner(null), 1100);
    return () => window.clearTimeout(timer);
  }, [milestoneBanner]);

  // Canvas ResizeObserver + main 60-120fps delta-clamped RAF loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const syncCanvasSize = () => {
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

    syncCanvasSize();
    const ro = new ResizeObserver(syncCanvasSize);
    ro.observe(canvas);

    const spawnObstacle = () => {
      const s = engineRef.current;
      const allowAirborne = s.score >= 180;
      const roll = Math.random();

      let kind: ObstacleKind;
      let w = 24;
      let h = 40;
      let y = GROUND_Y - h;

      if (allowAirborne && roll < 0.3) {
        const tier = Math.random();
        w = 48;
        h = 24;
        if (tier < 0.36) {
          kind = 'drone_low';
          y = GROUND_Y - 12 - h;
        } else if (tier < 0.78) {
          kind = 'drone_mid';
          y = GROUND_Y - 36 - h;
        } else {
          kind = 'drone_high';
          y = GROUND_Y - 72 - h;
        }
      } else {
        const gRoll = Math.random();
        if (gRoll < 0.28) {
          kind = 'spire_sm';
          w = 24;
          h = 38;
        } else if (gRoll < 0.56) {
          kind = 'spire_tall';
          w = 28;
          h = 54;
        } else if (gRoll < 0.82) {
          kind = 'cactus_double';
          w = 46;
          h = 44;
        } else {
          kind = 'spire_triple';
          w = 62;
          h = 36;
        }
        y = GROUND_Y - h;
      }

      s.obstacles.push({
        kind,
        x: LOGICAL_W + 24,
        y,
        w,
        h,
        wingPhase: Math.random() * Math.PI * 2,
      });

      const minGap = 215 + s.speed * 0.46;
      const extraGap = Math.random() * (170 + s.speed * 0.14);
      s.nextSpawnDist = minGap + extraGap;
    };

    const stepSimulation = (dt: number) => {
      const s = engineRef.current;

      // Damped screen shake & impact flash decay even during hitstop/gameover
      if (s.shakeAmp > 0.05) {
        s.shakeAmp *= Math.exp(-dt * 14);
      } else {
        s.shakeAmp = 0;
      }

      if (s.impactFlash > 0) {
        s.impactFlash = Math.max(0, s.impactFlash - dt * 4.5);
      }

      // 60ms collision hitstop freeze frame for crisp impact feel
      if (s.hitstopTimer > 0) {
        s.hitstopTimer = Math.max(0, s.hitstopTimer - dt);
        return;
      }

      s.idleTime += dt;

      // Elastic squash-and-stretch recovery
      const spring = 1 - Math.exp(-dt * 16);
      s.dinoScaleX += (1 - s.dinoScaleX) * spring;
      s.dinoScaleY += (1 - s.dinoScaleY) * spring;

      // Horizon milestone light wave
      if (s.horizonWave >= 0) {
        s.horizonWave += dt * 1.45;
        if (s.horizonWave > 1.15) s.horizonWave = -1;
      }

      // Ambient drifting dust specks & low mist bands
      const windSpeed = s.status === 'playing' ? s.speed : 48;
      for (const speck of s.specks) {
        speck.x -= windSpeed * speck.speedFactor * dt;
        if (speck.x < -8) {
          speck.x = LOGICAL_W + 8;
          speck.y = 36 + Math.random() * (GROUND_Y - 42);
        }
      }
      for (const band of s.mistBands) {
        band.x -= windSpeed * band.speedFactor * dt;
        if (band.x + band.w < -20) {
          band.x = LOGICAL_W + 20 + Math.random() * 60;
        }
      }

      // Occasional diagonal shooting stars in Dusk / Starry Night sky
      const { a: palA, b: palB, t: palT } = samplePaletteAt(s.cycleVisual);
      const starAlphaNow = lerp(palA.starAlpha, palB.starAlpha, palT);
      if (starAlphaNow > 0.35) {
        s.shootingStarCooldown -= dt;
        if (s.shootingStarCooldown <= 0) {
          s.shootingStarCooldown = 2.6 + Math.random() * 4.2;
          s.shootingStars.push({
            x: 180 + Math.random() * (LOGICAL_W - 220),
            y: 16 + Math.random() * 64,
            vx: -340 - Math.random() * 140,
            vy: 95 + Math.random() * 55,
            len: 44 + Math.random() * 34,
            life: 0,
            maxLife: 0.55 + Math.random() * 0.28,
          });
        }
      }
      for (let i = s.shootingStars.length - 1; i >= 0; i -= 1) {
        const st = s.shootingStars[i];
        st.life += dt;
        if (st.life >= st.maxLife) {
          s.shootingStars.splice(i, 1);
          continue;
        }
        st.x += st.vx * dt;
        st.y += st.vy * dt;
      }

      // Particle bursts (dust + collision electric sparks)
      for (let i = s.particles.length - 1; i >= 0; i -= 1) {
        const p = s.particles[i];
        p.life += dt;
        if (p.life >= p.maxLife) {
          s.particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += (p.kind === 'spark' ? 560 : 420) * dt;
      }

      // Landing dust shock-rings
      for (let i = s.dustRings.length - 1; i >= 0; i -= 1) {
        const ring = s.dustRings[i];
        ring.life += dt;
        if (ring.life >= ring.maxLife) {
          s.dustRings.splice(i, 1);
          continue;
        }
        const prog = ring.life / ring.maxLife;
        ring.rx = lerp(6, ring.maxRx, 1 - Math.pow(1 - prog, 2.2));
      }

      // Floating milestone callouts
      for (let i = s.callouts.length - 1; i >= 0; i -= 1) {
        const c = s.callouts[i];
        c.life += dt;
        if (c.life >= c.maxLife) {
          s.callouts.splice(i, 1);
          continue;
        }
        c.y -= 28 * dt;
      }

      if (s.status !== 'playing') return;

      s.activePlayMs += dt * 1000;

      // Escalating speed curve
      s.speed = Math.min(
        MAX_SPEED,
        BASE_SPEED + Math.sqrt(s.score) * 9.5 + s.score * 0.14,
      );
      if (s.speed > s.peakSpeed) {
        s.peakSpeed = s.speed;
      }

      const dx = s.speed * dt;
      s.distance += dx;
      s.score = Math.floor(s.distance * 0.028);

      // 100-point milestone: horizon light sweep + floating +100 + pentatonic combo chime
      const currentMilestone = Math.floor(s.score / 100);
      if (currentMilestone > s.lastMilestone && s.score >= 100) {
        s.lastMilestone = currentMilestone;
        s.horizonWave = 0;
        s.callouts.push({
          x: DINO_X + 26,
          y: s.dinoY - 12,
          text: `+100 · ${currentMilestone * 100}`,
          life: 0,
          maxLife: 0.95,
        });
        setMilestoneBanner(currentMilestone * 100);
        playComboSound(currentMilestone - 1);
      }

      // Smooth Day -> Dusk -> Starry Night transition every 500 points
      const targetCycle = computeTargetCycle(s.score);
      s.cycleVisual += (targetCycle - s.cycleVisual) * Math.min(1, dt * 3.2);

      // 3-layer parallax scroll
      s.farScroll = (s.farScroll + dx * 0.07) % LOGICAL_W;
      s.midScroll = (s.midScroll + dx * 0.24) % LOGICAL_W;
      s.groundScroll = (s.groundScroll + dx) % 48;

      for (const pebble of s.pebbles) {
        pebble.x -= dx;
        if (pebble.x + pebble.w < -16) {
          pebble.x = LOGICAL_W + 14 + Math.random() * 44;
          pebble.yOffset = 6 + Math.random() * 46;
        }
      }

      // Coyote time & jump buffer
      if (s.grounded) {
        s.coyoteTimer = COYOTE_DURATION;
      } else {
        s.coyoteTimer = Math.max(0, s.coyoteTimer - dt);
      }

      if (s.jumpBufferTimer > 0) {
        s.jumpBufferTimer = Math.max(0, s.jumpBufferTimer - dt);
      }

      // Buffered jump trigger with launch vertical stretch
      if (s.jumpBufferTimer > 0 && s.coyoteTimer > 0) {
        s.dinoVy = JUMP_VELOCITY;
        s.grounded = false;
        s.ducking = false;
        s.wasFastDropping = false;
        s.coyoteTimer = 0;
        s.jumpBufferTimer = 0;
        s.dinoScaleX = 0.84;
        s.dinoScaleY = 1.18;
        spawnDustBurst(DINO_X + 18, GROUND_Y, 7, 1.0);
        spawnDustRing(DINO_X + 20, GROUND_Y + 1, 20);
        playSound('jump');
      }

      // Vertical physics with variable jump height & fast-drop
      if (!s.grounded) {
        let g = GRAVITY;
        if (s.duckHeld) {
          g = FAST_DROP_GRAVITY;
          s.wasFastDropping = true;
          if (s.dinoVy < 360) s.dinoVy = 360;
        } else if (!s.jumpHeld && s.dinoVy < -240) {
          g = GRAVITY * RELEASE_GRAVITY_MULT;
        }
        s.dinoVy += g * dt;
        s.dinoY += s.dinoVy * dt;

        const targetH = s.duckHeld ? DUCK_H : STAND_H;
        const floorY = GROUND_Y - targetH;
        if (s.dinoY >= floorY) {
          s.dinoY = floorY;
          s.dinoVy = 0;
          s.grounded = true;
          s.ducking = s.duckHeld;
          if (s.wasFastDropping) {
            s.dinoScaleX = 1.26;
            s.dinoScaleY = 0.76;
            s.shakeAmp = Math.max(s.shakeAmp, 2.2);
            spawnDustBurst(DINO_X + 22, GROUND_Y, 11, 1.35);
            spawnDustRing(DINO_X + 24, GROUND_Y + 1, 34);
            playSound('thud');
          } else {
            s.dinoScaleX = 1.16;
            s.dinoScaleY = 0.86;
            spawnDustBurst(DINO_X + 18, GROUND_Y, 6, 0.95);
            spawnDustRing(DINO_X + 20, GROUND_Y + 1, 22);
          }
          s.wasFastDropping = false;
        }
      } else {
        s.ducking = s.duckHeld;
        s.dinoY = GROUND_Y - (s.ducking ? DUCK_H : STAND_H);
        s.runCycle += dt * (10.2 + (s.speed - BASE_SPEED) * 0.016);

        // Subtle terracotta running footstep dust motes
        s.footDustTimer -= dt;
        if (s.footDustTimer <= 0) {
          s.footDustTimer = Math.max(0.08, 0.16 - (s.speed - BASE_SPEED) * 0.00014);
          spawnDustBurst(DINO_X + 15, GROUND_Y, 2, 0.65);
        }
      }

      // Spawn & advance obstacles
      s.nextSpawnDist -= dx;
      if (s.nextSpawnDist <= 0) {
        spawnObstacle();
      }

      for (let i = s.obstacles.length - 1; i >= 0; i -= 1) {
        const obs = s.obstacles[i];
        const isDrone = obs.kind.startsWith('drone_');
        obs.x -= dx * (isDrone ? 1.08 : 1.0);
        if (isDrone) {
          obs.wingPhase += dt * 16;
        }
        if (obs.x + obs.w < -48) {
          s.obstacles.splice(i, 1);
        }
      }

      // Forgiving hitbox collision check
      const dinoW = s.ducking ? DUCK_W : STAND_W;
      const dinoH = s.ducking ? DUCK_H : STAND_H;
      const dLeft = DINO_X + 7;
      const dRight = DINO_X + dinoW - 7;
      const dTop = s.dinoY + 5;
      const dBottom = s.dinoY + dinoH - 4;

      for (const obs of s.obstacles) {
        const insetX = obs.kind.startsWith('drone_') ? 7 : 5;
        const insetY = obs.kind.startsWith('drone_') ? 5 : 4;
        const oLeft = obs.x + insetX;
        const oRight = obs.x + obs.w - insetX;
        const oTop = obs.y + insetY;
        const oBottom = obs.y + obs.h - 2;

        if (dRight > oLeft && dLeft < oRight && dBottom > oTop && dTop < oBottom) {
          s.status = 'gameover';
          s.gameOverAtMs = performance.now();
          s.hitstopTimer = 0.06;
          s.impactFlash = 0.85;
          s.shakeAmp = 7.5;
          s.jumpHeld = false;
          s.duckHeld = false;
          spawnDustBurst(DINO_X + dinoW * 0.65, s.dinoY + dinoH * 0.45, 16, 1.1, 'spark');
          setJumpPressed(false);
          setDuckPressed(false);
          setStatus('gameover');
          setHudScore(s.score);
          setHudSpeedMult((s.speed / BASE_SPEED).toFixed(1));
          playSound('gameOver');

          if (!s.runReported) {
            s.runReported = true;
            onRunFinishedRef.current({
              score: Math.max(0, Math.round(s.score)),
              durationMs: Math.max(0, Math.round(s.activePlayMs)),
              meta: {
                maxSpeed: Number((s.peakSpeed / BASE_SPEED).toFixed(2)),
              },
            });
          }
          break;
        }
      }

      // Throttled React HUD sync (~16Hz)
      const now = performance.now();
      if (now - s.lastHudSync > 65) {
        s.lastHudSync = now;
        setHudScore(s.score);
        setHudSpeedMult((s.speed / BASE_SPEED).toFixed(1));
        const labelIdx = Math.floor(s.score / 500) % 3;
        setHudCycleLabel(CYCLE_LABELS[labelIdx]);
      }
    };

    const drawOlympusMesaLayer = (scroll: number, fill: string, rim: string) => {
      ctx.save();
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      const pts: { x: number; y: number }[] = [];
      for (let x = 0; x <= LOGICAL_W; x += 16) {
        const wx = x + scroll;
        const raw = Math.sin(wx * 0.0052) * 0.65 + Math.cos(wx * 0.0125) * 0.35;
        // Flat-top Olympus Mons shield mesa clamping
        const clamped = Math.min(0.62, Math.max(-0.45, raw));
        const y = GROUND_Y - 46 - clamped * 36;
        pts.push({ x, y });
        ctx.lineTo(x, y);
      }
      ctx.lineTo(LOGICAL_W, GROUND_Y);
      ctx.closePath();
      ctx.fill();

      // Subtle atmospheric ridge rim highlight
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 1) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
        else ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
      ctx.restore();
    };

    const drawDuneLayerWithRim = (scroll: number, fill: string, rim: string) => {
      ctx.save();
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      const pts: { x: number; y: number }[] = [];
      for (let x = 0; x <= LOGICAL_W; x += 16) {
        const wx = x + scroll;
        const y =
          GROUND_Y -
          15 -
          Math.abs(Math.sin(wx * 0.0105)) * 20 -
          Math.cos(wx * 0.024) * 6;
        pts.push({ x, y });
        ctx.lineTo(x, y);
      }
      ctx.lineTo(LOGICAL_W, GROUND_Y);
      ctx.closePath();
      ctx.fill();

      // Crisp warm sunlit crest edge
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 1) {
        if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
        else ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
      ctx.restore();
    };

    const drawCrystalSpire = (
      x: number,
      baseY: number,
      w: number,
      h: number,
      litColor: string,
      shadeColor: string,
      edgeColor: string,
    ) => {
      const peakX = x + w * 0.46;
      const peakY = baseY - h;

      // Ground cast shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.beginPath();
      ctx.ellipse(x + w * 0.56, baseY + 1.5, w * 0.56, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();

      // Sunlit left facet
      ctx.fillStyle = litColor;
      ctx.beginPath();
      ctx.moveTo(x + 1, baseY);
      ctx.lineTo(x + w * 0.22, peakY + h * 0.26);
      ctx.lineTo(peakX, peakY);
      ctx.lineTo(peakX + 1, baseY);
      ctx.closePath();
      ctx.fill();

      // Shaded right facet
      ctx.fillStyle = shadeColor;
      ctx.beginPath();
      ctx.moveTo(peakX, peakY);
      ctx.lineTo(x + w * 0.8, peakY + h * 0.24);
      ctx.lineTo(x + w - 1, baseY);
      ctx.lineTo(peakX, baseY);
      ctx.closePath();
      ctx.fill();

      // Crystalline ridge bevel highlight
      ctx.strokeStyle = edgeColor;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(x + 1, baseY);
      ctx.lineTo(x + w * 0.22, peakY + h * 0.26);
      ctx.lineTo(peakX, peakY);
      ctx.lineTo(peakX, baseY - 2);
      ctx.stroke();
    };

    const drawObstacle = (
      obs: Obstacle,
      litColor: string,
      shadeColor: string,
      edgeColor: string,
      accentColor: string,
      time: number,
    ) => {
      ctx.save();

      if (obs.kind === 'spire_sm') {
        drawCrystalSpire(obs.x, obs.y + obs.h, obs.w, obs.h, litColor, shadeColor, edgeColor);
      } else if (obs.kind === 'spire_tall') {
        drawCrystalSpire(obs.x, obs.y + obs.h, obs.w, obs.h, litColor, shadeColor, edgeColor);
        // Side crystal offshoot
        drawCrystalSpire(
          obs.x + obs.w * 0.56,
          obs.y + obs.h,
          12,
          obs.h * 0.44,
          litColor,
          shadeColor,
          edgeColor,
        );
      } else if (obs.kind === 'cactus_double') {
        // Ground contact shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.26)';
        ctx.beginPath();
        ctx.ellipse(obs.x + obs.w * 0.5, obs.y + obs.h + 1.5, obs.w * 0.52, 3, 0, 0, Math.PI * 2);
        ctx.fill();

        const drawColumn = (cx: number, topY: number, colW: number, colH: number, armDir: number) => {
          // Shaded column base
          ctx.fillStyle = shadeColor;
          ctx.beginPath();
          ctx.roundRect(cx, topY, colW, colH, [4, 4, 1, 1]);
          ctx.fill();

          // Lit left facet
          ctx.fillStyle = litColor;
          ctx.beginPath();
          ctx.roundRect(cx, topY, colW * 0.52, colH, [4, 1, 0, 1]);
          ctx.fill();

          // Edge stroke
          ctx.strokeStyle = edgeColor;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.roundRect(cx, topY, colW, colH, [4, 4, 1, 1]);
          ctx.stroke();

          const armY = topY + colH * 0.36;
          const armX = armDir < 0 ? cx - 6 : cx + colW;
          ctx.fillStyle = armDir < 0 ? litColor : shadeColor;
          ctx.beginPath();
          ctx.roundRect(armX, armY - 8, 6, 13, 2);
          ctx.fill();
          ctx.stroke();
        };
        drawColumn(obs.x + 7, obs.y, 12, obs.h, -1);
        drawColumn(obs.x + 26, obs.y + 10, 12, obs.h - 10, 1);
      } else if (obs.kind === 'spire_triple') {
        drawCrystalSpire(obs.x, obs.y + obs.h, 21, 28, litColor, shadeColor, edgeColor);
        drawCrystalSpire(obs.x + 18, obs.y + obs.h, 25, 36, litColor, shadeColor, edgeColor);
        drawCrystalSpire(obs.x + 40, obs.y + obs.h, 22, 25, litColor, shadeColor, edgeColor);
      } else {
        // Airborne Orbital Reconnaissance Drone
        const cx = obs.x + obs.w * 0.5;
        const cy = obs.y + obs.h * 0.54;
        const hoverBob = Math.sin(obs.wingPhase * 0.5) * 1.6;
        const dy = cy + hoverBob;

        // Ground shadow projection directly beneath low/mid drone
        const alt = Math.max(0, GROUND_Y - (obs.y + obs.h));
        const shAlpha = Math.max(0.05, 0.24 - alt * 0.0022);
        ctx.fillStyle = `rgba(0, 0, 0, ${shAlpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(cx, GROUND_Y + 1.5, Math.max(10, 20 - alt * 0.1), 2.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Trailing aerodynamic wake lines
        ctx.strokeStyle = 'rgba(227, 232, 245, 0.24)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(obs.x + obs.w - 2, dy - 3);
        ctx.lineTo(obs.x + obs.w + 18, dy - 3);
        ctx.moveTo(obs.x + obs.w - 5, dy + 3);
        ctx.lineTo(obs.x + obs.w + 12, dy + 3);
        ctx.stroke();

        // Spinning rotor blur disc above fuselage
        const rotorSpan = 13 + Math.sin(obs.wingPhase * 1.8) * 5;
        ctx.fillStyle = 'rgba(214, 226, 244, 0.22)';
        ctx.strokeStyle = edgeColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(cx + 2, dy - 10, rotorSpan, 2.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Rotor mast
        ctx.beginPath();
        ctx.moveTo(cx + 2, dy - 9);
        ctx.lineTo(cx + 2, dy - 4);
        ctx.stroke();

        // Swept aerodynamic stabilizer fin
        ctx.fillStyle = shadeColor;
        ctx.beginPath();
        ctx.moveTo(cx + 6, dy - 2);
        ctx.lineTo(obs.x + obs.w, dy - 8);
        ctx.lineTo(obs.x + obs.w - 4, dy + 1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Two-tone sculpted fuselage
        ctx.fillStyle = litColor;
        ctx.beginPath();
        ctx.moveTo(obs.x, dy + 1);
        ctx.lineTo(obs.x + 15, dy - 6);
        ctx.lineTo(obs.x + obs.w - 3, dy - 2);
        ctx.lineTo(obs.x + obs.w - 8, dy + 5);
        ctx.lineTo(obs.x + 13, dy + 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Blinking navigation beacon LED
        const blink = Math.sin(time * 9 + obs.wingPhase) > 0;
        ctx.fillStyle = blink ? '#f6d892' : accentColor;
        ctx.beginPath();
        ctx.arc(obs.x + 11.5, dy, 2.5, 0, Math.PI * 2);
        ctx.fill();
        if (blink) {
          ctx.fillStyle = 'rgba(246, 216, 146, 0.28)';
          ctx.beginPath();
          ctx.arc(obs.x + 11.5, dy, 5.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    };

    const drawDino = (
      x: number,
      y: number,
      ducking: boolean,
      grounded: boolean,
      runCycle: number,
      vy: number,
      scaleX: number,
      scaleY: number,
      isDead: boolean,
      bodyFill: string,
      shadeFill: string,
      accentFill: string,
    ) => {
      const w = ducking ? DUCK_W : STAND_W;
      const h = ducking ? DUCK_H : STAND_H;
      const alt = Math.max(0, GROUND_Y - (y + h));

      // Altitude-scaled & softened ground contact shadow
      const shRatio = Math.max(0.28, 1 - alt / 160);
      const shAlpha = Math.max(0.08, 0.36 * shRatio);
      ctx.save();
      ctx.fillStyle = `rgba(0, 0, 0, ${shAlpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x + w * 0.48, GROUND_Y + 2, w * 0.44 * shRatio, 3.8 * shRatio, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Anchor squash-and-stretch at feet center
      const anchorX = x + w * 0.48;
      const anchorY = y + h;

      ctx.save();
      ctx.translate(anchorX, anchorY);
      ctx.scale(scaleX, scaleY);
      ctx.translate(-anchorX, -anchorY);

      const bob = grounded && !isDead ? Math.abs(Math.sin(runCycle)) * -2.2 : 0;
      const tailWag = grounded
        ? Math.sin(runCycle * 1.0) * 3.5
        : Math.max(-6, Math.min(6, vy * 0.008));

      if (ducking) {
        const dy = y + bob * 0.6;
        // Articulated aerodynamic balance tail
        ctx.fillStyle = shadeFill;
        ctx.beginPath();
        ctx.moveTo(x - 4, dy + 11 + tailWag * 0.7);
        ctx.lineTo(x + 13, dy + 6);
        ctx.lineTo(x + 15, dy + 15);
        ctx.closePath();
        ctx.fill();

        // Rear crouched leg (shaded)
        const stride = Math.sin(runCycle);
        ctx.fillStyle = shadeFill;
        ctx.beginPath();
        ctx.roundRect(x + 15 - stride * 4, dy + 18, 5, 10, 2);
        ctx.fill();

        // Sculpted forward-leaning torso
        ctx.fillStyle = bodyFill;
        ctx.beginPath();
        ctx.moveTo(x + 11, dy + 7);
        ctx.lineTo(x + 35, dy + 4);
        ctx.lineTo(x + 37, dy + 18);
        ctx.lineTo(x + 13, dy + 19);
        ctx.closePath();
        ctx.fill();

        // Dorsal aero stripe
        ctx.fillStyle = accentFill;
        ctx.beginPath();
        ctx.roundRect(x + 15, dy + 6.5, 16, 2.6, 1.2);
        ctx.fill();

        // Aerodynamic forward head
        ctx.fillStyle = bodyFill;
        ctx.beginPath();
        ctx.moveTo(x + 33, dy + 2);
        ctx.lineTo(x + 51, dy + 3);
        ctx.lineTo(x + 54, dy + 11);
        ctx.lineTo(x + 48, dy + 15);
        ctx.lineTo(x + 33, dy + 15);
        ctx.closePath();
        ctx.fill();

        // Visor with specular glass reflection
        ctx.fillStyle = isDead ? '#c96a48' : '#10141c';
        ctx.beginPath();
        ctx.roundRect(x + 41, dy + 4.5, 8.5, 4.5, 1.5);
        ctx.fill();
        ctx.fillStyle = isDead ? '#fff5dc' : 'rgba(255,255,255,0.68)';
        ctx.fillRect(x + 42.5, dy + 5.2, 3.2, 1.3);

        // Front crouched leg
        ctx.fillStyle = bodyFill;
        ctx.beginPath();
        ctx.roundRect(x + 27 + stride * 4, dy + 18, 5, 10, 2);
        ctx.fill();
      } else {
        const dy = y + bob;
        const swing = Math.sin(runCycle);
        const liftA = Math.max(0, Math.cos(runCycle)) * 4.5;
        const liftB = Math.max(0, -Math.cos(runCycle)) * 4.5;

        // Articulated rear balance tail
        ctx.fillStyle = shadeFill;
        ctx.beginPath();
        ctx.moveTo(x - 4, dy + 22 + tailWag);
        ctx.lineTo(x + 10, dy + 19);
        ctx.lineTo(x + 13, dy + 32);
        ctx.lineTo(x + 2, dy + 30 + tailWag * 0.5);
        ctx.closePath();
        ctx.fill();

        // Back articulated leg (thigh + shin + foot pad)
        ctx.fillStyle = shadeFill;
        if (!grounded || isDead) {
          ctx.beginPath();
          ctx.roundRect(x + 12, dy + 35, 5, 11, 2);
          ctx.fill();
          ctx.fillRect(x + 12, dy + 45, 7.5, 2.5);
        } else {
          const lx = x + 13 - swing * 4.5;
          const ly = dy + 35 - liftA * 0.5;
          ctx.beginPath();
          ctx.roundRect(lx, ly, 4.8, 12.5 - liftA * 0.4, 2);
          ctx.fill();
          ctx.fillRect(lx, ly + 11 - liftA * 0.4, 7.5, 2.3);
        }

        // Sculpted beveled torso chassis
        ctx.fillStyle = bodyFill;
        ctx.beginPath();
        ctx.moveTo(x + 9, dy + 19);
        ctx.lineTo(x + 17, dy + 13);
        ctx.lineTo(x + 27, dy + 15);
        ctx.lineTo(x + 28, dy + 34);
        ctx.lineTo(x + 11, dy + 36);
        ctx.closePath();
        ctx.fill();

        // Belly shadow bevel
        ctx.fillStyle = shadeFill;
        ctx.beginPath();
        ctx.moveTo(x + 11, dy + 31);
        ctx.lineTo(x + 27, dy + 29);
        ctx.lineTo(x + 26, dy + 35);
        ctx.lineTo(x + 11, dy + 36);
        ctx.closePath();
        ctx.fill();

        // Dorsal armor fins
        ctx.fillStyle = accentFill;
        ctx.fillRect(x + 11, dy + 19, 3.2, 4.5);
        ctx.fillRect(x + 10.5, dy + 25.5, 3.2, 4.5);

        // Articulated forearm
        ctx.fillStyle = bodyFill;
        ctx.beginPath();
        ctx.roundRect(x + 25, dy + 21, 8, 3.4, 1.5);
        ctx.fill();

        // Angled mechanical head with jawline
        ctx.fillStyle = bodyFill;
        ctx.beginPath();
        ctx.moveTo(x + 17, dy + 2);
        ctx.lineTo(x + 35, dy);
        ctx.lineTo(x + 39, dy + 5);
        ctx.lineTo(x + 38, dy + 12);
        ctx.lineTo(x + 28, dy + 12.5);
        ctx.lineTo(x + 28, dy + 14.5);
        ctx.lineTo(x + 34, dy + 14.5);
        ctx.lineTo(x + 33, dy + 17);
        ctx.lineTo(x + 17, dy + 16);
        ctx.closePath();
        ctx.fill();

        // Reflective optical visor & collision startled expression
        if (isDead) {
          ctx.fillStyle = '#0b0c0e';
          ctx.beginPath();
          ctx.arc(x + 29.5, dy + 6.5, 4.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#f6d892';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(x + 29.5, dy + 6.5, 3.1, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#e58d67';
          ctx.beginPath();
          ctx.arc(x + 29.5, dy + 6.5, 1.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#10141c';
          ctx.beginPath();
          ctx.roundRect(x + 26.5, dy + 3.8, 8.2, 4.4, 1.5);
          ctx.fill();
          // Crisp specular glass streak
          ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
          ctx.fillRect(x + 28, dy + 4.5, 3.4, 1.2);
          ctx.fillStyle = accentFill;
          ctx.fillRect(x + 32.5, dy + 5.6, 1.4, 1.4);
        }

        // Front articulated leg
        ctx.fillStyle = bodyFill;
        if (!grounded || isDead) {
          ctx.beginPath();
          ctx.roundRect(x + 20, dy + 35, 5, 11, 2);
          ctx.fill();
          ctx.fillRect(x + 20, dy + 45, 7.5, 2.5);
        } else {
          const lx = x + 19 + swing * 4.5;
          const ly = dy + 35 - liftB * 0.5;
          ctx.beginPath();
          ctx.roundRect(lx, ly, 4.8, 12.5 - liftB * 0.4, 2);
          ctx.fill();
          ctx.fillRect(lx, ly + 11 - liftB * 0.4, 7.5, 2.3);
        }
      }
      ctx.restore();
    };

    const render = () => {
      const s = engineRef.current;
      const cw = canvas.width;
      const ch = canvas.height;
      if (cw === 0 || ch === 0) return;

      ctx.save();
      ctx.scale(cw / LOGICAL_W, ch / LOGICAL_H);

      // Damped screen shake offset
      if (s.shakeAmp > 0) {
        const sx = (Math.random() - 0.5) * 2 * s.shakeAmp;
        const sy = (Math.random() - 0.5) * 2 * s.shakeAmp * 0.75;
        ctx.translate(sx, sy);
      }

      const { a, b, t } = samplePaletteAt(s.cycleVisual);

      // Sky vertical gradient
      const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
      skyGrad.addColorStop(0, lerpRgb(a.skyTop, b.skyTop, t));
      skyGrad.addColorStop(0.56, lerpRgb(a.skyMid, b.skyMid, t));
      skyGrad.addColorStop(1, lerpRgb(a.skyHorizon, b.skyHorizon, t));
      ctx.fillStyle = skyGrad;
      ctx.fillRect(-10, -10, LOGICAL_W + 20, GROUND_Y + 14);

      // Warm horizon atmospheric glow band
      const hazeGrad = ctx.createLinearGradient(0, GROUND_Y - 58, 0, GROUND_Y);
      hazeGrad.addColorStop(0, lerpRgb(a.horizonGlow, b.horizonGlow, t, 0));
      hazeGrad.addColorStop(1, lerpRgb(a.horizonGlow, b.horizonGlow, t, 0.28));
      ctx.fillStyle = hazeGrad;
      ctx.fillRect(0, GROUND_Y - 58, LOGICAL_W, 58);

      // Procedural twinkling starfield
      const starAlpha = lerp(a.starAlpha, b.starAlpha, t);
      if (starAlpha > 0.02) {
        for (const star of s.stars) {
          const twinkle = 0.55 + 0.45 * Math.sin(s.idleTime * 2.2 + star.phase);
          ctx.fillStyle = `rgba(227, 232, 245, ${(starAlpha * twinkle * 0.88).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Diagonal shooting stars in deep-space night / dusk
      for (const st of s.shootingStars) {
        const prog = st.life / st.maxLife;
        const alpha = Math.sin(prog * Math.PI) * Math.min(1, starAlpha * 1.2);
        const speedLen = Math.hypot(st.vx, st.vy) || 1;
        const tx = st.x - (st.vx / speedLen) * st.len;
        const ty = st.y - (st.vy / speedLen) * st.len;
        const grad = ctx.createLinearGradient(st.x, st.y, tx, ty);
        grad.addColorStop(0, `rgba(242, 246, 255, ${alpha.toFixed(3)})`);
        grad.addColorStop(1, 'rgba(138, 180, 248, 0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(st.x, st.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }

      // Distant ringed planet silhouette (left-mid upper sky)
      const planetX = 186 - ((s.idleTime * 1.2) % 36);
      const planetY = 58;
      ctx.save();
      ctx.globalAlpha = 0.18 + starAlpha * 0.24;
      ctx.fillStyle = lerpRgb(a.celestial, b.celestial, t);
      ctx.beginPath();
      ctx.arc(planetX, planetY, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = lerpRgb(a.celestial, b.celestial, t);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(planetX, planetY, 27, 6.2, -0.24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Primary celestial body (Sun -> Low Dusk -> Cratered Crescent Moon)
      const celestialColor = lerpRgb(a.celestial, b.celestial, t);
      const celX = LOGICAL_W - 118;
      const celY = 60 + Math.sin((s.cycleVisual % 3) * 0.9) * 12;
      ctx.save();
      // Subtle atmospheric corona halo
      const celHalo = ctx.createRadialGradient(celX, celY, 12, celX, celY, 44);
      celHalo.addColorStop(0, lerpRgb(a.celestial, b.celestial, t, 0.26));
      celHalo.addColorStop(1, lerpRgb(a.celestial, b.celestial, t, 0));
      ctx.fillStyle = celHalo;
      ctx.beginPath();
      ctx.arc(celX, celY, 44, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = celestialColor;
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.arc(celX, celY, 18, 0, Math.PI * 2);
      ctx.fill();

      if (starAlpha > 0.45) {
        // Subtle crater details on illuminated limb
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = lerpRgb(a.skyMid, b.skyMid, t);
        ctx.beginPath();
        ctx.arc(celX - 7, celY - 4, 3.2, 0, Math.PI * 2);
        ctx.arc(celX - 9, celY + 6, 2.2, 0, Math.PI * 2);
        ctx.arc(celX - 2, celY + 9, 2.5, 0, Math.PI * 2);
        ctx.fill();

        // Crescent shadow mask
        ctx.globalAlpha = Math.min(1, (starAlpha - 0.45) * 1.9);
        ctx.fillStyle = lerpRgb(a.skyTop, b.skyTop, t);
        ctx.beginPath();
        ctx.arc(celX + 7.5, celY - 3, 15.8, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = 0.18;
        ctx.strokeStyle = celestialColor;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(celX, celY, 27, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      // Slowly drifting twin Martian moons: Phobos & Deimos
      const phobosX = ((520 - s.idleTime * 4.5) % (LOGICAL_W + 60) + LOGICAL_W + 60) % (LOGICAL_W + 60) - 30;
      const deimosX = ((370 - s.idleTime * 2.1) % (LOGICAL_W + 60) + LOGICAL_W + 60) % (LOGICAL_W + 60) - 30;
      ctx.save();
      ctx.fillStyle = lerpRgb(a.celestial, b.celestial, t, 0.48 + starAlpha * 0.3);
      ctx.beginPath();
      ctx.ellipse(phobosX, 46, 5.4, 4.1, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = lerpRgb(a.skyTop, b.skyTop, t, 0.38);
      ctx.beginPath();
      ctx.arc(phobosX - 1.5, 45.5, 1.3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = lerpRgb(a.celestial, b.celestial, t, 0.4 + starAlpha * 0.32);
      ctx.beginPath();
      ctx.arc(deimosX, 76, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 3-Layer Parallax Martian Terrain:
      // 1) Far Olympus Mons flat-top mesa silhouette
      drawOlympusMesaLayer(
        s.farScroll,
        lerpRgb(a.farMesa, b.farMesa, t),
        lerpRgb(a.horizonGlow, b.horizonGlow, t, 0.22),
      );

      // 2) Mid-ground terracotta dunes with crisp warm top rim-light
      drawDuneLayerWithRim(
        s.midScroll,
        lerpRgb(a.midDune, b.midDune, t),
        lerpRgb(a.midRim, b.midRim, t, 0.65),
      );

      // Low-altitude drifting dust mist ribbons
      for (const band of s.mistBands) {
        const mg = ctx.createLinearGradient(band.x, band.y, band.x + band.w, band.y);
        mg.addColorStop(0, lerpRgb(a.horizonGlow, b.horizonGlow, t, 0));
        mg.addColorStop(0.5, lerpRgb(a.horizonGlow, b.horizonGlow, t, band.alpha));
        mg.addColorStop(1, lerpRgb(a.horizonGlow, b.horizonGlow, t, 0));
        ctx.fillStyle = mg;
        ctx.beginPath();
        ctx.roundRect(band.x, band.y, band.w, band.h, 8);
        ctx.fill();
      }

      // Milestone horizon sweep light wave
      if (s.horizonWave >= 0 && s.horizonWave <= 1.1) {
        const waveX = s.horizonWave * LOGICAL_W;
        const wGrad = ctx.createLinearGradient(waveX - 95, GROUND_Y, waveX + 20, GROUND_Y);
        wGrad.addColorStop(0, 'rgba(232, 196, 122, 0)');
        wGrad.addColorStop(0.75, 'rgba(232, 196, 122, 0.34)');
        wGrad.addColorStop(1, 'rgba(232, 196, 122, 0)');
        ctx.fillStyle = wGrad;
        ctx.fillRect(waveX - 95, GROUND_Y - 14, 115, 18);
      }

      // 3) Foreground ground plane & geological strata
      ctx.fillStyle = lerpRgb(a.ground, b.ground, t);
      ctx.fillRect(-10, GROUND_Y, LOGICAL_W + 20, LOGICAL_H - GROUND_Y + 12);

      ctx.strokeStyle = lerpRgb(a.horizonLine, b.horizonLine, t, 0.78);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y);
      ctx.lineTo(LOGICAL_W, GROUND_Y);
      ctx.stroke();

      // Secondary geological strata hairline
      ctx.strokeStyle = lerpRgb(a.horizonLine, b.horizonLine, t, 0.14);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y + 22);
      ctx.lineTo(LOGICAL_W, GROUND_Y + 22);
      ctx.stroke();

      // Scrolling geological notches & pebbles
      for (const pebble of s.pebbles) {
        ctx.fillStyle = lerpRgb(
          a.horizonLine,
          b.horizonLine,
          t,
          pebble.kind === 'notch' ? 0.18 : 0.3,
        );
        ctx.fillRect(pebble.x, GROUND_Y + pebble.yOffset, pebble.w, pebble.h);
      }

      // Drifting atmospheric dust specks
      for (const speck of s.specks) {
        ctx.fillStyle = lerpRgb(a.horizonLine, b.horizonLine, t, speck.alpha);
        ctx.fillRect(speck.x, speck.y, speck.size, speck.size);
      }

      // Landing dust shock-rings
      for (const ring of s.dustRings) {
        const aRing = (1 - ring.life / ring.maxLife) * 0.52;
        ctx.strokeStyle = lerpRgb(a.horizonLine, b.horizonLine, t, aRing);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(ring.x, ring.y, ring.rx, 3.2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Sculpted Obstacles
      const obsLit = lerpRgb(a.obstacleLit, b.obstacleLit, t);
      const obsShade = lerpRgb(a.obstacleShade, b.obstacleShade, t);
      const obsEdge = lerpRgb(a.obstacleEdge, b.obstacleEdge, t);
      const accent = lerpRgb(a.dinoAccent, b.dinoAccent, t);
      for (const obs of s.obstacles) {
        drawObstacle(obs, obsLit, obsShade, obsEdge, accent, s.idleTime);
      }

      // Takeoff/landing dust & collision electric sparks
      for (const p of s.particles) {
        const alpha = Math.max(0, 1 - p.life / p.maxLife);
        if (p.kind === 'spark') {
          ctx.fillStyle = p.color ?? '#f6d892';
          ctx.globalAlpha = alpha;
          ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = lerpRgb(a.horizonLine, b.horizonLine, t, alpha * 0.65);
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Articulated Mechanical Dino
      const idleBreath = s.status === 'ready' ? Math.sin(s.idleTime * 3.2) * 1.4 : 0;
      drawDino(
        DINO_X,
        s.dinoY + idleBreath,
        s.ducking,
        s.grounded,
        s.runCycle,
        s.dinoVy,
        s.dinoScaleX,
        s.dinoScaleY,
        s.status === 'gameover',
        lerpRgb(a.dinoFill, b.dinoFill, t),
        lerpRgb(a.dinoShade, b.dinoShade, t),
        accent,
      );

      // Restrained peripheral high-speed wind lines (>= 1.55x)
      const speedRatio = s.speed / BASE_SPEED;
      if (s.status === 'playing' && speedRatio >= 1.55) {
        const intensity = Math.min(1, (speedRatio - 1.55) / 0.75);
        ctx.save();
        ctx.strokeStyle = lerpRgb(a.horizonLine, b.horizonLine, t, 0.24 * intensity);
        ctx.lineWidth = 1.1;
        for (let i = 0; i < 6; i += 1) {
          const laneY = i < 3 ? 16 + i * 14 : LOGICAL_H - 14 - (i - 3) * 11;
          const phase = ((s.idleTime * 920 + i * 173) % (LOGICAL_W + 140));
          const xEnd = LOGICAL_W + 60 - phase;
          const len = 34 + (i % 3) * 24;
          ctx.beginPath();
          ctx.moveTo(xEnd, laneY);
          ctx.lineTo(xEnd + len, laneY);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Floating +100 milestone callouts
      ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      for (const c of s.callouts) {
        const alpha = Math.max(0, 1 - c.life / c.maxLife);
        ctx.fillStyle = `rgba(232, 196, 122, ${alpha.toFixed(3)})`;
        ctx.fillText(c.text, c.x, c.y);
      }

      // Brief warm impact flash on collision hitstop
      if (s.impactFlash > 0.01) {
        ctx.fillStyle = `rgba(214, 159, 135, ${(s.impactFlash * 0.22).toFixed(3)})`;
        ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
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
  }, [playComboSound, playSound, spawnDustBurst, spawnDustRing]);

  const displayBest = Math.max(bestScore ?? 0, hudScore);

  return (
    <div className="flex w-full max-w-full flex-col gap-3 overflow-hidden">
      {/* Compact Calibrated HUD */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-hairline bg-paper px-3.5 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs text-ink-muted">得分</span>
            <span className="tabular-nums-mono text-base font-semibold tracking-tight text-ink">
              {formatPaddedScore(hudScore)}
            </span>
          </div>
          <div className="h-3.5 w-px bg-hairline-strong" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs text-ink-muted">HI</span>
            <span className="tabular-nums-mono text-sm font-medium text-ink-muted">
              {formatPaddedScore(displayBest)}
            </span>
          </div>
          <div className="hidden h-3.5 w-px bg-hairline-strong sm:block" aria-hidden="true" />
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <span className="tabular-nums-mono rounded-full border border-hairline bg-surface px-2 py-0.5 text-ink">
              {hudSpeedMult}×
            </span>
            <span className="hidden sm:inline">{hudCycleLabel}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {status === 'playing' || status === 'paused' ? (
            <button
              type="button"
              onClick={togglePause}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
              aria-label={status === 'paused' ? '继续游戏' : '暂停游戏'}
            >
              {status === 'paused' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              <span>{status === 'paused' ? '继续' : '暂停'}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={startNewRun}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-hover"
            aria-label="重新开始"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>重开</span>
          </button>
        </div>
      </div>

      {/* Calibrated Darkroom Martian Stage */}
      <div
        ref={stageRef}
        tabIndex={0}
        role="application"
        aria-label="荒原小恐龙游戏画布"
        data-only-dark="true"
        className="deep-space relative w-full overflow-hidden rounded-[20px] border border-hairline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="relative aspect-[760/300] min-h-[168px] w-full">
          <canvas
            ref={canvasRef}
            onPointerDown={(e) => {
              e.preventDefault();
              pressJump();
            }}
            onPointerUp={releaseJump}
            onPointerCancel={releaseJump}
            className="block h-full w-full cursor-pointer touch-none select-none"
          />

          {/* Milestone subtle toast */}
          {milestoneBanner !== null && status === 'playing' ? (
            <div className="pointer-events-none absolute top-3 right-3 rounded-full border border-white/15 bg-[#0b0c0e]/75 px-2.5 py-0.5 text-xs font-medium text-[#e8c47a] tabular-nums-mono backdrop-blur-sm">
              里程碑 {milestoneBanner}
            </div>
          ) : null}

          {/* Start Overlay */}
          {status === 'ready' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/42 px-4 text-center backdrop-blur-[1.5px]">
              <p className="text-base font-medium tracking-tight text-[#f2efe9] sm:text-lg">
                荒原小恐龙
              </p>
              <p className="mt-1 max-w-sm text-xs text-[#c7cdd6]">
                按空格 / 上键起跳（轻点小跳、长按高跳），下键急降俯冲躲避低空无人机
              </p>
              <button
                type="button"
                onClick={startNewRun}
                className="mt-3.5 inline-flex min-h-[40px] items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>开始奔跑</span>
              </button>
            </div>
          ) : null}

          {/* Pause Overlay */}
          {status === 'paused' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/65 px-4 text-center backdrop-blur-xs">
              <p className="text-base font-medium text-[#f2efe9]">已暂停</p>
              <p className="mt-1 text-xs text-[#9aa0a6]">按空格、P 或点击下方按钮继续行程</p>
              <div className="mt-3.5 flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={togglePause}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full bg-[#e3e3e3] px-4 text-xs font-medium text-[#131314]"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>继续奔跑</span>
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
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0b0c0e]/70 px-4 text-center backdrop-blur-xs">
              <p className="text-sm font-medium text-[#d69f87]">行程终止</p>
              <p className="tabular-nums-mono mt-0.5 text-2xl font-semibold tracking-tight text-[#f2efe9]">
                {hudScore.toLocaleString('en-US')} 分
              </p>
              <p className="mt-0.5 text-xs text-[#9aa0a6]">
                最高速 <span className="tabular-nums-mono text-[#e3e3e3]">{hudSpeedMult}×</span> · 按空格或点击立即重开
              </p>
              <button
                type="button"
                onClick={startNewRun}
                className="mt-3 inline-flex min-h-[40px] items-center gap-2 rounded-full bg-[#e3e3e3] px-5 text-sm font-medium text-[#131314] transition-transform active:scale-95"
              >
                <RotateCcw className="h-4 w-4" />
                <span>再来一局</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Touch & Quick Action Bar */}
      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            setDuckInput(true);
          }}
          onPointerUp={() => setDuckInput(false)}
          onPointerLeave={() => setDuckInput(false)}
          onPointerCancel={() => setDuckInput(false)}
          className={`flex min-h-[46px] touch-none select-none items-center justify-center gap-2 rounded-[14px] border text-sm font-medium transition-colors ${
            duckPressed
              ? 'border-postmark bg-postmark/15 text-ink'
              : 'border-hairline bg-paper text-ink hover:bg-surface-hover'
          }`}
        >
          <ArrowDown className="h-4 w-4 text-postmark" />
          <span>按住下蹲 / 急降</span>
        </button>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            pressJump();
          }}
          onPointerUp={releaseJump}
          onPointerLeave={releaseJump}
          onPointerCancel={releaseJump}
          className={`flex min-h-[46px] touch-none select-none items-center justify-center gap-2 rounded-[14px] border text-sm font-medium transition-colors ${
            jumpPressed
              ? 'border-accent bg-accent/15 text-ink'
              : 'border-hairline bg-paper text-ink hover:bg-surface-hover'
          }`}
        >
          <ArrowUp className="h-4 w-4 text-accent" />
          <span>{status === 'playing' ? '跳跃（短按小跳）' : '起跳开始'}</span>
        </button>
      </div>
    </div>
  );
}
