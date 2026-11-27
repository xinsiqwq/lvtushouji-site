-- Phase 3 Expansion: Mars Arcade Global Leaderboard (D1-only, Top-50 bounded per game)
CREATE TABLE IF NOT EXISTS arcade_scores (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  visitor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS arcade_scores_desc ON arcade_scores(game_id, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS arcade_scores_asc ON arcade_scores(game_id, score ASC, created_at ASC);
