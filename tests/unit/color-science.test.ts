import { describe, expect, it } from 'vitest';
import {
  createIdentityLut3D,
  evaluateLut3D,
  packLut3DTo2DAtlas,
  parseCubeLut,
  resampleLut3D,
  serializeCubeLut,
} from '../../src/client/features/toolkit/color/cube-lut';
import {
  BEGINNER_GUIDES,
  GRADE_PRESETS,
  getGradePresetById,
} from '../../src/client/features/toolkit/color/grade-presets';
import {
  DEFAULT_GRADE_PARAMS,
  HSL_BAND_IDS,
  blendGradeParams,
  cloneGradeParams,
  resolveGradeParams,
} from '../../src/client/features/toolkit/color/grade-types';
import {
  LOG_PROFILES,
  bakeCombinedCubeLut33,
  evalLogProfileRgb,
  getLogProfileLut33,
} from '../../src/client/features/toolkit/color/log-profiles';
import {
  clearToolkitHandoff,
  consumeToolkitHandoff,
  peekToolkitHandoff,
  setToolkitHandoff,
} from '../../src/client/features/toolkit/color/media-handoff';
import { evaluateGradePixelCpu } from '../../src/client/features/toolkit/color/webgl-color-pipeline';

/**
 * Official published 18% middle-gray Log code values (normalized 0..1)
 * verified against each manufacturer's technical white paper.
 */
const MIDDLE_GRAY_LOG_VALUES: Record<string, number> = {
  'dji-dlog': 0.39876, // DJI D-Log White Paper: ~39.9%
  'dji-dlog-m': 0.39, // DJI D-Log M quasi-Log Rec.709 anchor
  'insta360-ilog': 0.4, // Insta360 I-Log Rec.709 anchor
  'sony-slog3-cine': 420 / 1023, // Sony Technical Summary: 420/1023 = 41.06%
  'sony-slog3': 420 / 1023, // Sony Technical Summary: 420/1023 = 41.06%
  'sony-slog2': 0.32345, // Sony S-Log2 Technical Summary: ~32.3% IRE
  'nikon-nlog': 372 / 1023, // Nikon N-Log Spec Ver. 1.00: 372/1023 = 36.36%
  'leica-llog': 0.43531, // Leica L-Log Reference Manual: 43.5%
  'apple-log': 0.48827, // Apple Log White Paper (Sep 2023): 48.8%
  'canon-clog3': 0.32795, // Canon Log 3 Tech Info: 32.8% IRE (CV10 351)
  'panasonic-vlog': 0.42331, // Panasonic V-Log Manual Rev 1.0: 42.3% (CV10 433)
};

