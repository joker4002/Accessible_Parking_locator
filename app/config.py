from pydantic import BaseModel


class Settings(BaseModel):
    # If you have a direct Open Data Kingston URL for accessible parking, put it here.
    # Otherwise we will load from local cached file under data/ or project root.
    accessible_parking_source_url: str | None = None

    # Local cache path (CSV/GeoJSON/JSON)
    accessible_parking_cache_path: str = "Parking_Lot_Areas.geojson"


settings = Settings()
