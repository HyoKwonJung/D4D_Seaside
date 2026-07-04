require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const stealthmole = require("./lib/stealthmole");

const db = require("./lib/db.js");
const { loadCableReference } = require("./lib/cable-reference.js");
const { deriveLiveEvents } = require("./lib/live-review-engine.js");
const {
  VTS_IDENTIFIED_RADIUS_KM,
  annotateVesselWithVts,
  isWithinVtsCoverage,
  loadVtsReference
} = require("./lib/vts-reference.js");
const { findWatchArea, getAISStreamBoundingBoxes, listWatchAreas, findWatchZone, listWatchZones } = require("./lib/watch-areas.js");
const { listAttackStrategies, getCaseStudies, getContextNote } = require("./lib/attack-strategy-reference.js");
const { evaluateAisGap, getAisGapEventId } = require("./lib/dark-vessel-inference.js");
const domain = require("./public/shared/cableguard-domain.js");

const PORT = parsePositiveInteger(process.env.PORT, 3000);
const AISSTREAM_API_KEY = process.env.AISSTREAM_API_KEY || "";
const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const AIS_STREAM_BOUNDING_BOXES = getAISStreamBoundingBoxes();
const WATCH_AREAS = listWatchAreas();
const FILTER_MESSAGE_TYPES = ["PositionReport", "ShipStaticData", "StaticDataReport"];
const MAX_TRACK_POINTS = 30;
const STATUS_BROADCAST_INTERVAL_MS = 10000;
const POSITION_RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;
const DARK_VESSEL_SWEEP_MS = 5 * 60 * 1000; // AIS_GAP_WARN_MINUTES is 15 min, so a 5 min sweep catches a new gap within 1-2 cycles.
const AISSTREAM_INITIAL_RECONNECT_DELAY_MS = 5000;
const AISSTREAM_MAX_RECONNECT_DELAY_MS = 10 * 60 * 1000;
const AISSTREAM_RATE_LIMIT_DELAY_MS = Math.max(30000, parsePositiveInteger(process.env.AISSTREAM_RATE_LIMIT_DELAY_MS, 120000));

const app = express();
const server = http.createServer(app);
const localWss = new WebSocket.Server({ server });

const liveVessels = new Map();
const trackHistory = new Map();
const vesselNames = new Map();
const liveReviewEvents = new Map();
const vesselEventIndex = new Map();
const clients = new Set();

let cableReference = [];
let vtsReference = [];
let aisstreamSocket = null;
let aisstreamConnected = false;
let aisstreamStatus = AISSTREAM_API_KEY ? "disconnected" : "disabled";
let reconnectTimer = null;
let reconnectDelayMs = AISSTREAM_INITIAL_RECONNECT_DELAY_MS;
let persistenceActive = false;
let rateLimitedUntil = 0;
let runtimeReadyPromise = null;
let backgroundServicesStarted = false;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(ensureRuntimeReady);

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function ensureRuntimeReady(req, res, next) {
  prepareRuntimeState().then(() => next()).catch(next);
}

function sendOsintError(res, scope, err) {
  console.error(`[StealthMole ${scope} error]`, err);
  res.status(err.status || 500).json({
    ok: false,
    error: err.message,
    body: err.body || null
  });
}

app.get("/api/osint/quotas", async (req, res) => {
  try {
    const data = await stealthmole.getQuotas();
    res.json({ ok: true, data });
  } catch (err) {
    sendOsintError(res, "quotas", err);
  }
});

app.get("/api/osint/telegram", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({
        ok: false,
        error: "Missing query parameter: q"
      });
    }

    const data = await stealthmole.searchTelegramKeyword(q);
    res.json({ ok: true, query: q, data });
  } catch (err) {
    sendOsintError(res, "telegram search", err);
  }
});

app.get("/api/osint/telegram/poll", async (req, res) => {
  try {
    const id = String(req.query.id || "").trim();
    const cursor = Number(req.query.cursor || 0);

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "Missing query parameter: id"
      });
    }

    const data = await stealthmole.pollTelegramSearch(id, cursor);
    res.json({ ok: true, id, cursor, data });
  } catch (err) {
    sendOsintError(res, "telegram poll", err);
  }
});

