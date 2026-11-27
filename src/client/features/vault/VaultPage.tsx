import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, Download, Eye, FileText, Maximize2 } from 'lucide-react';
import type { VaultRedeemResult } from '../../../shared/types';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { DarkroomDialog, type DarkroomPhoto } from '../../components/DarkroomDialog';
import { apiJson } from '../../lib/api';
import { createCardPointerHandlers, createMagneticHandlers } from '../../lib/pointer-fx';
import { qrToSvgPath } from '../../lib/qr-svg';
import { useRouter } from '../../lib/router';

const PASSCODE_RE = /^[A-Za-z0-9]{6}$/;
const MAX_INLINE_TEXT_BYTES = 262_144;

const SAFE_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const SAFE_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'application/json']);

const SAFE_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
]);

function normalizeMime(mime: string | undefined | null): string {
  return (mime || '').toLowerCase().split(';')[0]?.trim() ?? '';
}

function buildInlineUrl(downloadUrl: string): string {
  return `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}inline=1`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCountdown(expiresAt: string, nowMs: number): string {
  const diff = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(diff) || diff <= 0) return '已到期';
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (days > 0) return `剩余有效 ${days} 天 ${hours} 小时`;
  if (hours > 0) return `剩余有效 ${hours} 小时 ${mins} 分`;
  return `剩余有效 ${mins} 分 ${secs} 秒`;
}

