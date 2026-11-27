import fs from 'node:fs';
import path from 'node:path';

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  sessionId: string | null;
  csrfToken: string | null;
}

export interface ApiRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  origin?: string | null;
  csrfToken?: string | null;
  redirect?: RequestRedirect;
  responseType?: 'json' | 'buffer' | 'text';
}

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
  text: string;
  buffer: Buffer;
}

export interface ApiClientOptions {
  repoRoot?: string;
}

function splitFallbackSetCookieHeader(headerValue: string): string[] {
  // Split combined Set-Cookie header only at commas followed by `<cookie-name>=`
  const parts: string[] = [];
  let start = 0;
  const regex = /,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(headerValue)) !== null) {
    parts.push(headerValue.slice(start, match.index));
    start = match.index + match[0].length;
  }
  parts.push(headerValue.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}

function resolveDefaultRepoRoot(): string {
  const cwd = process.cwd();
  let cursor = cwd;
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(cursor, 'tests', 'e2e')) ||
      fs.existsSync(path.join(cursor, 'wrangler.jsonc'))
    ) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return cwd;
}

function readSetupTokenFromDevVars(repoRoot: string): string | undefined {
  for (const filename of ['.dev.vars.local', '.dev.vars']) {
    const filePath = path.join(repoRoot, filename);
    if (!fs.existsSync(filePath)) continue;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      if (key !== 'SETUP_TOKEN') continue;
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (val) return val;
    }
  }
  return undefined;
}

export class ApiClient {
  readonly baseURL: string;
  readonly origin: string;
  readonly repoRoot: string;
  private readonly jar = new Map<string, string>();
  private csrfToken: string | null = null;
  private sessionId: string | null = null;

  constructor(baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173', options: ApiClientOptions = {}) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.origin = new URL(this.baseURL).origin;
    this.repoRoot = options.repoRoot ?? resolveDefaultRepoRoot();
  }

  getCookies(): Record<string, string> {
    return Object.fromEntries(this.jar.entries());
  }

  setCookie(name: string, value: string): void {
    this.jar.set(name, value);
  }

  clearCookies(): void {
    this.jar.clear();
  }

