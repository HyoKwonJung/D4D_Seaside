CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vessels (
  mmsi TEXT PRIMARY KEY,
  current_name TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ais_positions (
  id BIGSERIAL PRIMARY KEY,
  mmsi TEXT NOT NULL REFERENCES vessels(mmsi) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  sog_kn DOUBLE PRECISION,
  cog_deg DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION,
  vessel_name TEXT,
  message_type TEXT NOT NULL DEFAULT 'Unknown',
  source TEXT NOT NULL DEFAULT 'aisstream',
  raw_payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ais_positions_mmsi_observed_at_unique
  ON ais_positions (mmsi, observed_at, lat, lon, message_type);

CREATE INDEX IF NOT EXISTS ais_positions_mmsi_observed_at_idx
  ON ais_positions (mmsi, observed_at DESC);

CREATE TABLE IF NOT EXISTS vessel_latest_state (
  mmsi TEXT PRIMARY KEY REFERENCES vessels(mmsi) ON DELETE CASCADE,
  vessel_name TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  sog_kn DOUBLE PRECISION,
  cog_deg DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION,
  last_message_type TEXT NOT NULL DEFAULT 'Unknown',
  source TEXT NOT NULL DEFAULT 'aisstream',
  last_seen_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  synthetic BOOLEAN NOT NULL DEFAULT FALSE,
  scenario_id TEXT,
  event_type TEXT NOT NULL,
  vessel_mmsi TEXT REFERENCES vessels(mmsi) ON DELETE SET NULL,
  vessel_name TEXT,
  occurred_at TIMESTAMPTZ,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  duration_h DOUBLE PRECISION,
  speed_kn DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION,
  nearest_cable_id TEXT,
  nearest_cable TEXT,
  distance_to_cable_nm DOUBLE PRECISION,
  region TEXT,
  ais_status TEXT,
  sar_matched BOOLEAN,
  description TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'Low',
  recommendation TEXT,
  scoring_version TEXT NOT NULL DEFAULT 'v1',
  review_status TEXT NOT NULL DEFAULT 'unverified',
  review_notes TEXT,
  review_updated_by TEXT,
  review_updated_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_active_last_seen_at_idx
  ON events (active, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS events_vessel_mmsi_idx
  ON events (vessel_mmsi);

CREATE TABLE IF NOT EXISTS event_evidence (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  evidence_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, seq)
);

CREATE TABLE IF NOT EXISTS event_reviews (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  review_status TEXT NOT NULL,
  notes TEXT,
  reviewer_name TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_reviews_event_id_reviewed_at_idx
  ON event_reviews (event_id, reviewed_at DESC);
