import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, GeoJsonProperties, Geometry } from 'geojson';
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import type { Stop } from '../../../shared/types';
import { OFFLINE_WORLD_GEOJSON } from '../../data/offline-world-geojson';
import type { ResolvedScheme } from '../../lib/theme';

type AtlasMapProps = {
  stops: Stop[];
  activeStopIndex: number;
  theme: ResolvedScheme;
  onSelectStop: (index: number) => void;
  onManualInteract: () => void;
};

function buildBezierCurve(a: [number, number], b: [number, number], steps = 24): number[][] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dist = Math.hypot(dx, dy);
  if (dist < 0.0001) return [a, b];

  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const nx = -dy / dist;
  const ny = dx / dist;
  const offset = Math.min(4.5, dist * 0.16);
  const ctrl: [number, number] = [mid[0] + nx * offset, mid[1] + ny * offset];

  const coords: number[][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const inv = 1 - t;
    coords.push([
      inv * inv * a[0] + 2 * inv * t * ctrl[0] + t * t * b[0],
      inv * inv * a[1] + 2 * inv * t * ctrl[1] + t * t * b[1],
    ]);
  }
  return coords;
}

function buildRouteCollections(stops: Stop[], activeIndex: number) {
  const validStops = stops.filter(
    (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180,
  );

  const completedCoords: number[][][] = [];
  const remainingCoords: number[][][] = [];

  for (let i = 0; i < validStops.length - 1; i += 1) {
    const seg = buildBezierCurve(
      [validStops[i]!.lng, validStops[i]!.lat],
      [validStops[i + 1]!.lng, validStops[i + 1]!.lat],
    );
    if (i < activeIndex) completedCoords.push(seg);
    else remainingCoords.push(seg);
  }

  const completedGeo: FeatureCollection<Geometry, GeoJsonProperties> = {
    type: 'FeatureCollection',
    features: completedCoords.map((coordinates) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    })),
  };

  const remainingGeo: FeatureCollection<Geometry, GeoJsonProperties> = {
    type: 'FeatureCollection',
    features: remainingCoords.map((coordinates) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    })),
  };

  return { validStops, completedGeo, remainingGeo };
}

function getPalette(theme: ResolvedScheme) {
  if (theme === 'dark') {
    return {
      bg: '#131314',
      land: '#1e1f20',
      landStroke: '#2d3138',
      chinaStroke: '#3f4754',
      graticule: 'rgba(227, 227, 227, 0.06)',
      routeCompleted: '#8ab4f8',
      routeRemaining: 'rgba(138, 180, 248, 0.34)',
      markerActive: '#8ab4f8',
      markerIdle: '#d69f87',
    };
  }
  return {
    bg: '#eef2f7',
    land: '#faf8f4',
    landStroke: '#d5dde7',
    chinaStroke: '#b9c4d3',
    graticule: 'rgba(31, 31, 31, 0.06)',
    routeCompleted: '#1a73e8',
    routeRemaining: 'rgba(26, 115, 232, 0.28)',
    markerActive: '#1a73e8',
    markerIdle: '#9a5b42',
  };
}

