import { ApiError } from '../../shared/errors';
import type { AppBindings } from '../types';

// Fixed conservative budgets. Bytes are a lifetime upload budget, not net storage;
// failed uploads, replacements and deletions never return reserved capacity.
export const COST_LIMITS = Object.freeze({
  uploadBytes: 2 * 1024 ** 3,
  classA: 10_000,
  classB: 100_000,
  apiRequests: 200_000,
});

export const MAX_PUT_BYTES = 16 << 20;

export const currentUsageMonth = (): string => new Date().toISOString().slice(0, 7);

export async function reserveUsage(
  env: Pick<AppBindings, 'DB'>,
  key: string,
  amount: number,
  limit: number,
): Promise<number> {
  if (
    typeof key !== 'string' ||
    !key ||
    key.length > 200 ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 0
  ) {
    throw new ApiError('无效的额度请求', 400);
  }
  const result = await env.DB.prepare(
    `INSERT INTO usage_limits (key, value) SELECT ?, ? WHERE ? <= ?
     ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
       WHERE value <= ? - excluded.value
     RETURNING value`,
  )
    .bind(key, amount, amount, limit, limit)
    .first<{ value: number }>();

  if (!result) {
    throw new ApiError(
      '云端用量额度已用尽，请稍后再试',
      key === 'r2-upload-bytes:lifetime' ? 507 : 429,
    );
  }
  return result.value;
}

function boundedSize(value: unknown): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  throw new ApiError('上传内容必须是大小已知的数据，不能使用流', 400);
}

export async function enforceCloudRequestLimit(
  env: Pick<AppBindings, 'DB'>,
  options?: { allowAdminOverflow?: boolean },
): Promise<void> {
  try {
    await reserveUsage(env, `api-requests:${currentUsageMonth()}`, 1, COST_LIMITS.apiRequests);
  } catch (error) {
    if (options?.allowAdminOverflow && error instanceof ApiError && error.status === 429) {
      return;
    }
    throw error;
  }
}

export function withCostLimits<T extends Pick<AppBindings, 'DB' | 'MEDIA'>>(env: T): T {
  const bucket = env.MEDIA;
  const wrapped = new Proxy(bucket, {
    get(target, property) {
      if (typeof property === 'symbol') return Reflect.get(target, property, target);
      const method = Reflect.get(target, property, target);
      if (typeof method !== 'function') return method;

      if (property === 'put') {
        return async (...args: unknown[]) => {
          const bytes = boundedSize(args[1]);
          if (bytes > MAX_PUT_BYTES) {
            throw new ApiError('单个对象大小超过 16 MiB 云端上传限制', 413);
          }
          await reserveUsage(env, `r2-class-a:${currentUsageMonth()}`, 1, COST_LIMITS.classA);
          await reserveUsage(env, 'r2-upload-bytes:lifetime', bytes, COST_LIMITS.uploadBytes);
          return Reflect.apply(method, target, args);
        };
      }

      if (property === 'list' || property === 'delete') {
        return async (...args: unknown[]) => {
          const count = property === 'delete' && Array.isArray(args[0]) ? Math.max(1, args[0].length) : 1;
          await reserveUsage(env, `r2-class-a:${currentUsageMonth()}`, count, COST_LIMITS.classA);
          return Reflect.apply(method, target, args);
        };
      }

      if (property === 'get' || property === 'head') {
        return async (...args: unknown[]) => {
          await reserveUsage(env, `r2-class-b:${currentUsageMonth()}`, 1, COST_LIMITS.classB);
          return Reflect.apply(method, target, args);
        };
      }

      return () => {
        throw new ApiError('此存储操作未启用额度保护', 403);
      };
    },
  });

  return { ...env, MEDIA: wrapped };
}
