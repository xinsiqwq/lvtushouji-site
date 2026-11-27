import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw, X } from 'lucide-react';
import type { ExifSummary } from '../../shared/types';
import { formatDay } from '../../shared/dates';

export type DarkroomPhoto = {
  id: string;
  title: string;
  caption?: string;
  previewUrl: string;
  takenAt?: string | null;
  lat?: number | null;
  lng?: number | null;
  exif?: ExifSummary;
};

type DarkroomDialogProps = {
  photos: DarkroomPhoto[];
  activeIndex: number | null;
  onChangeIndex: (index: number) => void;
  onClose: () => void;
  returnFocusEl?: HTMLElement | null;
};

let cachedDisplayTransitionSupport: boolean | undefined;

function canTransitionDisplay(): boolean {
  if (cachedDisplayTransitionSupport !== undefined) return cachedDisplayTransitionSupport;
  if (
    typeof window === 'undefined' ||
    !window.CSS?.supports?.('transition-behavior', 'allow-discrete') ||
    !document.body
  ) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  cachedDisplayTransitionSupport = getComputedStyle(probe).display === 'block';
  probe.remove();
  return cachedDisplayTransitionSupport;
}

function supportsTopLayerExit(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.CSS?.supports?.('overlay', 'auto')) &&
    canTransitionDisplay()
  );
}

async function closeTopLayer(dialog: HTMLDialogElement): Promise<void> {
  if (!dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }
    dialog.removeAttribute('data-closing');
  }
  if (dialog.open) {
    dialog.close();
  }
}

function formatExifLine(exif?: ExifSummary): string {
  if (!exif) return '';
  const parts = [exif.model, exif.focalLength, exif.aperture, exif.shutter, exif.iso ? `ISO ${exif.iso}` : undefined].filter(
    Boolean,
  );
  return parts.join(' · ');
}

