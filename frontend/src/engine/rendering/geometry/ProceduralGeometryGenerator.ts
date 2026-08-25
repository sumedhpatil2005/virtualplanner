import type { CityObject, RoadObject, BuildingObject, FlyoverObject, MetroLineObject, MetroStationObject, UtilityObject, JunctionObject, MetroFlyoverObject } from '../../objects/types';
import type { MeshData, MaterialConfig } from '../types';

/**
 * Helper to convert WGS84 coordinates to ECEF Cartesian3 coordinates.
 */
function wgs84ToCartesian(lng: number, lat: number, h: number): [number, number, number] {
  const a = 6378137.0; // semi-major axis in meters
  const f = 1.0 / 298.257223563; // flattening
  const e2 = 2.0 * f - f * f; // eccentricity squared

  const radLng = lng * (Math.PI / 180.0);
  const radLat = lat * (Math.PI / 180.0);

  const cosLat = Math.cos(radLat);
  const sinLat = Math.sin(radLat);

  const N = a / Math.sqrt(1.0 - e2 * sinLat * sinLat);

  const x = (N + h) * cosLat * Math.cos(radLng);
  const y = (N + h) * cosLat * Math.sin(radLng);
  const z = ((1.0 - e2) * N + h) * sinLat;

  return [x, y, z];
}

/**
 * Cross product of two 3D vectors
 */
function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

/**
 * Normalize a 3D vector
 */
function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function shortenPathAtStart(coords: [number, number, number][], distMeters: number): [number, number, number][] {
  if (coords.length < 2) return coords;
  const newCoords = [...coords.map(c => [...c] as [number, number, number])];
  let remaining = distMeters;

  while (newCoords.length >= 2 && remaining > 0) {
    const p1 = newCoords[0];
    const p2 = newCoords[1];
    
    const lonMetersPerDegree = 111000 * Math.cos((p1[1] * Math.PI) / 180);
    const latMetersPerDegree = 111000;
    
    const dx = (p2[0] - p1[0]) * lonMetersPerDegree;
    const dy = (p2[1] - p1[1]) * latMetersPerDegree;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len <= remaining) {
      remaining -= len;
      newCoords.shift();
    } else {
      const t = remaining / len;
      newCoords[0] = [
        p1[0] + t * (p2[0] - p1[0]),
        p1[1] + t * (p2[1] - p1[1]),
        p1[2] + t * (p2[2] - p1[2])
      ];
      break;
    }
  }
  return newCoords;
}

function shortenPathAtEnd(coords: [number, number, number][], distMeters: number): [number, number, number][] {
  const reversed = [...coords.map(c => [...c] as [number, number, number])].reverse();
  const shortened = shortenPathAtStart(reversed, distMeters);
  return shortened.reverse();
}

export class ProceduralGeometryGenerator {
  /**
   * Translates a CityObject configuration to a group of MeshData meshes
   */
  public generateMeshData(obj: CityObject, allObjects?: Map<string, CityObject>): MeshData[] {
    try {
      if (obj.type === 'building') {
        return this.generateBuildingMesh(obj as BuildingObject);
      }
      if (obj.type === 'road') {
        return this.generateRoadMeshes(obj as RoadObject, allObjects);
      }
      if (obj.type === 'flyover') {
        return this.generateFlyoverMeshes(obj as FlyoverObject, allObjects);
      }
      if (obj.type === 'metro_flyover') {
        return this.generateMetroFlyoverMeshes(obj as MetroFlyoverObject, allObjects);
      }
      if (obj.type === 'metro_line') {
        return this.generateMetroLineMeshes(obj as MetroLineObject);
      }
      if (obj.type === 'metro_station') {
        return this.generateMetroStationMeshes(obj as MetroStationObject, allObjects);
      }
      if (obj.type === 'utility') {
        return [this.generateUtilityMesh(obj as UtilityObject)];
      }
      if (obj.type === 'junction') {
        return [this.generateJunctionMesh(obj as JunctionObject, allObjects)];
      }
    } catch (err) {
      console.error(`Failed to generate procedural geometry for object ${obj.id}:`, err);
    }
    return [];
  }

  /**
   * Generates a list of 3D building meshes for [Far, Medium, Close] LODs
   */
  private generateBuildingMesh(building: BuildingObject): MeshData[] {
    const footprint = building.coordinates;
    const height = building.height || 10;
    const numPoints = footprint.length;
    if (numPoints === 0) return [];

    // --- 1. FAR LOD: Flat footprint mesh ---
    const farPositions: number[] = [];
    const farIndices: number[] = [];
    
    for (let i = 0; i < numPoints; i++) {
      const pt = footprint[i];
      const bot = wgs84ToCartesian(pt[0], pt[1], 0.1); // 0.1m height to prevent z-fighting
      farPositions.push(...bot);
    }
    
    // Triangle fan for flat footprint
    for (let i = 1; i < numPoints - 1; i++) {
      farIndices.push(0, i, i + 1);
    }

    const farMaterial: MaterialConfig = {
      type: 'solid',
      color: '#475569' // Muted footprint color
    };

    const farMesh: MeshData = {
      positions: new Float64Array(farPositions),
      indices: new Uint32Array(farIndices),
      material: farMaterial,
      layerId: 'building'
    };

    // --- 2. MEDIUM LOD: Simple extruded building ---
    const medPositionsList: number[] = [];
    const medIndicesList: number[] = [];

    // Vertices: Bottom ring, then top ring
    for (let i = 0; i < numPoints; i++) {
      const pt = footprint[i];
      const bot = wgs84ToCartesian(pt[0], pt[1], 0);
      medPositionsList.push(...bot);
    }
    for (let i = 0; i < numPoints; i++) {
      const pt = footprint[i];
      const top = wgs84ToCartesian(pt[0], pt[1], height);
      medPositionsList.push(...top);
    }

    // Walls
    for (let i = 0; i < numPoints; i++) {
      const next = (i + 1) % numPoints;
      const bCurr = i;
      const bNext = next;
      const tCurr = i + numPoints;
      const tNext = next + numPoints;
      medIndicesList.push(bCurr, bNext, tNext);
      medIndicesList.push(bCurr, tNext, tCurr);
    }

    // Roof cap
    const roofOffset = numPoints;
    for (let i = 1; i < numPoints - 1; i++) {
      medIndicesList.push(roofOffset, roofOffset + i, roofOffset + i + 1);
    }

    const medMaterial: MaterialConfig = {
      type: 'solid',
      color: building.usageType === 'commercial' ? '#38bdf8' : building.usageType === 'industrial' ? '#f59e0b' : '#64748b'
    };

    const medMesh: MeshData = {
      positions: new Float64Array(medPositionsList),
      indices: new Uint32Array(medIndicesList),
      material: medMaterial,
      layerId: 'building'
    };

    // --- 3. CLOSE LOD: Reuse extruded geometry with enhanced visual material ---
    const closeMaterial: MaterialConfig = {
      type: 'solid',
      color: building.usageType === 'commercial' ? '#0ea5e9' : building.usageType === 'industrial' ? '#d97706' : '#4b5563' // High-quality contrasting colors
    };

    const closeMesh: MeshData = {
      positions: medMesh.positions, // REUSE same typed array coordinates (no allocation!)
      indices: medMesh.indices,     // REUSE same typed array indices
      material: closeMaterial,
      layerId: 'building'
    };

    return [farMesh, medMesh, closeMesh];
  }

  /**
   * Generates ECEF parallel ribbon geometries along a centerline path
   */
  private generateRibbon(
    coords: [number, number, number][],
    leftOffset: number,
    rightOffset: number,
    elevation: number = 0,
    thickness: number = 0
  ): { positions: number[]; indices: number[] } {
    const positions: number[] = [];
    const indices: number[] = [];
    const numPoints = coords.length;
    if (numPoints < 2) return { positions, indices };

    // 1. Calculate side offset vertices
    for (let i = 0; i < numPoints; i++) {
      const curr = coords[i];
      const next = coords[i + 1] || curr;
      const prev = coords[i - 1] || curr;

      const pCurr = wgs84ToCartesian(curr[0], curr[1], (curr[2] || 0) + elevation);
      
      // Ellipsoidal surface normal (up direction)
      const up = normalize(pCurr);

      // Path tangent in ECEF space
      const pNext = wgs84ToCartesian(next[0], next[1], (next[2] || 0) + elevation);
      const pPrev = wgs84ToCartesian(prev[0], prev[1], (prev[2] || 0) + elevation);
      const tangent = normalize([pNext[0] - pPrev[0], pNext[1] - pPrev[1], pNext[2] - pPrev[2]]);

      // Lateral vector (perpendicular to tangent and up, pointing right)
      const right = normalize(cross(tangent, up));

      // Compute left and right offset points
      const pLeft = [
        pCurr[0] + right[0] * leftOffset,
        pCurr[1] + right[1] * leftOffset,
        pCurr[2] + right[2] * leftOffset
      ];
      const pRight = [
        pCurr[0] + right[0] * rightOffset,
        pCurr[1] + right[1] * rightOffset,
        pCurr[2] + right[2] * rightOffset
      ];

      // Add to positions list
      positions.push(...pLeft, ...pRight);

      // If thickness is requested, add bottom vertices for 3D profiles
      if (thickness > 0) {
        const pLeftBot = [
          pLeft[0] - up[0] * thickness,
          pLeft[1] - up[1] * thickness,
          pLeft[2] - up[2] * thickness
        ];
        const pRightBot = [
          pRight[0] - up[0] * thickness,
          pRight[1] - up[1] * thickness,
          pRight[2] - up[2] * thickness
        ];
        positions.push(...pLeftBot, ...pRightBot);
      }
    }

    // 2. Generate quad indices
    const stride = thickness > 0 ? 4 : 2;
    for (let i = 0; i < numPoints - 1; i++) {
      const currIdx = i * stride;
      const nextIdx = (i + 1) * stride;

      const lCurr = currIdx;
      const rCurr = currIdx + 1;
      const lNext = nextIdx;
      const rNext = nextIdx + 1;

      // Triangle 1: left curr -> right curr -> right next
      indices.push(lCurr, rCurr, rNext);
      // Triangle 2: left curr -> right next -> left next
      indices.push(lCurr, rNext, lNext);

      // Add sides if thickness > 0
      if (thickness > 0) {
        const lCurrBot = currIdx + 2;
        const rCurrBot = currIdx + 3;
        const lNextBot = nextIdx + 2;
        const rNextBot = nextIdx + 3;

        // Top -> Bottom left wall
        indices.push(lCurr, lNext, lNextBot);
        indices.push(lCurr, lNextBot, lCurrBot);

        // Top -> Bottom right wall
        indices.push(rCurr, rNextBot, rNext);
        indices.push(rCurr, rCurrBot, rNextBot);
      }
    }

    return { positions, indices };
  }



