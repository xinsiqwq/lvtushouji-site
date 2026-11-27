import type { Vec3 } from 'ogl';

export type PlanetId =
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune';

export type PlanetPortal = {
  /** 目标站内路由，例如 '/atlas'、'/observatory' 或 '/explore/mars' */
  href: string;
  /** 悬停徽标与无障碍标签展示的去向名称 */
  label: string;
  /** 是否为「敬请期待」占位页；接入新功能页面时将 href 改为目标路由并置为 false 即可 */
  placeholder: boolean;
};

export type SolarPlanetSpec = {
  id: PlanetId;
  nameZh: string;
  nameEn: string;
  auLabel: string;
  orbitR: number;
  radius: number;
  initialAngle: number;
  orbitSpeed: number;
  spinSpeed: number;
  axialTilt: number;
  orbitInclination: number;
  eccentricity: number;
  hitScale: number;
  shaderKind: number;
  /** 电影感俯冲跳转时末尾大气溶解过渡色调（RGB） */
  warpTint: string;
  hasMoon?: boolean;
  hasRings?: boolean;
  ringInner?: number;
  ringOuter?: number;
  hasThinRing?: boolean;
  portal: PlanetPortal;
};

/**
 * 太阳系八大行星注册表与路由映射入口（Solar System Interactive Registry）
 * ------------------------------------------------------------------------
 * 已开放核心页面：
 * - 水星 (mercury) -> '/toolkit'       （实用工具台）
 * - 金星 (venus)   -> '/gallery'       （暗房影集）
 * - 地球 (earth)   -> '/atlas'         （旅图）
 * - 火星 (mars)    -> '/arcade'        （游乐竞技场）
 * - 木星 (jupiter) -> '/projects'      （作品展柜）
 * - 土星 (saturn)  -> '/observatory'   （观星台）
 * - 海王星 (neptune) -> '/vault'       （文件密匣）
 *
 * 观测活页行星：
 * - 天王星 (uranus)  -> '/explore/uranus'  （实时星历）
 */
