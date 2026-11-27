import type { MouseEvent } from 'react';
import {
  CloudRain,
  Compass,
  Flame,
  Map as MapIcon,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  Waves,
  Wind,
} from 'lucide-react';
import { useRouter } from '../../../lib/router';
import {
  AMBIENCE_TRACKS,
  formatCountdown,
  getActiveTrackLabels,
  MODE_LABELS,
  pauseTimer,
  POMODORO_PRESETS,
  resetTimer,
  setMasterVolume,
  setPauseOnHidden,
  setPreset,
  setTimerMode,
  setTrackVolume,
  startTimer,
  stopAll,
  togglePlayAll,
  toggleTrack,
  useAmbienceState,
  type AmbienceTrackId,
  type PomodoroMode,
} from '../ambience-audio';

const TRACK_ICONS: Record<AmbienceTrackId, typeof Wind> = {
  wind: Wind,
  rain: CloudRain,
  fire: Flame,
  brown: Waves,
};

const MODES: readonly PomodoroMode[] = ['focus', 'shortBreak', 'longBreak'];

const RING_SIZE = 236;
const RING_CENTER = RING_SIZE / 2;
const RING_RADIUS = 96;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const DIAL_TICKS = Array.from({ length: 60 }, (_, index) => {
  const angle = (index / 60) * 2 * Math.PI - Math.PI / 2;
  const isMajor = index % 5 === 0;
  const rInner = isMajor ? RING_RADIUS + 8 : RING_RADIUS + 10.5;
  const rOuter = RING_RADIUS + 14.5;
  return {
    index,
    isMajor,
    x1: RING_CENTER + Math.cos(angle) * rInner,
    y1: RING_CENTER + Math.sin(angle) * rInner,
    x2: RING_CENTER + Math.cos(angle) * rOuter,
    y2: RING_CENTER + Math.sin(angle) * rOuter,
  };
});

