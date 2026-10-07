/** 850 → "850 m", 1250 → "1.25 km". */
export function formatDistanceM(meters: number): string {
  return meters >= 1000 ? `${+(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}
