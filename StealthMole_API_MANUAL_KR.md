# StealthMole External API Reference

> ⚠️ API 오용·남용 금지
> - 본 API의 오용 및 남용을 철저히 금합니다.
> - 오용·남용 등으로 문제가 야기될 경우, 운영진의 판단에 따라 사전 통보 없이 API 제공을 철회할 수 있습니다.

> 이번 해커톤 제공 범위
> - **Darkweb Tracker(`dt`) 검색과 ULP Binder(`ub`) 모듈은 이번 해커톤에서 제공하지 않습니다.**
> - 두 모듈의 섹션은 문서에 남겨 두되 상세 명세는 제외하고 미제공 안내만 표기했습니다.

> 안내
> - 실제 연동에 사용하는 Base URL은 `https://hackathon.stealthmole.com` 입니다.
> - 본 문서에서 `BASE_URL` 은 위 주소를 의미합니다.
> - 응답 필드는 권한, 계약 플랜, 서비스 상태에 따라 일부 달라질 수 있습니다.

- 공유 금지 (Do not share) --- 본 문서는 정보제공서비스의 특정 고객에게만 배포됩니다. 사전 허가 없이 공유할 수 없습니다.
- 기밀유지협약 (Non-disclosure agreement) --- 본 문서는 NDA(기밀유지협약) 동의 하에 제공되며, 이를 위반할 경우 법적 책임이 발생할 수 있습니다.
- 주의 --- 본 라이선스로 허용된 행위를 포함한 기타 저작권 관련 사항은 정보제공서비스 담당자를 통해 반드시 확인한 후 사용하시기 바랍니다.

---


# 1. API 서버 인증

## 1.1 JWT 인증 토큰 발급

REST API 요청 시, 발급받은 access key와 secret key로 토큰을 생성하여 Authorization 헤더를 통해 전송합니다. 토큰은 JWT 형식을 따릅니다.

*JWT 요구사항*

| 최소 버전 | 링크 |
|---|---|
| 2.3.0 | https://jwt.io |

서명 방식은 HS256를 사용하며, 서명에 사용할 access key, secret key는 발급받은 key를 사용합니다.

페이로드의 구성은 다음과 같습니다.

```json
{
  "access_key": "발급 받은 access key (필수)",
  "nonce": "무작위의 UUID 문자열 (필수)",
  "iat": "현재시간의 UTC timestamp값 10자리 숫자 (필수)"
}
```

예시: `iat = 1641964710`

```python
# Python 3 기준
import jwt  # pip install PyJWT
import uuid
from datetime import datetime, timezone

payload = {
    'access_key': '발급받은 Access Key',
    'nonce': str(uuid.uuid4()),
    'iat': int(datetime.now(timezone.utc).timestamp())
}

jwt_token = jwt.encode(payload, '발급받은 Secret Key')
authorization_token = 'Bearer {}'.format(jwt_token)
```

Authorization 헤더 예시:

```http
Authorization: Bearer <jwt_token>
```

> 참고
> - JWT의 `nonce` 는 재사용하면 안 됩니다.
> - 운영 환경 기준으로 **같은 JWT를 재사용하면 두 번째 호출부터 `401`** 이 발생합니다.
> - 따라서 클라이언트는 **요청마다 새 JWT를 생성해서 사용해야 합니다.**

# 2. 모듈 개요

StealthMole External API는 여러 보안·위협 인텔리전스 모듈로 구성됩니다. 외부 사용자는 각 모듈의 목적과 적용 범위를 먼저 확인한 뒤, 필요한 엔드포인트를 연동하는 것을 권장합니다.

| 모듈 | 서비스 코드 | 설명 | 주요 엔드포인트 |
|---|---|---|---|
| Darkweb Tracker | `dt` | 다크웹/딥웹 상의 콘텐츠, 사이트, 서비스 정보 등을 수집·검색하는 위협정보 검색 모듈. 키워드, 도메인, URL, 파일, 메신저, 가상자산 주소, 각종 식별자 기반 연관 탐색에 적합 | `/{service}/search/...`, `/{service}/node`, `/api/file/...` |
| Telegram Tracker | `tt` | 텔레그램 채널/그룹, 유저, 메시지, 첨부파일 등을 수집·검색하는 모듈. 텔레그램 내 위협정보와 범죄 연관 정황을 채널/유저/메시지 단위로 탐색할 때 사용 | `/{service}/search/...`, `/{service}/node` |
| Credential Lookout | `cl` | 다크웹/딥웹에 노출된 계정 유출정보를 조회하는 모듈. 도메인, 이메일, 사용자 ID, 비밀번호 기준으로 계정 유출 여부를 점검할 때 사용 | `/cl/search`, `/cl/export` |
| Compromised Data File | `cdf` | 유출 데이터 파일 분석 Extension. 스틸러 로그 등을 통해 확보된 침해 문서와 파일을 분석하여 텍스트, 메타데이터, 임베디드 객체, GPS 좌표, IP 주소 등 핵심 정보를 추출하고 노출 맥락을 추적하는 데 적합 | `/{service}/search/...`, `/api/file/...` |
| Compromised Data Set | `cds` | 악성코드 감염 기기 등에서 탈취된 계정/기기 유출정보를 조회하는 모듈. 로그인 사이트, 계정 ID, 이메일, 비밀번호, IP, 국가 등으로 검색할 수 있습니다. | `/cds/search`, `/cds/export`, `/cds/node` |
| Combo Binder | `cb` | 유출된 `ID:Password` 조합(Combo) 기반 계정정보를 조회하는 모듈 | `/cb/search`, `/cb/export` |
| ULP Binder | `ub` | `URL - Login ID - Password` 구조로 유출된 계정정보를 조회하는 모듈 | `/ub/search`, `/ub/export` |
| Ransomware Monitoring | `rm` | 랜섬웨어 그룹이 기업/기관 정보를 탈취하여 공개한 사고를 모니터링하는 모듈. 피해 조직, 공격 그룹, 유출 증거 URL 중심 조회 제공 | `/rm/search` |
| Government Monitoring | `gm` | 정부기관 대상 위협 모니터링 모듈. 정부기관 관련 게시물/증거/언급을 조회할 때 사용 | `/gm/search` |
| Leaked Monitoring | `lm` | 기업 대상 위협 모니터링 모듈. 기업 관련 유출, 언급, 협박, 공개 정황을 조회할 때 사용 | `/lm/search` |
| Management API | 공통 | 서비스 사용량, 통계, 운영 보조 기능을 제공하는 관리성 API | `/user/quotas` |

## 2.1 연동 전에 이해할 점

외부 개발자가 연동할 때는 아래 3가지 API 그룹을 구분해서 이해하는 것이 중요합니다.

### A. 비동기 검색 API

대상 모듈:

- `dt`
- `tt`
- `cdf`

특징:

- 첫 호출에서 바로 최종 검색 결과가 오지 않을 수 있습니다.
- `202 Accepted` 응답이 발생할 수 있습니다.
- 클라이언트는 `id` 또는 `cid` 를 저장한 뒤 polling 해야 합니다.

권장 연동 흐름:

1. `.../search/{indicator}/targets` 로 target 확인
2. `.../search/{indicator}/target` 또는 `.../target/all` 호출
3. `202` 또는 `last=false` 이면 `.../search/{id}` polling
4. 필요 시 `dt` / `tt` 에 한해 `.../node` 호출
5. `cdf` 는 현재 외부 API 기준으로 node API 없이 search 결과와 `/api/file/...` 다운로드 흐름 중심으로 연동

### B. 동기 검색 API

대상 모듈:

- `cl`
- `cb`
- `ub`
- `cds`

특징:

- 일반적인 검색 API처럼 요청 시점에 결과를 반환합니다.
- `limit`, `cursor`, `orderType`, `order` 기반 pagination/정렬을 사용합니다.
- 대부분 export API를 함께 제공합니다.

### C. 조회/다운로드/모니터링 API

대상:

- `node` 상세조회
- `gm`, `lm`, `rm`
- `user/quotas`

특징:

- 검색 결과 drill-down, 대용량 다운로드, 운영 현황 조회에 사용합니다.

## 2.2 모듈별 권장 사용 시나리오

### Darkweb Tracker (`dt`)

> ⛔ 이번 해커톤에서는 제공하지 않는 모듈입니다.

