# 해저케이블 위협 인텔리전스 확장 설계서

**대상 브랜치**: `feature/threat-intel-and-dark-vessel-detection` (origin에 push 전, 로컬 검토용)
**작성일**: 2026-07-04
**목표**: CableGuard-MVP에 (A) 지역별 감시 가치 스코어링, (B) 공격 전략 가성비 참조 데이터, (C) AIS 꺼짐(다크선박) 위치추론을 추가하여, "왜 이 구역을 지키는가"와 "AIS를 꺼도 탐지된다"를 실제로 증명하는 시스템으로 확장한다.

---

## 0. 왜 이 세 가지인가 (조사 요약)

기존 코드베이스(`shared/lib/*.js`, `personal/cable_threat_scoring.py`)와 과거 브레인스토밍 기록(`personal/ref/*.html`), 외부 공개 연구를 종합한 결과:

| 항목 | 현재 상태 |
|---|---|
| 공격 신호 탐지 (저속 접근, 배회, 조우) | ✅ 구현됨 (`lib/live-review-engine.js`) |
| 케이블/VTS 참조 데이터 | ⚠️ 있지만 취약 (index.html 정규식 스크래핑, 수동 CSV) |
| **지역별 감시 가치 스코어링** | ❌ 없음. `watch-areas.js`(AOI 경계만), `korea_vts_locations.csv`(VTS 좌표만), `cable_threat_scoring.py`의 `ZONES`(하드코딩 3개, Node와 연결 안 됨)로 3곳에 분산 |
| **공격 가성비/전략 비교 데이터** | ❌ 없음. `cable_threat_scoring.py`에 방어자 비용(`exp_loss vs interdictor.cost_usd`)만 있고, 공격자 비용 모델은 없음 |
| **AIS 꺼짐(다크선박) 위치추론** | ❌ 전혀 없음. `ais_status`/`sar_matched` 필드는 스키마·스코어링(`calculateRiskScore`)에 이미 존재하지만, 이를 실제로 산출하는 로직이 없음 — synthetic 데모 데이터에만 하드코딩됨 |

즉 세 가지 모두 "필드는 있는데 채우는 로직이 없다"는 동일한 패턴의 공백이다. 이 설계서는 그 공백을 메운다.

---

## 1. 설계 원칙 (기존 프로젝트 철학 계승)

`shared/README.md`에 명시된 원칙을 그대로 따른다:
- **설명 가능성 우선**: 블랙박스 ML 대신, 규칙 기반 + 물리 모델(Kalman) — 왜 점수가 나왔는지 항상 증거(evidence)로 설명 가능해야 함
- **위협 확정이 아닌 우선순위화**: 이 시스템은 "적대 행위 확정"이 아니라 "검토 우선순위 산정"이 목적
- **사람 승인 없는 자동 조치 금지**: 모든 신규 로직도 "검토 대상 이벤트 생성"까지만 하고, 대응 여부는 사람이 결정
- **기존 스키마/스코어링과의 정합성**: `calculateRiskScore`의 `event_type` 베이스 점수 테이블에 이미 `ais_gap: 20`이 존재함 — 이번 설계는 이 슬롯을 실제로 채우는 것이지 새 스코어링 체계를 만드는 게 아님

---

## 2. 컴포넌트 A — 지역별 감시 가치 스코어링 (Area Surveillance Value)

### 2.1 개념

