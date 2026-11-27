import {
  Body,
  Equator,
  EquatorFromVector,
  Horizon,
  Observer,
  RotateVector,
  Rotation_EQJ_EQD,
  Spherical,
  VectorFromSphere,
} from 'astronomy-engine';
import { formatDay } from '../../../shared/dates';
import { CHINESE_STARS, loadCatalog } from '../../lib/bright-star-catalog';
import { computeSkyAlmanac } from './sky-almanac';

export interface SkyPostcardOptions {
  lat: number;
  lng: number;
  date: Date;
  place: string;
  displayDate?: string;
  displayClock?: string;
}

const POSTCARD_WIDTH = 1200;
const POSTCARD_HEIGHT = 1600;

const CONSTELLATION_ASTERISMS: ReadonlyArray<ReadonlyArray<[string, string]>> = [
  // Big Dipper (Ursa Major)
  [
    ['Dubhe', 'Merak'],
    ['Merak', 'Phecda'],
    ['Phecda', 'Megrez'],
    ['Megrez', 'Dubhe'],
    ['Megrez', 'Alioth'],
    ['Alioth', 'Mizar'],
    ['Mizar', 'Alkaid'],
  ],
  // Orion
  [
    ['Betelgeuse', 'Bellatrix'],
    ['Betelgeuse', 'Alnitak'],
    ['Bellatrix', 'Mintaka'],
    ['Mintaka', 'Alnilam'],
    ['Alnilam', 'Alnitak'],
    ['Alnitak', 'Saiph'],
    ['Mintaka', 'Rigel'],
    ['Rigel', 'Saiph'],
  ],
  // Cassiopeia
  [
    ['Caph', 'Schedar'],
    ['Schedar', 'Cih'],
    ['Cih', 'Ruchbah'],
    ['Ruchbah', 'Segin'],
  ],
  // Cygnus
  [
    ['Deneb', 'Sadr'],
    ['Sadr', 'Albireo'],
    ['Aljanah', 'Sadr'],
    ['Sadr', 'Fawaris'],
  ],
  // Summer Triangle
  [
    ['Vega', 'Deneb'],
    ['Deneb', 'Altair'],
    ['Altair', 'Vega'],
  ],
  // Scorpius
  [
    ['Acrab', 'Dschubba'],
    ['Dschubba', 'Antares'],
    ['Antares', 'Sargas'],
    ['Sargas', 'Shaula'],
  ],
  // Southern Cross (Crux)
  [
    ['Acrux', 'Gacrux'],
    ['Mimosa', 'Imai'],
  ],
];

const WARM_STARS = new Set(['Betelgeuse', 'Antares', 'Aldebaran', 'Arcturus', 'Pollux', 'Dubhe']);
const COOL_STARS = new Set(['Sirius', 'Rigel', 'Vega', 'Spica', 'Altair', 'Deneb', 'Bellatrix', 'Acrux']);

const PLANET_MARKERS: ReadonlyArray<{ body: Body; name: string; color: string; radius: number }> = [
  { body: Body.Moon, name: '月亮', color: '#f5efe0', radius: 7.5 },
  { body: Body.Venus, name: '金星', color: '#f2ebc6', radius: 5.5 },
  { body: Body.Jupiter, name: '木星', color: '#ebd4aa', radius: 5.2 },
  { body: Body.Mars, name: '火星', color: '#e2a482', radius: 4.8 },
  { body: Body.Saturn, name: '土星', color: '#d8c891', radius: 4.8 },
  { body: Body.Mercury, name: '水星', color: '#c4cdd0', radius: 4.0 },
];

function formatCoordLine(lat: number, lng: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}  /  ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;
}

function drawMoonPhaseOnCanvas(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  phaseAngleDeg: number,
  southernHemisphere: boolean,
): void {
  const normalized = ((phaseAngleDeg % 360) + 360) % 360;
  const displayDeg = southernHemisphere ? (360 - normalized) % 360 : normalized;

  ctx.save();
  // Base dark disk
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#1d2027';
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(31, 31, 31, 0.25)';
  ctx.stroke();

  if (displayDeg >= 2 && displayDeg <= 358) {
    ctx.beginPath();
    ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
    ctx.clip();

    if (displayDeg > 178 && displayDeg < 182) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#efe5c8';
      ctx.fill();
    } else {
      const waxing = displayDeg < 180;
      const rad = (displayDeg * Math.PI) / 180;
      const cosA = Math.cos(rad);
      const rx = Math.abs(cosA) * r;

      ctx.beginPath();
      if (waxing) {
        ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);
        const steps = 48;
        for (let i = 0; i <= steps; i += 1) {
          const theta = Math.PI / 2 - (i / steps) * Math.PI;
          const xSign = displayDeg < 90 ? 1 : -1;
          const x = cx + xSign * rx * Math.cos(theta);
          const y = cy + r * Math.sin(theta);
          ctx.lineTo(x, y);
        }
      } else {
        ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, true);
        const steps = 48;
        for (let i = 0; i <= steps; i += 1) {
          const theta = Math.PI / 2 - (i / steps) * Math.PI;
          const xSign = displayDeg < 270 ? 1 : -1;
          const x = cx + xSign * rx * Math.cos(theta);
          const y = cy + r * Math.sin(theta);
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.fillStyle = '#efe5c8';
      ctx.fill();
    }
  }
  ctx.restore();
}

