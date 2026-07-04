"""
scoring.py — CableGuard 위험 점수 로직의 Python 포팅.

public/shared/cableguard-domain.js 의 calculateRiskScore / getRiskLevel /
buildEvidence / generateRecommendation 을 그대로 옮긴 것. 프론트/Node/Foundry가
동일한 설명가능(rule-based) 점수를 내도록 단일 진실을 유지한다.

멀티센서 확장: rf_matched 를 sar_matched 와 동일한 패턴으로 추가.
(미매칭 = 잠재 다크 = 가산점)

순수 함수로 작성 → 단위 테스트 및 PySpark UDF 양쪽에서 재사용 가능.
Foundry transform 래퍼는 파일 하단 주석 참고.
"""

BASE_SCORES = {
    "dark_sar": 35,
    "ais_loitering": 20,
    "ais_gap": 20,
    "encounter": 25,
    "dragging_like": 35,
    "live_ais_review": 10,
    # 멀티센서 신규
    "rf_dark": 35,
    "sar_dark": 35,
}

REVIEW_STATUSES = ["unverified", "reviewed", "verified", "escalated"]


def _to_number(value):
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n and n not in (float("inf"), float("-inf")) else None


def calculate_risk_score(event):
    """cableguard-domain.js calculateRiskScore 와 동일한 규칙."""
    score = BASE_SCORES.get(event.get("event_type"), 0)
    distance = _to_number(event.get("distance_to_cable_nm"))
    duration = _to_number(event.get("duration_h"))
    speed = _to_number(event.get("speed_kn"))

    if distance is not None:
        if distance <= 1:
            score += 30
        elif distance <= 3:
            score += 25
        elif distance <= 5:
            score += 15
    if duration is not None:
        if duration >= 4:
            score += 15
        elif duration >= 2:
            score += 8
    if speed is not None and speed > 0:
        if speed <= 2:
            score += 10
        elif speed <= 3:
            score += 6

    if event.get("ais_status") == "off":
        score += 20
    if event.get("ais_status") == "intermittent":
        score += 12
    # AIS를 정상 송신 중인 협조 선박은 감점 (off +20 의 대칭, domain.js와 동일)
    if event.get("ais_status") == "on":
        score -= 12

    # 센서 미매칭 = 잠재 다크 (sar 기존 + rf 신규, 동일 패턴)
    if event.get("sar_matched") is False:
        score += 15
    if event.get("rf_matched") is False:
        score += 15

    if event.get("event_type") == "dragging_like" and speed is not None and speed <= 3:
        score += 15
    if event.get("event_type") == "encounter" and distance is not None and distance <= 5:
        score += 10

    return max(0, min(100, round(score)))


def get_risk_level(score):
    if score >= 70:
        return "Very High"
    if score >= 50:
        return "High"
    if score >= 30:
        return "Medium"
    return "Low"


def normalize_review_status(value):
    v = str(value or "unverified").strip().lower()
    return v if v in REVIEW_STATUSES else "unverified"


def build_evidence(event, score):
    """설명가능 근거. domain.js buildEvidence 핵심 + 멀티센서 추가."""
    evidence = list(event.get("evidence") or [])
    seen = set(evidence)

    def add(text):
        if text not in seen:
            evidence.append(text)
            seen.add(text)

    distance = _to_number(event.get("distance_to_cable_nm"))
    duration = _to_number(event.get("duration_h"))
    speed = _to_number(event.get("speed_kn"))

    if event.get("event_type") in ("dark_sar", "sar_dark") and event.get("sar_matched") is False:
        add("Unmatched SAR detection near cable route (no AIS correlation).")
    if event.get("event_type") == "rf_dark" and event.get("rf_matched") is False:
        add("RF emission detected with no matching AIS track (potential dark vessel).")
    if distance is not None:
        if distance <= 1:
            add("Within 1 nm of nearest submarine cable.")
        elif distance <= 3:
            add("Inside 3 nm warning zone of nearest cable.")
        elif distance <= 5:
            add("Inside 5 nm watch zone of nearest cable.")
    if duration is not None and duration >= 4:
        add("Observed duration exceeds the 4 hour review threshold.")
    elif duration is not None and duration >= 2:
        add("Observed duration exceeds the 2 hour review threshold.")
    if speed is not None and 0 < speed <= 2:
        add("Low-speed movement under 2 knots.")
    elif speed is not None and 2 < speed <= 3:
        add("Slow movement between 2 and 3 knots.")
    if event.get("ais_status") == "off":
        add("AIS is off or unavailable for this contact.")
    if event.get("ais_status") == "intermittent":
        add("AIS intermittent/gap behavior observed.")
    if event.get("ais_status") == "on":
        add("Vessel is actively transmitting AIS (cooperative behavior lowers the score).")
    if score >= 70:
        add("Computed risk score reaches the Very High prioritization band.")
    return evidence


