import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  Body,
  Equator,
  Horizon,
  Illumination,
  MoonPhase,
  Observer,
  SearchAltitude,
  SearchHourAngle,
  SearchRiseSet,
} from 'astronomy-engine';
import {
  ArrowUpRight,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Compass,
  LocateFixed,
  MapPin,
  Moon,
  Orbit,
  Sun,
  Sunrise,
  Sunset,
} from 'lucide-react';
import { useRouter } from '../../../lib/router';

interface LocationPreset {
  id: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  tzOffsetMin: number; // minutes east of UTC
}

const LOCATION_PRESETS: readonly LocationPreset[] = [
  { id: 'beijing', name: '北京', region: '华北', lat: 39.9042, lng: 116.4074, tzOffsetMin: 480 },
  { id: 'kangding', name: '川西康定', region: '川西', lat: 30.0499, lng: 101.9624, tzOffsetMin: 480 },
  { id: 'namtso', name: '纳木错', region: '西藏', lat: 30.741, lng: 90.9623, tzOffsetMin: 480 },
  { id: 'sayram', name: '赛里木湖', region: '新疆', lat: 44.602, lng: 81.186, tzOffsetMin: 480 },
  { id: 'dali', name: '大理', region: '云南', lat: 25.6065, lng: 100.2676, tzOffsetMin: 480 },
  { id: 'lenghu', name: '冷湖', region: '青海暗夜', lat: 38.744, lng: 93.337, tzOffsetMin: 480 },
  { id: 'shanghai', name: '上海', region: '华东', lat: 31.2304, lng: 121.4737, tzOffsetMin: 480 },
  { id: 'tokyo', name: '东京', region: '日本', lat: 35.6762, lng: 139.6503, tzOffsetMin: 540 },
  { id: 'reykjavik', name: '冰岛雷克雅未克', region: '冰岛', lat: 64.1466, lng: -21.9426, tzOffsetMin: 0 },
] as const;

const GALACTIC_CENTER_RA_HOURS = 17.7611;
const GALACTIC_CENTER_DEC_DEG = -29.0078;

const COMPASS_LABELS = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'] as const;

type SkyBand =
  | 'night'
  | 'astro'
  | 'nautical'
  | 'blue'
  | 'goldenLow'
  | 'goldenHigh'
  | 'daylight';

const SKY_BAND_COLORS: Record<SkyBand, string> = {
  night: '#141926',
  astro: '#1f2c4a',
  nautical: '#2e4674',
  blue: '#4672b8',
  goldenLow: '#c2744e',
  goldenHigh: '#dea55c',
  daylight: '#d8ceb7',
};

interface DialSegment {
  band: SkyBand;
  startHour: number;
  endHour: number;
}

interface TimeRange {
  start: Date;
  end: Date;
}

interface GalacticCenterReport {
  darkWindows: TimeRange[];
  peakAlt: number;
  peakTime: Date | null;
  peakAzimuth: number | null;
  peakDirection: string;
  theoreticalMaxAlt: number;
  note: string;
  dialArcs: Array<{ startHour: number; endHour: number }>;
}

interface TwilightAlmanacResult {
  dayStartMs: number;
  dayEndMs: number;
  solarNoon: Date | null;
  noonAltitude: number;
  astroDawn: Date | null;
  nauticalDawn: Date | null;
  civilDawn: Date | null;
  morningMinus4: Date | null;
  sunrise: Date | null;
  morningPlus6: Date | null;
  eveningPlus6: Date | null;
  sunset: Date | null;
  eveningMinus4: Date | null;
  civilDusk: Date | null;
  nauticalDusk: Date | null;
  astroDusk: Date | null;
  daylightLabel: string;
  morningBlueLabel: string;
  morningGoldenLabel: string;
  eveningGoldenLabel: string;
  eveningBlueLabel: string;
  moon: {
    phaseAngle: number;
    phaseName: string;
    illuminationPercent: number;
    moonrise: Date | null;
    moonset: Date | null;
    southernHemisphere: boolean;
  };
  galacticCenter: GalacticCenterReport;
  dialSegments: DialSegment[];
  observatoryIso: string;
  observatoryTimeLabel: string;
}

function getBrowserTzOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}

function formatUtcOffsetLabel(offsetMin: number): string {
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return mm === 0 ? `UTC${sign}${hh}` : `UTC${sign}${hh}:${String(mm).padStart(2, '0')}`;
}

