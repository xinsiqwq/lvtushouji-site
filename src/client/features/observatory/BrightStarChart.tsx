import { useEffect, useMemo, useState } from 'react';
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
import {
  CHINESE_STARS,
  isNamedStar,
  loadCatalog,
  type CatalogStar,
} from '../../lib/bright-star-catalog';

const solarBodies = [
  { body: Body.Sun, name: '太阳', color: '#ffe4a0' },
  { body: Body.Moon, name: '月亮', color: '#f5f2df' },
  { body: Body.Mercury, name: '水星', color: '#c0caca' },
  { body: Body.Venus, name: '金星', color: '#e7e2bc' },
  { body: Body.Mars, name: '火星', color: '#e2a482' },
  { body: Body.Jupiter, name: '木星', color: '#ead2a8' },
  { body: Body.Saturn, name: '土星', color: '#d3c48b' },
  { body: Body.Uranus, name: '天王星', color: '#a9dddd' },
  { body: Body.Neptune, name: '海王星', color: '#9babdf' },
];

type SkyPoint = {
  name: string;
  azimuth: number;
  altitude: number;
  magnitude: number;
  color: string;
  planet: boolean;
  hasProperName: boolean;
};

type BrightStarChartProps = {
  lat: number;
  lng: number;
  date: Date;
  place: string;
};

