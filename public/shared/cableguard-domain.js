(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.CableGuardDomain = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const REVIEW_STATUSES = ["unverified", "reviewed", "verified", "escalated"];

  function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function roundNumber(value, places) {
    const num = toNumber(value);
    if (num === null) return null;
    const factor = 10 ** places;
    return Math.round(num * factor) / factor;
  }

  function isFinitePoint(event) {
    return Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lon));
  }

  function formatDistance(value) {
    const num = toNumber(value);
    return num === null ? "Unknown" : `${roundNumber(num, 1)} nm`;
  }

  function formatDuration(value) {
    const num = toNumber(value);
    return num === null ? "Unknown" : `${roundNumber(num, 1)} h`;
  }

  function normalizeReviewStatus(value) {
    const normalized = String(value || "unverified").trim().toLowerCase();
    return REVIEW_STATUSES.includes(normalized) ? normalized : "unverified";
  }

  function calculateRiskScore(event) {
    const base = {
      dark_sar: 35,
      ais_loitering: 20,
      ais_gap: 20,
      encounter: 25,
      dragging_like: 35,
      live_ais_review: 10
    };
    let score = base[event.event_type] || 0;
    const distance = toNumber(event.distance_to_cable_nm);
    const duration = toNumber(event.duration_h);
    const speed = toNumber(event.speed_kn);

    if (distance !== null) {
      if (distance <= 1) score += 30;
      else if (distance <= 3) score += 25;
      else if (distance <= 5) score += 15;
    }
    if (duration !== null) {
      if (duration >= 4) score += 15;
      else if (duration >= 2) score += 8;
    }
    if (speed !== null && speed > 0) {
      if (speed <= 2) score += 10;
      else if (speed <= 3) score += 6;
    }
    if (event.ais_status === "off") score += 20;
    if (event.ais_status === "intermittent") score += 12;
    if (event.sar_matched === false) score += 15;
    if (event.event_type === "dragging_like" && speed !== null && speed <= 3) score += 15;
    if (event.event_type === "encounter" && distance !== null && distance <= 5) score += 10;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function getRiskLevel(score) {
    const value = typeof score === "number" ? score : calculateRiskScore(score);
    if (value >= 70) return "Very High";
    if (value >= 50) return "High";
    if (value >= 30) return "Medium";
    return "Low";
  }

  function buildEvidence(event, score) {
    const evidence = new Set(Array.isArray(event.evidence) ? event.evidence : []);
    const distance = toNumber(event.distance_to_cable_nm);
    const duration = toNumber(event.duration_h);
    const speed = toNumber(event.speed_kn);

    if (event.event_type === "dark_sar" && event.sar_matched === false) {
      evidence.add("Unmatched SAR-like detection near cable route.");
    }
    if (distance !== null) {
      if (distance <= 1) evidence.add(`Within ${formatDistance(distance)} of nearest submarine cable.`);
      else if (distance <= 3) evidence.add(`Inside 3 nm warning zone at ${formatDistance(distance)} from nearest cable.`);
      else if (distance <= 5) evidence.add(`Inside 5 nm watch zone at ${formatDistance(distance)} from nearest cable.`);
    }
    if (duration !== null && duration >= 4) {
      evidence.add(`Observed duration is ${formatDuration(duration)}, exceeding the 4 hour review threshold.`);
    } else if (duration !== null && duration >= 2) {
      evidence.add(`Observed duration is ${formatDuration(duration)}, exceeding the 2 hour review threshold.`);
    }
    if (speed !== null && speed > 0 && speed <= 2) {
      evidence.add("Low-speed movement under 2 knots.");
    } else if (speed !== null && speed > 2 && speed <= 3) {
      evidence.add("Slow movement between 2 and 3 knots.");
    }
    if (event.ais_status === "off") evidence.add("AIS is off or unavailable for this contact.");
    if (event.ais_status === "intermittent") evidence.add("AIS intermittent/gap behavior observed.");
    if (event.event_type === "dragging_like") {
      evidence.add("Track shape is compatible with cable-risk dragging behavior.");
    }
    if (event.event_type === "encounter" && distance !== null && distance <= 5) {
      evidence.add("Encounter occurred within 5 nm of cable route.");
    }
    if (event.event_type === "live_ais_review" && event.source === "aisstream") {
      evidence.add("Live AIS review is unverified and requires confirmation before escalation.");
    }
    if (score >= 70) {
      evidence.add("Computed risk score reaches the Very High prioritization band.");
    }
    return Array.from(evidence);
  }

  function generateRecommendation(event, score, level) {
    const distance = toNumber(event.distance_to_cable_nm);
    if (level === "Very High" && event.event_type === "dark_sar" && distance !== null && distance <= 3) {
      return "Prioritize immediate confirmation. Retask UAV/SAR or coastal radar to verify the contact. Monitor likely egress corridor.";
    }
    if ((level === "High" || level === "Very High") && event.event_type === "ais_loitering") {
      return "Maintain close monitoring. Check recent AIS gaps, vessel identity, and nearby contacts. Consider patrol or UAV confirmation.";
    }
    if (event.event_type === "encounter") {
      return "Review encounter context. Check both vessels' identities, duration, and prior port history. Monitor for coordinated movement.";
    }
    if (event.event_type === "dragging_like") {
      return "Flag as cable-risk behavior. Confirm with additional sensors before escalation. Review speed, heading stability, and cable alignment.";
    }
    if (event.event_type === "ais_gap") {
      return "Review last known position, reappearance point, and cable proximity. Maintain watch over likely transit corridor.";
    }
    if (event.event_type === "live_ais_review") {
      return "Treat as unverified AIS review. Maintain watch, compare recent track history, and seek sensor confirmation before escalation.";
    }
    return "Maintain watch and seek corroborating information before escalation. This is risk prioritization, not hostile-intent confirmation.";
  }

  function inferRegion(lat, lon) {
    if (lat >= 33 && lat <= 34.4 && lon >= 126 && lon <= 128.2) return "Jeju";
    if (lat >= 34.2 && lat <= 35.6 && lon >= 128 && lon <= 129.8) return "Busan-Geoje";
    if (lat >= 35 && lat <= 37.2 && lon <= 127) return "West Sea";
    if (lat >= 36.8 && lat <= 38.2 && lon >= 129.5) return "Ulleung";
    if (lat >= 34 && lat <= 35.8 && lon >= 129) return "Korea Strait";
    return "All";
  }

  function estimateTrackDurationHours(track) {
    if (!track || track.length < 2) return null;
    const first = Date.parse(track[0].timestamp);
    const last = Date.parse(track[track.length - 1].timestamp);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;
    return (last - first) / 3600000;
  }

  function enrichEvent(input, options) {
    const event = Object.assign({}, input);
    const settings = options || {};
    if ((!event.nearest_cable || event.distance_to_cable_nm === undefined || event.distance_to_cable_nm === null)
      && typeof settings.findNearestCable === "function"
      && isFinitePoint(event)) {
      const nearest = settings.findNearestCable(event.lat, event.lon);
      if (nearest) {
        event.nearest_cable = event.nearest_cable || nearest.name;
        event.distance_to_cable_nm = event.distance_to_cable_nm ?? nearest.distance_nm;
        event.nearest_cable_id = event.nearest_cable_id || nearest.id || null;
      }
    }

    let score = calculateRiskScore(event);

    // Scale by the surveillance value of the watch zone the event occurred
    // in (1.0 = neutral, up to ~3.0 for the highest-priority chokepoints).
    // See lib/watch-areas.js getAreaValueMultiplier() / docs/threat-intel-expansion-design.md.
    const areaValueMultiplier = toNumber(settings.areaValueMultiplier) ?? 1.0;
    if (areaValueMultiplier !== 1.0) {
      event.area_value_multiplier = areaValueMultiplier;
      score = Math.round(score * areaValueMultiplier);
    }

    if (event.source === "aisstream" && event.event_type === "live_ais_review") {
      score = Math.min(score, 49);
    }
    score = Math.max(0, Math.min(100, score));

    const level = getRiskLevel(score);
    event.risk_score = score;
    event.risk_level = level;
    event.evidence = buildEvidence(event, score);
    if (areaValueMultiplier > 1.2 && event.watch_zone_name) {
      event.evidence.push(`Located in ${event.watch_zone_name}, a high-priority surveillance zone (value multiplier x${areaValueMultiplier}).`);
    }
    event.recommendation = generateRecommendation(event, score, level);
    event.review_status = normalizeReviewStatus(event.review_status);
    return event;
  }

  return {
    REVIEW_STATUSES,
    toNumber,
    roundNumber,
    calculateRiskScore,
    getRiskLevel,
    buildEvidence,
    generateRecommendation,
    inferRegion,
    estimateTrackDurationHours,
    normalizeReviewStatus,
    enrichEvent
  };
});
