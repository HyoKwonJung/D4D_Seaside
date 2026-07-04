const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const domain = require("../public/shared/cableguard-domain.js");

const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATABASE_SSL = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true";
const BASELINE_POSITION_RETENTION_DAYS = parsePositiveInteger(process.env.BASELINE_AIS_POSITION_RETENTION_DAYS, 7);
const SUSPICIOUS_POSITION_RETENTION_DAYS = Math.max(
  BASELINE_POSITION_RETENTION_DAYS,
  parsePositiveInteger(process.env.SUSPICIOUS_AIS_POSITION_RETENTION_DAYS || process.env.AIS_POSITION_RETENTION_DAYS, 30)
);
const SUSPICIOUS_RETENTION_LOOKBACK_HOURS = parsePositiveInteger(process.env.SUSPICIOUS_RETENTION_LOOKBACK_HOURS, 48);

let pool = null;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isDatabaseEnabled() {
  return Boolean(DATABASE_URL);
}

function isDatabaseActive() {
  return Boolean(pool);
}

async function initializeDatabase() {
  if (!isDatabaseEnabled()) return false;

  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL ? { rejectUnauthorized: false } : false
    });
    await pool.query("SELECT 1");
    await runMigrations();
    await pruneOldPositions();
    return true;
  } catch (error) {
    console.warn("Database initialization failed; continuing with in-memory mode:", error.message);
    await closeDatabase();
    return false;
  }
}

