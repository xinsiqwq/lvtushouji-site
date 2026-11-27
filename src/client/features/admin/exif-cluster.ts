import { localDay } from '../../../shared/dates';
import type { Media, Stop } from '../../../shared/types';

const EARTH_RADIUS_KM = 6371;

export type ClusterOptions = {
  maxDistanceKm?: number;
  maxTimeGapHours?: number;
  defaultDate?: string;
  idPrefix?: string;
  existingStopCount?: number;
};

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function parsePhotoTimeMs(takenAt: string | null | undefined): number | null {
  if (!takenAt) return null;
  const trimmed = takenAt.trim();
  if (!trimmed) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T12:00:00Z` : trimmed;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function formatCoordsCompact(lat: number, lng: number): string {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${latDir} · ${Math.abs(lng).toFixed(2)}°${lngDir}`;
}

type DraftCluster = {
  items: Media[];
  sumLat: number;
  sumLng: number;
  lastTimeMs: number | null;
};

function isConfirmedGeoMedia(m: Media): m is Media & { lat: number; lng: number } {
  return (
    m.confirmed &&
    typeof m.lat === 'number' &&
    typeof m.lng === 'number' &&
    Number.isFinite(m.lat) &&
    Number.isFinite(m.lng) &&
    Math.abs(m.lat) <= 90 &&
    Math.abs(m.lng) <= 180
  );
}

/**
 * Pure client-side Haversine + time-gap clustering of confirmed geolocated photos
 * into draft Journey stops with `mediaIds` pre-bound, coordinates averaged, and date prefilled.
 */
export function clusterMediaIntoStops(mediaList: Media[], options: ClusterOptions = {}): Stop[] {
  const maxDistanceKm = options.maxDistanceKm ?? 18;
  const maxTimeGapMs = (options.maxTimeGapHours ?? 12) * 3600_000;
  const fallbackDate = localDay(options.defaultDate) || new Date().toISOString().slice(0, 10);
  const idPrefix = options.idPrefix ?? `stop_cluster_${Date.now().toString(36)}`;
  const existingCount = options.existingStopCount ?? 0;

  const eligible = mediaList.filter(isConfirmedGeoMedia);
  if (eligible.length === 0) return [];

  const dated: Array<{ media: Media & { lat: number; lng: number }; ms: number }> = [];
  const undated: Array<Media & { lat: number; lng: number }> = [];

  for (const item of eligible) {
    const ms = parsePhotoTimeMs(item.takenAt);
    if (ms !== null) {
      dated.push({ media: item, ms });
    } else {
      undated.push(item);
    }
  }

  dated.sort((a, b) => a.ms - b.ms || a.media.name.localeCompare(b.media.name));
  undated.sort((a, b) => a.name.localeCompare(b.name));

  const clusters: DraftCluster[] = [];

  for (const entry of dated) {
    const { media, ms } = entry;
    const prev = clusters[clusters.length - 1];
    if (prev) {
      const avgLat = prev.sumLat / prev.items.length;
      const avgLng = prev.sumLng / prev.items.length;
      const distKm = haversineKm(avgLat, avgLng, media.lat, media.lng);
      const timeGap = prev.lastTimeMs !== null ? Math.abs(ms - prev.lastTimeMs) : 0;
      if (distKm <= maxDistanceKm && timeGap <= maxTimeGapMs) {
        prev.items.push(media);
        prev.sumLat += media.lat;
        prev.sumLng += media.lng;
        prev.lastTimeMs = ms;
        continue;
      }
    }
    clusters.push({
      items: [media],
      sumLat: media.lat,
      sumLng: media.lng,
      lastTimeMs: ms,
    });
  }

  for (const media of undated) {
    let bestCluster: DraftCluster | null = null;
    let bestDist = Infinity;
    for (const cluster of clusters) {
      const avgLat = cluster.sumLat / cluster.items.length;
      const avgLng = cluster.sumLng / cluster.items.length;
      const distKm = haversineKm(avgLat, avgLng, media.lat, media.lng);
      if (distKm <= maxDistanceKm && distKm < bestDist) {
        bestDist = distKm;
        bestCluster = cluster;
      }
    }
    if (bestCluster) {
      bestCluster.items.push(media);
      bestCluster.sumLat += media.lat;
      bestCluster.sumLng += media.lng;
    } else {
      clusters.push({
        items: [media],
        sumLat: media.lat,
        sumLng: media.lng,
        lastTimeMs: null,
      });
    }
  }

  return clusters.map((cluster, idx) => {
    const avgLat = Number((cluster.sumLat / cluster.items.length).toFixed(5));
    const avgLng = Number((cluster.sumLng / cluster.items.length).toFixed(5));
    const firstValidDay =
      cluster.items.map((m) => localDay(m.takenAt)).find((d) => d.length === 10) || fallbackDate;

    return {
      id: `${idPrefix}_${existingCount + idx}`,
      name: `归集站点 ${existingCount + idx + 1}`,
      region: '',
      lat: avgLat,
      lng: avgLng,
      date: firstValidDay,
      note: '',
      mediaIds: cluster.items.map((m) => m.id),
    };
  });
}