function formatIsoWithOffset(date: Date, offsetMin: number): string {
  const shifted = new Date(date.getTime() + offsetMin * 60_000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offH = String(Math.floor(abs / 60)).padStart(2, '0');
  const offM = String(abs % 60).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00${sign}${offH}:${offM}`;
}

function formatTodayYmd(offsetMin: number): string {
  const shifted = new Date(Date.now() + offsetMin * 60_000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function shiftYmd(ymd: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return ymd;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + deltaDays);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseYmdStartMs(ymd: string, offsetMin: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) {
    const today = formatTodayYmd(offsetMin);
    return parseYmdStartMs(today, offsetMin);
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0) - offsetMin * 60_000;
}

function formatClockInOffset(
  date: Date | null,
  offsetMin: number,
  dayStartMs?: number,
): string {
  if (!date || !Number.isFinite(date.getTime())) return '—';
  const shifted = new Date(date.getTime() + offsetMin * 60_000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  if (dayStartMs !== undefined) {
    const dayDiff = Math.floor((date.getTime() - dayStartMs) / 86_400_000);
    if (dayDiff === 1) return `${hh}:${mm} (+1)`;
    if (dayDiff === -1) return `${hh}:${mm} (-1)`;
  }
  return `${hh}:${mm}`;
}

function formatWindowRange(
  start: Date | null,
  end: Date | null,
  offsetMin: number,
  dayStartMs: number,
  fallback: string,
): string {
  if (!start || !end) return fallback;
  return `${formatClockInOffset(start, offsetMin, dayStartMs)} – ${formatClockInOffset(end, offsetMin, dayStartMs)}`;
}

function azimuthToCompass(azimuth: number): string {
  const norm = ((azimuth % 360) + 360) % 360;
  return COMPASS_LABELS[Math.round(norm / 45) % 8] ?? '正北';
}

function getMoonPhaseName(phaseAngleDeg: number): string {
  const deg = ((phaseAngleDeg % 360) + 360) % 360;
  if (deg < 22.5 || deg >= 337.5) return '新月';
  if (deg < 67.5) return '蛾眉月';
  if (deg < 112.5) return '上弦月';
  if (deg < 157.5) return '盈凸月';
  if (deg < 202.5) return '满月';
  if (deg < 247.5) return '亏凸月';
  if (deg < 292.5) return '下弦月';
  return '残月';
}

function buildMoonLitSvgPath(
  phaseAngleDeg: number,
  cx: number,
  cy: number,
  r: number,
  southernHemisphere = false,
): string | null {
  const normalized = ((phaseAngleDeg % 360) + 360) % 360;
  const displayDeg = southernHemisphere ? (360 - normalized) % 360 : normalized;

  if (displayDeg < 2 || displayDeg > 358) return null;
  if (displayDeg > 178 && displayDeg < 182) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
  }

  const rad = (displayDeg * Math.PI) / 180;
  const rx = Math.abs(Math.cos(rad)) * r;

  if (displayDeg < 180) {
    const outerArc = `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r}`;
    if (rx < 0.05) return `${outerArc} L ${cx} ${cy - r} Z`;
    const sweep = displayDeg < 90 ? 0 : 1;
    return `${outerArc} A ${rx.toFixed(3)} ${r} 0 0 ${sweep} ${cx} ${cy - r} Z`;
  }

  const outerArc = `M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r}`;
  if (rx < 0.05) return `${outerArc} L ${cx} ${cy - r} Z`;
  const sweep = displayDeg < 270 ? 0 : 1;
  return `${outerArc} A ${rx.toFixed(3)} ${r} 0 0 ${sweep} ${cx} ${cy - r} Z`;
}

function classifySkyBand(sunAltitude: number): SkyBand {
  if (sunAltitude <= -18) return 'night';
  if (sunAltitude <= -12) return 'astro';
  if (sunAltitude <= -6) return 'nautical';
  if (sunAltitude <= -4) return 'blue';
  if (sunAltitude <= 0) return 'goldenLow';
  if (sunAltitude <= 6) return 'goldenHigh';
  return 'daylight';
}

function safeSearchAltitude(
  observer: Observer,
  direction: number,
  start: Date,
  limitDays: number,
  altitude: number,
): Date | null {
  try {
    const res = SearchAltitude(Body.Sun, observer, direction, start, limitDays, altitude);
    return res ? res.date : null;
  } catch {
    return null;
  }
}

function safeSearchRiseSet(
  body: Body,
  observer: Observer,
  direction: number,
  start: Date,
  limitDays: number,
): Date | null {
  try {
    const res = SearchRiseSet(body, observer, direction, start, limitDays);
    return res ? res.date : null;
  } catch {
    return null;
  }
}

function computeTwilightAlmanac(
  lat: number,
  lng: number,
  dateYmd: string,
  tzOffsetMin: number,
): TwilightAlmanacResult {
  const safeLat = Number.isFinite(lat) ? Math.max(-89.9, Math.min(89.9, lat)) : 39.9042;
  const safeLng = Number.isFinite(lng) ? Math.max(-180, Math.min(180, lng)) : 116.4074;
  const observer = new Observer(safeLat, safeLng, 0);

  const dayStartMs = parseYmdStartMs(dateYmd, tzOffsetMin);
  const dayEndMs = dayStartMs + 86_400_000;
  const dayStart = new Date(dayStartMs);
  const dayEnd = new Date(dayEndMs);

  // 1. Solar Noon inside the chosen local civil day
  let solarNoon: Date | null = null;
  let noonAltitude = 0;
  try {
    let noonEvt = SearchHourAngle(Body.Sun, observer, 0, dayStart, 1);
    if (noonEvt.time.date.getTime() > dayEndMs) {
      noonEvt = SearchHourAngle(Body.Sun, observer, 0, dayEnd, -1);
    }
    solarNoon = noonEvt.time.date;
    noonAltitude = noonEvt.hor.altitude;
  } catch {
    solarNoon = new Date(dayStartMs + 12 * 3600_000);
    const eq = Equator(Body.Sun, solarNoon, observer, true, true);
    noonAltitude = Horizon(solarNoon, observer, eq.ra, eq.dec, 'normal').altitude;
  }

  const noonMs = solarNoon.getTime();
  const morningStart = new Date(noonMs - 12 * 3600_000);

  const keepMorning = (d: Date | null): Date | null =>
    d && d.getTime() < noonMs ? d : null;
  const keepEvening = (d: Date | null): Date | null =>
    d && d.getTime() > noonMs ? d : null;

  // 2. Morning & Evening twilight / golden / blue hour transitions
  const astroDawn = keepMorning(safeSearchAltitude(observer, 1, morningStart, 0.52, -18));
  const nauticalDawn = keepMorning(safeSearchAltitude(observer, 1, morningStart, 0.52, -12));
  const civilDawn = keepMorning(safeSearchAltitude(observer, 1, morningStart, 0.52, -6));
  const morningMinus4 = keepMorning(safeSearchAltitude(observer, 1, morningStart, 0.52, -4));
  const sunrise = keepMorning(safeSearchRiseSet(Body.Sun, observer, 1, morningStart, 0.52));
  const morningPlus6 = keepMorning(safeSearchAltitude(observer, 1, morningStart, 0.52, 6));

  const eveningPlus6 = keepEvening(safeSearchAltitude(observer, -1, solarNoon, 0.52, 6));
  const sunset = keepEvening(safeSearchRiseSet(Body.Sun, observer, -1, solarNoon, 0.52));
  const eveningMinus4 = keepEvening(safeSearchAltitude(observer, -1, solarNoon, 0.52, -4));
  const civilDusk = keepEvening(safeSearchAltitude(observer, -1, solarNoon, 0.52, -6));
  const nauticalDusk = keepEvening(safeSearchAltitude(observer, -1, solarNoon, 0.52, -12));
  const astroDusk = keepEvening(safeSearchAltitude(observer, -1, solarNoon, 0.52, -18));

  // Daylight duration
  let daylightLabel = '—';
  if (sunrise && sunset && sunset.getTime() > sunrise.getTime()) {
    const mins = Math.round((sunset.getTime() - sunrise.getTime()) / 60_000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    daylightLabel = `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
  } else if (noonAltitude > -0.833) {
    daylightLabel = '极昼 24h 00m';
  } else {
    daylightLabel = '极夜 00h 00m';
  }

  const lowSunAllDay =
    morningMinus4 !== null &&
    eveningMinus4 !== null &&
    morningPlus6 === null &&
    eveningPlus6 === null &&
    noonAltitude > -4 &&
    noonAltitude <= 6;

  const morningBlueLabel = formatWindowRange(
    civilDawn,
    morningMinus4,
    tzOffsetMin,
    dayStartMs,
    noonAltitude < -6 ? '未达蓝调高度' : '高纬白夜过渡',
  );
  const eveningBlueLabel = formatWindowRange(
    eveningMinus4,
    civilDusk,
    tzOffsetMin,
    dayStartMs,
    noonAltitude < -6 ? '未达蓝调高度' : '高纬白夜过渡',
  );
  const morningGoldenLabel = lowSunAllDay
    ? `${formatClockInOffset(morningMinus4, tzOffsetMin, dayStartMs)} – ${formatClockInOffset(solarNoon, tzOffsetMin, dayStartMs)}`
    : formatWindowRange(
        morningMinus4,
        morningPlus6,
        tzOffsetMin,
        dayStartMs,
        noonAltitude <= -4 ? '太阳未升至 -4°' : '持续黄金暖光',
      );
  const eveningGoldenLabel = lowSunAllDay
    ? `${formatClockInOffset(solarNoon, tzOffsetMin, dayStartMs)} – ${formatClockInOffset(eveningMinus4, tzOffsetMin, dayStartMs)}`
    : formatWindowRange(
        eveningPlus6,
        eveningMinus4,
        tzOffsetMin,
        dayStartMs,
        noonAltitude <= -4 ? '太阳未升至 -4°' : '持续黄金暖光',
      );

  // 3. Moon phase, illumination, rise & set
  const moonRef = new Date(dayStartMs + 21 * 3600_000);
  const phaseAngle = ((MoonPhase(moonRef) % 360) + 360) % 360;
  const moonIllum = Illumination(Body.Moon, moonRef);
  const illuminationPercent = Math.max(
    0,
    Math.min(100, Math.round(moonIllum.phase_fraction * 100)),
  );
  const rawMoonrise = safeSearchRiseSet(Body.Moon, observer, 1, dayStart, 1);
  const rawMoonset = safeSearchRiseSet(Body.Moon, observer, -1, dayStart, 1);
  const moonrise = rawMoonrise && rawMoonrise.getTime() < dayEndMs ? rawMoonrise : null;
  const moonset = rawMoonset && rawMoonset.getTime() < dayEndMs ? rawMoonset : null;

  // 4. 24-hour Circular Twilight Dial sampling (144 intervals = 10-min steps)
  const dialSegments: DialSegment[] = [];
  const steps = 144;
  const stepHours = 24 / steps;
  for (let i = 0; i < steps; i += 1) {
    const midMs = dayStartMs + (i + 0.5) * stepHours * 3600_000;
    const sampleDate = new Date(midMs);
    const sunEq = Equator(Body.Sun, sampleDate, observer, true, true);
    const sunHor = Horizon(sampleDate, observer, sunEq.ra, sunEq.dec, 'normal');
    const band = classifySkyBand(sunHor.altitude);
    const startHour = i * stepHours;
    const endHour = (i + 1) * stepHours;
    const prevSeg = dialSegments[dialSegments.length - 1];
    if (prevSeg && prevSeg.band === band) {
      prevSeg.endHour = endHour;
    } else {
      dialSegments.push({ band, startHour, endHour });
    }
  }

  // 5. Galactic Center (RA 17.7611h, Dec -29.0078°) dark-sky (>10° & Sun <= -18°) sampling
  // Sample tonight from solarNoon -> solarNoon + 24h in 5-min steps
  const darkWindows: TimeRange[] = [];
  let inWindow = false;
  let winStart: Date | null = null;
  let lastValid: Date | null = null;
  let peakAlt = -90;
  let peakTime: Date | null = null;
  let peakAzimuth: number | null = null;
  let hadAstroDarkness = false;

  const nightStepMs = 5 * 60_000;
  const nightSteps = 288;
  for (let i = 0; i <= nightSteps; i += 1) {
    const t = new Date(noonMs + i * nightStepMs);
    const sunEq = Equator(Body.Sun, t, observer, true, true);
    const sunHor = Horizon(t, observer, sunEq.ra, sunEq.dec, 'normal');
    const isDark = sunHor.altitude <= -18;
    if (isDark) hadAstroDarkness = true;

    const gcHor = Horizon(t, observer, GALACTIC_CENTER_RA_HOURS, GALACTIC_CENTER_DEC_DEG, 'normal');
    const visible = isDark && gcHor.altitude >= 10;

    if (visible) {
      if (gcHor.altitude > peakAlt) {
        peakAlt = gcHor.altitude;
        peakTime = t;
        peakAzimuth = gcHor.azimuth;
      }
      if (!inWindow) {
        inWindow = true;
        winStart = t;
      }
      lastValid = t;
    } else if (inWindow && winStart && lastValid) {
      darkWindows.push({ start: winStart, end: lastValid });
      inWindow = false;
      winStart = null;
      lastValid = null;
    }
  }
  if (inWindow && winStart && lastValid) {
    darkWindows.push({ start: winStart, end: lastValid });
  }

  // Also map tonight's GC dark windows onto the 24h circular dial without splitting at midnight
  const dialArcs: Array<{ startHour: number; endHour: number }> = [];
  for (const w of darkWindows) {
    const h1 = ((w.start.getTime() - dayStartMs) / 3600_000 + 24) % 24;
    const durationH = Math.min(23.9, (w.end.getTime() - w.start.getTime()) / 3600_000);
    if (durationH <= 0.05) continue;
    dialArcs.push({ startHour: h1, endHour: h1 + durationH });
  }

  const theoreticalMaxAlt = 90 - Math.abs(safeLat - GALACTIC_CENTER_DEC_DEG);
  let gcNote = '';
  if (darkWindows.length > 0 && peakTime && peakAzimuth !== null) {
    gcNote = `天文黑夜中最高仰角 ${peakAlt.toFixed(1)}°（${azimuthToCompass(peakAzimuth)}方，${formatClockInOffset(peakTime, tzOffsetMin, dayStartMs)}）`;
  } else if (theoreticalMaxAlt < 0) {
    gcNote = `该纬度银心最高仰角仅 ${theoreticalMaxAlt.toFixed(1)}°，终年位于地平线以下`;
  } else if (theoreticalMaxAlt < 10) {
    gcNote = `该纬度银心最高仅达 ${theoreticalMaxAlt.toFixed(1)}°，难以越过 10° 观测门槛`;
  } else if (!hadAstroDarkness) {
    gcNote = '当夜处于高纬白夜期，太阳未降至 -18° 以下，天空背景偏亮';
  } else {
    gcNote = '今夜银心随太阳在白昼或地平线附近运行，可切换至 4–9 月查看最佳银心夜窗口';
  }

  // 6. Choose ideal timestamp for Observatory jump CTA
  const defaultEvening = new Date(dayStartMs + 21.5 * 3600_000);
  const targetSkyDate = peakTime ?? astroDusk ?? defaultEvening;
  const observatoryIso = formatIsoWithOffset(targetSkyDate, tzOffsetMin);
  const observatoryTimeLabel = formatClockInOffset(targetSkyDate, tzOffsetMin, dayStartMs);

  return {
    dayStartMs,
    dayEndMs,
    solarNoon,
    noonAltitude,
    astroDawn,
    nauticalDawn,
    civilDawn,
    morningMinus4,
    sunrise,
    morningPlus6,
    eveningPlus6,
    sunset,
    eveningMinus4,
    civilDusk,
    nauticalDusk,
    astroDusk,
    daylightLabel,
    morningBlueLabel,
    morningGoldenLabel,
    eveningGoldenLabel,
    eveningBlueLabel,
    moon: {
      phaseAngle,
      phaseName: getMoonPhaseName(phaseAngle),
      illuminationPercent,
      moonrise,
      moonset,
      southernHemisphere: safeLat < 0,
    },
    galacticCenter: {
      darkWindows,
      peakAlt: peakTime ? peakAlt : theoreticalMaxAlt,
      peakTime,
      peakAzimuth,
      peakDirection: peakAzimuth !== null ? azimuthToCompass(peakAzimuth) : '正南',
      theoreticalMaxAlt,
      note: gcNote,
      dialArcs,
    },
    dialSegments,
    observatoryIso,
    observatoryTimeLabel,
  };
}

