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
import type { SkyTarget } from '../../lib/sky';

export type MoonPhaseName =
  | '新月'
  | '蛾眉月'
  | '上弦月'
  | '盈凸月'
  | '满月'
  | '亏凸月'
  | '下弦月'
  | '残月';

export interface MoonAlmanac {
  phaseAngle: number;
  illuminationPercent: number;
  phaseName: MoonPhaseName;
  altitude: number;
  azimuth: number;
  aboveHorizon: boolean;
  southernHemisphere: boolean;
}

export interface TwilightAlmanac {
  sunset: Date | null;
  astronomicalDusk: Date | null;
  sunsetLabel: string;
  astronomicalDuskLabel: string;
}

export interface VisiblePlanetInfo {
  id: string;
  name: string;
  english: string;
  altitude: number;
  azimuth: number;
  direction: string;
  magnitude: number;
  color: string;
  target: SkyTarget;
}

export interface SkyAlmanac {
  moon: MoonAlmanac;
  twilight: TwilightAlmanac;
  visiblePlanets: VisiblePlanetInfo[];
}

const NAKED_EYE_PLANETS: ReadonlyArray<{
  body: Body;
  id: string;
  name: string;
  english: string;
  color: string;
}> = [
  { body: Body.Mercury, id: 'NAME Mercury', name: '水星', english: 'Mercury', color: '#c4cdd0' },
  { body: Body.Venus, id: 'NAME Venus', name: '金星', english: 'Venus', color: '#efe7c2' },
  { body: Body.Mars, id: 'NAME Mars', name: '火星', english: 'Mars', color: '#e2a482' },
  { body: Body.Jupiter, id: 'NAME Jupiter', name: '木星', english: 'Jupiter', color: '#ebd4aa' },
  { body: Body.Saturn, id: 'NAME Saturn', name: '土星', english: 'Saturn', color: '#d6c68e' },
];

const COMPASS_LABELS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'] as const;

export function azimuthToCompass(azimuth: number): string {
  const normalized = ((azimuth % 360) + 360) % 360;
  return COMPASS_LABELS[Math.round(normalized / 45) % 8] ?? '北';
}

export function getMoonPhaseName(phaseAngleDeg: number): MoonPhaseName {
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

/**
 * Generates an SVG path for the illuminated portion of a lunar disk centered at (cx, cy) with radius r.
 * Returns null for a new moon (fully unlit).
 */
export function buildMoonLitSvgPath(
  phaseAngleDeg: number,
  cx: number,
  cy: number,
  r: number,
  southernHemisphere = false,
): string | null {
  const normalized = ((phaseAngleDeg % 360) + 360) % 360;
  const displayDeg = southernHemisphere ? (360 - normalized) % 360 : normalized;

  if (displayDeg < 2 || displayDeg > 358) {
    return null;
  }

  if (displayDeg > 178 && displayDeg < 182) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
  }

  const rad = (displayDeg * Math.PI) / 180;
  const rx = Math.abs(Math.cos(rad)) * r;

  if (displayDeg < 180) {
    // Waxing (right limb lit in northern hemisphere)
    const outerArc = `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r}`;
    if (rx < 0.05) {
      return `${outerArc} L ${cx} ${cy - r} Z`;
    }
    const terminatorSweep = displayDeg < 90 ? 0 : 1;
    return `${outerArc} A ${rx.toFixed(3)} ${r} 0 0 ${terminatorSweep} ${cx} ${cy - r} Z`;
  }

  // Waning (left limb lit in northern hemisphere)
  const outerArc = `M ${cx} ${cy - r} A ${r} ${r} 0 0 0 ${cx} ${cy + r}`;
  if (rx < 0.05) {
    return `${outerArc} L ${cx} ${cy - r} Z`;
  }
  const terminatorSweep = displayDeg < 270 ? 0 : 1;
  return `${outerArc} A ${rx.toFixed(3)} ${r} 0 0 ${terminatorSweep} ${cx} ${cy - r} Z`;
}

