/**
 * 3D display of underground alignments and imported subsurface records (docs/urbanos/UNDERGROUND_WORKSPACE.md §3).
 * Uses Cesium entities in its own CustomDataSource:
 * - an alignment is a polylineVolume (circle or box of the entered size) whose centreline sits at
 *   −(crown depth + height/2) below the ground datum. Runs of vertices with UNKNOWN depth are not placed below ground:
 *   they are a dashed line on the surface ("depth UNKNOWN"). An UNKNOWN section size is a plain line at crown depth.
 *   Hypothetical values are drawn paler than estimated / measured ones.
 * - subsurface utility records: a line at −depth when the depth is known, else dashed on the surface;
 *   boreholes: a vertical line from ground to the final depth (or a short stub when it is UNKNOWN).
 * The first entity of an alignment carries the object's id, so clicking it selects the object like any other.
 */
import {
  Cartesian2, Color, ColorMaterialProperty, CornerType, CustomDataSource, PolylineDashMaterialProperty, type Entity, type Viewer,
} from 'cesium';
import { scenePoint } from '../terrain/groundHeight';
import type { Certainty } from '../objects/certainty';
import type { UndergroundAlignmentKind, UndergroundAlignmentObject } from '../objects/types';
import { depthsOf, sectionHeightM, sectionWidthM } from './alignmentGeometry';
import type { SubsurfaceRecord } from '../../lib/coordinationApi';

const KIND_COLOR: Record<UndergroundAlignmentKind, string> = {
  bored_tunnel: '#f59e0b', underground_metro: '#a855f7', cut_and_cover: '#f97316', utility_trunk: '#22d3ee', storm_drain: '#22c55e',
};
const ALPHA: Record<Certainty, number> = { measured: 0.95, estimated: 0.8, hypothetical: 0.55, unknown: 0.35 };

function circleShape(r: number, n = 20): Cartesian2[] {
  return Array.from({ length: n }, (_, i) => new Cartesian2(r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)));
}
function boxShape(w: number, h: number): Cartesian2[] {
  return [new Cartesian2(-w / 2, -h / 2), new Cartesian2(w / 2, -h / 2), new Cartesian2(w / 2, h / 2), new Cartesian2(-w / 2, h / 2)];
}

/** Consecutive vertex runs whose depth is known (≥2 vertices) and the spans between them that are UNKNOWN. */
export function depthRuns(a: UndergroundAlignmentObject): { known: number[][]; unknown: number[][] } {
  const ds = depthsOf(a);
  const known: number[][] = [], unknown: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < ds.length; i++) {
    if (ds[i].crownDepthM !== null) run.push(i);
    else { if (run.length >= 2) known.push(run); run = []; }
  }
  if (run.length >= 2) known.push(run);
  // a segment is unknown when either end is unknown
  for (let i = 1; i < ds.length; i++) {
    if (ds[i - 1].crownDepthM === null || ds[i].crownDepthM === null) {
      const last = unknown[unknown.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i); else unknown.push([i - 1, i]);
    }
  }
  return { known, unknown };
}

export class UndergroundRenderer {
  private ds: CustomDataSource | null = null;
  private viewer: Viewer | null = null;
  private recordsDs: CustomDataSource | null = null;

  attach(viewer: Viewer | null) {
    if (!viewer || this.viewer === viewer) return;
    this.viewer = viewer;
    this.ds = new CustomDataSource('underground-alignments');
    this.recordsDs = new CustomDataSource('subsurface-records');
    void viewer.dataSources.add(this.ds);
    void viewer.dataSources.add(this.recordsDs);
  }

  isAttached() { return !!this.viewer && !this.viewer.isDestroyed(); }

  renderAlignments(alignments: UndergroundAlignmentObject[], selectedId: string | null) {
    if (!this.ds || !this.isAttached()) return;
    const ents = this.ds.entities;
    ents.suspendEvents();
    ents.removeAll();
    for (const a of alignments) this.addAlignment(ents, a, a.id === selectedId);
    ents.resumeEvents();
    this.viewer?.scene.requestRender();
  }

