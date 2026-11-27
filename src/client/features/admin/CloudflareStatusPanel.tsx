import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  Flame,
  Globe,
  HardDrive,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  CLOUDFLARE_PLAN_LIMITS,
  type CloudflareHealthLevel,
  type CloudflareOpsActionRequest,
  type CloudflareOpsActionResponse,
  type CloudflarePlanTier,
  type CloudflareStatusSnapshot,
  type CloudflareTimeRange,
  type CloudflareZoneSecurityLevel,
} from '../../../shared/cloudflare-types';
import { apiJson } from '../../lib/api';

type CloudflareStatusPanelProps = {
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
  onSnapshotChange?: (snapshot: CloudflareStatusSnapshot) => void;
};

type PollIntervalSec = 0 | 5 | 15 | 30;

type LatencySample = {
  at: string;
  workerMs: number;
  d1Ms: number;
  r2Ms: number;
  doMs: number;
};

type PendingConfirmAction = {
  request: CloudflareOpsActionRequest;
  title: string;
  description: string;
  impact: string;
  confirmLabel: string;
  destructive?: boolean;
};

const MAX_LATENCY_SAMPLES = 20;

const SECURITY_LEVEL_LABELS: Record<CloudflareZoneSecurityLevel, string> = {
  off: '关闭 (Off)',
  essentially_off: '极低 (Essentially Off)',
  low: '低 (Low)',
  medium: '常规 (Medium)',
  high: '高 (High)',
  under_attack: 'Under Attack 防护中',
};

const COMPONENT_STATUS_LABELS: Record<string, { label: string; tone: 'ok' | 'warn' | 'err' }> = {
  operational: { label: '正常', tone: 'ok' },
  degraded_performance: { label: '性能降级', tone: 'warn' },
  partial_outage: { label: '局部中断', tone: 'warn' },
  major_outage: { label: '重大故障', tone: 'err' },
  under_maintenance: { label: '维护中', tone: 'warn' },
};

