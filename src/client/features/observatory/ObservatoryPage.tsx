import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Calendar,
  Compass,
  ImageDown,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Sunset,
  X,
} from 'lucide-react';
import { formatDay } from '../../../shared/dates';
import type { Library, Media } from '../../../shared/types';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { useRouter } from '../../lib/router';
import {
  findSkyTargets,
  skyPositionLabel,
  validSkyPosition,
  type SkySettings,
  type SkyState,
  type SkyTarget,
} from '../../lib/sky';
import type { SkyAlmanac } from './sky-almanac';

const BrightStarChart = lazy(() => import('./BrightStarChart'));

type SkyAlmanacModule = typeof import('./sky-almanac');

interface SkyBookmark {
  id: string;
  journeyTitle: string;
  stopName: string;
  region: string;
  date: string;
  takenAt: string | null;
  lat: number;
  lng: number;
}

interface ParsedNightTime {
  baseNight: Date;
  eveningDate: string;
  sliderMinutes: number;
  exactIso: string | null;
  displayDay: string;
  displayClock: string | null;
}

const INITIAL_SETTINGS: SkySettings = {
  constellations: true,
  labels: true,
  grid: false,
  atmosphere: true,
  ground: true,
};

function isSkyState(value: unknown): value is SkyState {
  if (!value || typeof value !== 'object') return false;
  const s = value as SkyState;
  return (
    validSkyPosition(s.lat, s.lng) &&
    [s.yaw, s.pitch, s.fov].every(Number.isFinite) &&
    typeof s.date === 'string' &&
    Number.isFinite(Date.parse(s.date)) &&
    typeof s.ready === 'boolean'
  );
}

function formatLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addCalendarDays(ymd: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays);
  return new Date(ms).toISOString().slice(0, 10);
}

function parseNightTimeSpec(rawTime: string): ParsedNightTime {
  const trimmed = rawTime.trim();
  const parsedMs = trimmed ? Date.parse(trimmed) : NaN;
  const timeMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(trimmed);
  const now = Number.isFinite(parsedMs) ? new Date(parsedMs) : new Date();

  if (Number.isFinite(parsedMs) && timeMatch) {
    const sourceDate = timeMatch[1]!;
    const [hhStr, mmStr] = timeMatch[2]!.split(':');
    const origH = Number(hhStr);
    const origM = Number(mmStr);
    const eveningDate = origH < 6 ? addCalendarDays(sourceDate, -1) : sourceDate;
    const minutesSince19 = (origH >= 6 ? origH - 19 : origH + 5) * 60 + origM;
    const exactEveningStartMs = parsedMs - minutesSince19 * 60_000;
    const nightStart = new Date(exactEveningStartMs);
    const clampedMin = Math.max(0, Math.min(540, Math.round(minutesSince19 / 5) * 5));
    return {
      baseNight: nightStart,
      eveningDate,
      sliderMinutes: clampedMin,
      exactIso: new Date(parsedMs).toISOString(),
      displayDay: formatDay(sourceDate),
      displayClock: timeMatch[2]!,
    };
  }

  // Anchor diurnal 19:00 -> 04:00 night base on local evening
  const nightStart = new Date(now.getTime());
  if (Number.isFinite(parsedMs)) {
    const h = nightStart.getHours();
    if (h < 6) {
      nightStart.setDate(nightStart.getDate() - 1);
    }
    nightStart.setHours(19, 0, 0, 0);
    const eveningDate = formatLocalIsoDate(nightStart);
    const diffMin = Math.round((now.getTime() - nightStart.getTime()) / 60_000);
    const clampedMin = Math.max(0, Math.min(540, Math.round(diffMin / 5) * 5));
    return {
      baseNight: nightStart,
      eveningDate,
      sliderMinutes: clampedMin,
      exactIso: new Date(parsedMs).toISOString(),
      displayDay: formatDay(formatLocalIsoDate(now)),
      displayClock: null,
    };
  }

  if (nightStart.getHours() < 6) {
    nightStart.setDate(nightStart.getDate() - 1);
  }
  nightStart.setHours(19, 0, 0, 0);
  const fallbackDay = formatLocalIsoDate(nightStart);
  return {
    baseNight: nightStart,
    eveningDate: fallbackDay,
    sliderMinutes: 150, // 21:30 default
    exactIso: null,
    displayDay: formatDay(fallbackDay),
    displayClock: null,
  };
}

