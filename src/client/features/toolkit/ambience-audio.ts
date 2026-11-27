import { useSyncExternalStore } from 'react';

export type AmbienceTrackId = 'wind' | 'rain' | 'fire' | 'brown';
export type PomodoroMode = 'focus' | 'shortBreak' | 'longBreak';
export type PomodoroPresetId = '25-5' | '45-10' | '50-10';
export type TimerStatus = 'idle' | 'running' | 'paused';

export interface AmbienceTrackMeta {
  id: AmbienceTrackId;
  label: string;
  subtitle: string;
  defaultVolume: number;
}

export interface PomodoroPreset {
  id: PomodoroPresetId;
  label: string;
  caption: string;
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
}

export interface AmbienceTrackState {
  enabled: boolean;
  volume: number; // 0..1
}

export interface AmbienceState {
  isPlaying: boolean;
  masterVolume: number; // 0..1
  pauseOnHidden: boolean;
  tracks: Record<AmbienceTrackId, AmbienceTrackState>;
  timerStatus: TimerStatus;
  timerMode: PomodoroMode;
  presetId: PomodoroPresetId;
  remainingSeconds: number;
  totalSeconds: number;
  completedSessions: number;
  audioError: string | null;
}

export const AMBIENCE_TRACKS: readonly AmbienceTrackMeta[] = [
  {
    id: 'wind',
    label: '山脊风声',
    subtitle: '粉红噪声经缓慢 LFO 带通滤波，模拟高海拔气流起伏',
    defaultVolume: 0.62,
  },
  {
    id: 'rain',
    label: '高原夜雨',
    subtitle: '双声道柔和宽频细雨，叠衬低频温暖屋檐底色',
    defaultVolume: 0.58,
  },
  {
    id: 'fire',
    label: '木柴篝火',
    subtitle: '沉稳余烬低鸣叠加轻柔随机噼啪脉冲',
    defaultVolume: 0.54,
  },
  {
    id: 'brown',
    label: '深棕底噪',
    subtitle: '360 Hz 低通积分棕噪，温和屏蔽环境杂音',
    defaultVolume: 0.55,
  },
] as const;

export const POMODORO_PRESETS: readonly PomodoroPreset[] = [
  {
    id: '25-5',
    label: '25 / 5',
    caption: '经典节拍',
    focusMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
  },
  {
    id: '45-10',
    label: '45 / 10',
    caption: '深度阅读',
    focusMinutes: 45,
    shortBreakMinutes: 10,
    longBreakMinutes: 20,
  },
  {
    id: '50-10',
    label: '50 / 10',
    caption: '沉浸创作',
    focusMinutes: 50,
    shortBreakMinutes: 10,
    longBreakMinutes: 25,
  },
] as const;

export const MODE_LABELS: Record<PomodoroMode, string> = {
  focus: '专注',
  shortBreak: '短休',
  longBreak: '长休',
};

export function getPresetById(id: PomodoroPresetId): PomodoroPreset {
  return POMODORO_PRESETS.find((p) => p.id === id) ?? POMODORO_PRESETS[0]!;
}

export function getDurationSeconds(presetId: PomodoroPresetId, mode: PomodoroMode): number {
  const preset = getPresetById(presetId);
  if (mode === 'focus') return preset.focusMinutes * 60;
  if (mode === 'shortBreak') return preset.shortBreakMinutes * 60;
  return preset.longBreakMinutes * 60;
}

