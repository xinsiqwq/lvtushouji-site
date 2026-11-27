import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type {
  AdminSnapshot,
  HomeShowcaseFrame,
  Media,
  ProjectItem,
  ProjectLink,
  ProjectMetric,
  SiteSettings,
} from '../../../shared/types';
import { apiJson } from '../../lib/api';
import { formatCoordsCompact } from './exif-cluster';

type ProjectsAdminPanelProps = {
  snapshot: AdminSnapshot;
  onRefresh: () => Promise<void>;
  onStatus: (msg: string) => void;
  onError: (msg: string) => void;
};

const MAX_SHOWCASE_FRAMES = 6;

const LINK_KINDS: Array<{ value: ProjectLink['kind']; label: string }> = [
  { value: 'vault', label: '密匣分发' },
  { value: 'download', label: '直接下载' },
  { value: 'demo', label: '在线体验' },
  { value: 'external', label: '外部主页' },
];

function createEmptyProject(sortOrder: number): ProjectItem {
  const stamp = Date.now().toString(36);
  return {
    id: `proj_${stamp}`,
    slug: `project-${stamp}`,
    title: '',
    subtitle: '',
    summary: '',
    category: '实用工具',
    version: '0.1.0',
    status: 'draft',
    stack: [],
    highlights: [],
    metrics: [],
    links: [],
    requirements: '',
    coverUrl: null,
    sortOrder,
    updatedAt: new Date().toISOString(),
  };
}

function slugifyTitle(input: string): string {
  const ascii = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || `project-${Date.now().toString(36)}`;
}