### Telegram Tracker (`tt`)

대표 활용 시나리오:

- Telegram 채널/유저/메시지를 중심으로 정보 노출 여부를 확인하고 싶을 때
- 채널 메시지, 멤버, 프로필 이미지, 첨부파일까지 연계해 보고 싶을 때
- 특정 채널/유저의 최근 활동과 이력까지 확인하고 싶을 때

### Credential Lookout (`cl`)

대표 활용 시나리오:

- 조직 계정의 외부 유출 여부를 점검할 때
- 이메일, 사용자 ID, 비밀번호, 도메인 기준으로 credential leak를 조회할 때

### Compromised Data File (`cdf`)

대표 활용 시나리오:

- 스틸러 로그나 유출 아카이브에서 확보한 침해 문서·파일의 내용을 자동 분석하고 싶을 때
- 문서 본문, 파일 메타데이터, 임베디드 객체, GPS 좌표, IP 주소를 함께 추출하여 노출 맥락을 추적할 때
- ZIP, RAR 등 압축 파일 내부까지 확인하여 민감 정보나 숨겨진 위협 신호를 찾고 싶을 때
- 감염 시스템 파일에서 설치 소프트웨어 목록, 브라우저 자동완성 데이터 등 추가 노출 흔적을 확인할 때
- 유출 파일의 지리적 출처를 지도 기반 분석과 연계해 확인할 때

주요 기능:

- 자동 파일 파싱: 다양한 형식의 유출 문서에서 텍스트, 메타데이터, 임베디드 객체를 자동 추출
- GPS & IP 태깅: 내장된 GPS 좌표와 IP 주소 메타데이터를 추출하여 유출 파일의 출처 추적 지원
- 자동완성 & 소프트웨어 식별: 침해된 시스템 파일에서 설치 소프트웨어 목록과 브라우저 자동완성 데이터 탐지
- 다크 맵 연동: 유출 파일의 지리적 출처를 지도 기반으로 시각화하는 분석 워크플로우 지원
- 압축 파일 분석: 아카이브 파일을 심층 검사하여 수동 추출 없이 민감 콘텐츠 식별

### Compromised Data Set (`cds`)

대표 활용 시나리오:

- Stealer 감염 기기 유출 데이터를 기반으로 계정 탈취 여부를 확인할 때
- 로그인 사이트, 계정, 비밀번호, 감염 IP, 국가, 사용자명, 컴퓨터명까지 함께 확인할 때

### Combo Binder (`cb`)

대표 활용 시나리오:

- `ID:Password` 조합 유출을 탐지할 때
- Credential stuffing 대응이나 계정 재사용 위험 분석이 필요할 때

### ULP Binder (`ub`)

> ⛔ 이번 해커톤에서는 제공하지 않는 모듈입니다.

### Ransomware Monitoring (`rm`)

대표 활용 시나리오:

- 특정 기업/기관이 랜섬웨어 피해 공개 목록에 포함되었는지 확인할 때
- 공격 그룹, 피해 조직, 도메인, 공개된 증거 URL을 빠르게 조회할 때

### Government Monitoring (`gm`), Leaked Monitoring (`lm`)

대표 활용 시나리오:

- 정부기관 또는 기업 대상 위협을 대시보드형으로 모니터링할 때
- 복잡한 연관 분석보다 목록 조회와 필터링이 중요할 때

# 3. 공통 정보

## 3.1 Base URL

```text
https://hackathon.stealthmole.com
```

## 3.2 인증

대부분의 엔드포인트는 Bearer 토큰이 필요합니다.

```http
Authorization: Bearer <token>
```

## 3.3 Content Types

- 요청(JSON): `application/json`
- 일반 응답: `application/json`
- 파일 응답: `text/csv`, `application/json`, `application/x-zip-compressed`, 기타 바이너리 응답(`application/octet-stream` 등)

## 3.4 공통 상태 코드

| Code | 의미 |
|---|---|
| 200 | 성공 |
| 202 | 비동기 검색 계속 진행 중 |
| 400 | 잘못된 파라미터 |
| 401 | 인증 실패 |
| 403 | 권한 부족 |
| 404 | 리소스 없음 / 미지원 서비스 / unauthorized 성격 |
| 406 | export 준비 중 |
| 408 | 비동기 검색 타임아웃 |
| 426 | API quota 초과 |

## 3.5 공통 에러 객체

```json
{
  "detail": "error message"
}
```

단, 일부 비동기 검색은 다음 형식을 반환할 수 있습니다.

```json
{
  "statusCode": 408,
  "detail": "Request Timeout"
}
```

## 3.6 API 쿼리 사용량 차감 기준

API 쿼리 사용량은 서비스별 월간 quota 기준으로 관리됩니다. 사용량 조회는 `GET /user/quotas` 에서 확인할 수 있으며, 운영 DB 시간 기준 현재 월 1일 00:00:00 이후 정상 사용으로 집계된 요청만 `used` 값에 합산됩니다.

### 공통 원칙

- 쿼리 사용량은 서비스 코드별로 합산됩니다. 예: `DT`, `TT`, `CL`, `CDS`, `CB`, `UB`, `RM`, `GM`, `LM`, `CDF`
- 차감 대상 엔드포인트는 요청 처리 전에 남은 quota를 확인합니다. 남은 quota가 부족하면 `426` 과 함께 다음 오류가 반환됩니다.

```json
{
  "detail": "You have exceeded the query limit."
}
```

- 인증 실패, 파라미터 오류, 미지원 서비스/target, 권한 부족 등으로 요청이 정상 사용으로 집계되지 않은 경우에는 쿼리 사용량이 차감되지 않습니다.
- `GET /user/quotas` 호출은 쿼리 사용량이 차감되지 않습니다.

### 엔드포인트별 차감 기준

| API 구분 | 대상 엔드포인트 | 차감 기준 |
|---|---|---|
| target 목록 조회 | `/{service}/search/{indicator}/targets` (`dt`, `tt`, `cdf`) | 차감되지 않습니다. |
| 비동기 검색 | `/{service}/search/{indicator}/target`, `/{service}/search/{indicator}/target/all` (`dt`, `tt`, `cdf`) | 최종 검색 결과가 반환되는 target 단위로 1회 차감됩니다. `target/all` 처럼 여러 target을 조회하면 응답에 포함되는 target별로 차감될 수 있습니다. |
| 비동기 검색 polling / paging | `/{service}/search/{id}` (`dt`, `tt`, `cdf`) | 검색 결과 페이지가 반환될 때 1회 차감됩니다. `202 Accepted` 로 추가 검색 진행 상태만 안내되는 응답은 차감되지 않습니다. |
| Node / 상세조회 | `/{service}/node`, `/{service}/node/content`, `/{service}/node/list` (`dt`, `tt`) | 상세조회 요청 1회당 1회 차감됩니다. |
| CDS 상세조회 | `/cds/node` | quota 보유 여부는 확인하지만, 상세조회 자체의 쿼리 사용량은 차감되지 않습니다. |
| 동기 검색 | `/cl/search`, `/cds/search`, `/cb/search`, `/ub/search` | 요청 1회당 1회 차감됩니다. 한 번의 검색 요청은 최대 `limit=50` 범위에서 결과 페이지를 반환합니다. |
| 동기 export | `/cl/export`, `/cds/export`, `/cb/export`, `/ub/export` (`limit > 0`) | export 요청 1회당 1회 차감됩니다. |
| 전체 export | `/cl/export`, `/cds/export`, `/cb/export`, `/ub/export` (`limit=0`) | 전체 결과 수를 50건 단위로 나눈 페이지 수만큼 차감됩니다. 계산식은 `ceil(totalCount / 50)` 이며, 결과가 0건이어도 최소 1회 차감됩니다. |
| 모니터링 검색 | `/rm/search`, `/gm/search`, `/lm/search` | 요청 1회당 1회 차감됩니다. |
| 파일 다운로드 | `/api/file/{service}/{type}/{hash}` | `dt` 서비스의 파일 다운로드(`service=dt`, `type=f`)는 요청 1회당 1회 차감됩니다. 그 외 파일 다운로드는 쿼리 사용량이 차감되지 않습니다. |
| 사용량 조회 | `/user/quotas` | 차감되지 않습니다. |

