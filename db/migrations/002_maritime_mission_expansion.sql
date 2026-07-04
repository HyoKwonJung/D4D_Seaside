ALTER TABLE ais_positions
  ADD COLUMN IF NOT EXISTS retention_class TEXT NOT NULL DEFAULT 'baseline';

ALTER TABLE ais_positions
  ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;

ALTER TABLE ais_positions
  ADD COLUMN IF NOT EXISTS watch_area_id TEXT;

ALTER TABLE ais_positions
  ADD COLUMN IF NOT EXISTS watch_area_name TEXT;

UPDATE ais_positions
SET retention_until = COALESCE(retention_until, observed_at + INTERVAL '30 days')
WHERE retention_until IS NULL;

CREATE INDEX IF NOT EXISTS ais_positions_retention_until_idx
  ON ais_positions (retention_until);

ALTER TABLE vessel_latest_state
  ADD COLUMN IF NOT EXISTS watch_area_id TEXT;

ALTER TABLE vessel_latest_state
  ADD COLUMN IF NOT EXISTS watch_area_name TEXT;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS counterparty_mmsi TEXT;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS counterparty_vessel_name TEXT;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS watch_area_id TEXT;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS watch_area_name TEXT;
