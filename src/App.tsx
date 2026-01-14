import { DirectionsRenderer, GoogleMap, InfoWindowF, MarkerF, PolygonF, useJsApiLoader } from '@react-google-maps/api';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { haversineMeters, formatDistance } from './geo';
import { MOCK_SPOTS } from './mockData';
import parkingLotsCsv from './Parking_Lot_Areas.csv?raw';
import parkingLotsGeoJson from './Parking_Lot_Areas.geojson?raw';
import { parseParkingLotAreas } from './parkingLots.ts';
import { predictAvailability } from './predict';
import type { ParkingLotArea, ParkingSpot } from './types';

const DEFAULT_CENTER = { lat: 44.2312, lng: -76.4860 };

type SpotWithDistance = ParkingSpot & { distanceMeters: number };

type ParkingLotGeometry = {
  // A lot can be MultiPolygon: [polygonIndex][ringIndex][pointIndex]
  polygons: google.maps.LatLngLiteral[][][];
};

type TravelModeKey = 'DRIVING' | 'TRANSIT' | 'WALKING';

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export default function App() {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'kingstonaccess-google-maps',
    googleMapsApiKey: apiKey ?? ''
  });

  const mapRef = useRef<google.maps.Map | null>(null);
  const pendingLotGeocodeRef = useRef<Record<string, Promise<{ lat: number; lng: number }> | undefined>>({});

  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(2);
  const [query, setQuery] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [onlyAccessibleLots, setOnlyAccessibleLots] = useState<boolean>(true);
  const [parkingLots, setParkingLots] = useState<ParkingLotArea[]>([]);
  const [parkingLotsError, setParkingLotsError] = useState<string | null>(null);
  const [selectedParkingLotId, setSelectedParkingLotId] = useState<string | null>(null);
  const [parkingLotMarkers, setParkingLotMarkers] = useState<Record<string, { lat: number; lng: number }>>({});
  const [parkingLotGeometries, setParkingLotGeometries] = useState<Record<string, ParkingLotGeometry>>({});
  const [activeTab, setActiveTab] = useState<'results' | 'lots'>('results');
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [travelMode, setTravelMode] = useState<TravelModeKey>('DRIVING');
  const [lastRoute, setLastRoute] = useState<{ destination: { lat: number; lng: number }; label: string } | null>(null);

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

  useEffect(() => {
    try {
      const lots = parseParkingLotAreas(parkingLotsCsv);
      setParkingLots(lots);
      setParkingLotsError(null);
    } catch {
      setParkingLotsError('Could not load Parking_Lot_Areas.csv');
    }
  }, []);

  useEffect(() => {
    try {
      const parsed = JSON.parse(parkingLotsGeoJson) as {
        type: 'FeatureCollection';
        features: Array<{
          type: 'Feature';
          properties: Record<string, unknown>;
          geometry:
            | { type: 'Polygon'; coordinates: number[][][] }
            | { type: 'MultiPolygon'; coordinates: number[][][][] };
        }>;
      };

      const next: Record<string, ParkingLotGeometry> = {};

      for (const f of parsed.features) {
        const globalId = (f.properties?.GLOBALID as string | undefined) ?? undefined;
        if (!globalId) continue;

        const toLatLng = (pt: number[]): google.maps.LatLngLiteral => ({ lat: pt[1], lng: pt[0] });

        if (f.geometry.type === 'Polygon') {
          const rings = f.geometry.coordinates.map((ring) => ring.map(toLatLng));
          next[globalId] = { polygons: [rings] };
        } else if (f.geometry.type === 'MultiPolygon') {
          const polygons = f.geometry.coordinates.map((poly) => poly.map((ring) => ring.map(toLatLng)));
          next[globalId] = { polygons };
        }
      }

      setParkingLotGeometries(next);
    } catch {
      // If parsing fails, we simply won't render polygons.
    }
  }, []);

  const parkingLotById = useMemo(() => {
    const m = new Map<string, ParkingLotArea>();
    for (const l of parkingLots) m.set(l.id, l);
    return m;
  }, [parkingLots]);

  const geocodeParkingLot = async (lot: ParkingLotArea): Promise<{ lat: number; lng: number }> => {
    const cached = parkingLotMarkers[lot.id];
    if (cached) return cached;

    const pending = pendingLotGeocodeRef.current[lot.id];
    if (pending) return pending;

    const p = new Promise<{ lat: number; lng: number }>((resolve, reject) => {
      if (!isLoaded || !apiKey) {
        reject(new Error('Google Maps not loaded'));
        return;
      }

      const query = `${lot.lotName ?? lot.mapLabel ?? 'Parking lot'} Kingston ON`;
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address: query }, (results, status) => {
        if (status !== 'OK' || !results || results.length === 0) {
          reject(new Error(`Geocode failed (${status})`));
          return;
        }

        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng() });
      });
    });

    pendingLotGeocodeRef.current[lot.id] = p;

    try {
      const pos = await p;
      setParkingLotMarkers((prev) => ({ ...prev, [lot.id]: pos }));
      return pos;
    } finally {
      delete pendingLotGeocodeRef.current[lot.id];
    }
  };

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
        if (mapRef.current) {
          mapRef.current.setCenter(next);
          mapRef.current.setZoom(16);
        }

        if (lastRoute) {
          routeTo(lastRoute.destination, lastRoute.label, next);
        }
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatusMsg('Location permission denied. Allow location access in your browser settings and try again.');
          return;
        }
        if (err.code === err.POSITION_UNAVAILABLE) {
          setStatusMsg('Location unavailable. Check your device location services and try again.');
          return;
        }
        if (err.code === err.TIMEOUT) {
          setStatusMsg('Location request timed out. Try again, or move closer to a window for better GPS signal.');
          return;
        }
        setStatusMsg('Could not access location. You can still use the map and list.');
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
    );
  };

  const onCenterKingston = () => {
    setUserPos(null);
    setStatusMsg('Centered on Downtown Kingston.');
    if (mapRef.current) mapRef.current.panTo(DEFAULT_CENTER);
  };

  const ariaStatusId = 'app-status';

  const filteredParkingLots = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = parkingLots.filter((l) => {
      if (!onlyAccessibleLots) return true;
      const n = Number.parseInt(String(l.handicapSpace ?? '').trim(), 10);
      return Number.isFinite(n) && n > 0;
    });

    if (!q) return filtered;
    return filtered.filter((l) => {
      const hay = `${l.lotName ?? ''} ${l.ownership ?? ''} ${l.mapLabel ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [parkingLots, query, onlyAccessibleLots]);

  const selectedParkingLot = useMemo(() => {
    if (!selectedParkingLotId) return null;
    return parkingLotById.get(selectedParkingLotId) ?? null;
  }, [parkingLotById, selectedParkingLotId]);

  const fitMapToParkingLot = (lotId: string) => {
    const geom = parkingLotGeometries[lotId];
    if (!geom || !mapRef.current) return false;

    const bounds = new google.maps.LatLngBounds();
    for (const polygon of geom.polygons) {
      for (const ring of polygon) {
        for (const pt of ring) bounds.extend(pt);
      }
    }

    if (!bounds.isEmpty()) {
      mapRef.current.fitBounds(bounds, 48);
      return true;
    }

    return false;
  };

  const clearRoute = () => {
    setDirections(null);
    setStatusMsg('Route cleared.');
  };

  const routeTo = (destination: { lat: number; lng: number }, label: string, originOverride?: { lat: number; lng: number }) => {
    if (!isLoaded || !apiKey) {
      setStatusMsg('Map is still loading. Try again in a moment.');
      return;
    }
    const origin = originOverride ?? userPos;
    if (!origin) {
      setStatusMsg('Click “Locate me” first to enable in-app navigation.');
      return;
    }

    const svc = new google.maps.DirectionsService();
    svc.route(
      {
        origin,
        destination,
        travelMode: google.maps.TravelMode[travelMode],
        provideRouteAlternatives: false
      },
      (result, status) => {
        if (status !== 'OK' || !result) {
          setStatusMsg('Could not compute a route. Try again.');
          return;
        }

        setDirections(result);
        setLastRoute({ destination, label });
        const b = result.routes?.[0]?.bounds;
        if (b && mapRef.current) mapRef.current.fitBounds(b, 48);
        setStatusMsg(`Route to ${label} shown on map.`);
      }
    );
  };

  const accessibleLotCentroids = useMemo(() => {
    const out: Record<string, { lat: number; lng: number }> = {};
    for (const [id, geom] of Object.entries(parkingLotGeometries)) {
      const b = new google.maps.LatLngBounds();
      for (const poly of geom.polygons) {
        for (const ring of poly) {
          for (const pt of ring) b.extend(pt);
        }
      }
      if (b.isEmpty()) continue;
      const c = b.getCenter();
      out[id] = { lat: c.lat(), lng: c.lng() };
    }
    return out;
  }, [parkingLotGeometries]);

  const routeSummary = useMemo(() => {
    const leg = directions?.routes?.[0]?.legs?.[0];
    if (!leg) return null;

    const steps = (leg.steps ?? []).map((s) => {
      const stepAny = s as unknown as {
        travel_mode?: string;
        html_instructions?: string;
        instructions?: string;
        distance?: { text?: string };
        duration?: { text?: string };
        transit?: {
          num_stops?: number;
          headsign?: string;
          line?: {
            short_name?: string;
            name?: string;
            vehicle?: { name?: string };
          };
          departure_stop?: { name?: string };
          arrival_stop?: { name?: string };
        };
      };

      const mode = stepAny.travel_mode ?? '';
      const instructionRaw = stepAny.html_instructions ?? stepAny.instructions ?? '';
      const instruction = stripHtml(instructionRaw);
      const distance = stepAny.distance?.text ?? '';
      const duration = stepAny.duration?.text ?? '';

      const transit = stepAny.transit;
      const transitSummary = transit
        ? {
            vehicle: transit.line?.vehicle?.name,
            line: transit.line?.short_name ?? transit.line?.name,
            headsign: transit.headsign,
            from: transit.departure_stop?.name,
            to: transit.arrival_stop?.name,
            stops: transit.num_stops
          }
        : null;

      return { mode, instruction, distance, duration, transitSummary };
    });

    return {
      distance: leg.distance?.text ?? '',
      duration: leg.duration?.text ?? '',
      start: leg.start_address ?? '',
      end: leg.end_address ?? '',
      steps
    };
  }, [directions]);

  return (
    <div className="container">
      <aside className="sidebar" aria-label="Search and results">
        <div className="sidebarTop">
          <div className="header">
            <div className="brand">
              <h1>KingstonAccess</h1>
              <p>Accessible parking finder + availability hint</p>
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

            <label className="toggle">
              <input
                type="checkbox"
                checked={onlyAccessibleLots}
                onChange={(e) => setOnlyAccessibleLots(e.target.checked)}
              />
              Only show lots with accessible spaces
            </label>

            <div style={{ height: 10 }} />

            <div className="label" id="mode-label">Travel mode</div>
            <select
              aria-labelledby="mode-label"
              value={travelMode}
              onChange={(e) => setTravelMode(e.target.value as TravelModeKey)}
            >
              <option value={'DRIVING'}>Driving</option>
              <option value={'TRANSIT'}>Transit</option>
              <option value={'WALKING'}>Walking</option>
            </select>

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
              {directions ? (
                <button type="button" className="secondary" onClick={clearRoute} aria-describedby={ariaStatusId}>
                  Clear route
                </button>
              ) : null}
            </div>

            <div style={{ height: 10 }} />

            <div className="help" id={ariaStatusId} aria-live="polite">
              {statusMsg ?? 'Tip: Use keyboard Tab/Shift+Tab to navigate controls and results.'}
            </div>
          </div>
        </div>

        <div className="sidebarScroll" aria-label="Lists">
          {routeSummary ? (
            <div className="card" role="region" aria-label="Navigation directions">
              <div className="label">Navigation</div>
              <div className="itemMeta">
                Distance: {routeSummary.distance || '—'}
                <br />
                Time: {routeSummary.duration || '—'}
              </div>

              <div style={{ height: 10 }} />

              <div className="list" role="list">
                {routeSummary.steps.map((st, idx) => {
                  const t = st.transitSummary;
                  return (
                    <div key={idx} className="item" role="listitem">
                      <div className="itemTitle">Step {idx + 1}</div>
                      <div className="itemMeta">
                        {t ? (
                          <>
                            {t.vehicle ?? 'Transit'} {t.line ? `(${t.line})` : ''}
                            {t.headsign ? ` toward ${t.headsign}` : ''}
                            <br />
                            From: {t.from ?? '—'}
                            <br />
                            To: {t.to ?? '—'}
                            <br />
                            Stops: {typeof t.stops === 'number' ? t.stops : '—'}
                            <br />
                          </>
                        ) : null}
                        {st.instruction || '—'}
                        <br />
                        {st.distance ? `Distance: ${st.distance}` : null}
                        {st.duration ? ` • Time: ${st.duration}` : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="tabs" role="tablist" aria-label="List tabs">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'results'}
              className={`tabButton ${activeTab === 'results' ? 'active' : ''}`}
              onClick={() => setActiveTab('results')}
            >
              Results
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'lots'}
              className={`tabButton ${activeTab === 'lots' ? 'active' : ''}`}
              onClick={() => setActiveTab('lots')}
            >
              Parking lots
            </button>
          </div>

          {activeTab === 'results' ? (
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
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => routeTo({ lat: s.lat, lng: s.lng }, s.name)}
                        >
                          Navigate
                        </button>
                      </div>
                    </div>
                  );
                })}

                {spots.length === 0 ? (
                  <div className="help">No spots match. Try increasing distance or clearing search.</div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="card" role="region" aria-label="Parking lot areas dataset">
              <div className="label">Parking lots ({filteredParkingLots.length})</div>
              {parkingLotsError ? <div className="help">{parkingLotsError}</div> : null}
              <div className="list" role="list">
                {filteredParkingLots.map((l) => {
                  const handicap = l.handicapSpace ?? '—';
                  const capacity = l.capacity ?? '—';

                  return (
                    <div key={l.id} className="item" role="listitem">
                      <div className="itemHeader">
                        <div>
                          <div className="itemTitle">{l.lotName ?? 'Unnamed lot'}</div>
                          <div className="itemMeta">
                            Owner: {l.ownership ?? '—'}
                            <br />
                            Capacity: {capacity}
                            <br />
                            Accessible spaces: {handicap}
                          </div>
                        </div>
                      </div>

                      <div style={{ height: 10 }} />

                      <div className="row">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              setSelectedParkingLotId(l.id);

                              const fitOk = fitMapToParkingLot(l.id);
                              if (fitOk) {
                                setStatusMsg(`Showing on map: ${l.lotName ?? 'Parking lot'}`);
                                return;
                              }

                              // Fallback when no geometry exists for this lot.
                              setStatusMsg(`Locating: ${l.lotName ?? 'Parking lot'}…`);
                              const pos = await geocodeParkingLot(l);
                              if (mapRef.current) mapRef.current.panTo(pos);
                              setStatusMsg(`Showing on map: ${l.lotName ?? 'Parking lot'}`);
                            } catch {
                              setStatusMsg('Could not locate this parking lot on the map.');
                            }
                          }}
                        >
                          View on map
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            const ok = fitMapToParkingLot(l.id);
                            if (!ok) {
                              setStatusMsg('This lot has no boundary geometry available.');
                              return;
                            }

                            const geom = parkingLotGeometries[l.id];
                            const b = new google.maps.LatLngBounds();
                            for (const poly of geom.polygons) {
                              for (const ring of poly) {
                                for (const pt of ring) b.extend(pt);
                              }
                            }
                            const c = (() => {
                              if (b.isEmpty()) return DEFAULT_CENTER;
                              const center = b.getCenter();
                              return { lat: center.lat(), lng: center.lng() };
                            })();
                            routeTo(c, l.lotName ?? 'Parking lot');
                          }}
                        >
                          Navigate
                        </button>
                      </div>
                    </div>
                  );
                })}
                {filteredParkingLots.length === 0 ? (
                  <div className="help">No parking lots match your search.</div>
                ) : null}
              </div>
            </div>
          )}

          <div className="help">
            Data note: currently using a small built-in demo dataset. Replace with Open Data Kingston feed when available.
          </div>
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
              onLoad={(map) => {
                mapRef.current = map;
              }}
              options={{
                clickableIcons: false,
                streetViewControl: false,
                mapTypeControl: false,
                fullscreenControl: true,
                keyboardShortcuts: true
              }}
            >
              {directions ? (
                <DirectionsRenderer
                  directions={directions}
                  options={{
                    preserveViewport: false,
                    suppressMarkers: false
                  }}
                />
              ) : null}

              {Object.entries(accessibleLotCentroids).map(([id, pos]) => {
                const lot = parkingLotById.get(id);
                const handicapN = Number.parseInt(String(lot?.handicapSpace ?? '').trim(), 10);
                const hasAccessible = Number.isFinite(handicapN) && handicapN > 0;
                if (!hasAccessible) return null;

                return (
                  <MarkerF
                    key={`acc-${id}`}
                    position={pos}
                    title={lot?.lotName ?? 'Accessible parking'}
                    label={{
                      text: '♿',
                      color: '#111827',
                      fontSize: '16px',
                      fontWeight: '700'
                    }}
                    zIndex={10}
                    onClick={() => {
                      setSelectedParkingLotId(id);
                      setStatusMsg(`Selected: ${lot?.lotName ?? 'Parking lot'}`);
                    }}
                  />
                );
              })}

              {userPos ? (
                <MarkerF
                  key="user-location"
                  position={userPos}
                  title="Your location"
                  icon={{
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 7,
                    fillColor: '#2563eb',
                    fillOpacity: 1,
                    strokeColor: '#ffffff',
                    strokeOpacity: 1,
                    strokeWeight: 2
                  }}
                />
              ) : null}

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

              {Object.entries(parkingLotGeometries).flatMap(([id, geom]) => {
                const lot = parkingLotById.get(id);
                const title = lot?.lotName ?? lot?.mapLabel ?? 'Parking lot';
                const isSelected = selectedParkingLotId === id;
                const handicapN = Number.parseInt(String(lot?.handicapSpace ?? '').trim(), 10);
                const hasAccessible = Number.isFinite(handicapN) && handicapN > 0;
                if (onlyAccessibleLots && !hasAccessible) return [];

                const fillColor = hasAccessible ? '#22c55e' : '#ffd54a';
                const strokeColor = hasAccessible ? '#16a34a' : '#ffd54a';

                return geom.polygons.map((rings, idx) => (
                  <PolygonF
                    key={`lot-poly-${id}-${idx}`}
                    paths={rings}
                    options={{
                      clickable: true,
                      fillColor,
                      fillOpacity: isSelected ? 0.35 : 0.18,
                      strokeColor,
                      strokeOpacity: 0.9,
                      strokeWeight: isSelected ? 3 : 2,
                      zIndex: isSelected ? 5 : 2
                    }}
                    onClick={() => {
                      setSelectedParkingLotId(id);
                      setStatusMsg(`Selected: ${title}`);
                    }}
                  />
                ));
              })}

              {Object.entries(parkingLotMarkers).map(([id, pos]) => {
                if (parkingLotGeometries[id]) return null;
                const lot = parkingLotById.get(id);
                const title = lot?.lotName ?? lot?.mapLabel ?? 'Parking lot';

                return (
                  <MarkerF
                    key={`lot-${id}`}
                    position={pos}
                    onClick={() => {
                      setSelectedParkingLotId(id);
                      setStatusMsg(`Selected: ${title}`);
                    }}
                    title={title}
                    icon={{
                      path: google.maps.SymbolPath.CIRCLE,
                      scale: 7,
                      fillColor: '#ffd54a',
                      fillOpacity: 1,
                      strokeColor: '#0b1220',
                      strokeOpacity: 1,
                      strokeWeight: 2
                    }}
                  />
                );
              })}

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

              {selectedParkingLotId && !parkingLotGeometries[selectedParkingLotId] && parkingLotMarkers[selectedParkingLotId] && selectedParkingLot ? (
                <InfoWindowF
                  position={parkingLotMarkers[selectedParkingLotId]}
                  onCloseClick={() => setSelectedParkingLotId(null)}
                >
                  <div style={{ color: '#0b1220', maxWidth: 260 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{selectedParkingLot.lotName ?? 'Parking lot'}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.3 }}>
                      Owner: {selectedParkingLot.ownership ?? '—'}
                      <br />
                      Capacity: {selectedParkingLot.capacity ?? '—'}
                      <br />
                      Accessible spaces: {selectedParkingLot.handicapSpace ?? '—'}
                    </div>
                  </div>
                </InfoWindowF>
              ) : null}

              {selectedParkingLotId && parkingLotGeometries[selectedParkingLotId] && selectedParkingLot ? (() => {
                const geom = parkingLotGeometries[selectedParkingLotId];
                const bounds = new google.maps.LatLngBounds();
                for (const polygon of geom.polygons) {
                  for (const ring of polygon) {
                    for (const pt of ring) bounds.extend(pt);
                  }
                }
                const center = (() => {
                  if (bounds.isEmpty()) return DEFAULT_CENTER;
                  const c = bounds.getCenter();
                  return { lat: c.lat(), lng: c.lng() };
                })();

                return (
                  <InfoWindowF
                    position={center}
                    onCloseClick={() => setSelectedParkingLotId(null)}
                  >
                    <div style={{ color: '#0b1220', maxWidth: 260 }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{selectedParkingLot.lotName ?? 'Parking lot'}</div>
                      <div style={{ fontSize: 13, lineHeight: 1.3 }}>
                        Owner: {selectedParkingLot.ownership ?? '—'}
                        <br />
                        Capacity: {selectedParkingLot.capacity ?? '—'}
                        <br />
                        Accessible spaces: {selectedParkingLot.handicapSpace ?? '—'}
                      </div>
                    </div>
                  </InfoWindowF>
                );
              })() : null}
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
