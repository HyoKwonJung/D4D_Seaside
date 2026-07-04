/**
 * foundry-osdk.js — OSDK 클라이언트 래퍼.
 *
 * OSDK 패키지(@osdk/client, @cableguard-dashboard-backend/sdk)는 사설 레지스트리라
 * 설치 전에는 존재하지 않는다. 따라서 동적 import + try/catch 로 감싸,
 * 미설치/미설정 시 앱을 깨지 않고 안전하게 no-op(빈 결과) 처리한다.
 *
 * 토큰: lib/foundry-oauth.js 의 getAccessToken 을 createClient 토큰 프로바이더로 사용
 *       (refresh token → access token 자동 갱신).
 */

const oauth = require("./foundry-oauth.js");

let clientPromise = null;

async function getClient() {
  if (!oauth.isConfigured() || !oauth.hasRefreshToken()) return null;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    // 동적 import: 패키지 미설치 시 여기서 에러 → 상위에서 no-op 처리
    const { createClient } = await import("@osdk/client");
    const sdk = await import("@cableguard-dashboard-backend/sdk");
    const ontologyRid = process.env.FOUNDRY_ONTOLOGY_RID || sdk.$ontologyRid;
    const foundryUrl = (process.env.FOUNDRY_URL || "").replace(/\/+$/, "");
    if (!ontologyRid) throw new Error("Missing ontology RID (FOUNDRY_ONTOLOGY_RID or sdk.$ontologyRid).");
    // 토큰 프로바이더 = () => Promise<string>
    const client = createClient(foundryUrl, ontologyRid, () => oauth.getAccessToken());
    return { client, sdk };
  })().catch(error => {
    clientPromise = null; // 다음 호출에서 재시도 허용
    throw error;
  });

  return clientPromise;
}

async function isReady() {
  try {
    return Boolean(await getClient());
  } catch (error) {
    console.warn("[foundry-osdk] not ready:", error.message);
    return false;
  }
}

/** CableGuardEvent 조회 → 기존 대시보드 이벤트 형태로 매핑 */
async function fetchCableGuardEvents(opts = {}) {
  const ctx = await getClient();
  if (!ctx) return [];
  const { client, sdk } = ctx;
  const page = await client(sdk.CableguardEvent).fetchPage({ $pageSize: opts.pageSize || 100 });
  return (page.data || []).map(mapEvent);
}

/**
 * OSDK 오브젝트 → 대시보드 이벤트. Foundry ontology CableguardEvent 실제 속성(camelCase)에 정렬됨.
 * (확인된 키: eventId, eventType, source, synthetic, riskScore, riskLevel, vesselName, vesselMmsi,
 *  lat, lon, occurredAt, durationH, speedKn, distanceToCableNm, nearestCable, region, aisStatus,
 *  description, reviewStatus, recommendation, watchAreaName, active)
 * 참고: darkVesselStatus 는 현재 온톨로지에 없어 "unknown" 으로 기본 처리됨.
 */
function mapEvent(o) {
  const num = v => (v === null || v === undefined || v === "" ? null : Number(v));
  const bool = v => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "string") {
      if (/^(false|0|no)$/i.test(v.trim())) return false;
      if (/^(true|1|yes)$/i.test(v.trim())) return true;
    }
    return Boolean(v);
  };
  return {
    id: o.eventId ?? o.$primaryKey,
    event_type: o.eventType ?? null,
    source: o.source ?? "foundry",
    synthetic: Boolean(o.synthetic),
    risk_score: num(o.riskScore) ?? 0,
    risk_level: o.riskLevel ?? null,
    vessel_name: o.vesselName ?? "Unknown",
    mmsi: o.vesselMmsi ?? null,
    imo: o.imo ?? o.vesselImo ?? o.imoNumber ?? null,
    flag: o.flag ?? o.vesselFlag ?? null,
    owner: o.owner ?? o.registeredOwner ?? o.vesselOwner ?? null,
    origin_port: o.originPort ?? o.departurePort ?? o.lastPort ?? null,
    destination_port: o.destinationPort ?? o.arrivalPort ?? o.nextPort ?? null,
    eta: o.eta ?? o.etaAt ?? o.arrivalEta ?? null,
    last_korea_visit_at: o.lastKoreaVisitAt ?? o.koreaLastVisitAt ?? o.koreaPortVisitAt ?? o.lastPortCallKoreaAt ?? null,
    is_sanctioned: bool(o.isSanctioned ?? o.sanctioned),
    sanctions_status: o.sanctionsStatus ?? null,
    sanctions_list: normalizeStringList(o.sanctionsList ?? o.sanctionLists),
    crew_count: num(o.crewCount),
    crew_nationality: o.crewNationality ?? o.crewNationalities ?? null,
    crew_summary: o.crewSummary ?? o.crewInfo ?? null,
    lat: num(o.lat),
    lon: num(o.lon),
    timestamp: o.occurredAt ?? null,
    occurred_at: o.occurredAt ?? null,
    duration_h: num(o.durationH),
    speed_kn: num(o.speedKn),
    heading_deg: num(o.headingDeg),
    distance_to_cable_nm: num(o.distanceToCableNm),
    nearest_cable_id: o.nearestCableId ?? null,
    nearest_cable: o.nearestCable ?? null,
    counterparty_mmsi: o.counterpartyMmsi ?? null,
    counterparty_vessel_name: o.counterpartyVesselName ?? null,
    region: o.region ?? null,
    ais_status: o.aisStatus ?? null,
    sar_matched: bool(o.sarMatched),
    rf_matched: bool(o.rfMatched),
    dark_vessel_status: o.darkVesselStatus ?? "unknown",
    detection_ids: normalizeStringList(o.detectionIds),
    description: o.description ?? null,
    evidence: normalizeStringList(o.evidence),
    review_status: o.reviewStatus ?? "unverified",
    recommendation: o.recommendation ?? null,
    scoring_version: o.scoringVersion ?? null,
    watch_area_name: o.watchAreaName ?? null,
    active: o.active,
    source_system: "foundry-osdk"
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined && item !== "").map(String);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(item => item !== null && item !== undefined && item !== "").map(String);
    } catch (error) {
      // Treat non-JSON strings as a single statement/id below.
    }
  }
  return [trimmed];
}
/** 첫 오브젝트의 실제 속성 키 덤프 (매핑 정렬용, gfw_probe 와 동일 취지) */
async function describeFirst() {
  const ctx = await getClient();
  if (!ctx) return null;
  const { client, sdk } = ctx;
  const page = await client(sdk.CableguardEvent).fetchPage({ $pageSize: 1 });
  return page.data && page.data[0] ? Object.keys(page.data[0]) : [];
}

module.exports = {
  getClient,
  isReady,
  fetchCableGuardEvents,
  describeFirst
};
