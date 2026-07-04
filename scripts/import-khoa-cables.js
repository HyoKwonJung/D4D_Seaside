#!/usr/bin/env node
// Imports the KHOA (국립해양조사원) submarine cable Shapefile from
// data.go.kr dataset 15130167 (https://www.data.go.kr/data/15130167/fileData.do
// — free file download, no SERVICE_KEY needed, confirmed anonymous/no-login)
// to replace the low-resolution hand-drawn cable geometry currently scraped
// from public/index.html (some cables there have as few as 2-3 coordinate
// points — a straight-line approximation).
//
// The download ships as 5 files (tl_cblsub_l_lv1.shp .. lv5.shp) — these are
// S-57 electronic-navigational-chart usage bands (ENCLEV attribute), not
// duplicate/alternate copies: lower levels are coarser/wider-area, higher
// levels are the detailed harbour/approach-scale charts. This script reads
// ALL of them and merges the segments, since our zones of interest (harbour
// approaches / chokepoints) are exactly what the high-ENCLEV charts cover
// in detail, while low-ENCLEV charts give broader national coverage.
//
// IMPORTANT: coordinates in the .shp are NOT WGS84 lat/lon — they're in
// KGD2002 Unified CS (EPSG:5179, Transverse Mercator, meters). This script
// reads the sibling .prj (WKT) and reprojects every point to WGS84 via
// proj4. KGD2002 is GRS80-based and treated as equivalent to WGS84 here
// (differences are sub-meter, well inside this system's multi-nm risk
// scoring tolerances) — not survey-grade, fine for anomaly detection.
//
// Usage:
//   node scripts/import-khoa-cables.js <path-to-.shp-or-directory>
//   - a single .shp path: imports just that level (expects sibling .dbf/.prj)
//   - a directory: imports every *.shp found directly inside it
//
// First run is effectively also an inspection pass — it prints the
// attribute schema, geometry stats, and a WGS84 sanity-check range so
// transform correctness can be eyeballed before trusting the output.
//
// Output: data/khoa_cables.json — an array of
//   { id, source: "khoa", enc_level, properties: {<raw dbf attributes>}, coords: [[[lon,lat],...], ...] }
// lib/cable-reference.js merges this in (if present) as additional
// high-resolution geometry for nearest-cable-distance calculations. It does
// NOT replace the named/colored CABLES array used by the map UI — KHOA
// segments have no commercial name (OBJNAM/NOBJNM are consistently null in
// samples inspected), so they're used as a geometry-only supplement, not
// merged into named cable identities.
const fs = require("fs");
const path = require("path");
const shapefile = require("shapefile");
const proj4 = require("proj4");

const OUTPUT_PATH = path.join(__dirname, "..", "data", "khoa_cables.json");

// KHOA's cable layer legitimately includes full international cable routes
// (e.g. segments running down toward the Philippines/Taiwan) charted for
// navigational safety near Korean-administered waters — this isn't a CRS
// bug. Since this system only monitors the 4 Korean watch AOIs
// (lib/watch-areas.js MARITIME_WATCH_AOIS span roughly lat 31.5-39.6, lon
// 123.0-132.6), records with no point anywhere near that area are dropped
// here rather than carried around — they'd add zero value to
// findNearestCable() and would slow it down for every scored event. A
// record is kept in full (not clipped) if ANY point falls inside this
// bounding box, generous margin included.
const KOREA_REGION_BOUNDS = { latMin: 30, latMax: 41, lonMin: 122, lonMax: 134 };

function touchesKoreaRegion(coords) {
  return coords.some(line => line.some(([lon, lat]) =>
    lat >= KOREA_REGION_BOUNDS.latMin && lat <= KOREA_REGION_BOUNDS.latMax &&
    lon >= KOREA_REGION_BOUNDS.lonMin && lon <= KOREA_REGION_BOUNDS.lonMax
  ));
}