### `queryCost` 와 export 차감

`/cl/search`, `/cds/search`, `/cb/search`, `/ub/search` 응답의 `queryCost` 는 해당 동기 검색 계열에서 1회 쿼리 사용량이 대표하는 결과 건수 단위입니다. 현재 운영 기준으로 값은 `50` 입니다.

전체 export(`limit=0`)에서는 이 값을 기준으로 전체 결과를 몇 페이지로 나눌지 계산한 뒤 해당 페이지 수만큼 quota를 차감합니다.

예:

| 전체 결과 수 | 계산 | 차감 쿼리 수 |
|---:|---:|---:|
| 0 | 최소 차감 | 1 |
| 1~50 | `ceil(totalCount / 50)` | 1 |
| 51~100 | `ceil(totalCount / 50)` | 2 |
| 101~150 | `ceil(totalCount / 50)` | 3 |

---

# 4. 공통 스키마

## 4.1 AsyncSearchItem

```json
{
  "id": "string",
  "value": "string",
  "highlight": "string",
  "createDate": 1710000000,
  "metadata": "{\"key\":\"value\"}"
}
```

설명:

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 결과 메타 id |
| `value` | string | 대표 값 |
| `highlight` | string | HTML 포함 가능 |
| `createDate` | integer | Unix timestamp |
| `metadata` | string\|null | JSON 문자열 또는 null |

## 4.2 AsyncSearchStatusResponse

```json
{
  "id": "string",
  "cid": "string",
  "pid": "string",
  "totalCount": 0,
  "filteredCount": 0,
  "cursor": 0,
  "limit": 100,
  "last": false,
  "statusCode": 202,
  "message": "Additional search. Please request again.",
  "data": []
}
```

설명:

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | cache 식별자. 경우에 따라 포함되며, 이후 `GET /{service}/search/{id}` 의 `{id}` 경로 값으로 사용 |
| `cid` | string | cache 식별자. 경우에 따라 포함되며, 이후 `GET /{service}/search/{id}` 의 `{id}` 경로 값으로 사용 |
| `pid` | string | 쿼리 해시 |
| `totalCount` | integer | 현재 cache 결과 수 |
| `filteredCount` | integer\|object | 필터링된 결과 수 |
| `cursor` | integer | 다음 offset |
| `limit` | integer | 페이지 크기 |
| `last` | boolean | 검색 종료 여부 |
| `statusCode` | integer | `0`, `202`, `408` |
| `message` | string | 진행 중 안내 문구 |
| `data` | array | `AsyncSearchItem[]` |

## 4.3 StandardListResponse

```json
{
  "totalCount": 123,
  "cursor": 50,
  "limit": 50,
  "data": []
}
```

## 4.4 SearchResponseWithCost

```json
{
  "totalCount": 123,
  "cursor": 50,
  "limit": 50,
  "queryCost": 50,
  "data": []
}
```

## 4.5 TargetsResponse

```json
{
  "totalCount": 4,
  "target": ["domain", "url", "image", "document"]
}
```

---


# 5. 비동기 검색 API (`dt`, `tt`, `cdf`)

`dt`, `tt`, `cdf` 는 비동기 검색 방식으로 동작하는 모듈입니다. 초기 요청 시 최종 결과가 즉시 반환되지 않을 수 있으며, 진행 상태에 따라 `202` 응답과 함께 부분 결과가 반환될 수 있습니다.

- `dt` (Darkweb Tracker): 다크웹/딥웹 상의 콘텐츠, 사이트, 서비스 정보 등을 수집·검색하며, 키워드가 포함된 콘텐츠 조회와 각종 식별자 기반 연관 탐색에 활용됩니다.
- `tt` (Telegram Tracker): Telegram 채널/그룹, 사용자, 메시지, 첨부파일 등을 수집·검색하며, 텔레그램 내 노출 정보와 범죄 연관 정황 탐색에 활용됩니다.
- `cdf` (Compromised Data File): 유출 문서와 파일의 텍스트, 메타데이터, 임베디드 객체, GPS/IP 정보, 압축 파일 내부 콘텐츠 등을 분석하여 비정형 데이터 파일에 포함된 노출 단서를 탐지하는 데 활용됩니다.

비동기 검색 API는 indicator 기반으로 target 목록을 확인한 뒤 검색을 수행하며, 필요 시 `/{service}/search/{id}` 를 통해 polling 및 paging 을 진행합니다.

## 5.1 공통 규칙

### 허용 서비스

- `dt`
- `tt`
- `cdf`

### 서비스별 사용 가능 indicator

아래 목록은 **운영 환경 기준**으로 사용 가능한 indicator 목록입니다.
실제 target 목록은 계정 권한, 계약 플랜, 운영 설정에 따라 달라질 수 있으므로, 구현 시에는 `GET /{service}/search/{indicator}/targets` 응답도 함께 사용하는 것을 권장합니다.

아래 표는 사용 편의를 위해 indicator를 성격별로 묶어 정리한 목록입니다. 동일한 indicator는 서비스가 다르더라도 가능한 한 동일한 분류 기준을 적용합니다.

#### DT indicator

> ⛔ 이번 해커톤에서는 제공하지 않는 모듈입니다.

#### TT indicator

| 분류 | indicator |
|---|---|
| 웹/사이트 | `domain`, `url`, `tor`, `torurl`, `i2p`, `i2purl`, `filehosting`, `googledrive`, `pastebin`, `shorten` |
| 파일/문서 | `document`, `image`, `exefile`, `otherfile`, `compressed` |
| 식별자/개인정보 | `email`, `id`, `tel`, `kssn`, `creditcard` |
| 보안/침해지표 | `ip`, `hash`, `hashstring`, `cve`, `pgp` |
| 메신저/SNS | `telegram`, `telegram.channel`, `telegram.message`, `telegram.user`, `discord`, `line`, `kakaotalk`, `session`, `tox`, `facebook`, `instagram`, `twitter`, `band` |
| 금융/가상자산 | `bitcoin`, `ethereum`, `monero` |
| 위치/메타데이터 | `gps` |
| 콘텐츠/검색 식별자 | `keyword` |

#### CDF indicator

| 분류 | indicator |
|---|---|
| 파일/문서 | `document`, `image`, `exefile`, `otherfile`, `compressed` |
| 보안/침해지표 | `ip`, `hash` |
| 위치/메타데이터 | `gps`, `country` |
| 콘텐츠/검색 식별자 | `keyword` |

### 공통 Query 파라미터

| 이름 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `limit` | integer | N | 100 | 최대 100 |
| `cursor` | integer | N | 0 | 0 이상 |
| `orderType` | string | N | `createDate` | `value` 또는 `createDate` |
| `order` | string | N | `desc` | `asc`, `desc` |
| `start` | integer | N | 0 | Unix timestamp |
| `end` | integer | N | 0 | Unix timestamp |

> 참고
> - 운영 환경 기준으로 async 계열(`dt`, `tt`, `cdf`)은 `limit=0` 도 허용됩니다. 이 경우 보통 `data=[]` 와 함께 메타데이터만 반환됩니다.
> - 다만 클라이언트 구현과 사용자 경험을 고려하면 **권장값은 1 이상**입니다.

### 비동기 polling 규칙

초기 검색에서 `202` 또는 `last=false` 응답을 받으면:

1. 응답의 `id` 또는 `cid` 저장
2. 이후 polling 또는 paging 요청의 `GET /{service}/search/{id}` 에서 `{id}` 경로 값으로 해당 cache 식별자 사용
3. `last=true` 까지 재호출

> 참고
> - `202` 응답이어도 body 내부에는 이미 일부 `data` 가 포함될 수 있습니다.
> - `/{service}/search/{id}` 는 polling 용도뿐 아니라 `cursor` 기반 paging에도 사용됩니다.
> - `target/all` 호출 시 target별로 완료 상태가 다를 수 있으며, 일부 target은 `statusCode=408` 로 timeout 이 반환될 수 있습니다.

---

## 5.2 GET /{service}/search/{indicator}/targets

indicator 에서 사용 가능한 target 목록 조회.

### Security

- Bearer token

### Path Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `service` | string | Y | `dt`, `tt`, `cdf` |
| `indicator` | string | Y | indicator 이름 |

### Response 200

- `TargetsResponse`

### Response 404

