import { Zip, ZipPassThrough } from 'fflate';
import { Hono } from 'hono';
import { ApiError } from '../../shared/errors';
import { CLOUD_MEDIA_LIMITS } from '../../shared/media-formats';
import {
  DEFAULT_SITE_SETTINGS,
  type AdminSnapshot,
  type HomeShowcaseFrame,
  type Journey,
  type Library,
  type Media,
  type SiteSettings,
  type TrashItem,
  type TrashKind,
  type VaultFileRecord,
  type VaultVisibility,
} from '../../shared/types';
import { id, object, text } from '../../shared/validators';
import { COST_LIMITS, currentUsageMonth } from '../middleware/cost-limits';
import { requireCloudAdmin } from '../middleware/security';
import type { AppBindings, AppVariables } from '../types';
import { listAllProjects } from './projects';

export const adminRoutes = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

type MediaRow = {
  id: string;
  data: string;
  original: string;
  thumbnail: string;
  preview: string;
  hash: string | null;
};

type VaultFileRow = {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  r2_key: string;
  chunk_count: number;
  visibility: VaultVisibility;
  created_at: string;
};

type TrashRow = {
  key: string;
  kind: TrashKind;
  record_id: string;
  removed_at: string;
  data: string;
};

type SqlValue = string | number | null;
type DumpRow = Record<string, SqlValue>;
type ManifestEntry = { path: string; size: number; sha256: string };
type ObjectInfo = { key: string; size: number; etag: string };

const encoder = new TextEncoder();

function kindOf(value: unknown): TrashKind {
  if (value !== 'journey' && value !== 'media' && value !== 'vault_file') {
    throw new ApiError('无效的回收内容类型');
  }
  return value;
}