/* -------------------------------------------------------------------------- */
/* 24-Hour Circular SVG Geometry Helpers                                      */
/* -------------------------------------------------------------------------- */

const DIAL_SIZE = 340;
const DIAL_CX = DIAL_SIZE / 2;
const DIAL_CY = DIAL_SIZE / 2;
const DIAL_OUTER_R = 128;
const DIAL_GC_R = 107;
const DIAL_LABEL_R = 150;

function hourToRad(hour: number): number {
  return ((hour / 24) * 360 + 90) * (Math.PI / 180);
}

function polarPoint(cx: number, cy: number, radius: number, hour: number): { x: number; y: number } {
  const rad = hourToRad(hour);
  return {
    x: cx + Math.cos(rad) * radius,
    y: cy + Math.sin(rad) * radius,
  };
}

function describeHourArc(
  cx: number,
  cy: number,
  radius: number,
  startHour: number,
  endHour: number,
): string {
  const span = Math.max(0.01, Math.min(23.98, endHour - startHour));
  const p1 = polarPoint(cx, cy, radius, startHour);
  const p2 = polarPoint(cx, cy, radius, startHour + span);
  const largeArc = span > 12 ? 1 : 0;
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}

function dateToDialHour(date: Date | null, dayStartMs: number): number | null {
  if (!date) return null;
  const h = (date.getTime() - dayStartMs) / 3600_000;
  return ((h % 24) + 24) % 24;
}