export function formatClockHHMM(date: Date | null): string {
  if (!date || !Number.isFinite(date.getTime())) return '—';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function computeSkyAlmanac(lat: number, lng: number, date: Date): SkyAlmanac {
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  const safeLat = Number.isFinite(lat) ? Math.max(-89.9, Math.min(89.9, lat)) : 39.9042;
  const safeLng = Number.isFinite(lng) ? Math.max(-180, Math.min(180, lng)) : 116.4074;
  const observer = new Observer(safeLat, safeLng, 0);

  // 1. Moon phase, illumination, and live topocentric position
  const phaseAngle = ((MoonPhase(safeDate) % 360) + 360) % 360;
  const moonIllum = Illumination(Body.Moon, safeDate);
  const illuminationPercent = Math.max(0, Math.min(100, Math.round(moonIllum.phase_fraction * 100)));
  const moonEq = Equator(Body.Moon, safeDate, observer, true, true);
  const moonHor = Horizon(safeDate, observer, moonEq.ra, moonEq.dec, 'normal');

  const moon: MoonAlmanac = {
    phaseAngle,
    illuminationPercent,
    phaseName: getMoonPhaseName(phaseAngle),
    altitude: moonHor.altitude,
    azimuth: moonHor.azimuth,
    aboveHorizon: moonHor.altitude > 0,
    southernHemisphere: safeLat < 0,
  };

  // 2. Evening sunset and astronomical twilight end (-18 deg solar altitude)
  let sunset: Date | null = null;
  let astronomicalDusk: Date | null = null;
  let sunsetLabel = '—';
  let astronomicalDuskLabel = '—';

  try {
    const noonEvent = SearchHourAngle(Body.Sun, observer, 0, safeDate, -1);
    const searchStart = noonEvent.time.date;
    const sunsetEvent = SearchRiseSet(Body.Sun, observer, -1, searchStart, 1);
    sunset = sunsetEvent ? sunsetEvent.date : null;

    const duskStart = sunset ?? searchStart;
    const duskEvent = SearchAltitude(Body.Sun, observer, -1, duskStart, 1, -18);
    astronomicalDusk = duskEvent ? duskEvent.date : null;

    if (sunset) {
      sunsetLabel = formatClockHHMM(sunset);
    } else {
      const sunEq = Equator(Body.Sun, searchStart, observer, true, true);
      const sunHor = Horizon(searchStart, observer, sunEq.ra, sunEq.dec, 'normal');
      sunsetLabel = sunHor.altitude > 0 ? '极昼无日落' : '极夜无日出';
    }

    if (astronomicalDusk) {
      astronomicalDuskLabel = formatClockHHMM(astronomicalDusk);
    } else {
      const midnightApprox = new Date(searchStart.getTime() + 12 * 3600_000);
      const midSunEq = Equator(Body.Sun, midnightApprox, observer, true, true);
      const midSunHor = Horizon(midnightApprox, observer, midSunEq.ra, midSunEq.dec, 'normal');
      astronomicalDuskLabel = midSunHor.altitude > -18 ? '白夜（未达 -18°）' : '全夜深暗';
    }
  } catch {
    sunsetLabel = '—';
    astronomicalDuskLabel = '—';
  }

  // 3. Naked-eye planets currently above the horizon
  const visiblePlanets: VisiblePlanetInfo[] = [];
  for (const planet of NAKED_EYE_PLANETS) {
    const eq = Equator(planet.body, safeDate, observer, true, true);
    const hor = Horizon(safeDate, observer, eq.ra, eq.dec, 'normal');
    if (hor.altitude > 0) {
      const illum = Illumination(planet.body, safeDate);
      visiblePlanets.push({
        id: planet.id,
        name: planet.name,
        english: planet.english,
        altitude: hor.altitude,
        azimuth: hor.azimuth,
        direction: azimuthToCompass(hor.azimuth),
        magnitude: illum.mag,
        color: planet.color,
        target: {
          id: planet.id,
          name: planet.name,
          english: planet.english,
          kind: '行星',
        },
      });
    }
  }

  visiblePlanets.sort((a, b) => a.magnitude - b.magnitude);

  return {
    moon,
    twilight: {
      sunset,
      astronomicalDusk,
      sunsetLabel,
      astronomicalDuskLabel,
    },
    visiblePlanets,
  };
}
