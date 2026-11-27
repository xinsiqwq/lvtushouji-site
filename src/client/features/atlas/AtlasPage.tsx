import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Compass, Lock, Pause, Play, Route } from 'lucide-react';
import { formatDay } from '../../../shared/dates';
import type { Journey, Library, Media, Stop } from '../../../shared/types';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { DarkroomDialog, type DarkroomPhoto } from '../../components/DarkroomDialog';
import { useRouter } from '../../lib/router';
import { useTheme } from '../../lib/theme';

const AtlasMap = lazy(() => import('./AtlasMap'));

function withShareParam(url: string, shareToken: string): string {
  if (!shareToken || !url.startsWith('/api/files/')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}share=${encodeURIComponent(shareToken)}`;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const a = sinLat * sinLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinLng * sinLng;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatLatitudeTag(lat: number): string {
  return `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'N' : 'S'}`;
}

function buildObservatoryHref(stop: Stop, media?: Media): string | null {
  const lat = stop.lat;
  const lng = stop.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  const timeSource = media?.takenAt || `${stop.date}T21:30:00`;
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    time: timeSource,
    place: stop.name,
  });
  return `/observatory?${params.toString()}`;
}

function formatExifSummary(media?: Media): string {
  if (!media?.exif) return '';
  const { model, focalLength, aperture, shutter, iso } = media.exif;
  return [model, focalLength, aperture, shutter, iso ? `ISO ${iso}` : undefined]
    .filter(Boolean)
    .join(' · ');
}

export default function AtlasPage() {
  const { navigate, search } = useRouter();
  const { resolved } = useTheme();

  const shareToken = useMemo(() => new URLSearchParams(search).get('share')?.trim() ?? '', [search]);

  const [library, setLibrary] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedJourneyId, setSelectedJourneyId] = useState<string>('');
  const [activeStopIndex, setActiveStopIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [footprintsToggle, setFootprintsToggle] = useState<boolean | null>(null);

  const [darkroomIndex, setDarkroomIndex] = useState<number | null>(null);
  const [returnFocusEl, setReturnFocusEl] = useState<HTMLElement | null>(null);
  const playbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const mq =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(max-width: 1023px)')
        : null;
    if (!mq) return;
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const libraryUrl = shareToken
      ? `/api/library?share=${encodeURIComponent(shareToken)}`
      : '/api/library';
    fetch(libraryUrl, { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<Library>) : null))
      .then((data) => {
        if (cancelled) return;
        if (data) {
          setLibrary(data);
          if (data.journeys.length > 0) {
            const sharedPrivate = shareToken
              ? data.journeys.find((j) => j.visibility === 'private')
              : undefined;
            setSelectedJourneyId(sharedPrivate?.id ?? data.journeys[0]!.id);
            setActiveStopIndex(0);
          } else {
            setSelectedJourneyId('');
            setActiveStopIndex(0);
          }
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shareToken]);

  const journeys = library?.journeys ?? [];
  const activeJourney: Journey | null = useMemo(() => {
    if (journeys.length === 0) return null;
    return journeys.find((j) => j.id === selectedJourneyId) ?? journeys[0] ?? null;
  }, [journeys, selectedJourneyId]);

  const isSharedPrivateView = Boolean(shareToken) && activeJourney?.visibility === 'private';

  const mediaById = useMemo(() => {
    const map = new Map<string, Media>();
    for (const m of library?.media ?? []) {
      map.set(m.id, m);
    }
    return map;
  }, [library?.media]);

  const footprints = useMemo(() => {
    let totalStops = 0;
    const uniquePhotos = new Set<string>();
    let totalKm = 0;
    let maxLat = -Infinity;
    let minLat = Infinity;

    for (const journey of journeys) {
      totalStops += journey.stops.length;
      let prevValid: { lat: number; lng: number } | null = null;
      for (const stop of journey.stops) {
        for (const mid of stop.mediaIds) {
          uniquePhotos.add(mid);
        }
        const valid =
          Number.isFinite(stop.lat) &&
          Number.isFinite(stop.lng) &&
          Math.abs(stop.lat) <= 90 &&
          Math.abs(stop.lng) <= 180;
        if (valid) {
          if (stop.lat > maxLat) maxLat = stop.lat;
          if (stop.lat < minLat) minLat = stop.lat;
          if (prevValid) {
            totalKm += haversineKm(prevValid.lat, prevValid.lng, stop.lat, stop.lng);
          }
          prevValid = { lat: stop.lat, lng: stop.lng };
        }
      }
    }

    const latSpan =
      Number.isFinite(minLat) && Number.isFinite(maxLat)
        ? Math.abs(maxLat - minLat) < 0.05
          ? formatLatitudeTag(maxLat)
          : `${formatLatitudeTag(minLat)} – ${formatLatitudeTag(maxLat)}`
        : '—';

    return {
      journeyCount: journeys.length,
      stopCount: totalStops,
      photoCount: uniquePhotos.size,
      distanceKm: Math.round(totalKm),
      latSpan,
    };
  }, [journeys]);

  const showFootprints = footprintsToggle ?? !isMobile;

  const stops = activeJourney?.stops ?? [];
  const clampedStopIndex = stops.length > 0 ? Math.min(activeStopIndex, stops.length - 1) : 0;

  const stopPlayback = useCallback(() => {
    setPlaying(false);
    if (playbackTimerRef.current !== null) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!playing || stops.length <= 1) return;
    if (clampedStopIndex >= stops.length - 1) {
      setPlaying(false);
      return;
    }
    playbackTimerRef.current = window.setTimeout(() => {
      setActiveStopIndex((prev) => {
        const next = prev + 1;
        if (next >= stops.length - 1) {
          setPlaying(false);
        }
        return Math.min(stops.length - 1, next);
      });
    }, 2000);

    return () => {
      if (playbackTimerRef.current !== null) {
        window.clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
    };
  }, [clampedStopIndex, playing, stops.length]);

  const darkroomPhotos = useMemo<DarkroomPhoto[]>(() => {
    const items: DarkroomPhoto[] = [];
    for (const stop of stops) {
      for (const mediaId of stop.mediaIds) {
        const m = mediaById.get(mediaId);
        if (!m) continue;
        items.push({
          id: m.id,
          title: stop.name,
          caption: m.caption || stop.note,
          previewUrl: withShareParam(m.preview || `/api/files/${m.id}?variant=preview`, shareToken),
          takenAt: m.takenAt || stop.date,
          lat: stop.lat,
          lng: stop.lng,
          exif: m.exif,
        });
      }
    }
    return items;
  }, [mediaById, shareToken, stops]);

  const photoIndexByMediaId = useMemo(() => {
    const map = new Map<string, number>();
    darkroomPhotos.forEach((p, idx) => map.set(p.id, idx));
    return map;
  }, [darkroomPhotos]);

  const handleSelectJourney = (journeyId: string) => {
    stopPlayback();
    setSelectedJourneyId(journeyId);
    setActiveStopIndex(0);
  };

  const progressRatio = stops.length > 1 ? ((clampedStopIndex + 1) / stops.length) * 100 : 100;

  return (
    <div className="relative overflow-x-clip">
      <CelestialFieldBackdrop variant="subtle-header" />
      <div className={isMobile && drawerOpen ? 'relative z-10 mx-auto max-w-[1440px] px-3 py-2' : 'relative z-10 mx-auto max-w-[1440px] px-3 py-4 sm:px-6 sm:py-6'}>
      {/* Compact Atlas header & journey switcher */}
      <div className={isMobile && drawerOpen ? 'mb-2 flex flex-wrap items-center justify-between gap-2' : 'mb-4 flex flex-wrap items-end justify-between gap-3'}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1
              tabIndex={-1}
              className={
                isMobile && drawerOpen
                  ? 'display-h1 truncate text-[20px] text-ink'
                  : 'display-h1 break-words text-[26px] text-ink sm:text-[32px]'
              }
            >
              {activeJourney ? activeJourney.title : '旅图'}
            </h1>
            {isSharedPrivateView && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-postmark/35 bg-paper px-2.5 py-0.5 text-[11.5px] font-medium text-postmark">
                <Lock className="h-3 w-3" aria-hidden="true" />
                <span>同行私密阅览</span>
              </span>
            )}
          </div>
          {!(isMobile && drawerOpen) && activeJourney?.subtitle && (
            <p className="mt-1 mb-0 max-w-[680px] break-words text-[14px] text-ink-muted">
              {activeJourney.subtitle}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {journeys.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="切换公开旅程">
              {journeys.map((j) => {
                const selected = j.id === activeJourney?.id;
                return (
                  <button
                    key={j.id}
                    type="button"
                    role="tab"
                    onClick={() => handleSelectJourney(j.id)}
                    aria-selected={selected}
                    className={[
                      'min-h-[36px] rounded-full px-3.5 text-[13px] transition-colors',
                      selected
                        ? 'bg-cta-bg font-medium text-cta-text'
                        : 'bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink',
                    ].join(' ')}
                  >
                    {j.title}
                  </button>
                );
              })}
            </div>
          )}

          {journeys.length > 0 && !(isMobile && drawerOpen) && (
            <button
              type="button"
              onClick={() => setFootprintsToggle(!showFootprints)}
              aria-expanded={showFootprints}
              aria-controls="atlas-footprints-overview"
              className={[
                'inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3.5 text-[13px] transition-colors',
                showFootprints
                  ? 'border-hairline-strong bg-paper text-ink'
                  : 'border-hairline bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink',
              ].join(' ')}
            >
              <Route className="h-3.5 w-3.5 text-postmark" aria-hidden="true" />
              <span>足迹总览</span>
            </button>
          )}

          {stops.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={stops.length <= 1}
                onClick={() => {
                  if (!playing && stops.length > 1) {
                    if (clampedStopIndex >= stops.length - 1) setActiveStopIndex(0);
                    setPlaying(true);
                  }
                }}
                aria-pressed={playing}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-cta-bg px-4 text-[13px] font-medium text-cta-text transition-opacity hover:opacity-90 disabled:opacity-45"
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                <span>沿途回放</span>
              </button>
              {playing && (
                <button
                  type="button"
                  onClick={stopPlayback}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-surface px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover"
                >
                  <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>暂停</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Collapsible Footprints Overview Bar */}
      {journeys.length > 0 && showFootprints && !(isMobile && drawerOpen) && (
        <div
          id="atlas-footprints-overview"
          aria-label="足迹总览"
          className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[18px] border border-hairline bg-surface/85 px-4 py-2.5 text-[12.5px] text-ink-muted"
        >
          <span className="font-medium text-ink">足迹总览</span>
          <span className="inline-flex items-baseline gap-1.5">
            <span>旅程</span>
            <strong className="tabular-nums-mono font-medium text-ink">
              {footprints.journeyCount}
            </strong>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span>停驻</span>
            <strong className="tabular-nums-mono font-medium text-ink">
              {footprints.stopCount}
            </strong>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span>影像</span>
            <strong className="tabular-nums-mono font-medium text-ink">
              {footprints.photoCount}
            </strong>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span>累计航迹</span>
            <strong className="tabular-nums-mono font-medium text-ink">
              {footprints.distanceKm.toLocaleString('en-US')} km
            </strong>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span>纬度跨度</span>
            <strong className="tabular-nums-mono font-medium text-ink">
              {footprints.latSpan}
            </strong>
          </span>
        </div>
      )}

      {/* Progress bar & active stop indicator */}
      {stops.length > 0 && (
        <div className={isMobile && drawerOpen ? 'mb-2 flex items-center gap-3' : 'mb-4 flex items-center gap-3'}>
          <div
            aria-label="路线进度"
            className="h-1 flex-1 overflow-hidden rounded-full bg-surface"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${progressRatio}%` }}
            />
          </div>
          <span className="tabular-nums-mono shrink-0 text-[12px] text-ink-muted">
            第 {clampedStopIndex + 1} / {stops.length} 站
          </span>
        </div>
      )}

      {/* Asymmetric Split: ~62% Map left, ~38% Journal Cards right on desktop; Map top + Drawer bottom on mobile */}
      <div className={isMobile && drawerOpen ? 'grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]' : 'grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]'}>
        {/* Left: 2.5D Interactive Map */}
        <div
          className={
            isMobile
              ? drawerOpen
                ? 'h-[164px] min-h-[164px] overflow-hidden rounded-[24px]'
                : 'h-[360px] min-h-[360px] overflow-hidden rounded-[24px]'
              : 'h-[44vh] min-h-[260px] overflow-hidden rounded-[24px] lg:sticky lg:top-[76px] lg:h-[calc(100dvh-140px)]'
          }
        >
          <Suspense
            fallback={
              <div className="flex h-full min-h-[260px] items-center justify-center rounded-[24px] bg-surface text-[14px] text-ink-muted">
                正在铺开地图轮廓……
              </div>
            }
          >
            <AtlasMap
              stops={stops}
              activeStopIndex={clampedStopIndex}
              theme={resolved}
              onSelectStop={(idx) => {
                stopPlayback();
                setActiveStopIndex(idx);
              }}
              onManualInteract={stopPlayback}
            />
          </Suspense>
        </div>

        {/* Right / Bottom Drawer: Mounted Bone-White Journal Cards */}
        <div className="min-w-0">
          {isMobile && stops.length > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-[16px] bg-surface px-4 py-2.5">
              <span className="text-[13px] font-medium text-ink">
                第 {clampedStopIndex + 1} / {stops.length} 站 · {stops[clampedStopIndex]?.name}
              </span>
              <button
                type="button"
                onClick={() => setDrawerOpen((prev) => !prev)}
                aria-expanded={drawerOpen}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-full bg-cta-bg px-3 text-[12.5px] font-medium text-cta-text"
              >
                <span>{drawerOpen ? '收起手记' : '展开手记'}</span>
                {drawerOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
          )}

          {loading ? (
            <div className="rounded-[24px] bg-surface p-8 text-[14px] text-ink-muted">
              正在读取旅途手记……
            </div>
          ) : stops.length === 0 ? (
            <div className="rounded-[24px] border border-hairline bg-surface p-8">
              <p className="m-0 text-[15px] font-medium text-ink">暂无公开旅图。</p>
              <p className="font-editorial-serif mt-2.5 mb-0 text-[13.5px] leading-relaxed text-ink-muted">
                沿途胶片与轨迹尚在安静整理之中。你可以先去观星台望一眼今夜天穹，或移步整理台编排第一段山海路线。
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2.5">
                <a
                  href="/observatory"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate('/observatory');
                  }}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-paper px-4 text-[13px] font-medium text-ink no-underline transition-colors hover:bg-surface-hover"
                >
                  <Compass className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                  <span>前往观星台</span>
                </a>
                <a
                  href="/admin"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate('/admin');
                  }}
                  className="inline-flex min-h-[36px] items-center rounded-full border border-hairline bg-page/60 px-4 text-[13px] text-ink-muted no-underline transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  前往整理台
                </a>
              </div>
            </div>
          ) : (
            <div className={isMobile && drawerOpen ? 'space-y-1.5' : 'space-y-4'}>
              {stops.map((stop, index) => {
                const isActive = index === clampedStopIndex;
                const hideOnCollapsedMobile = isMobile && !drawerOpen && !isActive;
                const primaryMedia = stop.mediaIds.map((mid) => mediaById.get(mid)).find(Boolean);
                const exifText = formatExifSummary(primaryMedia);
                const skyHref = buildObservatoryHref(stop, primaryMedia);
                const displayDate = formatDay(primaryMedia?.takenAt || stop.date);
                const compactMobile = isMobile && drawerOpen;

                return (
                  <article
                    key={stop.id}
                    hidden={hideOnCollapsedMobile}
                    aria-hidden={hideOnCollapsedMobile || undefined}
                    aria-current={isActive ? 'step' : undefined}
                    onClick={() => {
                      stopPlayback();
                      setActiveStopIndex(index);
                    }}
                    className={[
                      'cursor-pointer rounded-[24px]',
                      compactMobile ? 'p-2.5' : 'p-5 sm:p-6',
                      isActive ? 'bg-paper ring-1 ring-accent/40' : 'bg-paper',
                    ].join(' ')}
                  >
                    <div className={stop.mediaIds.length > 0 ? 'flex items-start justify-between gap-3' : ''}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 text-left">
                            <h2
                              className={
                                compactMobile
                                  ? 'm-0 truncate text-[15px] font-medium text-ink'
                                  : 'm-0 text-[18px] font-medium text-ink'
                              }
                            >
                              {stop.name}
                            </h2>
                            {stop.region && !compactMobile && (
                              <span className="mt-0.5 block text-[12.5px] text-ink-muted">
                                {stop.region}
                              </span>
                            )}
                          </div>

                          {displayDate && (
                            <span
                              aria-label={`邮戳日期 ${displayDate}`}
                              className={
                                compactMobile
                                  ? 'tabular-nums-mono inline-flex h-6 shrink-0 items-center justify-center rounded-full border border-postmark px-2 text-center text-[10px] font-medium text-postmark'
                                  : 'tabular-nums-mono inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-postmark px-1 text-center text-[9.5px] leading-tight font-medium tracking-tight text-postmark'
                              }
                            >
                              {displayDate}
                            </span>
                          )}
                        </div>

                        {stop.note && (
                          <p
                            className={[
                              'font-editorial-serif mb-0 break-words leading-relaxed text-ink',
                              compactMobile
                                ? 'mt-1 line-clamp-1 text-[12.5px]'
                                : 'mt-3 line-clamp-2 text-[14.5px]',
                            ].join(' ')}
                          >
                            {stop.note}
                          </p>
                        )}

                        <div
                          className={[
                            'flex flex-wrap items-center justify-between gap-2 border-t border-hairline',
                            compactMobile ? 'mt-1.5 pt-1.5' : 'mt-3 pt-2.5',
                          ].join(' ')}
                        >
                          <div
                            className={[
                              'tabular-nums-mono flex min-w-0 flex-wrap items-center gap-2 text-ink-muted',
                              compactMobile ? 'max-w-[200px] truncate text-[10.5px]' : 'text-[12px]',
                            ].join(' ')}
                          >
                            {exifText && <span className={compactMobile ? 'truncate' : ''}>{exifText}</span>}
                            {Number.isFinite(stop.lat) && Number.isFinite(stop.lng) && !compactMobile && (
                              <span>
                                {Math.abs(stop.lat).toFixed(4)}° {stop.lat >= 0 ? 'N' : 'S'} /{' '}
                                {Math.abs(stop.lng).toFixed(4)}° {stop.lng >= 0 ? 'E' : 'W'}
                              </span>
                            )}
                          </div>

                          {skyHref && (
                            <a
                              href={skyHref}
                              onClick={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                                navigate(skyHref);
                              }}
                              className={[
                                'inline-flex items-center gap-1 rounded-full bg-surface font-medium text-accent no-underline transition-colors hover:bg-surface-hover',
                                compactMobile ? 'min-h-[26px] px-2.5 text-[11px]' : 'min-h-[34px] gap-1.5 px-3 text-[12.5px]',
                              ].join(' ')}
                            >
                              <Compass className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>回望此地当夜星空</span>
                            </a>
                          )}
                        </div>
                      </div>

                      {stop.mediaIds.length > 0 && (
                        <div className={compactMobile ? 'w-[72px] shrink-0 space-y-1' : 'w-[144px] shrink-0 space-y-2 sm:w-[164px]'}>
                          {stop.mediaIds.map((mediaId) => {
                            const media = mediaById.get(mediaId);
                            if (!media) return null;
                            const photoIdx = photoIndexByMediaId.get(media.id) ?? 0;
                            const imgSrc = withShareParam(
                              media.thumbnail || `/api/files/${media.id}?variant=thumbnail`,
                              shareToken,
                            );
                            return (
                              <button
                                key={media.id}
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  stopPlayback();
                                  setReturnFocusEl(event.currentTarget);
                                  setDarkroomIndex(photoIdx);
                                }}
                                aria-label="在暗房查看摄影原件"
                                className="flex w-full justify-center overflow-hidden rounded-[12px] bg-paper p-1 text-left transition-opacity hover:opacity-95"
                              >
                                <img
                                  src={imgSrc}
                                  alt={media.caption || stop.name}
                                  loading="lazy"
                                  className={
                                    compactMobile
                                      ? 'block h-auto max-h-[48px] w-auto max-w-full rounded-[8px]'
                                      : 'block h-auto w-auto max-w-full rounded-[8px]'
                                  }
                                />
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <DarkroomDialog
        photos={darkroomPhotos}
        activeIndex={darkroomIndex}
        onChangeIndex={(idx) => setDarkroomIndex(idx)}
        onClose={() => setDarkroomIndex(null)}
        returnFocusEl={returnFocusEl}
      />
      </div>
    </div>
  );
}