describe('Adobe .cube 3D LUT codec & trilinear evaluator', () => {
  it('round-trips 17³ and 33³ .cube files with comments, quotes, and custom domains', () => {
    for (const size of [17, 33]) {
      const idLut = createIdentityLut3D(size, `Test Identity ${size}`);
      // Apply a distinct non-linear transform so red-fastest order is strongly tested
      for (let b = 0; b < size; b++) {
        for (let g = 0; g < size; g++) {
          for (let r = 0; r < size; r++) {
            const idx = ((b * size + g) * size + r) * 3;
            idLut.data[idx] = Math.pow(r / (size - 1), 0.9);
            idLut.data[idx + 1] = Math.pow(g / (size - 1), 1.05);
            idLut.data[idx + 2] = Math.pow(b / (size - 1), 1.15);
          }
        }
      }

      const text = serializeCubeLut(idLut, `RoundTrip ${size}`);
      expect(text).toContain(`LUT_3D_SIZE ${size}`);
      expect(text).toContain(`TITLE "RoundTrip ${size}"`);

      const parsed = parseCubeLut(text);
      expect(parsed.size).toBe(size);
      expect(parsed.title).toBe(`RoundTrip ${size}`);
      expect(parsed.data.length).toBe(size * size * size * 3);

      // Verify exact red-fastest storage & round-trip precision
      const [er, eg, eb] = evaluateLut3D(parsed, 0.25, 0.5, 0.75);
      expect(er).toBeCloseTo(Math.pow(0.25, 0.9), 3);
      expect(eg).toBeCloseTo(Math.pow(0.5, 1.05), 3);
      expect(eb).toBeCloseTo(Math.pow(0.75, 1.15), 3);
    }
  });

  it('throws clear Chinese errors on 1D-only or malformed .cube files', () => {
    expect(() =>
      parseCubeLut('TITLE "1D Only"\nLUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1\n'),
    ).toThrow(/3D LUT|1D LUT/);

    expect(() =>
      parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n'),
    ).toThrow(/行数不匹配/);

    expect(() => parseCubeLut('')).toThrow(/为空/);
  });

  it('packs N×N×N 3D LUT into (N*N)×N RGBA8 2D atlas with x = b*N + r, y = g', () => {
    const size = 5;
    const lut = createIdentityLut3D(size, 'Atlas Check');
    const atlas = packLut3DTo2DAtlas(lut);

    expect(atlas.width).toBe(size * size);
    expect(atlas.height).toBe(size);
    expect(atlas.size).toBe(size);
    expect(atlas.pixels.length).toBe(atlas.width * atlas.height * 4);

    // Check specific lattice coordinate (r=1, g=2, b=3)
    const r = 1;
    const g = 2;
    const b = 3;
    const x = b * size + r;
    const y = g;
    const offset = (y * atlas.width + x) * 4;
    expect(atlas.pixels[offset]).toBe(Math.round((r / (size - 1)) * 255));
    expect(atlas.pixels[offset + 1]).toBe(Math.round((g / (size - 1)) * 255));
    expect(atlas.pixels[offset + 2]).toBe(Math.round((b / (size - 1)) * 255));
    expect(atlas.pixels[offset + 3]).toBe(255);

    const downsampled = resampleLut3D(createIdentityLut3D(33), 17);
    expect(downsampled.size).toBe(17);
    const [rr, gg, bb] = evaluateLut3D(downsampled, 0.37, 0.61, 0.83);
    expect(rr).toBeCloseTo(0.37, 4);
    expect(gg).toBeCloseTo(0.61, 4);
    expect(bb).toBeCloseTo(0.83, 4);
  });
});