export function ProjectsAdminPanel({
  snapshot,
  onRefresh,
  onStatus,
  onError,
}: ProjectsAdminPanelProps) {
  const [projects, setProjects] = useState<ProjectItem[]>(() => snapshot.projects ?? []);
  const [editing, setEditing] = useState<ProjectItem>(() =>
    snapshot.projects?.[0] ? { ...snapshot.projects[0] } : createEmptyProject(0),
  );
  const [stackText, setStackText] = useState(() => (snapshot.projects?.[0]?.stack ?? []).join(', '));
  const [highlightsText, setHighlightsText] = useState(() =>
    (snapshot.projects?.[0]?.highlights ?? []).join('\n'),
  );
  const [savingProject, setSavingProject] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Section B: Site settings + Home showcase
  const [siteTitle, setSiteTitle] = useState(() => snapshot.settings.title);
  const [siteTagline, setSiteTagline] = useState(() => snapshot.settings.tagline);
  const [showcaseFrames, setShowcaseFrames] = useState<HomeShowcaseFrame[]>(
    () => snapshot.settings.homeShowcase ?? [],
  );
  const [savingSettings, setSavingSettings] = useState(false);

  // Sync projects list from snapshot or live endpoint
  useEffect(() => {
    if (Array.isArray(snapshot.projects)) {
      setProjects(snapshot.projects);
    }
  }, [snapshot.projects]);

  useEffect(() => {
    apiJson<{ projects: ProjectItem[] }>('/api/admin/projects')
      .then((res) => {
        if (Array.isArray(res.projects)) {
          setProjects(res.projects);
        }
      })
      .catch(() => {
        /* Fallback to snapshot.projects */
      });
  }, []);

  useEffect(() => {
    setSiteTitle(snapshot.settings.title);
    setSiteTagline(snapshot.settings.tagline);
    setShowcaseFrames(snapshot.settings.homeShowcase ?? []);
  }, [snapshot.settings]);

  const confirmedMedia = useMemo(
    () => snapshot.library.media.filter((m) => m.confirmed && m.lat !== null && m.lng !== null),
    [snapshot.library.media],
  );

  // Map mediaId -> stop name for auto-filling place label when picking library photos
  const mediaPlaceMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const j of snapshot.library.journeys) {
      for (const s of j.stops) {
        const placeLabel = [s.region, s.name].filter(Boolean).join(' · ') || s.name;
        for (const mid of s.mediaIds) {
          if (!map.has(mid)) map.set(mid, placeLabel);
        }
      }
    }
    return map;
  }, [snapshot.library.journeys]);

  const selectProject = (proj: ProjectItem) => {
    setEditing({
      ...proj,
      metrics: proj.metrics.map((m) => ({ ...m })),
      links: proj.links.map((l) => ({ ...l })),
    });
    setStackText(proj.stack.join(', '));
    setHighlightsText(proj.highlights.join('\n'));
    setConfirmDeleteId(null);
  };

  const startNewProject = () => {
    const draft = createEmptyProject(projects.length);
    setEditing(draft);
    setStackText('');
    setHighlightsText('');
    setConfirmDeleteId(null);
  };

  const handleToggleStatus = async (proj: ProjectItem) => {
    setTogglingId(proj.id);
    onError('');
    try {
      const nextStatus: ProjectItem['status'] = proj.status === 'published' ? 'draft' : 'published';
      const res = await apiJson<{ project: ProjectItem }>('/api/admin/projects', {
        method: 'POST',
        json: { ...proj, status: nextStatus },
      });
      setProjects((prev) => prev.map((p) => (p.id === proj.id ? res.project : p)));
      if (editing.id === proj.id) {
        setEditing((prev) => ({ ...prev, status: res.project.status, updatedAt: res.project.updatedAt }));
      }
      await onRefresh();
      onStatus(`作品「${res.project.title}」已切换为${nextStatus === 'published' ? '已发布' : '草稿'}。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '切换发布状态失败');
    } finally {
      setTogglingId(null);
    }
  };

  const handleSaveProject = async () => {
    if (!editing.title.trim()) {
      onError('请填写作品名称。');
      return;
    }
    const rawSlug = (editing.slug.trim() || slugifyTitle(editing.title))
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[^a-z0-9]+/, '');
    const cleanSlug = rawSlug || slugifyTitle(editing.title);
    const stack = stackText
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const highlights = highlightsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const metrics: ProjectMetric[] = editing.metrics
      .map((m) => ({ label: m.label.trim(), value: m.value.trim() }))
      .filter((m) => m.label && m.value);
    const links: ProjectLink[] = editing.links
      .map((l) => ({
        label: l.label.trim(),
        href: l.href.trim(),
        kind: l.kind,
        ...(l.vaultCode?.trim() ? { vaultCode: l.vaultCode.trim() } : {}),
        ...(l.note?.trim() ? { note: l.note.trim() } : {}),
      }))
      .filter((l) => l.label && l.href);

    setSavingProject(true);
    onError('');
    try {
      const payload: ProjectItem = {
        ...editing,
        slug: cleanSlug,
        title: editing.title.trim(),
        subtitle: editing.subtitle.trim(),
        summary: editing.summary.trim(),
        category: editing.category.trim() || '工程作品',
        version: editing.version.trim() || '1.0.0',
        stack,
        highlights,
        metrics,
        links,
        requirements: editing.requirements?.trim() || '',
        coverUrl: editing.coverUrl?.trim() ? editing.coverUrl.trim() : null,
        sortOrder: Number.isFinite(editing.sortOrder) ? Math.round(editing.sortOrder) : 0,
      };
      const res = await apiJson<{ project: ProjectItem }>('/api/admin/projects', {
        method: 'POST',
        json: payload,
      });
      selectProject(res.project);
      setProjects((prev) => {
        const exists = prev.some((p) => p.id === res.project.id);
        const next = exists
          ? prev.map((p) => (p.id === res.project.id ? res.project : p))
          : [...prev, res.project];
        return next.sort((a, b) => a.sortOrder - b.sortOrder);
      });
      await onRefresh();
      onStatus(`作品「${res.project.title}」已保存。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存作品失败');
    } finally {
      setSavingProject(false);
    }
  };

  const handleDeleteProject = async (proj: ProjectItem) => {
    onError('');
    try {
      await apiJson(`/api/admin/projects/${encodeURIComponent(proj.id)}`, {
        method: 'DELETE',
      });
      const remaining = projects.filter((p) => p.id !== proj.id);
      setProjects(remaining);
      setConfirmDeleteId(null);
      if (editing.id === proj.id) {
        if (remaining[0]) {
          selectProject(remaining[0]);
        } else {
          startNewProject();
        }
      }
      await onRefresh();
      onStatus(`已删除作品「${proj.title}」。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '删除作品失败');
    }
  };

  const addMediaShowcaseFrame = (media: Media) => {
    if (showcaseFrames.length >= MAX_SHOWCASE_FRAMES) {
      onError(`首页山海精选展台最多配置 ${MAX_SHOWCASE_FRAMES} 幅画作。`);
      return;
    }
    const coords =
      media.lat !== null && media.lng !== null ? formatCoordsCompact(media.lat, media.lng) : '';
    const frame: HomeShowcaseFrame = {
      id: `frame_${media.id}_${Date.now().toString(36)}`,
      src: `/api/files/${media.id}?variant=preview`,
      alt: media.caption || media.name,
      place: mediaPlaceMap.get(media.id) || media.name.replace(/\.[^.]+$/, ''),
      coords,
      caption: media.caption || '',
      mediaId: media.id,
      width: media.width,
      height: media.height,
    };
    setShowcaseFrames((prev) => [...prev, frame]);
  };

  const addCustomShowcaseFrame = () => {
    if (showcaseFrames.length >= MAX_SHOWCASE_FRAMES) {
      onError(`首页山海精选展台最多配置 ${MAX_SHOWCASE_FRAMES} 幅画作。`);
      return;
    }
    const frame: HomeShowcaseFrame = {
      id: `frame_${Date.now().toString(36)}`,
      src: '/demo/mountain.jpg',
      alt: '山海精选画幅',
      place: '川西高地',
      coords: '30.06°N · 101.96°E',
      caption: '',
      mediaId: null,
      width: 1200,
      height: 800,
    };
    setShowcaseFrames((prev) => [...prev, frame]);
  };

  const moveShowcaseFrame = (index: number, delta: -1 | 1) => {
    setShowcaseFrames((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
  };

  const saveSettings = async (overrideShowcase?: HomeShowcaseFrame[]) => {
    const trimmedTitle = siteTitle.trim();
    if (!trimmedTitle) {
      onError('请填写站点标题。');
      return;
    }
    const nextFrames = overrideShowcase ?? showcaseFrames;
    for (const frame of nextFrames) {
      if (!frame.src.trim().startsWith('/')) {
        onError(`画幅「${frame.place || frame.id}」的图片路径必须以 / 开头（仅限站内或媒体接口路径）。`);
        return;
      }
    }

    setSavingSettings(true);
    onError('');
    try {
      const payload: SiteSettings = {
        title: trimmedTitle,
        tagline: siteTagline.trim(),
        homeShowcase: nextFrames.map((f) => ({
          id: f.id.trim() || `frame_${Date.now().toString(36)}`,
          src: f.src.trim(),
          alt: f.alt.trim() || f.place.trim() || '山海精选',
          place: f.place.trim() || '旅途一隅',
          coords: f.coords.trim(),
          caption: f.caption.trim(),
          mediaId: f.mediaId ?? null,
          ...(f.width && Number.isFinite(f.width) ? { width: Math.round(f.width) } : {}),
          ...(f.height && Number.isFinite(f.height) ? { height: Math.round(f.height) } : {}),
        })),
      };
      const updated = await apiJson<SiteSettings>('/api/admin/settings', {
        method: 'PATCH',
        json: payload,
      });
      setSiteTitle(updated.title);
      setSiteTagline(updated.tagline);
      setShowcaseFrames(updated.homeShowcase ?? []);
      await onRefresh();
      onStatus(
        overrideShowcase && overrideShowcase.length === 0
          ? '已重置为默认首页演示画幅。'
          : '首页与站点展台配置已保存。',
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存首页配置失败');
    } finally {
      setSavingSettings(false);
    }
  };

  const isExistingProject = projects.some((p) => p.id === editing.id);

  return (
    <div className="space-y-8">
      {/* Section A: Jupiter Projects Showcase Management */}
      <section className="rounded-[20px] bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-[18px] font-medium text-ink">木星「作品集展柜」管理</h2>
            <p className="mt-1 mb-0 text-[13px] text-ink-muted">
              维护公开展示的个人工程与桌面作品；草稿状态仅在整理台可见。
            </p>
          </div>
          <button
            type="button"
            onClick={startNewProject}
            className="inline-flex min-h-[34px] items-center gap-1 rounded-full border border-hairline bg-page px-3.5 text-[12.5px] text-ink hover:bg-surface-hover"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>新建作品</span>
          </button>
        </div>

        {/* Project cards list */}
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {projects.map((proj) => {
            const active = editing.id === proj.id;
            return (
              <div
                key={proj.id}
                className={[
                  'flex flex-col justify-between gap-3 rounded-[16px] border p-4 transition-colors',
                  active
                    ? 'border-accent bg-paper'
                    : 'border-hairline bg-paper/75 hover:bg-paper',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => selectProject(proj)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[14.5px] font-medium text-ink">
                        {proj.title}
                      </span>
                      <span className="tabular-nums-mono rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-muted">
                        v{proj.version}
                      </span>
                    </div>
                    <div className="mt-1 text-[12.5px] text-ink-muted">
                      {proj.category}
                      {proj.subtitle ? ` · ${proj.subtitle}` : ''}
                    </div>
                  </button>
                  <span
                    className={[
                      'shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px]',
                      proj.status === 'published'
                        ? 'bg-surface font-medium text-accent'
                        : 'bg-surface text-ink-muted',
                    ].join(' ')}
                  >
                    {proj.status === 'published' ? '已发布' : '草稿'}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2.5">
                  <span className="tabular-nums-mono text-[11.5px] text-ink-muted">
                    排序 {proj.sortOrder} · {proj.slug}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={togglingId === proj.id}
                      onClick={() => void handleToggleStatus(proj)}
                      className="min-h-[30px] rounded-full bg-surface px-3 text-[12px] text-ink hover:bg-surface-hover disabled:opacity-50"
                    >
                      {proj.status === 'published' ? '转为草稿' : '公开发布'}
                    </button>
                    <button
                      type="button"
                      onClick={() => selectProject(proj)}
                      className="min-h-[30px] rounded-full bg-surface px-3 text-[12px] text-accent hover:bg-surface-hover"
                    >
                      编辑
                    </button>
                    {confirmDeleteId === proj.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleDeleteProject(proj)}
                          className="min-h-[30px] rounded-full bg-postmark px-3 text-[12px] font-medium text-white"
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="min-h-[30px] rounded-full bg-surface px-2.5 text-[12px] text-ink-muted"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(proj.id)}
                        aria-label={`删除 ${proj.title}`}
                        className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full bg-surface text-ink-muted hover:text-postmark"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Project Editor Form */}
        <div className="mt-6 rounded-[18px] border border-hairline bg-paper p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-[15px] font-medium text-ink">
              {isExistingProject ? `正在编辑：${editing.title || editing.id}` : '新建展柜作品'}
            </h3>
            <span className="tabular-nums-mono text-[12px] text-ink-muted">ID: {editing.id}</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[12.5px] text-ink-muted">
              作品名称
              <input
                type="text"
                value={editing.title}
                onChange={(e) => setEditing((p) => ({ ...p, title: e.target.value }))}
                placeholder="例如：流量观察 · TrafficObserver"
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
              />
            </label>
            <label className="text-[12.5px] text-ink-muted">
              副标题
              <input
                type="text"
                value={editing.subtitle}
                onChange={(e) => setEditing((p) => ({ ...p, subtitle: e.target.value }))}
                placeholder="一句话定位"
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
              />
            </label>
            <label className="text-[12.5px] text-ink-muted">
              分类
              <input
                type="text"
                value={editing.category}
                onChange={(e) => setEditing((p) => ({ ...p, category: e.target.value }))}
                placeholder="Windows 桌面工具"
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
              />
            </label>
            <label className="text-[12.5px] text-ink-muted">
              版本号
              <input
                type="text"
                value={editing.version}
                onChange={(e) => setEditing((p) => ({ ...p, version: e.target.value }))}
                placeholder="1.0.0"
                className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
              />
            </label>

            <label className="text-[12.5px] text-ink-muted">
              URL 标识 (slug)
              <input
                type="text"
                value={editing.slug}
                onChange={(e) => setEditing((p) => ({ ...p, slug: e.target.value }))}
                placeholder="traffic-observer"
                className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
              />
            </label>
            <label className="text-[12.5px] text-ink-muted">
              发布状态
              <select
                value={editing.status}
                onChange={(e) =>
                  setEditing((p) => ({
                    ...p,
                    status: e.target.value === 'published' ? 'published' : 'draft',
                  }))
                }
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
              >
                <option value="published">已发布（公开展示）</option>
                <option value="draft">草稿（仅管理员可见）</option>
              </select>
            </label>
            <label className="text-[12.5px] text-ink-muted">
              排序权重（越小越靠前）
              <input
                type="number"
                value={editing.sortOrder}
                onChange={(e) =>
                  setEditing((p) => ({ ...p, sortOrder: Number(e.target.value) || 0 }))
                }
                className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
              />
            </label>
            <label className="text-[12.5px] text-ink-muted">
              运行环境要求
              <input
                type="text"
                value={editing.requirements ?? ''}
                onChange={(e) => setEditing((p) => ({ ...p, requirements: e.target.value }))}
                placeholder="Windows 10/11 x64 · .NET 8"
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
              />
            </label>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-[12.5px] text-ink-muted">
              技术栈（逗号分隔）
              <input
                type="text"
                value={stackText}
                onChange={(e) => setStackText(e.target.value)}
                placeholder=".NET 8, C#, Windows ETW, WPF"
                className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
              />
            </label>
            <label className="text-[12.5px] text-ink-muted">
              封面站内路径（可选）
              <input
                type="text"
                value={editing.coverUrl ?? ''}
                onChange={(e) => setEditing((p) => ({ ...p, coverUrl: e.target.value || null }))}
                placeholder="/api/files/... 或留空"
                className="tabular-nums-mono mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13px] text-ink"
              />
            </label>
          </div>

          <label className="mt-3 block text-[12.5px] text-ink-muted">
            作品简介
            <textarea
              rows={2}
              value={editing.summary}
              onChange={(e) => setEditing((p) => ({ ...p, summary: e.target.value }))}
              placeholder="简明描述作品解决的核心问题与设计取舍"
              className="font-editorial-serif mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-2 text-[13.5px] text-ink"
            />
          </label>

          <label className="mt-3 block text-[12.5px] text-ink-muted">
            核心工程亮点（每行一条）
            <textarea
              rows={4}
              value={highlightsText}
              onChange={(e) => setHighlightsText(e.target.value)}
              placeholder="每行输入一条工程实现或特性要点"
              className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-2 text-[13px] text-ink"
            />
          </label>

          {/* Metrics rows */}
          <div className="mt-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-ink">实测指标条</span>
              <button
                type="button"
                onClick={() =>
                  setEditing((p) => ({
                    ...p,
                    metrics: [...p.metrics, { label: '', value: '' }],
                  }))
                }
                className="inline-flex min-h-[28px] items-center gap-1 rounded-full bg-surface px-3 text-[12px] text-ink hover:bg-surface-hover"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                <span>添加指标</span>
              </button>
            </div>
            {editing.metrics.length > 0 && (
              <div className="mt-2 space-y-2">
                {editing.metrics.map((metric, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={metric.label}
                      placeholder="指标名（如：核心检查）"
                      onChange={(e) =>
                        setEditing((p) => ({
                          ...p,
                          metrics: p.metrics.map((m, i) =>
                            i === idx ? { ...m, label: e.target.value } : m,
                          ),
                        }))
                      }
                      className="min-w-[140px] flex-1 rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink"
                    />
                    <input
                      type="text"
                      value={metric.value}
                      placeholder="数值（如：25/25 通过）"
                      onChange={(e) =>
                        setEditing((p) => ({
                          ...p,
                          metrics: p.metrics.map((m, i) =>
                            i === idx ? { ...m, value: e.target.value } : m,
                          ),
                        }))
                      }
                      className="tabular-nums-mono min-w-[140px] flex-1 rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setEditing((p) => ({
                          ...p,
                          metrics: p.metrics.filter((_, i) => i !== idx),
                        }))
                      }
                      aria-label="删除此指标"
                      className="rounded-full p-1.5 text-ink-muted hover:text-postmark"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Links rows */}
          <div className="mt-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-ink">分发与访问链接</span>
              <button
                type="button"
                onClick={() =>
                  setEditing((p) => ({
                    ...p,
                    links: [
                      ...p.links,
                      { label: '密匣获取', href: '/vault', kind: 'vault', note: '' },
                    ],
                  }))
                }
                className="inline-flex min-h-[28px] items-center gap-1 rounded-full bg-surface px-3 text-[12px] text-ink hover:bg-surface-hover"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                <span>添加链接</span>
              </button>
            </div>
            {editing.links.length > 0 && (
              <div className="mt-2 space-y-2.5">
                {editing.links.map((link, idx) => (
                  <div
                    key={idx}
                    className="grid gap-2 rounded-[12px] border border-hairline bg-surface/60 p-3 sm:grid-cols-12"
                  >
                    <input
                      type="text"
                      value={link.label}
                      placeholder="按钮文字"
                      onChange={(e) =>
                        setEditing((p) => ({
                          ...p,
                          links: p.links.map((l, i) =>
                            i === idx ? { ...l, label: e.target.value } : l,
                          ),
                        }))
                      }
                      className="rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink sm:col-span-3"
                    />
                    <input
                      type="text"
                      value={link.href}
                      placeholder="/vault 或 https://..."
                      onChange={(e) =>
                        setEditing((p) => ({
                          ...p,
                          links: p.links.map((l, i) =>
                            i === idx ? { ...l, href: e.target.value } : l,
                          ),
                        }))
                      }
                      className="tabular-nums-mono rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink sm:col-span-3"
                    />
                    <select
                      value={link.kind}
                      onChange={(e) =>
                        setEditing((p) => ({
                          ...p,
                          links: p.links.map((l, i) =>
                            i === idx
                              ? { ...l, kind: e.target.value as ProjectLink['kind'] }
                              : l,
                          ),
                        }))
                      }
                      className="rounded-[8px] border border-hairline bg-page px-2 py-1.5 text-[12.5px] text-ink sm:col-span-2"
                    >
                      {LINK_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={link.vaultCode ?? ''}
                      maxLength={6}
                      placeholder="口令(可选)"
                      onChange={(e) =>
                        setEditing((p) => ({
                          ...p,
                          links: p.links.map((l, i) =>
                            i === idx ? { ...l, vaultCode: e.target.value } : l,
                          ),
                        }))
                      }
                      className="tabular-nums-mono rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink sm:col-span-2"
                    />
                    <div className="flex items-center justify-end gap-1 sm:col-span-2">
                      <button
                        type="button"
                        onClick={() =>
                          setEditing((p) => ({
                            ...p,
                            links: p.links.filter((_, i) => i !== idx),
                          }))
                        }
                        aria-label="删除此链接"
                        className="rounded-full p-1.5 text-ink-muted hover:text-postmark"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={link.note ?? ''}
                      placeholder="附注说明（如：经密匣按口令定向分发，含 SHA-256 校验）"
                      onChange={(e) =>
                        setEditing((p) => ({
                          ...p,
                          links: p.links.map((l, i) =>
                            i === idx ? { ...l, note: e.target.value } : l,
                          ),
                        }))
                      }
                      className="rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12px] text-ink sm:col-span-12"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={savingProject}
              onClick={() => void handleSaveProject()}
              className="pill-cta-primary"
            >
              {savingProject ? '正在保存…' : '保存作品'}
            </button>
          </div>
        </div>
      </section>

      {/* Section B: Home Showcase & Site Settings */}
      <section className="rounded-[20px] bg-surface p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-[18px] font-medium text-ink">首页山海精选展台配置</h2>
            <p className="mt-1 mb-0 text-[13px] text-ink-muted">
              自定义站点标题、引言以及首页精选画幅（最多 {MAX_SHOWCASE_FRAMES} 幅；留空则使用默认演示画幅）。
            </p>
          </div>
          <button
            type="button"
            disabled={savingSettings}
            onClick={() => void saveSettings([])}
            className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-hairline bg-page px-3.5 text-[12.5px] text-ink hover:bg-surface-hover disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>恢复默认画幅</span>
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-[12.5px] text-ink-muted">
            站点标题
            <input
              type="text"
              maxLength={24}
              value={siteTitle}
              onChange={(e) => setSiteTitle(e.target.value)}
              className="mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
            />
          </label>
          <label className="text-[12.5px] text-ink-muted">
            站点引言
            <input
              type="text"
              maxLength={180}
              value={siteTagline}
              onChange={(e) => setSiteTagline(e.target.value)}
              className="font-editorial-serif mt-1 block w-full rounded-[10px] border border-hairline bg-page px-3 py-1.5 text-[13.5px] text-ink"
            />
          </label>
        </div>

        {/* Pick from confirmed media library */}
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-ink">
              从已定位影像库选入展台（{showcaseFrames.length} / {MAX_SHOWCASE_FRAMES}）
            </span>
            <button
              type="button"
              disabled={showcaseFrames.length >= MAX_SHOWCASE_FRAMES}
              onClick={addCustomShowcaseFrame}
              className="inline-flex min-h-[30px] items-center gap-1 rounded-full bg-page px-3 text-[12px] text-ink hover:bg-surface-hover disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>添加自定义画幅</span>
            </button>
          </div>

          {confirmedMedia.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {confirmedMedia.map((m) => {
                const alreadyAdded = showcaseFrames.some((f) => f.mediaId === m.id);
                const disabled = alreadyAdded || showcaseFrames.length >= MAX_SHOWCASE_FRAMES;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => addMediaShowcaseFrame(m)}
                    className={[
                      'flex items-center gap-2 rounded-[12px] border p-1.5 pr-3 text-left transition-colors',
                      alreadyAdded
                        ? 'border-accent bg-paper opacity-70'
                        : 'border-hairline bg-paper hover:border-hairline-strong disabled:opacity-45',
                    ].join(' ')}
                  >
                    <img
                      src={`/api/files/${m.id}?variant=thumbnail`}
                      alt={m.caption || m.name}
                      loading="lazy"
                      className="h-9 w-12 rounded-[8px] object-cover"
                    />
                    <div className="min-w-0 max-w-[130px]">
                      <div className="truncate text-[12px] font-medium text-ink">{m.name}</div>
                      <div className="text-[11px] text-ink-muted">
                        {alreadyAdded ? '已在展台' : '点击选入'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="mt-2 mb-0 text-[12.5px] text-ink-muted">
              当前暂无已定位影像，可在「旅图整理」上传定位后直接选入，或点击上方添加自定义站内画幅。
            </p>
          )}
        </div>

        {/* Current configured frames */}
        <div className="mt-5 space-y-3">
          {showcaseFrames.length === 0 ? (
            <div className="rounded-[14px] border border-dashed border-hairline-strong bg-paper/60 px-4 py-5 text-[13px] text-ink-muted">
              当前未设置自定义展台画幅，首页将自动展示 4 幅默认山海演示画幅。
            </div>
          ) : (
            showcaseFrames.map((frame, idx) => (
              <div
                key={frame.id}
                className="flex flex-col gap-3 rounded-[16px] border border-hairline bg-paper p-4 sm:flex-row"
              >
                <div className="h-24 w-full shrink-0 overflow-hidden rounded-[12px] bg-surface sm:w-36">
                  <img
                    src={frame.src}
                    alt={frame.alt || frame.place}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="tabular-nums-mono text-[12px] text-ink-muted">
                      画幅 {idx + 1}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => moveShowcaseFrame(idx, -1)}
                        aria-label="上移画幅"
                        className="rounded-full p-1 text-ink-muted hover:text-ink disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === showcaseFrames.length - 1}
                        onClick={() => moveShowcaseFrame(idx, 1)}
                        aria-label="下移画幅"
                        className="rounded-full p-1 text-ink-muted hover:text-ink disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setShowcaseFrames((prev) => prev.filter((_, i) => i !== idx))
                        }
                        aria-label="移除画幅"
                        className="rounded-full p-1 text-ink-muted hover:text-postmark"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input
                      type="text"
                      value={frame.place}
                      placeholder="地点名称"
                      onChange={(e) =>
                        setShowcaseFrames((prev) =>
                          prev.map((f, i) => (i === idx ? { ...f, place: e.target.value } : f)),
                        )
                      }
                      className="rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink"
                    />
                    <input
                      type="text"
                      value={frame.coords}
                      placeholder="30.06°N · 101.96°E"
                      onChange={(e) =>
                        setShowcaseFrames((prev) =>
                          prev.map((f, i) => (i === idx ? { ...f, coords: e.target.value } : f)),
                        )
                      }
                      className="tabular-nums-mono rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink"
                    />
                    <input
                      type="text"
                      value={frame.src}
                      placeholder="/api/files/... 或 /demo/..."
                      onChange={(e) =>
                        setShowcaseFrames((prev) =>
                          prev.map((f, i) => (i === idx ? { ...f, src: e.target.value } : f)),
                        )
                      }
                      className="tabular-nums-mono rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink"
                    />
                  </div>
                  <input
                    type="text"
                    value={frame.caption}
                    placeholder="一行山海手记配文"
                    onChange={(e) =>
                      setShowcaseFrames((prev) =>
                        prev.map((f, i) => (i === idx ? { ...f, caption: e.target.value } : f)),
                      )
                    }
                    className="font-editorial-serif w-full rounded-[8px] border border-hairline bg-page px-2.5 py-1.5 text-[12.5px] text-ink"
                  />
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-5">
          <button
            type="button"
            disabled={savingSettings}
            onClick={() => void saveSettings()}
            className="pill-cta-primary"
          >
            {savingSettings ? '正在保存…' : '保存首页配置'}
          </button>
        </div>
      </section>
    </div>
  );
}
