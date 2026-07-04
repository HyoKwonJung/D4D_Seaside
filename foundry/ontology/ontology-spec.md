# Ontology 스펙 (Foundry UI에서 등록)

이 문서는 Foundry Ontology Manager에서 만들 **오브젝트 타입 3개 + 링크 + Action 4개**의 명세입니다.
스키마는 `db/migrations/003_multisensor_fusion.sql`(Node 측 저장) 및
`transforms/*.py`(Foundry 측 파생)와 필드명을 일치시켰습니다.

---

## 오브젝트 타입 1: `Vessel` (선박 — 엔티티 해석의 중심)

| 속성 | 타입 | 설명 |
|---|---|---|
| `vessel_key` (PK) | string | 해석된 식별자. MMSI 있으면 `mmsi:<n>`, 다크면 `dark:<uuid>` |
| `mmsi` | string? | AIS 있을 때만 |
| `imo` | string? | OSINT/제원 보강 |
| `vessel_name` | string | 기본 "Unknown" |
| `flag` | string? | 선적국 |
| `owner` | string? | MarineTraffic 등 보강 |
| `dark_vessel_status` | string | 상태기계 (README 참고) |
| `latest_lat` / `latest_lon` | double? | 최신 위치(AIS 또는 최근 탐지) |
| `latest_seen_at` | timestamp | |
| `risk_score` | integer | 연결 이벤트 최대 점수 |
| `osint_flag` | boolean | StealthMole 언급 존재 |

**엔티티 해석 규칙**: 탐지가 AIS와 매칭되면 해당 `Vessel(mmsi:*)`에 링크. 미매칭이면
새 `Vessel(dark:*)` 생성(또는 근접한 기존 dark 베슬에 병합 — 상관 엔진의 `dark_track_id`).

---

## 오브젝트 타입 2: `Detection` (센서 원탐지 — MMSI 없을 수 있음)

| 속성 | 타입 | 설명 |
|---|---|---|
| `detection_id` (PK) | string | `<source>:<external_id>` |
| `source` | string | `ais` / `rf` / `sar` / `optical` |
| `provider` | string? | aisstream / gfw / hawkeye / unseenlabs / kompsat ... |
| `detected_at` | timestamp | |
| `lat` / `lon` | double | |
| `confidence` | double? | 제공자 신뢰도 |
| `matched_mmsi` | string? | 상관 엔진 산출 (없으면 미매칭) |
| `match_distance_nm` | double? | 매칭 게이트 거리 |
| `match_time_delta_s` | double? | 매칭 게이트 시간차 |
| `dark_candidate` | boolean | `matched_mmsi IS NULL AND source != 'ais'` |
| `raw_payload_json` | string? | 원본 |

**링크**: `Detection → Vessel` (many-to-one, `matched_mmsi` 또는 `dark_track_id` 경유).

---

## 오브젝트 타입 3: `Event` (파생 위험 이벤트 — 기존 events 테이블과 동형)

기존 `db/migrations/001` events 스키마를 그대로 승격. 주요 속성:

| 속성 | 타입 | 설명 |
|---|---|---|
| `event_id` (PK) | string | `LIVE-CABLE-*`, `DARK-RF-*` 등 |
| `event_type` | string | dark_sar / ais_loitering / ais_gap / encounter / dragging_like / live_ais_review / **rf_dark** / **sar_dark** |
| `source` | string | synthetic_injection / aisstream / rf / sar |
| `risk_score` / `risk_level` | int / string | scoring.py 산출 |
| `rf_matched` / `sar_matched` | boolean? | **신규** — 미매칭이면 점수 가산 |
| `dark_vessel_status` | string | 상관 결과 반영 |
| `distance_to_cable_nm` | double? | |
| `recommendation` | string | scoring.py 산출 (초계/UAV 검증 등) |
| `evidence` | string[] | 설명가능 근거 |
| `review_status` | string | unverified/reviewed/verified/escalated |

**링크**: `Event → Vessel`, `Event → Detection[]` (이벤트 근거가 된 탐지들).

---

## Action 타입 (Workshop 폐루프)

### `classifyDarkVessel`
- 대상: `Vessel`
- 입력: `dark_vessel_status`(선택지), `notes`
- 효과: 상태 갱신 + 감사 로그 append (기존 event_reviews 패턴 승계)

### `taskPatrolAsset`  ★폐루프 핵심★
- 대상: `Vessel` 또는 `Event`
- 입력: `asset_type`(UAV/coastal-radar/patrol-boat), `priority`, `notes`
- 효과: 초계 임무 오브젝트 생성 + 상태 `tasking`. (탐지→융합→**검증자산 재지시** 폐루프 완성)

### `saveReview`
- 대상: `Event`
- 입력: `review_status`, `reviewer_name`, `notes`
- 효과: 기존 `/api/events/:id/review`와 동형. write-back으로 Node 대시보드 동기화

### `mergeDarkTracks`
- 대상: `Vessel[]` (dark:*)
- 효과: 중복 다크 트랙을 하나의 엔티티로 병합 (엔티티 해석 보정)

---

## Ontology 등록 순서 (UI)

1. `Vessel` → `Detection` → `Event` 오브젝트 타입 생성 (위 속성)
2. 링크 타입: Detection→Vessel, Event→Vessel, Event→Detection
3. 각 오브젝트를 Phase별 파생 데이터셋에 백킹(back)
4. Action 4종 등록 + 권한
5. Workshop 앱에서 오브젝트/Action 배치
