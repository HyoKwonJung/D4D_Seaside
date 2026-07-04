window.SYNTHETIC_EVENTS = [
  {
    id: "EVT-DARK-JEJU-001",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "dark_sar_jeju",
    event_type: "dark_sar",
    vessel_id: "UNKNOWN-SAR-001",
    vessel_name: "Unknown",
    mmsi: null,
    lat: 33.47,
    lon: 126.88,
    timestamp: "2026-07-04T03:20:00Z",
    duration_h: null,
    speed_kn: null,
    heading_deg: null,
    distance_to_cable_nm: 0.8,
    nearest_cable: "Jeju-Udo",
    region: "Jeju",
    ais_status: "off",
    sar_matched: false,
    description: "SAR-like contact without AIS match near Jeju-Udo cable route.",
    evidence: [
      "SAR-like detection has no matching AIS contact.",
      "Detected within 0.8 nm of submarine cable route.",
      "AIS status unknown/off in the immediate area."
    ]
  },
  {
    id: "EVT-DARK-JEJU-002",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "dark_sar_jeju_mainland",
    event_type: "dark_sar",
    vessel_id: "UNKNOWN-SAR-002",
    vessel_name: "Unknown",
    mmsi: null,
    lat: 33.59,
    lon: 127.06,
    timestamp: "2026-07-04T04:05:00Z",
    duration_h: null,
    speed_kn: null,
    heading_deg: null,
    distance_to_cable_nm: 2.4,
    nearest_cable: "Jeju-Mainland 2",
    region: "Jeju",
    ais_status: "off",
    sar_matched: false,
    description: "Second unmatched SAR-like contact north-east of Jeju cable convergence.",
    evidence: [
      "No matching AIS track within the synthetic detection window.",
      "Located inside a 3 nm review zone for Jeju-Mainland cable routes."
    ]
  },
  {
    id: "EVT-LOITER-BUSAN-001",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "ais_loitering_busan_geoje",
    event_type: "ais_loitering",
    vessel_id: "SYN-LOITER-001",
    vessel_name: "MV Demo Loiter",
    mmsi: "999000001",
    lat: 35.05,
    lon: 128.95,
    timestamp: "2026-07-04T05:30:00Z",
    duration_h: 5.2,
    speed_kn: 1.3,
    heading_deg: 68,
    distance_to_cable_nm: 1.8,
    nearest_cable: "FLAG North Asia Loop/REACH North Asia Loop",
    region: "Busan-Geoje",
    ais_status: "on",
    sar_matched: null,
    description: "AIS-on vessel loitering at low speed near Busan/Geoje cable approach.",
    evidence: [
      "Low-speed AIS movement remained near the same cable approach for over 5 hours.",
      "Track stayed within 3 nm of a submarine cable route."
    ]
  },
  {
    id: "EVT-LOITER-GEOJE-002",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "ais_loitering_geoje_review",
    event_type: "ais_loitering",
    vessel_id: "SYN-LOITER-002",
    vessel_name: "MT Demo Holding",
    mmsi: "999000002",
    lat: 34.73,
    lon: 128.36,
    timestamp: "2026-07-04T06:15:00Z",
    duration_h: 3.0,
    speed_kn: 1.8,
    heading_deg: 112,
    distance_to_cable_nm: 3.4,
    nearest_cable: "Jeju-Mainland 3",
    region: "Busan-Geoje",
    ais_status: "on",
    sar_matched: null,
    description: "Slow holding pattern south-west of Geoje, outside the closest warning ring.",
    evidence: [
      "AIS track shows repeated turns at low speed.",
      "Nearest cable is outside 3 nm but inside a 5 nm watch zone."
    ]
  },
  {
    id: "EVT-GAP-WEST-001",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "ais_gap_gunsan",
    event_type: "ais_gap",
    vessel_id: "SYN-GAP-001",
    vessel_name: "MV Demo Gap",
    mmsi: "999000003",
    lat: 35.78,
    lon: 126.28,
    timestamp: "2026-07-04T02:45:00Z",
    duration_h: 2.6,
    speed_kn: 8.2,
    heading_deg: 42,
    distance_to_cable_nm: 2.7,
    nearest_cable: "Asia United Gateway East (AUG East)",
    region: "West Sea",
    ais_status: "intermittent",
    sar_matched: null,
    description: "AIS gap near the planned Gunsan cable branch of AUG East.",
    evidence: [
      "AIS transmission gap bracketed a planned cable corridor.",
      "Last and next known positions imply transit across a cable review area."
    ]
  },
  {
    id: "EVT-GAP-WEST-002",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "ais_gap_west_medium",
    event_type: "ais_gap",
    vessel_id: "SYN-GAP-002",
    vessel_name: "MV Demo West Transit",
    mmsi: "999000004",
    lat: 36.15,
    lon: 125.72,
    timestamp: "2026-07-04T07:00:00Z",
    duration_h: 1.4,
    speed_kn: 10.5,
    heading_deg: 30,
    distance_to_cable_nm: 6.8,
    nearest_cable: "Asia United Gateway East (AUG East)",
    region: "West Sea",
    ais_status: "intermittent",
    sar_matched: null,
    description: "Short intermittent AIS gap farther from the planned Gunsan cable route.",
    evidence: [
      "AIS was intermittent, but the closest cable is outside the 5 nm watch zone."
    ]
  },
  {
    id: "EVT-ENCOUNTER-KS-001",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "encounter_korea_strait",
    event_type: "encounter",
    vessel_id: "SYN-PAIR-001",
    vessel_name: "MV Demo Pair A / FV Demo Pair B",
    mmsi: "999000005, 999000006",
    lat: 34.82,
    lon: 129.12,
    timestamp: "2026-07-04T08:10:00Z",
    duration_h: 1.7,
    speed_kn: 0.9,
    heading_deg: 205,
    distance_to_cable_nm: 3.2,
    nearest_cable: "JAKO",
    region: "Korea Strait",
    ais_status: "on",
    sar_matched: null,
    description: "Two AIS-on vessels remained close at low speed near a cable route.",
    evidence: [
      "Two vessels remained within a close encounter envelope for around 1.7 hours.",
      "Encounter centroid is inside the 5 nm cable watch zone."
    ]
  },
  {
    id: "EVT-ENCOUNTER-KS-002",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "encounter_korea_strait_far",
    event_type: "encounter",
    vessel_id: "SYN-PAIR-002",
    vessel_name: "MV Demo Pair C / MV Demo Pair D",
    mmsi: "999000007, 999000008",
    lat: 34.55,
    lon: 130.15,
    timestamp: "2026-07-04T09:00:00Z",
    duration_h: 1.1,
    speed_kn: 2.0,
    heading_deg: 175,
    distance_to_cable_nm: 8.5,
    nearest_cable: "JAKO",
    region: "Korea Strait",
    ais_status: "on",
    sar_matched: null,
    description: "Short low-speed encounter farther from a cable corridor.",
    evidence: [
      "Close encounter observed, but farther from the nearest submarine cable."
    ]
  },
  {
    id: "EVT-DRAG-BUSAN-001",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "dragging_like_busan",
    event_type: "dragging_like",
    vessel_id: "SYN-DRAG-001",
    vessel_name: "MV Demo Slow Tow",
    mmsi: "999000009",
    lat: 35.13,
    lon: 129.03,
    timestamp: "2026-07-04T01:50:00Z",
    duration_h: 2.2,
    speed_kn: 2.5,
    heading_deg: 138,
    distance_to_cable_nm: 0.9,
    nearest_cable: "APCN-2",
    region: "Busan-Geoje",
    ais_status: "on",
    sar_matched: null,
    description: "Slow, stable-heading movement roughly aligned with a cable approach.",
    evidence: [
      "Movement speed and heading stability are compatible with cable-risk dragging behavior.",
      "Track is inside 1 nm of a submarine cable route."
    ]
  },
  {
    id: "EVT-DRAG-ULLEUNG-001",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "dragging_like_ulleung",
    event_type: "dragging_like",
    vessel_id: "SYN-DRAG-002",
    vessel_name: "MV Demo East Creep",
    mmsi: "999000010",
    lat: 37.34,
    lon: 130.31,
    timestamp: "2026-07-04T10:25:00Z",
    duration_h: 1.4,
    speed_kn: 2.8,
    heading_deg: 86,
    distance_to_cable_nm: 2.2,
    nearest_cable: "Ulleung-Mainland 2",
    region: "Ulleung",
    ais_status: "on",
    sar_matched: null,
    description: "Slow eastbound movement near the Ulleung-mainland cable corridor.",
    evidence: [
      "Movement is slow and aligned with a cable corridor.",
      "Event is within 3 nm of the nearest submarine cable."
    ]
  },
  {
    id: "EVT-DARK-FAR-001",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "dark_contact_far",
    event_type: "dark_sar",
    vessel_id: "UNKNOWN-SAR-003",
    vessel_name: "Unknown",
    mmsi: null,
    lat: 35.95,
    lon: 129.72,
    timestamp: "2026-07-04T11:15:00Z",
    duration_h: null,
    speed_kn: null,
    heading_deg: null,
    distance_to_cable_nm: 9.5,
    nearest_cable: "Ulleung-Mainland 2",
    region: "Ulleung",
    ais_status: "unknown",
    sar_matched: true,
    description: "Lower-priority dark-contact style reference away from cable corridors.",
    evidence: [
      "Contact is outside the 5 nm cable watch zone.",
      "Synthetic matching context reduces immediate priority."
    ]
  },
  // {
  //   id: "EVT-LOITER-FAR-001",
  //   source: "synthetic_injection",
  //   synthetic: true,
  //   scenario_id: "loitering_far_reference",
  //   event_type: "ais_loitering",
  //   vessel_id: "SYN-LOITER-003",
  //   vessel_name: "FV Demo Waiting",
  //   mmsi: "999000011",
  //   lat: 35.62,
  //   lon: 127.92,
  //   timestamp: "2026-07-04T12:00:00Z",
  //   duration_h: 5.0,
  //   speed_kn: 1.5,
  //   heading_deg: 315,
  //   distance_to_cable_nm: 10.0,
  //   nearest_cable: "Jeju-Mainland 3",
  //   region: "Busan-Geoje",
  //   ais_status: "on",
  //   sar_matched: null,
  //   description: "Loitering reference case farther from cable corridors.",
  //   evidence: [
  //     "Low-speed loitering is present, but the nearest cable is outside the watch zone."
  //   ]
  // },
  {
    id: "EVT-LIVE-REF-001",
    source: "synthetic_injection",
    synthetic: true,
    scenario_id: "normal_live_ais_reference",
    event_type: "live_ais_review",
    vessel_id: "SYN-LIVE-REF-001",
    vessel_name: "MV Demo Normal Transit",
    mmsi: "999000012",
    lat: 35.31,
    lon: 129.42,
    timestamp: "2026-07-04T12:20:00Z",
    duration_h: 0.3,
    speed_kn: 12.6,
    heading_deg: 92,
    distance_to_cable_nm: 7.2,
    nearest_cable: "APCN-2",
    region: "Busan-Geoje",
    ais_status: "on",
    sar_matched: null,
    description: "Normal-looking AIS transit included as a low-risk comparison event.",
    evidence: [
      "Synthetic reference vessel is moving normally outside the cable watch zone."
    ]
  }
];

