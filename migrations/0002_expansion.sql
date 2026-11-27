-- Phase 1 Expansion: Projects Showcase
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
