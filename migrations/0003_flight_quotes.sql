-- Each traveler's own round-trip fare to a destination (flights differ by hometown).
CREATE TABLE IF NOT EXISTS flight_quotes (
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  traveler_id    INTEGER NOT NULL REFERENCES travelers(id) ON DELETE CASCADE,
  price          REAL NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (destination_id, traveler_id)
);
