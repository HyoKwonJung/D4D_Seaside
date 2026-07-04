"""
correlation.py — ★키스톤★ AIS 트랙 ↔ 비-AIS 탐지(RF/SAR) 시공간 상관.

이 프로젝트의 핵심 관문. "이 RF/SAR 탐지가 알려진 AIS 선박과 매칭되는가?"를 판정해
매칭되면 해당 Vessel에 귀속(설명가능·저위험), 미매칭이면 잠재 다크 베슬로 승격한다.

기존 cableguard-domain.js의 sar_matched 패턴을 일반화:
    매칭 게이트 내 AIS 존재  → matched  (dark_vessel_status = ais-matched)
    게이트 내 AIS 없음       → 미매칭    (dark_vessel_status = rf-only / sar-only)

순수 함수(테스트 가능) + 하단에 Foundry PySpark 래퍼.
Phase 0에서는 detections 로 '합성 dark_sar 이벤트'를 넣어 이 로직을 검증한다.
"""

import math

EARTH_RADIUS_NM = 3440.065

# --- 매칭 게이트 파라미터 (튜닝 대상) --------------------------------------
# 탐지 위치와 AIS 보간 위치가 이 반경 & 시간창 안에 있으면 "같은 선박"으로 간주.
# 값이 크면 오매칭(다크 놓침), 작으면 과탐(정상 선박을 다크로). 센서 정밀도에 맞춰 조정.
MATCH_RADIUS_NM = {
    "rf": 2.0,    # RF 지오로케이션 오차 큼 → 넉넉
    "sar": 0.5,   # SAR 위치 정밀 → 타이트
    "optical": 0.3,
}
MATCH_TIME_WINDOW_S = {
    "rf": 30 * 60,
    "sar": 15 * 60,
    "optical": 10 * 60,
}
DEFAULT_MATCH_RADIUS_NM = 1.0
DEFAULT_MATCH_TIME_WINDOW_S = 20 * 60

# 무-AIS 탐지들을 하나의 다크 트랙으로 묶는 클러스터 반경/시간
DARK_CLUSTER_RADIUS_NM = 3.0
DARK_CLUSTER_TIME_S = 60 * 60


def haversine_nm(lat1, lon1, lat2, lon2):
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2)
    return 2 * EARTH_RADIUS_NM * math.asin(math.sqrt(a))


