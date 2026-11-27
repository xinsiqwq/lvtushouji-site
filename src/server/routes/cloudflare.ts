import { Hono } from 'hono';
import {
  CLOUDFLARE_REQUIRED_PERMISSIONS,
  type CloudflareAccountAnalytics,
  type CloudflareGlobalComponent,
  type CloudflareGlobalIncident,
  type CloudflareGlobalStatus,
  type CloudflareHealthLevel,
  type CloudflareOpsActionRequest,
  type CloudflareOpsActionResponse,
  type CloudflareRuntimeProbe,
  type CloudflareStatusSnapshot,
  type CloudflareTimeRange,
  type CloudflareTrafficPoint,
  type CloudflareWorkerPoint,
  type CloudflareZoneControls,
  type CloudflareZoneSecurityLevel,
} from '../../shared/cloudflare-types';
import { ApiError } from '../../shared/errors';
import { object } from '../../shared/validators';
import { COST_LIMITS, currentUsageMonth } from '../middleware/cost-limits';
import { noteSecurityEvent, requireCloudAdmin } from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';

export const cloudflareRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const CF_GRAPHQL_URL = `${CF_API_BASE}/graphql`;
const CF_STATUSPAGE_URL = 'https://www.cloudflarestatus.com/api/v2/summary.json';
const CACHE_TTL_MS = 60_000;
const STATUSPAGE_ERROR_CACHE_TTL_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const STATUSPAGE_TIMEOUT_MS = 6_000;

const VALID_SECURITY_LEVELS = new Set<CloudflareZoneSecurityLevel>([
  'off',
  'essentially_off',
  'low',
  'medium',
  'high',
  'under_attack',
]);

const R2_CLASS_A_ACTIONS = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
  'LifecycleStorageTierTransition',
  'PutBucketCustomDomain',
  'PutBucketEventNotification',
]);

const R2_CLASS_B_ACTIONS = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
  'GetBucketCustomDomain',
]);

const CORE_COMPONENT_PATTERNS = [
  /workers/i,
  /\bd1\b/i,
  /\br2\b/i,
  /durable objects/i,
  /authoritative dns/i,
  /\bdns\b/i,
  /\bssl\b/i,
  /\bcdn\b/i,
  /cache/i,
  /dashboard/i,
  /\bapi\b/i,
  /waf|firewall/i,
];

type CacheEntry<T> = {
  value: T;
  storedAt: number;
};

const globalStatusCache = new Map<string, CacheEntry<CloudflareGlobalStatus>>();
const accountAnalyticsCache = new Map<string, CacheEntry<CloudflareAccountAnalytics>>();

export function clearCloudflareStatusCache(): void {
  globalStatusCache.clear();
  accountAnalyticsCache.clear();
}

function parseRange(raw: string | undefined): CloudflareTimeRange {
  if (raw === '24h' || raw === '7d') return raw;
  return 'today';
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

function extractRootDomain(hostname: string): string {
  const clean = hostname.trim().toLowerCase().replace(/\.+$/, '');
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;
  return parts.slice(-2).join('.');
}

function formatTimeBucketLabel(isoOrDate: string, isDaily: boolean): string {
  if (isDaily) {
    return isoOrDate.slice(5, 10);
  }
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate.slice(11, 16) || isoOrDate;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatRangeBounds(range: CloudflareTimeRange, now: Date): {
  startIso: string;
  endIso: string;
  startDate: string;
  endDate: string;
  todayStartIso: string;
  monthStartIso: string;
} {
  const endIso = now.toISOString();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));

  let start: Date;
  if (range === '24h') {
    start = new Date(now.getTime() - 24 * 3600_000);
  } else if (range === '7d') {
    start = new Date(now.getTime() - 7 * 86400_000);
  } else {
    start = todayStart;
  }

  return {
    startIso: start.toISOString(),
    endIso,
    startDate: start.toISOString().slice(0, 10),
    endDate: endIso.slice(0, 10),
    todayStartIso: todayStart.toISOString(),
    monthStartIso: monthStart.toISOString(),
  };
}

async function fingerprintScope(parts: Array<string | undefined>): Promise<string> {
  const raw = parts.map((p) => p ?? '').join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: T | null; errorText?: string }> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let parsed: T | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data: parsed,
      errorText: text.slice(0, 240),
    };
  }
  return { ok: true, status: res.status, data: parsed };
}

type CfRestEnvelope<T> = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
};

async function cfRestFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; result: T | null; error?: string }> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  try {
    const res = await fetchJsonWithTimeout<CfRestEnvelope<T>>(
      `${CF_API_BASE}${path}`,
      { ...init, headers },
      UPSTREAM_TIMEOUT_MS,
    );
    if (!res.ok || !res.data?.success) {
      const apiErr = res.data?.errors?.[0]?.message;
      return {
        ok: false,
        status: res.status,
        result: null,
        error: apiErr || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      status: res.status,
      result: (res.data.result ?? null) as T | null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      result: null,
      error: err instanceof Error ? err.message : '网络请求失败',
    };
  }
}

type GraphQlEnvelope<T> = {
  data?: T | null;
  errors?: Array<{ message?: string }>;
};

async function cfGraphQlFetch<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const res = await fetchJsonWithTimeout<GraphQlEnvelope<T>>(
      CF_GRAPHQL_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
      UPSTREAM_TIMEOUT_MS,
    );
    if (!res.ok) {
      const errMsg = res.data?.errors?.[0]?.message || `GraphQL HTTP ${res.status}`;
      return { ok: false, data: null, error: errMsg };
    }
    if (res.data?.errors?.length && !res.data?.data) {
      return { ok: false, data: null, error: res.data.errors[0]?.message || 'GraphQL 查询错误' };
    }
    return {
      ok: true,
      data: res.data?.data ?? null,
      error: res.data?.errors?.[0]?.message,
    };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'GraphQL 请求超时或失败',
    };
  }
}

