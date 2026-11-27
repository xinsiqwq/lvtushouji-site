import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/server/index';
import { clearCloudflareStatusCache } from '../../src/server/routes/cloudflare';
import type { AppBindings } from '../../src/server/types';
import type {
  CloudflareOpsActionResponse,
  CloudflareStatusSnapshot,
} from '../../src/shared/cloudflare-types';
import { resetTestDatabase } from './test-db';

async function setupAdminSession() {
  const res = await SELF.fetch('http://127.0.0.1:5173/api/security/auth', {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:5173',
      'content-type': 'application/json',
      'x-travel-setup-token': (env as unknown as AppBindings).SETUP_TOKEN!,
    },
    body: JSON.stringify({ action: 'setup', password: 'cf-status-test-password-123' }),
  });
  expect(res.status).toBe(200);
  const cookies = res.headers
    .getSetCookie()
    .filter((c: string) => !c.includes('Max-Age=0'))
    .map((c: string) => c.split(';')[0])
    .join('; ');
  const json = (await res.json()) as { csrfToken: string };
  return { cookies, csrfToken: json.csrfToken };
}

function buildMockCloudflareFetch(options?: {
  securityLevel?: string;
  devMode?: 'on' | 'off';
  failD1GraphQl?: boolean;
}) {
  let securityLevel = options?.securityLevel ?? 'medium';
  let devMode: 'on' | 'off' = options?.devMode ?? 'off';
  let gqlCalls = 0;
  let purgeCalls = 0;

  const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();

    if (url.includes('cloudflarestatus.com/api/v2/summary.json')) {
      return Response.json({
        page: { url: 'https://www.cloudflarestatus.com' },
        status: { indicator: 'none', description: 'All Systems Operational' },
        components: [
          { id: 'c1', name: 'Cloudflare Workers', status: 'operational', updated_at: '2026-11-27T07:00:00Z' },
          { id: 'c2', name: 'D1', status: 'operational', updated_at: '2026-11-27T07:00:00Z' },
          { id: 'c3', name: 'R2', status: 'operational', updated_at: '2026-11-27T07:00:00Z' },
          { id: 'c4', name: 'Durable Objects', status: 'operational', updated_at: '2026-11-27T07:00:00Z' },
          { id: 'c5', name: 'Unrelated Group', group: true, status: 'operational' },
        ],
        incidents: [],
        scheduled_maintenances: [],
      });
    }

    if (url.includes('/client/v4/zones?') || url.endsWith('/client/v4/zones')) {
      return Response.json({
        success: true,
        result: [
          {
            id: 'zone_test_123',
            name: 'example-site.test',
            status: 'active',
            paused: false,
            account: { id: 'acct_test_456', name: 'Test CF Account' },
            plan: { name: 'Free Website' },
          },
        ],
      });
    }

    if (url.includes('/zones/zone_test_123/settings/security_level')) {
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as { value?: string };
        securityLevel = body.value || securityLevel;
      }
      return Response.json({
        success: true,
        result: { id: 'security_level', value: securityLevel },
      });
    }

    if (url.includes('/zones/zone_test_123/settings/development_mode')) {
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as { value?: 'on' | 'off' };
        devMode = body.value || devMode;
      }
      return Response.json({
        success: true,
        result: {
          id: 'development_mode',
          value: devMode,
          time_remaining: devMode === 'on' ? 10800 : 0,
        },
      });
    }

    if (url.includes('/zones/zone_test_123/purge_cache') && method === 'POST') {
      purgeCalls += 1;
      return Response.json({ success: true, result: { id: 'zone_test_123' } });
    }

    if (url.includes('/workers/scripts/') && url.includes('/deployments')) {
      return Response.json({
        success: true,
        result: {
          deployments: [
            { id: 'dep_abc123456789', created_on: '2026-11-27T06:30:00Z', source: 'wrangler' },
          ],
        },
      });
    }

    if (url.includes('/client/v4/graphql') && method === 'POST') {
      gqlCalls += 1;
      const payload = JSON.parse(String(init?.body || '{}')) as { query?: string };
      const q = payload.query || '';

      if (q.includes('WorkersStatus')) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  rangeGroups: [
                    {
                      sum: { requests: 1200, errors: 6, subrequests: 420 },
                      quantiles: { cpuTimeP50: 1450, cpuTimeP99: 7800 },
                      dimensions: { datetimeHour: '2026-11-27T06:00:00Z' },
                    },
                  ],
                  todayGroups: [{ sum: { requests: 1200 } }],
                },
              ],
            },
          },
        });
      }

      if (q.includes('D1Status')) {
        if (options?.failD1GraphQl) {
          return Response.json({ errors: [{ message: 'D1 analytics permission denied' }] }, { status: 403 });
        }
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  rangeD1: [{ sum: { readQueries: 800, writeQueries: 120, rowsRead: 42000, rowsWritten: 950 } }],
                  todayD1: [{ sum: { rowsRead: 42000, rowsWritten: 950 } }],
                  storageD1: [{ max: { databaseSizeBytes: 524288 } }],
                },
              ],
            },
          },
        });
      }

      if (q.includes('R2Status')) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  opsR2: [
                    { sum: { requests: 35 }, dimensions: { actionType: 'PutObject' } },
                    { sum: { requests: 15 }, dimensions: { actionType: 'ListObjects' } },
                    { sum: { requests: 410 }, dimensions: { actionType: 'GetObject' } },
                    { sum: { requests: 90 }, dimensions: { actionType: 'HeadObject' } },
                    { sum: { requests: 12 }, dimensions: { actionType: 'DeleteObject' } },
                  ],
                  storageR2: [
                    { max: { objectCount: 64, payloadSize: 10485760, metadataSize: 40960 } },
                  ],
                },
              ],
            },
          },
        });
      }

      if (q.includes('DoStatus')) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  rangeDo: [{ sum: { requests: 320, responseBodySize: 65536 } }],
                  todayDo: [{ sum: { requests: 320 } }],
                  storageDo: [{ max: { storedBytes: 131072 } }],
                },
              ],
            },
          },
        });
      }

      if (q.includes('ZoneTraffic')) {
        return Response.json({
          data: {
            viewer: {
              zones: [
                {
                  groups: [
                    {
                      dimensions: { datetime: '2026-11-27T05:00:00Z' },
                      sum: {
                        requests: 500,
                        cachedRequests: 400,
                        bytes: 5000000,
                        cachedBytes: 4200000,
                        encryptedRequests: 500,
                        threats: 3,
                      },
                    },
                    {
                      dimensions: { datetime: '2026-11-27T06:00:00Z' },
                      sum: {
                        requests: 700,
                        cachedRequests: 560,
                        bytes: 7000000,
                        cachedBytes: 5800000,
                        encryptedRequests: 693,
                        threats: 4,
                      },
                    },
                  ],
                },
              ],
            },
          },
        });
      }
    }

    return Response.json({ error: `Unhandled mock URL: ${url}` }, { status: 404 });
  });

  return {
    mockFetch,
    getStats: () => ({ gqlCalls, purgeCalls, securityLevel, devMode }),
  };
}

