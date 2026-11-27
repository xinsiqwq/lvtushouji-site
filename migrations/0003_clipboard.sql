-- Phase 2 Expansion: Mercury Cross-Device Clipboard Drops (D1-only, zero R2)
CREATE TABLE IF NOT EXISTS clipboard_drops (
  code TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  destroy_hash TEXT NOT NULL,
  burn_after_read INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  max_views INTEGER NOT NULL DEFAULT 10,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clipboard_drops_expires ON clipboard_drops(expires_at);