export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function getActiveTrackLabels(state: AmbienceState): string[] {
  return AMBIENCE_TRACKS.filter((meta) => state.tracks[meta.id].enabled).map((meta) => meta.label);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function createInitialState(): AmbienceState {
  const totalSeconds = getDurationSeconds('25-5', 'focus');
  return {
    isPlaying: false,
    masterVolume: 0.72,
    pauseOnHidden: false,
    tracks: {
      wind: { enabled: false, volume: 0.62 },
      rain: { enabled: false, volume: 0.58 },
      fire: { enabled: false, volume: 0.54 },
      brown: { enabled: false, volume: 0.55 },
    },
    timerStatus: 'idle',
    timerMode: 'focus',
    presetId: '25-5',
    remainingSeconds: totalSeconds,
    totalSeconds,
    completedSessions: 0,
    audioError: null,
  };
}

const INITIAL_SNAPSHOT: AmbienceState = createInitialState();
let currentState: AmbienceState = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();

function emitState(next: AmbienceState): void {
  currentState = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AmbienceState {
  return currentState;
}

function getServerSnapshot(): AmbienceState {
  return INITIAL_SNAPSHOT;
}

export function useAmbienceState(): AmbienceState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* -------------------------------------------------------------------------- */
/* Procedural Web Audio Synthesizer (lazy AudioContext, zero external assets) */
/* -------------------------------------------------------------------------- */

interface ChannelNodes {
  gain: GainNode;
}

interface AudioEngine {
  ctx: AudioContext;
  masterGain: GainNode;
  channels: Record<AmbienceTrackId, ChannelNodes>;
}

let sharedAudioCtx: AudioContext | null = null;
let audioEngine: AudioEngine | null = null;
let suspendedByHidden = false;
let visibilityBound = false;

function ensureAudioContext(): AudioContext | null {
  if (sharedAudioCtx) return sharedAudioCtx;
  const AudioCtx = getAudioContextCtor();
  if (!AudioCtx) {
    emitState({ ...currentState, audioError: '当前浏览器不支持 Web Audio 音频合成' });
    return null;
  }
  try {
    sharedAudioCtx = new AudioCtx();
    ensureVisibilityListener();
    return sharedAudioCtx;
  } catch {
    emitState({ ...currentState, audioError: '音频上下文未能初始化，请点击播放重试' });
    return null;
  }
}

function unlockAudioForTimer(): void {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (!currentState.isPlaying && ctx.state === 'running') {
    void ctx.suspend().catch(() => {});
  }
}

/**
 * Crossfades the loop seam of a generated stereo buffer so looping produces zero clicks.
 */
function crossfadeLoopEdges(data: Float32Array, fadeSamples: number): void {
  const n = data.length;
  const f = Math.min(fadeSamples, Math.floor(n / 8));
  if (f <= 0) return;
  for (let i = 0; i < f; i += 1) {
    const t = i / f;
    const head = data[i] ?? 0;
    const tail = data[n - f + i] ?? 0;
    const blended = head * t + tail * (1 - t);
    data[i] = blended;
  }
}

function createPinkNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, sampleRate);

  for (let ch = 0; ch < 2; ch += 1) {
    const out = buffer.getChannelData(ch);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const sample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.095;
      b6 = white * 0.115926;
      out[i] = Math.max(-0.95, Math.min(0.95, sample));
    }
    crossfadeLoopEdges(out, Math.floor(sampleRate * 0.35));
  }
  return buffer;
}

function createBrownNoiseBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, sampleRate);

  for (let ch = 0; ch < 2; ch += 1) {
    const out = buffer.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      out[i] = Math.max(-0.95, Math.min(0.95, last * 3.1));
    }
    crossfadeLoopEdges(out, Math.floor(sampleRate * 0.4));
  }
  return buffer;
}

function createSoftRainBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, sampleRate);

  for (let ch = 0; ch < 2; ch += 1) {
    const out = buffer.getChannelData(ch);
    let prev = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      // Gentle one-pole tilt softens harsh upper-band white hiss
      prev = prev * 0.45 + white * 0.55;
      out[i] = prev * 0.48;
    }
    crossfadeLoopEdges(out, Math.floor(sampleRate * 0.35));
  }
  return buffer;
}

function createFireCrackleBuffer(ctx: AudioContext, durationSec: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  // Sparse stochastic micro-impulses with soft exponential decay
  const totalPopCount = Math.floor(durationSec * 4.5);
  for (let p = 0; p < totalPopCount; p += 1) {
    const startIdx = Math.floor(Math.random() * (length - 400));
    const decaySamples = Math.floor(sampleRate * (0.0018 + Math.random() * 0.0065));
    const amp = 0.14 + Math.random() * 0.32;
    const pan = Math.random(); // 0 = left, 1 = right
    const lGain = Math.cos(pan * Math.PI * 0.5) * amp;
    const rGain = Math.sin(pan * Math.PI * 0.5) * amp;
    const oscFreq = 900 + Math.random() * 2800;

    for (let i = 0; i < decaySamples && startIdx + i < length; i += 1) {
      const env = Math.exp((-5.5 * i) / decaySamples);
      const tone = Math.sin((2 * Math.PI * oscFreq * i) / sampleRate);
      const grit = (Math.random() * 2 - 1) * 0.65 + tone * 0.35;
      const val = grit * env;
      left[startIdx + i] = Math.max(-0.95, Math.min(0.95, (left[startIdx + i] ?? 0) + val * lGain));
      right[startIdx + i] = Math.max(-0.95, Math.min(0.95, (right[startIdx + i] ?? 0) + val * rGain));
    }
  }

  crossfadeLoopEdges(left, Math.floor(sampleRate * 0.25));
  crossfadeLoopEdges(right, Math.floor(sampleRate * 0.25));
  return buffer;
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof globalThis === 'undefined') return null;
  const scope = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function ensureVisibilityListener(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!audioEngine) return;
    if (document.hidden) {
      if (currentState.pauseOnHidden && currentState.isPlaying) {
        suspendedByHidden = true;
        void audioEngine.ctx.suspend().catch(() => {});
      }
    } else if (suspendedByHidden) {
      suspendedByHidden = false;
      if (currentState.isPlaying) {
        void audioEngine.ctx.resume().catch(() => {});
      }
    }
  });
}

