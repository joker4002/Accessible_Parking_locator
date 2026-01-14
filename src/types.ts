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
