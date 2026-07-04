-- Attack strategy cost-efficiency reference. Like watch_zones (003), this is
-- a durable cache/audit table — the live system reads
-- lib/attack-strategy-reference.js directly (computed from
-- db/seed/attack_case_studies.json on every request), not this table.
-- Populate it for reporting/history via a future collector script if needed.
CREATE TABLE IF NOT EXISTS attack_strategy_reference (
  method_key                    TEXT PRIMARY KEY,
  name_ko                       TEXT NOT NULL,
  name_en                       TEXT NOT NULL,
  direct_cost_usd_est           NUMERIC,
  repair_cost_usd_low           NUMERIC,
  repair_cost_usd_high          NUMERIC,
  downtime_days_low             NUMERIC,
  downtime_days_high            NUMERIC,
  observed_incident_count       INTEGER NOT NULL DEFAULT 0,
  successful_prosecution_count  INTEGER NOT NULL DEFAULT 0,
  deniability_score             NUMERIC,
  deniability_is_assumed        BOOLEAN NOT NULL DEFAULT false,
  detectability_difficulty      NUMERIC,
  cost_efficiency_score         NUMERIC,
  is_observed                   BOOLEAN NOT NULL DEFAULT true,
  evidence_case_ids             JSONB,
  notes                         TEXT,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