export default function VaultPage() {
  const { search } = useRouter();

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [slip, setSlip] = useState<VaultRedeemResult | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Safe on-demand inline preview states (never fetched until user explicitly clicks)
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [imagePreviewError, setImagePreviewError] = useState('');
  const [darkroomOpen, setDarkroomOpen] = useState(false);
  const [darkroomReturnEl, setDarkroomReturnEl] = useState<HTMLElement | null>(null);

  const [textPreviewOpen, setTextPreviewOpen] = useState(false);
  const [textLoading, setTextLoading] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState('');
  const [copiedText, setCopiedText] = useState(false);

  const autoRedeemedCodeRef = useRef<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const resetPreviewState = useCallback(() => {
    setImagePreviewOpen(false);
    setImagePreviewError('');
    setDarkroomOpen(false);
    setTextPreviewOpen(false);
    setTextLoading(false);
    setTextContent(null);
    setTextError('');
    setCopiedText(false);
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!slip) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [slip]);

  const redeemCode = useCallback(
    async (rawInput: string) => {
      const trimmed = rawInput.trim();
      if (!PASSCODE_RE.test(trimmed)) {
        setError('请输入完整的 6 位数字或字母口令。');
        return;
      }

      setSubmitting(true);
      setError('');
      resetPreviewState();
      try {
        const requestId =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}`;
        const res = await apiJson<VaultRedeemResult>('/api/vault/redeem', {
          method: 'POST',
          json: { code: trimmed, requestId },
        });
        setSlip(res);
        setNowMs(Date.now());
      } catch (err) {
        setSlip(null);
        setError(err instanceof Error ? err.message : '提取口令无效或已失效');
      } finally {
        setSubmitting(false);
      }
    },
    [resetPreviewState],
  );

  // Auto-prefill & redeem once from ?code= or ?c= query parameter
  useEffect(() => {
    const params = new URLSearchParams(search);
    const urlCode = (params.get('code') || params.get('c') || '').trim();
    if (!PASSCODE_RE.test(urlCode)) return;
    if (autoRedeemedCodeRef.current === urlCode) return;
    autoRedeemedCodeRef.current = urlCode;
    setCode(urlCode);
    void redeemCode(urlCode);
  }, [redeemCode, search]);

  const qrData = useMemo(() => {
    if (!slip) return null;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return qrToSvgPath(`${origin}${slip.downloadUrl}`);
  }, [slip]);

  const mime = normalizeMime(slip?.fileMime);
  const inlineUrl = slip ? buildInlineUrl(slip.downloadUrl) : '';
  const canPreviewImage = Boolean(slip) && SAFE_IMAGE_MIMES.has(mime);
  const canPreviewText =
    Boolean(slip) && SAFE_TEXT_MIMES.has(mime) && (slip?.fileSize ?? Infinity) <= MAX_INLINE_TEXT_BYTES;
  const canPreviewAudio = Boolean(slip) && SAFE_AUDIO_MIMES.has(mime);

  const darkroomPhotos = useMemo<DarkroomPhoto[]>(() => {
    if (!slip || !canPreviewImage) return [];
    return [
      {
        id: slip.ticketId,
        title: slip.fileName,
        caption: slip.note || undefined,
        previewUrl: inlineUrl,
      },
    ];
  }, [canPreviewImage, inlineUrl, slip]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await redeemCode(code);
  };

  const handleToggleTextPreview = async () => {
    if (!slip || !canPreviewText) return;
    if (textPreviewOpen) {
      setTextPreviewOpen(false);
      return;
    }
    setTextPreviewOpen(true);
    if (textContent !== null || textLoading) return;

    setTextLoading(true);
    setTextError('');
    try {
      const res = await fetch(inlineUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        throw new Error(`无法读取文本内容 (${res.status})`);
      }
      const body = await res.text();
      setTextContent(body);
    } catch (err) {
      setTextError(err instanceof Error ? err.message : '在线阅读加载失败，请直接下载原件。');
    } finally {
      setTextLoading(false);
    }
  };

  const handleCopyText = async () => {
    if (textContent === null || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(textContent);
      setCopiedText(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopiedText(false), 2000);
    } catch {
      // Clipboard may be unavailable in restricted contexts
    }
  };

  const cardHandlers = createCardPointerHandlers();
  const magneticHandlers = createMagneticHandlers(4);

  return (
    <div className="relative flex min-h-[calc(100dvh_-_var(--nav-height))] flex-col items-center justify-center overflow-hidden px-4 py-12 sm:px-6">
      <CelestialFieldBackdrop variant="vault" />

      <div className="relative z-10 w-full max-w-[560px]">
        <div className="text-center">
          <h1 tabIndex={-1} className="display-h1 text-[30px] text-ink sm:text-[38px]">
            文件密匣
          </h1>
        </div>

        {/* Centered Gemini-style extraction capsule */}
        <form
          onSubmit={handleSubmit}
          className="mt-8 flex items-center gap-2 rounded-full border border-hairline-strong bg-surface/90 p-1.5 pl-5 shadow-lg backdrop-blur-md transition-colors focus-within:border-accent"
        >
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={12}
            autoComplete="off"
            spellCheck={false}
            aria-label="输入 6 位提取口令"
            placeholder="输入 6 位提取口令"
            className="tabular-nums-mono min-w-0 flex-1 bg-transparent py-2 text-[16px] tracking-[0.14em] text-ink outline-none placeholder:tracking-normal placeholder:text-ink-muted"
          />
          <button
            type="submit"
            disabled={submitting}
            {...magneticHandlers}
            className="pill-cta-primary min-h-[44px] shrink-0 px-6 text-[14.5px] disabled:opacity-50"
          >
            {submitting ? '校验中…' : '提取文件'}
          </button>
        </form>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-[16px] border border-hairline bg-surface/90 px-4 py-3 text-center text-[13.5px] text-postmark backdrop-blur-sm"
          >
            {error}
          </p>
        )}

        {/* Paper-textured claim slip */}
        {slip && (
          <section
            aria-label="密匣文件签条"
            {...cardHandlers}
            className="interactive-card panel-fade-in mt-7 rounded-[24px] border border-hairline bg-paper p-6 shadow-md sm:p-7"
          >
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <h2 className="m-0 break-all text-[18px] font-medium text-ink">
                  {slip.fileName}
                </h2>

                <div className="tabular-nums-mono mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-muted">
                  <span>体积 {formatBytes(slip.fileSize)}</span>
                  <span>剩余可提取 {slip.remainingDownloads} 次</span>
                  <span>{formatCountdown(slip.expiresAt, nowMs)}</span>
                </div>

                {slip.note && (
                  <p className="font-editorial-serif mt-4 mb-0 rounded-[12px] border border-postmark/25 bg-surface/60 px-3.5 py-2.5 text-[14px] text-postmark">
                    {slip.note}
                  </p>
                )}

                <div className="mt-5 flex flex-wrap items-center gap-2.5">
                  <a
                    href={slip.downloadUrl}
                    download={slip.fileName}
                    {...magneticHandlers}
                    className="pill-cta-primary"
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    <span>下载原件</span>
                  </a>

                  {canPreviewImage && (
                    <button
                      type="button"
                      onClick={() => {
                        setImagePreviewError('');
                        setImagePreviewOpen((prev) => !prev);
                      }}
                      aria-expanded={imagePreviewOpen}
                      className="pill-cta-secondary min-h-[44px] px-4 text-[13.5px]"
                    >
                      <Eye className="h-4 w-4" aria-hidden="true" />
                      <span>{imagePreviewOpen ? '收起预览' : '预览图片'}</span>
                    </button>
                  )}

                  {canPreviewText && (
                    <button
                      type="button"
                      onClick={() => {
                        void handleToggleTextPreview();
                      }}
                      aria-expanded={textPreviewOpen}
                      className="pill-cta-secondary min-h-[44px] px-4 text-[13.5px]"
                    >
                      <FileText className="h-4 w-4" aria-hidden="true" />
                      <span>{textPreviewOpen ? '收起阅读' : '在线阅读'}</span>
                    </button>
                  )}
                </div>
              </div>

              {qrData && (
                <div className="shrink-0 self-center rounded-[14px] bg-white p-2.5 sm:self-start">
                  <svg
                    viewBox={qrData.viewBox}
                    width={96}
                    height={96}
                    role="img"
                    aria-label="密匣分享二维码"
                    className="block h-24 w-24 text-[#1f1f1f]"
                  >
                    <rect width={qrData.dimension} height={qrData.dimension} fill="#ffffff" />
                    <path d={qrData.path} fill="#1f1f1f" />
                  </svg>
                </div>
              )}
            </div>

            {/* Safe inline image preview (on-demand) */}
            {canPreviewImage && imagePreviewOpen && (
              <div className="mt-5 rounded-[16px] border border-hairline bg-surface/75 p-3.5">
                {imagePreviewError ? (
                  <p role="alert" className="m-0 text-[13px] text-postmark">
                    {imagePreviewError}
                  </p>
                ) : (
                  <div className="flex flex-col items-center gap-2.5">
                    <button
                      type="button"
                      onClick={(event) => {
                        setDarkroomReturnEl(event.currentTarget);
                        setDarkroomOpen(true);
                      }}
                      aria-label="在暗房查看大图"
                      className="flex max-w-full justify-center overflow-hidden rounded-[12px] bg-paper p-1.5 transition-opacity hover:opacity-95"
                    >
                      <img
                        src={inlineUrl}
                        alt={slip.fileName}
                        onError={() => setImagePreviewError('图片预览暂时不可用，请直接下载原件。')}
                        className="block h-auto max-h-[300px] w-auto max-w-full rounded-[8px]"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        setDarkroomReturnEl(event.currentTarget);
                        setDarkroomOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-page/70 px-3 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                    >
                      <Maximize2 className="h-3 w-3" aria-hidden="true" />
                      <span>暗房查看大图</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Safe inline text reader (on-demand, <= 256 KiB) */}
            {canPreviewText && textPreviewOpen && (
              <div className="mt-5 rounded-[16px] border border-hairline bg-surface/80 p-4">
                <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-hairline pb-2">
                  <span className="tabular-nums-mono text-[11.5px] text-ink-muted">
                    {mime} · {formatBytes(slip.fileSize)}
                  </span>
                  {textContent !== null && (
                    <button
                      type="button"
                      onClick={() => {
                        void handleCopyText();
                      }}
                      className="inline-flex min-h-[28px] items-center gap-1 rounded-full border border-hairline bg-page/70 px-3 text-[12px] text-ink transition-colors hover:bg-surface-hover"
                    >
                      {copiedText ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                          <span>已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>复制内容</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {textLoading ? (
                  <p className="m-0 py-4 text-[13px] text-ink-muted">正在读取文本内容……</p>
                ) : textError ? (
                  <p role="alert" className="m-0 text-[13px] text-postmark">
                    {textError}
                  </p>
                ) : (
                  <pre className="tabular-nums-mono m-0 max-h-[320px] overflow-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink">
                    {textContent ?? ''}
                  </pre>
                )}
              </div>
            )}

            {/* Safe inline audio player (preload="none" so zero fetch on redeem) */}
            {canPreviewAudio && (
              <div className="mt-5 rounded-[16px] border border-hairline bg-surface/75 p-3.5">
                <div className="mb-2 text-[12px] text-ink-muted">在线试听</div>
                <audio
                  controls
                  preload="none"
                  src={inlineUrl}
                  aria-label={`试听 ${slip.fileName}`}
                  className="block w-full"
                />
              </div>
            )}
          </section>
        )}
      </div>

      <DarkroomDialog
        photos={darkroomPhotos}
        activeIndex={darkroomOpen ? 0 : null}
        onChangeIndex={() => {}}
        onClose={() => setDarkroomOpen(false)}
        returnFocusEl={darkroomReturnEl}
      />
    </div>
  );
}
