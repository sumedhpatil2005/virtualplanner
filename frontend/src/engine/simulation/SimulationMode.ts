import type { Viewer } from 'cesium';
import {
  StudyAreaExplorer,
  clampRangeM,
  boundsOf,
  type Bounds,
  type DrivableObject,
  type StudyArea,
  type StudyDirection,
} from './StudyAreaExplorer';
import { roadTilesAround } from './osmCoverage';
import { cacheGetMany, cachePutMany } from '../storage/localCache';
import { OverpassCancelledError } from '../editing/OverpassClient';
import { StudyAreaVisualizer } from '../rendering/renderers/StudyAreaVisualizer';
import { MicroTrafficVisualizer } from '../rendering/renderers/MicroTrafficVisualizer';
import { TrafficMicroSim, STEP_S, type MicroSimMetrics } from './TrafficMicroSim';
import type { TrafficSignalSource, SignalPoint } from './trafficSignals';

export type TrafficStatus = 'idle' | 'running' | 'paused';

export interface TrafficRunState {
  status: TrafficStatus;
  /** Simulated seconds per real second. */
  speed: number;
  /** Demand at the area edge as a share of the entering roads' capacity. */
  demandLevel: number;
  /** Send extra traffic through the selected roads, so they are the centre of the study. */
  focus: boolean;
  seed: number;
  metrics: MicroSimMetrics | null;
  error: string | null;
}

export const TRAFFIC_SPEEDS = [1, 5, 20] as const;
/** Traffic volume presets, as a share of the capacity of the roads leading into the area. */
export const TRAFFIC_LEVELS = [
  { label: 'Light', value: 0.05 },
  { label: 'Normal', value: 0.12 },
  { label: 'Heavy', value: 0.25 },
] as const;
export const DEFAULT_DEMAND_LEVEL = 0.12;
/**
 * With focus on, the selected roads carry extra through traffic: this many
 * times the volume level, as a share of their capacity (Light 20%, Normal 48%,
 * Heavy 100%), on top of the traffic that uses them by itself.
 */
export const FOCUS_LOAD_PER_LEVEL = 4;
export const focusLoadFor = (traffic: Pick<TrafficRunState, 'focus' | 'demandLevel'>) =>
  traffic.focus ? traffic.demandLevel * FOCUS_LOAD_PER_LEVEL : 0;
export const DEFAULT_TRAFFIC_SEED = 42;
/** Distances offered for the study area, along the roads. */
export const STUDY_DISTANCES_M = [500, 1000, 2000, 3000, 5000] as const;
export const DEFAULT_STUDY_DISTANCE_M = 2000;

/** Loading OpenStreetMap roads for the part of a study area the project holds none for. */
export interface OsmRoadsState {
  status: 'idle' | 'loading' | 'error';
  /** Roads added by the last load, or null before one finishes. */
  added: number | null;
  error: string | null;
}

/** Where study areas get OSM roads the project does not hold yet. */
export interface OsmRoadSource {
  /** Makes the project hold every OSM road in `boxes` (fetching only missing ones); resolves to the number added. */
  load: (boxes: Bounds[], signal: AbortSignal) => Promise<number>;
}

/** Each map tile is checked against OpenStreetMap again after this long, for roads added there since. */
const ROAD_TILE_RECHECK_MS = 14 * 24 * 3600 * 1000;

/** Real traffic signals for the study area, from OpenStreetMap. */
export interface SignalsState {
  status: 'off' | 'loading' | 'ready' | 'error';
  /** Mapped signals in the area, once loaded. */
  count: number | null;
}

export interface SimulationModeState {
  active: boolean;
  seedRoadIds: string[];
  rangeMeters: number;
  direction: StudyDirection;
  area: StudyArea | null;
  error: string | null;
  traffic: TrafficRunState;
  osmRoads: OsmRoadsState;
  signals: SignalsState;
}

/** Wait after a road edit before re-mapping, so a burst of changes maps once. */
const NETWORK_CHANGE_DEBOUNCE_MS = 250;
/** How often live figures reach the UI, and how often road stretches are recoloured (real ms). */
const METRICS_EVERY_MS = 500;
const RECOLOUR_EVERY_MS = 1000;
/** Most simulation steps run in one frame; beyond this the run falls behind real time rather than freezing. */
const MAX_STEPS_PER_FRAME = 200;

