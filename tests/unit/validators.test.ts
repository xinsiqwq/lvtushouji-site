import { describe, expect, it } from 'vitest';
import { exifTakenAt, formatDay, formatRange, localDay } from '../../src/shared/dates';
import { ApiError } from '../../src/shared/errors';
import { CLOUD_MEDIA_LIMITS, acceptAttribute, formatSummary } from '../../src/shared/media-formats';
import { coordinates, date, id, object, passcode, text } from '../../src/shared/validators';

describe('shared validators & date helpers', () => {
  it('validates text, id, object, coordinates, and calendar dates', () => {
    expect(text('  川西秘境  ', '标题', 20, true)).toBe('川西秘境');
    expect(() => text('   ', '标题', 20, true)).toThrow(ApiError);
    expect(() => text('abcdef', '标题', 5)).toThrow(ApiError);

    expect(id('journey_01-abc')).toBe('journey_01-abc');
    expect(() => id('../evil')).toThrow(ApiError);
    expect(() => id('')).toThrow(ApiError);

    expect(coordinates(31.23, 121.47)).toEqual({ lat: 31.23, lng: 121.47 });
    expect(coordinates(null, null, true)).toEqual({ lat: null, lng: null });
    expect(() => coordinates(91, 0)).toThrow(ApiError);
    expect(() => coordinates(0, 181)).toThrow(ApiError);
    expect(() => coordinates(NaN, 100)).toThrow(ApiError);

    expect(date('2024-02-29', '日期')).toBe('2024-02-29'); // leap year
    expect(() => date('2023-02-29', '日期')).toThrow(ApiError); // non-leap year
    expect(() => date('2024-04-31', '日期')).toThrow(ApiError);
    expect(date(null, '日期', true)).toBeNull();

    expect(object({ ok: true })).toEqual({ ok: true });
    expect(() => object(null)).toThrow(ApiError);
    expect(() => object([])).toThrow(ApiError);
  });

  it('validates 6-char alphanumeric vault passcodes strictly', () => {
    expect(passcode(' Ab12Xy ')).toBe('Ab12Xy');
    expect(passcode('000000')).toBe('000000');
    expect(() => passcode('12345')).toThrow(ApiError);
    expect(() => passcode('1234567')).toThrow(ApiError);
    expect(() => passcode('123-56')).toThrow(ApiError);
    expect(() => passcode(123456)).toThrow(ApiError);
  });

  it('formats calendar dates and validates EXIF DateTimeOriginal strings', () => {
    expect(localDay('2026-11-20T22:15:00+08:00')).toBe('2026-11-20');
    expect(localDay('2025-02-29')).toBe('');
    expect(formatDay('2026-11-20')).toBe('2026.11.20');
    expect(formatRange('2026-11-01', '2026-11-20')).toBe('2026.11.01 — 2026.11.20');

    expect(exifTakenAt('2026:10:05 21:30:15', '+08:00')).toBe('2026-10-05T21:30:15+08:00');
    expect(exifTakenAt('2026:10:05 21:30:15')).toBe('2026-10-05T21:30:15');
    expect(exifTakenAt('2025:02:29 12:00:00')).toBeNull();
    expect(exifTakenAt('2026:10:05 21:30:15', '+14:30')).toBeNull();
  });

  it('exposes cloud media limits and format metadata', () => {
    expect(CLOUD_MEDIA_LIMITS.maxFileBytes).toBe(16 << 20);
    expect(CLOUD_MEDIA_LIMITS.maxChunkBytes).toBe(8 << 20);
    expect(acceptAttribute).toContain('.webp');
    expect(formatSummary('image')).toContain('WebP');
  });
});