def _epoch_seconds(ts):
    """ISO8601 문자열 또는 epoch(초/ms)를 초 단위 float로."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return float(ts) / 1000.0 if ts > 1e12 else float(ts)
    try:
        from datetime import datetime
        s = str(ts).replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def interpolate_ais_position(track, target_ts):
    """AIS 트랙(시간순 [{lat,lon,timestamp}, ...])에서 target 시각의 위치를 선형 보간."""
    target = _epoch_seconds(target_ts)
    if not track or target is None:
        return None
    pts = []
    for p in track:
        t = _epoch_seconds(p.get("timestamp"))
        if t is not None and p.get("lat") is not None and p.get("lon") is not None:
            pts.append((t, float(p["lat"]), float(p["lon"])))
    if not pts:
        return None
    pts.sort(key=lambda x: x[0])
    if target <= pts[0][0]:
        return (pts[0][1], pts[0][2])
    if target >= pts[-1][0]:
        return (pts[-1][1], pts[-1][2])
    for i in range(1, len(pts)):
        t0, la0, lo0 = pts[i - 1]
        t1, la1, lo1 = pts[i]
        if t0 <= target <= t1:
            f = 0 if t1 == t0 else (target - t0) / (t1 - t0)
            return (la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f)
    return (pts[-1][1], pts[-1][2])


def match_detection_to_ais(detection, ais_tracks):
    """
    단일 탐지를 AIS 트랙들과 매칭.
    detection: {source, lat, lon, detected_at, ...}
    ais_tracks: { mmsi: [ {lat, lon, timestamp}, ... ] }
    반환: 매칭 정보가 채워진 detection dict.
    """
    src = detection.get("source", "rf")
    radius = MATCH_RADIUS_NM.get(src, DEFAULT_MATCH_RADIUS_NM)
    window = MATCH_TIME_WINDOW_S.get(src, DEFAULT_MATCH_TIME_WINDOW_S)
    det_ts = _epoch_seconds(detection.get("detected_at"))
    lat, lon = detection.get("lat"), detection.get("lon")

    best = None  # (distance_nm, mmsi, time_delta_s)
    if lat is not None and lon is not None and det_ts is not None:
        for mmsi, track in (ais_tracks or {}).items():
            pos = interpolate_ais_position(track, detection.get("detected_at"))
            if pos is None:
                continue
            # 시간창: 트랙이 탐지 시각을 커버하는지(가장 가까운 포인트 시간차)
            nearest_dt = min(
                (abs(det_ts - _epoch_seconds(p.get("timestamp")))
                 for p in track if _epoch_seconds(p.get("timestamp")) is not None),
                default=None,
            )
            if nearest_dt is None or nearest_dt > window:
                continue
            dist = haversine_nm(lat, lon, pos[0], pos[1])
            if dist <= radius and (best is None or dist < best[0]):
                best = (dist, mmsi, nearest_dt)

    out = dict(detection)
    if best is not None:
        out["matched_mmsi"] = best[1]
        out["match_distance_nm"] = round(best[0], 3)
        out["match_time_delta_s"] = round(best[2], 1)
        out["dark_candidate"] = False
    else:
        out["matched_mmsi"] = None
        out["match_distance_nm"] = None
        out["match_time_delta_s"] = None
        out["dark_candidate"] = src != "ais"
    return out


def resolve_dark_status(detection):
    """미매칭 탐지의 dark_vessel_status 산출 (단일 탐지 기준)."""
    if not detection.get("dark_candidate"):
        return "ais-matched"
    src = detection.get("source")
    if src == "rf":
        return "rf-only"
    if src == "sar":
        return "sar-only"
    if src == "optical":
        return "optical-only"
    return "unknown"


def correlate(detections, ais_tracks):
    """
    탐지 리스트 전체를 상관 → 매칭 정보 + dark_vessel_status 채워 반환.
    이후 clustering 으로 rf-only + sar-only 가 같은 지점이면 multi-sensor 로 승격.
    """
    matched = [match_detection_to_ais(d, ais_tracks) for d in (detections or [])]
    for d in matched:
        d["dark_vessel_status"] = resolve_dark_status(d)

    darks = [d for d in matched if d.get("dark_candidate")]
    for i, a in enumerate(darks):
        at = _epoch_seconds(a.get("detected_at"))
        for b in darks[i + 1:]:
            if a.get("source") == b.get("source"):
                continue
            bt = _epoch_seconds(b.get("detected_at"))
            if at is None or bt is None or abs(at - bt) > DARK_CLUSTER_TIME_S:
                continue
            if (a.get("lat") is None or b.get("lat") is None):
                continue
            if haversine_nm(a["lat"], a["lon"], b["lat"], b["lon"]) <= DARK_CLUSTER_RADIUS_NM:
                a["dark_vessel_status"] = "multi-sensor"
                b["dark_vessel_status"] = "multi-sensor"
    return matched


def detection_to_event(detection, nearest_cable=None):
    """미매칭(다크) 탐지를 Event dict로 승격 (scoring.py enrich_event 입력용)."""
    src = detection.get("source")
    event_type = "rf_dark" if src == "rf" else "sar_dark" if src == "sar" else "dark_sar"
    return {
        "id": f"DARK-{str(src).upper()}-{detection.get('detection_id') or detection.get('external_id')}",
        "source": src,
        "synthetic": bool(detection.get("synthetic")),
        "event_type": event_type,
        "vessel_id": None,
        "mmsi": None,
        "vessel_name": "Unknown (dark contact)",
        "lat": detection.get("lat"),
        "lon": detection.get("lon"),
        "timestamp": detection.get("detected_at"),
        "occurred_at": detection.get("detected_at"),
        "ais_status": "off",
        "sar_matched": (False if src == "sar" else None),
        "rf_matched": (False if src == "rf" else None),
        "dark_vessel_status": detection.get("dark_vessel_status", "unknown"),
        "distance_to_cable_nm": (nearest_cable or {}).get("distance_nm"),
        "nearest_cable": (nearest_cable or {}).get("name"),
        "nearest_cable_id": (nearest_cable or {}).get("id"),
        "review_status": "unverified",
        "scoring_version": "v1",
        "evidence": [],
    }


# ---------------------------------------------------------------------------
# Foundry PySpark 래퍼 (개요)
# ---------------------------------------------------------------------------
# 대규모에서는 detections × ais_positions 를 시공간 버킷(geohash + time bucket)으로
# 조인해 후보를 좁힌 뒤 위 게이트를 적용한다(전체 cross join 회피). dev tier에서는
# 저볼륨이므로 아래처럼 groupBy 수집 후 UDF로 충분.
#
# from transforms.api import transform_df, Input, Output
# from pyspark.sql import functions as F, types as T
#
# @transform_df(
#     Output("<correlated_detections_rid>"),
#     detections=Input("<normalized_detections_rid>"),   # ingestion_adapters.py 출력
#     ais=Input("<ais_snapshot_rid>"),                   # Node 브릿지가 push
# )
# def compute(detections, ais):
#     tracks = (ais.groupBy("mmsi")
#                  .agg(F.collect_list(F.struct("lat", "lon", "timestamp")).alias("track")))
#     # detections 를 driver로 모으거나(저볼륨), geohash 버킷 조인 후 mapPartitions 로 correlate() 적용.
#     ...