function ensureAudioEngine(): AudioEngine | null {
  if (audioEngine) return audioEngine;
  const ctx = ensureAudioContext();
  if (!ctx) return null;

  try {
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.015;
    compressor.release.value = 0.25;

    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // 1. Wind (山脊风声): pink noise -> slow LFO-modulated bandpass (180..520 Hz)
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    const pinkBuf = createPinkNoiseBuffer(ctx, 8);
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = pinkBuf;
    windSrc.loop = true;

    const windBand = ctx.createBiquadFilter();
    windBand.type = 'bandpass';
    windBand.frequency.value = 350;
    windBand.Q.value = 1.35;

    const windLfo = ctx.createOscillator();
    windLfo.type = 'sine';
    windLfo.frequency.value = 0.085; // ~11.8s cycle
    const windLfoDepth = ctx.createGain();
    windLfoDepth.gain.value = 170; // sweeps 180 Hz .. 520 Hz
    windLfo.connect(windLfoDepth);
    windLfoDepth.connect(windBand.frequency);

    const windBodyLowpass = ctx.createBiquadFilter();
    windBodyLowpass.type = 'lowpass';
    windBodyLowpass.frequency.value = 240;
    const windBodyGain = ctx.createGain();
    windBodyGain.gain.value = 0.28;

    windSrc.connect(windBand);
    windBand.connect(windGain);
    windSrc.connect(windBodyLowpass);
    windBodyLowpass.connect(windBodyGain);
    windBodyGain.connect(windGain);
    windGain.connect(masterGain);

    windSrc.start();
    windLfo.start();

    // 2. Rain (高原夜雨): layered stereo soft broadband rain hiss + warm low-shelf body
    const rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    const rainBuf = createSoftRainBuffer(ctx, 7);
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = rainBuf;
    rainSrc.loop = true;

    const rainHighpass = ctx.createBiquadFilter();
    rainHighpass.type = 'highpass';
    rainHighpass.frequency.value = 260;

    const rainLowpass = ctx.createBiquadFilter();
    rainLowpass.type = 'lowpass';
    rainLowpass.frequency.value = 4100;

    const rainLowShelf = ctx.createBiquadFilter();
    rainLowShelf.type = 'lowshelf';
    rainLowShelf.frequency.value = 230;
    rainLowShelf.gain.value = 5.5;

    const rainWarmBody = ctx.createBiquadFilter();
    rainWarmBody.type = 'lowpass';
    rainWarmBody.frequency.value = 640;
    const rainWarmGain = ctx.createGain();
    rainWarmGain.gain.value = 0.34;

    const rainShimmer = ctx.createGain();
    rainShimmer.gain.value = 0.94;
    const rainLfo = ctx.createOscillator();
    rainLfo.type = 'sine';
    rainLfo.frequency.value = 0.06;
    const rainLfoDepth = ctx.createGain();
    rainLfoDepth.gain.value = 0.06;
    rainLfo.connect(rainLfoDepth);
    rainLfoDepth.connect(rainShimmer.gain);

    rainSrc.connect(rainHighpass);
    rainHighpass.connect(rainLowpass);
    rainLowpass.connect(rainLowShelf);
    rainLowShelf.connect(rainShimmer);
    rainSrc.connect(rainWarmBody);
    rainWarmBody.connect(rainWarmGain);
    rainWarmGain.connect(rainShimmer);
    rainShimmer.connect(rainGain);
    rainGain.connect(masterGain);

    rainSrc.start();
    rainLfo.start();

    // 3. Fire (木柴篝火): warm low rumble + stochastic crackle impulse bursts
    const fireGain = ctx.createGain();
    fireGain.gain.value = 0;
    const brownBuf = createBrownNoiseBuffer(ctx, 9);
    const fireRumbleSrc = ctx.createBufferSource();
    fireRumbleSrc.buffer = brownBuf;
    fireRumbleSrc.loop = true;

    const fireLowpass = ctx.createBiquadFilter();
    fireLowpass.type = 'lowpass';
    fireLowpass.frequency.value = 165;
    fireLowpass.Q.value = 0.9;

    const fireFlicker = ctx.createGain();
    fireFlicker.gain.value = 0.88;
    const fireLfo = ctx.createOscillator();
    fireLfo.type = 'sine';
    fireLfo.frequency.value = 0.42;
    const fireLfoDepth = ctx.createGain();
    fireLfoDepth.gain.value = 0.14;
    fireLfo.connect(fireLfoDepth);
    fireLfoDepth.connect(fireFlicker.gain);

    const crackleBuf = createFireCrackleBuffer(ctx, 11);
    const crackleSrc = ctx.createBufferSource();
    crackleSrc.buffer = crackleBuf;
    crackleSrc.loop = true;

    const crackleHighpass = ctx.createBiquadFilter();
    crackleHighpass.type = 'highpass';
    crackleHighpass.frequency.value = 950;
    const crackleLowpass = ctx.createBiquadFilter();
    crackleLowpass.type = 'lowpass';
    crackleLowpass.frequency.value = 5400;
    const crackleGain = ctx.createGain();
    crackleGain.gain.value = 0.72;

    fireRumbleSrc.connect(fireLowpass);
    fireLowpass.connect(fireFlicker);
    fireFlicker.connect(fireGain);

    crackleSrc.connect(crackleHighpass);
    crackleHighpass.connect(crackleLowpass);
    crackleLowpass.connect(crackleGain);
    crackleGain.connect(fireGain);

    fireGain.connect(masterGain);

    fireRumbleSrc.start();
    fireLfo.start();
    crackleSrc.start();

    // 4. Brown (深棕底噪): smooth integrated brownian noise low-passed at 360 Hz
    const brownGain = ctx.createGain();
    brownGain.gain.value = 0;
    const brownSrc = ctx.createBufferSource();
    brownSrc.buffer = brownBuf;
    brownSrc.loop = true;

    const brownLowpass = ctx.createBiquadFilter();
    brownLowpass.type = 'lowpass';
    brownLowpass.frequency.value = 360;
    brownLowpass.Q.value = 0.707;

    brownSrc.connect(brownLowpass);
    brownLowpass.connect(brownGain);
    brownGain.connect(masterGain);

    brownSrc.start();

    audioEngine = {
      ctx,
      masterGain,
      channels: {
        wind: { gain: windGain },
        rain: { gain: rainGain },
        fire: { gain: fireGain },
        brown: { gain: brownGain },
      },
    };

    ensureVisibilityListener();
    return audioEngine;
  } catch {
    emitState({ ...currentState, audioError: '音频上下文未能初始化，请点击播放重试' });
    return null;
  }
}

