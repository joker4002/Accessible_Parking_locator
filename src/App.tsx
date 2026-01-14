import { DirectionsRenderer, GoogleMap, InfoWindowF, MarkerF, PolygonF, useJsApiLoader } from '@react-google-maps/api';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BackboardHttpError, backboardGetOrCreateThread, backboardResetThread, backboardSendMessage } from './backboard';
import { haversineMeters, formatDistance } from './geo';
import parkingLotsCsv from './Parking_Lot_Areas.csv?raw';
import parkingLotsGeoJson from './Parking_Lot_Areas.geojson?raw';
import { parseParkingLotAreas } from './parkingLots.ts';
import { predictAvailability } from './predict';
import type { ParkingLotArea, ParkingSpot } from './types';

const DEFAULT_CENTER = { lat: 44.2312, lng: -76.4860 };
const KINGSTON_VIEWBOX = {
  left: -76.80,
  top: 44.40,
  right: -76.25,
  bottom: 44.10
};

type SpotWithDistance = ParkingSpot & {
  distanceMeters: number;
  handicapSpace?: string;
  ownership?: string;
  capacity?: string;
};

type ParkingLotGeometry = {
  // A lot can be MultiPolygon: [polygonIndex][ringIndex][pointIndex]
  polygons: google.maps.LatLngLiteral[][][];
};