describe('Official Log profiles & Rec.709 color science', () => {
  it('exposes all 11 authentic Log profiles across DJI, Insta360, Sony, Nikon, Leica, Apple, Canon, Panasonic', () => {
    const ids = LOG_PROFILES.map((p) => p.id);
    expect(ids).toEqual([
      'dji-dlog',
      'dji-dlog-m',
      'insta360-ilog',
      'sony-slog3-cine',
      'sony-slog3',
      'sony-slog2',
      'nikon-nlog',
      'leica-llog',
      'apple-log',
      'canon-clog3',
      'panasonic-vlog',
    ]);

    for (const spec of LOG_PROFILES) {
      expect(spec.cameras.length).toBeGreaterThan(3);
      expect(spec.reference.length).toBeGreaterThan(5);
      expect(spec.description.length).toBeGreaterThan(10);
    }
  });

  it('maps each profile’s official 18% middle-gray code value to neutral ~0.41–0.46 Rec.709 display grey', () => {
    for (const spec of LOG_PROFILES) {
      const midLog = MIDDLE_GRAY_LOG_VALUES[spec.id];
      expect(midLog).toBeDefined();

      const [r, g, b] = evalLogProfileRgb(spec.id, midLog, midLog, midLog);
      // Neutral gray preservation (gamut matrix row sums === 1.0)
      expect(Math.abs(r - g)).toBeLessThan(1e-5);
      expect(Math.abs(g - b)).toBeLessThan(1e-5);
      // Cinema/broadcast Rec.709 display middle gray target range: 0.41..0.46
      expect(r).toBeGreaterThanOrEqual(0.41);
      expect(r).toBeLessThanOrEqual(0.46);
    }
  });

  it('is strictly monotonic along the neutral ramp and never hard-clips highlights early', () => {
    const steps = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (const spec of LOG_PROFILES) {
      let prev = -1;
      for (const v of steps) {
        const [r, g, b] = evalLogProfileRgb(spec.id, v, v, v);
        expect(Number.isFinite(r)).toBe(true);
        expect(Math.abs(r - g)).toBeLessThan(1e-5);
        expect(Math.abs(g - b)).toBeLessThan(1e-5);
        expect(r).toBeGreaterThanOrEqual(prev);
        // Once above black floor (v >= 0.2), output must strictly increase
        if (v >= 0.25) {
          expect(r).toBeGreaterThan(prev);
        }
        prev = r;
      }

      // Highlight headroom sanity: 0.85 -> 1.0 still has distinct smooth rolloff
      const [hi85] = evalLogProfileRgb(spec.id, 0.85, 0.85, 0.85);
      const [hi100] = evalLogProfileRgb(spec.id, 1.0, 1.0, 1.0);
      expect(hi100).toBeGreaterThan(hi85);
      expect(hi100).toBeLessThanOrEqual(1.0);
      expect(hi100).toBeGreaterThan(0.92);
    }
  });

  it('generates cached 33³ Log LUTs matching direct evaluation and bakes combined 33³ .cube files', () => {
    const slog3Lut = getLogProfileLut33('sony-slog3-cine');
    expect(slog3Lut.size).toBe(33);
    expect(getLogProfileLut33('sony-slog3-cine')).toBe(slog3Lut); // cached reference

    const [lr, lg, lb] = evaluateLut3D(slog3Lut, 0.41, 0.41, 0.41);
    const [dr, dg, db] = evalLogProfileRgb('sony-slog3-cine', 0.41, 0.41, 0.41);
    expect(lr).toBeCloseTo(dr, 2);
    expect(lg).toBeCloseTo(dg, 2);
    expect(lb).toBeCloseTo(db, 2);

    const preset = getGradePresetById('teal-orange-cinema')!;
    const gradedParams = resolveGradeParams(preset.params);
    const combined = bakeCombinedCubeLut33({
      logProfileId: 'dji-dlog',
      baseStrength: 1,
      grade: gradedParams,
      title: 'DJI D-Log + Teal Orange',
    });

    expect(combined.size).toBe(33);
    const cubeText = serializeCubeLut(combined);
    const reparsed = parseCubeLut(cubeText);
    expect(reparsed.size).toBe(33);

    // Exact 33³ lattice vertex must match chained evaluation to 5 decimal places (proves exact red-fastest indexing)
    const [gx, gy, gz] = [16 / 32, 13 / 32, 11 / 32];
    const [g1r, g1g, g1b] = evalLogProfileRgb('dji-dlog', gx, gy, gz);
    const [gExpR, gExpG, gExpB] = evaluateGradePixelCpu(g1r, g1g, g1b, gradedParams);
    const [gLutR, gLutG, gLutB] = evaluateLut3D(reparsed, gx, gy, gz);
    expect(gLutR).toBeCloseTo(gExpR, 5);
    expect(gLutG).toBeCloseTo(gExpG, 5);
    expect(gLutB).toBeCloseTo(gExpB, 5);

    // Off-grid interior sample verifies smooth 33³ trilinear interpolation (< 1.5% deviation)
    const [s1r, s1g, s1b] = evalLogProfileRgb('dji-dlog', 0.5, 0.4, 0.35);
    const [expR, expG, expB] = evaluateGradePixelCpu(s1r, s1g, s1b, gradedParams);
    const [lutR, lutG, lutB] = evaluateLut3D(reparsed, 0.5, 0.4, 0.35);
    expect(Math.abs(lutR - expR)).toBeLessThan(0.015);
    expect(Math.abs(lutG - expG)).toBeLessThan(0.015);
    expect(Math.abs(lutB - expB)).toBeLessThan(0.015);
  });
});