function syncAudioGains(state: AmbienceState): void {
  if (!audioEngine) return;
  const { ctx, masterGain, channels } = audioEngine;
  const now = ctx.currentTime;

  const targetMaster = state.isPlaying ? state.masterVolume * 0.75 : 0;
  masterGain.gain.cancelScheduledValues(now);
  masterGain.gain.setTargetAtTime(targetMaster, now, 0.08);

  const ids: AmbienceTrackId[] = ['wind', 'rain', 'fire', 'brown'];
  for (const id of ids) {
    const tr = state.tracks[id];
    const target = state.isPlaying && tr.enabled ? tr.volume * 0.85 : 0;
    const node = channels[id].gain.gain;
    node.cancelScheduledValues(now);
    node.setTargetAtTime(target, now, 0.09);
  }

  const shouldRun =
    state.isPlaying && !(state.pauseOnHidden && typeof document !== 'undefined' && document.hidden);

  if (shouldRun) {
    suspendedByHidden = false;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  } else if (!state.isPlaying && ctx.state === 'running') {
    // Suspend after smooth fade-out settles
    window.setTimeout(() => {
      if (audioEngine && !currentState.isPlaying && audioEngine.ctx.state === 'running') {
        void audioEngine.ctx.suspend().catch(() => {});
      }
    }, 320);
  }
}