예:

```json
{
  "detail": "service is not found. (abc)"
}
```

```json
{
  "detail": "Indicator is not found. (domain)"
}
```

---

## 5.3 GET /{service}/search/{indicator}/target

특정 target 또는 여러 target 지정 검색.

### Security

- Bearer token

### Path Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `service` | string | Y | `dt`, `tt`, `cdf` |
| `indicator` | string | Y | indicator 이름 |

### Query Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `targets` | string | Y | 쉼표 구분 target 목록. 예: `domain,url` |
| `text` | string | Y | 검색어 |
| `limit` | integer | N | 최대 100 |
| `orderType` | string | N | `value`, `createDate` |
| `order` | string | N | `asc`, `desc` |
| `start` | integer | N | Unix timestamp |
| `end` | integer | N | Unix timestamp |
| `wait` | boolean | N | 기본 `true`. `false` 이면 최초 요청에서 결과를 기다리지 않고 cache 등록/worker enqueue 후 가능한 현재 상태를 바로 반환합니다. |

> 참고
> - `wait=false` 는 최초 검색 요청의 응답 시간을 줄이기 위한 옵션입니다.
> - cache에 이미 결과가 있으면 `wait=false` 여도 현재 cache 결과가 반환될 수 있습니다.
> - 검색이 아직 진행 중인 target은 `statusCode=202`, `last=false`, `cid` 를 반환하며, 클라이언트는 해당 `cid` 로 `GET /{service}/search/{id}` 를 호출해 polling 해야 합니다.

### Response 200

항상 target명을 key로 하는 객체(map)를 반환합니다. `targets`에 단일 target만 지정한 경우에도 응답은 `{ "target": { ... } }` 형태입니다.

예시:

```json
{
  "domain": {
    "id": "cache-id-1",
    "pid": "query-hash",
    "totalCount": 120,
    "filteredCount": 3,
    "cursor": 100,
    "limit": 100,
    "last": false,
    "statusCode": 0,
    "data": []
  },
  "url": {
    "cid": "cache-id-2",
    "pid": "query-hash",
    "totalCount": 0,
    "filteredCount": 0,
    "cursor": 0,
    "limit": 100,
    "last": false,
    "statusCode": 202,
    "message": "Additional search. Please request again."
  }
}
```

### Response 400

```json
{
  "detail": "Limit can't be larger than 100."
}
```

```json
{
  "detail": "Cursor must be greater than zero."
}
```

### Response 404

```json
{
  "detail": "target is not supported."
}
```

### Response 426

```json
{
  "detail": "You have exceeded the query limit."
}
```

---

## 5.4 GET /{service}/search/{indicator}/target/all

indicator 아래 전체 target 검색.

> 참고
> - 이 엔드포인트는 **플랫폼에 기본(Default) 설정된 target만 대상으로 검색**합니다.
> - 검색 대상 target 기본 설정을 변경하려면 **StealthMole 플랫폼에 로그인하여 설정을 변경**해야 합니다.
> - 모든 사용 가능 target을 직접 선택해 검색하려면 `GET /{service}/search/{indicator}/target` 엔드포인트에서 `targets` 파라미터를 명시적으로 지정하는 방식을 사용하십시오.

### Security

- Bearer token

### Path Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `service` | string | Y | `dt`, `tt`, `cdf` |
| `indicator` | string | Y | indicator 이름 |

### Query Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `text` | string | Y | 검색어 |
| `limit` | integer | N | 최대 100 |
| `orderType` | string | N | `value`, `createDate` |
| `order` | string | N | `asc`, `desc` |
| `start` | integer | N | Unix timestamp |
| `end` | integer | N | Unix timestamp |
| `wait` | boolean | N | 기본 `true`. `false` 이면 최초 요청에서 결과를 기다리지 않고 cache 등록/worker enqueue 후 가능한 현재 상태를 바로 반환합니다. |

> 참고
> - `wait=false` 는 `target/all` 처럼 여러 target을 동시에 검색할 때 최초 응답 시간을 줄이는 데 유용합니다.
> - cache에 이미 결과가 있으면 `wait=false` 여도 현재 cache 결과가 반환될 수 있습니다.
> - 검색이 아직 진행 중인 target은 `statusCode=202`, `last=false`, `cid` 를 반환하며, 클라이언트는 해당 `cid` 로 `GET /{service}/search/{id}` 를 호출해 polling 해야 합니다.

### Response 200

- target별 `AsyncSearchStatusResponse` 맵

> 참고
> - `target/all` 응답은 target별로 완료/미완료/0건/timeout 이 섞일 수 있습니다.
> - 따라서 클라이언트는 HTTP status만 보지 말고 각 target 객체의 `statusCode`, `last`, `data` 를 함께 해석해야 합니다.

---

## 5.5 GET /{service}/search/{id}

cache id 기반 재조회 및 paging.

### Security

- Bearer token

### Path Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `service` | string | Y | `dt`, `tt`, `cdf` |
| `id` | string | Y | cache id |

### Query Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `limit` | integer | N | 최대 100 |
| `cursor` | integer | N | offset |
| `orderType` | string | N | `value`, `createDate` |
| `order` | string | N | `asc`, `desc` |
| `start` | integer | N | Unix timestamp |
| `end` | integer | N | Unix timestamp |

### Response 200

- `AsyncSearchStatusResponse`

### Response 404

```json
{
  "detail": "Search ID is not found."
}
```

---

# 6. Node / Detail API

## 6.1 GET /{service}/node

검색 결과 상세 조회.

> 참고
> - 현재 외부 API 기준으로 node API는 `dt`, `tt` 에만 적용됩니다.
> - `cdf` 는 `/{service}/node` 를 지원하지 않습니다.

### Security

- Bearer token

### Path Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `service` | string | Y | `dt`, `tt` |

### Query Parameters

| 이름 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `id` | string | Y | - | 노드 id |
| `pid` | string | N | null | 부모/검색 문맥 id |
| `data_from` | boolean | N | `false` | 데이터 발견 경로 포함 여부 |
| `include_url` | boolean | N | `false` | 하위 URL 포함 여부 |
| `include_contents` | boolean | N | `true` | 본문 포함 여부 |

### Response 200

- node 유형별 상세 JSON

### Response 404

지원하지 않는 service를 요청한 경우:

```json
{
  "detail": "service is not found. (abc)"
}
```

해당 node의 category가 외부 node 상세 API에서 지원되지 않는 경우:

```json
{
  "detail": "Node category is not supported. (keyword)"
}
```

### Response 426

```json
{
  "detail": "You have exceeded the query limit."
}
```

---

## 6.2 GET /cds/node

CDS 상세 조회.

### Security

- Bearer token

### Query Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | Y | CDS detail id |

### Response 200

- CDS detail JSON

### Response 403

```json
{
  "detail": "You do not have permission."
}
```

### 기타 에러

- API 호출 한도를 초과하면 `426` 이 발생할 수 있습니다.
- `id` 가 없으면 FastAPI validation 에 의해 `422` 가 발생할 수 있습니다.
- 존재하지 않는 `id` 이면 `404 Parameter Error.` 가 발생할 수 있습니다.

---

## 6.3 DT Node API Response Reference

> ⛔ 이번 해커톤에서는 제공하지 않는 모듈입니다.

## 6.4 TT Node API Response Reference

아래는 **TT에서 접근 가능한 node 응답**만 따로 정리한 섹션입니다.

대상 endpoint:

- `GET /tt/node`

### 6.4.1 TT Node Request Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `id` | string | Y | node id. 검색 결과의 `data.id` 값 |
| `pid` | string | N | 부모 node id. 검색 결과의 `id` 값 |
| `data_from` | boolean | N | 데이터 발견경로 포함 여부. 기본 `false` |
| `include_url` | boolean | N | 하위 URL 포함 여부. 기본 `false` |
| `include_contents` | boolean | N | `torurl`, `i2purl`, `url` 응답에서 본문 포함 여부. 기본 `true` |

### 6.4.2 TT 공통 보조 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `history` | array | Telegram channel/user 이력 |
| `message` | string[] | Telegram channel 최근 메시지 목록 |
| `messagehisto` | string[] | Telegram message 주변 메시지 목록 |

### 6.4.3 TT Node별 대표 응답 스키마

