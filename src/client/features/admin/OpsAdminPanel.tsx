import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Download, KeyRound, RotateCcw, ShieldBan, SlidersHorizontal, Trash2 } from 'lucide-react';
import type {
  SecurityPolicy,
  SecuritySnapshot,
  TrashItem,
  UsageLimitsSummary,
} from '../../../shared/types';
import { apiJson, notifyAuthChange } from '../../lib/api';

type OpsAdminPanelProps = {
  mode: 'usage' | 'security';
  trash: TrashItem[];
  onRefresh: () => Promise<void>;
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
};

type PurgeResult = {
  ok: boolean;
  purged?: number;
  deletedR2Keys?: number | string[];
};

function formatTrashKind(kind: TrashItem['kind']): string {
  if (kind === 'journey') return '旅程';
  if (kind === 'media') return '影像';
  return '密匣文件';
}

export function OpsAdminPanel({
  mode,
  trash,
  onRefresh,
  onStatus,
  onError,
}: OpsAdminPanelProps) {
  const [usage, setUsage] = useState<UsageLimitsSummary | null>(null);
  const [security, setSecurity] = useState<SecuritySnapshot | null>(null);

  // Trash 2-step purge confirmation state
  const [confirmPurgeKey, setConfirmPurgeKey] = useState<string | null>(null);
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);
  const [purging, setPurging] = useState(false);

  // Security: password change
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Security: policy form
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const [retentionDays, setRetentionDays] = useState<SecurityPolicy['retentionDays']>(30);
  const [requestsPerMinute, setRequestsPerMinute] = useState(180);
  const [savingPolicy, setSavingPolicy] = useState(false);

  // Security: manual IP block form
  const [blockIp, setBlockIp] = useState('');
  const [blockReason, setBlockReason] = useState('');
  const [submittingBlock, setSubmittingBlock] = useState(false);

  const loadUsage = useCallback(async () => {
    try {
      const snap = await apiJson<UsageLimitsSummary>('/api/admin/usage');
      setUsage(snap);
    } catch {
      /* Auth boundary handles 401 */
    }
  }, []);

  const loadSecurity = useCallback(async () => {
    try {
      const snap = await apiJson<SecuritySnapshot>('/api/security');
      setSecurity(snap);
      setRecordingEnabled(snap.policy.recordingEnabled);
      setRetentionDays(snap.policy.retentionDays);
      setRequestsPerMinute(snap.policy.requestsPerMinute);
    } catch {
      /* Auth boundary handles 401 */
    }
  }, []);

  useEffect(() => {
    if (mode === 'usage') {
      void loadUsage();
    } else {
      void loadSecurity();
    }
  }, [mode, trash.length, loadUsage, loadSecurity]);

  const counterValue = (key: string) => usage?.counters.find((c) => c.key === key)?.value ?? 0;

  const restoreTrash = async (key: string) => {
    onError('');
    try {
      await apiJson('/api/admin/restore', { method: 'POST', json: { key } });
      setConfirmPurgeKey(null);
      await onRefresh();
      onStatus('已从回收站恢复。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '恢复失败');
    }
  };

  const purgeTrash = async (payload: { key: string } | { all: true }) => {
    setPurging(true);
    onError('');
    try {
      const res = await apiJson<PurgeResult>('/api/admin/trash/purge', {
        method: 'POST',
        json: payload,
      });
      setConfirmPurgeKey(null);
      setConfirmPurgeAll(false);
      await Promise.all([onRefresh(), loadUsage()]);
      const deletedCount = Array.isArray(res.deletedR2Keys)
        ? res.deletedR2Keys.length
        : typeof res.deletedR2Keys === 'number'
          ? res.deletedR2Keys
          : 0;
      const purgedCount = res.purged ?? 1;
      onStatus(
        'all' in payload
          ? `已清空回收站（销毁 ${purgedCount} 项记录，清理 ${deletedCount} 个 R2 对象）。`
          : `已彻底销毁该项记录并清理 ${deletedCount} 个关联 R2 对象。`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : '彻底销毁失败');
    } finally {
      setPurging(false);
    }
  };

  const revokeSession = async (id: string) => {
    onError('');
    try {
      await apiJson('/api/security/sessions', { method: 'DELETE', json: { id } });
      await loadSecurity();
      onStatus('已注销指定会话。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '注销会话失败');
    }
  };

  const handlePasswordSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!oldPassword) {
      onError('请输入当前管理口令。');
      return;
    }
    if (newPassword.length < 8) {
      onError('新口令长度需不少于 8 个字符。');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      onError('两次输入的新口令不一致。');
      return;
    }
    setSavingPassword(true);
    onError('');
    try {
      await apiJson('/api/security/auth', {
        method: 'POST',
        json: {
          action: 'password',
          oldPassword,
          newPassword,
        },
      });
      setOldPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      notifyAuthChange('password');
      await loadSecurity();
      onStatus('管理口令已更新，其余旧会话已自动失效。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '修改管理口令失败');
    } finally {
      setSavingPassword(false);
    }
  };

  const handlePolicySubmit = async (event: FormEvent) => {
    event.preventDefault();
    const rpm = Math.round(Number(requestsPerMinute));
    if (!Number.isInteger(rpm) || rpm < 10 || rpm > 600) {
      onError('每分钟请求上限需为 10～600 之间的整数。');
      return;
    }
    setSavingPolicy(true);
    onError('');
    try {
      const updated = await apiJson<SecurityPolicy>('/api/security', {
        method: 'PATCH',
        json: {
          recordingEnabled,
          retentionDays,
          requestsPerMinute: rpm,
        },
      });
      setSecurity((prev) => (prev ? { ...prev, policy: updated } : prev));
      onStatus('安全策略已保存。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '更新安全策略失败');
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleBlockRule = async (
    type: 'ip' | 'visitor',
    value: string,
    reason: string,
  ) => {
    const trimmed = value.trim();
    if (!trimmed) {
      onError('请输入要封禁的目标地址或访客标识。');
      return;
    }
    setSubmittingBlock(true);
    onError('');
    try {
      await apiJson('/api/security/block', {
        method: 'POST',
        json: {
          action: 'block',
          type,
          value: trimmed,
          reason: reason.trim() || '整理台手动限制',
        },
      });
      if (type === 'ip') {
        setBlockIp('');
        setBlockReason('');
      }
      await loadSecurity();
      onStatus(`已添加封禁规则（${type === 'ip' ? trimmed : trimmed.slice(0, 12)}）。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '添加封禁规则失败');
    } finally {
      setSubmittingBlock(false);
    }
  };

  const handleUnblock = async (type: 'ip' | 'visitor', value: string) => {
    onError('');
    try {
      await apiJson('/api/security/block', {
        method: 'DELETE',
        json: { type, value },
      });
      await loadSecurity();
      onStatus('已解除该封禁规则。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '解除封禁失败');
    }
  };

  if (mode === 'usage') {
    const month = usage?.month ?? new Date().toISOString().slice(0, 7);
    const uploadBytesUsed = counterValue('r2-upload-bytes:lifetime');
    const uploadBytesCap = usage?.limits.uploadBytes ?? 2 * 1024 * 1024 * 1024;
    const apiUsed = counterValue(`api-requests:${month}`);
    const apiCap = usage?.limits.apiRequests ?? 200_000;
    const classAUsed = counterValue(`r2-class-a:${month}`);
    const classACap = usage?.limits.classA ?? 10_000;
    const classBUsed = counterValue(`r2-class-b:${month}`);
    const classBCap = usage?.limits.classB ?? 100_000;

    const items = [
      {
        label: '累计上传容量（终身上限）',
        usedLabel: `${(uploadBytesUsed / (1024 * 1024)).toFixed(2)} MiB`,
        capLabel: `${Math.round(uploadBytesCap / (1024 * 1024)).toLocaleString('en-US')} MiB (2 GiB)`,
        pct: uploadBytesCap > 0 ? Math.min(100, (uploadBytesUsed / uploadBytesCap) * 100) : 0,
      },
      {
        label: '本月 API 请求次数',
        usedLabel: apiUsed.toLocaleString('en-US'),
        capLabel: apiCap.toLocaleString('en-US'),
        pct: apiCap > 0 ? Math.min(100, (apiUsed / apiCap) * 100) : 0,
      },
      {
        label: '本月 R2 写入/列表（A 类）',
        usedLabel: classAUsed.toLocaleString('en-US'),
        capLabel: classACap.toLocaleString('en-US'),
        pct: classACap > 0 ? Math.min(100, (classAUsed / classACap) * 100) : 0,
      },
      {
        label: '本月 R2 读取（B 类）',
        usedLabel: classBUsed.toLocaleString('en-US'),
        capLabel: classBCap.toLocaleString('en-US'),
        pct: classBCap > 0 ? Math.min(100, (classBUsed / classBCap) * 100) : 0,
      },
    ];

    return (
      <div className="space-y-8">
        <section className="rounded-[20px] bg-surface p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="m-0 text-[18px] font-medium text-ink">云端硬预算熔断与用量监控</h2>
            <a href="/api/admin/backup" download className="pill-cta-primary">
              <Download className="h-4 w-4" aria-hidden="true" />
              <span>导出完整备份 (ZIP)</span>
            </a>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {items.map((item) => {
              const warning = item.pct >= 80;
              return (
                <div
                  key={item.label}
                  className="rounded-[16px] border border-hairline bg-paper p-4"
                >
                  <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-muted">
                    <span>{item.label}</span>
                    <span
                      className={[
                        'tabular-nums-mono shrink-0 text-[11.5px] font-medium',
                        warning ? 'text-postmark' : 'text-ink-muted',
                      ].join(' ')}
                    >
                      {item.pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="tabular-nums-mono mt-1.5 text-[20px] font-medium text-ink">
                    {item.usedLabel}
                  </div>
                  <div
                    role="progressbar"
                    aria-label={item.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(item.pct)}
                    className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-surface"
                  >
                    <div
                      className={[
                        'h-full rounded-full transition-[width] duration-300',
                        warning ? 'bg-postmark' : 'bg-accent',
                      ].join(' ')}
                      style={{ width: `${Math.max(item.pct > 0 ? 2 : 0, item.pct)}%` }}
                    />
                  </div>
                  <div className="tabular-nums-mono mt-1.5 text-[11.5px] text-ink-muted">
                    熔断上限 {item.capLabel}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-[20px] bg-surface p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="m-0 text-[18px] font-medium text-ink">回收站</h2>
              <p className="mt-1 mb-0 text-[12.5px] text-ink-muted">
                软删除记录仍保留 R2 原始文件以便随时恢复；彻底销毁后将同步释放存储空间且不可撤销。
              </p>
            </div>
            {trash.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                {confirmPurgeAll ? (
                  <>
                    <button
                      type="button"
                      disabled={purging}
                      onClick={() => void purgeTrash({ all: true })}
                      className="min-h-[34px] rounded-full bg-postmark px-4 text-[12.5px] font-medium text-white disabled:opacity-50"
                    >
                      {purging ? '正在清空…' : `确认清空全部 (${trash.length} 项)`}
                    </button>
                    <button
                      type="button"
                      disabled={purging}
                      onClick={() => setConfirmPurgeAll(false)}
                      className="min-h-[34px] rounded-full bg-page px-3.5 text-[12.5px] text-ink-muted"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmPurgeKey(null);
                      setConfirmPurgeAll(true);
                    }}
                    className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-page px-3.5 text-[12.5px] text-postmark hover:bg-surface-hover"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>清空回收站</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {trash.length === 0 ? (
            <p className="mt-3 mb-0 text-[13px] text-ink-muted">回收站为空。</p>
          ) : (
            <div className="mt-4 max-h-[480px] space-y-2.5 overflow-y-auto pr-1">
              {trash.map((t) => {
                const confirmingThis = confirmPurgeKey === t.key;
                return (
                  <div
                    key={t.key}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-hairline bg-paper px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-ink">{t.label}</div>
                      <div className="tabular-nums-mono text-[12px] text-ink-muted">
                        {formatTrashKind(t.kind)} ({t.kind}) · 删除于{' '}
                        {t.removedAt.slice(0, 16).replace('T', ' ')}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void restoreTrash(t.key)}
                        className="inline-flex min-h-[34px] items-center gap-1 rounded-full bg-surface px-3.5 text-[12.5px] text-ink hover:bg-surface-hover"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>恢复</span>
                      </button>
                      {confirmingThis ? (
                        <>
                          <button
                            type="button"
                            disabled={purging}
                            onClick={() => void purgeTrash({ key: t.key })}
                            className="min-h-[34px] rounded-full bg-postmark px-3.5 text-[12.5px] font-medium text-white disabled:opacity-50"
                          >
                            确认销毁
                          </button>
                          <button
                            type="button"
                            disabled={purging}
                            onClick={() => setConfirmPurgeKey(null)}
                            className="min-h-[34px] rounded-full bg-surface px-3 text-[12.5px] text-ink-muted"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmPurgeAll(false);
                            setConfirmPurgeKey(t.key);
                          }}
                          className="inline-flex min-h-[34px] items-center gap-1 rounded-full bg-surface px-3.5 text-[12.5px] text-postmark hover:bg-surface-hover"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>彻底销毁</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    );
  }

  const nonAuthVisitors = security?.visitors.filter((v) => !v.authenticated) ?? [];
  const recentEvents = security?.events.slice(0, 20) ?? [];

  return (
    <div className="space-y-8">
      {/* Totals & Active Sessions */}
      <section className="rounded-[20px] bg-surface p-6">
        <h2 className="m-0 text-[18px] font-medium text-ink">当前管理员会话与安全概览</h2>
        {security ? (
          <>
            <div className="tabular-nums-mono mt-4 grid gap-3 sm:grid-cols-4">
              <div className="rounded-[14px] border border-hairline bg-paper p-3.5">
                <div className="text-[12px] text-ink-muted">累计请求</div>
                <div className="mt-1 text-[18px] font-medium text-ink">
                  {security.totals.requests}
                </div>
              </div>
              <div className="rounded-[14px] border border-hairline bg-paper p-3.5">
                <div className="text-[12px] text-ink-muted">独立访客</div>
                <div className="mt-1 text-[18px] font-medium text-ink">
                  {security.totals.visitors}
                </div>
              </div>
              <div className="rounded-[14px] border border-hairline bg-paper p-3.5">
                <div className="text-[12px] text-ink-muted">拦截拒绝</div>
                <div className="mt-1 text-[18px] font-medium text-ink">
                  {security.totals.denied}
                </div>
              </div>
              <div className="rounded-[14px] border border-hairline bg-paper p-3.5">
                <div className="text-[12px] text-ink-muted">登录失败</div>
                <div className="mt-1 text-[18px] font-medium text-ink">
                  {security.totals.failedLogins}
                </div>
              </div>
            </div>

            <div className="mt-5 max-h-[360px] space-y-2 overflow-y-auto pr-1">
              {security.sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-hairline bg-paper px-4 py-3"
                >
                  <div className="text-[13px] text-ink">
                    {s.device.browser} · {s.device.os}{' '}
                    <span className="tabular-nums-mono text-ink-muted">({s.address})</span>
                    {s.current && <span className="ml-2 text-[12px] text-accent">当前会话</span>}
                  </div>
                  {!s.current && (
                    <button
                      type="button"
                      onClick={() => void revokeSession(s.id)}
                      className="min-h-[32px] rounded-full bg-surface px-3 text-[12px] text-postmark hover:bg-surface-hover"
                    >
                      注销会话
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-3 mb-0 text-[13px] text-ink-muted">正在加载安全概览……</p>
        )}
      </section>

      {/* Password & Policy Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Change Admin Password */}
        <section className="rounded-[20px] bg-surface p-6">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-accent" aria-hidden="true" />
            <h2 className="m-0 text-[17px] font-medium text-ink">修改管理口令</h2>
          </div>
          <p className="mt-1.5 mb-0 text-[12.5px] text-ink-muted">
            新口令长度至少 8 位；修改成功后将签发新会话并注销其他设备的登录态。
          </p>

          <form onSubmit={handlePasswordSubmit} className="mt-4 space-y-3">
            <label className="block text-[12.5px] text-ink-muted">
              当前口令
              <input
                type="password"
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="输入当前管理口令"
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
              />
            </label>
            <label className="block text-[12.5px] text-ink-muted">
              新口令（至少 8 位）
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="设置新的管理员口令"
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
              />
            </label>
            <label className="block text-[12.5px] text-ink-muted">
              确认新口令
              <input
                type="password"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                placeholder="再次输入新口令"
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
              />
            </label>
            <button
              type="submit"
              disabled={savingPassword}
              className="pill-cta-primary"
            >
              {savingPassword ? '正在更新…' : '更新管理口令'}
            </button>
          </form>
        </section>

        {/* Security Policy Switches */}
        <section className="rounded-[20px] bg-surface p-6">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-accent" aria-hidden="true" />
            <h2 className="m-0 text-[17px] font-medium text-ink">安全策略开关</h2>
          </div>
          <p className="mt-1.5 mb-0 text-[12.5px] text-ink-muted">
            调整访问日志记录、数据保留周期及单访客每分钟速率上限。
          </p>

          <form onSubmit={handlePolicySubmit} className="mt-4 space-y-4">
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-[14px] border border-hairline bg-paper px-4 py-3">
              <div>
                <div className="text-[13.5px] font-medium text-ink">记录访客访问事件</div>
                <div className="text-[12px] text-ink-muted">
                  关闭后仍会记录登录认证、拦截拒绝与策略变更事件
                </div>
              </div>
              <input
                type="checkbox"
                checked={recordingEnabled}
                onChange={(e) => setRecordingEnabled(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[12.5px] text-ink-muted">
                事件保留周期
                <select
                  value={retentionDays}
                  onChange={(e) =>
                    setRetentionDays(Number(e.target.value) as SecurityPolicy['retentionDays'])
                  }
                  className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
                >
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                </select>
              </label>
              <label className="text-[12.5px] text-ink-muted">
                单访客每分钟请求上限 (10–600)
                <input
                  type="number"
                  min={10}
                  max={600}
                  value={requestsPerMinute}
                  onChange={(e) => setRequestsPerMinute(Number(e.target.value))}
                  className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
                />
              </label>
            </div>

            <button type="submit" disabled={savingPolicy} className="pill-cta-primary">
              {savingPolicy ? '正在保存…' : '保存安全策略'}
            </button>
          </form>
        </section>
      </div>

      {/* Block Rules & Visitors Management */}
      <section className="rounded-[20px] bg-surface p-6">
        <div className="flex items-center gap-2">
          <ShieldBan className="h-4 w-4 text-postmark" aria-hidden="true" />
          <h2 className="m-0 text-[18px] font-medium text-ink">封禁规则管理</h2>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleBlockRule('ip', blockIp, blockReason);
          }}
          className="mt-4 flex flex-wrap items-end gap-2.5 rounded-[16px] border border-hairline bg-paper p-4"
        >
          <label className="min-w-[180px] flex-1 text-[12px] text-ink-muted">
            公网 IP 地址
            <input
              type="text"
              value={blockIp}
              onChange={(e) => setBlockIp(e.target.value)}
              placeholder="例如 203.0.113.10 或公网 IPv4/IPv6"
              className="tabular-nums-mono mt-1 block w-full rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[13px] text-ink"
            />
          </label>
          <label className="min-w-[180px] flex-1 text-[12px] text-ink-muted">
            封禁原因（可选）
            <input
              type="text"
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
              placeholder="高频异常探测 / 手动限制"
              className="mt-1 block w-full rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[13px] text-ink"
            />
          </label>
          <button
            type="submit"
            disabled={submittingBlock}
            className="min-h-[36px] rounded-full bg-cta-bg px-4 text-[13px] font-medium text-cta-text disabled:opacity-50"
          >
            封禁 IP
          </button>
        </form>

        {/* Active block rules */}
        <div className="mt-4">
          <h3 className="m-0 mb-2.5 text-[13.5px] font-medium text-ink">
            生效中的封禁规则 ({security?.blocks.length ?? 0})
          </h3>
          {!security || security.blocks.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-muted">当前无封禁规则。</p>
          ) : (
            <div className="space-y-2">
              {security.blocks.map((b) => (
                <div
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-hairline bg-paper px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-postmark">
                        {b.type === 'ip' ? 'IP' : '访客'}
                      </span>
                      <span className="tabular-nums-mono break-all text-[13px] font-medium text-ink">
                        {b.type === 'visitor' ? `${b.value.slice(0, 16)}…` : b.value}
                      </span>
                    </div>
                    <div className="tabular-nums-mono mt-0.5 text-[12px] text-ink-muted">
                      {b.reason || '手动限制'} · {b.createdAt.slice(0, 16).replace('T', ' ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleUnblock(b.type, b.value)}
                    className="min-h-[32px] rounded-full bg-surface px-3.5 text-[12px] font-medium text-ink hover:bg-surface-hover"
                  >
                    解除封禁
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Non-authenticated recent visitors quick-block */}
        {nonAuthVisitors.length > 0 && (
          <div className="mt-5 border-t border-hairline pt-4">
            <h3 className="m-0 mb-2.5 text-[13.5px] font-medium text-ink">
              近期未登录访客（快捷处置）
            </h3>
            <div className="space-y-2">
              {nonAuthVisitors.slice(0, 12).map((v) => (
                <div
                  key={v.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-hairline bg-paper px-4 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                      <span className="tabular-nums-mono font-medium">{v.address}</span>
                      <span className="text-ink-muted">
                        {v.device.browser} · {v.device.os}
                      </span>
                    </div>
                    <div className="tabular-nums-mono text-[11.5px] text-ink-muted">
                      请求 {v.requests} · 拒绝 {v.denied} · 最近 {v.lastSeen.slice(0, 16).replace('T', ' ')}
                    </div>
                  </div>
                  {v.blocked ? (
                    <span className="rounded-full bg-surface px-3 py-1 text-[11.5px] text-postmark">
                      已封禁
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={submittingBlock}
                      onClick={() => void handleBlockRule('visitor', v.id, '整理台快捷封禁')}
                      className="min-h-[30px] rounded-full bg-surface px-3 text-[12px] text-postmark hover:bg-surface-hover disabled:opacity-40"
                    >
                      封禁访客
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Recent Security Events Timeline */}
      <section className="rounded-[20px] bg-surface p-6">
        <h2 className="m-0 text-[18px] font-medium text-ink">近期安全事件时间线</h2>
        <p className="mt-1 mb-0 text-[12.5px] text-ink-muted">展示最新 20 条审计记录。</p>

        {recentEvents.length === 0 ? (
          <p className="mt-3 mb-0 text-[13px] text-ink-muted">暂无近期安全事件。</p>
        ) : (
          <div className="mt-4 max-h-[440px] space-y-2 overflow-y-auto pr-1">
            {recentEvents.map((ev) => {
              const isErrorStatus = ev.status >= 400;
              return (
                <div
                  key={ev.id}
                  className="flex flex-col gap-1 rounded-[14px] border border-hairline bg-paper px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                      <span
                        className={[
                          'tabular-nums-mono rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium',
                          isErrorStatus ? 'text-postmark' : 'text-accent',
                        ].join(' ')}
                      >
                        {ev.status}
                      </span>
                      <span className="tabular-nums-mono font-medium text-ink">{ev.method}</span>
                      <span className="tabular-nums-mono break-all text-ink">{ev.path}</span>
                    </div>
                    {ev.reasons.length > 0 && (
                      <div className="mt-0.5 text-[12px] text-postmark">
                        {ev.reasons.join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="tabular-nums-mono shrink-0 text-[11.5px] text-ink-muted sm:text-right">
                    <div>
                      {ev.address} · {ev.device.browser} / {ev.device.os}
                    </div>
                    <div>{ev.at.slice(0, 19).replace('T', ' ')}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
