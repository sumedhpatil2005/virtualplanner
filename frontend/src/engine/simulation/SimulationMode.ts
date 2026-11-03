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
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, type MicroSimMetrics, type VehicleView } from './TrafficMicroSim';
import type { TrafficSignalSource, SignalPoint } from './trafficSignals';
import { snapDemandPlan, contentKey, demandContextKey, type SimulationContext, type DemandPlan, type DemandProvenance } from './StudyDemand';
export type { SimulationContext } from './StudyDemand';
import { fetchCountDataset, DEFAULT_COUNT_DATASET, type CountDataset } from '../calibration/observedCounts';
import { apiGet } from '../../lib/api';
import { applyNetworkCorrections, validateCorrectionLayer, type NetworkCorrectionLayer, type CorrectionReport } from './networkCorrections';
import { fitPlan, measureFlows, compareRows, summarize, junctionsIn, zoneFor, junctionChecks, observedFlows, type CalibrationRow, type JunctionCheck, type SimSetup } from '../calibration/calibration';
import { gehAgainst } from '../calibration/ipf';
import type { GehSummary } from '../calibration/geh';
import { fetchDiurnalProfile, hourFactor, COUNT_HOURS, type DiurnalProfile, type DayType } from './timeOfDay';
import { compileAreaDemand } from './AreaDemand';
import { roadSection, type RoadSection } from './roadSection';
import { startAnalysisJob, type RunningAnalysis } from './analysisRunner';
import { DEFAULT_ANALYSIS, type AnalysisJob, type AnalysisOutput } from './analysisJob';
import { compareAnalyses, type ComparisonResult } from './ScenarioComparison';

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
  demand: DemandProvenance | null;
}

export interface TrafficRunSnapshot {
  scenarioId: string;
  durationS: number;
  seed: number;
  demandLevel: number;
  focus: boolean;
  /** Clock hour and demand multiplier the run used. */
  hour: number;
  hourFactor: number;
  demandKey: string;
  networkKey: string;
  metrics: MicroSimMetrics;
  /** Planned demand (veh/h at the run's hour) and the road analysis of the run. */
  demandVph: number;
  analysis: AnalysisOutput;
}
export interface TrafficComparisonState {
  baseline: TrafficRunSnapshot | null;
  current: TrafficRunSnapshot | null;
  /** Existing city (baseline) against the proposal (current), same frozen demand. */
  result: ComparisonResult | null;
  staleReason: string | null;
  running: boolean;
  progress: number;
  /** The land use (and so the demand) differs from the baseline's: a development scenario. */
  demandChanged: boolean;
}

/** Road analysis of the selected section, from a fixed repeatable run. */
export interface RoadAnalysisState {
  status: 'idle' | 'running' | 'ready' | 'error';
  progress: number;
  output: AnalysisOutput | null;
  error: string | null;
  /** Settings the result is for (hour, demand options); a change re-runs it. */
  hour: number | null;
  demandVph: number | null;
}

/** Demand options the user can change. */
export interface DemandSettings {
  /** Include traffic crossing the area on its main roads (default on). */
  through: boolean;
  /** Hypothetical demand multiplier (null = the estimate as is). Always labelled hypothetical. */
  hypotheticalScale: number | null;
}

export const TRAFFIC_SPEEDS = [1, 5, 20] as const;
/** Traffic volume presets, as a share of the capacity of the roads leading into the area. */
export const TRAFFIC_LEVELS = [
  { label: 'Light', value: 0.05 },
  { label: 'Normal', value: 0.12 },
  { label: 'Heavy', value: 0.25 },
] as const;
export const DEFAULT_DEMAND_LEVEL = OD_REFERENCE_LEVEL;
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

/** Calibration of the study area's demand against observed junction counts. */
export interface CalibrationState {
  datasetStatus: 'idle' | 'loading' | 'ready' | 'error';
  dataset: CountDataset | null;
  datasetError: string | null;
  /** Counted junctions inside the study area, with any reason they cannot be compared. */
  junctions: JunctionCheck[];
  rows: CalibrationRow[];
  before: GehSummary | null;
  after: GehSummary | null;
  fit: {
    iterations: number; converged: boolean; cappedTrips: number; seeds: number; seedVph: number; unreachable: number;
    factorMin: number; factorMax: number; assignedBefore: GehSummary; assignedAfter: GehSummary; demandLevel: number;
  } | null;
  status: 'idle' | 'measuring' | 'fitting' | 'error';
  progress: number;
  error: string | null;
  /** Live traffic runs on the calibrated demand. */
  applied: boolean;
  /** Simulated seconds counted per run (after the warm-up). */
  windowS: number | null;
  /** Network state at the end of each counted run, to explain low simulated flows (queues, gridlock). */
  runMetrics: { before: MicroSimMetrics | null; after: MicroSimMetrics | null };
  staleReason: string | null;
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
  comparison: TrafficComparisonState;
  selectedVehicleId: number | null;
  calibration: CalibrationState;
  timeOfDay: TimeOfDayState;
  /** The road section the click stands for (both carriageways, between main junctions). */
  section: RoadSection | null;
  analysis: RoadAnalysisState;
  demandSettings: DemandSettings;
}

