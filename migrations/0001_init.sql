-- Atlas & Admin
CREATE TABLE IF NOT EXISTS journeys (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  original TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  preview TEXT NOT NULL,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS media_hash ON media(hash);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_trash (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('journey', 'media', 'vault_file')),
  record_id TEXT NOT NULL,
  removed_at TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(kind, record_id)
);

-- Vault
CREATE TABLE IF NOT EXISTS vault_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'shared')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_uploads (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  total_chunks INTEGER NOT NULL,
  received_chunks TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'uploading',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_shares (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  passcode_hash TEXT NOT NULL,
  passcode_salt TEXT NOT NULL,
  passcode_lookup TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  max_downloads INTEGER NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  prior_expires_at TEXT
);
CREATE INDEX IF NOT EXISTS vault_shares_lookup ON vault_shares(passcode_lookup);
CREATE INDEX IF NOT EXISTS vault_shares_file ON vault_shares(file_id);

CREATE TABLE IF NOT EXISTS vault_tickets (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_tickets_share ON vault_tickets(share_id);
CREATE INDEX IF NOT EXISTS vault_tickets_expires ON vault_tickets(expires_at);

-- Security
CREATE TABLE IF NOT EXISTS security_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS security_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  visitor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  address TEXT NOT NULL,
  device TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS security_visitors (
  id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  address TEXT NOT NULL,
  address_source TEXT NOT NULL,
  device TEXT NOT NULL,
  authenticated INTEGER NOT NULL,
  client_info TEXT
);

CREATE TABLE IF NOT EXISTS security_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  visitor_id TEXT NOT NULL,
  status INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS security_events_time ON security_events(at);
CREATE INDEX IF NOT EXISTS security_events_visitor ON security_events(visitor_id, at);

CREATE TABLE IF NOT EXISTS security_blocks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(type, value)
);

CREATE TABLE IF NOT EXISTS security_limits (
  key TEXT PRIMARY KEY,
  start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Usage Limits
CREATE TABLE IF NOT EXISTS usage_limits (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL CHECK(value >= 0)
);