app.get("/api/osint/telegram/node", async (req, res) => {
  try {
    const id = String(req.query.id || "").trim();
    const pid = req.query.pid ? String(req.query.pid) : undefined;

    if (!id) {
      return res.status(400).json({
        ok: false,
        error: "Missing query parameter: id"
      });
    }

    const data = await stealthmole.getTelegramNode(id, pid);
    res.json({ ok: true, id, pid, data });
  } catch (err) {
    sendOsintError(res, "telegram node", err);
  }
});

app.get("/api/osint/monitoring", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({
        ok: false,
        error: "Missing query parameter: q"
      });
    }

    const data = await stealthmole.searchMonitoring(q);
    res.json({ ok: true, query: q, data });
  } catch (err) {
    sendOsintError(res, "monitoring", err);
  }
});

app.get("/health", (req, res) => {
  res.json(buildHealth());
});

app.get("/api/ais/latest", (req, res) => {
  res.json(buildSnapshotPayload());
});

app.get("/api/events/live", (req, res) => {
  res.json({
    events: Array.from(liveReviewEvents.values())
  });
});

app.get("/api/watch-zones", (req, res) => {
  res.json({
    zones: listWatchZones()
  });
});

app.get("/api/attack-strategy-reference", (req, res) => {
  res.json({
    strategies: listAttackStrategies(),
    case_studies: getCaseStudies()
  });
});

app.post("/api/events/:eventId/review", async (req, res) => {
  if (!persistenceActive) {
    res.status(503).json({
      error: "Persistence is not active. Configure DATABASE_URL before saving reviews."
    });
    return;
  }

  try {
    const saved = await db.saveEventReview(req.params.eventId, req.body || {});
    if (!saved) {
      res.status(404).json({ error: "Event not found." });
      return;
    }
    liveReviewEvents.set(saved.id, saved);
    broadcast({ type: "event", event: saved });
    res.json({ ok: true, event: saved });
  } catch (error) {
    const status = error.message === "Event not found." ? 404 : 500;
    res.status(status).json({ error: error.message || "Unable to save review." });
  }
});

localWss.on("connection", ws => {
  clients.add(ws);
  prepareRuntimeState({ startBackground: shouldStartLiveAISInCurrentRuntime() })
    .then(() => {
      sendJson(ws, Object.assign({ type: "status" }, buildHealth()));
      sendJson(ws, Object.assign({ type: "snapshot" }, buildSnapshotPayload()));
    })
    .catch(error => {
      sendJson(ws, { type: "error", error: error.message || "Runtime initialization failed." });
    });

  ws.on("close", () => {
    clients.delete(ws);
  });
});

function buildHealth() {
  return {
    status: "ok",
    aisstream_connected: aisstreamConnected,
    aisstream_status: aisstreamStatus,
    live_vessel_count: liveVessels.size,
    live_event_count: liveReviewEvents.size,
    watch_area_count: WATCH_AREAS.length,
    watch_areas: WATCH_AREAS.map(area => area.name),
    vts_site_count: vtsReference.length,
    vts_identified_radius_km: VTS_IDENTIFIED_RADIUS_KM,
    persistence_enabled: db.isDatabaseEnabled(),
    persistence_active: persistenceActive,
    baseline_retention_days: db.BASELINE_POSITION_RETENTION_DAYS,
    suspicious_retention_days: db.SUSPICIOUS_POSITION_RETENTION_DAYS,
    demo_mode_available: true
  };
}

function buildSnapshotPayload() {
  return {
    vessels: Array.from(liveVessels.values()),
    events: Array.from(liveReviewEvents.values()),
    aisstream_connected: aisstreamConnected,
    aisstream_status: aisstreamStatus,
    live_vessel_count: liveVessels.size,
    live_event_count: liveReviewEvents.size,
    watch_area_count: WATCH_AREAS.length,
    watch_areas: WATCH_AREAS.map(area => area.name),
    vts_site_count: vtsReference.length,
    vts_identified_radius_km: VTS_IDENTIFIED_RADIUS_KM,
    persistence_enabled: db.isDatabaseEnabled(),
    persistence_active: persistenceActive,
    baseline_retention_days: db.BASELINE_POSITION_RETENTION_DAYS,
    suspicious_retention_days: db.SUSPICIOUS_POSITION_RETENTION_DAYS,
    demo_mode_available: true
  };
}

