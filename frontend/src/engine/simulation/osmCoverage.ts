import type { Area } from '../objects/types';
import type { Bounds, DrivableObject } from './StudyAreaExplorer';

/**
 * Where the project already holds OpenStreetMap roads.
 *
 * Roads are imported per saved Area. An Area counts as covering roads when
 * imported OSM roads lie inside it (some Areas were used only for buildings),
 * or when it was created to fill in roads for a study area, even if OSM had
 * none there. A study area needs roads only where it can reach, so coverage
 * is checked on a grid of points within range of the selected roads.
 */

/** Areas saved when roads are loaded for a study area; always count as covered. */
export const STUDY_AREA_ROADS_PREFIX = 'area_osmroads_';

const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** Coverage is sampled at about this spacing, at least. */
const MIN_SAMPLE_SPACING_M = 150;
/** At most this many samples per side, however large the range. */
const MAX_SAMPLES_PER_SIDE = 24;

const isImportedOsmRoad = (r: DrivableObject) => r.type === 'road' && !!r.osmProvenance;

function pointInRing(lng: number, lat: number, ring: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inArea = (lng: number, lat: number, a: Area) =>
  lng >= a.minLon && lng <= a.maxLon && lat >= a.minLat && lat <= a.maxLat && pointInRing(lng, lat, a.polygonCoordinates);

/** Saved Areas that hold imported OSM roads. */
export function roadCoveredAreas(areas: readonly Area[], roads: readonly DrivableObject[]): Area[] {
  const osm = roads.filter(isImportedOsmRoad);
  return areas.filter(a =>
    a.id.startsWith(STUDY_AREA_ROADS_PREFIX) ||
    osm.some(r => r.coordinates.some(c => inArea(c[0], c[1], a)))
  );
}

/** Beyond this many boxes, one box around them all is fetched instead. */
const MAX_BOXES = 12;

/**
 * The parts of the study range with no OSM roads loaded, as boxes to fetch
 * (empty when everything within range is covered). Uncovered samples are
 * grouped into rectangles, so thin strips at the edge of an imported area
 * do not turn into one box over roads already held.
 */
export function uncoveredBoxes(seedBox: Bounds, rangeM: number, covered: readonly Area[]): Bounds[] {
  const lat0 = (seedBox.minLat + seedBox.maxLat) / 2;
  const kx = mPerDegLng(lat0);
  const widthM = (seedBox.maxLng - seedBox.minLng) * kx + 2 * rangeM;
  const heightM = (seedBox.maxLat - seedBox.minLat) * M_PER_DEG_LAT + 2 * rangeM;
  const spacing = Math.max(MIN_SAMPLE_SPACING_M, Math.max(widthM, heightM) / MAX_SAMPLES_PER_SIDE);
  const cols = Math.floor(widthM / spacing) + 1;
  const rows = Math.floor(heightM / spacing) + 1;
  const lngAt = (ix: number) => seedBox.minLng - rangeM / kx + (ix * spacing) / kx;
  const latAt = (iy: number) => seedBox.minLat - rangeM / M_PER_DEG_LAT + (iy * spacing) / M_PER_DEG_LAT;

  // Per sample: 1 = in range and uncovered, 2 = in range and covered, 0 = out of range
  const state: number[][] = [];
  for (let iy = 0; iy < rows; iy++) {
    const row: number[] = [];
    for (let ix = 0; ix < cols; ix++) {
      const lng = lngAt(ix), lat = latAt(iy);
      // Roads further than the range from every seed are beyond reach
      const dx = Math.max(seedBox.minLng - lng, 0, lng - seedBox.maxLng) * kx;
      const dy = Math.max(seedBox.minLat - lat, 0, lat - seedBox.maxLat) * M_PER_DEG_LAT;
      row.push(Math.hypot(dx, dy) > rangeM ? 0 : covered.some(a => inArea(lng, lat, a)) ? 2 : 1);
    }
    state.push(row);
  }
  const holdsCovered = (ix0: number, ix1: number, iy0: number, iy1: number) => {
    for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) if (state[iy][ix] === 2) return true;
    return false;
  };

  // Runs of uncovered samples per row, stacked onto the rectangle above them
  // when the widened rectangle still holds no covered sample
  type Rect = { ix0: number; ix1: number; iy0: number; iy1: number };
  const done: Rect[] = [];
  let open: Rect[] = [];
  for (let iy = 0; iy < rows; iy++) {
    const next: Rect[] = [];
    for (let ix = 0; ix < cols; ix++) {
      if (state[iy][ix] !== 1) continue;
      const ix0 = ix;
      while (ix + 1 < cols && state[iy][ix + 1] === 1) ix++;
      const i = open.findIndex(r => r.ix0 <= ix && ix0 <= r.ix1 && !holdsCovered(Math.min(r.ix0, ix0), Math.max(r.ix1, ix), r.iy0, iy));
      if (i >= 0) {
        const [r] = open.splice(i, 1);
        next.push({ ix0: Math.min(r.ix0, ix0), ix1: Math.max(r.ix1, ix), iy0: r.iy0, iy1: iy });
      } else {
        next.push({ ix0, ix1: ix, iy0: iy, iy1: iy });
      }
    }
    done.push(...open);
    open = next;
  }
  done.push(...open);
  if (done.length === 0) return [];

  // Each sample stands for the cell around it; one more sample of margin reaches into the covered part
  const boxes = done.map(r => ({
    minLng: lngAt(r.ix0 - 1),
    minLat: latAt(r.iy0 - 1),
    maxLng: lngAt(r.ix1 + 1),
    maxLat: latAt(r.iy1 + 1),
  }));
  if (boxes.length <= MAX_BOXES) return boxes;
  return [boxes.reduce((a, b) => ({
    minLng: Math.min(a.minLng, b.minLng),
    minLat: Math.min(a.minLat, b.minLat),
    maxLng: Math.max(a.maxLng, b.maxLng),
    maxLat: Math.max(a.maxLat, b.maxLat),
  }))];
}

/** Tile size for checking the project's roads against OpenStreetMap (degrees, about 1.1 km). */
export const ROAD_TILE_DEG = 0.01;

export interface RoadTile {
  key: string;
  box: Bounds;
}

/** The tiles covering everything within `rangeM` of `bounds`. */
export function roadTilesAround(bounds: Bounds, rangeM: number): RoadTile[] {
  const lat0 = (bounds.minLat + bounds.maxLat) / 2;
  const dLat = rangeM / M_PER_DEG_LAT;
  const dLng = rangeM / mPerDegLng(lat0);
  const x0 = Math.floor((bounds.minLng - dLng) / ROAD_TILE_DEG), x1 = Math.floor((bounds.maxLng + dLng) / ROAD_TILE_DEG);
  const y0 = Math.floor((bounds.minLat - dLat) / ROAD_TILE_DEG), y1 = Math.floor((bounds.maxLat + dLat) / ROAD_TILE_DEG);
  const tiles: RoadTile[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      // Rounded so neighbouring tiles share exact edges
      const r = (v: number) => Math.round(v * 1e6) / 1e6;
      tiles.push({ key: `${x}:${y}`, box: { minLng: r(x * ROAD_TILE_DEG), minLat: r(y * ROAD_TILE_DEG), maxLng: r((x + 1) * ROAD_TILE_DEG), maxLat: r((y + 1) * ROAD_TILE_DEG) } });
    }
  }
  return tiles;
}
