import type { AccessibleFeature } from './types';

// Convert Web Mercator (EPSG:3857) to WGS84 (lat/lng)
function webMercatorToLatLng(x: number, y: number): { lat: number; lng: number } {
  const lng = (x / 20037508.34) * 180;
  let lat = (y / 20037508.34) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return { lat, lng };
}

export function parseAccessibleFeatures(csv: string): AccessibleFeature[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  const objIdIdx = headers.indexOf('OBJECTID');
  const typeIdx = headers.indexOf('Type');
  const statusIdx = headers.indexOf('Status');
  const facilityIdx = headers.indexOf('Facility Name');
  const commentIdx = headers.indexOf('Comment');
  const globalIdIdx = headers.indexOf('GlobalID');
  const xIdx = headers.indexOf('x');
  const yIdx = headers.indexOf('y');

  if (
    objIdIdx === -1 ||
    typeIdx === -1 ||
    statusIdx === -1 ||
    facilityIdx === -1 ||
    globalIdIdx === -1 ||
    xIdx === -1 ||
    yIdx === -1
  ) {
    return [];
  }

  const features: AccessibleFeature[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Simple CSV parsing (handles quoted fields)
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current.trim());

    const objId = fields[objIdIdx]?.trim();
    const type = fields[typeIdx]?.trim();
    const status = fields[statusIdx]?.trim();
    const facilityName = fields[facilityIdx]?.trim();
    const comment = fields[commentIdx]?.trim();
    const globalId = fields[globalIdIdx]?.trim();
    const xStr = fields[xIdx]?.trim();
    const yStr = fields[yIdx]?.trim();

    if (!objId || !type || !status || !facilityName || !globalId || !xStr || !yStr) continue;

    const x = Number.parseFloat(xStr);
    const y = Number.parseFloat(yStr);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    const { lat, lng } = webMercatorToLatLng(x, y);

    features.push({
      objectId: objId,
      type,
      status,
      facilityName,
      comment: comment || undefined,
      globalId,
      x,
      y,
      lat,
      lng
    });
  }

  return features;
}