function broadcast(payload) {
  const serialized = JSON.stringify(payload);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  });
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastStatus() {
  broadcast(Object.assign({ type: "status" }, buildHealth()));
}

function connectAISStream() {
  if (!AISSTREAM_API_KEY) {
    aisstreamStatus = "disabled";
    aisstreamConnected = false;
    console.log("Live AIS disabled - AISSTREAM_API_KEY is not set. Demo Mode available.");
    return;
  }

  if (aisstreamSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(aisstreamSocket.readyState)) {
    return;
  }

  clearTimeout(reconnectTimer);
  aisstreamStatus = "connecting";
  broadcastStatus();

  try {
    aisstreamSocket = new WebSocket(AISSTREAM_URL);
  } catch (error) {
    console.warn("AISStream socket creation failed:", error.message);
    scheduleReconnect();
    return;
  }

  aisstreamSocket.on("open", () => {
    aisstreamConnected = true;
    aisstreamStatus = "connected";
    reconnectDelayMs = AISSTREAM_INITIAL_RECONNECT_DELAY_MS;
    rateLimitedUntil = 0;
    console.log("Connected to AISStream.");
    aisstreamSocket.send(JSON.stringify({
      APIKey: AISSTREAM_API_KEY,
      BoundingBoxes: AIS_STREAM_BOUNDING_BOXES,
      FilterMessageTypes: FILTER_MESSAGE_TYPES
    }));
    broadcastStatus();
  });

  aisstreamSocket.on("unexpected-response", (request, response) => {
    aisstreamConnected = false;
    if (response && response.statusCode === 429) {
      markAISRateLimited();
      console.warn(`AISStream rate limited (${response.statusCode}). Backing off reconnect attempts.`);
    } else {
      aisstreamStatus = "error";
      console.warn(`AISStream unexpected response: ${response ? response.statusCode : "unknown"}`);
    }
    if (response && typeof response.resume === "function") response.resume();
    broadcastStatus();
  });

  aisstreamSocket.on("message", data => {
    handleAISStreamMessage(data).catch(error => {
      console.warn("AISStream message handling failed:", error.message);
    });
  });

  aisstreamSocket.on("close", (code, reason) => {
    aisstreamConnected = false;
    if (rateLimitedUntil > Date.now()) {
      aisstreamStatus = "rate_limited";
    } else if (aisstreamStatus !== "error") {
      aisstreamStatus = "disconnected";
    }
    console.warn(`AISStream disconnected (${code}) ${reason || ""}`.trim());
    broadcastStatus();
    scheduleReconnect();
  });

  aisstreamSocket.on("error", error => {
    aisstreamConnected = false;
    if (String(error.message || "").includes("429")) {
      markAISRateLimited();
    } else {
      aisstreamStatus = "error";
    }
    console.warn("AISStream error:", error.message);
    broadcastStatus();
  });
}

function scheduleReconnect() {
  if (!AISSTREAM_API_KEY) return;
  clearTimeout(reconnectTimer);
  const now = Date.now();
  const delayMs = rateLimitedUntil > now
    ? Math.max(reconnectDelayMs, rateLimitedUntil - now)
    : reconnectDelayMs;
  reconnectTimer = setTimeout(() => {
    if (rateLimitedUntil <= Date.now()) rateLimitedUntil = 0;
    connectAISStream();
  }, delayMs);
  reconnectDelayMs = Math.min(Math.max(Math.round(delayMs * 1.7), AISSTREAM_INITIAL_RECONNECT_DELAY_MS), AISSTREAM_MAX_RECONNECT_DELAY_MS);
}

function markAISRateLimited() {
  rateLimitedUntil = Date.now() + AISSTREAM_RATE_LIMIT_DELAY_MS;
  aisstreamStatus = "rate_limited";
  reconnectDelayMs = Math.max(reconnectDelayMs, AISSTREAM_RATE_LIMIT_DELAY_MS);
}

