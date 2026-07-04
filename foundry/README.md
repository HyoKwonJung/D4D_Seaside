# CableGuard × Palantir Foundry 융합 통합

AIS 단일 소스에서 **멀티센서 융합(RF/SAR/OSINT) + Ontology 엔티티 해석 + 초계 폐루프**로
확장하기 위한 Foundry 측 설계·코드 패키지.

## 왜 하이브리드인가 (dev tier 제약 반영)

Foundry **dev tier는 실시간 대용량을 흡수하면 quota가 즉시 소진**됩니다. 따라서:

```
[레이어 1] 실시간·대용량 → 기존 Node/Vercel MVP 유지 (Foundry에 raw AIS 안 넣음)
      · AISStream firehose, 라이브 지도, Postgres ais_positions
      · 즉시 파생(케이블/loiter/encounter) = 기존 live-review-engine
              │  저볼륨 파생물만 배치 push (lib/foundry-bridge.js)
              ▼
[레이어 2] Foundry = 융합/온톨로지 코어 (저빈도 배치 소스)
      · Data Connection: GFW, StealthMole, MarineTraffic, (RF 배치)
      · Python Transforms: 정규화 → 상관(correlation) → 점수(scoring)
      · Ontology: Vessel / Detection / Event + dark_vessel_status
              │
              ▼
[레이어 3] 폐루프 → Workshop 앱
      · 애널리스트 분류/리뷰, "초계 자산 배치" Action
      · 분류 결과 write-back → Node 대시보드
```

**핵심 우회**: SAR 이미지 ML 파이프라인을 직접 만들지 않고 **GFW의 처리된 SAR 탐지**를 소비.

---

## 디렉터리

```
foundry/
├── README.md                       ← 이 문서 (phase 가이드)
├── API_PROCUREMENT.md              ← 당신이 조달할 API 목록
├── ontology/
│   └── ontology-spec.md            ← Vessel/Detection/Event 오브젝트 + Action 스펙
└── transforms/
    ├── scoring.py                  ← cableguard-domain.js 점수 로직의 Python 포팅
    ├── correlation.py              ← ★키스톤★ AIS ↔ 탐지 시공간 상관
    └── ingestion_adapters.py       ← 소스별 정규화 어댑터 (Detection 공통 스키마로)
lib/foundry-bridge.js               ← Node → Foundry push / write-back 수신 (레이어1↔2 브릿지)
db/migrations/003_multisensor_fusion.sql  ← detections 테이블 + dark_vessel_status
```

---

## 단계별 실행 가이드

범례: 🖱️ = Foundry UI에서 당신이 클릭 · 💻 = 리포지토리 코드(작성됨) · 🔑 = API 조달 필요

### Phase 0 — 기존 데이터로 아키텍처 증명 (신규 조달 0)
목표: **합성 dark_sar를 RF/SAR 탐지 대역으로** 써서 상관→온톨로지→Workshop 폐루프 전체 시연.

1. 💻 `db/migrations/003_...` 적용 → `detections` 테이블 + `dark_vessel_status` 생성 (`npm run db:migrate`)
2. 💻 `lib/foundry-bridge.js`를 `server.js`에 배선 (아래 "배선" 참고) → 파생 이벤트/스냅샷을 Foundry 데이터셋으로 push
3. 🖱️ Foundry: push 대상 **데이터셋 2개**(events, vessel_snapshot) 생성 + 🔑 서비스 토큰/OAuth 앱 발급
4. 🖱️ Foundry Code Repository에 `transforms/scoring.py`, `correlation.py`, `ingestion_adapters.py` 업로드
5. 🖱️ Transform 파이프라인 구성: (합성/라이브 파생) → `ingestion_adapters` → `correlation` → `scoring`
6. 🖱️ **Ontology** 등록: `Vessel`, `Detection`, `Event` (스펙: `ontology/ontology-spec.md`)
7. 🖱️ **Workshop 앱**: 다크 베슬 알림 리스트 + 지도 + 상세 + `classifyDarkVessel` / `taskPatrolAsset` Action 버튼

### Phase 1 — GFW(무료) + StealthMole 실연동
GFW는 저빈도 배치라 **Node(레이어1)에서 폴링 → 정규화 → Foundry push** 방식으로 붙인다
(Foundry External Transform도 가능하나, Node가 이미 OSINT 프록시 패턴을 갖고 있어 일관적).

1. ✅ GFW API token → `.env`의 `GFW_API_TOKEN` (완료)
2. 💻 `lib/gfw.js` — GFW v3 클라이언트 (events + SAR 4Wings + vessel search) **작성됨**
3. 🔎 `node foundry/tools/gfw_probe.js` 실행 → 실제 응답 구조 1회 확인 (라이브 호출, 당신 통제)
4. 💻 `ingestion_adapters.py`의 `normalize_gfw_sar()` / `normalize_gfw_event()` — 확인된 필드로 **작성됨**
   (SAR는 GFW가 `matched` 사전계산 → `matched=false`가 곧 다크. correlation은 2차 검증)
5. 💻 GFW 폴러를 Node에 배선 → detections/events 저장 + `foundry.pushEvent()` push (다음 작업)
6. 💻/🖱️ StealthMole: 선박 식별자(IMO/MMSI/name) 조회 → `Vessel.osint_flag` 링크 (기존 `/api/osint/*` 활용)

### Phase 2 — ⛔ 스코프 제외 (유료/자체 ML)
MarineTraffic(유료), Copernicus 자체 SAR 탐지 ML. **진행 안 함.**
`normalize_marinetraffic()` 등 어댑터 골격만 유지. SAR는 GFW `matched=false`로 커버.

### Phase 3 — ⛔ 스코프 제외 (계약/태스킹)
RF(HawkEye/Unseenlabs/Spire), KOMPSAT. **진행 안 함.**
`Detection`/`normalize_rf()` 스키마는 준비됨 → 향후 계약 시 필드 매핑만 채우면 됨.

---

## Node ↔ Foundry 배선 (Phase 0, step 2)

`lib/foundry-bridge.js`는 **기존 앱을 깨지 않도록 독립 모듈**로 작성됨(자동 배선 안 함).
활성화하려면 `server.js`에서:

```js
const foundry = require("./lib/foundry-bridge.js");
// upsertLiveEvent(event) 성공 후:
foundry.pushEvent(event).catch(() => {});   // 실패해도 앱에 영향 없음
// 주기적으로:
setInterval(() => foundry.pushVesselSnapshot(Array.from(liveVessels.values())), 5 * 60 * 1000);
```

환경변수 미설정 시 브릿지는 **자동 no-op** (Phase 0 이전엔 아무것도 안 보냄).

---

## dark_vessel_status 상태기계 (상관 엔진 산출)

```
unknown        → 아직 판정 전
ais-matched    → 탐지가 AIS 트랙과 게이트 내 매칭 (설명가능, 저위험)
rf-only        → RF 탐지 있으나 매칭 AIS 없음 (잠재 다크)
sar-only       → SAR 탐지 있으나 매칭 AIS 없음 (잠재 다크)
multi-sensor   → RF+SAR 등 복수 무-AIS 탐지 일치 (강한 다크 신호)
confirmed-dark → 애널리스트가 Workshop Action으로 확정
```