  private calculateOffsetsForSection(section: any) {
    const hasMedian = section.hasMedian;
    const medianWidth = section.medianWidth || 0;
    const halfMedian = hasMedian ? medianWidth / 2 : 0;

    const A = section.carriagewayA;
    const B = section.carriagewayB;

    let carriageA_start = 0;
    let carriageA_end = 0;
    let carriageB_start = 0;
    let carriageB_end = 0;

    if (B) {
      // Divided road: centerline is the center of the median
      carriageA_start = -(halfMedian + A.lanes * A.laneWidth);
      carriageA_end = -halfMedian;

      carriageB_start = halfMedian;
      carriageB_end = halfMedian + B.lanes * B.laneWidth;
    } else {
      // Undivided road: centerline is the center of carriageway A's lanes
      const carriageWidth = A.lanes * A.laneWidth;
      carriageA_start = -carriageWidth / 2;
      carriageA_end = carriageWidth / 2;
    }

    // Left elements (start from carriage A's leftmost edge and expand left/outward)
    const leftElements = this.getRoadsideOffsets(A.leftRoadside, carriageA_start, -1);
    // Right elements of carriage A (only applicable for undivided roads or inner median side)
    const rightElementsA = this.getRoadsideOffsets(A.rightRoadside, carriageA_end, 1);

    let rightElementsB = null;
    let leftElementsB = null;

    if (B) {
      // B.rightRoadside expands right/outward from carriage B's rightmost edge
      rightElementsB = this.getRoadsideOffsets(B.rightRoadside, carriageB_end, 1);
      // B.leftRoadside (inner side of carriage B, facing median)
      leftElementsB = this.getRoadsideOffsets(B.leftRoadside, carriageB_start, -1);
    }

    return {
      median: [-halfMedian, halfMedian],
      carriageA: [carriageA_start, carriageA_end],
      carriageB: B ? [carriageB_start, carriageB_end] : null,
      leftA: leftElements,
      rightA: rightElementsA,
      leftB: leftElementsB,
      rightB: rightElementsB
    };
  }

  private getRoadsideOffsets(roadside: any, baseOffset: number, sign: number) {
    const hasElements = (roadside.footpathWidth || 0) > 0 ||
                        (roadside.cycleTrackWidth || 0) > 0 ||
                        (roadside.vergeWidth || 0) > 0 ||
                        (roadside.parkingWidth || 0) > 0 ||
                        (roadside.drainageWidth || 0) > 0;
    const curbWidth = hasElements ? 0.2 : 0;
    
    let current = baseOffset;

    // Curb
    const curbStart = current;
    current += sign * curbWidth;
    const curbEnd = current;

    // Footpath
    const fpStart = current;
    current += sign * (roadside.footpathWidth || 0);
    const fpEnd = current;

    // Cycle Track
    const ctStart = current;
    current += sign * (roadside.cycleTrackWidth || 0);
    const ctEnd = current;

    // Verge
    const vgStart = current;
    current += sign * (roadside.vergeWidth || 0);
    const vgEnd = current;

    // Parking
    const pkStart = current;
    current += sign * (roadside.parkingWidth || 0);
    const pkEnd = current;

    // Drainage
    const drStart = current;
    current += sign * (roadside.drainageWidth || 0);
    const drEnd = current;

    return {
      curb: [Math.min(curbStart, curbEnd), Math.max(curbStart, curbEnd)],
      footpath: [Math.min(fpStart, fpEnd), Math.max(fpStart, fpEnd)],
      cycleTrack: [Math.min(ctStart, ctEnd), Math.max(ctStart, ctEnd)],
      verge: [Math.min(vgStart, vgEnd), Math.max(vgStart, vgEnd)],
      parking: [Math.min(pkStart, pkEnd), Math.max(pkStart, pkEnd)],
      drainage: [Math.min(drStart, drEnd), Math.max(drStart, drEnd)]
    };
  }

  private generateRoadMeshes(road: RoadObject, allObjects?: Map<string, CityObject>): MeshData[] {
    const meshes: MeshData[] = [];
    const coords = road.coordinates;
    if (coords.length < 2) return meshes;

    let roadCoords = coords;
    const isBridge = road.osmProvenance?.bridge || false;
    const isTunnel = road.osmProvenance?.tunnel || false;
    const bridgeElevation = 6.0;

    // Check if coords have 0 elevation but the road is a bridge
    const averageElev = coords.reduce((sum, c) => sum + (c[2] || 0), 0) / coords.length;
    if (isBridge && averageElev < 0.5) {
      roadCoords = coords.map(c => [c[0], c[1], bridgeElevation]);
    } else if (isTunnel) {
      // Offset tunnels slightly below the surface
      roadCoords = coords.map(c => [c[0], c[1], -0.2]);
    }

    // Use synthesized sections if not present
    const sections = road.sections && road.sections.length > 0
      ? road.sections
      : this.synthesizeDefaultSectionsForGenerator(road);

    // Resolve junctions
    const junctions = allObjects 
      ? Array.from(allObjects.values()).filter(o => o.type === 'junction') as JunctionObject[]
      : [];

    const isAtJunction = (pt: [number, number, number]) => {
      return junctions.find(j => {
        const dx = j.coordinates[0] - pt[0];
        const dy = j.coordinates[1] - pt[1];
        return (dx * dx + dy * dy) < 0.000000004;
      });
    };

    const getJunctionRadius = (j: JunctionObject) => {
      let maxRoadWidth = 6.0;
      if (j.connectedRoads && j.connectedRoads.length > 0 && allObjects) {
        j.connectedRoads.forEach(roadId => {
          const rObj = allObjects.get(roadId);
          if (rObj && rObj.type === 'road') {
            const rWidth = (rObj as RoadObject).width || 6.0;
            if (rWidth > maxRoadWidth) maxRoadWidth = rWidth;
          }
        });
      }
      return Math.max(3.0, maxRoadWidth / 2 + 0.5);
    };

    const jStart = isAtJunction(roadCoords[0]);
    const jEnd = isAtJunction(roadCoords[roadCoords.length - 1]);

    // Visual road class asphalt colors (subtle dark-mode professional hierarchy)
    let asphaltColor = '#1e293b'; // default: arterial
    if (road.roadClass === 'highway') {
      asphaltColor = '#0f172a'; // slate-900
    } else if (road.roadClass === 'collector') {
      asphaltColor = '#334155'; // slate-700
    } else if (road.roadClass === 'local') {
      asphaltColor = '#475569'; // slate-600
    }

    for (const section of sections) {
      const startIdx = Math.max(0, Math.min(section.startNodeIndex, coords.length - 1));
      const endIdx = Math.max(startIdx, Math.min(section.endNodeIndex, coords.length - 1));
      if (endIdx - startIdx < 1) continue;

      let sectionCoords = roadCoords.slice(startIdx, endIdx + 1);
      const offsets = this.calculateOffsetsForSection(section);

      // Shorten coordinates at junctions to prevent overlapping meshes
      let totalLength = 0;
      for (let i = 0; i < sectionCoords.length - 1; i++) {
        const p1 = sectionCoords[i];
        const p2 = sectionCoords[i + 1];
        const lonMetersPerDegree = 111000 * Math.cos((p1[1] * Math.PI) / 180);
        const latMetersPerDegree = 111000;
        const dx = (p2[0] - p1[0]) * lonMetersPerDegree;
        const dy = (p2[1] - p1[1]) * latMetersPerDegree;
        totalLength += Math.sqrt(dx * dx + dy * dy);
      }

      const shortenStart = (startIdx === 0 && jStart) ? getJunctionRadius(jStart) : 0;
      const shortenEnd = (endIdx === roadCoords.length - 1 && jEnd) ? getJunctionRadius(jEnd) : 0;

      if (shortenStart + shortenEnd < totalLength * 0.75) {
        if (shortenStart > 0) {
          sectionCoords = shortenPathAtStart(sectionCoords, shortenStart);
        }
        if (shortenEnd > 0) {
          sectionCoords = shortenPathAtEnd(sectionCoords, shortenEnd);
        }
      }

      // 1. Asphalt (Carriageway A)
      if (offsets.carriageA[1] - offsets.carriageA[0] > 0.1) {
        const asphaltA = this.generateRibbon(sectionCoords, offsets.carriageA[0], offsets.carriageA[1], 0);
        meshes.push({
          positions: new Float64Array(asphaltA.positions),
          indices: new Uint32Array(asphaltA.indices),
          material: { type: 'solid', color: asphaltColor },
          layerId: 'asphalt'
        });

        // 1b. Lane Markings for Carriageway A
        const lanesA = section.carriagewayA.lanes;
        if (lanesA > 1) {
          const A_width = offsets.carriageA[1] - offsets.carriageA[0];
          const laneW = A_width / lanesA;
          for (let i = 1; i < lanesA; i++) {
            const offsetMark = offsets.carriageA[0] + i * laneW;
            const marking = this.generateRibbon(sectionCoords, offsetMark - 0.06, offsetMark + 0.06, 0.01);
            meshes.push({
              positions: new Float64Array(marking.positions),
              indices: new Uint32Array(marking.indices),
              material: { type: 'solid', color: '#e2e8f0' },
              layerId: 'marking'
            });
          }
        }
      }

      // 2. Asphalt (Carriageway B)
      if (offsets.carriageB && (offsets.carriageB[1] - offsets.carriageB[0] > 0.1)) {
        const asphaltB = this.generateRibbon(sectionCoords, offsets.carriageB[0], offsets.carriageB[1], 0);
        meshes.push({
          positions: new Float64Array(asphaltB.positions),
          indices: new Uint32Array(asphaltB.indices),
          material: { type: 'solid', color: asphaltColor },
          layerId: 'asphalt'
        });

        // 2b. Lane Markings for Carriageway B
        const lanesB = section.carriagewayB.lanes;
        if (lanesB > 1) {
          const B_width = offsets.carriageB[1] - offsets.carriageB[0];
          const laneW = B_width / lanesB;
          for (let i = 1; i < lanesB; i++) {
            const offsetMark = offsets.carriageB[0] + i * laneW;
            const marking = this.generateRibbon(sectionCoords, offsetMark - 0.06, offsetMark + 0.06, 0.01);
            meshes.push({
              positions: new Float64Array(marking.positions),
              indices: new Uint32Array(marking.indices),
              material: { type: 'solid', color: '#e2e8f0' },
              layerId: 'marking'
            });
          }
        }
      }

      // 2c. Center Divider Yellow Markings (for undivided two-way roads)
      if (offsets.carriageB && !section.hasMedian) {
        const centerOffset = offsets.carriageA[1];
        const yellowLeft = this.generateRibbon(sectionCoords, centerOffset - 0.12, centerOffset - 0.04, 0.015);
        const yellowRight = this.generateRibbon(sectionCoords, centerOffset + 0.04, centerOffset + 0.12, 0.015);
        
        meshes.push({
          positions: new Float64Array(yellowLeft.positions),
          indices: new Uint32Array(yellowLeft.indices),
          material: { type: 'solid', color: '#eab308' },
          layerId: 'marking'
        });
        meshes.push({
          positions: new Float64Array(yellowRight.positions),
          indices: new Uint32Array(yellowRight.indices),
          material: { type: 'solid', color: '#eab308' },
          layerId: 'marking'
        });
      }

      // 3. Central Median
      if (section.hasMedian && section.medianWidth > 0) {
        const divider = this.generateRibbon(sectionCoords, offsets.median[0], offsets.median[1], 0.15, 0.15);
        meshes.push({
          positions: new Float64Array(divider.positions),
          indices: new Uint32Array(divider.indices),
          material: { type: 'solid', color: '#334155' },
          layerId: 'divider'
        });
      }

      // 4. Roadside Elements Helper
      const generateRoadside = (elements: any) => {
        if (!elements) return;

        // Skip curbs, footpaths, cycle tracks for tunnels
        if (isTunnel) return;

        // Curb (extruded 0.22m)
        if (elements.curb[1] - elements.curb[0] > 0.05) {
          const curb = this.generateRibbon(sectionCoords, elements.curb[0], elements.curb[1], 0.22, 0.22);
          meshes.push({
            positions: new Float64Array(curb.positions),
            indices: new Uint32Array(curb.indices),
            material: { type: 'solid', color: '#4b5563' },
            layerId: 'curb'
          });
        }

        // Footpath (extruded 0.22m)
        if (elements.footpath[1] - elements.footpath[0] > 0.05) {
          const fp = this.generateRibbon(sectionCoords, elements.footpath[0], elements.footpath[1], 0.22, 0.22);
          meshes.push({
            positions: new Float64Array(fp.positions),
            indices: new Uint32Array(fp.indices),
            material: { type: 'solid', color: '#475569' },
            layerId: 'sidewalk'
          });
        }

        // Cycle Track (extruded 0.05m)
        if (elements.cycleTrack[1] - elements.cycleTrack[0] > 0.05) {
          const ct = this.generateRibbon(sectionCoords, elements.cycleTrack[0], elements.cycleTrack[1], 0.05, 0.05);
          meshes.push({
            positions: new Float64Array(ct.positions),
            indices: new Uint32Array(ct.indices),
            material: { type: 'solid', color: '#065f46' },
            layerId: 'cycleway'
          });
        }

        // Verge (extruded 0.02m)
        if (elements.verge[1] - elements.verge[0] > 0.05) {
          const vg = this.generateRibbon(sectionCoords, elements.verge[0], elements.verge[1], 0.02, 0.02);
          meshes.push({
            positions: new Float64Array(vg.positions),
            indices: new Uint32Array(vg.indices),
            material: { type: 'solid', color: '#15803d' },
            layerId: 'verge'
          });
        }

        // Parking (extruded 0.0m)
        if (elements.parking[1] - elements.parking[0] > 0.05) {
          const pk = this.generateRibbon(sectionCoords, elements.parking[0], elements.parking[1], 0);
          meshes.push({
            positions: new Float64Array(pk.positions),
            indices: new Uint32Array(pk.indices),
            material: { type: 'solid', color: '#475569' },
            layerId: 'parking'
          });
        }

        // Drainage (extruded 0.0m, or slightly lower)
        if (elements.drainage[1] - elements.drainage[0] > 0.05) {
          const dr = this.generateRibbon(sectionCoords, elements.drainage[0], elements.drainage[1], -0.1, 0.1);
          meshes.push({
            positions: new Float64Array(dr.positions),
            indices: new Uint32Array(dr.indices),
            material: { type: 'solid', color: '#1f2937' },
            layerId: 'drainage'
          });
        }
      };

      // Generate for all roadsides
      generateRoadside(offsets.leftA);
      generateRoadside(offsets.rightA);
      generateRoadside(offsets.leftB);
      generateRoadside(offsets.rightB);

      // 5. If it's a bridge, generate concrete deck slab under the road
      if (isBridge) {
        const roadWidth = road.width || (offsets.carriageA[1] - offsets.carriageA[0]) * 2;
        const halfW = roadWidth / 2;
        const slab = this.generateRibbon(sectionCoords, -halfW, halfW, -0.05, 0.4);
        meshes.push({
          positions: new Float64Array(slab.positions),
          indices: new Uint32Array(slab.indices),
          material: { type: 'solid', color: '#475569' }, // concrete grey
          layerId: 'transit_deck'
        });
      }
    }

    // 6. Generate bridge concrete pillars if needed
    if (isBridge) {
      const pierSpacing = 30; // 30m spacing
      const pillars = this.generatePillarsAlongCenterline(
        roadCoords,
        undefined,
        0, // Coords already contain the deck elevation (Z = 6.0)
        pierSpacing,
        'transit_pillars'
      );
      meshes.push(...pillars);
    }

    return meshes;
  }

