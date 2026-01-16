from __future__ import annotations

import json
import math
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Optional

import requests
from flask import Flask, jsonify, request


app = Flask(__name__)


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-API-Key"
    return resp


KINGSTON_DEFAULT_BOUNDS = {
    "min_lat": 44.10,
    "max_lat": 44.40,
    "min_lng": -76.70,
    "max_lng": -76.20,
}


BACKBOARD_API_BASE_URL = os.getenv("BACKBOARD_API_BASE_URL", "https://app.backboard.io/api").rstrip("/")
BACKBOARD_API_KEY = os.getenv("BACKBOARD_API_KEY", "").strip()
BACKBOARD_LLM_PROVIDER = os.getenv("BACKBOARD_LLM_PROVIDER", "openrouter").strip() or "openrouter"
BACKBOARD_MODEL_NAME = os.getenv("BACKBOARD_MODEL_NAME", "google/gemini-3-flash-preview").strip() or "google/gemini-3-flash-preview"
BACKBOARD_ASSISTANT_ID: Optional[str] = None

BACKBOARD_SEND_TIMEOUT_S = float(os.getenv("BACKBOARD_SEND_TIMEOUT_S", "60"))
BACKBOARD_SEND_RETRIES = int(os.getenv("BACKBOARD_SEND_RETRIES", "1"))
BACKBOARD_RETRY_BACKOFF_S = float(os.getenv("BACKBOARD_RETRY_BACKOFF_S", "1.0"))


@dataclass(frozen=True)
class ParkingLotSpot:
    id: str
    label: str
    lat: float
    lng: float
    handicap_spaces: Optional[int]
    capacity: Optional[int]


def haversine_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lng / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def compute_probability(handicap_spaces: Optional[int], capacity: Optional[int]) -> float:
    if handicap_spaces is None or capacity is None or capacity <= 0:
        return 0.35
    ratio = handicap_spaces / float(capacity)
    return clamp(0.25 + ratio * 1.5, 0.15, 0.95)


def _safe_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return int(float(s))
        except ValueError:
            return None
    return None


