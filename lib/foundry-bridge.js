/**
 * Layer 1(Node) -> Layer 2(Foundry) bridge.
 *
 * The dashboard should not push raw AIS firehose data into Foundry. This module
 * only sends low-volume derived rows: events, vessel snapshots, and optional
 * non-AIS detections such as GFW SAR candidates. Missing configuration is a
 * no-op so local demo mode keeps working.
 */

const oauth = require("./foundry-oauth.js");

const FOUNDRY_API_URL = process.env.FOUNDRY_API_URL || process.env.FOUNDRY_URL || "";
const STATIC_FOUNDRY_API_TOKEN = process.env.FOUNDRY_API_TOKEN || process.env.FOUNDRY_TOKEN || "";
const EVENTS_DATASET_RID = process.env.FOUNDRY_EVENTS_DATASET_RID || "";
const SNAPSHOT_DATASET_RID = process.env.FOUNDRY_SNAPSHOT_DATASET_RID || "";
const DETECTIONS_DATASET_RID = process.env.FOUNDRY_DETECTIONS_DATASET_RID || "";

function getStatus() {
  return {
    enabled: Boolean(FOUNDRY_API_URL && hasTokenProvider()),
    api_url_configured: Boolean(FOUNDRY_API_URL),
    token_configured: hasTokenProvider(),
    token_source: STATIC_FOUNDRY_API_TOKEN ? "static" : (oauth.isConfigured() && oauth.hasRefreshToken() ? "oauth" : null),
    events_dataset_configured: Boolean(EVENTS_DATASET_RID),
    snapshot_dataset_configured: Boolean(SNAPSHOT_DATASET_RID),
    detections_dataset_configured: Boolean(DETECTIONS_DATASET_RID)
  };
}

function isEnabled() {
  return getStatus().enabled;
}

function hasTokenProvider() {
  return Boolean(STATIC_FOUNDRY_API_TOKEN || (oauth.isConfigured() && oauth.hasRefreshToken()));
}

async function getBearerToken() {
  if (STATIC_FOUNDRY_API_TOKEN) return STATIC_FOUNDRY_API_TOKEN;
  return oauth.getAccessToken();
}

async function foundryPost(path, body) {
  return foundryRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function foundryRequest(path, options) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: "foundry_not_configured" };
  try {
    const res = await fetch(new URL(path, FOUNDRY_API_URL).toString(), {
      method: options.method || "POST",
      headers: {
        Authorization: `Bearer ${await getBearerToken()}`,
        ...(options.headers || {})
      },
      body: options.body
    });
    const text = await res.text();
    const payload = text ? parseFoundryResponse(text) : {};
    if (!res.ok) {
      console.warn(`[foundry-bridge] ${path} -> ${res.status}`);
      return { ok: false, status: res.status, payload };
    }
    return { ok: true, status: res.status, payload };
  } catch (error) {
    console.warn(`[foundry-bridge] ${path} failed:`, error.message);
    return { ok: false, error: error.message };
  }
}

function parseFoundryResponse(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { text };
  }
}

function extractTransactionRid(payload) {
  return payload.transactionRid
    || payload.transaction_rid
    || payload.rid
    || (payload.transaction && (payload.transaction.rid || payload.transaction.transactionRid))
    || (payload.data && (payload.data.rid || payload.data.transactionRid))
    || null;
}

function buildNdjson(rows) {
  return rows.map(row => JSON.stringify(row)).join("\n") + "\n";
}

function buildUploadFilePath(kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `cableguard-${kind}-${stamp}.ndjson`;
}

async function abortDatasetTransaction(datasetRid, transactionRid) {
  if (!transactionRid) return { ok: false, skipped: true, reason: "missing_transaction_rid" };
  return foundryPost(`/api/v2/datasets/${datasetRid}/transactions/${transactionRid}/abort`, {});
}

async function appendRowsToDataset(datasetRid, rows, kind) {
  const begin = await foundryPost(`/api/v2/datasets/${datasetRid}/transactions`, { transactionType: "APPEND" });
  if (!begin.ok) return begin;

  const transactionRid = extractTransactionRid(begin.payload || {});
  if (!transactionRid) {
    return { ok: false, status: begin.status, payload: begin.payload, error: "missing_transaction_rid" };
  }

  const filePath = buildUploadFilePath(kind);
  const uploadPath = `/api/v2/datasets/${datasetRid}/files/${encodeURIComponent(filePath)}/upload?transactionRid=${encodeURIComponent(transactionRid)}`;
  const upload = await foundryRequest(uploadPath, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buildNdjson(rows)
  });

  if (!upload.ok) {
    await abortDatasetTransaction(datasetRid, transactionRid);
    return Object.assign({ transactionRid, filePath }, upload);
  }

  const commit = await foundryPost(`/api/v2/datasets/${datasetRid}/transactions/${transactionRid}/commit`, {});
  if (!commit.ok) {
    await abortDatasetTransaction(datasetRid, transactionRid);
    return Object.assign({ transactionRid, filePath }, commit);
  }

  return Object.assign({ transactionRid, filePath }, commit);
}
async function pushEvent(event) {
  return pushEvents(event ? [event] : []);
}