  private addAlignment(ents: CustomDataSource['entities'], a: UndergroundAlignmentObject, selected: boolean) {
    const ds = depthsOf(a);
    const h = sectionHeightM(a.section), w = sectionWidthM(a.section);
    const base = Color.fromCssColorString(KIND_COLOR[a.alignmentKind] ?? '#f59e0b');
    const { known, unknown } = depthRuns(a);
    let first = true;
    const nextId = (suffix: string) => { if (first) { first = false; return a.id; } return `ug:${a.id}:${suffix}`; };
    known.forEach((run, k) => {
      const cert = run.reduce<Certainty>((worst, i) => (ALPHA[ds[i].certainty] < ALPHA[worst] ? ds[i].certainty : worst), 'measured');
      const color = base.withAlpha(selected ? Math.min(1, ALPHA[cert] + 0.25) : ALPHA[cert]);
      if (h !== null && w !== null) {
        const positions = run.map(i => scenePoint(a.coordinates[i][0], a.coordinates[i][1], -((ds[i].crownDepthM as number) + h / 2)));
        ents.add({
          id: nextId(`run${k}`), name: a.name,
          polylineVolume: {
            positions, shape: a.section.shape === 'circular' ? circleShape(w / 2) : boxShape(w, h), cornerType: CornerType.MITERED,
            material: new ColorMaterialProperty(color), outline: selected, outlineColor: Color.WHITE,
          },
        } as Entity.ConstructorOptions);
      } else {
        // Section size UNKNOWN: a centreline at crown depth only
        const positions = run.map(i => scenePoint(a.coordinates[i][0], a.coordinates[i][1], -(ds[i].crownDepthM as number)));
        ents.add({ id: nextId(`line${k}`), name: a.name, polyline: { positions, width: selected ? 6 : 4, material: new PolylineDashMaterialProperty({ color, dashLength: 10 }) } });
      }
    });
    unknown.forEach((span, k) => {
      ents.add({
        id: nextId(`unk${k}`), name: `${a.name} (depth UNKNOWN)`,
        polyline: {
          positions: span.map(i => scenePoint(a.coordinates[i][0], a.coordinates[i][1], 0)), width: 3, clampToGround: true,
          material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString('#94a3b8'), dashLength: 8 }),
        },
      });
    });
    // Plan trace on the surface so the alignment can be found and clicked from above
    ents.add({
      id: nextId('plan'), name: a.name,
      polyline: { positions: a.coordinates.map(c => scenePoint(c[0], c[1], 0)), width: selected ? 3 : 2, clampToGround: true, material: base.withAlpha(0.5) },
    });
  }

  renderRecords(records: SubsurfaceRecord[]) {
    if (!this.recordsDs || !this.isAttached()) return;
    const ents = this.recordsDs.entities;
    ents.suspendEvents();
    ents.removeAll();
    for (const r of records) {
      const g = r.geometry;
      if (!g) continue;
      if (r.record_type === 'borehole' && g.type === 'Point') {
        const [x, y] = g.coordinates;
        const depth = r.final_depth_m;
        ents.add({
          id: `rec:${r.id}`, name: `Borehole ${r.external_id}`,
          polyline: {
            positions: [scenePoint(x, y, 0), scenePoint(x, y, -(depth ?? 1))], width: 4,
            material: depth === null ? new PolylineDashMaterialProperty({ color: Color.fromCssColorString('#94a3b8') }) : Color.fromCssColorString('#eab308'),
          },
        });
      } else if (g.type === 'LineString') {
        const d = r.depth_m;
        const color = Color.fromCssColorString('#38bdf8').withAlpha(r.z_certainty === 'measured' ? 0.95 : 0.7);
        ents.add({
          id: `rec:${r.id}`, name: `${r.utility_type ?? 'Utility'} record ${r.external_id}`,
          polyline: d === null
            ? { positions: g.coordinates.map(c => scenePoint(c[0], c[1], 0)), width: 3, clampToGround: true, material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString('#94a3b8') }) }
            : { positions: g.coordinates.map(c => scenePoint(c[0], c[1], -d)), width: 4, material: color },
        });
      }
    }
    ents.resumeEvents();
    this.viewer?.scene.requestRender();
  }
}

export const undergroundRenderer = new UndergroundRenderer();
