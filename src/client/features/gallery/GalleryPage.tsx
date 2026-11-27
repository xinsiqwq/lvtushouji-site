import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Camera, RotateCcw } from 'lucide-react';
import { formatDay } from '../../../shared/dates';
import type { ExifSummary, Library, Media } from '../../../shared/types';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { DarkroomDialog, type DarkroomPhoto } from '../../components/DarkroomDialog';
import { createCardPointerHandlers } from '../../lib/pointer-fx';
import { useRouter } from '../../lib/router';

type OrientationFilter = 'all' | 'landscape' | 'portrait';

type GalleryFrame = {
  media: Media;
  journeyId: string;
  journeyTitle: string;
  stopName: string;
  region: string;
  date: string;
  lat: number | null;
  lng: number | null;
  caption: string;
  orientation: 'landscape' | 'portrait';
};

function formatExifLine(exif?: ExifSummary): string {
  if (!exif) return '';
  return [
    exif.model,
    exif.focalLength,
    exif.aperture,
    exif.shutter,
    exif.iso ? `ISO ${exif.iso}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

function parseFocalSortValue(focal: string): number {
  const m = /(\d+(?:\.\d+)?)/.exec(focal);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

export default function GalleryPage() {
  const { navigate } = useRouter();
  const [library, setLibrary] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [journeyFilter, setJourneyFilter] = useState<string>('all');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [cameraFilter, setCameraFilter] = useState<string>('all');
  const [focalFilter, setFocalFilter] = useState<string>('all');
  const [orientationFilter, setOrientationFilter] = useState<OrientationFilter>('all');

  const [darkroomIndex, setDarkroomIndex] = useState<number | null>(null);
  const [returnFocusEl, setReturnFocusEl] = useState<HTMLElement | null>(null);

  const cardHandlers = createCardPointerHandlers();

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/library', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        throw new Error(`无法读取公开影集（${res.status}）`);
      }
      const data = (await res.json()) as Library;
      setLibrary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '暗房影集暂时无法加载，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // Flatten all public image media joined with their journey/stop context (zero duplicate storage)
  const allFrames = useMemo<GalleryFrame[]>(() => {
    if (!library) return [];
    const mediaById = new Map<string, Media>();
    for (const m of library.media) {
      if (m.kind === 'image') {
        mediaById.set(m.id, m);
      }
    }

    const publicJourneys = library.journeys.filter((j) => j.visibility === 'public');
    const seen = new Set<string>();
    const frames: GalleryFrame[] = [];

    for (const journey of publicJourneys) {
      for (const stop of journey.stops) {
        for (const mediaId of stop.mediaIds) {
          if (seen.has(mediaId)) continue;
          const media = mediaById.get(mediaId);
          if (!media) continue;
          seen.add(mediaId);
          const orientation =
            media.height > 0 && media.width > 0 && media.height > media.width
              ? 'portrait'
              : 'landscape';
          frames.push({
            media,
            journeyId: journey.id,
            journeyTitle: journey.title,
            stopName: stop.name || journey.title,
            region: stop.region?.trim() || '',
            date: media.takenAt || stop.date || journey.startDate,
            lat: media.lat ?? stop.lat ?? null,
            lng: media.lng ?? stop.lng ?? null,
            caption: media.caption?.trim() || stop.note?.trim() || '',
            orientation,
          });
        }
      }

      if (journey.coverId && !seen.has(journey.coverId)) {
        const cover = mediaById.get(journey.coverId);
        if (cover) {
          seen.add(journey.coverId);
          const orientation =
            cover.height > 0 && cover.width > 0 && cover.height > cover.width
              ? 'portrait'
              : 'landscape';
          frames.push({
            media: cover,
            journeyId: journey.id,
            journeyTitle: journey.title,
            stopName: journey.title,
            region: journey.stops[0]?.region?.trim() || '',
            date: cover.takenAt || journey.startDate,
            lat: cover.lat ?? null,
            lng: cover.lng ?? null,
            caption: cover.caption?.trim() || journey.subtitle?.trim() || '',
            orientation,
          });
        }
      }
    }

    return frames;
  }, [library]);

  // Derived filter options from live public frames & EXIF
  const journeyOptions = useMemo(() => {
    const map = new Map<string, { id: string; title: string; count: number }>();
    for (const frame of allFrames) {
      const existing = map.get(frame.journeyId);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(frame.journeyId, {
          id: frame.journeyId,
          title: frame.journeyTitle,
          count: 1,
        });
      }
    }
    return Array.from(map.values());
  }, [allFrames]);

  const regionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const frame of allFrames) {
      if (frame.region) set.add(frame.region);
    }
    return Array.from(set);
  }, [allFrames]);

  const cameraOptions = useMemo(() => {
    const set = new Set<string>();
    for (const frame of allFrames) {
      const model = frame.media.exif?.model?.trim();
      if (model) set.add(model);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allFrames]);

  const focalOptions = useMemo(() => {
    const set = new Set<string>();
    for (const frame of allFrames) {
      const focal = frame.media.exif?.focalLength?.trim();
      if (focal) set.add(focal);
    }
    return Array.from(set).sort((a, b) => {
      const diff = parseFocalSortValue(a) - parseFocalSortValue(b);
      return Number.isFinite(diff) && diff !== 0 ? diff : a.localeCompare(b);
    });
  }, [allFrames]);

  const orientationCounts = useMemo(() => {
    let landscape = 0;
    let portrait = 0;
    for (const frame of allFrames) {
      if (frame.orientation === 'portrait') portrait += 1;
      else landscape += 1;
    }
    return { all: allFrames.length, landscape, portrait };
  }, [allFrames]);

  const filteredFrames = useMemo(() => {
    return allFrames.filter((frame) => {
      if (journeyFilter !== 'all' && frame.journeyId !== journeyFilter) return false;
      if (regionFilter !== 'all' && frame.region !== regionFilter) return false;
      if (cameraFilter !== 'all' && frame.media.exif?.model?.trim() !== cameraFilter) {
        return false;
      }
      if (focalFilter !== 'all' && frame.media.exif?.focalLength?.trim() !== focalFilter) {
        return false;
      }
      if (orientationFilter !== 'all' && frame.orientation !== orientationFilter) {
        return false;
      }
      return true;
    });
  }, [allFrames, cameraFilter, focalFilter, journeyFilter, orientationFilter, regionFilter]);

  const hasActiveFilter =
    journeyFilter !== 'all' ||
    regionFilter !== 'all' ||
    cameraFilter !== 'all' ||
    focalFilter !== 'all' ||
    orientationFilter !== 'all';

  const resetFilters = () => {
    setJourneyFilter('all');
    setRegionFilter('all');
    setCameraFilter('all');
    setFocalFilter('all');
    setOrientationFilter('all');
  };

  const darkroomPhotos = useMemo<DarkroomPhoto[]>(() => {
    return filteredFrames.map((frame) => ({
      id: frame.media.id,
      title: frame.stopName,
      caption: frame.caption || frame.journeyTitle,
      previewUrl: frame.media.preview || `/api/files/${frame.media.id}?variant=preview`,
      takenAt: frame.date,
      lat: frame.lat,
      lng: frame.lng,
      exif: frame.media.exif,
    }));
  }, [filteredFrames]);

  // Keep dialog index in sync if filters change while closed
  useEffect(() => {
    if (darkroomIndex !== null && darkroomIndex >= darkroomPhotos.length) {
      setDarkroomIndex(null);
    }
  }, [darkroomIndex, darkroomPhotos.length]);

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
    <div className="relative min-h-[calc(100dvh_-_var(--nav-height))] overflow-x-clip">
      <CelestialFieldBackdrop variant="subtle-header" />

      <div className="relative z-10 mx-auto max-w-[1320px] px-4 py-8 sm:px-6 sm:py-12">
        {/* Editorial Header */}
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="tabular-nums-mono text-[12px] tracking-[0.08em] text-ink-muted">
              金星轨道 · Venus · 0.72 AU
            </div>
            <h1 tabIndex={-1} className="display-h1 mt-2 text-[30px] text-ink sm:text-[40px]">
              暗房影集
            </h1>
            <p className="font-editorial-serif mt-3 mb-0 max-w-[660px] text-[15px] leading-relaxed text-ink-muted sm:text-[15.5px]">
              所有公开旅程的摄影作品直接在此以接触印相与装裱画幅展开，无需重复上传，点击任意一帧即可进入暗房细看原片。
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {!loading && allFrames.length > 0 && (
              <span className="tabular-nums-mono text-[12.5px] text-ink-muted">
                {hasActiveFilter
                  ? `已筛出 ${filteredFrames.length} / ${allFrames.length} 帧`
                  : `共收录 ${allFrames.length} 帧公开原片`}
              </span>
            )}
            <a
              href="/atlas"
              onClick={handleSpaLink('/atlas')}
              className="pill-cta-secondary min-h-[38px] px-4 text-[13px]"
            >
              <span>在旅图查看足迹</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </header>

        {/* Contact-Sheet Filter Bar */}
        {!loading && !error && allFrames.length > 0 && (
          <section
            aria-label="影集筛选条件"
            className="mt-7 rounded-[22px] border border-hairline bg-surface/90 p-4 sm:p-5"
          >
            {/* Journey pills */}
            {journeyOptions.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-hairline pb-3.5">
                <span className="mr-1 text-[12px] text-ink-muted">旅程</span>
                <button
                  type="button"
                  aria-pressed={journeyFilter === 'all'}
                  onClick={() => setJourneyFilter('all')}
                  className={[
                    'min-h-[32px] rounded-full px-3.5 text-[12.5px] transition-colors',
                    journeyFilter === 'all'
                      ? 'bg-cta-bg font-medium text-cta-text'
                      : 'bg-page/75 text-ink-muted hover:bg-surface-hover hover:text-ink',
                  ].join(' ')}
                >
                  全部旅程
                </button>
                {journeyOptions.map((item) => {
                  const active = journeyFilter === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setJourneyFilter(item.id)}
                      className={[
                        'min-h-[32px] rounded-full px-3.5 text-[12.5px] transition-colors',
                        active
                          ? 'bg-cta-bg font-medium text-cta-text'
                          : 'bg-page/75 text-ink-muted hover:bg-surface-hover hover:text-ink',
                      ].join(' ')}
                    >
                      {item.title}
                      <span className="tabular-nums-mono ml-1.5 opacity-70">{item.count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Orientation + EXIF + Region controls */}
            <div
              className={`flex flex-wrap items-center gap-3 ${journeyOptions.length > 1 ? 'pt-3.5' : ''}`}
            >
              {/* Orientation segmented toggle */}
              <div
                role="group"
                aria-label="按画幅方向筛选"
                className="inline-flex items-center rounded-full border border-hairline bg-page/75 p-0.5"
              >
                {(
                  [
                    { key: 'all', label: '全部', count: orientationCounts.all },
                    { key: 'landscape', label: '横幅', count: orientationCounts.landscape },
                    { key: 'portrait', label: '竖幅', count: orientationCounts.portrait },
                  ] as const
                ).map((opt) => {
                  const active = orientationFilter === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setOrientationFilter(opt.key)}
                      className={[
                        'min-h-[30px] rounded-full px-3 text-[12.5px] transition-colors',
                        active
                          ? 'bg-cta-bg font-medium text-cta-text'
                          : 'text-ink-muted hover:text-ink',
                      ].join(' ')}
                    >
                      {opt.label}
                      <span className="tabular-nums-mono ml-1 text-[11px] opacity-70">
                        {opt.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {regionOptions.length > 0 && (
                <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
                  <span>地区</span>
                  <select
                    aria-label="按地区筛选"
                    value={regionFilter}
                    onChange={(e) => setRegionFilter(e.target.value)}
                    className="min-h-[34px] rounded-full border border-hairline bg-page px-3 text-[12.5px] text-ink outline-none focus:border-accent"
                  >
                    <option value="all">全部地区</option>
                    {regionOptions.map((region) => (
                      <option key={region} value={region}>
                        {region}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {cameraOptions.length > 0 && (
                <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
                  <span>机身</span>
                  <select
                    aria-label="按相机型号筛选"
                    value={cameraFilter}
                    onChange={(e) => setCameraFilter(e.target.value)}
                    className="tabular-nums-mono min-h-[34px] max-w-[200px] rounded-full border border-hairline bg-page px-3 text-[12.5px] text-ink outline-none focus:border-accent"
                  >
                    <option value="all">全部机身</option>
                    {cameraOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {focalOptions.length > 0 && (
                <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
                  <span>焦段</span>
                  <select
                    aria-label="按焦段筛选"
                    value={focalFilter}
                    onChange={(e) => setFocalFilter(e.target.value)}
                    className="tabular-nums-mono min-h-[34px] rounded-full border border-hairline bg-page px-3 text-[12.5px] text-ink outline-none focus:border-accent"
                  >
                    <option value="all">全部焦段</option>
                    {focalOptions.map((focal) => (
                      <option key={focal} value={focal}>
                        {focal}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {hasActiveFilter && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="ml-auto inline-flex min-h-[32px] items-center gap-1 rounded-full border border-hairline bg-page px-3 text-[12px] text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  <span>重置筛选</span>
                </button>
              )}
            </div>
          </section>
        )}

        {/* Contact Sheet Mounted Grid */}
        <div className="mt-8">
          {loading ? (
            <div
              aria-busy="true"
              aria-label="正在展开暗房影集"
              className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
            >
              {[0, 1, 2].map((idx) => (
                <div
                  key={idx}
                  className="rounded-[20px] border border-hairline bg-paper p-4"
                >
                  <div className="flex justify-between">
                    <div className="h-3.5 w-14 rounded bg-surface" />
                    <div className="h-3.5 w-20 rounded bg-surface" />
                  </div>
                  <div className="mt-3 aspect-[3/2] w-full rounded-[8px] bg-surface" />
                  <div className="mt-3.5 h-4 w-32 rounded bg-surface" />
                  <div className="mt-2 h-3.5 w-48 rounded bg-surface" />
                </div>
              ))}
            </div>
          ) : error ? (
            <section
              role="alert"
              className="rounded-[24px] border border-hairline bg-surface p-8 text-center"
            >
              <p className="m-0 text-[15px] text-ink">{error}</p>
              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => void loadLibrary()}
                  className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]"
                >
                  重新读取
                </button>
              </div>
            </section>
          ) : allFrames.length === 0 ? (
            <section className="mx-auto max-w-[600px] rounded-[28px] border border-hairline bg-paper px-6 py-12 text-center shadow-xs sm:px-10">
              <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full border border-hairline bg-surface text-postmark">
                <Camera className="h-5 w-5" aria-hidden="true" />
              </div>
              <h2 className="mt-4 mb-0 text-[20px] font-medium text-ink">
                暗房中暂时还没有公开印相
              </h2>
              <p className="font-editorial-serif mx-auto mt-3 mb-0 max-w-[440px] text-[14.5px] leading-relaxed text-ink-muted">
                在整理台上传旅途照片并将旅程设为公开后，所有作品会自动汇聚到这里，保持原画幅比例并自动归档镜头信息。
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-3">
                <a
                  href="/atlas"
                  onClick={handleSpaLink('/atlas')}
                  className="pill-cta-secondary min-h-[40px] px-5 text-[13.5px]"
                >
                  <span>去旅图看看</span>
                </a>
                <a
                  href="/admin"
                  onClick={handleSpaLink('/admin')}
                  className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]"
                >
                  <span>前往整理台上传</span>
                </a>
              </div>
            </section>
          ) : filteredFrames.length === 0 ? (
            <section className="rounded-[24px] border border-hairline bg-surface p-8 text-center">
              <p className="m-0 text-[15px] text-ink">当前筛选条件下没有找到对应的摄影作品。</p>
              <div className="mt-5">
                <button
                  type="button"
                  onClick={resetFilters}
                  className="pill-cta-secondary min-h-[38px] px-5 text-[13px]"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>清空全部筛选</span>
                </button>
              </div>
            </section>
          ) : (
            <div className="columns-1 gap-5 sm:columns-2 lg:columns-3">
              {filteredFrames.map((frame, index) => {
                const frameNo = `No. ${String(index + 1).padStart(2, '0')}`;
                const postmarkDay = formatDay(frame.date);
                const exifLine = formatExifLine(frame.media.exif);
                const thumbSrc =
                  frame.media.thumbnail ||
                  frame.media.preview ||
                  `/api/files/${frame.media.id}?variant=thumbnail`;

                return (
                  <figure
                    key={frame.media.id}
                    {...cardHandlers}
                    className="interactive-card mb-5 break-inside-avoid rounded-[20px] border border-hairline bg-paper p-3.5 shadow-xs transition-colors hover:border-hairline-strong sm:p-4"
                  >
                    {/* Film Contact-Sheet Header Margin */}
                    <div className="tabular-nums-mono mb-2.5 flex items-center justify-between gap-2 text-[11.5px]">
                      <span className="text-ink-muted">{frameNo}</span>
                      {postmarkDay ? (
                        <span className="text-postmark">{postmarkDay}</span>
                      ) : (
                        <span className="text-ink-muted">
                          {frame.orientation === 'portrait' ? '竖幅' : '横幅'}
                        </span>
                      )}
                    </div>

                    {/* Natural Aspect-Ratio Mounted Print Button */}
                    <button
                      type="button"
                      onClick={(event) => {
                        setReturnFocusEl(event.currentTarget);
                        setDarkroomIndex(index);
                      }}
                      aria-label={`在暗房查看 ${frame.stopName} 摄影原片`}
                      className="block w-full cursor-pointer overflow-hidden rounded-[8px] border-0 bg-surface/50 p-0 text-left transition-opacity hover:opacity-95"
                    >
                      <img
                        src={thumbSrc}
                        alt={frame.caption || frame.stopName}
                        loading="lazy"
                        className="block h-auto w-full rounded-[6px]"
                      />
                    </button>

                    {/* Bone-White Print Caption & EXIF Metadata */}
                    <figcaption className="mt-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-1.5">
                        <span className="text-[14.5px] font-medium text-ink">
                          {frame.stopName}
                        </span>
                        <span className="text-[12px] text-ink-muted">
                          {frame.region ? `${frame.journeyTitle} · ${frame.region}` : frame.journeyTitle}
                        </span>
                      </div>

                      {frame.caption && (
                        <p className="font-editorial-serif mt-1.5 mb-0 line-clamp-2 text-[13.5px] leading-relaxed text-ink-muted">
                          {frame.caption}
                        </p>
                      )}

                      {exifLine && (
                        <div className="tabular-nums-mono mt-2.5 border-t border-hairline pt-2 text-[11.5px] text-ink-muted">
                          {exifLine}
                        </div>
                      )}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          )}
        </div>

        {/* Calm Bottom Navigation */}
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-6 text-[13px] text-ink-muted">
          <a
            href="/"
            onClick={handleSpaLink('/')}
            className="inline-flex items-center gap-1.5 text-ink-muted no-underline transition-colors hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>返回太阳系首页</span>
          </a>
          <a
            href="/projects"
            onClick={handleSpaLink('/projects')}
            className="inline-flex items-center gap-1 text-accent no-underline hover:underline"
          >
            <span>前往木星作品展柜</span>
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
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
  );
}
