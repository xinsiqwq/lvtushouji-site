const ARCADE_MUTED_STORAGE_KEY = 'lvtushouji:arcade-muted:v1';

let cachedMuted: boolean | null = null;
let sharedAudioCtx: AudioContext | null = null;

const PENTATONIC_COMBO_HZ = [
  523.25, // C5
  587.33, // D5
  659.25, // E5
  783.99, // G5
  880.0, // A5
  1046.5, // C6
  1174.66, // D6
  1318.51, // E6
] as const;

const CELESTIAL_CHIME_HZ = [
  329.63, // tier 0 (E4)
  369.99, // tier 1 (F#4)
  415.3, // tier 2 (G#4)
  493.88, // tier 3 (B4)
  554.37, // tier 4 (C#5)
  659.25, // tier 5 (E5)
  739.99, // tier 6 (F#5)
  830.61, // tier 7 (G#5)
  987.77, // tier 8 (B5)
  1108.73, // tier 9 (C#6)
  1244.51, // tier 10 (D#6)
  1318.51, // tier 11 (E6)
  1479.98, // tier 12 (F#6)
] as const;

function readMutedFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ARCADE_MUTED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function getArcadeMuted(): boolean {
  if (cachedMuted === null) {
    cachedMuted = readMutedFromStorage();
  }
  return cachedMuted;
}

export function setArcadeMuted(muted: boolean): void {
  const next = Boolean(muted);
  cachedMuted = next;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ARCADE_MUTED_STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* Storage may be unavailable in private contexts */
  }
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedAudioCtx) {
    if (sharedAudioCtx.state === 'suspended') {
      void sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  }
  try {
    const AudioCtxCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtxCtor) return null;
    sharedAudioCtx = new AudioCtxCtor();
    if (sharedAudioCtx.state === 'suspended') {
      void sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

type ToneSpec = {
  type?: OscillatorType;
  freqStart: number;
  freqEnd?: number;
  delay?: number;
  attack?: number;
  duration: number;
  gain: number;
};

function playTones(tones: readonly ToneSpec[]): void {
  if (getArcadeMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const baseTime = ctx.currentTime + 0.004;

  for (const tone of tones) {
    try {
      const startTime = baseTime + (tone.delay ?? 0);
      const stopTime = startTime + tone.duration;

      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = tone.type ?? 'triangle';
      osc.frequency.setValueAtTime(Math.max(40, tone.freqStart), startTime);
      if (tone.freqEnd !== undefined && tone.freqEnd !== tone.freqStart) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, tone.freqEnd), stopTime);
      }

      const peak = Math.min(0.14, Math.max(0.005, tone.gain));
      const requestedAttack = tone.attack ?? 0.01;
      const attackEnd = Math.min(startTime + requestedAttack, startTime + tone.duration * 0.3);

      gainNode.gain.setValueAtTime(0.0001, startTime);
      gainNode.gain.linearRampToValueAtTime(peak, attackEnd);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, stopTime);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(stopTime + 0.018);
      osc.onended = () => {
        try {
          osc.disconnect();
          gainNode.disconnect();
        } catch {
          /* Ignore disconnect races */
        }
      };
    } catch {
      /* Swallow Web Audio scheduling errors safely */
    }
  }
}

