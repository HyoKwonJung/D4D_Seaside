// AIS-gap dark-vessel position inference. See
// docs/threat-intel-expansion-design.md section 4 for the full design.
//
// This is a periodic watchdog check (not message-triggered like the other
// three detectors in live-review-engine.js), because by definition a dark
// vessel has stopped sending AIS — there is no incoming message to react
// to. server.js calls evaluateAisGap() on a timer for every tracked vessel.
//
// Algorithm: constant-velocity Kalman filter, predict-only (no measurement
// update happens during the gap, since there are no new AIS fixes). Runs in
// a local East-North-Up tangent plane (meters) centered on the vessel's
// last confirmed position. Process noise uses the standard continuous
// white-noise-acceleration model, so position uncertainty grows with the
// CUBE of gap duration — the longer AIS stays off, the faster the search
// area grows, matching how real dead-reckoning uncertainty behaves.
const { findNearestCable } = require("./live-review-engine.js");

const AIS_GAP_WARN_MINUTES = 15; // Class A vessels normally report every few seconds to tens of seconds underway — 15 min of silence is already atypical.
const AIS_GAP_DARK_MINUTES = 45; // Beyond this, classify as ais_status "off" (fully dark) rather than "intermittent".
const DARK_VESSEL_PROXIMITY_NM = 15; // Only watch vessels whose last confirmed position was within this range of a cable — bounds compute cost and false positives from vessels that naturally leave AIS coverage far offshore.
const CABLE_TRIGGER_BUFFER_NM = 5; // Same buffer used by deriveCableRiskEvent in live-review-engine.js.

// Tunable — see design doc section 7, open question 4. Not backtested
// against real gap/reappearance data yet.
const PROCESS_NOISE_INTENSITY = 0.002; // m^2/s^3 — represents ~0.045 m/s^2 (undetected acceleration/turning) during the gap.
const INITIAL_POSITION_VARIANCE_M2 = 900; // (30m std) — typical AIS position accuracy.
const INITIAL_VELOCITY_VARIANCE_M2S2 = 0.25; // (0.5 m/s std) — uncertainty in the last reported SOG/COG.

const EARTH_RADIUS_M = 6371000;
const METERS_PER_NM = 1852;
const KNOTS_TO_MS = 0.514444;

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}

// Local equirectangular projection — accurate enough at the scale of a
// single AIS gap (a few nm), not intended for long-range navigation.
function toLocalMeters(lat, lon, refLat, refLon) {
  const metersPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metersPerDegLon = metersPerDegLat * Math.cos(degToRad(refLat));
  return {
    x: (lon - refLon) * metersPerDegLon,
    y: (lat - refLat) * metersPerDegLat
  };
}

function fromLocalMeters(x, y, refLat, refLon) {
  const metersPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metersPerDegLon = metersPerDegLat * Math.cos(degToRad(refLat));
  return {
    lat: refLat + y / metersPerDegLat,
    lon: refLon + x / metersPerDegLon
  };
}

// 4x4 matrix helpers (state = [x, y, vx, vy]). No external dependency —
// deliberately small and explicit rather than pulling in a linear-algebra
// library for a 4x4 matrix.
function matMul(a, b) {
  const rows = a.length;
  const cols = b[0].length;
  const inner = b.length;
  const result = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      let sum = 0;
      for (let k = 0; k < inner; k += 1) sum += a[i][k] * b[k][j];
      result[i][j] = sum;
    }
  }
  return result;
}

function transpose(a) {
  return a[0].map((_, colIndex) => a.map(row => row[colIndex]));
}

function matAdd(a, b) {
  return a.map((row, i) => row.map((value, j) => value + b[i][j]));
}

function matVecMul(a, v) {
  return a.map(row => row.reduce((sum, value, j) => sum + value * v[j], 0));
}

class ConstantVelocityKalmanFilter {
  constructor(state, positionVarianceM2, velocityVarianceM2S2, processNoiseIntensity) {
    this.state = state.slice();
    this.P = [
      [positionVarianceM2, 0, 0, 0],
      [0, positionVarianceM2, 0, 0],
      [0, 0, velocityVarianceM2S2, 0],
      [0, 0, 0, velocityVarianceM2S2]
    ];
    this.q = processNoiseIntensity;
  }

