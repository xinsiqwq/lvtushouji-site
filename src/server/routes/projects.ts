import { Hono } from 'hono';
import { ApiError } from '../../shared/errors';
import type { ProjectItem, ProjectLink, ProjectMetric } from '../../shared/types';
import { id, object, text } from '../../shared/validators';
import { requireCloudAdmin } from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';

export const projectsRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

const VALID_LINK_KINDS = new Set<ProjectLink['kind']>(['download', 'external', 'vault', 'demo']);

export const SEED_PROJECTS: readonly ProjectItem[] = [
  {
    id: 'proj_traffic_observer',
    slug: 'traffic-observer',
    title: '流量观察 · TrafficObserver',
    subtitle: '面向 Windows 的零驱动进程级实时流量观测器',
    summary:
      '基于 Windows 内核 ETW 事件追踪构建的轻量级桌面网络监测工具，无需安装 NDIS 驱动或接管系统代理，在复杂虚拟网卡与代理环境下清晰拆分每个进程的真实出入站流量。',
    category: 'Windows 桌面工具',
    version: '1.0.0',
    status: 'published',
    stack: ['.NET 8', 'C#', 'Windows ETW', 'WPF'],
    highlights: [
      '零驱动进程级监控：直接订阅 Windows Kernel ETW 网络事件，免驱动、免注入即可精准归属各进程流量',
      'TUN 代理内外层拆分：自动区分虚拟网卡隧道内明文进程流量与外层代理转发流量，杜绝重复统计',
      '物理网卡总账核对：周期性与底层物理 NIC 计数器校准对账，保证长时运行零漂移',
      '本地持久化按日统计：纯本地轻量落盘记录每日与累计流量账单，重启不丢数据',
    ],
    metrics: [
      { label: '核心检查', value: '25/25 通过' },
      { label: '回环字节校验', value: '16/16 零误差' },
      { label: '丢失事件', value: '0' },
      { label: '运行环境', value: '.NET 8 x64' },
    ],
    links: [
      {
        label: '查看发行说明与下载',
        href: '/vault',
        kind: 'vault',
        note: '便携包经密匣按口令定向分发，含 SHA-256 校验',
      },
    ],
    requirements: 'Windows 10/11 x64 · .NET 8 Desktop Runtime',
    coverUrl: null,
    sortOrder: 1,
    updatedAt: '2026-11-20T00:00:00.000Z',
  },
  {
    id: 'proj_videovault_v2',
    slug: 'videovault-v2',
    title: 'VideoVault V2',
    subtitle: '私有视频定制水印分发与双端断点续传系统',
    summary:
      '专为小规模私域影像与教学交付打造的云端与桌面双端系统。桌面制片端以共享解码管线并行渲染独立动态水印，云端依托 Cloudflare Workers 与私有 R2 提供流式断点下载与精确配额控制。',
    category: '云端与桌面双端系统',
    version: '0.7.1',
    status: 'published',
    stack: ['Cloudflare Workers', 'D1 / R2', 'Python / Tk', 'FFmpeg'],
    highlights: [
      '3 次配额与 24 小时续传恢复租约：受控下载次数并在断网 24 小时内凭租约恢复续传，不重复消耗配额',
      '每成员独立动态微信 UID 水印：为每位接收成员嵌入专属动态轨迹与防追踪水印标识',
      '1–4 路共享解码并行管线：单次解码同时喂送多路编码输出，显著压缩批量定制压制耗时',
      '8 MiB 分片断点续传与流式 SHA-256：大体积成片上传边读边校验，断链后精确续传剩余分片',
    ],
    metrics: [
      { label: '配额机制', value: '3 次 / 24h 恢复' },
      { label: '并发压测', value: '100 人独立水印' },
      { label: '长片断续验收', value: '410 秒真中断续传' },
      { label: '私有存储', value: 'R2 Range 206 流式' },
    ],
    links: [
      {
        label: '申请内测体验包',
        href: '/vault',
        kind: 'vault',
        note: '双端便携测试包通过密匣口令定向获取',
      },
    ],
    requirements: '浏览器访问用户端 · Windows 便携制片端',
    coverUrl: null,
    sortOrder: 2,
    updatedAt: '2026-11-21T00:00:00.000Z',
  },
];