const DIAL_HOUR_MARKS = [0, 3, 6, 9, 12, 15, 18, 21] as const;

export default function TwilightCompassTool() {
  const { navigate } = useRouter();
  const initialPreset = LOCATION_PRESETS[0]!;

  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(initialPreset.id);
  const [placeName, setPlaceName] = useState<string>(initialPreset.name);
  const [lat, setLat] = useState<number>(initialPreset.lat);
  const [lng, setLng] = useState<number>(initialPreset.lng);
  const [latInput, setLatInput] = useState<string>(initialPreset.lat.toFixed(4));
  const [lngInput, setLngInput] = useState<string>(initialPreset.lng.toFixed(4));
  const [tzOffsetMin, setTzOffsetMin] = useState<number>(initialPreset.tzOffsetMin);
  const [dateYmd, setDateYmd] = useState<string>(() => formatTodayYmd(initialPreset.tzOffsetMin));

  const [geoStatus, setGeoStatus] = useState<'idle' | 'locating' | 'error'>('idle');
  const [geoMessage, setGeoMessage] = useState<string>('');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const selectPreset = (preset: LocationPreset) => {
    setSelectedPresetId(preset.id);
    setPlaceName(preset.name);
    setLat(preset.lat);
    setLng(preset.lng);
    setLatInput(preset.lat.toFixed(4));
    setLngInput(preset.lng.toFixed(4));
    setTzOffsetMin(preset.tzOffsetMin);
    setGeoStatus('idle');
    setGeoMessage('');
  };

  const handleLatChange = (raw: string) => {
    setLatInput(raw);
    const parsed = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(parsed) && parsed >= -89.9 && parsed <= 89.9) {
      setLat(parsed);
      setSelectedPresetId(null);
      setPlaceName('自定义坐标');
      setTzOffsetMin(getBrowserTzOffsetMin());
    }
  };

  const handleLngChange = (raw: string) => {
    setLngInput(raw);
    const parsed = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(parsed) && parsed >= -180 && parsed <= 180) {
      setLng(parsed);
      setSelectedPresetId(null);
      setPlaceName('自定义坐标');
      setTzOffsetMin(getBrowserTzOffsetMin());
    }
  };

  const handleLocateCurrent = () => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGeoStatus('error');
      setGeoMessage('当前浏览器不支持地理定位，请直接选择城市或输入经纬度。');
      return;
    }
    setGeoStatus('locating');
    setGeoMessage('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const nextLat = Math.max(-89.9, Math.min(89.9, pos.coords.latitude));
        const nextLng = Math.max(-180, Math.min(180, pos.coords.longitude));
        const localTz = getBrowserTzOffsetMin();
        setLat(nextLat);
        setLng(nextLng);
        setLatInput(nextLat.toFixed(4));
        setLngInput(nextLng.toFixed(4));
        setSelectedPresetId(null);
        setPlaceName('当前定位坐标');
        setTzOffsetMin(localTz);
        setDateYmd(formatTodayYmd(localTz));
        setGeoStatus('idle');
        setGeoMessage('已使用设备当前位置（坐标仅用于本地计算，不上传服务器）。');
      },
      (err) => {
        setGeoStatus('error');
        if (err.code === err.PERMISSION_DENIED) {
          setGeoMessage('定位权限未开启，可改选上方摄影地预设或手动输入经纬度。');
        } else {
          setGeoMessage('暂时无法获取设备位置，请稍后重试或手动输入经纬度。');
        }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  };

  const almanac = useMemo(
    () => computeTwilightAlmanac(lat, lng, dateYmd, tzOffsetMin),
    [dateYmd, lat, lng, tzOffsetMin],
  );

  const moonLitPath = useMemo(
    () =>
      buildMoonLitSvgPath(
        almanac.moon.phaseAngle,
        20,
        20,
        15,
        almanac.moon.southernHemisphere,
      ),
    [almanac.moon.phaseAngle, almanac.moon.southernHemisphere],
  );

  // Current time at target location for the dial needle
  const nowShifted = new Date(nowMs + tzOffsetMin * 60_000);
  const nowLocalHour =
    nowShifted.getUTCHours() + nowShifted.getUTCMinutes() / 60 + nowShifted.getUTCSeconds() / 3600;
  const nowClockStr = `${String(nowShifted.getUTCHours()).padStart(2, '0')}:${String(nowShifted.getUTCMinutes()).padStart(2, '0')}`;
  const isTodaySelected = dateYmd === formatTodayYmd(tzOffsetMin);

  const sunriseHour = dateToDialHour(almanac.sunrise, almanac.dayStartMs);
  const sunsetHour = dateToDialHour(almanac.sunset, almanac.dayStartMs);
  const noonHour = dateToDialHour(almanac.solarNoon, almanac.dayStartMs);

  const needleTip = polarPoint(DIAL_CX, DIAL_CY, DIAL_OUTER_R + 12, nowLocalHour);
  const needleTail = polarPoint(DIAL_CX, DIAL_CY, 16, (nowLocalHour + 12) % 24);

  const observatoryHref = `/observatory?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&time=${encodeURIComponent(almanac.observatoryIso)}&place=${encodeURIComponent(placeName)}`;

  const handleOpenObservatory = (event: MouseEvent<HTMLAnchorElement>) => {
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
    navigate(observatoryHref);
  };

  const formatTime = (d: Date | null) =>
    formatClockInOffset(d, tzOffsetMin, almanac.dayStartMs);

  const scheduleRows: ReadonlyArray<{
    label: string;
    angle: string;
    value: string;
    accent?: 'blue' | 'golden' | 'sun' | 'night';
  }> = [
    { label: '天文晨光始', angle: '-18°', value: formatTime(almanac.astroDawn), accent: 'night' },
    { label: '航海晨光始', angle: '-12°', value: formatTime(almanac.nauticalDawn), accent: 'night' },
    { label: '民用晨光始', angle: '-6°', value: formatTime(almanac.civilDawn), accent: 'blue' },
    { label: '晨间蓝调时刻', angle: '-6° ~ -4°', value: almanac.morningBlueLabel, accent: 'blue' },
    { label: '日出时刻', angle: '0°', value: formatTime(almanac.sunrise), accent: 'sun' },
    { label: '晨间黄金时刻', angle: '-4° ~ +6°', value: almanac.morningGoldenLabel, accent: 'golden' },
    {
      label: '太阳中天（正午）',
      angle: `${almanac.noonAltitude.toFixed(1)}°`,
      value: formatTime(almanac.solarNoon),
      accent: 'sun',
    },
    { label: '傍晚黄金时刻', angle: '+6° ~ -4°', value: almanac.eveningGoldenLabel, accent: 'golden' },
    { label: '日落时刻', angle: '0°', value: formatTime(almanac.sunset), accent: 'sun' },
    { label: '傍晚蓝调时刻', angle: '-4° ~ -6°', value: almanac.eveningBlueLabel, accent: 'blue' },
    { label: '民用昏影终', angle: '-6°', value: formatTime(almanac.civilDusk), accent: 'blue' },
    { label: '航海昏影终', angle: '-12°', value: formatTime(almanac.nauticalDusk), accent: 'night' },
    { label: '天文昏影终', angle: '-18°', value: formatTime(almanac.astroDusk), accent: 'night' },
  ];

  const gcWindowText =
    almanac.galacticCenter.darkWindows.length > 0
      ? almanac.galacticCenter.darkWindows
          .map(
            (w) =>
              `${formatTime(w.start)} – ${formatTime(w.end)}`,
          )
          .join(' · ')
      : '今夜无暗夜高仰角窗口';

  return (
    <div className="space-y-5">
      {/* Header Row */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-medium tracking-[-0.02em] text-ink sm:text-[24px]">
            晨昏与蓝调时刻罗盘
          </h2>
          <p className="mt-1 text-[14px] text-ink-muted">
            本地星历引擎离线推算黄金时刻、蓝调时刻、月相与银河银心观测窗口，为风光与星空出行提前校准时间。
          </p>
        </div>

        <a
          href={observatoryHref}
          onClick={handleOpenObservatory}
          className="pill-cta-primary min-h-[40px] px-5 text-[13.5px]"
        >
          <Compass className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>在观星台打开今夜星空</span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </a>
      </div>

      {/* Location Presets + Manual Coords + Date Bar */}
      <section
        aria-label="地点与日期设置"
        className="rounded-[20px] border border-hairline bg-surface p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          {LOCATION_PRESETS.map((preset) => {
            const active = selectedPresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={active}
                onClick={() => selectPreset(preset)}
                className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition-colors ${
                  active
                    ? 'border-accent/55 bg-paper font-medium text-ink'
                    : 'border-hairline bg-paper/55 text-ink-muted hover:border-hairline-strong hover:text-ink'
                }`}
              >
                <span>{preset.name}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 border-t border-hairline pt-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          {/* Manual Lat / Lng */}
          <div className="grid min-w-0 grid-cols-2 gap-2.5">
            <label className="block min-w-0">
              <span className="mb-1 block text-[12px] text-ink-muted">纬度 (°N / -°S)</span>
              <input
                type="number"
                step="0.0001"
                min={-89.9}
                max={89.9}
                value={latInput}
                onChange={(e) => handleLatChange(e.target.value)}
                className="tabular-nums-mono w-full min-w-0 rounded-[12px] border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label className="block min-w-0">
              <span className="mb-1 block text-[12px] text-ink-muted">经度 (°E / -°W)</span>
              <input
                type="number"
                step="0.0001"
                min={-180}
                max={180}
                value={lngInput}
                onChange={(e) => handleLngChange(e.target.value)}
                className="tabular-nums-mono w-full min-w-0 rounded-[12px] border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </div>

          {/* Date Picker + Day Stepping */}
          <div className="min-w-0">
            <span className="mb-1 block text-[12px] text-ink-muted">
              推算日期（{formatUtcOffsetLabel(tzOffsetMin)} 当地时间）
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="前一天"
                onClick={() => setDateYmd((d) => shiftYmd(d, -1))}
                className="inline-flex h-[38px] w-[36px] shrink-0 items-center justify-center rounded-[12px] border border-hairline bg-paper text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <div className="relative min-w-0 flex-1">
                <Calendar
                  className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted"
                  aria-hidden="true"
                />
                <input
                  type="date"
                  aria-label="选择推算日期"
                  value={dateYmd}
                  onChange={(e) => {
                    if (e.target.value) setDateYmd(e.target.value);
                  }}
                  className="tabular-nums-mono h-[38px] w-full rounded-[12px] border border-hairline bg-paper py-1.5 pr-2.5 pl-8 text-[13.5px] text-ink focus:border-accent focus:outline-none"
                />
              </div>
              <button
                type="button"
                aria-label="后一天"
                onClick={() => setDateYmd((d) => shiftYmd(d, 1))}
                className="inline-flex h-[38px] w-[36px] shrink-0 items-center justify-center rounded-[12px] border border-hairline bg-paper text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setDateYmd(formatTodayYmd(tzOffsetMin))}
                className="h-[38px] shrink-0 rounded-[12px] border border-hairline bg-paper px-3 text-[12.5px] text-ink transition-colors hover:border-hairline-strong hover:bg-surface-hover"
              >
                今天
              </button>
            </div>
          </div>

          {/* Geolocation CTA */}
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleLocateCurrent}
              disabled={geoStatus === 'locating'}
              className="inline-flex h-[38px] w-full items-center justify-center gap-1.5 rounded-[12px] border border-hairline-strong bg-paper px-4 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60 md:w-auto"
            >
              <LocateFixed className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
              <span>{geoStatus === 'locating' ? '定位中…' : '定位当前城市'}</span>
            </button>
          </div>
        </div>

        {geoMessage && (
          <p
            className={`mt-2.5 mb-0 text-[12.5px] ${
              geoStatus === 'error' ? 'text-postmark' : 'text-ink-muted'
            }`}
          >
            {geoMessage}
          </p>
        )}
      </section>

      {/* Main Split: 24-Hour Circular SVG Twilight Dial + Tabular Schedule */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,410px)_minmax(0,1fr)]">
        {/* Left Column: Editorial 24h Circular SVG Twilight Dial + Lunar & Galactic Cards */}
        <div className="space-y-5">
          <section
            aria-label="二十四小时晨昏光影罗盘"
            className="rounded-[20px] border border-hairline bg-paper p-5"
          >
            <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-muted">
              <span className="inline-flex items-center gap-1.5 text-ink">
                <MapPin className="h-3.5 w-3.5 text-postmark" aria-hidden="true" />
                <strong className="font-medium">{placeName}</strong>
              </span>
              <span className="tabular-nums-mono">
                {lat >= 0 ? `${lat.toFixed(2)}°N` : `${Math.abs(lat).toFixed(2)}°S`},{' '}
                {lng >= 0 ? `${lng.toFixed(2)}°E` : `${Math.abs(lng).toFixed(2)}°W`}
              </span>
            </div>

            {/* 24-Hour Circular SVG Twilight Dial */}
            <div className="mx-auto mt-3 w-full max-w-[336px]">
              <svg
                viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
                className="h-auto w-full"
                role="img"
                aria-label={`${placeName} ${dateYmd} 二十四小时晨昏时刻罗盘`}
              >
                {/* Subtle outer compass ring */}
                <circle
                  cx={DIAL_CX}
                  cy={DIAL_CY}
                  r={DIAL_OUTER_R + 14}
                  fill="none"
                  stroke="var(--color-hairline)"
                  strokeWidth={1}
                />

                {/* Inner hairline reticle */}
                <circle
                  cx={DIAL_CX}
                  cy={DIAL_CY}
                  r={DIAL_GC_R - 12}
                  fill="none"
                  stroke="var(--color-hairline)"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                />
                <line
                  x1={DIAL_CX - (DIAL_GC_R - 12)}
                  y1={DIAL_CY}
                  x2={DIAL_CX + (DIAL_GC_R - 12)}
                  y2={DIAL_CY}
                  stroke="var(--color-hairline)"
                  strokeWidth={0.75}
                />
                <line
                  x1={DIAL_CX}
                  y1={DIAL_CY - (DIAL_GC_R - 12)}
                  x2={DIAL_CX}
                  y2={DIAL_CY + (DIAL_GC_R - 12)}
                  stroke="var(--color-hairline)"
                  strokeWidth={0.75}
                />

                {/* 24h Sky Phase Band Ring */}
                <g aria-hidden="true">
                  {almanac.dialSegments.length === 1 ? (
                    <circle
                      cx={DIAL_CX}
                      cy={DIAL_CY}
                      r={DIAL_OUTER_R}
                      fill="none"
                      stroke={SKY_BAND_COLORS[almanac.dialSegments[0]!.band]}
                      strokeWidth={18}
                    />
                  ) : (
                    almanac.dialSegments.map((seg, idx) => (
                      <path
                        key={`${seg.band}-${idx}`}
                        d={describeHourArc(
                          DIAL_CX,
                          DIAL_CY,
                          DIAL_OUTER_R,
                          seg.startHour,
                          Math.min(24, seg.endHour + 0.04),
                        )}
                        fill="none"
                        stroke={SKY_BAND_COLORS[seg.band]}
                        strokeWidth={18}
                        strokeLinecap="butt"
                      />
                    ))
                  )}
                </g>

                {/* Galactic Center Dark-Sky Visibility Inner Arc */}
                <g aria-hidden="true">
                  <circle
                    cx={DIAL_CX}
                    cy={DIAL_CY}
                    r={DIAL_GC_R}
                    fill="none"
                    stroke="var(--color-hairline)"
                    strokeWidth={4}
                    opacity={0.45}
                  />
                  {almanac.galacticCenter.dialArcs.map((arc, idx) => (
                    <path
                      key={`gc-${idx}`}
                      d={describeHourArc(DIAL_CX, DIAL_CY, DIAL_GC_R, arc.startHour, arc.endHour)}
                      fill="none"
                      stroke="var(--color-accent)"
                      strokeWidth={5}
                      strokeLinecap="round"
                    />
                  ))}
                </g>

                {/* 24h Clock Ticks & Labels (12 at top, 00 at bottom) */}
                <g aria-hidden="true">
                  {Array.from({ length: 24 }, (_, hour) => {
                    const isMajor = hour % 3 === 0;
                    const p1 = polarPoint(DIAL_CX, DIAL_CY, DIAL_OUTER_R + 10, hour);
                    const p2 = polarPoint(
                      DIAL_CX,
                      DIAL_CY,
                      DIAL_OUTER_R + (isMajor ? 16 : 13.5),
                      hour,
                    );
                    return (
                      <line
                        key={hour}
                        x1={p1.x.toFixed(2)}
                        y1={p1.y.toFixed(2)}
                        x2={p2.x.toFixed(2)}
                        y2={p2.y.toFixed(2)}
                        stroke={isMajor ? 'var(--color-ink-muted)' : 'var(--color-hairline-strong)'}
                        strokeWidth={isMajor ? 1.2 : 0.85}
                      />
                    );
                  })}

                  {DIAL_HOUR_MARKS.map((hour) => {
                    const pt = polarPoint(DIAL_CX, DIAL_CY, DIAL_LABEL_R + 6, hour);
                    return (
                      <text
                        key={`lbl-${hour}`}
                        x={pt.x.toFixed(1)}
                        y={pt.y.toFixed(1)}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="var(--color-ink-muted)"
                        fontSize="10.5"
                        fontFamily="var(--font-mono)"
                      >
                        {String(hour).padStart(2, '0')}
                      </text>
                    );
                  })}
                </g>

                {/* Sunrise / Sunset / Solar Noon Pins */}
                {noonHour !== null && (() => {
                  const pt = polarPoint(DIAL_CX, DIAL_CY, DIAL_OUTER_R, noonHour);
                  return (
                    <circle
                      cx={pt.x.toFixed(2)}
                      cy={pt.y.toFixed(2)}
                      r={3.5}
                      fill="#faf8f4"
                      stroke="#9a5b42"
                      strokeWidth={1.6}
                    />
                  );
                })()}

                {sunriseHour !== null && (() => {
                  const pt = polarPoint(DIAL_CX, DIAL_CY, DIAL_OUTER_R, sunriseHour);
                  return (
                    <circle
                      cx={pt.x.toFixed(2)}
                      cy={pt.y.toFixed(2)}
                      r={4.2}
                      fill="#f4c27a"
                      stroke="#1f1f1f"
                      strokeWidth={1.4}
                    />
                  );
                })()}

                {sunsetHour !== null && (() => {
                  const pt = polarPoint(DIAL_CX, DIAL_CY, DIAL_OUTER_R, sunsetHour);
                  return (
                    <circle
                      cx={pt.x.toFixed(2)}
                      cy={pt.y.toFixed(2)}
                      r={4.2}
                      fill="#c2744e"
                      stroke="#1f1f1f"
                      strokeWidth={1.4}
                    />
                  );
                })()}

                {/* Current Local Time Needle */}
                <g aria-hidden="true">
                  <line
                    x1={needleTail.x.toFixed(2)}
                    y1={needleTail.y.toFixed(2)}
                    x2={needleTip.x.toFixed(2)}
                    y2={needleTip.y.toFixed(2)}
                    stroke="var(--color-postmark)"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    opacity={isTodaySelected ? 0.95 : 0.45}
                  />
                  <circle
                    cx={needleTip.x.toFixed(2)}
                    cy={needleTip.y.toFixed(2)}
                    r={3.2}
                    fill="var(--color-postmark)"
                    opacity={isTodaySelected ? 1 : 0.55}
                  />
                  <circle
                    cx={DIAL_CX}
                    cy={DIAL_CY}
                    r={3}
                    fill="var(--color-paper)"
                    stroke="var(--color-postmark)"
                    strokeWidth={1.5}
                  />
                </g>

                {/* Center Editorial Readout */}
                <g textAnchor="middle">
                  <text
                    x={DIAL_CX}
                    y={DIAL_CY - 30}
                    fill="var(--color-ink-muted)"
                    fontSize="11"
                    fontFamily="var(--font-sans)"
                  >
                    昼长
                  </text>
                  <text
                    x={DIAL_CX}
                    y={DIAL_CY - 10}
                    fill="var(--color-ink)"
                    fontSize="18"
                    fontWeight="500"
                    fontFamily="var(--font-mono)"
                  >
                    {almanac.daylightLabel}
                  </text>
                  <text
                    x={DIAL_CX}
                    y={DIAL_CY + 24}
                    fill="var(--color-ink-muted)"
                    fontSize="11"
                    fontFamily="var(--font-sans)"
                  >
                    正午仰角{' '}
                    <tspan fontFamily="var(--font-mono)" fill="var(--color-ink)">
                      {almanac.noonAltitude.toFixed(1)}°
                    </tspan>
                  </text>
                  <text
                    x={DIAL_CX}
                    y={DIAL_CY + 44}
                    fill="var(--color-postmark)"
                    fontSize="10.5"
                    fontFamily="var(--font-mono)"
                  >
                    此刻 {nowClockStr}
                  </text>
                </g>
              </svg>
            </div>

            {/* Compact Dial Legend */}
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5 border-t border-hairline pt-3 text-[11.5px] text-ink-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SKY_BAND_COLORS.night }} />
                <span>深暗夜空</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SKY_BAND_COLORS.nautical }} />
                <span>天文/航海昏影</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SKY_BAND_COLORS.blue }} />
                <span>蓝调时刻</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SKY_BAND_COLORS.goldenHigh }} />
                <span>黄金时刻</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SKY_BAND_COLORS.daylight }} />
                <span>日间</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-4 rounded-full bg-accent" />
                <span>银心窗口</span>
              </span>
            </div>
          </section>

          {/* Lunar Phase & Galactic Center Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {/* Moon Card */}
            <section
              aria-label="月相与月出月落"
              className="rounded-[18px] border border-hairline bg-surface p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <svg
                    viewBox="0 0 40 40"
                    className="h-10 w-10 shrink-0"
                    role="img"
                    aria-label={`${almanac.moon.phaseName}，照度 ${almanac.moon.illuminationPercent}%`}
                  >
                    <circle
                      cx={20}
                      cy={20}
                      r={15}
                      fill="#181c24"
                      stroke="var(--color-hairline-strong)"
                      strokeWidth={1.2}
                    />
                    {moonLitPath && <path d={moonLitPath} fill="#ede6d2" />}
                  </svg>
                  <div>
                    <div className="flex items-center gap-2">
                      <Moon className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                      <h3 className="m-0 text-[15px] font-medium text-ink">
                        {almanac.moon.phaseName}
                      </h3>
                    </div>
                    <p className="mt-0.5 mb-0 text-[12.5px] text-ink-muted">
                      月面照度{' '}
                      <span className="tabular-nums-mono font-medium text-ink">
                        {almanac.moon.illuminationPercent}%
                      </span>
                    </p>
                  </div>
                </div>

                <div className="space-y-1 text-right text-[12.5px]">
                  <div className="text-ink-muted">
                    月出{' '}
                    <span className="tabular-nums-mono font-medium text-ink">
                      {almanac.moon.moonrise
                        ? formatClockInOffset(almanac.moon.moonrise, tzOffsetMin)
                        : '当日无'}
                    </span>
                  </div>
                  <div className="text-ink-muted">
                    月落{' '}
                    <span className="tabular-nums-mono font-medium text-ink">
                      {almanac.moon.moonset
                        ? formatClockInOffset(almanac.moon.moonset, tzOffsetMin)
                        : '当日无'}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* Galactic Center Card */}
            <section
              aria-label="银河银心可见窗口"
              className="rounded-[18px] border border-hairline bg-surface p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Orbit className="h-4 w-4 text-accent" aria-hidden="true" />
                  <h3 className="m-0 text-[15px] font-medium text-ink">银河银心窗口</h3>
                </div>
                <span className="tabular-nums-mono text-[11.5px] text-ink-muted">
                  仰角 &gt; 10° · 深暗夜空
                </span>
              </div>
              <p className="tabular-nums-mono mt-2 mb-0 text-[15px] font-medium text-ink">
                {gcWindowText}
              </p>
              <p className="mt-1.5 mb-0 text-[12.5px] leading-[1.55] text-ink-muted">
                {almanac.galacticCenter.note}
              </p>
            </section>
          </div>
        </div>

        {/* Right Column: Photography Windows + Full Tabular Schedule Table */}
        <div className="space-y-5">
          {/* Morning & Evening Photography Highlight Strip */}
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div className="rounded-[18px] border border-hairline bg-paper p-4">
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <Sunrise className="h-4 w-4 text-postmark" aria-hidden="true" />
                <span>晨间摄影光窗</span>
              </div>
              <dl className="mt-3 space-y-2 text-[13px]">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">蓝调时刻 (-6° ~ -4°)</dt>
                  <dd className="tabular-nums-mono m-0 font-medium text-accent">
                    {almanac.morningBlueLabel}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">黄金时刻 (-4° ~ +6°)</dt>
                  <dd className="tabular-nums-mono m-0 font-medium text-postmark">
                    {almanac.morningGoldenLabel}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2 border-t border-hairline pt-2">
                  <dt className="text-ink-muted">日出</dt>
                  <dd className="tabular-nums-mono m-0 font-medium text-ink">
                    {formatTime(almanac.sunrise)}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-[18px] border border-hairline bg-paper p-4">
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <Sunset className="h-4 w-4 text-postmark" aria-hidden="true" />
                <span>傍晚摄影光窗</span>
              </div>
              <dl className="mt-3 space-y-2 text-[13px]">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">黄金时刻 (+6° ~ -4°)</dt>
                  <dd className="tabular-nums-mono m-0 font-medium text-postmark">
                    {almanac.eveningGoldenLabel}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-ink-muted">蓝调时刻 (-4° ~ -6°)</dt>
                  <dd className="tabular-nums-mono m-0 font-medium text-accent">
                    {almanac.eveningBlueLabel}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2 border-t border-hairline pt-2">
                  <dt className="text-ink-muted">日落</dt>
                  <dd className="tabular-nums-mono m-0 font-medium text-ink">
                    {formatTime(almanac.sunset)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Complete Tabular-Nums Schedule Table */}
          <section
            aria-label="完整晨昏时刻表"
            className="overflow-hidden rounded-[20px] border border-hairline bg-surface"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-paper px-5 py-3.5">
              <div className="flex items-center gap-2">
                <Sun className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                <h3 className="m-0 text-[15px] font-medium text-ink">全天晨昏时刻表</h3>
              </div>
              <span className="tabular-nums-mono text-[12px] text-ink-muted">
                {dateYmd} · {formatUtcOffsetLabel(tzOffsetMin)}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[13.5px]">
                <thead>
                  <tr className="border-b border-hairline text-[12px] text-ink-muted">
                    <th scope="col" className="px-3.5 py-2.5 font-normal sm:px-5">
                      阶段
                    </th>
                    <th scope="col" className="px-2 py-2.5 font-normal sm:px-3">
                      太阳高度角
                    </th>
                    <th scope="col" className="px-3.5 py-2.5 text-right font-normal sm:px-5">
                      当地时间
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {scheduleRows.map((row) => {
                    const dotColor =
                      row.accent === 'blue'
                        ? SKY_BAND_COLORS.blue
                        : row.accent === 'golden'
                          ? SKY_BAND_COLORS.goldenHigh
                          : row.accent === 'sun'
                            ? SKY_BAND_COLORS.goldenLow
                            : SKY_BAND_COLORS.nautical;
                    return (
                      <tr
                        key={row.label}
                        className="border-b border-hairline last:border-b-0 hover:bg-paper/60"
                      >
                        <td className="px-3.5 py-2.5 text-ink sm:px-5">
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: dotColor }}
                            />
                            <span>{row.label}</span>
                          </span>
                        </td>
                        <td className="tabular-nums-mono px-2 py-2.5 text-[12.5px] text-ink-muted sm:px-3">
                          {row.angle}
                        </td>
                        <td className="tabular-nums-mono px-3.5 py-2.5 text-right font-medium text-ink sm:px-5">
                          {row.value}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Bottom Observatory Handoff Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-paper px-5 py-3.5 text-[13px]">
              <span className="text-ink-muted">
                推荐观星入场时刻：
                <strong className="tabular-nums-mono ml-1 font-medium text-ink">
                  {almanac.observatoryTimeLabel}
                </strong>
              </span>
              <a
                href={observatoryHref}
                onClick={handleOpenObservatory}
                className="inline-flex items-center gap-1.5 font-medium text-accent no-underline hover:underline"
              >
                <span>带此坐标与时刻前往观星台</span>
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