  // Predict-only step for an elapsed gap of dtSeconds. No correction step —
  // there is no new measurement during an AIS gap by definition.
  predict(dtSeconds) {
    const dt = Math.max(0, dtSeconds);
    const F = [
      [1, 0, dt, 0],
      [0, 1, 0, dt],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const q = this.q;
    const Q = [
      [(q * dt ** 3) / 3, 0, (q * dt ** 2) / 2, 0],
      [0, (q * dt ** 3) / 3, 0, (q * dt ** 2) / 2],
      [(q * dt ** 2) / 2, 0, q * dt, 0],
      [0, (q * dt ** 2) / 2, 0, q * dt]
    ];
    this.state = matVecMul(F, this.state);
    this.P = matAdd(matMul(matMul(F, this.P), transpose(F)), Q);
  }

  // 2-sigma (~95%) position uncertainty radius in meters. x/y variances stay
  // independent under this model (F and Q don't couple the two axes when P0
  // is diagonal), so the larger axis variance gives a conservative circular
  // bound rather than a tighter ellipse.
  positionUncertaintyMeters() {
    return 2 * Math.sqrt(Math.max(this.P[0][0], this.P[1][1]));
  }
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R_NM = 3440.065;
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(degToRad(lat1)) * Math.cos(degToRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(a));
}

function getAisGapEventId(mmsi) {
  return `LIVE-AISGAP-${mmsi}`;
}

// Projects a vessel's likely current position from its last known state and
// returns an evaluation, or null if the vessel isn't a dark-vessel
// candidate (gap too short, or too far from any cable to matter).
function projectDarkVesselPosition(vessel, nowMs) {
  const lastSeenMs = Date.parse(vessel.timestamp);
  if (!Number.isFinite(lastSeenMs)) return null;
  const gapMinutes = (nowMs - lastSeenMs) / 60000;
  if (gapMinutes < AIS_GAP_WARN_MINUTES) return null;

  const lat = Number(vessel.lat);
  const lon = Number(vessel.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const speedKn = Number(vessel.sog);
  const headingDeg = Number(vessel.heading ?? vessel.cog);
  const speedMs = Number.isFinite(speedKn) ? speedKn * KNOTS_TO_MS : 0;
  const headingRad = Number.isFinite(headingDeg) ? degToRad(headingDeg) : 0;
  // Heading is compass bearing (0=N, clockwise); convert to ENU velocity.
  const vx = speedMs * Math.sin(headingRad);
  const vy = speedMs * Math.cos(headingRad);

  const filter = new ConstantVelocityKalmanFilter(
    [0, 0, vx, vy],
    INITIAL_POSITION_VARIANCE_M2,
    INITIAL_VELOCITY_VARIANCE_M2S2,
    PROCESS_NOISE_INTENSITY
  );
  filter.predict(gapMinutes * 60);

  const projectedMeters = { x: filter.state[0], y: filter.state[1] };
  const projected = fromLocalMeters(projectedMeters.x, projectedMeters.y, lat, lon);
  const uncertaintyNm = filter.positionUncertaintyMeters() / METERS_PER_NM;

  return {
    gapMinutes,
    lastConfirmedLat: lat,
    lastConfirmedLon: lon,
    projectedLat: projected.lat,
    projectedLon: projected.lon,
    uncertaintyNm,
    aisStatus: gapMinutes >= AIS_GAP_DARK_MINUTES ? "off" : "intermittent"
  };
}

// Main entry point. Returns an enriched event (via domain.enrichEvent,
// injected by the caller to avoid a require cycle / keep this module
// Node-only) or null.
function evaluateAisGap(vessel, cables, nowMs, options) {
  if (!vessel || !vessel.mmsi) return null;

  const lastKnownDistance = findNearestCable(Number(vessel.lat), Number(vessel.lon), cables);
  if (!lastKnownDistance || lastKnownDistance.distance_nm > DARK_VESSEL_PROXIMITY_NM) return null;

  const projection = projectDarkVesselPosition(vessel, nowMs);
  if (!projection) return null;

  const projectedNearest = findNearestCable(projection.projectedLat, projection.projectedLon, cables) || lastKnownDistance;
  // If even the closest edge of the uncertainty circle can't reach the
  // trigger buffer, this is still just a watch candidate, not yet an event.
  const reachableDistanceNm = projectedNearest.distance_nm - projection.uncertaintyNm;
  if (reachableDistanceNm > CABLE_TRIGGER_BUFFER_NM) return null;

  const domain = options.domain;
  const watchArea = options.watchArea;
  const watchZone = options.watchZone;
  const getContextNote = options.getContextNote;

  return domain.enrichEvent(
    {
      id: getAisGapEventId(vessel.mmsi),
      source: "aisstream",
      synthetic: false,
      scenario_id: "live_ais_gap_review",
      event_type: "ais_gap",
      vessel_id: vessel.mmsi,
      vessel_name: vessel.vessel_name || "Unknown",
      mmsi: vessel.mmsi,
      lat: projection.projectedLat,
      lon: projection.projectedLon,
      timestamp: new Date(nowMs).toISOString(),
      occurred_at: vessel.timestamp,
      gap_started_at: vessel.timestamp,
      last_confirmed_lat: projection.lastConfirmedLat,
      last_confirmed_lon: projection.lastConfirmedLon,
      projected_lat: projection.projectedLat,
      projected_lon: projection.projectedLon,
      position_uncertainty_nm: Math.round(projection.uncertaintyNm * 100) / 100,
      duration_h: projection.gapMinutes / 60,
      speed_kn: Number(vessel.sog) || null,
      heading_deg: vessel.heading ?? vessel.cog ?? null,
      distance_to_cable_nm: Math.max(0, projectedNearest.distance_nm),
      nearest_cable_id: projectedNearest.id,
      nearest_cable: projectedNearest.name,
      region: domain.inferRegion(projection.projectedLat, projection.projectedLon),
      watch_area_id: watchArea ? watchArea.id : null,
      watch_area_name: watchArea ? watchArea.name : null,
      watch_zone_id: watchZone ? watchZone.id : null,
      watch_zone_name: watchZone ? watchZone.name : null,
      ais_status: projection.aisStatus,
      sar_matched: null,
      description: `AIS transmission has been silent for ${Math.round(projection.gapMinutes)} minutes near a cable corridor. Projected position carries +/-${projection.uncertaintyNm.toFixed(1)} nm uncertainty.`,
      evidence: [
        `Last confirmed AIS position was ${Math.round(lastKnownDistance.distance_nm * 10) / 10} nm from ${lastKnownDistance.name} at ${vessel.timestamp}.`,
        `AIS has been silent for ${Math.round(projection.gapMinutes)} minutes (threshold for "off" classification: ${AIS_GAP_DARK_MINUTES} min).`,
        `Dead-reckoning projection puts the vessel within ${projection.uncertaintyNm.toFixed(1)} nm of its last known course/speed, potentially ${Math.round(projectedNearest.distance_nm * 10) / 10} nm from ${projectedNearest.name}.`,
        watchArea ? `Last confirmed inside ${watchArea.name}.` : "Last confirmed inside a Korean maritime watch area.",
        typeof getContextNote === "function" ? getContextNote("ais_gap") : null
      ].filter(Boolean),
      scoring_version: "v1",
      review_status: "unverified",
      active: true
    },
    { areaValueMultiplier: watchZone ? watchZone.recoveryCoeff : 1.0 }
  );
}

module.exports = {
  AIS_GAP_WARN_MINUTES,
  AIS_GAP_DARK_MINUTES,
  DARK_VESSEL_PROXIMITY_NM,
  ConstantVelocityKalmanFilter,
  getAisGapEventId,
  projectDarkVesselPosition,
  evaluateAisGap
};
