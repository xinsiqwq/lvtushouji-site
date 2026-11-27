import { useMemo, useState, type ChangeEvent } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Copy,
  Crosshair,
  Layers,
  Link2,
  MapPin,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { localDay } from '../../../shared/dates';
import type { AdminSnapshot, ExifSummary, Journey, Media, Stop } from '../../../shared/types';
import { DarkroomDialog, type DarkroomPhoto } from '../../components/DarkroomDialog';
import { apiJson } from '../../lib/api';
import { processAtlasImage } from '../../lib/exif-webp';
import { AdminMapPicker } from './AdminMapPicker';
import { clusterMediaIntoStops } from './exif-cluster';

type AtlasAdminPanelProps = {
  snapshot: AdminSnapshot;
  onRefresh: () => Promise<void>;
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
};

type MapPickerTarget =
  | { kind: 'pending'; mediaId: string; title: string; lat: number | null; lng: number | null }
  | { kind: 'stop'; stopIndex: number; title: string; lat: number; lng: number };

function formatExifSummary(exif?: ExifSummary): string {
  if (!exif) return '';
  return [
    exif.model,
    exif.focalLength,
    exif.aperture,
    exif.shutter,
    exif.iso ? `ISO ${exif.iso}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

function generateShareToken(length = 20): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet.charAt(bytes[i]! % alphabet.length);
  }
  return out;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through to textarea fallback */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function createBlankJourney(sortOrder: number): Journey {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: `journey_${Date.now().toString(36)}`,
    title: '',
    subtitle: '',
    startDate: today,
    endDate: today,
    visibility: 'private',
    coverId: null,
    stops: [],
    createdAt: new Date().toISOString(),
    sortOrder,
    shareToken: null,
  };
}

export function AtlasAdminPanel({
  snapshot,
  onRefresh,
  onStatus,
  onError,
}: AtlasAdminPanelProps) {
  const [uploading, setUploading] = useState(false);
  const [coordsDraft, setCoordsDraft] = useState<
    Record<string, { lat: string; lng: string; caption: string }>
  >({});
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({});
  const [savingCaptionId, setSavingCaptionId] = useState<string | null>(null);

  const [editingJourney, setEditingJourney] = useState<Journey>(() =>
    snapshot.library.journeys[0]
      ? { ...snapshot.library.journeys[0] }
      : createBlankJourney(0),
  );
  const [savingJourney, setSavingJourney] = useState(false);
  const [copiedShareLink, setCopiedShareLink] = useState(false);

  const [mapPickerTarget, setMapPickerTarget] = useState<MapPickerTarget | null>(null);
  const [darkroomList, setDarkroomList] = useState<DarkroomPhoto[]>([]);
  const [darkroomIndex, setDarkroomIndex] = useState<number | null>(null);

  const pendingMedia = useMemo(
    () => snapshot.library.media.filter((m) => m.lat === null || m.lng === null || !m.confirmed),
    [snapshot.library.media],
  );
  const confirmedMedia = useMemo(
    () => snapshot.library.media.filter((m) => m.lat !== null && m.lng !== null && m.confirmed),
    [snapshot.library.media],
  );

  const mediaById = useMemo(() => {
    const map = new Map<string, Media>();
    for (const m of snapshot.library.media) {
      map.set(m.id, m);
    }
    return map;
  }, [snapshot.library.media]);

  // Media linked in any saved journey
  const persistedLinkedMediaIds = useMemo(() => {
    const set = new Set<string>();
    for (const j of snapshot.library.journeys) {
      if (j.coverId) set.add(j.coverId);
      for (const s of j.stops) {
        for (const mid of s.mediaIds) set.add(mid);
      }
    }
    return set;
  }, [snapshot.library.journeys]);

  // Cover candidates: media bound to current journey stops first, then remaining confirmed media
  const coverCandidates = useMemo(() => {
    const inJourney = new Set<string>();
    for (const s of editingJourney.stops) {
      for (const mid of s.mediaIds) inJourney.add(mid);
    }
    const primary = confirmedMedia.filter((m) => inJourney.has(m.id));
    const secondary = confirmedMedia.filter((m) => !inJourney.has(m.id));
    return [...primary, ...secondary];
  }, [confirmedMedia, editingJourney.stops]);

  const savedEditingJourney = useMemo(
    () => snapshot.library.journeys.find((j) => j.id === editingJourney.id) ?? null,
    [snapshot.library.journeys, editingJourney.id],
  );

  const openMediaDarkroom = (pool: Media[], clickedIndex: number) => {
    const photos: DarkroomPhoto[] = pool.map((m) => ({
      id: m.id,
      title: m.name,
      caption: m.caption || undefined,
      previewUrl: `/api/files/${m.id}?variant=preview`,
      takenAt: m.takenAt,
      lat: m.lat,
      lng: m.lng,
      exif: m.exif,
    }));
    setDarkroomList(photos);
    setDarkroomIndex(clickedIndex);
  };

  const handlePhotoUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setUploading(true);
    onError('');
    try {
      for (const file of files) {
        onStatus(`正在本地解析 EXIF 并压缩 WebP：${file.name}……`);
        const processed = await processAtlasImage(file);
        const form = new FormData();
        form.append('files', processed.file, processed.file.name);
        form.append('thumbnail', processed.thumbnail, 'thumb-600.webp');
        form.append('preview', processed.preview, 'preview-1600.webp');
        form.append('width', String(processed.width));
        form.append('height', String(processed.height));
        if (processed.takenAt) form.append('takenAt', processed.takenAt);
        if (processed.lat !== null && processed.lng !== null) {
          form.append('lat', String(processed.lat));
          form.append('lng', String(processed.lng));
          form.append('confirmed', String(processed.confirmed));
        }
        if (processed.exif) form.append('exif', JSON.stringify(processed.exif));

        await apiJson<{ media: Media[] }>('/api/media', {
          method: 'POST',
          body: form,
        });
      }
      await onRefresh();
      onStatus(`已完成 ${files.length} 张影像上传。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '影像上传失败');
    } finally {
      setUploading(false);
    }
  };

  const saveMediaCaption = async (item: Media) => {
    const nextCaption = captionDrafts[item.id] ?? item.caption;
    setSavingCaptionId(item.id);
    onError('');
    try {
      await apiJson('/api/media', {
        method: 'PATCH',
        json: {
          id: item.id,
          caption: nextCaption.trim(),
        },
      });
      await onRefresh();
      onStatus(`已更新「${item.name}」的影像说明。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存影像说明失败');
    } finally {
      setSavingCaptionId(null);
    }
  };

  const confirmCoordinates = async (item: Media) => {
    const draft = coordsDraft[item.id] ?? {
      lat: item.lat !== null ? String(item.lat) : '',
      lng: item.lng !== null ? String(item.lng) : '',
      caption: item.caption,
    };
    const lat = Number(draft.lat);
    const lng = Number(draft.lng);
    if (!draft.lat.trim() || !draft.lng.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      onError('请填写有效的纬度与经度数值。');
      return;
    }
    onError('');
    try {
      await apiJson('/api/media', {
        method: 'PATCH',
        json: {
          id: item.id,
          lat,
          lng,
          confirmed: true,
          caption: draft.caption,
        },
      });
      await onRefresh();
      onStatus(`已确认「${item.name}」的拍摄坐标。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存坐标失败');
    }
  };

  const trashRecord = async (kind: 'media' | 'journey', id: string) => {
    onError('');
    try {
      await apiJson('/api/admin/trash', { method: 'POST', json: { kind, id } });
      await onRefresh();
      if (kind === 'journey' && editingJourney.id === id) {
        const remaining = snapshot.library.journeys.filter((j) => j.id !== id);
        setEditingJourney(
          remaining[0] ? { ...remaining[0] } : createBlankJourney(remaining.length),
        );
      }
      onStatus('已移入回收站。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '移入回收站失败');
    }
  };

  const addStop = () => {
    const nextStop: Stop = {
      id: `stop_${Date.now().toString(36)}_${editingJourney.stops.length}`,
      name: '新站点',
      region: '',
      lat: 30.2741,
      lng: 120.1551,
      date: editingJourney.startDate || new Date().toISOString().slice(0, 10),
      note: '',
      mediaIds: [],
    };
    setEditingJourney((prev) => ({ ...prev, stops: [...prev.stops, nextStop] }));
  };

  const handleAutoClusterStops = () => {
    onError('');
    const alreadyInCurrent = new Set(editingJourney.stops.flatMap((s) => s.mediaIds));
    const globallyUnlinked = confirmedMedia.filter(
      (m) => !persistedLinkedMediaIds.has(m.id) && !alreadyInCurrent.has(m.id),
    );
    const pool =
      globallyUnlinked.length > 0
        ? globallyUnlinked
        : confirmedMedia.filter((m) => !alreadyInCurrent.has(m.id));

    if (pool.length === 0) {
      onStatus('暂无未编入当前旅程的已定位影像可供自动归集。');
      return;
    }

    const clustered = clusterMediaIntoStops(pool, {
      maxDistanceKm: 18,
      maxTimeGapHours: 12,
      defaultDate: editingJourney.startDate,
      existingStopCount: editingJourney.stops.length,
    });

    if (clustered.length === 0) {
      onStatus('未找到可用于时空归集的已定位影像。');
      return;
    }

    setEditingJourney((prev) => {
      const nextStops = [...prev.stops, ...clustered];
      const allDates = nextStops
        .map((s) => localDay(s.date))
        .filter((d) => d.length === 10)
        .sort();
      const firstDate = allDates[0] || prev.startDate;
      const lastDate = allDates[allDates.length - 1] || prev.endDate;
      const nextStart =
        prev.stops.length === 0 || firstDate < prev.startDate.slice(0, 10)
          ? firstDate
          : prev.startDate;
      const nextEnd =
        prev.stops.length === 0 || lastDate > prev.endDate.slice(0, 10)
          ? lastDate
          : prev.endDate;
      const firstMediaId = clustered[0]?.mediaIds[0] ?? null;
      return {
        ...prev,
        startDate: nextStart,
        endDate: nextEnd < nextStart ? nextStart : nextEnd,
        coverId: prev.coverId ?? firstMediaId,
        stops: nextStops,
      };
    });

    onStatus(`已按时空距离与时间间隔归集 ${pool.length} 张影像为 ${clustered.length} 个草稿站点，可调整名称后保存旅程。`);
  };

  const moveStop = (index: number, delta: -1 | 1) => {
    setEditingJourney((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.stops.length) return prev;
      const next = [...prev.stops];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return { ...prev, stops: next };
    });
  };

  const toggleStopMedia = (stopIndex: number, mediaId: string) => {
    setEditingJourney((prev) => ({
      ...prev,
      stops: prev.stops.map((s, i) => {
        if (i !== stopIndex) return s;
        const exists = s.mediaIds.includes(mediaId);
        return {
          ...s,
          mediaIds: exists
            ? s.mediaIds.filter((id) => id !== mediaId)
            : [...s.mediaIds, mediaId],
        };
      }),
    }));
  };

  const moveStopMedia = (stopIndex: number, mediaIndex: number, delta: -1 | 1) => {
    setEditingJourney((prev) => ({
      ...prev,
      stops: prev.stops.map((s, i) => {
        if (i !== stopIndex) return s;
        const target = mediaIndex + delta;
        if (target < 0 || target >= s.mediaIds.length) return s;
        const nextIds = [...s.mediaIds];
        const [moved] = nextIds.splice(mediaIndex, 1);
        nextIds.splice(target, 0, moved!);
        return { ...s, mediaIds: nextIds };
      }),
    }));
  };

  const absorbFirstPhotoMeta = (stopIndex: number) => {
    const stop = editingJourney.stops[stopIndex];
    if (!stop || stop.mediaIds.length === 0) {
      onError('请先为该站点勾选至少一张已定位影像。');
      return;
    }
    const firstMedia = mediaById.get(stop.mediaIds[0]!);
    if (!firstMedia) {
      onError('未找到该站点的首图记录。');
      return;
    }
    const hasCoords =
      typeof firstMedia.lat === 'number' &&
      typeof firstMedia.lng === 'number' &&
      Number.isFinite(firstMedia.lat) &&
      Number.isFinite(firstMedia.lng);
    const photoDay = localDay(firstMedia.takenAt);
    if (!hasCoords && !photoDay) {
      onError('首图缺少有效坐标与拍摄日期。');
      return;
    }
    onError('');
    setEditingJourney((prev) => ({
      ...prev,
      stops: prev.stops.map((s, i) => {
        if (i !== stopIndex) return s;
        return {
          ...s,
          lat: hasCoords ? Number(firstMedia.lat!.toFixed(5)) : s.lat,
          lng: hasCoords ? Number(firstMedia.lng!.toFixed(5)) : s.lng,
          date: photoDay || s.date,
        };
      }),
    }));
    onStatus(`已从「${firstMedia.name}」吸取坐标与日期至第 ${stopIndex + 1} 站。`);
  };

  const handleCopyCompanionLink = async () => {
    if (!editingJourney.shareToken) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = `${origin}/atlas?share=${encodeURIComponent(editingJourney.shareToken)}`;
    const ok = await copyText(url);
    if (ok) {
      setCopiedShareLink(true);
      onStatus('已复制同行私密分享链接。');
      window.setTimeout(() => setCopiedShareLink(false), 2500);
    } else {
      onError('剪贴板复制失败，请手动选中链接复制。');
    }
  };

  const saveJourney = async () => {
    if (!editingJourney.title.trim()) {
      onError('请填写旅程标题。');
      return;
    }
    setSavingJourney(true);
    onError('');
    try {
      const normalizedEnd =
        editingJourney.endDate.slice(0, 10) < editingJourney.startDate.slice(0, 10)
          ? editingJourney.startDate.slice(0, 10)
          : editingJourney.endDate.slice(0, 10);
      const res = await apiJson<{ journey: Journey }>('/api/journeys', {
        method: 'POST',
        json: {
          ...editingJourney,
          endDate: normalizedEnd,
          shareToken: editingJourney.shareToken ?? null,
        },
      });
      setEditingJourney(res.journey);
      await onRefresh();
      onStatus(`旅程「${res.journey.title}」已保存。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存旅程失败');
    } finally {
      setSavingJourney(false);
    }
  };

  const companionShareUrl = editingJourney.shareToken
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/atlas?share=${encodeURIComponent(editingJourney.shareToken)}`
    : '';
  const shareTokenUnsaved =
    (editingJourney.shareToken ?? null) !== (savedEditingJourney?.shareToken ?? null);

  return (
    <div className="space-y-8">
      {/* Photo upload + Confirmed Media Grid */}
      <section className="rounded-[20px] bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-[18px] font-medium text-ink">影像入库与 EXIF 预处理</h2>
            <p className="mt-1 mb-0 text-[12.5px] text-ink-muted">
              本地读取 EXIF 与经纬度，自动生成 600px / 1600px WebP 后上传至私有存储。
            </p>
          </div>
          <label className="inline-flex min-h-[40px] cursor-pointer items-center rounded-full bg-cta-bg px-5 text-[13.5px] font-medium text-cta-text">
            <span>{uploading ? '正在处理影像…' : '选择摄影作品'}</span>
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={uploading}
              onChange={handlePhotoUpload}
              className="hidden"
            />
          </label>
        </div>

        {confirmedMedia.length > 0 && (
          <div className="mt-5 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {confirmedMedia.map((m, idx) => {
              const linked = persistedLinkedMediaIds.has(m.id);
              const exifLine = formatExifSummary(m.exif);
              const draftCaption = captionDrafts[m.id] ?? m.caption;
              const captionChanged = draftCaption !== m.caption;

              return (
                <article
                  key={m.id}
                  className="flex flex-col overflow-hidden rounded-[16px] border border-hairline bg-paper"
                >
                  <button
                    type="button"
                    onClick={() => openMediaDarkroom(confirmedMedia, idx)}
                    aria-label={`暗房预览 ${m.name}`}
                    className="group relative block h-40 w-full overflow-hidden bg-surface text-left"
                  >
                    <img
                      src={`/api/files/${m.id}?variant=thumbnail`}
                      alt={m.caption || m.name}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                    <span
                      className={[
                        'absolute top-2.5 left-2.5 rounded-full px-2.5 py-0.5 text-[11px] backdrop-blur-xs',
                        linked
                          ? 'bg-page/85 font-medium text-accent'
                          : 'bg-page/80 text-ink-muted',
                      ].join(' ')}
                    >
                      {linked ? '已入编' : '未编入'}
                    </span>
                  </button>

                  <div className="flex flex-1 flex-col gap-2 p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-[13.5px] font-medium text-ink" title={m.name}>
                        {m.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => void trashRecord('media', m.id)}
                        aria-label={`回收 ${m.name}`}
                        className="shrink-0 rounded-full p-1 text-ink-muted hover:text-postmark"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>

                    <div className="tabular-nums-mono text-[11.5px] text-ink-muted">
                      {m.lat !== null && m.lng !== null && `${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}`}
                      {m.takenAt ? ` · ${m.takenAt.slice(0, 10)}` : ''}
                    </div>

                    {exifLine && (
                      <div className="tabular-nums-mono truncate text-[11.5px] text-ink-muted" title={exifLine}>
                        {exifLine}
                      </div>
                    )}

                    <div className="mt-auto flex items-center gap-1.5 pt-1">
                      <input
                        type="text"
                        value={draftCaption}
                        onChange={(e) =>
                          setCaptionDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))
                        }
                        placeholder="添加一行拍摄说明"
                        aria-label={`${m.name} 的拍摄说明`}
                        className="font-editorial-serif min-w-0 flex-1 rounded-[8px] border border-hairline bg-page px-2.5 py-1 text-[12.5px] text-ink"
                      />
                      <button
                        type="button"
                        disabled={savingCaptionId === m.id}
                        onClick={() => void saveMediaCaption(m)}
                        className={[
                          'min-h-[30px] shrink-0 rounded-full px-3 text-[11.5px] transition-colors disabled:opacity-50',
                          captionChanged
                            ? 'bg-cta-bg font-medium text-cta-text'
                            : 'bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink',
                        ].join(' ')}
                      >
                        {savingCaptionId === m.id ? '保存中' : '保存说明'}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Pending GPS queue */}
      <section className="rounded-[20px] bg-surface p-6">
        <h2 className="m-0 mb-4 text-[18px] font-medium text-ink">待定位影像</h2>
        {pendingMedia.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-muted">当前没有待定位影像。</p>
        ) : (
          <div className="space-y-3">
            {pendingMedia.map((item, idx) => {
              const draft = coordsDraft[item.id] ?? {
                lat: item.lat !== null ? String(item.lat) : '',
                lng: item.lng !== null ? String(item.lng) : '',
                caption: item.caption,
              };
              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 rounded-[16px] border border-hairline bg-paper p-4 sm:flex-row sm:items-end"
                >
                  <button
                    type="button"
                    onClick={() => openMediaDarkroom(pendingMedia, idx)}
                    aria-label={`预览待定位影像 ${item.name}`}
                    className="h-20 w-28 shrink-0 overflow-hidden rounded-[10px] bg-surface"
                  >
                    <img
                      src={`/api/files/${item.id}?variant=thumbnail`}
                      alt={item.caption || item.name}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </button>

                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium text-ink">
                          {item.name}
                        </span>
                        <span className="shrink-0 text-[12px] text-postmark">待定位</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void trashRecord('media', item.id)}
                        aria-label={`回收 ${item.name}`}
                        className="rounded-full p-1 text-ink-muted hover:text-postmark"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>

                    <div className="flex flex-wrap items-end gap-2.5">
                      <label className="min-w-[160px] flex-1 text-[12px] text-ink-muted">
                        拍摄说明
                        <input
                          type="text"
                          value={draft.caption}
                          placeholder="一句地名或场景说明"
                          onChange={(e) =>
                            setCoordsDraft((prev) => ({
                              ...prev,
                              [item.id]: { ...draft, caption: e.target.value },
                            }))
                          }
                          className="font-editorial-serif mt-1 block w-full rounded-[8px] border border-hairline bg-page px-2.5 py-1 text-[12.5px] text-ink"
                        />
                      </label>
                      <label className="text-[12px] text-ink-muted">
                        纬度
                        <input
                          type="text"
                          value={draft.lat}
                          onChange={(e) =>
                            setCoordsDraft((prev) => ({
                              ...prev,
                              [item.id]: { ...draft, lat: e.target.value },
                            }))
                          }
                          className="tabular-nums-mono mt-1 block w-28 rounded-[8px] border border-hairline bg-page px-2.5 py-1 text-[12.5px] text-ink"
                        />
                      </label>
                      <label className="text-[12px] text-ink-muted">
                        经度
                        <input
                          type="text"
                          value={draft.lng}
                          onChange={(e) =>
                            setCoordsDraft((prev) => ({
                              ...prev,
                              [item.id]: { ...draft, lng: e.target.value },
                            }))
                          }
                          className="tabular-nums-mono mt-1 block w-28 rounded-[8px] border border-hairline bg-page px-2.5 py-1 text-[12.5px] text-ink"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          const parsedLat = Number(draft.lat);
                          const parsedLng = Number(draft.lng);
                          setMapPickerTarget({
                            kind: 'pending',
                            mediaId: item.id,
                            title: `地图选点 · ${item.name}`,
                            lat: draft.lat.trim() && Number.isFinite(parsedLat) ? parsedLat : item.lat,
                            lng: draft.lng.trim() && Number.isFinite(parsedLng) ? parsedLng : item.lng,
                          });
                        }}
                        className="inline-flex min-h-[34px] items-center gap-1 rounded-full border border-hairline bg-surface px-3 text-[12px] text-ink hover:bg-surface-hover"
                      >
                        <MapPin className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                        <span>地图选点</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void confirmCoordinates(item)}
                        className="min-h-[34px] rounded-full bg-cta-bg px-4 text-[12.5px] font-medium text-cta-text"
                      >
                        确认定位
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Journey Editor */}
      <section className="rounded-[20px] bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-[18px] font-medium text-ink">旅程编排与公开控制</h2>
          <div className="flex flex-wrap gap-2">
            {snapshot.library.journeys.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => {
                  setEditingJourney({ ...j });
                  setCopiedShareLink(false);
                }}
                className={[
                  'min-h-[32px] rounded-full px-3 text-[12.5px]',
                  editingJourney.id === j.id
                    ? 'bg-cta-bg font-medium text-cta-text'
                    : 'bg-page text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {j.title} ({j.visibility === 'public' ? '公开' : '私密'})
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setEditingJourney({
                  ...createBlankJourney(snapshot.library.journeys.length),
                  title: '新旅程',
                });
                setCopiedShareLink(false);
              }}
              className="inline-flex min-h-[32px] items-center gap-1 rounded-full border border-hairline bg-page px-3 text-[12.5px] text-ink"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>新建旅程</span>
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-[12.5px] text-ink-muted">
            标题
            <input
              type="text"
              value={editingJourney.title}
              onChange={(e) => setEditingJourney((p) => ({ ...p, title: e.target.value }))}
              className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            副标题
            <input
              type="text"
              value={editingJourney.subtitle}
              onChange={(e) => setEditingJourney((p) => ({ ...p, subtitle: e.target.value }))}
              className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            开始日期
            <input
              type="date"
              value={editingJourney.startDate.slice(0, 10)}
              onChange={(e) => {
                const nextStart = e.target.value;
                setEditingJourney((p) => ({
                  ...p,
                  startDate: nextStart,
                  endDate: p.endDate.slice(0, 10) < nextStart ? nextStart : p.endDate,
                }));
              }}
              className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            结束日期
            <input
              type="date"
              value={editingJourney.endDate.slice(0, 10)}
              onChange={(e) => setEditingJourney((p) => ({ ...p, endDate: e.target.value }))}
              className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            可见状态
            <select
              value={editingJourney.visibility}
              onChange={(e) =>
                setEditingJourney((p) => ({
                  ...p,
                  visibility: e.target.value === 'public' ? 'public' : 'private',
                }))
              }
              className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
            >
              <option value="private">私密（仅管理员）</option>
              <option value="public">公开展示</option>
            </select>
          </label>
        </div>

        {/* Cover selector */}
        <div className="mt-5 rounded-[16px] border border-hairline bg-paper p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-ink">旅程封面影像</span>
            {editingJourney.coverId && (
              <button
                type="button"
                onClick={() => setEditingJourney((p) => ({ ...p, coverId: null }))}
                className="text-[12px] text-ink-muted hover:text-ink"
              >
                清除封面
              </button>
            )}
          </div>
          {coverCandidates.length === 0 ? (
            <p className="mt-2 mb-0 text-[12.5px] text-ink-muted">
              上传并确认坐标后，可在此点选旅程封面缩略图。
            </p>
          ) : (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {coverCandidates.map((m) => {
                const selected = editingJourney.coverId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() =>
                      setEditingJourney((p) => ({
                        ...p,
                        coverId: p.coverId === m.id ? null : m.id,
                      }))
                    }
                    className={[
                      'relative flex items-center gap-2 rounded-[10px] border p-1 pr-2.5 text-left transition-colors',
                      selected
                        ? 'border-accent bg-surface'
                        : 'border-hairline bg-page hover:border-hairline-strong',
                    ].join(' ')}
                  >
                    <img
                      src={`/api/files/${m.id}?variant=thumbnail`}
                      alt={m.caption || m.name}
                      loading="lazy"
                      className="h-9 w-12 rounded-[6px] object-cover"
                    />
                    <span className="max-w-[110px] truncate text-[12px] text-ink">{m.name}</span>
                    {selected && <Check className="h-3.5 w-3.5 text-accent" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Private Companion Share Link */}
        <div className="mt-4 rounded-[16px] border border-hairline bg-paper p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Link2 className="h-4 w-4 text-postmark" aria-hidden="true" />
              <span className="text-[13px] font-medium text-ink">同行私密分享链接</span>
              {shareTokenUnsaved && (
                <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-postmark">
                  未保存
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!editingJourney.shareToken ? (
                <button
                  type="button"
                  onClick={() =>
                    setEditingJourney((p) => ({ ...p, shareToken: generateShareToken(20) }))
                  }
                  className="min-h-[30px] rounded-full bg-surface px-3 text-[12px] font-medium text-ink hover:bg-surface-hover"
                >
                  生成同行链接
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void handleCopyCompanionLink()}
                    className="inline-flex min-h-[30px] items-center gap-1 rounded-full bg-cta-bg px-3 text-[12px] font-medium text-cta-text"
                  >
                    <Copy className="h-3 w-3" aria-hidden="true" />
                    <span>{copiedShareLink ? '已复制链接' : '复制同行链接'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingJourney((p) => ({ ...p, shareToken: generateShareToken(20) }))
                    }
                    className="inline-flex min-h-[30px] items-center gap-1 rounded-full bg-surface px-3 text-[12px] text-ink hover:bg-surface-hover"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    <span>重置口令</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingJourney((p) => ({ ...p, shareToken: null }))}
                    className="min-h-[30px] rounded-full bg-surface px-3 text-[12px] text-postmark hover:bg-surface-hover"
                  >
                    撤销链接
                  </button>
                </>
              )}
            </div>
          </div>

          {editingJourney.shareToken ? (
            <div className="mt-2.5 space-y-1">
              <div className="tabular-nums-mono overflow-x-auto rounded-[10px] border border-hairline bg-page px-3 py-2 text-[12px] text-ink">
                {companionShareUrl}
              </div>
              <p className="m-0 text-[12px] text-ink-muted">
                凭此链接可直接免登录阅览私密旅程及其关联照片；变更后请点击下方「保存旅程」生效。
              </p>
            </div>
          ) : (
            <p className="mt-1.5 mb-0 text-[12px] text-ink-muted">
              为私密旅程生成随机 20 位同行令牌后，仅持有该链接的同伴可在旅图页查看，无需登录整理台。
            </p>
          )}
        </div>

        {/* Stops list */}
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-ink">站点列表与排序</span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleAutoClusterStops}
                className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-hairline bg-page px-3.5 text-[12.5px] text-ink hover:bg-surface-hover"
              >
                <Layers className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                <span>按时空自动归集站点</span>
              </button>
              <button
                type="button"
                onClick={addStop}
                className="inline-flex min-h-[32px] items-center gap-1 rounded-full bg-page px-3 text-[12.5px] text-ink hover:bg-surface-hover"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>添加站点</span>
              </button>
            </div>
          </div>

          {editingJourney.stops.map((stop, idx) => (
            <div key={stop.id} className="rounded-[16px] border border-hairline bg-paper p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="tabular-nums-mono text-[12px] text-ink-muted">
                  第 {idx + 1} 站
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setMapPickerTarget({
                        kind: 'stop',
                        stopIndex: idx,
                        title: `第 ${idx + 1} 站选点 · ${stop.name || '未命名站点'}`,
                        lat: stop.lat,
                        lng: stop.lng,
                      })
                    }
                    className="inline-flex min-h-[28px] items-center gap-1 rounded-full border border-hairline bg-page px-2.5 text-[12px] text-ink hover:bg-surface-hover"
                  >
                    <MapPin className="h-3 w-3 text-accent" aria-hidden="true" />
                    <span>地图选点</span>
                  </button>
                  <button
                    type="button"
                    disabled={stop.mediaIds.length === 0}
                    onClick={() => absorbFirstPhotoMeta(idx)}
                    className="inline-flex min-h-[28px] items-center gap-1 rounded-full border border-hairline bg-page px-2.5 text-[12px] text-ink hover:bg-surface-hover disabled:opacity-40"
                  >
                    <Crosshair className="h-3 w-3 text-postmark" aria-hidden="true" />
                    <span>吸取首图坐标与日期</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStop(idx, -1)}
                    disabled={idx === 0}
                    aria-label="上移站点"
                    className="rounded-full p-1.5 text-ink-muted hover:text-ink disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStop(idx, 1)}
                    disabled={idx === editingJourney.stops.length - 1}
                    aria-label="下移站点"
                    className="rounded-full p-1.5 text-ink-muted hover:text-ink disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingJourney((p) => ({
                        ...p,
                        stops: p.stops.filter((_, i) => i !== idx),
                      }))
                    }
                    aria-label="删除站点"
                    className="rounded-full p-1.5 text-ink-muted hover:text-postmark"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="mt-2.5 grid gap-2.5 sm:grid-cols-5">
                <input
                  type="text"
                  value={stop.name}
                  placeholder="站点名称"
                  onChange={(e) =>
                    setEditingJourney((p) => ({
                      ...p,
                      stops: p.stops.map((s, i) => (i === idx ? { ...s, name: e.target.value } : s)),
                    }))
                  }
                  className="rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[13px] text-ink"
                />
                <input
                  type="text"
                  value={stop.region}
                  placeholder="地区（可选）"
                  onChange={(e) =>
                    setEditingJourney((p) => ({
                      ...p,
                      stops: p.stops.map((s, i) =>
                        i === idx ? { ...s, region: e.target.value } : s,
                      ),
                    }))
                  }
                  className="rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[13px] text-ink"
                />
                <input
                  type="number"
                  step="0.0001"
                  value={stop.lat}
                  placeholder="纬度"
                  onChange={(e) =>
                    setEditingJourney((p) => ({
                      ...p,
                      stops: p.stops.map((s, i) =>
                        i === idx ? { ...s, lat: Number(e.target.value) } : s,
                      ),
                    }))
                  }
                  className="tabular-nums-mono rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[13px] text-ink"
                />
                <input
                  type="number"
                  step="0.0001"
                  value={stop.lng}
                  placeholder="经度"
                  onChange={(e) =>
                    setEditingJourney((p) => ({
                      ...p,
                      stops: p.stops.map((s, i) =>
                        i === idx ? { ...s, lng: Number(e.target.value) } : s,
                      ),
                    }))
                  }
                  className="tabular-nums-mono rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[13px] text-ink"
                />
                <input
                  type="date"
                  value={stop.date.slice(0, 10)}
                  onChange={(e) =>
                    setEditingJourney((p) => ({
                      ...p,
                      stops: p.stops.map((s, i) => (i === idx ? { ...s, date: e.target.value } : s)),
                    }))
                  }
                  className="tabular-nums-mono rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[13px] text-ink"
                />
              </div>

              <textarea
                rows={2}
                value={stop.note}
                placeholder="两行站点手记"
                onChange={(e) =>
                  setEditingJourney((p) => ({
                    ...p,
                    stops: p.stops.map((s, i) => (i === idx ? { ...s, note: e.target.value } : s)),
                  }))
                }
                className="font-editorial-serif mt-2 w-full rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[13px] text-ink"
              />

              {/* Stop Photo Picker */}
              <div className="mt-3 rounded-[12px] border border-hairline bg-surface/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="tabular-nums-mono text-[12px] font-medium text-ink">
                    站点关联影像（已选 {stop.mediaIds.length} 张）
                  </span>
                  {stop.mediaIds.length > 0 && (
                    <span className="text-[11.5px] text-ink-muted">
                      第一张将作为站点首图与坐标吸取来源
                    </span>
                  )}
                </div>

                {/* Ordered selected photos */}
                {stop.mediaIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {stop.mediaIds.map((mid, mIdx) => {
                      const media = mediaById.get(mid);
                      return (
                        <div
                          key={mid}
                          className="flex items-center gap-1.5 rounded-[10px] border border-accent/40 bg-paper p-1 pr-2"
                        >
                          <img
                            src={`/api/files/${mid}?variant=thumbnail`}
                            alt={media?.name ?? mid}
                            loading="lazy"
                            className="h-8 w-10 rounded-[6px] object-cover"
                          />
                          <div className="min-w-0 max-w-[96px]">
                            <div className="truncate text-[11.5px] font-medium text-ink">
                              {media?.name ?? mid}
                            </div>
                            {mIdx === 0 && (
                              <div className="text-[10.5px] text-accent">首图</div>
                            )}
                          </div>
                          <div className="flex items-center">
                            <button
                              type="button"
                              disabled={mIdx === 0}
                              onClick={() => moveStopMedia(idx, mIdx, -1)}
                              aria-label="左移照片"
                              className="rounded p-0.5 text-ink-muted hover:text-ink disabled:opacity-30"
                            >
                              <ArrowLeft className="h-3 w-3" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              disabled={mIdx === stop.mediaIds.length - 1}
                              onClick={() => moveStopMedia(idx, mIdx, 1)}
                              aria-label="右移照片"
                              className="rounded p-0.5 text-ink-muted hover:text-ink disabled:opacity-30"
                            >
                              <ArrowRight className="h-3 w-3" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleStopMedia(idx, mid)}
                              aria-label={`取消关联 ${media?.name ?? mid}`}
                              className="rounded p-0.5 text-ink-muted hover:text-postmark"
                            >
                              <X className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Pool toggle chips */}
                {confirmedMedia.length > 0 ? (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {confirmedMedia.map((m) => {
                      const bound = stop.mediaIds.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => toggleStopMedia(idx, m.id)}
                          aria-pressed={bound}
                          className={[
                            'inline-flex items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-1 text-[11.5px] transition-colors',
                            bound
                              ? 'border-accent bg-page font-medium text-accent'
                              : 'border-hairline bg-page/80 text-ink-muted hover:text-ink',
                          ].join(' ')}
                        >
                          <img
                            src={`/api/files/${m.id}?variant=thumbnail`}
                            alt=""
                            loading="lazy"
                            className="h-5 w-5 rounded-full object-cover"
                          />
                          <span className="max-w-[100px] truncate">{m.name}</span>
                          {bound && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-2 mb-0 text-[12px] text-ink-muted">
                    暂无可选的已定位影像，请先上传并确认照片坐标。
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={savingJourney}
            onClick={() => void saveJourney()}
            className="pill-cta-primary"
          >
            {savingJourney ? '正在保存…' : '保存旅程'}
          </button>
          {snapshot.library.journeys.some((j) => j.id === editingJourney.id) && (
            <button
              type="button"
              onClick={() => void trashRecord('journey', editingJourney.id)}
              className="pill-cta-secondary"
            >
              移入回收站
            </button>
          )}
        </div>
      </section>

      <AdminMapPicker
        open={mapPickerTarget !== null}
        title={mapPickerTarget?.title ?? '地图选点'}
        initialLat={mapPickerTarget?.lat ?? null}
        initialLng={mapPickerTarget?.lng ?? null}
        onClose={() => setMapPickerTarget(null)}
        onConfirm={({ lat, lng }) => {
          if (!mapPickerTarget) return;
          if (mapPickerTarget.kind === 'pending') {
            const media = mediaById.get(mapPickerTarget.mediaId);
            setCoordsDraft((prev) => {
              const existing = prev[mapPickerTarget.mediaId] ?? {
                lat: '',
                lng: '',
                caption: media?.caption ?? '',
              };
              return {
                ...prev,
                [mapPickerTarget.mediaId]: {
                  ...existing,
                  lat: String(lat),
                  lng: String(lng),
                },
              };
            });
            onStatus(`已选定坐标 ${lat.toFixed(4)}, ${lng.toFixed(4)}，请点击「确认定位」保存。`);
          } else {
            const targetIdx = mapPickerTarget.stopIndex;
            setEditingJourney((prev) => ({
              ...prev,
              stops: prev.stops.map((s, i) => (i === targetIdx ? { ...s, lat, lng } : s)),
            }));
            onStatus(`已更新第 ${targetIdx + 1} 站坐标为 ${lat.toFixed(4)}, ${lng.toFixed(4)}。`);
          }
        }}
      />

      <DarkroomDialog
        photos={darkroomList}
        activeIndex={darkroomIndex}
        onChangeIndex={setDarkroomIndex}
        onClose={() => setDarkroomIndex(null)}
      />
    </div>
  );
}
