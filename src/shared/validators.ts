import { ApiError } from './errors';

export { ApiError };

export function text(value: unknown, label: string, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new ApiError(`${label}不能为空或超出长度限制（${limit}字）`);
  }
  return value.trim();
}

export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new ApiError('无效的标识');
  }
  return value;
}

export function coordinates(
  lat: unknown,
  lng: unknown,
  nullable = false,
): { lat: number | null; lng: number | null } {
  if (nullable && lat === null && lng === null) return { lat: null, lng: null };
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    throw new ApiError('坐标必须成对填写，纬度范围 -90～90，经度范围 -180～180');
  }
  return { lat, lng };
}

export function date(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const result = text(value, label, 40, true);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new ApiError(`${label}无效`);
  }
  const day = result.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new ApiError(`${label}无效`);
  }
  return result;
}

export function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError('请求内容必须是对象');
  }
  return input as Record<string, unknown>;
}

export function passcode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError('请输入 6 位数字或字母口令');
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9]{6}$/.test(trimmed)) {
    throw new ApiError('提取口令必须为 6 位数字或字母');
  }
  return trimmed;
}