#### telegram.user

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | Telegram 사용자 id |
| `bot` | boolean | bot 여부 |
| `history` | array | 사용자 정보 변경 이력 |
| `history.id` | string | 이력 문서 id |
| `history.date` | string | 이력 등록일 |
| `histo_id` | string | 현재 사용자 정보의 history id |
| `first_name` | string | 이름 |
| `last_name` | string | 성 |
| `username` | string[] | username 목록 |
| `phone` | string | 전화번호 |
| `profile` | string | 프로필 이미지 sha256 |
| `create_date` | string | 생성일 |
| `deleted` | string | 삭제 계정 시 `Deleted Account` |

#### telegram.channel

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | Telegram 채널 id |
| `message` | string[] | 최근 메시지 목록 |
| `countPhotos` | integer | 사진 개수 |
| `countFiles` | integer | 파일 개수 |
| `countAudios` | integer | 오디오 개수 |
| `countVideos` | integer | 비디오 개수 |
| `countMembers` | integer | 멤버 수 |
| `history` | array | 채널 정보 변경 이력 |
| `histo_id` | string | 현재 채널 정보의 history id |
| `title` | string | 채널/그룹 제목 |
| `url` | string | 채널 URL |
| `type` | string | `Channel` 또는 `Group` |
| `image` | string\|null | 프로필 이미지 sha256 |

#### telegram.message

| 필드 | 타입 | 설명 |
|---|---|---|
| `channel_id` | string | 채널 id |
| `channel_title` | string | 채널명 |
| `channel_url` | string | 채널 URL |
| `user_id` | string | 발신 user id 또는 채널 정보 |
| `username` | string | 발신자 표현 문자열 |
| `fwd_id` | string | forward 원본 id |
| `fwd_date` | string | forward 일시 |
| `fwd_name` | string | forward 원본 이름 |
| `reply_to_msg_id` | integer | reply 대상 메시지 id |
| `message` | string | 현재 메시지 본문 |
| `create_date` | string | 메시지 생성일 |
| `download` | string | 첨부파일 sha256 |
| `messagehisto` | string[] | 이전/현재/다음 메시지 목록 |

예시:

```json
{
  "channel_id": "12345",
  "channel_title": "Leak Channel",
  "channel_url": "https://t.me/leak",
  "user_id": "99999",
  "username": "John/Doe/@john",
  "message": "sample telegram message",
  "create_date": "2024-02-02 11:22:33",
  "messagehisto": ["prev1", "current", "next1"]
}
```

### 6.4.4 TT 일반 node 상세 스키마

TT에서도 Telegram 전용 node 외에 일반 indicator 기반 node를 사용할 수 있습니다.
아래는 category별 대표 응답 필드입니다.

#### url / torurl / i2purl

| 필드 | 타입 | 설명 |
|---|---|---|
| `url` | string | URL 값 |
| `scannedDate` | string | 스캔 일시 |
| `contentsHash` | string | 본문 해시 |
| `contentHtml` | string | 본문 HTML |
| `includedUrl` | string[] | 하위 URL 목록 |

#### domain / tor / i2p

| 필드 | 타입 | 설명 |
|---|---|---|
| `domain` | string | 도메인 값 |
| `ip` | string | 관련 IP |

#### ip

| 필드 | 타입 | 설명 |
|---|---|---|
| `ip` | string | IP 주소 |
| `country` | string | 국가 |
| `region` | string | 지역 |
| `city` | string | 도시 |
| `org` | string | ASN/기관 |

#### email

| 필드 | 타입 | 설명 |
|---|---|---|
| `email` | string | 이메일 주소 |
| `pgp` | object[] | 연관 PGP 키 목록 |
| `pgp[].fingerprint` | string | PGP fingerprint |
| `pgp[].rawdata` | string | PGP public key 원문 |
| `googledrive` | string[] | 연관 Google Drive URL |

#### id

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | ID 값 |
| `type` | array | 유형 목록 |

#### hash

| 필드 | 타입 | 설명 |
|---|---|---|
| `md5` | string | MD5 |
| `sha1` | string | SHA1 |
| `sha256` | string | SHA256 |
| `type` | string | 연관 유형 |

#### hashstring

| 필드 | 타입 | 설명 |
|---|---|---|
| `hash` | string | 원본 hash/string |
| `type` | string | 탐지된 유형 |
| `text` | string | 관련 텍스트 |

#### gps

| 필드 | 타입 | 설명 |
|---|---|---|
| `latitude` | string | 위도 |
| `longitude` | string | 경도 |
| `imagefrom` | string[] | 연결된 이미지 목록 |

#### document

| 필드 | 타입 | 설명 |
|---|---|---|
| `filename` | string | 파일명 |
| `md5` | string | MD5 |
| `sha1` | string | SHA1 |
| `sha256` | string | SHA256 |
| `size` | integer\|string | 파일 크기 |
| `type` | string | 파일 유형 |
| `creator` | string | 생성자 |
| `modifier` | string | 수정자 |
| `create_date` | string | 생성일 |
| `modify_date` | string | 수정일 |
| `lang` | string | 문서 언어 |
| `text` | string | 추출 텍스트 |
| `url` | string | 관련 URL |
| `total_count` | integer | 동일 파일 개수 |

#### exefile

| 필드 | 타입 | 설명 |
|---|---|---|
| `filename` | string | 파일명 |
| `md5` | string | MD5 |
| `sha1` | string | SHA1 |
| `sha256` | string | SHA256 |
| `size` | integer\|string | 파일 크기 |
| `type` | string | 파일 유형 |
| `text` | string | 추출 텍스트 |
| `total_count` | integer | 동일 파일 개수 |

#### image

| 필드 | 타입 | 설명 |
|---|---|---|
| `filename` | string | 파일명 |
| `md5` | string | MD5 |
| `sha1` | string | SHA1 |
| `sha256` | string | SHA256 |
| `size` | integer\|string | 파일 크기 |
| `type` | string | 이미지 유형 |
| `resolution` | string | 해상도 |
| `gps` | object\|array | GPS 정보 |
| `text` | string | OCR/추출 텍스트 |
| `total_count` | integer | 동일 이미지 개수 |

#### otherfile

| 필드 | 타입 | 설명 |
|---|---|---|
| `filename` | string | 파일명 |
| `md5` | string | MD5 |
| `sha1` | string | SHA1 |
| `sha256` | string | SHA256 |
| `size` | integer\|string | 파일 크기 |
| `type` | string | 파일 유형 |
| `text` | string | 추출 텍스트 |
| `total_count` | integer | 동일 파일 개수 |

#### twitter / facebook / instagram / band

| 필드 | 타입 | 설명 |
|---|---|---|
| `url` | string | SNS URL |
| `type` | string | SNS 유형 |
| `facebook_url` | string | Facebook URL (`facebook`) |

#### creditcard

| 필드 | 타입 | 설명 |
|---|---|---|
| `creditcard` | string | 카드 번호 |
| `company` | string[] | 카드사 |
| `name` | string | 카드명 |
| `type` | string | 카드 유형 |

#### cve

| 필드 | 타입 | 설명 |
|---|---|---|
| `cve` | string | CVE 식별자 |

#### wallet (`bitcoin`, `ethereum`, `monero`)

| 필드 | 타입 | 설명 |
|---|---|---|
| `wallet` | string | 지갑 주소 |
| `type` | string | 지갑 유형 |
| `detaininfo` | string | 외부 상세정보 링크 |

#### messenger (`discord`, `line`, `kakaotalk`, `session`, `tox`)

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 메신저 식별자 |
| `type` | string | 메신저 유형 |

#### pgp

| 필드 | 타입 | 설명 |
|---|---|---|
| `algorithm` | string | 키 알고리즘 |
| `create_date` | string | 생성일 |
| `expire_date` | string | 만료일 |
| `register_name` | string | 등록명 |
| `email` | string | 키에 포함된 이메일 |
| `rawdata` | string | armored key data |

#### tel

| 필드 | 타입 | 설명 |
|---|---|---|
| `tel` | string | 전화번호 |

## 6.5 CDS Node API Response Reference

### 6.5.1 GET /cds/node

대표 응답 필드:

| 필드 | 타입 | 설명 |
|---|---|---|
| `host` | string | 로그인 사이트/호스트 |
| `user` | string | 사용자 ID 또는 이메일 |
| `password` | string | 비밀번호 |
| `leakeddate` | string\|null | 유출 일시 |
| `ip` | string\|null | 감염 기기 IP |
| `username` | string\|null | OS 사용자명 |
| `computername` | string\|null | 컴퓨터명 |
| `stealerpath` | string\|null | stealer 경로 |
| `stealertype` | string | stealer 유형 |

예시:

```json
{
  "host": "example.com",
  "user": "john@example.com",
  "password": "secret",
  "leakeddate": "2024-01-01 00:00:00",
  "ip": "1.2.3.4",
  "username": "john",
  "computername": "PC-01",
  "stealerpath": "C:/Users/john/AppData/...",
  "stealertype": "RedLine"
}
```

---

# 7. 동기 검색 API

## 7.1 GET /cl/search

Credential Lookout 검색.

> 참고
> - `/cl/search` 는 `limit=0` 을 허용하지 않습니다. `1` 이상을 사용해야 합니다.

### Security

- Bearer token

### Query Parameters

| 이름 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | Y | - | 검색어 |
| `limit` | integer | N | 50 | 최대 50 |
| `cursor` | integer | N | 0 | offset |
| `orderType` | string | N | `LeakedDate` | `domain`, `email`, `password`, `LeakedDate`, `LeakedFrom` |
| `order` | string | N | `desc` | `asc`, `desc` |
| `start` | integer | N | 0 | Unix timestamp |
| `end` | integer | N | 0 | Unix timestamp |

### Supported Query Categories

- `domain`
- `root_domain`
- `email`
- `id`
- `password`
- `after`
- `before`

설명:

- `after`, `before` 지시자는 **유출 날짜 기준 필터**입니다.
- 날짜 형식은 `YYYY-MM` 또는 `YYYY-MM-DD` 를 사용할 수 있습니다.
  - 예: `after:2026-03`
  - 예: `before:2026-04-30`

### Response 200

- `SearchResponseWithCost`

#### `data[]` 주요 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 상세/관리용 ID |
| `leaked_from` | string\|null | 유출원 |
| `leaked_date` | string\|null | 유출 일자 (`YYYY-MM`) |
| `domain` | string\|null | 유출 이메일 도메인 |
| `email` | string\|null | 유출 이메일 주소 |
| `password` | string\|null | 유출 비밀번호 |

### Response 400

다음 경우 `400 Bad Request` 가 발생할 수 있습니다.

- `limit > 50` 또는 `limit <= 0`
- `cursor + limit > 25000`
- `cursor < 0`
- `start < 0`
- `end < 0`

예:

```json
{
  "detail": "Limit can't be larger than 50."
}
```

### Response 404

```json
{
  "detail": "Unauthorized."
}
```

### Response 426

```json
{
  "detail": "You have exceeded the query limit."
}
```

---

## 7.2 GET /cl/export

CL 검색 결과 export.

> 참고
> - `exportType=json` 이어도 일부 배포에서는 첨부 filename 이 `.csv` 로 내려올 수 있습니다.
> - 따라서 파일 확장자보다 **`Content-Type` 헤더를 기준으로 처리해야 합니다.**
> - export API에서 `limit=0` 은 전체 export를 의미합니다. 단, 전체 건수가 1,000,000건을 초과하면 `422` 가 발생할 수 있습니다.

### Security

- Bearer token

### Query Parameters

- `/cl/search` 와 동일 + 아래 추가

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `exportType` | string | N | `csv` 또는 `json` |

### Response 200

- CSV 또는 JSON 파일

---

## 7.3 GET /cb/search

Combo Binder 검색.

> 참고
> - `cb` 는 `limit=0` 을 허용하지 않습니다. `1` 이상을 사용해야 합니다.

### Query Parameters

| 이름 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | Y | - | 검색어 |
| `limit` | integer | N | 50 | 최대 50 |
| `cursor` | integer | N | 0 | offset |
| `orderType` | string | N | `LeakedDate` | `user`, `password`, `LeakedDate` |
| `order` | string | N | `desc` | `asc`, `desc` |
| `start` | integer | N | 0 | Unix timestamp |
| `end` | integer | N | 0 | Unix timestamp |

### Supported Query Categories

- `domain`
- `email`
- `id`
- `password`
- `after`
- `before`

설명:

- `after`, `before` 지시자는 **유출 날짜 기준 필터**입니다.
- 날짜 형식은 `YYYY-MM` 또는 `YYYY-MM-DD` 를 사용할 수 있습니다.
  - 예: `after:2026-03`
  - 예: `before:2026-03-31`

### Response 200

- `SearchResponseWithCost`

#### `data[]` 주요 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 상세/관리용 ID |
| `user` | string\|null | 유출 사용자 ID 또는 이메일 |
| `password` | string\|null | 유출 비밀번호 |
| `leakeddate` | integer\|null | 유출 시각 (Unix timestamp) |

### Response 400

다음 경우 `400 Bad Request` 가 발생할 수 있습니다.

- `limit > 50` 또는 `limit <= 0`
- `cursor + limit > 25000`
- `cursor < 0`
- `start < 0`
- `end < 0`

---

## 7.4 GET /cb/export

CB 검색 결과 export.

> 참고
> - `exportType=json` 이어도 일부 배포에서는 첨부 filename 이 `.csv` 로 내려올 수 있습니다.
> - 따라서 파일 확장자보다 **`Content-Type` 헤더를 기준으로 처리해야 합니다.**
> - export API에서 `limit=0` 은 전체 export를 의미합니다. 단, 전체 건수가 1,000,000건을 초과하면 `422` 가 발생할 수 있습니다.

### Query Parameters

- `/cb/search` 와 동일 + `exportType=csv|json`

### Response 200

- CSV 또는 JSON 파일

---

## 7.5 GET /ub/search

> ⛔ 이번 해커톤에서는 제공하지 않는 모듈입니다.

---

## 7.6 GET /ub/export

> ⛔ 이번 해커톤에서는 제공하지 않는 모듈입니다.

---

## 7.7 GET /cds/search

Compromised Data Set 검색.

> 참고
> - `cds` 는 `limit=0` 을 허용하지 않습니다. `1` 이상을 사용해야 합니다.

### Query Parameters

| 이름 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | Y | - | 검색어 |
| `limit` | integer | N | 50 | 최대 50 |
| `cursor` | integer | N | 0 | offset |
| `orderType` | string | N | `LeakedDate` | `host`, `user`, `password`, `LeakedDate`, `RegDate` |
| `order` | string | N | `desc` | `asc`, `desc` |
| `start` | integer | N | 0 | Unix timestamp |
| `end` | integer | N | 0 | Unix timestamp |
| `includeGps` | boolean | N | `false` | `true` 이면 응답 `data[]` 항목에 `geo` 필드가 포함될 수 있습니다. |

### Supported Query Categories

- `domain`
- `url`
- `email`
- `id`
- `password`
- `ip`
- `country`
- `after`
- `before`

설명:

- `country` 지시자는 **피해자 IP 위치를 기준으로 국가를 필터링**할 때 사용합니다.
- 국가 코드는 **대문자 2자리 ISO 형식**으로 입력합니다. 예: `country:KR`, `country:US`
- `after`, `before` 지시자는 **유출 날짜 기준 필터**입니다.
- 날짜 형식은 `YYYY-MM` 또는 `YYYY-MM-DD` 를 사용할 수 있습니다.
  - 예: `after:2026-03`
  - 예: `before:2026-03-31`

### Response 200

- `SearchResponseWithCost`

#### `data[]` 주요 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | CDS 상세 조회용 id |
| `host` | string | 로그인 사이트/호스트 |
| `user` | string\|null | 사용자 ID 또는 이메일 |
| `password` | string\|null | 비밀번호 |
| `leakeddate` | integer\|null | 유출 시각 (Unix timestamp) |
| `regdate` | integer\|null | 서버 등록 시각 (Unix timestamp) |
| `ip` | string\|null | 감염 기기 IP |
| `username` | string\|null | OS 사용자명 |
| `computername` | string\|null | 컴퓨터명 |
| `geo` | object\|null | `includeGps=true` 일 때만 포함될 수 있습니다. 형식은 `{ "lat": number, "lon": number }` 이며, GPS 정보가 없거나 좌표를 읽을 수 없는 경우 `null` 입니다. |

