const MARITIME_WATCH_AOIS = [
  {
    id: "west-sea",
    name: "West Sea / Yellow Sea",
    // Include the full Yellow Sea picture (main shipping lanes run 122-125E).
    bounds: [[30.0, 121.0], [38.9, 127.6]]
  },
  {
    id: "jeju-approaches",
    name: "Jeju / Southwest Approaches",
    // Extend farther south and west of Jeju so open-water contacts south of the island are retained.
    bounds: [[27.5, 121.5], [34.8, 129.0]]
  },
  {
    id: "korea-strait",
    name: "Korea Strait / South Coast",
    bounds: [[33.4, 127.0], [36.0, 130.4]]
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