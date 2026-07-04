const domain = require("../public/shared/cableguard-domain.js");
const { isWithinVtsCoverage } = require("./vts-reference.js");

const MAX_TRACK_WINDOW_POINTS = 30;
const LOITERING_MIN_DURATION_H = 1.5;
const LOITERING_MAX_MEAN_SPEED_KN = 2.5;
const LOITERING_MAX_SPREAD_NM = 1.2;
const ENCOUNTER_MAX_DISTANCE_NM = 0.75;
const ENCOUNTER_MAX_SPEED_KN = 3;
const ENCOUNTER_MIN_DURATION_H = 0.5;

function getCableReviewEventId(mmsi) {
  return `LIVE-CABLE-${mmsi}`;
}

function getLoiteringEventId(mmsi) {
  return `LIVE-LOITER-${mmsi}`;
}

function getEncounterEventId(mmsiA, mmsiB) {
  const ordered = [String(mmsiA), String(mmsiB)].sort();
  return `LIVE-ENCOUNTER-${ordered[0]}-${ordered[1]}`;
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

function findNearestCable(lat, lon, cables) {
  if (!Array.isArray(cables)) return null;
  let nearest = null;
  cables.forEach(cable => {
    const distance = distancePointToCableNm(lat, lon, cable);
    if (!Number.isFinite(distance)) return;
    if (!nearest || distance < nearest.distance_nm) {
      nearest = {
        id: cable.id,
        name: cable.name,
        distance_nm: distance
      };
    }
  });
  return nearest;
}

function deriveCableRiskEvent(vessel, track, cables, watchArea) {
  if (!vessel || !Array.isArray(track) || track.length < 3) return null;
  if (isVtsIdentified(vessel)) return null;
  const speed = domain.toNumber(vessel.sog);
  if (speed === null || speed > 2) return null;

  const nearest = findNearestCable(vessel.lat, vessel.lon, cables);
  if (!nearest || nearest.distance_nm > 5) return null;

  return domain.enrichEvent({
    id: getCableReviewEventId(vessel.mmsi),
    source: "aisstream",
    synthetic: false,
    scenario_id: "live_ais_review",
    event_type: "live_ais_review",
    vessel_id: vessel.mmsi,
    vessel_name: vessel.vessel_name || "Unknown",
    mmsi: vessel.mmsi,
    lat: vessel.lat,
    lon: vessel.lon,
    timestamp: vessel.timestamp,
    occurred_at: vessel.timestamp,
    duration_h: domain.estimateTrackDurationHours(track),
    speed_kn: speed,
    heading_deg: vessel.heading ?? vessel.cog,
    distance_to_cable_nm: nearest.distance_nm,
    nearest_cable_id: nearest.id,
    nearest_cable: nearest.name,
    region: domain.inferRegion(vessel.lat, vessel.lon),
    watch_area_id: watchArea ? watchArea.id : null,
    watch_area_name: watchArea ? watchArea.name : null,
    ais_status: "on",
    sar_matched: null,
    description: "Live AIS vessel is moving slowly near a cable corridor in a Korean maritime watch area. Requires confirmation.",
    evidence: [
      "Live AIS vessel is inside a cable monitoring corridor within a Korean maritime watch area.",
      "Speed over ground is at or below 2 knots.",
      watchArea ? `Observed inside ${watchArea.name}.` : "Observed inside a Korean maritime watch area.",
      "Classification is Unverified AIS Review, not hostile intent."
    ],
    scoring_version: "v1",
    review_status: "unverified",
    active: true,
    track_window_points: Math.min(track.length, MAX_TRACK_WINDOW_POINTS)
  });
}

function deriveLoiteringEvent(vessel, track, cables, watchArea) {
  if (!vessel || !Array.isArray(track) || track.length < 4) return null;
  if (isVtsIdentified(vessel)) return null;
  const durationHours = domain.estimateTrackDurationHours(track);
  if (durationHours === null || durationHours < LOITERING_MIN_DURATION_H) return null;

  const meanSpeed = averageFinite(track.map(getTrackSpeedKn));
  if (meanSpeed !== null && meanSpeed > LOITERING_MAX_MEAN_SPEED_KN) return null;

  const spreadNm = estimateTrackSpreadNm(track);
  if (spreadNm === null || spreadNm > LOITERING_MAX_SPREAD_NM) return null;

  const nearest = findNearestCable(vessel.lat, vessel.lon, cables);
  return domain.enrichEvent({
    id: getLoiteringEventId(vessel.mmsi),
    source: "aisstream",
    synthetic: false,
    scenario_id: "live_loitering_review",
    event_type: "ais_loitering",
    vessel_id: vessel.mmsi,
    vessel_name: vessel.vessel_name || "Unknown",
    mmsi: vessel.mmsi,
    lat: vessel.lat,
    lon: vessel.lon,
    timestamp: vessel.timestamp,
    occurred_at: vessel.timestamp,
    duration_h: durationHours,
    speed_kn: meanSpeed !== null ? meanSpeed : domain.toNumber(vessel.sog),
    heading_deg: vessel.heading ?? vessel.cog,
    distance_to_cable_nm: nearest ? nearest.distance_nm : null,
    nearest_cable_id: nearest ? nearest.id : null,
    nearest_cable: nearest ? nearest.name : null,
    region: domain.inferRegion(vessel.lat, vessel.lon),
    watch_area_id: watchArea ? watchArea.id : null,
    watch_area_name: watchArea ? watchArea.name : null,
    ais_status: "on",
    sar_matched: null,
    description: "Low-speed AIS loitering pattern inside a Korean maritime watch area. Review for anomaly confirmation.",
    evidence: [
      `Track spread stayed within ${roundNm(spreadNm)} nm while duration exceeded ${roundHours(durationHours)} hours.`,
      meanSpeed !== null ? `Average speed stayed near ${roundKnots(meanSpeed)} knots.` : "Low-speed holding pattern detected.",
      watchArea ? `Observed inside ${watchArea.name}.` : "Observed inside a Korean maritime watch area."
    ],
    scoring_version: "v1",
    review_status: "unverified",
    active: true,
    track_window_points: Math.min(track.length, MAX_TRACK_WINDOW_POINTS)
  });
}

function deriveEncounterEvents(vessel, liveVessels, trackHistory, cables, watchArea, vtsLocations) {
  if (!vessel || !(liveVessels instanceof Map)) return [];
  if (isVtsIdentified(vessel, vtsLocations)) return [];
  const events = [];
  liveVessels.forEach(candidate => {
    if (!candidate || candidate.mmsi === vessel.mmsi) return;
    if (isVtsIdentified(candidate, vtsLocations)) return;
    const distanceNm = haversineNm(vessel.lat, vessel.lon, candidate.lat, candidate.lon);
    if (!Number.isFinite(distanceNm) || distanceNm > ENCOUNTER_MAX_DISTANCE_NM) return;

    const ownSpeed = domain.toNumber(vessel.sog);
    const candidateSpeed = domain.toNumber(candidate.sog);
    if ((ownSpeed !== null && ownSpeed > ENCOUNTER_MAX_SPEED_KN) || (candidateSpeed !== null && candidateSpeed > ENCOUNTER_MAX_SPEED_KN)) {
      return;
    }

    const ownTrack = trackHistory.get(vessel.mmsi) || [];
    const candidateTrack = trackHistory.get(candidate.mmsi) || [];
    if (ownTrack.length < 3 || candidateTrack.length < 3) return;

    const ownDuration = domain.estimateTrackDurationHours(ownTrack);
    const candidateDuration = domain.estimateTrackDurationHours(candidateTrack);
    const durationHours = minFinite([ownDuration, candidateDuration]);
    if (durationHours === null || durationHours < ENCOUNTER_MIN_DURATION_H) return;

    const midpoint = {
      lat: (Number(vessel.lat) + Number(candidate.lat)) / 2,
      lon: (Number(vessel.lon) + Number(candidate.lon)) / 2
    };
    const nearest = findNearestCable(midpoint.lat, midpoint.lon, cables);
    const sortedPair = [vessel, candidate].sort((left, right) => String(left.mmsi).localeCompare(String(right.mmsi)));
    events.push(domain.enrichEvent({
      id: getEncounterEventId(vessel.mmsi, candidate.mmsi),
      source: "aisstream",
      synthetic: false,
      scenario_id: "live_encounter_review",
      event_type: "encounter",
      vessel_id: sortedPair[0].mmsi,
      vessel_name: sortedPair[0].vessel_name || "Unknown",
      mmsi: sortedPair[0].mmsi,
      counterparty_mmsi: sortedPair[1].mmsi,
      counterparty_vessel_name: sortedPair[1].vessel_name || "Unknown",
      lat: midpoint.lat,
      lon: midpoint.lon,
      timestamp: vessel.timestamp,
      occurred_at: vessel.timestamp,
      duration_h: durationHours,
      speed_kn: averageFinite([ownSpeed, candidateSpeed]),
      heading_deg: vessel.heading ?? vessel.cog,
      distance_to_cable_nm: nearest ? nearest.distance_nm : null,
      nearest_cable_id: nearest ? nearest.id : null,
      nearest_cable: nearest ? nearest.name : null,
      region: domain.inferRegion(midpoint.lat, midpoint.lon),
      watch_area_id: watchArea ? watchArea.id : null,
      watch_area_name: watchArea ? watchArea.name : null,
      ais_status: "on",
      sar_matched: null,
      description: "Two AIS tracks are moving slowly in close proximity. Review for possible rendezvous or STS-style behavior.",
      evidence: [
        `${sortedPair[0].vessel_name || sortedPair[0].mmsi} and ${sortedPair[1].vessel_name || sortedPair[1].mmsi} are within ${roundNm(distanceNm)} nm.`,
        `Low-speed proximity persisted for about ${roundHours(durationHours)} hours.`,
        watchArea ? `Observed inside ${watchArea.name}.` : "Observed inside a Korean maritime watch area."
      ],
      scoring_version: "v1",
      review_status: "unverified",
      active: true,
      related_mmsis: [sortedPair[0].mmsi, sortedPair[1].mmsi]
    }));
  });
  return dedupeById(events);
}

function deriveLiveEvents(options) {
  const vessel = options && options.vessel;
  const track = options && options.track;
  const cables = options && options.cables;
  const liveVessels = options && options.liveVessels;
  const trackHistory = options && options.trackHistory;
  const watchArea = options && options.watchArea;
  const vtsLocations = options && options.vtsLocations;

  if (isVtsIdentified(vessel, vtsLocations)) return [];

  const results = [];
  const cableRiskEvent = deriveCableRiskEvent(vessel, track, cables, watchArea);
  if (cableRiskEvent) results.push(cableRiskEvent);

  const loiteringEvent = deriveLoiteringEvent(vessel, track, cables, watchArea);
  if (loiteringEvent) results.push(loiteringEvent);

  return results.concat(deriveEncounterEvents(vessel, liveVessels, trackHistory, cables, watchArea, vtsLocations));
}

function degToRad(value) {
  return value * Math.PI / 180;
}

function estimateTrackSpreadNm(track) {
  if (!Array.isArray(track) || track.length < 2) return null;
  let maxDistance = 0;
  for (let i = 0; i < track.length; i += 1) {
    const left = track[i];
    for (let j = i + 1; j < track.length; j += 1) {
      const right = track[j];
      const distance = haversineNm(left.lat, left.lon, right.lat, right.lon);
      if (Number.isFinite(distance)) maxDistance = Math.max(maxDistance, distance);
    }
  }
  return maxDistance;
}

function averageFinite(values) {
  const filtered = values.filter(value => Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function getTrackSpeedKn(point) {
  if (!point) return null;
  return domain.toNumber(point.speed_kn ?? point.sog);
}

function minFinite(values) {
  const filtered = values.filter(value => Number.isFinite(value));
  if (!filtered.length) return null;
  return Math.min(...filtered);
}

function dedupeById(items) {
  const byId = new Map();
  items.forEach(item => {
    if (item && item.id) byId.set(item.id, item);
  });
  return Array.from(byId.values());
}

function isVtsIdentified(vessel, vtsLocations) {
  if (!vessel) return false;
  if (vessel.identified_by_vts === true) return true;
  return isWithinVtsCoverage(vessel.lat, vessel.lon, vtsLocations);
}

function roundNm(value) {
  const rounded = domain.roundNumber(value, 2);
  return rounded === null ? "unknown" : rounded;
}

function roundHours(value) {
  const rounded = domain.roundNumber(value, 1);
  return rounded === null ? "unknown" : rounded;
}

function roundKnots(value) {
  const rounded = domain.roundNumber(value, 1);
  return rounded === null ? "unknown" : rounded;
}

module.exports = {
  deriveLiveEvents,
  distancePointToCableNm,
  findNearestCable,
  getCableReviewEventId,
  getEncounterEventId,
  getLoiteringEventId
};
