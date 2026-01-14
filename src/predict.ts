import type { AvailabilityPrediction, ParkingSpot } from './types';

export function predictAvailability(spot: ParkingSpot, now: Date): AvailabilityPrediction {
  const day = now.getDay(); // 0 Sun .. 6 Sat
  const hour = now.getHours();

  // Simple heuristic “AI-ish” predictor for demos.
  // Downtown tends to be busier on weekend late mornings/afternoons.
  const isWeekend = day === 0 || day === 6;
  const weekendPeak = isWeekend && hour >= 10 && hour <= 16;
  const weekdayPeak = !isWeekend && ((hour >= 8 && hour <= 9) || (hour >= 15 && hour <= 18));

  let p = 0.7;
  let rationale = 'Typical availability expected for this area.';

  if (spot.zone?.toLowerCase() === 'downtown' && weekendPeak) {
    p = 0.35;
    rationale = 'Downtown is often busiest on weekends (late morning–afternoon).';
  } else if (spot.zone?.toLowerCase() === 'downtown' && !isWeekend && hour >= 11 && hour <= 13) {
    p = 0.5;
    rationale = 'Lunch hours can be moderately busy downtown.';
  } else if (spot.zone?.toLowerCase() === 'campus' && !isWeekend && weekdayPeak) {
    p = 0.45;
    rationale = 'Campus area can be busier during weekday commute times.';
  } else if (spot.hasCurbRamp === false) {
    // Not strictly availability, but we nudge confidence lower to reflect accessibility fit.
    p = Math.max(0.25, p - 0.15);
    rationale = 'Nearby curb ramp may be limited; may take longer to park/access.';
  } else if (weekdayPeak) {
    p = 0.55;
    rationale = 'Typical commuter peak time; moderate demand expected.';
  }

  const label: AvailabilityPrediction['label'] = p >= 0.67 ? 'High' : p >= 0.45 ? 'Medium' : 'Low';
  return { probability: p, label, rationale };
}