async function handleAISStreamMessage(data) {
  let payload;
  try {
    payload = JSON.parse(data.toString());
  } catch (error) {
    return;
  }

  const normalized = normalizeAISMessage(payload);
  if (!normalized) return;

  const watchArea = Number.isFinite(normalized.lat) && Number.isFinite(normalized.lon)
    ? findWatchArea(normalized.lat, normalized.lon)
    : null;
  const watchZone = Number.isFinite(normalized.lat) && Number.isFinite(normalized.lon)
    ? findWatchZone(normalized.lat, normalized.lon)
    : null;
  normalized.watch_area_id = watchArea ? watchArea.id : null;
  normalized.watch_area_name = watchArea ? watchArea.name : null;

  if (normalized.vessel_name && normalized.vessel_name !== "Unknown") {
    vesselNames.set(normalized.mmsi, normalized.vessel_name);
  }

  if (!Number.isFinite(normalized.lat) || !Number.isFinite(normalized.lon)) {
    const existing = liveVessels.get(normalized.mmsi);
    if (!existing) return;
    const updated = applyVtsIdentification(Object.assign({}, existing, {
      vessel_name: normalized.vessel_name || existing.vessel_name || "Unknown",
      timestamp: normalized.timestamp || existing.timestamp,
      message_type: normalized.message_type || existing.message_type
    }));
    liveVessels.set(normalized.mmsi, updated);
    await persistVessel(updated, payload);
    broadcast({ type: "ais", vessel: updated });
    return;
  }

  const existing = liveVessels.get(normalized.mmsi) || {};
  const vessel = applyVtsIdentification(Object.assign({}, existing, normalized, {
    vessel_name: normalized.vessel_name !== "Unknown"
      ? normalized.vessel_name
      : existing.vessel_name || vesselNames.get(normalized.mmsi) || "Unknown"
  }));

  liveVessels.set(vessel.mmsi, vessel);
  appendTrack(vessel);
  await persistVessel(vessel, payload);
  await syncDerivedEvents(vessel, watchArea, watchZone);
  broadcast({ type: "ais", vessel });
}

async function syncDerivedEvents(vessel, watchArea, watchZone) {
  const track = trackHistory.get(vessel.mmsi) || [];
  const derivedEvents = deriveLiveEvents({
    vessel,
    track,
    liveVessels,
    trackHistory,
    cables: cableReference,
    watchArea,
    watchZone,
    vtsLocations: vtsReference
  });
  const currentIds = new Set(derivedEvents.map(event => event.id));
  const previousIds = new Set(vesselEventIndex.get(vessel.mmsi) || []);

  for (const staleEventId of previousIds) {
    if (!currentIds.has(staleEventId)) {
      await deactivateLiveEvent(staleEventId);
    }
  }

  for (const derivedEvent of derivedEvents) {
    await upsertLiveEvent(derivedEvent);
  }

  vesselEventIndex.set(vessel.mmsi, currentIds);
  return derivedEvents;
}

// Periodic watchdog for dark vessels (AIS gone silent) — see
// lib/dark-vessel-inference.js. Unlike syncDerivedEvents (triggered by an
// incoming AIS message), this runs on a timer, since a dark vessel by
// definition has stopped sending messages. Deliberately does NOT check VTS
// identification: a vessel going dark while under VTS control is itself the
// anomaly, unlike the other three detectors where VTS coverage means the
// vessel's traffic pattern is already explained.
//
// Only ever upserts (never deactivates here) — position_uncertainty_nm
// grows monotonically with gap duration, so a candidate that once qualified
// stays qualified until a new AIS message arrives. When that happens,
// syncDerivedEvents' own stale-id cleanup (above) deactivates the ais_gap
// event automatically, since deriveLiveEvents' current id set won't include
// it — no extra cleanup path needed here.
async function sweepDarkVesselCandidates() {
  const now = Date.now();
  for (const vessel of liveVessels.values()) {
    let darkEvent;
    try {
      const watchArea = findWatchArea(Number(vessel.lat), Number(vessel.lon));
      const watchZone = findWatchZone(Number(vessel.lat), Number(vessel.lon));
      darkEvent = evaluateAisGap(vessel, cableReference, now, { domain, watchArea, watchZone, getContextNote });
    } catch (error) {
      console.warn(`Dark-vessel evaluation failed for ${vessel.mmsi}:`, error.message);
      continue;
    }
    if (darkEvent) {
      await upsertLiveEvent(darkEvent);
    }
  }
}

function applyVtsIdentification(vessel) {
  return annotateVesselWithVts(vessel, vtsReference);
}

function getLiveVesselByMmsi(mmsi) {
  if (mmsi === null || mmsi === undefined) return null;
  return liveVessels.get(mmsi) || liveVessels.get(String(mmsi)) || null;
}

