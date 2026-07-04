-- 003: 멀티센서 융합 (RF/SAR 탐지 + 다크 베슬 상태)
-- 기존 스키마에 additive. lib/db.js runMigrations 가 자동 적용.
-- Node 측(레이어1)에서 비-AIS 탐지를 저장하고, Foundry(레이어2)로 push하기 위한 테이블.

-- 비-AIS 센서 탐지 (RF / SAR / optical) — MMSI 없을 수 있음
CREATE TABLE IF NOT EXISTS detections (
  detection_id TEXT PRIMARY KEY,               -- '<source>:<external_id>'
  source TEXT NOT NULL,                         -- 'rf' | 'sar' | 'optical'
  provider TEXT,                                -- aisstream/gfw/hawkeye/unseenlabs/kompsat/synthetic
  external_id TEXT,
  detected_at TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION,
  -- 상관(correlation) 결과
  matched_mmsi TEXT REFERENCES vessels(mmsi) ON DELETE SET NULL,
  match_distance_nm DOUBLE PRECISION,
  match_time_delta_s DOUBLE PRECISION,
  dark_candidate BOOLEAN NOT NULL DEFAULT FALSE,
  dark_vessel_status TEXT NOT NULL DEFAULT 'unknown',
  dark_track_id TEXT,                           -- 무-AIS 탐지 클러스터 묶음 id
  synthetic BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS detections_detected_at_idx
  ON detections (detected_at DESC);
CREATE INDEX IF NOT EXISTS detections_dark_candidate_idx
  ON detections (dark_candidate, detected_at DESC);
CREATE INDEX IF NOT EXISTS detections_matched_mmsi_idx
  ON detections (matched_mmsi);

-- 이벤트: 센서 매칭 플래그 + 다크 상태 (scoring.py rf_matched/sar_matched 패턴)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS rf_matched BOOLEAN;
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS dark_vessel_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS detection_ids TEXT[];   -- 근거가 된 detections

-- 선박: 엔티티 해석 결과 보강
ALTER TABLE vessels
  ADD COLUMN IF NOT EXISTS imo TEXT;
ALTER TABLE vessels
  ADD COLUMN IF NOT EXISTS flag TEXT;
ALTER TABLE vessels
  ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE vessels
  ADD COLUMN IF NOT EXISTS dark_vessel_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE vessels
  ADD COLUMN IF NOT EXISTS osint_flag BOOLEAN NOT NULL DEFAULT FALSE;

-- Foundry 동기화 추적 (어떤 행을 이미 push 했는지)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS foundry_synced_at TIMESTAMPTZ;
ALTER TABLE detections
  ADD COLUMN IF NOT EXISTS foundry_synced_at TIMESTAMPTZ;