  getCsrfToken(): string | null {
    return this.csrfToken;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private captureCookies(headers: Headers): void {
    const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const rawCookies =
      typeof getSetCookie === 'function'
        ? getSetCookie.call(headers)
        : headers.get('set-cookie')
          ? splitFallbackSetCookieHeader(headers.get('set-cookie')!)
          : [];

    for (const entry of rawCookies) {
      const segments = entry.split(';').map((s) => s.trim());
      const nv = segments[0];
      if (!nv) continue;
      const eqIdx = nv.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = nv.slice(0, eqIdx).trim();
      const value = nv.slice(eqIdx + 1);

      let maxAgeZero = false;
      for (let i = 1; i < segments.length; i += 1) {
        const attr = segments[i]!;
        const attrEq = attr.indexOf('=');
        if (attrEq > 0) {
          const k = attr.slice(0, attrEq).trim().toLowerCase();
          const v = attr.slice(attrEq + 1).trim();
          if (k === 'max-age') {
            const parsed = Number(v);
            if (Number.isFinite(parsed) && parsed <= 0) {
              maxAgeZero = true;
            }
          }
        }
      }

      // Intentionally ignore `Secure` flag over local HTTP (`http://127.0.0.1`)
      if (maxAgeZero || value === '') {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
  }

  private buildCookieHeader(): string | undefined {
    if (this.jar.size === 0) return undefined;
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request<T = unknown>(endpoint: string, options: ApiRequestOptions = {}): Promise<ApiResponse<T>> {
    const method = (options.method ?? 'GET').toUpperCase();
    const url = endpoint.startsWith('http://') || endpoint.startsWith('https://')
      ? endpoint
      : `${this.baseURL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    const headers = new Headers(options.headers);
    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader && !headers.has('cookie')) {
      headers.set('cookie', cookieHeader);
    }

    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (isMutation) {
      if (options.origin === null) {
        headers.delete('origin');
      } else if (options.origin !== undefined) {
        headers.set('origin', options.origin);
      } else if (!headers.has('origin')) {
        headers.set('origin', this.origin);
      }

      if (options.csrfToken === null) {
        headers.delete('x-travel-csrf');
      } else if (options.csrfToken !== undefined) {
        headers.set('x-travel-csrf', options.csrfToken);
      } else if (!headers.has('x-travel-csrf') && this.csrfToken) {
        headers.set('x-travel-csrf', this.csrfToken);
      }
    }

    let bodyToSend: BodyInit | undefined;
    const rawBody = options.body;
    if (rawBody !== undefined && rawBody !== null) {
      if (
        rawBody instanceof FormData ||
        rawBody instanceof Uint8Array ||
        rawBody instanceof ArrayBuffer ||
        rawBody instanceof Blob ||
        typeof rawBody === 'string'
      ) {
        bodyToSend = rawBody as BodyInit;
      } else {
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
        bodyToSend = JSON.stringify(rawBody);
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body: bodyToSend,
      redirect: options.redirect ?? 'follow',
    });

    this.captureCookies(response.headers);

    const arrayBuf = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const contentType = response.headers.get('content-type') || '';
    const text = buffer.toString('utf8');

    let data: unknown = text;
    if (options.responseType === 'buffer') {
      data = buffer;
    } else if (options.responseType === 'text') {
      data = text;
    } else if (
      options.responseType === 'json' ||
      contentType.includes('application/json') ||
      contentType.includes('+json')
    ) {
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
    } else if (text.startsWith('{') || text.startsWith('[')) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      data: data as T,
      text,
      buffer,
    };
  }

  // -------------------------------------------------------------------------
  // Auth & Setup
  // -------------------------------------------------------------------------

  async setupEntry(token: string): Promise<ApiResponse<string>> {
    return this.request<string>(`/__setup?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      redirect: 'manual',
    });
  }

  async getAuthStatus(): Promise<ApiResponse<AuthStatus>> {
    const res = await this.request<AuthStatus>('/api/security/auth', { method: 'GET' });
    if (res.ok && res.data && typeof res.data === 'object') {
      this.csrfToken = res.data.csrfToken ?? null;
      this.sessionId = res.data.sessionId ?? null;
    }
    return res;
  }

  async postAuth(
    body:
      | { action: 'setup'; password: string }
      | { action: 'login'; password: string }
      | { action: 'logout' }
      | { action: 'password' | 'change'; oldPassword: string; newPassword: string },
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<AuthStatus>> {
    const res = await this.request<AuthStatus>('/api/security/auth', {
      method: 'POST',
      body,
      ...overrides,
    });
    if (res.ok && res.data && typeof res.data === 'object') {
      this.csrfToken = res.data.csrfToken ?? null;
      this.sessionId = res.data.sessionId ?? null;
    }
    return res;
  }

  async ensureAdminSession(
    password = process.env.E2E_ADMIN_PASSWORD || 'AtlasVaultStarlight2026!',
    setupToken?: string,
  ): Promise<AuthStatus> {
    const current = await this.getAuthStatus();
    if (!current.ok) {
      throw new Error(`GET /api/security/auth failed with status ${current.status}: ${current.text}`);
    }

    if (current.data.authenticated) {
      return current.data;
    }

    if (!current.data.configured) {
      const resolvedToken =
        setupToken ||
        process.env.SETUP_TOKEN ||
        readSetupTokenFromDevVars(this.repoRoot);

      if (!resolvedToken) {
        throw new Error(
          `Admin auth is unconfigured and SETUP_TOKEN was not found in argument, process.env.SETUP_TOKEN, or ${path.join(this.repoRoot, '.dev.vars')}`,
        );
      }

      const setupEntryRes = await this.setupEntry(resolvedToken);
      if (setupEntryRes.status !== 303 && setupEntryRes.status !== 200) {
        throw new Error(
          `GET /__setup failed with status ${setupEntryRes.status}: ${setupEntryRes.text}`,
        );
      }

      const setupRes = await this.postAuth(
        { action: 'setup', password },
        {
          headers: {
            'x-travel-setup-token': resolvedToken,
          },
        },
      );
      if (!setupRes.ok || !setupRes.data.authenticated) {
        throw new Error(
          `POST /api/security/auth (setup) failed with status ${setupRes.status}: ${setupRes.text}`,
        );
      }
      return setupRes.data;
    }

    const loginRes = await this.postAuth({ action: 'login', password });
    if (!loginRes.ok || !loginRes.data.authenticated) {
      throw new Error(
        `POST /api/security/auth (login) failed with status ${loginRes.status}: ${loginRes.text}`,
      );
    }
    return loginRes.data;
  }

  // -------------------------------------------------------------------------
  // Security Endpoints
  // -------------------------------------------------------------------------

  getSecurity(): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/security', { method: 'GET' });
  }

  patchSecurity(
    policy: {
      recordingEnabled?: boolean;
      allowVisitorMessages?: boolean;
      retentionDays?: 7 | 30 | 90;
      requestsPerMinute?: number;
    },
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/security', {
      method: 'PATCH',
      body: policy,
      ...overrides,
    });
  }

