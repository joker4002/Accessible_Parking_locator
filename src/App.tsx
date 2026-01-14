import { GoogleMap, InfoWindowF, MarkerF, useJsApiLoader } from '@react-google-maps/api';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { haversineMeters, formatDistance } from './geo';
import { MOCK_SPOTS } from './mockData';
import { predictAvailability } from './predict';
import type { ParkingSpot } from './types';

const DEFAULT_CENTER = { lat: 44.2312, lng: -76.4860 };

type SpotWithDistance = ParkingSpot & { distanceMeters: number };

export default function App() {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'kingstonaccess-google-maps',
    googleMapsApiKey: apiKey ?? ''
  });

  const mapRef = useRef<google.maps.Map | null>(null);

  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(2);
  const [query, setQuery] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const now = useMemo(() => new Date(), []);

  const spots: SpotWithDistance[] = useMemo(() => {
    const origin = userPos ?? DEFAULT_CENTER;
    const computed = MOCK_SPOTS.map((s) => ({
      ...s,
      distanceMeters: haversineMeters(origin, { lat: s.lat, lng: s.lng })
    })).sort((a, b) => a.distanceMeters - b.distanceMeters);

    const radM = radiusKm * 1000;
    const filteredByRadius = computed.filter((s) => s.distanceMeters <= radM);

    const q = query.trim().toLowerCase();
    if (!q) return filteredByRadius;

    return filteredByRadius.filter((s) => {
      const hay = `${s.name} ${s.zone ?? ''} ${s.description ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [userPos, radiusKm, query]);

  const selectedSpot = useMemo(() => {
    if (!selectedId) return null;
    return spots.find((s) => s.id === selectedId) ?? null;
  }, [selectedId, spots]);

  useEffect(() => {
    if (!apiKey) {
      setStatusMsg(
        'Missing Google Maps API key. Create a .env.local with VITE_GOOGLE_MAPS_API_KEY=YOUR_KEY then restart the dev server.'
      );
    }
  }, [apiKey]);

  const canUseGeo = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  const onLocateMe = () => {
    if (!canUseGeo) {
      setStatusMsg('Geolocation not available in this browser.');
      return;
    }

    setStatusMsg('Requesting your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserPos(next);
        setStatusMsg('Location updated. Showing nearest accessible parking.');
        if (mapRef.current) mapRef.current.panTo(next);
      },
      () => {
        setStatusMsg('Could not access location. You can still use the map and list.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const onCenterKingston = () => {
    setUserPos(null);
    setStatusMsg('Centered on Downtown Kingston.');
    if (mapRef.current) mapRef.current.panTo(DEFAULT_CENTER);
  };

  const ariaStatusId = 'app-status';

  return (
    <div className="container">
      <aside className="sidebar" aria-label="Search and results">
        <div className="header">
          <div className="brand">
            <h1>KingstonAccess</h1>
            <p>Accessible parking finder + availability hint (MVP)</p>
          </div>
          <div className="badge" aria-label="Prototype badge">
            MVP
          </div>
        </div>

        <div className="card" role="region" aria-label="Search controls">
          <div className="label" id="search-label">Search</div>
          <input
            aria-labelledby="search-label"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g., Downtown, KGH, Market Square"
            inputMode="search"
          />

          <div style={{ height: 10 }} />

          <div className="label" id="radius-label">Distance filter</div>
          <select
            aria-labelledby="radius-label"
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value))}
          >
            <option value={0.5}>0.5 km</option>
            <option value={1}>1 km</option>
            <option value={2}>2 km</option>
            <option value={5}>5 km</option>
          </select>

          <div style={{ height: 10 }} />

          <div className="row">
            <button type="button" onClick={onLocateMe} aria-describedby={ariaStatusId}>
              Locate me
            </button>
            <button type="button" className="secondary" onClick={onCenterKingston} aria-describedby={ariaStatusId}>
              Center on Kingston
            </button>
          </div>

          <div style={{ height: 10 }} />

          <div className="help" id={ariaStatusId} aria-live="polite">
            {statusMsg ?? 'Tip: Use keyboard Tab/Shift+Tab to navigate controls and results.'}
          </div>
        </div>

        <div className="card" role="region" aria-label="Results list">
          <div className="label">Results ({spots.length})</div>
          <div className="list" role="list">
            {spots.map((s) => {
              const pred = predictAvailability(s, now);
              const chipClass = pred.label === 'High' ? 'good' : pred.label === 'Medium' ? 'mid' : 'bad';

              return (
                <div
                  key={s.id}
                  className="item"
                  role="listitem"
                >
                  <div className="itemHeader">
                    <div>
                      <div className="itemTitle">{s.name}</div>
                      <div className="itemMeta">
                        Zone: {s.zone ?? '—'}
                        <br />
                        Distance: {formatDistance(s.distanceMeters)}
                      </div>
                    </div>
                    <div className={`chip ${chipClass}`} aria-label={`Availability ${pred.label}`}>
                      {pred.label} ({Math.round(pred.probability * 100)}%)
                    </div>
                  </div>

                  <div className="itemMeta">
                    {pred.rationale}
                    <br />
                    Curb ramp: {s.hasCurbRamp === true ? 'Yes' : s.hasCurbRamp === false ? 'Unknown/No' : 'Unknown'}
                  </div>

                  <div style={{ height: 10 }} />

                  <div className="row">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(s.id);
                        setStatusMsg(`Selected: ${s.name}`);
                        if (mapRef.current) mapRef.current.panTo({ lat: s.lat, lng: s.lng });
                      }}
                    >
                      View on map
                    </button>
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${s.lat},${s.lng}`)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <button type="button" className="secondary">
                        Navigate
                      </button>
                    </a>
                  </div>
                </div>
              );
            })}

            {spots.length === 0 ? (
              <div className="help">No spots match. Try increasing distance or clearing search.</div>
            ) : null}
          </div>
        </div>

        <div className="help">
          Data note: currently using a small built-in demo dataset. Replace with Open Data Kingston feed when available.
        </div>
      </aside>

      <main className="mapWrap" aria-label="Map">
        {!apiKey ? (
          <div className="toast" role="alert">
            <strong>Google Maps API Key not configured</strong>
            <div className="help">
              Create <code>.env.local</code> with <code>VITE_GOOGLE_MAPS_API_KEY=...</code> and restart <code>npm run dev</code>.
            </div>
          </div>
        ) : null}

        {loadError ? (
          <div className="toast" role="alert">
            <strong>Failed to load Google Maps</strong>
            <div className="help">Check your API key restrictions and billing, then reload.</div>
          </div>
        ) : null}

        <div className="map" role="application" aria-label="Interactive map">
          {isLoaded && apiKey ? (
            <GoogleMap
              mapContainerStyle={{ width: '100%', height: '100%' }}
              center={userPos ?? DEFAULT_CENTER}
              zoom={14}
              onLoad={(map) => (mapRef.current = map)}
              options={{
                clickableIcons: false,
                streetViewControl: false,
                mapTypeControl: false,
                fullscreenControl: true,
                keyboardShortcuts: true
              }}
            >
              {spots.map((s) => (
                <MarkerF
                  key={s.id}
                  position={{ lat: s.lat, lng: s.lng }}
                  onClick={() => {
                    setSelectedId(s.id);
                    setStatusMsg(`Selected: ${s.name}`);
                  }}
                  title={s.name}
                />
              ))}

              {selectedSpot ? (
                <InfoWindowF
                  position={{ lat: selectedSpot.lat, lng: selectedSpot.lng }}
                  onCloseClick={() => setSelectedId(null)}
                >
                  <div style={{ color: '#0b1220', maxWidth: 240 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{selectedSpot.name}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.3 }}>
                      {selectedSpot.description ?? 'Accessible parking location.'}
                      <br />
                      Zone: {selectedSpot.zone ?? '—'}
                    </div>
                  </div>
                </InfoWindowF>
              ) : null}
            </GoogleMap>
          ) : (
            <div className="toast">
              <strong>Loading map…</strong>
              <div className="help">If this doesn’t load, confirm the API key is set.</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