export default function FocusAmbienceTool() {
  const state = useAmbienceState();
  const { navigate } = useRouter();

  const progress =
    state.totalSeconds > 0
      ? Math.max(0, Math.min(1, 1 - state.remainingSeconds / state.totalSeconds))
      : 0;
  const remainingFraction = 1 - progress;
  const dashOffset = RING_CIRCUMFERENCE * (1 - remainingFraction);
  const isFocusMode = state.timerMode === 'focus';
  const strokeVar = isFocusMode ? 'var(--color-accent)' : 'var(--color-postmark)';

  const activeLabels = getActiveTrackLabels(state);
  const enabledCount = activeLabels.length;

  const timerStatusText =
    state.timerStatus === 'running'
      ? isFocusMode
        ? '专注进行中'
        : '休息进行中'
      : state.timerStatus === 'paused'
        ? '已暂停'
        : isFocusMode
          ? '准备开始专注'
          : '准备开始休息';

  const handleSpaLink = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
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
    navigate(href);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-medium tracking-[-0.02em] text-ink sm:text-[24px]">
            专注番茄钟与环境白噪音台
          </h2>
          <p className="mt-1 text-[14px] text-ink-muted">
            纯 Web Audio 程序化合成环境声场，零音频文件请求，专注节奏与声音在站内无缝伴随。
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1 text-[12px] text-ink-muted">
          <span>本地合成</span>
          <span aria-hidden="true" className="h-3 w-px bg-hairline-strong" />
          <span className="tabular-nums-mono text-ink">
            {state.isPlaying ? `${enabledCount} 路发声中` : '声音待机'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,376px)_minmax(0,1fr)]">
        {/* Left: Minimalist Pomodoro Countdown Card */}
        <section
          aria-label="专注番茄钟"
          className="flex flex-col justify-between rounded-[20px] border border-hairline bg-paper p-5 sm:p-6"
        >
          <div>
            {/* Mode toggle */}
            <div
              role="group"
              aria-label="计时模式切换"
              className="grid grid-cols-3 gap-1 rounded-full border border-hairline bg-surface p-1"
            >
              {MODES.map((mode) => {
                const active = state.timerMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTimerMode(mode)}
                    className={`min-h-[36px] rounded-full px-3 text-[13.5px] font-medium transition-colors ${
                      active
                        ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                        : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {MODE_LABELS[mode]}
                  </button>
                );
              })}
            </div>

            {/* Circular SVG Countdown Ring */}
            <div className="relative mx-auto mt-6 mb-5 flex w-full max-w-[236px] items-center justify-center">
              <svg
                viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
                className="h-auto w-full"
                role="img"
                aria-label={`${MODE_LABELS[state.timerMode]}剩余 ${formatCountdown(state.remainingSeconds)}`}
              >
                {/* Fine chronometer outer ticks */}
                <g aria-hidden="true">
                  {DIAL_TICKS.map((tick) => (
                    <line
                      key={tick.index}
                      x1={tick.x1.toFixed(2)}
                      y1={tick.y1.toFixed(2)}
                      x2={tick.x2.toFixed(2)}
                      y2={tick.y2.toFixed(2)}
                      stroke={tick.isMajor ? 'var(--color-hairline-strong)' : 'var(--color-hairline)'}
                      strokeWidth={tick.isMajor ? 1.25 : 0.85}
                      strokeLinecap="round"
                    />
                  ))}
                </g>

                {/* Base track circle */}
                <circle
                  cx={RING_CENTER}
                  cy={RING_CENTER}
                  r={RING_RADIUS}
                  fill="none"
                  stroke="var(--color-hairline-strong)"
                  strokeWidth={3}
                />

                {/* Active countdown arc */}
                <circle
                  cx={RING_CENTER}
                  cy={RING_CENTER}
                  r={RING_RADIUS}
                  fill="none"
                  stroke={strokeVar}
                  strokeWidth={4.5}
                  strokeLinecap="round"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={dashOffset}
                  transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
                  style={{ transition: 'stroke-dashoffset 240ms cubic-bezier(0.22, 1, 0.36, 1)' }}
                />
              </svg>

              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[12px] text-ink-muted">{timerStatusText}</span>
                <span className="tabular-nums-mono mt-1 text-[42px] font-medium leading-none tracking-[-0.03em] text-ink sm:text-[46px]">
                  {formatCountdown(state.remainingSeconds)}
                </span>
                <span className="mt-2.5 text-[12px] text-ink-muted">
                  已完成{' '}
                  <strong className="tabular-nums-mono font-medium text-ink">
                    {state.completedSessions}
                  </strong>{' '}
                  轮专注
                </span>
              </div>
            </div>

            {/* Start / Pause / Reset controls */}
            <div className="flex items-center justify-center gap-2.5">
              {state.timerStatus === 'running' ? (
                <button
                  type="button"
                  onClick={pauseTimer}
                  className="pill-cta-primary min-h-[42px] min-w-[132px] px-5 text-[14px]"
                >
                  <Pause className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>暂停计时</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startTimer}
                  className="pill-cta-primary min-h-[42px] min-w-[132px] px-5 text-[14px]"
                >
                  <Play className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{state.timerStatus === 'paused' ? '继续计时' : '开始专注'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={resetTimer}
                aria-label="重置计时器"
                className="pill-cta-secondary min-h-[42px] px-4 text-[14px]"
              >
                <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>重置</span>
              </button>
            </div>
          </div>

          {/* Presets & Session Counter */}
          <div className="mt-6 space-y-4 border-t border-hairline pt-4">
            <div>
              <div className="mb-2 flex items-center justify-between text-[12.5px] text-ink-muted">
                <span>节奏预设</span>
                <span className="tabular-nums-mono">每 4 轮进入长休</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {POMODORO_PRESETS.map((preset) => {
                  const selected = state.presetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setPreset(preset.id)}
                      className={`flex flex-col items-center rounded-[12px] border px-2 py-2 text-center transition-colors ${
                        selected
                          ? 'border-accent/50 bg-surface text-ink'
                          : 'border-hairline bg-transparent text-ink-muted hover:border-hairline-strong hover:text-ink'
                      }`}
                    >
                      <span className="tabular-nums-mono text-[13.5px] font-medium">
                        {preset.label}
                      </span>
                      <span className="mt-0.5 text-[11px] opacity-80">{preset.caption}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-[12px] border border-hairline bg-surface/70 px-3.5 py-2.5 text-[12.5px]">
              <span className="text-ink-muted">本轮番茄进度</span>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  {[0, 1, 2, 3].map((slot) => {
                    const filled = slot < (state.completedSessions % 4);
                    return (
                      <span
                        key={slot}
                        className={`h-2 w-2 rounded-full transition-colors ${
                          filled ? 'bg-postmark' : 'bg-hairline-strong'
                        }`}
                      />
                    );
                  })}
                </div>
                <span className="tabular-nums-mono font-medium text-ink">
                  {state.completedSessions} 次
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Right: 4-Channel Soundscape Mixer */}
        <section
          aria-label="环境白噪音混音台"
          className="flex flex-col justify-between rounded-[20px] border border-hairline bg-surface p-5 sm:p-6"
        >
          <div>
            {/* Mixer Header & Master Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[17px] font-medium text-ink">四轨自然声场混音</h3>
                <p className="mt-0.5 text-[13px] text-ink-muted">
                  点击卡片即刻合奏，可自由叠合音量比例；计时结束时轻响谐波钟声。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={togglePlayAll}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-hairline-strong bg-paper px-4 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover"
                >
                  {state.isPlaying ? (
                    <>
                      <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>暂停声音</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>播放混音</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={stopAll}
                  disabled={!state.isPlaying && enabledCount === 0}
                  aria-label="全部静音并清空已选音轨"
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-full border border-hairline bg-transparent px-3.5 text-[13px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>静音</span>
                </button>
              </div>
            </div>

            {state.audioError && (
              <div
                role="alert"
                className="mt-3 rounded-[12px] border border-postmark/30 bg-paper px-3.5 py-2.5 text-[13px] text-postmark"
              >
                {state.audioError}
              </div>
            )}

            {/* Master Volume & Visibility Behavior */}
            <div className="mt-4 flex flex-col gap-3 rounded-[14px] border border-hairline bg-paper p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Volume2 className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <label htmlFor="ambience-master-volume" className="shrink-0 text-[13px] text-ink">
                  总音量
                </label>
                <input
                  id="ambience-master-volume"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(state.masterVolume * 100)}
                  onChange={(e) => setMasterVolume(Number(e.target.value) / 100)}
                  className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent"
                />
                <span className="tabular-nums-mono w-10 shrink-0 text-right text-[12.5px] text-ink-muted">
                  {Math.round(state.masterVolume * 100)}%
                </span>
              </div>

              <span aria-hidden="true" className="hidden h-5 w-px bg-hairline sm:block" />

              <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-muted select-none">
                <input
                  type="checkbox"
                  checked={state.pauseOnHidden}
                  onChange={(e) => setPauseOnHidden(e.target.checked)}
                  className="h-4 w-4 rounded border-hairline-strong accent-accent"
                />
                <span>切离标签页自动静音</span>
              </label>
            </div>

            {/* 4 Soundscape Channel Cards */}
            <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              {AMBIENCE_TRACKS.map((track) => {
                const trackState = state.tracks[track.id];
                const Icon = TRACK_ICONS[track.id];
                const activeSounding = trackState.enabled && state.isPlaying;
                const percent = Math.round(trackState.volume * 100);

                return (
                  <div
                    key={track.id}
                    className={`rounded-[16px] border p-4 transition-colors ${
                      trackState.enabled
                        ? 'border-accent/45 bg-paper'
                        : 'border-hairline bg-paper/55 hover:border-hairline-strong'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2.5">
                      <button
                        type="button"
                        onClick={() => toggleTrack(track.id)}
                        aria-pressed={trackState.enabled}
                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      >
                        <span
                          className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors ${
                            activeSounding
                              ? 'border-accent/40 bg-accent/12 text-accent'
                              : trackState.enabled
                                ? 'border-hairline-strong bg-surface text-ink'
                                : 'border-hairline bg-surface text-ink-muted'
                          }`}
                        >
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[15px] font-medium text-ink">
                            {track.label}
                          </span>
                          <span className="mt-0.5 block text-[12px] leading-[1.5] text-ink-muted">
                            {track.subtitle}
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleTrack(track.id)}
                        aria-pressed={trackState.enabled}
                        aria-label={`${trackState.enabled ? '关闭' : '开启'}${track.label}`}
                        className={`shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                          activeSounding
                            ? 'border-accent/40 bg-accent/12 text-accent'
                            : trackState.enabled
                              ? 'border-hairline-strong bg-surface text-ink'
                              : 'border-hairline bg-transparent text-ink-muted hover:text-ink'
                        }`}
                      >
                        {activeSounding ? '发声中' : trackState.enabled ? '已选' : '开启'}
                      </button>
                    </div>

                    <div className="mt-4 flex items-center gap-2.5">
                      <label
                        htmlFor={`track-vol-${track.id}`}
                        className="shrink-0 text-[12px] text-ink-muted"
                      >
                        音量
                      </label>
                      <input
                        id={`track-vol-${track.id}`}
                        type="range"
                        min={0}
                        max={100}
                        value={percent}
                        aria-label={`${track.label}音量`}
                        onChange={(e) => setTrackVolume(track.id, Number(e.target.value) / 100)}
                        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent"
                      />
                      <span className="tabular-nums-mono w-9 shrink-0 text-right text-[12px] text-ink-muted">
                        {percent}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Companion Dock Hint */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-hairline bg-paper px-4 py-3 text-[13px] text-ink-muted">
            <p className="m-0">开启后切去翻看旅图或星图，右下角浮窗将继续陪伴</p>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href="/atlas"
                onClick={handleSpaLink('/atlas')}
                className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1 text-[12.5px] text-ink no-underline transition-colors hover:border-hairline-strong hover:bg-surface-hover"
              >
                <MapIcon className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                <span>去翻旅图</span>
              </a>
              <a
                href="/observatory"
                onClick={handleSpaLink('/observatory')}
                className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1 text-[12.5px] text-ink no-underline transition-colors hover:border-hairline-strong hover:bg-surface-hover"
              >
                <Compass className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                <span>去观星台</span>
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
