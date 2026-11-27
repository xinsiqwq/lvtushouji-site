import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Crosshair, MapPin, X } from 'lucide-react';
import type { Map as MapLibreMap, Marker as MapLibreMarker } from 'maplibre-gl';
import { OFFLINE_WORLD_GEOJSON } from '../../data/offline-world-geojson';
import { useTheme, type ResolvedScheme } from '../../lib/theme';

type AdminMapPickerProps = {
  open: boolean;
  title?: string;
  initialLat?: number | null;
  initialLng?: number | null;
  onConfirm: (coords: { lat: number; lng: number }) => void;
  onClose: () => void;
};

const DEFAULT_LAT = 30.2741;
const DEFAULT_LNG = 120.1551;

function getPickerPalette(theme: ResolvedScheme) {
  if (theme === 'dark') {
    return {
      bg: '#131314',
      land: '#1e1f20',
      landStroke: '#2d3138',
      chinaStroke: '#3f4754',
      graticule: 'rgba(227, 227, 227, 0.06)',
      pin: '#8ab4f8',
      pinStroke: '#131314',
    };
  }
  return {
    bg: '#eef2f7',
    land: '#faf8f4',
    landStroke: '#d5dde7',
    chinaStroke: '#b9c4d3',
    graticule: 'rgba(31, 31, 31, 0.06)',
    pin: '#1a73e8',
    pinStroke: '#ffffff',
  };
}

function clampCoords(lat: number, lng: number): { lat: number; lng: number } {
  const safeLat = Math.max(-90, Math.min(90, Number(lat.toFixed(5))));
  const safeLng = Math.max(-180, Math.min(180, Number(lng.toFixed(5))));
  return { lat: safeLat, lng: safeLng };
}

