from __future__ import annotations

from pydantic import BaseModel


class ParkingSpot(BaseModel):
    id: str
    lat: float
    lon: float
    spot_type: str | None = None
    rules: str | None = None
    address: str | None = None
    description: str | None = None


class NearbyQuery(BaseModel):
    lat: float
    lon: float
    k: int = 5
    radius_m: float | None = None


class PredictionResult(BaseModel):
    probability: float
    reason: str
    tier: str
