-- Allowlisted travelers. Names are stored normalized (NFC, trimmed, single-spaced, lowercase)
-- for case-insensitive matching, plus the display form from the seed file.
CREATE TABLE IF NOT EXISTS travelers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  first_norm    TEXT NOT NULL,
  last_norm     TEXT NOT NULL,
  first_display TEXT NOT NULL,
  last_display  TEXT NOT NULL,
  UNIQUE (first_norm, last_norm)
);

CREATE TABLE IF NOT EXISTS destinations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id         INTEGER NOT NULL REFERENCES travelers(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  lat              REAL NOT NULL,
  lng              REAL NOT NULL,
  flight_cost      REAL NOT NULL DEFAULT 0,
  hotel_per_night  REAL NOT NULL DEFAULT 0,
  nights           INTEGER NOT NULL DEFAULT 0,
  food_activities  REAL NOT NULL DEFAULT 0,
  notes            TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_destinations_owner ON destinations(owner_id);

CREATE TABLE IF NOT EXISTS comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  author_id      INTEGER NOT NULL REFERENCES travelers(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_destination ON comments(destination_id);

CREATE TABLE IF NOT EXISTS votes (
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  voter_id       INTEGER NOT NULL REFERENCES travelers(id) ON DELETE CASCADE,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (destination_id, voter_id)
);

-- Fixed-window rate limit counters keyed by "<bucket>:<ip>".
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
