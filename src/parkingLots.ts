import type { ParkingLotArea } from './types';

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

function normalizeNull(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (s.toLowerCase() === '<null>') return undefined;
  return s;
}

export function parseParkingLotAreas(csvRaw: string): ParkingLotArea[] {
  const lines = csvRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const objectIdIdx = idx('OBJECTID');
  const lotIdIdx = idx('LOT_ID');
  const lotNameIdx = idx('LOT_NAME');
  const capacityIdx = idx('CAPACITY');
  const controlTypeIdx = idx('CONTROL_TYPE');
  const handicapIdx = idx('HANDICAP_SPACE');
  const ownershipIdx = idx('OWNERSHIP');
  const mapLabelIdx = idx('MAP_LABEL');
  const shapeLengthIdx = idx('Shape__Length');
  const shapeAreaIdx = idx('Shape__Area');
  const globalIdIdx = idx('GLOBALID');

  const rows: ParkingLotArea[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);

    const objectId = objectIdIdx >= 0 ? normalizeNull(cols[objectIdIdx]) : undefined;
    const lotId = lotIdIdx >= 0 ? normalizeNull(cols[lotIdIdx]) : undefined;
    const lotName = lotNameIdx >= 0 ? normalizeNull(cols[lotNameIdx]) : undefined;
    const capacity = capacityIdx >= 0 ? normalizeNull(cols[capacityIdx]) : undefined;
    const controlType = controlTypeIdx >= 0 ? normalizeNull(cols[controlTypeIdx]) : undefined;
    const handicapSpace = handicapIdx >= 0 ? normalizeNull(cols[handicapIdx]) : undefined;
    const ownership = ownershipIdx >= 0 ? normalizeNull(cols[ownershipIdx]) : undefined;
    const mapLabel = mapLabelIdx >= 0 ? normalizeNull(cols[mapLabelIdx]) : undefined;
    const shapeLength = shapeLengthIdx >= 0 ? normalizeNull(cols[shapeLengthIdx]) : undefined;
    const shapeArea = shapeAreaIdx >= 0 ? normalizeNull(cols[shapeAreaIdx]) : undefined;
    const globalId = globalIdIdx >= 0 ? normalizeNull(cols[globalIdIdx]) : undefined;

    const id = globalId ?? objectId ?? `${i}`;

    rows.push({
      id,
      objectId,
      lotId,
      lotName,
      capacity,
      controlType,
      handicapSpace,
      ownership,
      mapLabel,
      shapeLength,
      shapeArea
    });
  }

  return rows;
}