def generate_recommendation(event, score, level):
    et = event.get("event_type")
    distance = _to_number(event.get("distance_to_cable_nm"))
    if et in ("rf_dark", "sar_dark"):
        return ("Unmatched sensor detection with no AIS. Classify as potential dark vessel. "
                "Retask patrol/UAV/coastal radar to verify. This is risk prioritization, not hostile-intent confirmation.")
    if level == "Very High" and et == "dark_sar" and distance is not None and distance <= 3:
        return "Prioritize immediate confirmation. Retask UAV/SAR or coastal radar. Monitor likely egress corridor."
    if level in ("High", "Very High") and et == "ais_loitering":
        return "Maintain close monitoring. Check recent AIS gaps, identity, nearby contacts. Consider patrol/UAV."
    if et == "encounter":
        return "Review encounter context. Check both vessels' identities, duration, prior port history."
    if et == "dragging_like":
        return "Flag as cable-risk behavior. Confirm with additional sensors before escalation."
    if et == "ais_gap":
        return "Review last known position, reappearance point, cable proximity."
    if et == "live_ais_review":
        return "Treat as unverified AIS review. Compare recent track history, seek sensor confirmation."
    return "Maintain watch and seek corroborating information before escalation."


def enrich_event(event):
    """점수/등급/근거/권고를 채운 dict 반환. live_ais_review는 49점 상한(자동 escalation 방지)."""
    out = dict(event)
    score = calculate_risk_score(out)
    if out.get("source") == "aisstream" and out.get("event_type") == "live_ais_review":
        score = min(score, 49)
    # AIS 정상 송신 + 다크 징후 없음 → Very High(70+) 자동 격상 방지 (상한 69, domain.js와 동일)
    if (out.get("source") == "aisstream"
            and out.get("ais_status") == "on"
            and out.get("sar_matched") is not False
            and out.get("rf_matched") is not False):
        score = min(score, 69)
    level = get_risk_level(score)
    out["risk_score"] = score
    out["risk_level"] = level
    out["evidence"] = build_evidence(out, score)
    out["recommendation"] = generate_recommendation(out, score, level)
    out["review_status"] = normalize_review_status(out.get("review_status"))
    return out


# ---------------------------------------------------------------------------
# Foundry PySpark transform 래퍼 (업로드 시 주석 해제·데이터셋 RID 지정)
# ---------------------------------------------------------------------------
# from transforms.api import transform_df, Input, Output
# from pyspark.sql import functions as F, types as T
#
# @transform_df(
#     Output("<enriched_events_dataset_rid>"),
#     correlated=Input("<correlated_events_dataset_rid>"),  # correlation.py 출력
# )
# def compute(correlated):
#     schema = T.StructType([
#         T.StructField("risk_score", T.IntegerType()),
#         T.StructField("risk_level", T.StringType()),
#         T.StructField("recommendation", T.StringType()),
#         T.StructField("review_status", T.StringType()),
#     ])
#
#     @F.udf(schema)
#     def score_udf(event_type, source, distance, duration, speed, ais_status,
#                   sar_matched, rf_matched, review_status):
#         e = enrich_event({
#             "event_type": event_type, "source": source,
#             "distance_to_cable_nm": distance, "duration_h": duration,
#             "speed_kn": speed, "ais_status": ais_status,
#             "sar_matched": sar_matched, "rf_matched": rf_matched,
#             "review_status": review_status,
#         })
#         return (e["risk_score"], e["risk_level"], e["recommendation"], e["review_status"])
#
#     scored = correlated.withColumn("_s", score_udf(
#         "event_type", "source", "distance_to_cable_nm", "duration_h", "speed_kn",
#         "ais_status", "sar_matched", "rf_matched", "review_status"))
#     return scored.select("*", "_s.*").drop("_s")
