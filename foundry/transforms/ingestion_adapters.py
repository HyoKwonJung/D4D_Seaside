"""
ingestion_adapters.py — 소스별 원시 응답 → 공통 Detection 스키마 정규화.

각 어댑터는 소스 1레코드(dict)를 받아 아래 CANONICAL Detection dict를 반환한다.
correlation.py 는 이 공통 스키마만 알면 되므로, 새 소스를 붙일 때 여기에 어댑터만 추가.

Phase 1~3에서 실제 API 응답을 받으면 각 함수의 TODO(필드 매핑)만 채우면 된다.
응답 스키마가 확정되기 전이므로, 매핑은 문서화된 필드 추정 + TODO로 표시.
"""

from datetime import datetime, timezone

# --- 공통 Detection 스키마 -------------------------------------------------
# detection_id, source, provider, detected_at(ISO8601), lat, lon,
# confidence, external_id, raw_payload_json, synthetic


def _iso(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        sec = ts / 1000.0 if ts > 1e12 else ts
        return datetime.fromtimestamp(sec, tz=timezone.utc).isoformat()
    return str(ts)


def _canonical(source, provider, external_id, detected_at, lat, lon,
               confidence=None, raw=None, synthetic=False):
    return {
        "detection_id": f"{source}:{external_id}",
        "source": source,
        "provider": provider,
        "external_id": str(external_id),
        "detected_at": _iso(detected_at),
        "lat": float(lat) if lat is not None else None,
        "lon": float(lon) if lon is not None else None,
        "confidence": confidence,
        "raw_payload_json": raw,
        "synthetic": bool(synthetic),
    }


# --- Phase 0: 합성 dark_sar 이벤트 → SAR 탐지 대역 -------------------------
def normalize_synthetic_dark(event):
    """
    public/data/synthetic_injections.js 의 dark_sar 이벤트를 SAR 탐지처럼 취급.
    Phase 0에서 상관 엔진을 실데이터 없이 검증하기 위한 브릿지.
    """
    return _canonical(
        source="sar",
        provider="synthetic",
        external_id=event.get("id"),
        detected_at=event.get("timestamp"),
        lat=event.get("lat"),
        lon=event.get("lon"),
        confidence=None,
        raw=event,
        synthetic=True,
    )


# --- Phase 1: Global Fishing Watch SAR 탐지 (4Wings public-global-sar-presence) --
def normalize_gfw_sar(record):
    """
    GFW SAR presence (4Wings report). GFW가 이미 AIS 매칭(matched)을 계산해준다.
    필드(확인됨): lat, lon(셀 중심), date, detections(count), matched(bool),
                 matched 시 mmsi/vesselId/shipName/imo/flag.
    matched=false 로 조회하면 다크 탐지가 바로 나오므로 correlation은 2차 검증.
    주의: 위치는 그리드 셀 단위(근사). 정밀 점탐지는 Phase 3(descoped).
    """
    matched = bool(record.get("matched"))
    date = record.get("date") or record.get("entryTimestamp")
    det = _canonical(
        source="sar",
        provider="gfw",
        external_id=record.get("id") or f"{record.get('lat')},{record.get('lon')},{date}",
        detected_at=date,
        lat=record.get("lat"),
        lon=record.get("lon"),
        confidence=None,
        raw=record,
    )
    # GFW 사전 매칭 결과를 그대로 반영 (correlation.py가 없어도 dark 판정 가능)
    det["matched_mmsi"] = record.get("mmsi") if matched else None
    det["dark_candidate"] = not matched
    det["dark_vessel_status"] = "ais-matched" if matched else "sar-only"
    det["detections_count"] = record.get("detections")
    return det


def normalize_gfw_event(record):
    """
    GFW Events(encounter/loitering/gap). 우리 Event 교차검증용.
    필드(확인됨): id, type, start, end, position{lat,lon}, vessel{id,ssvid,flag,name}.
    vessel.ssvid = MMSI.
    """
    type_map = {"encounter": "encounter", "loitering": "ais_loitering",
                "gap": "ais_gap", "AIS_OFF": "ais_gap", "port_visit": None}
    gfw_type = record.get("type")
    position = record.get("position") or {}
    vessel = record.get("vessel") or {}
    duration_h = None
    start, end = record.get("start"), record.get("end")
    if start and end:
        try:
            from datetime import datetime
            s = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
            e = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
            duration_h = max(0.0, (e - s).total_seconds() / 3600.0)
        except Exception:
            duration_h = None
    return {
        "id": f"GFW-{record.get('id')}",
        "source": "gfw",
        "event_type": type_map.get(gfw_type),   # None이면 스킵
        "mmsi": vessel.get("ssvid"),
        "vessel_name": vessel.get("name") or "Unknown",
        "lat": position.get("lat"),
        "lon": position.get("lon"),
        "timestamp": start,
        "occurred_at": start,
        "duration_h": duration_h,
        "ais_status": "intermittent" if gfw_type in ("gap", "AIS_OFF") else "on",
        "raw_payload_json": record,
    }


# --- Phase 2: MarineTraffic (선박 제원/소유주 보강 — Vessel 갱신) ----------
def normalize_marinetraffic(record):
    """
    Detection이 아니라 Vessel 보강용. 반환은 Vessel patch dict.
    TODO(Phase 2): 구매한 엔드포인트(PS/VD 계열) 응답 필드 확정.
    """
    return {
        "mmsi": record.get("MMSI"),        # TODO
        "imo": record.get("IMO"),          # TODO
        "vessel_name": record.get("SHIPNAME"),
        "flag": record.get("FLAG"),
        "owner": record.get("OWNER"),
        "latest_lat": record.get("LAT"),
        "latest_lon": record.get("LON"),
    }


# --- Phase 3: RF 지오로케이션 (HawkEye / Unseenlabs / Spire) ---------------
def normalize_rf(record, provider="hawkeye"):
    """
    RF 탐지. 업체별 응답/파일 포맷 상이.
    TODO(Phase 3): 계약 업체 스키마로 확정. 흔한 필드:
      - signal_id / detection_id  → external_id
      - collect_time / timestamp  → detected_at
      - lat/lon 또는 geolocation.{latitude,longitude}
      - confidence / probability
      - emitter_type (radar 등) → raw에 보존
    """
    geo = record.get("geolocation") or {}
    return _canonical(
        source="rf",
        provider=provider,
        external_id=record.get("signal_id") or record.get("detection_id"),   # TODO
        detected_at=record.get("collect_time") or record.get("timestamp"),   # TODO
        lat=record.get("lat") or geo.get("latitude"),                        # TODO
        lon=record.get("lon") or geo.get("longitude"),                       # TODO
        confidence=record.get("confidence") or record.get("probability"),
        raw=record,
    )


# --- Phase 3: KOMPSAT / Copernicus 자체 탐지 결과 -------------------------
def normalize_sar_detection(record, provider="kompsat"):
    """
    자체 SAR 탐지 ML 파이프라인 출력 → Detection.
    (원영상 → 탐지 ML은 별도 transform. 여기는 그 출력 정규화만.)
    TODO(Phase 3): 탐지 파이프라인 출력 스키마로 확정.
    """
    return _canonical(
        source="sar",
        provider=provider,
        external_id=record.get("detection_id"),
        detected_at=record.get("acquired_at"),
        lat=record.get("lat"),
        lon=record.get("lon"),
        confidence=record.get("confidence"),
        raw=record,
    )


ADAPTERS = {
    "synthetic": normalize_synthetic_dark,
    "gfw_sar": normalize_gfw_sar,
    "gfw_event": normalize_gfw_event,
    # 아래는 Phase 2/3 (현재 스코프 제외 — 유료/발주). 스키마만 유지.
    "marinetraffic": normalize_marinetraffic,
    "rf": normalize_rf,
    "sar": normalize_sar_detection,
}