async function pushEvents(events) {
  if (!EVENTS_DATASET_RID) return { ok: false, skipped: true, reason: "missing_events_dataset" };
  const rows = (Array.isArray(events) ? events : []).filter(Boolean).map(serializeEvent);
  if (!rows.length) return { ok: true, skipped: true, count: 0 };
  const result = await appendRowsToDataset(EVENTS_DATASET_RID, rows, "events");
  return Object.assign({ count: rows.length }, result);
}

async function pushVesselSnapshot(vessels) {
  if (!SNAPSHOT_DATASET_RID) return { ok: false, skipped: true, reason: "missing_snapshot_dataset" };
  const rows = (Array.isArray(vessels) ? vessels : []).filter(Boolean).map(serializeVessel);
  if (!rows.length) return { ok: true, skipped: true, count: 0 };
  const result = await appendRowsToDataset(SNAPSHOT_DATASET_RID, rows, "snapshot");
  return Object.assign({ count: rows.length }, result);
}

async function pushDetection(detection) {
  return pushDetections(detection ? [detection] : []);
}

async function pushDetections(detections) {
  if (!DETECTIONS_DATASET_RID) return { ok: false, skipped: true, reason: "missing_detections_dataset" };
  const rows = (Array.isArray(detections) ? detections : []).filter(Boolean).map(serializeDetection);
  if (!rows.length) return { ok: true, skipped: true, count: 0 };
  const result = await appendRowsToDataset(DETECTIONS_DATASET_RID, rows, "detections");
  return Object.assign({ count: rows.length }, result);
}

function applyWriteBack(payload, handlers) {
  if (!payload || !payload.action) return;
  const fn = handlers && handlers[payload.action];
  if (typeof fn === "function") fn(payload);
}

function serializeEvent(event) {
  return {
    event_id: event.id,
    source: event.source || null,
    source_system: event.source_system || null,
    synthetic: Boolean(event.synthetic),
    scenario_id: event.scenario_id || null,
    event_type: event.event_type || null,
    vessel_key: event.mmsi ? `mmsi:${event.mmsi}` : (event.dark_track_id ? `dark:${event.dark_track_id}` : null),
    mmsi: event.mmsi || event.vessel_id || null,
    vessel_name: event.vessel_name || null,
    lat: numeric(event.lat),
    lon: numeric(event.lon),
    occurred_at: event.occurred_at || event.timestamp || null,
    duration_h: numeric(event.duration_h),
    speed_kn: numeric(event.speed_kn),
    heading_deg: numeric(event.heading_deg),
    risk_score: numeric(event.risk_score),
    risk_level: event.risk_level || null,
    distance_to_cable_nm: numeric(event.distance_to_cable_nm),
    nearest_cable_id: event.nearest_cable_id || null,
    nearest_cable: event.nearest_cable || null,
    counterparty_mmsi: event.counterparty_mmsi || null,
    counterparty_vessel_name: event.counterparty_vessel_name || null,
    region: event.region || null,
    watch_area_id: event.watch_area_id || null,
    watch_area_name: event.watch_area_name || null,
    ais_status: event.ais_status || null,
    rf_matched: nullableBool(event.rf_matched),
    sar_matched: nullableBool(event.sar_matched),
    dark_vessel_status: event.dark_vessel_status || "unknown",
    detection_ids: Array.isArray(event.detection_ids) ? event.detection_ids : [],
    review_status: event.review_status || "unverified",
    recommendation: event.recommendation || null,
    evidence: Array.isArray(event.evidence) ? event.evidence : []
  };
}

function serializeDetection(detection) {
  return {
    detection_id: detection.detection_id || null,
    source: detection.source || null,
    provider: detection.provider || null,
    external_id: detection.external_id || null,
    detected_at: detection.detected_at || detection.timestamp || null,
    lat: numeric(detection.lat),
    lon: numeric(detection.lon),
    confidence: numeric(detection.confidence),
    matched_mmsi: detection.matched_mmsi || null,
    match_distance_nm: numeric(detection.match_distance_nm),
    match_time_delta_s: numeric(detection.match_time_delta_s),
    dark_candidate: Boolean(detection.dark_candidate),
    dark_vessel_status: detection.dark_vessel_status || "unknown",
    dark_track_id: detection.dark_track_id || null,
    synthetic: Boolean(detection.synthetic),
    raw_payload_json: detection.raw_payload_json || detection.raw || null
  };
}

function serializeVessel(v) {
  return {
    vessel_key: v.mmsi ? `mmsi:${v.mmsi}` : null,
    mmsi: v.mmsi || null,
    vessel_name: v.vessel_name || "Unknown",
    lat: numeric(v.lat),
    lon: numeric(v.lon),
    sog_kn: numeric(v.sog),
    cog_deg: numeric(v.cog),
    heading_deg: numeric(v.heading),
    latest_seen_at: v.timestamp || null,
    watch_area_name: v.watch_area_name || null,
    identified_by_vts: Boolean(v.identified_by_vts)
  };
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableBool(value) {
  if (value === null || value === undefined) return null;
  return Boolean(value);
}

module.exports = {
  applyWriteBack,
  getStatus,
  isEnabled,
  pushDetection,
  pushDetections,
  pushEvent,
  pushEvents,
  pushVesselSnapshot
};