  getVisitor(id: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request(`/api/security/visitor?id=${encodeURIComponent(id)}`, { method: 'GET' });
  }

  revokeSession(
    id: string,
    method: 'POST' | 'DELETE' = 'DELETE',
  ): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request('/api/security/sessions', {
      method,
      body: { id },
    });
  }

  blockTarget(payload: {
    action?: 'block' | 'unblock';
    type: 'visitor' | 'ip';
    value: string;
    reason?: string;
  }): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request('/api/security/block', {
      method: 'POST',
      body: { action: 'block', ...payload },
    });
  }

  unblockTarget(payload: {
    type: 'visitor' | 'ip';
    value: string;
  }): Promise<ApiResponse<{ ok: boolean }>> {
    return this.request('/api/security/block', {
      method: 'DELETE',
      body: payload,
    });
  }

  // -------------------------------------------------------------------------
  // Admin Operations
  // -------------------------------------------------------------------------

  getAdminUsage(): Promise<ApiResponse<{
    limits: { uploadBytes: number; classA: number; classB: number; apiRequests: number };
    counters: Array<{ key: string; value: number }>;
  }>> {
    return this.request('/api/admin/usage', { method: 'GET' });
  }

  getAdminBackup(): Promise<ApiResponse<Buffer>> {
    return this.request<Buffer>('/api/admin/backup', {
      method: 'GET',
      responseType: 'buffer',
    });
  }

  trashItem(
    kind: 'journey' | 'media' | 'message' | 'vault_file',
    id: string,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/admin/trash', {
      method: 'POST',
      body: { kind, id },
    });
  }

  restoreItem(key: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/admin/restore', {
      method: 'POST',
      body: { key },
    });
  }

  // -------------------------------------------------------------------------
  // Atlas & Media Endpoints
  // -------------------------------------------------------------------------

  getLibrary(ifNoneMatch?: string): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/library', {
      method: 'GET',
      headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : undefined,
    });
  }

  getAtlasConfig(): Promise<ApiResponse<{ tiandituConfigured: boolean }>> {
    return this.request('/api/atlas/config', { method: 'GET' });
  }

  getAtlasTile(layer: string, z: number, y: number, x: number): Promise<ApiResponse<Buffer>> {
    return this.request<Buffer>(
      `/api/atlas/tiles/${encodeURIComponent(layer)}/${z}/${y}/${x}`,
      { method: 'GET', responseType: 'buffer' },
    );
  }

  getFile(
    mediaId: string,
    opts: {
      variant?: 'thumbnail' | 'preview' | 'original';
      download?: boolean;
      method?: 'GET' | 'HEAD';
      range?: string;
    } = {},
  ): Promise<ApiResponse<Buffer>> {
    const params = new URLSearchParams();
    if (opts.variant) params.set('variant', opts.variant);
    if (opts.download) params.set('download', '1');
    const qs = params.toString();
    const headers: Record<string, string> = {};
    if (opts.range) headers.range = opts.range;
    return this.request<Buffer>(
      `/api/files/${encodeURIComponent(mediaId)}${qs ? `?${qs}` : ''}`,
      {
        method: opts.method ?? 'GET',
        headers,
        responseType: 'buffer',
      },
    );
  }

  uploadMedia(
    formData: FormData,
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/media', {
      method: 'POST',
      body: formData,
      ...overrides,
    });
  }

  patchMedia(
    patchOrUpdates: Record<string, unknown> | Array<Record<string, unknown>>,
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/media', {
      method: 'PATCH',
      body: patchOrUpdates,
      ...overrides,
    });
  }

  saveJourney(
    journey: Record<string, unknown>,
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/journeys', {
      method: 'POST',
      body: journey,
      ...overrides,
    });
  }

  // -------------------------------------------------------------------------
  // Vault Endpoints
  // -------------------------------------------------------------------------

  redeemVault(
    code: string,
    requestId?: string,
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<{
    fileName: string;
    size: number;
    mime: string;
    remainingDownloads: number;
    expiresAt: string;
    note?: string;
    shareUrl?: string;
    downloadUrl: string;
    error?: string;
  }>> {
    return this.request('/api/vault/redeem', {
      method: 'POST',
      body: requestId ? { code, requestId } : { code },
      ...overrides,
    });
  }

  downloadVaultTicket(
    ticketId: string,
    opts: { method?: 'GET' | 'HEAD'; range?: string } = {},
  ): Promise<ApiResponse<Buffer>> {
    const headers: Record<string, string> = {};
    if (opts.range) headers.range = opts.range;
    return this.request<Buffer>(
      `/api/vault/download/${encodeURIComponent(ticketId)}`,
      {
        method: opts.method ?? 'GET',
        headers,
        responseType: 'buffer',
      },
    );
  }

  initVaultUpload(
    meta: {
      name: string;
      mime: string;
      size: number;
      sha256: string;
      totalChunks: number;
    },
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<{ uploadId: string; fileId?: string; chunkSize?: number }>> {
    return this.request('/api/vault/uploads/init', {
      method: 'POST',
      body: meta,
      ...overrides,
    });
  }

  uploadVaultChunk(
    uploadId: string,
    chunkIndex: number,
    bytes: Uint8Array | Buffer | ArrayBuffer,
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'x-chunk-index': String(chunkIndex),
      ...(overrides.headers ?? {}),
    };
    return this.request(`/api/vault/uploads/${encodeURIComponent(uploadId)}/chunk`, {
      ...overrides,
      method: 'PUT',
      headers,
      body: bytes,
    });
  }

  completeVaultUpload(
    uploadId: string,
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request(`/api/vault/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      body: {},
      ...overrides,
    });
  }

  abortVaultUpload(
    uploadId: string,
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request(`/api/vault/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
      ...overrides,
    });
  }

  listVaultShares(): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/vault/shares', { method: 'GET' });
  }

  createVaultShare(
    input: {
      fileId: string;
      expiresIn?: number;
      expiresAt?: string;
      maxDownloads: number;
      passcode?: string;
      note?: string;
    },
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/api/vault/shares', {
      method: 'POST',
      body: input,
      ...overrides,
    });
  }

  revokeVaultShare(
    shareId: string,
    overrides: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request(`/api/vault/shares/${encodeURIComponent(shareId)}/revoke`, {
      method: 'POST',
      body: {},
      ...overrides,
    });
  }
}

export function createApiClient(baseURL?: string, options?: ApiClientOptions): ApiClient {
  return new ApiClient(baseURL, options);
}
