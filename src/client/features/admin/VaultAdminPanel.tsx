import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Copy, Trash2 } from 'lucide-react';
import type { VaultFileRecord, VaultShareSummary } from '../../../shared/types';
import { apiJson } from '../../lib/api';
import { qrToSvgPath } from '../../lib/qr-svg';
import { VaultUploader } from '../vault/VaultUploader';

type VaultAdminPanelProps = {
  files: VaultFileRecord[];
  onRefresh: () => Promise<void>;
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
};

type ShareFilter = 'all' | 'active' | 'inactive';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function isShareActive(share: VaultShareSummary, nowMs: number): boolean {
  if (share.revokedAt) return false;
  if (share.downloads >= share.maxDownloads) return false;
  const expMs = Date.parse(share.expiresAt);
  if (Number.isFinite(expMs) && expMs <= nowMs) return false;
  return true;
}

function shareStatusText(share: VaultShareSummary, nowMs: number): string {
  if (share.revokedAt) return '已撤销（墓碑留存）';
  if (share.downloads >= share.maxDownloads) return '次数已用尽';
  const expMs = Date.parse(share.expiresAt);
  if (Number.isFinite(expMs) && expMs <= nowMs) return '已过期';
  return '生效中';
}

async function copyClaimSlipText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall back to textarea copy */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function VaultAdminPanel({
  files,
  onRefresh,
  onStatus,
  onError,
}: VaultAdminPanelProps) {
  const [shares, setShares] = useState<VaultShareSummary[]>([]);
  const [shareFilter, setShareFilter] = useState<ShareFilter>('all');
  const [selectedFileId, setSelectedFileId] = useState(files[0]?.id ?? '');
  const [maxDownloads, setMaxDownloads] = useState('5');
  const [expiresHours, setExpiresHours] = useState('24');
  const [customPasscode, setCustomPasscode] = useState('');
  const [note, setNote] = useState('');
  const [copiedSlip, setCopiedSlip] = useState(false);
  const [trashingId, setTrashingId] = useState<string | null>(null);
  const [latestIssued, setLatestIssued] = useState<{
    passcode: string;
    share: VaultShareSummary;
  } | null>(null);

  const loadShares = async () => {
    try {
      const res = await apiJson<{ shares: VaultShareSummary[]; files: VaultFileRecord[] }>(
        '/api/vault/shares',
      );
      setShares(res.shares);
      if (!selectedFileId && res.files[0]) {
        setSelectedFileId(res.files[0].id);
      }
    } catch {
      /* Handled by parent auth boundary */
    }
  };

  useEffect(() => {
    void loadShares();
  }, [files.length]);

  useEffect(() => {
    if (!files.some((f) => f.id === selectedFileId)) {
      setSelectedFileId(files[0]?.id ?? '');
    }
  }, [files, selectedFileId]);

  const handleTrashFile = async (file: VaultFileRecord) => {
    setTrashingId(file.id);
    onError('');
    try {
      await apiJson('/api/admin/trash', {
        method: 'POST',
        json: { kind: 'vault_file', id: file.id },
      });
      await Promise.all([loadShares(), onRefresh()]);
      onStatus(`已将密匣文件「${file.name}」移入回收站。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '移入回收站失败');
    } finally {
      setTrashingId(null);
    }
  };

  const handleCreateShare = async (event: FormEvent) => {
    event.preventDefault();
    const targetId = selectedFileId || files[0]?.id;
    if (!targetId) {
      onError('请先上传一个密匣文件。');
      return;
    }
    onError('');
    try {
      const res = await apiJson<{ share: VaultShareSummary; passcode: string }>(
        '/api/vault/shares',
        {
          method: 'POST',
          json: {
            fileId: targetId,
            maxDownloads: Number(maxDownloads) || 5,
            expiresIn: Math.max(60, Math.round((Number(expiresHours) || 24) * 3600)),
            ...(customPasscode.trim() ? { passcode: customPasscode.trim() } : {}),
            note: note.trim(),
          },
        },
      );
      setLatestIssued(res);
      setCopiedSlip(false);
      setCustomPasscode('');
      setNote('');
      await Promise.all([loadShares(), onRefresh()]);
      onStatus(`已生成分享口令：${res.passcode}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '生成分享失败');
    }
  };

  const handleRevoke = async (shareId: string) => {
    onError('');
    try {
      await apiJson(`/api/vault/shares/${encodeURIComponent(shareId)}/revoke`, {
        method: 'POST',
        json: {},
      });
      await loadShares();
      onStatus('已撤销该分享并保留墓碑记录。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '撤销分享失败');
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const directClaimUrl = latestIssued
    ? `${origin}/vault?code=${encodeURIComponent(latestIssued.passcode)}`
    : '';
  const issuedQr = directClaimUrl ? qrToSvgPath(directClaimUrl) : null;

  const handleCopyClaimSlip = async () => {
    if (!latestIssued) return;
    const lines = [
      '【文件密匣取件签条】',
      `文件：${latestIssued.share.fileName}`,
      `6 位取件口令：${latestIssued.passcode}`,
      `直达链接：${directClaimUrl}`,
      `有效次数：${latestIssued.share.maxDownloads} 次 · 到期：${latestIssued.share.expiresAt.slice(0, 16).replace('T', ' ')}`,
    ];
    if (latestIssued.share.note) {
      lines.push(`附言：${latestIssued.share.note}`);
    }
    const ok = await copyClaimSlipText(lines.join('\n'));
    if (ok) {
      setCopiedSlip(true);
      onStatus('已复制取件签条到剪贴板。');
      window.setTimeout(() => setCopiedSlip(false), 2500);
    } else {
      onError('剪贴板复制失败，请手动复制口令与链接。');
    }
  };

  const nowMs = Date.now();
  const { activeCount, inactiveCount, filteredShares } = useMemo(() => {
    const active: VaultShareSummary[] = [];
    const inactive: VaultShareSummary[] = [];
    for (const share of shares) {
      if (isShareActive(share, nowMs)) active.push(share);
      else inactive.push(share);
    }
    const list =
      shareFilter === 'active'
        ? active
        : shareFilter === 'inactive'
          ? inactive
          : shares;
    return {
      activeCount: active.length,
      inactiveCount: inactive.length,
      filteredShares: list,
    };
  }, [shares, shareFilter, nowMs]);

  return (
    <div className="space-y-8">
      <VaultUploader
        onUploaded={(file) => {
          setSelectedFileId(file.id);
          void Promise.all([loadShares(), onRefresh()]);
        }}
      />

      <section className="rounded-[20px] bg-surface p-6">
        <h2 className="m-0 text-[18px] font-medium text-ink">已存密匣文件</h2>
        {files.length === 0 ? (
          <p className="mt-3 mb-0 text-[13px] text-ink-muted">暂无密匣文件，请先分片上传。</p>
        ) : (
          <div
            className="mt-4 grid gap-2.5 sm:grid-cols-2"
            role="radiogroup"
            aria-label="选择要分享的密匣文件"
          >
            {files.map((f) => {
              const selected = (selectedFileId || files[0]?.id) === f.id;
              return (
                <div
                  key={f.id}
                  className={[
                    'flex items-start justify-between gap-2.5 rounded-[14px] px-4 py-3 transition-colors',
                    selected
                      ? 'border border-accent bg-paper'
                      : 'border border-hairline bg-paper/70 hover:bg-surface-hover',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSelectedFileId(f.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-[13.5px] font-medium text-ink">
                        {f.name}
                      </span>
                      <span
                        className={[
                          'shrink-0 rounded-full bg-surface px-2.5 py-0.5 text-[11.5px]',
                          f.visibility === 'private' ? 'text-ink-muted' : 'text-accent',
                        ].join(' ')}
                      >
                        {f.visibility === 'private' ? '私密' : '已分享'}
                      </span>
                    </div>
                    <div className="tabular-nums-mono mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-ink-muted">
                      <span>{formatBytes(f.size)}</span>
                      <span>{f.createdAt.slice(0, 16).replace('T', ' ')}</span>
                      <span title={`SHA-256: ${f.sha256}`}>SHA-256 {f.sha256.slice(0, 12)}</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    disabled={trashingId === f.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleTrashFile(f);
                    }}
                    className="inline-flex min-h-[30px] shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 text-[11.5px] text-ink-muted hover:bg-surface-hover hover:text-postmark disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>移入回收站</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-[20px] bg-surface p-6">
        <h2 className="m-0 text-[18px] font-medium text-ink">生成口令分享票据</h2>
        <form onSubmit={handleCreateShare} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-[12.5px] text-ink-muted">
            有效期（小时）
            <input
              type="number"
              min={1}
              max={8760}
              value={expiresHours}
              onChange={(e) => setExpiresHours(e.target.value)}
              className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            次数上限
            <input
              type="number"
              min={1}
              max={999}
              value={maxDownloads}
              onChange={(e) => setMaxDownloads(e.target.value)}
              className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            自定义 6 位口令（可选）
            <input
              type="text"
              maxLength={6}
              value={customPasscode}
              onChange={(e) => setCustomPasscode(e.target.value)}
              placeholder="留空自动生成"
              className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            签条附言（可选）
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="一句说明"
              className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" className="pill-cta-primary">
              生成分享口令
            </button>
          </div>
        </form>

        {latestIssued && issuedQr && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-[18px] border border-hairline bg-paper p-5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink-muted">新分享口令</div>
              <div className="tabular-nums-mono mt-1 text-[24px] font-medium tracking-[0.14em] text-ink">
                {latestIssued.passcode}
              </div>
              <div className="mt-1 text-[12.5px] text-postmark">
                {latestIssued.share.fileName} · 上限 {latestIssued.share.maxDownloads} 次
              </div>
              <div className="tabular-nums-mono mt-1.5 break-all text-[12px] text-ink-muted">
                {directClaimUrl}
              </div>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void handleCopyClaimSlip()}
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-surface px-3.5 text-[12.5px] font-medium text-ink hover:bg-surface-hover"
                >
                  {copiedSlip ? (
                    <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>{copiedSlip ? '已复制取件签条' : '复制取件签条'}</span>
                </button>
              </div>
            </div>
            <div className="shrink-0 rounded-[12px] bg-white p-2">
              <svg
                viewBox={issuedQr.viewBox}
                width={88}
                height={88}
                role="img"
                aria-label="新生成密匣口令二维码"
              >
                <rect width={issuedQr.dimension} height={issuedQr.dimension} fill="#ffffff" />
                <path d={issuedQr.path} fill="#1f1f1f" />
              </svg>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-[20px] bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-[18px] font-medium text-ink">分享记录与撤销墓碑</h2>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="筛选分享记录">
            {(
              [
                { id: 'all', label: `全部 (${shares.length})` },
                { id: 'active', label: `生效中 (${activeCount})` },
                { id: 'inactive', label: `已失效或撤销 (${inactiveCount})` },
              ] as const
            ).map((pill) => {
              const active = shareFilter === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setShareFilter(pill.id)}
                  className={[
                    'tabular-nums-mono min-h-[30px] rounded-full px-3 text-[12px] transition-colors',
                    active
                      ? 'bg-cta-bg font-medium text-cta-text'
                      : 'bg-page text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  {pill.label}
                </button>
              );
            })}
          </div>
        </div>

        {filteredShares.length === 0 ? (
          <p className="mt-3 mb-0 text-[13px] text-ink-muted">
            {shares.length === 0 ? '暂无分享记录。' : '当前筛选条件下没有分享记录。'}
          </p>
        ) : (
          <div className="mt-4 space-y-2.5">
            {filteredShares.map((s) => {
              const active = isShareActive(s, nowMs);
              const statusLabel = shareStatusText(s, nowMs);
              return (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-hairline bg-paper px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-ink">{s.fileName}</span>
                      <span
                        className={[
                          'rounded-full bg-surface px-2 py-0.5 text-[11px]',
                          active ? 'text-accent' : 'text-ink-muted',
                        ].join(' ')}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    {s.note && (
                      <div className="font-editorial-serif mt-0.5 text-[12.5px] text-postmark">
                        {s.note}
                      </div>
                    )}
                    <div className="tabular-nums-mono mt-0.5 text-[12px] text-ink-muted">
                      已提取 {s.downloads} / {s.maxDownloads} · 到期{' '}
                      {s.expiresAt.slice(0, 16).replace('T', ' ')}
                      {s.revokedAt ? ' · 已撤销（墓碑留存）' : ''}
                    </div>
                  </div>
                  {!s.revokedAt && (
                    <button
                      type="button"
                      onClick={() => void handleRevoke(s.id)}
                      className="min-h-[34px] rounded-full bg-surface px-3.5 text-[12.5px] font-medium text-postmark hover:bg-surface-hover"
                    >
                      撤销
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
