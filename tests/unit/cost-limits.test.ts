import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './test-db';
import {
  COST_LIMITS,
  MAX_PUT_BYTES,
  currentUsageMonth,
  reserveUsage,
  withCostLimits,
} from '../../src/server/middleware/cost-limits';
import type { AppBindings } from '../../src/server/types';

describe('cost-limits circuit breaker', () => {
  beforeEach(async () => {
    await resetTestDatabase(env.DB);
  });

  it('concurrent reservations never cross the hard cap and failed reservations do not grow it', async () => {
    const testEnv = env as unknown as AppBindings;
    const attempts = await Promise.allSettled(
      Array.from({ length: 30 }, () => reserveUsage(testEnv, 'race', 1, 10)),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(10);

    const row = await env.DB.prepare('SELECT value FROM usage_limits WHERE key=?')
      .bind('race')
      .first<{ value: number }>();
    expect(row?.value).toBe(10);

    await expect(reserveUsage(testEnv, 'race', 1, 10)).rejects.toThrow(/额度/);
    await expect(reserveUsage(testEnv, 'negative', -1, 10)).rejects.toThrow(/无效/);
  });

  it('storage lifetime limit refuses R2 put with 507 before writing to MEDIA', async () => {
    await env.DB.prepare('INSERT INTO usage_limits VALUES (?,?)')
      .bind('r2-upload-bytes:lifetime', COST_LIMITS.uploadBytes)
      .run();
    const limited = withCostLimits(env as unknown as AppBindings);

    await expect(limited.MEDIA.put('refused', new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      status: 507,
    });
    expect(await env.MEDIA.head('refused')).toBeNull();
  });

  it('operation quotas block before R2, reject streams/oversize/multipart, and meter array deletes', async () => {
    const limited = withCostLimits(env as unknown as AppBindings);

    await limited.MEDIA.put('one', 'é'); // 2 UTF-8 bytes
    await limited.MEDIA.put('two', new Uint8Array([1, 2, 3])); // 3 bytes

    const bytesRow = await env.DB.prepare('SELECT value FROM usage_limits WHERE key=?')
      .bind('r2-upload-bytes:lifetime')
      .first<{ value: number }>();
    expect(bytesRow?.value).toBe(5);

    await limited.MEDIA.head('missing');
    const month = currentUsageMonth();
    const classBRow = await env.DB.prepare('SELECT value FROM usage_limits WHERE key=?')
      .bind(`r2-class-b:${month}`)
      .first<{ value: number }>();
    expect(classBRow?.value).toBe(1);

    // Array delete charges per key
    await limited.MEDIA.delete(['one', 'two']);
    const classARow = await env.DB.prepare('SELECT value FROM usage_limits WHERE key=?')
      .bind(`r2-class-a:${month}`)
      .first<{ value: number }>();
    expect(classARow?.value).toBe(4); // 2 puts + 2 deleted keys

    // Exhaust Class B
    await env.DB.prepare('UPDATE usage_limits SET value=? WHERE key=?')
      .bind(COST_LIMITS.classB, `r2-class-b:${month}`)
      .run();
    await expect(limited.MEDIA.get('one')).rejects.toMatchObject({ status: 429 });

    // Exhaust Class A
    await limited.MEDIA.put('keep', new Uint8Array([9])).catch(() => {});
    await env.MEDIA.put('keep', new Uint8Array([9]));
    await env.DB.prepare('UPDATE usage_limits SET value=? WHERE key=?')
      .bind(COST_LIMITS.classA, `r2-class-a:${month}`)
      .run();
    await expect(limited.MEDIA.delete('keep')).rejects.toMatchObject({ status: 429 });
    expect(await env.MEDIA.head('keep')).not.toBeNull();

    // Reject streams (400), > 16 MiB (413), and multipart (403)
    await expect(
      limited.MEDIA.put('stream', new ReadableStream() as unknown as ArrayBuffer),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      limited.MEDIA.put('too-big', new Uint8Array(MAX_PUT_BYTES + 1)),
    ).rejects.toMatchObject({ status: 413 });
    expect(() => limited.MEDIA.createMultipartUpload('x')).toThrow(/额度保护/);
  });

  it('new reservations cannot start above the cap', async () => {
    const testEnv = env as unknown as AppBindings;
    await expect(reserveUsage(testEnv, 'new', 11, 10)).rejects.toMatchObject({ status: 429 });
    expect(
      await env.DB.prepare('SELECT value FROM usage_limits WHERE key=?').bind('new').first(),
    ).toBeNull();
  });
});