export const arcadeSfx = {
  jump(): void {
    playTones([
      { type: 'triangle', freqStart: 275, freqEnd: 560, attack: 0.006, duration: 0.095, gain: 0.072 },
      { type: 'sine', freqStart: 550, freqEnd: 840, delay: 0.01, attack: 0.008, duration: 0.065, gain: 0.022 },
    ]);
  },

  pickup(): void {
    playTones([
      { type: 'sine', freqStart: 587.33, attack: 0.006, duration: 0.068, gain: 0.068 },
      { type: 'sine', freqStart: 880, delay: 0.052, attack: 0.008, duration: 0.098, gain: 0.074 },
      { type: 'triangle', freqStart: 1760, delay: 0.058, attack: 0.008, duration: 0.06, gain: 0.016 },
    ]);
  },

  clear(): void {
    playTones([
      { type: 'triangle', freqStart: 523.25, attack: 0.006, duration: 0.08, gain: 0.068 },
      { type: 'triangle', freqStart: 659.25, delay: 0.056, attack: 0.007, duration: 0.09, gain: 0.074 },
      { type: 'sine', freqStart: 783.99, delay: 0.114, attack: 0.008, duration: 0.135, gain: 0.08 },
    ]);
  },

  merge(): void {
    playTones([
      { type: 'sine', freqStart: 392, freqEnd: 523.25, attack: 0.008, duration: 0.105, gain: 0.068 },
      { type: 'triangle', freqStart: 784, freqEnd: 1046.5, delay: 0.018, attack: 0.01, duration: 0.088, gain: 0.028 },
    ]);
  },

  bounce(): void {
    playTones([
      { type: 'triangle', freqStart: 440, freqEnd: 310, attack: 0.004, duration: 0.058, gain: 0.064 },
      { type: 'sine', freqStart: 880, freqEnd: 620, attack: 0.003, duration: 0.028, gain: 0.018 },
    ]);
  },

  click(): void {
    playTones([
      { type: 'sine', freqStart: 700, freqEnd: 460, attack: 0.003, duration: 0.032, gain: 0.044 },
    ]);
  },

  flag(): void {
    playTones([
      { type: 'triangle', freqStart: 740, attack: 0.004, duration: 0.044, gain: 0.054 },
      { type: 'triangle', freqStart: 587.33, delay: 0.038, attack: 0.005, duration: 0.048, gain: 0.048 },
    ]);
  },

  win(): void {
    playTones([
      { type: 'triangle', freqStart: 523.25, attack: 0.008, duration: 0.105, gain: 0.072 },
      { type: 'triangle', freqStart: 659.25, delay: 0.082, attack: 0.008, duration: 0.105, gain: 0.076 },
      { type: 'triangle', freqStart: 783.99, delay: 0.165, attack: 0.008, duration: 0.115, gain: 0.078 },
      { type: 'sine', freqStart: 1046.5, delay: 0.248, attack: 0.01, duration: 0.24, gain: 0.084 },
      { type: 'sine', freqStart: 1567.98, delay: 0.268, attack: 0.014, duration: 0.2, gain: 0.024 },
    ]);
  },

  gameOver(): void {
    playTones([
      { type: 'triangle', freqStart: 329.63, freqEnd: 311.13, attack: 0.008, duration: 0.115, gain: 0.068 },
      { type: 'triangle', freqStart: 277.18, freqEnd: 261.63, delay: 0.11, attack: 0.008, duration: 0.125, gain: 0.064 },
      { type: 'sine', freqStart: 220, freqEnd: 196, delay: 0.22, attack: 0.012, duration: 0.19, gain: 0.058 },
    ]);
  },

  combo(step: number): void {
    const safeStep = Number.isFinite(step) ? Math.floor(step) : 0;
    const idx = Math.max(0, Math.min(PENTATONIC_COMBO_HZ.length - 1, safeStep));
    const freq = PENTATONIC_COMBO_HZ[idx];
    const tones: ToneSpec[] = [
      { type: 'sine', freqStart: freq, attack: 0.005, duration: 0.155, gain: 0.074 },
      { type: 'triangle', freqStart: freq * 2, delay: 0.008, attack: 0.008, duration: 0.09, gain: 0.022 },
    ];
    if (idx >= 4) {
      tones.push({
        type: 'sine',
        freqStart: freq * 1.5,
        delay: 0.022,
        attack: 0.01,
        duration: 0.11,
        gain: 0.018,
      });
    }
    playTones(tones);
  },

  thud(): void {
    playTones([
      { type: 'sine', freqStart: 145, freqEnd: 55, attack: 0.004, duration: 0.105, gain: 0.11 },
      { type: 'triangle', freqStart: 280, freqEnd: 185, attack: 0.002, duration: 0.028, gain: 0.048 },
    ]);
  },

  chime(tier?: number): void {
    const rawTier = typeof tier === 'number' && Number.isFinite(tier) ? Math.round(tier) : 4;
    const idx = Math.max(0, Math.min(CELESTIAL_CHIME_HZ.length - 1, rawTier));
    const freq = CELESTIAL_CHIME_HZ[idx];
    const sustain = 0.135 + idx * 0.009;
    const tones: ToneSpec[] = [
      { type: 'sine', freqStart: freq, attack: 0.008, duration: sustain, gain: 0.068 },
      { type: 'sine', freqStart: freq * 2, delay: 0.016, attack: 0.01, duration: sustain * 0.78, gain: 0.024 },
    ];
    if (idx >= 8) {
      tones.push({
        type: 'triangle',
        freqStart: freq * 1.5,
        delay: 0.032,
        attack: 0.012,
        duration: sustain * 0.85,
        gain: 0.018,
      });
    }
    playTones(tones);
  },

  crack(): void {
    playTones([
      { type: 'triangle', freqStart: 1280, freqEnd: 620, attack: 0.002, duration: 0.036, gain: 0.06 },
      { type: 'triangle', freqStart: 1860, freqEnd: 890, delay: 0.014, attack: 0.002, duration: 0.042, gain: 0.048 },
      { type: 'sine', freqStart: 2340, freqEnd: 1420, delay: 0.024, attack: 0.003, duration: 0.028, gain: 0.02 },
    ]);
  },

  warp(): void {
    playTones([
      { type: 'sine', freqStart: 260, freqEnd: 680, attack: 0.014, duration: 0.17, gain: 0.062 },
      { type: 'triangle', freqStart: 390, freqEnd: 1020, delay: 0.018, attack: 0.016, duration: 0.155, gain: 0.032 },
    ]);
  },
} as const;