describe('Admin Cloudflare real-time status & ops API', () => {
  beforeEach(async () => {
    clearCloudflareStatusCache();
    await resetTestDatabase(env.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCloudflareStatusCache();
  });

  it('guards status and ops endpoints with 401/403', async () => {
    const unauthStatus = await SELF.fetch('http://127.0.0.1:5173/api/admin/cloudflare/status');
    expect(unauthStatus.status).toBe(401);

    const unauthOps = await SELF.fetch('http://127.0.0.1:5173/api/admin/cloudflare/ops', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'purge_cache' }),
    });
    expect(unauthOps.status).toBe(401);

    const auth = await setupAdminSession();
    const missingCsrf = await SELF.fetch('http://127.0.0.1:5173/api/admin/cloudflare/ops', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        cookie: auth.cookies,
      },
      body: JSON.stringify({ action: 'purge_cache' }),
    });
    expect(missingCsrf.status).toBe(403);
  });

  it('probes D1, R2, and Arena DO in lite mode without polluting security_events or R2 user budget', async () => {
    const auth = await setupAdminSession();
    const beforeEvents = await env.DB.prepare('SELECT count(*) AS cnt FROM security_events').first<{
      cnt: number;
    }>();

    const res = await SELF.fetch('http://127.0.0.1:5173/api/admin/cloudflare/status?mode=lite&poll=1', {
      headers: { cookie: auth.cookies },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as CloudflareStatusSnapshot;
    expect(body.mode).toBe('lite');
    expect(body.overall).toBe('healthy');
    expect(body.runtime.edge.environment).toBe('local-dev');
    expect(body.runtime.d1.ok).toBe(true);
    expect(body.runtime.r2.ok).toBe(true);
    expect(body.runtime.durableObject.ok).toBe(true);
    expect(body.globalStatus).toBeNull();
    expect(body.account).toBeNull();

    // Passive poll must NOT add security_events rows
    const afterEvents = await env.DB.prepare('SELECT count(*) AS cnt FROM security_events').first<{
      cnt: number;
    }>();
    expect(afterEvents?.cnt).toBe(beforeEvents?.cnt);

    // Raw R2 health probe must NOT inflate r2-class-b user budget counter
    const r2Counter = await env.DB.prepare(
      "SELECT value FROM usage_limits WHERE key LIKE 'r2-class-b:%'",
    ).first<{ value: number }>();
    expect(r2Counter).toBeNull();
  });

  it('degrades gracefully without CF_API_TOKEN while returning global status and permission guide', async () => {
    const auth = await setupAdminSession();
    const { mockFetch } = buildMockCloudflareFetch();
    vi.stubGlobal('fetch', mockFetch);

    const baseEnv = env as unknown as AppBindings;
    const res = await app.fetch(
      new Request('http://127.0.0.1:5173/api/admin/cloudflare/status?range=today', {
        headers: { cookie: auth.cookies },
      }),
      { ...baseEnv, CF_API_TOKEN: '' },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as CloudflareStatusSnapshot;
    expect(body.overall).toBe('healthy');
    expect(body.globalStatus?.status).toBe('ok');
    expect(body.globalStatus?.components.length).toBe(4);
    expect(body.account?.configured).toBe(false);
    expect(body.account?.permissionsGuide.length).toBeGreaterThanOrEqual(5);

    // Ops without token returns 503
    const opsRes = await app.fetch(
      new Request('http://127.0.0.1:5173/api/admin/cloudflare/ops', {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'content-type': 'application/json',
          'x-travel-csrf': auth.csrfToken,
          cookie: auth.cookies,
        },
        body: JSON.stringify({ action: 'purge_cache' }),
      }),
      { ...baseEnv, CF_API_TOKEN: '' },
    );
    expect(opsRes.status).toBe(503);
  });

  it('aggregates official Cloudflare GraphQL analytics, caches for 60s, and tolerates partial GraphQL failures', async () => {
    const auth = await setupAdminSession();
    const { mockFetch, getStats } = buildMockCloudflareFetch({ failD1GraphQl: true });
    vi.stubGlobal('fetch', mockFetch);

    const cfEnv: AppBindings = {
      ...(env as unknown as AppBindings),
      CF_API_TOKEN: 'cf-test-token-1234567890abcdef',
    };

    const res1 = await app.fetch(
      new Request('http://127.0.0.1:5173/api/admin/cloudflare/status?range=24h', {
        headers: { cookie: auth.cookies },
      }),
      cfEnv,
    );
    expect(res1.status).toBe(200);
    const snap1 = (await res1.json()) as CloudflareStatusSnapshot;

    expect(snap1.account?.configured).toBe(true);
    expect(snap1.account?.cached).toBe(false);
    expect(snap1.account?.accountId).toBe('acct_test_456');
    expect(snap1.account?.zoneControls?.zoneId).toBe('zone_test_123');
    expect(snap1.account?.workers.available).toBe(true);
    expect(snap1.account?.workers.requests).toBe(1200);
    expect(snap1.account?.workers.errorRatePct).toBe(0.5);
    expect(snap1.account?.workers.cpuTimeP50Ms).toBe(1.45);
    expect(snap1.account?.r2.available).toBe(true);
    expect(snap1.account?.r2.monthClassA).toBe(50); // 35 PutObject + 15 ListObjects
    expect(snap1.account?.r2.monthClassB).toBe(500); // 410 GetObject + 90 HeadObject
    expect(snap1.account?.r2.objectCount).toBe(64);
    expect(snap1.account?.durableObjects.requests).toBe(320);
    expect(snap1.account?.zoneTraffic.requests).toBe(1200);
    expect(snap1.account?.zoneTraffic.cacheHitRatePct).toBe(80);
    expect(snap1.account?.zoneTraffic.threats).toBe(7);
    expect(snap1.account?.latestDeployment?.id).toBe('dep_abc123456789');

    // Partial failure in D1 GraphQL produces a warning without failing other metrics
    expect(snap1.account?.d1.available).toBe(false);
    expect(snap1.account?.warnings.some((w) => w.includes('D1'))).toBe(true);

    const callsAfterFirst = getStats().gqlCalls;

    // Second request without force uses 60s server cache
    const res2 = await app.fetch(
      new Request('http://127.0.0.1:5173/api/admin/cloudflare/status?range=24h', {
        headers: { cookie: auth.cookies },
      }),
      cfEnv,
    );
    const snap2 = (await res2.json()) as CloudflareStatusSnapshot;
    expect(snap2.account?.cached).toBe(true);
    expect(getStats().gqlCalls).toBe(callsAfterFirst);

    // force=1 bypasses cache
    const res3 = await app.fetch(
      new Request('http://127.0.0.1:5173/api/admin/cloudflare/status?range=24h&force=1', {
        headers: { cookie: auth.cookies },
      }),
      cfEnv,
    );
    const snap3 = (await res3.json()) as CloudflareStatusSnapshot;
    expect(snap3.account?.cached).toBe(false);
    expect(getStats().gqlCalls).toBeGreaterThan(callsAfterFirst);
  });

  it('executes ops mutations (purge_cache, under_attack, dev_mode), invalidates cache, and writes audit logs', async () => {
    const auth = await setupAdminSession();
    const { mockFetch, getStats } = buildMockCloudflareFetch();
    vi.stubGlobal('fetch', mockFetch);

    const cfEnv: AppBindings = {
      ...(env as unknown as AppBindings),
      CF_API_TOKEN: 'cf-test-token-1234567890abcdef',
    };

    const postOps = (body: unknown) =>
      app.fetch(
        new Request('http://127.0.0.1:5173/api/admin/cloudflare/ops', {
          method: 'POST',
          headers: {
            origin: 'http://127.0.0.1:5173',
            'content-type': 'application/json',
            'x-travel-csrf': auth.csrfToken,
            cookie: auth.cookies,
          },
          body: JSON.stringify(body),
        }),
        cfEnv,
      );

    // Invalid payloads rejected with 400
    expect((await postOps({ action: 'unknown' })).status).toBe(400);
    expect((await postOps({ action: 'security_level', value: 'invalid' })).status).toBe(400);
    expect((await postOps({ action: 'development_mode', enabled: 'yes' })).status).toBe(400);

    // 1. Toggle Under Attack mode
    const secRes = await postOps({ action: 'security_level', value: 'under_attack' });
    expect(secRes.status).toBe(200);
    const secJson = (await secRes.json()) as CloudflareOpsActionResponse;
    expect(secJson.ok).toBe(true);
    expect(secJson.zoneControls?.securityLevel).toBe('under_attack');
    expect(getStats().securityLevel).toBe('under_attack');

    // 2. Toggle Development Mode ON
    const devRes = await postOps({ action: 'development_mode', enabled: true });
    expect(devRes.status).toBe(200);
    const devJson = (await devRes.json()) as CloudflareOpsActionResponse;
    expect(devJson.zoneControls?.developmentMode?.enabled).toBe(true);
    expect(devJson.zoneControls?.developmentMode?.timeRemainingSec).toBe(10800);

    // 3. Purge Everything
    const purgeRes = await postOps({ action: 'purge_cache' });
    expect(purgeRes.status).toBe(200);
    expect(getStats().purgeCalls).toBe(1);

    // Verify all 3 ops were recorded in security_events as 'policy' audit logs
    const policyEvents = await env.DB.prepare(
      "SELECT data FROM security_events WHERE kind = 'policy' ORDER BY at DESC",
    ).all<{ data: string }>();
    const reasonsText = policyEvents.results
      .map((r) => (JSON.parse(r.data) as { reasons: string[] }).reasons.join(' '))
      .join('\n');
    expect(reasonsText).toContain('安全级别切换为 under_attack');
    expect(reasonsText).toContain('开启开发模式');
    expect(reasonsText).toContain('清理整站缓存');
  });
});
