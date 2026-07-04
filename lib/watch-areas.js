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

function getAISStreamBoundingBoxes() {
  return MARITIME_WATCH_AOIS.map(area => area.bounds);
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

function pointInBounds(lat, lon, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2) return false;
  const southWest = bounds[0] || [];
  const northEast = bounds[1] || [];
  return lat >= southWest[0] && lat <= northEast[0] && lon >= southWest[1] && lon <= northEast[1];
}

module.exports = {
  MARITIME_WATCH_AOIS,
  findWatchArea,
  getAISStreamBoundingBoxes,
  listWatchAreas
};
