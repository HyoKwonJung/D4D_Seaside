require("dotenv").config();

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const stealthmole = require("./lib/stealthmole");
const foundryOAuth = require("./lib/foundry-oauth.js");
const foundryOsdk = require("./lib/foundry-osdk.js");
const foundryBridge = require("./lib/foundry-bridge.js");
const gfw = require("./lib/gfw.js");

const db = require("./lib/db.js");
const domain = require("./public/shared/cableguard-domain.js");
const { loadCableReference } = require("./lib/cable-reference.js");
const { deriveLiveEvents } = require("./lib/live-review-engine.js");
const {
  VTS_IDENTIFIED_RADIUS_KM,
  annotateVesselWithVts,
  isWithinVtsCoverage,
  loadVtsReference
} = require("./lib/vts-reference.js");
const { findWatchArea, getAISStreamBoundingBoxes, listWatchAreas } = require("./lib/watch-areas.js");

const PORT = parsePositiveInteger(process.env.PORT, 3000);
const AISSTREAM_API_KEY = process.env.AISSTREAM_API_KEY || "";
const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const AIS_STREAM_BOUNDING_BOXES = getAISStreamBoundingBoxes();
const WATCH_AREAS = listWatchAreas();
const FILTER_MESSAGE_TYPES = ["PositionReport", "ShipStaticData", "StaticDataReport"];
const MAX_TRACK_POINTS = 30;
const STATUS_BROADCAST_INTERVAL_MS = 10000;
const POSITION_RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;
const AISSTREAM_INITIAL_RECONNECT_DELAY_MS = 5000;
const AISSTREAM_MAX_RECONNECT_DELAY_MS = 10 * 60 * 1000;
const AISSTREAM_RATE_LIMIT_DELAY_MS = Math.max(30000, parsePositiveInteger(process.env.AISSTREAM_RATE_LIMIT_DELAY_MS, 120000));
const OSINT_MONITORING_CACHE_MS = Math.max(30000, parsePositiveInteger(process.env.OSINT_MONITORING_CACHE_MS, 10 * 60 * 1000));
const FOUNDRY_SNAPSHOT_INTERVAL_MS = Math.max(60000, parsePositiveInteger(process.env.FOUNDRY_SNAPSHOT_INTERVAL_MS, 5 * 60 * 1000));
const GFW_SAR_LOOKBACK_HOURS = Math.max(1, parsePositiveInteger(process.env.GFW_SAR_LOOKBACK_HOURS, 24));
const GFW_SAR_POLL_INTERVAL_MS = Math.max(10 * 60 * 1000, parsePositiveInteger(process.env.GFW_SAR_POLL_INTERVAL_MS, 6 * 60 * 60 * 1000));
const ENABLE_GFW_SAR_POLLING = String(process.env.ENABLE_GFW_SAR_POLLING || "false").toLowerCase() === "true";
const AI_RECOMMENDER_PROVIDER = String(process.env.AI_RECOMMENDER_PROVIDER || "local").toLowerCase();
const KIMI_API_KEY = process.env.KIMI_API_KEY || "";
const KIMI_API_BASE_URL = String(process.env.KIMI_API_BASE_URL || "https://api.moonshot.ai/v1").replace(/\/+$/, "");
const KIMI_MODEL = process.env.KIMI_MODEL || "moonshot-v1-8k";

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
const osintMonitoringCache = new Map();
const foundryEventSignatures = new Map();
let foundrySnapshotInFlight = false;
let gfwSarIngestRunning = false;
let gfwLastSarIngest = null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/korea_3d_cable_map.html", (req, res) => {
  res.sendFile(path.join(__dirname, "korea_3d_cable_map.html"));
});
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

    const cacheKey = q.toLowerCase();
    const cached = osintMonitoringCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.at) < OSINT_MONITORING_CACHE_MS) {
      return res.json({
        ok: true,
        query: q,
        cached: true,
        cached_at: new Date(cached.at).toISOString(),
        data: cached.data
      });
    }

    const data = await stealthmole.searchMonitoring(q);
    osintMonitoringCache.set(cacheKey, { at: now, data });
    res.json({
      ok: true,
      query: q,
      cached: false,
      cached_at: new Date(now).toISOString(),
      data
    });
  } catch (err) {
    sendOsintError(res, "monitoring", err);
  }
});

// --- Foundry OSDK: OAuth 로그인(1회) + refresh 기반 access token + 이벤트 조회 ---

app.get("/api/auth/foundry/login", (req, res) => {
  if (!foundryOAuth.isConfigured()) {
    return res.status(503).json({ error: "Foundry OAuth not configured. Set FOUNDRY_URL/CLIENT_ID/CLIENT_SECRET." });
  }
  const redirectUri = `${req.protocol}://${req.get("host")}/api/auth/foundry/callback`;
  // 데모용 state. 프로덕션은 세션에 저장 후 callback 에서 검증할 것.
  const state = crypto.randomBytes(12).toString("hex");
  res.redirect(foundryOAuth.buildAuthorizeUrl(redirectUri, state));
});