type TravelModeKey = 'DRIVING' | 'TRANSIT' | 'WALKING';

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export default function App() {
  const apiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim();
  const backboardLlmProvider = ((import.meta.env.VITE_BACKBOARD_LLM_PROVIDER as string | undefined) ?? 'google').trim();
  const backboardModelName = ((import.meta.env.VITE_BACKBOARD_MODEL_NAME as string | undefined) ?? 'gemini-2.5-flash').trim();

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'kingstonaccess-google-maps',
    googleMapsApiKey: apiKey ?? ''
  });

  const mapRef = useRef<google.maps.Map | null>(null);
  const pendingLotGeocodeRef = useRef<Record<string, Promise<{ lat: number; lng: number }> | undefined>>({});
  const placeSearchAbortRef = useRef<AbortController | null>(null);

  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);
  const [refPos, setRefPos] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(2);
  const [query, setQuery] = useState<string>('');
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [placeSuggestions, setPlaceSuggestions] = useState<Array<{ label: string; lat: number; lng: number }>>([]);
  const [isSearchingPlaces, setIsSearchingPlaces] = useState<boolean>(false);
  const [placeSelected, setPlaceSelected] = useState<boolean>(false);
  const [destinationLabel, setDestinationLabel] = useState<string | null>(null);
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
  const [lastRoute, setLastRoute] = useState<{ destination: { lat: number; lng: number }; label: string; viaAccessibleSpot?: boolean } | null>(null);
  const [routeWaypoint, setRouteWaypoint] = useState<
    | { lat: number; lng: number; label: string; kind: 'lot'; id: string }
    | null
  >(null);
  const [aiAdvice, setAiAdvice] = useState<string | null>(null);
  const [isAiLoading, setIsAiLoading] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiChatMessages, setAiChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [aiChatInput, setAiChatInput] = useState<string>('');
  const [aiChatError, setAiChatError] = useState<string | null>(null);
  const [isAiChatLoading, setIsAiChatLoading] = useState<boolean>(false);
  const [nearestOptions, setNearestOptions] = useState<
    Array<{ id: string; kind: 'lot'; label: string; lat: number; lng: number; distanceMeters: number; meta?: string }>
  >([]);
  const [isNearestLoading, setIsNearestLoading] = useState<boolean>(false);
  const [nearestError, setNearestError] = useState<string | null>(null);
  const [busyPrediction, setBusyPrediction] = useState<{ busy: boolean; probability: number; rationale: string } | null>(null);

  const now = useMemo(() => new Date(), []);

  const parkingLotById = useMemo(() => {
    const m = new Map<string, ParkingLotArea>();
    for (const l of parkingLots) m.set(l.id, l);
    return m;
  }, [parkingLots]);

  const lotCentroidsWithAccessibleSpaces = useMemo(() => {
    const out: Record<string, { lat: number; lng: number }> = {};

    for (const [id, geom] of Object.entries(parkingLotGeometries)) {
      const lot = parkingLotById.get(id);
      const handicapN = Number.parseInt(String(lot?.handicapSpace ?? '').trim(), 10);
      const hasAccessible = Number.isFinite(handicapN) && handicapN > 0;
      if (!hasAccessible) continue;

      let minLat = Number.POSITIVE_INFINITY;
      let maxLat = Number.NEGATIVE_INFINITY;
      let minLng = Number.POSITIVE_INFINITY;
      let maxLng = Number.NEGATIVE_INFINITY;

      for (const polygon of geom.polygons) {
        for (const ring of polygon) {
          for (const pt of ring) {
            if (!Number.isFinite(pt.lat) || !Number.isFinite(pt.lng)) continue;
            minLat = Math.min(minLat, pt.lat);
            maxLat = Math.max(maxLat, pt.lat);
            minLng = Math.min(minLng, pt.lng);
            maxLng = Math.max(maxLng, pt.lng);
          }
        }
      }

      if (!Number.isFinite(minLat) || !Number.isFinite(maxLat) || !Number.isFinite(minLng) || !Number.isFinite(maxLng)) continue;
      out[id] = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
    }

    return out;
  }, [parkingLotGeometries, parkingLotById]);

  const spots: SpotWithDistance[] = useMemo(() => {
    const origin = userPos ?? refPos ?? DEFAULT_CENTER;
    const radM = radiusKm * 1000;
    const q = filterQuery.trim().toLowerCase();

    const computed = parkingLots
      .map((l): SpotWithDistance | null => {
        const handicapN = Number.parseInt(String(l.handicapSpace ?? '').trim(), 10);
        const hasAccessible = Number.isFinite(handicapN) && handicapN > 0;
        if (!hasAccessible) return null;

        const pos = lotCentroidsWithAccessibleSpaces[l.id] ?? parkingLotMarkers[l.id];
        if (!pos) return null;

        const name = l.lotName ?? l.mapLabel ?? 'Accessible parking lot';
        const distanceMeters = haversineMeters(origin, pos);

        const isDowntown = pos.lat >= 44.225 && pos.lat <= 44.245 && pos.lng >= -76.52 && pos.lng <= -76.47;
        const zone = isDowntown ? 'Downtown' : undefined;

        const description =
          `Owner: ${l.ownership ?? '—'}\n` +
          `Capacity: ${l.capacity ?? '—'}\n` +
          `Accessible spaces: ${l.handicapSpace ?? '—'}`;

        return {
          id: l.id,
          name,
          lat: pos.lat,
          lng: pos.lng,
          description,
          ...(zone ? { zone } : {}),
          handicapSpace: l.handicapSpace,
          ownership: l.ownership,
          capacity: l.capacity,
          distanceMeters
        };
      })
      .filter((v): v is SpotWithDistance => v !== null)
      .filter((s) => s.distanceMeters <= radM)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    if (!q) return computed;

    return computed.filter((s) => {
      const hay = `${s.name} ${s.zone ?? ''} ${s.description ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [userPos, refPos, radiusKm, filterQuery, parkingLots, lotCentroidsWithAccessibleSpaces, parkingLotMarkers]);

  const findNearestAccessibleParkingTo = (
    destination: { lat: number; lng: number },
    opts?: { preferLots?: boolean }
  ) => {
    let bestLot: { id: string; lat: number; lng: number; distanceMeters: number; label: string; kind: 'lot' } | null = null;

    for (const [lotId, pos] of Object.entries(lotCentroidsWithAccessibleSpaces)) {
      const lot = parkingLotById.get(lotId);
      const label = lot?.lotName ?? lot?.mapLabel ?? 'Accessible parking lot';
      const d = haversineMeters(destination, pos);
      if (!bestLot || d < bestLot.distanceMeters) {
        bestLot = { id: lotId, lat: pos.lat, lng: pos.lng, distanceMeters: d, label, kind: 'lot' };
      }
    }

    if (opts?.preferLots) return bestLot;
    return bestLot;
  };

  const onSendAiChat = async () => {
    const msg = aiChatInput.trim();
    if (!msg) return;

    setIsAiChatLoading(true);
    setAiChatError(null);
    setAiChatInput('');
    setAiChatMessages((prev) => [...prev, { role: 'user', content: msg }]);

    try {
      const { thread_id } = await backboardGetOrCreateThread();
      const res = await backboardSendMessage({
        thread_id,
        content: msg,
        memory: 'Auto',
        web_search: 'off',
        llm_provider: backboardLlmProvider,
        model_name: backboardModelName
      });

      const text = (res.content ?? '').trim();
      const looksLikeQuotaError = /LLM Invocation Error|insufficient_quota|exceeded your current quota/i.test(text);
      if (!text || looksLikeQuotaError) {
        setAiChatError(
          `AI error. Provider/model requested: ${backboardLlmProvider}/${backboardModelName}. ` +
            'Backboard returned a quota/provider error. Enable the provider in Backboard dashboard or switch to a provider/model that is enabled for this API key.'
        );
        return;
      }

      setAiChatMessages((prev) => [...prev, { role: 'assistant', content: text }]);
    } catch (e) {
      if (e instanceof BackboardHttpError) {
        setAiChatError(e.message);
      } else {
        setAiChatError(
          ((e as Error).message || 'AI request failed') +
            '. If this says “Failed to fetch”, start the local API server: `node server.mjs`.'
        );
      }
    } finally {
      setIsAiChatLoading(false);
    }
  };

  const autoSelectNearestSpotTo = (destination: { lat: number; lng: number }) => {
    const best = findNearestAccessibleParkingTo(destination, { preferLots: true });
    if (!best) return;

    setSelectedParkingLotId(best.id);

    const gmaps = (globalThis as unknown as { google?: { maps?: typeof google.maps } }).google?.maps;
    if (mapRef.current && gmaps) {
      const b = new gmaps.LatLngBounds();
      b.extend(destination);
      b.extend({ lat: best.lat, lng: best.lng });
      mapRef.current.fitBounds(b, 72);
    } else if (mapRef.current) {
      mapRef.current.panTo({ lat: best.lat, lng: best.lng });
    }

    setStatusMsg(`Nearest accessible parking selected (${formatDistance(best.distanceMeters)}).`);
  };

  const getNearestAccessibleOptionsTo = (
    destination: { lat: number; lng: number },
    limit: number
  ): Array<{ id: string; kind: 'lot'; label: string; lat: number; lng: number; distanceMeters: number; meta?: string }> => {
    const out: Array<{ id: string; kind: 'lot'; label: string; lat: number; lng: number; distanceMeters: number; meta?: string }> = [];

    for (const [lotId, pos] of Object.entries(lotCentroidsWithAccessibleSpaces)) {
      const lot = parkingLotById.get(lotId);
      const label = lot?.lotName ?? lot?.mapLabel ?? 'Accessible parking lot';
      const handicap = lot?.handicapSpace ?? '';
      const d = haversineMeters(destination, pos);
      out.push({
        id: lotId,
        kind: 'lot',
        label,
        lat: pos.lat,
        lng: pos.lng,
        distanceMeters: d,
        meta: handicap ? `Accessible spaces: ${handicap}` : undefined
      });
    }

    out.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return out.slice(0, Math.max(0, limit));
  };

  useEffect(() => {
    const run = async () => {
      if (!refPos) {
        setNearestOptions([]);
        setNearestError(null);
        setBusyPrediction(null);
        return;
      }

      setIsNearestLoading(true);
      setNearestError(null);

      try {
        const nearestRes = await fetch(
          `/api/nearest?lat=${encodeURIComponent(refPos.lat)}&lng=${encodeURIComponent(refPos.lng)}&limit=5`
        );
        if (!nearestRes.ok) throw new Error(`Nearest API failed (${nearestRes.status})`);
        const nearestJson = (await nearestRes.json()) as {
          options?: Array<{ id: string; label: string; lat: number; lng: number; handicapSpace?: string; distanceMeters?: number }>;
        };
        const options = (nearestJson.options ?? []).map((o) => ({
          id: o.id,
          kind: 'lot' as const,
          label: o.label,
          lat: o.lat,
          lng: o.lng,
          distanceMeters: o.distanceMeters ?? haversineMeters(refPos, { lat: o.lat, lng: o.lng }),
          meta: o.handicapSpace ? `Accessible spaces: ${o.handicapSpace}` : undefined
        }));
        setNearestOptions(options);

        const predRes = await fetch(`/api/predict?lat=${encodeURIComponent(refPos.lat)}&lng=${encodeURIComponent(refPos.lng)}`);
        if (!predRes.ok) throw new Error(`Predict API failed (${predRes.status})`);
        const predJson = (await predRes.json()) as { busy?: boolean; probability?: number; rationale?: string };
        if (typeof predJson.busy === 'boolean' && typeof predJson.probability === 'number') {
          setBusyPrediction({ busy: predJson.busy, probability: predJson.probability, rationale: predJson.rationale ?? '' });
        } else {
          setBusyPrediction(null);
        }
      } catch (e) {
        setNearestError(
          ((e as Error).message || 'API error') +
            '. If the API server is not running, start it: `node server.mjs` (port 8787).'
        );
        setNearestOptions(getNearestAccessibleOptionsTo(refPos, 5));
        setBusyPrediction({
          busy: isBusyNow(refPos),
          probability: isBusyNow(refPos) ? 0.35 : 0.7,
          rationale: isBusyNow(refPos)
            ? 'Saturday morning downtown tends to be busiest.'
            : 'Typical availability expected for this area.'
        });
      } finally {
        setIsNearestLoading(false);
      }
    };

    void run();
  }, [refPos]);

  const isBusyNow = (dest: { lat: number; lng: number }) => {
    const d = new Date();
    const isSaturday = d.getDay() === 6;
    const hour = d.getHours();
    const isMorning = hour >= 9 && hour <= 12;
    const isDowntown = dest.lat >= 44.225 && dest.lat <= 44.245 && dest.lng >= -76.52 && dest.lng <= -76.47;
    return isSaturday && isMorning && isDowntown;
  };

  const reportData = async (payload: unknown) => {
    try {
      const text = JSON.stringify(payload, null, 2);
      await navigator.clipboard.writeText(text);
      setStatusMsg('Copied report details to clipboard.');
    } catch {
      setStatusMsg('Could not copy report details.');
    }
  };

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

  const searchPlacesFree = async (q: string, signal?: AbortSignal): Promise<Array<{ label: string; lat: number; lng: number }>> => {
    const query = q.trim();
    if (!query) return [];

    const bbox = `${KINGSTON_VIEWBOX.left},${KINGSTON_VIEWBOX.bottom},${KINGSTON_VIEWBOX.right},${KINGSTON_VIEWBOX.top}`;
    const makeUrl = (qq: string) => {
      const u = new URL('https://photon.komoot.io/api/');
      u.searchParams.set('q', qq);
      u.searchParams.set('limit', '8');
      u.searchParams.set('bbox', bbox);
      u.searchParams.set('lang', 'en');
      u.searchParams.set('lat', String(DEFAULT_CENTER.lat));
      u.searchParams.set('lon', String(DEFAULT_CENTER.lng));
      return u;
    };

    const tries: string[] = [];
    tries.push(query);
    if (!/\bkingston\b/i.test(query)) tries.push(`${query} Kingston, Ontario`);

    let lastErr: unknown = null;
    for (const t of tries) {
      try {
        const res = await fetch(makeUrl(t).toString(), {
          signal,
          headers: {
            Accept: 'application/json'
          }
        });
        if (!res.ok) throw new Error(`Search failed (${res.status})`);

        const json = (await res.json()) as {
          type?: string;
          features?: Array<{
            type?: string;
            geometry?: { type?: string; coordinates?: [number, number] };
            properties?: { name?: string; street?: string; city?: string; state?: string; country?: string; osm_value?: string };
          }>;
        };

        const feats = json.features ?? [];
        const out: Array<{ label: string; lat: number; lng: number }> = [];
        for (const f of feats) {
          const coords = f.geometry?.coordinates;
          if (!coords || coords.length !== 2) continue;
          const [lng, lat] = coords;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

          const p = f.properties;
          const labelParts = [p?.name, p?.street, p?.city, p?.state, p?.country].filter(Boolean);
          const label = labelParts.length ? labelParts.join(', ') : query;
          out.push({ label, lat, lng });
          if (out.length >= 8) break;
        }
        return out;
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr ?? new Error('Search failed');
  };

  const selectPlace = (pos: { lat: number; lng: number }, label?: string) => {
    setRefPos(pos);
    setFilterQuery('');
    setActiveTab('results');
    setPlaceSuggestions([]);
    setPlaceSelected(true);
    setDestinationLabel(label ?? null);
    setRouteWaypoint(null);
    if (label) setStatusMsg(`Selected: ${label}`);

    if (mapRef.current) {
      mapRef.current.panTo(pos);
      mapRef.current.setZoom(15);
    }

    setStatusMsg('Place selected. Selecting nearest accessible parking…');
    autoSelectNearestSpotTo(pos);
  };

  useEffect(() => {
    if (placeSelected) return;
    const raw = query.trim();
    if (raw.length < 2) {
      setPlaceSuggestions([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        placeSearchAbortRef.current?.abort();
        const ctrl = new AbortController();
        placeSearchAbortRef.current = ctrl;

        setIsSearchingPlaces(true);
        const results = await searchPlacesFree(raw, ctrl.signal);
        setPlaceSuggestions(results);
        if (results.length > 0) {
          setStatusMsg('Select a place below.');
        }
      } catch (e) {
        if ((e as { name?: string } | null)?.name !== 'AbortError') {
          setPlaceSuggestions([]);
        }
      } finally {
        setIsSearchingPlaces(false);
      }
    }, 350);

    return () => window.clearTimeout(timer);
  }, [query, placeSelected]);

  const geocodeAddress = async (address: string): Promise<{ lat: number; lng: number }> => {
    if (!isLoaded || !apiKey) throw new Error('Google Maps not loaded');
    const gmaps = (globalThis as unknown as { google?: { maps?: typeof google.maps } }).google?.maps;
    if (!gmaps) throw new Error('Google Maps not loaded');

    const bounds = new gmaps.LatLngBounds(
      new gmaps.LatLng(DEFAULT_CENTER.lat - 0.2, DEFAULT_CENTER.lng - 0.25),
      new gmaps.LatLng(DEFAULT_CENTER.lat + 0.2, DEFAULT_CENTER.lng + 0.25)
    );

    const tries: string[] = [];
    const raw = address.trim();
    if (raw) tries.push(raw);
    if (raw && !/\bkingston\b/i.test(raw)) tries.push(`${raw} Kingston, ON`);

    const tryOne = (addr: string) =>
      new Promise<{ lat: number; lng: number }>((resolve, reject) => {
        const geocoder = new gmaps.Geocoder();
        geocoder.geocode(
          {
            address: addr,
            bounds,
            region: 'ca'
          },
          (results, status) => {
            if (status !== 'OK' || !results || results.length === 0) {
              reject(new Error(`Geocode failed (${status})`));
              return;
            }

            const loc = results[0].geometry.location;
            resolve({ lat: loc.lat(), lng: loc.lng() });
          }
        );
      });

    let lastErr: unknown = null;
    for (const t of tries) {
      try {
        return await tryOne(t);
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr ?? new Error('Geocode failed');
  };

  const onUseMapCenterAsLocation = () => {
    const c = mapRef.current?.getCenter();
    if (!c) {
      setStatusMsg('Map is not ready yet.');
      return;
    }

    const next = { lat: c.lat(), lng: c.lng() };
    setUserPos(next);
    setStatusMsg('Using map center as your location.');

    if (lastRoute) {
      if (lastRoute.viaAccessibleSpot) {
        routeToViaAccessibleSpot(lastRoute.destination, lastRoute.label, next);
      } else {
        routeTo(lastRoute.destination, lastRoute.label, next);
      }
    }
  };

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
          if (lastRoute.viaAccessibleSpot) {
            routeToViaAccessibleSpot(lastRoute.destination, lastRoute.label, next);
          } else {
            routeTo(lastRoute.destination, lastRoute.label, next);
          }
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
    setRefPos(null);
    setDestinationLabel(null);
    setStatusMsg('Centered on Downtown Kingston.');
    if (mapRef.current) mapRef.current.panTo(DEFAULT_CENTER);
  };

  const ariaStatusId = 'app-status';

  const filteredParkingLots = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
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
  }, [parkingLots, filterQuery, onlyAccessibleLots]);

  const resultsCount = spots.length;
  const parkingLotsCount = filteredParkingLots.length;

  useEffect(() => {
    const q = filterQuery.trim();
    if (!q) return;

    if (activeTab === 'results' && resultsCount === 0 && parkingLotsCount > 0) {
      setActiveTab('lots');
      return;
    }

    if (activeTab === 'lots' && parkingLotsCount === 0 && resultsCount > 0) {
      setActiveTab('results');
    }
  }, [activeTab, filterQuery, resultsCount, parkingLotsCount]);

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
    setRouteWaypoint(null);
    setStatusMsg('Route cleared.');
  };

  const onAskAiAdvice = async () => {
    if (!refPos) {
      setAiError('Select a destination first.');
      return;
    }

    setIsAiLoading(true);
    setAiError(null);
    try {
      const { thread_id } = await backboardGetOrCreateThread();

      const originText = userPos ? `User location: (${userPos.lat.toFixed(5)}, ${userPos.lng.toFixed(5)})` : 'User location: unknown';
      const destinationText = `Destination: ${destinationLabel ?? 'Selected destination'} (${refPos.lat.toFixed(5)}, ${refPos.lng.toFixed(5)})`;
      const waypointText = routeWaypoint
        ? `Chosen accessible parking waypoint: ${routeWaypoint.label} (${routeWaypoint.lat.toFixed(5)}, ${routeWaypoint.lng.toFixed(5)})`
        : 'Chosen accessible parking waypoint: not computed yet';
      const modeText = `Travel mode: ${travelMode}`;

      const prompt =
        `You are helping a wheelchair user in Kingston, Ontario.\n` +
        `${originText}\n` +
        `${destinationText}\n` +
        `${waypointText}\n` +
        `${modeText}\n\n` +
        `Task: Give short bullet-point advice for the best accessible parking stop (near the destination), and estimate the chance of finding an accessible spot now. ` +
        `If the waypoint seems suboptimal, suggest a better alternative near the destination. Keep it concise.`;

      const res = await backboardSendMessage({
        thread_id,
        content: prompt,
        memory: 'Auto',
        web_search: 'off',
        llm_provider: backboardLlmProvider,
        model_name: backboardModelName
      });

      const text = (res.content ?? '').trim();
      if (!text) {
        setAiError('AI response was empty.');
        return;
      }

      const looksLikeQuotaError = /LLM Invocation Error|insufficient_quota|exceeded your current quota/i.test(text);
      if (looksLikeQuotaError) {
        setAiAdvice(null);
        setAiError(
          `AI quota/provider error. Provider/model requested: ${backboardLlmProvider}/${backboardModelName}. ` +
            'Backboard returned an LLM invocation error (quota/billing). Fix: in Backboard dashboard, enable the chosen provider (and billing/keys) or switch to a provider/model that is enabled for this API key; then restart the dev server and click “Reset AI”.'
        );
        return;
      }

      setAiAdvice(text);
    } catch (e) {
      if (e instanceof BackboardHttpError) {
        if (e.status === 429) {
          setAiError(
            `AI quota exceeded (429). Provider/model requested: ${backboardLlmProvider}/${backboardModelName}. ` +
              'Backboard is still returning an OpenAI-style insufficient_quota error, which usually means the chosen provider is not configured/available for this Backboard API key, or it is falling back to OpenAI internally. ' +
              'Fix: In Backboard dashboard, ensure the provider is enabled (and billing/keys are set). Then restart the dev server and click “Reset AI”.'
          );
          return;
        }
        setAiError(e.message);
        return;
      }
      setAiError(
        ((e as Error).message || 'AI request failed') +
          '. If this says “Failed to fetch”, start the local API server: `node server.mjs`.'
      );
    } finally {
      setIsAiLoading(false);
    }
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
    const request: google.maps.DirectionsRequest = {
      origin,
      destination,
      travelMode: google.maps.TravelMode[travelMode],
      provideRouteAlternatives: false
    };
    if (travelMode === 'DRIVING') {
      (request as unknown as { drivingOptions?: unknown }).drivingOptions = {
        departureTime: new Date(),
        trafficModel: 'bestguess'
      };
    }
    svc.route(
      request,
      (result, status) => {
        if (status !== 'OK' || !result) {
          setStatusMsg('Could not compute a route. Try again.');
          return;
        }

        setDirections(result);
        setRouteWaypoint(null);
        setLastRoute({ destination, label, viaAccessibleSpot: false });
        const b = result.routes?.[0]?.bounds;
        if (b && mapRef.current) mapRef.current.fitBounds(b, 48);
        setStatusMsg(`Route to ${label} shown on map.`);
      }
    );
  };

  const routeToViaAccessibleSpot = (destination: { lat: number; lng: number }, label: string, originOverride?: { lat: number; lng: number }) => {
    if (!isLoaded || !apiKey) {
      setStatusMsg('Map is still loading. Try again in a moment.');
      return;
    }
    const origin = originOverride ?? userPos;
    if (!origin) {
      setStatusMsg('Click “Locate me” first to enable in-app navigation.');
      return;
    }

    const computedNearest = findNearestAccessibleParkingTo(destination, { preferLots: true });
    const chosen = routeWaypoint ?? computedNearest;
    if (!chosen) {
      routeTo(destination, label, origin);
      return;
    }

    setSelectedParkingLotId(chosen.id);
    if (!routeWaypoint) {
      setRouteWaypoint({ lat: chosen.lat, lng: chosen.lng, label: chosen.label, kind: 'lot', id: chosen.id });
    }
    const svc = new google.maps.DirectionsService();
    const request: google.maps.DirectionsRequest = {
      origin,
      destination,
      waypoints: [{ location: { lat: chosen.lat, lng: chosen.lng }, stopover: true }],
      optimizeWaypoints: false,
      travelMode: google.maps.TravelMode[travelMode],
      provideRouteAlternatives: false
    };
    if (travelMode === 'DRIVING') {
      (request as unknown as { drivingOptions?: unknown }).drivingOptions = {
        departureTime: new Date(),
        trafficModel: 'bestguess'
      };
    }
    svc.route(
      request,
      (result, status) => {
        if (status !== 'OK' || !result) {
          setStatusMsg('Could not compute a route. Try again.');
          return;
        }

        setDirections(result);
        setLastRoute({ destination, label, viaAccessibleSpot: true });
        const b = result.routes?.[0]?.bounds;
        if (b && mapRef.current) mapRef.current.fitBounds(b, 48);
        setStatusMsg(`Route to ${label} via accessible parking shown on map.`);
      }
    );
  };

  const accessibleLotCentroids = lotCentroidsWithAccessibleSpaces;

  const routeSummary = useMemo(() => {
    const route = directions?.routes?.[0];
    const legs = route?.legs ?? [];
    if (legs.length === 0) return null;

    const totalDistanceM = legs.reduce((acc, l) => acc + (l.distance?.value ?? 0), 0);
    const totalBaseDurationS = legs.reduce((acc, l) => acc + (l.duration?.value ?? 0), 0);
    const totalDurationS = legs.reduce((acc, l) => {
      const anyLeg = l as unknown as { duration_in_traffic?: { value?: number } };
      const useTraffic = travelMode === 'DRIVING' && anyLeg.duration_in_traffic?.value != null;
      return acc + (useTraffic ? (anyLeg.duration_in_traffic?.value ?? 0) : (l.duration?.value ?? 0));
    }, 0);

    const fmtM = (m: number) => {
      if (!Number.isFinite(m)) return '';
      if (m < 1000) return `${Math.round(m)} m`;
      return `${(m / 1000).toFixed(1)} km`;
    };
    const fmtS = (s: number) => {
      if (!Number.isFinite(s)) return '';
      const mins = Math.round(s / 60);
      if (mins < 60) return `${mins} min`;
      const h = Math.floor(mins / 60);
      const r = mins % 60;
      return `${h} hr ${r} min`;
    };

    const legSummaries = legs.map((leg) => {
      const anyLeg = leg as unknown as { duration_in_traffic?: { text?: string; value?: number } };
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
        distance: leg.distance?.text ?? (leg.distance?.value != null ? fmtM(leg.distance.value) : ''),
        duration:
          (travelMode === 'DRIVING' ? anyLeg.duration_in_traffic?.text : undefined) ??
          leg.duration?.text ??
          (leg.duration?.value != null ? fmtS(leg.duration.value) : ''),
        start: leg.start_address ?? '',
        end: leg.end_address ?? '',
        steps
      };
    });

    return {
      distance: route?.legs?.[0]?.distance?.text && legs.length === 1 ? legs[0].distance?.text ?? '' : fmtM(totalDistanceM),
      duration: route?.legs?.[0]?.duration?.text && legs.length === 1 ? legs[0].duration?.text ?? '' : fmtS(totalDurationS),
      durationBase: fmtS(totalBaseDurationS),
      durationTraffic: fmtS(totalDurationS),
      durationDelay: fmtS(Math.max(0, totalDurationS - totalBaseDurationS)),
      legs: legSummaries
    };
  }, [directions, travelMode]);

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
              aria-busy={isSearchingPlaces}
              value={query}
              disabled={isSearchingPlaces}
              onChange={(e) => {
                const next = e.target.value;
                setQuery(next);
                setPlaceSelected(false);
                setRefPos(null);
                setDestinationLabel(null);
                setFilterQuery('');
              }}
              onKeyDown={async (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key !== 'Enter') return;
                const raw = query.trim();
                e.preventDefault();

                if (!raw) return;

                if (placeSuggestions.length > 0) {
                  const top = placeSuggestions[0];
                  selectPlace({ lat: top.lat, lng: top.lng }, top.label);
                  return;
                }

                try {
                  setIsSearchingPlaces(true);
                  setStatusMsg('Searching Kingston…');
                  const results = await searchPlacesFree(raw);
                  if (results.length === 0) throw new Error('No results');

                  if (results.length === 1) {
                    const top = results[0];
                    selectPlace({ lat: top.lat, lng: top.lng }, top.label);
                  } else {
                    setPlaceSuggestions(results);
                    setStatusMsg('Multiple matches found. Select a place below.');
                  }
                } catch {
                  try {
                    setStatusMsg('Search failed. Trying alternate lookup…');
                    const pos = await geocodeAddress(raw);
                    selectPlace(pos, raw);
                  } catch {
                    setStatusMsg('Could not find that location. Showing filtered results instead (try adding “Kingston, ON”).');
                  }
                } finally {
                  setIsSearchingPlaces(false);
                }
              }}
              placeholder="e.g., Downtown, KGH, Market Square"
              inputMode="search"
            />

            {placeSuggestions.length > 0 ? (
              <div className="suggestions" role="list" aria-label="Place suggestions">
                {placeSuggestions.map((sug, idx) => (
                  <button
                    key={`${sug.lat},${sug.lng},${idx}`}
                    type="button"
                    className="suggestionButton"
                    role="listitem"
                    onClick={() => {
                      selectPlace({ lat: sug.lat, lng: sug.lng }, sug.label);
                    }}
                  >
                    {sug.label}
                  </button>
                ))}
              </div>
            ) : null}

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
              <button type="button" className="secondary" onClick={onUseMapCenterAsLocation} aria-describedby={ariaStatusId}>
                Use map center
              </button>
              {directions ? (
                <button type="button" className="secondary" onClick={clearRoute} aria-describedby={ariaStatusId}>
                  Clear route
                </button>
              ) : null}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  backboardResetThread();
                  setAiAdvice(null);
                  setAiError(null);
                  setAiChatMessages([]);
                  setAiChatError(null);
                  setStatusMsg('AI thread reset.');
                }}
              >
                Reset AI
              </button>
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
                {travelMode === 'DRIVING' ? (
                  <>
                    With traffic: {routeSummary.durationTraffic || routeSummary.duration || '—'}
                    <br />
                    Base: {routeSummary.durationBase || '—'}
                    <br />
                    Delay: {routeSummary.durationDelay || '—'}
                  </>
                ) : (
                  <>Time: {routeSummary.duration || '—'}</>
                )}
              </div>

              <div style={{ height: 10 }} />

              <div className="list" role="list">
                {routeSummary.legs.flatMap((leg, legIdx) => {
                  const header = (
                    <div key={`leg-h-${legIdx}`} className="item" role="listitem">
                      <div className="itemTitle">Leg {legIdx + 1}</div>
                      <div className="itemMeta">
                        From: {leg.start || '—'}
                        <br />
                        To: {leg.end || '—'}
                        <br />
                        {leg.distance ? `Distance: ${leg.distance}` : 'Distance: —'}
                        {leg.duration ? ` • Time: ${leg.duration}` : null}
                      </div>
                    </div>
                  );

                  const steps = leg.steps.map((st, stepIdx) => {
                    const t = st.transitSummary;
                    return (
                      <div key={`leg-${legIdx}-step-${stepIdx}`} className="item" role="listitem">
                        <div className="itemTitle">Step {stepIdx + 1}</div>
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
                  });

                  return [header, ...steps];
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
              Results ({resultsCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'lots'}
              className={`tabButton ${activeTab === 'lots' ? 'active' : ''}`}
              onClick={() => setActiveTab('lots')}
            >
              Parking lots ({parkingLotsCount})
            </button>
          </div>

          {activeTab === 'results' ? (
            <div className="card" role="region" aria-label="Results list">
              <div className="label">Results ({spots.length})</div>
              <div className="list" role="list">
                {refPos ? (
                  <div className="item" role="listitem">
                    <div className="itemHeader">
                      <div>
                        <div className="itemTitle">{destinationLabel ?? 'Selected destination'}</div>
                        <div className="itemMeta">
                          Destination
                          <br />
                          Lat: {refPos.lat.toFixed(5)}
                          <br />
                          Lng: {refPos.lng.toFixed(5)}
                        </div>
                      </div>
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="row">
                      <button
                        type="button"
                        onClick={() => {
                          setStatusMsg(`Selected: ${destinationLabel ?? 'Destination'}`);
                          if (mapRef.current) {
                            mapRef.current.panTo(refPos);
                            mapRef.current.setZoom(15);
                          }
                        }}
                      >
                        View on map
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => routeToViaAccessibleSpot(refPos, destinationLabel ?? 'Destination')}
                      >
                        Navigate (via accessible parking)
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={isAiLoading}
                        onClick={onAskAiAdvice}
                      >
                        {isAiLoading ? 'AI…' : 'AI advice'}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          reportData({
                            type: 'destination',
                            label: destinationLabel ?? 'Selected destination',
                            lat: refPos.lat,
                            lng: refPos.lng
                          });
                        }}
                      >
                        Report data
                      </button>
                    </div>

                    {aiError ? (
                      <div className="itemMeta" style={{ marginTop: 10 }}>
                        {aiError}
                      </div>
                    ) : null}

                    {aiAdvice ? (
                      <div className="itemMeta" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
                        {aiAdvice}
                      </div>
                    ) : null}

                    <div style={{ height: 10 }} />

                    <div className="itemMeta">
                      Nearest accessible options (Top 5)
                      {busyPrediction?.busy ? ' • Busy now (heuristic)' : ''}
                    </div>
                    {nearestError ? (
                      <div className="itemMeta" style={{ marginTop: 8 }}>
                        {nearestError}
                      </div>
                    ) : null}
                    {busyPrediction ? (
                      <div className="itemMeta" style={{ marginTop: 8 }}>
                        Availability hint: {Math.round(busyPrediction.probability * 100)}% • {busyPrediction.rationale}
                      </div>
                    ) : null}
                    <div className="list" role="list">
                      {isNearestLoading ? (
                        <div className="help">Loading nearest options…</div>
                      ) : nearestOptions.length === 0 ? (
                        <div className="help">No accessible parking lots found.</div>
                      ) : (
                        nearestOptions.map((opt) => (
                          <div key={`${opt.kind}-${opt.id}`} className="item" role="listitem">
                            <div className="itemTitle">{opt.label}</div>
                            <div className="itemMeta">
                              Type: Parking lot
                              <br />
                              Distance: {formatDistance(opt.distanceMeters)}
                              {opt.meta ? (
                                <>
                                  <br />
                                  {opt.meta}
                                </>
                              ) : null}
                            </div>
                            <div style={{ height: 10 }} />
                            <div className="row">
                              <button
                                type="button"
                                onClick={() => {
                                  setRouteWaypoint({ lat: opt.lat, lng: opt.lng, label: opt.label, kind: 'lot', id: opt.id });
                                  if (mapRef.current) mapRef.current.panTo({ lat: opt.lat, lng: opt.lng });
                                  setStatusMsg('Waypoint updated. Click Navigate again to reroute.');
                                }}
                              >
                                Use as waypoint
                              </button>
                              <button type="button" className="secondary" onClick={() => reportData(opt)}>
                                Report data
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}

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
                            Accessible spaces: {s.handicapSpace ?? '—'}
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
                        Owner: {s.ownership ?? '—'}
                        <br />
                        Capacity: {s.capacity ?? '—'}
                      </div>

                      <div style={{ height: 10 }} />

                      <div className="row">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedParkingLotId(s.id);
                            setStatusMsg(`Selected: ${s.name}`);
                            if (!fitMapToParkingLot(s.id) && mapRef.current) mapRef.current.panTo({ lat: s.lat, lng: s.lng });
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
                        <button type="button" className="secondary" onClick={() => reportData(s)}>
                          Report data
                        </button>
                      </div>
                    </div>
                  );
                })}

                {spots.length === 0 ? (
                  <div className="help">
                    No accessible parking lots match.
                    {parkingLotsCount > 0 ? (
                      <>
                        {' '}
                        Found {parkingLotsCount} matching parking lot{parkingLotsCount === 1 ? '' : 's'}.{' '}
                        <button type="button" className="linkButton" onClick={() => setActiveTab('lots')}>
                          View parking lots
                        </button>
                      </>
                    ) : (
                      <> Try increasing distance or clearing search.</>
                    )}
                  </div>
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
                        <button type="button" className="secondary" onClick={() => reportData(l)}>
                          Report data
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

          <div className="card" role="region" aria-label="AI chat">
            <div className="label">AI Chat</div>
            <div className="itemMeta">
              Provider/model: {backboardLlmProvider}/{backboardModelName}
            </div>

            <div style={{ height: 10 }} />

            <div className="list" role="list">
              {aiChatMessages.map((m, idx) => (
                <div key={idx} className="item" role="listitem">
                  <div className="itemTitle">{m.role === 'user' ? 'You' : 'AI'}</div>
                  <div className="itemMeta" style={{ whiteSpace: 'pre-wrap' }}>
                    {m.content}
                  </div>
                </div>
              ))}
              {aiChatMessages.length === 0 ? <div className="help">Ask about parking, accessibility, or route choices.</div> : null}
            </div>

            {aiChatError ? (
              <div className="itemMeta" style={{ marginTop: 10 }}>
                {aiChatError}
              </div>
            ) : null}

            <div style={{ height: 10 }} />

            <div className="row">
              <input
                value={aiChatInput}
                disabled={isAiChatLoading}
                onChange={(e) => setAiChatInput(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void onSendAiChat();
                }}
                placeholder="Ask the AI…"
              />
              <button type="button" disabled={isAiChatLoading} onClick={onSendAiChat}>
                {isAiChatLoading ? 'Sending…' : 'Send'}
              </button>
            </div>
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
                if (routeWaypoint?.kind === 'lot' && routeWaypoint.id === id) return null;
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

              {refPos ? (
                <MarkerF
                  key="ref-location"
                  position={refPos}
                  title="Searched location"
                  label={{
                    text: '📍',
                    color: '#111827',
                    fontSize: '16px',
                    fontWeight: '700'
                  }}
                  zIndex={11}
                />
              ) : null}

              {routeWaypoint ? (
                <MarkerF
                  key={`route-waypoint-${routeWaypoint.kind}-${routeWaypoint.id}`}
                  position={{ lat: routeWaypoint.lat, lng: routeWaypoint.lng }}
                  title={routeWaypoint.label}
                  label={{
                    text: '♿',
                    color: '#111827',
                    fontSize: '16px',
                    fontWeight: '700'
                  }}
                  zIndex={12}
                  onClick={() => {
                    setStatusMsg(`Waypoint: ${routeWaypoint.label}`);
                    setSelectedParkingLotId(routeWaypoint.id);
                  }}
                />
              ) : null}

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
