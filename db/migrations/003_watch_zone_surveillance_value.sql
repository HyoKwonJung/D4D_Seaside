-- Fine-grained surveillance-value zones (subdivisions of the AOIs used for
-- AISStream bounding boxes). See lib/watch-areas.js for the live computation
-- this table mirrors, and docs/threat-intel-expansion-design.md section 2.
--
-- The running system computes surveillance_value/recovery_coeff in-memory on
-- every request from lib/watch-areas.js (so formula/weight changes take
-- effect immediately without a migration). This table is a durable cache +
-- audit trail, populated by scripts/collect-reference-data.js, not read by
-- the live scoring path.
CREATE TABLE IF NOT EXISTS watch_zones (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  parent_aoi_id           TEXT,
  bounds                  JSONB NOT NULL,
  chokepoint_width_km     NUMERIC,
  chokepoint_depth_m      NUMERIC,
  cable_count             INTEGER NOT NULL DEFAULT 0,
  total_national_cables   INTEGER NOT NULL DEFAULT 0,
  redundancy_class        TEXT CHECK (redundancy_class IN ('none', 'partial', 'full')),
  landing_station_distance_km NUMERIC,
  incident_history_score  NUMERIC NOT NULL DEFAULT 0,
  surveillance_value      NUMERIC,
  recovery_coeff          NUMERIC,
  source_notes            TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Records which watch zone (if any) a live-derived event fell in, and the
-- multiplier that was applied, for audit/backtesting.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS watch_zone_id TEXT,
  ADD COLUMN IF NOT EXISTS watch_zone_name TEXT,
  ADD COLUMN IF NOT EXISTS area_value_multiplier NUMERIC;