function isEventSuppressedByVts(event) {
  if (!event) return false;
  if (isWithinVtsCoverage(event.lat, event.lon, vtsReference)) return true;

  const primary = getLiveVesselByMmsi(event.mmsi || event.vessel_id);
  if (primary && primary.identified_by_vts) return true;

  const counterparty = getLiveVesselByMmsi(event.counterparty_mmsi);
  return Boolean(counterparty && counterparty.identified_by_vts);
}

async function upsertLiveEvent(derivedEvent) {
  let event = derivedEvent;
  if (persistenceActive) {
    try {
      event = await db.upsertEvent(derivedEvent);
    } catch (error) {
      console.warn(`Failed to persist event ${derivedEvent.id}:`, error.message);
    }
  }
  liveReviewEvents.set(event.id, event);
  indexEventMembership(event);
  broadcast({ type: "event", event });
  broadcastStatus();
  return event;
}

async function deactivateLiveEvent(eventId) {
  const existing = liveReviewEvents.get(eventId);
  liveReviewEvents.delete(eventId);
  clearEventMembership(existing);
  if (persistenceActive) {
    await db.deactivateEvent(eventId).catch(error => {
      console.warn(`Failed to deactivate event ${eventId}:`, error.message);
    });
  }
  broadcast({ type: "event_deleted", event_id: eventId });
  broadcastStatus();
}

async function persistVessel(vessel, rawPayload) {
  if (!persistenceActive) return;
  try {
    await db.persistVesselState(vessel, rawPayload);
  } catch (error) {
    console.warn(`Failed to persist vessel ${vessel.mmsi}:`, error.message);
  }
}

function indexEventMembership(event) {
  getEventMmsis(event).forEach(mmsi => {
    const current = new Set(vesselEventIndex.get(mmsi) || []);
    current.add(event.id);
    vesselEventIndex.set(mmsi, current);
  });
}

function clearEventMembership(event) {
  getEventMmsis(event).forEach(mmsi => {
    const current = new Set(vesselEventIndex.get(mmsi) || []);
    current.delete(event.id);
    if (current.size) vesselEventIndex.set(mmsi, current);
    else vesselEventIndex.delete(mmsi);
  });
}

function getEventMmsis(event) {
  const ids = new Set();
  [event && event.mmsi, event && event.vessel_id, event && event.counterparty_mmsi].forEach(value => {
    if (value !== null && value !== undefined && value !== "") ids.add(String(value));
  });
  return Array.from(ids);
}

function normalizeAISMessage(raw) {
  if (!raw || typeof raw !== "object") return null;

  const messageType = pick(raw, ["MessageType", "message_type", "type"]) || "Unknown";
  const meta = pick(raw, ["MetaData", "metadata", "meta"]) || {};
  const message = pick(raw, ["Message", "message"]) || {};
  const body = pick(message, [messageType, "PositionReport", "ShipStaticData", "StaticDataReport"]) || message;

  const mmsi = pickFirst([
    pick(body, ["UserID", "MMSI", "mmsi"]),
    pick(meta, ["MMSI", "mmsi"])
  ]);
  if (mmsi === null || mmsi === undefined || mmsi === "") return null;

  const mmsiText = String(mmsi);
  const lat = toFiniteNumber(pickFirst([
    pick(body, ["Latitude", "latitude", "lat"]),
    pick(meta, ["Latitude", "latitude", "lat"])
  ]));
  const lon = toFiniteNumber(pickFirst([
    pick(body, ["Longitude", "longitude", "lon", "lng"]),
    pick(meta, ["Longitude", "longitude", "lon", "lng"])
  ]));

  return {
    source: "aisstream",
    synthetic: false,
    mmsi: mmsiText,
    vessel_name: normalizeName(pickFirst([
      pick(body, ["Name", "ShipName", "VesselName", "name", "ship_name"]),
      pick(meta, ["ShipName", "ship_name", "VesselName", "vessel_name"]),
      vesselNames.get(mmsiText)
    ])),
    lat,
    lon,
    sog: toFiniteNumber(pick(body, ["Sog", "SOG", "SpeedOverGround", "speed", "sog"])),
    cog: toFiniteNumber(pick(body, ["Cog", "COG", "CourseOverGround", "course", "cog"])),
    heading: toFiniteNumber(pick(body, ["TrueHeading", "Heading", "heading"])),
    timestamp: normalizeTimestamp(pickFirst([
      pick(meta, ["time_utc", "Time_UTC", "timestamp", "Timestamp"]),
      pick(body, ["Timestamp", "timestamp"])
    ])),
    message_type: messageType
  };
}

