import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  ApsisKind,
  Body,
  C_AUDAY,
  Ecliptic,
  Equator,
  GeoVector,
  HelioVector,
  Illumination,
  KM_PER_AU,
  Observer,
  PlanetOrbitalPeriod,
  SearchPlanetApsis,
  SearchRelativeLongitude,
} from 'astronomy-engine';
import { ArrowLeft, ArrowUpRight, Compass, Orbit } from 'lucide-react';
import { formatDay } from '../../../shared/dates';
import { CelestialFieldBackdrop } from '../../components/CelestialFieldBackdrop';
import { createCardPointerHandlers, createMagneticHandlers } from '../../lib/pointer-fx';
import { useRouter } from '../../lib/router';
import {
  findPlanetById,
  SOLAR_PLANETS,
  type PlanetId,
  type SolarPlanetSpec,
} from '../home/solar-planets';

type PlanetComingSoonPageProps = {
  slug: string;
};

const PLANET_BODY_MAP: Record<PlanetId, Body> = {
  mercury: Body.Mercury,
  venus: Body.Venus,
  earth: Body.Earth,
  mars: Body.Mars,
  jupiter: Body.Jupiter,
  saturn: Body.Saturn,
  uranus: Body.Uranus,
  neptune: Body.Neptune,
};

const ZODIAC_SIGNS = [
  { zh: '白羊宫', en: 'Aries' },
  { zh: '金牛宫', en: 'Taurus' },
  { zh: '双子宫', en: 'Gemini' },
  { zh: '巨蟹宫', en: 'Cancer' },
  { zh: '狮子宫', en: 'Leo' },
  { zh: '室女宫', en: 'Virgo' },
  { zh: '天秤宫', en: 'Libra' },
  { zh: '天蝎宫', en: 'Scorpio' },
  { zh: '人马宫', en: 'Sagittarius' },
  { zh: '摩羯宫', en: 'Capricorn' },
  { zh: '宝瓶宫', en: 'Aquarius' },
  { zh: '双鱼宫', en: 'Pisces' },
] as const;

type PlanetEditorialMeta = {
  badge: string;
  tagline: string;
  vignette: string;
  roadmap?: {
    phase: string;
    title: string;
    description: string;
  };
};

const PLANET_EDITORIAL: Record<PlanetId, PlanetEditorialMeta> = {
  uranus: {
    badge: '实时星历 · 在线观测活页',
    tagline: '侧卧前行的淡青色冰巨星',
    vignette:
      '天王星以 97.7° 的极端倾角近乎平躺着绕日运行，阳光与讯号穿越十余个天文单位抵达地球，需要两个多小时的静默跋涉。此页实时推算其当前地心距、单程光行时与黄道落座，作为太阳系外缘的一张常驻星历活页。',
  },
  mercury: {
    badge: '实时星历 · 工具台筹备中',
    tagline: '紧贴太阳脉动的内轨信使',
    vignette:
      '水星以 88 天绕日一周的疾速穿行于晨昏地平线附近，是太阳系中轨道离心率最显著的大行星。',
    roadmap: {
      phase: '第二阶段规划',
      title: '水星实用工具台',
      description:
        '将汇集零上传本地浏览器工具与轻量日常小件，所有运算留在本地设备完成，不额外消耗云端存储与请求配额。',
    },
  },
  mars: {
    badge: '实时星历 · 竞技场筹备中',
    tagline: '赤铁尘暴与峡谷纵横的外邻行星',
    vignette:
      '火星每两年多与地球迎来一次近距离冲日，其 25.2° 的自转倾角带来与地球相似的四季轮替。',
    roadmap: {
      phase: '第三至四阶段规划',
      title: '火星游乐竞技场',
      description:
        '规划克制视觉语言下的轻量交互小品与实时联机双人对弈空间，采用独立状态会话驱动，按阶段陆续开放。',
    },
  },
  venus: {
    badge: '实时星历 · 金星已接入暗房影集',
    tagline: '晨昏最亮的云幕行星',
    vignette: '金星在浓密云层之下逆向自转，是夜空中仅次于月亮的明亮天体。',
  },
  earth: {
    badge: '实时星历 · 地球已接入旅图',
    tagline: '脚下所行之山海与坐标原点',
    vignette: '一切旅途轨迹与仰望星空的基准，均以此刻脚下的经纬坐标为原点。',
  },
  jupiter: {
    badge: '实时星历 · 木星已接入作品展柜',
    tagline: '太阳系最宏阔的气态巨行星',
    vignette: '木星拥有厚重条纹云带与四颗伽利略卫星，承载站内独立工程作品的长期展陈。',
  },
  saturn: {
    badge: '实时星历 · 土星已接入观星台',
    tagline: '冰晶星环环绕的夜空地标',
    vignette: '土星的宽阔光环与清晰倾角，让它成为每一次望远镜观测中最难忘的夜空坐标。',
  },
  neptune: {
    badge: '实时星历 · 海王星已接入文件密匣',
    tagline: '远在三十天文单位之外的深蓝边疆',
    vignette: '海王星静守在太阳系最外层轨道，单程光行时超过四小时，如同一座安静的远方密匣。',
  },
};

