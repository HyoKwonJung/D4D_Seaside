const fs = require("fs");
const path = require("path");

const CASE_STUDIES_PATH = path.join(__dirname, "..", "db", "seed", "attack_case_studies.json");

let cachedCaseStudies = null;

function loadCaseStudies(forceRefresh) {
  if (cachedCaseStudies && !forceRefresh) return cachedCaseStudies;
  cachedCaseStudies = JSON.parse(fs.readFileSync(CASE_STUDIES_PATH, "utf8"));
  return cachedCaseStudies;
}

// Method-level aggregates. direct_cost_usd_est is the attacker's marginal
// cost — near-zero for a vessel already underway, floored to avoid a
// divide-by-zero in cost_efficiency_score. repair_cost_usd_low/high spans
// telecom-only incidents (~$1-3M) up to the outlier cases that also damaged
// power/gas infrastructure (Newnew Polar Bear, Eagle S, up to $80M) — see
// notes per method and docs/threat-intel-expansion-design.md section 3.
//
// is_observed=false methods (deliberate_cut_tool, deep_sea_cut_uuv) have no
// real-world incidents in the case-study dataset — their cost/deniability
// figures are analyst estimates, not measured, and are flagged as such.
const METHODS = [
  {
    method_key: "anchor_drag_transit",
    name_ko: "앵커 드래깅 (운항 중 위장)",
    name_en: "Anchor Drag (disguised as transit)",
    direct_cost_usd_est: 10000,
    repair_cost_usd_low: 1000000,
    repair_cost_usd_high: 80000000,
    downtime_days_low: 10,
    downtime_days_high: 60,
    detectability_difficulty: 0.4,
    is_observed: true,
    notes: "All 7 non-control incidents in the case-study dataset used this method. Telecom-only cases cost ~$1-3M to repair; cases that also damaged power/gas infrastructure (Newnew Polar Bear, Eagle S) ran into the tens of millions. This is the method the AIS-gap/loitering/cable-proximity detectors in this system are built to catch."
  },
  {
    method_key: "anchor_drag_disabled_vessel",
    name_ko: "기동불능 선박에 의한 우발적 절단",
    name_en: "Anchor drag from a disabled/drifting vessel",
    direct_cost_usd_est: null,
    repair_cost_usd_low: null,
    repair_cost_usd_high: null,
    downtime_days_low: 150,
    downtime_days_high: 150,
    detectability_difficulty: 0.2,
    is_observed: true,
    notPremeditated: true,
    notes: "Edge case (Rubymar, 2024): not premeditated — a vessel disabled by a missile strike drifted and dragged anchor while sinking. No deniability/cost-efficiency score computed — no attacker cost model applies to an unintentional event."
  },
  {
    method_key: "deliberate_cut_tool",
    name_ko: "수중 절단장비 (특수선박/ROV)",
    name_en: "Deliberate cutting tool (specialized vessel/ROV)",
    direct_cost_usd_est: 2000000,
    repair_cost_usd_low: 1000000,
    repair_cost_usd_high: 3000000,
    downtime_days_low: 10,
    downtime_days_high: 30,
    detectability_difficulty: 0.75,
    is_observed: false,
    assumedDeniabilityScore: 0.95,
    notes: "No confirmed real-world incidents — direct_cost/repair_cost/deniability are analyst estimates, not measured data. Referenced threat: China holds patents (2009, 2020 follow-on) for a towed submarine-cable cutting device."
  },
  {
    method_key: "deep_sea_cut_uuv",
    name_ko: "심해 무인잠수정 절단 (예: Haidou-1급)",
    name_en: "Deep-sea UUV cutting (e.g. Haidou-1-class)",
    direct_cost_usd_est: 50000000,
    repair_cost_usd_low: 1000000,
    repair_cost_usd_high: 3000000,
    downtime_days_low: 10,
    downtime_days_high: 30,
    detectability_difficulty: 0.97,
    is_observed: false,
    assumedDeniabilityScore: 0.99,
    notes: "Anticipated future threat, no confirmed incidents — direct_cost/repair_cost/deniability are analyst estimates, not measured data. Has no AIS signature at all — current AIS/SAR-based detection (this system) cannot see it; would require DAS/acoustic sensing (see design doc section 8). Its low $-cost-efficiency score below reflects the huge capital cost of a state-level asset, NOT low priority — read it as 'undetectable by this system', not 'unlikely'."
  }
];