  private synthesizeDefaultSectionsForGenerator(road: RoadObject): any[] {
    const laneWidth = road.laneWidth || 3.5;
    const laneCount = road.laneCount || 2;
    const dividerWidth = road.dividerWidth || 0;
    const hasDivider = road.hasDivider || (dividerWidth > 0);
    const hasFootpath = road.hasFootpath || false;
    const footpathWidth = road.footpathWidth || 1.5;

    let lanesA = laneCount;
    let lanesB = 0;
    if (hasDivider) {
      lanesA = Math.ceil(laneCount / 2);
      lanesB = Math.floor(laneCount / 2);
    } else if (!road.isOneWay) {
      lanesA = Math.ceil(laneCount / 2);
      lanesB = Math.floor(laneCount / 2);
    }

    const leftRoadside = {
      footpathWidth: hasFootpath ? footpathWidth : 0,
      cycleTrackWidth: 0,
      vergeWidth: 0,
      parkingWidth: 0,
      drainageWidth: 0
    };

    const rightRoadside = {
      footpathWidth: (hasFootpath && !hasDivider && lanesB > 0) || (hasFootpath && hasDivider) ? footpathWidth : 0,
      cycleTrackWidth: 0,
      vergeWidth: 0,
      parkingWidth: 0,
      drainageWidth: 0
    };

    const carriagewayA = {
      direction: road.isOneWay ? 'forward' : 'both',
      lanes: lanesA,
      laneWidth,
      leftRoadside: leftRoadside,
      rightRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 }
    };

    let carriagewayB = undefined;
    if (lanesB > 0) {
      carriagewayB = {
        direction: 'backward',
        lanes: lanesB,
        laneWidth,
        leftRoadside: { footpathWidth: 0, cycleTrackWidth: 0, vergeWidth: 0, parkingWidth: 0, drainageWidth: 0 },
        rightRoadside: rightRoadside
      };
    } else if (!hasDivider && !road.isOneWay) {
      carriagewayA.rightRoadside = rightRoadside;
    } else if (road.isOneWay) {
      carriagewayA.rightRoadside = rightRoadside;
    }