function parseInitialParams(search: string): {
  lat: number;
  lng: number;
  place: string;
} & ParsedNightTime {
  const params = new URLSearchParams(search);
  const rawLat = params.get('lat');
  const rawLng = params.get('lng');
  const parsedLat = rawLat !== null ? Number(rawLat) : NaN;
  const parsedLng = rawLng !== null ? Number(rawLng) : NaN;
  const hasValidCoords =
    rawLat !== null &&
    rawLng !== null &&
    rawLat.trim() !== '' &&
    rawLng.trim() !== '' &&
    validSkyPosition(parsedLat, parsedLng);

  const parsedTime = parseNightTimeSpec(params.get('time') || '');

  return {
    lat: hasValidCoords ? parsedLat : 39.9042,
    lng: hasValidCoords ? parsedLng : 116.4074,
    place: hasValidCoords ? params.get('place') || '旅图站点' : '北京参考位置',
    ...parsedTime,
  };
}

function formatDiurnalClock(minutesFrom19: number): string {
  const totalMinutes = (19 * 60 + minutesFrom19) % (24 * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export default function ObservatoryPage() {
  const { search } = useRouter();
  const initial = useMemo(() => parseInitialParams(search), [search]);

  const [position, setPosition] = useState({
    lat: initial.lat,
    lng: initial.lng,
    name: initial.place,
  });
  const [draftLat, setDraftLat] = useState(String(initial.lat));
  const [draftLng, setDraftLng] = useState(String(initial.lng));
  const [coordOpen, setCoordOpen] = useState(false);
  const [coordError, setCoordError] = useState('');

  const [baseNight, setBaseNight] = useState<Date>(initial.baseNight);
  const [eveningDate, setEveningDate] = useState<string>(initial.eveningDate);
  const [sliderMinutes, setSliderMinutes] = useState(initial.sliderMinutes);
  const [exactIsoOverride, setExactIsoOverride] = useState<string | null>(initial.exactIso);
  const [clockOverride, setClockOverride] = useState<string | null>(initial.displayClock);
  const [displayDayOverride, setDisplayDayOverride] = useState<string | null>(
    initial.displayClock ? initial.displayDay : null,
  );

  const [bookmarks, setBookmarks] = useState<SkyBookmark[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [exportingPostcard, setExportingPostcard] = useState(false);
  const [almanacMod, setAlmanacMod] = useState<SkyAlmanacModule | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import('./sky-almanac')
      .then((mod) => {
        if (!cancelled) setAlmanacMod(mod);
      })
      .catch(() => {
        // Keep Observatory usable even if almanac module fails to load
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeDate = useMemo(
    () =>
      exactIsoOverride
        ? new Date(exactIsoOverride)
        : new Date(baseNight.getTime() + sliderMinutes * 60_000),
    [baseNight, exactIsoOverride, sliderMinutes],
  );

  const almanac = useMemo<SkyAlmanac | null>(
    () => (almanacMod ? almanacMod.computeSkyAlmanac(position.lat, position.lng, activeDate) : null),
    [activeDate, almanacMod, position.lat, position.lng],
  );

  const moonLitPath = useMemo(
    () =>
      almanac && almanacMod
        ? almanacMod.buildMoonLitSvgPath(
            almanac.moon.phaseAngle,
            18,
            18,
            14.5,
            almanac.moon.southernHemisphere,
          )
        : null,
    [almanac, almanacMod],
  );

  const [settings, setSettings] = useState<SkySettings>(INITIAL_SETTINGS);
  const [skyState, setSkyState] = useState<SkyState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [fatalError, setFatalError] = useState('');
  const [notice, setNotice] = useState('');
  const [fallback, setFallback] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState(() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}`,
  );

  const [query, setQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(true);
  const [selectedTarget, setSelectedTarget] = useState<SkyTarget | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bootedRef = useRef(false);
  const readyRef = useRef(false);
  const configRef = useRef({
    lat: position.lat,
    lng: position.lng,
    date: activeDate.toISOString(),
    ...settings,
  });

  configRef.current = {
    lat: position.lat,
    lng: position.lng,
    date: activeDate.toISOString(),
    ...settings,
  };

  // Sync URL query params when arriving from Atlas "回望此地当夜星空"
  useEffect(() => {
    setPosition({ lat: initial.lat, lng: initial.lng, name: initial.place });
    setDraftLat(String(initial.lat));
    setDraftLng(String(initial.lng));
    setBaseNight(initial.baseNight);
    setEveningDate(initial.eveningDate);
    setSliderMinutes(initial.sliderMinutes);
    setExactIsoOverride(initial.exactIso);
    setClockOverride(initial.displayClock);
    setDisplayDayOverride(initial.displayClock ? initial.displayDay : null);
  }, [initial]);

  // Quietly load public Atlas stops for bidirectional "快门下的星空" bookmarks
  useEffect(() => {
    let cancelled = false;
    fetch('/api/library', { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => (res.ok ? (res.json() as Promise<Library>) : null))
      .then((data) => {
        if (cancelled || !data) return;
        const mediaMap = new Map<string, Media>();
        for (const m of data.media ?? []) {
          mediaMap.set(m.id, m);
        }
        const items: SkyBookmark[] = [];
        for (const journey of data.journeys ?? []) {
          for (const stop of journey.stops ?? []) {
            if (!validSkyPosition(stop.lat, stop.lng)) continue;
            const primaryMedia = stop.mediaIds.map((mid) => mediaMap.get(mid)).find(Boolean);
            items.push({
              id: `${journey.id}:${stop.id}`,
              journeyTitle: journey.title,
              stopName: stop.name,
              region: stop.region,
              date: stop.date,
              takenAt: primaryMedia?.takenAt ?? null,
              lat: stop.lat,
              lng: stop.lng,
            });
          }
        }
        setBookmarks(items);
      })
      .catch(() => {
        // Silently ignore so Observatory stays resilient when offline
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const post = useCallback(
    (command: string, payload: unknown = {}) => {
      if (!session) return;
      iframeRef.current?.contentWindow?.postMessage(
        { source: 'travel-sky-host', session, command, payload },
        window.location.origin,
      );
    },
    [session],
  );

  useEffect(() => {
    bootedRef.current = false;
    readyRef.current = false;
    setSkyState(null);
    setStatus('loading');
    setFatalError('');
    setNotice('');
    const nextSession =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    setSession(nextSession);
  }, [generation]);

  useEffect(() => {
    if (!session || fallback) return;
    const timer = window.setTimeout(() => {
      if (!readyRef.current) {
        setStatus('error');
        setFatalError('这片星空暂时没有展开，可以重试或切换简版方位图。');
      }
    }, 30_000);

    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== iframeRef.current?.contentWindow
      ) {
        return;
      }
      const msg = event.data;
      if (!msg || msg.source !== 'travel-sky-engine' || msg.session !== session) return;

      if (msg.type === 'ready') {
        bootedRef.current = true;
        post('configure', configRef.current);
        post(document.hidden ? 'pause' : 'resume');
      } else if (msg.type === 'state' && isSkyState(msg.state)) {
        setSkyState(msg.state);
        if (msg.state.ready) {
          bootedRef.current = true;
          readyRef.current = true;
          window.clearTimeout(timer);
          setStatus('ready');
        }
      } else if (msg.type === 'error') {
        const errText =
          typeof msg.error === 'string'
            ? msg.error
            : typeof msg.error?.message === 'string'
              ? msg.error.message
              : '';
        if (msg.fatal) {
          window.clearTimeout(timer);
          setStatus('error');
          setFatalError(errText || '星图引擎加载失败。');
        } else {
          setNotice(errText || '暂时没有找到该天体。');
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
  }, [fallback, post, session]);

  useEffect(() => {
    if (bootedRef.current && !fallback) {
      post('configure', configRef.current);
    }
  }, [activeDate, fallback, position, post, session, settings]);

  useEffect(() => {
    const onVis = () => {
      if (!fallback) post(document.hidden ? 'pause' : 'resume');
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (!fallback) post('pause');
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fallback, post]);

  const searchResults = useMemo(() => findSkyTargets(query), [query]);

  const handleSelectTarget = (target: SkyTarget) => {
    setSelectedTarget(target);
    setNotice('');
    if (!fallback) {
      post('target', { id: target.id, name: target.name });
    }
  };

  const handleClearSelection = () => {
    setSelectedTarget(null);
    setNotice('');
    if (!fallback) {
      post('target', { id: '' });
    }
  };

  const applyCoordinates = () => {
    const lat = Number(draftLat);
    const lng = Number(draftLng);
    if (!draftLat.trim() || !draftLng.trim() || !validSkyPosition(lat, lng)) {
      setCoordError('请输入有效经纬度（纬度 -90～90，经度 -180～180）。');
      return;
    }
    setCoordError('');
    setPosition({ lat, lng, name: '自定观测点' });
  };

  const handleDateChange = (nextYmd: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nextYmd);
    if (!match) return;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const nextNight = new Date(year, month - 1, day, 19, 0, 0, 0);
    if (!Number.isFinite(nextNight.getTime())) return;
    setEveningDate(nextYmd);
    setBaseNight(nextNight);
    setExactIsoOverride(null);
    setClockOverride(null);
    setDisplayDayOverride(null);
  };

  const handleResetToTonight = () => {
    const now = new Date();
    const nightStart = new Date(now.getTime());
    if (nightStart.getHours() < 6) {
      nightStart.setDate(nightStart.getDate() - 1);
    }
    nightStart.setHours(19, 0, 0, 0);
    setEveningDate(formatLocalIsoDate(nightStart));
    setBaseNight(nightStart);
    setSliderMinutes(150);
    setExactIsoOverride(null);
    setClockOverride(null);
    setDisplayDayOverride(null);
  };

  const applyBookmark = (bm: SkyBookmark) => {
    const parsedTime = parseNightTimeSpec(bm.takenAt || `${bm.date}T21:30:00`);
    setPosition({ lat: bm.lat, lng: bm.lng, name: bm.stopName });
    setDraftLat(String(bm.lat));
    setDraftLng(String(bm.lng));
    setBaseNight(parsedTime.baseNight);
    setEveningDate(parsedTime.eveningDate);
    setSliderMinutes(parsedTime.sliderMinutes);
    setExactIsoOverride(parsedTime.exactIso);
    setClockOverride(parsedTime.displayClock);
    setDisplayDayOverride(parsedTime.displayClock ? parsedTime.displayDay : null);
    setBookmarksOpen(false);
    setNotice(`已切换至「${bm.stopName}」当夜星空。`);
  };

  const activeInfo = skyState?.selected ?? null;
  const activeDisplayDay = displayDayOverride
    ? displayDayOverride
    : formatDay(addCalendarDays(eveningDate, sliderMinutes >= 300 ? 1 : 0));
  const activeDisplayClock = clockOverride || formatDiurnalClock(sliderMinutes);

  const handleExportPostcard = async () => {
    if (exportingPostcard) return;
    setExportingPostcard(true);
    setNotice('');
    try {
      const { downloadSkyPostcard } = await import('./sky-postcard');
      await downloadSkyPostcard({
        lat: position.lat,
        lng: position.lng,
        date: activeDate,
        place: position.name,
        displayDate: activeDisplayDay,
        displayClock: activeDisplayClock,
      });
      setNotice('星空明信片（1200×1600 PNG）已保存到本地。');
    } catch {
      setNotice('导出星空明信片失败，请稍后再试。');
    } finally {
      setExportingPostcard(false);
    }
  };

  return (
    <div className="relative overflow-x-clip">
      <CelestialFieldBackdrop variant="subtle-header" />
      <div className="relative z-10 mx-auto max-w-[1440px] px-3 py-4 sm:px-6 sm:py-6">
      {/* Observatory Header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 tabIndex={-1} className="display-h1 text-[26px] text-ink sm:text-[32px]">
            实时星图
          </h1>
          <p className="tabular-nums-mono mt-1 mb-0 text-[13.5px] text-ink-muted">
            {skyPositionLabel(position)} · {activeDisplayDay} · 观测时刻 {activeDisplayClock}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Arbitrary Date Picker + Reset to Tonight */}
          <div className="inline-flex min-h-[36px] max-w-full items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1 text-[12.5px] text-ink">
            <Calendar className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
            <input
              type="date"
              value={eveningDate}
              aria-label="观测日期"
              onChange={(e) => handleDateChange(e.target.value)}
              className="tabular-nums-mono min-w-0 bg-transparent text-[12.5px] text-ink outline-none"
            />
            <button
              type="button"
              onClick={handleResetToTonight}
              className="shrink-0 rounded-full bg-page/70 px-2.5 py-0.5 text-[11.5px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              回到今晚
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setBookmarksOpen(false);
              setCoordOpen((v) => !v);
            }}
            aria-expanded={coordOpen}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-surface px-3.5 text-[13px] text-ink hover:bg-surface-hover"
          >
            <Compass className="h-3.5 w-3.5" aria-hidden="true" />
            <span>设置位置</span>
          </button>

          {bookmarks.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setCoordOpen(false);
                setBookmarksOpen((v) => !v);
              }}
              aria-expanded={bookmarksOpen}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-hairline bg-surface px-3.5 text-[13px] text-ink hover:bg-surface-hover"
            >
              <Bookmark className="h-3.5 w-3.5 text-postmark" aria-hidden="true" />
              <span>旅图星空书签</span>
              <span className="tabular-nums-mono text-[11.5px] text-ink-muted">
                {bookmarks.length}
              </span>
            </button>
          )}

          <button
            type="button"
            disabled={exportingPostcard}
            onClick={() => {
              void handleExportPostcard();
            }}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-hairline bg-surface px-3.5 text-[13px] text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            <ImageDown className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{exportingPostcard ? '正在绘制…' : '导出星空明信片'}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (fallback) {
                setFallback(false);
                setGeneration((g) => g + 1);
              } else {
                setFallback(true);
              }
            }}
            className="inline-flex min-h-[36px] items-center rounded-full bg-cta-bg px-4 text-[13px] font-medium text-cta-text"
          >
            {fallback ? '回到沉浸星图' : '简版方位图'}
          </button>
        </div>
      </div>

      {/* Coordinate editor drawer */}
      {coordOpen && (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[20px] bg-surface p-4">
          <label className="text-[12.5px] text-ink-muted">
            观测纬度
            <input
              type="text"
              value={draftLat}
              onChange={(e) => setDraftLat(e.target.value)}
              className="tabular-nums-mono mt-1 block w-36 rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            观测经度
            <input
              type="text"
              value={draftLng}
              onChange={(e) => setDraftLng(e.target.value)}
              className="tabular-nums-mono mt-1 block w-36 rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
            />
          </label>
          <button
            type="button"
            onClick={applyCoordinates}
            className="min-h-[36px] rounded-full bg-cta-bg px-4 text-[13px] font-medium text-cta-text"
          >
            应用坐标
          </button>
          {coordError && (
            <span role="alert" className="text-[12.5px] text-postmark">
              {coordError}
            </span>
          )}
        </div>
      )}

      {/* Bidirectional "快门下的星空" Travel Stop Bookmarks Drawer */}
      {bookmarksOpen && bookmarks.length > 0 && (
        <div
          aria-label="旅图星空书签"
          className="mb-4 rounded-[20px] border border-hairline bg-surface p-4"
        >
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-ink">
              快门下的星空 · 从公开旅图直达当夜天穹
            </span>
            <button
              type="button"
              onClick={() => setBookmarksOpen(false)}
              aria-label="关闭旅图星空书签"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-page/70 text-ink-muted hover:bg-surface-hover hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {bookmarks.map((bm) => (
              <button
                key={bm.id}
                type="button"
                onClick={() => applyBookmark(bm)}
                className="inline-flex flex-col items-start rounded-[14px] border border-hairline bg-paper px-3.5 py-2 text-left transition-colors hover:border-hairline-strong hover:bg-surface-hover"
              >
                <span className="text-[13px] font-medium text-ink">{bm.stopName}</span>
                <span className="tabular-nums-mono mt-0.5 text-[11.5px] text-ink-muted">
                  {bm.journeyTitle} · {formatDay(bm.takenAt || bm.date)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Constant Deep-Space #0B0C0E 32px Viewport */}
      <section
        data-only-dark="true"
        aria-label="深空星图视窗"
        className="deep-space observatory-viewport relative overflow-hidden rounded-[32px] border border-hairline"
        style={{ borderRadius: '32px' }}
      >
        {fallback ? (
          <Suspense
            fallback={
              <div className="flex min-h-[520px] items-center justify-center text-[14px] text-ink-muted">
                正在计算简版亮星方位图……
              </div>
            }
          >
            <BrightStarChart
              lat={position.lat}
              lng={position.lng}
              date={activeDate}
              place={position.name}
            />
          </Suspense>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
            {/* Left: Same-Origin Stellarium WASM Canvas */}
            <div className="relative h-[58vh] min-h-[420px] w-full bg-page lg:h-[640px]">
              <iframe
                key={session}
                ref={iframeRef}
                title="同源实时星图"
                src={`/stellarium/index.html?session=${encodeURIComponent(session)}`}
                onError={() => setFallback(true)}
                onLoad={(event) => {
                  try {
                    const href = event.currentTarget.contentDocument?.location?.href ?? '';
                    if (!href.includes('/stellarium/')) {
                      setFallback(true);
                    }
                  } catch {
                    setFallback(true);
                  }
                }}
                className="block h-full w-full border-0"
              />

              {status === 'loading' && (
                <div
                  role="status"
                  className="pointer-events-none absolute top-3 left-3 rounded-full border border-hairline bg-page/80 px-3.5 py-1.5 text-[12.5px] text-ink-muted backdrop-blur-sm"
                >
                  正在展开星表与银河视窗……
                </div>
              )}

              {status === 'error' && (
                <div
                  role="alert"
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-page/90 p-6 text-center"
                >
                  <p className="m-0 text-[14px] text-ink">{fatalError}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setGeneration((g) => g + 1)}
                      className="rounded-full bg-surface px-4 py-2 text-[13px] text-ink hover:bg-surface-hover"
                    >
                      重新加载星图
                    </button>
                    <button
                      type="button"
                      onClick={() => setFallback(true)}
                      className="rounded-full bg-cta-bg px-4 py-2 text-[13px] font-medium text-cta-text"
                    >
                      查看简版方位图
                    </button>
                  </div>
                </div>
              )}

              {/* Bottom minimal time slider & view controls */}
              <div className="absolute right-3 bottom-3 left-3 flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-hairline bg-page/80 px-4 py-3 backdrop-blur-md">
                <div className="flex min-w-[210px] flex-1 items-center gap-3">
                  <label
                    htmlFor="obs-diurnal-slider"
                    className="shrink-0 text-[12.5px] text-ink-muted"
                  >
                    夜空时刻
                  </label>
                  <input
                    id="obs-diurnal-slider"
                    type="range"
                    min={0}
                    max={540}
                    step={5}
                    value={sliderMinutes}
                    aria-label="观测时刻（19:00 至 04:00）"
                    onChange={(e) => {
                      setExactIsoOverride(null);
                      setClockOverride(null);
                      setDisplayDayOverride(null);
                      setSliderMinutes(Number(e.target.value));
                    }}
                    className="flex-1 accent-accent"
                  />
                  <span className="tabular-nums-mono w-12 text-right text-[13px] font-medium text-ink">
                    {clockOverride || formatDiurnalClock(sliderMinutes)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label="放大星图"
                    onClick={() =>
                      post('view', {
                        fov: Math.max(10, (skyState?.fov ?? 85) / 1.35),
                      })
                    }
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-surface text-ink hover:bg-surface-hover"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="缩小星图"
                    onClick={() =>
                      post('view', {
                        fov: Math.min(130, (skyState?.fov ?? 85) * 1.35),
                      })
                    }
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-surface text-ink hover:bg-surface-hover"
                  >
                    <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => post('reset')}
                    className="inline-flex h-8 items-center gap-1 rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink hover:bg-surface-hover"
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    <span>回到南方天空</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Right: Minimal Astronomical HUD */}
            <aside className="flex flex-col gap-4 border-t border-hairline bg-surface p-5 lg:border-t-0 lg:border-l">
              <div>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={query}
                    onFocus={() => setDropdownOpen(true)}
                    onClick={() => setDropdownOpen(true)}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setDropdownOpen(true);
                      setNotice('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        if (dropdownOpen) {
                          e.preventDefault();
                          e.stopPropagation();
                          setDropdownOpen(false);
                        } else if (coordOpen) {
                          e.preventDefault();
                          e.stopPropagation();
                          setCoordOpen(false);
                        } else if (selectedTarget || skyState?.selected) {
                          e.preventDefault();
                          e.stopPropagation();
                          handleClearSelection();
                        }
                        return;
                      }
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (searchResults.length > 0) {
                          handleSelectTarget(searchResults[0]!);
                          return;
                        }
                        const trimmed = query.trim();
                        if (trimmed) {
                          if (!fallback) {
                            post('target', { id: trimmed, name: trimmed });
                          } else {
                            setNotice('在本地星表中没有找到该天体。');
                          }
                        }
                      }
                    }}
                    aria-label="搜索天体"
                    placeholder="找一颗星或星座（天狼星 / Orion）"
                    className="w-full rounded-full border border-hairline bg-page py-2 pr-3 pl-9 text-[13px] text-ink placeholder:text-ink-muted"
                  />
                </div>

                {dropdownOpen && (
                  <div
                    role="listbox"
                    aria-label="候选天体列表"
                    className="mt-2.5 flex max-h-[196px] flex-col gap-1 overflow-y-auto"
                  >
                    {searchResults.length > 0 ? (
                      searchResults.map((item) => {
                        const isSelected = selectedTarget?.id === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            onClick={() => handleSelectTarget(item)}
                            className={[
                              'flex items-center justify-between rounded-[10px] px-3 py-1.5 text-left text-[12.5px] transition-colors',
                              isSelected
                                ? 'bg-surface-hover font-medium text-accent'
                                : 'text-ink hover:bg-surface-hover',
                            ].join(' ')}
                          >
                            <span>
                              {item.name}{' '}
                              <span className="text-ink-muted">{item.english}</span>
                            </span>
                            <span className="text-[11px] text-ink-muted">{item.kind}</span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="m-0 px-3 py-2 text-[12px] text-ink-muted">
                        没有找到匹配天体，按 Enter 可尝试在星表中查询。
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Layer switches */}
              <div>
                <p className="mb-2 text-[12px] text-ink-muted">星图图层</p>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      { key: 'constellations', label: '星座线' },
                      { key: 'labels', label: '天体名称' },
                      { key: 'grid', label: '方位网格' },
                      { key: 'ground', label: '地景' },
                      { key: 'atmosphere', label: '大气' },
                    ] as const
                  ).map((layer) => {
                    const active = settings[layer.key];
                    return (
                      <button
                        key={layer.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          setSettings((prev) => ({ ...prev, [layer.key]: !prev[layer.key] }))
                        }
                        className={[
                          'min-h-[32px] rounded-full border px-3 text-[12px] transition-colors',
                          active
                            ? 'border-accent/50 bg-accent/15 text-accent'
                            : 'border-hairline bg-page/60 text-ink-muted hover:text-ink',
                        ].join(' ')}
                      >
                        {layer.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Live celestial target readout */}
              <div
                aria-live="polite"
                className="rounded-[16px] border border-hairline bg-page/70 p-4 text-[13px]"
              >
                {activeInfo || selectedTarget ? (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-ink">
                          {activeInfo?.name || selectedTarget?.name}
                        </div>
                        <div className="text-[11.5px] text-ink-muted">
                          {activeInfo?.kind || selectedTarget?.kind}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleClearSelection}
                        aria-label="取消天体选择"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="tabular-nums-mono mt-2.5 grid grid-cols-2 gap-1.5 text-[12px] text-ink-muted">
                      <span>
                        高度{' '}
                        {typeof activeInfo?.altitude === 'number'
                          ? `${activeInfo.altitude.toFixed(1)}°${activeInfo.altitude < 0 ? '（地平线下）' : ''}`
                          : '—'}
                      </span>
                      <span>
                        方位{' '}
                        {typeof activeInfo?.azimuth === 'number'
                          ? `${activeInfo.azimuth.toFixed(1)}°`
                          : '—'}
                      </span>
                      {typeof activeInfo?.magnitude === 'number' && (
                        <span>星等 {activeInfo.magnitude.toFixed(2)}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="text-ink-muted">
                    搜索或点击星体查看坐标
                  </span>
                )}
              </div>

              {notice && (
                <p role="status" className="m-0 text-[12px] text-postmark">
                  {notice}
                </p>
              )}
            </aside>
          </div>
        )}

        {/* Tonight's Sky Almanac Deck (Moon Phase, Twilight -18°, Visible Planets) */}
        {fallback && notice && (
          <p role="status" className="m-0 border-t border-hairline bg-surface/90 px-5 pt-3 text-[12px] text-postmark">
            {notice}
          </p>
        )}
        {almanac ? (
          <div
            aria-label="今夜天象年鉴"
            className="grid grid-cols-1 gap-4 border-t border-hairline bg-surface/90 px-5 py-4 md:grid-cols-[auto_auto_minmax(0,1fr)] md:items-center md:gap-6"
          >
            {/* Moon phase disk + illumination */}
            <button
              type="button"
              onClick={() =>
                handleSelectTarget({
                  id: 'NAME Moon',
                  name: '月亮',
                  english: 'Moon',
                  kind: '行星',
                })
              }
              className="flex items-center gap-3 rounded-[14px] border border-hairline bg-page/70 px-3.5 py-2.5 text-left transition-colors hover:border-hairline-strong hover:bg-surface-hover"
            >
              <svg
                viewBox="0 0 36 36"
                width={36}
                height={36}
                role="img"
                aria-label={`月相 ${almanac.moon.phaseName}，照度 ${almanac.moon.illuminationPercent}%`}
                className="h-9 w-9 shrink-0"
              >
                <circle
                  cx="18"
                  cy="18"
                  r="14.5"
                  fill="#1a1d24"
                  stroke="rgba(227,227,227,0.22)"
                  strokeWidth="1"
                />
                {moonLitPath && <path d={moonLitPath} fill="#efe5c8" />}
              </svg>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13.5px] font-medium text-ink">
                    {almanac.moon.phaseName}
                  </span>
                  <span className="tabular-nums-mono text-[12px] text-postmark">
                    照度 {almanac.moon.illuminationPercent}%
                  </span>
                </div>
                <div className="tabular-nums-mono mt-0.5 text-[11.5px] text-ink-muted">
                  {almanac.moon.aboveHorizon
                    ? `月高 ${almanac.moon.altitude.toFixed(0)}° · 方位 ${almanac.moon.azimuth.toFixed(0)}°`
                    : '此刻位于地平线下'}
                </div>
              </div>
            </button>

            {/* Sunset & Astronomical Twilight End (-18°) */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-[14px] border border-hairline bg-page/60 px-4 py-2.5 text-[12.5px]">
              <div className="flex items-center gap-1.5 text-ink-muted">
                <Sunset className="h-3.5 w-3.5 text-postmark" aria-hidden="true" />
                <span>日落</span>
                <strong className="tabular-nums-mono font-medium text-ink">
                  {almanac.twilight.sunsetLabel}
                </strong>
              </div>
              <div className="flex items-center gap-1.5 text-ink-muted">
                <span>天文入夜 (-18°)</span>
                <strong className="tabular-nums-mono font-medium text-ink">
                  {almanac.twilight.astronomicalDuskLabel}
                </strong>
              </div>
            </div>

            {/* Visible naked-eye planets above horizon */}
            <div className="min-w-0">
              <div className="mb-1.5 text-[11.5px] text-ink-muted">
                此刻地平线上可见行星（点击直达星图目标）
              </div>
              {almanac.visiblePlanets.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {almanac.visiblePlanets.map((planet) => {
                    const isTargeted =
                      selectedTarget?.id === planet.id || activeInfo?.id === planet.id;
                    return (
                      <button
                        key={planet.id}
                        type="button"
                        onClick={() => handleSelectTarget(planet.target)}
                        className={[
                          'inline-flex min-h-[30px] items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors',
                          isTargeted
                            ? 'border-accent/60 bg-accent/15 text-accent'
                            : 'border-hairline bg-page/70 text-ink hover:border-hairline-strong hover:bg-surface-hover',
                        ].join(' ')}
                      >
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: planet.color }}
                          aria-hidden="true"
                        />
                        <span className="font-medium">{planet.name}</span>
                        <span className="tabular-nums-mono text-[11px] text-ink-muted">
                          {planet.altitude.toFixed(0)}° {planet.direction}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="m-0 text-[12px] text-ink-muted">
                  当前时刻五大肉眼行星均位于地平线下，可拖动夜空时刻探索。
                </p>
              )}
            </div>
          </div>
        ) : (
          <div
            aria-label="今夜天象年鉴"
            className="border-t border-hairline bg-surface/90 px-5 py-4 text-[12.5px] text-ink-muted"
          >
            正在推演当夜月相与行星高度……
          </div>
        )}
      </section>
      </div>
    </div>
  );
}