window.SYNTHETIC_TRACKS = [
  {
    vessel_id: "SYN-LOITER-001",
    vessel_name: "MV Demo Loiter",
    mmsi: "999000001",
    track_type: "loitering",
    related_event_id: "EVT-LOITER-BUSAN-001",
    coordinates: [
      [128.91, 35.03, "2026-07-04T00:30:00Z", 1.4],
      [128.96, 35.06, "2026-07-04T01:20:00Z", 1.2],
      [128.93, 35.08, "2026-07-04T02:15:00Z", 1.1],
      [128.99, 35.04, "2026-07-04T03:10:00Z", 1.5],
      [128.95, 35.05, "2026-07-04T05:30:00Z", 1.3]
    ]
  },
  {
    vessel_id: "SYN-LOITER-002",
    vessel_name: "MT Demo Holding",
    mmsi: "999000002",
    track_type: "loitering",
    related_event_id: "EVT-LOITER-GEOJE-002",
    coordinates: [
      [128.31, 34.71, "2026-07-04T03:00:00Z", 2.1],
      [128.37, 34.76, "2026-07-04T04:00:00Z", 1.7],
      [128.34, 34.78, "2026-07-04T05:00:00Z", 1.6],
      [128.36, 34.73, "2026-07-04T06:15:00Z", 1.8]
    ]
  },
  {
    vessel_id: "SYN-GAP-001",
    vessel_name: "MV Demo Gap",
    mmsi: "999000003",
    track_type: "ais_gap",
    related_event_id: "EVT-GAP-WEST-001",
    coordinates: [
      [125.92, 35.48, "2026-07-04T00:15:00Z", 9.0],
      [126.06, 35.58, "2026-07-04T00:45:00Z", 8.5],
      [126.24, 35.74, "2026-07-04T03:20:00Z", 8.2],
      [126.43, 35.88, "2026-07-04T03:55:00Z", 8.7]
    ]
  },
  {
    vessel_id: "SYN-GAP-002",
    vessel_name: "MV Demo West Transit",
    mmsi: "999000004",
    track_type: "ais_gap",
    related_event_id: "EVT-GAP-WEST-002",
    coordinates: [
      [125.28, 35.91, "2026-07-04T05:40:00Z", 10.3],
      [125.50, 36.03, "2026-07-04T06:05:00Z", 10.9],
      [125.72, 36.15, "2026-07-04T07:00:00Z", 10.5],
      [125.96, 36.28, "2026-07-04T07:25:00Z", 10.6]
    ]
  },
  {
    vessel_id: "SYN-PAIR-001-A",
    vessel_name: "MV Demo Pair A",
    mmsi: "999000005",
    track_type: "encounter",
    related_event_id: "EVT-ENCOUNTER-KS-001",
    coordinates: [
      [128.98, 34.88, "2026-07-04T06:40:00Z", 6.2],
      [129.08, 34.84, "2026-07-04T07:20:00Z", 1.1],
      [129.12, 34.82, "2026-07-04T08:10:00Z", 0.8],
      [129.20, 34.79, "2026-07-04T09:00:00Z", 4.5]
    ]
  },
  {
    vessel_id: "SYN-PAIR-001-B",
    vessel_name: "FV Demo Pair B",
    mmsi: "999000006",
    track_type: "encounter",
    related_event_id: "EVT-ENCOUNTER-KS-001",
    coordinates: [
      [129.27, 34.70, "2026-07-04T06:45:00Z", 5.9],
      [129.18, 34.78, "2026-07-04T07:25:00Z", 1.2],
      [129.12, 34.82, "2026-07-04T08:10:00Z", 1.0],
      [129.06, 34.90, "2026-07-04T09:05:00Z", 4.2]
    ]
  },
  {
    vessel_id: "SYN-PAIR-002",
    vessel_name: "MV Demo Pair C / MV Demo Pair D",
    mmsi: "999000007",
    track_type: "encounter",
    related_event_id: "EVT-ENCOUNTER-KS-002",
    coordinates: [
      [130.05, 34.50, "2026-07-04T08:05:00Z", 2.3],
      [130.15, 34.55, "2026-07-04T09:00:00Z", 2.0],
      [130.28, 34.58, "2026-07-04T09:45:00Z", 3.8]
    ]
  },
  {
    vessel_id: "SYN-DRAG-001",
    vessel_name: "MV Demo Slow Tow",
    mmsi: "999000009",
    track_type: "dragging_like",
    related_event_id: "EVT-DRAG-BUSAN-001",
    coordinates: [
      [128.98, 35.19, "2026-07-04T00:00:00Z", 2.6],
      [129.00, 35.16, "2026-07-04T00:35:00Z", 2.5],
      [129.03, 35.13, "2026-07-04T01:10:00Z", 2.5],
      [129.06, 35.10, "2026-07-04T01:50:00Z", 2.4]
    ]
  },
  {
    vessel_id: "SYN-DRAG-002",
    vessel_name: "MV Demo East Creep",
    mmsi: "999000010",
    track_type: "dragging_like",
    related_event_id: "EVT-DRAG-ULLEUNG-001",
    coordinates: [
      [130.10, 37.32, "2026-07-04T09:00:00Z", 2.7],
      [130.20, 37.33, "2026-07-04T09:35:00Z", 2.8],
      [130.31, 37.34, "2026-07-04T10:25:00Z", 2.8],
      [130.42, 37.36, "2026-07-04T10:55:00Z", 2.9]
    ]
  },
  // {
  //   vessel_id: "SYN-LOITER-003",
  //   vessel_name: "FV Demo Waiting",
  //   mmsi: "999000011",
  //   track_type: "normal",
  //   related_event_id: "EVT-LOITER-FAR-001",
  //   coordinates: [
  //     [127.86, 35.58, "2026-07-04T08:00:00Z", 1.6],
  //     [127.91, 35.62, "2026-07-04T09:30:00Z", 1.4],
  //     [127.87, 35.66, "2026-07-04T10:50:00Z", 1.7],
  //     [127.92, 35.62, "2026-07-04T12:00:00Z", 1.5]
  //   ]
  // },
  {
    vessel_id: "SYN-LIVE-REF-001",
    vessel_name: "MV Demo Normal Transit",
    mmsi: "999000012",
    track_type: "normal",
    related_event_id: "EVT-LIVE-REF-001",
    coordinates: [
      [128.95, 35.28, "2026-07-04T11:30:00Z", 12.1],
      [129.18, 35.30, "2026-07-04T11:55:00Z", 12.4],
      [129.42, 35.31, "2026-07-04T12:20:00Z", 12.6],
      [129.68, 35.32, "2026-07-04T12:45:00Z", 12.5]
    ]
  }
];
