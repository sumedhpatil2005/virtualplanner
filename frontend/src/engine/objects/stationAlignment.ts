import type { CityObject, MetroStationObject } from './types';

/** A station within this distance of a metro track aligns to it automatically. */
export const STATION_TRACK_SNAP_METERS = 100;

const METERS_PER_DEG_LAT = 110_540;
const METERS_PER_DEG_LON_AT_EQUATOR = 111_320;

/** Normalises any angle to [0, 360). */
export const normalizeHeading = (deg: number): number => ((deg % 360) + 360) % 360;

/** Local planar projection (metres) around a reference latitude — accurate at station scale. */
const toLocalMeters = (lon: number, lat: number, refLat: number): [number, number] => [
  lon * METERS_PER_DEG_LON_AT_EQUATOR * Math.cos((refLat * Math.PI) / 180),
  lat * METERS_PER_DEG_LAT,
];

/** Compass bearing from a to b in degrees clockwise from north. */
export function bearingDegrees(a: [number, number, ...number[]], b: [number, number, ...number[]]): number {
  const [ax, ay] = toLocalMeters(a[0], a[1], a[1]);
  const [bx, by] = toLocalMeters(b[0], b[1], a[1]);
  return normalizeHeading((Math.atan2(bx - ax, by - ay) * 180) / Math.PI);
}

export interface NearestTrack {
  trackId: string;
  trackName: string;
  bearing: number;
  distanceMeters: number;
}

/** Finds the closest metro track segment (metro line or metro+flyover) to a point. */
export function findNearestTrack(
  point: [number, number, ...number[]],
  objects: Iterable<CityObject>,
  maxMeters = STATION_TRACK_SNAP_METERS
): NearestTrack | null {
  const refLat = point[1];
  const [px, py] = toLocalMeters(point[0], point[1], refLat);
  let best: NearestTrack | null = null;

  for (const obj of objects) {
    if (obj.type !== 'metro_line' && obj.type !== 'metro_flyover') continue;
    const coords = obj.coordinates as [number, number, number][];
    if (!coords || coords.length < 2) continue;

    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = toLocalMeters(coords[i][0], coords[i][1], refLat);
      const [x2, y2] = toLocalMeters(coords[i + 1][0], coords[i + 1][1], refLat);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
      const dist = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      if (dist <= maxMeters && (!best || dist < best.distanceMeters)) {
        best = {
          trackId: obj.id,
          trackName: obj.name,
          bearing: normalizeHeading((Math.atan2(dx, dy) * 180) / Math.PI),
          distanceMeters: dist,
        };
      }
    }
  }
  return best;
}

export interface StationHeading {
  /** Degrees clockwise from north along the platform's long axis. */
  heading: number;
  source: 'track' | 'manual';
  track?: NearestTrack;
}

/**
 * Decides which way a station faces. With `alignToTrack` (the default) it
 * follows the nearest track; otherwise, or when no track is close enough, it
 * uses the station's own `heading`.
 */
export function resolveStationHeading(station: MetroStationObject, objects: Iterable<CityObject>): StationHeading {
  if (station.alignToTrack !== false) {
    const track = findNearestTrack(station.coordinates, objects);
    if (track) return { heading: track.bearing, source: 'track', track };
  }
  return { heading: normalizeHeading(station.heading ?? 0), source: 'manual' };
}