async function runRuntimeProbe(request: Request, rawEnv: AppBindings): Promise<CloudflareRuntimeProbe> {
  const startedAt = performance.now();
  const url = new URL(request.url);
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;

  const colo = typeof cf?.colo === 'string' && cf.colo ? cf.colo : null;
  const environment: 'production' | 'local-dev' =
    !isLoopbackHost(url.hostname) && colo ? 'production' : 'local-dev';

  const edge = {
    environment,
    host: url.host,
    colo,
    country: typeof cf?.country === 'string' ? cf.country : null,
    city: typeof cf?.city === 'string' ? cf.city : null,
    region: typeof cf?.region === 'string' ? cf.region : null,
    asn: typeof cf?.asn === 'number' ? cf.asn : null,
    asOrganization: typeof cf?.asOrganization === 'string' ? cf.asOrganization : null,
    httpProtocol: typeof cf?.httpProtocol === 'string' ? cf.httpProtocol : null,
    tlsVersion: typeof cf?.tlsVersion === 'string' ? cf.tlsVersion : null,
    tlsCipher: typeof cf?.tlsCipher === 'string' ? cf.tlsCipher : null,
    clientTcpRttMs: typeof cf?.clientTcpRtt === 'number' ? cf.clientTcpRtt : null,
  };

  const month = currentUsageMonth();

  // 1. D1 live probe + table stats + app budget snapshot
  const d1ProbePromise = (async () => {
    const t0 = performance.now();
    try {
      const [countsRes, usageRes] = await Promise.all([
        rawEnv.DB.prepare(
          `SELECT
            (SELECT count(*) FROM journeys) AS journeys,
            (SELECT count(*) FROM media) AS media,
            (SELECT count(*) FROM vault_files) AS vaultFiles,
            (SELECT count(*) FROM projects) AS projects,
            (SELECT count(*) FROM arena_lobbies) AS arenaLobbies,
            (SELECT coalesce(sum(human_count), 0) FROM arena_lobbies) AS arenaHumans,
            (SELECT count(*) FROM arena_matches) AS arenaMatches,
            (SELECT count(*) FROM security_events) AS securityEvents`,
        ).all<{
          journeys: number;
          media: number;
          vaultFiles: number;
          projects: number;
          arenaLobbies: number;
          arenaHumans: number;
          arenaMatches: number;
          securityEvents: number;
        }>(),
        rawEnv.DB.prepare(
          'SELECT key, value FROM usage_limits WHERE key IN (?, ?, ?, ?)',
        )
          .bind(
            `api-requests:${month}`,
            'r2-upload-bytes:lifetime',
            `r2-class-a:${month}`,
            `r2-class-b:${month}`,
          )
          .all<{ key: string; value: number }>(),
      ]);

      const latencyMs = Math.max(1, Math.round(performance.now() - t0));
      const row = countsRes.results[0];
      const counterMap = new Map(usageRes.results.map((r) => [r.key, Number(r.value) || 0]));

      return {
        d1: {
          ok: true,
          latencyMs,
          detail: 'SQLite 查询正常响应',
          databaseBytes: Number(countsRes.meta.size_after ?? 0),
          tables: {
            journeys: Number(row?.journeys ?? 0),
            media: Number(row?.media ?? 0),
            vaultFiles: Number(row?.vaultFiles ?? 0),
            projects: Number(row?.projects ?? 0),
            arenaLobbies: Number(row?.arenaLobbies ?? 0),
            arenaMatches: Number(row?.arenaMatches ?? 0),
            securityEvents: Number(row?.securityEvents ?? 0),
          },
        },
        arenaLobbies: Number(row?.arenaLobbies ?? 0),
        arenaHumans: Number(row?.arenaHumans ?? 0),
        appBudget: {
          month,
          apiRequests: counterMap.get(`api-requests:${month}`) ?? 0,
          apiRequestsCap: COST_LIMITS.apiRequests,
          uploadBytes: counterMap.get('r2-upload-bytes:lifetime') ?? 0,
          uploadBytesCap: COST_LIMITS.uploadBytes,
          r2ClassA: counterMap.get(`r2-class-a:${month}`) ?? 0,
          r2ClassACap: COST_LIMITS.classA,
          r2ClassB: counterMap.get(`r2-class-b:${month}`) ?? 0,
          r2ClassBCap: COST_LIMITS.classB,
        },
      };
    } catch (err) {
      return {
        d1: {
          ok: false,
          latencyMs: Math.max(1, Math.round(performance.now() - t0)),
          detail: 'D1 查询异常',
          error: err instanceof Error ? err.message : 'D1 探针失败',
          databaseBytes: 0,
          tables: {
            journeys: 0,
            media: 0,
            vaultFiles: 0,
            projects: 0,
            arenaLobbies: 0,
            arenaMatches: 0,
            securityEvents: 0,
          },
        },
        arenaLobbies: 0,
        arenaHumans: 0,
        appBudget: {
          month,
          apiRequests: 0,
          apiRequestsCap: COST_LIMITS.apiRequests,
          uploadBytes: 0,
          uploadBytesCap: COST_LIMITS.uploadBytes,
          r2ClassA: 0,
          r2ClassACap: COST_LIMITS.classA,
          r2ClassB: 0,
          r2ClassBCap: COST_LIMITS.classB,
        },
      };
    }
  })();

  // 2. R2 live probe (uses unwrapped raw binding head() so admin health polling does not inflate user R2 budget counters)
  const r2ProbePromise = (async () => {
    const t0 = performance.now();
    try {
      await rawEnv.MEDIA.head('__cf_health_probe__');
      return {
        ok: true,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        detail: '私有桶绑定连通正常',
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        detail: 'R2 存储探针异常',
        error: err instanceof Error ? err.message : 'R2 不可达',
      };
    }
  })();

  // 3. Durable Object (ArenaRoomDO) live probe — reuses read-only GET /status without mutating DO state
  const doProbePromise = (async () => {
    const t0 = performance.now();
    try {
      if (!rawEnv.ARENA_ROOM) {
        return {
          ok: false,
          latencyMs: 0,
          detail: '未绑定 ARENA_ROOM',
          error: 'Durable Object 绑定缺失',
        };
      }
      const stub = rawEnv.ARENA_ROOM.getByName('__cf_health_probe__');
      const res = await stub.fetch('https://arena.internal/status', { method: 'GET' });
      await res.arrayBuffer();
      const latencyMs = Math.max(1, Math.round(performance.now() - t0));
      const healthy = res.status === 200 || res.status === 404;
      return {
        ok: healthy,
        latencyMs,
        detail: healthy ? '沙暴联机 DO 实例响应正常' : `DO 返回异常状态 (${res.status})`,
        error: healthy ? undefined : `Unexpected DO status ${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        detail: 'Durable Object 探针异常',
        error: err instanceof Error ? err.message : 'DO 不可达',
      };
    }
  })();

  const [d1Result, r2Result, doResult] = await Promise.all([
    d1ProbePromise,
    r2ProbePromise,
    doProbePromise,
  ]);

  return {
    probedAt: new Date().toISOString(),
    workerResponseMs: Math.max(1, Math.round(performance.now() - startedAt)),
    edge,
    d1: d1Result.d1,
    r2: r2Result,
    durableObject: {
      ...doResult,
      activeLobbies: d1Result.arenaLobbies,
      activeHumans: d1Result.arenaHumans,
    },
    appBudget: d1Result.appBudget,
  };
}

type StatuspageSummaryPayload = {
  page?: { url?: string };
  status?: { indicator?: string; description?: string };
  components?: Array<{
    id?: string;
    name?: string;
    status?: string;
    updated_at?: string;
    group?: boolean;
  }>;
  incidents?: Array<{
    id?: string;
    name?: string;
    status?: string;
    impact?: string;
    shortlink?: string;
    updated_at?: string;
  }>;
  scheduled_maintenances?: Array<{
    id?: string;
    name?: string;
    status?: string;
    impact?: string;
    shortlink?: string;
    updated_at?: string;
  }>;
};

async function fetchGlobalStatus(force: boolean): Promise<CloudflareGlobalStatus> {
  const now = Date.now();
  const cached = globalStatusCache.get('summary');
  const ttlMs = cached?.value.status === 'unavailable' ? STATUSPAGE_ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
  if (!force && cached && now - cached.storedAt < ttlMs) {
    return {
      ...cached.value,
      cached: true,
      cacheAgeSec: Math.max(0, Math.round((now - cached.storedAt) / 1000)),
    };
  }

  try {
    const res = await fetchJsonWithTimeout<StatuspageSummaryPayload>(
      CF_STATUSPAGE_URL,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      STATUSPAGE_TIMEOUT_MS,
    );

    if (!res.ok || !res.data) {
      throw new Error(`Statuspage HTTP ${res.status}`);
    }

    const rawComponents = Array.isArray(res.data.components) ? res.data.components : [];
    const concrete = rawComponents.filter((c) => !c.group && typeof c.name === 'string');
    const degraded = concrete.filter((c) => c.status && c.status !== 'operational');
    const matchedCore = concrete.filter(
      (c) =>
        (c.status && c.status !== 'operational') ||
        CORE_COMPONENT_PATTERNS.some((pattern) => pattern.test(c.name || '')),
    );

    const seenNames = new Set<string>();
    const selectedComponents: CloudflareGlobalComponent[] = [];
    for (const item of [...degraded, ...matchedCore]) {
      const name = (item.name || '').trim();
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);
      selectedComponents.push({
        id: item.id || name,
        name,
        status: item.status || 'unknown',
        updatedAt: item.updated_at || new Date(now).toISOString(),
      });
      if (selectedComponents.length >= 16) break;
    }

    const mapIncident = (
      item: NonNullable<StatuspageSummaryPayload['incidents']>[number],
    ): CloudflareGlobalIncident => ({
      id: item.id || crypto.randomUUID(),
      name: item.name || '未命名事件',
      status: item.status || 'investigating',
      impact: item.impact || 'minor',
      shortlink: item.shortlink || 'https://www.cloudflarestatus.com/',
      updatedAt: item.updated_at || new Date(now).toISOString(),
    });

    const rawIndicator = res.data.status?.indicator;
    const indicator: CloudflareGlobalStatus['indicator'] =
      rawIndicator === 'none' ||
      rawIndicator === 'minor' ||
      rawIndicator === 'major' ||
      rawIndicator === 'critical'
        ? rawIndicator
        : 'unknown';

    const result: CloudflareGlobalStatus = {
      status: 'ok',
      fetchedAt: new Date(now).toISOString(),
      cached: false,
      cacheAgeSec: 0,
      indicator,
      description: res.data.status?.description || 'Cloudflare 状态已同步',
      pageUrl: res.data.page?.url || 'https://www.cloudflarestatus.com',
      components: selectedComponents,
      degradedCount: degraded.length,
      incidents: (res.data.incidents ?? []).slice(0, 6).map(mapIncident),
      maintenances: (res.data.scheduled_maintenances ?? []).slice(0, 6).map(mapIncident),
    };

    globalStatusCache.set('summary', { value: result, storedAt: now });
    return result;
  } catch (err) {
    const failedResult: CloudflareGlobalStatus = {
      status: 'unavailable',
      fetchedAt: new Date(now).toISOString(),
      cached: false,
      cacheAgeSec: 0,
      indicator: 'unknown',
      description: '暂无法连接 Cloudflare 全球状态页',
      pageUrl: 'https://www.cloudflarestatus.com',
      components: [],
      degradedCount: 0,
      incidents: [],
      maintenances: [],
      error: err instanceof Error ? err.message : 'Statuspage 请求失败',
    };
    globalStatusCache.set('summary', { value: failedResult, storedAt: now });
    return failedResult;
  }
}

type ResolvedCfScope = {
  accountId: string | null;
  accountName: string | null;
  zoneId: string | null;
  zoneName: string | null;
  zoneStatus: string | null;
  zonePlanName: string | null;
  zonePaused: boolean;
  warnings: string[];
};

async function resolveCloudflareScope(
  token: string,
  env: AppBindings,
  requestHost: string,
): Promise<ResolvedCfScope> {
  const warnings: string[] = [];
  let accountId = env.CF_ACCOUNT_ID?.trim() || null;
  let accountName: string | null = null;
  let zoneId = env.CF_ZONE_ID?.trim() || null;
  let zoneName: string | null = env.CF_ZONE_NAME?.trim() || null;
  let zoneStatus: string | null = null;
  let zonePlanName: string | null = null;
  let zonePaused = false;

  const hostWithoutPort = requestHost.split(':')[0].toLowerCase();
  const preferredZoneName =
    zoneName || (!isLoopbackHost(hostWithoutPort) ? extractRootDomain(hostWithoutPort) : null);

  type ZoneRecord = {
    id: string;
    name: string;
    status: string;
    paused?: boolean;
    account?: { id?: string; name?: string };
    plan?: { name?: string };
  };

  if (zoneId) {
    const zoneRes = await cfRestFetch<ZoneRecord>(token, `/zones/${encodeURIComponent(zoneId)}`);
    if (zoneRes.ok && zoneRes.result) {
      zoneName = zoneRes.result.name;
      zoneStatus = zoneRes.result.status;
      zonePlanName = zoneRes.result.plan?.name || 'Free';
      zonePaused = Boolean(zoneRes.result.paused);
      if (!accountId && zoneRes.result.account?.id) {
        accountId = zoneRes.result.account.id;
      }
      if (zoneRes.result.account?.name) {
        accountName = zoneRes.result.account.name;
      }
    } else {
      warnings.push(`读取 Zone (${zoneId}) 信息失败：${zoneRes.error || '未知错误'}`);
    }
  } else {
    const queryPath = preferredZoneName
      ? `/zones?name=${encodeURIComponent(preferredZoneName)}&per_page=5`
      : '/zones?status=active&per_page=5';
    let listRes = await cfRestFetch<ZoneRecord[]>(token, queryPath);
    if (listRes.ok && (!listRes.result || listRes.result.length === 0) && preferredZoneName) {
      listRes = await cfRestFetch<ZoneRecord[]>(token, '/zones?status=active&per_page=5');
    }
    if (listRes.ok && listRes.result && listRes.result.length > 0) {
      const picked = listRes.result[0];
      zoneId = picked.id;
      zoneName = picked.name;
      zoneStatus = picked.status;
      zonePlanName = picked.plan?.name || 'Free';
      zonePaused = Boolean(picked.paused);
      if (!accountId && picked.account?.id) {
        accountId = picked.account.id;
      }
      if (picked.account?.name) {
        accountName = picked.account.name;
      }
    } else if (!listRes.ok) {
      warnings.push(`自动识别 Zone 失败：${listRes.error || 'Token 可能缺少 Zone:Read 权限'}`);
    }
  }

  if (!accountId) {
    type AccountRecord = { id: string; name: string };
    const accRes = await cfRestFetch<AccountRecord[]>(token, '/accounts?per_page=5');
    if (accRes.ok && accRes.result && accRes.result.length > 0) {
      accountId = accRes.result[0].id;
      accountName = accRes.result[0].name;
    } else if (!accRes.ok) {
      warnings.push(`自动识别 Account ID 失败：${accRes.error || '请配置 CF_ACCOUNT_ID 或授予 Account Settings:Read'}`);
    }
  }

  return {
    accountId,
    accountName,
    zoneId,
    zoneName,
    zoneStatus,
    zonePlanName,
    zonePaused,
    warnings,
  };
}

async function fetchZoneControls(
  token: string,
  scope: ResolvedCfScope,
): Promise<{ controls: CloudflareZoneControls | null; warnings: string[] }> {
  const warnings: string[] = [];
  if (!scope.zoneId) {
    return { controls: null, warnings };
  }

  type SettingValue = {
    id: string;
    value: string;
    time_remaining?: number;
  };

  const [secRes, devRes] = await Promise.all([
    cfRestFetch<SettingValue>(token, `/zones/${encodeURIComponent(scope.zoneId)}/settings/security_level`),
    cfRestFetch<SettingValue>(token, `/zones/${encodeURIComponent(scope.zoneId)}/settings/development_mode`),
  ]);

  let securityLevel: CloudflareZoneSecurityLevel | null = null;
  if (secRes.ok && secRes.result?.value && VALID_SECURITY_LEVELS.has(secRes.result.value as CloudflareZoneSecurityLevel)) {
    securityLevel = secRes.result.value as CloudflareZoneSecurityLevel;
  } else if (!secRes.ok) {
    warnings.push(`无法读取安全防护级别：${secRes.error}`);
  }

  let developmentMode: CloudflareZoneControls['developmentMode'] = null;
  if (devRes.ok && devRes.result) {
    developmentMode = {
      enabled: devRes.result.value === 'on',
      timeRemainingSec: Math.max(0, Number(devRes.result.time_remaining ?? 0)),
    };
  } else if (!devRes.ok) {
    warnings.push(`无法读取开发模式状态：${devRes.error}`);
  }

  const canManageZone = secRes.ok || devRes.ok;

  return {
    controls: {
      zoneId: scope.zoneId,
      zoneName: scope.zoneName || scope.zoneId,
      zoneStatus: scope.zoneStatus || 'active',
      planName: scope.zonePlanName || 'Free',
      paused: scope.zonePaused,
      securityLevel,
      developmentMode,
      canManageZone,
      opsNote: canManageZone
        ? undefined
        : '当前 Token 缺少 Zone Settings / Cache Purge 权限，远程运维开关暂不可用',
    },
    warnings,
  };
}

function createEmptyAccountAnalytics(
  configured: boolean,
  range: CloudflareTimeRange,
  workerName: string,
  fetchedAt: string,
): CloudflareAccountAnalytics {
  return {
    configured,
    fetchedAt,
    cached: false,
    cacheAgeSec: 0,
    range,
    accountId: null,
    accountName: null,
    workerName,
    dashboardUrl: null,
    latestDeployment: null,
    workers: {
      available: false,
      requests: 0,
      todayRequests: 0,
      errors: 0,
      subrequests: 0,
      errorRatePct: 0,
      cpuTimeP50Ms: 0,
      cpuTimeP99Ms: 0,
      series: [],
    },
    d1: {
      available: false,
      readQueries: 0,
      writeQueries: 0,
      rowsRead: 0,
      rowsWritten: 0,
      todayRowsRead: 0,
      todayRowsWritten: 0,
      storageBytes: 0,
    },
    r2: {
      available: false,
      monthClassA: 0,
      monthClassB: 0,
      objectCount: 0,
      payloadBytes: 0,
      metadataBytes: 0,
      totalStorageBytes: 0,
    },
    durableObjects: {
      available: false,
      requests: 0,
      todayRequests: 0,
      responseBodyBytes: 0,
      storedBytes: 0,
    },
    zoneTraffic: {
      available: false,
      requests: 0,
      cachedRequests: 0,
      cacheHitRatePct: 0,
      bytes: 0,
      cachedBytes: 0,
      encryptedRequests: 0,
      httpsRatePct: 0,
      threats: 0,
      series: [],
    },
    zoneControls: null,
    warnings: [],
    permissionsGuide: CLOUDFLARE_REQUIRED_PERMISSIONS,
  };
}

async function fetchAccountAnalytics(
  env: AppBindings,
  requestHost: string,
  range: CloudflareTimeRange,
  force: boolean,
): Promise<CloudflareAccountAnalytics> {
  const token = env.CF_API_TOKEN?.trim() || '';
  const workerName = env.CF_WORKER_NAME?.trim() || 'lvtushouji-site';
  const now = new Date();
  const nowMs = now.getTime();
  const fetchedAt = now.toISOString();

  if (!token) {
    return createEmptyAccountAnalytics(false, range, workerName, fetchedAt);
  }

  const scopeFingerprint = await fingerprintScope([
    token,
    env.CF_ACCOUNT_ID,
    env.CF_ZONE_ID,
    env.CF_ZONE_NAME,
    workerName,
    env.CF_D1_DATABASE_ID,
    env.CF_R2_BUCKET_NAME,
    range,
  ]);

  const cached = accountAnalyticsCache.get(scopeFingerprint);
  if (!force && cached && nowMs - cached.storedAt < CACHE_TTL_MS) {
    return {
      ...cached.value,
      cached: true,
      cacheAgeSec: Math.max(0, Math.round((nowMs - cached.storedAt) / 1000)),
    };
  }

  const out = createEmptyAccountAnalytics(true, range, workerName, fetchedAt);
  const scope = await resolveCloudflareScope(token, env, requestHost);
  out.accountId = scope.accountId;
  out.accountName = scope.accountName;
  out.warnings.push(...scope.warnings);

  if (scope.accountId) {
    out.dashboardUrl = `https://dash.cloudflare.com/${scope.accountId}`;
  }

  const bounds = formatRangeBounds(range, now);
  const isDaily = range === '7d';

  type WorkersGqlResult = {
    viewer?: {
      accounts?: Array<{
        rangeGroups?: Array<{
          sum?: { requests?: number; errors?: number; subrequests?: number };
          quantiles?: { cpuTimeP50?: number; cpuTimeP99?: number };
          dimensions?: { datetimeHour?: string; date?: string };
        }>;
        todayGroups?: Array<{
          sum?: { requests?: number };
        }>;
      }>;
    };
  };

  type D1GqlResult = {
    viewer?: {
      accounts?: Array<{
        rangeD1?: Array<{
          sum?: {
            readQueries?: number;
            writeQueries?: number;
            rowsRead?: number;
            rowsWritten?: number;
          };
        }>;
        todayD1?: Array<{
          sum?: { rowsRead?: number; rowsWritten?: number };
        }>;
        storageD1?: Array<{
          max?: { databaseSizeBytes?: number };
        }>;
      }>;
    };
  };

  type R2GqlResult = {
    viewer?: {
      accounts?: Array<{
        opsR2?: Array<{
          sum?: { requests?: number };
          dimensions?: { actionType?: string };
        }>;
        storageR2?: Array<{
          max?: {
            objectCount?: number;
            payloadSize?: number;
            metadataSize?: number;
          };
        }>;
      }>;
    };
  };

  type DoGqlResult = {
    viewer?: {
      accounts?: Array<{
        rangeDo?: Array<{
          sum?: { requests?: number; responseBodySize?: number };
        }>;
        todayDo?: Array<{
          sum?: { requests?: number };
        }>;
        storageDo?: Array<{
          max?: { storedBytes?: number };
        }>;
      }>;
    };
  };

  type ZoneHttpGqlResult = {
    viewer?: {
      zones?: Array<{
        groups?: Array<{
          dimensions?: { datetime?: string; date?: string };
          sum?: {
            requests?: number;
            cachedRequests?: number;
            bytes?: number;
            cachedBytes?: number;
            encryptedRequests?: number;
            threats?: number;
          };
        }>;
      }>;
    };
  };

  type WorkerDeploymentsPayload = {
    deployments?: Array<{
      id?: string;
      created_on?: string;
      source?: string;
    }>;
  };

  const d1FilterExtra = env.CF_D1_DATABASE_ID?.trim()
    ? `, databaseId: $d1DatabaseId`
    : '';
  const r2FilterExtra = env.CF_R2_BUCKET_NAME?.trim()
    ? `, bucketName: $r2BucketName`
    : '';

  const tasks: Array<Promise<void>> = [];

  // Task A: Zone controls
  tasks.push(
    (async () => {
      const { controls, warnings } = await fetchZoneControls(token, scope);
      out.zoneControls = controls;
      out.warnings.push(...warnings);
    })(),
  );

  // Task B: Account-scoped GraphQL queries + Worker deployments
  if (scope.accountId) {
    const accountId = scope.accountId;

    // B1: Workers analytics
    tasks.push(
      (async () => {
        const bucketDim = isDaily ? 'date' : 'datetimeHour';
        const query = `
          query WorkersStatus($accountTag: String!, $start: Time!, $end: Time!, $todayStart: Time!, $scriptName: String!) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                rangeGroups: workersInvocationsAdaptive(
                  limit: 120
                  filter: { scriptName: $scriptName, datetime_geq: $start, datetime_leq: $end }
                ) {
                  sum { requests errors subrequests }
                  quantiles { cpuTimeP50 cpuTimeP99 }
                  dimensions { ${bucketDim} }
                }
                todayGroups: workersInvocationsAdaptive(
                  limit: 120
                  filter: { scriptName: $scriptName, datetime_geq: $todayStart, datetime_leq: $end }
                ) {
                  sum { requests }
                }
              }
            }
          }
        `;
        const res = await cfGraphQlFetch<WorkersGqlResult>(token, query, {
          accountTag: accountId,
          start: bounds.startIso,
          end: bounds.endIso,
          todayStart: bounds.todayStartIso,
          scriptName: workerName,
        });
        if (!res.ok) {
          out.warnings.push(`Workers 指标拉取失败：${res.error}`);
          return;
        }
        const acct = res.data?.viewer?.accounts?.[0];
        if (!acct) return;
        const rangeGroups = acct.rangeGroups ?? [];
        const todayGroups = acct.todayGroups ?? [];

        let requests = 0;
        let errors = 0;
        let subrequests = 0;
        let maxP50Us = 0;
        let maxP99Us = 0;
        const bucketMap = new Map<string, { requests: number; errors: number }>();

        for (const g of rangeGroups) {
          const req = Number(g.sum?.requests ?? 0);
          const err = Number(g.sum?.errors ?? 0);
          const sub = Number(g.sum?.subrequests ?? 0);
          requests += req;
          errors += err;
          subrequests += sub;
          maxP50Us = Math.max(maxP50Us, Number(g.quantiles?.cpuTimeP50 ?? 0));
          maxP99Us = Math.max(maxP99Us, Number(g.quantiles?.cpuTimeP99 ?? 0));
          const ts = g.dimensions?.date || g.dimensions?.datetimeHour || '';
          if (ts) {
            const existing = bucketMap.get(ts) ?? { requests: 0, errors: 0 };
            existing.requests += req;
            existing.errors += err;
            bucketMap.set(ts, existing);
          }
        }

        const todayRequests = todayGroups.reduce((s, g) => s + Number(g.sum?.requests ?? 0), 0);
        const series: CloudflareWorkerPoint[] = [...bucketMap.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([timestamp, vals]) => ({
            label: formatTimeBucketLabel(timestamp, isDaily),
            timestamp,
            requests: vals.requests,
            errors: vals.errors,
          }));

        out.workers = {
          available: true,
          requests,
          todayRequests,
          errors,
          subrequests,
          errorRatePct: requests > 0 ? Number(((errors / requests) * 100).toFixed(2)) : 0,
          cpuTimeP50Ms: Number((maxP50Us / 1000).toFixed(2)),
          cpuTimeP99Ms: Number((maxP99Us / 1000).toFixed(2)),
          series,
        };
      })(),
    );

    // B2: D1 analytics & storage
    tasks.push(
      (async () => {
        const query = `
          query D1Status($accountTag: String!, $start: Time!, $end: Time!, $todayStart: Time!${env.CF_D1_DATABASE_ID?.trim() ? ', $d1DatabaseId: String!' : ''}) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                rangeD1: d1AnalyticsAdaptiveGroups(
                  limit: 100
                  filter: { datetime_geq: $start, datetime_leq: $end${d1FilterExtra} }
                ) {
                  sum { readQueries writeQueries rowsRead rowsWritten }
                }
                todayD1: d1AnalyticsAdaptiveGroups(
                  limit: 100
                  filter: { datetime_geq: $todayStart, datetime_leq: $end${d1FilterExtra} }
                ) {
                  sum { rowsRead rowsWritten }
                }
                storageD1: d1StorageAdaptiveGroups(
                  limit: 20
                  filter: { datetime_geq: $start, datetime_leq: $end${d1FilterExtra} }
                ) {
                  max { databaseSizeBytes }
                }
              }
            }
          }
        `;
        const res = await cfGraphQlFetch<D1GqlResult>(token, query, {
          accountTag: accountId,
          start: bounds.startIso,
          end: bounds.endIso,
          todayStart: bounds.todayStartIso,
          ...(env.CF_D1_DATABASE_ID?.trim() ? { d1DatabaseId: env.CF_D1_DATABASE_ID.trim() } : {}),
        });
        if (!res.ok) {
          out.warnings.push(`D1 官方指标拉取失败：${res.error}`);
          return;
        }
        const acct = res.data?.viewer?.accounts?.[0];
        if (!acct) return;
        const rangeD1 = acct.rangeD1 ?? [];
        const todayD1 = acct.todayD1 ?? [];
        const storageD1 = acct.storageD1 ?? [];

        out.d1 = {
          available: true,
          readQueries: rangeD1.reduce((s, g) => s + Number(g.sum?.readQueries ?? 0), 0),
          writeQueries: rangeD1.reduce((s, g) => s + Number(g.sum?.writeQueries ?? 0), 0),
          rowsRead: rangeD1.reduce((s, g) => s + Number(g.sum?.rowsRead ?? 0), 0),
          rowsWritten: rangeD1.reduce((s, g) => s + Number(g.sum?.rowsWritten ?? 0), 0),
          todayRowsRead: todayD1.reduce((s, g) => s + Number(g.sum?.rowsRead ?? 0), 0),
          todayRowsWritten: todayD1.reduce((s, g) => s + Number(g.sum?.rowsWritten ?? 0), 0),
          storageBytes: storageD1.reduce(
            (maxBytes, g) => Math.max(maxBytes, Number(g.max?.databaseSizeBytes ?? 0)),
            0,
          ),
        };
      })(),
    );

    // B3: R2 monthly operations & storage
    tasks.push(
      (async () => {
        const query = `
          query R2Status($accountTag: String!, $monthStart: Time!, $start: Time!, $end: Time!${env.CF_R2_BUCKET_NAME?.trim() ? ', $r2BucketName: String!' : ''}) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                opsR2: r2OperationsAdaptiveGroups(
                  limit: 200
                  filter: { datetime_geq: $monthStart, datetime_leq: $end${r2FilterExtra} }
                ) {
                  sum { requests }
                  dimensions { actionType }
                }
                storageR2: r2StorageAdaptiveGroups(
                  limit: 20
                  filter: { datetime_geq: $start, datetime_leq: $end${r2FilterExtra} }
                ) {
                  max { objectCount payloadSize metadataSize }
                }
              }
            }
          }
        `;
        const res = await cfGraphQlFetch<R2GqlResult>(token, query, {
          accountTag: accountId,
          monthStart: bounds.monthStartIso,
          start: bounds.startIso,
          end: bounds.endIso,
          ...(env.CF_R2_BUCKET_NAME?.trim() ? { r2BucketName: env.CF_R2_BUCKET_NAME.trim() } : {}),
        });
        if (!res.ok) {
          out.warnings.push(`R2 官方指标拉取失败：${res.error}`);
          return;
        }
        const acct = res.data?.viewer?.accounts?.[0];
        if (!acct) return;

        let monthClassA = 0;
        let monthClassB = 0;
        for (const g of acct.opsR2 ?? []) {
          const count = Number(g.sum?.requests ?? 0);
          const action = g.dimensions?.actionType || '';
          if (R2_CLASS_A_ACTIONS.has(action)) {
            monthClassA += count;
          } else if (R2_CLASS_B_ACTIONS.has(action)) {
            monthClassB += count;
          }
        }

        let objectCount = 0;
        let payloadBytes = 0;
        let metadataBytes = 0;
        for (const g of acct.storageR2 ?? []) {
          objectCount = Math.max(objectCount, Number(g.max?.objectCount ?? 0));
          payloadBytes = Math.max(payloadBytes, Number(g.max?.payloadSize ?? 0));
          metadataBytes = Math.max(metadataBytes, Number(g.max?.metadataSize ?? 0));
        }

        out.r2 = {
          available: true,
          monthClassA,
          monthClassB,
          objectCount,
          payloadBytes,
          metadataBytes,
          totalStorageBytes: payloadBytes + metadataBytes,
        };
      })(),
    );

    // B4: Durable Objects invocations & storage
    tasks.push(
      (async () => {
        const query = `
          query DoStatus($accountTag: String!, $start: Time!, $end: Time!, $todayStart: Time!) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                rangeDo: durableObjectsInvocationsAdaptiveGroups(
                  limit: 100
                  filter: { datetime_geq: $start, datetime_leq: $end }
                ) {
                  sum { requests responseBodySize }
                }
                todayDo: durableObjectsInvocationsAdaptiveGroups(
                  limit: 100
                  filter: { datetime_geq: $todayStart, datetime_leq: $end }
                ) {
                  sum { requests }
                }
                storageDo: durableObjectsStorageGroups(
                  limit: 20
                  filter: { datetime_geq: $start, datetime_leq: $end }
                ) {
                  max { storedBytes }
                }
              }
            }
          }
        `;
        const res = await cfGraphQlFetch<DoGqlResult>(token, query, {
          accountTag: accountId,
          start: bounds.startIso,
          end: bounds.endIso,
          todayStart: bounds.todayStartIso,
        });
        if (!res.ok) {
          out.warnings.push(`Durable Objects 官方指标拉取失败：${res.error}`);
          return;
        }
        const acct = res.data?.viewer?.accounts?.[0];
        if (!acct) return;
        const rangeDo = acct.rangeDo ?? [];
        const todayDo = acct.todayDo ?? [];
        const storageDo = acct.storageDo ?? [];

        out.durableObjects = {
          available: true,
          requests: rangeDo.reduce((s, g) => s + Number(g.sum?.requests ?? 0), 0),
          todayRequests: todayDo.reduce((s, g) => s + Number(g.sum?.requests ?? 0), 0),
          responseBodyBytes: rangeDo.reduce((s, g) => s + Number(g.sum?.responseBodySize ?? 0), 0),
          storedBytes: storageDo.reduce(
            (maxBytes, g) => Math.max(maxBytes, Number(g.max?.storedBytes ?? 0)),
            0,
          ),
        };
      })(),
    );

    // B5: Latest Worker deployment
    tasks.push(
      (async () => {
        const depRes = await cfRestFetch<WorkerDeploymentsPayload>(
          token,
          `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
        );
        if (depRes.ok && depRes.result?.deployments?.length) {
          const latest = depRes.result.deployments[0];
          if (latest?.id) {
            out.latestDeployment = {
              id: latest.id,
              createdOn: latest.created_on || '',
              source: latest.source || 'wrangler',
            };
          }
        }
      })(),
    );
  }

  // Task C: Zone HTTP traffic analytics
  if (scope.zoneId) {
    const zoneId = scope.zoneId;
    tasks.push(
      (async () => {
        const query = isDaily
          ? `
            query ZoneTrafficDaily($zoneTag: String!, $startDate: Date!, $endDate: Date!) {
              viewer {
                zones(filter: { zoneTag: $zoneTag }) {
                  groups: httpRequests1dGroups(
                    limit: 14
                    orderBy: [date_ASC]
                    filter: { date_geq: $startDate, date_leq: $endDate }
                  ) {
                    dimensions { date }
                    sum { requests cachedRequests bytes cachedBytes encryptedRequests threats }
                  }
                }
              }
            }
          `
          : `
            query ZoneTrafficHourly($zoneTag: String!, $start: Time!, $end: Time!) {
              viewer {
                zones(filter: { zoneTag: $zoneTag }) {
                  groups: httpRequests1hGroups(
                    limit: 36
                    orderBy: [datetime_ASC]
                    filter: { datetime_geq: $start, datetime_leq: $end }
                  ) {
                    dimensions { datetime }
                    sum { requests cachedRequests bytes cachedBytes encryptedRequests threats }
                  }
                }
              }
            }
          `;

        const res = await cfGraphQlFetch<ZoneHttpGqlResult>(
          token,
          query,
          isDaily
            ? { zoneTag: zoneId, startDate: bounds.startDate, endDate: bounds.endDate }
            : { zoneTag: zoneId, start: bounds.startIso, end: bounds.endIso },
        );
        if (!res.ok) {
          out.warnings.push(`域名流量分析拉取失败：${res.error}`);
          return;
        }
        const groups = res.data?.viewer?.zones?.[0]?.groups ?? [];
        let requests = 0;
        let cachedRequests = 0;
        let bytes = 0;
        let cachedBytes = 0;
        let encryptedRequests = 0;
        let threats = 0;
        const series: CloudflareTrafficPoint[] = [];

        for (const g of groups) {
          const req = Number(g.sum?.requests ?? 0);
          const cachedReq = Number(g.sum?.cachedRequests ?? 0);
          const b = Number(g.sum?.bytes ?? 0);
          const cb = Number(g.sum?.cachedBytes ?? 0);
          const enc = Number(g.sum?.encryptedRequests ?? 0);
          const thr = Number(g.sum?.threats ?? 0);
          requests += req;
          cachedRequests += cachedReq;
          bytes += b;
          cachedBytes += cb;
          encryptedRequests += enc;
          threats += thr;
          const ts = g.dimensions?.date || g.dimensions?.datetime || '';
          if (ts) {
            series.push({
              label: formatTimeBucketLabel(ts, isDaily),
              timestamp: ts,
              requests: req,
              cachedRequests: cachedReq,
              bytes: b,
              threats: thr,
            });
          }
        }

        out.zoneTraffic = {
          available: true,
          requests,
          cachedRequests,
          cacheHitRatePct: requests > 0 ? Number(((cachedRequests / requests) * 100).toFixed(1)) : 0,
          bytes,
          cachedBytes,
          encryptedRequests,
          httpsRatePct: requests > 0 ? Number(((encryptedRequests / requests) * 100).toFixed(1)) : 0,
          threats,
          series,
        };
      })(),
    );
  }

  await Promise.allSettled(tasks);

  accountAnalyticsCache.set(scopeFingerprint, { value: out, storedAt: nowMs });
  return out;
}

function computeOverallHealth(
  runtime: CloudflareRuntimeProbe,
  globalStatus: CloudflareGlobalStatus | null,
  account: CloudflareAccountAnalytics | null,
): CloudflareHealthLevel {
  if (!runtime.d1.ok || !runtime.r2.ok) {
    return 'down';
  }
  if (!runtime.durableObject.ok) {
    return 'degraded';
  }
  if (globalStatus?.indicator === 'critical' || globalStatus?.indicator === 'major') {
    return 'degraded';
  }
  if (globalStatus?.indicator === 'minor') {
    return 'degraded';
  }
  if (account?.workers.available && account.workers.errorRatePct >= 5) {
    return 'degraded';
  }
  return 'healthy';
}

cloudflareRoutes.use('*', async (c, next) => {
  requireCloudAdmin(c.get('cloudCtx'));
  await next();
});

cloudflareRoutes.get('/status', async (c) => {
  const mode = c.req.query('mode') === 'lite' ? 'lite' : 'full';
  const range = parseRange(c.req.query('range'));
  const force = c.req.query('force') === '1' || c.req.query('force') === 'true';
  const host = new URL(c.req.url).host;

  if (mode === 'lite') {
    const runtime = await runRuntimeProbe(c.req.raw, c.env);
    const snapshot: CloudflareStatusSnapshot = {
      overall: computeOverallHealth(runtime, null, null),
      generatedAt: new Date().toISOString(),
      mode: 'lite',
      range,
      runtime,
      globalStatus: null,
      account: null,
    };
    return c.json(snapshot);
  }

  const [runtime, globalStatus, account] = await Promise.all([
    runRuntimeProbe(c.req.raw, c.env),
    fetchGlobalStatus(force),
    fetchAccountAnalytics(c.env, host, range, force),
  ]);

  const snapshot: CloudflareStatusSnapshot = {
    overall: computeOverallHealth(runtime, globalStatus, account),
    generatedAt: new Date().toISOString(),
    mode: 'full',
    range,
    runtime,
    globalStatus,
    account,
  };

  return c.json(snapshot);
});

cloudflareRoutes.post('/ops', async (c) => {
  const token = c.env.CF_API_TOKEN?.trim() || '';
  if (!token) {
    throw new ApiError('尚未配置 CF_API_TOKEN，无法执行 Cloudflare 远程运维操作', 503);
  }

  const body = object(await c.req.json().catch(() => null));
  const action = body.action;
  if (action !== 'purge_cache' && action !== 'security_level' && action !== 'development_mode') {
    throw new ApiError('不支持的 Cloudflare 运维操作类型', 400);
  }

  let validatedReq: CloudflareOpsActionRequest;
  if (action === 'purge_cache') {
    validatedReq = { action: 'purge_cache' };
  } else if (action === 'security_level') {
    if (
      typeof body.value !== 'string' ||
      !VALID_SECURITY_LEVELS.has(body.value as CloudflareZoneSecurityLevel)
    ) {
      throw new ApiError('无效的安全防护级别参数', 400);
    }
    validatedReq = {
      action: 'security_level',
      value: body.value as CloudflareZoneSecurityLevel,
    };
  } else {
    if (typeof body.enabled !== 'boolean') {
      throw new ApiError('开发模式开关必须为布尔值', 400);
    }
    validatedReq = { action: 'development_mode', enabled: body.enabled };
  }

  const host = new URL(c.req.url).host;
  const scope = await resolveCloudflareScope(token, c.env, host);
  if (!scope.zoneId) {
    throw new ApiError('未能识别站点对应的 Cloudflare Zone ID，请检查 Token 权限或配置 CF_ZONE_ID', 503);
  }

  const ctx = c.get('cloudCtx');
  let message = '';

  if (validatedReq.action === 'purge_cache') {
    const res = await cfRestFetch<{ id?: string }>(
      token,
      `/zones/${encodeURIComponent(scope.zoneId)}/purge_cache`,
      {
        method: 'POST',
        body: JSON.stringify({ purge_everything: true }),
      },
    );
    if (!res.ok) {
      throw new ApiError(`清理 Cloudflare 缓存失败：${res.error || '权限不足或接口异常'}`, res.status === 403 ? 403 : 502);
    }
    noteSecurityEvent(ctx, 'policy', `Cloudflare 运维：清理整站缓存 (${scope.zoneName || scope.zoneId})`);
    message = `已提交整站缓存清理任务（${scope.zoneName || scope.zoneId}），全球边缘节点将在约 30 秒内生效。`;
  } else if (validatedReq.action === 'security_level') {
    const res = await cfRestFetch<{ value?: string }>(
      token,
      `/zones/${encodeURIComponent(scope.zoneId)}/settings/security_level`,
      {
        method: 'PATCH',
        body: JSON.stringify({ value: validatedReq.value }),
      },
    );
    if (!res.ok) {
      throw new ApiError(`更新安全防护级别失败：${res.error || '权限不足或接口异常'}`, res.status === 403 ? 403 : 502);
    }
    noteSecurityEvent(
      ctx,
      'policy',
      `Cloudflare 运维：安全级别切换为 ${validatedReq.value} (${scope.zoneName || scope.zoneId})`,
    );
    message =
      validatedReq.value === 'under_attack'
        ? '已开启 Under Attack 防护模式，所有访客将先经过 Cloudflare 质询校验。'
        : `已将 Cloudflare 安全防护级别恢复为 ${validatedReq.value}。`;
  } else {
    const targetValue = validatedReq.enabled ? 'on' : 'off';
    const res = await cfRestFetch<{ value?: string }>(
      token,
      `/zones/${encodeURIComponent(scope.zoneId)}/settings/development_mode`,
      {
        method: 'PATCH',
        body: JSON.stringify({ value: targetValue }),
      },
    );
    if (!res.ok) {
      throw new ApiError(`切换开发模式失败：${res.error || '权限不足或接口异常'}`, res.status === 403 ? 403 : 502);
    }
    noteSecurityEvent(
      ctx,
      'policy',
      `Cloudflare 运维：${validatedReq.enabled ? '开启' : '关闭'}开发模式 (${scope.zoneName || scope.zoneId})`,
    );
    message = validatedReq.enabled
      ? '已开启 Cloudflare 开发模式（边缘缓存将临时绕过，3 小时后自动关闭）。'
      : '已关闭 Cloudflare 开发模式，边缘缓存策略恢复正常。';
  }

  // Invalidate cached analytics/controls so subsequent polls reflect the live change immediately
  accountAnalyticsCache.clear();
  const { controls } = await fetchZoneControls(token, scope);

  const response: CloudflareOpsActionResponse = {
    ok: true,
    action: validatedReq.action,
    message,
    executedAt: new Date().toISOString(),
    zoneControls: controls,
  };
  return c.json(response);
});
