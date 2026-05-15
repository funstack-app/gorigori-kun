CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  ref_image_paths TEXT,
  count INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_images_turn ON images(turn_id, created_at);
