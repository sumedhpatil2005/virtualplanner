/**
 * Where a road the user draws crosses another road: a junction, a grade separation, or "level not known".
 * (docs/TOPOLOGY_RECONSTRUCTION.md)
 *
 * The evidence is what the data holds: OSM `bridge=*`, `tunnel=*` and `layer=*` tags (OSM wiki Key:layer — layer orders
 * crossing features and is not a height; Key:bridge; Key:tunnel), whether the other object is a structure the user drew
 * (flyover, metro flyover), and the heights the model gives each road at the crossing (bridgeElevation: 6.5 m per deck
 * level, ramps at 5 %, all ESTIMATED from the tags, not measured).
 *
 *  - Heights more than GRADE_SEPARATION_M apart: separate (a deck over, a tunnel under). No junction.
 *  - Both untagged ground roads and both within GROUND_M of the ground there: a junction. The crossing is made an
 *    explicit shared vertex of both roads, so objects, graph and junction tools agree.
 *  - Anything else (heights within 3 m but a bridge/tunnel/layer tag on either, a drawn flyover, or a ramp/embankment
 *    height off the ground): the level is not known well enough to guess. The crossing is NOT joined and is recorded on
 *    the new road as `levelCrossings[] { decision: 'unconfirmed' }` for the user to confirm (Confirm junction / Keep
 *    separate, PropertiesPanel). The network builder keeps an unconfirmed or separate crossing apart.
 */
import type { CityObject, RoadObject } from '../objects/types';
import { isOsmBridge, isOsmTunnel } from '../objects/bridgeElevation';

export type CrossingDecision = 'unconfirmed' | 'separate' | 'junction';
export interface LevelCrossing {
  /** The other road or structure. */
  roadId: string;
  /** Plan point of the crossing, with this road's height there. */
  point: [number, number, number];
  /** The other road's height there (m, model estimate). */
  otherZ: number;
  decision: CrossingDecision;
  /** Why the level is uncertain, in words. */
  reason: string;
}

/** Heights further apart than this pass over each other (same as the network builder's GRADE_SEPARATION_M). */
export const GRADE_SEPARATION_M = 3;
/** A road this close to height 0 at the crossing is on the ground. Above it, on a ramp or embankment (chosen; see doc). */
export const GROUND_M = 0.5;
/** A flag applies to a crossing found within this distance of its point (m). */
export const FLAG_MATCH_M = 2;
/** The builder keeps near-miss vertex joins apart within this distance of a held-apart crossing (m, > join tolerance). */
export const FLAG_GUARD_M = 8;

const M = 111320;
export const planDistM = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((b[0] - a[0]) * M * Math.cos((a[1] * Math.PI) / 180), (b[1] - a[1]) * M);

type Line = { id: string; type: string; coordinates: readonly (readonly number[])[]; osmProvenance?: RoadObject['osmProvenance'] };

export function levelEvidence(o: Pick<Line, 'type' | 'osmProvenance'>): 'ground' | 'bridge' | 'tunnel' | 'layer' | 'structure' {
  if (o.type === 'flyover' || o.type === 'metro_flyover') return 'structure';
  const p = o.osmProvenance;
  if (!p) return 'ground';
  if (isOsmBridge(p)) return 'bridge';
  if (isOsmTunnel(p)) return 'tunnel';
  if ((p.layer ?? 0) !== 0) return 'layer';
  return 'ground';
}

const EVIDENCE_WORDS = { bridge: 'is tagged as a bridge in OpenStreetMap', tunnel: 'is tagged as a tunnel or below ground in OpenStreetMap', layer: 'has an OpenStreetMap layer other than 0', structure: 'is a drawn flyover' } as const;

export function classifyCrossing(a: Pick<Line, 'type' | 'osmProvenance' | 'id'>, b: Pick<Line, 'type' | 'osmProvenance' | 'id'> & { name?: string }, za: number, zb: number): { kind: 'junction' | 'separate' | 'uncertain'; reason: string } {
  if (Math.abs(za - zb) > GRADE_SEPARATION_M) return { kind: 'separate', reason: `${Math.abs(za - zb).toFixed(1)} m apart in height` };
  const ea = levelEvidence(a), eb = levelEvidence(b);
  if (eb !== 'ground') return { kind: 'uncertain', reason: `the other road ${EVIDENCE_WORDS[eb]}, but the heights are only ${Math.abs(za - zb).toFixed(1)} m apart` };
  if (ea !== 'ground') return { kind: 'uncertain', reason: `this road ${EVIDENCE_WORDS[ea]}, but the heights are only ${Math.abs(za - zb).toFixed(1)} m apart` };
  if (Math.abs(za) > GROUND_M || Math.abs(zb) > GROUND_M) return { kind: 'uncertain', reason: `one road is ${Math.max(Math.abs(za), Math.abs(zb)).toFixed(1)} m off the ground here (a ramp or embankment, estimated)` };
  return { kind: 'junction', reason: 'both on the ground, no bridge or tunnel tag' };
}

export interface Crossing { otherId: string; point: [number, number, number]; za: number; zb: number; sa: number; ta: number; sb: number; tb: number }

/** Plan crossings of `line` with each of `others`, in the order found. */
export function findCrossings(line: readonly (readonly number[])[], others: readonly Line[]): Crossing[] {
  const out: Crossing[] = [];
  for (const o of others) {
    const b = o.coordinates;
    for (let i = 0; i < line.length - 1; i++) {
      const p = line[i], q = line[i + 1];
      for (let j = 0; j < b.length - 1; j++) {
        const r = b[j], s = b[j + 1];
        const dx = q[0] - p[0], dy = q[1] - p[1], ex = s[0] - r[0], ey = s[1] - r[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-20) continue;
        const t = ((r[0] - p[0]) * ey - (r[1] - p[1]) * ex) / den, u = ((r[0] - p[0]) * dy - (r[1] - p[1]) * dx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const za = (p[2] || 0) + t * ((q[2] || 0) - (p[2] || 0)), zb = (r[2] || 0) + u * ((s[2] || 0) - (r[2] || 0));
        out.push({ otherId: o.id, point: [p[0] + t * dx, p[1] + t * dy, za], za, zb, sa: i, ta: t, sb: j, tb: u });
      }
    }
  }
  return out;
}

/** The decision recorded on either road for a crossing between them near `pt`, or null. */
export function crossingDecision(a: CityObject, b: CityObject, pt: readonly number[]): CrossingDecision | null {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const list = (x as { levelCrossings?: LevelCrossing[] }).levelCrossings;
    if (!list) continue;
    for (const f of list) if (f.roadId === y.id && planDistM(f.point, pt) <= FLAG_MATCH_M) return f.decision;
  }
  return null;
}

/** Held-apart crossings between a and b (unconfirmed or separate), for the builder's guards. */
export function heldApartPoints(a: CityObject, b: CityObject): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const list = (x as { levelCrossings?: LevelCrossing[] }).levelCrossings;
    if (list) for (const f of list) if (f.roadId === y.id && f.decision !== 'junction') out.push(f.point);
  }
  return out;
}
