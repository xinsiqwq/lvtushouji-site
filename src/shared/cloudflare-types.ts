export type CloudflareTimeRange = 'today' | '24h' | '7d';
export type CloudflarePlanTier = 'free' | 'paid';
export type CloudflareHealthLevel = 'healthy' | 'degraded' | 'down';
export type CloudflareZoneSecurityLevel =
  | 'off'
  | 'essentially_off'
  | 'low'
  | 'medium'
  | 'high'
  | 'under_attack';

export const CLOUDFLARE_PLAN_LIMITS = {
  free: {
    label: 'Cloudflare Free 免费套餐',
    workersRequests: 100_000,
    workersRequestsPeriod: 'day' as const,
    d1RowsRead: 5_000_000,
    d1RowsReadPeriod: 'day' as const,
    d1RowsWritten: 100_000,
    d1RowsWrittenPeriod: 'day' as const,
    d1StorageBytes: 5 * 1024 ** 3,
    r2StorageBytes: 10 * 1024 ** 3,
    r2ClassA: 1_000_000,
    r2ClassAPeriod: 'month' as const,
    r2ClassB: 10_000_000,
    r2ClassBPeriod: 'month' as const,
    doRequests: 100_000,
    doRequestsPeriod: 'day' as const,
    doStorageBytes: 5 * 1024 ** 3,
  },
  paid: {
    label: 'Workers Paid ($5/月)',
    workersRequests: 10_000_000,
    workersRequestsPeriod: 'month' as const,
    d1RowsRead: 25_000_000_000,
    d1RowsReadPeriod: 'month' as const,
    d1RowsWritten: 50_000_000,
    d1RowsWrittenPeriod: 'month' as const,
    d1StorageBytes: 5 * 1024 ** 3,
    r2StorageBytes: 10 * 1024 ** 3,
    r2ClassA: 1_000_000,
    r2ClassAPeriod: 'month' as const,
    r2ClassB: 10_000_000,
    r2ClassBPeriod: 'month' as const,
    doRequests: 1_000_000,
    doRequestsPeriod: 'month' as const,
    doStorageBytes: 5 * 1024 ** 3,
  },
} as const;

export type CloudflareBindingProbe = {
  ok: boolean;
  latencyMs: number;
  detail: string;
  error?: string;
};

export type CloudflareEdgeInfo = {
  environment: 'production' | 'local-dev';
  host: string;
  colo: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  asn: number | null;
  asOrganization: string | null;
  httpProtocol: string | null;
  tlsVersion: string | null;
  tlsCipher: string | null;
  clientTcpRttMs: number | null;
};

export type CloudflareRuntimeProbe = {
  probedAt: string;
  workerResponseMs: number;
  edge: CloudflareEdgeInfo;
  d1: CloudflareBindingProbe & {
    databaseBytes: number;
    tables: {
      journeys: number;
      media: number;
      vaultFiles: number;
      projects: number;
      arenaLobbies: number;
      arenaMatches: number;
      securityEvents: number;
    };
  };
  r2: CloudflareBindingProbe;
  durableObject: CloudflareBindingProbe & {
    activeLobbies: number;
    activeHumans: number;
  };
  appBudget: {
    month: string;
    apiRequests: number;
    apiRequestsCap: number;
    uploadBytes: number;
    uploadBytesCap: number;
    r2ClassA: number;
    r2ClassACap: number;
    r2ClassB: number;
    r2ClassBCap: number;
  };
};

export type CloudflareGlobalComponent = {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
};

export type CloudflareGlobalIncident = {
  id: string;
  name: string;
  status: string;
  impact: string;
  shortlink: string;
  updatedAt: string;
};

export type CloudflareGlobalStatus = {
  status: 'ok' | 'unavailable';
  fetchedAt: string;
  cached: boolean;
  cacheAgeSec: number;
  indicator: 'none' | 'minor' | 'major' | 'critical' | 'unknown';
  description: string;
  pageUrl: string;
  components: CloudflareGlobalComponent[];
  degradedCount: number;
  incidents: CloudflareGlobalIncident[];
  maintenances: CloudflareGlobalIncident[];
  error?: string;
};

export type CloudflareTrafficPoint = {
  label: string;
  timestamp: string;
  requests: number;
  cachedRequests: number;
  bytes: number;
  threats: number;
};

