import { useTheme } from '../lib/theme';

type ThemeToggleProps = {
  variant?: 'default' | 'cosmic-glass';
};

export function ThemeToggle({ variant = 'default' }: ThemeToggleProps = {}) {
  const { preference, resolved, toggle } = useTheme();
  const isDark = resolved === 'dark';
  const modeLabel =
    preference === 'system'
      ? `当前：跟随系统（${isDark ? '深色' : '浅色'}）· 点击切换`
      : `当前：固定${isDark ? '深色' : '浅色'} · 点击切换`;

  const buttonClass =
    variant === 'cosmic-glass'
      ? 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 bg-[#101420]/45 text-white/82 shadow-[0_4px_20px_rgba(0,0,0,0.22)] backdrop-blur-md transition-colors hover:border-white/28 hover:bg-[#101420]/65 hover:text-white sm:h-10 sm:w-10'
      : 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-transparent text-ink-muted transition-colors hover:bg-surface hover:text-ink';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? '切换至浅色模式' : '切换至深色模式'}
      title={modeLabel}
      className={buttonClass}
    >
      {isDark ? (
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  );
}