    return [{
      startNodeIndex: 0,
      endNodeIndex: Math.max(0, road.coordinates.length - 1),
      totalRowWidth: road.width || (laneCount * laneWidth + dividerWidth + (hasFootpath ? footpathWidth * 2 : 0)),
      wideningPossible: true,
      hasMedian: hasDivider,
      medianWidth: dividerWidth,
      carriagewayA,
      carriagewayB,
      reservedSpaces: [],
      provenance: {
        originalSource: 'OSM',
        originalConfidence: 'estimated',
        geometryModified: false,
        profileModified: false,
        lastModifiedBy: 'importer',
        verificationStatus: 'unverified'
      }
    }];
  }

  /**
   * Generates procedural meshes for flyovers, including concrete pillars
   */
  private generateFlyoverMeshes(flyover: FlyoverObject, allObjects?: Map<string, CityObject>): MeshData[] {
    const meshes: MeshData[] = [];
    const coords = flyover.coordinates;
    if (coords.length < 2) return meshes;

    const laneWidth = flyover.laneWidth || 3.5;
    const laneCount = flyover.laneCount || 2;
    const dividerWidth = flyover.hasDivider ? (flyover.dividerWidth || 2.0) : 0;
    const asphaltWidth = laneCount * laneWidth + dividerWidth;
    const slabWidth = asphaltWidth + 1.2;

    // 1. Concrete Deck Slab (supports asphalt and barriers)
    // Thickness = 0.3m. Placed from z = -0.3 to z = 0.0.
    const deckSlab = this.generateRibbon(coords, -slabWidth / 2, slabWidth / 2, -0.3, 0.3);
    meshes.push({
      positions: new Float64Array(deckSlab.positions),
      indices: new Uint32Array(deckSlab.indices),
      material: { type: 'solid', color: '#64748b' }, // Medium concrete grey
      layerId: 'transit_deck'
    });

    // 2. Asphalt Driving Surface (raised by 2cm to prevent z-fighting on deck slab)
    const asphaltColor = flyover.roadClass === 'highway' ? '#0f172a' : '#1e293b'; // slate-900 or slate-800
    const asphalt = this.generateRibbon(coords, -asphaltWidth / 2, asphaltWidth / 2, 0.02, 0);
    meshes.push({
      positions: new Float64Array(asphalt.positions),
      indices: new Uint32Array(asphalt.indices),
      material: { type: 'solid', color: asphaltColor },
      layerId: 'transit_deck'
    });

    // 3. Side Barriers/Parapets (LOD: transit_deck_details)
    // Left barrier (outer slab edge to slab edge - 0.4)
    const leftBarrier = this.generateRibbon(coords, -slabWidth / 2, -slabWidth / 2 + 0.4, 0.0, 0.8);
    meshes.push({
      positions: new Float64Array(leftBarrier.positions),
      indices: new Uint32Array(leftBarrier.indices),
      material: { type: 'solid', color: '#64748b' },
      layerId: 'transit_deck_details'
    });

    // Right barrier (slab edge - 0.4 to outer slab edge)
    const rightBarrier = this.generateRibbon(coords, slabWidth / 2 - 0.4, slabWidth / 2, 0.0, 0.8);
    meshes.push({
      positions: new Float64Array(rightBarrier.positions),
      indices: new Uint32Array(rightBarrier.indices),
      material: { type: 'solid', color: '#64748b' },
      layerId: 'transit_deck_details'
    });

    // 4. Central Concrete Divider (if two-way with median) — Jersey barrier style
    if (flyover.hasDivider && dividerWidth > 0.1) {
      // Main concrete barrier body — raised 0.8m above asphalt surface
      const divider = this.generateRibbon(coords, -dividerWidth / 2, dividerWidth / 2, 0.04, 0.8);
      meshes.push({
        positions: new Float64Array(divider.positions),
        indices: new Uint32Array(divider.indices),
        material: { type: 'solid', color: '#b0bec5' }, // Light concrete grey — clearly visible
        layerId: 'transit_deck_details'
      });
      // Yellow stripe on top of barrier for visibility
      const dividerStripe = this.generateRibbon(coords, -dividerWidth / 2 + 0.1, dividerWidth / 2 - 0.1, 0.85, 0);
      meshes.push({
        positions: new Float64Array(dividerStripe.positions),
        indices: new Uint32Array(dividerStripe.indices),
        material: { type: 'solid', color: '#fbbf24' }, // Yellow top stripe
        layerId: 'transit_deck_details'
      });
    } else if (!flyover.isOneWay) {
      // 4b. Double yellow line markings for two-way undivided roads
      const lineLeft = this.generateRibbon(coords, -0.12, -0.04, 0.03, 0);
      meshes.push({
        positions: new Float64Array(lineLeft.positions),
        indices: new Uint32Array(lineLeft.indices),
        material: { type: 'solid', color: '#fbbf24' }, // Yellow center divider
        layerId: 'transit_deck'
      });

      const lineRight = this.generateRibbon(coords, 0.04, 0.12, 0.03, 0);
      meshes.push({
        positions: new Float64Array(lineRight.positions),
        indices: new Uint32Array(lineRight.indices),
        material: { type: 'solid', color: '#fbbf24' },
        layerId: 'transit_deck'
      });
    }

    // 5. White lane separator markings
    const lanesA = Math.ceil(laneCount / (flyover.isOneWay ? 1 : 2));
    const lanesB = flyover.isOneWay ? 0 : Math.floor(laneCount / 2);

    if (lanesA > 1) {
      const startOffset = flyover.hasDivider ? -asphaltWidth / 2 : -asphaltWidth / 2;
      for (let i = 1; i < lanesA; i++) {
        const offset = startOffset + i * laneWidth;
        const mark = this.generateRibbon(coords, offset - 0.06, offset + 0.06, 0.025, 0);
        meshes.push({
          positions: new Float64Array(mark.positions),
          indices: new Uint32Array(mark.indices),
          material: { type: 'solid', color: '#cbd5e1' }, // white/light grey dashes
          layerId: 'transit_deck'
        });
      }
    }

    if (lanesB > 1) {
      const startOffset = flyover.hasDivider ? dividerWidth / 2 : 0;
      for (let i = 1; i < lanesB; i++) {
        const offset = startOffset + i * laneWidth;
        const mark = this.generateRibbon(coords, offset - 0.06, offset + 0.06, 0.025, 0);
        meshes.push({
          positions: new Float64Array(mark.positions),
          indices: new Uint32Array(mark.indices),
          material: { type: 'solid', color: '#cbd5e1' },
          layerId: 'transit_deck'
        });
      }
    }

    // 6. Box Girders underneath (LOD: transit_deck_details)
    // Left girder
    const leftGirder = this.generateRibbon(coords, -slabWidth * 0.4, -slabWidth * 0.08, -0.9, 0.6);
    meshes.push({
      positions: new Float64Array(leftGirder.positions),
      indices: new Uint32Array(leftGirder.indices),
      material: { type: 'solid', color: '#475569' }, // slate-600 concrete
      layerId: 'transit_deck_details'
    });

    // Right girder
    const rightGirder = this.generateRibbon(coords, slabWidth * 0.08, slabWidth * 0.4, -0.9, 0.6);
    meshes.push({
      positions: new Float64Array(rightGirder.positions),
      indices: new Uint32Array(rightGirder.indices),
      material: { type: 'solid', color: '#475569' },
      layerId: 'transit_deck_details'
    });

    // 7. Support Columns (Pillars) and horizontal Pier Caps
    const pierSpacing = flyover.pierSpacing || 30;
    const pillarMeshes = this.generateFlyoverPillars(
      flyover,
      slabWidth,
      pierSpacing,
      allObjects
    );
    meshes.push(...pillarMeshes);

    // 8. Solid Ramp Abutments (where deck is close to ground)
    const abutments = this.generateFlyoverRampAbutments(flyover, slabWidth);
    meshes.push(...abutments);

    return meshes;
  }

  private generateFlyoverPillars(
    flyover: FlyoverObject,
    deckSlabWidth: number,
    spacing: number,
    allObjects?: Map<string, CityObject>
  ): MeshData[] {
    const pillars: MeshData[] = [];
    const coords = flyover.coordinates;
    if (coords.length < 2) return pillars;

    const groundCoords = flyover.groundCoordinates;

    // Subsample positions along path based on spacing
    const distanceList: number[] = [0];
    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
      const p1 = wgs84ToCartesian(coords[i - 1][0], coords[i - 1][1], 0);
      const p2 = wgs84ToCartesian(coords[i][0], coords[i][1], 0);
      const dist = Math.sqrt(
        (p2[0] - p1[0]) ** 2 +
        (p2[1] - p1[1]) ** 2 +
        (p2[2] - p1[2]) ** 2
      );
      totalDist += dist;
      distanceList.push(totalDist);
    }

    // Get all roads in the scene for clash checking
    const allRoads: RoadObject[] = [];
    if (allObjects) {
      allObjects.forEach(obj => {
        if (obj.type === 'road' && obj.id !== flyover.id) {
          allRoads.push(obj as RoadObject);
        }
      });
    }

    let currentMarker = spacing / 2; // Offset first column from ramp start
    while (currentMarker < totalDist) {
      // Find segment matching the cumulative distance
      let idx = 0;
      while (idx < distanceList.length - 1 && distanceList[idx + 1] < currentMarker) {
        idx++;
      }

      // Interpolate along the matched segment
      const segmentStartDist = distanceList[idx];
      const segmentEndDist = distanceList[idx + 1];
      const t = (currentMarker - segmentStartDist) / (segmentEndDist - segmentStartDist);

      const pStart = coords[idx];
      const pEnd = coords[idx + 1];
      const interpLng = pStart[0] + (pEnd[0] - pStart[0]) * t;
      const interpLat = pStart[1] + (pEnd[1] - pStart[1]) * t;

      // Interpolate deck Z height
      const startZ = pStart[2] || 0;
      const endZ = pEnd[2] || 0;
      const deckZ = startZ + (endZ - startZ) * t;

      // Interpolate ground Z height
      let groundZ = 0;
      if (groundCoords && groundCoords[idx] && groundCoords[idx + 1]) {
        const gStart = groundCoords[idx][2] || 0;
        const gEnd = groundCoords[idx + 1][2] || 0;
        groundZ = gStart + (gEnd - gStart) * t;
      }

      // Elevation height check: Ramps ascend from 0 to target elevation.
      // Do not render pillars where the deck is close to the ground (height < 3.0 meters)
      const deckHeight = deckZ - groundZ;
      if (deckHeight >= 3.0) {
        // Calculate tangent vector at this segment for alignment
        const tangentECEF = [
          (pEnd[0] - pStart[0]),
          (pEnd[1] - pStart[1]),
          (pEnd[2] - pStart[2])
        ] as [number, number, number];

        // --- 2. Tapered Rectangular Pier (Pillar) ---
        // Scale pillar width relative to deck width to look structurally sound (like metro)
        const topWidth = Math.max(2.0, deckSlabWidth * 0.4); 
        const topLength = 1.4; // longitudinal length
        const botWidth = topWidth * 0.8;
        const botLength = 1.2;
        
        // Height of column: reaches the bottom of the pier cap, which is deckZ - 1.7
        const pillarHeight = deckHeight - 1.7;

        if (pillarHeight > 0.5) {
          const pillar = this.generateTaperedRectangularPier(
            interpLng,
            interpLat,
            pillarHeight,
            topWidth,
            topLength,
            botWidth,
            botLength,
            groundZ,
            tangentECEF,
            'transit_pillars'
          );
          pillars.push(pillar);

          // --- 3. Horizontal Pier Cap (LOD Details) ---
          // Width = 70% of deck width, length = 1.8m, depth = 0.8m
          // Placed at the top of the pillar (from deckZ - 1.7 to deckZ - 0.9)
          const capWidth = deckSlabWidth * 0.7;
          const capLength = 1.8;
          const capHeight = 0.8;
          const capElevation = deckZ - 1.7;

          const cap = this.generateRectangularBox(
            interpLng,
            interpLat,
            capElevation,
            capHeight,
            capWidth,
            capLength,
            tangentECEF,
            '#64748b', // Concrete cap grey
            'transit_pillars_details'
          );
          pillars.push(cap);
        }
      }

      currentMarker += spacing;
    }

    return pillars;
  }

  private generateTaperedRectangularPier(
    lng: number,
    lat: number,
    height: number,
    topW: number,
    topL: number,
    botW: number,
    botL: number,
    baseElevation: number,
    tangent: [number, number, number],
    layerId?: any
  ): MeshData {
    const base = wgs84ToCartesian(lng, lat, baseElevation);
    const u = normalize(base);
    const r = normalize(cross(tangent, u));
    const f = normalize(cross(u, r));

    const positionsList: number[] = [];
    const indicesList: number[] = [];

    // Bottom 4 vertices
    const halfBotW = botW / 2;
    const halfBotL = botL / 2;
    const botOffsets = [
      [-halfBotW, -halfBotL],
      [halfBotW, -halfBotL],
      [halfBotW, halfBotL],
      [-halfBotW, halfBotL]
    ];

    botOffsets.forEach(off => {
      const pt = [
        base[0] + r[0] * off[0] + f[0] * off[1],
        base[1] + r[1] * off[0] + f[1] * off[1],
        base[2] + r[2] * off[0] + f[2] * off[1]
      ];
      positionsList.push(...pt);
    });

    // Top 4 vertices
    const topBase = wgs84ToCartesian(lng, lat, baseElevation + height);
    const halfTopW = topW / 2;
    const halfTopL = topL / 2;
    const topOffsets = [
      [-halfTopW, -halfTopL],
      [halfTopW, -halfTopL],
      [halfTopW, halfTopL],
      [-halfTopW, halfTopL]
    ];

    topOffsets.forEach(off => {
      const pt = [
        topBase[0] + r[0] * off[0] + f[0] * off[1],
        topBase[1] + r[1] * off[0] + f[1] * off[1],
        topBase[2] + r[2] * off[0] + f[2] * off[1]
      ];
      positionsList.push(...pt);
    });

    // Side faces indices
    indicesList.push(0, 1, 5, 0, 5, 4);
    indicesList.push(1, 2, 6, 1, 6, 5);
    indicesList.push(2, 3, 7, 2, 7, 6);
    indicesList.push(3, 0, 4, 3, 4, 7);

    return {
      positions: new Float64Array(positionsList),
      indices: new Uint32Array(indicesList),
      material: { type: 'solid', color: '#64748b' },
      layerId
    };
  }

  private generateRectangularBox(
    lng: number,
    lat: number,
    baseElevation: number,
    boxHeight: number,
    boxWidth: number,
    boxLength: number,
    tangent: [number, number, number],
    color = '#64748b',
    layerId?: any
  ): MeshData {
    const base = wgs84ToCartesian(lng, lat, baseElevation);
    const u = normalize(base);
    const r = normalize(cross(tangent, u));
    const f = normalize(cross(u, r));

    const positionsList: number[] = [];
    const indicesList: number[] = [];

    const halfW = boxWidth / 2;
    const halfL = boxLength / 2;

    const offsets = [
      [-halfW, -halfL],
      [halfW, -halfL],
      [halfW, halfL],
      [-halfW, halfL]
    ];

    // Bottom 4 vertices
    offsets.forEach(off => {
      const pt = [
        base[0] + r[0] * off[0] + f[0] * off[1],
        base[1] + r[1] * off[0] + f[1] * off[1],
        base[2] + r[2] * off[0] + f[2] * off[1]
      ];
      positionsList.push(...pt);
    });

    // Top 4 vertices
    const topBase = wgs84ToCartesian(lng, lat, baseElevation + boxHeight);
    offsets.forEach(off => {
      const pt = [
        topBase[0] + r[0] * off[0] + f[0] * off[1],
        topBase[1] + r[1] * off[0] + f[1] * off[1],
        topBase[2] + r[2] * off[0] + f[2] * off[1]
      ];
      positionsList.push(...pt);
    });

    // Side faces indices
    indicesList.push(0, 1, 5, 0, 5, 4);
    indicesList.push(1, 2, 6, 1, 6, 5);
    indicesList.push(2, 3, 7, 2, 7, 6);
    indicesList.push(3, 0, 4, 3, 4, 7);

    // Top face
    indicesList.push(4, 5, 6, 4, 6, 7);

    return {
      positions: new Float64Array(positionsList),
      indices: new Uint32Array(indicesList),
      material: { type: 'solid', color },
      layerId
    };
  }

  private generateFlyoverRampAbutments(flyover: FlyoverObject, deckSlabWidth: number): MeshData[] {
    const meshes: MeshData[] = [];
    const coords = flyover.coordinates;
    const groundCoords = flyover.groundCoordinates;
    if (!groundCoords || coords.length < 2) return meshes;

    const positionsList: number[] = [];
    const indicesList: number[] = [];
    let indexOffset = 0;
    
    // Half width of the slab
    const halfW = deckSlabWidth / 2;

    for (let i = 0; i < coords.length - 1; i++) {
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const g1 = groundCoords[i];
      const g2 = groundCoords[i + 1];

      // Calculate heights
      const h1 = (p1[2] || 0) - (g1[2] || 0);
      const h2 = (p2[2] || 0) - (g2[2] || 0);

      // Only generate abutments where the deck is close to the ground (< 3.5m)
      if (h1 >= 3.5 && h2 >= 3.5) continue;

      // Calculate tangent to get perpendicular left/right vectors
      const c1 = wgs84ToCartesian(p1[0], p1[1], 0);
      const c2 = wgs84ToCartesian(p2[0], p2[1], 0);
      
      // Normalizing vectors (length)
      const dx = c2[0] - c1[0];
      const dy = c2[1] - c1[1];
      const dz = c2[2] - c1[2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const tangent = [dx / len, dy / len, dz / len] as [number, number, number];
      
      const up1 = normalize(wgs84ToCartesian(p1[0], p1[1], p1[2] || 0));
      const right1 = normalize(cross(tangent, up1));
      
      const up2 = normalize(wgs84ToCartesian(p2[0], p2[1], p2[2] || 0));
      const right2 = normalize(cross(tangent, up2));

      // 4 points for Left Wall
      const deckLeft1 = wgs84ToCartesian(p1[0], p1[1], p1[2]);
      deckLeft1[0] -= right1[0] * halfW;
      deckLeft1[1] -= right1[1] * halfW;
      deckLeft1[2] -= right1[2] * halfW;

      const groundLeft1 = wgs84ToCartesian(g1[0], g1[1], g1[2]);
      groundLeft1[0] -= right1[0] * halfW;
      groundLeft1[1] -= right1[1] * halfW;
      groundLeft1[2] -= right1[2] * halfW;

      const deckLeft2 = wgs84ToCartesian(p2[0], p2[1], p2[2]);
      deckLeft2[0] -= right2[0] * halfW;
      deckLeft2[1] -= right2[1] * halfW;
      deckLeft2[2] -= right2[2] * halfW;

      const groundLeft2 = wgs84ToCartesian(g2[0], g2[1], g2[2]);
      groundLeft2[0] -= right2[0] * halfW;
      groundLeft2[1] -= right2[1] * halfW;
      groundLeft2[2] -= right2[2] * halfW;
      
      // Left Wall Quads (counter-clockwise)
      positionsList.push(...deckLeft1, ...groundLeft1, ...groundLeft2, ...deckLeft2);
      indicesList.push(
        indexOffset, indexOffset + 1, indexOffset + 2, 
        indexOffset, indexOffset + 2, indexOffset + 3
      );
      indexOffset += 4;

      // 4 points for Right Wall
      const deckRight1 = wgs84ToCartesian(p1[0], p1[1], p1[2]);
      deckRight1[0] += right1[0] * halfW;
      deckRight1[1] += right1[1] * halfW;
      deckRight1[2] += right1[2] * halfW;

      const groundRight1 = wgs84ToCartesian(g1[0], g1[1], g1[2]);
      groundRight1[0] += right1[0] * halfW;
      groundRight1[1] += right1[1] * halfW;
      groundRight1[2] += right1[2] * halfW;

      const deckRight2 = wgs84ToCartesian(p2[0], p2[1], p2[2]);
      deckRight2[0] += right2[0] * halfW;
      deckRight2[1] += right2[1] * halfW;
      deckRight2[2] += right2[2] * halfW;

      const groundRight2 = wgs84ToCartesian(g2[0], g2[1], g2[2]);
      groundRight2[0] += right2[0] * halfW;
      groundRight2[1] += right2[1] * halfW;
      groundRight2[2] += right2[2] * halfW;

      // Right Wall Quads (reverse winding)
      positionsList.push(...deckRight1, ...deckRight2, ...groundRight2, ...groundRight1);
      indicesList.push(
        indexOffset, indexOffset + 1, indexOffset + 2, 
        indexOffset, indexOffset + 2, indexOffset + 3
      );
      indexOffset += 4;
    }

    if (positionsList.length > 0) {
      meshes.push({
        positions: new Float64Array(positionsList),
        indices: new Uint32Array(indicesList),
        material: { type: 'solid', color: '#475569' }, // Darker slate grey for side walls
        layerId: 'transit_deck_details'
      });
    }

    return meshes;
  }

  private generateMetroFlyoverMeshes(mf: MetroFlyoverObject, allObjects?: Map<string, CityObject>): MeshData[] {
    const meshes: MeshData[] = [];
    const coords = mf.coordinates;
    if (coords.length < 2) return meshes;

    const groundCoords = mf.groundCoordinates || coords.map(c => [c[0], c[1], 0]);
    const metroElevation = mf.metroElevation || 12.0;
    const metroCoords = groundCoords.map(c => [c[0], c[1], c[2] + metroElevation] as [number, number, number]);

    const laneWidth = mf.laneWidth || 3.5;
    const laneCount = mf.laneCount || 4;
    const dividerWidth = mf.hasDivider ? (mf.dividerWidth || 2.0) : 0;
    const roadAsphaltWidth = laneCount * laneWidth + dividerWidth;
    const roadSlabWidth = roadAsphaltWidth + 1.2;

    // ==========================================
    // 1. MIDDLE LEVEL: ROAD DECK
    // ==========================================
    // A. Concrete Deck Slab
    const roadSlab = this.generateRibbon(coords, -roadSlabWidth / 2, roadSlabWidth / 2, -0.3, 0.3);
    meshes.push({
      positions: new Float64Array(roadSlab.positions),
      indices: new Uint32Array(roadSlab.indices),
      material: { type: 'solid', color: '#64748b' }, // Medium concrete grey
      layerId: 'transit_deck'
    });

    // B. Asphalt Surface
    const asphaltColor = mf.roadClass === 'highway' ? '#0f172a' : '#1e293b';
    const roadAsphalt = this.generateRibbon(coords, -roadAsphaltWidth / 2, roadAsphaltWidth / 2, 0.02, 0);
    meshes.push({
      positions: new Float64Array(roadAsphalt.positions),
      indices: new Uint32Array(roadAsphalt.indices),
      material: { type: 'solid', color: asphaltColor },
      layerId: 'transit_deck'
    });

    // C. Outer Side Barriers (Parapets) (LOD Details)
    const leftRoadBarrier = this.generateRibbon(coords, -roadSlabWidth / 2, -roadSlabWidth / 2 + 0.4, 0.0, 0.8);
    meshes.push({
      positions: new Float64Array(leftRoadBarrier.positions),
      indices: new Uint32Array(leftRoadBarrier.indices),
      material: { type: 'solid', color: '#64748b' },
      layerId: 'transit_deck_details'
    });

    const rightRoadBarrier = this.generateRibbon(coords, roadSlabWidth / 2 - 0.4, roadSlabWidth / 2, 0.0, 0.8);
    meshes.push({
      positions: new Float64Array(rightRoadBarrier.positions),
      indices: new Uint32Array(rightRoadBarrier.indices),
      material: { type: 'solid', color: '#64748b' },
      layerId: 'transit_deck_details'
    });

    // D. Central Divider Concrete Median — Jersey barrier style
    if (mf.hasDivider && dividerWidth > 0.1) {
      // Main concrete barrier body — raised 0.8m above asphalt surface
      const divider = this.generateRibbon(coords, -dividerWidth / 2, dividerWidth / 2, 0.04, 0.8);
      meshes.push({
        positions: new Float64Array(divider.positions),
        indices: new Uint32Array(divider.indices),
        material: { type: 'solid', color: '#b0bec5' }, // Light concrete grey
        layerId: 'transit_deck_details'
      });
      // Yellow stripe on top of barrier for visibility
      const dividerStripe = this.generateRibbon(coords, -dividerWidth / 2 + 0.1, dividerWidth / 2 - 0.1, 0.85, 0);
      meshes.push({
        positions: new Float64Array(dividerStripe.positions),
        indices: new Uint32Array(dividerStripe.indices),
        material: { type: 'solid', color: '#fbbf24' },
        layerId: 'transit_deck_details'
      });
    } else if (!mf.isOneWay) {
      const lineLeft = this.generateRibbon(coords, -0.12, -0.04, 0.03, 0);
      meshes.push({
        positions: new Float64Array(lineLeft.positions),
        indices: new Uint32Array(lineLeft.indices),
        material: { type: 'solid', color: '#fbbf24' },
        layerId: 'transit_deck'
      });
      const lineRight = this.generateRibbon(coords, 0.04, 0.12, 0.03, 0);
      meshes.push({
        positions: new Float64Array(lineRight.positions),
        indices: new Uint32Array(lineRight.indices),
        material: { type: 'solid', color: '#fbbf24' },
        layerId: 'transit_deck'
      });
    }

    // E. Lane Dividers
    const lanesA = Math.ceil(laneCount / (mf.isOneWay ? 1 : 2));
    const lanesB = mf.isOneWay ? 0 : Math.floor(laneCount / 2);

    if (lanesA > 1) {
      const startOffset = mf.hasDivider ? -roadAsphaltWidth / 2 : -roadAsphaltWidth / 2;
      for (let i = 1; i < lanesA; i++) {
        const offset = startOffset + i * laneWidth;
        const mark = this.generateRibbon(coords, offset - 0.06, offset + 0.06, 0.025, 0);
        meshes.push({
          positions: new Float64Array(mark.positions),
          indices: new Uint32Array(mark.indices),
          material: { type: 'solid', color: '#cbd5e1' },
          layerId: 'transit_deck'
        });
      }
    }
    if (lanesB > 1) {
      const startOffset = mf.hasDivider ? dividerWidth / 2 : 0;
      for (let i = 1; i < lanesB; i++) {
        const offset = startOffset + i * laneWidth;
        const mark = this.generateRibbon(coords, offset - 0.06, offset + 0.06, 0.025, 0);
        meshes.push({
          positions: new Float64Array(mark.positions),
          indices: new Uint32Array(mark.indices),
          material: { type: 'solid', color: '#cbd5e1' },
          layerId: 'transit_deck'
        });
      }
    }

    // F. Twin Road Box Girders Underneath (LOD Details)
    const leftRoadGirder = this.generateRibbon(coords, -roadSlabWidth * 0.4, -roadSlabWidth * 0.08, -0.9, 0.6);
    meshes.push({
      positions: new Float64Array(leftRoadGirder.positions),
      indices: new Uint32Array(leftRoadGirder.indices),
      material: { type: 'solid', color: '#475569' },
      layerId: 'transit_deck_details'
    });
    const rightRoadGirder = this.generateRibbon(coords, roadSlabWidth * 0.08, roadSlabWidth * 0.4, -0.9, 0.6);
    meshes.push({
      positions: new Float64Array(rightRoadGirder.positions),
      indices: new Uint32Array(rightRoadGirder.indices),
      material: { type: 'solid', color: '#475569' },
      layerId: 'transit_deck_details'
    });

    // ==========================================
    // 2. TOP LEVEL: METRO DECK
    // ==========================================
    const metroDeckWidth = 5.0;
    
    // A. Concrete Metro Deck slab
    const metroSlab = this.generateRibbon(metroCoords, -metroDeckWidth / 2, metroDeckWidth / 2, -0.4, 0.4);
    meshes.push({
      positions: new Float64Array(metroSlab.positions),
      indices: new Uint32Array(metroSlab.indices),
      material: { type: 'solid', color: '#1e293b' }, // Dark transit slab
      layerId: 'transit_deck'
    });

    // B. Concrete Metro Girder Underneath (LOD Details)
    const metroGirder = this.generateRibbon(metroCoords, -metroDeckWidth * 0.4, metroDeckWidth * 0.4, -0.9, 0.5);
    meshes.push({
      positions: new Float64Array(metroGirder.positions),
      indices: new Uint32Array(metroGirder.indices),
      material: { type: 'solid', color: '#475569' },
      layerId: 'transit_deck_details'
    });

    // C. Glowing rails (LOD Details)
    const railLeft = this.generateRibbon(metroCoords, -1.5, -1.3, 0.1, 0.1);
    meshes.push({
      positions: new Float64Array(railLeft.positions),
      indices: new Uint32Array(railLeft.indices),
      material: { type: 'solid', color: '#a5f3fc' }, // cyan glow
      layerId: 'transit_rails'
    });
    const railRight = this.generateRibbon(metroCoords, 1.3, 1.5, 0.1, 0.1);
    meshes.push({
      positions: new Float64Array(railRight.positions),
      indices: new Uint32Array(railRight.indices),
      material: { type: 'solid', color: '#a5f3fc' },
      layerId: 'transit_rails'
    });

    // D. Outer Side Barriers (Parapets) (LOD Details)
    const leftMetroBarrier = this.generateRibbon(metroCoords, -metroDeckWidth / 2, -metroDeckWidth / 2 + 0.35, 0.0, 0.8);
    meshes.push({
      positions: new Float64Array(leftMetroBarrier.positions),
      indices: new Uint32Array(leftMetroBarrier.indices),
      material: { type: 'solid', color: '#334155' },
      layerId: 'transit_deck_details'
    });
    const rightMetroBarrier = this.generateRibbon(metroCoords, metroDeckWidth / 2 - 0.35, metroDeckWidth / 2, 0.0, 0.8);
    meshes.push({
      positions: new Float64Array(rightMetroBarrier.positions),
      indices: new Uint32Array(rightMetroBarrier.indices),
      material: { type: 'solid', color: '#334155' },
      layerId: 'transit_deck_details'
    });

    // ==========================================
    // 3. PILLARS & PIER CAPS (DOUBLE-DECKER SYSTEM)
    // ==========================================
    const pierSpacing = mf.pierSpacing || 30;
    
    // Subsample positions along path based on spacing
    const distanceList: number[] = [0];
    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
      const p1 = wgs84ToCartesian(coords[i - 1][0], coords[i - 1][1], 0);
      const p2 = wgs84ToCartesian(coords[i][0], coords[i][1], 0);
      const dist = Math.sqrt(
        (p2[0] - p1[0]) ** 2 +
        (p2[1] - p1[1]) ** 2 +
        (p2[2] - p1[2]) ** 2
      );
      totalDist += dist;
      distanceList.push(totalDist);
    }

    const allRoads: RoadObject[] = [];
    if (allObjects) {
      allObjects.forEach(obj => {
        if (obj.type === 'road' && obj.id !== mf.id) {
          allRoads.push(obj as RoadObject);
        }
      });
    }

    let currentMarker = pierSpacing / 2;
    while (currentMarker < totalDist) {
      let idx = 0;
      while (idx < distanceList.length - 1 && distanceList[idx + 1] < currentMarker) {
        idx++;
      }

      const segmentStartDist = distanceList[idx];
      const segmentEndDist = distanceList[idx + 1];
      const t = (currentMarker - segmentStartDist) / (segmentEndDist - segmentStartDist);

      const pStart = coords[idx];
      const pEnd = coords[idx + 1];
      const interpLng = pStart[0] + (pEnd[0] - pStart[0]) * t;
      const interpLat = pStart[1] + (pEnd[1] - pStart[1]) * t;

      const deckZ = pStart[2] + (pEnd[2] - pStart[2]) * t;

      let groundZ = 0;
      if (groundCoords && groundCoords[idx] && groundCoords[idx + 1]) {
        const gStart = groundCoords[idx][2] || 0;
        const gEnd = groundCoords[idx + 1][2] || 0;
        groundZ = gStart + (gEnd - gStart) * t;
      }

      const metroZ = groundZ + metroElevation;

      const tangentECEF = [
        (pEnd[0] - pStart[0]),
        (pEnd[1] - pStart[1]),
        (pEnd[2] - pStart[2])
      ] as [number, number, number];

      // --- 2. Central Structural Pier (reaches top metro deck cap at metroZ - 1.7) ---
      const topWidth = 2.0;
      const topLength = 1.4;
      const botWidth = 1.6;
      const botLength = 1.2;
      const pillarHeight = metroElevation - 1.7;

      if (pillarHeight > 0.5) {
        const pillar = this.generateTaperedRectangularPier(
          interpLng,
          interpLat,
          pillarHeight,
          topWidth,
          topLength,
          botWidth,
          botLength,
          groundZ,
          tangentECEF,
          'transit_pillars'
        );
        meshes.push(pillar);

        // --- 3. Upper Pier Cap (supporting Metro Deck) (LOD Details) ---
        const upperCap = this.generateRectangularBox(
          interpLng,
          interpLat,
          metroZ - 1.7,
          0.8,
          4.0,
          1.8,
          tangentECEF,
          '#64748b',
          'transit_pillars_details'
        );
        meshes.push(upperCap);

        // --- 4. Lower Pier Cap (supporting Middle Road Deck) (LOD Details) ---
        const roadDeckHeight = deckZ - groundZ;
        if (roadDeckHeight >= 3.0) {
          const lowerCapWidth = roadSlabWidth * 0.7;
          const lowerCap = this.generateRectangularBox(
            interpLng,
            interpLat,
            deckZ - 1.7,
            0.8,
            lowerCapWidth,
            1.8,
            tangentECEF,
            '#64748b',
            'transit_pillars_details'
          );
          meshes.push(lowerCap);
        }
      }

      currentMarker += pierSpacing;
    }

    return meshes;
  }

  /**
   * Generates procedural elevated metro tracks and pillars
   */
  private generateMetroLineMeshes(metro: MetroLineObject): MeshData[] {
    const meshes: MeshData[] = [];
    const coords = metro.coordinates;
    const elevation = metro.elevation || 12;
    const deckWidth = 5.0;

    const averageElev = coords.reduce((sum, c) => sum + (c[2] || 0), 0) / coords.length;
    const renderElevation = averageElev > 0.5 ? 0 : elevation;

    // 1. Metro track bed deck
    const deck = this.generateRibbon(coords, -deckWidth / 2, deckWidth / 2, renderElevation, 0.4);
    meshes.push({
      positions: new Float64Array(deck.positions),
      indices: new Uint32Array(deck.indices),
      material: { type: 'solid', color: '#1e293b' },
      layerId: 'transit_deck'
    });

    // 2. Glowing rails
    const railLeft = this.generateRibbon(coords, -1.5, -1.3, renderElevation + 0.1, 0.1);
    meshes.push({
      positions: new Float64Array(railLeft.positions),
      indices: new Uint32Array(railLeft.indices),
      material: { type: 'solid', color: '#a5f3fc' }, // cyan glowing track
      layerId: 'transit_rails'
    });

    const railRight = this.generateRibbon(coords, 1.3, 1.5, renderElevation + 0.1, 0.1);
    meshes.push({
      positions: new Float64Array(railRight.positions),
      indices: new Uint32Array(railRight.indices),
      material: { type: 'solid', color: '#a5f3fc' },
      layerId: 'transit_rails'
    });

    // 3. Support pillars
    const pierSpacing = metro.pierSpacing || 30;
    const pillars = this.generatePillarsAlongCenterline(coords, undefined, renderElevation, pierSpacing, 'transit_pillars');
    meshes.push(...pillars);

    return meshes;
  }

  /**
   * Generates concrete support pillars at regular metric intervals along a coordinate path
   */
  private generatePillarsAlongCenterline(
    coords: [number, number, number][],
    groundCoords: [number, number, number][] | undefined,
    height: number,
    spacing: number,
    layerId?: any
  ): MeshData[] {
    const pillars: MeshData[] = [];
    if (coords.length < 2) return pillars;

    // 1. Subsample positions along path based on spacing
    // We compute cumulative metric distance along coordinates
    const distanceList: number[] = [0];
    let totalDist = 0;
    for (let i = 1; i < coords.length; i++) {
      const p1 = wgs84ToCartesian(coords[i - 1][0], coords[i - 1][1], 0);
      const p2 = wgs84ToCartesian(coords[i][0], coords[i][1], 0);
      const dist = Math.sqrt(
        (p2[0] - p1[0]) ** 2 +
        (p2[1] - p1[1]) ** 2 +
        (p2[2] - p1[2]) ** 2
      );
      totalDist += dist;
      distanceList.push(totalDist);
    }

    // Place columns at regular spacing intervals
    const radius = 1.0; // 1m column radius
    let currentMarker = spacing / 2; // offset first column
    while (currentMarker < totalDist) {
      // Find segment matching the cumulative distance
      let idx = 0;
      while (idx < distanceList.length - 1 && distanceList[idx + 1] < currentMarker) {
        idx++;
      }

      // Interpolate along the matched segment
      const segmentStartDist = distanceList[idx];
      const segmentEndDist = distanceList[idx + 1];
      const t = (currentMarker - segmentStartDist) / (segmentEndDist - segmentStartDist);

      const pStart = coords[idx];
      const pEnd = coords[idx + 1];
      const interpLng = pStart[0] + (pEnd[0] - pStart[0]) * t;
      const interpLat = pStart[1] + (pEnd[1] - pStart[1]) * t;

      // Interpolate Z coordinate and add height offset
      const startZ = pStart[2] || 0;
      const endZ = pEnd[2] || 0;
      const deckZ = startZ + (endZ - startZ) * t;

      let groundZ = 0;
      if (groundCoords && groundCoords[idx] && groundCoords[idx + 1]) {
        const gStart = groundCoords[idx][2] || 0;
        const gEnd = groundCoords[idx + 1][2] || 0;
        groundZ = gStart + (gEnd - gStart) * t;
      }

      const pillarHeight = deckZ - groundZ + height;

      // Skip columns near ramps where deck height is too low (height < 1.5m)
      if (pillarHeight >= 1.5) {
        const columnMesh = this.generateCylinder(
          interpLng,
          interpLat,
          pillarHeight,
          radius,
          layerId,
          '#64748b',
          groundZ
        );
        pillars.push(columnMesh);
      }

      currentMarker += spacing;
    }

    return pillars;
  }

  /**
   * Generates a cylinder pier geometry representing a support column
   */
  private generateCylinder(
    lng: number, 
    lat: number, 
    height: number, 
    radius: number, 
    layerId?: any,
    color = '#64748b',
    baseElevation = 0
  ): MeshData {
    const positionsList: number[] = [];
    const indicesList: number[] = [];
    const segments = 12;

    // 1. Generate cylinder vertices
    // Top circle and bottom circle
    for (let hOffset = 0; hOffset <= height; hOffset += height) {
      const base = wgs84ToCartesian(lng, lat, baseElevation + hOffset);
      const up = normalize(base);
      
      // Calculate right/forward vectors orthogonal to local up
      let arbitrary = [1, 0, 0] as [number, number, number];
      if (Math.abs(up[0]) > 0.9) arbitrary = [0, 1, 0];
      const right = normalize(cross(up, arbitrary));
      const forward = normalize(cross(up, right));

      for (let i = 0; i < segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const xOffset = Math.cos(theta) * radius;
        const yOffset = Math.sin(theta) * radius;

        const pt = [
          base[0] + right[0] * xOffset + forward[0] * yOffset,
          base[1] + right[1] * xOffset + forward[1] * yOffset,
          base[2] + right[2] * xOffset + forward[2] * yOffset
        ];
        positionsList.push(...pt);
      }
    }

    // 2. Generate side indices
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      const botCurr = i;
      const botNext = next;
      const topCurr = i + segments;
      const topNext = next + segments;

      indicesList.push(botCurr, botNext, topNext);
      indicesList.push(botCurr, topNext, topCurr);
    }

    return {
      positions: new Float64Array(positionsList),
      indices: new Uint32Array(indicesList),
      material: { type: 'solid', color },
      layerId
    };
  }

  private getJunctionRadius(j: JunctionObject, allObjects?: Map<string, CityObject>): number {
    if (!allObjects) return 4.0;
    
    let maxRoadWidth = 6.0;
    
    if (j.connectedRoads && j.connectedRoads.length > 0) {
      j.connectedRoads.forEach(roadId => {
        const road = allObjects.get(roadId);
        if (road && road.type === 'road') {
          const r = road as RoadObject;
          if (r.width && r.width > maxRoadWidth) {
            maxRoadWidth = r.width;
          }
        }
      });
    } else {
      Array.from(allObjects.values()).forEach(obj => {
        if (obj.type === 'road') {
          const r = obj as RoadObject;
          const coords = r.coordinates;
          if (coords.length > 0) {
            const startPt = coords[0];
            const endPt = coords[coords.length - 1];
            
            const distStart = Math.sqrt(
              Math.pow(startPt[0] - j.coordinates[0], 2) + 
              Math.pow(startPt[1] - j.coordinates[1], 2)
            );
            const distEnd = Math.sqrt(
              Math.pow(endPt[0] - j.coordinates[0], 2) + 
              Math.pow(endPt[1] - j.coordinates[1], 2)
            );
            
            if (distStart < 0.00006 || distEnd < 0.00006) {
              if (r.width && r.width > maxRoadWidth) {
                maxRoadWidth = r.width;
              }
            }
          }
        }
      });
    }

    return Math.max(3.0, maxRoadWidth / 2 + 0.5);
  }

  private generateJunctionMesh(j: JunctionObject, allObjects?: Map<string, CityObject>): MeshData {
    const radius = this.getJunctionRadius(j, allObjects);
    let elevation = j.coordinates[2] || 0;

    if (allObjects) {
      let maxRoadElev = elevation;
      
      // Determine dynamic junction elevation matching the maximum of connected elevated roads
      if (j.connectedRoads && j.connectedRoads.length > 0) {
        j.connectedRoads.forEach(roadId => {
          const road = allObjects.get(roadId);
          if (road && road.type === 'road') {
            const r = road as RoadObject;
            const coords = r.coordinates;
            if (coords.length > 0) {
              const startPt = coords[0];
              const endPt = coords[coords.length - 1];
              
              const distStart = Math.sqrt(
                Math.pow(startPt[0] - j.coordinates[0], 2) + 
                Math.pow(startPt[1] - j.coordinates[1], 2)
              );
              const distEnd = Math.sqrt(
                Math.pow(endPt[0] - j.coordinates[0], 2) + 
                Math.pow(endPt[1] - j.coordinates[1], 2)
              );
              
              if (distStart < 0.00006) {
                const startZ = r.osmProvenance?.bridge ? 6.0 : (startPt[2] || 0);
                if (startZ > maxRoadElev) maxRoadElev = startZ;
              } else if (distEnd < 0.00006) {
                const endZ = r.osmProvenance?.bridge ? 6.0 : (endPt[2] || 0);
                if (endZ > maxRoadElev) maxRoadElev = endZ;
              }
            }
          }
        });
      }
      
      elevation = maxRoadElev;
    }

    return this.generateCylinder(
      j.coordinates[0], 
      j.coordinates[1], 
      0.02, 
      radius, 
      'asphalt', 
      '#1e293b', 
      elevation
    );
  }

  private dot(a: [number, number, number], b: [number, number, number]): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  private sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  private generateLocalBox(
    center: [number, number, number],
    up: [number, number, number],
    right: [number, number, number],
    forward: [number, number, number],
    length: number,
    width: number,
    height: number,
    color: string,
    layerId: any
  ): MeshData {
    const dx = [right[0] * width / 2, right[1] * width / 2, right[2] * width / 2];
    const dy = [forward[0] * length / 2, forward[1] * length / 2, forward[2] * length / 2];
    const dz = [up[0] * height / 2, up[1] * height / 2, up[2] * height / 2];

    const corners = [
      // Bottom 4 points
      [center[0] - dx[0] - dy[0] - dz[0], center[1] - dx[1] - dy[1] - dz[1], center[2] - dx[2] - dy[2] - dz[2]],
      [center[0] + dx[0] - dy[0] - dz[0], center[1] + dx[1] - dy[1] - dz[1], center[2] + dx[2] - dy[2] - dz[2]],
      [center[0] + dx[0] + dy[0] - dz[0], center[1] + dx[1] + dy[1] - dz[1], center[2] + dx[2] + dy[2] - dz[2]],
      [center[0] - dx[0] + dy[0] - dz[0], center[1] - dx[1] + dy[1] - dz[1], center[2] - dx[2] + dy[2] - dz[2]],
      // Top 4 points
      [center[0] - dx[0] - dy[0] + dz[0], center[1] - dx[1] - dy[1] + dz[1], center[2] - dx[2] - dy[2] + dz[2]],
      [center[0] + dx[0] - dy[0] + dz[0], center[1] + dx[1] - dy[1] + dz[1], center[2] + dx[2] - dy[2] + dz[2]],
      [center[0] + dx[0] + dy[0] + dz[0], center[1] + dx[1] + dy[1] + dz[1], center[2] + dx[2] + dy[2] + dz[2]],
      [center[0] - dx[0] + dy[0] + dz[0], center[1] - dx[1] + dy[1] + dz[1], center[2] - dx[2] + dy[2] + dz[2]]
    ];

    const positions = new Float64Array(corners.flat());
    const indices = new Uint32Array([
      // Front
      0, 1, 5, 0, 5, 4,
      // Right
      1, 2, 6, 1, 6, 5,
      // Back
      2, 3, 7, 2, 7, 6,
      // Left
      3, 0, 4, 3, 4, 7,
      // Top
      4, 5, 6, 4, 6, 7,
      // Bottom
      3, 2, 1, 3, 1, 0
    ]);

    return {
      positions,
      indices,
      material: { type: 'solid', color },
      layerId
    };
  }

  private generateLocalArch(
    center: [number, number, number],
    up: [number, number, number],
    right: [number, number, number],
    forward: [number, number, number],
    length: number,
    spanWidth: number,
    archHeight: number,
    color: string,
    layerId: any
  ): MeshData {
    const positionsList: number[] = [];
    const indicesList: number[] = [];
    
    const stepsX = 16;
    const stepsY = 10;

    for (let y = 0; y <= stepsY; y++) {
      const tY = y / stepsY;
      const yOffset = (tY - 0.5) * length;

      for (let x = 0; x <= stepsX; x++) {
        const tX = x / stepsX;
        const theta = -Math.PI / 2 + tX * Math.PI;

        const rightOffset = Math.sin(theta) * (spanWidth / 2);
        const upOffset = Math.cos(theta) * archHeight;

        const pt = [
          center[0] + right[0] * rightOffset + forward[0] * yOffset + up[0] * upOffset,
          center[1] + right[1] * rightOffset + forward[1] * yOffset + up[1] * upOffset,
          center[2] + right[2] * rightOffset + forward[2] * yOffset + up[2] * upOffset
        ];
        positionsList.push(...pt);
      }
    }

    const verticesPerRow = stepsX + 1;
    for (let y = 0; y < stepsY; y++) {
      for (let x = 0; x < stepsX; x++) {
        const r0c0 = y * verticesPerRow + x;
        const r0c1 = r0c0 + 1;
        const r1c0 = (y + 1) * verticesPerRow + x;
        const r1c1 = r1c0 + 1;

        indicesList.push(r0c0, r0c1, r1c1);
        indicesList.push(r0c0, r1c1, r1c0);
      }
    }

    return {
      positions: new Float64Array(positionsList),
      indices: new Uint32Array(indicesList),
      material: { type: 'solid', color },
      layerId
    };
  }

  private generateMetroStationMeshes(station: MetroStationObject, allObjects?: Map<string, CityObject>): MeshData[] {
    const meshes: MeshData[] = [];
    const position = station.coordinates;
    const length = station.length || 140;
    const width = station.width || 20;
    const height = station.height || 8;
    const elevation = station.elevation || 12;

    const center = wgs84ToCartesian(position[0], position[1], elevation);
    const up = normalize(center);

    let forward = [0, 0, 0] as [number, number, number];
    let right = [0, 0, 0] as [number, number, number];
    let aligned = false;

    if (allObjects) {
      let minDist = Infinity;
      let bestTangent = [0, 0, 0] as [number, number, number];

      for (const obj of allObjects.values()) {
        if (obj.type === 'metro_line') {
          const line = obj as MetroLineObject;
          const coords = line.coordinates;
          if (coords.length < 2) continue;

          const pECEF = coords.map(c => wgs84ToCartesian(c[0], c[1], elevation));

          for (let i = 0; i < pECEF.length - 1; i++) {
            const p1 = pECEF[i];
            const p2 = pECEF[i + 1];

            const v = this.sub(p2, p1);
            const w = this.sub(center, p1);

            const c1 = this.dot(w, v);
            const c2 = this.dot(v, v);

            let proj: [number, number, number];
            if (c1 <= 0) {
              proj = p1;
            } else if (c2 <= c1) {
              proj = p2;
            } else {
              const b = c1 / c2;
              proj = [p1[0] + v[0] * b, p1[1] + v[1] * b, p1[2] + v[2] * b];
            }

            const distVec = this.sub(center, proj);
            const dist = Math.sqrt(this.dot(distVec, distVec));

            if (dist < minDist) {
              minDist = dist;
              bestTangent = normalize(v);
            }
          }
        }
      }

      if (minDist < 100) {
        const dotVal = this.dot(bestTangent, up);
        const tangentProj = [
          bestTangent[0] - up[0] * dotVal,
          bestTangent[1] - up[1] * dotVal,
          bestTangent[2] - up[2] * dotVal
        ] as [number, number, number];

        forward = normalize(tangentProj);
        right = normalize(cross(forward, up));
        aligned = true;
      }
    }

    if (!aligned) {
      let arbitrary = [1, 0, 0] as [number, number, number];
      if (Math.abs(up[0]) > 0.9) arbitrary = [0, 1, 0];
      right = normalize(cross(up, arbitrary));
      forward = normalize(cross(up, right));
    }

    // A. Concrete Pillars (4 rectangular support columns from ground level to concourse deck)
    const pillarHeight = elevation - 2.0;
    
    const ox = (width - 2) / 3;
    const oy = (length - 20) / 3;
    const pillarOffsets = [
      [-ox, -oy],
      [ox, -oy],
      [-ox, oy],
      [ox, oy]
    ];

    for (const [oxVal, oyVal] of pillarOffsets) {
      const centerGround = wgs84ToCartesian(position[0], position[1], 0);
      const pillarBase = [
        centerGround[0] + right[0] * oxVal + forward[0] * oyVal,
        centerGround[1] + right[1] * oxVal + forward[1] * oyVal,
        centerGround[2] + right[2] * oxVal + forward[2] * oyVal
      ] as [number, number, number];

      // Shift the box center vertically by half of the pillar height
      const pillarBoxCenter = [
        pillarBase[0] + up[0] * (pillarHeight / 2),
        pillarBase[1] + up[1] * (pillarHeight / 2),
        pillarBase[2] + up[2] * (pillarHeight / 2)
      ] as [number, number, number];

      const pillarMesh = this.generateLocalBox(
        pillarBoxCenter,
        up,
        right,
        forward,
        2.0, // length (along track)
        2.0, // width (transverse)
        pillarHeight,
        '#64748b', // Concrete grey
        'transit_pillars'
      );
      meshes.push(pillarMesh);
    }

    // A2. Concrete Crossbeams connecting the pillars
    const beamWidth = ox * 2;
    const beamOffsets = [-oy, oy];
    for (const oyVal of beamOffsets) {
      const beamCenter = [
        center[0] - up[0] * 2.5 + forward[0] * oyVal,
        center[1] - up[1] * 2.5 + forward[1] * oyVal,
        center[2] - up[2] * 2.5 + forward[2] * oyVal
      ] as [number, number, number];

      const beamMesh = this.generateLocalBox(
        beamCenter,
        up,
        right,
        forward,
        2.4,
        beamWidth,
        1.2,
        '#475569',
        'transit_pillars'
      );
      meshes.push(beamMesh);
    }

    // B. Concourse Deck (Lower deck)
    const concourseCenter = [
      center[0] - up[0] * 1.5,
      center[1] - up[1] * 1.5,
      center[2] - up[2] * 1.5
    ] as [number, number, number];

    const concourseDeck = this.generateLocalBox(
      concourseCenter,
      up,
      right,
      forward,
      length - 20,
      width - 4,
      1.5,
      '#334155',
      'transit_deck'
    );
    meshes.push(concourseDeck);

    // C. Platform Deck (Upper deck)
    const platformCenter = [
      center[0] + up[0] * 1.5,
      center[1] + up[1] * 1.5,
      center[2] + up[2] * 1.5
    ] as [number, number, number];

    const platformDeck = this.generateLocalBox(
      platformCenter,
      up,
      right,
      forward,
      length,
      width,
      0.8,
      '#475569',
      'transit_deck'
    );
    meshes.push(platformDeck);



    // D. Open Air Safety Railings
    const railLength = length - 6;
    const railWidth = 0.1;
    const railHeight = 1.2;
    const railCenterZOffset = 2.5;
    const railHalfWidth = width / 2;
    const railOffsets = [-railHalfWidth, railHalfWidth];

    for (const offset of railOffsets) {
      const railCenter = [
        center[0] + right[0] * offset + up[0] * railCenterZOffset,
        center[1] + right[1] * offset + up[1] * railCenterZOffset,
        center[2] + right[2] * offset + up[2] * railCenterZOffset
      ] as [number, number, number];

      const railing = this.generateLocalBox(
        railCenter,
        up,
        right,
        forward,
        railLength,
        railWidth,
        railHeight,
        'rgba(56, 189, 248, 0.55)',
        'transit_station'
      );
      meshes.push(railing);
    }

    // E. Structural Steel Arch Ribs (5 skeleton girders spaced along length)
    const ribSpanWidth = width + 2.0;
    const ribArchHeight = height - 2.8 > 3.0 ? height - 2.8 : 3.5;
    const ribOffsets = [-oy, -oy / 2, 0, oy / 2, oy];

    for (const oyVal of ribOffsets) {
      const ribCenter = [
        center[0] + up[0] * 4.5 + forward[0] * oyVal,
        center[1] + up[1] * 4.5 + forward[1] * oyVal,
        center[2] + up[2] * 4.5 + forward[2] * oyVal
      ] as [number, number, number];

      const steelRib = this.generateLocalArch(
        ribCenter,
        up,
        right,
        forward,
        1.5,
        ribSpanWidth,
        ribArchHeight,
        '#1e293b',
        'transit_station'
      );
      meshes.push(steelRib);
    }

    // F. Translucent Canopy Roof Cover (slightly lower/narrower than ribs)
    const roofCenter = [
      center[0] + up[0] * 4.4,
      center[1] + up[1] * 4.4,
      center[2] + up[2] * 4.4
    ] as [number, number, number];

    const canopy = this.generateLocalArch(
      roofCenter,
      up,
      right,
      forward,
      length + 2.0,
      width + 1.8,
      ribArchHeight - 0.2,
      'rgba(56, 189, 248, 0.35)',
      'transit_station'
    );
    meshes.push(canopy);

    return meshes;
  }

  /**
   * Generates a subsurface 3D utility conduit line
   */
  private generateUtilityMesh(utility: UtilityObject): MeshData {
    const coords = utility.coordinates;
    const depth = utility.depth || 3;
    const thickness = 0.5;

    // Utilities are rendered as a subterranean 3D ribbon profile
    const ribbon = this.generateRibbon(coords, -thickness / 2, thickness / 2, -depth, thickness);
    
    let color = '#38bdf8'; // water: blue
    if (utility.utilityType === 'electricity') color = '#eab308'; // electric: yellow
    if (utility.utilityType === 'sewage') color = '#a1a1aa'; // sewage: grey
    if (utility.utilityType === 'fiber') color = '#ec4899'; // fiber: pink

    return {
      positions: new Float64Array(ribbon.positions),
      indices: new Uint32Array(ribbon.indices),
      material: { type: 'solid', color },
      layerId: 'transit_utility'
    };
  }
}