/** Clock for the run: which hour's demand is simulated, from the real Pune hour-of-day profile. */
export interface TimeOfDayState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  profile: DiurnalProfile | null;
  /** Clock hour simulated (0-23). */
  hour: number;
  day: DayType;
  /** Which peak the observed counts (and calibrated demand) are taken to be: neither source says. */
  countPeak: 'AM' | 'PM';
  /** 24-hour playback: the clock advances one hour every PLAYBACK_S_PER_HOUR simulated seconds. */
  playback: boolean;
  /** Demand multiplier now applied: profile[hour] / profile[count hour]. */
  factor: number;
}
/** Simulated seconds per clock hour during 24-hour playback (a full day in 24 minutes of simulation). */
export const PLAYBACK_S_PER_HOUR = 60;

const EMPTY_CALIBRATION: CalibrationState = {
  datasetStatus: 'idle', dataset: null, datasetError: null, junctions: [], rows: [], before: null, after: null, fit: null,
  status: 'idle', progress: 0, error: null, applied: false, windowS: null, staleReason: null, runMetrics: { before: null, after: null },
};

/** Wait after a road edit before re-mapping, so a burst of changes maps once. */
export const DEFAULT_CORRECTION_LAYER = 'pune_west_v1';
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
/** Demand period of a counted peak hour (the counts' AM or PM peak, as the user sets it). */
export const countPeakPeriod = (peak: 'AM' | 'PM'): 'AM_Peak' | 'PM_Peak' => (peak === 'PM' ? 'PM_Peak' : 'AM_Peak');

export class SimulationMode {
  private state: SimulationModeState = {
    active: false,
    seedRoadIds: [],
    rangeMeters: DEFAULT_STUDY_DISTANCE_M,
    direction: 'both',
    area: null,
    error: null,
    traffic: { status: 'idle', speed: 1, demandLevel: DEFAULT_DEMAND_LEVEL, focus: false, seed: DEFAULT_TRAFFIC_SEED, metrics: null, error: null, demand: null },
    osmRoads: { status: 'idle', added: null, error: null },
    signals: { status: 'off', count: null },
    comparison: { baseline: null, current: null, result: null, staleReason: null, running: false, progress: 0, demandChanged: false },
    selectedVehicleId: null,
    calibration: EMPTY_CALIBRATION,
    timeOfDay: { status: 'idle', error: null, profile: null, hour: COUNT_HOURS.PM, day: 'weekday', countPeak: 'PM', playback: false, factor: 1 },
    section: null,
    analysis: { status: 'idle', progress: 0, output: null, error: null, hour: null, demandVph: null },
    demandSettings: { through: true, hypotheticalScale: null },
  };
  private analysisRun: RunningAnalysis | null = null;
  private analysisTimer: ReturnType<typeof setTimeout> | null = null;
  private comparisonRun: RunningAnalysis | null = null;
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
  private readonly getContext: () => SimulationContext;
  private baselinePlan: DemandPlan | null = null;
  private baselineContextKey = '';
  private baselineStudyKey = '';
  private comparisonGeneration = 0;
  /** Demand fitted to observed counts; used by live traffic while set. */
  private calibratedPlan: DemandPlan | null = null;
  private calibrationGeneration = 0;
  private readonly loadCounts: () => Promise<CountDataset>;

  /** Local OSM correction layer (backend/data/network_corrections) and whether it is applied. */
  private correctionLayer: NetworkCorrectionLayer | null = null;
  private correctionsEnabled = true;
  private lastCorrectionReport: CorrectionReport | null = null;
  /** Signal plans: Webster from critical flows, or the earlier equal split. */
  private signalTiming: 'webster' | 'equal' = 'webster';

  constructor(getRoads: () => DrivableObject[], osmSource: OsmRoadSource | null = null, signalSource: TrafficSignalSource | null = null, getContext: () => SimulationContext = () => ({}),
    loadCounts: () => Promise<CountDataset> = () => fetchCountDataset(DEFAULT_COUNT_DATASET),
    loadCorrections: (() => Promise<unknown>) | null = () => apiGet<unknown>(`/api/network-corrections/${DEFAULT_CORRECTION_LAYER}`)) {
    this.loadCounts = loadCounts;
    // Roads for the simulation: the project's roads with the correction layer (and the OSM
    // one-way implications) applied on top; the stored roads are never changed
    this.getRoads = () => {
      const { roads, report } = applyNetworkCorrections(getRoads(), this.correctionLayer, this.correctionsEnabled);
      this.lastCorrectionReport = report;
      return roads;
    };
    loadCorrections?.().then(doc => {
      this.correctionLayer = validateCorrectionLayer(doc);
      this.networkChanged();
      this.notify();
    }).catch(() => { /* no layer: OSM as imported */ });
    this.osmSource = osmSource;
    this.signalSource = signalSource;
    this.getContext = getContext;
  }