export function DarkroomDialog({
  photos,
  activeIndex,
  onChangeIndex,
  onClose,
  returnFocusEl,
}: DarkroomDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; baseX: number; baseY: number }>({
    active: false,
    startX: 0,
    startY: 0,
    baseX: 0,
    baseY: 0,
  });

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const isOpen = activeIndex !== null && photos[activeIndex] !== undefined;
  const activePhoto = isOpen ? photos[activeIndex] : null;
  const zoomed = scale > 1.01;

  const resetTransform = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    resetTransform();
    setLoadError(false);
    setRetryCount(0);
  }, [activeIndex, activePhoto?.id, resetTransform]);

  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      onClose();
      return;
    }
    void closeTopLayer(dialog);
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      previousActiveRef.current =
        returnFocusEl ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      dialog.removeAttribute('data-closing');
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.removeAttribute('data-closing');
      dialog.close();
    }
  }, [isOpen, returnFocusEl]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.removeAttribute('data-closing');
      const restoreTarget = returnFocusEl ?? previousActiveRef.current;
      onClose();
      if (restoreTarget && restoreTarget.isConnected) {
        requestAnimationFrame(() => restoreTarget.focus());
      }
    };

    const handleCancel = (event: Event) => {
      event.preventDefault();
      void closeTopLayer(dialog);
    };

    // Mandatory fallback for browsers without closedBy support (e.g. Safari)
    const supportsClosedBy = 'closedBy' in HTMLDialogElement.prototype;
    const handleBackdropClick = (event: MouseEvent) => {
      if (supportsClosedBy) return;
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) {
        void closeTopLayer(dialog);
      }
    };

    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('click', handleBackdropClick);
    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('click', handleBackdropClick);
    };
  }, [onClose, returnFocusEl]);

  const canNavigate = photos.length > 1 && !zoomed;
  const goPrev = useCallback(() => {
    if (!canNavigate || activeIndex === null) return;
    onChangeIndex((activeIndex - 1 + photos.length) % photos.length);
  }, [activeIndex, canNavigate, onChangeIndex, photos.length]);

  const goNext = useCallback(() => {
    if (!canNavigate || activeIndex === null) return;
    onChangeIndex((activeIndex + 1) % photos.length);
  }, [activeIndex, canNavigate, onChangeIndex, photos.length]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        if (!zoomed && photos.length > 1) {
          event.preventDefault();
          goPrev();
        }
      } else if (event.key === 'ArrowRight') {
        if (!zoomed && photos.length > 1) {
          event.preventDefault();
          goNext();
        }
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setScale((s) => Math.min(4, Number((s + 0.5).toFixed(2))));
      } else if (event.key === '-') {
        event.preventDefault();
        setScale((s) => {
          const next = Math.max(1, Number((s - 0.5).toFixed(2)));
          if (next <= 1) setPan({ x: 0, y: 0 });
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goNext, goPrev, isOpen, photos.length, zoomed]);

  const imageSrc = activePhoto
    ? retryCount > 0
      ? `${activePhoto.previewUrl}${activePhoto.previewUrl.includes('?') ? '&' : '?'}retry=${retryCount}`
      : activePhoto.previewUrl
    : '';

  const exifLine = formatExifLine(activePhoto?.exif);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-label="暗房大图查看"
      className="darkroom-dialog deep-space m-auto w-[min(94vw,1160px)] max-h-[92vh] overflow-hidden rounded-[24px] border border-hairline bg-page p-0 text-ink shadow-2xl"
    >
      {activePhoto && (
        <div className="flex max-h-[92vh] flex-col">
          {/* Top toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate text-[14.5px] font-medium text-ink">{activePhoto.title}</span>
              {activePhoto.takenAt && formatDay(activePhoto.takenAt) && (
                <span className="tabular-nums-mono shrink-0 text-[12px] text-postmark">
                  {formatDay(activePhoto.takenAt)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  setScale((s) => {
                    const next = Math.max(1, Number((s - 0.5).toFixed(2)));
                    if (next <= 1) setPan({ x: 0, y: 0 });
                    return next;
                  })
                }
                disabled={scale <= 1}
                aria-label="缩小"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover disabled:opacity-40"
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
              </button>
              <span className="tabular-nums-mono min-w-[48px] text-center text-[12px] text-ink-muted">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(4, Number((s + 0.5).toFixed(2))))}
                aria-label="放大"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={resetTransform}
                aria-label="重置缩放"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
              </button>

              {photos.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={goPrev}
                    disabled={zoomed}
                    aria-label="上一张"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover disabled:opacity-40"
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={zoomed}
                    aria-label="下一张"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-surface text-ink transition-colors hover:bg-surface-hover disabled:opacity-40"
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={requestClose}
                aria-label="关闭暗房灯箱"
                className="inline-flex h-9 items-center gap-1 rounded-full border border-hairline bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                <span>关闭</span>
              </button>
            </div>
          </div>

          {/* Image viewport */}
          <div
            className="relative flex min-h-[300px] flex-1 items-center justify-center overflow-hidden bg-page p-4 select-none sm:p-6"
            style={{ touchAction: zoomed ? 'none' : 'pan-y' }}
            onWheel={(event) => {
              event.preventDefault();
              const delta = event.deltaY < 0 ? 0.25 : -0.25;
              setScale((s) => {
                const next = Math.min(4, Math.max(1, Number((s + delta).toFixed(2))));
                if (next <= 1) setPan({ x: 0, y: 0 });
                return next;
              });
            }}
            onPointerDown={(event) => {
              if (!zoomed) return;
              dragRef.current = {
                active: true,
                startX: event.clientX,
                startY: event.clientY,
                baseX: pan.x,
                baseY: pan.y,
              };
            }}
            onPointerMove={(event) => {
              if (!dragRef.current.active) return;
              setPan({
                x: dragRef.current.baseX + (event.clientX - dragRef.current.startX),
                y: dragRef.current.baseY + (event.clientY - dragRef.current.startY),
              });
            }}
            onPointerUp={() => {
              dragRef.current.active = false;
            }}
            onPointerCancel={() => {
              dragRef.current.active = false;
            }}
          >
            {loadError ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <p className="m-0 text-[14px] text-ink-muted">这张照片暂时没有展开成功。</p>
                <button
                  type="button"
                  onClick={() => {
                    setLoadError(false);
                    setRetryCount((n) => n + 1);
                  }}
                  className="rounded-full bg-surface px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-hover"
                >
                  重试加载
                </button>
              </div>
            ) : (
              <img
                src={imageSrc}
                alt={activePhoto.caption || activePhoto.title}
                onError={() => setLoadError(true)}
                onLoad={() => setLoadError(false)}
                draggable={false}
                className="max-h-[70vh] w-auto max-w-full rounded-[6px] object-contain"
                style={{
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
                  transformOrigin: 'center center',
                  cursor: zoomed ? 'grab' : 'default',
                  transition: dragRef.current.active ? 'none' : 'transform 140ms var(--ease-editorial)',
                }}
              />
            )}
          </div>

          {/* Caption & EXIF footer */}
          {(activePhoto.caption || exifLine || (activePhoto.lat !== null && activePhoto.lat !== undefined)) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-surface px-4 py-3 text-[12.5px] sm:px-6">
              <p className="font-editorial-serif m-0 max-w-[680px] text-ink">
                {activePhoto.caption || activePhoto.title}
              </p>
              <div className="tabular-nums-mono flex flex-wrap items-center gap-3 text-[12px] text-ink-muted">
                {exifLine && <span>{exifLine}</span>}
                {typeof activePhoto.lat === 'number' && typeof activePhoto.lng === 'number' && (
                  <span>
                    {Math.abs(activePhoto.lat).toFixed(4)}° {activePhoto.lat >= 0 ? 'N' : 'S'},{' '}
                    {Math.abs(activePhoto.lng).toFixed(4)}° {activePhoto.lng >= 0 ? 'E' : 'W'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
