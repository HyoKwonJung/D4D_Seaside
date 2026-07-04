/**
 * gfw.js — Global Fishing Watch API v3 클라이언트 (Phase 1, 무료).
 *
 * 아키텍처상 GFW는 저빈도 배치 소스이므로 Node(레이어1)에서 폴링해
 * detections/events 로 정규화한 뒤 Foundry(레이어2)로 push한다.
 * (stealthmole.js 와 동일한 프록시 패턴)
 *
 * GFW는 이미 SAR 탐지의 AIS 매칭 여부(matched)를 계산해주므로, dark 탐지는
 * matched=false 필터로 직접 조회할 수 있다(우리 correlation.py는 2차 검증용).
 *
 * 주의: v3 일부 파라미터 표기(케이스/POST vs GET)는 배포 시점에 따라 다를 수 있어
 *       foundry/tools/gfw_probe.js 로 실제 응답을 1회 확인 후 확정 권장.
 */

const BASE_URL = process.env.GFW_BASE_URL || "https://gateway.api.globalfishingwatch.org";
const API_PREFIX = "/v3";

const EVENT_DATASETS = {
  loitering: "public-global-loitering-events:latest",
  gap: "public-global-gaps-events:latest",
  encounter: "public-global-encounters-events:latest",
  port_visit: "public-global-port-visits-events:latest",
  fishing: "public-global-fishing-events:latest"
};
const SAR_DATASET = "public-global-sar-presence:latest";

function getToken() {
  const token = process.env.GFW_API_TOKEN;
  if (!token) throw new Error("Missing GFW_API_TOKEN in environment.");
  return token;
}

function isEnabled() {
  return Boolean(process.env.GFW_API_TOKEN);
}

/** watch-areas 의 bounds [[swLat,swLon],[neLat,neLon]] → GeoJSON Polygon */
function boundsToGeoJSON(bounds) {
  const [sw, ne] = bounds;
  const [swLat, swLon] = sw;
  const [neLat, neLon] = ne;
  return {
    type: "Polygon",
    coordinates: [[
      [swLon, swLat],
      [neLon, swLat],
      [neLon, neLat],
      [swLon, neLat],
      [swLon, swLat]
    ]]
  };
}

async function gfwRequest(path, { method = "GET", query, body } = {}) {
  const url = new URL(API_PREFIX + path, BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error(`GFW API error ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    error.status = response.status;
    error.body = payload;
    throw error;
  }
  return payload;
}

/**
 * 이벤트 조회 (loitering/gap/encounter ...). GFW는 대개 POST /events 를 사용.
 * @param {string} type - EVENT_DATASETS 키
 * @param {object} opts - { bounds, startDate, endDate, limit }
 */
async function getEvents(type, opts = {}) {
  const dataset = EVENT_DATASETS[type];
  if (!dataset) throw new Error(`Unknown GFW event type: ${type}`);
  const body = {
    datasets: [dataset],
    startDate: opts.startDate,
    endDate: opts.endDate,
    limit: opts.limit || 50,
    offset: opts.offset || 0
  };
  if (opts.bounds) body.geometry = boundsToGeoJSON(opts.bounds);
  return gfwRequest("/events", { method: "POST", body });
}

/**
 * SAR 탐지 (4Wings 리포트). matched=false 로 다크 탐지 직접 조회.
 * @param {object} opts - { bounds, startDate, endDate, matched }
 */
async function getSarDetections(opts = {}) {
  const body = {};
  if (opts.bounds) body.geojson = boundsToGeoJSON(opts.bounds);
  const query = {
    "spatial-resolution": opts.spatialResolution || "HIGH",
    "temporal-resolution": opts.temporalResolution || "HOURLY",
    "datasets[0]": SAR_DATASET,
    "date-range": `${opts.startDate},${opts.endDate}`,
    format: "JSON"
  };
  if (opts.matched !== undefined) query["filters[0]"] = `matched='${opts.matched}'`;
  return gfwRequest("/4wings/report", { method: "POST", body, query });
}

/** 선박 식별 검색 (name/MMSI/IMO) */
async function searchVessels(query) {
  return gfwRequest("/vessels/search", {
    query: {
      query,
      "datasets[0]": "public-global-vessel-identity:latest",
      limit: 20
    }
  });
}

module.exports = {
  isEnabled,
  getEvents,
  getSarDetections,
  searchVessels,
  boundsToGeoJSON,
  EVENT_DATASETS,
  SAR_DATASET
};
