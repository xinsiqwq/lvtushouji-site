-- Sandstorm v3.0: persist map_id on active lobbies and archived matches
ALTER TABLE arena_lobbies ADD COLUMN map_id TEXT NOT NULL DEFAULT 'dust';
ALTER TABLE arena_matches ADD COLUMN map_id TEXT NOT NULL DEFAULT 'dust';