export default function BrightStarChart({ lat, lng, date, place }: BrightStarChartProps) {
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<SkyPoint | null>(null);
  const [catalog, setCatalog] = useState<CatalogStar[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    loadCatalog().then(
      (stars) => {
        if (!disposed) setCatalog(stars);
      },
      () => {
        if (!disposed) setError('简版星表暂时无法加载。');
      },
    );
    return () => {
      disposed = true;
    };
  }, []);

  const sky = useMemo(() => {
    if (!Number.isFinite(date.getTime())) return [];
    const observer = new Observer(lat, lng, 0);
    const rotationMatrix = Rotation_EQJ_EQD(date);

    const stars: SkyPoint[] = catalog.map(([name, ra, dec, magnitude]) => {
      const eq = EquatorFromVector(
        RotateVector(rotationMatrix, VectorFromSphere(new Spherical(dec, ra * 15, 1), date)),
      );
      const h = Horizon(date, observer, eq.ra, eq.dec, 'normal');
      const chineseName = CHINESE_STARS[name];
      return {
        name: chineseName || name,
        azimuth: h.azimuth,
        altitude: h.altitude,
        magnitude,
        color: '#edf2ed',
        planet: false,
        hasProperName: Boolean(chineseName) || isNamedStar(name),
      };
    });

    for (const { body, name, color } of solarBodies) {
      const eq = Equator(body, date, observer, true, true);
      const h = Horizon(date, observer, eq.ra, eq.dec, 'normal');
      stars.push({
        name,
        azimuth: h.azimuth,
        altitude: h.altitude,
        magnitude: body === Body.Sun ? -26.7 : body === Body.Moon ? -12 : 0,
        color,
        planet: true,
        hasProperName: true,
      });
    }
    return stars;
  }, [catalog, date, lat, lng]);

  const above = useMemo(
    () => sky.filter((p) => p.altitude >= 0).sort((a, b) => a.magnitude - b.magnitude),
    [sky],
  );
  const currentSelected = selected
    ? above.find((p) => p.name === selected.name && p.planet === selected.planet) || selected
    : null;

  const project = (azimuth: number, altitude: number) => {
    const angle = ((azimuth - rotation) * Math.PI) / 180;
    const radius = ((90 - altitude) / 90) * 270 * zoom;
    return { x: 320 - Math.sin(angle) * radius, y: 320 - Math.cos(angle) * radius };
  };

  return (
    <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col items-center">
        {error ? (
          <p role="alert" className="py-12 text-[14px] text-ink-muted">
            {error}
          </p>
        ) : (
          <svg
            viewBox="0 0 640 640"
            role="img"
            aria-label="当前地点与时间的可见亮星方位图"
            className="h-auto w-full max-w-[560px]"
          >
            <defs>
              <clipPath id="bright-sky-circle">
                <circle cx="320" cy="320" r="270" />
              </clipPath>
              <radialGradient id="bright-sky-shade">
                <stop offset="0%" stopColor="#141820" />
                <stop offset="100%" stopColor="#0b0c0e" />
              </radialGradient>
            </defs>

            <circle
              cx="320"
              cy="320"
              r="270"
              fill="url(#bright-sky-shade)"
              stroke="rgba(227,227,227,0.22)"
            />

            <g clipPath="url(#bright-sky-circle)">
              {[30, 60].map((alt) => (
                <circle
                  key={alt}
                  cx="320"
                  cy="320"
                  r={((90 - alt) / 90) * 270 * zoom}
                  fill="none"
                  stroke="rgba(227,227,227,0.12)"
                  strokeDasharray="3 6"
                />
              ))}
              {[0, 45, 90, 135, 180, 225, 270, 315].map((az) => {
                const p = project(az, 0);
                return (
                  <line
                    key={az}
                    x1="320"
                    y1="320"
                    x2={p.x}
                    y2={p.y}
                    stroke="rgba(227,227,227,0.08)"
                  />
                );
              })}

              {above
                .filter((p) => p.altitude >= 90 - 90 / zoom)
                .map((p, i) => {
                  const pt = project(p.azimuth, p.altitude);
                  const r = p.planet
                    ? p.name === '太阳' || p.name === '月亮'
                      ? 6.5
                      : 3.8
                    : Math.max(0.9, 3.1 - p.magnitude * 0.45);
                  return (
                    <g
                      key={`${p.name}-${i}`}
                      onClick={() => setSelected(p)}
                      className="cursor-pointer"
                    >
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={r}
                        fill={p.color}
                        opacity={p.planet ? 1 : Math.max(0.42, 1 - p.magnitude * 0.1)}
                      />
                      <circle cx={pt.x} cy={pt.y} r="10" fill="transparent" />
                      <title>
                        {p.name} · 高度 {p.altitude.toFixed(1)}° · 方位 {p.azimuth.toFixed(1)}°
                      </title>
                      {(p.planet || (p.magnitude < 1.5 && p.hasProperName)) && (
                        <text
                          x={pt.x + 8}
                          y={pt.y + 4}
                          fill={p.planet ? p.color : '#9aa0a6'}
                          fontSize="10"
                        >
                          {p.name}
                        </text>
                      )}
                    </g>
                  );
                })}
              <text x="320" y="312" textAnchor="middle" fill="#8ab4f8" fontSize="11">
                天顶
              </text>
              <circle cx="320" cy="320" r="2" fill="#8ab4f8" />
            </g>

            {[
              { a: 0, n: '北 N' },
              { a: 90, n: '东 E' },
              { a: 180, n: '南 S' },
              { a: 270, n: '西 W' },
            ].map(({ a, n }) => {
              const angle = ((a - rotation) * Math.PI) / 180;
              return (
                <text
                  key={a}
                  x={320 - Math.sin(angle) * 294}
                  y={325 - Math.cos(angle) * 294}
                  textAnchor="middle"
                  fill={a === 0 ? '#d69f87' : '#9aa0a6'}
                  fontSize="13"
                >
                  {n}
                </text>
              );
            })}
          </svg>
        )}
        <p className="mt-2 mb-0 text-[12px] text-ink-muted">
          {place} · 仰望方位投影（外圈为地平线）
        </p>
      </div>

      <aside className="flex flex-col gap-4 rounded-[20px] bg-surface p-5">
        <div>
          <label htmlFor="bright-rotation" className="block text-[12.5px] text-ink-muted">
            旋转方位角度：<span className="tabular-nums-mono text-ink">{rotation}°</span>
          </label>
          <input
            id="bright-rotation"
            type="range"
            min={0}
            max={360}
            step={5}
            value={rotation}
            aria-label="旋转方位角度"
            onChange={(e) => setRotation(Number(e.target.value))}
            className="mt-1.5 w-full accent-accent"
          />
        </div>

        <div>
          <label htmlFor="bright-zoom" className="block text-[12.5px] text-ink-muted">
            天顶放大倍数：<span className="tabular-nums-mono text-ink">{zoom.toFixed(1)}×</span>
          </label>
          <input
            id="bright-zoom"
            type="range"
            min={1}
            max={2.5}
            step={0.1}
            value={zoom}
            aria-label="天顶放大缩放倍数"
            onChange={(e) => setZoom(Number(e.target.value))}
            className="mt-1.5 w-full accent-accent"
          />
        </div>

        <div aria-live="polite" className="rounded-[14px] bg-page/70 p-3.5 text-[13px]">
          {currentSelected ? (
            <>
              <div className="font-medium text-ink">{currentSelected.name}</div>
              <div className="tabular-nums-mono mt-1 text-[12px] text-ink-muted">
                高度 {currentSelected.altitude.toFixed(1)}° · 方位{' '}
                {currentSelected.azimuth.toFixed(1)}° · 星等 {currentSelected.magnitude.toFixed(1)}
              </div>
            </>
          ) : (
            <span className="text-ink-muted">点击星点或从下方列表选一颗星查看高度与方位。</span>
          )}
        </div>

        <details className="rounded-[14px] bg-page/60 p-3">
          <summary className="cursor-pointer text-[13px] font-medium text-ink">
            地平线上方可见亮星（{above.length}）
          </summary>
          <div className="mt-2.5 flex max-h-[220px] flex-col gap-1 overflow-y-auto">
            {above.slice(0, 40).map((star, idx) => (
              <button
                key={`${star.name}-${idx}`}
                type="button"
                onClick={() => setSelected(star)}
                className="flex items-center justify-between rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] text-ink hover:bg-surface-hover"
              >
                <span>{star.name}</span>
                <span className="tabular-nums-mono text-[11.5px] text-ink-muted">
                  {star.altitude.toFixed(0)}°
                </span>
              </button>
            ))}
          </div>
        </details>
      </aside>
    </div>
  );
}