export async function renderSkyPostcardBlob(options: SkyPostcardOptions): Promise<Blob> {
  if (typeof document === 'undefined') {
    throw new Error('明信片渲染仅支持浏览器环境。');
  }

  const catalog = await loadCatalog();
  const safeDate = Number.isFinite(options.date.getTime()) ? options.date : new Date();
  const safeLat = Number.isFinite(options.lat) ? options.lat : 39.9042;
  const safeLng = Number.isFinite(options.lng) ? options.lng : 116.4074;
  const almanac = computeSkyAlmanac(safeLat, safeLng, safeDate);

  const canvas = document.createElement('canvas');
  canvas.width = POSTCARD_WIDTH;
  canvas.height = POSTCARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法初始化明信片画布。');
  }

  const sansStack = "'Inter', 'Noto Sans SC', 'PingFang SC', ui-sans-serif, system-ui, sans-serif";
  const serifStack = "'Noto Serif SC', 'Songti SC', Georgia, serif";
  const monoStack = "'JetBrains Mono', ui-monospace, Consolas, monospace";

  // 1. Bone-white archival stationery background
  ctx.fillStyle = '#FAF8F4';
  ctx.fillRect(0, 0, POSTCARD_WIDTH, POSTCARD_HEIGHT);

  // Subtle archival frame border
  ctx.strokeStyle = 'rgba(31, 31, 31, 0.12)';
  ctx.lineWidth = 2;
  ctx.strokeRect(42, 42, POSTCARD_WIDTH - 84, POSTCARD_HEIGHT - 84);
  ctx.strokeStyle = 'rgba(154, 91, 66, 0.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(52, 52, POSTCARD_WIDTH - 104, POSTCARD_HEIGHT - 104);

  // 2. Top archival masthead
  const dateLabel =
    options.displayDate ||
    formatDay(
      `${safeDate.getFullYear()}-${String(safeDate.getMonth() + 1).padStart(2, '0')}-${String(safeDate.getDate()).padStart(2, '0')}`,
    );
  const clockLabel =
    options.displayClock ||
    `${String(safeDate.getHours()).padStart(2, '0')}:${String(safeDate.getMinutes()).padStart(2, '0')}`;

  ctx.fillStyle = '#9A5B42';
  ctx.font = `500 22px ${sansStack}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('旅途手记 · 观星台', 88, 122);

  ctx.fillStyle = '#5F6368';
  ctx.font = `400 22px ${monoStack}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${dateLabel}  ${clockLabel}`, POSTCARD_WIDTH - 88, 122);

  ctx.beginPath();
  ctx.moveTo(88, 146);
  ctx.lineTo(POSTCARD_WIDTH - 88, 146);
  ctx.strokeStyle = 'rgba(31, 31, 31, 0.1)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 3. Centerpiece Deep-Space #0B0C0E zenith sky dome
  const cx = POSTCARD_WIDTH / 2;
  const cy = 678;
  const radius = 438;

  const project = (azimuth: number, altitude: number) => {
    const rad = (azimuth * Math.PI) / 180;
    const r = ((90 - altitude) / 90) * radius;
    return {
      x: cx - Math.sin(rad) * r,
      y: cy - Math.cos(rad) * r,
    };
  };

  // Outer bezel degree ticks
  ctx.save();
  for (let deg = 0; deg < 360; deg += 5) {
    const rad = (deg * Math.PI) / 180;
    const major = deg % 90 === 0;
    const medium = deg % 30 === 0;
    const inner = radius + 6;
    const outer = radius + (major ? 22 : medium ? 15 : 10);
    ctx.beginPath();
    ctx.moveTo(cx - Math.sin(rad) * inner, cy - Math.cos(rad) * inner);
    ctx.lineTo(cx - Math.sin(rad) * outer, cy - Math.cos(rad) * outer);
    ctx.strokeStyle = major ? 'rgba(154, 91, 66, 0.65)' : 'rgba(31, 31, 31, 0.22)';
    ctx.lineWidth = major ? 2 : 1;
    ctx.stroke();
  }
  ctx.restore();

  // Deep-space circular fill
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  const skyGrad = ctx.createRadialGradient(cx, cy, 12, cx, cy, radius);
  skyGrad.addColorStop(0, '#161b26');
  skyGrad.addColorStop(0.68, '#0f1218');
  skyGrad.addColorStop(1, '#0b0c0e');
  ctx.fillStyle = skyGrad;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(31, 31, 31, 0.35)';
  ctx.stroke();

  // Clip interior sky layers
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
  ctx.clip();

  // Altitude guide rings (30°, 60°)
  ctx.save();
  ctx.setLineDash([5, 9]);
  ctx.strokeStyle = 'rgba(227, 227, 227, 0.14)';
  ctx.lineWidth = 1.2;
  for (const alt of [30, 60]) {
    const rr = ((90 - alt) / 90) * radius;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Azimuth spokes
  ctx.strokeStyle = 'rgba(227, 227, 227, 0.08)';
  ctx.lineWidth = 1;
  for (let az = 0; az < 360; az += 45) {
    const p = project(az, 0);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  // Compute star horizontal coordinates via astronomy-engine
  const observer = new Observer(safeLat, safeLng, 0);
  const rotMatrix = Rotation_EQJ_EQD(safeDate);
  const projectedByName = new Map<string, { x: number; y: number; alt: number; mag: number }>();

  interface StarDot {
    rawName: string;
    label: string | null;
    x: number;
    y: number;
    alt: number;
    mag: number;
  }
  const visibleStars: StarDot[] = [];

  for (const [rawName, ra, dec, magnitude] of catalog) {
    const eq = EquatorFromVector(
      RotateVector(rotMatrix, VectorFromSphere(new Spherical(dec, ra * 15, 1), safeDate)),
    );
    const hor = Horizon(safeDate, observer, eq.ra, eq.dec, 'normal');
    if (hor.altitude < 0) continue;
    const pt = project(hor.azimuth, hor.altitude);
    projectedByName.set(rawName, { x: pt.x, y: pt.y, alt: hor.altitude, mag: magnitude });
    visibleStars.push({
      rawName,
      label: CHINESE_STARS[rawName] ?? null,
      x: pt.x,
      y: pt.y,
      alt: hor.altitude,
      mag: magnitude,
    });
  }

  // Subtle constellation asterism lines
  ctx.save();
  ctx.strokeStyle = 'rgba(138, 180, 248, 0.28)';
  ctx.lineWidth = 1.25;
  for (const segments of CONSTELLATION_ASTERISMS) {
    for (const [aName, bName] of segments) {
      const a = projectedByName.get(aName);
      const b = projectedByName.get(bName);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Render stars
  const labeledBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  const canPlaceLabel = (x: number, y: number, w: number, h: number) => {
    const distFromCenter = Math.hypot(x + w / 2 - cx, y - cy);
    if (distFromCenter > radius - 36) return false;
    return !labeledBoxes.some(
      (b) => x < b.x + b.w + 8 && x + w + 8 > b.x && y - h < b.y + 4 && y + 4 > b.y - b.h,
    );
  };

  for (const star of visibleStars) {
    const starRadius = Math.max(1.05, 4.1 - star.mag * 0.62);
    const alpha = Math.max(0.32, Math.min(1, 1.05 - star.mag * 0.13));
    const fillColor = WARM_STARS.has(star.rawName)
      ? '#f7dec1'
      : COOL_STARS.has(star.rawName)
        ? '#dce9ff'
        : '#eef2f6';

    if (star.mag < 1.35) {
      const glow = ctx.createRadialGradient(star.x, star.y, 0.5, star.x, star.y, starRadius * 3.8);
      glow.addColorStop(0, `rgba(220, 233, 255, ${(alpha * 0.42).toFixed(2)})`);
      glow.addColorStop(1, 'rgba(220, 233, 255, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(star.x, star.y, starRadius * 3.8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.arc(star.x, star.y, starRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Labels for brightest Chinese-named stars
  ctx.font = `400 15px ${sansStack}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const labelCandidates = visibleStars
    .filter((s) => s.label && s.mag < 2.1)
    .sort((a, b) => a.mag - b.mag);
  for (const star of labelCandidates) {
    if (!star.label) continue;
    const lx = star.x + 9;
    const ly = star.y;
    const textW = ctx.measureText(star.label).width;
    if (canPlaceLabel(lx, ly, textW, 18)) {
      ctx.fillStyle = 'rgba(202, 212, 224, 0.82)';
      ctx.fillText(star.label, lx, ly);
      labeledBoxes.push({ x: lx, y: ly, w: textW, h: 18 });
    }
  }

  // Visible solar system bodies (Moon & naked-eye planets)
  for (const item of PLANET_MARKERS) {
    const eq = Equator(item.body, safeDate, observer, true, true);
    const hor = Horizon(safeDate, observer, eq.ra, eq.dec, 'normal');
    if (hor.altitude <= 0) continue;
    const pt = project(hor.azimuth, hor.altitude);

    ctx.save();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, item.radius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(235, 212, 170, 0.35)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pt.x, pt.y, item.radius, 0, Math.PI * 2);
    ctx.fillStyle = item.color;
    ctx.fill();

    ctx.font = `500 16px ${sansStack}`;
    ctx.fillStyle = item.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.name, pt.x + item.radius + 8, pt.y);
    ctx.restore();
  }

  // Zenith subtle crosshair
  ctx.strokeStyle = 'rgba(138, 180, 248, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy);
  ctx.lineTo(cx + 7, cy);
  ctx.moveTo(cx, cy - 7);
  ctx.lineTo(cx, cy + 7);
  ctx.stroke();

  ctx.restore(); // End sky circle clip

  // Cardinal compass labels outside dome
  const cardinals: ReadonlyArray<{ az: number; label: string; highlight?: boolean }> = [
    { az: 0, label: 'N 北', highlight: true },
    { az: 90, label: 'E 东' },
    { az: 180, label: 'S 南' },
    { az: 270, label: 'W 西' },
  ];
  ctx.font = `500 21px ${sansStack}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const c of cardinals) {
    const rad = (c.az * Math.PI) / 180;
    const tx = cx - Math.sin(rad) * (radius + 44);
    const ty = cy - Math.cos(rad) * (radius + 44);
    ctx.fillStyle = c.highlight ? '#9A5B42' : '#5F6368';
    ctx.fillText(c.label, tx, ty);
  }

  // 4. Bottom editorial colophon on bone-white paper
  const footerTop = 1218;
  ctx.beginPath();
  ctx.moveTo(88, footerTop);
  ctx.lineTo(POSTCARD_WIDTH - 88, footerTop);
  ctx.strokeStyle = 'rgba(31, 31, 31, 0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const placeText = (options.place || '观测点').trim().slice(0, 24);
  ctx.fillStyle = '#1F1F1F';
  ctx.font = `500 44px ${sansStack}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(placeText, 88, footerTop + 76);

  ctx.fillStyle = '#5F6368';
  ctx.font = `400 22px ${monoStack}`;
  ctx.fillText(formatCoordLine(safeLat, safeLng), 88, footerTop + 122);

  const planetSummary =
    almanac.visiblePlanets.length > 0
      ? `可见行星：${almanac.visiblePlanets.map((p) => p.name).join('、')}`
      : '此刻五大肉眼行星均位于地平线下';
  ctx.fillStyle = '#5F6368';
  ctx.font = `400 20px ${serifStack}`;
  ctx.fillText(
    `日落 ${almanac.twilight.sunsetLabel} · 天文入夜 ${almanac.twilight.astronomicalDuskLabel}`,
    88,
    footerTop + 172,
  );
  ctx.fillText(planetSummary, 88, footerTop + 208);

  // Right side: Moon phase medallion & stats
  const moonCenterX = POSTCARD_WIDTH - 134;
  const moonCenterY = footerTop + 88;
  drawMoonPhaseOnCanvas(
    ctx,
    moonCenterX,
    moonCenterY,
    38,
    almanac.moon.phaseAngle,
    almanac.moon.southernHemisphere,
  );

  ctx.fillStyle = '#1F1F1F';
  ctx.font = `500 24px ${sansStack}`;
  ctx.textAlign = 'right';
  ctx.fillText(almanac.moon.phaseName, moonCenterX - 58, moonCenterY - 4);

  ctx.fillStyle = '#9A5B42';
  ctx.font = `400 19px ${monoStack}`;
  ctx.fillText(`月面照度 ${almanac.moon.illuminationPercent}%`, moonCenterX - 58, moonCenterY + 26);

  // Quiet bottom archival colophon
  ctx.beginPath();
  ctx.moveTo(88, 1482);
  ctx.lineTo(POSTCARD_WIDTH - 88, 1482);
  ctx.strokeStyle = 'rgba(31, 31, 31, 0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = '#5F6368';
  ctx.font = `400 17px ${sansStack}`;
  ctx.textAlign = 'left';
  ctx.fillText('当夜天顶星图 · 仰望方位投影', 88, 1522);

  ctx.textAlign = 'right';
  ctx.font = `400 17px ${monoStack}`;
  ctx.fillText('本地星历推演 · 1200×1600', POSTCARD_WIDTH - 88, 1522);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('无法导出 PNG 图像。'));
      }
    }, 'image/png');
  });
}

export async function downloadSkyPostcard(options: SkyPostcardOptions): Promise<string> {
  const blob = await renderSkyPostcardBlob(options);
  const datePart = (options.displayDate || formatDay(options.date.toISOString())).replaceAll('.', '-');
  const placePart = (options.place || 'sky')
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const filename = `starry-postcard-${datePart || 'night'}-${placePart || 'sky'}.png`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}