export async function ensureProjectsSeeded(db: D1Database): Promise<void> {
  const [seedFlag, countRow] = await Promise.all([
    db
      .prepare("SELECT data FROM admin_settings WHERE key='projects_seeded'")
      .first<{ data: string }>(),
    db.prepare('SELECT COUNT(*) AS cnt FROM projects').first<{ cnt: number }>(),
  ]);
  if (seedFlag || Number(countRow?.cnt ?? 0) > 0) {
    return;
  }

  const statements: D1PreparedStatement[] = SEED_PROJECTS.map((project) =>
    db
      .prepare(
        'INSERT OR IGNORE INTO projects (id, data, sort_order, updated_at) VALUES (?, ?, ?, ?)',
      )
      .bind(project.id, JSON.stringify(project), project.sortOrder, project.updatedAt),
  );
  statements.push(
    db.prepare("INSERT OR IGNORE INTO admin_settings (key, data) VALUES ('projects_seeded', '1')"),
  );
  await db.batch(statements);
}

export async function listAllProjects(db: D1Database): Promise<ProjectItem[]> {
  await ensureProjectsSeeded(db);
  const rows = await db
    .prepare('SELECT data FROM projects ORDER BY sort_order ASC, updated_at DESC, rowid ASC')
    .all<{ data: string }>();
  return rows.results.map((row) => JSON.parse(row.data) as ProjectItem);
}

function validateSafeHref(raw: unknown): string {
  const href = text(raw, '链接地址', 500, true);
  if (href.startsWith('/')) {
    if (href.startsWith('//') || href.includes('..') || /[\s\\]/.test(href)) {
      throw new ApiError('站内链接地址格式无效', 400);
    }
    return href;
  }
  try {
    const parsed = new URL(href);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return href;
    }
  } catch {
    /* Fall through to error */
  }
  throw new ApiError('链接地址必须为站内路径或 http/https 链接', 400);
}

function validateSafeInternalAssetPath(raw: unknown, label: string): string {
  const path = text(raw, label, 300, true);
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || /[\s\\]/.test(path)) {
    throw new ApiError(`${label}必须为站内相对路径（以 / 开头）`, 400);
  }
  return path;
}

function validateStringList(raw: unknown, label: string, maxItems: number, maxLen: number): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError(`${label}必须为数组`, 400);
  }
  if (raw.length > maxItems) {
    throw new ApiError(`${label}最多包含 ${maxItems} 项`, 400);
  }
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new ApiError(`${label}条目必须为文本`, 400);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLen) {
      throw new ApiError(`${label}单条内容超出长度限制（${maxLen}字）`, 400);
    }
    result.push(trimmed);
  }
  return result;
}

function validateMetrics(raw: unknown): ProjectMetric[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError('验证指标必须为数组', 400);
  }
  if (raw.length > 12) {
    throw new ApiError('验证指标最多包含 12 项', 400);
  }
  return raw.map((item) => {
    const entry = object(item);
    return {
      label: text(entry.label, '指标名称', 60, true),
      value: text(entry.value, '指标数值', 120, true),
    };
  });
}

function validateLinks(raw: unknown): ProjectLink[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiError('项目链接必须为数组', 400);
  }
  if (raw.length > 12) {
    throw new ApiError('项目链接最多包含 12 项', 400);
  }
  return raw.map((item) => {
    const entry = object(item);
    const label = text(entry.label, '链接标题', 80, true);
    const href = validateSafeHref(entry.href);
    const kind = entry.kind as ProjectLink['kind'];
    if (typeof kind !== 'string' || !VALID_LINK_KINDS.has(kind)) {
      throw new ApiError('链接类型必须为 download、external、vault 或 demo', 400);
    }
    const link: ProjectLink = { label, href, kind };
    if (entry.vaultCode !== undefined && entry.vaultCode !== null && String(entry.vaultCode).trim() !== '') {
      const code = String(entry.vaultCode).trim();
      if (!/^[A-Za-z0-9]{6}$/.test(code)) {
        throw new ApiError('关联密匣口令必须为 6 位字母或数字', 400);
      }
      link.vaultCode = code;
    }
    if (entry.note !== undefined && entry.note !== null && String(entry.note).trim() !== '') {
      link.note = text(entry.note, '链接说明', 240, false);
    }
    return link;
  });
}