/**
 * Plays a gentle harmonic bell chime when a Pomodoro focus/break interval finishes.
 */
function playCompletionBell(): void {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime + 0.02;
    const bellBus = ctx.createGain();
    bellBus.gain.value = Math.max(0.08, currentState.masterVolume * 0.24);
    bellBus.connect(ctx.destination);

    const harmonics: ReadonlyArray<{ freq: number; gain: number; decay: number }> = [
      { freq: 528, gain: 0.55, decay: 1.9 },
      { freq: 1056, gain: 0.24, decay: 1.2 },
      { freq: 1584, gain: 0.12, decay: 0.75 },
    ];

    for (const h of harmonics) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = h.freq;
      env.gain.setValueAtTime(0.0001, now);
      env.gain.linearRampToValueAtTime(h.gain, now + 0.018);
      env.gain.exponentialRampToValueAtTime(0.0001, now + h.decay);
      osc.connect(env);
      env.connect(bellBus);
      osc.start(now);
      osc.stop(now + h.decay + 0.05);
    }

    window.setTimeout(() => {
      try {
        bellBus.disconnect();
      } catch {
        // ignore disconnect cleanup
      }
      if (sharedAudioCtx && !currentState.isPlaying && sharedAudioCtx.state === 'running') {
        void sharedAudioCtx.suspend().catch(() => {});
      }
    }, 2300);
  } catch {
    // Graceful no-op if autoplay policy restricts audio
  }
}

/* -------------------------------------------------------------------------- */
/* Soundscape Controller Actions                                              */
/* -------------------------------------------------------------------------- */

export function toggleTrack(id: AmbienceTrackId): void {
  const prev = currentState;
  const nextEnabled = !prev.tracks[id].enabled;
  const nextTracks: Record<AmbienceTrackId, AmbienceTrackState> = {
    ...prev.tracks,
    [id]: { ...prev.tracks[id], enabled: nextEnabled },
  };

  const anyEnabled = Object.values(nextTracks).some((t) => t.enabled);
  const nextPlaying = nextEnabled ? true : anyEnabled ? prev.isPlaying : false;

  if (nextPlaying) {
    ensureAudioEngine();
  }

  const nextState: AmbienceState = {
    ...prev,
    tracks: nextTracks,
    isPlaying: nextPlaying,
    audioError: null,
  };
  emitState(nextState);
  syncAudioGains(nextState);
}

export function setTrackVolume(id: AmbienceTrackId, volume: number): void {
  const clamped = clampUnit(volume);
  const prev = currentState;
  const nextState: AmbienceState = {
    ...prev,
    tracks: {
      ...prev.tracks,
      [id]: { ...prev.tracks[id], volume: clamped },
    },
  };
  emitState(nextState);
  syncAudioGains(nextState);
}

export function setMasterVolume(volume: number): void {
  const clamped = clampUnit(volume);
  const nextState: AmbienceState = {
    ...currentState,
    masterVolume: clamped,
  };
  emitState(nextState);
  syncAudioGains(nextState);
}

export function pauseAudio(): void {
  if (!currentState.isPlaying) return;
  const nextState: AmbienceState = {
    ...currentState,
    isPlaying: false,
  };
  emitState(nextState);
  syncAudioGains(nextState);
}

export function togglePlayAll(): void {
  const prev = currentState;
  if (prev.isPlaying) {
    pauseAudio();
    return;
  }

  ensureAudioEngine();
  const anyEnabled = Object.values(prev.tracks).some((t) => t.enabled);
  const nextTracks = anyEnabled
    ? prev.tracks
    : {
        ...prev.tracks,
        wind: { ...prev.tracks.wind, enabled: true },
      };

  const nextState: AmbienceState = {
    ...prev,
    tracks: nextTracks,
    isPlaying: true,
    audioError: null,
  };
  emitState(nextState);
  syncAudioGains(nextState);
}

export function stopAll(): void {
  const prev = currentState;
  const nextTracks: Record<AmbienceTrackId, AmbienceTrackState> = {
    wind: { ...prev.tracks.wind, enabled: false },
    rain: { ...prev.tracks.rain, enabled: false },
    fire: { ...prev.tracks.fire, enabled: false },
    brown: { ...prev.tracks.brown, enabled: false },
  };
  const nextState: AmbienceState = {
    ...prev,
    isPlaying: false,
    tracks: nextTracks,
  };
  emitState(nextState);
  syncAudioGains(nextState);
}

