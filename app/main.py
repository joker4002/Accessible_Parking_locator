from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.data_loader import load_spots_from_file
from app.models import ParkingSpot, NearbyQuery, PredictionResult
from app.services import find_nearby, predict_busy_probability

app = FastAPI(title="Accessible Parking Locator API", version="0.1.0")

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state for loaded parking spots
spots: list[ParkingSpot] = []

# Load data on startup
@app.on_event("startup")
def load_data():
    global spots
    try:
        result = load_spots_from_file(settings.accessible_parking_cache_path)
        spots = result.spots
        print(f"Successfully loaded {len(spots)} parking spots from {result.source}")
    except Exception as e:
        print(f"Error loading parking data: {e}")
        # In a real app, you might want to fail fast or implement retry logic


@app.get("/health")
def health():
    return {
        "status": "ok",
        "spots_loaded": len(spots),
    }


@app.post("/spots/nearby", response_model=list[dict])
def get_nearby_spots(query: NearbyQuery) -> list[dict]:
    """
    Find the nearest accessible parking spots to the given coordinates.
    
    - **lat, lon**: Center point coordinates (required)
    - **k**: Maximum number of spots to return (default: 5)
    - **radius_m**: Optional maximum distance in meters
    """
    if not spots:
        raise HTTPException(status_code=503, detail="Parking data not loaded")
    
    return find_nearby(
        spots,
        lat=query.lat,
        lon=query.lon,
        k=query.k,
        radius_m=query.radius_m,
    )


@app.get("/predict/probability", response_model=PredictionResult)
def get_busyness_prediction(
    lat: float,
    lon: float,
    when: Optional[datetime] = None,
) -> PredictionResult:
    """
    Predict the probability of finding an available accessible parking spot.
    
    - **lat, lon**: Coordinates to predict for
    - **when**: Optional timestamp (defaults to now)
    """
    return predict_busy_probability(lat=lat, lon=lon, when=when)


# For development: Add a simple endpoint to list all spots (remove in production)
@app.get("/spots", include_in_schema=False)
def list_all_spots():
    return [s.model_dump() for s in spots[:100]]  # Limit to first 100 for demo