type LiveTelemetry = {
  isEarth: boolean;
  geoDistAu: number;
  geoDistMillionKm: number;
  lightSeconds: number;
  helioDistAu: number;
  helioDistMillionKm: number;
  raHours: number | null;
  decDeg: number | null;
  eclipticLon: number;
  eclipticLat: number;
  zodiac: { zh: string; en: string };
  magnitude: number | null;
  phasePct: number | null;
  orbitalPeriodDays: number;
};

type AlmanacEvents = {
  synodicLabel: string;
  synodicDate: string | null;
  apsisLabel: string;
  apsisDate: string | null;
  apsisDistAu: number | null;
};

function formatRa(hours: number): string {
  const normalized = ((hours % 24) + 24) % 24;
  const h = Math.floor(normalized);
  const remMin = (normalized - h) * 60;
  const m = Math.floor(remMin);
  const s = (remMin - m) * 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${s.toFixed(1).padStart(4, '0')}s`;
}

function formatDec(deg: number): string {
  const sign = deg < 0 ? '−' : '+';
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const remMin = (abs - d) * 60;
  const m = Math.floor(remMin);
  const s = Math.round((remMin - m) * 60);
  return `${sign}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}′ ${String(Math.min(59, s)).padStart(2, '0')}″`;
}

function formatLightTravelTime(totalSeconds: number): { primary: string; secondary: string } {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return { primary: '0 分 00 秒', secondary: '观测基准点' };
  }
  const rounded = Math.round(totalSeconds);
  const totalMinutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  const primary = `${totalMinutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
  if (totalMinutes >= 60) {
    const hours = totalSeconds / 3600;
    return { primary, secondary: `约 ${hours.toFixed(2)} 光时` };
  }
  return { primary, secondary: `约 ${rounded} 光秒` };
}

function formatUtcTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}.${mo}.${d} ${h}:${mi}:${s} UTC`;
}

function computeLiveTelemetry(planet: SolarPlanetSpec, now: Date): LiveTelemetry {
  const body = PLANET_BODY_MAP[planet.id];
  const helioVec = HelioVector(body, now);
  const helioDistAu = helioVec.Length();
  const helioDistMillionKm = (helioDistAu * KM_PER_AU) / 1e6;
  const orbitalPeriodDays = PlanetOrbitalPeriod(body);

  if (body === Body.Earth) {
    const ecl = Ecliptic(helioVec);
    const elon = ((ecl.elon % 360) + 360) % 360;
    const zodiac = ZODIAC_SIGNS[Math.floor(elon / 30) % 12]!;
    return {
      isEarth: true,
      geoDistAu: 0,
      geoDistMillionKm: 0,
      lightSeconds: 0,
      helioDistAu,
      helioDistMillionKm,
      raHours: null,
      decDeg: null,
      eclipticLon: elon,
      eclipticLat: ecl.elat,
      zodiac,
      magnitude: null,
      phasePct: null,
      orbitalPeriodDays,
    };
  }

  const geoVec = GeoVector(body, now, true);
  const geoDistAu = geoVec.Length();
  const geoDistMillionKm = (geoDistAu * KM_PER_AU) / 1e6;
  const lightSeconds = (geoDistAu / C_AUDAY) * 86_400;

  const observer = new Observer(0, 0, 0);
  const eq = Equator(body, now, observer, false, true);
  const ecl = Ecliptic(geoVec);
  const elon = ((ecl.elon % 360) + 360) % 360;
  const zodiac = ZODIAC_SIGNS[Math.floor(elon / 30) % 12]!;
  const illum = Illumination(body, now);

  return {
    isEarth: false,
    geoDistAu,
    geoDistMillionKm,
    lightSeconds,
    helioDistAu,
    helioDistMillionKm,
    raHours: eq.ra,
    decDeg: eq.dec,
    eclipticLon: elon,
    eclipticLat: ecl.elat,
    zodiac,
    magnitude: illum.mag,
    phasePct: illum.phase_fraction * 100,
    orbitalPeriodDays,
  };
}

function computeAlmanacEvents(planet: SolarPlanetSpec, dayIso: string): AlmanacEvents {
  const body = PLANET_BODY_MAP[planet.id];
  const anchor = new Date(`${dayIso}T00:00:00Z`);
  const isInferior = body === Body.Mercury || body === Body.Venus;
  let synodicDate: string | null = null;
  let apsisLabel = '下次拱点';
  let apsisDate: string | null = null;
  let apsisDistAu: number | null = null;

  if (body !== Body.Earth) {
    try {
      const eventTime = SearchRelativeLongitude(body, 0, anchor);
      synodicDate = formatDay(eventTime.date.toISOString());
    } catch {
      synodicDate = null;
    }
  }

  try {
    const apsis = SearchPlanetApsis(body, anchor);
    apsisLabel = apsis.kind === ApsisKind.Pericenter ? '下次近日点' : '下次远日点';
    apsisDate = formatDay(apsis.time.date.toISOString());
    apsisDistAu = apsis.dist_au;
  } catch {
    apsisDate = null;
  }

  return {
    synodicLabel: body === Body.Earth ? '回归周期' : isInferior ? '下次下合日' : '下次冲日',
    synodicDate,
    apsisLabel,
    apsisDate,
    apsisDistAu,
  };
}

export default function PlanetComingSoonPage({ slug }: PlanetComingSoonPageProps) {
  const { navigate } = useRouter();
  const planet = findPlanetById(slug);
  const [now, setNow] = useState<Date>(() => new Date());

  const cardHandlers = createCardPointerHandlers();
  const magneticHandlers = createMagneticHandlers(4);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        setNow(new Date());
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const dayIso = now.toISOString().slice(0, 10);

  const telemetry = useMemo(
    () => (planet ? computeLiveTelemetry(planet, now) : null),
    [planet, now],
  );

  const almanac = useMemo(
    () => (planet ? computeAlmanacEvents(planet, dayIso) : null),
    [planet, dayIso],
  );

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

  if (!planet || !telemetry) {
    return (
      <div className="relative flex min-h-[calc(100dvh_-_var(--nav-height))] items-center justify-center overflow-hidden px-4 py-12 sm:px-6">
        <CelestialFieldBackdrop variant="vault" />
        <div className="relative z-10 w-full max-w-[460px] rounded-[24px] border border-hairline bg-surface p-8 text-center">
          <h1 tabIndex={-1} className="display-h1 text-[28px] text-ink">
            未收录的轨道坐标
          </h1>
          <p className="mt-3 text-[14.5px] text-ink-muted">
            当前星历表仅收录太阳系八大行星，可以先回到太阳系首页或前往观星台。
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a href="/" onClick={handleSpaLink('/')} className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>返回太阳系</span>
            </a>
            <a href="/observatory" onClick={handleSpaLink('/observatory')} className="pill-cta-secondary min-h-[40px] px-5 text-[13.5px]">
              <span>前往观星台</span>
            </a>
          </div>
        </div>
      </div>
    );
  }

  const editorial = PLANET_EDITORIAL[planet.id];
  const axialTiltDeg = (planet.axialTilt * 180) / Math.PI;
  const inclinationDeg = (Math.abs(planet.orbitInclination) * 180) / Math.PI;
  const lightTravel = formatLightTravelTime(telemetry.lightSeconds);
  const orbitalYears = telemetry.orbitalPeriodDays / 365.256;
  const hasLivePortal = !planet.portal.placeholder && !planet.portal.href.startsWith('/explore/');

  return (
    <div className="relative min-h-[calc(100dvh_-_var(--nav-height))] overflow-x-clip">
      <CelestialFieldBackdrop variant="vault" />

      <div className="relative z-10 mx-auto max-w-[1040px] px-4 py-8 sm:px-6 sm:py-12">
        {/* Top Ephemeris Masthead */}
        <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4 sm:gap-5">
            <div
              aria-hidden="true"
              className="mt-1 h-14 w-14 shrink-0 rounded-full border border-hairline shadow-md sm:h-16 sm:w-16"
              style={{
                background: `radial-gradient(circle at 34% 30%, ${planet.warpTint} 0%, color-mix(in srgb, ${planet.warpTint} 30%, #0b0c0e) 76%)`,
              }}
            />
            <div className="min-w-0">
              <div className="tabular-nums-mono text-[12px] tracking-[0.08em] text-ink-muted">
                {planet.nameEn} · 平均日距 {planet.auLabel} · J2000 实时星历
              </div>
              <h1 tabIndex={-1} className="display-h1 mt-1.5 text-[32px] text-ink sm:text-[42px]">
                {planet.nameZh}
              </h1>
              <p className="mt-1.5 mb-0 text-[14.5px] text-ink-muted">{editorial.tagline}</p>
            </div>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3.5 py-1 text-[12.5px] font-medium text-accent">
              <Orbit className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{editorial.badge}</span>
            </span>
            <span className="tabular-nums-mono text-[12px] text-ink-muted">
              推算历元 {formatUtcTimestamp(now)}
            </span>
          </div>
        </header>

        {/* Poetic Vignette Sheet */}
        <section
          aria-label="行星观测序言"
          className="mt-7 rounded-[24px] border border-hairline bg-paper px-6 py-5 sm:px-7 sm:py-6"
        >
          <p className="font-editorial-serif m-0 max-w-[780px] text-[15px] leading-[1.85] text-ink sm:text-[15.5px]">
            {editorial.vignette}
          </p>
        </section>

        {/* Live Telemetry Ephemeris Sheet */}
        <section
          aria-label="实时星历遥测数据"
          {...cardHandlers}
          className="interactive-card mt-6 rounded-[28px] border border-hairline bg-surface p-6 sm:p-8"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline pb-4">
            <h2 className="m-0 text-[18px] font-medium text-ink">此刻星历观测读数</h2>
            <span className="tabular-nums-mono text-[12px] text-postmark">
              黄道落座 · {telemetry.zodiac.zh} ({telemetry.zodiac.en})
            </span>
          </div>

          {/* Primary 3-column Live Metrics */}
          <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-[18px] border border-hairline bg-paper px-4 py-4">
              <div className="text-[12px] text-ink-muted">实时地心距离</div>
              <div className="tabular-nums-mono mt-1.5 text-[21px] font-medium text-ink">
                {telemetry.isEarth ? '0.0000 AU' : `${telemetry.geoDistAu.toFixed(4)} AU`}
              </div>
              <div className="tabular-nums-mono mt-1 text-[12px] text-ink-muted">
                {telemetry.isEarth
                  ? '观测所在行星'
                  : `约 ${telemetry.geoDistMillionKm.toFixed(1)} 百万公里`}
              </div>
            </div>

            <div className="rounded-[18px] border border-hairline bg-paper px-4 py-4">
              <div className="text-[12px] text-ink-muted">单程光行时</div>
              <div className="tabular-nums-mono mt-1.5 text-[21px] font-medium text-ink">
                {lightTravel.primary}
              </div>
              <div className="tabular-nums-mono mt-1 text-[12px] text-ink-muted">
                {lightTravel.secondary}
              </div>
            </div>

            <div className="rounded-[18px] border border-hairline bg-paper px-4 py-4">
              <div className="text-[12px] text-ink-muted">实时日心距离</div>
              <div className="tabular-nums-mono mt-1.5 text-[21px] font-medium text-ink">
                {telemetry.helioDistAu.toFixed(4)} AU
              </div>
              <div className="tabular-nums-mono mt-1 text-[12px] text-ink-muted">
                约 {telemetry.helioDistMillionKm.toFixed(1)} 百万公里
              </div>
            </div>

            <div className="rounded-[18px] border border-hairline bg-paper px-4 py-4">
              <div className="text-[12px] text-ink-muted">赤经 / 赤纬（J2000）</div>
              <div className="tabular-nums-mono mt-1.5 text-[15px] font-medium text-ink">
                {telemetry.raHours !== null ? `RA ${formatRa(telemetry.raHours)}` : '地心基准'}
              </div>
              <div className="tabular-nums-mono mt-1 text-[13px] text-ink-muted">
                {telemetry.decDeg !== null ? `Dec ${formatDec(telemetry.decDeg)}` : '以太阳黄经计位'}
              </div>
            </div>

            <div className="rounded-[18px] border border-hairline bg-paper px-4 py-4">
              <div className="text-[12px] text-ink-muted">黄经 / 黄道带</div>
              <div className="tabular-nums-mono mt-1.5 text-[17px] font-medium text-ink">
                {telemetry.zodiac.zh} · {telemetry.eclipticLon.toFixed(2)}°
              </div>
              <div className="tabular-nums-mono mt-1 text-[12px] text-ink-muted">
                黄纬 {telemetry.eclipticLat >= 0 ? '+' : '−'}
                {Math.abs(telemetry.eclipticLat).toFixed(2)}° · {telemetry.zodiac.en}
              </div>
            </div>

            <div className="rounded-[18px] border border-hairline bg-paper px-4 py-4">
              <div className="text-[12px] text-ink-muted">
                {telemetry.isEarth ? '公转周期' : '视星等与相位'}
              </div>
              <div className="tabular-nums-mono mt-1.5 text-[17px] font-medium text-ink">
                {telemetry.magnitude !== null
                  ? `${telemetry.magnitude >= 0 ? '+' : ''}${telemetry.magnitude.toFixed(2)} mag`
                  : `${telemetry.orbitalPeriodDays.toFixed(1)} 天`}
              </div>
              <div className="tabular-nums-mono mt-1 text-[12px] text-ink-muted">
                {telemetry.phasePct !== null
                  ? `受照比例 ${telemetry.phasePct.toFixed(1)}%`
                  : '1.00 地球年'}
              </div>
            </div>
          </div>

          {/* Orbital Mechanics & Almanac Strip */}
          <div className="mt-5 grid grid-cols-1 gap-3 border-t border-hairline pt-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-[14px] border border-hairline bg-page/60 px-3.5 py-3">
              <div className="text-[11.5px] text-ink-muted">自转轴倾角</div>
              <div className="tabular-nums-mono mt-1 text-[14px] font-medium text-ink">
                {axialTiltDeg.toFixed(1)}°
              </div>
            </div>

            <div className="rounded-[14px] border border-hairline bg-page/60 px-3.5 py-3">
              <div className="text-[11.5px] text-ink-muted">轨道倾角（模型）</div>
              <div className="tabular-nums-mono mt-1 text-[14px] font-medium text-ink">
                {inclinationDeg.toFixed(2)}°
              </div>
            </div>

            <div className="rounded-[14px] border border-hairline bg-page/60 px-3.5 py-3">
              <div className="text-[11.5px] text-ink-muted">公转周期</div>
              <div className="tabular-nums-mono mt-1 text-[14px] font-medium text-ink">
                {orbitalYears >= 2
                  ? `${orbitalYears.toFixed(2)} 年`
                  : `${telemetry.orbitalPeriodDays.toFixed(1)} 天`}
              </div>
            </div>

            <div className="rounded-[14px] border border-hairline bg-page/60 px-3.5 py-3">
              <div className="text-[11.5px] text-ink-muted">
                {almanac?.synodicDate ? almanac.synodicLabel : almanac?.apsisLabel || '下次天象'}
              </div>
              <div className="tabular-nums-mono mt-1 text-[14px] font-medium text-ink">
                {almanac?.synodicDate || almanac?.apsisDate || '—'}
              </div>
            </div>
          </div>

          {almanac?.apsisDate && almanac.synodicDate && (
            <div className="tabular-nums-mono mt-3 text-[12px] text-ink-muted">
              {almanac.apsisLabel}：{almanac.apsisDate}
              {almanac.apsisDistAu !== null ? `（日距 ${almanac.apsisDistAu.toFixed(3)} AU）` : ''}
            </div>
          )}
        </section>

        {/* Roadmap Card for Mercury / Mars OR Live Destination Card for Active Planets */}
        {editorial.roadmap && (
          <section
            aria-label="空间建设规划"
            className="mt-6 rounded-[24px] border border-hairline bg-paper px-6 py-6 sm:px-7"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 text-[18px] font-medium text-ink">{editorial.roadmap.title}</h2>
              <span className="rounded-full border border-hairline bg-surface px-3 py-0.5 text-[12px] text-postmark">
                {editorial.roadmap.phase}
              </span>
            </div>
            <p className="font-editorial-serif mt-2.5 mb-0 max-w-[740px] text-[14.5px] leading-relaxed text-ink-muted">
              {editorial.roadmap.description}
            </p>
          </section>
        )}

        {hasLivePortal && (
          <section
            aria-label="已开放空间入口"
            className="mt-6 flex flex-col gap-4 rounded-[24px] border border-hairline bg-paper px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7"
          >
            <div>
              <div className="text-[15.5px] font-medium text-ink">
                {planet.nameZh}已接入「{planet.portal.label}」
              </div>
              <p className="mt-1 mb-0 text-[13.5px] text-ink-muted">
                可直接前往对应站内空间继续浏览。
              </p>
            </div>
            <a
              href={planet.portal.href}
              onClick={handleSpaLink(planet.portal.href)}
              {...magneticHandlers}
              className="pill-cta-primary min-h-[40px] shrink-0 px-5 text-[13.5px]"
            >
              <span>前往{planet.portal.label}</span>
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </section>
        )}

        {/* Quick Planet Switcher & Primary Navigation */}
        <div className="mt-8 flex flex-col gap-5 border-t border-hairline pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="切换观测行星">
            {SOLAR_PLANETS.filter((p) => p.id !== 'earth').map((item) => {
              const active = item.id === planet.id;
              return (
                <a
                  key={item.id}
                  href={`/explore/${item.id}`}
                  onClick={handleSpaLink(`/explore/${item.id}`)}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'inline-flex min-h-[32px] items-center rounded-full border px-3 text-[12.5px] no-underline transition-colors',
                    active
                      ? 'border-transparent bg-cta-bg font-medium text-cta-text'
                      : 'border-hairline bg-surface text-ink-muted hover:border-hairline-strong hover:text-ink',
                  ].join(' ')}
                >
                  {item.nameZh}
                </a>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <a
              href="/observatory"
              onClick={handleSpaLink('/observatory')}
              className="pill-cta-secondary min-h-[38px] px-4 text-[13px]"
            >
              <Compass className="h-3.5 w-3.5" aria-hidden="true" />
              <span>前往观星台</span>
            </a>
            <a
              href="/"
              onClick={handleSpaLink('/')}
              {...magneticHandlers}
              className="pill-cta-primary min-h-[38px] px-4 text-[13px]"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>返回太阳系</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