async function closeDatabase() {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  await activePool.end().catch(() => {});
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await client.query("SELECT version FROM schema_migrations");
    const appliedVersions = new Set(applied.rows.map(row => row.version));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith(".sql")).sort();

    for (const file of files) {
      if (appliedVersions.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function loadRuntimeSnapshot(maxTrackPoints) {
  if (!pool) {
    return {
      vessels: [],
      tracksByMmsi: new Map(),
      vesselNames: new Map(),
      events: []
    };
  }

  const [latestStateResult, trackResult, eventRows] = await Promise.all([
    pool.query(`
      SELECT
        mmsi,
        vessel_name,
        lat,
        lon,
        sog_kn,
        cog_deg,
        heading_deg,
        last_message_type,
        last_seen_at,
        watch_area_id,
        watch_area_name
      FROM vessel_latest_state
      ORDER BY last_seen_at DESC
    `),
    pool.query(`
      WITH ranked AS (
        SELECT
          mmsi,
          lat,
          lon,
          sog_kn,
          cog_deg,
          heading_deg,
          observed_at,
          ROW_NUMBER() OVER (PARTITION BY mmsi ORDER BY observed_at DESC) AS rn
        FROM ais_positions
      )
      SELECT mmsi, lat, lon, sog_kn, cog_deg, heading_deg, observed_at
      FROM ranked
      WHERE rn <= $1
      ORDER BY mmsi ASC, observed_at ASC
    `, [maxTrackPoints]),
    selectEvents("active = TRUE")
  ]);

  const tracksByMmsi = new Map();
  trackResult.rows.forEach(row => {
    if (!tracksByMmsi.has(row.mmsi)) tracksByMmsi.set(row.mmsi, []);
    tracksByMmsi.get(row.mmsi).push({
      lat: toNullableNumber(row.lat),
      lon: toNullableNumber(row.lon),
      sog: toNullableNumber(row.sog_kn),
      cog: toNullableNumber(row.cog_deg),
      heading: toNullableNumber(row.heading_deg),
      speed_kn: toNullableNumber(row.sog_kn),
      timestamp: toIsoString(row.observed_at)
    });
  });

  const vesselNames = new Map();
  const vessels = latestStateResult.rows.map(row => {
    const vesselName = row.vessel_name || "Unknown";
    if (vesselName && vesselName !== "Unknown") vesselNames.set(row.mmsi, vesselName);
    return {
      source: "aisstream",
      synthetic: false,
      mmsi: row.mmsi,
      vessel_name: vesselName,
      lat: toNullableNumber(row.lat),
      lon: toNullableNumber(row.lon),
      sog: toNullableNumber(row.sog_kn),
      cog: toNullableNumber(row.cog_deg),
      heading: toNullableNumber(row.heading_deg),
      timestamp: toIsoString(row.last_seen_at),
      message_type: row.last_message_type || "Unknown",
      watch_area_id: row.watch_area_id || null,
      watch_area_name: row.watch_area_name || null
    };
  });

  return {
    vessels,
    tracksByMmsi,
    vesselNames,
    events: eventRows
  };
}

async function persistVesselState(vessel, rawPayload) {
  if (!pool || !vessel || !vessel.mmsi) return;
  const client = await pool.connect();
  const vesselName = normalizeStoredName(vessel.vessel_name);
  const observedAt = toDatabaseTimestamp(vessel.timestamp);
  try {
    await client.query("BEGIN");
    await upsertVessel(client, vessel.mmsi, vesselName, observedAt);
    await upsertLatestState(client, vessel, observedAt, vesselName);
    if (Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon)) {
      await client.query(`
        INSERT INTO ais_positions (
          mmsi,
          observed_at,
          lat,
          lon,
          sog_kn,
          cog_deg,
          heading_deg,
          vessel_name,
          message_type,
          source,
          raw_payload_json,
          retention_class,
          retention_until,
          watch_area_id,
          watch_area_name
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, 'aisstream',
          $10::jsonb, 'baseline', $11::timestamptz + ($12::text || ' days')::interval, $13, $14
        )
        ON CONFLICT (mmsi, observed_at, lat, lon, message_type) DO NOTHING
      `, [
        vessel.mmsi,
        observedAt,
        vessel.lat,
        vessel.lon,
        domain.toNumber(vessel.sog),
        domain.toNumber(vessel.cog),
        domain.toNumber(vessel.heading),
        vesselName,
        vessel.message_type || "Unknown",
        JSON.stringify(rawPayload || null),
        observedAt,
        BASELINE_POSITION_RETENTION_DAYS,
        vessel.watch_area_id || null,
        vessel.watch_area_name || null
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function upsertEvent(event) {
  if (!pool || !event || !event.id) return event;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO events (
        id,
        source,
        synthetic,
        scenario_id,
        event_type,
        vessel_mmsi,
        vessel_name,
        occurred_at,
        lat,
        lon,
        duration_h,
        speed_kn,
        heading_deg,
        nearest_cable_id,
        nearest_cable,
        distance_to_cable_nm,
        counterparty_mmsi,
        counterparty_vessel_name,
        region,
        watch_area_id,
        watch_area_name,
        ais_status,
        sar_matched,
        description,
        risk_score,
        risk_level,
        recommendation,
        scoring_version,
        review_status,
        active,
        opened_at,
        last_seen_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29, TRUE, NOW(), NOW(), NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        source = EXCLUDED.source,
        synthetic = EXCLUDED.synthetic,
        scenario_id = EXCLUDED.scenario_id,
        event_type = EXCLUDED.event_type,
        vessel_mmsi = EXCLUDED.vessel_mmsi,
        vessel_name = EXCLUDED.vessel_name,
        occurred_at = EXCLUDED.occurred_at,
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        duration_h = EXCLUDED.duration_h,
        speed_kn = EXCLUDED.speed_kn,
        heading_deg = EXCLUDED.heading_deg,
        nearest_cable_id = EXCLUDED.nearest_cable_id,
        nearest_cable = EXCLUDED.nearest_cable,
        distance_to_cable_nm = EXCLUDED.distance_to_cable_nm,
        counterparty_mmsi = EXCLUDED.counterparty_mmsi,
        counterparty_vessel_name = EXCLUDED.counterparty_vessel_name,
        region = EXCLUDED.region,
        watch_area_id = EXCLUDED.watch_area_id,
        watch_area_name = EXCLUDED.watch_area_name,
        ais_status = EXCLUDED.ais_status,
        sar_matched = EXCLUDED.sar_matched,
        description = EXCLUDED.description,
        risk_score = EXCLUDED.risk_score,
        risk_level = EXCLUDED.risk_level,
        recommendation = EXCLUDED.recommendation,
        scoring_version = EXCLUDED.scoring_version,
        review_status = events.review_status,
        active = TRUE,
        last_seen_at = NOW(),
        closed_at = NULL,
        updated_at = NOW()
    `, [
      event.id,
      event.source || "aisstream",
      Boolean(event.synthetic),
      event.scenario_id || null,
      event.event_type,
      event.mmsi || event.vessel_id || null,
      event.vessel_name || "Unknown",
      toDatabaseTimestamp(event.timestamp || event.occurred_at),
      toNullableNumber(event.lat),
      toNullableNumber(event.lon),
      toNullableNumber(event.duration_h),
      toNullableNumber(event.speed_kn),
      toNullableNumber(event.heading_deg),
      event.nearest_cable_id || null,
      event.nearest_cable || null,
      toNullableNumber(event.distance_to_cable_nm),
      event.counterparty_mmsi || null,
      event.counterparty_vessel_name || null,
      event.region || null,
      event.watch_area_id || null,
      event.watch_area_name || null,
      event.ais_status || null,
      event.sar_matched === null || event.sar_matched === undefined ? null : Boolean(event.sar_matched),
      event.description || null,
      Number(event.risk_score || 0),
      event.risk_level || "Low",
      event.recommendation || null,
      event.scoring_version || "v1",
      domain.normalizeReviewStatus(event.review_status)
    ]);

    await client.query("DELETE FROM event_evidence WHERE event_id = $1", [event.id]);
    const evidenceRows = Array.isArray(event.evidence) ? event.evidence : [];
    for (let i = 0; i < evidenceRows.length; i += 1) {
      await client.query(`
        INSERT INTO event_evidence (event_id, seq, evidence_text)
        VALUES ($1, $2, $3)
      `, [event.id, i, String(evidenceRows[i])]);
    }

    if (event.source === "aisstream" && !event.synthetic) {
      await promoteRetentionForEvent(client, event);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return getEventById(event.id);
}

async function deactivateEvent(eventId) {
  if (!pool || !eventId) return null;
  await pool.query(`
    UPDATE events
    SET active = FALSE,
        closed_at = COALESCE(closed_at, NOW()),
        updated_at = NOW()
    WHERE id = $1
  `, [eventId]);
  return null;
}

async function listActiveEvents() {
  if (!pool) return [];
  return selectEvents("active = TRUE");
}

async function getEventById(eventId) {
  if (!pool || !eventId) return null;
  const events = await selectEvents("id = $1", [eventId]);
  return events[0] || null;
}

async function saveEventReview(eventId, reviewInput) {
  if (!pool) {
    throw new Error("Database persistence is not enabled.");
  }
  const reviewStatus = domain.normalizeReviewStatus(reviewInput.review_status);
  const reviewerName = String(reviewInput.reviewer_name || "Operator").trim() || "Operator";
  const notes = reviewInput.notes === undefined || reviewInput.notes === null
    ? ""
    : String(reviewInput.notes);
  const reviewedAt = toDatabaseTimestamp(reviewInput.reviewed_at);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const eventResult = await client.query("SELECT id FROM events WHERE id = $1", [eventId]);
    if (!eventResult.rowCount) {
      throw new Error("Event not found.");
    }
    await client.query(`
      INSERT INTO event_reviews (event_id, review_status, notes, reviewer_name, reviewed_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [eventId, reviewStatus, notes || null, reviewerName, reviewedAt]);
    await client.query(`
      UPDATE events
      SET review_status = $2,
          review_notes = $3,
          review_updated_by = $4,
          review_updated_at = $5,
          updated_at = NOW()
      WHERE id = $1
    `, [eventId, reviewStatus, notes || null, reviewerName, reviewedAt]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return getEventById(eventId);
}

async function pruneOldPositions() {
  if (!pool) return 0;
  const result = await pool.query(`
    DELETE FROM ais_positions
    WHERE COALESCE(retention_until, observed_at + ($1::text || ' days')::interval) < NOW()
  `, [SUSPICIOUS_POSITION_RETENTION_DAYS]);
  return result.rowCount || 0;
}

async function promoteRetentionForEvent(client, event) {
  const relatedMmsis = collectEventMmsis(event);
  if (!relatedMmsis.length) return;
  await client.query(`
    UPDATE ais_positions
    SET retention_class = 'suspicious',
        retention_until = GREATEST(
          COALESCE(retention_until, observed_at),
          NOW() + ($2::text || ' days')::interval
        )
    WHERE mmsi = ANY($1::text[])
      AND observed_at >= NOW() - ($3::text || ' hours')::interval
  `, [relatedMmsis, SUSPICIOUS_POSITION_RETENTION_DAYS, SUSPICIOUS_RETENTION_LOOKBACK_HOURS]);
}

function collectEventMmsis(event) {
  const ids = new Set();
  [event && event.mmsi, event && event.vessel_id, event && event.counterparty_mmsi].forEach(value => {
    if (value !== null && value !== undefined && value !== "") ids.add(String(value));
  });
  if (Array.isArray(event && event.related_mmsis)) {
    event.related_mmsis.forEach(value => {
      if (value !== null && value !== undefined && value !== "") ids.add(String(value));
    });
  }
  return Array.from(ids);
}

async function selectEvents(whereClause, params) {
  const eventResult = await pool.query(`
    SELECT
      id,
      source,
      synthetic,
      scenario_id,
      event_type,
      vessel_mmsi,
      vessel_name,
      occurred_at,
      lat,
      lon,
      duration_h,
      speed_kn,
      heading_deg,
      nearest_cable_id,
      nearest_cable,
      distance_to_cable_nm,
      counterparty_mmsi,
      counterparty_vessel_name,
      region,
      watch_area_id,
      watch_area_name,
      ais_status,
      sar_matched,
      description,
      risk_score,
      risk_level,
      recommendation,
      scoring_version,
      review_status,
      review_notes,
      review_updated_by,
      review_updated_at,
      active,
      opened_at,
      last_seen_at,
      closed_at,
      created_at,
      updated_at
    FROM events
    WHERE ${whereClause}
    ORDER BY risk_score DESC, updated_at DESC, id ASC
  `, params || []);

  if (!eventResult.rowCount) return [];
  const ids = eventResult.rows.map(row => row.id);
  const evidenceResult = await pool.query(`
    SELECT event_id, seq, evidence_text
    FROM event_evidence
    WHERE event_id = ANY($1::text[])
    ORDER BY event_id ASC, seq ASC
  `, [ids]);

  const evidenceByEventId = new Map();
  evidenceResult.rows.forEach(row => {
    if (!evidenceByEventId.has(row.event_id)) evidenceByEventId.set(row.event_id, []);
    evidenceByEventId.get(row.event_id).push(row.evidence_text);
  });

  return eventResult.rows.map(row => ({
    id: row.id,
    source: row.source,
    synthetic: row.synthetic,
    scenario_id: row.scenario_id,
    event_type: row.event_type,
    vessel_id: row.vessel_mmsi,
    vessel_name: row.vessel_name || "Unknown",
    mmsi: row.vessel_mmsi,
    lat: toNullableNumber(row.lat),
    lon: toNullableNumber(row.lon),
    timestamp: toIsoString(row.occurred_at || row.last_seen_at),
    occurred_at: toIsoString(row.occurred_at || row.last_seen_at),
    duration_h: toNullableNumber(row.duration_h),
    speed_kn: toNullableNumber(row.speed_kn),
    heading_deg: toNullableNumber(row.heading_deg),
    distance_to_cable_nm: toNullableNumber(row.distance_to_cable_nm),
    nearest_cable_id: row.nearest_cable_id,
    nearest_cable: row.nearest_cable,
    counterparty_mmsi: row.counterparty_mmsi || null,
    counterparty_vessel_name: row.counterparty_vessel_name || null,
    region: row.region,
    watch_area_id: row.watch_area_id || null,
    watch_area_name: row.watch_area_name || null,
    ais_status: row.ais_status,
    sar_matched: row.sar_matched,
    description: row.description,
    risk_score: Number(row.risk_score || 0),
    risk_level: row.risk_level,
    recommendation: row.recommendation,
    evidence: evidenceByEventId.get(row.id) || [],
    scoring_version: row.scoring_version,
    review_status: domain.normalizeReviewStatus(row.review_status),
    review_notes: row.review_notes || "",
    review_updated_by: row.review_updated_by || "",
    review_updated_at: row.review_updated_at ? toIsoString(row.review_updated_at) : null,
    active: row.active,
    opened_at: toIsoString(row.opened_at),
    last_seen_at: toIsoString(row.last_seen_at),
    closed_at: row.closed_at ? toIsoString(row.closed_at) : null
  }));
}

async function upsertVessel(client, mmsi, vesselName, observedAt) {
  await client.query(`
    INSERT INTO vessels (mmsi, current_name, first_seen_at, last_seen_at, updated_at)
    VALUES ($1, $2, $3, $3, NOW())
    ON CONFLICT (mmsi) DO UPDATE SET
      current_name = COALESCE(EXCLUDED.current_name, vessels.current_name),
      last_seen_at = GREATEST(vessels.last_seen_at, EXCLUDED.last_seen_at),
      updated_at = NOW()
  `, [mmsi, vesselName, observedAt]);
}

async function upsertLatestState(client, vessel, observedAt, vesselName) {
  await client.query(`
    INSERT INTO vessel_latest_state (
      mmsi,
      vessel_name,
      lat,
      lon,
      sog_kn,
      cog_deg,
      heading_deg,
      last_message_type,
      source,
      watch_area_id,
      watch_area_name,
      last_seen_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'aisstream', $9, $10, $11, NOW())
    ON CONFLICT (mmsi) DO UPDATE SET
      vessel_name = COALESCE(EXCLUDED.vessel_name, vessel_latest_state.vessel_name),
      lat = COALESCE(EXCLUDED.lat, vessel_latest_state.lat),
      lon = COALESCE(EXCLUDED.lon, vessel_latest_state.lon),
      sog_kn = COALESCE(EXCLUDED.sog_kn, vessel_latest_state.sog_kn),
      cog_deg = COALESCE(EXCLUDED.cog_deg, vessel_latest_state.cog_deg),
      heading_deg = COALESCE(EXCLUDED.heading_deg, vessel_latest_state.heading_deg),
      last_message_type = EXCLUDED.last_message_type,
      watch_area_id = COALESCE(EXCLUDED.watch_area_id, vessel_latest_state.watch_area_id),
      watch_area_name = COALESCE(EXCLUDED.watch_area_name, vessel_latest_state.watch_area_name),
      last_seen_at = GREATEST(vessel_latest_state.last_seen_at, EXCLUDED.last_seen_at),
      updated_at = NOW()
  `, [
    vessel.mmsi,
    vesselName,
    Number.isFinite(vessel.lat) ? vessel.lat : null,
    Number.isFinite(vessel.lon) ? vessel.lon : null,
    domain.toNumber(vessel.sog),
    domain.toNumber(vessel.cog),
    domain.toNumber(vessel.heading),
    vessel.message_type || "Unknown",
    vessel.watch_area_id || null,
    vessel.watch_area_name || null,
    observedAt
  ]);
}

function normalizeStoredName(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "Unknown") return null;
  return normalized;
}

function toDatabaseTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function toNullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

module.exports = {
  BASELINE_POSITION_RETENTION_DAYS,
  closeDatabase,
  deactivateEvent,
  getEventById,
  initializeDatabase,
  isDatabaseActive,
  isDatabaseEnabled,
  listActiveEvents,
  loadRuntimeSnapshot,
  persistVesselState,
  pruneOldPositions,
  saveEventReview,
  SUSPICIOUS_POSITION_RETENTION_DAYS,
  SUSPICIOUS_RETENTION_LOOKBACK_HOURS,
  upsertEvent
};
