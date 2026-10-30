-- Candidate travel windows anyone can propose, and each traveler's yes/maybe/no on them.
CREATE TABLE IF NOT EXISTS date_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by  INTEGER NOT NULL REFERENCES travelers(id) ON DELETE CASCADE,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS date_votes (
  option_id   INTEGER NOT NULL REFERENCES date_options(id) ON DELETE CASCADE,
  traveler_id INTEGER NOT NULL REFERENCES travelers(id) ON DELETE CASCADE,
  answer      TEXT NOT NULL CHECK (answer IN ('yes', 'maybe', 'no')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (option_id, traveler_id)
);