function normalizeSlug(raw: unknown, fallbackId: string): string {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return fallbackId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }
  if (typeof raw !== 'string') {
    throw new ApiError('项目路径标识（slug）必须为文本', 400);
  }
  const trimmed = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(trimmed)) {
    throw new ApiError('项目路径标识（slug）仅支持字母、数字、连字符和下划线', 400);
  }
  return trimmed;
}

projectsRoutes.get('/api/projects', async (c) => {
  const db = c.get('costEnv').DB;
  const all = await listAllProjects(db);
  const projects = all.filter((item) => item.status === 'published');
  return c.json({ projects });
});

projectsRoutes.get('/api/admin/projects', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;
  const projects = await listAllProjects(db);
  return c.json({ projects });
});

projectsRoutes.post('/api/admin/projects', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;
  const body = object(await c.req.json().catch(() => null));

  const projectId =
    body.id !== undefined && body.id !== null && body.id !== ''
      ? id(body.id)
      : `proj_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const slug = normalizeSlug(body.slug, projectId);
  const title = text(body.title, '项目标题', 120, true);
  const subtitle =
    body.subtitle !== undefined && body.subtitle !== null
      ? text(body.subtitle, '项目副标题', 240, false)
      : '';
  const summary =
    body.summary !== undefined && body.summary !== null
      ? text(body.summary, '项目简介', 2000, false)
      : '';
  const category =
    body.category !== undefined && body.category !== null
      ? text(body.category, '项目分类', 80, false)
      : '';
  const version =
    body.version !== undefined && body.version !== null
      ? text(body.version, '版本号', 40, false)
      : '';

  const statusRaw = body.status === undefined ? 'draft' : body.status;
  if (statusRaw !== 'published' && statusRaw !== 'draft') {
    throw new ApiError('项目状态必须为 published 或 draft', 400);
  }

  const stack = validateStringList(body.stack, '技术栈', 24, 60);
  const highlights = validateStringList(body.highlights, '核心亮点', 20, 300);
  const metrics = validateMetrics(body.metrics);
  const links = validateLinks(body.links);

  let requirements: string | undefined;
  if (body.requirements !== undefined && body.requirements !== null && String(body.requirements).trim() !== '') {
    requirements = text(body.requirements, '运行要求', 240, false);
  }

  let coverUrl: string | null = null;
  if (body.coverUrl !== undefined && body.coverUrl !== null && body.coverUrl !== '') {
    coverUrl = validateSafeInternalAssetPath(body.coverUrl, '项目封面路径');
  }

  let sortOrder = 0;
  if (body.sortOrder !== undefined && body.sortOrder !== null) {
    if (
      typeof body.sortOrder !== 'number' ||
      !Number.isFinite(body.sortOrder) ||
      body.sortOrder < -9999 ||
      body.sortOrder > 999999
    ) {
      throw new ApiError('排序权重必须为有效数字', 400);
    }
    sortOrder = Math.round(body.sortOrder);
  }

  const updatedAt = new Date().toISOString();
  const project: ProjectItem = {
    id: projectId,
    slug,
    title,
    subtitle,
    summary,
    category,
    version,
    status: statusRaw,
    stack,
    highlights,
    metrics,
    links,
    ...(requirements ? { requirements } : {}),
    coverUrl,
    sortOrder,
    updatedAt,
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO projects (id, data, sort_order, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data = excluded.data,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      )
      .bind(project.id, JSON.stringify(project), project.sortOrder, project.updatedAt),
    db.prepare("INSERT OR IGNORE INTO admin_settings (key, data) VALUES ('projects_seeded', '1')"),
  ]);

  return c.json({ project });
});

projectsRoutes.delete('/api/admin/projects/:id', async (c) => {
  requireCloudAdmin(c.get('cloudCtx'));
  const db = c.get('costEnv').DB;
  const projectId = id(c.req.param('id'));

  const existing = await db
    .prepare('SELECT id FROM projects WHERE id=?')
    .bind(projectId)
    .first<{ id: string }>();
  if (!existing) {
    throw new ApiError('项目不存在', 404);
  }

  await db.prepare('DELETE FROM projects WHERE id=?').bind(projectId).run();
  return c.json({ ok: true, id: projectId });
});
