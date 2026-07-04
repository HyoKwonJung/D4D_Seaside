# API 조달 체크리스트 (당신이 준비할 것)

CableGuard 멀티센서 융합(Foundry Ontology + 폐루프)에 필요한 외부 소스 목록입니다.
우선순위 = Phase 순서. 각 항목의 **auth 방식**과 **정규화 타깃**(코드가 기대하는 필드)을 맞춰 오면
`foundry/transforms/ingestion_adapters.py`의 해당 어댑터에 필드 매핑만 채우면 됩니다.

> **현재 스코프 결정 (2026-07-04)**: 유료/발주가 필요한 소스는 진행하지 않음.
> **진행: Phase 0 + Phase 1 (GFW 무료 + StealthMole 보유)**.
> Phase 2(MarineTraffic 유료 / Copernicus 자체 SAR ML) · Phase 3(RF / KOMPSAT 계약)은
> **스코프 제외** — 스키마/어댑터 골격만 유지하고 데이터는 붙이지 않음.
> SAR는 GFW `matched=false`로 이미 커버되므로 자체 SAR 파이프라인 불필요.

---

## Phase 0 — 신규 조달 불필요 (이미 보유)

| 소스 | 상태 | auth | 용도 |
|---|---|---|---|
| **AISStream.io** | ✅ 보유 (`AISSTREAM_API_KEY`) | API Key | 실시간 AIS (레이어1, Node에 유지) |
| **StealthMole** | ✅ 보유 (hackathon 키) | JWT(HS256, access/secret) | OSINT 교차검증 |
| **합성 시나리오** | ✅ 리포지토리 내장 | - | 상관 엔진 테스트 픽스처 (RF/SAR 대역) |

> Phase 0은 위 3개만으로 Ontology + 상관 + Workshop 폐루프 전체를 시연합니다.

---

## Phase 1 — 무료 API (등록만 하면 됨) · **최우선 조달**

### 1. Global Fishing Watch API  ★가장 중요★
- **등록**: https://globalfishingwatch.org/our-apis/  → API access token 신청 (무료, 승인 수일)
- **auth**: Bearer token (`Authorization: Bearer <token>`)
- **주는 것**:
  - Vessel search (identity/owner)
  - **Events API**: encounter / loitering / gap / port-visit  ← 우리 rule engine 교차검증
  - **SAR detections** (Sentinel-1 기반, 이미 처리됨) ← **SAR 이미지 처리 우회 핵심**
- **환경변수**: `GFW_API_TOKEN`
- **정규화 타깃**: SAR detection → `Detection`(source=`sar`), events → `Event` 교차검증

### 2. StealthMole (이미 보유 — Foundry로 확장만)
- Foundry External Transform에서 호출하거나, Node가 결과를 push
- **정규화 타깃**: 선박 식별자(IMO/MMSI/name) 언급 → `Vessel`에 osint_flag 링크

---

## Phase 2 — ⛔ 스코프 제외 (유료/자체 ML)

> 진행하지 않음. 어댑터 골격만 리포지토리에 유지.

### 3. MarineTraffic API
- **등록**: https://www.marinetraffic.com/en/online-services/  → API 서비스 구매(유료)
- **auth**: API key (URL param 또는 header)
- **주는 것**: 마지막 AIS 위치(PS 계열), 선박 제원·소유주·fleet(VD 계열)
- **환경변수**: `MARINETRAFFIC_API_KEY`
- **정규화 타깃**: `Vessel` 제원/소유주 보강

### 4. Copernicus Data Space Ecosystem (Sentinel-1 SAR)
- **등록**: https://dataspace.copernicus.eu/  → 계정 생성(무료), OAuth2 client
- **auth**: OAuth2 (client_id/secret → access token)
- **주는 것**: Sentinel-1 SAR 원영상 (배치, 재방문 ~6일)
- **주의**: 원영상 → 선박탐지는 **자체 ML 파이프라인 필요**. GFW SAR로 충분하면 **후순위/생략 가능**
- **환경변수**: `COPERNICUS_CLIENT_ID`, `COPERNICUS_CLIENT_SECRET`

---

## Phase 3 — ⛔ 스코프 제외 (계약/태스킹)

> 진행하지 않음. 데모는 Phase 0 합성 데이터로 대체. 스키마만 준비됨.


### 5. RF 지오로케이션 (택1)
- **HawkEye 360** (RFGeo / SeaVision 연동) — 기업/정부 계약, 태스킹 기반
- **Unseenlabs** — RF 탐지 리포트, 태스킹
- **Spire Maritime** — 개발자 API 상대적으로 친화적 (주력 위성AIS)
- **auth**: 업체별 상이 (REST Bearer 또는 S3/SFTP 파일 전송)
- **환경변수(예)**: `RF_PROVIDER`, `RF_API_URL`, `RF_API_TOKEN` / 또는 S3 자격증명
- **정규화 타깃**: `Detection`(source=`rf`) — 스키마는 Phase 0에서 이미 준비됨

### 6. KOMPSAT-5/6 SAR (한국 국가자산)
- **경로**: KARI / SI Imaging Services(SIIS) — 태스킹, GeoTIFF 전송
- **auth**: 파일 기반(S3/SFTP) 또는 발주 채널
- **주의**: 원영상 → 탐지 ML 필요. 국가자산 활용은 전략적 가치, 데모 범위 밖

---

## 제외 / 주의 (초기 범위에서 뺌)

| 소스 | 이유 |
|---|---|
| **Equasis** | 공식 REST API 없음 → 스크래핑은 ToS 리스크. 수동 참조만 |
| **TankerTrackers / Off-Nadir** | 애널리스트 구독 서비스, 자동 API 없음. 수동 검증용 |
| **SHODAN (VSAT)** | API는 있으나 선박 지오로케이션 신뢰도·커버리지 낮음 |

---

## Foundry 플랫폼 자체 (당신이 Foundry에서 발급)

| 항목 | 용도 |
|---|---|
| **OAuth2 third-party app** (client_id/secret) | 외부 서버(Node) → Foundry API 연동 (그림의 "OAuth 앱") |
| **서비스 계정 토큰** 또는 OAuth | Node 브릿지가 파생 이벤트/스냅샷을 Foundry 데이터셋에 push |
| **Data Connection Source RID** (소스별) | External Transforms가 참조할 소스 식별자 |
| **Output dataset RID** (파이프라인별) | Transform 출력 대상 |

> Node 브릿지용 환경변수: `FOUNDRY_API_URL`, `FOUNDRY_API_TOKEN`,
> `FOUNDRY_EVENTS_DATASET_RID`, `FOUNDRY_SNAPSHOT_DATASET_RID`

---

## 요약: 지금 진행 (스코프 확정)

1. ✅ **Global Fishing Watch API token** — `.env`에 `GFW_API_TOKEN` 추가 완료
2. **Foundry OAuth2 app + 서비스 토큰** (브릿지 연동용) — 진행 필요
3. ✅ **StealthMole** — 이미 보유

**제외 (유료/발주)**: MarineTraffic, Copernicus 자체 SAR, RF(HawkEye/Unseenlabs/Spire), KOMPSAT.