예시 (`includeGps` 생략 또는 `false`):

```json
{
  "totalCount": 1,
  "cursor": null,
  "limit": 50,
  "queryCost": 50,
  "data": [
    {
      "id": "abc123",
      "host": "example.com",
      "user": "john@example.com",
      "password": "secret",
      "leakeddate": 1710000000,
      "regdate": 1710001000,
      "ip": "1.2.3.4",
      "username": "john",
      "computername": "PC-01"
    }
  ]
}
```

예시 (`includeGps=true`):

```json
{
  "totalCount": 1,
  "cursor": null,
  "limit": 50,
  "queryCost": 50,
  "data": [
    {
      "id": "abc123",
      "host": "example.com",
      "user": "john@example.com",
      "password": "secret",
      "leakeddate": 1710000000,
      "regdate": 1710001000,
      "ip": "1.2.3.4",
      "username": "john",
      "computername": "PC-01",
      "geo": {
        "lat": 37.5665,
        "lon": 126.9780
      }
    }
  ]
}
```

### `includeGps` 동작 및 예외/주의사항

- `includeGps` 기본값은 `false` 입니다.
- `includeGps` 를 생략하거나 `false` 로 호출하면 `geo` 필드는 응답에 포함되지 않습니다.
- `includeGps=true` 로 호출하면 각 `data[]` 항목에 `geo` 필드가 포함될 수 있습니다.
- `geo` 값은 다음 두 형태 중 하나입니다.
  - 좌표가 준비된 경우: `{ "lat": <float>, "lon": <float> }`
  - 좌표를 제공할 수 없는 경우: `null`
- 현재 구현 기준으로 `includeGps=true` 를 사용하더라도 `geo` 값은 `null` 로 반환될 수 있습니다. 따라서 클라이언트는 `geo` 필드의 존재 여부와 `null` 가능성을 모두 고려하여 처리해야 합니다.
- `includeGps` 는 `/cds/search` 에만 적용됩니다. `/cds/export`, `/cds/node` 응답에는 영향을 주지 않습니다.
- `includeGps` 사용 여부는 `queryCost`, 정렬, 페이징, 도메인/국가 필터링, 권한 판정 로직을 변경하지 않습니다.

### 예외 응답 및 특이 동작

#### Response 400

다음 경우 `400 Bad Request` 가 발생할 수 있습니다.

- `limit > 50` 또는 `limit <= 0`
- `cursor + limit > 25000`
- `cursor < 0`
- `start < 0`
- `end < 0`

예:

```json
{
  "detail": "Limit can't be larger than 50."
}
```

#### Response 404

다음 경우 `404` 가 발생할 수 있습니다.

- CDS 사용 권한이 없는 경우
- `use_limit_or_operator` 제약이 있는 사용자 계정에서 `OR` 연산자를 사용한 경우

예:

```json
{
  "detail": "Unauthorized."
}
```

또는:

```json
{
  "detail": "OR operators are not allowed."
}
```

#### Response 426

API 호출 한도를 초과한 경우:

```json
{
  "detail": "You have exceeded the query limit."
}
```

#### 검색어 검증 실패 시 빈 결과 반환 가능

일부 검색어 형식 오류는 명시적 에러 대신 아래와 같이 빈 결과로 반환될 수 있습니다.

```json
{
  "totalCount": 0,
  "cursor": null,
  "limit": 50,
  "data": []
}
```

---

## 7.8 GET /cds/export

CDS 검색 결과 export.

> 참고
> - `exportType=json` 이어도 일부 배포에서는 첨부 filename 이 `.csv` 로 내려올 수 있습니다.
> - 따라서 파일 확장자보다 **`Content-Type` 헤더를 기준으로 처리해야 합니다.**
> - export API에서 `limit=0` 은 전체 export를 의미합니다. 단, 전체 건수가 1,000,000건을 초과하면 `422` 가 발생할 수 있습니다.

### Query Parameters

- `/cds/search` 와 동일하되 `includeGps` 는 지원하지 않음 + `exportType=csv|json`

### Response 200

- CSV 또는 JSON 파일

---

# 8. 모니터링 API

## 8.1 GET /gm/search

Government Monitoring 검색.

### Query Parameters

| 이름 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | N | `""` | 비우면 전체 목록 |
| `limit` | integer | N | 50 | 최대 50 |
| `cursor` | integer | N | 0 | offset |
| `orderType` | string | N | `detectionTime` | `title`, `author`, `detectionTime` |
| `order` | string | N | `desc` | `asc`, `desc` |
| `start` | integer | N | 0 | 탐지 시간(`detection_datetime`) 시작 Unix timestamp |
| `end` | integer | N | 0 | 탐지 시간(`detection_datetime`) 종료 Unix timestamp |

### Supported Query Prefix

- `tor`
- `torurl`
- `domain`
- `url`
- `id`

> 참고
> - `gm` / `lm` 의 prefix 검색은 사용자가 직관적으로 기대하는 제목 검색과 다를 수 있습니다.
> - 구현 기준으로 `domain`, `url`, `tor`, `torurl` 은 주로 URL 계열 필드에 매핑되고, `id` 는 작성자(author) 계열 필드에 매핑됩니다.
> - 제목 또는 본문과 유사한 일반 문자열 검색이 필요한 경우 plain query 검색을 함께 검토하십시오.
> - `start`, `end` 는 탐지 시간(`detection_datetime`) 기준으로 필터링합니다.

### Response 200

- `StandardListResponse`

#### `data[]` 주요 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 관리용 ID |
| `title` | string | 위협 게시글 제목 |
| `author` | string | 위협 게시글 작성자 ID |
| `detection_datetime` | integer | 탐지 시간 |
| `proof_url` | string | 위협 게시글 URL. 무료 권한에서는 `Not supported to FREE version` 문자열이 반환될 수 있습니다. |

### Response 400 / 404 / 426

- `limit > 50` 또는 `limit < 0` 이면 `400` 이 발생할 수 있습니다.
- `start < 0`, `end < 0`, 또는 `start > end` 이면 `400` 이 발생할 수 있습니다.
- 사용 권한이 없으면 `404 Unauthorized.` 가 발생할 수 있습니다.
- API 호출 한도를 초과하면 `426` 이 발생할 수 있습니다.

---

## 8.2 GET /lm/search

Leaked Monitoring 검색.

### Query Parameters

- `/gm/search` 와 동일

### Response 200

- `StandardListResponse`

#### `data[]` 주요 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 관리용 ID |
| `title` | string | 위협 게시글 제목 |
| `author` | string | 위협 게시글 작성자 ID |
| `detection_datetime` | integer | 탐지 시간 |
| `proof_url` | string | 위협 게시글 URL. 무료 권한에서는 `Not supported to FREE version` 문자열이 반환될 수 있습니다. |

### Response 400 / 404 / 426

- `limit > 50` 또는 `limit < 0` 이면 `400` 이 발생할 수 있습니다.
- `start < 0`, `end < 0`, 또는 `start > end` 이면 `400` 이 발생할 수 있습니다.
- 사용 권한이 없으면 `404 Unauthorized.` 가 발생할 수 있습니다.
- API 호출 한도를 초과하면 `426` 이 발생할 수 있습니다.

---

## 8.3 GET /rm/search

Ransomware Monitoring 검색.

### Query Parameters

| 이름 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `query` | string | N | `""` | 비우면 전체 목록 |
| `limit` | integer | N | 50 | 최대 50 |
| `cursor` | integer | N | 0 | offset |
| `orderType` | string | N | `detectionTime` | `victim`, `attackGroup`, `detectionTime` |
| `order` | string | N | `desc` | `asc`, `desc` |
| `start` | integer | N | 0 | 탐지 시간(`detection_datetime`) 시작 Unix timestamp |
| `end` | integer | N | 0 | 탐지 시간(`detection_datetime`) 종료 Unix timestamp |

### Supported Query Prefix

- `tor`
- `torurl`
- `domain`

> 참고
> - `start`, `end` 는 탐지 시간(`detection_datetime`) 기준으로 필터링합니다.

### Response 200

- `StandardListResponse`

