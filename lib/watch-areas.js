const MARITIME_WATCH_AOIS = [
  {
    id: "west-sea",
    name: "West Sea / Yellow Sea",
    bounds: [[32.0, 123.0], [38.9, 126.9]]
  },
  {
    id: "jeju-approaches",
    name: "Jeju / Southwest Approaches",
    bounds: [[31.5, 124.8], [34.8, 128.6]]
  },
  {
    id: "korea-strait",
    name: "Korea Strait / South Coast",
    bounds: [[33.6, 127.3], [35.9, 130.2]]
  },
  {
    id: "east-sea",
    name: "East Sea / Ulleung Approaches",
    bounds: [[36.0, 128.8], [39.6, 132.6]]
  }
];

// Finer-grained subdivisions of the AOIs above, scored for surveillance
// priority. See docs/threat-intel-expansion-design.md section 2 for the
// methodology and sourcing behind these numbers.
//
// cable_count / total_national_cables are derived from the active (status
// !== "planned") entries in the CABLES array embedded in public/index.html,
// counted by distinct cable system per landing area (see
// scripts/collect-reference-data.js for the derivation). Overlap is allowed:
// a cable that lands in two zones (e.g. EAC-C2C at both Busan and Sindu-ri)
// counts toward both zones' cable_count, since a break anywhere along its
// route is a national-impact event regardless of which zone it happened in.
//
// chokepoint_width_km / chokepoint_depth_m for the Geoje-Busan approach are
// from O'Malley (2019), "Assessing Threats to South Korea's Undersea
// Communications Cable Infrastructure," Korean Journal of International
// Studies. Other zones' figures are rough estimates from public bathymetry
// (not survey-grade) — flagged as such; refine with real bathymetric data
// when available (see design doc section 7, open question on KHOA access).
const WATCH_ZONES = [
  {
    id: "geoje-busan-chokepoint",
    name: "Geoje-Busan Approach (Korea Strait Chokepoint)",
    parentAoiId: "korea-strait",
    bounds: [[34.7, 128.5], [35.35, 129.35]],
    chokepointWidthKm: 50,
    chokepointDepthM: 90,
    cableCount: 8,
    totalNationalCables: 12,
    redundancyClass: "none",
    landingStationDistanceKm: 0,
    incidentHistoryScore: 0,
    sourceNotes: "O'Malley (2019) KJIS; cable count from public/index.html CABLES (Busan 7 systems + Geoje/TPE 1)."
  },
  {
    id: "jeju-southern-approach",
    name: "Jeju / Southern Mainland Approach",
    parentAoiId: "jeju-approaches",
    bounds: [[32.8, 126.0], [34.9, 128.0]],
    chokepointWidthKm: 150,
    chokepointDepthM: 200,
    cableCount: 3,
    totalNationalCables: 12,
    redundancyClass: "partial",
    landingStationDistanceKm: 5,
    incidentHistoryScore: 0,
    sourceNotes: "Cable count from public/index.html CABLES (Jeju-Udo, Jeju-Mainland-2, Jeju-Mainland-3). Depth/width are rough estimates, not survey-grade."
  },
  {
    id: "taean-sindu-ri-approach",
    name: "Taean / Sindu-ri Approach (West Sea)",
    parentAoiId: "west-sea",
    bounds: [[36.5, 125.8], [37.0, 126.5]],
    chokepointWidthKm: 100,
    chokepointDepthM: 50,
    cableCount: 1,
    totalNationalCables: 12,
    redundancyClass: "partial",
    landingStationDistanceKm: 3,
    incidentHistoryScore: 0,
    sourceNotes: "Cable count from public/index.html CABLES (EAC-C2C at Sindu-ri). Shallow Yellow Sea continental shelf — depth estimate, not survey-grade."
  },
  {
    id: "ulleung-east-sea-approach",
    name: "Ulleung / East Sea Approach",
    parentAoiId: "east-sea",
    bounds: [[37.2, 130.7], [37.7, 131.2]],
    chokepointWidthKm: 200,
    chokepointDepthM: 1500,
    cableCount: 1,
    totalNationalCables: 12,
    redundancyClass: "partial",
    landingStationDistanceKm: 2,
    incidentHistoryScore: 0,
    sourceNotes: "Cable count from public/index.html CABLES (Ulleung-Mainland 2). Deep East Sea basin — depth estimate, not survey-grade."
  }
];

// surveillance_value weights — initial values, tuning target (see design doc
// section 7, open question 4). Chokepoint geometry + cable density are
// weighted highest per O'Malley (2019) and industry (Windward/NATO) sources
// that consistently cite chokepoint concentration as the primary risk factor.
const VALUE_WEIGHTS = {
  chokepoint: 0.35,
  cableDensity: 0.30,
  redundancyDeficit: 0.15,
  incidentHistory: 0.10,
  landingProximity: 0.10
};

