export type ParkingSpot = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  description?: string;
  hasCurbRamp?: boolean;
  surface?: 'paved' | 'gravel' | 'unknown';
  zone?: string;
};

export type AvailabilityPrediction = {
  probability: number; // 0..1
  label: 'High' | 'Medium' | 'Low';
  rationale: string;
};

export type ParkingLotArea = {
  id: string;
  objectId?: string;
  lotId?: string;
  lotName?: string;
  capacity?: string;
  controlType?: string;
  handicapSpace?: string;
  ownership?: string;
  mapLabel?: string;
  shapeLength?: string;
  shapeArea?: string;
};

export type AccessibleFeature = {
  objectId: string;
  type: string;
  status: string;
  facilityName: string;
  comment?: string;
  globalId: string;
  x: number; // Web Mercator X
  y: number; // Web Mercator Y
  lat: number; // Converted latitude
  lng: number; // Converted longitude
};