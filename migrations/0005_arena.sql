-- Phase 4 Expansion: Mars 3D Tactical Arena · Polar Iceworld
-- Active room index (ephemeral metadata synchronized on room lifecycle events, zero tick writes)
CREATE TABLE IF NOT EXISTS arena_lobbies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  phase TEXT NOT NULL DEFAULT 'lobby',
  human_count INTEGER NOT NULL DEFAULT 0,
  max_humans INTEGER NOT NULL DEFAULT 8,
  bot_count INTEGER NOT NULL DEFAULT 4,
  bot_difficulty TEXT NOT NULL DEFAULT 'veteran',
  rounds_to_win INTEGER NOT NULL DEFAULT 5,
  target_kills INTEGER NOT NULL DEFAULT 25,
  score_red INTEGER NOT NULL DEFAULT 0,
  score_blue INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_lobbies_public ON arena_lobbies(is_public, updated_at DESC);

-- Completed match archive (1 write per finished match, bounded to latest 100 rows, included in backup)
CREATE TABLE IF NOT EXISTS arena_matches (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('online', 'solo')),
  mode TEXT NOT NULL,
  winner_team TEXT NOT NULL,
  score_red INTEGER NOT NULL DEFAULT 0,
  score_blue INTEGER NOT NULL DEFAULT 0,
  mvp_name TEXT NOT NULL,
  mvp_kills INTEGER NOT NULL DEFAULT 0,
  mvp_deaths INTEGER NOT NULL DEFAULT 0,
  mvp_headshots INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  player_count INTEGER NOT NULL DEFAULT 1,
  bot_count INTEGER NOT NULL DEFAULT 0,
  players_json TEXT NOT NULL DEFAULT '[]',
  visitor_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_matches_created ON arena_matches(created_at DESC);