const REDUNDANCY_DEFICIT_SCORE = { none: 100, partial: 50, full: 0 };

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

// Narrower + shallower corridors are easier to anchor-drag across and
// concentrate more traffic into less searchable water — both raise risk.
function computeChokepointScore(zone) {
  const widthFactor = clamp01((200 - Number(zone.chokepointWidthKm || 0)) / 200);
  const depthFactor = clamp01((500 - Number(zone.chokepointDepthM || 0)) / 500);
  return clampScore(100 * ((widthFactor + depthFactor) / 2));
}

function computeCableDensityScore(zone) {
  const total = Number(zone.totalNationalCables) || 0;
  if (total <= 0) return 0;
  return clampScore(100 * (Number(zone.cableCount || 0) / total));
}

function computeRedundancyDeficitScore(zone) {
  return REDUNDANCY_DEFICIT_SCORE[zone.redundancyClass] ?? 50;
}

function computeLandingProximityScore(zone) {
  const distanceKm = Number(zone.landingStationDistanceKm);
  if (!Number.isFinite(distanceKm)) return 0;
  return clampScore(100 - distanceKm * 10);
}

function computeSurveillanceValue(zone) {
  if (!zone) return 0;
  const chokepoint = computeChokepointScore(zone);
  const cableDensity = computeCableDensityScore(zone);
  const redundancyDeficit = computeRedundancyDeficitScore(zone);
  const incidentHistory = clampScore(Number(zone.incidentHistoryScore) || 0);
  const landingProximity = computeLandingProximityScore(zone);

  const value =
    VALUE_WEIGHTS.chokepoint * chokepoint +
    VALUE_WEIGHTS.cableDensity * cableDensity +
    VALUE_WEIGHTS.redundancyDeficit * redundancyDeficit +
    VALUE_WEIGHTS.incidentHistory * incidentHistory +
    VALUE_WEIGHTS.landingProximity * landingProximity;

  return Math.round(clampScore(value) * 10) / 10;
}

// Same 1.0-3.0 scale as personal/cable_threat_scoring.py's ZONES.recovery_coeff,
// so the two representations stay comparable while they're merged.
function computeRecoveryCoefficient(surveillanceValue) {
  return Math.round((1.0 + 2.0 * (surveillanceValue / 100)) * 100) / 100;
}

function getAISStreamBoundingBoxes() {
  return MARITIME_WATCH_AOIS.map(area => area.bounds);
}

function pointInBounds(lat, lon, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2) return false;
  const southWest = bounds[0] || [];
  const northEast = bounds[1] || [];
  return lat >= southWest[0] && lat <= northEast[0] && lon >= southWest[1] && lon <= northEast[1];
}

function findWatchArea(lat, lon) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  return MARITIME_WATCH_AOIS.find(area => pointInBounds(lat, lon, area.bounds)) || null;
}

function listWatchAreas() {
  return MARITIME_WATCH_AOIS.map(area => ({
    id: area.id,
    name: area.name,
    bounds: area.bounds
  }));
}

// Fine-grained zones can overlap in principle; first match wins (they don't
// currently overlap given the seed bounds above).
function findWatchZone(lat, lon) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  const zone = WATCH_ZONES.find(item => pointInBounds(lat, lon, item.bounds));
  return zone ? enrichZone(zone) : null;
}

function enrichZone(zone) {
  const surveillanceValue = computeSurveillanceValue(zone);
  return Object.assign({}, zone, {
    surveillanceValue,
    recoveryCoeff: computeRecoveryCoefficient(surveillanceValue)
  });
}

function listWatchZones() {
  return WATCH_ZONES.map(enrichZone).sort((a, b) => b.surveillanceValue - a.surveillanceValue);
}

function getWatchZoneById(zoneId) {
  const zone = WATCH_ZONES.find(item => item.id === zoneId);
  return zone ? enrichZone(zone) : null;
}

function getSurveillanceValue(zoneId) {
  const zone = getWatchZoneById(zoneId);
  return zone ? zone.surveillanceValue : 0;
}

// The multiplier applied to calculateRiskScore() in cableguard-domain.js.
// No zone match (open water outside any scored corridor) => neutral 1.0.
function getAreaValueMultiplier(zoneId) {
  const zone = getWatchZoneById(zoneId);
  return zone ? zone.recoveryCoeff : 1.0;
}

module.exports = {
  MARITIME_WATCH_AOIS,
  WATCH_ZONES,
  findWatchArea,
  getAISStreamBoundingBoxes,
  listWatchAreas,
  findWatchZone,
  listWatchZones,
  getWatchZoneById,
  getSurveillanceValue,
  getAreaValueMultiplier,
  computeSurveillanceValue,
  computeRecoveryCoefficient
};