describe('GradeParams math, CPU grading parity, presets & beginner guides', () => {
  it('preserves identity on DEFAULT_GRADE_PARAMS and handles exposure, B&W, HSL, and blending accurately', () => {
    // Identity check
    const [r0, g0, b0] = evaluateGradePixelCpu(0.32, 0.54, 0.71, DEFAULT_GRADE_PARAMS);
    expect(r0).toBeCloseTo(0.32, 5);
    expect(g0).toBeCloseTo(0.54, 5);
    expect(b0).toBeCloseTo(0.71, 5);

    // +1 EV exposure brightens midtones cleanly
    const plus1 = resolveGradeParams({ exposure: 1 });
    const [er] = evaluateGradePixelCpu(0.45, 0.45, 0.45, plus1);
    expect(er).toBeGreaterThan(0.58);

    // Saturation -100 produces exact monochrome even when HSL blue luminance filter is active
    const leicaBw = resolveGradeParams(getGradePresetById('leica-high-contrast-bw')!.params);
    const [br, bg, bb] = evaluateGradePixelCpu(0.18, 0.42, 0.85, leicaBw);
    expect(br).toBeCloseTo(bg, 5);
    expect(bg).toBeCloseTo(bb, 5);
    // And blue sky should render noticeably darker than red of equal initial luminance
    const [rr] = evaluateGradePixelCpu(0.85, 0.25, 0.18, leicaBw);
    expect(rr).toBeGreaterThan(br);

    // Blend strength 0 -> base, 1 -> target, 0.5 -> midpoint (with neutral split-hue preserved)
    const base = cloneGradeParams(DEFAULT_GRADE_PARAMS);
    const half = blendGradeParams(
      base,
      { contrast: 20, splitHighlightHue: 40, splitHighlightSat: 20, hsl: { blue: { lum: -20 } } },
      0.5,
    );
    expect(half.contrast).toBe(10);
    expect(half.splitHighlightHue).toBe(40);
    expect(half.splitHighlightSat).toBe(10);
    expect(half.hsl.blue.lum).toBe(-10);
    expect(half.exposure).toBe(0);
  });

  it('has 20 valid unique presets (8 film, 6 cinema, 6 practical) and 8 valid beginner guides', () => {
    expect(GRADE_PRESETS).toHaveLength(20);
    const byCategory = {
      film: GRADE_PRESETS.filter((p) => p.category === 'film'),
      cinema: GRADE_PRESETS.filter((p) => p.category === 'cinema'),
      practical: GRADE_PRESETS.filter((p) => p.category === 'practical'),
    };
    expect(byCategory.film).toHaveLength(8);
    expect(byCategory.cinema).toHaveLength(6);
    expect(byCategory.practical).toHaveLength(6);

    const presetIds = new Set<string>();
    for (const preset of GRADE_PRESETS) {
      expect(presetIds.has(preset.id)).toBe(false);
      presetIds.add(preset.id);
      expect(preset.name.trim().length).toBeGreaterThan(0);
      expect(preset.reference.trim().length).toBeGreaterThan(0);
      expect(preset.bestFor.length).toBeGreaterThanOrEqual(2);

      // Verify every preset evaluates cleanly to finite [0..1] RGB without NaN
      const resolved = resolveGradeParams(preset.params);
      for (const band of HSL_BAND_IDS) {
        expect(resolved.hsl[band].hue).toBeGreaterThanOrEqual(-30);
        expect(resolved.hsl[band].hue).toBeLessThanOrEqual(30);
      }
      const [pr, pg, pb] = evaluateGradePixelCpu(0.45, 0.52, 0.68, resolved);
      expect(pr).toBeGreaterThanOrEqual(0);
      expect(pr).toBeLessThanOrEqual(1);
      expect(pg).toBeGreaterThanOrEqual(0);
      expect(pg).toBeLessThanOrEqual(1);
      expect(pb).toBeGreaterThanOrEqual(0);
      expect(pb).toBeLessThanOrEqual(1);
    }

    expect(BEGINNER_GUIDES).toHaveLength(8);
    for (const guide of BEGINNER_GUIDES) {
      expect(guide.problem.trim().length).toBeGreaterThan(0);
      expect(guide.diagnosis.trim().length).toBeGreaterThan(5);
      expect(guide.tip.trim().length).toBeGreaterThan(5);
      expect(guide.recommendedPresetIds.length).toBe(2);
      for (const pid of guide.recommendedPresetIds) {
        expect(presetIds.has(pid)).toBe(true);
      }
    }
  });

  it('stores, peeks, and consumes in-memory media handoffs independently per target', () => {
    clearToolkitHandoff();
    expect(peekToolkitHandoff('grade')).toBeNull();
    expect(peekToolkitHandoff('image')).toBeNull();

    const blob = new Blob(['frame-bytes'], { type: 'image/png' });
    setToolkitHandoff({
      target: 'grade',
      blob,
      fileName: 'slog3-frame.png',
      sourceLabel: 'Log 视频 LUT 还原',
      createdAt: Date.now(),
    });

    expect(peekToolkitHandoff('grade')?.fileName).toBe('slog3-frame.png');
    expect(peekToolkitHandoff('image')).toBeNull();

    const consumed = consumeToolkitHandoff('grade');
    expect(consumed?.fileName).toBe('slog3-frame.png');
    expect(consumeToolkitHandoff('grade')).toBeNull();
  });
});
