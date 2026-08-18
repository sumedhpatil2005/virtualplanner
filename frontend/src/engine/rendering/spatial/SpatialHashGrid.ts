export class SpatialHashGrid {
  private cellSizeInMeters: number;
  private cellToObjects = new Map<string, Set<string>>();
  private objectToCells = new Map<string, Set<string>>();

  constructor(cellSizeInMeters: number = 300) {
    this.cellSizeInMeters = cellSizeInMeters;
  }

  /**
   * Projects WGS84 GPS (lng, lat) coordinates into Web Mercator metric offsets (EPSG:3857)
   */
  public projectCoordinates(lng: number, lat: number): { x: number; y: number } {
    const r = 6378137.0; // WGS84 semi-major axis in meters
    const x = lng * (Math.PI / 180.0) * r;
    
    // Clamp latitude to prevent infinity at poles
    const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const latRad = clampedLat * (Math.PI / 180.0);
    const y = Math.log(Math.tan(Math.PI / 4.0 + latRad / 2.0)) * r;
    
    return { x, y };
  }

  /**
   * Gets the 2D tile cell hash key for a given location coordinate
   */
  public getTileKey(lng: number, lat: number): string {
    const { x, y } = this.projectCoordinates(lng, lat);
    const cellX = Math.floor(x / this.cellSizeInMeters);
    const cellY = Math.floor(y / this.cellSizeInMeters);
    return `tile_${cellX}_${cellY}`;
  }

  /**
   * Inserts an object into the spatial grid, registering it in all cell tiles it intersects
   */
  public insertObject(objId: string, coords: [number, number, number] | [number, number, number][]): void {
    // 1. Clean up old registrations
    this.remove(objId);

    const addedCells = new Set<string>();

    const addCell = (tileKey: string) => {
      if (!addedCells.has(tileKey)) {
        if (!this.cellToObjects.has(tileKey)) {
          this.cellToObjects.set(tileKey, new Set());
        }
        this.cellToObjects.get(tileKey)!.add(objId);

        if (!this.objectToCells.has(objId)) {
          this.objectToCells.set(objId, new Set());
        }
        this.objectToCells.get(objId)!.add(tileKey);

        addedCells.add(tileKey);
      }
    };

    const isPath = Array.isArray(coords[0]);

    if (!isPath) {
      // Single point object
      const pt = coords as [number, number, number];
      const tileKey = this.getTileKey(pt[0], pt[1]);
      addCell(tileKey);
    } else {
      const pts = coords as [number, number, number][];
      if (pts.length === 0) return;
      if (pts.length === 1) {
        const tileKey = this.getTileKey(pts[0][0], pts[0][1]);
        addCell(tileKey);
        return;
      }

      // Check if it's a polygon (first and last coordinate points match)
      const first = pts[0];
      const last = pts[pts.length - 1];
      const isPolygon = first[0] === last[0] && first[1] === last[1] && pts.length >= 3;

      const numSegments = isPolygon ? pts.length - 1 : pts.length - 1;

      for (let i = 0; i < numSegments; i++) {
        const p1 = this.projectCoordinates(pts[i][0], pts[i][1]);
        const p2 = this.projectCoordinates(pts[i + 1][0], pts[i + 1][1]);

        // Traverse and register all cells crossed by this segment
        const intersected = this.getCellsIntersectedBySegment(p1, p2);
        intersected.forEach(addCell);
      }
    }
  }

  /**
   * Amanatides-Woo grid traversal algorithm to find all cells intersected by a line segment
   */
  public getCellsIntersectedBySegment(p1: { x: number; y: number }, p2: { x: number; y: number }): string[] {
    const cells = new Set<string>();
    const S = this.cellSizeInMeters;

    let cx = Math.floor(p1.x / S);
    let cy = Math.floor(p1.y / S);
    const endCx = Math.floor(p2.x / S);
    const endCy = Math.floor(p2.y / S);

    cells.add(`tile_${cx}_${cy}`);
    if (cx === endCx && cy === endCy) {
      return Array.from(cells);
    }

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;

    const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);

    const nextGridX = stepX > 0 ? (cx + 1) * S : cx * S;
    const nextGridY = stepY > 0 ? (cy + 1) * S : cy * S;

    let tMaxX = dx !== 0 ? (nextGridX - p1.x) / dx : Infinity;
    let tMaxY = dy !== 0 ? (nextGridY - p1.y) / dy : Infinity;

    const tDeltaX = dx !== 0 ? S / Math.abs(dx) : Infinity;
    const tDeltaY = dy !== 0 ? S / Math.abs(dy) : Infinity;

    let limit = 1000;
    while ((cx !== endCx || cy !== endCy) && limit > 0) {
      limit--;
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX;
        cx += stepX;
      } else {
        tMaxY += tDeltaY;
        cy += stepY;
      }
      cells.add(`tile_${cx}_${cy}`);
    }

    return Array.from(cells);
  }

  /**
   * Removes an object ID from the spatial grid
   */
  public remove(objId: string): void {
    const tileKeys = this.objectToCells.get(objId);
    if (tileKeys) {
      tileKeys.forEach(tileKey => {
        const set = this.cellToObjects.get(tileKey);
        if (set) {
          set.delete(objId);
          if (set.size === 0) {
            this.cellToObjects.delete(tileKey);
          }
        }
      });
    }
    this.objectToCells.delete(objId);
  }

  /**
   * Resolves the primary spatial tile key where an object is registered
   */
  public getTileKeyForObject(objId: string): string | undefined {
    const set = this.objectToCells.get(objId);
    return set && set.size > 0 ? Array.from(set)[0] : undefined;
  }

  /**
   * Resolves all spatial tile keys intersected by an object
   */
  public getTileKeysForObject(objId: string): string[] {
    const set = this.objectToCells.get(objId);
    return set ? Array.from(set) : [];
  }

  /**
   * Queries object IDs residing inside the specified list of tiles
   */
  public getObjectsInTiles(tileKeys: string[]): string[] {
    const objects = new Set<string>();
    for (const key of tileKeys) {
      const set = this.cellToObjects.get(key);
      if (set) {
        set.forEach(id => objects.add(id));
      }
    }
    return Array.from(objects);
  }

  /**
   * Resolves intersecting TileKeys covering a geographic bounding box
   */
  public getTileKeysForBounds(minLng: number, minLat: number, maxLng: number, maxLat: number): string[] {
    const minProj = this.projectCoordinates(minLng, minLat);
    const maxProj = this.projectCoordinates(maxLng, maxLat);

    let minCellX = Math.floor(minProj.x / this.cellSizeInMeters);
    let maxCellX = Math.floor(maxProj.x / this.cellSizeInMeters);
    let minCellY = Math.floor(minProj.y / this.cellSizeInMeters);
    let maxCellY = Math.floor(maxProj.y / this.cellSizeInMeters);

    // Defensive clamping to prevent infinite/massive loops on global/horizon view bounds
    const LIMIT = 20; // Max 20 cells (6km) width/height for visualization tiles queries
    if (maxCellX - minCellX > LIMIT) {
      const centerX = Math.floor((minCellX + maxCellX) / 2);
      minCellX = centerX - Math.floor(LIMIT / 2);
      maxCellX = centerX + Math.floor(LIMIT / 2);
    }
    if (maxCellY - minCellY > LIMIT) {
      const centerY = Math.floor((minCellY + maxCellY) / 2);
      minCellY = centerY - Math.floor(LIMIT / 2);
      maxCellY = centerY + Math.floor(LIMIT / 2);
    }

    const tileKeys: string[] = [];
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        tileKeys.push(`tile_${cx}_${cy}`);
      }
    }
    return tileKeys;
  }
}
