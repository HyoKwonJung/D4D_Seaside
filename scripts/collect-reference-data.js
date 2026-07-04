#!/usr/bin/env node
// Collects/refreshes reference data backing the surveillance-value model.
//
// Offline mode (default, no setup required): re-derives cable counts per
// watch zone from the CABLES array embedded in public/index.html and prints
// the computed surveillance_value/recovery_coeff table, cross-checking it
// against the hand-seeded figures in lib/watch-areas.js.
//
// Online mode (KHOA_DATA_GO_KR_SERVICE_KEY set): not yet implemented — see
// docs/threat-intel-expansion-design.md section 2.3/7. Would fetch the KHOA
// submarine cable Shapefile (data.go.kr dataset 15130167) to replace the
// index.html regex-scrape in lib/cable-reference.js with an authoritative
// source, and refine chokepoint_width_km/chokepoint_depth_m with real
// bathymetry instead of the current rough estimates.
//
// Usage: node scripts/collect-reference-data.js [--write-db]
//   --write-db   Upsert the computed table into `watch_zones` (requires
//                DATABASE_URL). Optional — the live scoring path reads
//                lib/watch-areas.js directly, not this table.
const fs = require("fs");
const path = require("path");

const { loadCableReference } = require("../lib/cable-reference.js");
const { WATCH_ZONES, listWatchZones } = require("../lib/watch-areas.js");

function countCablesByLanding(cables) {
  const byLanding = new Map();
  cables.forEach(cable => {
    if (cable.status === "planned") return; // only count active infrastructure
    (cable.landing || []).forEach(label => {
      const key = String(label).replace(/\(.*?\)/g, "").trim();
      if (!byLanding.has(key)) byLanding.set(key, new Set());
      byLanding.get(key).add(cable.id);
    });
  });
  return byLanding;
}

function main() {
  const cables = loadCableReference(true);
  const byLanding = countCablesByLanding(cables);

  console.log("=== Active cable systems by landing area (from public/index.html) ===");
  for (const [landing, ids] of byLanding.entries()) {
    console.log(`  ${landing}: ${ids.size} system(s) [${Array.from(ids).join(", ")}]`);
  }

  console.log("\n=== Computed surveillance_value / recovery_coeff (lib/watch-areas.js) ===");
  const zones = listWatchZones();
  zones.forEach(zone => {
    console.log(
      `  ${zone.id.padEnd(28)} value=${String(zone.surveillanceValue).padStart(5)}  coeff=${zone.recoveryCoeff.toFixed(2)}  ` +
      `(cables ${zone.cableCount}/${zone.totalNationalCables}, width ${zone.chokepointWidthKm}km, depth ${zone.chokepointDepthM}m, redundancy ${zone.redundancyClass})`
    );
  });

  console.log(
    "\nNote: cable_count in lib/watch-areas.js is hand-derived from the landing labels above " +
    "(see docs/threat-intel-expansion-design.md section 2). If the counts above don't match " +
    "the WATCH_ZONES entries, update lib/watch-areas.js accordingly."
  );

  if (process.argv.includes("--write-db")) {
    writeToDatabase(zones).catch(error => {
      console.error("Failed to write watch_zones to database:", error.message);
      process.exitCode = 1;
    });
  } else {
    console.log("\n(Pass --write-db to also upsert this table into Postgres, if DATABASE_URL is set.)");
  }
}

async function writeToDatabase(zones) {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set — skipping database write.");
    return;
  }
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.DATABASE_SSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : false
  });
  try {
    for (const zone of zones) {
      await pool.query(
        `INSERT INTO watch_zones (
           id, name, parent_aoi_id, bounds, chokepoint_width_km, chokepoint_depth_m,
           cable_count, total_national_cables, redundancy_class, landing_station_distance_km,
           incident_history_score, surveillance_value, recovery_coeff, source_notes, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, parent_aoi_id = EXCLUDED.parent_aoi_id, bounds = EXCLUDED.bounds,
           chokepoint_width_km = EXCLUDED.chokepoint_width_km, chokepoint_depth_m = EXCLUDED.chokepoint_depth_m,
           cable_count = EXCLUDED.cable_count, total_national_cables = EXCLUDED.total_national_cables,
           redundancy_class = EXCLUDED.redundancy_class, landing_station_distance_km = EXCLUDED.landing_station_distance_km,
           incident_history_score = EXCLUDED.incident_history_score, surveillance_value = EXCLUDED.surveillance_value,
           recovery_coeff = EXCLUDED.recovery_coeff, source_notes = EXCLUDED.source_notes, updated_at = now()`,
        [
          zone.id, zone.name, zone.parentAoiId, JSON.stringify(zone.bounds),
          zone.chokepointWidthKm, zone.chokepointDepthM, zone.cableCount, zone.totalNationalCables,
          zone.redundancyClass, zone.landingStationDistanceKm, zone.incidentHistoryScore,
          zone.surveillanceValue, zone.recoveryCoeff, zone.sourceNotes
        ]
      );
    }
    console.log(`\nWrote ${zones.length} zone(s) to watch_zones.`);
  } finally {
    await pool.end();
  }
}

main();
