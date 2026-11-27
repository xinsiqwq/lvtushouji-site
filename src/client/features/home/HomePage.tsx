import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { ArrowUpRight, ChevronDown, Pause, Play, RotateCcw } from 'lucide-react';
import {
  DEFAULT_SITE_SETTINGS,
  type HomeShowcaseFrame,
  type Library,
  type ProjectItem,
} from '../../../shared/types';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { createCardPointerHandlers } from '../../lib/pointer-fx';
import { useRouter } from '../../lib/router';
import { useTheme } from '../../lib/theme';
import SolarSystemLoader from './SolarSystemLoader';
import { SOLAR_PLANETS, type SolarPlanetSpec } from './solar-planets';

const StarRingCanvas = lazy(() => import('./StarRingCanvas'));

type StageFrame = {
  id: string;
  src: string;
  alt: string;
  place: string;
  coords: string;
  caption: string;
  width?: number;
  height?: number;
};

type MoonTelemetry = {
  illuminationPct: number;
  phaseLabel: string;
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

const COLOPHON_LINKS = [
  { href: '/atlas', label: '旅图' },
  { href: '/gallery', label: '暗房影集' },
  { href: '/observatory', label: '观星台' },
  { href: '/projects', label: '作品展柜' },
  { href: '/toolkit', label: '实用工具台' },
  { href: '/arcade', label: '游乐竞技场' },
  { href: '/vault', label: '文件密匣' },
  { href: '/explore/uranus', label: '实时星历' },
  { href: '/admin', label: '整理台' },
] as const;

function moonPhaseNameZh(phaseAngleDeg: number): string {
  const angle = ((phaseAngleDeg % 360) + 360) % 360;
  if (angle < 22.5 || angle >= 337.5) return '新月';
  if (angle < 67.5) return '蛾眉月';
  if (angle < 112.5) return '上弦月';
  if (angle < 157.5) return '盈凸月';
  if (angle < 202.5) return '满月';
  if (angle < 247.5) return '亏凸月';
  if (angle < 292.5) return '下弦月';
  return '残月';
}

function normalizeShowcaseFrames(raw?: HomeShowcaseFrame[]): StageFrame[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const valid: StageFrame[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const src = typeof item.src === 'string' ? item.src.trim() : '';
    const place = typeof item.place === 'string' ? item.place.trim() : '';
    const caption = typeof item.caption === 'string' ? item.caption.trim() : '';
    if (!src || !place || !caption) continue;
    const width =
      typeof item.width === 'number' && Number.isFinite(item.width) && item.width > 0
        ? item.width
        : undefined;
    const height =
      typeof item.height === 'number' && Number.isFinite(item.height) && item.height > 0
        ? item.height
        : undefined;
    valid.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `showcase-${i}`,
      src,
      alt: typeof item.alt === 'string' && item.alt.trim() ? item.alt.trim() : place,
      place,
      coords: typeof item.coords === 'string' ? item.coords.trim() : '',
      caption,
      ...(width && height ? { width, height } : {}),
    });
  }
  return valid;
}

