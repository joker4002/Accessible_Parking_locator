from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from typing import Iterable

from app.models import ParkingSpot


def _polygon_centroid(ring: list) -> tuple[float, float] | None:
    # ring: [[lon, lat], ...]
    if not isinstance(ring, list) or len(ring) < 3:
        return None

    # Shoelace formula (in lon/lat space; good enough for small areas)
    area2 = 0.0
    cx = 0.0
    cy = 0.0

    for i in range(len(ring) - 1):
        p1 = ring[i]
        p2 = ring[i + 1]
        if not (
            isinstance(p1, (list, tuple))
            and isinstance(p2, (list, tuple))
            and len(p1) >= 2
            and len(p2) >= 2
        ):
            continue
        x1, y1 = float(p1[0]), float(p1[1])
        x2, y2 = float(p2[0]), float(p2[1])
        cross = x1 * y2 - x2 * y1
        area2 += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross

    if abs(area2) < 1e-12:
        # Fallback: average of points
        xs = [float(p[0]) for p in ring if isinstance(p, (list, tuple)) and len(p) >= 2]
        ys = [float(p[1]) for p in ring if isinstance(p, (list, tuple)) and len(p) >= 2]
        if not xs or not ys:
            return None
        return (sum(xs) / len(xs), sum(ys) / len(ys))

    cx /= 3.0 * area2
    cy /= 3.0 * area2
    return (cx, cy)


def _geom_to_point_latlon(geom: dict) -> tuple[float, float] | None:
    if not isinstance(geom, dict):
        return None

    gtype = geom.get("type")
    coords = geom.get("coordinates")

    if gtype == "Point" and isinstance(coords, (list, tuple)) and len(coords) >= 2:
        return (float(coords[1]), float(coords[0]))

    if gtype == "Polygon" and isinstance(coords, list) and len(coords) >= 1:
        outer = coords[0]
        if isinstance(outer, list) and len(outer) >= 3:
            c = _polygon_centroid(outer)
            if c is None:
                return None
            lon, lat = c
            return (float(lat), float(lon))

    if gtype == "MultiPolygon" and isinstance(coords, list) and len(coords) >= 1:
        # pick centroid of first polygon outer ring
        first_poly = coords[0]
        if isinstance(first_poly, list) and len(first_poly) >= 1:
            outer = first_poly[0]
            if isinstance(outer, list) and len(outer) >= 3:
                c = _polygon_centroid(outer)
                if c is None:
                    return None
                lon, lat = c
                return (float(lat), float(lon))

    return None



@dataclass(frozen=True)
class LoadResult:
    spots: list[ParkingSpot]
    source: str


def _try_parse_float(v: object) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _row_get(row: dict, keys: Iterable[str]) -> object | None:
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k]
    return None


def _normalize_spot(row: dict, idx: int) -> ParkingSpot | None:
    lat = _try_parse_float(_row_get(row, ["lat", "latitude", "LAT", "Y"]))
    lon = _try_parse_float(_row_get(row, ["lon", "lng", "longitude", "LON", "X"]))
    if lat is None or lon is None:
        return None

    spot_id = str(
        _row_get(row, ["id", "ID", "objectid", "OBJECTID", "spot_id"]) or idx
    )

    spot_type = _row_get(row, ["type", "TYPE", "spot_type", "SpaceType", "category"])
    rules = _row_get(row, ["rules", "RULES", "regulation", "Regulations", "payment"])
    address = _row_get(row, ["address", "ADDRESS", "street", "Street", "location"])
    description = _row_get(row, ["description", "DESCRIPTION", "desc", "notes"])

    return ParkingSpot(
        id=spot_id,
        lat=float(lat),
        lon=float(lon),
        spot_type=str(spot_type) if spot_type is not None else None,
        rules=str(rules) if rules is not None else None,
        address=str(address) if address is not None else None,
        description=str(description) if description is not None else None,
    )


def load_spots_from_file(path: str) -> LoadResult:
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Accessible parking cache file not found: {path}. "
            f"Put a CSV/GeoJSON/JSON file there or set a source URL."
        )

    ext = os.path.splitext(path)[1].lower()
    if ext in (".csv",):
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            spots: list[ParkingSpot] = []
            for idx, row in enumerate(reader):
                s = _normalize_spot(row, idx)
                if s is not None:
                    spots.append(s)
        return LoadResult(spots=spots, source=path)

    if ext in (".json", ".geojson"):
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)

        spots: list[ParkingSpot] = []

        if isinstance(obj, dict) and "features" in obj:
            # GeoJSON FeatureCollection
            for idx, feat in enumerate(obj.get("features", [])):
                props = feat.get("properties", {}) if isinstance(feat, dict) else {}
                geom = feat.get("geometry", {}) if isinstance(feat, dict) else {}
                row = dict(props)

                ll = _geom_to_point_latlon(geom)
                if ll is not None:
                    lat, lon = ll
                    row.setdefault("lat", lat)
                    row.setdefault("lon", lon)

                s = _normalize_spot(row, idx)
                if s is not None:
                    spots.append(s)
            return LoadResult(spots=spots, source=path)

        if isinstance(obj, list):
            for idx, row in enumerate(obj):
                if isinstance(row, dict):
                    s = _normalize_spot(row, idx)
                    if s is not None:
                        spots.append(s)
            return LoadResult(spots=spots, source=path)

        raise ValueError(f"Unsupported JSON structure in {path}")

    raise ValueError(f"Unsupported file extension: {ext} (expected .csv/.json/.geojson)")
