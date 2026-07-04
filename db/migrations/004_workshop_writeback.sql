-- 004: Foundry Workshop write-back closed loop.
-- Stores action audit payloads and patrol tasking requests returned from Workshop.

CREATE TABLE IF NOT EXISTS workshop_writebacks (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  event_id TEXT,
  vessel_key TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  reviewer_name TEXT,
  notes TEXT,
  raw_payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workshop_writebacks_event_id_created_at_idx
  ON workshop_writebacks (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workshop_writebacks_vessel_key_created_at_idx
  ON workshop_writebacks (vessel_key, created_at DESC);

CREATE TABLE IF NOT EXISTS patrol_taskings (
  id BIGSERIAL PRIMARY KEY,
  tasking_id TEXT UNIQUE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  vessel_key TEXT,
  asset_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'tasking',
  notes TEXT,
  requested_by TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS patrol_taskings_event_id_requested_at_idx
  ON patrol_taskings (event_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS patrol_taskings_status_requested_at_idx
  ON patrol_taskings (status, requested_at DESC);

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS patrol_tasking_status TEXT,
  ADD COLUMN IF NOT EXISTS patrol_tasking_asset TEXT,
  ADD COLUMN IF NOT EXISTS patrol_tasking_updated_at TIMESTAMPTZ;