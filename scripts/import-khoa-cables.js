#!/usr/bin/env node
// Imports the KHOA (국립해양조사원) submarine cable Shapefile from
// data.go.kr dataset 15130167 (https://www.data.go.kr/data/15130167/fileData.do
// — free file download, no SERVICE_KEY needed) to replace the low-resolution
// hand-drawn cable geometry currently scraped from public/index.html
// (some cables there have as few as 2-3 coordinate points).
//
// Usage:
//   node scripts/import-khoa-cables.js <path-to-.shp>
//   (expects a sibling .dbf file with the same basename, as shapefiles
//   normally ship — unzip the downloaded .zip first)
//
// First run should be treated as an INSPECTION pass: this script prints the
// attribute schema (.dbf field names) and geometry stats before writing
// anything, because KHOA's exact attribute schema isn't known yet — the
// conversion below makes minimal assumptions (geometry only) and does not
// try to guess field names for cable identity/name/status.
//
// Output: data/khoa_cables.json — an array of
//   { id, source: "khoa", properties: {<raw dbf attributes>}, coords: [[[lon,lat],...], ...] }
// lib/cable-reference.js merges this in (if present) as additional
// high-resolution geometry for nearest-cable-distance calculations. It does
// NOT replace the named/colored CABLES array used by the map UI — merging
// KHOA records into named commercial cable identities is a follow-up step
// once we can see whether the attribute schema has a usable name/ID field.
const fs = require("fs");
const path = require("path");
const shapefile = require("shapefile");

const OUTPUT_PATH = path.join(__dirname, "..", "data", "khoa_cables.json");

function toCoordsArray(geometry) {
  if (!geometry) return null;
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return null; // Point/Polygon geometries aren't expected for a cable-route layer.
}

async function main() {
  const shpPath = process.argv[2];
  if (!shpPath) {
    console.error("Usage: node scripts/import-khoa-cables.js <path-to-.shp>");
    process.exit(1);
  }
  const dbfPath = shpPath.replace(/\.shp$/i, ".dbf");
  if (!fs.existsSync(shpPath)) {
    console.error(`Not found: ${shpPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(dbfPath)) {
    console.warn(`No sibling .dbf found at ${dbfPath} — attribute fields (cable name/status/etc, if any) won't be available, geometry-only import.`);
  }

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

    const coords = toCoordsArray(geometry);
    if (coords) {
      const totalPoints = coords.reduce((sum, line) => sum + line.length, 0);
      pointCounts.push(totalPoints);
      records.push({
        id: `khoa-${index}`,
        source: "khoa",
        properties: feature.properties || {},
        coords
      });
    }

    if (feature.properties) {
      Object.keys(feature.properties).forEach(key => propertyKeySamples.add(key));
    }

    index += 1;
    result = await source.read();
  }

  console.log("=== KHOA Shapefile inspection ===");
  console.log("Total features:", index);
  console.log("Geometry types:", geometryTypeCounts);
  console.log("Attribute (.dbf) fields found:", Array.from(propertyKeySamples));
  if (pointCounts.length) {
    const avg = pointCounts.reduce((a, b) => a + b, 0) / pointCounts.length;
    console.log(`Line features: ${pointCounts.length}, points per feature — min ${Math.min(...pointCounts)}, max ${Math.max(...pointCounts)}, avg ${avg.toFixed(1)}`);
  }
  if (records.length) {
    console.log("\nFirst record properties (for schema reference):", JSON.stringify(records[0].properties, null, 2));
    console.log("First record point count:", records[0].coords.reduce((s, l) => s + l.length, 0));
  }

  if (!records.length) {
    console.warn("\nNo usable line geometry found — nothing written. Check the geometry type distribution above.");
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(records, null, 2));
  console.log(`\nWrote ${records.length} cable line feature(s) to ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log("Next: review the attribute fields above with the person reviewing this branch, then decide how to merge these into lib/cable-reference.js's named cable identities (if at all) vs. using them as geometry-only supplements for distance calculations.");
}

main().catch(error => {
  console.error("Import failed:", error.message);
  process.exit(1);
});
