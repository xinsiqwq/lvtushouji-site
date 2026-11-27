import type { MouseEvent } from 'react';
import { ArrowUpRight, Pause, Square, Volume2, VolumeX } from 'lucide-react';
import { useRouter } from '../../lib/router';
import {
  formatCountdown,
  getActiveTrackLabels,
  MODE_LABELS,
  pauseAudio,
  pauseTimer,
  resetTimer,
  stopAll,
  useAmbienceState,
} from './ambience-audio';

export function AmbienceDock() {
  const state = useAmbienceState();
  const { pathname, navigate } = useRouter();

  const onToolkit = pathname === '/toolkit' || pathname.startsWith('/toolkit/');
  const timerRunning = state.timerStatus === 'running';
  const audioPlaying = state.isPlaying;

  // CRITICAL INVARIANT: render zero DOM nodes when idle or already on /toolkit
  if (onToolkit || (!audioPlaying && !timerRunning)) {
    return null;
  }

  const activeLabels = getActiveTrackLabels(state);
  const soundLabel =
    activeLabels.length === 0
      ? '环境白噪音'
      : activeLabels.length === 1
        ? activeLabels[0]!
        : `${activeLabels[0]!} +${activeLabels.length - 1}`;

  const pauseLabel =
    timerRunning && audioPlaying
      ? '暂停计时与声音'
      : timerRunning
        ? '暂停专注计时'
        : '暂停环境白噪音';

  const handlePause = () => {
    if (timerRunning) {
      pauseTimer();
    }
    if (audioPlaying) {
      pauseAudio();
    }
  };

  const handleStopOrMute = () => {
    if (audioPlaying) {
      stopAll();
      return;
    }
    if (timerRunning) {
      resetTimer();
    }
  };

  const handleOpenFocus = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    navigate('/toolkit?tool=focus');
  };

  const indicatorTone =
    timerRunning && state.timerMode !== 'focus' ? 'bg-postmark' : 'bg-accent';

  return (
    <aside
      aria-label="专注计时与环境音伴随浮窗"
      data-ambience-dock="active"
      className="fixed right-4 bottom-4 z-30 flex max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-full border border-hairline-strong bg-surface/92 px-2.5 py-1.5 text-ink shadow-[0_8px_28px_rgba(0,0,0,0.16)] backdrop-blur-md"
    >
      <a
        href="/toolkit?tool=focus"
        onClick={handleOpenFocus}
        aria-label="返回专注番茄钟与白噪音台"
        className="flex min-w-0 items-center gap-2 rounded-full py-1 pl-1.5 pr-2 text-[13px] text-ink no-underline transition-colors hover:bg-surface-hover"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${indicatorTone}`}
        />

        {timerRunning && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="text-[12px] text-ink-muted">
              {MODE_LABELS[state.timerMode]}
            </span>
            <span className="tabular-nums-mono text-[13.5px] font-medium text-ink">
              {formatCountdown(state.remainingSeconds)}
            </span>
          </span>
        )}

        {timerRunning && audioPlaying && (
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-hairline-strong" />
        )}

        {audioPlaying && (
          <span className="flex min-w-0 items-center gap-1 text-[12.5px] text-ink-muted">
            <Volume2 className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            <span className="max-w-[116px] truncate sm:max-w-[152px]">{soundLabel}</span>
          </span>
        )}

        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
      </a>

      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-hairline" />

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={handlePause}
          aria-label={pauseLabel}
          title={pauseLabel}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-paper text-ink transition-colors hover:border-hairline-strong hover:bg-surface-hover"
        >
          <Pause className="h-3.5 w-3.5" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={handleStopOrMute}
          aria-label={audioPlaying ? '静音并停止环境音' : '停止并重置计时'}
          title={audioPlaying ? '静音并停止环境音' : '停止并重置计时'}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-transparent text-ink-muted transition-colors hover:border-hairline-strong hover:bg-surface-hover hover:text-ink"
        >
          {audioPlaying ? (
            <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Square className="h-3 w-3" aria-hidden="true" />
          )}
        </button>
      </div>
    </aside>
  );
}

export default AmbienceDock;