// Fields worth surfacing explicitly (S-57 ENC attribute codes) — kept
// alongside the full raw properties object. BURDEP (burial depth) in
// particular is a genuine risk-relevant signal this dataset adds beyond
// geometry: an unburied/shallow-buried segment is more exposed to
// anchor-drag damage than a deeply buried one.
const NOTABLE_FIELDS = ["OBJNAM", "NOBJNM", "CATCBL", "STATUS", "BURDEP", "CONDTN", "DATSTA", "DATEND", "ENC_NO", "ENCLEV"];

function toCoordsArray(geometry) {
  if (!geometry) return null;
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return null; // Point/Polygon geometries aren't expected for a cable-route layer.
}

function reprojectCoords(coords, transformPoint) {
  return coords.map(line => line.map(point => transformPoint(point)));
}

async function readOneShapefile(shpPath, idPrefix) {
  const dbfPath = shpPath.replace(/\.shp$/i, ".dbf");
  const prjPath = shpPath.replace(/\.shp$/i, ".prj");
  if (!fs.existsSync(dbfPath)) {
    console.warn(`No sibling .dbf found for ${shpPath} — attributes won't be available.`);
  }
  if (!fs.existsSync(prjPath)) {
    throw new Error(`No sibling .prj found for ${shpPath} — cannot determine source CRS, refusing to guess. Coordinates would be silently wrong.`);
  }

  const wkt = fs.readFileSync(prjPath, "utf8");
  const sourceCrs = proj4(wkt);
  const targetCrs = proj4("EPSG:4326");
  const transformPoint = point => proj4(sourceCrs, targetCrs, point);

  const source = await shapefile.open(shpPath, fs.existsSync(dbfPath) ? dbfPath : undefined);
  const records = [];
  const geometryTypeCounts = {};
  const pointCounts = [];
  const propertyKeySamples = new Set();

  let result = await source.read();
  let index = 0;
  while (!result.done) {
    const feature = result.value;
    const geometry = feature.geometry;
    const geometryType = geometry ? geometry.type : "null";
    geometryTypeCounts[geometryType] = (geometryTypeCounts[geometryType] || 0) + 1;

    const rawCoords = toCoordsArray(geometry);
    if (rawCoords) {
      const coords = reprojectCoords(rawCoords, transformPoint);
      const totalPoints = coords.reduce((sum, line) => sum + line.length, 0);
      pointCounts.push(totalPoints);
      const props = feature.properties || {};
      // OBJNAM/NOBJNM are consistently null in this dataset (no commercial
      // cable names) — findNearestCable()/enrichEvent() display `.name` in
      // evidence text, so this MUST be a real string, not undefined, or
      // evidence reads "X nm from undefined".
      const name = props.OBJNAM || props.NOBJNM || `Unnamed submarine cable (KHOA, ENC ${props.ENC_NO || "?"})`;
      records.push({
        id: `${idPrefix}-${index}`,
        name,
        source: "khoa",
        enc_level: idPrefix,
        properties: props,
        notable: NOTABLE_FIELDS.reduce((acc, key) => {
          if (props[key] !== undefined) acc[key] = props[key];
          return acc;
        }, {}),
        coords
      });
    }

    if (feature.properties) {
      Object.keys(feature.properties).forEach(key => propertyKeySamples.add(key));
    }

    index += 1;
    result = await source.read();
  }

  return { records, geometryTypeCounts, pointCounts, propertyKeySamples, totalFeatures: index };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node scripts/import-khoa-cables.js <path-to-.shp-or-directory>");
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Not found: ${inputPath}`);
    process.exit(1);
  }

  const isDirectory = fs.statSync(inputPath).isDirectory();
  const shpPaths = isDirectory
    ? fs.readdirSync(inputPath).filter(name => name.toLowerCase().endsWith(".shp")).map(name => path.join(inputPath, name))
    : [inputPath];

  if (!shpPaths.length) {
    console.error(`No .shp files found in ${inputPath}`);
    process.exit(1);
  }

  const allRecords = [];
  const allPointCounts = [];
  const allPropertyKeys = new Set();
  let allGeometryTypeCounts = {};
  let allTotalFeatures = 0;

  for (const shpPath of shpPaths.sort()) {
    const idPrefix = path.basename(shpPath, ".shp");
    console.log(`\nReading ${idPrefix}...`);
    const result = await readOneShapefile(shpPath, idPrefix);
    console.log(`  ${result.totalFeatures} feature(s), ${result.records.length} usable line(s)`);
    allRecords.push(...result.records);
    allPointCounts.push(...result.pointCounts);
    allTotalFeatures += result.totalFeatures;
    result.propertyKeySamples.forEach(key => allPropertyKeys.add(key));
    Object.entries(result.geometryTypeCounts).forEach(([type, count]) => {
      allGeometryTypeCounts[type] = (allGeometryTypeCounts[type] || 0) + count;
    });
  }

  console.log("\n=== KHOA Shapefile import summary (all levels combined) ===");
  console.log("Total features across all files:", allTotalFeatures);
  console.log("Geometry types:", allGeometryTypeCounts);
  console.log("Attribute (.dbf) fields found:", Array.from(allPropertyKeys));
  if (allPointCounts.length) {
    const avg = allPointCounts.reduce((a, b) => a + b, 0) / allPointCounts.length;
    console.log(`Line features: ${allPointCounts.length}, points per feature — min ${Math.min(...allPointCounts)}, max ${Math.max(...allPointCounts)}, avg ${avg.toFixed(1)}`);
  }

  if (allRecords.length) {
    const sampleLats = [];
    const sampleLons = [];
    allRecords.forEach(record => {
      record.coords.forEach(line => line.forEach(([lon, lat]) => {
        sampleLons.push(lon);
        sampleLats.push(lat);
      }));
    });
    console.log(`\nTransformed coordinate range — lat [${Math.min(...sampleLats).toFixed(3)}, ${Math.max(...sampleLats).toFixed(3)}], lon [${Math.min(...sampleLons).toFixed(3)}, ${Math.max(...sampleLons).toFixed(3)}]`);
    console.log("Note: this legitimately extends well beyond Korean waters (KHOA charts full international cable routes for navigational safety) — a wide range here is expected, not a sign the CRS transform is wrong. A transform bug would instead put points somewhere geographically nonsensical (ocean depths on land, etc.), not just \"far from Korea\".");
    const withBurdep = allRecords.filter(r => r.notable.BURDEP !== undefined && r.notable.BURDEP !== null);
    console.log(`Records with burial-depth (BURDEP) data: ${withBurdep.length}/${allRecords.length}`);
    const withName = allRecords.filter(r => r.notable.OBJNAM || r.notable.NOBJNM);
    console.log(`Records with a commercial/object name (OBJNAM/NOBJNM): ${withName.length}/${allRecords.length}`);
  }

  const beforeFilterCount = allRecords.length;
  const filteredRecords = allRecords.filter(record => touchesKoreaRegion(record.coords));
  console.log(`\nRegion filter (lat ${KOREA_REGION_BOUNDS.latMin}-${KOREA_REGION_BOUNDS.latMax}, lon ${KOREA_REGION_BOUNDS.lonMin}-${KOREA_REGION_BOUNDS.lonMax}): kept ${filteredRecords.length}/${beforeFilterCount} records (dropped far-international segments with no point near Korea).`);

  if (!filteredRecords.length) {
    console.warn("\nNo usable line geometry found after region filtering — nothing written.");
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(filteredRecords, null, 2));
  console.log(`\nWrote ${filteredRecords.length} cable line feature(s) to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main().catch(error => {
  console.error("Import failed:", error.message);
  process.exit(1);
});
