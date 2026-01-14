from __future__ import annotations

from datetime import datetime
from typing import Any

from app.geo import haversine_m
from app.models import ParkingSpot, PredictionResult


def find_nearby(
    spots: list[ParkingSpot],
    lat: float,
    lon: float,
    k: int = 5,
    radius_m: float | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for s in spots:
        d = haversine_m(lat, lon, s.lat, s.lon)
        if radius_m is not None and d > radius_m:
            continue
        rows.append({"spot": s, "distance_m": d})

    rows.sort(key=lambda r: r["distance_m"])
    rows = rows[: max(0, int(k))]

    return [
        {
            **r["spot"].model_dump(),
            "distance_m": float(r["distance_m"]),
        }
        for r in rows
    ]


def predict_busy_probability(
    lat: float,
    lon: float,
    when: datetime | None = None,
    downtown_center: tuple[float, float] = (44.2312, -76.4860),
) -> PredictionResult:
    """Simple, explainable heuristic 'AI' prediction.

    Output: probability of successfully finding an accessible spot (0..1).
    """

    when = when or datetime.now()

    # Base probability
    p = 0.70
    reason_parts: list[str] = ["base=0.70"]

    # Downtown tends to be busier
    dist_to_downtown_km = haversine_m(lat, lon, downtown_center[0], downtown_center[1]) / 1000.0
    if dist_to_downtown_km <= 1.5:
        p -= 0.20
        reason_parts.append("downtown(-0.20)")
    elif dist_to_downtown_km <= 3.0:
        p -= 0.10
        reason_parts.append("near_downtown(-0.10)")

    # Time-of-day effects
    hour = when.hour
    is_weekend = when.weekday() >= 5

    if 7 <= hour <= 9:
        p -= 0.08
        reason_parts.append("morning_commute(-0.08)")
    if 11 <= hour <= 14:
        p -= 0.10
        reason_parts.append("midday(-0.10)")
    if 16 <= hour <= 18:
        p -= 0.12
        reason_parts.append("evening_peak(-0.12)")

    if is_weekend and 10 <= hour <= 13:
        p -= 0.10
        reason_parts.append("weekend_morning(-0.10)")

    # Clamp
    p = max(0.05, min(0.95, p))

    if p >= 0.7:
        tier = "high"
    elif p >= 0.45:
        tier = "medium"
    else:
        tier = "low"

    return PredictionResult(probability=float(p), tier=tier, reason=";".join(reason_parts))
