import type { CityObject } from './types';
import { elevatedLayer } from './bridgeElevation';

/**
 * Height of each road class's surface above its centre line (m). Where roads
 * overlap at a junction the bigger road lies on top: steps are wider than the
 * markings' height (up to 0.025 m), so surfaces never flicker against each
 * other and a smaller road's markings stay under a bigger road's asphalt.
 */
export const ROAD_CLASS_LIFT_M: Record<string, number> = { local: 0, collector: 0.05, arterial: 0.1, highway: 0.15 };

/** How far above its coordinates a road's drawn surface is: 0 for bridges, tunnels and flyovers. */
export function surfaceLiftM(o: CityObject | undefined): number {
  if (!o || o.type !== 'road' || o.osmProvenance?.bridge || o.osmProvenance?.tunnel || elevatedLayer(o) > 0) return 0;
  return ROAD_CLASS_LIFT_M[o.roadClass] ?? 0;
}
