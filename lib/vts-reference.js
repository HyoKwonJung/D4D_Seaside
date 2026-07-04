const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(__dirname, "..", "korea_vts_locations.csv");
const VTS_IDENTIFIED_RADIUS_KM = 20;

let cachedLocations = null;

function loadVtsReference(forceRefresh) {
  if (cachedLocations && !forceRefresh) return cachedLocations;

  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const locations = [];
  for (let index = 1; index < lines.length; index += 1) {
    const [region, name, latRaw, lonRaw] = lines[index].split(",");
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!region || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    locations.push({
      id: `vts-${index}`,
      region: region.trim(),
      name: name.trim(),
      lat,
      lon
    });
  }

  cachedLocations = locations;
  return cachedLocations;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const earthRadiusKm = 6371;
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  const rLat1 = degToRad(lat1);
  const rLat2 = degToRad(lat2);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

function findNearestVts(lat, lon, locations) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
  const source = Array.isArray(locations) ? locations : loadVtsReference();
  let nearest = null;

  source.forEach(location => {
    const distanceKm = haversineKm(Number(lat), Number(lon), location.lat, location.lon);
    if (!Number.isFinite(distanceKm)) return;
    if (!nearest || distanceKm < nearest.distance_km) {
      nearest = Object.assign({}, location, { distance_km: distanceKm });
    }
  });

  return nearest;
}

function getVtsCoverage(lat, lon, locations) {
  const nearest = findNearestVts(lat, lon, locations);
  if (!nearest) {
    return {
      identified: false,
      nearest_vts_id: null,
      nearest_vts_name: null,
      nearest_vts_region: null,
      nearest_vts_distance_km: null
    };
  }

  return {
    identified: nearest.distance_km <= VTS_IDENTIFIED_RADIUS_KM,
    nearest_vts_id: nearest.id,
    nearest_vts_name: nearest.name,
    nearest_vts_region: nearest.region,
    nearest_vts_distance_km: nearest.distance_km
  };
}

function isWithinVtsCoverage(lat, lon, locations) {
  return getVtsCoverage(lat, lon, locations).identified;
}

function annotateVesselWithVts(vessel, locations) {
  if (!vessel || !Number.isFinite(Number(vessel.lat)) || !Number.isFinite(Number(vessel.lon))) {
    return Object.assign({}, vessel, {
      identified_by_vts: false,
      nearest_vts_id: null,
      nearest_vts_name: null,
      nearest_vts_region: null,
      nearest_vts_distance_km: null
    });
  }

  const coverage = getVtsCoverage(vessel.lat, vessel.lon, locations);
  return Object.assign({}, vessel, coverage, {
    identified_by_vts: coverage.identified
  });
}

function degToRad(value) {
  return value * Math.PI / 180;
}

module.exports = {
  VTS_IDENTIFIED_RADIUS_KM,
  loadVtsReference,
  findNearestVts,
  getVtsCoverage,
  isWithinVtsCoverage,
  annotateVesselWithVts
};