/**
 * State of Simulation mode: which roads the study area grows from, how far,
 * and the resulting area. The road network is read-only while this is active;
 * TwinCityEngine enforces that when entering and leaving.
 */
export class SimulationMode {
  private state: SimulationModeState = {
    active: false,
    seedRoadIds: [],
    rangeMeters: DEFAULT_STUDY_DISTANCE_M,
    direction: 'both',
    area: null,
    error: null,
    traffic: { status: 'idle', speed: 1, demandLevel: DEFAULT_DEMAND_LEVEL, focus: true, seed: DEFAULT_TRAFFIC_SEED, metrics: null, error: null },
    osmRoads: { status: 'idle', added: null, error: null },
    signals: { status: 'off', count: null },
  };
  private readonly signalSource: TrafficSignalSource | null;
  private signalLoad: AbortController | null = null;
  /** Signals for `signalBoundsKey`, or null to estimate them. */
  private signalPoints: SignalPoint[] | null = null;
  private signalBoundsKey = '';
  private osmLoad: AbortController | null = null;
  /** Map tiles already checked this session (or being checked); not again until the user retries. */
  private triedOsmLoads = new Set<string>();
  private listeners = new Set<() => void>();
  private readonly explorer = new StudyAreaExplorer();
  private readonly visualizer = new StudyAreaVisualizer();
  /** Bumped on every road or scenario change; the explorer rebuilds its graph when it moves. */
  private revision = 0;
  private recomputeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly trafficVisualizer = new MicroTrafficVisualizer();
  private sim: TrafficMicroSim | null = null;
  private frameHandle: number | null = null;
  private lastFrameAt = 0;
  private stepDebt = 0;
  private lastMetricsAt = 0;
  private lastRecolourAt = 0;
  /**
   * Traffic starts by itself once a road is picked and its area is mapped,
   * and again after the area re-maps. Pausing turns this off until resumed.
   */
  private autoRun = false;

  private readonly getRoads: () => DrivableObject[];
  private readonly osmSource: OsmRoadSource | null;

  constructor(getRoads: () => DrivableObject[], osmSource: OsmRoadSource | null = null, signalSource: TrafficSignalSource | null = null) {
    this.getRoads = getRoads;
    this.osmSource = osmSource;
    this.signalSource = signalSource;
  }