export function setPauseOnHidden(enabled: boolean): void {
  const nextState: AmbienceState = {
    ...currentState,
    pauseOnHidden: enabled,
  };
  emitState(nextState);
  if (!enabled && suspendedByHidden && audioEngine && nextState.isPlaying) {
    suspendedByHidden = false;
    void audioEngine.ctx.resume().catch(() => {});
  } else if (enabled && typeof document !== 'undefined' && document.hidden && nextState.isPlaying && audioEngine) {
    suspendedByHidden = true;
    void audioEngine.ctx.suspend().catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Pomodoro Timer Controller                                                  */
/* -------------------------------------------------------------------------- */

let timerIntervalId: ReturnType<typeof setInterval> | null = null;
let timerEndAtMs: number | null = null;

function clearTimerInterval(): void {
  if (timerIntervalId !== null) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
  timerEndAtMs = null;
}

function handleTimerComplete(): void {
  clearTimerInterval();
  playCompletionBell();

  const prev = currentState;
  const wasFocus = prev.timerMode === 'focus';
  const nextCompleted = wasFocus ? prev.completedSessions + 1 : prev.completedSessions;
  const nextMode: PomodoroMode = wasFocus
    ? nextCompleted % 4 === 0
      ? 'longBreak'
      : 'shortBreak'
    : 'focus';
  const nextTotal = getDurationSeconds(prev.presetId, nextMode);

  emitState({
    ...prev,
    timerStatus: 'idle',
    timerMode: nextMode,
    remainingSeconds: nextTotal,
    totalSeconds: nextTotal,
    completedSessions: nextCompleted,
  });
}

function tickTimer(): void {
  if (timerEndAtMs === null || currentState.timerStatus !== 'running') {
    clearTimerInterval();
    return;
  }
  const remaining = Math.ceil((timerEndAtMs - Date.now()) / 1000);
  if (remaining <= 0) {
    handleTimerComplete();
    return;
  }
  if (remaining !== currentState.remainingSeconds) {
    emitState({
      ...currentState,
      remainingSeconds: remaining,
    });
  }
}

export function startTimer(): void {
  const prev = currentState;
  if (prev.timerStatus === 'running') return;

  // Unlock AudioContext lazily on this user gesture (without building noise buffers yet)
  unlockAudioForTimer();

  const startRemaining = prev.remainingSeconds > 0 ? prev.remainingSeconds : prev.totalSeconds;
  timerEndAtMs = Date.now() + startRemaining * 1000;

  if (timerIntervalId !== null) {
    clearInterval(timerIntervalId);
  }
  timerIntervalId = setInterval(tickTimer, 250);

  emitState({
    ...prev,
    timerStatus: 'running',
    remainingSeconds: startRemaining,
  });
}

export function pauseTimer(): void {
  if (currentState.timerStatus !== 'running') return;
  const remaining =
    timerEndAtMs !== null
      ? Math.max(1, Math.ceil((timerEndAtMs - Date.now()) / 1000))
      : currentState.remainingSeconds;
  clearTimerInterval();
  emitState({
    ...currentState,
    timerStatus: 'paused',
    remainingSeconds: remaining,
  });
}

export function resetTimer(): void {
  clearTimerInterval();
  const prev = currentState;
  const totalSeconds = getDurationSeconds(prev.presetId, prev.timerMode);
  emitState({
    ...prev,
    timerStatus: 'idle',
    remainingSeconds: totalSeconds,
    totalSeconds,
  });
}

export function setTimerMode(mode: PomodoroMode): void {
  clearTimerInterval();
  const prev = currentState;
  const totalSeconds = getDurationSeconds(prev.presetId, mode);
  emitState({
    ...prev,
    timerStatus: 'idle',
    timerMode: mode,
    remainingSeconds: totalSeconds,
    totalSeconds,
  });
}

export function setPreset(presetId: PomodoroPresetId): void {
  clearTimerInterval();
  const prev = currentState;
  const totalSeconds = getDurationSeconds(presetId, prev.timerMode);
  emitState({
    ...prev,
    presetId,
    timerStatus: 'idle',
    remainingSeconds: totalSeconds,
    totalSeconds,
  });
}