function appendTrack(vessel) {
  const track = trackHistory.get(vessel.mmsi) || [];
  track.push({
    lat: vessel.lat,
    lon: vessel.lon,
    sog: vessel.sog,
    speed_kn: vessel.sog,
    cog: vessel.cog,
    heading: vessel.heading,
    timestamp: vessel.timestamp
  });
  while (track.length > MAX_TRACK_POINTS) track.shift();
  trackHistory.set(vessel.mmsi, track);
}

function pick(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function pickFirst(values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeName(value) {
  if (value === null || value === undefined) return "Unknown";
  const name = String(value).trim();
  return name || "Unknown";
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

async function loadReferenceData() {
  try {
    cableReference = loadCableReference();
  } catch (error) {
    cableReference = [];
    console.warn("Unable to load cable reference data for backend event derivation:", error.message);
  }

  try {
    vtsReference = loadVtsReference();
  } catch (error) {
    vtsReference = [];
    console.warn("Unable to load VTS reference data for vessel identification:", error.message);
  }
}

async function restoreRuntimeState() {
  await loadReferenceData();
  persistenceActive = await db.initializeDatabase();
  if (!persistenceActive) return;

  try {
    const snapshot = await db.loadRuntimeSnapshot(MAX_TRACK_POINTS);
    snapshot.vessels.forEach(vessel => {
      liveVessels.set(vessel.mmsi, applyVtsIdentification(vessel));
    });
    snapshot.tracksByMmsi.forEach((track, mmsi) => {
      trackHistory.set(mmsi, track);
    });
    snapshot.vesselNames.forEach((name, mmsi) => {
      vesselNames.set(mmsi, name);
    });
    const suppressedEventIds = [];
    snapshot.events.forEach(event => {
      if (isEventSuppressedByVts(event)) {
        suppressedEventIds.push(event.id);
        return;
      }
      liveReviewEvents.set(event.id, event);
      indexEventMembership(event);
    });
    if (suppressedEventIds.length) {
      await Promise.allSettled(suppressedEventIds.map(eventId => db.deactivateEvent(eventId)));
      console.log(`Suppressed ${suppressedEventIds.length} live events inside VTS identified zones.`);
    }
    console.log(`Database persistence active - restored ${liveVessels.size} vessels and ${liveReviewEvents.size} live events.`);
  } catch (error) {
    persistenceActive = false;
    console.warn("Unable to restore runtime state from database; continuing with in-memory mode:", error.message);
    await db.closeDatabase();
  }
}

async function prepareRuntimeState(options) {
  if (!runtimeReadyPromise) {
    runtimeReadyPromise = restoreRuntimeState();
  }
  await runtimeReadyPromise;
  if (options && options.startBackground) startBackgroundServices();
  return buildHealth();
}

function shouldStartLiveAISInCurrentRuntime() {
  if (!process.env.VERCEL) return true;
  return process.env.ENABLE_VERCEL_AISSTREAM === "true";
}

function startBackgroundServices() {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;
  connectAISStream();
  setInterval(broadcastStatus, STATUS_BROADCAST_INTERVAL_MS);
  setInterval(() => {
    sweepDarkVesselCandidates().catch(error => {
      console.warn("Dark-vessel sweep failed:", error.message);
    });
  }, DARK_VESSEL_SWEEP_MS);
  if (persistenceActive && db.SUSPICIOUS_POSITION_RETENTION_DAYS > 0) {
    setInterval(() => {
      db.pruneOldPositions().catch(error => {
        console.warn("Failed to prune historical AIS positions:", error.message);
      });
    }, POSITION_RETENTION_SWEEP_MS);
  }
}

async function startServer() {
  await prepareRuntimeState();
  server.listen(PORT, () => {
    console.log(`CableGuard-MVP running at http://localhost:${PORT}`);
    startBackgroundServices();
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  app,
  buildHealth,
  buildSnapshotPayload,
  localWss,
  prepareRuntimeState,
  server,
  startServer
};