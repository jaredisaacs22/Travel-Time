-- Optional hometown per traveler, shown as a small house marker on the map.
ALTER TABLE travelers ADD COLUMN home_label TEXT;
ALTER TABLE travelers ADD COLUMN home_lat REAL;
ALTER TABLE travelers ADD COLUMN home_lng REAL;
