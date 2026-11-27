import type { AuthStatus } from '../../shared/types';

export const AUTH_REQUIRED_EVENT = 'travel:auth-required';
export const AUTH_CHANGE_EVENT = 'travel:auth-change';

export class ApiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

let cachedCsrfToken: string | null = null;
let inflightAuthPromise: Promise<AuthStatus> | null = null;

export function invalidateCsrfCache(): void {
  cachedCsrfToken = null;
}

export function notifyAuthChange(
  kind: 'setup' | 'login' | 'logout' | 'password' | 'revoke',
): void {
  invalidateCsrfCache();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_CHANGE_EVENT, { detail: { kind } }));
  }
}

export async function readAuthStatus(): Promise<AuthStatus> {
  if (inflightAuthPromise) return inflightAuthPromise;
  inflightAuthPromise = (async () => {
    const res = await fetch('/api/security/auth', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new ApiClientError('无法检查安全会话状态', res.status);
    }
    const status = (await res.json()) as AuthStatus;
    cachedCsrfToken = status.csrfToken ?? null;
    return status;
  })();
  try {
    return await inflightAuthPromise;
  } finally {
    inflightAuthPromise = null;
  }
}

async function ensureCsrfToken(): Promise<string | null> {
  if (cachedCsrfToken) return cachedCsrfToken;
  try {
    const status = await readAuthStatus();
    return status.csrfToken ?? null;
  } catch {
    return null;
  }
}

function isBinaryOrFormBody(body: BodyInit | null | undefined): boolean {
  if (!body) return false;
  return (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
  );
}

export async function apiFetch(input: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(options.headers);

  if (isMutation && !headers.has('X-Travel-CSRF')) {
    const token = await ensureCsrfToken();
    if (token) headers.set('X-Travel-CSRF', token);
  }

  const doFetch = (reqHeaders: Headers) =>
    fetch(input, {
      ...options,
      method,
      headers: reqHeaders,
      credentials: 'same-origin',
    });

  let response = await doFetch(headers);

  const isAuthEndpoint = input === '/api/security/auth';
  const streamBody =
    typeof ReadableStream !== 'undefined' && options.body instanceof ReadableStream;

  if (isMutation && !isAuthEndpoint && !streamBody && (response.status === 401 || response.status === 403)) {
    invalidateCsrfCache();
    const refreshed = await ensureCsrfToken();
    if (refreshed) {
      const retryHeaders = new Headers(options.headers);
      retryHeaders.set('X-Travel-CSRF', refreshed);
      response = await doFetch(retryHeaders);
    }
  }

  if (response.status === 401 && !isAuthEndpoint) {
    invalidateCsrfCache();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    }
  }

  return response;
}

export async function apiJson<T>(
  input: string,
  options: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body;

  if (options.json !== undefined) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json; charset=utf-8');
    }
    body = JSON.stringify(options.json);
  } else if (body && isBinaryOrFormBody(body)) {
    // Preserve multipart boundary or binary payload content-type
  }

  const response = await apiFetch(input, { ...options, headers, body });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const errObj =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const message =
      (errObj && typeof errObj.error === 'string' && errObj.error) ||
      (typeof parsed === 'string' && parsed) ||
      `请求失败 (${response.status})`;
    const code = errObj && typeof errObj.code === 'string' ? errObj.code : undefined;
    throw new ApiClientError(message, response.status, code, parsed);
  }

  return parsed as T;
}