def _centroid_from_geometry(geometry: dict[str, Any]) -> Optional[tuple[float, float]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if not gtype or coords is None:
        return None

    points: list[tuple[float, float]] = []

    def add_ring(ring: Any) -> None:
        if not isinstance(ring, list):
            return
        for p in ring:
            if (
                isinstance(p, (list, tuple))
                and len(p) >= 2
                and isinstance(p[0], (int, float))
                and isinstance(p[1], (int, float))
            ):
                lng = float(p[0])
                lat = float(p[1])
                points.append((lat, lng))

    if gtype == "Polygon":
        if isinstance(coords, list):
            for ring in coords:
                add_ring(ring)
    elif gtype == "MultiPolygon":
        if isinstance(coords, list):
            for poly in coords:
                if isinstance(poly, list):
                    for ring in poly:
                        add_ring(ring)
    elif gtype == "Point":
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            return float(coords[1]), float(coords[0])

    if not points:
        return None

    lat_avg = sum(p[0] for p in points) / len(points)
    lng_avg = sum(p[1] for p in points) / len(points)
    return lat_avg, lng_avg


def load_parking_lots() -> list[ParkingLotSpot]:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    geojson_path = os.path.join(root, "source", "Parking_Lot_Areas.geojson")
    if not os.path.exists(geojson_path):
        return []

    with open(geojson_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    features = raw.get("features") or []
    lots: list[ParkingLotSpot] = []

    for idx, feat in enumerate(features):
        if not isinstance(feat, dict):
            continue
        props = feat.get("properties") or {}
        geom = feat.get("geometry") or {}

        object_id = props.get("OBJECTID")
        lot_id = props.get("LOT_ID")
        map_label = (props.get("MAP_LABEL") or "").strip() or None
        lot_name = (props.get("LOT_NAME") or "").strip() or None

        label = lot_name or map_label or (str(object_id) if object_id is not None else str(idx))
        identifier = str(lot_id or object_id or idx)

        centroid = _centroid_from_geometry(geom)
        if centroid is None:
            continue

        handicap_spaces = _safe_int(props.get("HANDICAP_SPACE"))
        capacity = _safe_int(props.get("CAPACITY"))

        lots.append(
            ParkingLotSpot(
                id=identifier,
                label=label,
                lat=float(centroid[0]),
                lng=float(centroid[1]),
                handicap_spaces=handicap_spaces,
                capacity=capacity,
            )
        )

    return lots


PARKING_LOTS: list[ParkingLotSpot] = load_parking_lots()


def _parse_float_arg(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None
    return None


def _parse_int_arg(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return int(v)
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return int(float(s))
        except Exception:
            return None
    return None


def _internal_nearby(lat: float, lng: float, radius_m: int, limit: int) -> list[dict[str, Any]]:
    radius_m = max(50, min(20000, radius_m))
    limit = max(1, min(100, limit))
    if not PARKING_LOTS:
        return []

    rows: list[dict[str, Any]] = []
    for lot in PARKING_LOTS:
        d = haversine_meters(lat, lng, lot.lat, lot.lng)
        if d > radius_m:
            continue
        p = compute_probability(lot.handicap_spaces, lot.capacity)
        rows.append(
            {
                "id": lot.id,
                "label": lot.label,
                "lat": lot.lat,
                "lng": lot.lng,
                "distance_m": d,
                "probability": p,
            }
        )

    rows.sort(key=lambda r: r["distance_m"])
    return rows[:limit]


def _internal_autocomplete(
    q: str,
    limit: int,
    min_lat: Optional[float],
    min_lng: Optional[float],
    max_lat: Optional[float],
    max_lng: Optional[float],
) -> list[dict[str, Any]]:
    q = (q or "").strip()
    if not q:
        return []

    limit = max(1, min(50, limit))
    headers = {"User-Agent": "KingstonAccess/1.0 (education project)"}
    params: dict[str, Any] = {
        "format": "jsonv2",
        "q": q,
        "limit": str(limit),
        "addressdetails": 1,
    }

    if None not in (min_lat, min_lng, max_lat, max_lng):
        params["viewbox"] = f"{min_lng},{max_lat},{max_lng},{min_lat}"
        params["bounded"] = 1

    url = "https://nominatim.openstreetmap.org/search"
    r = requests.get(url, params=params, headers=headers, timeout=10)
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, list):
        return []

    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            lat_v = float(item.get("lat"))
            lng_v = float(item.get("lon"))
        except Exception:
            continue

        name = (item.get("name") or "").strip()
        display = (item.get("display_name") or "").strip()
        label = name or (display.split(",")[0].strip() if display else q)

        out.append(
            {
                "id": str(item.get("place_id") or item.get("osm_id") or label),
                "label": label,
                "subtitle": _format_nominatim_subtitle(item),
                "lat": lat_v,
                "lng": lng_v,
            }
        )

    return out


def _expanded_place_queries(q: str) -> list[str]:
    base = (q or "").strip()
    if not base:
        return []

    norm = " ".join(base.lower().split())
    generic_terms = {
        "market",
        "super market",
        "supermarket",
        "grocery",
        "groceries",
        "grocery store",
        "food store",
    }

    is_generic = norm in generic_terms or any(t in norm for t in ("supermarket", "grocery", "super market"))
    if not is_generic:
        return [base]

    expansions = [
        base,
        "supermarket",
        "grocery store",
        "Metro Kingston",
        "Food Basics Kingston",
        "No Frills Kingston",
        "FreshCo Kingston",
        "Loblaws Kingston",
        "Walmart Kingston",
        "Costco Kingston",
    ]

    seen: set[str] = set()
    out: list[str] = []
    for s in expansions:
        v = " ".join((s or "").strip().split())
        if not v:
            continue
        key = v.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(v)
    return out


def _get_backboard_headers() -> dict[str, str]:
    if not BACKBOARD_API_KEY:
        raise RuntimeError("BACKBOARD_API_KEY is not set")
    return {
        "X-API-Key": BACKBOARD_API_KEY,
        "Content-Type": "application/json",
    }


def _shorten_error_text(s: str, max_len: int = 240) -> str:
    if not s:
        return ""
    one_line = " ".join(s.replace("\r", " ").replace("\n", " ").split())
    if len(one_line) <= max_len:
        return one_line
    return one_line[:max_len] + "…"


def _ensure_backboard_assistant() -> str:
    global BACKBOARD_ASSISTANT_ID
    if BACKBOARD_ASSISTANT_ID:
        return BACKBOARD_ASSISTANT_ID

    payload = {
        "name": "KingstonAccess AI Search",
        "description": "Parse natural language parking/search requests into strict JSON for an accessibility parking locator.",
        "llm_provider": BACKBOARD_LLM_PROVIDER,
        "llm_model_name": BACKBOARD_MODEL_NAME,
        "tools": [],
    }

    resp = requests.post(
        f"{BACKBOARD_API_BASE_URL}/assistants",
        headers=_get_backboard_headers(),
        json=payload,
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Backboard create assistant failed: {resp.status_code} {resp.text}")

    data = resp.json() if resp.content else {}
    assistant_id = (data.get("assistant_id") or "").strip()
    if not assistant_id:
        raise RuntimeError("Backboard assistant_id missing in response")
    BACKBOARD_ASSISTANT_ID = assistant_id
    return assistant_id


def _backboard_create_thread(assistant_id: str) -> str:
    resp = requests.post(
        f"{BACKBOARD_API_BASE_URL}/assistants/{assistant_id}/threads",
        headers=_get_backboard_headers(),
        json={},
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Backboard create thread failed: {resp.status_code} {resp.text}")
    data = resp.json() if resp.content else {}
    thread_id = (data.get("thread_id") or "").strip()
    if not thread_id:
        raise RuntimeError("Backboard thread_id missing in response")
    return thread_id


def _backboard_send_message(thread_id: str, content: str) -> str:
    form_headers = {"X-API-Key": BACKBOARD_API_KEY}
    form_data = {
        "content": content,
        "stream": "false",
        "memory": "off",
        "send_to_llm": "true",
        "llm_provider": BACKBOARD_LLM_PROVIDER,
        "model_name": BACKBOARD_MODEL_NAME,
    }

    last_err: Optional[Exception] = None
    attempts = max(1, BACKBOARD_SEND_RETRIES + 1)
    for i in range(attempts):
        try:
            resp = requests.post(
                f"{BACKBOARD_API_BASE_URL}/threads/{thread_id}/messages",
                headers=form_headers,
                data=form_data,
                timeout=BACKBOARD_SEND_TIMEOUT_S,
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"Backboard send message failed: {resp.status_code} {_shorten_error_text(resp.text)}"
                )
            data = resp.json() if resp.content else {}
            return (data.get("content") or "").strip()
        except Exception as e:
            last_err = e
            if i < attempts - 1:
                time.sleep(BACKBOARD_RETRY_BACKOFF_S * (i + 1))
                continue
            break
    raise RuntimeError(f"Backboard send message failed: {_shorten_error_text(str(last_err or 'unknown'))}")


def _extract_first_json_object(text: str) -> Optional[dict[str, Any]]:
    if not text:
        return None
    s = text.strip()
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    m = re.search(r"\{[\s\S]*\}", s)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        if isinstance(obj, dict):
            return obj
    except Exception:
        return None
    return None


def _ai_parse_intent(text: str, bounds: dict[str, float]) -> dict[str, Any]:
    assistant_id = _ensure_backboard_assistant()
    thread_id = _backboard_create_thread(assistant_id)

    prompt = {
        "task": "Parse a user's natural language place/parking request into strict JSON for a map app in Kingston, Ontario.",
        "rules": [
            "Return ONLY a single JSON object. No markdown, no code fences.",
            "If the user names a place, set query to that place name.",
            "If the user implies a radius, output radius_m (meters). Default 1500.",
            "Output limit for number of parking spots to return. Default 30.",
            "Output place_limit for number of place candidates to return. Default 10.",
            "Keep requests within Kingston bounds unless user explicitly asks otherwise.",
        ],
        "kingston_bounds": bounds,
        "user_text": text,
        "output_schema": {
            "query": "string",
            "radius_m": "int",
            "limit": "int",
            "place_limit": "int",
            "notes": "string"
        },
    }

    model_text = _backboard_send_message(thread_id, json.dumps(prompt, ensure_ascii=False))
    parsed = _extract_first_json_object(model_text) or {}

    query = (parsed.get("query") or "").strip() or text.strip()
    radius_m = _parse_int_arg(parsed.get("radius_m")) or 1500
    limit = _parse_int_arg(parsed.get("limit")) or 30
    place_limit = _parse_int_arg(parsed.get("place_limit")) or 10
    notes = (parsed.get("notes") or "").strip()

    return {
        "query": query,
        "radius_m": max(50, min(20000, radius_m)),
        "limit": max(1, min(100, limit)),
        "place_limit": max(1, min(20, place_limit)),
        "notes": notes,
        "raw_model_text": model_text,
    }


@app.route("/nearby")
def nearby():
    try:
        lat = float(request.args.get("lat", ""))
        lng = float(request.args.get("lng", ""))
    except Exception:
        return jsonify({"detail": "lat/lng are required"}), 400

    try:
        radius_m = int(request.args.get("radius_m", request.args.get("radius_meters", 1500)))
    except Exception:
        radius_m = 1500

    try:
        limit = int(request.args.get("limit", 30))
    except Exception:
        limit = 30

    radius_m = max(50, min(20000, radius_m))
    limit = max(1, min(100, limit))

    if not PARKING_LOTS:
        return jsonify({"detail": "Parking lot dataset not loaded"}), 500

    return jsonify(_internal_nearby(lat=lat, lng=lng, radius_m=radius_m, limit=limit))


def _format_nominatim_subtitle(item: dict[str, Any]) -> str:
    addr = item.get("address") or {}
    house = (addr.get("house_number") or "").strip()
    road = (addr.get("road") or addr.get("pedestrian") or addr.get("footway") or "").strip()
    city = (addr.get("city") or addr.get("town") or addr.get("village") or "Kingston").strip()
    postcode = (addr.get("postcode") or "").strip()

    street = " ".join([p for p in [house, road] if p])
    parts = [p for p in [street, postcode] if p]
    if parts:
        return ", ".join(parts)

    display = (item.get("display_name") or "").strip()
    if display:
        # keep it short: first 2 segments
        seg = [s.strip() for s in display.split(",") if s.strip()]
        return ", ".join(seg[:2])

    return city


@app.route("/autocomplete")
def autocomplete():
    q = (request.args.get("q") or request.args.get("query") or "").strip()
    if not q:
        return jsonify([])

    try:
        limit = int(request.args.get("limit", 20))
    except Exception:
        limit = 20
    limit = max(1, min(50, limit))

    min_lat = _parse_float_arg(request.args.get("min_lat"))
    min_lng = _parse_float_arg(request.args.get("min_lng"))
    max_lat = _parse_float_arg(request.args.get("max_lat"))
    max_lng = _parse_float_arg(request.args.get("max_lng"))

    try:
        out = _internal_autocomplete(
            q=q,
            limit=limit,
            min_lat=min_lat,
            min_lng=min_lng,
            max_lat=max_lat,
            max_lng=max_lng,
        )
        return jsonify(out)
    except Exception as e:
        return jsonify({"detail": f"Nominatim request failed: {e}"}), 502


@app.route("/ai/search", methods=["GET", "POST", "OPTIONS"])
def ai_search():
    if request.method == "OPTIONS":
        return ("", 204)

    if request.method == "GET":
        text = (request.args.get("q") or request.args.get("text") or "").strip()
    else:
        payload = request.get_json(silent=True) or {}
        text = (payload.get("q") or payload.get("text") or "").strip()

    if not text:
        return jsonify({"detail": "text is required"}), 400

    bounds = {
        "min_lat": _parse_float_arg(request.args.get("min_lat")) or KINGSTON_DEFAULT_BOUNDS["min_lat"],
        "min_lng": _parse_float_arg(request.args.get("min_lng")) or KINGSTON_DEFAULT_BOUNDS["min_lng"],
        "max_lat": _parse_float_arg(request.args.get("max_lat")) or KINGSTON_DEFAULT_BOUNDS["max_lat"],
        "max_lng": _parse_float_arg(request.args.get("max_lng")) or KINGSTON_DEFAULT_BOUNDS["max_lng"],
    }

    intent: dict[str, Any]
    if not BACKBOARD_API_KEY:
        intent = {
            "query": text,
            "radius_m": 1500,
            "limit": 30,
            "place_limit": 10,
            "notes": "fallback: BACKBOARD_API_KEY not set",
        }
    else:
        try:
            intent = _ai_parse_intent(text=text, bounds=bounds)
        except Exception as e:
            intent = {
                "query": text,
                "radius_m": 1500,
                "limit": 30,
                "place_limit": 10,
                "notes": f"fallback: backboard unavailable ({_shorten_error_text(str(e))})",
            }

    try:
        place_limit = int(intent["place_limit"])
        queries = _expanded_place_queries(intent["query"])

        merged: list[dict[str, Any]] = []
        seen_keys: set[str] = set()
        for q in queries:
            hits = _internal_autocomplete(
                q=q,
                limit=place_limit,
                min_lat=bounds["min_lat"],
                min_lng=bounds["min_lng"],
                max_lat=bounds["max_lat"],
                max_lng=bounds["max_lng"],
            )
            for p in hits:
                pid = (p.get("id") or "").strip()
                if pid:
                    key = pid
                else:
                    key = f"{p.get('lat')}:{p.get('lng')}:{(p.get('label') or '').strip().lower()}"
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                merged.append(p)
                if len(merged) >= place_limit:
                    break
            if len(merged) >= place_limit:
                break

        places = merged
    except Exception as e:
        return jsonify({"detail": f"Autocomplete failed: {e}"}), 502

    selected = places[0] if places else None
    spots: list[dict[str, Any]] = []
    if selected is not None:
        spots = _internal_nearby(
            lat=float(selected["lat"]),
            lng=float(selected["lng"]),
            radius_m=int(intent["radius_m"]),
            limit=int(intent["limit"]),
        )

    return jsonify(
        {
            "intent": {
                "query": intent["query"],
                "radius_m": intent["radius_m"],
                "limit": intent["limit"],
                "place_limit": intent["place_limit"],
                "notes": intent.get("notes", ""),
            },
            "selected_place": selected,
            "places": places,
            "spots": spots,
        }
    )


if __name__ == "__main__":
    # Run on 0.0.0.0 so Android emulator (10.0.2.2) can reach it
    app.run(host="0.0.0.0", port=8000, debug=True)
