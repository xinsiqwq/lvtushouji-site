export const SCHEMA_STATEMENTS: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS journeys (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, data TEXT NOT NULL, original TEXT NOT NULL, thumbnail TEXT NOT NULL, preview TEXT NOT NULL, hash TEXT)',
  'CREATE INDEX IF NOT EXISTS media_hash ON media(hash)',
  'CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS admin_trash (key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('journey', 'media', 'vault_file')), record_id TEXT NOT NULL, removed_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(kind, record_id))",
  "CREATE TABLE IF NOT EXISTS vault_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, r2_key TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 1, visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'shared')), created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS vault_uploads (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, total_chunks INTEGER NOT NULL, received_chunks TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'uploading', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS vault_shares (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, passcode_hash TEXT NOT NULL, passcode_salt TEXT NOT NULL, passcode_lookup TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', max_downloads INTEGER NOT NULL, downloads INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, prior_expires_at TEXT)",
  'CREATE INDEX IF NOT EXISTS vault_shares_lookup ON vault_shares(passcode_lookup)',
  'CREATE INDEX IF NOT EXISTS vault_shares_file ON vault_shares(file_id)',
  'CREATE TABLE IF NOT EXISTS vault_tickets (id TEXT PRIMARY KEY, share_id TEXT NOT NULL, file_id TEXT NOT NULL, expires_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS vault_tickets_share ON vault_tickets(share_id)',
  'CREATE INDEX IF NOT EXISTS vault_tickets_expires ON vault_tickets(expires_at)',
  'CREATE TABLE IF NOT EXISTS security_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS security_sessions (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, visitor_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, address TEXT NOT NULL, device TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS security_visitors (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, address TEXT NOT NULL, address_source TEXT NOT NULL, device TEXT NOT NULL, authenticated INTEGER NOT NULL, client_info TEXT)',
  'CREATE TABLE IF NOT EXISTS security_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, visitor_id TEXT NOT NULL, status INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS security_events_time ON security_events(at)',
  'CREATE INDEX IF NOT EXISTS security_events_visitor ON security_events(visitor_id, at)',
  'CREATE TABLE IF NOT EXISTS security_blocks (id TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(type, value))',
  'CREATE TABLE IF NOT EXISTS security_limits (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS usage_limits (key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0))',
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS clipboard_drops (code TEXT PRIMARY KEY, content TEXT NOT NULL, destroy_hash TEXT NOT NULL, burn_after_read INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, max_views INTEGER NOT NULL DEFAULT 10, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS clipboard_drops_expires ON clipboard_drops(expires_at)',
  "CREATE TABLE IF NOT EXISTS arcade_scores (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, player_name TEXT NOT NULL, score INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}', visitor_id TEXT NOT NULL, created_at TEXT NOT NULL)",
  'CREATE INDEX IF NOT EXISTS arcade_scores_desc ON arcade_scores(game_id, score DESC, created_at ASC)',
  'CREATE INDEX IF NOT EXISTS arcade_scores_asc ON arcade_scores(game_id, score ASC, created_at ASC)',
  "CREATE TABLE IF NOT EXISTS arena_lobbies (code TEXT PRIMARY KEY, name TEXT NOT NULL, host_name TEXT NOT NULL, mode TEXT NOT NULL, map_id TEXT NOT NULL DEFAULT 'dust', is_public INTEGER NOT NULL DEFAULT 1, phase TEXT NOT NULL DEFAULT 'lobby', human_count INTEGER NOT NULL DEFAULT 0, max_humans INTEGER NOT NULL DEFAULT 8, bot_count INTEGER NOT NULL DEFAULT 4, bot_difficulty TEXT NOT NULL DEFAULT 'veteran', rounds_to_win INTEGER NOT NULL DEFAULT 5, target_kills INTEGER NOT NULL DEFAULT 25, score_red INTEGER NOT NULL DEFAULT 0, score_blue INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  'CREATE INDEX IF NOT EXISTS arena_lobbies_public ON arena_lobbies(is_public, updated_at DESC)',
  "CREATE TABLE IF NOT EXISTS arena_matches (id TEXT PRIMARY KEY, room_code TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('online', 'solo')), mode TEXT NOT NULL, map_id TEXT NOT NULL DEFAULT 'dust', winner_team TEXT NOT NULL, score_red INTEGER NOT NULL DEFAULT 0, score_blue INTEGER NOT NULL DEFAULT 0, mvp_name TEXT NOT NULL, mvp_kills INTEGER NOT NULL DEFAULT 0, mvp_deaths INTEGER NOT NULL DEFAULT 0, mvp_headshots INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, player_count INTEGER NOT NULL DEFAULT 1, bot_count INTEGER NOT NULL DEFAULT 0, players_json TEXT NOT NULL DEFAULT '[]', visitor_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
  'CREATE INDEX IF NOT EXISTS arena_matches_created ON arena_matches(created_at DESC)',
];

const ARENA_V3_COLUMN_MIGRATIONS: ReadonlyArray<{
  table: 'arena_lobbies' | 'arena_matches';
  column: string;
  alterSql: string;
}> = [
  {
    table: 'arena_lobbies',
    column: 'map_id',
    alterSql: "ALTER TABLE arena_lobbies ADD COLUMN map_id TEXT NOT NULL DEFAULT 'dust'",
  },
  {
    table: 'arena_matches',
    column: 'map_id',
    alterSql: "ALTER TABLE arena_matches ADD COLUMN map_id TEXT NOT NULL DEFAULT 'dust'",
  },
];

let schemaReady = false;

export async function applySchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));

  // Safely upgrade existing local/prod D1 tables created prior to Sandstorm v3.0
  const pragmaResults = await db.batch(
    ARENA_V3_COLUMN_MIGRATIONS.map((m) => db.prepare(`PRAGMA table_info(${m.table})`)),
  );
  for (let i = 0; i < ARENA_V3_COLUMN_MIGRATIONS.length; i += 1) {
    const migration = ARENA_V3_COLUMN_MIGRATIONS[i]!;
    const cols = (pragmaResults[i]?.results ?? []) as Array<{ name?: string }>;
    const hasColumn = cols.some((col) => col.name === migration.column);
    if (!hasColumn) {
      try {
        await db.prepare(migration.alterSql).run();
      } catch (err) {
        if (!String(err).toLowerCase().includes('duplicate column')) {
          throw err;
        }
      }
    }
  }

  schemaReady = true;
}

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await applySchema(db);
}

export function resetSchemaReadyForTests(): void {
  schemaReady = false;
}