function guard(
  db: D1Database,
  condition: string,
  ...values: (string | number | null)[]
): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN ${condition} THEN 1 ELSE json('conflict') END`).bind(...values);
}

async function commitBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      throw new ApiError('资料已发生变化，请刷新后重试', 409);
    }
    throw error;
  }
}

function mapVaultFileRow(row: VaultFileRow): VaultFileRecord {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: Number(row.size),
    sha256: row.sha256,
    r2Key: row.r2_key,
    chunkCount: Number(row.chunk_count),
    visibility: row.visibility,
    createdAt: row.created_at,
  };
}

function parseTrashItem(item: TrashRow): TrashItem {
  if (item.kind === 'vault_file') {
    const row = JSON.parse(item.data) as VaultFileRow;
    const record = mapVaultFileRow(row);
    return {
      key: item.key,
      kind: item.kind,
      id: item.record_id,
      label: record.name,
      removedAt: item.removed_at,
      record,
    };
  }
  const stored = JSON.parse(item.data) as { data: string };
  const record = JSON.parse(stored.data) as Journey | Media;
  return {
    key: item.key,
    kind: item.kind,
    id: item.record_id,
    label: 'title' in record ? record.title : record.name,
    removedAt: item.removed_at,
    record,
  };
}

async function readSiteSettings(db: D1Database): Promise<SiteSettings> {
  const row = await db
    .prepare("SELECT data FROM admin_settings WHERE key='site'")
    .first<{ data: string }>();
  if (!row) return { ...DEFAULT_SITE_SETTINGS };
  try {
    return { ...DEFAULT_SITE_SETTINGS, ...(JSON.parse(row.data) as Partial<SiteSettings>) };
  } catch {
    return { ...DEFAULT_SITE_SETTINGS };
  }
}

async function readWholeLibrary(db: D1Database): Promise<Library> {
  const [journeyRows, mediaRows, settings] = await Promise.all([
    db.prepare('SELECT data FROM journeys ORDER BY rowid DESC').all<{ data: string }>(),
    db.prepare('SELECT data FROM media ORDER BY rowid DESC').all<{ data: string }>(),
    readSiteSettings(db),
  ]);
  return {
    journeys: journeyRows.results.map((r) => JSON.parse(r.data) as Journey),
    media: mediaRows.results.map((r) => JSON.parse(r.data) as Media),
    settings,
    access: { protected: true, role: 'owner' },
  };
}

function sqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApiError('备份包含无效数值', 500);
    return String(value);
  }
  return `CAST(X'${Array.from(encoder.encode(value), (b) => b.toString(16).padStart(2, '0')).join('')}' AS TEXT)`;
}

function validateSafeR2Key(value: unknown, expectedPrefix?: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    !/^[A-Za-z0-9_./-]+$/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new ApiError('备份媒体路径无效', 409);
  }
  if (expectedPrefix && !value.startsWith(expectedPrefix)) {
    throw new ApiError('备份媒体路径归属不匹配', 409);
  }
  return value;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const BACKUP_TABLES = [
  {
    name: 'journeys',
    columns: ['id', 'data'],
    schema: 'CREATE TABLE IF NOT EXISTS journeys (id TEXT PRIMARY KEY, data TEXT NOT NULL);',
  },
  {
    name: 'media',
    columns: ['id', 'data', 'original', 'thumbnail', 'preview', 'hash'],
    schema:
      'CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT NOT NULL, original TEXT NOT NULL, thumbnail TEXT NOT NULL, preview TEXT NOT NULL, hash TEXT);',
  },
  {
    name: 'admin_settings',
    columns: ['key', 'data'],
    schema: 'CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);',
  },
  {
    name: 'admin_trash',
    columns: ['key', 'kind', 'record_id', 'removed_at', 'data'],
    schema:
      "CREATE TABLE IF NOT EXISTS admin_trash (key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('journey', 'media', 'vault_file')), record_id TEXT NOT NULL, removed_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(kind, record_id));",
  },
  {
    name: 'vault_files',
    columns: [
      'id',
      'name',
      'mime',
      'size',
      'sha256',
      'r2_key',
      'chunk_count',
      'visibility',
      'created_at',
    ],
    schema:
      "CREATE TABLE IF NOT EXISTS vault_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, r2_key TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 1, visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'shared')), created_at TEXT NOT NULL);",
  },
  {
    name: 'vault_shares',
    columns: [
      'id',
      'file_id',
      'passcode_hash',
      'passcode_salt',
      'passcode_lookup',
      'note',
      'max_downloads',
      'downloads',
      'expires_at',
      'created_at',
      'revoked_at',
      'prior_expires_at',
    ],
    schema:
      'CREATE TABLE IF NOT EXISTS vault_shares (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, passcode_hash TEXT NOT NULL, passcode_salt TEXT NOT NULL, passcode_lookup TEXT NOT NULL, note TEXT NOT NULL DEFAULT \'\', max_downloads INTEGER NOT NULL, downloads INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, prior_expires_at TEXT);',
  },
  {
    name: 'security_settings',
    columns: ['key', 'value'],
    schema: 'CREATE TABLE IF NOT EXISTS security_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  },
  {
    name: 'projects',
    columns: ['id', 'data', 'sort_order', 'updated_at'],
    schema:
      'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);',
  },
  {
    name: 'arcade_scores',
    columns: ['id', 'game_id', 'player_name', 'score', 'duration_ms', 'meta_json', 'visitor_id', 'created_at'],
    schema:
      "CREATE TABLE IF NOT EXISTS arcade_scores (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_name TEXT NOT NULL, score INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}', visitor_id TEXT NOT NULL, created_at TEXT NOT NULL);",
  },
  {
    name: 'arena_matches',
    columns: [
      'id',
      'room_code',
      'source',
      'mode',
      'winner_team',
      'score_red',
      'score_blue',
      'mvp_name',
      'mvp_kills',
      'mvp_deaths',
      'mvp_headshots',
      'duration_ms',
      'player_count',
      'bot_count',
      'players_json',
      'visitor_id',
      'created_at',
    ],
    schema:
      "CREATE TABLE IF NOT EXISTS arena_matches (id TEXT PRIMARY KEY, room_code TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('online', 'solo')), mode TEXT NOT NULL, winner_team TEXT NOT NULL, score_red INTEGER NOT NULL DEFAULT 0, score_blue INTEGER NOT NULL DEFAULT 0, mvp_name TEXT NOT NULL, mvp_kills INTEGER NOT NULL DEFAULT 0, mvp_deaths INTEGER NOT NULL DEFAULT 0, mvp_headshots INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, player_count INTEGER NOT NULL DEFAULT 1, bot_count INTEGER NOT NULL DEFAULT 0, players_json TEXT NOT NULL DEFAULT '[]', visitor_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);",
  },
] as const;

async function createCloudBackup(env: AppBindings): Promise<Response> {
  const results = await env.DB.batch(
    BACKUP_TABLES.map((table) =>
      env.DB.prepare(`SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`),
    ),
  );
  const rows = results.map((res) => res.results as DumpRow[]);

  const sqlBytes = encoder.encode(
    [
      '-- Cloudflare D1 export cloudflare-1. Import only into a fresh cloud database.',
      ...BACKUP_TABLES.map((table) => table.schema),
      'CREATE INDEX IF NOT EXISTS media_hash ON media(hash);',
      'CREATE INDEX IF NOT EXISTS vault_shares_lookup ON vault_shares(passcode_lookup);',
      'CREATE INDEX IF NOT EXISTS vault_shares_file ON vault_shares(file_id);',
      'CREATE INDEX IF NOT EXISTS arcade_scores_desc ON arcade_scores(game_id, score DESC, created_at ASC);',
      'CREATE INDEX IF NOT EXISTS arcade_scores_asc ON arcade_scores(game_id, score ASC, created_at ASC);',
      'CREATE INDEX IF NOT EXISTS arena_matches_created ON arena_matches(created_at DESC);',
      ...BACKUP_TABLES.flatMap((table, index) =>
        rows[index].map(
          (row) =>
            `INSERT INTO ${table.name} (${table.columns.join(',')}) VALUES (${table.columns.map((column) => sqlLiteral(row[column] ?? null)).join(',')});`,
        ),
      ),
      '',
    ].join('\n'),
  );

  const keys = new Set<string>();
  const addMediaKeys = (row: DumpRow) => {
    const mediaId = row.id;
    if (typeof mediaId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(mediaId)) {
      throw new ApiError('媒体标识无效', 409);
    }
    for (const col of ['original', 'thumbnail', 'preview'] as const) {
      const key = validateSafeR2Key(row[col]);
      if (!key.startsWith(`atlas/${mediaId}/`) && !key.startsWith(`${mediaId}/`)) {
        throw new ApiError('媒体备份路径无效', 409);
      }
      keys.add(key);
    }
  };

  const addVaultKeys = (row: DumpRow) => {
    const fileId = row.id;
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(fileId)) {
      throw new ApiError('密匣文件标识无效', 409);
    }
    const chunkCount = Number(row.chunk_count ?? 1);
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 4096) {
      throw new ApiError('密匣分片数量无效', 409);
    }
    if (chunkCount === 1) {
      keys.add(validateSafeR2Key(row.r2_key, `vault/${fileId}/`));
    } else {
      for (let i = 0; i < chunkCount; i++) {
        keys.add(validateSafeR2Key(`vault/${fileId}/part-${i}`, `vault/${fileId}/`));
      }
    }
  };

  // Index 1: media, Index 3: admin_trash, Index 4: vault_files
  for (const row of rows[1]) addMediaKeys(row);
  for (const row of rows[4]) addVaultKeys(row);
  for (const row of rows[3]) {
    if (row.kind === 'media') {
      let stored: DumpRow;
      try {
        stored = JSON.parse(String(row.data)) as DumpRow;
      } catch {
        throw new ApiError('回收站媒体记录无效', 409);
      }
      if (!stored || stored.id !== row.record_id) {
        throw new ApiError('回收站媒体记录无效', 409);
      }
      addMediaKeys(stored);
    } else if (row.kind === 'vault_file') {
      let stored: DumpRow;
      try {
        stored = JSON.parse(String(row.data)) as DumpRow;
      } catch {
        throw new ApiError('回收站密匣记录无效', 409);
      }
      if (!stored || stored.id !== row.record_id) {
        throw new ApiError('回收站密匣记录无效', 409);
      }
      addVaultKeys(stored);
    }
  }

  const objects: ObjectInfo[] = [];
  for (const key of [...keys].sort()) {
    const meta = await env.MEDIA.head(key);
    if (!meta) throw new ApiError(`备份文件缺失: ${key}`, 409);
    if (meta.size > CLOUD_MEDIA_LIMITS.maxFileBytes) {
      throw new ApiError('媒体或密匣分片超过单文件备份限制', 413);
    }
    objects.push({ key, size: meta.size, etag: meta.etag });
  }

  const readmeBytes = encoder.encode(
    'Lvtushouji Cloudflare Backup (cloudflare-1)\n\nRestore library.sql into a fresh D1 database with wrangler d1 execute --local --file=library.sql.\nRestore every object under media/ to its matching private R2 key.\nVerify every file size and SHA-256 checksum in manifest.json before restoring.\nSession tokens, visitor logs, rate limits, usage counters, vault upload temp sessions, vault tickets, SESSION_SECRET, and SETUP_TOKEN are intentionally excluded.\n',
  );

  const manifest: ManifestEntry[] = [
    { path: 'library.sql', size: sqlBytes.byteLength, sha256: await sha256Hex(sqlBytes) },
    { path: 'README.txt', size: readmeBytes.byteLength, sha256: await sha256Hex(readmeBytes) },
  ];

  const queue: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else if (chunk.length) queue.push(chunk);
  });

  type Pending = { path: string; bytes: Uint8Array; offset: number; input: ZipPassThrough };
  let pending: Pending | null = null;
  let stage = 0;
  let objectIndex = 0;
  let ended = false;

  const enqueueEntry = (path: string, bytes: Uint8Array) => {
    const input = new ZipPassThrough(path);
    zip.add(input);
    pending = { path, bytes, offset: 0, input };
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!queue.length && !ended) {
          if (zipError) throw zipError;
          if (pending) {
            const current: Pending = pending;
            const end = Math.min(current.bytes.length, current.offset + 64 * 1024);
            const final = end === current.bytes.length;
            current.input.push(current.bytes.subarray(current.offset, end), final);
            current.offset = end;
            if (final) pending = null;
          } else if (stage === 0) {
            stage++;
            enqueueEntry('library.sql', sqlBytes);
          } else if (stage === 1) {
            stage++;
            enqueueEntry('README.txt', readmeBytes);
          } else if (objectIndex < objects.length) {
            const info = objects[objectIndex++];
            const object = await env.MEDIA.get(info.key, { onlyIf: { etagMatches: info.etag } });
            if (!object || !('arrayBuffer' in object)) {
              throw new Error(`备份期间对象发生变化: ${info.key}`);
            }
            const bytes = new Uint8Array(await object.arrayBuffer());
            if (bytes.length !== info.size) {
              throw new Error(`备份期间对象大小变化: ${info.key}`);
            }
            const archivePath = `media/${info.key}`;
            manifest.push({
              path: archivePath,
              size: bytes.length,
              sha256: await sha256Hex(bytes),
            });
            enqueueEntry(archivePath, bytes);
          } else if (stage === 2) {
            stage++;
            enqueueEntry(
              'manifest.json',
              encoder.encode(
                JSON.stringify(
                  { version: 'cloudflare-1', createdAt: new Date().toISOString(), files: manifest },
                  null,
                  2,
                ),
              ),
            );
          } else {
            zip.end();
            ended = true;
          }
        }
        if (zipError) throw zipError;
        if (queue.length) controller.enqueue(queue.shift()!);
        else if (ended) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      queue.length = 0;
      pending = null;
      ended = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="travel-backup-${new Date().toISOString().slice(0, 10)}.zip"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function validateHomeShowcase(raw: unknown): HomeShowcaseFrame[] {
  if (!Array.isArray(raw)) {
    throw new ApiError('首页精选展台必须为数组', 400);
  }
  if (raw.length > 8) {
    throw new ApiError('首页精选展台最多包含 8 张影像', 400);
  }
  return raw.map((item, index) => {
    const entry = object(item);
    const frameId =
      entry.id !== undefined && entry.id !== null && entry.id !== ''
        ? id(entry.id)
        : `frame_${index + 1}`;
    const src = text(entry.src, '展台影像路径', 300, true);
    if (!src.startsWith('/') || src.startsWith('//') || src.includes('..') || /[\s\\]/.test(src)) {
      throw new ApiError('展台影像路径必须为站内路径（以 / 或 /api/files/ 开头）', 400);
    }
    const alt =
      entry.alt !== undefined && entry.alt !== null ? text(entry.alt, '影像替代文字', 200, false) : '';
    const place =
      entry.place !== undefined && entry.place !== null ? text(entry.place, '拍摄地点', 120, false) : '';
    const coords =
      entry.coords !== undefined && entry.coords !== null ? text(entry.coords, '坐标文案', 80, false) : '';
    const caption =
      entry.caption !== undefined && entry.caption !== null
        ? text(entry.caption, '展台说明', 300, false)
        : '';

    const frame: HomeShowcaseFrame = {
      id: frameId,
      src,
      alt,
      place,
      coords,
      caption,
    };

    if (entry.mediaId === null) {
      frame.mediaId = null;
    } else if (entry.mediaId !== undefined && entry.mediaId !== '') {
      frame.mediaId = id(entry.mediaId);
    }

    if (entry.width !== undefined && entry.width !== null) {
      if (
        typeof entry.width !== 'number' ||
        !Number.isInteger(entry.width) ||
        entry.width < 1 ||
        entry.width > 20_000
      ) {
        throw new ApiError('展台影像宽度无效', 400);
      }
      frame.width = entry.width;
    }
    if (entry.height !== undefined && entry.height !== null) {
      if (
        typeof entry.height !== 'number' ||
        !Number.isInteger(entry.height) ||
        entry.height < 1 ||
        entry.height > 20_000
      ) {
        throw new ApiError('展台影像高度无效', 400);
      }
      frame.height = entry.height;
    }

    return frame;
  });
}

adminRoutes.use('*', async (c, next) => {
  requireCloudAdmin(c.get('cloudCtx'));
  await next();
});

adminRoutes.get('/', async (c) => {
  const db = c.get('costEnv').DB;
  const [library, trashRows, vaultRows, projects, sizeProbe] = await Promise.all([
    readWholeLibrary(db),
    db.prepare('SELECT * FROM admin_trash ORDER BY rowid DESC').all<TrashRow>(),
    db.prepare('SELECT * FROM vault_files ORDER BY created_at DESC, rowid DESC').all<VaultFileRow>(),
    listAllProjects(db),
    db.prepare('SELECT 1').all(),
  ]);

  const trash = trashRows.results.map(parseTrashItem);
  const vaultFiles = vaultRows.results.map(mapVaultFileRow);

  const originalBytes = [
    ...library.media,
    ...trash.filter((t) => t.kind === 'media').map((t) => t.record as Media),
  ].reduce((sum, m) => sum + (Number.isFinite(m.size) ? m.size : 0), 0);

  const vaultBytes = [
    ...vaultFiles,
    ...trash.filter((t) => t.kind === 'vault_file').map((t) => t.record as VaultFileRecord),
  ].reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0);

  const snapshot: AdminSnapshot = {
    library,
    settings: library.settings ?? { ...DEFAULT_SITE_SETTINGS },
    trash,
    vaultFiles,
    projects,
    storage: {
      dataDirectory: 'Cloudflare D1 / R2 (Local)',
      databaseBytes: sizeProbe.meta.size_after ?? 0,
      originalBytes,
      vaultBytes,
    },
    limits: {
      maxFileBytes: CLOUD_MEDIA_LIMITS.maxFileBytes,
      maxBatchBytes: CLOUD_MEDIA_LIMITS.maxBatchBytes,
      maxChunkBytes: CLOUD_MEDIA_LIMITS.maxChunkBytes,
    },
  };
  return c.json(snapshot);
});

adminRoutes.get('/settings', async (c) => {
  return c.json(await readSiteSettings(c.get('costEnv').DB));
});

adminRoutes.patch('/settings', async (c) => {
  const db = c.get('costEnv').DB;
  const value = object(await c.req.json().catch(() => null));
  const settings: SiteSettings = {
    title: text(value.title, '站点标题', 24, true),
    tagline: text(value.tagline ?? '', '站点引言', 180),
  };
  if (value.homeShowcase === undefined) {
    const existing = await readSiteSettings(db);
    if (existing.homeShowcase !== undefined) {
      settings.homeShowcase = existing.homeShowcase;
    }
  } else if (value.homeShowcase !== null) {
    settings.homeShowcase = validateHomeShowcase(value.homeShowcase);
  }
  await db
    .prepare(
      "INSERT INTO admin_settings (key,data) VALUES ('site',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
    )
    .bind(JSON.stringify(settings))
    .run();
  return c.json(settings);
});

adminRoutes.get('/usage', async (c) => {
  const result = await c
    .get('costEnv')
    .DB.prepare('SELECT key,value FROM usage_limits ORDER BY key')
    .all<{ key: string; value: number }>();
  return c.json({
    limits: COST_LIMITS,
    month: currentUsageMonth(),
    counters: result.results,
  });
});

adminRoutes.post('/trash', async (c) => {
  const db = c.get('costEnv').DB;
  const value = object(await c.req.json().catch(() => null));
  const kind = kindOf(value.kind);
  const recordId = id(value.id);

  const existingTrash = await db
    .prepare('SELECT key FROM admin_trash WHERE kind=? AND record_id=?')
    .bind(kind, recordId)
    .first();
  if (existingTrash) {
    throw new ApiError('这项资料已在回收站，请先恢复后再编辑', 409);
  }

  const trashKey = crypto.randomUUID();
  const removedAt = new Date().toISOString();

  if (kind === 'vault_file') {
    const fileRow = await db
      .prepare('SELECT * FROM vault_files WHERE id=?')
      .bind(recordId)
      .first<VaultFileRow>();
    if (!fileRow) throw new ApiError('要回收的文件不存在', 404);
    const activeShare = await db
      .prepare(
        'SELECT id FROM vault_shares WHERE file_id=? AND revoked_at IS NULL AND expires_at>? AND downloads<max_downloads',
      )
      .bind(recordId, removedAt)
      .first();
    if (activeShare) {
      throw new ApiError('文件仍有有效分享口令，请先撤销分享后再移入回收站', 409);
    }

    const trashData = JSON.stringify(fileRow);
    const trashRow: TrashRow = {
      key: trashKey,
      kind,
      record_id: recordId,
      removed_at: removedAt,
      data: trashData,
    };

    await commitBatch(db, [
      guard(db, 'NOT EXISTS(SELECT 1 FROM admin_trash WHERE kind=? AND record_id=?)', kind, recordId),
      guard(
        db,
        'EXISTS(SELECT 1 FROM vault_files WHERE id=? AND r2_key=? AND sha256=?)',
        fileRow.id,
        fileRow.r2_key,
        fileRow.sha256,
      ),
      guard(
        db,
        'NOT EXISTS(SELECT 1 FROM vault_shares WHERE file_id=? AND revoked_at IS NULL AND expires_at>? AND downloads<max_downloads)',
        recordId,
        removedAt,
      ),
      db
        .prepare('INSERT INTO admin_trash (key,kind,record_id,removed_at,data) VALUES (?,?,?,?,?)')
        .bind(trashKey, kind, recordId, removedAt, trashData),
      db.prepare('DELETE FROM vault_files WHERE id=?').bind(recordId),
    ]);

    return c.json(parseTrashItem(trashRow));
  }

  const table = kind === 'journey' ? 'journeys' : 'media';
  const original =
    kind === 'media'
      ? await db.prepare('SELECT * FROM media WHERE id=?').bind(recordId).first<MediaRow>()
      : await db.prepare('SELECT * FROM journeys WHERE id=?').bind(recordId).first<{ id: string; data: string }>();

  if (!original) throw new ApiError('要回收的资料不存在', 404);

  if (kind === 'media') {
    const journeysResult = await db
      .prepare('SELECT data FROM journeys ORDER BY rowid DESC')
      .all<{ data: string }>();
    const linked = journeysResult.results
      .map((r) => JSON.parse(r.data) as Journey)
      .find((j) => j.coverId === recordId || j.stops.some((s) => s.mediaIds.includes(recordId)));
    if (linked) {
      throw new ApiError(
        `影像仍关联旅程「${linked.title}」，请先编辑旅程解除关联及封面后再移入回收站`,
        409,
      );
    }
  }

  const trashData = JSON.stringify(original);
  const trashRow: TrashRow = {
    key: trashKey,
    kind,
    record_id: recordId,
    removed_at: removedAt,
    data: trashData,
  };

  const statements: D1PreparedStatement[] = [
    guard(db, 'NOT EXISTS(SELECT 1 FROM admin_trash WHERE kind=? AND record_id=?)', kind, recordId),
    guard(db, `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND data=?)`, original.id, original.data),
  ];
  if (kind === 'media') {
    statements.push(
      guard(
        db,
        `NOT EXISTS(SELECT 1 FROM journeys j WHERE json_extract(j.data,'$.coverId')=? OR EXISTS(SELECT 1 FROM json_each(j.data,'$.stops') s, json_each(s.value,'$.mediaIds') m WHERE m.value=?))`,
        recordId,
        recordId,
      ),
    );
  }
  statements.push(
    db
      .prepare('INSERT INTO admin_trash (key,kind,record_id,removed_at,data) VALUES (?,?,?,?,?)')
      .bind(trashKey, kind, recordId, removedAt, trashData),
    db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(recordId),
  );

  await commitBatch(db, statements);
  return c.json(parseTrashItem(trashRow));
});

adminRoutes.post('/restore', async (c) => {
  const db = c.get('costEnv').DB;
  const value = object(await c.req.json().catch(() => null));
  const key = id(value.key);
  const trash = await db.prepare('SELECT * FROM admin_trash WHERE key=?').bind(key).first<TrashRow>();
  if (!trash) throw new ApiError('回收记录不存在，可能已恢复', 404);

  const kind = kindOf(trash.kind);

  if (kind === 'vault_file') {
    const existing = await db
      .prepare('SELECT id FROM vault_files WHERE id=?')
      .bind(trash.record_id)
      .first();
    if (existing) {
      throw new ApiError('当前资料已有相同标识，无法覆盖恢复，请先核对现有资料', 409);
    }
    const stored = JSON.parse(trash.data) as VaultFileRow;
    await commitBatch(db, [
      guard(db, 'EXISTS(SELECT 1 FROM admin_trash WHERE key=? AND data=?)', key, trash.data),
      guard(db, 'NOT EXISTS(SELECT 1 FROM vault_files WHERE id=?)', trash.record_id),
      db
        .prepare(
          'INSERT INTO vault_files (id,name,mime,size,sha256,r2_key,chunk_count,visibility,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          stored.id,
          stored.name,
          stored.mime,
          stored.size,
          stored.sha256,
          stored.r2_key,
          stored.chunk_count,
          stored.visibility,
          stored.created_at,
        ),
      db.prepare('DELETE FROM admin_trash WHERE key=?').bind(key),
    ]);
    return c.json(mapVaultFileRow(stored));
  }

  const table = kind === 'journey' ? 'journeys' : 'media';
  const existing = await db
    .prepare(`SELECT id FROM ${table} WHERE id=?`)
    .bind(trash.record_id)
    .first();
  if (existing) {
    throw new ApiError('当前资料已有相同标识，无法覆盖恢复，请先核对现有资料', 409);
  }

  const stored = JSON.parse(trash.data) as MediaRow;
  const record = JSON.parse(stored.data) as Journey | Media;
  const statements: D1PreparedStatement[] = [
    guard(db, 'EXISTS(SELECT 1 FROM admin_trash WHERE key=? AND data=?)', key, trash.data),
    guard(db, `NOT EXISTS(SELECT 1 FROM ${table} WHERE id=?)`, trash.record_id),
  ];

  if (kind === 'journey') {
    const journey = record as Journey;
    const refs = [
      ...new Set(
        [journey.coverId, ...journey.stops.flatMap((s) => s.mediaIds)].filter(
          (x): x is string => x !== null,
        ),
      ),
    ];
    for (const ref of refs) {
      const mediaExists = await db.prepare('SELECT id FROM media WHERE id=?').bind(ref).first();
      if (!mediaExists) throw new ApiError('请先恢复旅程关联的影像，再恢复这段旅程', 409);
      statements.push(guard(db, 'EXISTS(SELECT 1 FROM media WHERE id=?)', ref));
    }
  }

  if (kind === 'media') {
    if (!stored.original || !stored.thumbnail || !stored.preview) {
      throw new ApiError('回收记录缺少媒体文件信息', 409);
    }
    statements.push(
      db
        .prepare('INSERT INTO media (id,data,original,thumbnail,preview,hash) VALUES (?,?,?,?,?,?)')
        .bind(
          trash.record_id,
          stored.data,
          stored.original,
          stored.thumbnail,
          stored.preview,
          stored.hash ?? (record as Media).hash ?? null,
        ),
    );
  } else {
    statements.push(
      db
        .prepare('INSERT INTO journeys (id,data) VALUES (?,?)')
        .bind(trash.record_id, stored.data),
    );
  }

  statements.push(db.prepare('DELETE FROM admin_trash WHERE key=?').bind(key));
  await commitBatch(db, statements);
  return c.json(record);
});

adminRoutes.post('/trash/purge', async (c) => {
  const costEnv = c.get('costEnv');
  const db = costEnv.DB;
  const value = object(await c.req.json().catch(() => null));
  const purgeAll = value.all === true;

  let rows: TrashRow[];
  if (purgeAll) {
    const res = await db.prepare('SELECT * FROM admin_trash ORDER BY rowid DESC').all<TrashRow>();
    rows = res.results;
  } else {
    if (value.key === undefined || value.key === null || value.key === '') {
      throw new ApiError('请指定要销毁的回收记录标识或设置 all: true', 400);
    }
    const key = id(value.key);
    const row = await db.prepare('SELECT * FROM admin_trash WHERE key=?').bind(key).first<TrashRow>();
    if (!row) {
      throw new ApiError('回收记录不存在，可能已清理', 404);
    }
    rows = [row];
  }

  if (rows.length === 0) {
    return c.json({ ok: true, purged: 0, deletedR2Keys: [] });
  }

  const r2KeysSet = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'media') {
      const stored = JSON.parse(row.data) as MediaRow;
      for (const candidate of [stored.original, stored.thumbnail, stored.preview]) {
        if (typeof candidate === 'string' && candidate) {
          r2KeysSet.add(validateSafeR2Key(candidate));
        }
      }
    } else if (row.kind === 'vault_file') {
      const stored = JSON.parse(row.data) as VaultFileRow;
      const chunkCount = Math.max(1, Number(stored.chunk_count ?? 1));
      if (!Number.isInteger(chunkCount) || chunkCount > 4096) {
        throw new ApiError('回收记录中的密匣分片数量无效', 409);
      }
      if (chunkCount === 1) {
        r2KeysSet.add(validateSafeR2Key(stored.r2_key, `vault/${stored.id}/`));
      } else {
        for (let i = 0; i < chunkCount; i += 1) {
          r2KeysSet.add(validateSafeR2Key(`vault/${stored.id}/part-${i}`, `vault/${stored.id}/`));
        }
      }
    }
  }

  const deletedR2Keys = [...r2KeysSet];
  for (let i = 0; i < deletedR2Keys.length; i += 500) {
    const batch = deletedR2Keys.slice(i, i + 500);
    await costEnv.MEDIA.delete(batch);
  }

  await db.batch(rows.map((row) => db.prepare('DELETE FROM admin_trash WHERE key=?').bind(row.key)));

  return c.json({
    ok: true,
    purged: rows.length,
    deletedR2Keys,
  });
});

adminRoutes.get('/backup', async (c) => {
  return createCloudBackup(c.get('costEnv'));
});