한국 해저케이블 9개 중 7개가 거제-부산 접근로(폭 ~50km, 수심 ~90m)에 집중된다는 사실은 이미 학술적으로 확인됨 (O'Malley, "Assessing Threats to South Korea's Undersea Communications Cable Infrastructure," *Korean Journal of International Studies*, 2019, https://www.kjis.org/journal/view.html?uid=242). `personal/cable_threat_scoring.py`는 이미 이 개념을 `recovery_coeff`(1.5~3.0)로 코드화했으나 3개 구역에 하드코딩되어 있고 Node 쪽 라이브 시스템과 연결되지 않는다.

이를 **`watch-areas.js`를 확장한 5요소 가중합 공식**으로 통합·일반화한다:

```
surveillance_value (0-100) =
    0.35 * chokepoint_score        // 통로 폭/수심 기반 (좁고 얕을수록 높음)
  + 0.30 * cable_density_score     // 이 구역을 지나는 케이블 수 / 전국 케이블 수
  + 0.15 * redundancy_deficit_score // 우회 경로 없음=100, 부분=50, 충분=0
  + 0.10 * incident_history_score  // 실제/유사 사건 이력 (한국은 현재 0 — 아래 4.4 참조)
  + 0.10 * landing_proximity_score // 육양국 반경 20km 이내 여부 (거리 감쇠)
```

가중치는 O'Malley(2019)와 Windward/NATO 공개 자료가 공통적으로 초크포인트 지형을 최우선 요인으로 꼽는 점을 반영해 `chokepoint_score`와 `cable_density_score`에 65%를 배정했다. **초기값이며, 실사용 후 튜닝 대상** (섹션 8 참조).

이 값은 최종적으로 `cable_threat_scoring.py`와 동일한 척도로 변환해 기존 코드와 정합성을 맞춘다:
```
recovery_coeff = 1.0 + 2.0 * (surveillance_value / 100)   // 범위 1.0 ~ 3.0, 기존 ZONES와 동일 스케일
```

### 2.2 데이터 스키마 (신규 테이블, `db/migrations/003_...sql`)

```sql
CREATE TABLE watch_zones (
  id              TEXT PRIMARY KEY,          -- 'korea-strait-chokepoint' 등, watch-areas.js의 id와 매칭
  name            TEXT NOT NULL,
  bounds          JSONB NOT NULL,            -- [[swLat,swLon],[neLat,neLon]], 기존 MARITIME_WATCH_AOIS와 동일 포맷
  chokepoint_width_km   NUMERIC,
  chokepoint_depth_m    NUMERIC,
  cable_count           INTEGER NOT NULL DEFAULT 0,
  total_national_cables INTEGER NOT NULL DEFAULT 9,   -- 갱신 가능한 상수
  redundancy_class      TEXT CHECK (redundancy_class IN ('none','partial','full')),
  landing_station_distance_km NUMERIC,
  incident_history_score NUMERIC DEFAULT 0,
  surveillance_value     NUMERIC,            -- 계산값 캐시 (수집기가 갱신)
  recovery_coeff         NUMERIC,            -- 계산값 캐시
  source_notes           TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

기존 `events.watch_area_id`는 그대로 두고, 조회 시 `watch_zones.id`와 조인한다 (현재 `MARITIME_WATCH_AOIS`의 4개 광역 AOI는 유지 — AISStream 구독용 bounding box로 계속 사용. `watch_zones`는 그보다 세분화된 "가치 평가 단위"로 별도 운용. 예: `korea-strait` AOI 안에 `geoje-busan-chokepoint`라는 세분 `watch_zones` 항목을 둠).

### 2.3 데이터 수집기 설계 (`scripts/collect-reference-data.js`)

가장 신뢰도 높은 무료 공개 소스는 **data.go.kr의 KHOA 해저케이블 Shapefile**(데이터셋 15130167, 무제한 라이선스)과 **해양수산부 연안 시설물 WFS/WMS API**(15075777/78/79, 1·3·5km 대역, 해저케이블 포함)이다. 둘 다 `SERVICE_KEY` 발급이 필요하다 (공공데이터포털 무료 가입).

수집기는 두 단계로 설계한다:

1. **오프라인 모드 (키 없이 즉시 사용 가능)**: 이미 `public/index.html`에 있는 `CABLES` 배열(각 케이블에 이미 `threat: 1-3` 필드가 있으나 근거 없이 수동 부여됨)과 O'Malley(2019) 논문 기반으로 수동 확정한 거제-부산/제주남방/서해 3개 초크포인트 지오메트리를 사용해 `watch_zones`를 시딩한다. **지금 바로 실행 가능.**
2. **온라인 모드 (`KHOA_DATA_GO_KR_SERVICE_KEY` 환경변수 설정 시)**: KHOA Shapefile을 다운로드(`npm i shapefile` 필요 — 신규 의존성)해 실제 케이블 경로와 대조, `cable_count`/좌표 정밀도를 갱신. 기존 `lib/cable-reference.js`의 정규식 스크래핑을 이 수집기의 출력(JSON)으로 교체.

```js
// scripts/collect-reference-data.js (설계 스펙, 아직 미구현)
// 1. loadSeedZones()               -- 오프라인 시드 (하드코딩, O'Malley 2019 근거 주석 포함)
// 2. fetchKhoaCableShapefile(key)  -- SERVICE_KEY 있으면 실행, 없으면 스킵 + 경고 로그
// 3. computeSurveillanceValue(zone) -- 위 공식 적용
// 4. upsertWatchZones(db, zones)   -- watch_zones 테이블에 upsert
// 5. writeCableReferenceCache(cables) -- lib/cable-reference.js가 읽는 JSON 캐시 파일 갱신 (index.html 정규식 스크래핑 대체)
```

### 2.4 통합 지점

- `lib/watch-areas.js`에 `getSurveillanceValue(watchZoneId)` / `getRecoveryCoefficient(watchZoneId)` 추가 (DB 또는 메모리 캐시 조회)
- `public/shared/cableguard-domain.js`의 `enrichEvent(input, options)` — **options에 `areaValueMultiplier` 신규 파라미터 추가** (기본값 1.0, 하위 호환):
  ```js
  // enrichEvent 내부, line 181 직후
  let score = calculateRiskScore(event);
  score = Math.round(score * (options.areaValueMultiplier || 1.0));
  score = Math.min(100, score); // clamp 유지
  ```
- `server.js`/`live-review-engine.js`의 각 `domain.enrichEvent({...})` 호출부에서 `watchArea.id → getRecoveryCoefficient()`로 조회한 값을 `options.areaValueMultiplier`로 전달

---

## 3. 컴포넌트 B — 공격 전략 가성비 참조 데이터 (Attack Strategy Cost-Efficiency Reference)

### 3.1 개념

실제 사건 데이터(2023-2025 발트해/대만/홍해)를 정량화하면, "앵커 드래깅"이 압도적으로 가성비 높은 공격 수단임이 드러난다:

| 지표 | 앵커 드래깅 (운항중 위장) | 수중 절단장비 (특수선박/ROV) | 심해 무인잠수정 (예: Haidou-1급) |
|---|---|---|---|
| 공격자 직접비용 | ~$0 (이미 항해 중인 상선이 닻만 내림) | 높음 (특수장비+운용선박) | 매우 높음 (국가급 자산) |
| 평균 수리비 유발 | $1-3M (통신), €50-80M (전력, Estlink2 사례) | 불명 (관측 사례 없음) | 불명 (관측 사례 없음) |
| 기소/처벌 확률 (관측 기반) | **낮음** — 9개 주요 사건 중 유죄 확정 1건(Hong Tai 58, 대만이 현행범 나포 성공) | N/A | N/A (AIS 자체가 없어 탐지 난이도 최고) |
| 탐지 난이도 | 중간 (AIS로 추적되다가 사건 직전 공백 발생 — 이 공백이 이번 설계 C의 탐지 대상) | 높음 | 매우 높음 (현 AIS/SAR 체계로 사실상 탐지 불가, DAS 등 별도 센서 필요) |
| 대표 사례 | Newnew Polar Bear(2023), Yi Peng 3(2024), Eagle S(2024), Shunxin-39(2025), Fitburg(2025) | 중국 예인식 절단장치 특허(2009,2020) — **관측 사례 없음, 위협 정보로만 존재** | 미래 위협으로 언급됨 — **관측 사례 없음** |

**핵심 시사점**: 관측된 모든 실제 사건이 "앵커 드래깅"이라는 한 가지 수법에 집중되어 있다. 이는 `cable_threat_scoring.py`의 `SIGNAL_WEIGHTS`가 이미 `anchor_suspected: 0.30`(최고 가중치)로 설정한 것이 데이터로 뒷받침됨을 의미한다 — **이 설계는 새 탐지 우선순위를 만드는 게 아니라 기존 우선순위가 옳았음을 실증 데이터로 검증하고, 그 근거를 시스템에 명시적으로 담는 것**이다.

### 3.2 데이터셋 (실제 사례, 전량 출처 확인됨)

```json
[
  {
    "case_id": "newnew-polar-bear-2023",
    "date": "2023-10-08",
    "location": "Baltic Sea (Balticconnector corridor)",
    "vessel_flag": "Hong Kong-linked",
    "method": "anchor_drag_transit",
    "cables_damaged": ["Balticconnector gas pipeline", "EE-FI telecom cable"],
    "repair_cost_usd_est": [35000000, 40000000],
    "prosecution_outcome": "China blocked cooperation ~10 months; captain tried only in Hong Kong (2025), not guilty plea",
    "source": "https://en.wikipedia.org/wiki/Newnew_Polar_Bear"
  },
  {
    "case_id": "yi-peng-3-2024",
    "date": "2024-11-17",
    "location": "Baltic Sea (Germany-Finland, Lithuania-Sweden)",
    "vessel_flag": "China",
    "method": "anchor_drag_transit",
    "cables_damaged": ["C-Lion1", "BCS East-West Interlink"],
    "ais_gap_hours": 7.5,
    "prosecution_outcome": "China controlled sole inspection, barred Swedish prosecutor from boarding, no charges",
    "source": "https://en.wikipedia.org/wiki/2024_Baltic_Sea_submarine_cable_disruptions"
  },
  {
    "case_id": "eagle-s-2024",
    "date": "2024-12-25",
    "location": "Baltic Sea (Estlink 2 corridor)",
    "vessel_flag": "Cook Islands (Russia shadow fleet)",
    "method": "anchor_drag_transit",
    "cables_damaged": ["Estlink 2 (power)", "4x telecom cables"],
    "anchor_drag_distance_km": 90,
    "repair_cost_usd_est": [50000000, 80000000],
    "vessel_scrap_value_usd_est": [10000000, 15000000],
    "prosecution_outcome": "Finland seized vessel (rare success), Helsinki court dismissed all charges 2025-10-03 for lack of jurisdiction (EEZ, not territorial waters)",
    "source": "https://en.wikipedia.org/wiki/2024_Estlink_2_incident"
  },
  {
    "case_id": "shunxin-39-2025",
    "date": "2025-01-03",
    "location": "Taiwan Strait (TPE cable, north of Taipei)",
    "vessel_flag": "Cameroon (Hong Kong-owned shell)",
    "method": "anchor_drag_transit",
    "identity_evasion": "used 6 different AIS MMSIs / 2+ vessel names over 6 months",
    "prosecution_outcome": "evaded boarding entirely",
    "source": "https://www.twz.com/news-features/taiwan-coast-guard-blames-chinese-owned-ship-for-cutting-undersea-communications-cable"
  },
  {
    "case_id": "hong-tai-58-2025",
    "date": "2025-02",
    "location": "Taiwan Strait (TPKM-3 cable, near Penghu)",
    "vessel_flag": "China-crewed",
    "method": "anchor_drag_transit",
    "prosecution_outcome": "ONLY successful prosecution — captain jailed 3 years + ~$560K damages, because Taiwan physically caught the ship before escape",
    "source": "https://www.voanews.com/a/chinese-vessel-suspected-of-damaging-undersea-cable-near-taiwan/7926977.html"
  },
  {
    "case_id": "vezhen-2025-control",
    "date": "2025-01-26",
    "location": "Baltic Sea",
    "method": "anchor_drag_transit",
    "note": "CONTROL CASE — ruled accidental (weather + seamanship), not sabotage. Useful for false-positive calibration.",
    "source": "https://euronews.com/my-europe/2025/02/03/sweden-releases-bulgarian-ship-after-ruling-out-sabotage"
  },
  {
    "case_id": "rubymar-2024",
    "date": "2024-02",
    "location": "Red Sea (Bab al-Mandab)",
    "method": "anchor_drag_disabled_vessel",
    "cables_damaged": ["AAE-1", "EIG", "Seacom"],
    "note": "Non-premeditated — Houthi-missile-disabled vessel drifted and dragged anchor while sinking. Edge case: exploited conflict-zone chaos, ~5mo repair delay due to access restrictions.",
    "source": "https://en.wikipedia.org/wiki/MV_Rubymar"
  }
]
```

이 JSON을 `db/seed/attack_case_studies.json`으로 저장하고, `attack_strategy_reference` 테이블(방법론별 집계)의 `evidence_case_ids`가 이를 참조한다.

### 3.3 스키마

```sql
CREATE TABLE attack_strategy_reference (
  method_key            TEXT PRIMARY KEY,   -- 'anchor_drag_transit', 'deliberate_cut_tool', 'deep_sea_cut_uuv', ...
  name_ko               TEXT NOT NULL,
  name_en               TEXT NOT NULL,
  direct_cost_usd_est   NUMERIC,            -- 공격자 한계비용 (앵커 드래깅은 ~0으로 floor 10000 적용, 나눗셈 방지)
  repair_cost_usd_low   NUMERIC,
  repair_cost_usd_high  NUMERIC,
  downtime_days_low     NUMERIC,
  downtime_days_high    NUMERIC,
  observed_incident_count INTEGER NOT NULL DEFAULT 0,
  successful_prosecution_count INTEGER NOT NULL DEFAULT 0,
  deniability_score     NUMERIC,   -- 0~1, (관측사건 - 기소성공)/관측사건 근사
  detectability_difficulty NUMERIC, -- 0~1, 정성 평가 (현재 시스템 기준)
  cost_efficiency_score NUMERIC,   -- (repair_cost_avg * deniability_score) / direct_cost_usd_est
  is_observed           BOOLEAN NOT NULL DEFAULT true,  -- false = 특허/이론상 위협 (예: UUV, 절단장비)
  evidence_case_ids     JSONB,
  notes                 TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.4 통합 지점 (중요: 실시간 스코어링에 직접 넣지 않는다)

공격자의 "비용"은 AIS 데이터만으로 실시간에 알 수 없다 — 이 값은 **분석·설명 계층**에서만 쓴다:
1. `generateRecommendation()` (`cableguard-domain.js`)에 사례 기반 문구 주입: 이벤트가 `anchor_suspected`류 신호(저속+케이블 근접+정지)를 만족하면, "이 패턴은 Yi Peng 3/Eagle S 사건과 유사하며, 사후 기소 성공률이 낮으므로 즉각적 물증 확보가 우선순위"라는 설명을 evidence에 추가
2. 신규 API 엔드포인트 `GET /api/attack-strategy-reference` — 커맨더 대시보드에 "왜 이 신호에 자원을 배분하는가"를 보여주는 참고 패널용 (기존 `/api/osint/*`와 같은 패턴)
3. `SIGNAL_WEIGHTS`(현재 `cable_threat_scoring.py`에만 존재) 튜닝 시 `cost_efficiency_score` 순위를 근거 자료로 사용 — **자동 반영이 아니라 사람이 검토 후 조정**하는 입력값

---

## 4. 컴포넌트 C — AIS 꺼짐(다크선박) 위치추론 (가장 중요한 공백)

### 4.1 알고리즘: Constant-Velocity Kalman Filter + 신뢰반경 확장

연구 결과(Jaskólski 2017 이산 Kalman 필터, Fossen & Fossen 2018 EKF)에서 검증된 표준 기법을 채택한다. GFW의 SAR-AIS 매칭 방식(위성 SAR로 AIS 없는 선박을 잡아내는 방식)은 상용 SAR 구독이 필요해 당장은 도입 불가 — 대신 **AIS 자체의 시계열 공백을 탐지해 마지막 알려진 상태로부터 현재 위치를 확률적으로 추정**하는, 추가 데이터 소스 없이 지금 바로 구현 가능한 방법을 1차로 구현한다.

```
상태벡터 x = [x, y, vx, vy]   (마지막 확인 위치 기준 로컬 평면좌표, 미터)

예측 (predict-only, AIS 공백 동안 반복):
  x_k = F * x_(k-1)          F = [[1,0,dt,0],[0,1,0,dt],[0,0,1,0],[0,0,0,1]]
  P_k = F * P_(k-1) * F^T + Q   // Q: 과정잡음 — 공백 중 기동 가능성을 반영해 충분히 크게 설정
                                 // → 공백이 길어질수록 P(불확실성)가 계속 커짐 (핵심 성질)

갱신 (새 AIS 메시지 수신 시):
  표준 Kalman gain으로 위치 보정, P 축소

투사 위치 불확실 반경 (2-sigma, ~95%):
  uncertainty_radius_nm = 2 * sqrt(max(eig(P_position)))
```

이는 별도 라이브러리 없이 4x4 행렬 연산만으로 순수 JS 구현 가능하다 (`lib/dark-vessel-inference.js`, 신규 파일, 의존성 추가 없음).

### 4.2 게이트/임계값 (신규 상수, `live-review-engine.js`와 동일한 스타일)

```js
const AIS_GAP_WARN_MINUTES = 15;      // Class A는 통상 수 초~수십 초 간격 송신 — 15분 이상 침묵은 이미 이례적
const AIS_GAP_DARK_MINUTES = 45;      // 이 이상이면 ais_status: "off" (다크 분류)로 승격
const DARK_VESSEL_PROXIMITY_NM = 15;  // 마지막 확인 위치가 케이블에서 15nm 이내였던 선박만 감시 대상
                                       // (원해로 나가 자연 소실되는 선박까지 전부 감시하면 계산량/오탐 폭증)
```

- `AIS_GAP_WARN_MINUTES` 경과: `ais_status: "intermittent"` (`calculateRiskScore`에서 +12점, 기존 로직 그대로 재사용)
- `AIS_GAP_DARK_MINUTES` 경과: `ais_status: "off"` (+20점, 기존 로직 그대로 재사용) + `event_type: "ais_gap"` (베이스 20점, 기존 슬롯 그대로 사용)
- 투사 위치가 케이블 버퍼(5nm, 기존 `deriveCableRiskEvent`와 동일 기준) 안에 들어오면 즉시 이벤트 생성/갱신, 아니면 감시만 계속하고 이벤트는 만들지 않음 (원양에서 자연스럽게 AIS 사각지대에 들어간 선박까지 알람을 내면 오탐 폭증)
- **재출현 시 추가 신호**: AIS가 다시 잡혔을 때 실제 위치와 투사 위치의 편차(`unexplained_reappearance_deviation_nm`)가 불확실 반경보다 훨씬 크면 "회피 기동 의심" 보너스 신호로 기록 (2단계 구현 — 아래 8절 참조)

### 4.3 스키마 변경 (`events` 테이블에 컬럼 추가, 기존 001/002와 같은 패턴)

```sql
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS gap_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_confirmed_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS last_confirmed_lon NUMERIC,
  ADD COLUMN IF NOT EXISTS projected_lat NUMERIC,
  ADD COLUMN IF NOT EXISTS projected_lon NUMERIC,
  ADD COLUMN IF NOT EXISTS position_uncertainty_nm NUMERIC;
```

### 4.4 통합 지점

1. **`lib/dark-vessel-inference.js` (신규)**: `KalmanTrackFilter` 클래스 + `evaluateAisGap(vessel, track, cables, now)` 함수 — 위 알고리즘 구현
2. **`server.js`에 watchdog 추가** — 기존 `startBackgroundServices()`의 `setInterval` 패턴을 그대로 따름:
   ```js
   setInterval(sweepDarkVesselCandidates, DARK_VESSEL_SWEEP_MS);  // 예: 5분
   ```
   `sweepDarkVesselCandidates()`는 `liveVessels` Map(또는 영속화 시 `vessel_latest_state` 테이블 — 재시작 후에도 공백 추적 유지 가능)을 순회하며 `evaluateAisGap` 실행 후 `deriveLiveEvents`와 동일한 방식으로 `upsertLiveEvent` 호출
3. **`live-review-engine.js`의 `deriveLiveEvents`에는 추가하지 않는다** — 이 함수는 "메시지 수신 시" 트리거인데, 다크선박은 정의상 메시지가 끊겼을 때 감지하는 것이므로 별도의 시간 기반 watchdog이어야 함 (구조적으로 다른 트리거 — 설계상 중요한 구분점)
4. **VTS 식별 예외 처리 재검토**: 기존 3개 탐지기는 VTS 반경 20km 이내 선박을 자동 제외하지만(`isVtsIdentified`), 다크선박 탐지는 **VTS 식별 여부와 무관하게 평가**해야 한다 — VTS 관제 중이던 선박이 갑자기 AIS를 끄는 것 자체가 이례적 신호이기 때문 (VTS 반경 안에서의 정상 저속 운항과는 본질적으로 다른 케이스)

---

## 5. 마이그레이션 계획

`db/migrations/003_threat_intel_expansion.sql`:
1. `CREATE TABLE watch_zones (...)`
2. `CREATE TABLE attack_strategy_reference (...)`
3. `ALTER TABLE events ADD COLUMN ... (gap_started_at 등 6개 컬럼)`
4. `schema_migrations`에 버전 기록 (기존 `scripts/db-migrate.js` 패턴 그대로 사용, 신규 마이그레이션 러너 불필요)

Postgres 미설정 환경(로컬 데모)에서는 기존과 동일하게 인메모리로 동작 — `watch_zones`/`attack_strategy_reference`는 DB 없을 때 `lib/watch-areas.js`/신규 `lib/attack-strategy-reference.js` 내 하드코딩 시드 데이터로 폴백한다 (기존 `cable-reference.js`의 캐시 패턴과 동일).

---

## 6. 구현 순서 (사용자 확정: 단계별 진행 + 매 단계 동작 확인)

| 단계 | 산출물 | 확인 방법 |
|---|---|---|
| **1. 지역가치 스코어링** | `003_...sql`(watch_zones 부분), `lib/watch-areas.js` 확장, `scripts/collect-reference-data.js`(오프라인 모드), `enrichEvent` areaValueMultiplier 배선 | `npm run check` 통과 + 시드 데이터로 거제-부산 구역이 실제로 가장 높은 `surveillance_value`를 받는지 콘솔 출력으로 확인 |
| **2. 공격 가성비 참조데이터** | `003_...sql`(attack_strategy_reference 부분), `db/seed/attack_case_studies.json`, `lib/attack-strategy-reference.js`, `/api/attack-strategy-reference` 엔드포인트, `generateRecommendation` 문구 주입 | API 호출로 앵커드래깅이 최고 `cost_efficiency_score`를 받는지 확인 |
| **3. AIS 갭 다크선박 추론** | `lib/dark-vessel-inference.js`(Kalman 필터), `server.js` watchdog 배선, `003_...sql`(events 컬럼 추가) | 유닛 테스트: 가상 트랙에 인위적 공백을 주입해 `evaluateAisGap`이 올바른 투사위치/불확실반경을 내는지 검증 + 실제 AISStream 연결 후 일정 시간 관찰 |

각 단계 완료 후 사용자에게 결과를 보여주고 다음 단계로 진행할지 확인한다.

---

## 7. 사용자 결정이 필요한 사항

1. **data.go.kr SERVICE_KEY**: KHOA 해저케이블 Shapefile / MOF 연안시설물 API를 쓰려면 공공데이터포털(data.go.kr) 가입 후 무료 키 발급 필요 — 발급 전에는 오프라인 시드 데이터로 진행. 발급 의향 있는지?
2. **`shapefile` npm 패키지 추가**: 온라인 모드 구현 시 신규 의존성 1개 추가됨 — 승인 필요 (package.json 변경은 팀 저장소에 영향)
3. **Postgres 연결 여부**: 현재 `DATABASE_URL` 미설정 시 인메모리로만 동작 — 다크선박 watchdog은 서버 재시작 시 공백 추적이 끊긴다는 한계가 있음. 영속화하려면 Postgres 필요 (이미 `.env.example`에 옵션으로 존재, 신규 요구사항 아님)
4. **초기 가중치 값들** (`surveillance_value`의 0.35/0.30/0.15/0.10/0.10, `AIS_GAP_WARN/DARK_MINUTES` 등)은 전부 "초기값, 실사용 후 튜닝 대상"으로 명시했다 — 이대로 1차 구현 진행해도 괜찮은지, 아니면 특정 값에 대해 의견이 있는지?

---

## 8. 향후 확장 (이번 범위 밖, 참고용)

- SAR 실데이터 연동 (`sar_matched` 필드를 실제로 채우는 것 — 현재 Sentinel-1 무료 재처리 파이프라인(GFW xView3-SAR, https://arxiv.org/abs/2206.00897, 오픈소스 모델 https://github.com/allenai/sar_vessel_detect)을 참고할 수 있으나, 자체 위성 수신/처리 인프라가 필요해 이번 범위에서는 제외
- 재출현 시 궤적 편차 기반 "회피 기동 의심" 신호 (4.2절 언급)
- RF/음향(DAS) 센서 融합 — `cable_threat_scoring.py`의 `p_rf`/`p_das` 필드가 이미 자리를 마련해둠

---

## 참고 자료 (전체 출처)

**사건 사례**: Newnew Polar Bear(en.wikipedia.org/wiki/Newnew_Polar_Bear), 2024 Baltic Sea disruptions(en.wikipedia.org/wiki/2024_Baltic_Sea_submarine_cable_disruptions), Eagle S/Estlink2(en.wikipedia.org/wiki/2024_Estlink_2_incident), Shunxin-39(twz.com/news-features/taiwan-coast-guard-blames-chinese-owned-ship-for-cutting-undersea-communications-cable), Hong Tai 58(voanews.com/a/chinese-vessel-suspected-of-damaging-undersea-cable-near-taiwan/7926977.html), Vezhen(euronews.com/my-europe/2025/02/03/sweden-releases-bulgarian-ship-after-ruling-out-sabotage), Rubymar(en.wikipedia.org/wiki/MV_Rubymar)

**학술/기술 문헌**: O'Malley (2019), KJIS — kjis.org/journal/view.html?uid=242; Jaskólski (2017) Kalman filter AIS reconstruction; Fossen & Fossen (2018) EKF AIS prediction; Wijaya & Nakamura (2023) PeerJ CS 9:e1572, 로이터링 탐지 Isolation Forest — pmc.ncbi.nlm.nih.gov/articles/PMC10557514; GFW xView3-SAR — arxiv.org/abs/2206.00897, github.com/allenai/sar_vessel_detect

**공개 데이터**: data.go.kr KHOA 해저케이블(data.go.kr/data/15130167/fileData.do), MOF 연안시설물 WFS(data.go.kr/data/15075777~9/openapi.do), TeleGeography Submarine Cable Map(submarinecablemap.com)

**기관/상용 프레임워크(개념 참고용)**: NATO Baltic Sentry(nato.int/en/news-and-events/articles/news/2025/01/14/nato-launches-baltic-sentry-to-increase-critical-infrastructure-security), Windward(windward.ai/blog/protecting-critical-maritime-infrastructure-in-2026), Spire(spire.com/blog/maritime/how-position-validation-is-changing-the-insights-into-ais-and-helping-to-solve-dark-vessel-detection)

**내부 소스**: `personal/ref/*.html` (6개 과거 설계 대화 기록), `personal/cable_threat_scoring.py` (기존 P0-P3 신호체계/기대손실 모델)