#### `data[]` 주요 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 관리용 ID |
| `victim` | string | 피해 업체명 |
| `attack_group` | string | 랜섬웨어 공격 그룹 |
| `detection_datetime` | integer | 탐지 시간 |
| `proof_url` | string | 랜섬웨어 게시글 URL. 무료 권한에서는 `Not supported to FREE version` 문자열이 반환될 수 있습니다. |
| `site` | string | 피해 업체 웹사이트 |
| `country` | string | 피해 업체 국가 |
| `sector` | string | 피해 업체 산업 분류 |

### Response 400 / 404 / 426

- `limit > 50` 또는 `limit < 0` 이면 `400` 이 발생할 수 있습니다.
- `start < 0`, `end < 0`, 또는 `start > end` 이면 `400` 이 발생할 수 있습니다.
- 사용 권한이 없으면 `404 Unauthorized.` 가 발생할 수 있습니다.
- API 호출 한도를 초과하면 `426` 이 발생할 수 있습니다.

---

# 9. 다운로드 / 통계 API

## 9.1 GET /api/file/{service}/{type}/{hash}

파일 다운로드.

### Security

- Bearer token

### Path Parameters

| 이름 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `service` | string | Y | 서비스 구분 |
| `type` | string | Y | 파일 유형 |
| `hash` | string | Y | 64자리 hex |

### Response 200

- 파일 바이너리

> 사용 가이드
> - DT/TT에서 파일 다운로드는 보통 `/dt/node`, `/tt/node` 또는 관련 file 계열 응답에서 확인한 `sha256`/hash 값을 사용합니다.
> - 대표적으로 다운로드 가능한 파일형 target은 `image`, `document`, `exefile`, `otherfile` 입니다.
> - 경로는 `service`, `type`, `hash` 조합을 받지만, 실제 다운로드 가능 여부는 서버의 파일 저장소와 `get_file()` 처리 가능 조합에 따라 달라집니다.
> - 현재 코드 기준으로 `dt/f` 다운로드는 별도 API quota 차감 및 다운로드 로그가 적용됩니다. 다른 조합은 파일 존재/권한에 따라 `404` 등이 반환될 수 있습니다.

### Response 404

```json
{
  "detail": "File not found"
}
```

---

## 9.2 GET /user/quotas

서비스별 사용량/허용량 조회.

### Security

- Bearer token

> 참고
> - `user/quotas` 조회는 운영 환경 기준으로 API 쿼리 사용량이 차감되지 않습니다.

### Response 200

```json
{
  "CDS": {"allowed": 1000, "used": 230},
  "CL": {"allowed": 500, "used": 120}
}
```

응답 필드 설명:

| 필드 | 타입 | 설명 |
|---|---|---|
| `allowed` | integer | 최대 사용 가능 개수 |
| `used` | integer | 현재까지 사용한 개수 |

---

# 10. 서비스별 enum 요약

## 10.1 Async Search (`dt`, `tt`, `cdf`)

### orderType

- `value`
- `createDate`

### order

- `asc`
- `desc`

## 10.2 CL

### orderType

- `domain`
- `email`
- `password`
- `LeakedDate`
- `LeakedFrom`

## 10.3 CB

### orderType

- `user`
- `password`
- `LeakedDate`

## 10.4 UB

> ⛔ 이번 해커톤에서는 제공하지 않는 모듈입니다.

## 10.5 CDS

### orderType

- `host`
- `user`
- `password`
- `LeakedDate`
- `RegDate`

## 10.6 GM / LM

### orderType

- `title`
- `author`
- `detectionTime`

## 10.7 RM

### orderType

- `victim`
- `attackGroup`
- `detectionTime`

---

# 11. 연동 시 유의사항

## 11.1 비동기 검색 연동 시 유의사항

`dt` / `tt` / `cdf` 는 단순 검색 API가 아니라:

- 첫 응답이 202일 수 있고
- target별 상태가 다를 수 있으며
- polling이 필요합니다.

따라서 SDK에서는 다음 기능 구현을 권장합니다.

- `search()`
- `pollSearchById()`
- `waitUntilCompleted()`

## 11.2 응답 타입이 완전히 고정되지 않을 수 있음

특히 아래 필드는 유연하게 파싱해야 합니다.

- `filteredCount`: integer 또는 object
- `metadata`: JSON 문자열 또는 null
- `data`: target별로 필드 구조 상이

## 11.3 target 목록은 정적 하드코딩보다 `/targets` 사용 권장

권한/계약에 따라 target 목록이 달라질 수 있으므로,
프론트엔드와 SDK는 가능하면 `GET /{service}/search/{indicator}/targets` 응답을 기준 목록으로 사용하는 것을 권장합니다.

## 11.4 JWT는 요청마다 새로 생성해야 함

운영 환경 기준으로 동일 JWT 재사용 시 `401` 이 발생합니다.
따라서 클라이언트는 토큰을 세션 단위로 재활용하지 말고 **요청마다 새로 생성해서 사용해야 합니다.**

## 11.5 Base URL

현재 연동에 사용하는 Base URL 은 아래와 같습니다.

```text
https://hackathon.stealthmole.com
```

클라이언트는 API 연동 시 위 주소를 사용해야 합니다.

## 11.6 `cdf` 는 search / file 중심으로 연동

현재 외부 API 기준으로 `cdf` 는 비동기 search 와 `/api/file/...` 다운로드는 동작하지만, `/{service}/node` 는 지원하지 않습니다.
따라서 `cdf` 연동은 search 결과와 파일 다운로드 흐름 중심으로 설계하는 것을 권장합니다.

## 11.7 export 응답은 filename보다 `Content-Type` 우선

`exportType=json` 인 경우에도 일부 배포에서는 첨부 filename 이 `.csv` 로 내려올 수 있습니다.
따라서 파일 처리 로직은 filename 확장자보다 **`Content-Type` 헤더**를 기준으로 구현해야 합니다.

## 11.8 `limit` 최소 허용값은 서비스마다 다를 수 있음

운영 환경 기준으로 다음과 같은 차이가 있습니다.

- async(`dt`, `tt`, `cdf`) : `limit=0` 허용
- `cl`, `cb`, `ub`, `cds` 검색 API : `limit=0` 비허용
- `cl`, `cb`, `ub`, `cds` export API : `limit=0` 은 전체 export 의미
- `gm`, `lm`, `rm` : `limit=0` 허용

SDK 또는 공통 클라이언트를 구현할 때는 서비스별 제약을 분기 처리하는 것을 권장합니다.

## 11.9 `/{service}/search/{id}` 는 polling + paging API

비동기 검색에서 `/{service}/search/{id}` 는 단순 polling 용도가 아니라 `cursor` 기반 재조회에도 사용됩니다.
즉, 초기 search 이후에는 같은 `id` 를 이용해 진행 상태 확인과 페이지 이동을 모두 처리할 수 있습니다.

---

# 12. API 주요 에러코드 목록

아래 표는 연동 시 자주 확인하게 되는 대표 에러코드를 요약한 것입니다.

| Status Code | Description | 설명 |
|---|---|---|
| `400` | `Limit can't be larger than 50.` | 동기 검색 계열에서 `limit` 값이 최대치를 초과한 경우 |
| `400` | `Limit can't be larger than 100.` | 비동기 검색 계열에서 `limit` 값이 최대치를 초과한 경우 |
| `400` | `Cursor must be greater than zero.` | `cursor` 는 0 이상의 값만 허용 |
| `400` | `Cursor can't be larger than 24,950.` | 동기 검색 계열에서 `cursor + limit` 이 허용 범위를 초과한 경우 |
| `400` | `Start must be greater than zero.` | `start` 는 0 이상의 값만 허용 |
| `400` | `End must be greater than zero.` | `end` 는 0 이상의 값만 허용 |
| `401` | `Invalid token or expired token.` | 인증 실패 또는 재사용/만료된 토큰 |
| `404` | `Parameter Error.` | 올바르지 않은 파라미터 사용 |
| `406` | `Export in progress. Please try again later.` | export 파일이 아직 준비 중 |
| `408` | `Request Timeout` | 비동기 검색 중 target별 timeout 발생 |
| `422` | `Please contact support@stealthmole.com to export data exceeding 1,000,000 results.` | 1,000,000건이 넘는 대량 데이터 export 시 support@stealthmole.com 문의 필요 |
| `426` | `You have exceeded the query limit.` | API 쿼리 개수 초과 |