  /** For React's useSyncExternalStore. */
  public subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };

  public getState = (): SimulationModeState => this.state;

  private setState(patch: Partial<SimulationModeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(cb => cb());
  }

  public isActive(): boolean {
    return this.state.active;
  }

  public setViewer(viewer: Viewer) {
    this.visualizer.setViewer(viewer);
    this.trafficVisualizer.setViewer(viewer);
    if (this.state.active && this.state.area) this.visualizer.render(this.state.area, false);
  }

  public dispose() {
    this.osmLoad?.abort();
    this.signalLoad?.abort();
    this.cancelPendingRecompute();
    this.resetTraffic();
    this.visualizer.dispose();
    this.trafficVisualizer.dispose();
  }

  public enter() {
    if (this.state.active) return;
    this.setState({ active: true });
    this.visualizer.setFocus(true);
    // Coming back to a previous study area: show it again against the current network
    if (this.state.seedRoadIds.length > 0) this.recompute(false, false);
  }

  public exit() {
    if (!this.state.active) return;
    this.cancelPendingRecompute();
    this.resetTraffic();
    this.visualizer.clear();
    this.visualizer.setFocus(false);
    this.setState({ active: false });
  }

  /** The drivable road under or near a clicked ground point. */
  public pickRoadAt(lng: number, lat: number, maxDistM: number): string | null {
    return this.explorer.nearestRoad(this.getRoads(), this.revision, lng, lat, maxDistM);
  }

  /**
   * A road was clicked. Plain click maps the area within the chosen distance
   * of it and starts traffic; with `additive` (Shift) the road is added to, or
   * removed from, the roads being studied.
   */
  public selectRoad(roadId: string, additive: boolean) {
    this.autoRun = true;
    if (!additive) {
      this.setState({ seedRoadIds: [roadId] });
      this.forgetOsmResult();
      this.recompute(true, true);
      return;
    }
    const seeds = this.state.seedRoadIds.includes(roadId)
      ? this.state.seedRoadIds.filter(id => id !== roadId)
      : [...this.state.seedRoadIds, roadId];
    if (seeds.length === 0) {
      this.clearSeeds();
      return;
    }
    this.setState({ seedRoadIds: seeds });
    this.recompute(false, false);
  }

  public clearSeeds() {
    this.autoRun = false;
    this.cancelPendingRecompute();
    this.resetTraffic();
    this.visualizer.clear();
    this.setState({ seedRoadIds: [], area: null, error: null });
    this.forgetOsmResult();
  }

  /** A finished load's message belongs to the area it was for. */
  private forgetOsmResult() {
    if (this.state.osmRoads.status !== 'loading') this.setState({ osmRoads: { status: 'idle', added: null, error: null } });
  }

  public setRange(meters: number) {
    const rangeMeters = clampRangeM(meters);
    if (rangeMeters === this.state.rangeMeters) return;
    this.setState({ rangeMeters });
    if (this.state.seedRoadIds.length > 0) {
      this.autoRun = true;
      this.recompute(true, false);
    }
  }

  public setDirection(direction: StudyDirection) {
    this.setState({ direction });
    if (this.state.seedRoadIds.length > 0) this.recompute(false, false);
  }

  /** Roads changed or the scenario switched. Re-maps the current area shortly after. */
  public networkChanged() {
    this.revision++;
    if (!this.state.active || this.state.seedRoadIds.length === 0) return;
    this.cancelPendingRecompute();
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null;
      this.recompute(false, false);
    }, NETWORK_CHANGE_DEBOUNCE_MS);
  }

  public fitView() {
    if (this.state.area) this.visualizer.flyToBounds(this.state.area.bounds);
  }

  /** Brings the camera in close on the selected roads. */
  public focusView() {
    const seeds = new Set(this.state.seedRoadIds);
    this.visualizer.flyToRoad(this.getRoads().filter(r => seeds.has(r.id)).flatMap(r => r.coordinates));
  }

  public flyTo(location: [number, number, number]) {
    this.visualizer.flyToPoint(location);
  }

  public flyToBounds(bounds: Bounds) {
    this.visualizer.flyToBounds(bounds);
  }

  private recompute(fly: boolean, reveal: boolean) {
    if (!this.state.active) return;
    // A run belongs to one area and network: any change starts over
    this.resetTraffic();
    try {
      const area = this.explorer.explore(this.getRoads(), this.revision, {
        seedRoadIds: this.state.seedRoadIds,
        rangeMeters: this.state.rangeMeters,
        direction: this.state.direction,
      });
      // Seeds deleted from the network drop out here
      this.setState({ area, error: null, seedRoadIds: area.seedRoadIds });
      this.visualizer.render(area, reveal);
      // The selected road is the subject: the camera goes to it, not the whole area
      if (fly) this.focusView();
    } catch (err: any) {
      this.visualizer.clear();
      this.setState({ area: null, error: err?.message || String(err) });
    }
    this.ensureOsmRoads();
    this.ensureSignals();
    this.maybeAutoStart();
  }

  /** Starts traffic when a road has been picked and its area is fully mapped. */
  private maybeAutoStart() {
    if (!this.autoRun || !this.state.area || this.state.traffic.status !== 'idle') return;
    if (this.osmLoad) return; // roads still arriving; the area re-maps when they do
    if (this.signalLoad) return; // starts when the signals are in
    this.startTraffic();
  }

  // ── Real traffic signals ──────────────────────────────────────────────────

  /** Loads the mapped traffic signals for the current area (cached on this device after the first time). */
  private ensureSignals() {
    const source = this.signalSource;
    const area = this.state.area;
    if (!source || !area) return;
    const b = area.bounds;
    const key = [b.minLng, b.minLat, b.maxLng, b.maxLat].map(v => v.toFixed(4)).join(',');
    if (key === this.signalBoundsKey) return;
    this.signalLoad?.abort();
    this.signalBoundsKey = key;
    this.signalPoints = null;
    const load = (this.signalLoad = new AbortController());
    this.setState({ signals: { status: 'loading', count: null } });
    source
      .signalsIn(b, load.signal)
      .then(points => {
        if (load !== this.signalLoad) return;
        this.signalPoints = points;
        this.setState({ signals: { status: 'ready', count: points.length } });
      })
      .catch(() => {
        if (load !== this.signalLoad) return;
        // Signals are then estimated from the road classes; try again next time the area changes
        this.signalBoundsKey = '';
        this.setState({ signals: { status: 'error', count: null } });
      })
      .finally(() => {
        if (load !== this.signalLoad) return;
        this.signalLoad = null;
        // A run that started on estimated signals is restarted on the real ones
        if (this.signalPoints && this.state.traffic.status === 'running') this.restartTraffic();
        else this.maybeAutoStart();
      });
  }

  // ── OpenStreetMap roads around the study area ─────────────────────────────

  /**
   * Checks the map tiles within range of the selected roads against
   * OpenStreetMap and loads every road the project is missing there, so the
   * study runs on all the roads that exist, not just those imported earlier.
   * A tile is checked once a fortnight per device; added roads are part of
   * the network, so the area re-maps with them.
   */
  private ensureOsmRoads() {
    const source = this.osmSource;
    if (!source || this.osmLoad || !this.state.active) return;
    const seeds = this.getRoads().filter(r => this.state.seedRoadIds.includes(r.id));
    if (seeds.length === 0) return;
    const tiles = roadTilesAround(boundsOf(seeds.flatMap(r => r.coordinates)), this.state.rangeMeters).filter(t => !this.triedOsmLoads.has(t.key));
    if (tiles.length === 0) return;
    for (const t of tiles) this.triedOsmLoads.add(t.key);

    const load = (this.osmLoad = new AbortController());
    cacheGetMany<{ checkedAt: number }>('osm-road-tiles', tiles.map(t => t.key))
      .then(checked => {
        const due = tiles.filter((_, i) => !checked[i] || Date.now() - checked[i]!.checkedAt > ROAD_TILE_RECHECK_MS);
        if (due.length === 0 || load.signal.aborted) return null;
        this.setState({ osmRoads: { status: 'loading', added: null, error: null } });
        return source.load(due.map(t => t.box), load.signal).then(added => {
          const now = Date.now();
          void cachePutMany('osm-road-tiles', due.map(t => [t.key, { checkedAt: now }]));
          return added;
        });
      })
      .then(added => {
        if (added !== null) this.setState({ osmRoads: { status: 'idle', added, error: null } });
      })
      .catch(err => {
        const error = err instanceof OverpassCancelledError ? 'Loading was cancelled.' : err?.message || String(err);
        this.setState({ osmRoads: { status: 'error', added: null, error } });
      })
      .finally(() => {
        this.osmLoad = null;
        // The range may have grown meanwhile
        this.ensureOsmRoads();
        // New roads re-map the area (which starts traffic); otherwise run on what there is
        if (!this.recomputeTimer) this.maybeAutoStart();
      });
  }

  /** Tries again after a failed OSM road load. */
  public retryOsmRoads() {
    this.triedOsmLoads.clear();
    this.ensureOsmRoads();
  }

  public cancelOsmRoads() {
    this.osmLoad?.abort();
  }

  // ── Live traffic ────────────────────────────────────────────────────────────

  private setTraffic(patch: Partial<TrafficRunState>) {
    this.setState({ traffic: { ...this.state.traffic, ...patch } });
  }

  /** Starts traffic on the current study area. */
  public startTraffic() {
    const area = this.state.area;
    if (!area || this.state.traffic.status !== 'idle') return;
    const roads = new Map(this.getRoads().map(r => [r.id, r]));
    const sim = new TrafficMicroSim(area, roads, {
      demandLevel: this.state.traffic.demandLevel,
      seed: this.state.traffic.seed,
      watchRoadIds: area.seedRoadIds,
      focusLoad: focusLoadFor(this.state.traffic),
      signalPoints: this.signalPoints ?? undefined,
    });
    const metrics = sim.getMetrics();
    if (metrics.entries === 0 || metrics.exits < 2) {
      this.setTraffic({
        error: metrics.entries === 0
          ? 'No road leads into this area, so no traffic can enter. Increase the range.'
          : 'Traffic needs a way out other than the way in. Increase the range.',
      });
      return;
    }
    this.sim = sim;
    this.visualizer.setMarkersVisible(false);
    this.setTraffic({ status: 'running', metrics, error: null });
    this.startLoop();
  }

  public pauseTraffic() {
    if (this.state.traffic.status !== 'running') return;
    this.autoRun = false;
    this.stopLoop();
    this.setTraffic({ status: 'paused', metrics: this.sim?.getMetrics() ?? null });
  }

  public resumeTraffic() {
    if (this.state.traffic.status !== 'paused') return;
    this.autoRun = true;
    this.setTraffic({ status: 'running' });
    this.startLoop();
  }

  /** Stops the run, removes the vehicles and restores the area's colours. */
  public resetTraffic() {
    const wasRunning = this.sim !== null;
    this.stopLoop();
    this.sim = null;
    this.trafficVisualizer.clear();
    this.visualizer.setMarkersVisible(true);
    if (wasRunning && this.state.area) this.visualizer.render(this.state.area, false);
    if (this.state.traffic.status !== 'idle' || this.state.traffic.metrics || this.state.traffic.error) {
      this.setTraffic({ status: 'idle', metrics: null, error: null });
    }
  }

  /** Clears the vehicles and starts again from an empty network. */
  public restartTraffic() {
    this.autoRun = true;
    this.resetTraffic();
    this.startTraffic();
  }

  public setTrafficSpeed(speed: number) {
    this.setTraffic({ speed });
  }

  public setDemandLevel(level: number) {
    const demandLevel = Math.max(0, Math.min(1, level));
    this.sim?.setDemandLevel(demandLevel);
    this.sim?.setFocusLoad(focusLoadFor({ focus: this.state.traffic.focus, demandLevel }));
    this.setTraffic({ demandLevel, metrics: this.sim?.getMetrics() ?? this.state.traffic.metrics });
  }

  /** Turns the extra through traffic on the selected roads on or off. */
  public setFocus(focus: boolean) {
    this.sim?.setFocusLoad(focusLoadFor({ focus, demandLevel: this.state.traffic.demandLevel }));
    this.setTraffic({ focus, metrics: this.sim?.getMetrics() ?? this.state.traffic.metrics });
  }

  private startLoop() {
    this.stopLoop();
    this.lastFrameAt = performance.now();
    this.stepDebt = 0;
    const frame = (now: number) => {
      const sim = this.sim;
      if (!sim) return;
      // Clamp long gaps (a background tab) instead of simulating them all at once
      const realDt = Math.min(0.25, (now - this.lastFrameAt) / 1000);
      this.lastFrameAt = now;
      const simDt = realDt * this.state.traffic.speed;
      this.stepDebt += simDt;
      let steps = Math.floor(this.stepDebt / STEP_S);
      this.stepDebt -= steps * STEP_S;
      if (steps > MAX_STEPS_PER_FRAME) {
        steps = MAX_STEPS_PER_FRAME;
        this.stepDebt = 0;
      }
      for (let i = 0; i < steps; i++) sim.step();
      // Drawn between steps too: vehicles carry on by the time since the last one
      this.trafficVisualizer.draw(sim, this.stepDebt, simDt);
      if (now - this.lastRecolourAt > RECOLOUR_EVERY_MS) {
        this.lastRecolourAt = now;
        this.visualizer.setSegmentSpeeds(sim.segmentSpeedRatios());
      }
      if (now - this.lastMetricsAt > METRICS_EVERY_MS) {
        this.lastMetricsAt = now;
        this.setTraffic({ metrics: sim.getMetrics() });
      }
      this.frameHandle = requestAnimationFrame(frame);
    };
    this.frameHandle = requestAnimationFrame(frame);
  }

  private stopLoop() {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private cancelPendingRecompute() {
    if (this.recomputeTimer) {
      clearTimeout(this.recomputeTimer);
      this.recomputeTimer = null;
    }
  }
}