export default function AtlasMap({
  stops,
  activeStopIndex,
  theme,
  onSelectStop,
  onManualInteract,
}: AtlasMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [tiandituConfigured, setTiandituConfigured] = useState(false);

  const onSelectStopRef = useRef(onSelectStop);
  const onManualInteractRef = useRef(onManualInteract);
  onSelectStopRef.current = onSelectStop;
  onManualInteractRef.current = onManualInteract;

  const { validStops, completedGeo, remainingGeo } = useMemo(
    () => buildRouteCollections(stops, activeStopIndex),
    [stops, activeStopIndex],
  );

  const palette = useMemo(() => getPalette(theme), [theme]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/atlas/config', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ tiandituConfigured?: boolean }>) : null))
      .then((data) => {
        if (!cancelled && data && typeof data.tiandituConfigured === 'boolean') {
          setTiandituConfigured(data.tiandituConfigured);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let mapInstance: MapLibreMap | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const init = async () => {
      try {
        const [workerMod, maplibreMod] = await Promise.all([
          import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
          import('maplibre-gl'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        const maplibregl = (
          'default' in maplibreMod && maplibreMod.default ? maplibreMod.default : maplibreMod
        ) as typeof import('maplibre-gl');
        if (typeof maplibregl.setWorkerUrl === 'function' && workerMod.default) {
          maplibregl.setWorkerUrl(workerMod.default);
        }
        if (disposed || !container) return;

        const initialStop = validStops[0];
        const center: [number, number] = initialStop
          ? [initialStop.lng, initialStop.lat]
          : [104.0, 34.0];

        const baseSources: Record<string, unknown> = {
          'offline-world': {
            type: 'geojson',
            data: OFFLINE_WORLD_GEOJSON,
          },
          'route-remaining': {
            type: 'geojson',
            data: remainingGeo,
          },
          'route-completed': {
            type: 'geojson',
            data: completedGeo,
          },
        };

        const baseLayers: Array<Record<string, unknown>> = [
          {
            id: 'bg-ocean',
            type: 'background',
            paint: { 'background-color': palette.bg },
          },
          {
            id: 'offline-land',
            type: 'fill',
            source: 'offline-world',
            filter: ['==', ['get', 'kind'], 'land'],
            paint: {
              'fill-color': palette.land,
              'fill-outline-color': palette.landStroke,
            },
          },
          {
            id: 'offline-graticule',
            type: 'line',
            source: 'offline-world',
            filter: ['==', ['get', 'kind'], 'graticule'],
            paint: {
              'line-color': palette.graticule,
              'line-width': 1,
            },
          },
          {
            id: 'offline-china',
            type: 'line',
            source: 'offline-world',
            filter: ['==', ['get', 'kind'], 'china-outline'],
            paint: {
              'line-color': palette.chinaStroke,
              'line-width': 1.25,
            },
          },
          {
            id: 'route-remaining-line',
            type: 'line',
            source: 'route-remaining',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': palette.routeRemaining,
              'line-width': 2.5,
              'line-dasharray': [2, 2],
            },
          },
          {
            id: 'route-completed-line',
            type: 'line',
            source: 'route-completed',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': palette.routeCompleted,
              'line-width': 3.2,
            },
          },
        ];

        const created = new maplibregl.Map({
          container,
          style: {
            version: 8,
            sources: baseSources as never,
            layers: baseLayers as never,
          },
          center,
          zoom: initialStop ? 4.4 : 3.2,
          pitch: 40,
          bearing: -8,
          attributionControl: false,
        });

        mapInstance = created;
        mapRef.current = created;
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            if (!disposed) {
              try {
                created.resize();
              } catch {
                /* Ignore resize errors during teardown. */
              }
            }
          });
          resizeObserver.observe(container);
        }

        created.on('load', () => {
          if (disposed) return;
          setMapReady(true);
        });

        created.on('dragstart', () => onManualInteractRef.current());
        created.on('wheel', () => onManualInteractRef.current());
        created.on('error', () => {
          // Non-fatal tile/source error: keep offline GeoJSON contours intact.
        });
      } catch {
        if (!disposed) {
          setWebglFailed(true);
        }
      }
    };

    void init();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      setMapReady(false);
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      mapInstance?.remove();
      mapRef.current = null;
    };
  }, []);

  // Optional Tianditu raster overlay only when server TIANDITU_KEY is configured
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !tiandituConfigured) return;
    if (map.getSource('tianditu-vec')) return;

    try {
      map.addSource('tianditu-vec', {
        type: 'raster',
        tiles: ['/api/atlas/tiles/vec_w/{z}/{y}/{x}'],
        tileSize: 256,
      });
      map.addLayer(
        {
          id: 'tianditu-vec-layer',
          type: 'raster',
          source: 'tianditu-vec',
          paint: { 'raster-opacity': theme === 'dark' ? 0.42 : 0.82 },
        },
        'route-remaining-line',
      );
    } catch {
      /* Keep offline contours on source failure. */
    }
  }, [mapReady, tiandituConfigured, theme]);

  // Sync day/night colors cleanly without blanking or remounting map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try {
      map.setPaintProperty('bg-ocean', 'background-color', palette.bg);
      map.setPaintProperty('offline-land', 'fill-color', palette.land);
      map.setPaintProperty('offline-land', 'fill-outline-color', palette.landStroke);
      map.setPaintProperty('offline-graticule', 'line-color', palette.graticule);
      map.setPaintProperty('offline-china', 'line-color', palette.chinaStroke);
      map.setPaintProperty('route-remaining-line', 'line-color', palette.routeRemaining);
      map.setPaintProperty('route-completed-line', 'line-color', palette.routeCompleted);
      if (map.getLayer('tianditu-vec-layer')) {
        map.setPaintProperty('tianditu-vec-layer', 'raster-opacity', theme === 'dark' ? 0.42 : 0.82);
      }
    } catch {
      /* Ignore paint updates during map teardown. */
    }
  }, [mapReady, palette, theme]);

  // Sync Bezier route sources and markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let cancelled = false;
    const sync = async () => {
      try {
        const remainingSrc = map.getSource('route-remaining') as { setData?: (d: unknown) => void } | undefined;
        const completedSrc = map.getSource('route-completed') as { setData?: (d: unknown) => void } | undefined;
        remainingSrc?.setData?.(remainingGeo);
        completedSrc?.setData?.(completedGeo);

        const maplibreMod = await import('maplibre-gl');
        const maplibregl = (
          'default' in maplibreMod && maplibreMod.default ? maplibreMod.default : maplibreMod
        ) as typeof import('maplibre-gl');
        if (cancelled) return;

        for (const m of markersRef.current) m.remove();
        markersRef.current = [];

        stops.forEach((stop, index) => {
          if (
            !Number.isFinite(stop.lat) ||
            !Number.isFinite(stop.lng) ||
            Math.abs(stop.lat) > 90 ||
            Math.abs(stop.lng) > 180
          ) {
            return;
          }
          const isActive = index === activeStopIndex;
          const markerEl = document.createElement('div');
          markerEl.dataset.stopMarker = 'true';
          markerEl.title = stop.name;
          markerEl.setAttribute('aria-hidden', 'true');
          markerEl.style.width = isActive ? '16px' : '11px';
          markerEl.style.height = isActive ? '16px' : '11px';
          markerEl.style.borderRadius = '9999px';
          markerEl.style.border = `2px solid ${theme === 'dark' ? '#131314' : '#ffffff'}`;
          markerEl.style.backgroundColor = isActive ? palette.markerActive : palette.markerIdle;
          markerEl.style.cursor = 'pointer';
          markerEl.style.boxShadow = isActive ? '0 0 0 4px rgba(26,115,232,0.22)' : 'none';
          markerEl.addEventListener('click', (event) => {
            event.stopPropagation();
            onManualInteractRef.current();
            onSelectStopRef.current(index);
          });

          const marker = new maplibregl.Marker({ element: markerEl })
            .setLngLat([stop.lng, stop.lat])
            .addTo(map);
          markersRef.current.push(marker);
        });
      } catch {
        /* Ignore marker update failures during teardown. */
      }
    };

    void sync();
    return () => {
      cancelled = true;
    };
  }, [activeStopIndex, completedGeo, mapReady, palette, remainingGeo, stops, theme]);

  // Smooth camera flight to active stop
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const stop = stops[activeStopIndex];
    if (
      !stop ||
      !Number.isFinite(stop.lat) ||
      !Number.isFinite(stop.lng) ||
      Math.abs(stop.lat) > 90 ||
      Math.abs(stop.lng) > 180
    ) {
      return;
    }

    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    try {
      if (reducedMotion) {
        map.jumpTo({ center: [stop.lng, stop.lat], zoom: 5.4, pitch: 40 });
      } else {
        map.flyTo({ center: [stop.lng, stop.lat], zoom: 5.4, pitch: 40, duration: 900 });
      }
    } catch {
      /* Ignore extreme coordinate camera errors. */
    }
  }, [activeStopIndex, mapReady, stops]);

  if (webglFailed) {
    return (
      <div
        role="region"
        aria-label="离线足迹轮廓图"
        className="relative flex h-full min-h-[160px] w-full flex-col items-center justify-center overflow-hidden rounded-[24px] bg-surface p-6 text-center"
      >
        <svg viewBox="0 0 360 180" className="h-auto w-full max-w-[520px] opacity-80" aria-hidden="true">
          <rect width="360" height="180" rx="16" fill={palette.bg} />
          <path d="M120 95 L195 85 L220 55 L265 70 L250 110 L175 120 Z" fill={palette.land} stroke={palette.landStroke} />
          {validStops.map((s, idx) => {
            const x = ((s.lng + 180) / 360) * 360;
            const y = ((90 - s.lat) / 180) * 180;
            return (
              <circle
                key={s.id}
                cx={x}
                cy={y}
                r={idx === activeStopIndex ? 5 : 3.5}
                fill={idx === activeStopIndex ? palette.markerActive : palette.markerIdle}
              />
            );
          })}
        </svg>
        <p className="mt-3 mb-0 text-[13px] text-ink-muted">
          当前环境未启用 WebGL，已切换为离线足迹轮廓。
        </p>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="旅图 2.5D 交互地图"
      className="relative h-full min-h-[160px] w-full overflow-hidden rounded-[24px] bg-surface"
    >
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute right-3 bottom-3 rounded-full bg-page/80 px-3 py-1 text-[11.5px] text-ink-muted backdrop-blur-sm">
        {tiandituConfigured ? '天地图 · 离线轮廓兜底' : '内置离线矢量轮廓'}
      </div>
    </div>
  );
}
