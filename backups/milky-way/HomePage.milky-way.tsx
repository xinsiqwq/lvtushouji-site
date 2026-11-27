import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react';
import { ChevronDown, Pause, Play } from 'lucide-react';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { createCardPointerHandlers, createMagneticHandlers } from '../../lib/pointer-fx';
import { useRouter } from '../../lib/router';
import { useTheme } from '../../lib/theme';

const StarRingCanvas = lazy(() => import('./StarRingCanvas'));

type StageFrame = {
  id: string;
  src: string;
  alt: string;
  place: string;
  coords: string;
  caption: string;
  width: number;
  height: number;
};

const STAGE_FRAMES: readonly StageFrame[] = [
  {
    id: 'mountain',
    src: '/demo/mountain.jpg',
    alt: '雪峰与晨光里的远山轮廓',
    place: '川西高地',
    coords: '30.06°N · 101.96°E',
    caption: '天刚亮时风停在山脊上，镜头只来得及接住第一寸淡金色的光。',
    width: 1200,
    height: 800,
  },
  {
    id: 'lake',
    src: '/demo/lake.jpg',
    alt: '静水湖面与对岸连绵山影',
    place: '高原湖畔',
    coords: '31.14°N · 90.62°E',
    caption: '水位落下去的傍晚，岸边碎石和倒影把天地分得很轻。',
    width: 1200,
    height: 800,
  },
  {
    id: 'road',
    src: '/demo/road.jpg',
    alt: '向远方蜿蜒伸展的公路',
    place: '荒原公路',
    coords: '37.36°N · 97.37°E',
    caption: '路标很少的午后，车窗外只有风、云影和不断后退的电线杆。',
    width: 1200,
    height: 800,
  },
  {
    id: 'forest',
    src: '/demo/forest.jpg',
    alt: '林间穿透枝叶的微光',
    place: '松林深处',
    coords: '29.65°N · 94.36°E',
    caption: '走过树影稀疏的地方，松针的潮气还留在鞋边。',
    width: 1200,
    height: 799,
  },
];

const MODULE_ENTRANCES = [
  {
    href: '/atlas',
    title: '旅图',
    cta: '翻看足迹',
  },
  {
    href: '/observatory',
    title: '实时星图',
    cta: '仰望夜空',
  },
  {
    href: '/vault',
    title: '文件密匣',
    cta: '打开密匣',
  },
] as const;