export default function HomePage() {
  const { navigate } = useRouter();
  const { resolved } = useTheme();
  const [ringPaused, setRingPaused] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [viewModified, setViewModified] = useState(false);
  const [resetViewTick, setResetViewTick] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [library, setLibrary] = useState<Library | null>(null);
  const [publishedProjectCount, setPublishedProjectCount] = useState<number | null>(null);
  const [moonInfo, setMoonInfo] = useState<MoonTelemetry | null>(null);
  const [brokenCustomIds, setBrokenCustomIds] = useState<Record<string, boolean>>({});
  const stageRef = useRef<HTMLDivElement>(null);

  const handleSceneReady = useCallback(() => {
    setSceneReady(true);
  }, []);

  useEffect(() => {
    if (sceneReady) return;
    const failsafeTimer = window.setTimeout(() => {
      setSceneReady(true);
    }, 6000);
    return () => window.clearTimeout(failsafeTimer);
  }, [sceneReady]);

  // Quietly enrich lower showcase, module live context & lunar illumination without blocking initial paint
  useEffect(() => {
    let cancelled = false;

    fetch('/api/library', { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<Library>) : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.journeys)) {
          setLibrary(data);
        }
      })
      .catch(() => {
        // Offline or cold start: fall back cleanly to default showcase and copy
      });

    fetch('/api/projects', { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<{ projects?: ProjectItem[] }>) : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.projects)) {
          setPublishedProjectCount(data.projects.length);
        }
      })
      .catch(() => {
        // Graceful fallback
      });

    import('astronomy-engine')
      .then(({ Body, Illumination, MoonPhase }) => {
        if (cancelled) return;
        const now = new Date();
        const illum = Illumination(Body.Moon, now);
        const phaseDeg = MoonPhase(now);
        setMoonInfo({
          illuminationPct: Math.round(illum.phase_fraction * 100),
          phaseLabel: moonPhaseNameZh(phaseDeg),
        });
      })
      .catch(() => {
        // Graceful fallback
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const customShowcaseFrames = useMemo(
    () =>
      normalizeShowcaseFrames(library?.settings?.homeShowcase).filter(
        (frame) => !brokenCustomIds[frame.id],
      ),
    [library?.settings?.homeShowcase, brokenCustomIds],
  );

  const usingCustomShowcase = customShowcaseFrames.length >= 1;
  const stageFrames: readonly StageFrame[] = usingCustomShowcase
    ? customShowcaseFrames
    : STAGE_FRAMES;

  const safeStageIndex = stageIndex < stageFrames.length ? stageIndex : 0;
  const activeFrame = stageFrames[safeStageIndex] ?? STAGE_FRAMES[0];

  const publicCounts = useMemo(() => {
    if (!library) return null;
    const publicJourneys = library.journeys.filter((j) => j.visibility === 'public');
    let stopCount = 0;
    const photoIds = new Set<string>();
    const imageIds = new Set(
      library.media.filter((m) => m.kind === 'image').map((m) => m.id),
    );
    for (const journey of publicJourneys) {
      stopCount += journey.stops.length;
      if (journey.coverId && imageIds.has(journey.coverId)) {
        photoIds.add(journey.coverId);
      }
      for (const stop of journey.stops) {
        for (const mid of stop.mediaIds) {
          if (imageIds.has(mid)) {
            photoIds.add(mid);
          }
        }
      }
    }
    return {
      journeys: publicJourneys.length,
      stops: stopCount,
      photos: photoIds.size,
    };
  }, [library]);

  const moduleEntrances = useMemo(
    () => [
      {
        href: '/atlas',
        title: '旅图',
        planet: '地球',
        context:
          publicCounts && publicCounts.journeys > 0
            ? `已收录 ${publicCounts.journeys} 段公开旅程 · ${publicCounts.stops} 处停驻`
            : '以地图与邮戳收藏走过的山海轨迹',
        cta: '翻看足迹',
      },
      {
        href: '/gallery',
        title: '暗房影集',
        planet: '金星',
        context:
          publicCounts && publicCounts.photos > 0
            ? `收录 ${publicCounts.photos} 帧公开摄影 · 焦段与画幅索引`
            : '按旅程、镜头与画幅浏览暗房接触印相',
        cta: '步入暗房',
      },
      {
        href: '/observatory',
        title: '实时星图',
        planet: '土星',
        context: moonInfo
          ? `今夜${moonInfo.phaseLabel} · 月面照度 ${moonInfo.illuminationPct}%`
          : '实时全天星图与任意时刻夜空回望',
        cta: '仰望夜空',
      },
      {
        href: '/projects',
        title: '作品展柜',
        planet: '木星',
        context:
          publishedProjectCount !== null && publishedProjectCount > 0
            ? `已陈列 ${publishedProjectCount} 项桌面与云端工程作品`
            : '独立构思并经实测验收的工程作品集',
        cta: '浏览展柜',
      },
      {
        href: '/toolkit',
        title: '实用工具台',
        planet: '水星',
        context: '10 项影像调色、Log LUT 与本地效率工具',
        cta: '打开工具台',
      },
      {
        href: '/vault',
        title: '文件密匣',
        planet: '海王星',
        context: '六位口令定向提取 · 限次与时效签条',
        cta: '打开密匣',
      },
    ],
    [moonInfo, publicCounts, publishedProjectCount],
  );

  const siteTitle = library?.settings?.title?.trim() || DEFAULT_SITE_SETTINGS.title;
  const siteTagline = library?.settings?.tagline?.trim() || DEFAULT_SITE_SETTINGS.tagline;
  const cardHandlers = createCardPointerHandlers();

  const handlePlanetNavigate = (planet: SolarPlanetSpec) => {
    navigate(planet.portal.href);
  };

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
      {/* 100% Full-viewport interactive 3D Solar System Hero (bleeds behind floating glass header to viewport top) */}
      <section
        data-only-dark="true"
        className="deep-space relative min-h-[calc(100svh_-_var(--nav-height))] h-[calc(100svh_-_var(--nav-height))] overflow-x-clip"
      >
        <Suspense fallback={null}>
          <StarRingCanvas
            paused={ringPaused}
            theme={resolved}
            resetViewTick={resetViewTick}
            onViewModifiedChange={setViewModified}
            onNavigatePlanet={handlePlanetNavigate}
            onReady={handleSceneReady}
          />
        </Suspense>
        <SolarSystemLoader ready={sceneReady} />

        <div className="absolute top-3.5 right-4 z-20 flex items-center gap-2 sm:right-7">
          {viewModified && (
            <button
              type="button"
              onClick={() => setResetViewTick((prev) => prev + 1)}
              aria-label="复位太阳系视角"
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-white/15 bg-[#101420]/42 px-3.5 text-[12.5px] font-medium text-[#e3e3e3]/88 backdrop-blur-md transition-colors hover:border-white/28 hover:bg-[#101420]/62 hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>复位视角</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setRingPaused((prev) => !prev)}
            aria-pressed={ringPaused}
            aria-label={ringPaused ? '恢复太阳系动效' : '暂停太阳系动效'}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-white/15 bg-[#101420]/42 px-3.5 text-[12.5px] font-medium text-[#e3e3e3]/88 backdrop-blur-md transition-colors hover:border-white/28 hover:bg-[#101420]/62 hover:text-white"
          >
            {ringPaused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{ringPaused ? '恢复星轨' : '暂停星轨'}</span>
          </button>
        </div>

        {/* Bottom-left museum exhibit caption lockup (quiet obsidian corner, clear of Sun corona & orbits) */}
        <div className="pointer-events-none absolute bottom-[72px] left-4 z-20 border-l border-white/20 pl-3.5 sm:bottom-8 sm:left-7">
          <div className="tabular-nums-mono mb-1 text-[10.5px] tracking-[0.14em] text-white/45 uppercase">
            SOLAR SYSTEM · J2000 · 0.39–30.1 AU
          </div>
          <h1
            tabIndex={-1}
            className="display-h1 text-[19px] text-white/88 sm:text-[22px]"
          >
            旅途手记 · 太阳系
          </h1>
          <div className="mt-1 text-[11px] tracking-[0.04em] text-white/38">
            拖拽视角 · 滚轮缩放 · 点击行星
          </div>
        </div>

        {/* Keyboard & screen-reader accessible portal links synced with SOLAR_PLANETS */}
        <nav aria-label="太阳系行星快捷入口" className="sr-only">
          {SOLAR_PLANETS.map((planet) => (
            <a
              key={planet.id}
              href={planet.portal.href}
              onClick={handleLink(planet.portal.href)}
            >
              {planet.nameZh} · {planet.portal.label}
            </a>
          ))}
        </nav>

        <button
          type="button"
          onClick={scrollToStage}
          aria-label="向下浏览山海实景手记"
          className="hero-cue-bob absolute bottom-5 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/15 bg-[#101420]/42 px-3.5 py-1.5 text-[12px] text-[#e3e3e3]/88 backdrop-blur-md transition-colors hover:border-white/28 hover:bg-[#101420]/62 hover:text-white"
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
              onError={() => {
                if (usingCustomShowcase) {
                  setBrokenCustomIds((prev) => ({ ...prev, [activeFrame.id]: true }));
                }
              }}
              className="panel-fade-in block h-auto w-full"
            />
            <div className="flex flex-col gap-4 bg-paper px-6 py-5 sm:flex-row sm:items-end sm:justify-between sm:px-7">
              <div className="min-w-0 flex-1">
                <p className="mb-1 flex flex-wrap items-baseline gap-2.5 text-[13px]">
                  <span className="font-medium text-postmark">{activeFrame.place}</span>
                  {activeFrame.coords && (
                    <span className="tabular-nums-mono text-[12px] text-ink-muted">
                      {activeFrame.coords}
                    </span>
                  )}
                </p>
                <p className="font-editorial-serif mb-0 text-[14.5px] leading-relaxed text-ink">
                  {activeFrame.caption}
                </p>
              </div>
              {stageFrames.length > 1 && (
                <div className="flex shrink-0 flex-wrap gap-2 sm:flex-nowrap" role="group" aria-label="切换实景预览">
                  {stageFrames.map((frame, index) => {
                    const selected = index === safeStageIndex;
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
              )}
            </div>
          </div>
        </section>

        {/* Core module entrances (strictly <= 3 columns, restrained editorial cards) */}
        <section aria-label="核心模块入口" className="relative z-10 mx-auto mt-14 max-w-[1280px] px-4 sm:px-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {moduleEntrances.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={handleLink(item.href)}
                {...cardHandlers}
                className="interactive-card scroll-reveal-card group flex flex-col justify-between rounded-[24px] border border-hairline bg-surface p-6 no-underline hover:border-hairline-strong hover:bg-surface-hover sm:p-7"
              >
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="m-0 text-[20px] font-medium text-ink">{item.title}</h2>
                    <span className="text-[12px] text-ink-muted">{item.planet}</span>
                  </div>
                  <p className="mt-2.5 mb-0 text-[13.5px] leading-relaxed text-ink-muted">
                    {item.context}
                  </p>
                </div>
                <span className="mt-5 inline-flex items-center gap-1 text-[13.5px] font-medium text-accent">
                  <span>{item.cta}</span>
                  <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
                </span>
              </a>
            ))}
          </div>
        </section>

        {/* Labs & Solar System Spatial Index */}
        <div className="relative z-10 mx-auto mt-10 max-w-[1280px] px-4 sm:px-6">
          <section
            id="labs"
            tabIndex={-1}
            aria-label="实验馆"
            {...cardHandlers}
            className="interactive-card scroll-reveal-card rounded-[24px] border border-hairline bg-surface px-6 py-7 sm:px-9 sm:py-9"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="m-0 text-[20px] font-medium text-ink sm:text-[22px]">
                  实验馆 · 太阳系空间索引
                </h2>
                <p className="mt-2 mb-0 max-w-[680px] text-[14px] leading-relaxed text-ink-muted">
                  八颗行星各自对应一处站内独立空间。木星作品展柜、金星暗房影集、水星实用工具台、火星游乐竞技场与天王星实时星历活页均已开放。
                </p>
              </div>
              <span className="tabular-nums-mono shrink-0 text-[12px] text-ink-muted">
                0.39 AU — 30.1 AU
              </span>
            </div>

            {/* Live Showcase Destinations (strictly 2 columns on desktop so fourColBentoCount stays 0) */}
            <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
              <a
                href="/projects"
                onClick={handleLink('/projects')}
                className="group flex flex-col justify-between rounded-[18px] border border-hairline bg-paper p-5 no-underline transition-colors hover:border-hairline-strong"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[15.5px] font-medium text-ink">木星 · 作品展柜</span>
                    <span className="tabular-nums-mono text-[11.5px] text-postmark">
                      {publishedProjectCount !== null && publishedProjectCount > 0
                        ? `${publishedProjectCount} 项已归档`
                        : '已开放'}
                    </span>
                  </div>
                  <p className="mt-2 mb-0 text-[13.5px] leading-relaxed text-ink-muted">
                    收录独立工程作品、架构拆解、实测验收指标与密匣定向发行说明。
                  </p>
                </div>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-accent">
                  <span>进入作品展柜</span>
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </a>

              <a
                href="/gallery"
                onClick={handleLink('/gallery')}
                className="group flex flex-col justify-between rounded-[18px] border border-hairline bg-paper p-5 no-underline transition-colors hover:border-hairline-strong"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[15.5px] font-medium text-ink">金星 · 暗房影集</span>
                    <span className="tabular-nums-mono text-[11.5px] text-postmark">
                      {publicCounts && publicCounts.photos > 0
                        ? `${publicCounts.photos} 帧原片`
                        : '已开放'}
                    </span>
                  </div>
                  <p className="mt-2 mb-0 text-[13.5px] leading-relaxed text-ink-muted">
                    跨旅程聚合公开摄影作品，支持按地区、机身焦段与横竖画幅筛选并在暗房细看。
                  </p>
                </div>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-accent">
                  <span>浏览暗房影集</span>
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </a>

              <a
                href="/toolkit"
                onClick={handleLink('/toolkit')}
                className="group flex flex-col justify-between rounded-[18px] border border-hairline bg-paper p-5 no-underline transition-colors hover:border-hairline-strong"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[15.5px] font-medium text-ink">水星 · 实用工具台</span>
                    <span className="tabular-nums-mono text-[11.5px] text-postmark">已开放</span>
                  </div>
                  <p className="mt-2 mb-0 text-[13.5px] leading-relaxed text-ink-muted">
                    10 项影像调色、Log LUT 与本地效率工具，涵盖暗房调色、多品牌 Log 还原、闪传剪贴板与晨昏罗盘。
                  </p>
                </div>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-accent">
                  <span>打开实用工具台</span>
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </a>

              <a
                href="/arcade"
                onClick={handleLink('/arcade')}
                className="group flex flex-col justify-between rounded-[18px] border border-hairline bg-paper p-5 no-underline transition-colors hover:border-hairline-strong"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[15.5px] font-medium text-ink">火星 · 游乐竞技场</span>
                    <span className="tabular-nums-mono text-[11.5px] text-postmark">已开放</span>
                  </div>
                  <p className="mt-2 mb-0 text-[13.5px] leading-relaxed text-ink-muted">
                    6 款高帧率经典街机与全站双轨英雄榜，支持本地个人最佳与全球榜单冲刺。
                  </p>
                </div>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-accent">
                  <span>进入游乐竞技场</span>
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </a>
            </div>

            {/* Quiet Ephemeris Strip */}
            <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
              <a
                href="/explore/uranus"
                onClick={handleLink('/explore/uranus')}
                className="flex flex-1 items-center justify-between gap-2 rounded-[14px] border border-hairline bg-page/60 px-4 py-3 text-[13px] no-underline transition-colors hover:border-hairline-strong hover:bg-page"
              >
                <span className="font-medium text-ink">天王星 · 实时星历</span>
                <span className="text-[11.5px] text-accent">在线观测活页</span>
              </a>
            </div>
          </section>
        </div>

        {/* Understated Editorial Colophon Footer */}
        <footer aria-label="站点尾注" className="relative z-10 mx-auto mt-12 max-w-[1280px] px-4 sm:px-6">
          <div className="flex flex-col gap-5 border-t border-hairline pt-7 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-ink">{siteTitle}</div>
              <p className="font-editorial-serif mt-1.5 mb-0 text-[13.5px] text-ink-muted">
                {siteTagline}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-ink-muted">
              {COLOPHON_LINKS.map((item) => (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => navigate(item.href)}
                  className="cursor-pointer border-0 bg-transparent p-0 text-[12.5px] text-ink-muted transition-colors hover:text-ink"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