export type CloudflareWorkerPoint = {
  label: string;
  timestamp: string;
  requests: number;
  errors: number;
};

export type CloudflareZoneControls = {
  zoneId: string;
  zoneName: string;
  zoneStatus: string;
  planName: string;
  paused: boolean;
  securityLevel: CloudflareZoneSecurityLevel | null;
  developmentMode: {
    enabled: boolean;
    timeRemainingSec: number;
  } | null;
  canManageZone: boolean;
  opsNote?: string;
};

export type CloudflarePermissionSpec = {
  scope: string;
  access: 'Read' | 'Edit' | 'Purge';
  purpose: string;
  requiredFor: 'monitoring' | 'ops';
};

export const CLOUDFLARE_REQUIRED_PERMISSIONS: CloudflarePermissionSpec[] = [
  { scope: 'Account · Account Analytics', access: 'Read', purpose: 'Workers / D1 / R2 / Durable Objects 真实用量与指标', requiredFor: 'monitoring' },
  { scope: 'Account · Workers Scripts', access: 'Read', purpose: '读取最新 Worker 部署版本信息', requiredFor: 'monitoring' },
  { scope: 'Account · Account Settings', access: 'Read', purpose: '未手填 Account ID 时自动识别账户', requiredFor: 'monitoring' },
  { scope: 'Zone · Zone', access: 'Read', purpose: '自动识别站点域名 Zone 与套餐状态', requiredFor: 'monitoring' },
  { scope: 'Zone · Analytics', access: 'Read', purpose: '读取域名流量、缓存命中率与安全拦截趋势', requiredFor: 'monitoring' },
  { scope: 'Zone · Zone Settings', access: 'Edit', purpose: '查看与切换 Under Attack 防护模式和开发模式', requiredFor: 'ops' },
  { scope: 'Zone · Cache Purge', access: 'Purge', purpose: '执行一键清理整站边缘缓存', requiredFor: 'ops' },
];

export type CloudflareAccountAnalytics = {
  configured: boolean;
  fetchedAt: string;
  cached: boolean;
  cacheAgeSec: number;
  range: CloudflareTimeRange;
  accountId: string | null;
  accountName: string | null;
  workerName: string;
  dashboardUrl: string | null;
  latestDeployment: {
    id: string;
    createdOn: string;
    source: string;
  } | null;
  workers: {
    available: boolean;
    requests: number;
    todayRequests: number;
    errors: number;
    subrequests: number;
    errorRatePct: number;
    cpuTimeP50Ms: number;
    cpuTimeP99Ms: number;
    series: CloudflareWorkerPoint[];
  };
  d1: {
    available: boolean;
    readQueries: number;
    writeQueries: number;
    rowsRead: number;
    rowsWritten: number;
    todayRowsRead: number;
    todayRowsWritten: number;
    storageBytes: number;
  };
  r2: {
    available: boolean;
    monthClassA: number;
    monthClassB: number;
    objectCount: number;
    payloadBytes: number;
    metadataBytes: number;
    totalStorageBytes: number;
  };
  durableObjects: {
    available: boolean;
    requests: number;
    todayRequests: number;
    responseBodyBytes: number;
    storedBytes: number;
  };
  zoneTraffic: {
    available: boolean;
    requests: number;
    cachedRequests: number;
    cacheHitRatePct: number;
    bytes: number;
    cachedBytes: number;
    encryptedRequests: number;
    httpsRatePct: number;
    threats: number;
    series: CloudflareTrafficPoint[];
  };
  zoneControls: CloudflareZoneControls | null;
  warnings: string[];
  permissionsGuide: CloudflarePermissionSpec[];
};

export type CloudflareStatusSnapshot = {
  overall: CloudflareHealthLevel;
  generatedAt: string;
  mode: 'lite' | 'full';
  range: CloudflareTimeRange;
  runtime: CloudflareRuntimeProbe;
  globalStatus: CloudflareGlobalStatus | null;
  account: CloudflareAccountAnalytics | null;
};

export type CloudflareOpsActionRequest =
  | { action: 'purge_cache' }
  | { action: 'security_level'; value: CloudflareZoneSecurityLevel }
  | { action: 'development_mode'; enabled: boolean };

export type CloudflareOpsActionResponse = {
  ok: true;
  action: CloudflareOpsActionRequest['action'];
  message: string;
  executedAt: string;
  zoneControls: CloudflareZoneControls | null;
};
