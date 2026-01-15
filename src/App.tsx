import { DirectionsRenderer, GoogleMap, InfoWindowF, MarkerF, PolygonF, useJsApiLoader } from '@react-google-maps/api';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BackboardHttpError, backboardGetOrCreateThread, backboardResetThread, backboardSendMessage } from './backboard';
import { haversineMeters, formatDistance } from './geo';
import parkingLotsCsv from './Parking_Lot_Areas.csv?raw';
import parkingLotsGeoJson from './Parking_Lot_Areas.geojson?raw';
import accessibleFeaturesCsv from './Accessible_Features_at_Kingston_Facilities_7247265357642076518.csv?raw';
import { parseParkingLotAreas } from './parkingLots.ts';
import { parseAccessibleFeatures } from './accessibleFeatures';
import type { ParkingLotArea, ParkingSpot, AccessibleFeature } from './types';
import { Language, t, setLanguage, getLanguage, translations } from './i18n';

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
  const directionsRendererRef = useRef<google.maps.DirectionsRenderer | null>(null);
  const directionsRendererKeyRef = useRef<number>(0);
  const [travelMode, setTravelMode] = useState<TravelModeKey>('DRIVING');
  const [lastRoute, setLastRoute] = useState<{ destination: { lat: number; lng: number }; label: string; viaAccessibleSpot?: boolean } | null>(null);
  const [routeWaypoint, setRouteWaypoint] = useState<
    | { lat: number; lng: number; label: string; kind: 'lot'; id: string }
    | null
  >(null);
  const [aiChatMessages, setAiChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [aiChatInput, setAiChatInput] = useState<string>('');
  const [aiChatError, setAiChatError] = useState<string | null>(null);
  const [isAiChatLoading, setIsAiChatLoading] = useState<boolean>(false);
  const [chatPlaceSuggestions, setChatPlaceSuggestions] = useState<Array<{ label: string; lat: number; lng: number }>>([]);
  const [chatPendingQuery, setChatPendingQuery] = useState<string | null>(null);
  const [nearestOptions, setNearestOptions] = useState<
    Array<{ id: string; kind: 'lot'; label: string; lat: number; lng: number; distanceMeters: number; meta?: string }>
  >([]);
  const [isNearestLoading, setIsNearestLoading] = useState<boolean>(false);
  const [nearestError, setNearestError] = useState<string | null>(null);
  const [accessibleFeatures, setAccessibleFeatures] = useState<AccessibleFeature[]>([]);
  const [nearbyAccessibleFeatures, setNearbyAccessibleFeatures] = useState<{
    total: number;
    byType: Array<{ type: string; count: number }>;
  } | null>(null);
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false);
  const [isRightCollapsed, setIsRightCollapsed] = useState(false);
  const [language, setLanguageState] = useState<Language>(() => getLanguage());
  const [showShortcuts, setShowShortcuts] = useState(false);
  const chatInputRef = useRef<HTMLInputElement>(null);

  const now = useMemo(() => new Date(), []);

  // Update language when state changes
  useEffect(() => {
    setLanguage(language);
    document.documentElement.lang = language === 'fr' ? 'fr-CA' : 'en-CA';
  }, [language]);

  const tr = (key: keyof typeof translations.en, params?: Record<string, string | number>) => {
    const text = translations[language][key] ?? translations.en[key] ?? String(key);
    if (!params) return text;
    let result = text;
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return result;
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'k') {
          e.preventDefault();
          chatInputRef.current?.focus();
        } else if (e.key === 'l') {
          e.preventDefault();
          onLocateMe();
        } else if (e.key === '[') {
          e.preventDefault();
          setIsLeftCollapsed((prev) => !prev);
        } else if (e.key === ']') {
          e.preventDefault();
          setIsRightCollapsed((prev) => !prev);
        }
      } else if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
    // Only show results when a destination (refPos) is selected
    if (!refPos) return [];
    
    const origin = refPos;
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
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 5); // Only show top 5 nearest parking lots

    if (!q) return computed;

    return computed.filter((s) => {
      const hay = `${s.name} ${s.zone ?? ''} ${s.description ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [refPos, radiusKm, filterQuery, parkingLots, lotCentroidsWithAccessibleSpaces, parkingLotMarkers]);

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

  // Extract place name from messages like "im going to shoppers" or "I want to go to metro"
  const extractPlaceName = (message: string): string | null => {
    const lower = message.toLowerCase().trim();
    
    // Common patterns for destination queries
    const patterns = [
      /(?:going to|want to go to|heading to|visiting|need to go to|looking for)\s+(.+?)(?:\s|$|,|\.)/i,
      /(?:go to|visit|find|search for|looking for)\s+(.+?)(?:\s|$|,|\.)/i,
      /^(.+?)(?:\s+in\s+kingston|\s+kingston|$)/i, // Simple place name at start
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        const place = match[1].trim();
        // Remove common stop words and location words
        const cleaned = place
          .replace(/\b(the|a|an|in|at|on|near|by|around)\b/gi, '')
          .trim();
        if (cleaned.length >= 2) {
          return cleaned;
        }
      }
    }

    // If no pattern matches, try the whole message (might be just a place name)
    if (lower.length >= 2 && lower.length < 50) {
      return message.trim();
    }

    return null;
  };

  const onSendAiChat = async () => {
    const msg = aiChatInput.trim();
    if (!msg) return;

    setIsAiChatLoading(true);
    setAiChatError(null);
    setAiChatInput('');
    setChatPlaceSuggestions([]);
    setChatPendingQuery(null);
    setAiChatMessages((prev) => [...prev, { role: 'user', content: msg }]);

    try {
      // First, try to extract place name and search for places
      const placeName = extractPlaceName(msg);
      if (placeName) {
        try {
          const places = await searchPlacesFree(placeName);
          if (places.length > 0) {
            setChatPlaceSuggestions(places);
            setChatPendingQuery(placeName);
            setAiChatMessages((prev) => [...prev, { 
              role: 'assistant', 
              content: tr('foundMatches', { count: places.length, query: placeName }) 
            }]);
            setIsAiChatLoading(false);
            return;
          }
        } catch {
          // If place search fails, continue with AI chat
        }
      }

      // Also try searching the original message directly
      try {
        const places = await searchPlacesFree(msg);
        if (places.length > 0) {
          setChatPlaceSuggestions(places);
          setChatPendingQuery(msg);
          setAiChatMessages((prev) => [...prev, { 
            role: 'assistant', 
            content: tr('foundMatches', { count: places.length, query: msg }) 
          }]);
          setIsAiChatLoading(false);
          return;
        }
      } catch {
        // If place search fails, continue with AI chat
      }

      // If no places found or search failed, use AI chat
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
            '. If this says "Failed to fetch", start the local API server: `node server.mjs`.'
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
        setNearbyAccessibleFeatures(null);
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

        // Find nearby accessible features
        const radiusMeters = 500; // 500m radius
        const nearby = accessibleFeatures
          .filter((f) => {
            const dist = haversineMeters(refPos, { lat: f.lat, lng: f.lng });
            return dist <= radiusMeters && f.status === 'Active';
          })
          .map((f) => ({
            ...f,
            distanceMeters: haversineMeters(refPos, { lat: f.lat, lng: f.lng })
          }))
          .sort((a, b) => a.distanceMeters - b.distanceMeters);

        // Group by type
        const byType = new Map<string, number>();
        for (const f of nearby) {
          byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
        }

        setNearbyAccessibleFeatures({
          total: nearby.length,
          byType: Array.from(byType.entries()).map(([type, count]) => ({ type, count }))
        });
      } catch (e) {
        setNearestError(
          ((e as Error).message || 'API error') +
            '. If the API server is not running, start it: `node server.mjs` (port 8787).'
        );
        setNearestOptions(getNearestAccessibleOptionsTo(refPos, 5));
        setNearbyAccessibleFeatures(null);
      } finally {
        setIsNearestLoading(false);
      }
    };

    void run();
  }, [refPos, accessibleFeatures]);



  useEffect(() => {
    if (!apiKey) {
      setStatusMsg(
        'Missing Google Maps API key. Create a .env.local with VITE_GOOGLE_MAPS_API_KEY=YOUR_KEY then restart the dev server.'
      );
    }
  }, [apiKey]);

  // Auto-locate user position on app load
  useEffect(() => {
    onLocateMe();
  }, []); // Only run once on mount

  // Style Google Maps InfoWindow close button
  useEffect(() => {
    const style = document.createElement('style');
    style.id = 'gm-infowindow-close-style';
    style.textContent = `
      /* Hide all Google Maps InfoWindow close buttons immediately */
      .gm-ui-hover-effect,
      .gm-ui-hover-effect > span,
      .gm-ui-hover-effect > span > img,
      .gm-ui-hover-effect img,
      .gm-style-iw-c .gm-ui-hover-effect,
      .gm-style-iw-d .gm-ui-hover-effect,
      .gm-style-iw-c .gm-ui-hover-effect > span > img,
      .gm-style-iw-d .gm-ui-hover-effect > span > img,
      .gm-style-iw-c .gm-ui-hover-effect img,
      .gm-style-iw-d .gm-ui-hover-effect img,
      .gm-style-iw-c img[src*="close"],
      .gm-style-iw-d img[src*="close"],
      .gm-ui-hover-effect img[src*="close"] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);

    // Use MutationObserver to immediately hide any close buttons that appear
    const observer = new MutationObserver(() => {
      const closeButtons = document.querySelectorAll('.gm-ui-hover-effect');
      closeButtons.forEach((btn) => {
        if (btn instanceof HTMLElement) {
          btn.style.setProperty('display', 'none', 'important');
          btn.style.setProperty('visibility', 'hidden', 'important');
          btn.style.setProperty('opacity', '0', 'important');
          btn.style.setProperty('pointer-events', 'none', 'important');
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    return () => {
      observer.disconnect();
      const existingStyle = document.getElementById('gm-infowindow-close-style');
      if (existingStyle) {
        document.head.removeChild(existingStyle);
      }
    };
  }, []);

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
      const features = parseAccessibleFeatures(accessibleFeaturesCsv);
      setAccessibleFeatures(features);
    } catch (e) {
      console.error('Could not load accessible features CSV:', e);
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
    // Expand common queries to improve search results
    const expandedQuery = query.toLowerCase();
    if (expandedQuery.includes('shopper')) {
      tries.push('Shoppers Drug Mart Kingston, Ontario');
      tries.push(`${query} Kingston, Ontario`);
    } else if (!/\bkingston\b/i.test(query)) {
      tries.push(`${query} Kingston, Ontario`);
    }

    const allResults: Array<{ label: string; lat: number; lng: number }> = [];
    const seen = new Set<string>(); // Track seen locations to avoid duplicates across all tries

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
        
        for (const f of feats) {
          const coords = f.geometry?.coordinates;
          if (!coords || coords.length !== 2) continue;
          const [lng, lat] = coords;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

          const p = f.properties;
          const name = (p?.name || '').trim();
          const street = (p?.street || '').trim();
          const city = (p?.city || '').trim();
          
          // Build label
          const labelParts = [name, street, city, p?.state, p?.country].filter(Boolean);
          const label = labelParts.length ? labelParts.join(', ') : query;
          
          // Create multiple unique keys for better duplicate detection
          // 1. High precision coordinate key (about 1m precision)
          const coordKey = `${Math.round(lat * 100000)},${Math.round(lng * 100000)}`;
          
          // 2. Name + street key (for same store at same street)
          const nameStreetKey = name && street ? `${name.toLowerCase()}:${street.toLowerCase()}` : '';
          
          // 3. Full address key (normalized)
          const fullAddressKey = label.toLowerCase().replace(/\s+/g, ' ').trim();
          
          // Check all keys - if any match, it's a duplicate
          if (seen.has(coordKey) || (nameStreetKey && seen.has(nameStreetKey)) || seen.has(fullAddressKey)) {
            continue;
          }
          
          // Add all keys to seen set
          seen.add(coordKey);
          if (nameStreetKey) seen.add(nameStreetKey);
          seen.add(fullAddressKey);
          
          allResults.push({ label, lat, lng });
          if (allResults.length >= 8) break;
        }
        
        if (allResults.length >= 8) break;
      } catch (e) {
        lastErr = e;
      }
    }

    // Return unique results, limited to 8
    if (allResults.length > 0) {
      return allResults.slice(0, 8);
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

  const resultsCount = nearestOptions.length;
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


  const routeTo = (destination: { lat: number; lng: number }, label: string, originOverride?: { lat: number; lng: number }) => {
    if (!isLoaded || !apiKey) {
      setStatusMsg('Map is still loading. Try again in a moment.');
      return;
    }
    const origin = originOverride ?? userPos;
    if (!origin) {
      setStatusMsg('Click "Locate me" first to enable in-app navigation.');
      return;
    }

    // Clear previous route before creating a new one
    if (directionsRendererRef.current) {
      directionsRendererRef.current.setDirections(null);
      directionsRendererRef.current.setMap(null);
      directionsRendererRef.current = null;
    }
    // Increment key to force React to recreate the DirectionsRenderer component
    directionsRendererKeyRef.current += 1;
    setDirections(null);
    setRouteWaypoint(null);

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
    // Ensure directions are cleared before making new request
    setDirections(null);
    
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
      setStatusMsg('Click "Locate me" first to enable in-app navigation.');
      return;
    }

    // Clear previous route before creating a new one
    if (directionsRendererRef.current) {
      directionsRendererRef.current.setDirections(null);
      directionsRendererRef.current.setMap(null);
      directionsRendererRef.current = null;
    }
    // Increment key to force React to recreate the DirectionsRenderer component
    directionsRendererKeyRef.current += 1;
    setDirections(null);
    setRouteWaypoint(null);

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
    // Ensure directions are cleared before making new request
    setDirections(null);
    
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
    <div className={`container ${isLeftCollapsed ? 'leftCollapsed' : ''} ${isRightCollapsed ? 'rightCollapsed' : ''}`}>
      {showShortcuts && (
        <div className="modalOverlay" onClick={() => setShowShortcuts(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2>{tr('keyboardShortcuts')}</h2>
              <button type="button" onClick={() => setShowShortcuts(false)} aria-label={tr('close')}>×</button>
            </div>
            <div className="modalBody">
              <div className="shortcutItem">
                <kbd>Ctrl+K</kbd> / <kbd>⌘K</kbd>
                <span>{tr('shortcutFocusChat')}</span>
              </div>
              <div className="shortcutItem">
                <kbd>Ctrl+L</kbd> / <kbd>⌘L</kbd>
                <span>{tr('shortcutRelocate')}</span>
              </div>
              <div className="shortcutItem">
                <kbd>Ctrl+[</kbd> / <kbd>⌘[</kbd>
                <span>{tr('shortcutToggleLeftPanel')}</span>
              </div>
              <div className="shortcutItem">
                <kbd>Ctrl+]</kbd> / <kbd>⌘]</kbd>
                <span>{tr('shortcutToggleRightPanel')}</span>
              </div>
              <div className="shortcutItem">
                <kbd>?</kbd>
                <span>{tr('showKeyboardShortcuts')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      <a className="skipLink" href="#main-content">
        {tr('skipToMap')}
      </a>
      <aside className={`sidebar sidebarLeft ${isLeftCollapsed ? 'collapsed' : ''}`} aria-label={tr('chat')}>
        <button
          className={`panelToggle panelToggleLeft ${isLeftCollapsed ? 'collapsed' : ''}`}
          onClick={() => setIsLeftCollapsed(!isLeftCollapsed)}
          aria-label={isLeftCollapsed ? tr('showLeftPanel') : tr('hideLeftPanel')}
        >
          <div className="panelToggleInner">{isLeftCollapsed ? '→' : '←'}</div>
        </button>
        <div className="sidebarTop" style={{ flex: '0 0 auto' }}>
          <div className="header">
            <div className="brand">
              <h1>{tr('appName')}</h1>
              <p>{tr('appSubtitle')}</p>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="helpButton"
                onClick={() => setShowShortcuts(true)}
                aria-label={tr('showKeyboardShortcuts')}
                title={tr('pressForShortcuts')}
              >
                ?
              </button>
              <div className="languageToggle">
                <button
                  type="button"
                  className={`languageButton ${language === 'en' ? 'active' : ''}`}
                  onClick={() => setLanguageState('en')}
                  aria-label="English"
                >
                  EN
                </button>
                <button
                  type="button"
                  className={`languageButton ${language === 'fr' ? 'active' : ''}`}
                  onClick={() => setLanguageState('fr')}
                  aria-label="Français"
                >
                  FR
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="sidebarScroll" style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div className="card" role="region" aria-label={tr('chat')} style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="label">{tr('chat')}</div>

            <div className="list" role="list" style={{ flex: '1 1 auto', overflow: 'auto', minHeight: 0 }}>
              {aiChatMessages.map((m, idx) => (
                <div key={idx} className="chatItem" role="listitem">
                  <div className="chatItemHeader">
                    <span className="chatRole">{m.role === 'user' ? tr('you') : tr('assistant')}</span>
                  </div>
                  <div className="chatItemContent" style={{ whiteSpace: 'pre-wrap' }}>
                    {m.content}
                  </div>
                </div>
              ))}
              {isAiChatLoading && (
                <div className="chatLoadingItem" role="status" aria-live="polite">
                  <div className="loadingMessage">
                    <span className="loadingSpinner" aria-hidden="true"></span>
                    <span>{tr('sendingMessage')}</span>
                  </div>
                  <div className="progressBar" role="progressbar" aria-valuenow={0} aria-valuemin={0} aria-valuemax={100}>
                    <div className="progressBarFill"></div>
                  </div>
                </div>
              )}
              {aiChatMessages.length === 0 && !isAiChatLoading ? (
                <div className="help">
                  {tr('typeDestination', { example: 'Metro' })}
                </div>
              ) : null}

              {chatPlaceSuggestions.length > 0 ? (
                <div className="item" role="listitem">
                  <div className="itemTitle">{tr('matches')}{chatPendingQuery ? tr('matchesFor', { query: chatPendingQuery }) : ''}</div>
                  <div style={{ height: 8 }} />
                  <div className="suggestions" role="list" aria-label={tr('destinationMatches')}>
                    {chatPlaceSuggestions.map((sug, idx) => (
                      <button
                        key={`${sug.lat},${sug.lng},${idx}`}
                        type="button"
                        className="suggestionButton"
                        role="listitem"
                        onClick={() => {
                          selectPlace({ lat: sug.lat, lng: sug.lng }, sug.label);
                          setChatPlaceSuggestions([]);
                          setChatPendingQuery(null);
                          setAiChatMessages((prev) => [...prev, { role: 'assistant', content: tr('selectedSeeResults', { label: sug.label }) }]);
                        }}
                      >
                        {sug.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {aiChatError ? (
              <div className="itemMeta" style={{ marginTop: 10 }}>
                {aiChatError}
              </div>
            ) : null}

            <div className="chatInputWrapper">
              <input
                ref={chatInputRef}
                value={aiChatInput}
                disabled={isAiChatLoading}
                onChange={(e) => setAiChatInput(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void onSendAiChat();
                }}
                placeholder={tr('typeDestinationPlaceholder')}
                inputMode="search"
                className="chatInput"
                aria-label={tr('chatInputLabel')}
              />
              <button type="button" disabled={isAiChatLoading} onClick={onSendAiChat} className="chatSendButton" aria-label={tr('sendMessage')}>
                ↑
              </button>
            </div>

            <div style={{ height: 10 }} />

            <label className="toggle">
              <input
                type="checkbox"
                checked={onlyAccessibleLots}
                onChange={(e) => setOnlyAccessibleLots(e.target.checked)}
              />
              {tr('onlyAccessibleSpaces')}
            </label>

            <div style={{ height: 10 }} />

            <div className="row">
              <button type="button" onClick={onLocateMe} aria-describedby={ariaStatusId}>
                {tr('relocate')}
              </button>
              {directions ? (
                <button type="button" className="secondary" onClick={clearRoute} aria-describedby={ariaStatusId}>
                  {tr('clearRoute')}
                </button>
              ) : null}
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  backboardResetThread();
                  setAiChatMessages([]);
                  setAiChatError(null);
                  setStatusMsg(tr('chatReset'));
                }}
              >
                {tr('resetChat')}
              </button>
            </div>

            <div style={{ height: 10 }} />

            <div className="help" id={ariaStatusId} aria-live="polite">
              {statusMsg ?? tr('tipKeyboardNavigation')}
            </div>
          </div>
        </div>
      </aside>

      <main id="main-content" className="mapWrap" aria-label={tr('map')} tabIndex={-1}>
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

        <div className="map" role="application" aria-label={tr('interactiveMap')}>
          {!isLoaded && !loadError && (
            <div className="mapLoadingOverlay" role="status" aria-live="polite">
              <div className="loadingMessage">
                <span className="loadingSpinner" aria-hidden="true"></span>
                <span>{tr('loadingMap')}</span>
              </div>
              <div className="progressBar" role="progressbar" aria-valuenow={0} aria-valuemin={0} aria-valuemax={100}>
                <div className="progressBarFill"></div>
              </div>
            </div>
          )}
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
                  key={`directions-${directionsRendererKeyRef.current}-${directions.routes?.[0]?.overview_polyline || Date.now()}`}
                  directions={directions}
                  onLoad={(renderer) => {
                    // Clear any previous renderer
                    if (directionsRendererRef.current && directionsRendererRef.current !== renderer) {
                      directionsRendererRef.current.setDirections(null);
                      directionsRendererRef.current.setMap(null);
                    }
                    directionsRendererRef.current = renderer;
                    // Ensure directions are set
                    renderer.setDirections(directions);
                  }}
                  onUnmount={(renderer) => {
                    // Explicitly clear directions when unmounting
                    renderer.setDirections(null);
                    renderer.setMap(null);
                    if (directionsRendererRef.current === renderer) {
                      directionsRendererRef.current = null;
                    }
                  }}
                  options={{
                    preserveViewport: false,
                    suppressMarkers: false,
                    polylineOptions: {
                      strokeColor: '#4285F4',
                      strokeWeight: 5,
                      strokeOpacity: 0.8
                    }
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
                  options={{
                    disableAutoPan: false
                  }}
                    onLoad={(infoWindow) => {
                      // Immediately hide the close button using requestAnimationFrame for instant execution
                      requestAnimationFrame(() => {
                        const closeButtons = document.querySelectorAll('.gm-ui-hover-effect');
                        closeButtons.forEach((btn) => {
                          if (btn instanceof HTMLElement) {
                            btn.style.setProperty('display', 'none', 'important');
                            btn.style.setProperty('visibility', 'hidden', 'important');
                            btn.style.setProperty('opacity', '0', 'important');
                            btn.style.setProperty('pointer-events', 'none', 'important');
                          }
                        });
                      });
                    }}
                >
                  <div 
                    style={{ 
                      color: '#0b1220', 
                      maxWidth: 260,
                      cursor: 'pointer',
                      padding: '4px'
                    }}
                    onClick={() => setSelectedParkingLotId(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedParkingLotId(null);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label="Close parking lot information"
                  >
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{selectedParkingLot.lotName ?? 'Parking lot'}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.3 }}>
                      Owner: {selectedParkingLot.ownership ?? '—'}
                      <br />
                      Capacity: {selectedParkingLot.capacity ?? '—'}
                      <br />
                      Accessible spaces: {selectedParkingLot.handicapSpace ?? '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 8, fontStyle: 'italic' }}>
                      Click anywhere to close
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
                    key={`info-${selectedParkingLotId}`}
                    position={center}
                    onCloseClick={() => setSelectedParkingLotId(null)}
                    options={{
                      disableAutoPan: false
                    }}
                    onLoad={(infoWindow) => {
                      // Immediately hide the close button using requestAnimationFrame for instant execution
                      requestAnimationFrame(() => {
                        const closeButtons = document.querySelectorAll('.gm-ui-hover-effect');
                        closeButtons.forEach((btn) => {
                          if (btn instanceof HTMLElement) {
                            btn.style.setProperty('display', 'none', 'important');
                            btn.style.setProperty('visibility', 'hidden', 'important');
                            btn.style.setProperty('opacity', '0', 'important');
                            btn.style.setProperty('pointer-events', 'none', 'important');
                          }
                        });
                      });
                    }}
                  >
                    <div 
                      style={{ 
                        color: '#0b1220', 
                        maxWidth: 260,
                        cursor: 'pointer',
                        padding: '4px'
                      }}
                      onClick={() => setSelectedParkingLotId(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedParkingLotId(null);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label="Close parking lot information"
                    >
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{selectedParkingLot.lotName ?? 'Parking lot'}</div>
                      <div style={{ fontSize: 13, lineHeight: 1.3 }}>
                        Owner: {selectedParkingLot.ownership ?? '—'}
                        <br />
                        Capacity: {selectedParkingLot.capacity ?? '—'}
                        <br />
                        Accessible spaces: {selectedParkingLot.handicapSpace ?? '—'}
                      </div>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 8, fontStyle: 'italic' }}>
                        Click anywhere to close
                      </div>
                    </div>
                  </InfoWindowF>
                );
              })() : null}
            </GoogleMap>
          ) : (
            <div className="toast">
              <strong>Loading map…</strong>
              <div className="help">If this doesn't load, confirm the API key is set.</div>
            </div>
          )}
        </div>
      </main>

      <aside className={`sidebar sidebarRight ${isRightCollapsed ? 'collapsed' : ''}`} aria-label={tr('results')}>
        <button
          className={`panelToggle panelToggleRight ${isRightCollapsed ? 'collapsed' : ''}`}
          onClick={() => setIsRightCollapsed(!isRightCollapsed)}
          aria-label={isRightCollapsed ? tr('showRightPanel') : tr('hideRightPanel')}
        >
          <div className="panelToggleInner">{isRightCollapsed ? '←' : '→'}</div>
        </button>
        <div className="sidebarScroll" aria-label={tr('lists')}>
          {routeSummary ? (
            <div className="card" role="region" aria-label={tr('navigationDirections')}>
              <div className="label">{tr('navigation')}</div>
              <div className="itemMeta">
                {tr('distance')}: {routeSummary.distance || '—'}
                <br />
                {travelMode === 'DRIVING' ? (
                  <>
                    {tr('withTraffic')}: {routeSummary.durationTraffic || routeSummary.duration || '—'}
                    <br />
                    {tr('base')}: {routeSummary.durationBase || '—'}
                    <br />
                    {tr('delay')}: {routeSummary.durationDelay || '—'}
                  </>
                ) : (
                  <>{tr('time')}: {routeSummary.duration || '—'}</>
                )}
              </div>

              <div style={{ height: 10 }} />

              <div className="list" role="list">
                {routeSummary.legs.flatMap((leg, legIdx) => {
                  const showLegHeader = routeSummary.legs.length > 1;

                  const header = showLegHeader ? (
                    <div key={`leg-h-${legIdx}`} className="item" role="listitem">
                      <div className="itemTitle">{tr('leg')} {legIdx + 1}</div>
                      <div className="itemMeta">
                        {tr('from')}: {leg.start || '—'}
                        <br />
                        {tr('to')}: {leg.end || '—'}
                        <br />
                        {leg.distance ? `${tr('distance')}: ${leg.distance}` : `${tr('distance')}: —`}
                        {leg.duration ? ` • ${tr('time')}: ${leg.duration}` : null}
                      </div>
                    </div>
                  ) : null;

                  const steps = leg.steps.map((st, stepIdx) => {
                    const t = st.transitSummary;
                    return (
                      <div key={`leg-${legIdx}-step-${stepIdx}`} className="item" role="listitem">
                        <div className="itemTitle">{tr('step')} {stepIdx + 1}</div>
                        <div className="itemMeta">
                          {t ? (
                            <>
                              {t.vehicle ?? tr('transit')} {t.line ? `(${t.line})` : ''}
                              {t.headsign ? ` ${tr('toward')} ${t.headsign}` : ''}
                              <br />
                              {tr('from')}: {t.from ?? '—'}
                              <br />
                              {tr('to')}: {t.to ?? '—'}
                              <br />
                              {tr('stops')}: {typeof t.stops === 'number' ? t.stops : '—'}
                              <br />
                            </>
                          ) : null}
                          {st.instruction || '—'}
                          <br />
                          {st.distance ? `${tr('distance')}: ${st.distance}` : null}
                          {st.duration ? ` • ${tr('time')}: ${st.duration}` : null}
                        </div>
                      </div>
                    );
                  });

                  return header ? [header, ...steps] : steps;
                })}
              </div>
            </div>
          ) : null}

          <div className="tabs" role="tablist" aria-label={tr('listTabs')}>
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
              <div className="label">Results ({resultsCount})</div>
              <div className="list" role="list">
                {!refPos ? (
                  <div className="help">
                    {tr('typeDestinationOrRelocate', { example: 'Metro', relocate: tr('relocate') })}
                  </div>
                ) : refPos ? (
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
                    </div>

                    <div style={{ height: 10 }} />

                    {nearbyAccessibleFeatures ? (
                      <div className="itemMeta" style={{ marginBottom: 10, padding: '12px', backgroundColor: 'rgba(0, 0, 0, 0.15)', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                        <strong style={{ display: 'block', marginBottom: '8px', color: 'var(--text)' }}>{tr('nearbyAccessibilityFeatures' as any, { radius: 500 })}:</strong>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                          {nearbyAccessibleFeatures.byType.map(({ type, count }) => (
                            <div key={type} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                              <span>{type}:</span>
                              <strong>{count}</strong>
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: '0.9em', color: 'var(--muted)', borderTop: '1px solid rgba(255, 255, 255, 0.12)', paddingTop: '6px', marginTop: '6px' }}>
                          {tr('total')}: <strong>{nearbyAccessibleFeatures.total}</strong> {tr('features')}
                        </div>
                      </div>
                    ) : null}

                    <div style={{ height: 10 }} />

                    <div className="itemMeta">
                      Nearest accessible options (Top 5)
                    </div>
                    {nearestError ? (
                      <div className="itemMeta" style={{ marginTop: 8 }}>
                        {nearestError}
                      </div>
                    ) : null}
                    <div className="list" role="list">
                      {isNearestLoading ? (
                        <>
                          <div className="progressBar" style={{ marginTop: '12px' }} role="progressbar" aria-valuenow={0} aria-valuemin={0} aria-valuemax={100}>
                            <div className="progressBarFill"></div>
                          </div>
                          {[1, 2, 3].map((i) => (
                            <div key={i} className="skeletonItem" aria-hidden="true">
                              <div className="skeletonText skeletonTextLarge"></div>
                              <div className="skeletonText"></div>
                              <div className="skeletonText skeletonTextSmall"></div>
                            </div>
                          ))}
                        </>
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
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}

                {spots.length === 0 && !refPos ? (
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

          <div className="help" style={{ marginTop: '20px', padding: '16px', backgroundColor: 'rgba(255, 255, 255, 0.05)', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '14px' }}>{tr('privacyNotice' as any)}</div>
            <div style={{ fontSize: '12px', lineHeight: '1.6', color: 'var(--muted)', marginBottom: '8px' }}>
              {tr('privacyText' as any)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--muted)', fontStyle: 'italic' }}>
              {tr('privacyContact' as any)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
              {tr('dataSource')}
            </div>
          </div>

        </div>
      </aside>
    </div>
  );
}