export function AdminMapPicker({
  open,
  title = '地图选点',
  initialLat,
  initialLng,
  onConfirm,
  onClose,
}: AdminMapPickerProps) {
  const { resolved: theme } = useTheme();
  const palette = useMemo(() => getPickerPalette(theme), [theme]);

  const hasValidInitial =
    typeof initialLat === 'number' &&
    typeof initialLng === 'number' &&
    Number.isFinite(initialLat) &&
    Number.isFinite(initialLng) &&
    Math.abs(initialLat) <= 90 &&
    Math.abs(initialLng) <= 180;

  const startLat = hasValidInitial ? initialLat : DEFAULT_LAT;
  const startLng = hasValidInitial ? initialLng : DEFAULT_LNG;

  const [picked, setPicked] = useState<{ lat: number; lng: number }>({
    lat: startLat,
    lng: startLng,
  });
  const [latInput, setLatInput] = useState(() => String(Number(startLat.toFixed(5))));
  const [lngInput, setLngInput] = useState(() => String(Number(startLng.toFixed(5))));
  const [mapReady, setMapReady] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [tiandituConfigured, setTiandituConfigured] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<MapLibreMarker | null>(null);

  useEffect(() => {
    if (!open) return;
    const nextLat = hasValidInitial ? initialLat : DEFAULT_LAT;
    const nextLng = hasValidInitial ? initialLng : DEFAULT_LNG;
    const clamped = clampCoords(nextLat, nextLng);
    setPicked(clamped);
    setLatInput(String(clamped.lat));
    setLngInput(String(clamped.lng));
    setWebglFailed(false);
  }, [open, hasValidInitial, initialLat, initialLng]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const updatePoint = (lat: number, lng: number) => {
    const next = clampCoords(lat, lng);
    setPicked(next);
    setLatInput(String(next.lat));
    setLngInput(String(next.lng));
  };

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let mapInstance: MapLibreMap | null = null;
    let markerInstance: MapLibreMarker | null = null;
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

        const created = new maplibregl.Map({
          container,
          style: {
            version: 8,
            sources: {
              'offline-world': {
                type: 'geojson',
                data: OFFLINE_WORLD_GEOJSON,
              },
            } as never,
            layers: [
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
            ] as never,
          },
          center: [startLng, startLat],
          zoom: hasValidInitial ? 6.2 : 3.6,
          attributionControl: false,
        });

        mapInstance = created;
        mapRef.current = created;

        const pinEl = document.createElement('div');
        pinEl.style.width = '18px';
        pinEl.style.height = '18px';
        pinEl.style.borderRadius = '9999px';
        pinEl.style.backgroundColor = palette.pin;
        pinEl.style.border = `2.5px solid ${palette.pinStroke}`;
        pinEl.style.boxShadow = '0 0 0 5px rgba(26,115,232,0.22)';
        pinEl.style.cursor = 'grab';

        const marker = new maplibregl.Marker({ element: pinEl, draggable: true })
          .setLngLat([startLng, startLat])
          .addTo(created);
        markerInstance = marker;
        markerRef.current = marker;

        marker.on('dragend', () => {
          const lngLat = marker.getLngLat();
          updatePoint(lngLat.lat, lngLat.lng);
        });

        created.on('click', (event) => {
          const { lat, lng } = event.lngLat;
          marker.setLngLat([lng, lat]);
          updatePoint(lat, lng);
        });

        created.on('load', () => {
          if (!disposed) setMapReady(true);
        });
        created.on('error', () => {
          /* Keep offline contours intact on tile error. */
        });

        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            if (!disposed) {
              try {
                created.resize();
              } catch {
                /* Ignore teardown resize errors. */
              }
            }
          });
          resizeObserver.observe(container);
        }
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
      markerInstance?.remove();
      markerRef.current = null;
      mapInstance?.remove();
      mapRef.current = null;
    };
    // Initialize map fresh per open session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Add Tianditu raster overlay when configured
  useEffect(() => {
    const map = mapRef.current;
    if (!open || !map || !mapReady || !tiandituConfigured) return;
    if (map.getSource('tianditu-vec')) return;

    try {
      map.addSource('tianditu-vec', {
        type: 'raster',
        tiles: ['/api/atlas/tiles/vec_w/{z}/{y}/{x}'],
        tileSize: 256,
      });
      map.addLayer({
        id: 'tianditu-vec-layer',
        type: 'raster',
        source: 'tianditu-vec',
        paint: { 'raster-opacity': theme === 'dark' ? 0.42 : 0.84 },
      });
    } catch {
      /* Fallback gracefully to offline contours. */
    }
  }, [open, mapReady, tiandituConfigured, theme]);

  // Keep map colors synced on theme switch
  useEffect(() => {
    const map = mapRef.current;
    if (!open || !map || !mapReady) return;
    try {
      map.setPaintProperty('bg-ocean', 'background-color', palette.bg);
      map.setPaintProperty('offline-land', 'fill-color', palette.land);
      map.setPaintProperty('offline-land', 'fill-outline-color', palette.landStroke);
      map.setPaintProperty('offline-graticule', 'line-color', palette.graticule);
      map.setPaintProperty('offline-china', 'line-color', palette.chinaStroke);
      if (map.getLayer('tianditu-vec-layer')) {
        map.setPaintProperty('tianditu-vec-layer', 'raster-opacity', theme === 'dark' ? 0.42 : 0.84);
      }
    } catch {
      /* Ignore paint updates during teardown. */
    }
  }, [open, mapReady, palette, theme]);

  const applyManualInputs = () => {
    const lat = Number(latInput);
    const lng = Number(lngInput);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return;
    }
    const next = clampCoords(lat, lng);
    setPicked(next);
    markerRef.current?.setLngLat([next.lng, next.lat]);
    mapRef.current?.flyTo({ center: [next.lng, next.lat], zoom: Math.max(mapRef.current.getZoom(), 5.5), duration: 500 });
  };

  const handleFallbackSvgClick = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const xRatio = (event.clientX - rect.left) / rect.width;
    const yRatio = (event.clientY - rect.top) / rect.height;
    const lng = xRatio * 360 - 180;
    const lat = 90 - yRatio * 180;
    updatePoint(lat, lng);
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-[780px] flex-col overflow-hidden rounded-[24px] border border-hairline bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3.5">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-accent" aria-hidden="true" />
            <h3 className="m-0 text-[16px] font-medium text-ink">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭地图选点"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-paper text-ink-muted hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="relative h-[360px] w-full bg-paper sm:h-[420px]">
          {webglFailed ? (
            <div className="flex h-full w-full flex-col items-center justify-center p-4">
              <svg
                viewBox="0 0 360 180"
                onClick={handleFallbackSvgClick}
                className="h-auto max-h-[300px] w-full max-w-[600px] cursor-crosshair rounded-[14px] border border-hairline"
                role="img"
                aria-label="点击离线轮廓图选择经纬度"
              >
                <rect width="360" height="180" fill={palette.bg} />
                <path
                  d="M120 95 L195 85 L220 55 L265 70 L250 110 L175 120 Z"
                  fill={palette.land}
                  stroke={palette.landStroke}
                />
                <circle
                  cx={((picked.lng + 180) / 360) * 360}
                  cy={((90 - picked.lat) / 180) * 180}
                  r={5}
                  fill={palette.pin}
                  stroke={palette.pinStroke}
                  strokeWidth={1.5}
                />
              </svg>
              <p className="mt-2 mb-0 text-[12px] text-ink-muted">
                当前环境未启用 WebGL，可点击轮廓图或直接输入经纬度微调。
              </p>
            </div>
          ) : (
            <>
              <div ref={containerRef} className="h-full w-full" />
              <div className="pointer-events-none absolute top-3 left-3 rounded-full bg-page/85 px-3 py-1 text-[11.5px] text-ink-muted backdrop-blur-xs">
                点击地图或拖拽标点定位
              </div>
              <div className="pointer-events-none absolute right-3 bottom-3 rounded-full bg-page/85 px-3 py-1 text-[11.5px] text-ink-muted backdrop-blur-xs">
                {tiandituConfigured ? '天地图 · 离线轮廓兜底' : '内置离线矢量轮廓'}
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-hairline bg-paper px-5 py-4">
          <div className="flex flex-wrap items-end gap-2.5">
            <label className="text-[12px] text-ink-muted">
              纬度
              <input
                type="text"
                value={latInput}
                onChange={(e) => setLatInput(e.target.value)}
                onBlur={applyManualInputs}
                className="tabular-nums-mono mt-1 block w-28 rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink"
              />
            </label>
            <label className="text-[12px] text-ink-muted">
              经度
              <input
                type="text"
                value={lngInput}
                onChange={(e) => setLngInput(e.target.value)}
                onBlur={applyManualInputs}
                className="tabular-nums-mono mt-1 block w-28 rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink"
              />
            </label>
            <button
              type="button"
              onClick={applyManualInputs}
              className="inline-flex min-h-[34px] items-center gap-1 rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink hover:bg-surface-hover"
            >
              <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
              <span>移至坐标</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[36px] rounded-full border border-hairline bg-surface px-4 text-[13px] text-ink hover:bg-surface-hover"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                const lat = Number(latInput);
                const lng = Number(lngInput);
                const finalCoords =
                  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
                    ? clampCoords(lat, lng)
                    : picked;
                onConfirm(finalCoords);
                onClose();
              }}
              className="min-h-[36px] rounded-full bg-cta-bg px-4 text-[13px] font-medium text-cta-text"
            >
              确认选点
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