  /** For React's useSyncExternalStore. */
  public subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };

  public getState = (): SimulationModeState => this.state;

  /** New snapshot for subscribers when something outside the state (network layer) changed. */
  private notify() {
    this.setState({});
  }

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
    this.cancelAnalysis();
    this.comparisonRun?.cancel();
    this.comparisonGeneration++;
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
    this.cancelAnalysis();
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
    this.invalidateComparison('The study roads changed. Capture a new baseline.');
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
    this.invalidateComparison('The study roads changed. Capture a new baseline.');
    this.autoRun = false;
    this.cancelPendingRecompute();
    this.resetTraffic();
    this.visualizer.reset();
    this.cancelAnalysis();
    this.setState({ seedRoadIds: [], area: null, section: null, error: null, analysis: { status: 'idle', progress: 0, output: null, error: null, hour: null, demandVph: null } });
    this.forgetOsmResult();
  }

  /** A finished load's message belongs to the area it was for. */
  private forgetOsmResult() {
    if (this.state.osmRoads.status !== 'loading') this.setState({ osmRoads: { status: 'idle', added: null, error: null } });
  }

  public setRange(meters: number) {
    const rangeMeters = clampRangeM(meters);
    if (rangeMeters === this.state.rangeMeters) return;
    this.invalidateComparison('The study range changed. Capture a new baseline.');
    this.setState({ rangeMeters });
    if (this.state.seedRoadIds.length > 0) {
      this.autoRun = true;
      this.recompute(true, false);
    }
  }

  public setDirection(direction: StudyDirection) {
    this.invalidateComparison('The study direction changed. Capture a new baseline.');
    this.setState({ direction });
    if (this.state.seedRoadIds.length > 0) this.recompute(false, false);
  }

  /** Turns the local OSM correction layer on or off (re-maps the area). */
  public setNetworkCorrections(enabled: boolean) {
    if (this.correctionsEnabled === enabled) return;
    this.correctionsEnabled = enabled;
    this.networkChanged();
    this.notify();
  }

  /** Webster signal timing from critical flows, or the earlier equal split. */
  public setSignalTiming(mode: 'webster' | 'equal') {
    if (this.signalTiming === mode) return;
    this.signalTiming = mode;
    this.networkChanged();
    this.notify();
  }

  /** What the network layer is doing, for the panel. */
  public networkLayerInfo() {
    return {
      corrections: this.correctionLayer ? { id: this.correctionLayer.id, version: this.correctionLayer.version, count: this.correctionLayer.corrections.length } : null,
      correctionsEnabled: this.correctionsEnabled,
      applied: this.lastCorrectionReport?.applied.length ?? 0,
      impliedOneWay: this.lastCorrectionReport?.impliedOneWay.length ?? 0,
      signalTiming: this.signalTiming,
    };
  }

  /** Roads changed or the scenario switched. Re-maps the current area shortly after. */
  public networkChanged() {
    this.invalidateComparison('The network changed. Run the comparison again.');
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
    this.analysisStale = true;
    this.cancelAnalysis();
    // A run belongs to one area and network: any change starts over
    this.resetTraffic();
    try {
      const area = this.explorer.explore(this.getRoads(), this.revision, {
        seedRoadIds: this.state.seedRoadIds,
        rangeMeters: this.state.rangeMeters,
        direction: this.state.direction,
      });
      // Seeds deleted from the network drop out here
      const section = area.seedRoadIds.length ? roadSection(area, new Map(this.getRoads().map(r => [r.id, r])), area.seedRoadIds) : null;
      this.setState({ area, error: null, seedRoadIds: area.seedRoadIds, section });
      this.refreshCountedJunctions();
      this.visualizer.render(area, reveal, new Set(section?.segmentKeys ?? []));
      // The selected road is the subject: the camera goes to it, not the whole area
      if (fly) this.focusView();
    } catch (err: any) {
      this.visualizer.clear();
      this.cancelAnalysis();
      this.setState({ area: null, section: null, error: err?.message || String(err), analysis: { status: 'idle', progress: 0, output: null, error: null, hour: null, demandVph: null } });
    }
    this.ensureOsmRoads();
    this.ensureSignals();
    this.maybeAutoStart();
  }

  /** Starts traffic when a road has been picked and its area is fully mapped. */
  private maybeAutoStart() {
    if (!this.state.area || this.osmLoad || this.signalLoad || this.recomputeTimer) return; // roads or signals still arriving
    // The analysis answers "what is happening on this road"; it runs whenever the area is complete
    if (this.state.analysis.status !== 'running' && (this.state.analysis.status !== 'ready' || this.analysisStale)) { this.analysisStale = false; this.scheduleAnalysis(); }
    if (!this.autoRun || this.state.traffic.status !== 'idle') return;
    this.startTraffic();
  }
  /** The area, network or demand changed since the last analysis. */
  private analysisStale = true;

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
        this.invalidateComparison('Mapped signals changed. Run the comparison again.');
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
    const context = this.getContext();
    const plan = this.studyPlan(area);
    const sim = new TrafficMicroSim(area, roads, {
      demandLevel: this.state.traffic.demandLevel,
      seed: this.state.traffic.seed,
      watchRoadIds: area.seedRoadIds, watchSegmentKeys: this.state.section?.segmentKeys,
      focusLoad: focusLoadFor(this.state.traffic),
      signalPoints: this.signalPoints ?? undefined, signalTiming: this.signalTiming,
      junctions: context.junctions,
      demandTrips: plan ? snapDemandPlan(plan, area.network, 250, new Set(area.segments.map(s => s.key))) : undefined,
    });
    sim.setHourFactor(this.state.timeOfDay.factor);
    this.playbackHourStartT = 0;
    void this.ensureTimeProfile();
    const metrics = sim.getMetrics();
    this.setTraffic({ demand: plan ? { ...plan.provenance } : { source: 'synthetic', label: 'Synthetic capacity-based arrivals; no project OD demand configured', period: context.period ?? 'AM_Peak', vehiclesPerHour: metrics.inflowVph, pairCount: sim.getDemandTrips().length } });
    if (metrics.entries === 0 || metrics.exits < (plan ? 1 : 2)) {
      this.setTraffic({
        error: plan ? 'No estimated OD trips can be routed in this study area. Include both trip origins and destinations.' : metrics.entries === 0
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
    if (this.state.selectedVehicleId !== null) this.setState({ selectedVehicleId: null });
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
    this.invalidateComparison('Demand settings changed. Restore the baseline settings or capture a new baseline.');
    this.sim?.setDemandLevel(demandLevel);
    this.sim?.setFocusLoad(focusLoadFor({ focus: this.state.traffic.focus, demandLevel }));
    this.setTraffic({ demandLevel, metrics: this.sim?.getMetrics() ?? this.state.traffic.metrics });
  }

  /** Turns the extra through traffic on the selected roads on or off. */
  public setFocus(focus: boolean) {
    this.invalidateComparison('Focus settings changed. Restore the baseline settings or capture a new baseline.');
    this.sim?.setFocusLoad(focusLoadFor({ focus, demandLevel: this.state.traffic.demandLevel }));
    this.setTraffic({ focus, metrics: this.sim?.getMetrics() ?? this.state.traffic.metrics });
  }

  private studyKey() {
    return contentKey({ roads: this.state.seedRoadIds, range: this.state.rangeMeters, direction: this.state.direction });
  }

  private demandContextKey() {
    return demandContextKey(this.getContext());
  }

  private invalidateComparison(reason: string) {
    this.invalidateCalibration(reason);
    this.comparisonGeneration++;
    if (!this.state.comparison.baseline && !this.state.comparison.running) return;
    if (this.state.comparison.running) this.comparisonRun?.cancel();
    this.setState({ comparison: { ...this.state.comparison, current: null, result: null, staleReason: reason, running: false } });
  }

  /** A trial must run on the area mapped from the current roads, not one still waiting out its debounce. */
  private flushPendingRecompute() {
    if (!this.recomputeTimer) return;
    this.cancelPendingRecompute();
    this.recompute(false, false);
  }

  // ── Demand for the area ─────────────────────────────────────────────────

  /** Land-use peak the clock falls in: morning before noon, else evening. */
  private landUsePeriod(): 'AM_Peak' | 'PM_Peak' {
    return this.state.timeOfDay.hour < 12 ? 'AM_Peak' : 'PM_Peak';
  }

  private planCache: { key: string; plan: DemandPlan | null } | null = null;

  /**
   * The OD demand the area runs on: the counts-calibrated plan when applied,
   * else the area estimate (AreaDemand.ts: the area's own trips, trips across
   * its edge and through traffic on its main roads) for the land-use peak of
   * the clock hour; the hypothetical multiplier, if set, on top (labelled so).
   */
  public studyPlan(area: StudyArea | null = this.state.area): DemandPlan | null {
    if (!area) return null;
    const settings = this.state.demandSettings;
    let plan: DemandPlan | null;
    if (this.calibratedPlan) plan = this.calibratedPlan;
    else {
      const period = this.landUsePeriod();
      const key = contentKey({ ctx: demandContextKey({ ...this.getContext(), period }), rev: this.revision, seeds: area.seedRoadIds, range: area.rangeMeters, dir: area.direction, through: settings.through, corr: this.correctionsEnabled });
      if (this.planCache?.key !== key) {
        const ctx = { ...this.getContext(), period };
        this.planCache = { key, plan: compileAreaDemand(ctx, area, new Map(this.getRoads().map(r => [r.id, r])), { through: settings.through }) };
      }
      plan = this.planCache.plan;
    }
    if (!plan) return null;
    const scale = settings.hypotheticalScale;
    if (scale === null || scale === 1) return plan;
    return { trips: plan.trips.map(t => ({ ...t, vehiclesPerHour: t.vehiclesPerHour * scale })),
      provenance: { ...plan.provenance, source: 'hypothetical', vehiclesPerHour: plan.provenance.vehiclesPerHour * scale,
        label: `HYPOTHETICAL: ${Math.round(scale * 100)}% of the estimate below. Not observed and not forecast; for exploring what more or less traffic would do. ${plan.provenance.label}` } };
  }

  public setDemandSettings(patch: Partial<DemandSettings>) {
    const next = { ...this.state.demandSettings, ...patch };
    if (next.hypotheticalScale !== null && (!Number.isFinite(next.hypotheticalScale) || next.hypotheticalScale <= 0)) next.hypotheticalScale = null;
    this.invalidateComparison('Demand settings changed. Restore them or save a new baseline.');
    this.setState({ demandSettings: next });
    if (this.state.traffic.status !== 'idle') this.restartTraffic();
    this.scheduleAnalysis();
  }

  // ── Road analysis ───────────────────────────────────────────────────────

  private simOptions(): AnalysisJob['options'] {
    const traffic = this.state.traffic;
    return { demandLevel: traffic.demandLevel, seed: traffic.seed, signalPoints: this.signalPoints ?? undefined, signalTiming: this.signalTiming, junctions: structuredClone(this.getContext().junctions) };
  }

  private analysisJob(plan: DemandPlan, area: StudyArea, section: RoadSection, measureS: number = DEFAULT_ANALYSIS.measureS): AnalysisJob {
    const ds = this.state.calibration.dataset;
    return { area, roads: new Map(structuredClone(this.getRoads()).map(r => [r.id, r])), options: this.simOptions(), plan: structuredClone(plan), section,
      hourFactor: this.state.timeOfDay.factor, feedbackIterations: DEFAULT_ANALYSIS.feedbackIterations, warmupS: DEFAULT_ANALYSIS.warmupS, measureS,
      countJunctions: ds ? junctionsIn(ds, area.bounds) : undefined };
  }

  /** Re-runs the road analysis shortly (settings settle first). Not during 24-hour playback. */
  private scheduleAnalysis(delayMs = 500) {
    if (this.analysisTimer) clearTimeout(this.analysisTimer);
    this.analysisTimer = null;
    if (!this.state.active || !this.state.area || this.state.timeOfDay.playback) return;
    this.analysisTimer = setTimeout(() => { this.analysisTimer = null; void this.runAnalysis(); }, delayMs);
  }

  private cancelAnalysis() {
    if (this.analysisTimer) clearTimeout(this.analysisTimer);
    this.analysisTimer = null;
    this.analysisRun?.cancel();
    this.analysisRun = null;
  }

  /**
   * Analyses the selected section in a fixed, repeatable run (analysisJob.ts):
   * the planned demand at the clock hour, one round of route adaptation, then
   * a measured run from an empty network. Live traffic is for watching; this
   * run is what the figures in the panel come from.
   */
  public async runAnalysis(): Promise<AnalysisOutput | null> {
    this.flushPendingRecompute();
    const area = this.state.area, section = this.state.section;
    this.cancelAnalysis();
    if (!area || !section) return null;
    await this.ensureCountData().catch(() => {});
    const plan = this.studyPlan(area);
    if (!plan?.trips.length) {
      this.setState({ analysis: { status: 'error', progress: 0, output: null, error: 'No traffic can be estimated for this area: no roads cross its edge and it holds no buildings or zones with activity.', hour: this.state.timeOfDay.hour, demandVph: 0 } });
      return null;
    }
    const hour = this.state.timeOfDay.hour, demandVph = plan.provenance.vehiclesPerHour * this.state.timeOfDay.factor;
    this.setState({ analysis: { ...this.state.analysis, status: 'running', progress: 0, error: null, hour, demandVph } });
    const run = startAnalysisJob(this.analysisJob(plan, area, section), progress => {
      if (this.analysisRun === run) this.setState({ analysis: { ...this.state.analysis, progress } });
    });
    this.analysisRun = run;
    try {
      const output = await run.promise;
      if (this.analysisRun !== run) return null;
      this.analysisRun = null;
      this.setState({ analysis: { status: 'ready', progress: 1, output, error: null, hour, demandVph } });
      return output;
    } catch (err) {
      if (this.analysisRun !== run) return null;
      this.analysisRun = null;
      this.setState({ analysis: { ...this.state.analysis, status: 'error', error: err instanceof Error ? err.message : String(err) } });
      return null;
    }
  }

  /** Shows (or hides) where the section's traffic comes from and goes to on the map. */
  public showSelectLink(on: boolean) {
    const out = this.state.analysis.output;
    this.visualizer.showSelectLink(on && out ? out.result.selectLinkVph : null);
  }

  // ── Existing city against a proposal ────────────────────────────────────

  private baselineRoads: Map<string, DrivableObject> | null = null;

  private snapshotOf(output: AnalysisOutput, plan: DemandPlan, measureS: number): TrafficRunSnapshot {
    const traffic = this.state.traffic, context = this.getContext();
    return { scenarioId: context.scenarioId ?? 'current', durationS: measureS, seed: traffic.seed, demandLevel: traffic.demandLevel, focus: traffic.focus,
      hour: this.state.timeOfDay.hour, hourFactor: this.state.timeOfDay.factor,
      demandKey: contentKey(plan), networkKey: contentKey({ roads: this.getRoads(), junctions: context.junctions, signalPoints: this.signalPoints }),
      metrics: output.result.network, demandVph: plan.provenance.vehiclesPerHour * this.state.timeOfDay.factor, analysis: output };
  }

  private async runJob(plan: DemandPlan, measureS: number, generation: number): Promise<AnalysisOutput> {
    const area = this.state.area, section = this.state.section;
    if (!area || !section) throw new Error('Select a study road before running a trial.');
    this.comparisonRun?.cancel();
    const run = startAnalysisJob(this.analysisJob(plan, area, section, measureS), progress => {
      if (generation === this.comparisonGeneration) this.setState({ comparison: { ...this.state.comparison, progress } });
    });
    this.comparisonRun = run;
    try {
      const out = await run.promise;
      if (generation !== this.comparisonGeneration) throw new Error('The project changed while the run was being captured. Run it again.');
      return out;
    } finally {
      if (this.comparisonRun === run) this.comparisonRun = null;
    }
  }

  /**
   * Saves the existing city as the baseline: the demand is frozen (as
   * coordinates, so it survives road edits), with the seed, volume and clock
   * hour, and the network is analysed on it.
   */
  public async captureBaseline(durationS: number = DEFAULT_ANALYSIS.measureS): Promise<TrafficRunSnapshot | null> {
    this.flushPendingRecompute();
    const generation = ++this.comparisonGeneration;
    this.setState({ comparison: { ...this.state.comparison, running: true, progress: 0, staleReason: null, result: null, current: null, demandChanged: false } });
    try {
      const area = this.state.area;
      if (!area) throw new Error('Select a study road before capturing a baseline.');
      await this.ensureCountData().catch(() => {});
      const plan = this.studyPlan(area);
      if (!plan?.trips.length) throw new Error('This study area has no OD demand to compare.');
      const duration = Number.isFinite(durationS) ? Math.max(STEP_S, Math.min(3600, durationS)) : DEFAULT_ANALYSIS.measureS;
      const contextKey = this.demandContextKey(), studyKey = this.studyKey();
      const output = await this.runJob(plan, duration, generation);
      if (generation !== this.comparisonGeneration) return null;
      const baseline = this.snapshotOf(output, plan, duration);
      this.baselinePlan = structuredClone(plan);
      this.baselineRoads = new Map(structuredClone(this.getRoads()).map(r => [r.id, r]));
      this.baselineContextKey = contextKey;
      this.baselineStudyKey = studyKey;
      this.setState({ comparison: { baseline, current: null, result: null, staleReason: null, running: false, progress: 1, demandChanged: false } });
      return baseline;
    } catch (err) {
      if (generation === this.comparisonGeneration) this.setState({ comparison: { ...this.state.comparison, current: null, staleReason: err instanceof Error ? err.message : String(err), running: false } });
      return null;
    }
  }

  /**
   * Runs the proposal (the network as it is now) on the baseline's frozen
   * demand, seed, volume and hour, and compares it with the baseline. When the
   * land use changed since the baseline, the demand is still held at the
   * baseline's unless `withNewDemand` asks for a development scenario, which
   * is labelled as such.
   */
  public async runComparison(opts: { withNewDemand?: boolean } = {}): Promise<TrafficRunSnapshot | null> {
    this.flushPendingRecompute();
    const baseline = this.state.comparison.baseline, frozen = this.baselinePlan;
    const demandChanged = !!baseline && this.baselineContextKey !== this.demandContextKey();
    let reason: string | null = null;
    if (!baseline || !frozen) reason = 'Save the existing city as a baseline before comparing.';
    else if (this.baselineStudyKey !== this.studyKey()) reason = 'The study road or range changed. Save a new baseline.';
    else if (baseline.seed !== this.state.traffic.seed || baseline.demandLevel !== this.state.traffic.demandLevel || baseline.focus !== this.state.traffic.focus) reason = 'Restore the baseline seed and volume before comparing.';
    else if (baseline.hour !== this.state.timeOfDay.hour || Math.abs(baseline.hourFactor - this.state.timeOfDay.factor) > 1e-9) reason = `Set the clock back to ${String(baseline.hour).padStart(2, '0')}:00, the baseline's hour, to compare like with like.`;
    if (reason) {
      this.setState({ comparison: { ...this.state.comparison, current: null, result: null, staleReason: reason, running: false, demandChanged } });
      return null;
    }
    const generation = ++this.comparisonGeneration;
    this.setState({ comparison: { ...this.state.comparison, running: true, progress: 0, staleReason: null, demandChanged } });
    try {
      const plan = opts.withNewDemand && demandChanged ? this.studyPlan() : frozen!;
      if (!plan?.trips.length) throw new Error('The proposal has no OD demand to run.');
      const output = await this.runJob(plan, baseline!.durationS, generation);
      if (generation !== this.comparisonGeneration) return null;
      const current = this.snapshotOf(output, plan, baseline!.durationS);
      const result = compareAnalyses(baseline!.analysis, output, { before: this.baselineRoads ?? new Map(), after: new Map(this.getRoads().map(r => [r.id, r])) },
        { before: baseline!.demandVph, after: current.demandVph });
      if (demandChanged && !opts.withNewDemand) result.caveats.unshift('The land use changed since the baseline. This comparison holds the demand at the baseline\'s, so it shows the effect of the road changes alone.');
      this.setState({ comparison: { baseline, current, result, staleReason: null, running: false, progress: 1, demandChanged } });
      return current;
    } catch (err) {
      if (generation === this.comparisonGeneration) this.setState({ comparison: { ...this.state.comparison, current: null, result: null, running: false, staleReason: err instanceof Error ? err.message : String(err) } });
      return null;
    }
  }

  // ── Time of day ──────────────────────────────────────────────────────────

  private setTimeOfDay(patch: Partial<TimeOfDayState>) {
    const prev = this.state.timeOfDay;
    const next = { ...prev, ...patch };
    // Calibrated demand is the counted peak hour; the area estimate is the peak of the clock's half of the day
    const reference = this.calibratedPlan ? COUNT_HOURS[next.countPeak] : COUNT_HOURS[next.hour < 12 ? 'AM' : 'PM'];
    next.factor = next.profile ? hourFactor(next.profile, next.hour, reference, next.day) : 1;
    const periodFlip = (prev.hour < 12) !== (next.hour < 12) && !this.calibratedPlan;
    this.setState({ timeOfDay: next });
    // Morning and evening land-use trips run opposite ways: a new plan, so live traffic starts again
    if (periodFlip && this.sim) { this.restartTraffic(); }
    else {
      this.sim?.setHourFactor(next.factor);
      if (this.sim) this.setTraffic({ metrics: this.sim.getMetrics() });
    }
    if (next.hour !== prev.hour || next.day !== prev.day || next.factor !== prev.factor) { this.analysisStale = true; this.scheduleAnalysis(700); }
  }

  /** Loads the hour-of-day profile (once; again after an error). */
  public ensureTimeProfile(): Promise<void> {
    const t = this.state.timeOfDay;
    if (t.status === 'ready' || t.status === 'loading') return Promise.resolve();
    this.setTimeOfDay({ status: 'loading', error: null });
    return fetchDiurnalProfile()
      .then(profile => this.setTimeOfDay({ status: 'ready', profile }))
      .catch(err => this.setTimeOfDay({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
  }

  public setHour(hour: number) {
    this.playbackHourStartT = this.sim?.timeS ?? 0;
    this.setTimeOfDay({ hour: ((Math.round(hour) % 24) + 24) % 24 });
  }

  public setDayType(day: DayType) {
    this.setTimeOfDay({ day });
  }

  /** Which peak hour the counts represent (AM 09:00 or PM 19:00); the calibrated demand is that hour's. */
  public setCountPeak(countPeak: 'AM' | 'PM') {
    this.setTimeOfDay({ countPeak });
    // A calibrated plan represents the counted hour: relabel it (and the live demand card) with the chosen peak
    if (this.calibratedPlan) {
      const period = countPeakPeriod(countPeak);
      this.calibratedPlan = { ...this.calibratedPlan, provenance: { ...this.calibratedPlan.provenance, period } };
      const demand = this.state.traffic.demand;
      if (demand?.source === 'calibrated') this.setTraffic({ demand: { ...demand, period } });
    }
  }

  public setPlayback(on: boolean) {
    this.playbackHourStartT = this.sim?.timeS ?? 0;
    this.setTimeOfDay({ playback: on });
  }

  private playbackHourStartT = 0;

  private advancePlayback(sim: TrafficMicroSim) {
    const t = this.state.timeOfDay;
    if (!t.playback || !t.profile) return;
    if (sim.timeS - this.playbackHourStartT >= PLAYBACK_S_PER_HOUR) {
      this.playbackHourStartT = sim.timeS;
      this.setTimeOfDay({ hour: (t.hour + 1) % 24 });
    }
  }

  // ── Calibration against observed counts ──────────────────────────────────

  private setCalibration(patch: Partial<CalibrationState>) {
    this.setState({ calibration: { ...this.state.calibration, ...patch } });
  }

  /** Loads the observed count file (once; again after an error). */
  public ensureCountData(): Promise<void> {
    const c = this.state.calibration;
    if (c.datasetStatus === 'ready' || c.datasetStatus === 'loading') return Promise.resolve();
    this.setCalibration({ datasetStatus: 'loading', datasetError: null });
    return this.loadCounts()
      .then(dataset => {
        this.setCalibration({ datasetStatus: 'ready', dataset });
        this.refreshCountedJunctions();
      })
      .catch(err => this.setCalibration({ datasetStatus: 'error', datasetError: err instanceof Error ? err.message : String(err) }));
  }

  private refreshCountedJunctions() {
    const ds = this.state.calibration.dataset, area = this.state.area;
    if (!ds) return;
    const inside = area ? junctionsIn(ds, area.bounds) : [];
    this.setCalibration({ junctions: inside.map(j => ({ id: j.id, name: j.name, problem: null, arms: 0, maxCardinalErrorDeg: null })) });
  }

  private invalidateCalibration(reason: string) {
    this.calibrationGeneration++;
    const c = this.state.calibration;
    const hadResults = c.rows.length > 0 || this.calibratedPlan !== null || c.status === 'measuring' || c.status === 'fitting';
    this.calibratedPlan = null;
    if (!hadResults) return;
    this.setCalibration({ rows: [], before: null, after: null, fit: null, applied: false, status: 'idle', progress: 0, error: null, staleReason: reason });
  }

  /** The uncalibrated demand for the area: the project estimate, or frozen synthetic arrivals when there is none. */
  private basePlan(area: StudyArea): DemandPlan {
    const context = this.getContext();
    // The uncalibrated area estimate, whatever is applied now
    const applied = this.calibratedPlan;
    this.calibratedPlan = null;
    const plan = this.studyPlan(area);
    this.calibratedPlan = applied;
    if (plan) return plan;
    const traffic = this.state.traffic;
    const sim = new TrafficMicroSim(area, new Map(this.getRoads().map(r => [r.id, r])), {
      demandLevel: traffic.demandLevel, seed: traffic.seed, watchRoadIds: area.seedRoadIds,
      focusLoad: focusLoadFor(traffic), junctions: context.junctions, signalPoints: this.signalPoints ?? undefined, signalTiming: this.signalTiming,
    });
    const trips = sim.getDemandTrips().flatMap(t => {
      const from = area.network.nodes.get(t.fromNodeId), to = area.network.nodes.get(t.toNodeId);
      return from && to ? [{ from: [...from.coordinates] as [number, number, number], to: [...to.coordinates] as [number, number, number], vehiclesPerHour: t.vehiclesPerHour, kind: t.kind, viaRoadId: t.viaRoadId }] : [];
    });
    return { trips, provenance: { source: 'synthetic', label: 'Synthetic capacity-based arrivals (no project OD demand here).', period: context.period ?? 'AM_Peak', vehiclesPerHour: trips.reduce((n, t) => n + t.vehiclesPerHour, 0), pairCount: trips.length } };
  }

  private simSetup(area: StudyArea): SimSetup {
    const traffic = this.state.traffic;
    const ds = this.state.calibration.dataset;
    return { area, roads: new Map(structuredClone(this.getRoads()).map(r => [r.id, r])),
      // Counted junctions are timed from their observed approach flows
      signalDesignCounts: this.signalTiming === 'webster' && ds ? junctionsIn(ds, area.bounds) : undefined,
      options: { demandLevel: traffic.demandLevel, seed: traffic.seed, watchRoadIds: area.seedRoadIds, junctions: structuredClone(this.getContext().junctions), signalPoints: this.signalPoints ?? undefined, signalTiming: this.signalTiming } };
  }

  private countedInArea(area: StudyArea) {
    const ds = this.state.calibration.dataset;
    if (!ds) throw new Error('The observed count file has not loaded.');
    const junctions = junctionsIn(ds, area.bounds);
    if (!junctions.length) throw new Error('No counted junction lies inside this study area.');
    return junctions;
  }

  /**
   * Runs the current (uncalibrated) demand from an empty network and compares
   * the simulated turning flows with the counts. With `fit`, then scales the
   * demand to the counts, runs that too and switches live traffic to it.
   */
  public async runCalibration(fit: boolean, opts: { warmupS?: number; measureS?: number } = {}): Promise<boolean> {
    this.flushPendingRecompute();
    await this.ensureCountData();
    const area = this.state.area;
    const generation = ++this.calibrationGeneration;
    const aborted = () => generation !== this.calibrationGeneration;
    try {
      if (!area) throw new Error('Select a study road first.');
      const junctions = this.countedInArea(area);
      const setup = this.simSetup(area);
      const base = this.basePlan(area);
      if (!base.trips.length) throw new Error('This study area has no demand to calibrate.');
      const zones = junctions.map(zoneFor);
      this.setCalibration({ status: 'measuring', progress: 0, error: null, staleReason: null });
      const before = await measureFlows(setup, base, zones, { ...opts, aborted, onProgress: p => this.setCalibration({ progress: fit ? p / 2 : p }) });
      if (aborted()) return false;
      const checks = junctionChecks(junctions, before.layouts);
      if (!fit) {
        const rows = compareRows(junctions, before.layouts, before.flows, null);
        this.setCalibration({ status: 'idle', progress: 1, junctions: checks, rows, before: summarize(rows, 'gehBefore'), after: null, fit: null, windowS: before.windowS, runMetrics: { before: before.metrics, after: null } });
        return true;
      }
      this.setCalibration({ status: 'fitting' });
      await new Promise<void>(r => setTimeout(r, 0));
      const result = fitPlan(setup, base, junctions);
      if (aborted()) return false;
      this.setCalibration({ status: 'measuring' });
      const after = await measureFlows(setup, result.plan, zones, { ...opts, aborted, onProgress: p => this.setCalibration({ progress: 0.5 + p / 2 }) });
      if (aborted()) return false;
      const rows = compareRows(junctions, before.layouts, before.flows, after.flows);
      const observed = observedFlows(junctions.filter(j => !checks.find(c => c.id === j.id)?.problem));
      const fitted = result.ipf.factors.length ? result.ipf.factors : [1];
      // The calibrated demand is the counted peak hour, whichever peak the user says the counts are
      this.calibratedPlan = { ...result.plan, provenance: { ...result.plan.provenance, period: countPeakPeriod(this.state.timeOfDay.countPeak) } };
      this.setCalibration({
        status: 'idle', progress: 1, junctions: checks, rows, before: summarize(rows, 'gehBefore'), after: summarize(rows, 'gehAfter'), windowS: after.windowS, applied: true, runMetrics: { before: before.metrics, after: after.metrics },
        fit: {
          iterations: result.ipf.iterations, converged: result.ipf.converged, cappedTrips: result.ipf.cappedTrips,
          seeds: result.seeds.length, seedVph: Math.round(result.seeds.reduce((n, s) => n + s.vehiclesPerHour, 0)), unreachable: result.unreachable.length,
          factorMin: Math.min(...fitted), factorMax: Math.max(...fitted),
          assignedBefore: gehAgainst(observed, result.ipf.before), assignedAfter: gehAgainst(observed, result.ipf.after),
          demandLevel: this.state.traffic.demandLevel,
        },
      });
      if (this.state.traffic.status !== 'idle') this.restartTraffic();
      return true;
    } catch (err) {
      if (!aborted()) this.setCalibration({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Back to the uncalibrated demand. */
  public clearCalibration() {
    const wasApplied = this.calibratedPlan !== null;
    this.calibrationGeneration++;
    this.calibratedPlan = null;
    this.setCalibration({ rows: [], before: null, after: null, fit: null, applied: false, status: 'idle', progress: 0, error: null, staleReason: null });
    if (wasApplied && this.state.traffic.status !== 'idle') this.restartTraffic();
  }

  /** The calibrated plan, for reports. */
  public getCalibratedPlan(): DemandPlan | null {
    return this.calibratedPlan;
  }

  public clearBaseline() {
    this.comparisonGeneration++;
    this.baselinePlan = null;
    this.comparisonRun?.cancel();
    this.baselineRoads = null;
    this.setState({ comparison: { baseline: null, current: null, result: null, staleReason: null, running: false, progress: 0, demandChanged: false } });
  }

  public getVehicleViews(): VehicleView[] {
    const vehicles: VehicleView[] = [];
    this.sim?.forEachVehicle(v => vehicles.push({ ...v }), this.stepDebt);
    return vehicles;
  }

  public inspectVehicle(id: number): VehicleView | null {
    let result: VehicleView | null = null;
    this.sim?.forEachVehicle(v => { if (v.id === id) result = { ...v }; }, this.stepDebt);
    return result;
  }

  public selectVehicle(id: number | null) {
    this.setState({ selectedVehicleId: id });
  }

  public pickVehicleAt(lng: number, lat: number, maxDistanceM = 8): VehicleView | null {
    let selected: VehicleView | null = null, best = maxDistanceM;
    const kx = 111320 * Math.cos(lat * Math.PI / 180);
    this.sim?.forEachVehicle(v => {
      const distance = Math.hypot((v.lng - lng) * kx, (v.lat - lat) * 111320);
      if (v.opacity > .1 && distance < best) { best = distance; selected = { ...v }; }
    }, this.stepDebt);
    return selected;
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
      this.advancePlayback(sim);
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
