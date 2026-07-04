const fs = require("fs");
const path = require("path");

const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");
// Produced by scripts/import-khoa-cables.js from the KHOA submarine cable
// Shapefile (data.go.kr dataset 15130167, free/no-usage-restriction public
// data). Committed to the repo so the resolution improvement works out of
// the box; regenerate by running that script against a freshly downloaded
// copy if KHOA updates the source data. Optional: the app runs fine
// without this file too (falls back to the named CABLES array only), just
// with lower nearest-cable-distance resolution. See
// docs/threat-intel-expansion-design.md section 2 / the "해상도" follow-up
// for why this exists (some named cables in index.html have as few as 2-3
// points, i.e. straight-line approximations).
const KHOA_CACHE_PATH = path.join(__dirname, "..", "data", "khoa_cables.json");

let cachedCables = null;

// Named, colored, commercially-identified cables (APCN-2, TPE, etc.) used
// by the map UI. Low resolution for some entries — this is the fragile
// regex-scrape this module always had.
function loadNamedCables() {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const match = html.match(/const CABLES = (\[[\s\S]*?\]);\s*const CONTOUR = /);
  if (!match) {
    throw new Error("Unable to load cable reference data from public/index.html.");
  }
  return JSON.parse(match[1]);
}

// High-resolution, unnamed KHOA geometry (official nautical chart cable
// layer) — supplements the named cables for distance calculations only.
// KHOA segments have no commercial name (OBJNAM/NOBJNM are consistently
// null), so they're never merged into a named cable's identity, just added
// as additional entries findNearestCable() can match against.
function loadKhoaCables() {
  if (!fs.existsSync(KHOA_CACHE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(KHOA_CACHE_PATH, "utf8"));
  } catch (error) {
    console.warn("Failed to load data/khoa_cables.json, continuing without it:", error.message);
    return [];
  }
}

function loadCableReference(forceRefresh) {
  if (cachedCables && !forceRefresh) return cachedCables;
  cachedCables = loadNamedCables().concat(loadKhoaCables());
  return cachedCables;
}

module.exports = {
  loadCableReference
};
