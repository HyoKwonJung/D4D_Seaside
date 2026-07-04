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
    live_ais_review: "Cable Corridor Review",
    rf_dark: "RF Dark Contact",
    sar_dark: "SAR Dark Contact"
  };
  const markerClassByType = {
    dark_sar: "dark_sar",
    ais_loitering: "ais_loitering",
    ais_gap: "ais_gap",
    encounter: "encounter",
    dragging_like: "dragging_like",
    live_ais_review: "live_ais_review",
    rf_dark: "rf_dark",
    sar_dark: "sar_dark"
  };
  const trackStyles = {
    normal: { color: "#94a3b8", weight: 2, opacity: 0.55 },
    loitering: { color: "#f97316", weight: 3, opacity: 0.82 },
    ais_gap: { color: "#facc15", weight: 3, opacity: 0.82, dashArray: "8,7" },
    encounter: { color: "#c084fc", weight: 3, opacity: 0.82 },
    dragging_like: { color: "#ff2d9e", weight: 3, opacity: 0.86 },
    dark_sar: { color: "#ef4444", weight: 2, opacity: 0.7, dashArray: "4,6" },
    rf_dark: { color: "#22d3ee", weight: 2, opacity: 0.74, dashArray: "5,6" },
    sar_dark: { color: "#fb7185", weight: 2, opacity: 0.74, dashArray: "4,6" }
  };
  const COMMANDER_INTENT_STORAGE_KEY = "cableguard.commanderIntent.v1";
  const RECOMMENDED_FOCUS_LIMIT = 2;
  const VESSEL_MARKER_REFRESH_MS = 60000;
  const DASHBOARD_REFRESH_MS = 3600000;
  const state = {
    showCables: true,
    showContours: true,
    showLiveAIS: true,
    showSynthetic: true,
    showFoundry: true,
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
    foundryEvents: new Map(),
    eventsById: new Map(),
    eventMarkers: new Map(),
    liveMarkers: new Map(),
    liveVesselInfo: null,
    liveVesselInfoMmsi: null,
    selectedEventId: null,
    osintCache: new Map(),
    osintActiveKey: null,
    osintRequestSeq: 0,
    aiDecisionTimer: null,
    aiDecisionKey: null,
    aiDecisionCache: null,
    detailEventId: null,
    decisionRenderedId: null,
    threatRiskBand: "all",
    decisionChecks: new Map(),
    dashboardDirty: false,
    lastDashboardRefreshAt: 0,
    dirtyVessels: new Map(),
    commanderIntent: { text: "" },
    focusAreas: [],
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
    loadCommanderIntent();
    syncCommanderIntentInputs();
    layers.syntheticEvents = L.layerGroup().addTo(map);
    layers.syntheticTracks = L.layerGroup().addTo(map);
    layers.liveAIS = L.layerGroup().addTo(map);
    layers.buffers = L.layerGroup().addTo(map);
    layers.focusAreas = L.layerGroup().addTo(map);
    map.on("zoomend", updateLiveAISMarkerScale);
    map.on("click", closeLiveVesselInfo);

    state.syntheticEvents = (window.SYNTHETIC_EVENTS || []).map(enrichEvent);
    state.syntheticEvents.forEach(event => state.eventsById.set(event.id, event));

    wireControls();
    applyBaseLayerVisibility();
    renderSyntheticTracks();
    refreshDashboard();
    connectLiveAIS();
    loadLatestAISSnapshot();
    loadFoundryEvents();

    // 라이브 수신 반영 주기: 선박 마커 1분, 그 외 패널은 1시간 배치 (사용자 조작은 즉시 반영 유지)
    window.setInterval(flushVesselMarkers, VESSEL_MARKER_REFRESH_MS);
    window.setInterval(runScheduledDashboardRefresh, 60000);

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
      "toggle-foundry",
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
      "decision-risk-label",
      "commander-intent",
      "commander-intent-save",
      "commander-intent-status",
      "interest-zone-list"
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
    bindToggle("toggle-foundry", "showFoundry", refreshDashboard);
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
    if (els["commander-intent-save"]) {
      els["commander-intent-save"].addEventListener("click", saveCommanderIntentFromUi);
    }
    if (els["commander-intent"]) {
      els["commander-intent"].addEventListener("input", () => setText("commander-intent-status", "Unsaved edits"));
    }
    const riskFilterGroup = document.getElementById("threat-risk-filter");
    if (riskFilterGroup) {
      riskFilterGroup.addEventListener("click", clickEvent => {
        const button = clickEvent.target.closest ? clickEvent.target.closest("button[data-risk]") : null;
        if (!button) return;
        state.threatRiskBand = button.dataset.risk || "all";
        riskFilterGroup.querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
        applyBaseLayerVisibility();
        refreshDashboard();
      });
    }
    if (els["decision-options"]) {
      // 체크 상태를 이벤트별로 기억해, 패널이 다시 그려져도 유지한다.
      els["decision-options"].addEventListener("change", changeEvent => {
        const target = changeEvent.target;
        if (!target || target.type !== "checkbox") return;
        const item = target.closest ? target.closest(".cg-check-item") : null;
        const titleEl = item ? item.querySelector("span") : null;
        if (!titleEl) return;
        state.decisionChecks.set(`${state.selectedEventId || "none"}|${titleEl.textContent}`, target.checked);
      });
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
      // 위험등급 필터가 걸려 있으면 일반 AIS 점은 숨기고 해당 등급 이벤트 마커만 보여준다.
      if (state.showLiveAIS && state.threatRiskBand === "all") layers.liveAIS.addTo(map);
      else map.removeLayer(layers.liveAIS);
    }
  }

  function syncToggleStates() {
    const mapping = {
      "toggle-cables": "showCables",
      "toggle-contours": "showContours",
      "toggle-live-ais": "showLiveAIS",
      "toggle-synthetic": "showSynthetic",
      "toggle-foundry": "showFoundry",
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

  function normalizeEvidenceList(value) {
    if (Array.isArray(value)) return value.filter(item => item !== null && item !== undefined && item !== "").map(String);
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(item => item !== null && item !== undefined && item !== "").map(String);
      } catch (error) {
        // Fall back to treating it as one evidence statement.
      }
    }
    return [trimmed];
  }

  function enrichFoundryEvent(input) {
    const event = Object.assign({}, input);
    event.source_system = "foundry-osdk";

    if ((!event.nearest_cable || event.distance_to_cable_nm === undefined || event.distance_to_cable_nm === null)
      && isFinitePoint(event)) {
      const nearest = findNearestCable(event.lat, event.lon);
      if (nearest) {
        event.nearest_cable = event.nearest_cable || nearest.name;
        event.distance_to_cable_nm = event.distance_to_cable_nm ?? nearest.distance_nm;
        event.nearest_cable_id = event.nearest_cable_id || nearest.id || null;
      }
    }

    const preservedScore = toNumber(event.risk_score);
    const score = preservedScore !== null ? preservedScore : calculateRiskScore(event);
    event.risk_score = score;
    event.risk_level = event.risk_level || getRiskLevel(score);
    event.evidence = normalizeEvidenceList(event.evidence);
    if (!event.evidence.length) event.evidence = buildEvidence(event, score);
    event.recommendation = event.recommendation || generateRecommendation(event, score, event.risk_level);
    event.review_status = normalizeReviewStatus(event.review_status);
    return event;
  }
  function refreshDashboard() {
    state.dashboardDirty = false;
    state.lastDashboardRefreshAt = Date.now();
    const visibleEvents = getFilteredEvents();
    state.focusAreas = computeRecommendedFocusAreas(visibleEvents);
    renderEventMarkers(visibleEvents);
    renderThreatTable(visibleEvents);
    renderSummary(visibleEvents);
    drawRecommendedFocusAreas(state.focusAreas);
    renderRecommendedFocusAreaList(state.focusAreas);
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

  // 초단위 라이브 수신이 대시보드 전체를 다시 그리며 입력값을 지우지 않도록,
  // 수신은 상태만 갱신하고 화면 반영은 주기에 맞춰 배치 처리한다.
  function scheduleDashboardRefresh() {
    state.dashboardDirty = true;
  }

  function flushVesselMarkers() {
    if (!state.dirtyVessels.size) return;
    state.dirtyVessels.forEach(vessel => renderLiveAISMarker(vessel));
    state.dirtyVessels.clear();
  }

  function isUserEditing() {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
  }

  function runScheduledDashboardRefresh() {
    if (!state.dashboardDirty) return;
    if (Date.now() - state.lastDashboardRefreshAt < DASHBOARD_REFRESH_MS) return;
    if (isUserEditing()) return; // 입력 중이면 다음 점검 주기로 미룬다
    refreshDashboard();
  }

  function getAllCandidateEvents() {
    const byId = new Map();
    const add = event => { if (event && event.id != null) byId.set(String(event.id), event); };
    // 우선순위: foundry(지속저장) → synthetic → live(실시간이 최신이므로 마지막에 덮어씀)
    if (state.showFoundry) state.foundryEvents.forEach(add);
    if (state.demoMode && state.showSynthetic) state.syntheticEvents.forEach(add);
    if (state.showLiveAIS) state.liveReviewEvents.forEach(add);
    const events = Array.from(byId.values());
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
        if (!passesThreatRiskBand(event, state.threatRiskBand)) return false;
        if (typeFilter !== "all" && event.event_type !== typeFilter) return false;
        if (regionFilter !== "all" && event.region !== regionFilter) return false;
        if (sourceFilter === "live" && event.source !== "aisstream") return false;
        if (sourceFilter === "synthetic" && event.source !== "synthetic_injection") return false;
        if (sourceFilter === "foundry" && event.source_system !== "foundry-osdk") return false;
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

  // Threat List 상단 등급 버튼: 선택한 등급 구간만 목록·지도에 표시 (정확 구간 매칭)
  function passesThreatRiskBand(event, band) {
    if (!band || band === "all") return true;
    const score = toNumber(event.risk_score) || 0;
    if (band === "very_high") return score >= 70;
    if (band === "high") return score >= 50 && score < 70;
    if (band === "medium") return score >= 30 && score < 50;
    if (band === "low") return score < 30;
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
      state.osintActiveKey = null;
      setHtml("osint-summary", "Waiting for Foundry ontology context.");
      setHtml("intel-summary", "Evidence, recommendation, and OSINT findings will appear with the selected event.");
      setText("decision-risk-label", "No active recommendation");
      state.decisionRenderedId = null;
      setDecisionOptions(buildDecisionOptions(null, []));
      return;
    }

    const typeLabel = eventTypeLabels[event.event_type] || event.event_type || "Unknown event";
    const sourceLabel = getSourceLabel(event);
    const context = getEventContextLabel(event);
    const watchArea = event.watch_area_name || event.region || "Unknown area";
    const veryHighCount = events.filter(item => item.risk_level === "Very High").length;
    const highCount = events.filter(item => item.risk_level === "High").length;
    const briefing = `${watchArea}: ${event.risk_level} ${typeLabel} on ${event.vessel_name || "Unknown vessel"}. ${formatDistance(event.distance_to_cable_nm)} from ${context}. ${sourceLabel} requires commander review before escalation.`;

    setText("ai-briefing-summary", briefing);
    setText("ai-briefing-meta", `${events.length} visible | ${veryHighCount} very high | ${highCount} high`);
    setText("decision-risk-label", `${event.risk_level} / ${event.risk_score}`);

    renderOntologyPanel(event, sourceLabel, context);
    renderIntelPanel(event, sourceLabel, context);
    // Decision 체크리스트는 선택 이벤트가 바뀔 때만 다시 그린다.
    // (Update Intent / Save Review 등으로 재렌더링돼도 체크 상태 DOM을 건드리지 않음)
    if (state.decisionRenderedId !== event.id) {
      state.decisionRenderedId = event.id;
      setDecisionOptions(buildDecisionOptions(event, events));
      requestAiDecisionSupport(events, event);
    }
  }

  function commandKv(label, value) {
    return `<div class="cg-intel-kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
  }

  function renderOntologyPanel(event, sourceLabel, context) {
    if (!event) {
      setHtml("osint-summary", "Waiting for Foundry ontology context.");
      return;
    }

    const identifiers = formatIdentifierSummary(event);
    const isFoundry = event.source_system === "foundry-osdk";
    const objectStatus = isFoundry
      ? "Linked Foundry CableguardEvent"
      : "No Foundry vessel object linked for this live contact";
    const provenance = isFoundry
      ? "Foundry OSDK ontology projection"
      : "Live dashboard event fields only";

    setHtml("osint-summary", `
      ${commandKv("Object", objectStatus)}
      ${commandKv("Entity", event.vessel_name || "Unknown")}
      ${commandKv("Identifiers", identifiers)}
      ${commandKv("Flag / Owner", formatFlagOwner(event))}
      ${commandKv("Route", formatRouteSummary(event))}
      ${commandKv("Korea Visit", formatOntologyValue(coalesceField(event, ["last_korea_visit_at", "lastKoreaVisitAt", "korea_last_visit_at", "koreaPortVisitAt", "last_port_call_korea_at"]))) }
      ${commandKv("Risk", `${event.risk_level || "Unknown"} (${event.risk_score ?? "n/a"})`)}
      ${commandKv("Dark Status", formatOntologyValue(coalesceField(event, ["dark_vessel_status", "darkVesselStatus"], "unknown")))}
      ${commandKv("Sanctions", formatSanctionsSummary(event))}
      ${commandKv("Crew", formatCrewSummary(event))}
      ${commandKv("Source", sourceLabel)}
      ${commandKv("Context", context)}
      ${commandKv("Provenance", provenance)}
      ${renderOntologyNotice(isFoundry)}
    `);
  }

  function renderOntologyNotice(isFoundry) {
    const text = isFoundry
      ? "Only populated Foundry ontology properties are shown. Missing route, port-call, sanctions, or crew fields indicate the enrichment pipeline has not populated them yet."
      : "This contact is not backed by a Foundry Vessel object yet, so route, sanctions, crew, and visit history are not authoritative here.";
    return `<div class="cg-osint-status ${isFoundry ? "good" : "warn"}">${escapeHtml(text)}</div>`;
  }

  // 측정된 이상징후(anomaly)와 통상 활동으로도 설명되는 상황요인(context)을 구분한다.
  // 입항대기 선박이 흔히 해당되는 저속·장시간·케이블 근접은 anomaly가 아니라 상황요인.
  function assessVesselAnomalies(event) {
    const anomalies = [];
    const factors = [];
    const distance = toNumber(event.distance_to_cable_nm);
    const speed = toNumber(event.speed_kn);
    const duration = toNumber(event.duration_h);

    if (event.ais_status === "off") anomalies.push("AIS transmission lost - contact is dark.");
    if (event.ais_status === "intermittent") anomalies.push("Intermittent AIS transmission (possible manipulation).");
    if (event.sar_matched === false) anomalies.push("SAR detection has no matching AIS track.");
    if (event.rf_matched === false) anomalies.push("RF emission has no matching AIS track.");
    const darkStatus = String(event.dark_vessel_status || "");
    if (/^(rf-only|sar-only|multi-sensor|confirmed-dark)$/.test(darkStatus)) {
      anomalies.push(`Multi-sensor dark vessel status: ${darkStatus}.`);
    }
    if (event.event_type === "dragging_like") anomalies.push("Track shape consistent with anchor/gear dragging over the cable route.");
    if (event.event_type === "ais_gap") anomalies.push("AIS gap detected along the track.");
    if (["dark_sar", "sar_dark", "rf_dark"].includes(event.event_type) && !anomalies.length) {
      anomalies.push("Detection originates from a non-AIS sensor with no cooperative track.");
    }

    if (distance !== null && distance <= 5) factors.push(`${formatDistance(distance)} from the nearest cable.`);
    if (event.event_type === "ais_loitering") factors.push("Loitering pattern (also common for vessels holding at anchorage).");
    if (event.event_type === "encounter") factors.push("Close proximity to another vessel (also common in anchorage areas).");
    if (speed !== null && speed > 0 && speed <= 3) factors.push("Low-speed movement.");
    if (duration !== null && duration >= 2) factors.push(`Observed for ${formatDuration(duration)}.`);
    if (event.ais_status === "on") factors.push("AIS actively transmitting - cooperative contact.");

    return { anomalies, factors };
  }

  // 고위험(80+) 표적용 모의 SAR 칩. 실제 위성 이미지가 붙기 전까지의 자리표시자로,
  // 이벤트 id 시드 기반 절차 생성이라 같은 표적은 항상 같은 이미지가 나온다.
  function hashSeed(text) {
    let h = 2166136261;
    const s = String(text || "sar");
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function drawSimulatedSarChip(canvas, event) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const hgt = canvas.height;
    let seed = hashSeed(event.id || event.mmsi);
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // SAR 스페클 노이즈 배경
    const img = ctx.createImageData(w, hgt);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.min(255, 16 + rand() * 40 + (rand() < 0.02 ? rand() * 90 : 0));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // 선체 후방산란 신호 (헤딩 방향으로 회전)
    const cx = w / 2;
    const cy = hgt / 2;
    const heading = toNumber(event.heading_deg);
    const headingRad = ((heading === null ? rand() * 360 : heading) * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(headingRad);
    const len = 14 + rand() * 10;
    const wid = 4 + rand() * 3;
    const grd = ctx.createRadialGradient(0, 0, 1, 0, 0, len);
    grd.addColorStop(0, "rgba(255,255,255,0.98)");
    grd.addColorStop(0.5, "rgba(220,230,235,0.75)");
    grd.addColorStop(1, "rgba(120,140,150,0)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(0, 0, len, wid, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(180,200,210,0.28)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(-len * 3.2, rand() * 6 - 3);
    ctx.stroke();
    ctx.restore();

    // 표적 박스와 주석
    ctx.strokeStyle = "rgba(250,204,21,0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 22, cy - 22, 44, 44);
    ctx.fillStyle = "rgba(250,204,21,0.95)";
    ctx.font = "9px monospace";
    ctx.fillText("TGT", cx - 21, cy - 27);
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    const lat = roundNumber(event.lat, 3);
    const lon = roundNumber(event.lon, 3);
    ctx.fillText(`LAT ${lat === null ? "?" : lat}  LON ${lon === null ? "?" : lon}`, 6, hgt - 17);
    ctx.fillText("SIMULATED SAR - TRAINING ONLY", 6, hgt - 6);
  }

  function renderIntelPanel(event, sourceLabel, context) {
    if (!event) {
      setHtml("intel-summary", "Evidence, recommendation, and OSINT findings will appear with the selected event.");
      return;
    }

    const assessment = assessVesselAnomalies(event);
    const anomalyVerdict = assessment.anomalies.length
      ? `<span class="cg-pill bad">⚠ ${assessment.anomalies.length} anomaly indicator${assessment.anomalies.length > 1 ? "s" : ""} measured</span>`
      : `<span class="cg-pill good">✓ No anomaly measured</span>`;
    const anomalyBody = assessment.anomalies.length
      ? `<ul class="cg-list">${assessment.anomalies.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : `<div class="cg-source-note">Vessel is transmitting AIS and its behavior is also consistent with routine activity (e.g., holding at anchorage).</div>`;
    const factorItems = assessment.factors.slice(0, 5).map(item => `<li>${escapeHtml(item)}</li>`).join("") || "<li>No contextual factors recorded.</li>";
    const showSarChip = (toNumber(event.risk_score) || 0) >= 80;
    const sarSection = showSarChip
      ? `<div class="cg-title" style="margin-top:12px">SAR Imagery (Simulated)</div>
         <canvas id="intel-sar-chip" class="cg-sar-chip" width="300" height="170"></canvas>
         <div class="cg-source-note">Procedurally generated SAR placeholder for high-risk targets (score 80+). Not real imagery.</div>`
      : "";

    setHtml("intel-summary", `
      <div class="cg-title">Anomaly Assessment</div>
      <div class="cg-anomaly-verdict">${anomalyVerdict}</div>
      ${anomalyBody}
      ${commandKv("Priority", `${event.risk_level} (${event.risk_score})`)}
      ${commandKv("Distance", formatDistance(event.distance_to_cable_nm))}
      ${commandKv("Speed", formatSpeed(event.speed_kn))}
      ${commandKv("Duration", formatDuration(event.duration_h))}
      ${sarSection}
      <div class="cg-title" style="margin-top:12px">Contextual Factors</div>
      <ul class="cg-list">${factorItems}</ul>
      <div class="cg-recommendation">${escapeHtml(event.recommendation || generateRecommendation(event, event.risk_score, event.risk_level))}</div>
      <div class="cg-title" style="margin-top:12px">OSINT</div>
      ${buildIntelOsintSection(event, sourceLabel, context)}
    `);
    if (showSarChip) {
      drawSimulatedSarChip(document.getElementById("intel-sar-chip"), event);
    }
  }

  function buildIntelOsintSection(event, sourceLabel, context) {
    const query = buildOsintQuery(event);
    const identity = `
      ${commandKv("OSINT Query", query || "No stable identifier")}
      ${commandKv("OSINT Basis", `${formatIdentifierSummary(event)} | ${sourceLabel} | ${context}`)}
    `;

    if (event.synthetic || event.source === "synthetic_injection") {
      state.osintActiveKey = null;
      return `${identity}${osintStatus("Scenario fixture: external OSINT lookup skipped for training data.", "warn")}`;
    }

    if (!location.protocol.startsWith("http")) {
      return `${identity}${osintStatus("Run through the backend server to query StealthMole OSINT.", "warn")}`;
    }

    if (!query) {
      state.osintActiveKey = null;
      return `${identity}${osintStatus("No stable IMO, MMSI, or vessel name is available for OSINT lookup.", "warn")}`;
    }

    const cacheKey = getOsintCacheKey(query);
    const cached = state.osintCache.get(cacheKey);
    if (cached) {
      return `${identity}${buildOsintFindingHtml(query, cached)}`;
    }

    if (state.osintActiveKey === cacheKey) {
      return `${identity}${osintStatus("Searching StealthMole monitoring sources...", "loading")}`;
    }

    state.osintActiveKey = cacheKey;
    const requestId = ++state.osintRequestSeq;
    fetch(`/api/osint/monitoring?q=${encodeURIComponent(query)}`, { cache: "no-store" })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || `OSINT lookup failed (${response.status})`);
        }
        return payload;
      })
      .then(payload => {
        state.osintCache.set(cacheKey, { ok: true, fetchedAt: new Date().toISOString(), response: payload });
        refreshIntelOsintIfCurrent(cacheKey, requestId);
      })
      .catch(error => {
        state.osintCache.set(cacheKey, { ok: false, fetchedAt: new Date().toISOString(), error: error.message || "OSINT lookup failed." });
        refreshIntelOsintIfCurrent(cacheKey, requestId);
      });

    return `${identity}${osintStatus("Searching StealthMole monitoring sources...", "loading")}`;
  }

  function refreshIntelOsintIfCurrent(cacheKey, requestId) {
    if (requestId !== state.osintRequestSeq) return;
    const current = state.selectedEventId ? state.eventsById.get(state.selectedEventId) : null;
    if (!current || getOsintCacheKey(buildOsintQuery(current)) !== cacheKey) return;
    state.osintActiveKey = null;
    renderIntelPanel(current, getSourceLabel(current), getEventContextLabel(current));
  }

  function getOsintIdentifiers(event) {
    if (!event) return [];
    const fields = [
      ["IMO", coalesceField(event, ["imo", "vessel_imo", "vesselImo", "imo_number"])],
      ["MMSI", coalesceField(event, ["mmsi", "vessel_id", "vesselMmsi"])],
      ["Name", coalesceField(event, ["vessel_name", "vesselName"])]
    ];
    const seen = new Set();
    return fields
      .map(([label, value]) => ({ label, value: normalizeOsintIdentifier(value) }))
      .filter(item => item.value && !seen.has(item.value.toLowerCase()) && seen.add(item.value.toLowerCase()));
  }

  function buildOsintQuery(event) {
    const identifiers = getOsintIdentifiers(event);
    const preferred = identifiers.find(item => item.label === "IMO")
      || identifiers.find(item => item.label === "MMSI")
      || identifiers.find(item => item.label === "Name");
    return preferred ? preferred.value : "";
  }

  function formatIdentifierSummary(event) {
    const identifiers = getOsintIdentifiers(event);
    return identifiers.length ? identifiers.map(item => `${item.label}: ${item.value}`).join(" / ") : "None available";
  }

  function coalesceField(source, keys, fallback) {
    if (!source) return fallback === undefined ? null : fallback;
    for (const key of keys) {
      const value = source[key];
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return fallback === undefined ? null : fallback;
  }

  function formatOntologyValue(value) {
    if (Array.isArray(value)) return value.length ? value.join(", ") : "Current ontology field not populated";
    const text = normalizeOsintIdentifier(value);
    return text || "Current ontology field not populated";
  }

  function formatFlagOwner(event) {
    const flag = formatOntologyValue(coalesceField(event, ["flag", "vessel_flag", "vesselFlag"]));
    const owner = formatOntologyValue(coalesceField(event, ["owner", "registered_owner", "registeredOwner", "vesselOwner"]));
    if (flag === "Current ontology field not populated" && owner === flag) return flag;
    return `${flag} / ${owner}`;
  }

  function formatRouteSummary(event) {
    const from = coalesceField(event, ["origin_port", "originPort", "departure_port", "departurePort", "last_port", "lastPort"]);
    const to = coalesceField(event, ["destination_port", "destinationPort", "arrival_port", "arrivalPort", "next_port", "nextPort"]);
    const eta = coalesceField(event, ["eta", "eta_at", "etaAt", "arrival_eta", "arrivalEta"]);
    if (!from && !to && !eta) return "Current ontology field not populated";
    const route = `${formatOntologyValue(from)} -> ${formatOntologyValue(to)}`;
    return eta ? `${route} / ETA ${formatOntologyValue(eta)}` : route;
  }

  function formatSanctionsSummary(event) {
    const sanctioned = coalesceField(event, ["is_sanctioned", "isSanctioned", "sanctioned"]);
    const status = coalesceField(event, ["sanctions_status", "sanctionsStatus"]);
    const lists = coalesceField(event, ["sanctions_list", "sanctionsList", "sanction_lists", "sanctionLists"]);
    if (sanctioned === true) return `Listed / ${formatOntologyValue(lists || status)}`;
    if (sanctioned === false) return status ? `Not listed / ${formatOntologyValue(status)}` : "Not listed in populated ontology fields";
    return formatOntologyValue(lists || status);
  }

  function formatCrewSummary(event) {
    const summary = coalesceField(event, ["crew_summary", "crewSummary", "crew_info", "crewInfo"]);
    const count = coalesceField(event, ["crew_count", "crewCount"]);
    const nationality = coalesceField(event, ["crew_nationality", "crewNationality", "crew_nationalities", "crewNationalities"]);
    if (summary) return formatOntologyValue(summary);
    if (!count && !nationality) return "Current ontology field not populated";
    return [`Count ${formatOntologyValue(count)}`, `Nationality ${formatOntologyValue(nationality)}`].join(" / ");
  }

  function normalizeOsintIdentifier(value) {
    if (value === null || value === undefined) return "";
    const text = String(value).trim().replace(/\s+/g, " ");
    if (!text) return "";
    if (/^(unknown|n\/a|na|null|none|undefined)$/i.test(text)) return "";
    return text;
  }

  function getOsintCacheKey(query) {
    return String(query || "").trim().toLowerCase();
  }

  function osintStatus(text, kind) {
    return `<div class="cg-osint-status ${escapeAttr(kind || "info")}">${escapeHtml(text)}</div>`;
  }

  function buildOsintFindingHtml(query, result) {
    if (!result || !result.ok) {
      return osintStatus(result && result.error ? result.error : "OSINT lookup unavailable.", "error");
    }

    const summary = summarizeOsintResponse(result.response && result.response.data);
    const cacheLabel = result.response && result.response.cached ? "server cache" : "live query";
    let statusText;
    let statusKind;
    if (summary.errorCount > 0) {
      statusText = `StealthMole lookup incomplete for ${query}: ${summary.errorCount} source${summary.errorCount === 1 ? "" : "s"} returned an error (${cacheLabel}).`;
      statusKind = "error";
    } else if (summary.total > 0) {
      statusText = `StealthMole returned ${summary.total} possible hit${summary.total === 1 ? "" : "s"} across ${summary.hitSources} source${summary.hitSources === 1 ? "" : "s"} (${cacheLabel}).`;
      statusKind = "warn";
    } else {
      statusText = `No StealthMole monitoring hits returned for ${query} (${cacheLabel}).`;
      statusKind = "good";
    }
    return `${osintStatus(statusText, statusKind)}<div class="cg-osint-sources">${summary.sections.map(renderOsintSection).join("")}</div>`;
  }

  function summarizeOsintResponse(data) {
    const sections = [
      buildOsintSection("ransomware", "Ransomware", data && data.ransomware),
      buildOsintSection("leakedMonitoring", "Leak Monitoring", data && data.leakedMonitoring),
      buildOsintSection("governmentMonitoring", "Gov Monitoring", data && data.governmentMonitoring)
    ];
    const total = sections.reduce((sum, section) => sum + (Number.isFinite(section.count) ? section.count : 0), 0);
    const hitSources = sections.filter(section => Number.isFinite(section.count) && section.count > 0).length;
    const errorCount = sections.filter(section => section.error).length;
    return { sections, total, hitSources, errorCount };
  }

  function buildOsintSection(key, label, node) {
    const error = node && node.error ? String(node.error) : "";
    const items = error ? [] : extractOsintItems(node).slice(0, 2);
    const count = error ? null : inferOsintCount(node, items.length);
    return { key, label, error, count, items };
  }

  function renderOsintSection(section) {
    const countLabel = section.error ? "Error" : `${section.count || 0}`;
    const body = section.error
      ? `<div class="cg-osint-empty">${escapeHtml(section.error)}</div>`
      : section.items.length
        ? `<ul class="cg-osint-list">${section.items.map(renderOsintItem).join("")}</ul>`
        : `<div class="cg-osint-empty">No records returned.</div>`;
    return `<section class="cg-osint-source"><div class="cg-osint-source-head"><span>${escapeHtml(section.label)}</span><strong>${escapeHtml(countLabel)}</strong></div>${body}</section>`;
  }

  function renderOsintItem(item) {
    const meta = [item.source, item.time].filter(Boolean).join(" | ");
    return `<li><strong>${escapeHtml(item.title)}</strong>${meta ? `<span>${escapeHtml(meta)}</span>` : ""}${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}</li>`;
  }

  function extractOsintItems(value) {
    const array = findOsintArray(value, 0);
    return array.map(normalizeOsintItem).filter(Boolean);
  }

  function findOsintArray(value, depth) {
    if (!value || depth > 4) return [];
    if (Array.isArray(value)) return value;
    if (typeof value !== "object") return [];
    const preferredKeys = ["results", "items", "data", "list", "records", "documents", "hits", "nodes", "content"];
    for (const key of preferredKeys) {
      if (Array.isArray(value[key])) return value[key];
    }
    for (const key of preferredKeys) {
      const nested = findOsintArray(value[key], depth + 1);
      if (nested.length) return nested;
    }
    for (const nestedValue of Object.values(value)) {
      const nested = findOsintArray(nestedValue, depth + 1);
      if (nested.length) return nested;
    }
    return [];
  }

  function normalizeOsintItem(item) {
    if (item === null || item === undefined) return null;
    if (typeof item !== "object") return { title: truncateText(item, 96), detail: "", source: "", time: "" };
    const title = pickOsintField(item, ["title", "name", "subject", "actor", "group", "keyword", "domain", "url", "id"]) || "Monitoring record";
    const detail = pickOsintField(item, ["summary", "description", "snippet", "content", "message", "text", "body", "detail"]);
    const source = pickOsintField(item, ["source", "sourceName", "channel", "site", "type"]);
    const time = pickOsintField(item, ["detectionTime", "detectedAt", "createdAt", "createDate", "publishedAt", "time"]);
    return {
      title: truncateText(title, 96),
      detail: truncateText(detail, 180),
      source: truncateText(source, 48),
      time: time ? formatCompactTime(time) : ""
    };
  }

  function pickOsintField(source, keys) {
    if (!source || typeof source !== "object") return "";
    for (const key of keys) {
      const value = source[key];
      if (value !== null && value !== undefined && value !== "") return String(value);
    }
    return "";
  }

  function inferOsintCount(node, fallback) {
    const explicit = findNumericOsintField(node, 0);
    return explicit !== null ? explicit : fallback;
  }

  function findNumericOsintField(value, depth) {
    if (!value || typeof value !== "object" || depth > 3) return null;
    for (const key of ["total", "totalCount", "count", "size"]) {
      const num = Number(value[key]);
      if (Number.isFinite(num)) return num;
    }
    for (const nestedValue of Object.values(value)) {
      const nested = findNumericOsintField(nestedValue, depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  }

  function truncateText(value, maxLength) {
    const text = normalizeOsintIdentifier(value);
    if (!text) return "";
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}...` : text;
  }

  function formatCompactTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return truncateText(value, 32);
    return date.toISOString().slice(0, 10);
  }
  function loadCommanderIntent() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(COMMANDER_INTENT_STORAGE_KEY) : null;
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const merged = parsed.text !== undefined
        ? parsed.text
        : [parsed.pir, parsed.ffir].filter(Boolean).join(" / ");
      state.commanderIntent = { text: normalizeCommanderText(merged) };
    } catch (error) {
      console.warn("Unable to load commander intent:", error.message);
    }
  }

  function syncCommanderIntentInputs() {
    if (els["commander-intent"]) els["commander-intent"].value = state.commanderIntent.text || "";
    setText("commander-intent-status", getCommanderIntentText() ? "Intent active" : "Local rules active");
  }

  function saveCommanderIntentFromUi() {
    state.commanderIntent = {
      text: normalizeCommanderText(els["commander-intent"] ? els["commander-intent"].value : "")
    };
    try {
      if (window.localStorage) {
        window.localStorage.setItem(COMMANDER_INTENT_STORAGE_KEY, JSON.stringify(state.commanderIntent));
      }
    } catch (error) {
      console.warn("Unable to save commander intent:", error.message);
    }
    setText("commander-intent-status", getCommanderIntentText() ? "Intent active" : "Local rules active");
    refreshDashboard();
  }

  function normalizeCommanderText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function getCommanderIntentText() {
    return state.commanderIntent.text || "";
  }

  // 한국어 지휘관 의도를 영문 이벤트 텍스트(watch area/event type 등)와 매칭하기 위한 별칭.
  const INTENT_KEYWORD_ALIASES = [
    [/제주/, ["jeju"]],
    [/부산|남해|대한해협|한국해협/, ["korea strait", "south coast"]],
    [/서해|황해/, ["west sea", "yellow sea"]],
    [/동해|울릉/, ["east sea", "ulleung"]],
    [/케이블|해저선/, ["cable"]],
    [/다크|미식별|무응답/, ["dark", "unknown"]],
    [/배회|체류|저속/, ["loiter"]],
    [/밀회|랑데부|접선|조우|환적/, ["encounter"]],
    [/공백|소실|중단|꺼짐/, ["gap", "off"]],
    [/어선|어업/, ["fishing"]],
    [/예인|저인망|앵커|닻/, ["dragging"]]
  ];

  function getCommanderIntentKeywords() {
    const text = getCommanderIntentText().toLowerCase();
    if (!text) return [];
    const stopWords = new Set(["and", "or", "the", "within", "near", "risk", "contact", "vessel", "ship", "구역", "선박", "위험", "접촉"]);
    const tokens = text.split(/[\s,.;:/|()\[\]{}?!]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2 && !stopWords.has(token));
    INTENT_KEYWORD_ALIASES.forEach(([pattern, aliases]) => {
      if (pattern.test(text)) tokens.push(...aliases);
    });
    return Array.from(new Set(tokens)).slice(0, 24);
  }

  function buildEventSearchText(event) {
    return [
      event.vessel_name,
      event.mmsi,
      event.imo,
      event.event_type,
      event.risk_level,
      event.watch_area_name,
      event.region,
      event.nearest_cable,
      event.source,
      event.source_system,
      event.dark_vessel_status,
      event.recommendation,
      ...(Array.isArray(event.evidence) ? event.evidence : [])
    ].filter(value => value !== undefined && value !== null).join(" ").toLowerCase();
  }

  function getIntentMatchScore(event) {
    const keywords = getCommanderIntentKeywords();
    if (!keywords.length) return 0;
    const haystack = buildEventSearchText(event);
    return keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0);
  }

  function getEventPriorityScore(event) {
    const base = toNumber(event.risk_score) || 0;
    const distance = toNumber(event.distance_to_cable_nm);
    const closeCableBonus = distance !== null && distance <= 3 ? 16 : distance !== null && distance <= 8 ? 8 : 0;
    const darkBonus = /dark|sar|rf/i.test(String(event.event_type || "")) || /dark/i.test(String(event.dark_vessel_status || "")) ? 10 : 0;
    return base + closeCableBonus + darkBonus + getIntentMatchScore(event) * 9;
  }

  function computeRecommendedFocusAreas(events) {
    const groups = new Map();
    events.filter(isFinitePoint).forEach(event => {
      const groupKey = event.watch_area_name || event.region || event.nearest_cable || "Unassigned maritime area";
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          id: slugifyFocusArea(groupKey),
          label: groupKey,
          events: [],
          minLat: Infinity,
          maxLat: -Infinity,
          minLon: Infinity,
          maxLon: -Infinity,
          score: 0,
          maxRisk: 0,
          intentHits: 0,
          darkCount: 0,
          veryHighCount: 0
        });
      }
      const group = groups.get(groupKey);
      const priority = getEventPriorityScore(event);
      group.events.push(event);
      group.score += priority;
      group.maxRisk = Math.max(group.maxRisk, toNumber(event.risk_score) || 0);
      group.intentHits += getIntentMatchScore(event);
      group.darkCount += /dark|sar|rf/i.test(String(event.event_type || "")) ? 1 : 0;
      group.veryHighCount += event.risk_level === "Very High" || (toNumber(event.risk_score) || 0) >= 70 ? 1 : 0;
      group.minLat = Math.min(group.minLat, Number(event.lat));
      group.maxLat = Math.max(group.maxLat, Number(event.lat));
      group.minLon = Math.min(group.minLon, Number(event.lon));
      group.maxLon = Math.max(group.maxLon, Number(event.lon));
    });

    // Commander Intent와 매칭되는 구역을 최우선 배치: score는 접촉 수 총합이라
    // 대형 구역이 항상 이기므로, 접촉당 intent 매칭 밀도를 1순위 기준으로 사용한다.
    const ranked = Array.from(groups.values())
      .map(group => finalizeFocusArea(group))
      .filter(Boolean)
      .sort((a, b) => b.intentDensity - a.intentDensity || b.score - a.score || b.maxRisk - a.maxRisk || b.count - a.count);

    // 상위 구역과 겹치는 박스는 제외하고 최대 RECOMMENDED_FOCUS_LIMIT개만 유지.
    const selected = [];
    for (const area of ranked) {
      if (selected.length >= RECOMMENDED_FOCUS_LIMIT) break;
      if (selected.some(kept => focusBoundsOverlap(kept.bounds, area.bounds))) continue;
      selected.push(area);
    }
    return selected;
  }

  function focusBoundsOverlap(a, b) {
    return a[0][0] <= b[1][0] && b[0][0] <= a[1][0] && a[0][1] <= b[1][1] && b[0][1] <= a[1][1];
  }

  function finalizeFocusArea(group) {
    if (!group.events.length || !Number.isFinite(group.minLat) || !Number.isFinite(group.minLon)) return null;
    const latSpan = Math.max(0, group.maxLat - group.minLat);
    const lonSpan = Math.max(0, group.maxLon - group.minLon);
    const latPad = Math.max(0.16, Math.min(0.55, latSpan * 0.32 || 0.22));
    const lonPad = Math.max(0.18, Math.min(0.65, lonSpan * 0.32 || 0.24));
    const priority = group.maxRisk >= 70 ? "Very High" : group.maxRisk >= 50 ? "High" : group.maxRisk >= 30 ? "Medium" : "Watch";
    const reasonParts = [
      `${group.events.length} contacts`,
      `${group.veryHighCount} very high`,
      `${group.darkCount} dark/RF/SAR cues`
    ];
    if (group.intentHits) reasonParts.push("intent match");
    return {
      id: group.id,
      label: group.label,
      count: group.events.length,
      maxRisk: Math.round(group.maxRisk),
      priority,
      score: Math.round(group.score),
      intentHits: group.intentHits,
      intentDensity: group.events.length ? group.intentHits / group.events.length : 0,
      reason: reasonParts.join(" / "),
      bounds: [
        [clampNumber(group.minLat - latPad, -85, 85), clampNumber(group.minLon - lonPad, -180, 180)],
        [clampNumber(group.maxLat + latPad, -85, 85), clampNumber(group.maxLon + lonPad, -180, 180)]
      ]
    };
  }

  function drawRecommendedFocusAreas(areas) {
    if (!layers.focusAreas) return;
    layers.focusAreas.clearLayers();
    (areas || []).forEach((area, index) => {
      const color = area.maxRisk >= 70 ? "#facc15" : area.maxRisk >= 50 ? "#38bdf8" : "#a7f3d0";
      const rect = L.rectangle(area.bounds, {
        color,
        weight: 2,
        opacity: 0.92,
        fillColor: color,
        fillOpacity: 0.07,
        dashArray: index === 0 ? "" : "8,6",
        interactive: true,
        className: "cg-interest-box"
      });
      rect.bindTooltip(`<strong>Priority Focus Area ${index + 1}</strong><br>${escapeHtml(area.label)}<br>${escapeHtml(area.reason)}`, {
        sticky: true,
        className: "cg-interest-tooltip"
      });
      rect.addTo(layers.focusAreas);
    });
  }

  function renderRecommendedFocusAreaList(areas) {
    if (!els["interest-zone-list"]) return;
    if (!areas || !areas.length) {
      setHtml("interest-zone-list", "No recommended focus area yet.");
      return;
    }
    const top = areas[0];
    const extra = areas.length > 1 ? ` +${areas.length - 1}` : "";
    // Intent가 입력돼 있으면 상위 구역이 의도와 매칭된 결과인지 표시해 준다.
    const hasIntent = getCommanderIntentKeywords().length > 0;
    const intentNote = !hasIntent ? "" : top.intentHits ? " · intent match" : " · no intent-matching contacts";
    setHtml("interest-zone-list", `<strong>Priority Focus Areas:</strong> ${escapeHtml(top.label)} (${escapeHtml(top.priority)}, ${top.count} contacts)${extra}${intentNote}`);
  }

  function slugifyFocusArea(value) {
    return String(value || "focus").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "focus";
  }

  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function buildDecisionOptions(event, events) {
    const focus = state.focusAreas[0] || null;
    const intent = getCommanderIntentText();
    if (!event) {
      return [
        { title: "Select Threat Candidate", body: "Select a top threat candidate to compute action priorities." },
        { title: "Enter Commander Intent", body: "Commander intent adds weight to focus areas and action priorities." },
        { title: "Check Focus Areas", body: focus ? `Monitor new contacts inside the ${focus.label} box first.` : "Priority focus area boxes appear on the map once threat candidates are visible." },
        { title: "Prepare Report", body: "Generate a threat report from the current filters and selected event." }
      ].map(renderDecisionCheckItem).join("");
    }

    const context = getEventContextLabel(event);
    const region = event.watch_area_name || event.region || "the operating area";
    const distance = formatDistance(event.distance_to_cable_nm);
    const isVeryHigh = event.risk_level === "Very High" || event.risk_score >= 70;
    const closeToCable = toNumber(event.distance_to_cable_nm) !== null && toNumber(event.distance_to_cable_nm) <= 3;
    const vessel = event.vessel_name || "Unknown";
    const focusText = focus ? `the ${focus.label} box` : `the ${region} area`;
    const intentText = intent ? "Commander intent applied" : "Default threat rules applied";

    return [
      { title: "Detect & Track", body: `Maintain track on ${vessel} ${event.risk_level} candidate at ${distance}. ${intentText}.`, checked: true },
      { title: "Re-correlate Sensors", body: `Re-correlate AIS, SAR/RF, Foundry, and OSINT evidence around ${context}. Keep as dark candidate if unmatched.` },
      { title: "Watch Focus Area", body: `Monitor new contacts, AIS gaps, and cable approaches inside ${focusText}.` },
      { title: isVeryHigh || closeToCable ? "Launch UAV/SAR" : "Hold Patrol Assets", body: isVeryHigh || closeToCable ? "Reinforce contact identification with UAV/SAR or maritime patrol assets." : "Keep patrol assets on standby and maintain track. Deploy on further indications." },
      { title: "Warning Broadcast", body: `Issue a VHF warning broadcast to ${vessel} and confirm the response.` },
      { title: "Request Adjacent Support", body: `Request coordinated response from coast guard and navy units covering ${region}.` },
      { title: "Disseminate Report", body: "Distribute the threat report to higher and adjacent commands via Export Threat Report." },
      { title: "Stand Down", body: "Return to routine surveillance once the threat is assessed as resolved." }
    ].map(renderDecisionCheckItem).join("");
  }

  // 지휘 조치 체크리스트 항목 (로컬/Kimi 공통). 상세 근거는 title 툴팁으로 제공.
  function renderDecisionCheckItem(option) {
    const title = option.title || option.label || "Action";
    const body = option.body || "";
    const saved = state.decisionChecks.get(`${state.selectedEventId || "none"}|${title}`);
    const checked = (saved !== undefined ? saved : Boolean(option.checked)) ? " checked" : "";
    return `<label class="cg-check-item"${body ? ` title="${escapeHtml(body)}"` : ""}><span>${escapeHtml(title)}</span><input type="checkbox"${checked}></label>`;
  }

  function setDecisionOptions(html) {
    setHtml("decision-options", html);
  }

  function applyAiDecisionResult(event, data) {
    setDecisionOptions(data.options.map(renderDecisionCheckItem).join(""));
    if (typeof data.briefing === "string" && data.briefing.trim()) {
      setText("ai-briefing-summary", data.briefing.trim());
    }
    if (data.provider && data.provider !== "local") {
      setText("decision-risk-label", `${event.risk_level} / ${event.risk_score} | ${String(data.provider).toUpperCase()}`);
    }
  }

  const AI_DECISION_CACHE_MS = 60000;

  function requestAiDecisionSupport(events, event) {
    if (!event || typeof fetch !== "function") return;
    // 라이브 갱신으로 대시보드가 다시 그려져도, 같은 이벤트에 대한 최근 AI 결과는 유지한다.
    const cacheKey = `${event.id}|${getCommanderIntentText()}`;
    state.aiDecisionKey = cacheKey;
    const cache = state.aiDecisionCache;
    if (cache && cache.key === cacheKey && (Date.now() - cache.at) < AI_DECISION_CACHE_MS) {
      applyAiDecisionResult(event, cache.data);
      return;
    }
    window.clearTimeout(state.aiDecisionTimer);
    const payload = {
      commander_intent: state.commanderIntent,
      summary: {
        visible: (events || []).length,
        very_high: (events || []).filter(item => item.risk_level === "Very High").length,
        high: (events || []).filter(item => item.risk_level === "High").length
      },
      selected_event: summarizeEventForAi(event),
      visible_events: (events || []).slice(0, 20).map(summarizeEventForAi),
      focus_areas: state.focusAreas
    };
    state.aiDecisionTimer = window.setTimeout(() => {
      fetch("/api/ai/decision-support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
          if (!data || !Array.isArray(data.options) || !data.options.length) return;
          state.aiDecisionCache = { key: cacheKey, at: Date.now(), data };
          // 응답이 도착했을 때 여전히 같은 이벤트/인텐트가 활성 상태일 때만 반영.
          if (state.aiDecisionKey !== cacheKey) return;
          applyAiDecisionResult(event, data);
        })
        .catch(() => {});
    }, 350);
  }

  function summarizeEventForAi(event) {
    return {
      id: event.id,
      vessel_name: event.vessel_name || "Unknown",
      mmsi: event.mmsi || null,
      event_type: event.event_type,
      risk_score: event.risk_score,
      risk_level: event.risk_level,
      lat: event.lat,
      lon: event.lon,
      watch_area_name: event.watch_area_name || null,
      region: event.region || null,
      nearest_cable: event.nearest_cable || null,
      distance_to_cable_nm: roundNumber(event.distance_to_cable_nm, 2),
      source: getSourceLabel(event),
      dark_vessel_status: event.dark_vessel_status || null,
      evidence: Array.isArray(event.evidence) ? event.evidence.slice(0, 5) : []
    };
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
        <td title="${escapeAttr(getSourceLabel(event))}">${escapeHtml(getSourceLabel(event))}</td>
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
      state.detailEventId = null;
      detail.innerHTML = "<div class=\"cg-detail-name\">No event selected</div><div class=\"cg-source-note\">Adjust filters or enable demo mode to view prioritization details.</div>";
      return;
    }

    // 같은 이벤트 재렌더링 시 작성 중인 리뷰 입력값(노트/리뷰어/상태)을 보존한다.
    const prevNotes = document.getElementById("review-notes");
    const prevReviewer = document.getElementById("reviewer-name");
    const prevStatus = document.getElementById("review-status");
    const preserved = state.detailEventId === event.id ? {
      notes: prevNotes ? prevNotes.value : null,
      reviewer: prevReviewer ? prevReviewer.value : null,
      status: prevStatus ? prevStatus.value : null
    } : null;

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
        ${detailKv("Source", getSourceLabel(event))}
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
    state.detailEventId = event.id;
    if (preserved) {
      const notesField = document.getElementById("review-notes");
      const reviewerField = document.getElementById("reviewer-name");
      const statusField = document.getElementById("review-status");
      if (notesField && preserved.notes !== null) notesField.value = preserved.notes;
      if (reviewerField && preserved.reviewer !== null) reviewerField.value = preserved.reviewer;
      if (statusField && preserved.status !== null) statusField.value = preserved.status;
    }
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

  function formatPatrolTasking(event) {
    if (!event || !event.patrol_tasking_status) return "None";
    const parts = [event.patrol_tasking_status, event.patrol_tasking_asset].filter(Boolean);
    if (event.patrol_tasking_updated_at) parts.push(formatTime(event.patrol_tasking_updated_at));
    return parts.join(" / ");
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
    setText("summary-dark", events.filter(event => ["dark_sar", "rf_dark", "sar_dark"].includes(event.event_type) || event.ais_status === "off").length);
    setText("summary-anomaly", events.filter(event => ["ais_loitering", "ais_gap", "encounter", "dragging_like", "live_ais_review", "rf_dark", "sar_dark"].includes(event.event_type)).length);
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
        // 접속 시 1회성 스냅샷은 즉시 반영 (초단위 스트림과 달리 입력 유실 위험 없음)
        data.vessels.forEach(vessel => ingestLiveVessel(vessel, { skipRefresh: true }));
        flushVesselMarkers();
        if (!isUserEditing()) refreshDashboard();
        else scheduleDashboardRefresh();
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
    state.dirtyVessels.set(normalized.mmsi, normalized);
    if (!options || !options.skipRefresh) scheduleDashboardRefresh();
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
    if (!options || !options.skipRefresh) scheduleDashboardRefresh();
  }

  function removeLiveReviewEvent(eventId, options) {
    if (!eventId) return;
    state.liveReviewEvents.delete(eventId);
    state.eventsById.delete(eventId);
    if (state.selectedEventId === eventId) state.selectedEventId = null;
    if (!options || !options.skipRefresh) scheduleDashboardRefresh();
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

  function getLiveAISMarkerRadius() {
    const zoom = typeof map !== "undefined" && typeof map.getZoom === "function" ? map.getZoom() : 8;
    if (zoom >= 12) return 3.8;
    if (zoom >= 10) return 4.6;
    if (zoom >= 8) return 5.4;
    return 6.2;
  }

  function getVesselAssessment(vessel) {
    const mmsi = vessel && vessel.mmsi != null ? String(vessel.mmsi) : "";
    const events = Array.from(state.liveReviewEvents.values())
      .filter(event => {
        if (!event || event.source !== "aisstream") return false;
        return [event.mmsi, event.vessel_id, event.counterparty_mmsi]
          .filter(value => value !== null && value !== undefined && value !== "")
          .some(value => String(value) === mmsi);
      })
      .sort((a, b) => Number(b.risk_score || 0) - Number(a.risk_score || 0));

    if (!events.length) {
      return {
        className: "neutral",
        events,
        label: "No active risk event"
      };
    }

    const top = events[0];
    return {
      className: top.risk_level === "Very High" || top.risk_level === "High" ? "hot" : "watch",
      events,
      label: `${top.risk_level || "Review"} risk event (${Number(top.risk_score || 0)})`
    };
  }

  function getLiveAISMarkerStyle(vessel) {
    const assessment = getVesselAssessment(vessel);
    const activeRisk = assessment.events.length > 0;
    return {
      radius: getLiveAISMarkerRadius(),
      color: activeRisk ? "rgba(250, 204, 21, 0.94)" : "rgba(205, 230, 255, 0.82)",
      fillColor: activeRisk ? "#f59e0b" : "#60a5fa",
      fillOpacity: activeRisk ? 0.82 : 0.58,
      opacity: 0.88,
      weight: activeRisk ? 2 : 1.2,
      className: "live-ais-dot"
    };
  }

  function buildLiveVesselInfo(vessel) {
    const assessment = getVesselAssessment(vessel);
    const watchArea = vessel.watch_area_name
      ? `<div class="pr"><span class="pl">Watch area:</span>${escapeHtml(vessel.watch_area_name)}</div>`
      : "";
    return `<div class="cg-popup cg-vessel-popup">
      <div class="cg-tooltip-head">
        <div class="pt">${escapeHtml(vessel.vessel_name || "Unknown")}</div>
        <button class="cg-vessel-close" type="button" aria-label="Close vessel info" data-live-vessel-close>&times;</button>
      </div>
      <div class="pr"><span class="pl">Contact:</span>Live AIS</div>
      <div class="pr"><span class="pl">Assessment:</span><span class="cg-vessel-assessment ${assessment.className}">${escapeHtml(assessment.label)}</span></div>
      <div class="pr"><span class="pl">MMSI:</span>${escapeHtml(vessel.mmsi)}</div>
      <div class="pr"><span class="pl">SOG:</span>${formatSpeed(vessel.sog)}</div>
      <div class="pr"><span class="pl">COG:</span>${formatHeading(vessel.cog)}</div>
      ${watchArea}
      <div class="pr"><span class="pl">Time:</span>${escapeHtml(formatTime(vessel.timestamp))}</div>
      <div class="pr"><span class="pl">Source:</span>AISStream</div>
    </div>`;
  }

  function bindLiveVesselInfoControls() {
    const element = state.liveVesselInfo && state.liveVesselInfo.getElement
      ? state.liveVesselInfo.getElement()
      : null;
    if (!element) return;
    L.DomEvent.disableClickPropagation(element);
    const closeButton = element.querySelector("[data-live-vessel-close]");
    if (closeButton) {
      L.DomEvent.disableClickPropagation(closeButton);
      L.DomEvent.on(closeButton, "click", closeLiveVesselInfo);
    }
  }

  function closeLiveVesselInfo() {
    if (state.liveVesselInfo && typeof map !== "undefined") {
      map.removeLayer(state.liveVesselInfo);
    }
    state.liveVesselInfo = null;
    state.liveVesselInfoMmsi = null;
  }

  function openLiveVesselInfo(vessel, latlng) {
    if (!vessel || typeof L === "undefined" || typeof map === "undefined") return;
    closeLiveVesselInfo();
    state.liveVesselInfo = L.tooltip({
      className: "cg-vessel-tooltip",
      direction: "auto",
      interactive: true,
      offset: [14, 0],
      opacity: 1,
      permanent: true
    })
      .setLatLng(latlng || [vessel.lat, vessel.lon])
      .setContent(buildLiveVesselInfo(vessel))
      .addTo(map);
    state.liveVesselInfoMmsi = vessel.mmsi;
    bindLiveVesselInfoControls();
  }

  function updateOpenLiveVesselInfo(vessel) {
    if (!state.liveVesselInfo || state.liveVesselInfoMmsi !== vessel.mmsi) return;
    state.liveVesselInfo
      .setLatLng([vessel.lat, vessel.lon])
      .setContent(buildLiveVesselInfo(vessel));
    bindLiveVesselInfoControls();
  }

  function updateLiveAISMarkerScale() {
    state.liveMarkers.forEach((marker, mmsi) => {
      const vessel = state.liveVessels.get(mmsi);
      if (vessel && marker && typeof marker.setStyle === "function") {
        marker.setStyle(getLiveAISMarkerStyle(vessel));
      }
    });
  }

  function renderLiveAISMarker(vessel) {
    if (!layers.liveAIS) return;
    const existing = state.liveMarkers.get(vessel.mmsi);
    const style = getLiveAISMarkerStyle(vessel);

    if (existing) {
      existing.setLatLng([vessel.lat, vessel.lon]);
      existing.setStyle(style);
      updateOpenLiveVesselInfo(vessel);
      return;
    }

    const marker = L.circleMarker([vessel.lat, vessel.lon], Object.assign({
      bubblingMouseEvents: false,
      interactive: true
    }, style));

    marker.on("click", event => {
      if (event.originalEvent) L.DomEvent.stop(event.originalEvent);
      const current = state.liveVessels.get(vessel.mmsi) || vessel;
      marker.bringToFront();
      openLiveVesselInfo(current, event.latlng || [current.lat, current.lon]);
    });
    marker.on("mouseover", () => marker.bringToFront());
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
      rf_matched: event.rf_matched ?? null,
      sar_matched: event.sar_matched ?? null,
      dark_vessel_status: event.dark_vessel_status || "unknown",
      detection_ids: Array.isArray(event.detection_ids) ? event.detection_ids : [],
      vessel_name: event.vessel_name,
      mmsi: event.mmsi,
      imo: event.imo || null,
      flag: event.flag || null,
      owner: event.owner || null,
      origin_port: event.origin_port || null,
      destination_port: event.destination_port || null,
      eta: event.eta || null,
      last_korea_visit_at: event.last_korea_visit_at || null,
      is_sanctioned: event.is_sanctioned ?? null,
      sanctions_status: event.sanctions_status || null,
      sanctions_list: Array.isArray(event.sanctions_list) ? event.sanctions_list : [],
      crew_count: event.crew_count ?? null,
      crew_nationality: event.crew_nationality || null,
      crew_summary: event.crew_summary || null,
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
      commander_intent: state.commanderIntent,
      recommended_focus_areas: state.focusAreas,
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

  async function loadFoundryEvents() {
    if (!location.protocol.startsWith("http")) return;
    try {
      const response = await fetch("/api/foundry/events", { cache: "no-store" });
      if (!response.ok) return;                  // 503(미설정) 등은 조용히 스킵 - 데모 모드 유지
      const data = await response.json();
      state.foundryEvents.clear();
      (data.events || []).forEach(item => {
        const enriched = enrichFoundryEvent(item);
        state.foundryEvents.set(enriched.id, enriched);
      });
      refreshDashboard();
    } catch (error) {
      // 네트워크/미설정: 무시
    }
  }

  function getSourceLabel(event) {
    if (event && event.source_system === "foundry-osdk") return "Foundry (persisted)";
    return sourceLabels[event.source] || event.source || "Unknown";
  }

  function getCandidateEventCount() {
    let count = 0;
    if (state.demoMode && state.showSynthetic) count += state.syntheticEvents.length;
    if (state.showLiveAIS) count += state.liveReviewEvents.size;
    if (state.showFoundry) count += state.foundryEvents.size;
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