let lastCopyAnnouncement = '';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** idx;
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[idx]}`;
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString('en-US');
}

function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19) || '--:--:--';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDurationMinutes(seconds: number): string {
  if (seconds <= 0) return '0 分钟';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}

function healthBadgeMeta(level: CloudflareHealthLevel): {
  label: string;
  toneClass: string;
  dotClass: string;
} {
  if (level === 'healthy') {
    return {
      label: '全部健康',
      toneClass: 'cf-tone-ok',
      dotClass: 'cf-dot-ok',
    };
  }
  if (level === 'degraded') {
    return {
      label: '部分降级 / 需关注',
      toneClass: 'cf-tone-warn',
      dotClass: 'cf-dot-warn',
    };
  }
  return {
    label: '核心探针异常',
    toneClass: 'cf-tone-err',
    dotClass: 'cf-dot-err',
  };
}

function LatencySparkline({
  values,
  label,
}: {
  values: number[];
  label: string;
}) {
  if (values.length < 2) {
    return (
      <div className="mt-2 h-[28px] w-full rounded-[6px] bg-surface/60 px-2 py-1 text-[11px] text-ink-muted">
        采集实时样本中…
      </div>
    );
  }
  const width = 180;
  const height = 28;
  const maxVal = Math.max(10, ...values);
  const minVal = Math.min(...values);
  const span = Math.max(1, maxVal - minVal);
  const points = values
    .map((v, idx) => {
      const x = (idx / (values.length - 1)) * (width - 4) + 2;
      const y = height - 4 - ((v - minVal) / span) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      className="mt-2 h-[28px] w-full overflow-visible"
      preserveAspectRatio="none"
    >
      <title>{`${label}最近 ${values.length} 次探针延迟趋势：最低 ${minVal}ms，最高 ${maxVal}ms`}</title>
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-accent"
        points={points}
      />
    </svg>
  );
}

export function CloudflareStatusPanel({
  onStatus,
  onError,
  onSnapshotChange,
}: CloudflareStatusPanelProps) {
  const [snapshot, setSnapshot] = useState<CloudflareStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<CloudflareTimeRange>('today');
  const [planTier, setPlanTier] = useState<CloudflarePlanTier>('free');
  const [intervalSec, setIntervalSec] = useState<PollIntervalSec>(15);
  const [tabVisible, setTabVisible] = useState<boolean>(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  const [countdown, setCountdown] = useState<number>(15);
  const [latencyHistory, setLatencyHistory] = useState<LatencySample[]>([]);
  const [showTrafficTable, setShowTrafficTable] = useState(false);

  // Ops state & native <dialog> confirmation
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmAction | null>(null);
  const [executingOps, setExecutingOps] = useState(false);
  const confirmDialogRef = useRef<HTMLDialogElement>(null);
  const confirmTitleId = useId();
  const pollSelectId = useId();
  const underAttackSwitchId = useId();
  const devModeSwitchId = useId();

  // Accessible copy button state (live region outside the button)
  const [copySnapState, setCopySnapState] = useState<{ state: 'idle' | 'copied' | 'failed'; msg: string }>({
    state: 'idle',
    msg: '',
  });
  const [copyCmdState, setCopyCmdState] = useState<{ state: 'idle' | 'copied' | 'failed'; msg: string }>({
    state: 'idle',
    msg: '',
  });
  const copyTimersRef = useRef<{ snap?: ReturnType<typeof setTimeout>; cmd?: ReturnType<typeof setTimeout> }>({});

  const nativeSwitchSupported = useMemo(
    () => typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype,
    [],
  );

  const fetchStatus = useCallback(
    async (opts?: { force?: boolean; poll?: boolean; targetRange?: CloudflareTimeRange }) => {
      const targetRange = opts?.targetRange ?? range;
      const isPoll = Boolean(opts?.poll);
      const isForce = Boolean(opts?.force);

      if (!isPoll) {
        setRefreshing(true);
      }

      try {
        const params = new URLSearchParams({ range: targetRange });
        if (isForce) params.set('force', '1');
        if (isPoll) params.set('poll', '1');

        const data = await apiJson<CloudflareStatusSnapshot>(
          `/api/admin/cloudflare/status?${params.toString()}`,
        );
        setSnapshot(data);
        onSnapshotChange?.(data);
        setLatencyHistory((prev) => {
          const next: LatencySample[] = [
            ...prev,
            {
              at: data.runtime.probedAt,
              workerMs: data.runtime.workerResponseMs,
              d1Ms: data.runtime.d1.latencyMs,
              r2Ms: data.runtime.r2.latencyMs,
              doMs: data.runtime.durableObject.latencyMs,
            },
          ];
          return next.slice(-MAX_LATENCY_SAMPLES);
        });
        if (isForce) {
          onStatus('已强制刷新 Cloudflare 实时探针与官方指标缓存。');
        }
      } catch (err) {
        if (!isPoll) {
          onError(err instanceof Error ? err.message : '拉取 Cloudflare 状态失败');
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
        if (intervalSec > 0) {
          setCountdown(intervalSec);
        }
      }
    },
    [intervalSec, onError, onSnapshotChange, onStatus, range],
  );

  // Initial load & range switch
  useEffect(() => {
    void fetchStatus({ targetRange: range });
  }, [range, fetchStatus]);

  // Auto-pause polling when browser tab is hidden
  useEffect(() => {
    const onVisChange = () => {
      const visible = document.visibilityState !== 'hidden';
      setTabVisible(visible);
      if (visible && intervalSec > 0) {
        setCountdown(intervalSec);
        void fetchStatus({ poll: true });
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, [fetchStatus, intervalSec]);

  // Countdown + auto-poll timer
  useEffect(() => {
    if (intervalSec === 0 || !tabVisible) return;
    setCountdown(intervalSec);

    const tick = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          void fetchStatus({ poll: true });
          return intervalSec;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(tick);
  }, [fetchStatus, intervalSec, tabVisible]);

  // Cleanup copy feedback timers
  useEffect(() => {
    const timers = copyTimersRef.current;
    return () => {
      if (timers.snap) clearTimeout(timers.snap);
      if (timers.cmd) clearTimeout(timers.cmd);
    };
  }, []);

  const executeOpsAction = useCallback(
    async (req: CloudflareOpsActionRequest) => {
      setExecutingOps(true);
      onError('');
      try {
        const res = await apiJson<CloudflareOpsActionResponse>('/api/admin/cloudflare/ops', {
          method: 'POST',
          json: req,
        });
        onStatus(res.message);
        setSnapshot((prev) => {
          if (!prev || !prev.account) return prev;
          return {
            ...prev,
            account: {
              ...prev.account,
              zoneControls: res.zoneControls ?? prev.account.zoneControls,
            },
          };
        });
      } catch (err) {
        onError(err instanceof Error ? err.message : '执行 Cloudflare 运维操作失败');
      } finally {
        setExecutingOps(false);
      }
    },
    [onError, onStatus],
  );

  // Sync pendingConfirm with native <dialog>.showModal()
  useEffect(() => {
    const dialog = confirmDialogRef.current;
    if (!dialog) return;

    if (pendingConfirm && !dialog.open) {
      dialog.returnValue = '';
      dialog.showModal();
    } else if (!pendingConfirm && dialog.open) {
      dialog.close();
    }
  }, [pendingConfirm]);

  useEffect(() => {
    const dialog = confirmDialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      const choice = dialog.returnValue;
      dialog.returnValue = '';
      const current = pendingConfirm;
      setPendingConfirm(null);
      if (choice === 'confirm' && current) {
        void executeOpsAction(current.request);
      }
    };

    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [executeOpsAction, pendingConfirm]);

  const copyTextWithAnnouncement = async (
    text: string,
    slot: 'snap' | 'cmd',
  ) => {
    const setState = slot === 'snap' ? setCopySnapState : setCopyCmdState;
    if (copyTimersRef.current[slot]) {
      clearTimeout(copyTimersRef.current[slot]);
    }

    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }

    let msg = ok ? '已复制' : '复制失败';
    if (msg === lastCopyAnnouncement) {
      msg += '\u00A0';
    }
    lastCopyAnnouncement = msg;

    setState({ state: ok ? 'copied' : 'failed', msg: '' });
    requestAnimationFrame(() => {
      setState({ state: ok ? 'copied' : 'failed', msg });
    });

    copyTimersRef.current[slot] = setTimeout(() => {
      setState({ state: 'idle', msg: '' });
    }, 2200);
  };

  const handleCopyDiagnosticSnapshot = () => {
    if (!snapshot) return;
    const payload = JSON.stringify(snapshot, null, 2);
    void copyTextWithAnnouncement(payload, 'snap');
  };

  const setupCommandText =
    'powershell -ExecutionPolicy Bypass -File scripts/provision-cloudflare-status-token.ps1';

  const plan = CLOUDFLARE_PLAN_LIMITS[planTier];
  const overallMeta = healthBadgeMeta(snapshot?.overall ?? 'healthy');

  const quotaCards = useMemo(() => {
    const acct = snapshot?.account;
    if (!acct?.configured) return [];

    const periodLabel = (period: 'day' | 'month') => (period === 'day' ? '今日 UTC' : '本月');
    const workersUsed = plan.workersRequestsPeriod === 'day' ? acct.workers.todayRequests : acct.workers.requests;
    const d1ReadUsed = plan.d1RowsReadPeriod === 'day' ? acct.d1.todayRowsRead : acct.d1.rowsRead;
    const d1WriteUsed = plan.d1RowsWrittenPeriod === 'day' ? acct.d1.todayRowsWritten : acct.d1.rowsWritten;
    const doReqUsed = plan.doRequestsPeriod === 'day' ? acct.durableObjects.todayRequests : acct.durableObjects.requests;

    return [
      {
        key: 'workers-req',
        title: `Workers 请求 (${periodLabel(plan.workersRequestsPeriod)})`,
        available: acct.workers.available,
        used: workersUsed,
        cap: plan.workersRequests,
        usedText: formatCompactNumber(workersUsed),
        capText: formatCompactNumber(plan.workersRequests),
        sub: acct.workers.available
          ? `错误率 ${acct.workers.errorRatePct}% · CPU P50 ${acct.workers.cpuTimeP50Ms}ms / P99 ${acct.workers.cpuTimeP99Ms}ms`
          : '暂无指标数据',
      },
      {
        key: 'd1-read',
        title: `D1 读行数 (${periodLabel(plan.d1RowsReadPeriod)})`,
        available: acct.d1.available,
        used: d1ReadUsed,
        cap: plan.d1RowsRead,
        usedText: formatCompactNumber(d1ReadUsed),
        capText: formatCompactNumber(plan.d1RowsRead),
        sub: acct.d1.available
          ? `查询 ${formatCompactNumber(acct.d1.readQueries)} 次 · 库大小 ${formatBytes(acct.d1.storageBytes || snapshot?.runtime.d1.databaseBytes || 0)}`
          : '暂无指标数据',
      },
      {
        key: 'd1-write',
        title: `D1 写行数 (${periodLabel(plan.d1RowsWrittenPeriod)})`,
        available: acct.d1.available,
        used: d1WriteUsed,
        cap: plan.d1RowsWritten,
        usedText: formatCompactNumber(d1WriteUsed),
        capText: formatCompactNumber(plan.d1RowsWritten),
        sub: acct.d1.available ? `写查询 ${formatCompactNumber(acct.d1.writeQueries)} 次` : '暂无指标数据',
      },
      {
        key: 'r2-storage',
        title: 'R2 桶实际存储',
        available: acct.r2.available,
        used: acct.r2.totalStorageBytes,
        cap: plan.r2StorageBytes,
        usedText: formatBytes(acct.r2.totalStorageBytes),
        capText: formatBytes(plan.r2StorageBytes),
        sub: acct.r2.available
          ? `共 ${acct.r2.objectCount.toLocaleString('en-US')} 个对象（元数据 ${formatBytes(acct.r2.metadataBytes)}）`
          : '暂无指标数据',
      },
      {
        key: 'r2-ops',
        title: 'R2 本月 A / B 类操作',
        available: acct.r2.available,
        used: Math.max(
          acct.r2.monthClassA / plan.r2ClassA,
          acct.r2.monthClassB / plan.r2ClassB,
        ) * 100,
        cap: 100,
        isDirectPct: true,
        usedText: `A ${formatCompactNumber(acct.r2.monthClassA)} / B ${formatCompactNumber(acct.r2.monthClassB)}`,
        capText: `上限 A ${formatCompactNumber(plan.r2ClassA)} · B ${formatCompactNumber(plan.r2ClassB)}`,
        sub: '按当前 UTC 自然月统计',
      },
      {
        key: 'do-req',
        title: `Durable Objects 请求 (${periodLabel(plan.doRequestsPeriod)})`,
        available: acct.durableObjects.available,
        used: doReqUsed,
        cap: plan.doRequests,
        usedText: formatCompactNumber(doReqUsed),
        capText: formatCompactNumber(plan.doRequests),
        sub: acct.durableObjects.available
          ? `SQLite 存储 ${formatBytes(acct.durableObjects.storedBytes)} / ${formatBytes(plan.doStorageBytes)}`
          : '暂无指标数据',
      },
    ];
  }, [plan, snapshot]);

  const requestConfirmUnderAttack = (nextEnabled: boolean) => {
    const zoneLabel = snapshot?.account?.zoneControls?.zoneName || '当前站点';
    setPendingConfirm({
      request: {
        action: 'security_level',
        value: nextEnabled ? 'under_attack' : 'medium',
      },
      title: nextEnabled ? '开启 Under Attack 防护模式？' : '关闭 Under Attack 防护模式？',
      description: nextEnabled
        ? `即将把 ${zoneLabel} 的 Cloudflare 安全级别切换为 Under Attack。`
        : `即将把 ${zoneLabel} 的安全级别恢复为常规（Medium）。`,
      impact: nextEnabled
        ? '开启后，所有访客在进入网站前都会看到约 5 秒的 Cloudflare 浏览器质询验证页面，可能影响自动化请求或弱网体验。'
        : '恢复常规防护级别后，普通访客将不再触发全站质询页。',
      confirmLabel: nextEnabled ? '确认开启防护' : '确认恢复常规',
      destructive: nextEnabled,
    });
  };

  const requestConfirmDevMode = (nextEnabled: boolean) => {
    const zoneLabel = snapshot?.account?.zoneControls?.zoneName || '当前站点';
    setPendingConfirm({
      request: {
        action: 'development_mode',
        enabled: nextEnabled,
      },
      title: nextEnabled ? '开启 Cloudflare 开发模式？' : '关闭 Cloudflare 开发模式？',
      description: nextEnabled
        ? `即将为 ${zoneLabel} 开启 Development Mode。`
        : `即将为 ${zoneLabel} 关闭 Development Mode。`,
      impact: nextEnabled
        ? '开发模式将临时绕过边缘缓存，所有静态资源请求会回源 Worker，3 小时后 Cloudflare 自动关闭。'
        : '关闭后边缘缓存立即恢复，降低 Worker 请求与带宽开销。',
      confirmLabel: nextEnabled ? '确认开启开发模式' : '确认关闭开发模式',
    });
  };

  const requestConfirmPurgeCache = () => {
    const zoneLabel = snapshot?.account?.zoneControls?.zoneName || '当前站点';
    setPendingConfirm({
      request: { action: 'purge_cache' },
      title: '清理整站 Cloudflare 边缘缓存？',
      description: `即将对 ${zoneLabel} 执行 Purge Everything。`,
      impact: '全球边缘节点的静态缓存会立即失效并在 30 秒内清空，随后首次访问会重新回源生成缓存。操作将记入安全审计日志。',
      confirmLabel: '确认清空缓存',
      destructive: true,
    });
  };

  if (loading && !snapshot) {
    return (
      <section className="rounded-[20px] bg-surface p-6">
        <p className="m-0 text-[13.5px] text-ink-muted">正在执行 Cloudflare 运行时探针与状态同步……</p>
      </section>
    );
  }

  const runtime = snapshot?.runtime;
  const globalStatus = snapshot?.globalStatus;
  const account = snapshot?.account;
  const zoneControls = account?.zoneControls ?? null;
  const trafficSeries = account?.zoneTraffic.series ?? [];
  const maxTrafficReq = Math.max(1, ...trafficSeries.map((p) => p.requests));

  const underAttackActive = zoneControls?.securityLevel === 'under_attack';
  const devModeActive = Boolean(zoneControls?.developmentMode?.enabled);
  const opsEnabled = Boolean(account?.configured && zoneControls?.canManageZone && !executingOps);

  return (
    <div className="space-y-6">
      {/* Sticky / top telemetry control bar */}
      <section className="rounded-[20px] border border-hairline bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium ${overallMeta.toneClass}`}
            >
              <span
                aria-hidden="true"
                className={`cf-pulse-dot h-2 w-2 rounded-full ${overallMeta.dotClass}`}
              />
              <span>{overallMeta.label}</span>
            </span>
            <span className="tabular-nums-mono text-[12px] text-ink-muted">
              最近探针 {formatClockTime(runtime?.probedAt)}
              {intervalSec > 0 && tabVisible ? ` · ${countdown}s 后自动刷新` : intervalSec === 0 ? ' · 自动轮询已暂停' : ' · 页面隐藏已暂停'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Refresh interval selector */}
            <label htmlFor={pollSelectId} className="sr-only">
              自动轮询间隔
            </label>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 py-1.5 text-[12.5px] text-ink-muted">
              {intervalSec > 0 && tabVisible ? (
                <Play className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              ) : (
                <Pause className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
              )}
              <select
                id={pollSelectId}
                value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value) as PollIntervalSec)}
                className="tabular-nums-mono bg-transparent text-[12.5px] text-ink focus:outline-none"
              >
                <option value={5}>每 5 秒</option>
                <option value={15}>每 15 秒 (推荐)</option>
                <option value={30}>每 30 秒</option>
                <option value={0}>手动暂停</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => void fetchStatus({ force: false })}
              disabled={refreshing}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>刷新探针</span>
            </button>

            <button
              type="button"
              onClick={() => void fetchStatus({ force: true })}
              disabled={refreshing}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-cta-bg px-3.5 text-[12.5px] font-medium text-cta-text transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>强刷 CF 接口</span>
            </button>

            {/* Accessible Copy Diagnostic Snapshot button (live region outside button) */}
            <span className="relative inline-flex items-center">
              <button
                type="button"
                onClick={handleCopyDiagnosticSnapshot}
                data-copied={copySnapState.state === 'copied' ? '' : undefined}
                data-failed={copySnapState.state === 'failed' ? '' : undefined}
                className="inline-flex min-h-[36px] min-w-[36px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 text-[12.5px] text-ink transition-colors hover:bg-surface-hover"
              >
                {copySnapState.state === 'copied' ? (
                  <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>复制诊断</span>
              </button>
              <span
                role="status"
                className={`cf-copy-tip ${copySnapState.msg ? 'cf-copy-tip-visible' : ''}`}
              >
                {copySnapState.msg}
              </span>
            </span>
          </div>
        </div>

        {/* Sub-bar: Time Window & Plan Tier Switchers */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="分析时间窗口">
            <span className="text-[12px] text-ink-muted">分析窗口</span>
            {(
              [
                { id: 'today', label: '今日 UTC' },
                { id: '24h', label: '近 24 小时' },
                { id: '7d', label: '近 7 天' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={range === opt.id}
                onClick={() => setRange(opt.id)}
                className={[
                  'min-h-[32px] rounded-full px-3 text-[12px] transition-colors',
                  range === opt.id
                    ? 'bg-cta-bg font-medium text-cta-text'
                    : 'bg-paper text-ink-muted hover:bg-surface-hover hover:text-ink',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="配额套餐基准">
            <span className="text-[12px] text-ink-muted">配额基准</span>
            {(
              [
                { id: 'free', label: 'Free 免费版' },
                { id: 'paid', label: 'Paid ($5)' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={planTier === opt.id}
                onClick={() => setPlanTier(opt.id)}
                className={[
                  'min-h-[32px] rounded-full px-3 text-[12px] transition-colors',
                  planTier === opt.id
                    ? 'bg-accent font-medium text-cta-text'
                    : 'bg-paper text-ink-muted hover:bg-surface-hover hover:text-ink',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Section 1: Runtime Live Probes & Edge Info */}
      {runtime && (
        <section className="rounded-[20px] border border-hairline bg-surface p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-accent" aria-hidden="true" />
              <h2 className="m-0 text-[18px] font-medium text-ink">本站边缘节点与实时运行时探针</h2>
            </div>
            <span className="tabular-nums-mono rounded-full border border-hairline bg-paper px-3 py-1 text-[11.5px] text-ink-muted">
              {runtime.edge.environment === 'production' ? 'Cloudflare 边缘生产环境' : '本地 Miniflare 模拟环境'} · Worker 总耗时 {runtime.workerResponseMs} ms
            </span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* Edge PoP Card */}
            <div className="rounded-[16px] border border-hairline bg-paper p-4">
              <div className="flex items-center justify-between gap-2 text-[12px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>当前命中节点 (Edge PoP)</span>
                </span>
                <span className="cf-tone-ok rounded-full px-2 py-0.5 text-[11px] font-medium">
                  {runtime.edge.colo || 'LOCAL'}
                </span>
              </div>
              <div className="tabular-nums-mono mt-1.5 text-[18px] font-medium text-ink">
                {runtime.edge.colo
                  ? `${runtime.edge.colo}${runtime.edge.country ? ` · ${runtime.edge.country}` : ''}`
                  : '127.0.0.1 本地'}
              </div>
              <div className="tabular-nums-mono mt-1 text-[11.5px] text-ink-muted">
                {runtime.edge.httpProtocol || 'HTTP/1.1'}
                {runtime.edge.tlsVersion ? ` · ${runtime.edge.tlsVersion}` : ''}
                {runtime.edge.clientTcpRttMs !== null ? ` · RTT ${runtime.edge.clientTcpRttMs}ms` : ''}
              </div>
              <div className="mt-1 truncate text-[11.5px] text-ink-muted">
                {runtime.edge.asOrganization
                  ? `AS${runtime.edge.asn ?? ''} ${runtime.edge.asOrganization}`
                  : runtime.edge.host}
              </div>
              <LatencySparkline
                values={latencyHistory.map((s) => s.workerMs)}
                label="Worker 响应"
              />
            </div>

            {/* D1 Probe */}
            <div className="rounded-[16px] border border-hairline bg-paper p-4">
              <div className="flex items-center justify-between gap-2 text-[12px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Database className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>D1 数据库 (DB)</span>
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${runtime.d1.ok ? 'cf-tone-ok' : 'cf-tone-err'}`}
                >
                  {runtime.d1.ok ? '正常' : '异常'}
                </span>
              </div>
              <div className="tabular-nums-mono mt-1.5 text-[18px] font-medium text-ink">
                {runtime.d1.latencyMs} ms
              </div>
              <div className="tabular-nums-mono mt-1 text-[11.5px] text-ink-muted">
                库体积 {formatBytes(runtime.d1.databaseBytes)} · 审计 {runtime.d1.tables.securityEvents} 条
              </div>
              <div className="tabular-nums-mono mt-1 text-[11.5px] text-ink-muted">
                旅程 {runtime.d1.tables.journeys} · 影像 {runtime.d1.tables.media} · 密匣 {runtime.d1.tables.vaultFiles}
              </div>
              <LatencySparkline
                values={latencyHistory.map((s) => s.d1Ms)}
                label="D1 探针"
              />
            </div>

            {/* R2 Probe */}
            <div className="rounded-[16px] border border-hairline bg-paper p-4">
              <div className="flex items-center justify-between gap-2 text-[12px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <HardDrive className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>R2 对象存储 (MEDIA)</span>
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${runtime.r2.ok ? 'cf-tone-ok' : 'cf-tone-err'}`}
                >
                  {runtime.r2.ok ? '正常' : '异常'}
                </span>
              </div>
              <div className="tabular-nums-mono mt-1.5 text-[18px] font-medium text-ink">
                {runtime.r2.latencyMs} ms
              </div>
              <div className="tabular-nums-mono mt-1 text-[11.5px] text-ink-muted">
                站内累计上传 {formatBytes(runtime.appBudget.uploadBytes)}
              </div>
              <div className="tabular-nums-mono mt-1 text-[11.5px] text-ink-muted">
                本月站内 A {runtime.appBudget.r2ClassA} · B {runtime.appBudget.r2ClassB}
              </div>
              <LatencySparkline
                values={latencyHistory.map((s) => s.r2Ms)}
                label="R2 探针"
              />
            </div>

            {/* Durable Object Probe */}
            <div className="rounded-[16px] border border-hairline bg-paper p-4">
              <div className="flex items-center justify-between gap-2 text-[12px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>Durable Objects (沙暴)</span>
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${runtime.durableObject.ok ? 'cf-tone-ok' : 'cf-tone-warn'}`}
                >
                  {runtime.durableObject.ok ? '正常' : '降级'}
                </span>
              </div>
              <div className="tabular-nums-mono mt-1.5 text-[18px] font-medium text-ink">
                {runtime.durableObject.latencyMs} ms
              </div>
              <div className="tabular-nums-mono mt-1 text-[11.5px] text-ink-muted">
                在线房间 {runtime.durableObject.activeLobbies} · 活跃玩家 {runtime.durableObject.activeHumans}
              </div>
              <div className="tabular-nums-mono mt-1 text-[11.5px] text-ink-muted">
                累计归档战报 {runtime.d1.tables.arenaMatches} 场
              </div>
              <LatencySparkline
                values={latencyHistory.map((s) => s.doMs)}
                label="Durable Object 探针"
              />
            </div>
          </div>
        </section>
      )}

      {/* Section 2: Cloudflare Account Official Quotas & Zone Traffic */}
      <section className="rounded-[20px] border border-hairline bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-accent" aria-hidden="true" />
              <h2 className="m-0 text-[18px] font-medium text-ink">Cloudflare 官方账户用量与域名流量</h2>
            </div>
            <p className="mt-1 mb-0 text-[12.5px] text-ink-muted">
              当前配额基准：{plan.label}（75% 黄色提醒 / 90% 红色告警）
              {account?.configured && (
                <>
                  {' '}· 缓存状态：
                  {account.cached ? `后端缓存 (${account.cacheAgeSec}s 前)` : '刚刚拉取'}
                </>
              )}
            </p>
          </div>

          {account?.dashboardUrl && (
            <a
              href={account.dashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[12.5px] text-ink transition-colors hover:bg-surface-hover"
            >
              <span>打开 Cloudflare 控制台</span>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          )}
        </div>

        {!account?.configured ? (
          <div className="mt-4 rounded-[16px] border border-hairline bg-paper p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="m-0 text-[15px] font-medium text-ink">
                  尚未配置 <code className="tabular-nums-mono">CF_API_TOKEN</code>（当前已优雅降级）
                </h3>
                <p className="mt-1.5 mb-0 text-[13px] text-ink-muted">
                  上方运行时探针与下方 Cloudflare 全球平台健康状态无需 Token 即可实时工作。将 Cloudflare API Token 作为 Worker Secret 注入后，即可解锁账户真实免费额度水位、域名流量趋势图与远程运维开关。
                </p>
              </div>
              <span className="cf-tone-warn shrink-0 rounded-full px-3 py-1 text-[12px] font-medium">
                待接入账户 API
              </span>
            </div>

            <div className="mt-4 rounded-[12px] border border-hairline bg-page p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-ink">推荐一键安全注入命令（不落盘明文、不进 Git）：</span>
                <span className="relative inline-flex items-center">
                  <button
                    type="button"
                    onClick={() => void copyTextWithAnnouncement(setupCommandText, 'cmd')}
                    data-copied={copyCmdState.state === 'copied' ? '' : undefined}
                    data-failed={copyCmdState.state === 'failed' ? '' : undefined}
                    className="inline-flex min-h-[28px] min-w-[28px] items-center gap-1 rounded-full border border-hairline bg-surface px-2.5 text-[11.5px] text-ink hover:bg-surface-hover"
                  >
                    {copyCmdState.state === 'copied' ? (
                      <Check className="h-3 w-3 text-accent" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3 w-3" aria-hidden="true" />
                    )}
                    <span>复制命令</span>
                  </button>
                  <span
                    role="status"
                    className={`cf-copy-tip ${copyCmdState.msg ? 'cf-copy-tip-visible' : ''}`}
                  >
                    {copyCmdState.msg}
                  </span>
                </span>
              </div>
              <pre className="tabular-nums-mono mt-2 mb-0 overflow-x-auto text-[12px] text-ink">
                <code>{setupCommandText}</code>
              </pre>
            </div>

            <div className="mt-4">
              <h3 className="m-0 mb-2 text-[13px] font-medium text-ink">最小 API Token 权限清单</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {(account?.permissionsGuide ?? []).map((perm) => (
                  <div
                    key={perm.scope}
                    className="flex items-start justify-between gap-2 rounded-[12px] border border-hairline bg-page/70 px-3 py-2 text-[12px]"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-ink">{perm.scope}</div>
                      <div className="text-ink-muted">{perm.purpose}</div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${perm.requiredFor === 'ops' ? 'cf-tone-warn' : 'cf-tone-ok'}`}
                    >
                      {perm.access}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Warnings from partial API permissions */}
            {account.warnings.length > 0 && (
              <div
                role="status"
                className="mt-4 rounded-[14px] border border-hairline bg-paper px-4 py-3 text-[12.5px] text-postmark"
              >
                <div className="font-medium">部分 Cloudflare 指标返回提示：</div>
                <ul className="mt-1 mb-0 list-disc pl-5">
                  {account.warnings.map((w, i) => (
                    <li key={`${i}-${w}`}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Account & Deployment metadata strip */}
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[14px] border border-hairline bg-paper px-4 py-2.5 text-[12.5px] text-ink-muted">
              <span>
                账户：<strong className="font-medium text-ink">{account.accountName || account.accountId || '未识别'}</strong>
              </span>
              {zoneControls && (
                <span>
                  域名 Zone：<strong className="tabular-nums-mono font-medium text-ink">{zoneControls.zoneName}</strong> ({zoneControls.planName} · {zoneControls.zoneStatus})
                </span>
              )}
              <span>
                Worker：<strong className="tabular-nums-mono font-medium text-ink">{account.workerName}</strong>
              </span>
              {account.latestDeployment && (
                <span className="tabular-nums-mono">
                  最新部署：{account.latestDeployment.id.slice(0, 8)} · {account.latestDeployment.createdOn.slice(0, 16).replace('T', ' ')} UTC
                </span>
              )}
            </div>

            {/* Quota progress bars grid */}
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {quotaCards.map((card) => {
                const pct = card.isDirectPct
                  ? Math.min(100, Math.max(0, card.used))
                  : card.cap > 0
                    ? Math.min(100, (card.used / card.cap) * 100)
                    : 0;
                const level = pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok';
                const statusLabel = pct >= 90 ? '告警' : pct >= 75 ? '提醒' : '充裕';

                return (
                  <div
                    key={card.key}
                    className="rounded-[16px] border border-hairline bg-paper p-4"
                  >
                    <div className="flex items-center justify-between gap-2 text-[12px] text-ink-muted">
                      <span>{card.title}</span>
                      <span
                        className={`tabular-nums-mono shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          level === 'err' ? 'cf-tone-err' : level === 'warn' ? 'cf-tone-warn' : 'cf-tone-ok'
                        }`}
                      >
                        {pct.toFixed(1)}% · {statusLabel}
                      </span>
                    </div>
                    <div className="tabular-nums-mono mt-1.5 text-[18px] font-medium text-ink">
                      {card.available ? card.usedText : '--'}
                    </div>
                    <div
                      role="progressbar"
                      aria-label={card.title}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(pct)}
                      className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface"
                    >
                      <div
                        className={`h-full rounded-full transition-[width] duration-300 ${
                          level === 'err'
                            ? 'cf-bar-err'
                            : level === 'warn'
                              ? 'cf-bar-warn'
                              : 'bg-accent'
                        }`}
                        style={{ width: `${pct > 0 ? Math.max(2, pct) : 0}%` }}
                      />
                    </div>
                    <div className="tabular-nums-mono mt-1.5 text-[11.5px] text-ink-muted">
                      {card.capText}
                    </div>
                    <div className="tabular-nums-mono mt-0.5 text-[11.5px] text-ink-muted">
                      {card.sub}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Zone HTTP Traffic KPIs + Accessible SVG Bar Chart */}
            {account.zoneTraffic.available && (
              <div className="mt-5 rounded-[16px] border border-hairline bg-paper p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="m-0 text-[15px] font-medium text-ink">
                    域名边缘流量与缓存效率（{range === 'today' ? '今日 UTC' : range === '24h' ? '近 24 小时' : '近 7 天'}）
                  </h3>
                  <button
                    type="button"
                    aria-expanded={showTrafficTable}
                    onClick={() => setShowTrafficTable((v) => !v)}
                    className="min-h-[30px] rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink-muted hover:bg-surface-hover hover:text-ink"
                  >
                    {showTrafficTable ? '收起明细表' : '查看数据明细表'}
                  </button>
                </div>

                <div className="tabular-nums-mono mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                  <div className="rounded-[12px] bg-surface/70 px-3 py-2.5">
                    <div className="text-[11.5px] text-ink-muted">边缘总请求</div>
                    <div className="mt-0.5 text-[16px] font-medium text-ink">
                      {formatCompactNumber(account.zoneTraffic.requests)}
                    </div>
                  </div>
                  <div className="rounded-[12px] bg-surface/70 px-3 py-2.5">
                    <div className="text-[11.5px] text-ink-muted">缓存命中率</div>
                    <div className="mt-0.5 text-[16px] font-medium text-ink">
                      {account.zoneTraffic.cacheHitRatePct}%
                    </div>
                  </div>
                  <div className="rounded-[12px] bg-surface/70 px-3 py-2.5">
                    <div className="text-[11.5px] text-ink-muted">总出站流量</div>
                    <div className="mt-0.5 text-[16px] font-medium text-ink">
                      {formatBytes(account.zoneTraffic.bytes)}
                    </div>
                  </div>
                  <div className="rounded-[12px] bg-surface/70 px-3 py-2.5">
                    <div className="text-[11.5px] text-ink-muted">HTTPS 占比</div>
                    <div className="mt-0.5 text-[16px] font-medium text-ink">
                      {account.zoneTraffic.httpsRatePct}%
                    </div>
                  </div>
                  <div className="col-span-2 rounded-[12px] bg-surface/70 px-3 py-2.5 sm:col-span-1">
                    <div className="text-[11.5px] text-ink-muted">安全拦截</div>
                    <div className="mt-0.5 text-[16px] font-medium text-postmark">
                      {formatCompactNumber(account.zoneTraffic.threats)}
                    </div>
                  </div>
                </div>

                {trafficSeries.length > 0 && (
                  <figure className="mt-4 mb-0">
                    <svg
                      role="img"
                      viewBox="0 0 640 130"
                      className="h-[130px] w-full"
                      preserveAspectRatio="none"
                    >
                      <title>
                        {`域名请求趋势图：共 ${trafficSeries.length} 个时段，总请求 ${account.zoneTraffic.requests} 次，缓存命中 ${account.zoneTraffic.cachedRequests} 次`}
                      </title>
                      {trafficSeries.map((pt, idx) => {
                        const slotW = 640 / trafficSeries.length;
                        const barW = Math.max(4, Math.min(28, slotW * 0.68));
                        const x = idx * slotW + (slotW - barW) / 2;
                        const totalH = Math.max(2, (pt.requests / maxTrafficReq) * 102);
                        const cachedH = Math.max(0, (pt.cachedRequests / maxTrafficReq) * 102);
                        return (
                          <g key={pt.timestamp}>
                            <rect
                              x={x}
                              y={112 - totalH}
                              width={barW}
                              height={totalH}
                              rx={3}
                              fill="currentColor"
                              className="text-ink-muted/30"
                            />
                            {cachedH > 0 && (
                              <rect
                                x={x}
                                y={112 - cachedH}
                                width={barW}
                                height={cachedH}
                                rx={3}
                                fill="currentColor"
                                className="text-accent"
                              />
                            )}
                          </g>
                        );
                      })}
                    </svg>
                    <figcaption className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-muted">
                      <span className="tabular-nums-mono">
                        {trafficSeries[0]?.label} → {trafficSeries[trafficSeries.length - 1]?.label}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="inline-flex items-center gap-1">
                          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[2px] bg-accent" />
                          <span>缓存命中</span>
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-[2px] bg-ink-muted/30" />
                          <span>总请求</span>
                        </span>
                      </span>
                    </figcaption>
                  </figure>
                )}

                {showTrafficTable && trafficSeries.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="tabular-nums-mono w-full border-collapse text-left text-[12px]">
                      <caption className="sr-only">Cloudflare 域名流量分时段明细</caption>
                      <thead>
                        <tr className="border-b border-hairline text-ink-muted">
                          <th scope="col" className="py-2 pr-3 font-medium">时段</th>
                          <th scope="col" className="py-2 pr-3 font-medium">总请求</th>
                          <th scope="col" className="py-2 pr-3 font-medium">缓存命中</th>
                          <th scope="col" className="py-2 pr-3 font-medium">流量</th>
                          <th scope="col" className="py-2 font-medium">拦截</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trafficSeries.map((pt) => (
                          <tr key={pt.timestamp} className="border-b border-hairline/60 text-ink">
                            <th scope="row" className="py-1.5 pr-3 font-normal">{pt.label}</th>
                            <td className="py-1.5 pr-3">{pt.requests.toLocaleString('en-US')}</td>
                            <td className="py-1.5 pr-3">{pt.cachedRequests.toLocaleString('en-US')}</td>
                            <td className="py-1.5 pr-3">{formatBytes(pt.bytes)}</td>
                            <td className="py-1.5">{pt.threats.toLocaleString('en-US')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* Section 3: Quick Cloudflare Ops Controls */}
      <section className="rounded-[20px] border border-hairline bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-postmark" aria-hidden="true" />
            <h2 className="m-0 text-[18px] font-medium text-ink">Cloudflare 快捷运维控制</h2>
          </div>
          <span className="text-[12px] text-ink-muted">
            所有远程写操作均需弹窗二次确认，并同步记录到「安全与会话」审计流水
          </span>
        </div>

        {zoneControls?.opsNote && (
          <p className="mt-2.5 mb-0 text-[12.5px] text-postmark">{zoneControls.opsNote}</p>
        )}

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {/* 1. Under Attack Mode */}
          <div className="flex flex-col justify-between gap-3 rounded-[16px] border border-hairline bg-paper p-4">
            <div>
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={underAttackSwitchId}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-[14px] font-medium text-ink"
                >
                  <ShieldAlert className="h-4 w-4 text-postmark" aria-hidden="true" />
                  <span>Under Attack 防护模式</span>
                </label>
                <input
                  id={underAttackSwitchId}
                  type="checkbox"
                  checked={underAttackActive}
                  disabled={!opsEnabled}
                  role={nativeSwitchSupported ? undefined : 'switch'}
                  aria-checked={nativeSwitchSupported ? undefined : underAttackActive}
                  {...({ switch: '' } as Record<string, string>)}
                  onChange={(e) => requestConfirmUnderAttack(e.target.checked)}
                  className={nativeSwitchSupported ? 'cf-native-switch' : 'cf-fallback-switch'}
                />
              </div>
              <p className="mt-1.5 mb-0 text-[12.5px] text-ink-muted">
                遭受高频 CC/爬虫攻击时一键开启全站质询页；关闭后恢复常规（Medium）。
              </p>
            </div>
            <div className="tabular-nums-mono text-[12px] text-ink-muted">
              当前级别：
              <strong className={underAttackActive ? 'text-postmark' : 'text-ink'}>
                {zoneControls?.securityLevel
                  ? SECURITY_LEVEL_LABELS[zoneControls.securityLevel]
                  : account?.configured
                    ? '未获取'
                    : '需配置 Token'}
              </strong>
            </div>
          </div>

          {/* 2. Development Mode */}
          <div className="flex flex-col justify-between gap-3 rounded-[16px] border border-hairline bg-paper p-4">
            <div>
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor={devModeSwitchId}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-[14px] font-medium text-ink"
                >
                  <Flame className="h-4 w-4 text-accent" aria-hidden="true" />
                  <span>开发模式 (Development Mode)</span>
                </label>
                <input
                  id={devModeSwitchId}
                  type="checkbox"
                  checked={devModeActive}
                  disabled={!opsEnabled}
                  role={nativeSwitchSupported ? undefined : 'switch'}
                  aria-checked={nativeSwitchSupported ? undefined : devModeActive}
                  {...({ switch: '' } as Record<string, string>)}
                  onChange={(e) => requestConfirmDevMode(e.target.checked)}
                  className={nativeSwitchSupported ? 'cf-native-switch' : 'cf-fallback-switch'}
                />
              </div>
              <p className="mt-1.5 mb-0 text-[12.5px] text-ink-muted">
                发版调试静态资源时临时绕过边缘缓存，最长持续 3 小时后自动关闭。
              </p>
            </div>
            <div className="tabular-nums-mono text-[12px] text-ink-muted">
              当前状态：
              <strong className={devModeActive ? 'text-accent' : 'text-ink'}>
                {zoneControls?.developmentMode
                  ? devModeActive
                    ? `已开启（剩余 ${formatDurationMinutes(zoneControls.developmentMode.timeRemainingSec)}）`
                    : '关闭'
                  : account?.configured
                    ? '未获取'
                    : '需配置 Token'}
              </strong>
            </div>
          </div>

          {/* 3. Purge Everything */}
          <div className="flex flex-col justify-between gap-3 rounded-[16px] border border-hairline bg-paper p-4">
            <div>
              <div className="text-[14px] font-medium text-ink">一键清理整站缓存</div>
              <p className="mt-1.5 mb-0 text-[12.5px] text-ink-muted">
                立即向全球 Cloudflare 边缘节点下发 Purge Everything，适合紧急更新静态构建产物后生效。
              </p>
            </div>
            <button
              type="button"
              disabled={!opsEnabled}
              onClick={requestConfirmPurgeCache}
              className="inline-flex min-h-[38px] w-full items-center justify-center gap-1.5 rounded-full border border-hairline bg-surface px-4 text-[13px] font-medium text-postmark transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{executingOps ? '正在执行…' : '清理整站边缘缓存'}</span>
            </button>
          </div>
        </div>
      </section>

      {/* Section 4: Cloudflare Global Platform Status (Statuspage) */}
      {globalStatus && (
        <section className="rounded-[20px] border border-hairline bg-surface p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                {globalStatus.indicator === 'none' ? (
                  <CheckCircle2 className="h-4 w-4 text-accent" aria-hidden="true" />
                ) : globalStatus.status === 'unavailable' ? (
                  <XCircle className="h-4 w-4 text-postmark" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-postmark" aria-hidden="true" />
                )}
                <h2 className="m-0 text-[18px] font-medium text-ink">Cloudflare 全球平台服务状态</h2>
              </div>
              <p className="mt-1 mb-0 text-[12.5px] text-ink-muted">
                {globalStatus.description}
                {globalStatus.status === 'ok'
                  ? ` · 全球异常组件 ${globalStatus.degradedCount} 项 · ${globalStatus.cached ? `缓存 ${globalStatus.cacheAgeSec}s 前` : '刚刚同步'}`
                  : globalStatus.error
                    ? `（${globalStatus.error}）`
                    : ''}
              </p>
            </div>

            <a
              href={globalStatus.pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-paper px-3.5 text-[12.5px] text-ink transition-colors hover:bg-surface-hover"
            >
              <span>Cloudflare Status</span>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>

          {globalStatus.incidents.length > 0 && (
            <div className="mt-4 space-y-2">
              <h3 className="m-0 text-[13.5px] font-medium text-postmark">
                正在处理的官方事故 ({globalStatus.incidents.length})
              </h3>
              {globalStatus.incidents.map((inc) => (
                <a
                  key={inc.id}
                  href={inc.shortlink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-[14px] border border-hairline bg-paper px-4 py-3 text-ink no-underline transition-colors hover:bg-surface-hover"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium">{inc.name}</span>
                    <span className="cf-tone-warn rounded-full px-2.5 py-0.5 text-[11px] font-medium">
                      {inc.status} · {inc.impact}
                    </span>
                  </div>
                </a>
              ))}
            </div>
          )}

          {globalStatus.components.length > 0 && (
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {globalStatus.components.map((comp) => {
                const meta = COMPONENT_STATUS_LABELS[comp.status] ?? {
                  label: comp.status,
                  tone: 'warn' as const,
                };
                return (
                  <div
                    key={comp.id}
                    className="flex items-center justify-between gap-2 rounded-[12px] border border-hairline bg-paper px-3.5 py-2.5"
                  >
                    <span className="truncate text-[12.5px] text-ink">{comp.name}</span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        meta.tone === 'ok'
                          ? 'cf-tone-ok'
                          : meta.tone === 'err'
                            ? 'cf-tone-err'
                            : 'cf-tone-warn'
                      }`}
                    >
                      {meta.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Native <dialog> confirmation modal (no redundant role/aria-modal, autofocus on Cancel) */}
      <dialog
        ref={confirmDialogRef}
        aria-labelledby={confirmTitleId}
        className="cf-confirm-dialog m-auto w-[min(92vw,460px)] rounded-[22px] border border-hairline bg-page p-0 text-ink shadow-2xl"
      >
        {pendingConfirm && (
          <div className="p-6">
            <h1 id={confirmTitleId} className="m-0 text-[18px] font-medium text-ink">
              {pendingConfirm.title}
            </h1>
            <p className="mt-2.5 mb-0 text-[13.5px] text-ink">{pendingConfirm.description}</p>
            <p className="mt-2 mb-0 rounded-[12px] border border-hairline bg-surface px-3.5 py-2.5 text-[12.5px] text-ink-muted">
              {pendingConfirm.impact}
            </p>
            <form method="dialog" className="mt-5 flex flex-wrap justify-end gap-2.5">
              <button
                type="submit"
                value="cancel"
                autoFocus
                className="min-h-[38px] rounded-full border border-hairline bg-surface px-4 text-[13px] font-medium text-ink hover:bg-surface-hover"
              >
                取消
              </button>
              <button
                type="submit"
                value="confirm"
                className={[
                  'min-h-[38px] rounded-full px-4 text-[13px] font-medium',
                  pendingConfirm.destructive
                    ? 'bg-postmark text-white hover:opacity-90'
                    : 'bg-cta-bg text-cta-text hover:opacity-90',
                ].join(' ')}
              >
                {pendingConfirm.confirmLabel}
              </button>
            </form>
          </div>
        )}
      </dialog>
    </div>
  );
}