app.get("/api/auth/foundry/callback", async (req, res) => {
  const code = String(req.query.code || "");
  if (!code) {
    res.status(400).send("Missing authorization code.");
    return;
  }
  try {
    const redirectUri = `${req.protocol}://${req.get("host")}/api/auth/foundry/callback`;
    const tokens = await foundryOAuth.exchangeCodeForTokens(code, redirectUri);
    // 보안: refresh token 은 1회만 노출. 복사 후 .env 의 FOUNDRY_REFRESH_TOKEN 에 저장.
    res.type("text/plain").send(
      "Foundry 로그인 성공.\n\n아래 refresh token 을 .env 의 FOUNDRY_REFRESH_TOKEN 에 저장하세요 (1회만 표시):\n\n"
      + (tokens.refresh_token || "(refresh_token 없음 - 앱에 offline_access 스코프 부여 확인)")
      + "\n"
    );
  } catch (error) {
    res.status(500).send("토큰 교환 실패: " + error.message);
  }
});

let foundryEventsCache = { at: 0, data: null };
const FOUNDRY_EVENTS_CACHE_MS = 30000;

app.get("/api/foundry/events", async (req, res) => {
  try {
    if (!(await foundryOsdk.isReady())) {
      return res.status(503).json({ ok: false, error: "Foundry OSDK not configured/ready." });
    }
    const now = Date.now();
    if (!foundryEventsCache.data || (now - foundryEventsCache.at) > FOUNDRY_EVENTS_CACHE_MS) {
      const events = await foundryOsdk.fetchCableGuardEvents({ pageSize: Number(req.query.limit) || 200 });
      foundryEventsCache = { at: now, data: events };
    }
    res.json({
      ok: true,
      count: foundryEventsCache.data.length,
      cached_at: new Date(foundryEventsCache.at).toISOString(),
      events: foundryEventsCache.data
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/foundry/writeback", async (req, res) => {
  try {
    const result = await applyFoundryWriteBack(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    if (persistenceActive) {
      await db.recordWorkshopWriteBack(req.body || {}, "failed").catch(() => {});
    }
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/foundry/writeback/taskings", async (req, res) => {
  if (!persistenceActive) {
    return res.status(503).json({ ok: false, error: "Persistence is not active." });
  }
  try {
    const taskings = await db.listPatrolTaskings(Number(req.query.limit) || 50);
    res.json({ ok: true, count: taskings.length, taskings });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/foundry/push/status", (req, res) => {
  res.json({
    ok: true,
    bridge: foundryBridge.getStatus(),
    queued_event_signatures: foundryEventSignatures.size,
    snapshot_interval_ms: FOUNDRY_SNAPSHOT_INTERVAL_MS
  });
});

app.post("/api/foundry/push", async (req, res) => {
  try {
    const result = await pushCurrentStateToFoundry({ force: req.body && req.body.force === true });
    res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/gfw/status", (req, res) => {
  res.json({
    ok: true,
    enabled: gfw.isEnabled(),
    sar_polling_enabled: ENABLE_GFW_SAR_POLLING,
    sar_poll_interval_ms: GFW_SAR_POLL_INTERVAL_MS,
    sar_default_lookback_hours: GFW_SAR_LOOKBACK_HOURS,
    last_sar_ingest: gfwLastSarIngest
  });
});

app.get("/api/gfw/detections", async (req, res) => {
  if (!persistenceActive) {
    return res.status(503).json({ ok: false, error: "Persistence is not active." });
  }
  try {
    const detections = await db.listRecentDetections(Number(req.query.limit) || 100);
    res.json({ ok: true, count: detections.length, detections });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/gfw/sar/ingest", async (req, res) => {
  try {
    const result = await ingestGfwSarDarkCandidates(req.body || {});
    res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/ai/decision-support", async (req, res) => {
  const fallback = buildLocalDecisionSupport(req.body || {});
  try {
    if (AI_RECOMMENDER_PROVIDER !== "kimi" || !KIMI_API_KEY) {
      return res.json(fallback);
    }
    const aiResult = await requestKimiDecisionSupport(req.body || {}, fallback);
    res.json(aiResult);
  } catch (error) {
    res.json(Object.assign({}, fallback, {
      provider: "local",
      ai_error: error.message || "AI recommendation fallback used."
    }));
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
    queueFoundryEventPush(saved, { force: true });
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

function buildLocalDecisionSupport(input) {
  const selected = input.selected_event || {};
  const focusAreas = Array.isArray(input.focus_areas) ? input.focus_areas : [];
  const focus = focusAreas[0] || null;
  const intent = input.commander_intent || {};
  const intentText = [intent.text, intent.pir, intent.ffir].filter(Boolean).join(" | ");
  const vessel = selected.vessel_name || "Unknown";
  const riskLevel = selected.risk_level || "Watch";
  const riskScore = Number(selected.risk_score || 0);
  const distance = Number.isFinite(Number(selected.distance_to_cable_nm)) ? `${Number(selected.distance_to_cable_nm).toFixed(1)} nm` : "unknown distance";
  const context = selected.nearest_cable || selected.watch_area_name || selected.region || "current watch area";
  const focusText = focus ? `the ${focus.label} focus area` : (selected.watch_area_name || selected.region || "the current watch area");
  const veryHigh = riskLevel === "Very High" || riskScore >= 70;
  const closeToCable = Number.isFinite(Number(selected.distance_to_cable_nm)) && Number(selected.distance_to_cable_nm) <= 3;
  const intentBasis = intentText ? "Commander intent applied" : "Default threat rules applied";
  const summary = input.summary || {};
  const visibleCount = Number(summary.visible) || (Array.isArray(input.visible_events) ? input.visible_events.length : 0);
  const veryHighCount = Number(summary.very_high) || 0;
  const highCount = Number(summary.high) || 0;
  const liveAisCount = Number(summary.live_ais_vessels) || 0;
  const focusNames = focusAreas.slice(0, 2).map(area => area.label).filter(Boolean).join(", ");
  const briefing = [
    `Receiving live AIS from ${liveAisCount} vessels; ${visibleCount} tracked threat candidates are in the picture (${veryHighCount} Very High, ${highCount} High).`,
    `The top contact is ${vessel} (${riskLevel}, ${distance} from the nearest cable).`,
    focusNames ? `Priority focus areas are ${focusNames}.` : "No priority focus area is currently designated."
  ].join(" ");

  return {
    ok: true,
    provider: "local",
    briefing,
    options: [
      { label: "A", title: "Detect & Track", body: `Maintain track on ${vessel} ${riskLevel} candidate at ${distance}. ${intentBasis}.`, checked: true },
      { label: "B", title: "Re-correlate Sensors", body: `Re-correlate AIS, SAR/RF, Foundry, and OSINT evidence around ${context}. Keep as dark candidate if unmatched.` },
      { label: "C", title: "Watch Focus Area", body: `Monitor new contacts, AIS gaps, and cable approaches inside ${focusText}.` },
      { label: "D", title: veryHigh || closeToCable ? "Launch UAV/SAR" : "Hold Patrol Assets", body: veryHigh || closeToCable ? "Reinforce contact identification with UAV/SAR or maritime patrol assets." : "Keep patrol assets on standby and maintain track. Deploy on further indications." },
      { label: "E", title: "Warning Broadcast", body: `Issue a VHF warning broadcast to ${vessel} and confirm the response.` },
      { label: "F", title: "Request Adjacent Support", body: "Request coordinated response from coast guard and navy units in the area." },
      { label: "G", title: "Disseminate Report", body: "Distribute the threat report to higher and adjacent commands." },
      { label: "H", title: "Stand Down", body: "Return to routine surveillance once the threat is assessed as resolved." }
    ],
    focus_areas: focusAreas
  };
}

async function requestKimiDecisionSupport(input, fallback) {
  const prompt = [
    "You are an operational maritime decision-support assistant for a commander.",
    "Return strict JSON only with this schema:",
    "{\"briefing\":\"...\",\"options\":[{\"label\":\"A\",\"title\":\"...\",\"body\":\"...\"}],\"focus_areas\":[...]}",
    "briefing: 2 to 3 English sentences briefing the commander. It MUST cite the key numbers from summary: total live AIS vessels received (live_ais_vessels), tracked threat candidates (visible), and Very High / High counts. Then name the top threat and main focus areas (use the summary and focus_areas data).",
    "CRITICAL: every text value MUST be written in English only. The input data may contain Korean - translate that context into English and never echo Korean characters in your output.",
    "Write everything in English. Keep each body under 90 characters.",
    "Return 6 to 8 options ordered by priority. Each option is one commander checklist action: title is a short action label of at most 3 words (e.g. \"Detect & Track\", \"Warning Broadcast\"), body is one short imperative sentence with the rationale.",
    "Do not assert hostile intent. Recommend confirmation, correlation, monitoring, or asset tasking only.",
    JSON.stringify({
      commander_intent: input.commander_intent || {},
      summary: input.summary || {},
      selected_event: input.selected_event || {},
      visible_events: Array.isArray(input.visible_events) ? input.visible_events.slice(0, 12) : [],
      focus_areas: Array.isArray(input.focus_areas) ? input.focus_areas.slice(0, 3) : []
    })
  ].join("\n");

  const response = await fetch(`${KIMI_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KIMI_API_KEY}`
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: "You are an English-only assistant. Return compact operational JSON only. Every text value must be in English regardless of the input language." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Kimi API error ${response.status}`);
  }

  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  const parsed = parseAiJson(content);
  const options = normalizeAiOptions(parsed.options, fallback.options);
  // KIMI must speak English only: if the model ignored the instruction and
  // returned Korean anywhere, replace that part with the English local fallback.
  const englishOptions = options.some(option => containsHangul(option.title) || containsHangul(option.body))
    ? fallback.options
    : options;
  const briefing = typeof parsed.briefing === "string" && parsed.briefing.trim() && !containsHangul(parsed.briefing)
    ? parsed.briefing.trim()
    : fallback.briefing;
  return {
    ok: true,
    provider: "kimi",
    model: KIMI_MODEL,
    briefing,
    options: englishOptions,
    focus_areas: Array.isArray(parsed.focus_areas) ? parsed.focus_areas : fallback.focus_areas
  };
}

function containsHangul(value) {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(String(value || ""));
}

function parseAiJson(content) {
  const text = String(content || "").replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(text);
  } catch (_error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("AI response was not valid JSON.");
  }
}

function normalizeAiOptions(options, fallbackOptions) {
  const normalized = Array.isArray(options)
    ? options.map((option, index) => ({
      label: String(option.label || String.fromCharCode(65 + index)).slice(0, 2),
      title: String(option.title || "Action").slice(0, 32),
      body: String(option.body || "Further confirmation required.").slice(0, 120)
    })).filter(option => option.title && option.body).slice(0, 8)
    : [];
  return normalized.length ? normalized : fallbackOptions;
}
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
    foundry_bridge: foundryBridge.getStatus(),
    gfw_enabled: gfw.isEnabled(),
    gfw_sar_polling_enabled: ENABLE_GFW_SAR_POLLING,
    gfw_last_sar_ingest: gfwLastSarIngest,
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
    foundry_bridge: foundryBridge.getStatus(),
    gfw_enabled: gfw.isEnabled(),
    gfw_sar_polling_enabled: ENABLE_GFW_SAR_POLLING,
    gfw_last_sar_ingest: gfwLastSarIngest,
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
      : existing.vessel_name || vesselNames.get(normalized.mmsi) || "Unknown",
    nav_status: normalized.nav_status ?? existing.nav_status ?? null
  }));

  liveVessels.set(vessel.mmsi, vessel);
  appendTrack(vessel);
  await persistVessel(vessel, payload);
  await syncDerivedEvents(vessel, watchArea);
  broadcast({ type: "ais", vessel });
}

async function syncDerivedEvents(vessel, watchArea) {
  const track = trackHistory.get(vessel.mmsi) || [];
  const derivedEvents = deriveLiveEvents({
    vessel,
    track,
    liveVessels,
    trackHistory,
    cables: cableReference,
    watchArea,
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
  queueFoundryEventPush(event);
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

async function applyFoundryWriteBack(payload) {
  if (!persistenceActive) {
    return { ok: false, error: "Persistence is not active. Workshop write-back requires DATABASE_URL." };
  }

  const input = normalizeWriteBackPayload(payload);
  if (parseBoolean(payload.dry_run ?? payload.dryRun, false)) {
    return { ok: true, dry_run: true, normalized: input };
  }
  let result;
  switch (input.action) {
    case "saveReview":
      result = await applyWorkshopSaveReview(input);
      break;
    case "classifyDarkVessel":
      result = await applyWorkshopClassifyDarkVessel(input);
      break;
    case "taskPatrolAsset":
      result = await applyWorkshopTaskPatrolAsset(input);
      break;
    case "mergeDarkTracks":
      result = await applyWorkshopMergeDarkTracks(input);
      break;
    default:
      await db.recordWorkshopWriteBack(payload, "rejected");
      return { ok: false, error: `Unsupported Workshop action: ${input.action || "unknown"}` };
  }

  await db.recordWorkshopWriteBack(Object.assign({}, payload, input), "applied");
  return result;
}

async function applyWorkshopSaveReview(input) {
  if (!input.event_id) throw new Error("saveReview requires event_id.");
  const event = await db.saveEventReview(input.event_id, {
    review_status: input.review_status || "reviewed",
    reviewer_name: input.reviewer_name || "Foundry Workshop",
    notes: input.notes || "",
    reviewed_at: input.reviewed_at
  });
  syncEventFromWriteBack(event);
  return { ok: true, action: input.action, event };
}

async function applyWorkshopClassifyDarkVessel(input) {
  const darkStatus = input.dark_vessel_status || input.status || "confirmed-dark";
  let event = null;
  let vesselRows = 0;
  if (input.vessel_key) {
    vesselRows = await db.updateVesselDarkStatus(input.vessel_key, darkStatus);
  }
  if (input.event_id) {
    event = await db.updateEventDarkStatus(input.event_id, darkStatus, {
      review_status: input.review_status || (darkStatus === "confirmed-dark" ? "verified" : "reviewed"),
      reviewer_name: input.reviewer_name || "Foundry Workshop",
      notes: input.notes || `Workshop classification: ${darkStatus}`,
      reviewed_at: input.reviewed_at
    });
    syncEventFromWriteBack(event);
  }
  if (!event && !vesselRows) throw new Error("classifyDarkVessel requires event_id or vessel_key.");
  broadcast({ type: "workshop_writeback", action: input.action, event_id: input.event_id || null, vessel_key: input.vessel_key || null, dark_vessel_status: darkStatus });
  broadcastStatus();
  return { ok: true, action: input.action, event, vessel_rows_updated: vesselRows, dark_vessel_status: darkStatus };
}

async function applyWorkshopTaskPatrolAsset(input) {
  if (!input.event_id && !input.vessel_key) throw new Error("taskPatrolAsset requires event_id or vessel_key.");
  const tasking = await db.createPatrolTasking({
    tasking_id: input.tasking_id,
    event_id: input.event_id,
    vessel_key: input.vessel_key,
    asset_type: input.asset_type || "patrol-asset",
    priority: input.priority || "medium",
    status: input.status || "tasking",
    notes: input.notes || "",
    requested_by: input.reviewer_name || input.requested_by || "Foundry Workshop",
    requested_at: input.requested_at,
    source: "foundry-workshop"
  });
  let event = null;
  if (input.event_id) {
    event = await db.getEventById(input.event_id);
    syncEventFromWriteBack(event);
  }
  broadcast({ type: "patrol_tasking", tasking, event });
  broadcastStatus();
  return { ok: true, action: input.action, tasking, event };
}

async function applyWorkshopMergeDarkTracks(input) {
  if (!Array.isArray(input.merge_keys) || input.merge_keys.length < 2) {
    throw new Error("mergeDarkTracks requires merge_keys with at least two vessel keys.");
  }
  broadcast({ type: "workshop_writeback", action: input.action, merge_keys: input.merge_keys, notes: input.notes || "" });
  return { ok: true, action: input.action, merge_keys: input.merge_keys, status: "logged" };
}

function syncEventFromWriteBack(event) {
  if (!event || !event.id) return;
  liveReviewEvents.set(event.id, event);
  indexEventMembership(event);
  queueFoundryEventPush(event, { force: true });
  broadcast({ type: "event", event });
  broadcastStatus();
}

function normalizeWriteBackPayload(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const target = input.target && typeof input.target === "object" ? input.target : {};
  const parameters = input.parameters && typeof input.parameters === "object" ? input.parameters : {};
  const action = normalizeWorkshopAction(input.action || input.action_type || input.actionType || input.actionName || input.type);
  return {
    action,
    event_id: pickWriteBackValue(input.event_id, input.eventId, target.event_id, target.eventId, parameters.event_id, parameters.eventId),
    vessel_key: pickWriteBackValue(input.vessel_key, input.vesselKey, target.vessel_key, target.vesselKey, parameters.vessel_key, parameters.vesselKey),
    review_status: pickWriteBackValue(input.review_status, input.reviewStatus, parameters.review_status, parameters.reviewStatus),
    dark_vessel_status: pickWriteBackValue(input.dark_vessel_status, input.darkVesselStatus, input.status, parameters.dark_vessel_status, parameters.darkVesselStatus, parameters.status),
    status: pickWriteBackValue(input.status, parameters.status),
    asset_type: pickWriteBackValue(input.asset_type, input.assetType, parameters.asset_type, parameters.assetType),
    priority: pickWriteBackValue(input.priority, parameters.priority),
    tasking_id: pickWriteBackValue(input.tasking_id, input.taskingId, parameters.tasking_id, parameters.taskingId),
    reviewer_name: pickWriteBackValue(input.reviewer_name, input.reviewerName, input.operator, parameters.reviewer_name, parameters.reviewerName, parameters.operator),
    requested_by: pickWriteBackValue(input.requested_by, input.requestedBy, parameters.requested_by, parameters.requestedBy),
    requested_at: pickWriteBackValue(input.requested_at, input.requestedAt, parameters.requested_at, parameters.requestedAt),
    reviewed_at: pickWriteBackValue(input.reviewed_at, input.reviewedAt, parameters.reviewed_at, parameters.reviewedAt),
    notes: pickWriteBackValue(input.notes, input.comment, parameters.notes, parameters.comment),
    merge_keys: normalizeMergeKeys(input.merge_keys || input.mergeKeys || parameters.merge_keys || parameters.mergeKeys)
  };
}

function normalizeWorkshopAction(value) {
  const text = String(value || "").trim();
  const compact = text.replace(/[\s_-]+/g, "").toLowerCase();
  const mapping = {
    savereview: "saveReview",
    classifydarkvessel: "classifyDarkVessel",
    taskpatrolasset: "taskPatrolAsset",
    mergedarktracks: "mergeDarkTracks"
  };
  return mapping[compact] || text;
}

function pickWriteBackValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function normalizeMergeKeys(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === "string" && value.trim()) return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function canPushFoundryEvents() {
  const status = foundryBridge.getStatus();
  return status.enabled && status.events_dataset_configured;
}

async function pushEventToFoundry(event, options) {
  if (!event || event.source_system === "foundry-osdk" || !canPushFoundryEvents()) {
    return { ok: false, skipped: true };
  }
  const settings = options || {};
  const signature = buildEventPushSignature(event);
  if (!settings.force && foundryEventSignatures.get(event.id) === signature) {
    return { ok: true, skipped: true, reason: "unchanged" };
  }
  foundryEventSignatures.set(event.id, signature);
  const result = await foundryBridge.pushEvent(event);
  if (result && result.ok && persistenceActive) {
    await db.markEventFoundrySynced(event.id).catch(error => {
      console.warn(`Failed to mark Foundry event sync ${event.id}:`, error.message);
    });
  }
  return result;
}

function queueFoundryEventPush(event, options) {
  pushEventToFoundry(event, options).catch(error => {
    console.warn(`Foundry event push failed for ${event && event.id ? event.id : "unknown"}:`, error.message);
  });
}

function buildEventPushSignature(event) {
  return JSON.stringify({
    id: event.id,
    source: event.source,
    event_type: event.event_type,
    lat: event.lat,
    lon: event.lon,
    occurred_at: event.occurred_at || event.timestamp,
    risk_score: event.risk_score,
    risk_level: event.risk_level,
    review_status: event.review_status,
    dark_vessel_status: event.dark_vessel_status,
    detection_ids: event.detection_ids || []
  });
}

async function pushCurrentStateToFoundry(options) {
  const settings = options || {};
  const status = foundryBridge.getStatus();
  if (!status.enabled) {
    return { ok: false, bridge: status, error: "Foundry bridge is not configured." };
  }
  if (!status.events_dataset_configured && !status.snapshot_dataset_configured) {
    return { ok: false, bridge: status, error: "No Foundry push datasets are configured." };
  }

  const events = Array.from(liveReviewEvents.values())
    .filter(event => event && event.source_system !== "foundry-osdk");
  const vessels = Array.from(liveVessels.values());
  let eventsResult = { ok: true, skipped: true, reason: "events_dataset_not_configured" };
  let snapshotResult = { ok: true, skipped: true, reason: "snapshot_dataset_not_configured" };

  if (status.events_dataset_configured && events.length) {
    eventsResult = await foundryBridge.pushEvents(events);
    if (eventsResult.ok && persistenceActive) {
      await Promise.allSettled(events.map(event => db.markEventFoundrySynced(event.id)));
      events.forEach(event => foundryEventSignatures.set(event.id, buildEventPushSignature(event)));
    }
  }

  if (status.snapshot_dataset_configured && vessels.length) {
    snapshotResult = await foundryBridge.pushVesselSnapshot(vessels);
  }

  const ok = Boolean((eventsResult.ok || eventsResult.skipped) && (snapshotResult.ok || snapshotResult.skipped));
  return {
    ok,
    bridge: status,
    event_count: events.length,
    vessel_count: vessels.length,
    events: eventsResult,
    snapshot: snapshotResult,
    forced: Boolean(settings.force)
  };
}

async function pushFoundryVesselSnapshot() {
  const status = foundryBridge.getStatus();
  if (!status.enabled || !status.snapshot_dataset_configured || foundrySnapshotInFlight) return;
  const vessels = Array.from(liveVessels.values());
  if (!vessels.length) return;
  foundrySnapshotInFlight = true;
  try {
    await foundryBridge.pushVesselSnapshot(vessels);
  } finally {
    foundrySnapshotInFlight = false;
  }
}

async function pushDetectionToFoundry(detection) {
  const status = foundryBridge.getStatus();
  if (!status.enabled || !status.detections_dataset_configured || !detection) {
    return { ok: false, skipped: true };
  }
  const result = await foundryBridge.pushDetection(detection);
  if (result && result.ok && persistenceActive) {
    await db.markDetectionFoundrySynced(detection.detection_id).catch(error => {
      console.warn(`Failed to mark Foundry detection sync ${detection.detection_id}:`, error.message);
    });
  }
  return result;
}

async function ingestGfwSarDarkCandidates(input) {
  if (!gfw.isEnabled()) {
    return { ok: false, enabled: false, error: "GFW_API_TOKEN is not configured." };
  }
  if (gfwSarIngestRunning && !(input && input.force === true)) {
    return { ok: false, enabled: true, error: "GFW SAR ingest is already running." };
  }

  const options = normalizeGfwSarIngestOptions(input || {});
  const startedAt = new Date().toISOString();
  const summary = {
    ok: true,
    enabled: true,
    dry_run: options.dryRun,
    started_at: startedAt,
    start_date: options.startDate,
    end_date: options.endDate,
    watch_area_count: options.areas.length,
    areas: [],
    detections_seen: 0,
    dark_candidates: 0,
    events_upserted: 0,
    errors: []
  };

  gfwSarIngestRunning = true;
  try {
    for (const area of options.areas) {
      const areaResult = {
        watch_area_id: area.id,
        watch_area_name: area.name,
        detections_seen: 0,
        dark_candidates: 0,
        events_upserted: 0
      };
      try {
        const payload = await gfw.getSarDetections({
          bounds: area.bounds,
          startDate: options.startDate,
          endDate: options.endDate,
          matched: false
        });
        const records = extractGfwRecords(payload).slice(0, options.limitPerArea);
        areaResult.detections_seen = records.length;
        summary.detections_seen += records.length;

        for (const record of records) {
          const detection = normalizeGfwSarRecord(record, area, { defaultMatched: false });
          if (!detection || !detection.dark_candidate) continue;
          areaResult.dark_candidates += 1;
          summary.dark_candidates += 1;

          if (!options.dryRun && persistenceActive) {
            await db.upsertDetection(detection);
          }
          if (!options.dryRun) {
            const event = buildGfwSarEvent(detection, area);
            // 케이블 방어 목적상, 케이블에서 먼 원양 다크 탐지는 이벤트화하지 않는다
            // (탐지 자체는 위에서 DB에 보존됨). 제외 수는 events_skipped_far로 보고.
            const cableDistance = Number(event.distance_to_cable_nm);
            if (Number.isFinite(cableDistance) && cableDistance > options.maxCableDistanceNm) {
              areaResult.events_skipped_far = (areaResult.events_skipped_far || 0) + 1;
              summary.events_skipped_far = (summary.events_skipped_far || 0) + 1;
              continue;
            }
            await upsertLiveEvent(event);
            await pushDetectionToFoundry(detection);
            areaResult.events_upserted += 1;
            summary.events_upserted += 1;
          }
        }
      } catch (error) {
        const message = `${area.name}: ${error.message}`;
        areaResult.error = error.message;
        summary.errors.push(message);
        console.warn("GFW SAR ingest failed:", message);
      }
      summary.areas.push(areaResult);
    }
  } finally {
    gfwSarIngestRunning = false;
  }

  summary.ok = summary.errors.length === 0;
  summary.completed_at = new Date().toISOString();
  gfwLastSarIngest = summary;
  return summary;
}

function normalizeGfwSarIngestOptions(input) {
  const endDate = normalizeGfwDate(input.endDate || input.end_date, new Date());
  const defaultStart = new Date(Date.now() - GFW_SAR_LOOKBACK_HOURS * 60 * 60 * 1000);
  const startDate = normalizeGfwDate(input.startDate || input.start_date, defaultStart);
  const limitPerArea = Math.max(1, Math.min(Number(input.limitPerArea || input.limit || process.env.GFW_SAR_LIMIT_PER_AREA) || 200, 1000));
  const bounds = normalizeBounds(input.bounds);
  const watchAreaId = String(input.watch_area_id || input.watchAreaId || "").trim();
  let areas;
  if (bounds) {
    areas = [{ id: "custom", name: "Custom Bounds", bounds }];
  } else if (watchAreaId) {
    areas = WATCH_AREAS.filter(area => area.id === watchAreaId || area.name === watchAreaId);
  } else {
    areas = WATCH_AREAS;
  }
  // 이벤트화할 다크 탐지의 최대 케이블 이격 (기본 10nm). 먼 원양 탐지는 DB에만 보존.
  const maxCableDistanceNm = Math.max(1, Number(
    input.max_cable_distance_nm ?? input.maxCableDistanceNm ?? process.env.GFW_SAR_MAX_CABLE_NM
  ) || 10);
  return {
    startDate,
    endDate,
    limitPerArea,
    maxCableDistanceNm,
    dryRun: parseBoolean(input.dry_run ?? input.dryRun, false),
    areas: areas.length ? areas : WATCH_AREAS
  };
}

function normalizeGfwDate(value, fallbackDate) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = value ? new Date(value) : fallbackDate;
  if (Number.isNaN(date.getTime())) return fallbackDate.toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeBounds(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const sw = value[0] || [];
  const ne = value[1] || [];
  const bounds = [[Number(sw[0]), Number(sw[1])], [Number(ne[0]), Number(ne[1])]];
  return bounds.flat().every(Number.isFinite) ? bounds : null;
}

function extractGfwRecords(payload) {
  return collectGfwRecords(payload, 0)
    .map(unwrapGfwFeature)
    .filter(record => record && typeof record === "object");
}

function collectGfwRecords(value, depth) {
  if (!value || depth > 6) return [];
  if (Array.isArray(value)) {
    const records = [];
    value.forEach(item => {
      if (isGfwRecordLike(item)) records.push(item);
      else records.push(...collectGfwRecords(item, depth + 1));
    });
    return records;
  }
  if (typeof value !== "object") return [];
  if (isGfwRecordLike(value)) return [value];

  const records = [];
  for (const key of ["entries", "detections", "results", "data", "rows", "features", "items"]) {
    if (value[key]) records.push(...collectGfwRecords(value[key], depth + 1));
  }
  Object.entries(value).forEach(([key, nested]) => {
    if (["entries", "detections", "results", "data", "rows", "features", "items"].includes(key)) return;
    records.push(...collectGfwRecords(nested, depth + 1));
  });
  return records;
}

function isGfwRecordLike(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type === "Feature") return true;
  const keys = new Set(Object.keys(value).map(key => key.toLowerCase()));
  return (keys.has("lat") || keys.has("latitude"))
    && (keys.has("lon") || keys.has("lng") || keys.has("longitude"))
    && (keys.has("date") || keys.has("detections") || keys.has("entrytimestamp") || keys.has("detectiontime"));
}

function unwrapGfwFeature(record) {
  if (!record || typeof record !== "object") return null;
  if (record.type === "Feature") {
    const props = record.properties && typeof record.properties === "object" ? record.properties : {};
    const coords = record.geometry && Array.isArray(record.geometry.coordinates)
      ? record.geometry.coordinates
      : [];
    return Object.assign({}, props, {
      id: record.id || props.id,
      lon: coords.length >= 2 ? coords[0] : props.lon,
      lat: coords.length >= 2 ? coords[1] : props.lat,
      raw_feature: record
    });
  }
  return record;
}

function normalizeGfwSarRecord(record, area, options) {
  const lat = pickNumberFromRecord(record, ["lat", "latitude", "cellLat", "centerLat"]);
  const lon = pickNumberFromRecord(record, ["lon", "lng", "longitude", "cellLon", "centerLon"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const detectedAt = normalizeTimestamp(pickValueFromRecord(record, [
    "date", "detectedAt", "detectionTime", "entryTimestamp", "timestamp", "start", "startDate"
  ]));
  const matchedRaw = pickValueFromRecord(record, ["matched", "aisMatched", "matchedAis", "hasAis", "matched_ais"]);
  const matched = matchedRaw === null || matchedRaw === undefined
    ? Boolean(options && options.defaultMatched)
    : parseBoolean(matchedRaw, false);
  const externalId = String(pickValueFromRecord(record, ["id", "detectionId", "detection_id", "cellId"]) || stableHash([lat, lon, detectedAt, area.id, JSON.stringify(record)]));
  const detectionId = `gfw-sar-${stableHash(externalId)}`;
  const matchedMmsi = matched ? normalizeIdentifier(pickValueFromRecord(record, ["mmsi", "ssvid", "vesselMmsi", "matchedMmsi"])) : null;

  return {
    detection_id: detectionId,
    source: "sar",
    provider: "gfw",
    external_id: externalId,
    detected_at: detectedAt,
    lat,
    lon,
    confidence: pickNumberFromRecord(record, ["confidence", "score", "probability"]),
    matched_mmsi: matchedMmsi,
    match_distance_nm: null,
    match_time_delta_s: null,
    dark_candidate: !matched,
    dark_vessel_status: matched ? "ais-matched" : "sar-only",
    dark_track_id: matched ? null : `dark-sar-${stableHash([lat, lon, detectedAt]).slice(0, 12)}`,
    synthetic: false,
    detections_count: pickNumberFromRecord(record, ["detections", "detections_count", "count"]),
    raw_payload_json: record
  };
}

function buildGfwSarEvent(detection, area) {
  const nearest = findNearestCable(detection.lat, detection.lon);
  const matched = Boolean(detection.matched_mmsi);
  const event = {
    id: `GFW-SAR-EVENT-${stableHash(detection.detection_id)}`,
    source: "gfw",
    source_system: "gfw-sar-ingest",
    synthetic: false,
    event_type: "sar_dark",
    vessel_id: matched ? detection.matched_mmsi : detection.dark_track_id,
    vessel_name: matched ? `MMSI ${detection.matched_mmsi}` : "Unknown SAR contact",
    mmsi: matched ? detection.matched_mmsi : null,
    lat: detection.lat,
    lon: detection.lon,
    timestamp: detection.detected_at,
    occurred_at: detection.detected_at,
    duration_h: null,
    speed_kn: null,
    heading_deg: null,
    nearest_cable_id: nearest && nearest.id,
    nearest_cable: nearest && nearest.name,
    distance_to_cable_nm: nearest && nearest.distance_nm,
    region: domain.inferRegion(detection.lat, detection.lon),
    watch_area_id: area.id,
    watch_area_name: area.name,
    ais_status: matched ? "on" : "off",
    sar_matched: matched,
    rf_matched: null,
    dark_vessel_status: detection.dark_vessel_status,
    detection_ids: [detection.detection_id],
    description: "GFW SAR detection without a matching AIS contact near the cable watch area.",
    evidence: [
      "GFW SAR presence returned as AIS-unmatched.",
      "Candidate generated by low-frequency batch ingest; confirm with patrol, radar, or later AIS reappearance."
    ],
    review_status: "unverified"
  };
  return domain.enrichEvent(event, { findNearestCable });
}

function findNearestCable(lat, lon) {
  if (!Array.isArray(cableReference) || !cableReference.length) return null;
  let nearest = null;
  cableReference.forEach(cable => {
    const distance = distancePointToCableNm(lat, lon, cable);
    if (!Number.isFinite(distance)) return;
    if (!nearest || distance < nearest.distance_nm) {
      nearest = { id: cable.id, name: cable.name, distance_nm: distance };
    }
  });
  return nearest;
}

function distancePointToCableNm(lat, lon, cable) {
  let min = Infinity;
  (cable.coords || []).forEach(line => {
    for (let i = 0; i < line.length; i += 1) {
      const point = line[i];
      min = Math.min(min, haversineNm(lat, lon, point[1], point[0]));
      if (i > 0) {
        const prev = line[i - 1];
        min = Math.min(min, distancePointToSegmentNm(lat, lon, prev[1], prev[0], point[1], point[0]));
      }
    }
  });
  return min;
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const earthRadiusNm = 3440.065;
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  const rLat1 = degToRad(lat1);
  const rLat2 = degToRad(lat2);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusNm * Math.asin(Math.sqrt(a));
}

function distancePointToSegmentNm(lat, lon, lat1, lon1, lat2, lon2) {
  const meanLat = degToRad((lat + lat1 + lat2) / 3);
  const x = (valueLon, originLon) => (valueLon - originLon) * 60 * Math.cos(meanLat);
  const y = (valueLat, originLat) => (valueLat - originLat) * 60;
  const px = x(lon, lon1);
  const py = y(lat, lat1);
  const sx = x(lon2, lon1);
  const sy = y(lat2, lat1);
  const lenSq = sx * sx + sy * sy;
  if (lenSq === 0) return haversineNm(lat, lon, lat1, lon1);
  const t = Math.max(0, Math.min(1, (px * sx + py * sy) / lenSq));
  const projX = t * sx;
  const projY = t * sy;
  const dx = px - projX;
  const dy = py - projY;
  return Math.sqrt(dx * dx + dy * dy);
}

function degToRad(value) {
  return value * Math.PI / 180;
}

function pickValueFromRecord(record, keys) {
  return findValueByKeys(record, keys.map(key => key.toLowerCase()), 0);
}

function pickNumberFromRecord(record, keys) {
  const value = pickValueFromRecord(record, keys);
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function findValueByKeys(value, lowerKeys, depth) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const [key, item] of Object.entries(value)) {
    if (lowerKeys.includes(key.toLowerCase()) && item !== null && item !== undefined && item !== "") return item;
  }
  for (const item of Object.values(value)) {
    const found = findValueByKeys(item, lowerKeys, depth + 1);
    if (found !== null && found !== undefined && found !== "") return found;
  }
  return null;
}

function parseBoolean(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "matched"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "unmatched"].includes(normalized)) return false;
  return fallback;
}

function normalizeIdentifier(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function stableHash(value) {
  return crypto.createHash("sha1").update(Array.isArray(value) ? value.join("|") : String(value)).digest("hex").slice(0, 16);
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
    // AIS 항해 상태 (1=묘박, 5=계류). 입항대기 선박을 이상행동 탐지에서 구분하는 근거.
    nav_status: toFiniteNumber(pick(body, ["NavigationalStatus", "NavigationStatus", "navigational_status", "nav_status"])),
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
  setTimeout(() => {
    pushCurrentStateToFoundry().catch(error => console.warn("Initial Foundry push failed:", error.message));
  }, 5000);
  setInterval(() => {
    pushFoundryVesselSnapshot().catch(error => console.warn("Foundry snapshot push failed:", error.message));
  }, FOUNDRY_SNAPSHOT_INTERVAL_MS);
  if (ENABLE_GFW_SAR_POLLING && gfw.isEnabled()) {
    setTimeout(() => {
      ingestGfwSarDarkCandidates({}).catch(error => console.warn("Initial GFW SAR ingest failed:", error.message));
    }, 15000);
    setInterval(() => {
      ingestGfwSarDarkCandidates({}).catch(error => console.warn("GFW SAR ingest failed:", error.message));
    }, GFW_SAR_POLL_INTERVAL_MS);
  }
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