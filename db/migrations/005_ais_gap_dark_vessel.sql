-- Supports lib/dark-vessel-inference.js's ais_gap events: records the
-- dead-reckoning projection (Kalman filter, constant-velocity model) used
-- to estimate a dark vessel's current position while AIS is silent.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS gap_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_confirmed_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS last_confirmed_lon NUMERIC,
  ADD COLUMN IF NOT EXISTS projected_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS projected_lon NUMERIC,
  ADD COLUMN IF NOT EXISTS position_uncertainty_nm NUMERIC;