export const SOLAR_PLANETS: readonly SolarPlanetSpec[] = [
  {
    id: 'mercury',
    nameZh: '水星',
    nameEn: 'Mercury',
    auLabel: '0.39 AU',
    orbitR: 2.6,
    radius: 0.17,
    initialAngle: 0.62,
    orbitSpeed: 0.13,
    spinSpeed: 0.08,
    axialTilt: 0.03,
    orbitInclination: 0.06,
    eccentricity: 0.12,
    hitScale: 2.5,
    shaderKind: 0,
    warpTint: '#9ea3ad',
    portal: { href: '/toolkit', label: '实用工具台', placeholder: false },
  },
  {
    id: 'venus',
    nameZh: '金星',
    nameEn: 'Venus',
    auLabel: '0.72 AU',
    orbitR: 3.85,
    radius: 0.30,
    initialAngle: -0.18,
    orbitSpeed: 0.092,
    spinSpeed: -0.05,
    axialTilt: 0.05,
    orbitInclination: 0.035,
    eccentricity: 0.01,
    hitScale: 1.9,
    shaderKind: 1,
    warpTint: '#e7c188',
    portal: { href: '/gallery', label: '暗房影集', placeholder: false },
  },
  {
    id: 'earth',
    nameZh: '地球',
    nameEn: 'Earth',
    auLabel: '1.00 AU',
    orbitR: 5.5,
    radius: 0.44,
    initialAngle: 0.14,
    orbitSpeed: 0.066,
    spinSpeed: 0.24,
    axialTilt: 0.41,
    orbitInclination: 0.0,
    eccentricity: 0.017,
    hitScale: 1.65,
    shaderKind: 2,
    warpTint: '#4f92f2',
    hasMoon: true,
    portal: { href: '/atlas', label: '旅图', placeholder: false },
  },
  {
    id: 'mars',
    nameZh: '火星',
    nameEn: 'Mars',
    auLabel: '1.52 AU',
    orbitR: 7.2,
    radius: 0.34,
    initialAngle: 0.36,
    orbitSpeed: 0.048,
    spinSpeed: 0.22,
    axialTilt: 0.44,
    orbitInclination: -0.028,
    eccentricity: 0.07,
    hitScale: 1.85,
    shaderKind: 3,
    warpTint: '#c96a48',
    portal: { href: '/arcade', label: '游乐竞技场', placeholder: false },
  },
  {
    id: 'jupiter',
    nameZh: '木星',
    nameEn: 'Jupiter',
    auLabel: '5.20 AU',
    orbitR: 10.6,
    radius: 1.06,
    initialAngle: 0.48,
    orbitSpeed: 0.023,
    spinSpeed: 0.36,
    axialTilt: 0.055,
    orbitInclination: 0.02,
    eccentricity: 0.045,
    hitScale: 1.25,
    shaderKind: 4,
    warpTint: '#d6a477',
    portal: { href: '/projects', label: '作品展柜', placeholder: false },
  },
  {
    id: 'saturn',
    nameZh: '土星',
    nameEn: 'Saturn',
    auLabel: '9.54 AU',
    orbitR: 14.0,
    radius: 0.94,
    initialAngle: 0.80,
    orbitSpeed: 0.016,
    spinSpeed: 0.32,
    axialTilt: 0.466,
    orbitInclination: -0.036,
    eccentricity: 0.05,
    hitScale: 1.38,
    shaderKind: 5,
    warpTint: '#e3cc9d',
    hasRings: true,
    ringInner: 1.26,
    ringOuter: 2.52,
    portal: { href: '/observatory', label: '观星台', placeholder: false },
  },
  {
    id: 'uranus',
    nameZh: '天王星',
    nameEn: 'Uranus',
    auLabel: '19.2 AU',
    orbitR: 17.2,
    radius: 0.56,
    initialAngle: -0.44,
    orbitSpeed: 0.011,
    spinSpeed: -0.24,
    axialTilt: 1.706,
    orbitInclination: 0.025,
    eccentricity: 0.04,
    hitScale: 1.55,
    shaderKind: 6,
    warpTint: '#8ad4e0',
    hasThinRing: true,
    ringInner: 1.38,
    ringOuter: 1.66,
    portal: { href: '/explore/uranus', label: '实时星历', placeholder: true },
  },
  {
    id: 'neptune',
    nameZh: '海王星',
    nameEn: 'Neptune',
    auLabel: '30.1 AU',
    orbitR: 19.8,
    radius: 0.54,
    initialAngle: -0.26,
    orbitSpeed: 0.008,
    spinSpeed: 0.25,
    axialTilt: 0.494,
    orbitInclination: -0.03,
    eccentricity: 0.01,
    hitScale: 1.6,
    shaderKind: 7,
    warpTint: '#416ce1',
    portal: { href: '/vault', label: '文件密匣', placeholder: false },
  },
];

export function findPlanetById(id: string): SolarPlanetSpec | undefined {
  return SOLAR_PLANETS.find((planet) => planet.id === id);
}

/** Evaluate 3D Keplerian elliptical orbit coordinate at angle theta (radians). */
export function evaluateOrbitPoint(
  planet: SolarPlanetSpec,
  theta: number,
  out: Vec3,
): Vec3 {
  const a = planet.orbitR;
  const e = planet.eccentricity;
  const b = a * Math.sqrt(Math.max(0.2, 1 - e * e));
  const x = a * (Math.cos(theta) - e);
  const z = b * Math.sin(theta);
  const cosI = Math.cos(planet.orbitInclination);
  const sinI = Math.sin(planet.orbitInclination);
  out.set(x * cosI, x * sinI, z);
  return out;
}

export function computePlanetPosition(
  planet: SolarPlanetSpec,
  elapsed: number,
  out: Vec3,
): Vec3 {
  const theta = planet.initialAngle + elapsed * planet.orbitSpeed;
  return evaluateOrbitPoint(planet, theta, out);
}