function tallyIncidents(caseStudies, methodKey) {
  const matches = caseStudies.filter(c => c.method === methodKey && !c.control_case);
  const successful = matches.filter(c => c.successful_prosecution === true);
  return {
    observed_incident_count: matches.length,
    successful_prosecution_count: successful.length,
    evidence_case_ids: matches.map(c => c.case_id)
  };
}

function computeDeniabilityScore(observedCount, successfulCount) {
  if (!observedCount) return null;
  return Math.round((1 - successfulCount / observedCount) * 1000) / 1000;
}

// A pure $-return-on-attacker-investment ratio: (average repair cost x
// deniability) / direct cost. Deliberately NOT a general threat-priority
// score — see deep_sea_cut_uuv's notes above for why a low score here does
// not mean "safe to ignore".
function computeCostEfficiencyScore(method, deniabilityScore) {
  if (!method.direct_cost_usd_est || method.repair_cost_usd_low == null || method.repair_cost_usd_high == null) {
    return null;
  }
  if (deniabilityScore === null) return null;
  const avgRepairCost = (method.repair_cost_usd_low + method.repair_cost_usd_high) / 2;
  return Math.round((avgRepairCost * deniabilityScore) / method.direct_cost_usd_est * 10) / 10;
}

function listAttackStrategies() {
  const caseStudies = loadCaseStudies();
  const enriched = METHODS.map(method => {
    const tally = tallyIncidents(caseStudies, method.method_key);
    let deniabilityScore = null;
    let deniabilityIsAssumed = false;
    if (method.notPremeditated) {
      // No attacker intent, so "deniability" isn't a meaningful concept here.
      deniabilityScore = null;
    } else if (tally.observed_incident_count > 0) {
      deniabilityScore = computeDeniabilityScore(tally.observed_incident_count, tally.successful_prosecution_count);
    } else if (typeof method.assumedDeniabilityScore === "number") {
      deniabilityScore = method.assumedDeniabilityScore;
      deniabilityIsAssumed = true;
    }
    const costEfficiencyScore = method.notPremeditated ? null : computeCostEfficiencyScore(method, deniabilityScore);
    return Object.assign({}, method, tally, {
      deniability_score: deniabilityScore,
      deniability_is_assumed: deniabilityIsAssumed,
      cost_efficiency_score: costEfficiencyScore
    });
  });
  // Observed methods ranked by cost efficiency first; unobserved (theoretical)
  // methods listed after, since their scores are analyst estimates, not
  // measured — mixing them into the same rank would overstate confidence.
  const observed = enriched.filter(m => m.is_observed).sort((a, b) => (b.cost_efficiency_score || 0) - (a.cost_efficiency_score || 0));
  const theoretical = enriched.filter(m => !m.is_observed).sort((a, b) => (b.cost_efficiency_score || 0) - (a.cost_efficiency_score || 0));
  return observed.concat(theoretical);
}

function getCaseStudies() {
  return loadCaseStudies();
}

// One-line context note surfaced in event evidence for signal patterns that
// structurally match the anchor-drag playbook (low speed + cable proximity,
// with or without an AIS gap). Returns null for event types with a
// different profile (e.g. "encounter", which is about vessel-to-vessel
// proximity, not cable interaction).
const ANCHOR_DRAG_PROFILE_EVENT_TYPES = new Set(["live_ais_review", "ais_loitering", "dragging_like", "ais_gap", "dark_sar"]);

function getContextNote(eventType) {
  if (!ANCHOR_DRAG_PROFILE_EVENT_TYPES.has(eventType)) return null;
  const strategies = listAttackStrategies();
  const topMethod = strategies.find(m => m.is_observed && m.cost_efficiency_score !== null);
  if (!topMethod) return null;
  return (
    `This behavior pattern matches ${topMethod.name_en} — the method behind every confirmed submarine cable ` +
    `sabotage incident to date (${topMethod.observed_incident_count} observed, only ${topMethod.successful_prosecution_count} successful prosecution). ` +
    `Historical outcomes favor the vessel escaping before boarding — prioritize immediate evidence capture over waiting for further confirmation.`
  );
}

module.exports = {
  loadCaseStudies,
  getCaseStudies,
  listAttackStrategies,
  getContextNote
};
