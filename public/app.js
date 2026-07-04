(function () {
  const NM_TO_METERS = 1852;
  const domain = window.CableGuardDomain || {};
  const sourceLabels = {
    synthetic_injection: "Synthetic Demo Injection",
    aisstream: "Live AIS"
  };
  const reviewStatusLabels = {
    unverified: "Unverified",
    reviewed: "Reviewed",
    verified: "Verified",
    escalated: "Escalated"
  };
  const eventTypeLabels = {
    dark_sar: "Dark SAR",
    ais_loitering: "Loitering / Holding",
    ais_gap: "AIS Gap",
    encounter: "Encounter / Rendezvous",
    dragging_like: "Dragging-compatible",
    live_ais_review: "Cable Corridor Review"
  };
  const markerClassByType = {
    dark_sar: "dark_sar",
    ais_loitering: "ais_loitering",
    ais_gap: "ais_gap",
    encounter: "encounter",
    dragging_like: "dragging_like",
    live_ais_review: "live_ais_review"
  };
  const trackStyles = {
    normal: { color: "#94a3b8", weight: 2, opacity: 0.55 },
    loitering: { color: "#f97316", weight: 3, opacity: 0.82 },
    ais_gap: { color: "#facc15", weight: 3, opacity: 0.82, dashArray: "8,7" },
    encounter: { color: "#c084fc", weight: 3, opacity: 0.82 },
    dragging_like: { color: "#ff2d9e", weight: 3, opacity: 0.86 },
    dark_sar: { color: "#ef4444", weight: 2, opacity: 0.7, dashArray: "4,6" }
  };
  const state = {
    showCables: true,
    showContours: true,
    showLiveAIS: true,
    showSynthetic: true,
    showBuffers: true,
    demoMode: true,
    liveStatus: "Disconnected",
    liveStatusDetail: "Live AIS disabled - scenario data available",
    lastAISUpdate: null,
    watchAreas: [],
    persistenceActive: false,
    baselineRetentionDays: null,
    suspiciousRetentionDays: null,
    syntheticEvents: [],
    liveVessels: new Map(),
    liveTrackHistory: new Map(),
    liveReviewEvents: new Map(),
    eventsById: new Map(),
    eventMarkers: new Map(),
    liveMarkers: new Map(),
    selectedEventId: null,
    ws: null
  };

  const layers = {};
  const els = {};

  function initCableGuard() {
    if (typeof L === "undefined" || typeof map === "undefined") {
      console.error("CableGuard requires the existing Leaflet map to load first.");
      return;
    }

    cacheElements();
    wireCollapsibles();
    layers.syntheticEvents = L.layerGroup().addTo(map);
    layers.syntheticTracks = L.layerGroup().addTo(map);
    layers.liveAIS = L.layerGroup().addTo(map);
    layers.buffers = L.layerGroup().addTo(map);

    state.syntheticEvents = (window.SYNTHETIC_EVENTS || []).map(enrichEvent);
    state.syntheticEvents.forEach(event => state.eventsById.set(event.id, event));

    wireControls();
    applyBaseLayerVisibility();
    renderSyntheticTracks();
    refreshDashboard();
    connectLiveAIS();
    loadLatestAISSnapshot();

    window.CableGuard = {
      calculateRiskScore,
      getRiskLevel,
      getRiskColor,
      buildEvidence,
      generateRecommendation,
      distancePointToCableNm
    };
  }

  function cacheElements() {
    [
      "status-live-ais",
      "status-vessel-count",
      "status-threat-count",
      "status-last-update",
      "status-ais-message",
      "status-watch-areas",
      "status-persistence",
      "summary-total",
      "summary-very-high",
      "summary-high",
      "summary-dark",
      "summary-anomaly",
      "summary-live",
      "filter-risk",
      "filter-type",
      "filter-region",
      "filter-source",
      "toggle-cables",
      "toggle-contours",
      "toggle-live-ais",
      "toggle-synthetic",
      "toggle-buffers",
      "show-all-cables",
      "threat-table-body",
      "selected-detail",
      "export-report",
      "ai-briefing-summary",
      "ai-briefing-meta",
      "osint-summary",
      "intel-summary",
      "decision-options",
      "decision-risk-label"
    ].forEach(id => {
      els[id] = document.getElementById(id);
    });
  }


  function wireCollapsibles() {
    document.querySelectorAll("[data-collapse-target]").forEach(button => {
      const targetId = button.getAttribute("data-collapse-target");
      const target = targetId ? document.getElementById(targetId) : null;
      if (!target) return;

      const syncExpandedState = () => {
        button.setAttribute("aria-expanded", String(!target.classList.contains("is-collapsed")));
      };

      syncExpandedState();
      button.addEventListener("click", () => {
        target.classList.toggle("is-collapsed");
        syncExpandedState();
      });
    });
  }

  function wireControls() {
    bindToggle("toggle-cables", "showCables", applyBaseLayerVisibility);
    bindToggle("toggle-contours", "showContours", applyBaseLayerVisibility);
    bindToggle("toggle-live-ais", "showLiveAIS", () => {
      applyBaseLayerVisibility();
      refreshDashboard();
    });
    bindToggle("toggle-synthetic", "showSynthetic", () => {
      renderSyntheticTracks();
      refreshDashboard();
    });
    bindToggle("toggle-buffers", "showBuffers", drawSelectedBuffers);
    ["filter-risk", "filter-type", "filter-region", "filter-source"].forEach(id => {
      if (!els[id]) return;
      els[id].addEventListener("change", refreshDashboard);
    });

    if (els["export-report"]) {
      els["export-report"].addEventListener("click", exportThreatReport);
    }
    if (els["show-all-cables"]) {
      els["show-all-cables"].addEventListener("click", showAllCables);
    }
  }

  function bindToggle(id, stateKey, onChange) {
    const el = els[id];
    if (!el) return;
    el.checked = Boolean(state[stateKey]);
    el.addEventListener("change", () => {
      state[stateKey] = el.checked;
      onChange();
      updateStatusPanel();
    });
  }

  function applyBaseLayerVisibility() {
    if (typeof cableLayers !== "undefined") {
      Object.values(cableLayers).forEach(entry => {
        if (!entry || !entry.layer) return;
        if (state.showCables) {
          entry.layer.addTo(map);
        } else {
          map.removeLayer(entry.layer);
        }
      });
    }

    if (typeof contourLayer !== "undefined") {
      if (state.showContours) {
        contourLayer.addTo(map);
      } else {
        map.removeLayer(contourLayer);
      }
    }

    if (typeof labelLayer !== "undefined") {
      if (state.showContours) {
        labelLayer.addTo(map);
        if (typeof updateLabels === "function") updateLabels();
      } else {
        labelLayer.clearLayers();
        map.removeLayer(labelLayer);
      }
    }

    if (layers.liveAIS) {
      if (state.showLiveAIS) layers.liveAIS.addTo(map);
      else map.removeLayer(layers.liveAIS);
    }
  }

  function syncToggleStates() {
    const mapping = {
      "toggle-cables": "showCables",
      "toggle-contours": "showContours",
      "toggle-live-ais": "showLiveAIS",
      "toggle-synthetic": "showSynthetic",
      "toggle-buffers": "showBuffers"
    };
    Object.entries(mapping).forEach(([id, key]) => {
      if (els[id]) els[id].checked = Boolean(state[key]);
    });
  }

  function showAllCables() {
    state.showCables = true;
    syncToggleStates();
    if (typeof cableLayers !== "undefined") {
      Object.values(cableLayers).forEach(entry => {
        if (entry && entry.layer) entry.layer.addTo(map);
      });
    }
  }

  function calculateRiskScore(event) {
    return typeof domain.calculateRiskScore === "function" ? domain.calculateRiskScore(event) : 0;
  }

  function getRiskLevel(score) {
    return typeof domain.getRiskLevel === "function" ? domain.getRiskLevel(score) : "Low";
  }

  function shortRiskLevel(level) {
    return {
      "Very High": "VH",
      High: "H",
      Medium: "M",
      Low: "L"
    }[level] || level;
  }

  function getRiskColor(scoreOrLevel) {
    const level = typeof scoreOrLevel === "string" ? scoreOrLevel : getRiskLevel(scoreOrLevel);
    if (level === "Very High") return "#dc2626";
    if (level === "High") return "#f97316";
    if (level === "Medium") return "#facc15";
    return "#38bdf8";
  }

  function buildEvidence(event, score) {
    return typeof domain.buildEvidence === "function" ? domain.buildEvidence(event, score) : [];
  }

  function generateRecommendation(event, score, level) {
    return typeof domain.generateRecommendation === "function"
      ? domain.generateRecommendation(event, score, level)
      : "Maintain watch and seek corroborating information before escalation.";
  }

  function enrichEvent(input) {
    if (typeof domain.enrichEvent !== "function") return Object.assign({}, input);
    return domain.enrichEvent(input, { findNearestCable });
  }

  function refreshDashboard() {
    const visibleEvents = getFilteredEvents();
    renderEventMarkers(visibleEvents);
    renderThreatTable(visibleEvents);
    renderSummary(visibleEvents);
    updateStatusPanel();

    if (!visibleEvents.length) {
      state.selectedEventId = null;
      renderSelectedDetail(null);
      renderCommandSurfaces([], null);
      drawSelectedBuffers();
      return;
    }

    if (!state.selectedEventId || !visibleEvents.some(event => event.id === state.selectedEventId)) {
      state.selectedEventId = visibleEvents[0].id;
    }

    const selectedEvent = state.eventsById.get(state.selectedEventId);
    renderSelectedDetail(selectedEvent);
    renderCommandSurfaces(visibleEvents, selectedEvent);
    highlightSelectedRow();
    drawSelectedBuffers();
  }

  function getAllCandidateEvents() {
    const events = [];
    if (state.demoMode && state.showSynthetic) {
      events.push(...state.syntheticEvents);
    }
    if (state.showLiveAIS) {
      events.push(...Array.from(state.liveReviewEvents.values()));
    }
    events.forEach(event => state.eventsById.set(event.id, event));
    return events;
  }

  function getFilteredEvents() {
    const riskFilter = getSelectValue("filter-risk", "all");
    const typeFilter = getSelectValue("filter-type", "all");
    const regionFilter = getSelectValue("filter-region", "all");
    const sourceFilter = getSelectValue("filter-source", "all");

    return getAllCandidateEvents()
      .filter(event => {
        if (!passesRiskFilter(event, riskFilter)) return false;
        if (typeFilter !== "all" && event.event_type !== typeFilter) return false;
        if (regionFilter !== "all" && event.region !== regionFilter) return false;
        if (sourceFilter === "live" && event.source !== "aisstream") return false;
        if (sourceFilter === "synthetic" && event.source !== "synthetic_injection") return false;
        return true;
      })
      .sort((a, b) => b.risk_score - a.risk_score || String(a.id).localeCompare(String(b.id)));
  }

  function passesRiskFilter(event, riskFilter) {
    if (riskFilter === "medium") return event.risk_score >= 30;
    if (riskFilter === "high") return event.risk_score >= 50;
    if (riskFilter === "very_high") return event.risk_score >= 70;
    return true;
  }

  function renderSyntheticTracks() {
    if (!layers.syntheticTracks) return;
    layers.syntheticTracks.clearLayers();
    if (!state.demoMode || !state.showSynthetic) return;

    (window.SYNTHETIC_TRACKS || []).forEach(track => {
      const latLngs = (track.coordinates || []).map(point => [point[1], point[0]]);
      if (latLngs.length < 2) return;
      const style = Object.assign({}, trackStyles[track.track_type] || trackStyles.normal);
      const polyline = L.polyline(latLngs, style)
        .bindPopup(`<div class="cg-popup"><div class="pt">${escapeHtml(track.vessel_name)}</div><div class="pr"><span class="pl">Track:</span>${escapeHtml(track.track_type)}</div><div class="pr"><span class="pl">Source:</span>Synthetic Demo Injection</div></div>`);
      polyline.addTo(layers.syntheticTracks);

      const start = latLngs[0];
      const end = latLngs[latLngs.length - 1];
      const trackPopup = endpoint => `<div class="cg-popup"><div class="pt">${escapeHtml(track.vessel_name)}</div><div class="pr"><span class="pl">Track point:</span>${endpoint}</div><div class="pr"><span class="pl">Track:</span>${escapeHtml(track.track_type)}</div><div class="pr"><span class="pl">Source:</span>Synthetic Demo Injection</div></div>`;
      L.circleMarker(start, {
        radius: 5,
        color: style.color,
        weight: 1,
        fillColor: "#020814",
        fillOpacity: 0.9
      }).bindTooltip("Track start", { direction: "top" }).bindPopup(trackPopup("Start"), { maxWidth: 240 }).addTo(layers.syntheticTracks);
      L.circleMarker(end, {
        radius: 5,
        color: style.color,
        weight: 1,
        fillColor: style.color,
        fillOpacity: 0.9
      }).bindTooltip("Track end", { direction: "top" }).bindPopup(trackPopup("End"), { maxWidth: 240 }).addTo(layers.syntheticTracks);
    });

    state.syntheticEvents
      .filter(event => event.event_type === "dark_sar")
      .forEach(event => {
        L.circle([event.lat, event.lon], {
          radius: NM_TO_METERS * 1.5,
          color: "#ef4444",
          weight: 1,
          opacity: 0.4,
          fillColor: "#ef4444",
          fillOpacity: 0.07,
          dashArray: "5,8",
          interactive: false
        }).addTo(layers.syntheticTracks);
      });
  }

  function renderEventMarkers(events) {
    layers.syntheticEvents.clearLayers();
    state.eventMarkers.clear();

    events.forEach(event => {
      if (!isFinitePoint(event)) return;
      const marker = L.marker([event.lat, event.lon], {
        icon: L.divIcon({
          className: `threat-marker ${markerClassByType[event.event_type] || "live_ais_review"}`,
          html: "",
          iconSize: [20, 20],
          iconAnchor: [10, 10],
          popupAnchor: [0, -10]
        }),
        keyboard: true,
        title: `${event.risk_level} ${eventTypeLabels[event.event_type] || event.event_type}`
      });
      marker.bindPopup(buildEventPopup(event), { maxWidth: 290 });
      marker.on("click", () => selectEvent(event.id, { zoom: false, openPopup: false }));
      marker.addTo(layers.syntheticEvents);
      state.eventMarkers.set(event.id, marker);
    });
  }

  function buildEventPopup(event) {
    const source = event.source === "synthetic_injection" ? "Synthetic Demo Injection" : "AISStream";
    const purpose = event.source === "synthetic_injection" ? "<div class=\"pr\"><span class=\"pl\">Purpose:</span>Controlled detection scenario</div>" : "";
    const counterparty = event.counterparty_mmsi
      ? `<div class="pr"><span class="pl">Counterparty:</span>${escapeHtml(event.counterparty_vessel_name || event.counterparty_mmsi)}</div>`
      : "";
    return `<div class="cg-popup">
      <div class="pt">${escapeHtml(event.vessel_name || "Unknown")}</div>
      <span class="cg-popup-risk" style="background:${getRiskColor(event.risk_level)}">${event.risk_score} / ${escapeHtml(event.risk_level)}</span>
      <div class="pr"><span class="pl">Type:</span>${escapeHtml(eventTypeLabels[event.event_type] || event.event_type)}</div>
      <div class="pr"><span class="pl">Source:</span>${source}</div>
      ${purpose}
      <div class="pr"><span class="pl">Context:</span>${escapeHtml(getEventContextLabel(event))}</div>
      <div class="pr"><span class="pl">Distance:</span>${formatDistance(event.distance_to_cable_nm)}</div>
      ${counterparty}
      <div class="pr"><span class="pl">Status:</span>${escapeHtml(event.source === "aisstream" ? formatReviewStatus(event.review_status) : "Requires confirmation")}</div>
    </div>`;
  }


  function renderCommandSurfaces(events, selectedEvent) {
    const event = selectedEvent || events[0] || null;
    if (!event) {
      setText("ai-briefing-summary", "No visible threat candidates. Maintain maritime watch and adjust filters if needed.");
      setText("ai-briefing-meta", "No active selection");
      setHtml("osint-summary", "Waiting for selected threat context.");
      setHtml("intel-summary", "Evidence and command notes will appear with the selected event.");
      setText("decision-risk-label", "No active recommendation");
      setHtml("decision-options", buildDecisionOptions(null));
      return;
    }

    const typeLabel = eventTypeLabels[event.event_type] || event.event_type || "Unknown event";
    const sourceLabel = sourceLabels[event.source] || event.source || "Unknown source";
    const context = getEventContextLabel(event);
    const watchArea = event.watch_area_name || event.region || "Unknown area";
    const veryHighCount = events.filter(item => item.risk_level === "Very High").length;
    const highCount = events.filter(item => item.risk_level === "High").length;
    const briefing = `${watchArea}: ${event.risk_level} ${typeLabel} on ${event.vessel_name || "Unknown vessel"}. ${formatDistance(event.distance_to_cable_nm)} from ${context}. ${sourceLabel} requires commander review before escalation.`;

    setText("ai-briefing-summary", briefing);
    setText("ai-briefing-meta", `${events.length} visible | ${veryHighCount} very high | ${highCount} high`);
    setText("decision-risk-label", `${event.risk_level} / ${event.risk_score}`);

    setHtml("osint-summary", `
      ${commandKv("Entity", event.vessel_name || "Unknown")}
      ${commandKv("MMSI", event.mmsi || "Unknown")}
      ${commandKv("Source", sourceLabel)}
      ${commandKv("Context", context)}
      ${commandKv("Review", formatReviewStatus(event.review_status))}
      ${commandKv("OSINT Note", event.source === "synthetic_injection" ? "Scenario fixture; corroborate with external intelligence before action." : "Live AIS-derived anomaly; confirm with review workflow and external sources.")}
    `);

    const evidenceItems = (event.evidence || []).slice(0, 5).map(item => `<li>${escapeHtml(item)}</li>`).join("") || "<li>No evidence statements loaded.</li>";
    setHtml("intel-summary", `
      ${commandKv("Priority", `${event.risk_level} (${event.risk_score})`)}
      ${commandKv("Distance", formatDistance(event.distance_to_cable_nm))}
      ${commandKv("Speed", formatSpeed(event.speed_kn))}
      ${commandKv("Duration", formatDuration(event.duration_h))}
      <div class="cg-title" style="margin-top:12px">Evidence</div>
      <ul class="cg-list">${evidenceItems}</ul>
      <div class="cg-recommendation">${escapeHtml(event.recommendation || generateRecommendation(event, event.risk_score, event.risk_level))}</div>
    `);

    setHtml("decision-options", buildDecisionOptions(event));
  }

  function commandKv(label, value) {
    return `<div class="cg-intel-kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
  }

  function buildDecisionOptions(event) {
    if (!event) {
      return [
        ["A", "탐지 및 추적", "위협 후보를 선택하면 추적 우선순위가 표시됩니다."],
        ["B", "경고방송", "위협 후보를 선택하면 경고 기준이 표시됩니다."],
        ["C", "경비함 이동", "위협 후보를 선택하면 투입 판단점이 표시됩니다."],
        ["D", "항공기 이동", "위협 후보를 선택하면 감시 방향이 표시됩니다."]
      ].map(renderDecisionOption).join("");
    }

    const context = getEventContextLabel(event);
    const region = event.watch_area_name || event.region || "해당 구역";
    const distance = formatDistance(event.distance_to_cable_nm);
    const isVeryHigh = event.risk_level === "Very High" || event.risk_score >= 70;
    const isHigh = event.risk_level === "High" || event.risk_score >= 50;
    const closeToCable = toNumber(event.distance_to_cable_nm) !== null && toNumber(event.distance_to_cable_nm) <= 3;
    const warningBasis = closeToCable ? `${distance} 접근. 항행 경고 및 케이블 보호구역 주의.` : "행동 지속 시 항행 경고 기준 검토.";
    const patrolBasis = isVeryHigh ? `${context} 우선 출동 후보. 현장 확인 필요.` : isHigh ? `${region} 인근 경비세력 대기 또는 전개 검토.` : "추적 유지 후 추가 징후 발생 시 전개.";
    const airBasis = isVeryHigh || closeToCable ? `${region} 상공 감시로 접촉 식별 보강.` : "필요 시 광역 감시 자산으로 패턴 확인.";

    return [
      ["A", "탐지 및 추적", `${event.vessel_name || "Unknown"} ${event.risk_level} 후보를 지속 추적.`],
      ["B", "경고방송", warningBasis],
      ["C", "경비함 이동", patrolBasis],
      ["D", "항공기 이동", airBasis]
    ].map(renderDecisionOption).join("");
  }

  function renderDecisionOption(option) {
    const label = option[0];
    const title = option[1];
    const body = option[2];
    return `<article class="cg-option"><div class="cg-option-head"><span>${escapeHtml(label)}</span><strong>${escapeHtml(title)}</strong></div><p>${escapeHtml(body)}</p></article>`;
  }

  function renderThreatTable(events) {
    const tbody = els["threat-table-body"];
    if (!tbody) return;
    if (!events.length) {
      tbody.innerHTML = "<tr><td colspan=\"7\">No visible events match current filters.</td></tr>";
      return;
    }

    tbody.innerHTML = events.map(event => `
      <tr data-event-id="${escapeAttr(event.id)}">
        <td><span class="cg-risk-badge" style="background:${getRiskColor(event.risk_level)}">${event.risk_score}</span></td>
        <td title="${escapeAttr(event.risk_level)}">${escapeHtml(shortRiskLevel(event.risk_level))}</td>
        <td title="${escapeAttr(eventTypeLabels[event.event_type] || event.event_type)}">${escapeHtml(eventTypeLabels[event.event_type] || event.event_type)}</td>
        <td title="${escapeAttr(event.vessel_name || "Unknown")}">${escapeHtml(event.vessel_name || "Unknown")}</td>
        <td title="${escapeAttr(getEventContextLabel(event))}">${escapeHtml(getEventContextLabel(event))}</td>
        <td>${formatDistance(event.distance_to_cable_nm)}</td>
        <td title="${escapeAttr(sourceLabels[event.source] || event.source || "Unknown")}">${escapeHtml(sourceLabels[event.source] || event.source || "Unknown")}</td>
      </tr>
    `).join("");

    tbody.querySelectorAll("tr[data-event-id]").forEach(row => {
      row.addEventListener("click", () => selectEvent(row.dataset.eventId, { zoom: true, openPopup: true }));
    });
    highlightSelectedRow();
  }

  function selectEvent(eventId, options) {
    const event = state.eventsById.get(eventId);
    if (!event) return;
    state.selectedEventId = eventId;
    renderSelectedDetail(event);
    renderCommandSurfaces(getFilteredEvents(), event);
    highlightSelectedRow();
    drawSelectedBuffers();

    const marker = state.eventMarkers.get(eventId);
    if (marker) {
      if (options && options.zoom) {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 10), { animate: true });
      }
      if (options && options.openPopup) marker.openPopup();
    } else if (options && options.zoom && isFinitePoint(event)) {
      map.setView([event.lat, event.lon], Math.max(map.getZoom(), 10), { animate: true });
    }
  }

  function highlightSelectedRow() {
    const tbody = els["threat-table-body"];
    if (!tbody) return;
    tbody.querySelectorAll("tr").forEach(row => {
      row.classList.toggle("selected", row.dataset.eventId === state.selectedEventId);
    });
  }

  function renderSelectedDetail(event) {
    const detail = els["selected-detail"];
    if (!detail) return;
    if (!event) {
      detail.innerHTML = "<div class=\"cg-detail-name\">No event selected</div><div class=\"cg-source-note\">Adjust filters or enable demo mode to view prioritization details.</div>";
      return;
    }

    const sourceBlock = event.source === "synthetic_injection"
      ? "<div class=\"cg-source-note\">Source: Synthetic Demo Injection<br>Purpose: Controlled detection scenario</div>"
      : `<div class="cg-source-note">Source: AISStream<br>Status: ${escapeHtml(formatReviewStatus(event.review_status))} AIS anomaly requiring confirmation workflow.</div>`;
    const evidence = (event.evidence || []).map(item => `<li>${escapeHtml(item)}</li>`).join("");
    const counterpartyBlock = event.counterparty_mmsi
      ? detailKv("Counterparty", `${event.counterparty_vessel_name || "Unknown"} (${event.counterparty_mmsi})`)
      : "";
    detail.innerHTML = `
      <div class="cg-detail-head">
        <div>
          <div class="cg-detail-name">${escapeHtml(event.vessel_name || "Unknown")}</div>
          <div class="cg-detail-type">${escapeHtml(eventTypeLabels[event.event_type] || event.event_type)}</div>
        </div>
        <span class="cg-risk-badge" style="background:${getRiskColor(event.risk_level)}">${event.risk_score}</span>
      </div>
      <div class="cg-detail-grid">
        ${detailKv("Risk Level", event.risk_level)}
        ${detailKv("Source", sourceLabels[event.source] || event.source || "Unknown")}
        ${detailKv("Watch Area", event.watch_area_name || event.region || "Unknown")}
        ${detailKv("Review Status", formatReviewStatus(event.review_status))}
        ${detailKv("MMSI", event.mmsi || "Unknown")}
        ${detailKv("AIS Status", event.ais_status || "Unknown")}
        ${detailKv("Context", getEventContextLabel(event))}
        ${detailKv("Distance", formatDistance(event.distance_to_cable_nm))}
        ${detailKv("Duration", formatDuration(event.duration_h))}
        ${detailKv("Speed", formatSpeed(event.speed_kn))}
        ${detailKv("Heading", formatHeading(event.heading_deg))}
        ${detailKv("Region", event.region || "Unknown")}
        ${counterpartyBlock}
      </div>
      <div class="cg-title">Commander Recommendation</div>
      <div class="cg-recommendation">${escapeHtml(event.recommendation)}</div>
      <div class="cg-title" style="margin-top:12px">Evidence</div>
      <ul class="cg-list">${evidence}</ul>
      ${renderReviewWorkflow(event)}
      ${sourceBlock}
    `;
    bindReviewControls(event);
  }

  function detailKv(label, value) {
    return `<div class="cg-kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
  }

  function renderReviewWorkflow(event) {
    if (event.source !== "aisstream") {
      return `
        <div class="cg-title" style="margin-top:12px">Review Workflow</div>
        <div class="cg-source-note">Synthetic demo events remain scenario fixtures and are not written to the persistent audit log.</div>
      `;
    }

    const reviewerName = event.review_updated_by || "Operator";
    const reviewStamp = event.review_updated_at
      ? `Last saved by ${escapeHtml(reviewerName)} at ${escapeHtml(formatTime(event.review_updated_at))}.`
      : "No persistent review saved yet.";

    return `
      <div class="cg-title" style="margin-top:12px">Review Workflow</div>
      <div class="cg-review-panel">
        <div class="cg-review-meta">
          <span class="cg-pill ${getReviewPillClass(event.review_status)}">${escapeHtml(formatReviewStatus(event.review_status))}</span>
          <span class="cg-review-stamp">${reviewStamp}</span>
        </div>
        <div class="cg-review-grid">
          <div class="cg-field">
            <label for="review-status">Review status</label>
            <select id="review-status">${buildReviewStatusOptions(event.review_status)}</select>
          </div>
          <div class="cg-field">
            <label for="reviewer-name">Reviewer</label>
            <input id="reviewer-name" type="text" value="${escapeAttr(reviewerName)}" maxlength="80">
          </div>
        </div>
        <div class="cg-field">
          <label for="review-notes">Operator notes</label>
          <textarea id="review-notes" rows="4" maxlength="3000">${escapeHtml(event.review_notes || "")}</textarea>
        </div>
        <button class="cg-secondary-action" id="save-review" type="button">Save Review</button>
        <div class="cg-source-note" id="review-save-status">Saved reviews are appended to the audit history in Postgres.</div>
      </div>
    `;
  }

  function buildReviewStatusOptions(currentStatus) {
    return ["unverified", "reviewed", "verified", "escalated"].map(status => `
      <option value="${status}"${status === normalizeReviewStatus(currentStatus) ? " selected" : ""}>
        ${escapeHtml(formatReviewStatus(status))}
      </option>
    `).join("");
  }

  function bindReviewControls(event) {
    if (!event || event.source !== "aisstream") return;
    const saveButton = document.getElementById("save-review");
    const statusField = document.getElementById("review-status");
    const reviewerField = document.getElementById("reviewer-name");
    const notesField = document.getElementById("review-notes");
    const statusMessage = document.getElementById("review-save-status");
    if (!saveButton || !statusField || !reviewerField || !notesField) return;

    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      if (statusMessage) statusMessage.textContent = "Saving review...";
      try {
        const response = await fetch(`/api/events/${encodeURIComponent(event.id)}/review`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            review_status: statusField.value,
            reviewer_name: reviewerField.value,
            notes: notesField.value
          })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Unable to save review.");
        }
        upsertLiveReviewEvent(data.event, { skipRefresh: true });
        state.selectedEventId = data.event.id;
        renderSelectedDetail(data.event);
      } catch (error) {
        if (statusMessage) statusMessage.textContent = error.message || "Unable to save review.";
      } finally {
        saveButton.disabled = false;
      }
    });
  }

  function formatReviewStatus(value) {
    return reviewStatusLabels[normalizeReviewStatus(value)] || "Unverified";
  }

  function getReviewPillClass(value) {
    const status = normalizeReviewStatus(value);
    if (status === "verified" || status === "reviewed") return "good";
    if (status === "escalated") return "bad";
    return "warn";
  }

  function normalizeReviewStatus(value) {
    return typeof domain.normalizeReviewStatus === "function"
      ? domain.normalizeReviewStatus(value)
      : "unverified";
  }

  function drawSelectedBuffers() {
    if (!layers.buffers) return;
    layers.buffers.clearLayers();
    const event = state.selectedEventId ? state.eventsById.get(state.selectedEventId) : null;
    if (!event || !state.showBuffers || !isFinitePoint(event)) return;
    const distanceToCable = toNumber(event.distance_to_cable_nm);
    if (distanceToCable === null || distanceToCable > 5) return;
    [
      { nm: 1, label: "1 nm cable danger zone", color: "#ef4444" },
      { nm: 3, label: "3 nm cable warning zone", color: "#f97316" },
      { nm: 5, label: "5 nm cable watch zone", color: "#38bdf8" }
    ].forEach(zone => {
      L.circle([event.lat, event.lon], {
        radius: zone.nm * NM_TO_METERS,
        color: zone.color,
        weight: 1,
        opacity: 0.62,
        fillColor: zone.color,
        fillOpacity: 0.025,
        interactive: false,
        className: `risk-buffer-zone risk-buffer-${zone.nm}`
      }).bindTooltip(zone.label, { sticky: true }).addTo(layers.buffers);
    });
  }

  function renderSummary(events) {
    setText("summary-total", events.length);
    setText("summary-very-high", events.filter(event => event.risk_level === "Very High").length);
    setText("summary-high", events.filter(event => event.risk_level === "High").length);
    setText("summary-dark", events.filter(event => event.event_type === "dark_sar" || event.ais_status === "off").length);
    setText("summary-anomaly", events.filter(event => ["ais_loitering", "ais_gap", "encounter", "dragging_like", "live_ais_review"].includes(event.event_type)).length);
    setText("summary-live", state.liveVessels.size);
  }

  function updateStatusPanel() {
    const liveClass = state.liveStatus === "Connected" ? "good" : state.liveStatus === "Disabled" ? "warn" : "bad";
    setHtml("status-live-ais", `<span class="cg-pill ${liveClass}">${escapeHtml(state.liveStatus)}</span>`);
    setText("status-vessel-count", state.liveVessels.size);
    setText("status-threat-count", getCandidateEventCount());
    setText("status-last-update", state.lastAISUpdate ? formatTime(state.lastAISUpdate) : "No live update");
    setText("status-ais-message", state.liveStatusDetail || "Live AIS disabled - scenario data available");
    setText("status-watch-areas", formatWatchAreas(state.watchAreas));
    setText("status-persistence", state.persistenceActive
      ? `ON (${state.baselineRetentionDays || "?"}d / ${state.suspiciousRetentionDays || "?"}d)`
      : "OFF");
  }

  async function loadLatestAISSnapshot() {
    if (!location.protocol.startsWith("http")) return;
    try {
      const response = await fetch("/api/ais/latest", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      replaceLiveReviewEvents(data.events || []);
      (data.vessels || []).forEach(vessel => ingestLiveVessel(vessel, { skipRefresh: true }));
      refreshDashboard();
      updateStatusFromHealth(data);
    } catch (error) {
      state.liveStatus = "Disconnected";
      state.liveStatusDetail = "Live AIS unavailable - scenario data available";
      updateStatusPanel();
    }
  }

  function connectLiveAIS() {
    if (!location.protocol.startsWith("http")) {
      state.liveStatus = "Disabled";
      state.liveStatusDetail = "Live AIS disabled - run through npm start for backend proxy";
      updateStatusPanel();
      return;
    }
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${location.host}/ws`;

    try {
      state.ws = new WebSocket(wsUrl);
    } catch (error) {
      state.liveStatus = "Disconnected";
      state.liveStatusDetail = "Live AIS unavailable - scenario data available";
      updateStatusPanel();
      return;
    }

    state.ws.addEventListener("open", () => {
      state.liveStatus = "Disconnected";
      state.liveStatusDetail = "Local AIS proxy connected; waiting for AISStream status.";
      updateStatusPanel();
    });

    state.ws.addEventListener("message", event => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (data.type === "status") {
        updateStatusFromHealth(data);
      }
      if (data.type === "ais" && data.vessel) {
        ingestLiveVessel(data.vessel);
      }
      if (data.type === "event" && data.event) {
        upsertLiveReviewEvent(data.event);
      }
      if (data.type === "event_deleted" && data.event_id) {
        removeLiveReviewEvent(data.event_id);
      }
      if (data.type === "snapshot" && Array.isArray(data.events)) {
        replaceLiveReviewEvents(data.events);
      } else if (Array.isArray(data.events)) {
        data.events.forEach(eventItem => upsertLiveReviewEvent(eventItem, { skipRefresh: true }));
      }
      if (Array.isArray(data.vessels)) {
        data.vessels.forEach(vessel => ingestLiveVessel(vessel, { skipRefresh: true }));
        refreshDashboard();
      }
    });

    state.ws.addEventListener("close", () => {
      if (state.liveStatus !== "Disabled") {
        state.liveStatus = "Disconnected";
        state.liveStatusDetail = "Live AIS disconnected - scenario data available";
        updateStatusPanel();
      }
      setTimeout(connectLiveAIS, 5000);
    });

    state.ws.addEventListener("error", () => {
      if (state.liveStatus !== "Disabled") {
        state.liveStatus = "Disconnected";
        state.liveStatusDetail = "Live AIS connection error - scenario data available";
        updateStatusPanel();
      }
    });
  }

  function updateStatusFromHealth(data) {
    state.watchAreas = Array.isArray(data.watch_areas) ? data.watch_areas : state.watchAreas;
    state.persistenceActive = Boolean(data.persistence_active);
    state.baselineRetentionDays = data.baseline_retention_days ?? state.baselineRetentionDays;
    state.suspiciousRetentionDays = data.suspicious_retention_days ?? state.suspiciousRetentionDays;
    if (data.aisstream_status === "disabled") {
      state.liveStatus = "Disabled";
      state.liveStatusDetail = "Live AIS disabled - scenario data available";
    } else if (data.aisstream_status === "rate_limited") {
      state.liveStatus = "Rate Limited";
      state.liveStatusDetail = "Live AIS provider rate-limited requests. Automatic reconnect is backing off.";
    } else if (data.aisstream_connected === true || data.aisstream_status === "connected") {
      state.liveStatus = "Connected";
      state.liveStatusDetail = `Live AIS connected across ${data.watch_area_count || state.watchAreas.length || 0} Korean maritime watch areas.`;
    } else {
      state.liveStatus = "Disconnected";
      state.liveStatusDetail = "Live AIS disconnected - scenario data remains available.";
    }
    if (typeof data.live_vessel_count === "number" && data.live_vessel_count > state.liveVessels.size) {
      setText("status-vessel-count", data.live_vessel_count);
    }
    updateStatusPanel();
  }

  function ingestLiveVessel(vessel, options) {
    const normalized = normalizeFrontendVessel(vessel);
    if (!normalized) return;
    state.liveVessels.set(normalized.mmsi, normalized);
    state.lastAISUpdate = normalized.timestamp || new Date().toISOString();
    appendLiveTrack(normalized);
    renderLiveAISMarker(normalized);
    if (!options || !options.skipRefresh) refreshDashboard();
  }

  function replaceLiveReviewEvents(events) {
    state.liveReviewEvents.clear();
    Array.from(state.eventsById.entries()).forEach(([eventId, event]) => {
      if (event && event.source === "aisstream") state.eventsById.delete(eventId);
    });
    (events || []).forEach(event => upsertLiveReviewEvent(event, { skipRefresh: true }));
  }

  function upsertLiveReviewEvent(event, options) {
    if (!event || !event.id) return;
    const enriched = enrichEvent(event);
    state.liveReviewEvents.set(enriched.id, enriched);
    state.eventsById.set(enriched.id, enriched);
    if (!options || !options.skipRefresh) refreshDashboard();
  }

  function removeLiveReviewEvent(eventId, options) {
    if (!eventId) return;
    state.liveReviewEvents.delete(eventId);
    state.eventsById.delete(eventId);
    if (state.selectedEventId === eventId) state.selectedEventId = null;
    if (!options || !options.skipRefresh) refreshDashboard();
  }

  function normalizeFrontendVessel(vessel) {
    const lat = toNumber(vessel.lat);
    const lon = toNumber(vessel.lon);
    const mmsi = vessel.mmsi === undefined || vessel.mmsi === null ? null : String(vessel.mmsi);
    if (!mmsi || lat === null || lon === null) return null;
    return {
      source: "aisstream",
      synthetic: false,
      mmsi,
      vessel_name: vessel.vessel_name || "Unknown",
      lat,
      lon,
      sog: toNumber(vessel.sog),
      cog: toNumber(vessel.cog),
      heading: toNumber(vessel.heading),
      timestamp: vessel.timestamp || new Date().toISOString(),
      message_type: vessel.message_type || "PositionReport",
      watch_area_id: vessel.watch_area_id || null,
      watch_area_name: vessel.watch_area_name || null
    };
  }

  function appendLiveTrack(vessel) {
    const track = state.liveTrackHistory.get(vessel.mmsi) || [];
    track.push({
      lat: vessel.lat,
      lon: vessel.lon,
      timestamp: vessel.timestamp,
      speed_kn: vessel.sog
    });
    while (track.length > 30) track.shift();
    state.liveTrackHistory.set(vessel.mmsi, track);
  }

  function renderLiveAISMarker(vessel) {
    if (!layers.liveAIS) return;
    const existing = state.liveMarkers.get(vessel.mmsi);
    const watchArea = vessel.watch_area_name ? `<div class="pr"><span class="pl">Watch area:</span>${escapeHtml(vessel.watch_area_name)}</div>` : "";
    const popup = `<div class="cg-popup">
      <div class="pt">${escapeHtml(vessel.vessel_name || "Unknown")}</div>
      <div class="pr"><span class="pl">Status:</span>Live AIS - unassessed</div>
      <div class="pr"><span class="pl">MMSI:</span>${escapeHtml(vessel.mmsi)}</div>
      <div class="pr"><span class="pl">SOG:</span>${formatSpeed(vessel.sog)}</div>
      <div class="pr"><span class="pl">COG:</span>${formatHeading(vessel.cog)}</div>
      ${watchArea}
      <div class="pr"><span class="pl">Time:</span>${escapeHtml(formatTime(vessel.timestamp))}</div>
      <div class="pr"><span class="pl">Source:</span>AISStream</div>
    </div>`;

    if (existing) {
      existing.setLatLng([vessel.lat, vessel.lon]);
      existing.setPopupContent(popup);
      return;
    }

    const marker = L.marker([vessel.lat, vessel.lon], {
      icon: L.divIcon({
        className: "live-ais-dot",
        html: "",
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -12]
      }),
      keyboard: true,
      opacity: 0.78,
      riseOnHover: true,
      title: "Live AIS - unassessed"
    }).bindPopup(popup, { maxWidth: 260 });
    marker.addTo(layers.liveAIS);
    state.liveMarkers.set(vessel.mmsi, marker);
  }

  function exportThreatReport() {
    const events = getFilteredEvents().map(event => ({
      id: event.id,
      source: event.source,
      synthetic: event.synthetic,
      risk_score: event.risk_score,
      risk_level: event.risk_level,
      event_type: event.event_type,
      vessel_name: event.vessel_name,
      mmsi: event.mmsi,
      counterparty_mmsi: event.counterparty_mmsi || null,
      counterparty_vessel_name: event.counterparty_vessel_name || null,
      watch_area_name: event.watch_area_name || null,
      nearest_cable: event.nearest_cable,
      distance_to_cable_nm: roundNumber(event.distance_to_cable_nm, 2),
      review_status: normalizeReviewStatus(event.review_status),
      review_notes: event.review_notes || "",
      review_updated_by: event.review_updated_by || "",
      review_updated_at: event.review_updated_at || null,
      evidence: event.evidence,
      recommendation: event.recommendation
    }));
    const payload = {
      generated_at: new Date().toISOString(),
      system: "CableGuard-MVP",
      note: "Risk prioritization only. Not hostile-intent confirmation.",
      events
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cableguard-threat-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(url);
    }, 1000);
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

  function findNearestCable(lat, lon) {
    if (typeof CABLES === "undefined" || !Array.isArray(CABLES)) return null;
    let nearest = null;
    CABLES.forEach(cable => {
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

  function getCandidateEventCount() {
    let count = 0;
    if (state.demoMode && state.showSynthetic) count += state.syntheticEvents.length;
    if (state.showLiveAIS) count += state.liveReviewEvents.size;
    return count;
  }

  function getEventContextLabel(event) {
    if (event.nearest_cable) return event.nearest_cable;
    if (event.watch_area_name) return event.watch_area_name;
    if (event.region) return event.region;
    return "Unknown";
  }

  function formatWatchAreas(watchAreas) {
    if (!Array.isArray(watchAreas) || !watchAreas.length) return "Not loaded";
    return `${watchAreas.length} active`;
  }

  function getSelectValue(id, fallback) {
    return els[id] ? els[id].value : fallback;
  }

  function setText(id, value) {
    if (els[id]) els[id].textContent = String(value);
  }

  function setHtml(id, value) {
    if (els[id]) els[id].innerHTML = value;
  }

  function isFinitePoint(event) {
    return Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lon));
  }

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

  function formatDistance(value) {
    const num = toNumber(value);
    return num === null ? "Unknown" : `${roundNumber(num, 1)} nm`;
  }

  function formatDuration(value) {
    const num = toNumber(value);
    return num === null ? "Unknown" : `${roundNumber(num, 1)} h`;
  }

  function formatSpeed(value) {
    const num = toNumber(value);
    return num === null ? "Unknown" : `${roundNumber(num, 1)} kn`;
  }

  function formatHeading(value) {
    const num = toNumber(value);
    return num === null ? "Unknown" : `${Math.round(num)} deg`;
  }

  function formatTime(value) {
    if (!value) return "Unknown";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().replace("T", " ").replace(".000Z", "Z");
  }

  function degToRad(value) {
    return value * Math.PI / 180;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCableGuard);
  } else {
    initCableGuard();
  }
})();
