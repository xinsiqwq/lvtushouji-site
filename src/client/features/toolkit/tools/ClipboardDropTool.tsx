import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  Clock,
  Copy,
  Download,
  Flame,
  KeyRound,
  Link2,
  Send,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import type {
  ClipboardClaimResponse,
  ClipboardCreateRequest,
  ClipboardCreateResponse,
} from '../../../../shared/types';
import { apiJson } from '../../../lib/api';
import { createCardPointerHandlers, createMagneticHandlers } from '../../../lib/pointer-fx';
import { qrToSvgPath } from '../../../lib/qr-svg';
import { useRouter } from '../../../lib/router';

type Mode = 'send' | 'claim';

const MAX_BYTES = 32_768;
const CODE_RE = /^[A-Za-z0-9]{6}$/;

const TTL_PRESETS = [
  { label: '10 分钟', seconds: 600 },
  { label: '1 小时', seconds: 3600 },
  { label: '24 小时', seconds: 86_400 },
] as const;

const VIEW_PRESETS = [3, 5, 10, 20] as const;

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function formatByteCount(bytes: number): string {
  return bytes.toLocaleString('en-US');
}

function formatCountdown(expiresAt: string, nowMs: number): string {
  const diff = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(diff) || diff <= 0) return '已到期';
  const totalSeconds = Math.floor(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `剩余 ${hours} 小时 ${mins} 分`;
  if (mins > 0) return `剩余 ${mins} 分 ${secs} 秒`;
  return `剩余 ${secs} 秒`;
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
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

export default function ClipboardDropTool() {
  const { search } = useRouter();

  const [mode, setMode] = useState<Mode>(() => {
    const params = new URLSearchParams(search);
    const urlCode = (params.get('code') || params.get('c') || '').trim();
    return CODE_RE.test(urlCode) ? 'claim' : 'send';
  });

  // Send state
  const [content, setContent] = useState('');
  const [ttlSeconds, setTtlSeconds] = useState<number>(3600);
  const [burnAfterRead, setBurnAfterRead] = useState<boolean>(true);
  const [maxViews, setMaxViews] = useState<number>(5);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createdSlip, setCreatedSlip] = useState<ClipboardCreateResponse | null>(null);
  const [destroying, setDestroying] = useState(false);
  const [destroyedCode, setDestroyedCode] = useState<string | null>(null);

  // Claim state
  const [claimCode, setClaimCode] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState('');
  const [claimedSlip, setClaimedSlip] = useState<ClipboardClaimResponse | null>(null);

  // Copy feedback + live countdown tick
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const copyTimerRef = useRef<number | null>(null);
  const autoClaimedCodeRef = useRef<string | null>(null);

  const cardHandlers = createCardPointerHandlers();
  const magneticHandlers = createMagneticHandlers(4);

  const byteCount = useMemo(() => utf8ByteLength(content), [content]);
  const isOverLimit = byteCount > MAX_BYTES;
  const usagePct = Math.min(100, (byteCount / MAX_BYTES) * 100);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!createdSlip && !claimedSlip) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [createdSlip, claimedSlip]);

  const triggerCopied = useCallback((key: string) => {
    setCopiedKey(key);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopiedKey(null), 2000);
  }, []);

  const handleCopy = useCallback(
    async (key: string, text: string) => {
      const ok = await copyTextSafe(text);
      if (ok) triggerCopied(key);
    },
    [triggerCopied],
  );

  const claimClipboard = useCallback(async (rawInput: string) => {
    const normalized = rawInput.trim().toUpperCase();
    if (!CODE_RE.test(normalized)) {
      setClaimError('请输入完整的 6 位字母或数字闪传口令。');
      return;
    }

    setClaiming(true);
    setClaimError('');
    try {
      const data = await apiJson<ClipboardClaimResponse>(
        `/api/clipboard/${encodeURIComponent(normalized)}`,
        {
          method: 'GET',
          cache: 'no-store',
        },
      );
      setClaimedSlip(data);
      setNowMs(Date.now());
    } catch (err) {
      setClaimedSlip(null);
      setClaimError(err instanceof Error ? err.message : '闪传口令不存在或已失效。');
    } finally {
      setClaiming(false);
    }
  }, []);

  // Inspect ?code= or ?c= on mount/search update and auto-claim once (never looping on error)
  useEffect(() => {
    const params = new URLSearchParams(search);
    const rawCode = (params.get('code') || params.get('c') || '').trim();
    if (!CODE_RE.test(rawCode)) return;
    const normalized = rawCode.toUpperCase();
    if (autoClaimedCodeRef.current === normalized) return;
    autoClaimedCodeRef.current = normalized;
    setMode('claim');
    setClaimCode(normalized);
    void claimClipboard(normalized);
  }, [claimClipboard, search]);

  const handleCreateSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!content.trim()) {
      setCreateError('请先输入或粘贴需要跨端传输的文本内容。');
      return;
    }
    if (isOverLimit) {
      setCreateError(`文本超出 ${formatByteCount(MAX_BYTES)} 字节上限，请精简后再发出。`);
      return;
    }

    setCreating(true);
    setCreateError('');
    setDestroyedCode(null);
    try {
      const payload: ClipboardCreateRequest = {
        content,
        burnAfterRead,
        maxViews: burnAfterRead ? 1 : Math.max(1, Math.min(20, Math.round(maxViews))),
        expiresInSeconds: ttlSeconds,
      };
      const res = await apiJson<ClipboardCreateResponse>('/api/clipboard', {
        method: 'POST',
        json: payload,
      });
      setCreatedSlip(res);
      setNowMs(Date.now());
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建闪传失败，请稍后重试。');
    } finally {
      setCreating(false);
    }
  };

  const handleDestroyCreated = async () => {
    if (!createdSlip || destroying) return;
    setDestroying(true);
    setCreateError('');
    try {
      await apiJson<{ ok: true; code: string }>(
        `/api/clipboard/${encodeURIComponent(createdSlip.code)}`,
        {
          method: 'DELETE',
          headers: { 'X-Destroy-Token': createdSlip.destroyToken },
        },
      );
      setDestroyedCode(createdSlip.code);
      setCreatedSlip(null);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '销毁口令失败，可能已过期或被提取完毕。');
    } finally {
      setDestroying(false);
    }
  };

  const handleClaimSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await claimClipboard(claimCode);
  };

  const handleDownloadClaimedText = () => {
    if (!claimedSlip) return;
    const blob = new Blob([claimedSlip.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `clipboard-${claimedSlip.code}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const directShareUrl = useMemo(() => {
    if (!createdSlip) return '';
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/toolkit?tool=clipboard&code=${createdSlip.code}`;
  }, [createdSlip]);

  const slipQr = useMemo(() => {
    if (!directShareUrl) return null;
    try {
      return qrToSvgPath(directShareUrl, 2);
    } catch {
      return null;
    }
  }, [directShareUrl]);

  const claimedStats = useMemo(() => {
    if (!claimedSlip) return null;
    const bytes = utf8ByteLength(claimedSlip.content);
    const lines = claimedSlip.content ? claimedSlip.content.split(/\r?\n/).length : 0;
    return { bytes, lines };
  }, [claimedSlip]);

  return (
    <div className="space-y-6">
      {/* Mode switch & storage boundary notice */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="跨端闪传模式切换"
          className="inline-flex w-full rounded-full border border-hairline bg-surface p-1 sm:w-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'send'}
            onClick={() => setMode('send')}
            className={[
              'inline-flex min-h-[38px] flex-1 items-center justify-center gap-1.5 rounded-full px-4 text-[13.5px] transition-colors sm:flex-initial',
              mode === 'send'
                ? 'bg-cta-bg font-medium text-cta-text'
                : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            <span>发出闪传</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'claim'}
            onClick={() => setMode('claim')}
            className={[
              'inline-flex min-h-[38px] flex-1 items-center justify-center gap-1.5 rounded-full px-4 text-[13.5px] transition-colors sm:flex-initial',
              mode === 'claim'
                ? 'bg-cta-bg font-medium text-cta-text'
                : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            <span>口令提取</span>
          </button>
        </div>

        <p className="m-0 text-[12.5px] text-ink-muted">
          限时文本直存 D1，不占 R2 存储空间，上限 32 KiB
        </p>
      </div>

      {/* SEND MODE */}
      {mode === 'send' && (
        <div className="space-y-5">
          {destroyedCode && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-[16px] border border-hairline bg-paper px-4 py-3 text-[13.5px] text-ink"
            >
              <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              <span>
                闪传口令 <strong className="tabular-nums-mono font-medium">{destroyedCode}</strong>{' '}
                已从数据库立即销毁。
              </span>
            </div>
          )}

          {/* Created claim slip */}
          {createdSlip && (
            <section
              aria-label="已生成闪传凭条"
              {...cardHandlers}
              className="interactive-card panel-fade-in rounded-[24px] border border-hairline bg-paper p-5 shadow-sm sm:p-7"
            >
              <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-muted">
                      <Clock className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                      <span className="tabular-nums-mono">
                        {formatCountdown(createdSlip.expiresAt, nowMs)}
                      </span>
                    </span>
                    {createdSlip.burnAfterRead ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-postmark/30 bg-postmark/10 px-3 py-1 text-[12px] font-medium text-postmark">
                        <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>阅后即焚 · 仅限 1 次</span>
                      </span>
                    ) : (
                      <span className="tabular-nums-mono inline-flex items-center rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-muted">
                        最多提取 {createdSlip.maxViews} 次
                      </span>
                    )}
                    <span className="tabular-nums-mono text-[12px] text-ink-muted">
                      {formatByteCount(createdSlip.sizeBytes)} B
                    </span>
                  </div>

                  <div className="mt-4">
                    <div className="text-[12px] text-ink-muted">跨端提取口令</div>
                    <div className="tabular-nums-mono mt-1 select-all text-[32px] font-medium leading-none tracking-[0.22em] text-ink sm:text-[38px]">
                      {createdSlip.code}
                    </div>
                  </div>

                  <p className="tabular-nums-mono mt-3 mb-0 break-all text-[12px] text-ink-muted">
                    {directShareUrl}
                  </p>

                  <div className="mt-5 flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => void handleCopy('created-code', createdSlip.code)}
                      {...magneticHandlers}
                      className="pill-cta-primary min-h-[40px] px-4 text-[13.5px]"
                    >
                      {copiedKey === 'created-code' ? (
                        <>
                          <Check className="h-4 w-4" aria-hidden="true" />
                          <span>已复制口令</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-4 w-4" aria-hidden="true" />
                          <span>复制口令</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleCopy('created-link', directShareUrl)}
                      className="pill-cta-secondary min-h-[40px] px-4 text-[13.5px]"
                    >
                      {copiedKey === 'created-link' ? (
                        <>
                          <Check className="h-4 w-4 text-accent" aria-hidden="true" />
                          <span>已复制链接</span>
                        </>
                      ) : (
                        <>
                          <Link2 className="h-4 w-4" aria-hidden="true" />
                          <span>复制直达链接</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={destroying}
                      onClick={() => void handleDestroyCreated()}
                      className="inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-full border border-postmark/35 bg-transparent px-4 text-[13.5px] font-medium text-postmark transition-colors hover:bg-postmark/10 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      <span>{destroying ? '销毁中…' : '立即销毁'}</span>
                    </button>
                  </div>
                </div>

                {slipQr && (
                  <div className="flex shrink-0 flex-col items-center gap-2 self-center sm:self-start">
                    <div className="rounded-[16px] border border-hairline bg-white p-2.5">
                      <svg
                        viewBox={slipQr.viewBox}
                        width={120}
                        height={120}
                        role="img"
                        aria-label={`闪传口令 ${createdSlip.code} 直达二维码`}
                        className="block h-[120px] w-[120px]"
                      >
                        <rect width={slipQr.dimension} height={slipQr.dimension} fill="#ffffff" />
                        <path d={slipQr.path} fill="#1f1f1f" />
                      </svg>
                    </div>
                    <span className="text-[11.5px] text-ink-muted">手机扫码直达提取</span>
                  </div>
                )}
              </div>

              <div className="mt-5 flex justify-end border-t border-hairline pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setCreatedSlip(null);
                    setContent('');
                    setCreateError('');
                  }}
                  className="text-[13px] text-accent hover:underline"
                >
                  清空并继续发送一条
                </button>
              </div>
            </section>
          )}

          {/* Compose form */}
          <form
            onSubmit={handleCreateSubmit}
            className="rounded-[24px] border border-hairline bg-surface p-5 sm:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="clipboard-send-input" className="text-[14px] font-medium text-ink">
                待传输文本
              </label>
              <div className="flex items-center gap-3">
                <span
                  className={[
                    'tabular-nums-mono text-[12px]',
                    isOverLimit ? 'font-medium text-postmark' : 'text-ink-muted',
                  ].join(' ')}
                >
                  {formatByteCount(byteCount)} / {formatByteCount(MAX_BYTES)} B
                </span>
                {content.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setContent('');
                      setCreateError('');
                    }}
                    className="text-[12px] text-ink-muted transition-colors hover:text-ink"
                  >
                    清空
                  </button>
                )}
              </div>
            </div>

            <div className="mt-2 h-[2px] w-full overflow-hidden rounded-full bg-hairline">
              <div
                className={[
                  'h-full transition-all duration-150',
                  isOverLimit ? 'bg-postmark' : 'bg-accent',
                ].join(' ')}
                style={{ width: `${usagePct}%` }}
              />
            </div>

            <textarea
              id="clipboard-send-input"
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                if (createError) setCreateError('');
              }}
              rows={7}
              spellCheck={false}
              placeholder="粘贴跨端传输的文本、终端命令、代码片段、临时口令或网址……"
              className="tabular-nums-mono mt-3 block w-full resize-y rounded-[16px] border border-hairline bg-paper px-4 py-3 text-[13.5px] leading-relaxed text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-muted focus:border-accent"
            />

            {/* TTL & Burn settings */}
            <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-[16px] border border-hairline bg-paper/75 p-4">
                <div className="text-[12.5px] font-medium text-ink-muted">留存有效期</div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {TTL_PRESETS.map((preset) => {
                    const active = ttlSeconds === preset.seconds;
                    return (
                      <button
                        key={preset.seconds}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setTtlSeconds(preset.seconds)}
                        className={[
                          'min-h-[34px] rounded-full border px-3.5 text-[13px] transition-colors',
                          active
                            ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                            : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                        ].join(' ')}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-[16px] border border-hairline bg-paper/75 p-4">
                <div className="text-[12.5px] font-medium text-ink-muted">销毁与提取次数</div>
                <label className="mt-2.5 flex cursor-pointer items-center gap-2.5 text-[13.5px] text-ink">
                  <input
                    type="checkbox"
                    checked={burnAfterRead}
                    onChange={(e) => setBurnAfterRead(e.target.checked)}
                    className="h-4 w-4 rounded accent-accent"
                  />
                  <span>阅后即焚（提取 1 次自动销毁）</span>
                </label>

                {!burnAfterRead && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] text-ink-muted">最大提取次数</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={maxViews}
                      aria-label="最大提取次数"
                      onChange={(e) => {
                        const parsed = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(parsed)) {
                          setMaxViews(Math.max(1, Math.min(20, parsed)));
                        }
                      }}
                      className="tabular-nums-mono w-16 rounded-[10px] border border-hairline bg-surface px-2.5 py-1 text-center text-[13px] text-ink outline-none focus:border-accent"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {VIEW_PRESETS.map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setMaxViews(n)}
                          className={[
                            'tabular-nums-mono rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
                            maxViews === n
                              ? 'border-accent/40 bg-accent/10 text-accent'
                              : 'border-hairline bg-surface text-ink-muted hover:text-ink',
                          ].join(' ')}
                        >
                          {n} 次
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {createError && (
              <p
                role="alert"
                className="mt-4 mb-0 flex items-center gap-2 rounded-[14px] border border-postmark/30 bg-paper px-4 py-2.5 text-[13px] text-postmark"
              >
                <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{createError}</span>
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <span className="text-[12px] text-ink-muted">
                口令仅含清晰大写字母与数字，到期或提取耗尽自动清除。
              </span>
              <button
                type="submit"
                disabled={creating || !content.trim() || isOverLimit}
                {...magneticHandlers}
                className="pill-cta-primary min-h-[42px] px-6 text-[14px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                <span>{creating ? '生成中…' : '生成 6 位闪传口令'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* CLAIM MODE */}
      {mode === 'claim' && (
        <div className="space-y-5">
          <form
            onSubmit={handleClaimSubmit}
            className="mx-auto flex w-full max-w-[540px] items-center gap-2 rounded-full border border-hairline-strong bg-surface p-1.5 pl-5 transition-colors focus-within:border-accent"
          >
            <input
              type="text"
              value={claimCode}
              onChange={(e) => {
                setClaimCode(e.target.value.toUpperCase());
                if (claimError) setClaimError('');
              }}
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              aria-label="输入 6 位闪传口令"
              placeholder="输入 6 位闪传口令"
              className="tabular-nums-mono min-w-0 flex-1 bg-transparent py-2 text-[16px] tracking-[0.16em] text-ink uppercase outline-none placeholder:tracking-normal placeholder:normal-case placeholder:text-ink-muted"
            />
            <button
              type="submit"
              disabled={claiming}
              {...magneticHandlers}
              className="pill-cta-primary min-h-[42px] shrink-0 px-5 text-[14px] disabled:opacity-50"
            >
              {claiming ? '提取中…' : '立即提取'}
            </button>
          </form>

          {claimError && (
            <p
              role="alert"
              className="mx-auto max-w-[540px] rounded-[16px] border border-postmark/30 bg-paper px-4 py-3 text-center text-[13.5px] text-postmark"
            >
              {claimError}
            </p>
          )}

          {claimedSlip && (
            <section
              aria-label="提取到的闪传文本"
              {...cardHandlers}
              className="interactive-card panel-fade-in rounded-[24px] border border-hairline bg-paper p-5 shadow-sm sm:p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums-mono rounded-full border border-hairline bg-surface px-3 py-1 text-[12.5px] font-medium tracking-[0.12em] text-ink">
                    {claimedSlip.code}
                  </span>

                  {claimedSlip.burned ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-postmark/35 bg-postmark/10 px-3 py-1 text-[12px] font-medium text-postmark">
                      <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>已阅后即焚</span>
                    </span>
                  ) : (
                    <span className="tabular-nums-mono inline-flex items-center rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-muted">
                      剩余可提取 {claimedSlip.remainingViews} 次
                    </span>
                  )}

                  {!claimedSlip.burned && (
                    <span className="tabular-nums-mono inline-flex items-center gap-1 text-[12px] text-ink-muted">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{formatCountdown(claimedSlip.expiresAt, nowMs)}</span>
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopy('claimed-content', claimedSlip.content)}
                    className="pill-cta-primary min-h-[36px] px-4 text-[13px]"
                  >
                    {copiedKey === 'claimed-content' ? (
                      <>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>已复制全文</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>复制全文</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleDownloadClaimedText}
                    className="pill-cta-secondary min-h-[36px] px-3.5 text-[13px]"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>保存 .txt</span>
                  </button>
                </div>
              </div>

              {claimedSlip.burned && (
                <p className="mt-3 mb-0 text-[12.5px] text-postmark">
                  此记录已完成最后一次读取并从服务端清除，刷新页面前请及时复制或保存。
                </p>
              )}

              <pre className="tabular-nums-mono mt-4 mb-0 max-h-[420px] overflow-auto rounded-[16px] border border-hairline bg-surface p-4 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink">
                {claimedSlip.content}
              </pre>

              {claimedStats && (
                <div className="tabular-nums-mono mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-muted">
                  <span>
                    {formatByteCount(claimedStats.bytes)} B · {claimedStats.lines} 行
                  </span>
                  <span>写入于 {new Date(claimedSlip.createdAt).toLocaleString('zh-CN')}</span>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