export default function HomePage() {
  const { navigate } = useRouter();
  const { resolved } = useTheme();
  const [ringPaused, setRingPaused] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);

  const activeFrame = STAGE_FRAMES[stageIndex] ?? STAGE_FRAMES[0];
  const cardHandlers = createCardPointerHandlers();
  const magneticHandlers = createMagneticHandlers(4);

  const handleLink = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
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

  const scrollToStage = () => {
    const el = document.getElementById('focal-stage');
    if (!el) return;
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  };

  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl || typeof window === 'undefined' || typeof CSS === 'undefined') return;
    if (
      CSS.supports('(animation-timeline: view()) and (animation-range: entry)') ||
      !window.matchMedia('(prefers-reduced-motion: no-preference)').matches
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const scale = 0.94 + Math.min(1, Math.max(0, entry.intersectionRatio)) * 0.06;
          stageEl.style.transform = `scale(${scale.toFixed(4)})`;
        }
      },
      { threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
    );

    observer.observe(stageEl);
    return () => {
      observer.disconnect();
      stageEl.style.transform = '';
    };
  }, []);

  return (
    <div className="pb-[560px]">
      {/* 100% Full-viewport barred spiral Milky Way Hero */}
      <section className="relative flex min-h-[calc(100svh_-_var(--nav-height))] h-[calc(100svh_-_var(--nav-height))] items-center justify-center overflow-hidden px-4 sm:px-6">
        <Suspense fallback={null}>
          <StarRingCanvas paused={ringPaused} theme={resolved} />
        </Suspense>

        <div className="absolute top-4 right-4 z-10 sm:right-6">
          <button
            type="button"
            onClick={() => setRingPaused((prev) => !prev)}
            aria-label={ringPaused ? '恢复银河动效' : '暂停银河动效'}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-hairline bg-surface/85 px-3.5 text-[12.5px] font-medium text-ink-muted backdrop-blur-md transition-colors hover:bg-surface-hover hover:text-ink"
          >
            {ringPaused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{ringPaused ? '恢复银河' : '暂停银河'}</span>
          </button>
        </div>

        {/* Soft contrast veil behind hero copy so Milky Way core stays luminous yet readable */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(480px 185px at 50% 49%, color-mix(in srgb, var(--color-page) 40%, transparent) 0%, color-mix(in srgb, var(--color-page) 10%, transparent) 58%, transparent 100%)',
          }}
        />

        <div className="relative z-10 mx-auto max-w-[760px] text-center">
          <h1
            tabIndex={-1}
            className="display-h1 text-[32px] text-ink sm:text-[48px]"
            style={{ textShadow: '0 2px 24px color-mix(in srgb, var(--color-page) 88%, transparent)' }}
          >
            把走过的山海，和看过的夜空收进一册。
          </h1>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <a href="/atlas" onClick={handleLink('/atlas')} {...magneticHandlers} className="pill-cta-primary">
              打开旅图
            </a>
            <a href="/observatory" onClick={handleLink('/observatory')} {...magneticHandlers} className="pill-cta-secondary">
              进入观星台
            </a>
          </div>
        </div>

        <button
          type="button"
          onClick={scrollToStage}
          aria-label="向下浏览山海实景手记"
          className="hero-cue-bob absolute bottom-5 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline bg-surface/75 px-3.5 py-1.5 text-[12px] text-ink-muted backdrop-blur-md transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <span>向下翻阅山海手记</span>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </section>

      {/* Lower half with cartographic celestial backdrop */}
      <div className="relative overflow-x-clip pt-14 sm:pt-20">
        <CelestialFieldBackdrop variant="home-lower" />

        {/* Compact focal anchor stage cleanly below the hero fold */}
        <section id="focal-stage" aria-label="山海实景锚点" className="relative z-10 mx-auto max-w-[920px] px-4 sm:px-6">
          <div
            ref={stageRef}
            className="scroll-focal-stage relative overflow-hidden rounded-[32px] border border-hairline bg-surface shadow-sm"
            style={{ borderRadius: '32px' }}
          >
            <img
              key={activeFrame.id}
              src={activeFrame.src}
              alt={activeFrame.alt}
              width={activeFrame.width}
              height={activeFrame.height}
              className="panel-fade-in block h-auto w-full object-cover"
            />
            <div className="flex flex-col gap-4 bg-paper px-6 py-5 sm:flex-row sm:items-end sm:justify-between sm:px-7">
              <div className="min-w-0 flex-1">
                <p className="mb-1 flex flex-wrap items-baseline gap-2.5 text-[13px]">
                  <span className="font-medium text-postmark">{activeFrame.place}</span>
                  <span className="tabular-nums-mono text-[12px] text-ink-muted">
                    {activeFrame.coords}
                  </span>
                </p>
                <p className="font-editorial-serif mb-0 text-[14.5px] leading-relaxed text-ink">
                  {activeFrame.caption}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 sm:flex-nowrap" role="group" aria-label="切换实景预览">
                {STAGE_FRAMES.map((frame, index) => {
                  const selected = index === stageIndex;
                  return (
                    <button
                      key={frame.id}
                      type="button"
                      onClick={() => setStageIndex(index)}
                      aria-pressed={selected}
                      className={[
                        'min-h-[34px] shrink-0 whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition-colors',
                        selected
                          ? 'bg-cta-bg font-medium text-cta-text'
                          : 'bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink',
                      ].join(' ')}
                    >
                      {frame.place}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* Three core modules */}
        <section aria-label="核心模块入口" className="relative z-10 mx-auto mt-14 max-w-[1280px] px-4 sm:px-6">
          <div className="grid gap-4 md:grid-cols-3">
            {MODULE_ENTRANCES.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={handleLink(item.href)}
                {...cardHandlers}
                className="interactive-card scroll-reveal-card group flex flex-col justify-between rounded-[24px] border border-hairline bg-surface p-7 no-underline hover:border-hairline-strong hover:bg-surface-hover"
              >
                <h2 className="m-0 text-[20px] font-medium text-ink">{item.title}</h2>
                <span className="mt-5 inline-flex items-center text-[13.5px] font-medium text-accent">
                  {item.cta}
                </span>
              </a>
            ))}
          </div>
        </section>

        {/* Reserved Labs slot */}
        <div className="relative z-10 mx-auto mt-10 max-w-[1280px] px-4 sm:px-6">
          <section
            id="labs"
            tabIndex={-1}
            aria-label="实验馆"
            {...cardHandlers}
            className="interactive-card scroll-reveal-card rounded-[24px] border border-hairline bg-surface px-6 py-8 sm:px-10"
          >
            <h2 className="m-0 text-[20px] font-medium text-ink">实验馆</h2>
          </section>
        </div>

        <footer className="relative z-10 mx-auto mt-12 max-w-[1280px] px-4 sm:px-6">
          <div className="border-t border-hairline pt-6 text-[13px] text-ink-muted">
            旅途手记
          </div>
        </footer>
      </div>
    </div>
  );
}
