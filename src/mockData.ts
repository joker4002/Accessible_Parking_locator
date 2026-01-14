import type { ParkingSpot } from './types';

// Sample accessible parking locations around Kingston, ON (approximate).
// Replace with Open Data Kingston dataset once backend/data pipeline is ready.
export const MOCK_SPOTS: ParkingSpot[] = [
  {
    id: 'k1',
    name: 'City Hall (Accessible Stall)',
    lat: 44.2312,
    lng: -76.486,
    zone: 'Downtown',
    hasCurbRamp: true,
    surface: 'paved',
    description: 'Near Kingston City Hall entrance. Short roll to sidewalk.'
  },
  {
    id: 'k2',
    name: 'KGH (Main Entrance Accessible)',
    lat: 44.2286,
    lng: -76.495,
    zone: 'Central',
    hasCurbRamp: true,
    surface: 'paved',
    description: 'Kingston General Hospital accessible stall near main doors.'
  },
  {
    id: 'k3',
    name: 'Market Square (Accessible)',
    lat: 44.2316,
    lng: -76.4854,
    zone: 'Downtown',
    hasCurbRamp: true,
    surface: 'paved',
    description: 'Accessible parking near Market Square—busy on weekends.'
  },
  {
    id: 'k4',
    name: 'Queen\'s University (Union St)',
    lat: 44.2253,
    lng: -76.4951,
    zone: 'Campus',
    hasCurbRamp: true,
    surface: 'paved',
    description: 'Accessible stall near main campus pathways.'
  },
  {
    id: 'k5',
    name: 'Waterfront (Ontario St)',
    lat: 44.2342,
    lng: -76.4842,
    zone: 'Waterfront',
    hasCurbRamp: false,
    surface: 'paved',
    description: 'Waterfront area. Check curb cuts nearby.'
  }
];
