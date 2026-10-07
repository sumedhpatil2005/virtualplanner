import { apiGet } from '../../lib/api';

/**
 * The backend's local OpenStreetMap index (backend/osm): every road and
 * traffic signal of the region, read from an OSM extract file. Complete and
 * quick, unlike the public Overpass servers, which are often overloaded and
 * can answer with partial data. Callers fall back to Overpass outside the
 * region it covers, or when it has not been built.
 */

export interface LocalOsmStatus {
  available: boolean;
  /** When the OSM data was exported (ISO time). */
  dataTimestamp?: string;
  bbox?: [number, number, number, number];
  ways?: number;
  signals?: number;
}

type Box = { minLng: number; minLat: number; maxLng: number; maxLat: number };

/** Answers shaped like Overpass's: `{ elements: [...] }`. */
interface Elements {
  elements: any[];
}

export class LocalOsmIndex {
  private status: Promise<LocalOsmStatus> | null = null;

  /** The index's status, asked once per session (a failed request is asked again next time). */
  public getStatus(): Promise<LocalOsmStatus> {
    this.status ??= apiGet<LocalOsmStatus>('/api/osm/status').catch(() => {
      this.status = null;
      return { available: false };
    });
    return this.status;
  }

  /** Whether the index holds every box. */
  public async covers(boxes: readonly Box[]): Promise<boolean> {
    const st = await this.getStatus();
    if (!st.available || !st.bbox || boxes.length === 0) return false;
    const [x0, y0, x1, y1] = st.bbox;
    return boxes.every(b => b.minLng >= x0 && b.minLat >= y0 && b.maxLng <= x1 && b.maxLat <= y1);
  }

  /** Road ways overlapping the boxes, as Overpass `out geom` elements. */
  public async ways(boxes: readonly Box[]): Promise<any[]> {
    return (await apiGet<Elements>(`/api/osm/ways?bbox=${encodeBoxes(boxes)}`)).elements;
  }

  /** Traffic signal nodes inside the boxes, as Overpass node elements. */
  public async signals(boxes: readonly Box[]): Promise<any[]> {
    return (await apiGet<Elements>(`/api/osm/signals?bbox=${encodeBoxes(boxes)}`)).elements;
  }
}

/**
 * Boxes for the query string. Many neighbouring tiles are sent as the one box
 * around them all: the answer is then a little larger, but the URL stays short.
 */
function encodeBoxes(boxes: readonly Box[]): string {
  const list = boxes.length > 20
    ? [{
        minLng: Math.min(...boxes.map(b => b.minLng)), minLat: Math.min(...boxes.map(b => b.minLat)),
        maxLng: Math.max(...boxes.map(b => b.maxLng)), maxLat: Math.max(...boxes.map(b => b.maxLat)),
      }]
    : boxes;
  return encodeURIComponent(list.map(b => [b.minLng, b.minLat, b.maxLng, b.maxLat].join(',')).join(';'));
}
