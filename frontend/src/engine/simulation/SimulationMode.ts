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
import { DirectionArrows } from '../rendering/renderers/DirectionArrows';
import { MicroTrafficVisualizer } from '../rendering/renderers/MicroTrafficVisualizer';
import { TrafficMicroSim, STEP_S, OD_REFERENCE_LEVEL, type MicroSimMetrics, type VehicleView } from './TrafficMicroSim';
import type { TrafficSignalSource, SignalPoint } from './trafficSignals';
import { snapDemandPlan, contentKey, networkContentKey, demandContextKey, type SimulationContext, type DemandPlan, type DemandProvenance } from './StudyDemand';
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
import { DEFAULT_ANALYSIS, CORRIDOR_RANGE_M, type AnalysisJob, type AnalysisOutput } from './analysisJob';
import { applyUrbanSpeeds, type SpeedReport } from './roadParameters';
import { compareAnalyses, type ComparisonResult } from './ScenarioComparison';
import { vcColour } from './RoadAnalysis';
import { fetchScreenlines, type ScreenlineFile } from '../calibration/screenlines';

/**
 * Live view lifecycle: idle (stopped, nothing computing), preparing (waiting
 * for the analysis, then simulating the warm-up off screen), running, paused.
 * Stop returns to idle and releases the simulation; nothing runs while Simulate
 * is closed.
 */
export type TrafficStatus = 'idle' | 'preparing' | 'running' | 'paused';

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
  /** While preparing: what it is waiting for, and how far the warm-up has got (0-1). */
  preparing: { stage: 'analysis' | 'warmup'; progress: number } | null;
  /** Clock hour the live view's demand is for (null while idle). */
  hour: number | null;
  /** Simulated seconds of warm-up run before the live view is shown. */
  warmupS: number;
}

/** Time-of-day periods offered in the main controls (hourly detail stays under Details). */
export const DAY_PERIODS = [
  { id: 'am', label: 'Morning peak', hour: 9 },
  { id: 'midday', label: 'Midday', hour: 14 },
  { id: 'pm', label: 'Evening peak', hour: 19 },
  { id: 'night', label: 'Night', hour: 23 },
] as const;
export type DayPeriodId = (typeof DAY_PERIODS)[number]['id'];
export const periodOfHour = (hour: number): DayPeriodId | null => DAY_PERIODS.find(p => p.hour === hour)?.id ?? null;

/** The selected road at each period of the day (one analysis run per period). */
export interface TimelineState {
  status: 'idle' | 'running' | 'ready' | 'error';
  progress: number;
  rows: { period: DayPeriodId; label: string; hour: number; demandVph: number; result: AnalysisOutput['result'] | null }[];
  error: string | null;
  /** Network and demand the rows are for; a change makes them stale. */
  key: string | null;
}

/** What is computing right now, for the panel and for tests: nothing should be listed while Simulate is closed or stopped. */
export interface ResourceReport { liveSim: boolean; animationFrame: boolean; warmup: boolean; analysisRunning: boolean; comparisonRunning: boolean; timelineRunning: boolean; timers: number; vehicles: number }

export type MapOverlay = 'none' | 'select-link' | 'area-vc' | 'cause' | 'comparison';

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
  /**
   * The road analysis on show ran on a network that differs from the saved
   * baseline's (the city as edited in Build), so the panel labels it a proposal.
   */
  showingProposal: boolean;
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
  /** Network, demand and hour the output is for: kept across closing and reopening Simulate while unchanged. */
  key: string | null;
  /**
   * The output on show is for a network, demand or hour that has changed since
   * (e.g. a Build edit); its re-run is pending or running. Cleared when the new
   * result arrives (docs/OVERHAUL.md §14).
   */
  outdated?: boolean;
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
  /** The selected road's neighbourhood: simulated vehicle by vehicle (analysis and live view). */
  corridor: StudyArea | null;
  analysis: RoadAnalysisState;
  demandSettings: DemandSettings;
  timeline: TimelineState;
  overlay: MapOverlay;
  /** Direction of the selected road highlighted on the map and in the panel: under the pointer (hover) or clicked (pinned). */
  directionFocus: { hover: number | null; pinned: number | null };
  /** Free-flow speeds used (OSM maxspeed, inherited, or urban default). */
  speeds: SpeedReport | null;
  /** Why the last run of something long was stopped (left Simulate, network changed), shown once. */
  notice: string | null;
  /** Counted roads (river bridges, PMC CMP 2008) for checking the model's volumes. */
  screenlines: ScreenlineFile | null;
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
  /** Demand multiplier now applied: profile[hour] / profile[count hour]. */
  factor: number;
}

const EMPTY_ANALYSIS: RoadAnalysisState = { status: 'idle', progress: 0, output: null, error: null, hour: null, demandVph: null, key: null };
const EMPTY_TIMELINE: TimelineState = { status: 'idle', progress: 0, rows: [], error: null, key: null };
/** The live view starts from the same warm-up the analysis counts from: vehicles already on the roads, in a state the model reached itself. */
export const LIVE_WARMUP_S = 300;
/** Real milliseconds of warm-up simulation per frame, so the page stays responsive. */
const WARMUP_SLICE_MS = 14;

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
    traffic: { status: 'idle', speed: 5, demandLevel: DEFAULT_DEMAND_LEVEL, focus: false, seed: DEFAULT_TRAFFIC_SEED, metrics: null, error: null, demand: null, preparing: null, hour: null, warmupS: LIVE_WARMUP_S },
    osmRoads: { status: 'idle', added: null, error: null },
    signals: { status: 'off', count: null },
    comparison: { baseline: null, current: null, result: null, staleReason: null, running: false, progress: 0, demandChanged: false, showingProposal: false },
    selectedVehicleId: null,
    calibration: EMPTY_CALIBRATION,
    timeOfDay: { status: 'idle', error: null, profile: null, hour: COUNT_HOURS.AM, day: 'weekday', countPeak: 'PM', factor: 1 },
    section: null,
    corridor: null,
    analysis: EMPTY_ANALYSIS,
    demandSettings: { through: true, hypotheticalScale: null },
    timeline: EMPTY_TIMELINE,
    overlay: 'none',
    directionFocus: { hover: null, pinned: null },
    speeds: null,
    notice: null,
    screenlines: null,
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
  private readonly arrows = new DirectionArrows();
  /** The direction list the arrows (and the highlight index) belong to. */
  private arrowDirections: readonly unknown[] | null = null;
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

  private readonly getRoads: () => DrivableObject[];
  private readonly osmSource: OsmRoadSource | null;
  private readonly getContext: () => SimulationContext;
  private baselinePlan: DemandPlan | null = null;
  private baselineContextKey = '';
  private baselineStudyKey = '';
  private comparisonGeneration = 0;
  /** Network the road analysis on show ran on, to tell the existing city from a proposal. */
  private analysisNetworkKey: string | null = null;
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
  private roadsCache: { n: number; layer: NetworkCorrectionLayer | null; enabled: boolean; rev: number; roads: DrivableObject[] } | null = null;
  private speedReport: SpeedReport | null = null;
  /** Live warm-up in progress (cancelled by Stop, a new area, or leaving Simulate). */
  private warmupHandle: ReturnType<typeof setTimeout> | null = null;
  private timelineRun: RunningAnalysis | null = null;
  private timelineGeneration = 0;
  /** Start was pressed before the analysis was ready: start once it is. */
  private pendingStart = false;

  constructor(getRoads: () => DrivableObject[], osmSource: OsmRoadSource | null = null, signalSource: TrafficSignalSource | null = null, getContext: () => SimulationContext = () => ({}),
    loadCounts: () => Promise<CountDataset> = () => fetchCountDataset(DEFAULT_COUNT_DATASET),
    loadCorrections: (() => Promise<unknown>) | null = () => apiGet<unknown>(`/api/network-corrections/${DEFAULT_CORRECTION_LAYER}`),
    loadScreenlines: (() => Promise<ScreenlineFile>) | null = () => fetchScreenlines()) {
    this.loadCounts = loadCounts;
    loadScreenlines?.().then(screenlines => this.setState({ screenlines })).catch(() => { /* no counts: the check is not shown */ });
    // Roads for the simulation: the project's roads with the correction layer (and the OSM
    // one-way implications) applied on top; the stored roads are never changed
    this.getRoads = () => {
      const raw = getRoads();
      if (this.roadsCache && this.roadsCache.n === raw.length && this.roadsCache.layer === this.correctionLayer && this.roadsCache.enabled === this.correctionsEnabled && this.roadsCache.rev === this.revision) return this.roadsCache.roads;
      const { roads, report } = applyNetworkCorrections(raw, this.correctionLayer, this.correctionsEnabled);
      this.lastCorrectionReport = report;
      // Free-flow speeds for a city (roadParameters.ts): OSM maxspeed, else a maxspeed of the same road, else an urban default
      const speeds = applyUrbanSpeeds(roads);
      this.speedReport = speeds.report;
      this.roadsCache = { n: raw.length, layer: this.correctionLayer, enabled: this.correctionsEnabled, rev: this.revision, roads: speeds.roads };
      return speeds.roads;
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
    this.syncArrows();
    this.listeners.forEach(cb => cb());
  }

  /**
   * The direction arrows follow the analysis on show: drawn for its
   * directions while Simulate is open and the result belongs to the selected
   * section, gone otherwise. Cheap when nothing changed (same result object).
   */
  private syncArrows() {
    const out = this.state.active ? this.state.analysis.output?.result : undefined;
    const section = this.state.section;
    const current = !!out && !!section && out.section.segmentKeys.length === section.segmentKeys.length && out.section.segmentKeys.every((k, i) => k === section.segmentKeys[i]);
    const dirs = current ? out!.directions : null;
    // A different direction list (another road, hour or proposal) may number its directions differently: start unhighlighted
    if (dirs !== this.arrowDirections) {
      this.arrowDirections = dirs;
      if (this.state.directionFocus.hover !== null || this.state.directionFocus.pinned !== null) this.state = { ...this.state, directionFocus: { hover: null, pinned: null } };
    }
    this.arrows.show(dirs);
    const f = this.state.directionFocus;
    this.arrows.setFocus(f.hover ?? f.pinned);
  }

  /** Pointer over a direction's row in the panel (null: left it). */
  public hoverDirection(index: number | null) {
    if (index !== null && !(index >= 0 && index < (this.arrowDirections?.length ?? 0))) index = null;
    if (this.state.directionFocus.hover === index) return;
    this.setState({ directionFocus: { ...this.state.directionFocus, hover: index } });
  }

  /**
   * Clicked a direction (its row, or its arrows on the map): highlights it
   * until clicked again. With `frame`, the camera flies to it, keeping its heading.
   */
  public pinDirection(index: number | null, frame = false) {
    if (index !== null && !(index >= 0 && index < (this.arrowDirections?.length ?? 0))) index = null;
    const pinned = index !== null && this.state.directionFocus.pinned === index ? null : index;
    this.setState({ directionFocus: { hover: null, pinned } });
    if (frame && pinned !== null) this.arrows.frame(pinned);
  }

  public isActive(): boolean {
    return this.state.active;
  }

  public setViewer(viewer: Viewer) {
    this.visualizer.setViewer(viewer);
    this.arrows.setViewer(viewer);
    this.trafficVisualizer.setViewer(viewer);
    if (this.state.active && this.state.area) this.visualizer.render(this.state.area, false);
  }

  public dispose() {
    this.stopAllComputation('');
    this.osmLoad?.abort();
    this.signalLoad?.abort();
    this.visualizer.dispose();
    this.arrows.dispose();
    this.trafficVisualizer.dispose();
  }

  /**
   * Stops everything that computes: the live view (animation frame, warm-up,
   * simulator), the road analysis, a baseline or comparison run, the
   * time-of-day runs and pending timers. Selections and finished results are
   * kept. `why` is shown once if something was interrupted.
   */
  private stopAllComputation(why: string) {
    const interrupted: string[] = [];
    if (this.state.analysis.status === 'running') interrupted.push('the road analysis');
    if (this.state.comparison.running) interrupted.push('the comparison run');
    if (this.state.timeline.status === 'running') interrupted.push('the time-of-day runs');
    this.cancelAnalysis();
    if (this.state.analysis.status === 'running') this.setState({ analysis: { ...this.state.analysis, status: this.state.analysis.output ? 'ready' : 'idle', progress: 0 } });
    if (this.comparisonRun || this.state.comparison.running) {
      this.comparisonRun?.cancel();
      this.comparisonRun = null;
      this.comparisonGeneration++;
      this.setState({ comparison: { ...this.state.comparison, running: false, progress: 0, staleReason: why ? `The run was stopped when you ${why}. Run it again.` : this.state.comparison.staleReason } });
    }
    this.cancelTimeline();
    this.calibrationGeneration++;
    if (this.state.calibration.status === 'measuring' || this.state.calibration.status === 'fitting') this.setCalibration({ status: 'idle', progress: 0 });
    this.cancelPendingRecompute();
    this.stopTraffic();
    if (why && interrupted.length) this.setState({ notice: `Stopped ${interrupted.join(' and ')} when you ${why}.` });
  }

  public enter() {
    if (this.state.active) return;
    this.setState({ active: true });
    this.visualizer.setFocus(true);
    // Coming back to a saved selection: show it again; its analysis is kept when nothing changed (nothing restarts by itself)
    if (this.state.seedRoadIds.length > 0) this.recompute(false, false);
  }

  /** Leaving Simulate (closing the panel or switching mode) stops all computation. The selection and results stay. */
  public exit() {
    if (!this.state.active) return;
    this.stopAllComputation('left Simulate');
    this.visualizer.clear();
    this.visualizer.setFocus(false);
    this.setState({ active: false, overlay: 'none' });
  }

  /** What is computing now (nothing, once stopped or closed). */
  public resources(): ResourceReport {
    let vehicles = 0;
    this.sim?.forEachVehicle(() => { vehicles++; });
    return { liveSim: this.sim !== null, animationFrame: this.frameHandle !== null, warmup: this.warmupHandle !== null, analysisRunning: this.analysisRun !== null,
      comparisonRunning: this.comparisonRun !== null, timelineRunning: this.timelineRun !== null,
      timers: [this.analysisTimer, this.recomputeTimer, this.warmupHandle].filter(t => t !== null).length, vehicles };
  }

  public dismissNotice() { if (this.state.notice) this.setState({ notice: null }); }

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
    this.cancelTimeline(true);
    // A new road: the live view stops (it belonged to the old one) and is started again by the user
    this.stopTraffic();
    this.setOverlay('none');
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
    this.cancelTimeline(true);
    this.cancelPendingRecompute();
    this.stopTraffic();
    this.visualizer.reset();
    this.cancelAnalysis();
    this.analysisNetworkKey = null;
    this.setState({ seedRoadIds: [], area: null, corridor: null, section: null, error: null, overlay: 'none', analysis: EMPTY_ANALYSIS, comparison: { ...this.state.comparison, showingProposal: false } });
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
    if (this.state.seedRoadIds.length > 0) this.recompute(true, false);
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
    // A run belongs to one area and network: any change stops the live view (the user starts it again)
    this.stopTraffic();
    try {
      const roads = this.getRoads();
      const area = this.explorer.explore(roads, this.revision, {
        seedRoadIds: this.state.seedRoadIds,
        rangeMeters: this.state.rangeMeters,
        direction: this.state.direction,
      });
      // The neighbourhood simulated vehicle by vehicle: the same network, a shorter range from the road
      const corridor = area.rangeMeters <= CORRIDOR_RANGE_M ? area : this.explorer.explore(roads, this.revision, { seedRoadIds: area.seedRoadIds, rangeMeters: CORRIDOR_RANGE_M, direction: this.state.direction });
      // Seeds deleted from the network drop out here
      const section = area.seedRoadIds.length ? roadSection(area, new Map(roads.map(r => [r.id, r])), area.seedRoadIds) : null;
      this.setState({ area, corridor, error: null, seedRoadIds: area.seedRoadIds, section, speeds: this.speedReport });
      // A kept result for another network or demand stays on show until its re-run lands: say so
      const shown = this.state.analysis;
      if (shown.output && !shown.outdated && shown.key !== this.analysisKey()) this.setState({ analysis: { ...shown, outdated: true } });
      this.refreshCountedJunctions();
      this.visualizer.render(area, reveal, new Set(section?.segmentKeys ?? []));
      // The selected road is the subject: the camera goes to it, not the whole area
      if (fly) this.focusView();
    } catch (err: any) {
      this.visualizer.clear();
      this.cancelAnalysis();
      this.analysisNetworkKey = null;
      this.setState({ area: null, corridor: null, section: null, error: err?.message || String(err), analysis: EMPTY_ANALYSIS, comparison: { ...this.state.comparison, showingProposal: false } });
    }
    this.ensureOsmRoads();
    this.ensureSignals();
    this.maybeAutoStart();
  }

  /** Runs the analysis once a road has been picked and its area is fully mapped (the live view only starts on request). */
  private maybeAutoStart() {
    if (!this.state.area || this.osmLoad || this.signalLoad || this.recomputeTimer) return; // roads or signals still arriving
    if (this.state.analysis.status === 'running') return;
    // A kept result for the same network, demand and hour is not re-run (e.g. after closing and reopening Simulate)
    if (this.state.analysis.output && this.state.analysis.key === this.analysisKey()) { this.analysisStale = false; this.redrawOverlay(); return; }
    if (this.state.analysis.status !== 'ready' || this.analysisStale) { this.analysisStale = false; this.scheduleAnalysis(); }
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
        this.maybeAutoStart();
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

  /**
   * Starts the live view of the selected road's neighbourhood. It runs on the
   * analysis's corridor demand (the same vehicles the figures come from), so
   * it waits for the analysis when that is still running. It first simulates
   * LIVE_WARMUP_S off screen, in slices, from an empty network, and then shows
   * the vehicles: the state on screen is one the model reached itself, not
   * vehicles placed by hand.
   */
  public startTraffic() {
    const area = this.state.area, corridor = this.state.corridor;
    if (!area || !corridor || this.state.traffic.status !== 'idle') return;
    const out = this.state.analysis.output;
    const fresh = out && this.state.analysis.key === this.analysisKey() && this.state.analysis.status === 'ready';
    if (!fresh) {
      // Waiting for the analysis: it provides the corridor's demand
      this.pendingStart = true;
      this.setTraffic({ status: 'preparing', preparing: { stage: 'analysis', progress: this.state.analysis.progress }, error: null });
      if (this.state.analysis.status !== 'running') { this.analysisStale = true; this.maybeAutoStart(); }
      return;
    }
    this.pendingStart = false;
    const roads = new Map(this.getRoads().map(r => [r.id, r]));
    const context = this.getContext();
    const plan = out.corridorPlan;
    const sim = new TrafficMicroSim(corridor, roads, {
      demandLevel: this.state.traffic.demandLevel,
      seed: this.state.traffic.seed,
      watchRoadIds: area.seedRoadIds, watchSegmentKeys: this.state.section?.segmentKeys,
      signalPoints: this.signalPoints ?? undefined, signalTiming: this.signalTiming,
      junctions: context.junctions,
      demandTrips: snapDemandPlan(plan, corridor.network, 60, new Set(corridor.segments.map(s => s.key))),
    });
    sim.setHourFactor(1);
    const metrics = sim.getMetrics();
    this.setTraffic({ demand: { ...plan.provenance }, hour: this.state.analysis.hour });
    if (metrics.entries === 0) {
      this.setTraffic({ status: 'idle', preparing: null, error: 'No traffic is routed through this road\'s neighbourhood at this hour, so there is nothing to show.' });
      return;
    }
    this.sim = sim;
    this.visualizer.setMarkersVisible(false);
    this.setTraffic({ status: 'preparing', preparing: { stage: 'warmup', progress: 0 }, metrics, error: null });
    const target = Math.round(this.state.traffic.warmupS / STEP_S);
    let done = 0;
    const slice = () => {
      this.warmupHandle = null;
      if (this.sim !== sim) return;
      const t0 = performance.now();
      while (done < target && performance.now() - t0 < WARMUP_SLICE_MS) { sim.step(); done++; }
      if (done < target) {
        this.setTraffic({ preparing: { stage: 'warmup', progress: done / target } });
        this.warmupHandle = setTimeout(slice, 0);
        return;
      }
      this.setTraffic({ status: 'running', preparing: null, metrics: sim.getMetrics() });
      this.startLoop();
    };
    this.warmupHandle = setTimeout(slice, 0);
  }

  public pauseTraffic() {
    if (this.state.traffic.status !== 'running') return;
    this.stopLoop();
    this.setTraffic({ status: 'paused', metrics: this.sim?.getMetrics() ?? null });
  }

  public resumeTraffic() {
    if (this.state.traffic.status !== 'paused') return;
    this.setTraffic({ status: 'running' });
    this.startLoop();
  }

  /**
   * Stops the live view and releases it: the animation frame, the warm-up and
   * the simulator go; vehicles are removed and the road colours restored.
   */
  public stopTraffic() {
    this.pendingStart = false;
    if (this.warmupHandle !== null) { clearTimeout(this.warmupHandle); this.warmupHandle = null; }
    const wasRunning = this.sim !== null;
    this.stopLoop();
    this.sim = null;
    if (this.state.selectedVehicleId !== null) this.setState({ selectedVehicleId: null });
    this.trafficVisualizer.clear();
    this.visualizer.setMarkersVisible(true);
    if (wasRunning && this.state.area && this.state.active) { this.visualizer.render(this.state.area, false, new Set(this.state.section?.segmentKeys ?? [])); this.redrawOverlay(); }
    const t = this.state.traffic;
    if (t.status !== 'idle' || t.metrics || t.error || t.preparing) this.setTraffic({ status: 'idle', metrics: null, error: null, preparing: null, hour: null });
  }

  /** Earlier name of stopTraffic. */
  public resetTraffic() { this.stopTraffic(); }

  /** Clears the vehicles and starts the live view again (a new warm-up, same seed). */
  public restartTraffic() {
    this.stopTraffic();
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
    this.stopTraffic();
    this.analysisStale = true;
    this.scheduleAnalysis();
  }

  // ── Road analysis ───────────────────────────────────────────────────────

  private simOptions(): AnalysisJob['options'] {
    const traffic = this.state.traffic;
    return { demandLevel: traffic.demandLevel, seed: traffic.seed, signalPoints: this.signalPoints ?? undefined, signalTiming: this.signalTiming, junctions: structuredClone(this.getContext().junctions) };
  }

  private analysisJob(plan: DemandPlan, area: StudyArea, section: RoadSection, measureS: number = DEFAULT_ANALYSIS.measureS, o: { hourFactor?: number; seeds?: readonly number[] } = {}): AnalysisJob {
    const ds = this.state.calibration.dataset;
    const corridor = this.state.corridor ?? area;
    return { area, corridor, roads: new Map(structuredClone(this.getRoads()).map(r => [r.id, r])), options: this.simOptions(), plan: structuredClone(plan), section,
      hourFactor: o.hourFactor ?? this.state.timeOfDay.factor, seeds: o.seeds ?? this.analysisSeeds, warmupS: DEFAULT_ANALYSIS.warmupS, measureS,
      countJunctions: ds ? junctionsIn(ds, corridor.bounds) : undefined };
  }

  /** Seeds every analysis runs (results are their mean, with the spread shown). */
  public analysisSeeds: readonly number[] = DEFAULT_ANALYSIS.seeds;

  /** What an analysis result depends on: a different key means it must be re-run. */
  private analysisKey() {
    const plan = this.studyPlan();
    return contentKey({ net: this.currentNetworkKey(), study: this.studyKey(), plan: plan ? contentKey({ n: plan.trips.length, v: Math.round(plan.provenance.vehiclesPerHour), src: plan.provenance.source }) : null,
      hour: this.state.timeOfDay.hour, day: this.state.timeOfDay.day, f: this.state.timeOfDay.factor, seeds: this.analysisSeeds, settings: this.state.demandSettings });
  }

  /** Re-runs the road analysis shortly (settings settle first). */
  private scheduleAnalysis(delayMs = 500) {
    if (this.analysisTimer) clearTimeout(this.analysisTimer);
    this.analysisTimer = null;
    if (!this.state.active || !this.state.area) return;
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
      this.setState({ analysis: { status: 'error', progress: 0, output: null, error: 'No traffic can be estimated for this area: no roads cross its edge and it holds no buildings or zones with activity.', hour: this.state.timeOfDay.hour, demandVph: 0, key: null } });
      if (this.pendingStart) { this.pendingStart = false; this.setTraffic({ status: 'idle', preparing: null, error: 'The live view needs the analysis, which could not run here.' }); }
      return null;
    }
    const hour = this.state.timeOfDay.hour, demandVph = plan.provenance.vehiclesPerHour * this.state.timeOfDay.factor;
    const key = this.analysisKey();
    this.setState({ analysis: { ...this.state.analysis, status: 'running', progress: 0, error: null, hour, demandVph } });
    const networkKey = this.currentNetworkKey();
    const run = startAnalysisJob(this.analysisJob(plan, area, section), progress => {
      if (this.analysisRun !== run) return;
      this.setState({ analysis: { ...this.state.analysis, progress } });
      if (this.pendingStart) this.setTraffic({ preparing: { stage: 'analysis', progress } });
    });
    this.analysisRun = run;
    try {
      const output = await run.promise;
      if (this.analysisRun !== run) return null;
      this.analysisRun = null;
      this.analysisNetworkKey = networkKey;
      this.setState({ analysis: { status: 'ready', progress: 1, output, error: null, hour, demandVph, key },
        comparison: { ...this.state.comparison, showingProposal: this.showsProposal(this.state.comparison.baseline) } });
      this.redrawOverlay();
      // Start was pressed while this was running: the live view can start now
      if (this.pendingStart && this.state.traffic.status === 'preparing') { this.setTraffic({ status: 'idle' }); this.startTraffic(); }
      return output;
    } catch (err) {
      if (this.analysisRun !== run) return null;
      this.analysisRun = null;
      this.setState({ analysis: { ...this.state.analysis, status: 'error', error: err instanceof Error ? err.message : String(err) } });
      if (this.pendingStart) { this.pendingStart = false; this.setTraffic({ status: 'idle', preparing: null, error: 'The live view needs the analysis, which failed.' }); }
      return null;
    }
  }

  /** Shows (or hides) where the section's traffic comes from and goes to on the map. */
  public showSelectLink(on: boolean) {
    this.setOverlay(on ? 'select-link' : 'none');
  }

  /**
   * What the map shows over the area: nothing extra, where the selected road's
   * traffic comes from and goes (select-link), how full every road is
   * (volume/capacity), the traced queue behind the road's delay, or what a
   * proposal changed. One at a time.
   */
  public setOverlay(overlay: MapOverlay) {
    if (overlay === this.state.overlay && overlay !== 'none') { this.redrawOverlay(); return; }
    this.setState({ overlay });
    this.redrawOverlay();
  }

  private redrawOverlay() {
    if (!this.state.active) return;
    const out = this.state.analysis.output?.result;
    const kind = this.state.overlay;
    this.visualizer.showSelectLink(null);
    if (kind === 'none' || !out) { this.visualizer.showOverlay(null); return; }
    if (kind === 'select-link') { this.visualizer.showOverlay(null); this.visualizer.showSelectLink(out.selectLinkVph); return; }
    if (kind === 'area-vc') {
      this.visualizer.showOverlay(key => { const vc = out.areaVc.get(key); return vc === undefined ? null : { css: vcColour(vc), alpha: vc < 0.3 ? 0.35 : 0.9 }; },
        out.areaBottlenecks.slice(0, 5).map((b, i) => ({ coordinates: b.coordinates, label: `${i + 1}. ${b.roadName} ${Math.round(b.vc * 100)}%`, css: '#f43f5e' })));
      return;
    }
    if (kind === 'cause') {
      const chain = out.cause.chain;
      const keys = new Set(chain?.segmentKeys ?? []), section = new Set(out.section.segmentKeys);
      this.visualizer.showOverlay(key => section.has(key) ? { css: '#67e8f9', alpha: 1 } : keys.has(key) ? { css: '#f43f5e', alpha: 1 } : null,
        chain?.root ? [{ coordinates: [chain.root.coordinates[0], chain.root.coordinates[1], 0], label: `Queue starts here: ${chain.root.label}`, css: '#f43f5e' }] : []);
      return;
    }
    if (kind === 'comparison') {
      const c = this.state.comparison.result;
      if (!c) { this.visualizer.showOverlay(null); return; }
      const change = c.segmentChange;
      this.visualizer.showOverlay(key => { const d = change.get(key); if (d === undefined || Math.abs(d) < 0.05) return null; return { css: d < 0 ? '#34d399' : '#f43f5e', alpha: Math.min(1, 0.4 + Math.abs(d)) }; },
        [...c.newBottlenecks.map(b => ({ coordinates: b.coordinates, label: `New bottleneck: ${b.roadName}`, css: '#f43f5e' }))]);
    }
  }

  // ── Existing city against a proposal ────────────────────────────────────

  private baselineRoads: Map<string, DrivableObject> | null = null;

  private snapshotOf(output: AnalysisOutput, plan: DemandPlan, measureS: number): TrafficRunSnapshot {
    const traffic = this.state.traffic, context = this.getContext();
    return { scenarioId: context.scenarioId ?? 'current', durationS: measureS, seed: traffic.seed, demandLevel: traffic.demandLevel, focus: traffic.focus,
      hour: this.state.timeOfDay.hour, hourFactor: this.state.timeOfDay.factor,
      demandKey: contentKey(plan), networkKey: this.currentNetworkKey(),
      metrics: output.result.network, demandVph: plan.provenance.vehiclesPerHour * this.state.timeOfDay.factor, analysis: output };
  }

  private currentNetworkKey() {
    return networkContentKey(this.getRoads(), this.getContext().junctions, this.signalPoints);
  }

  /** Whether the analysis on show ran on a network other than the baseline's. */
  private showsProposal(baseline: TrafficRunSnapshot | null) {
    return !!baseline && this.analysisNetworkKey !== null && this.analysisNetworkKey !== baseline.networkKey;
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
      this.setState({ comparison: { baseline, current: null, result: null, staleReason: null, running: false, progress: 1, demandChanged: false, showingProposal: this.showsProposal(baseline) } });
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
      this.setState({ comparison: { ...this.state.comparison, baseline, current, result, staleReason: null, running: false, progress: 1, demandChanged } });
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
    this.setState({ timeOfDay: next });
    if (next.hour !== prev.hour || next.day !== prev.day || next.factor !== prev.factor) {
      // A different hour is different demand and routes: the live view of the old hour stops; the analysis re-runs
      const wasLive = this.state.traffic.status !== 'idle';
      this.stopTraffic();
      this.analysisStale = true;
      this.scheduleAnalysis(700);
      if (wasLive) this.startTraffic();
    }
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
    this.setTimeOfDay({ hour: ((Math.round(hour) % 24) + 24) % 24 });
  }

  /** Morning peak, midday, evening peak or night: the hour that stands for the period. */
  public setPeriod(id: DayPeriodId) {
    const p = DAY_PERIODS.find(x => x.id === id);
    if (p) this.setHour(p.hour);
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

  // ── The selected road through the day ─────────────────────────────────

  /**
   * Runs the analysis at each period of the day (morning peak, midday,
   * evening peak, night) on the same network: one run each (seed 42), so
   * differences under about 10% are within run-to-run noise. This replaces the
   * earlier "Play 24 h", which only scaled arrival rates once a simulated
   * minute: no hour ever reached its own traffic state, and the morning to
   * evening switch at noon cleared every vehicle.
   */
  public async runTimeline(): Promise<boolean> {
    this.flushPendingRecompute();
    const area = this.state.area, section = this.state.section;
    if (!area || !section || !this.state.timeOfDay.profile) { await this.ensureTimeProfile(); }
    const profile = this.state.timeOfDay.profile;
    if (!area || !section || !profile) return false;
    this.cancelTimeline();
    const generation = ++this.timelineGeneration;
    const key = contentKey({ net: this.currentNetworkKey(), study: this.studyKey(), settings: this.state.demandSettings, day: this.state.timeOfDay.day });
    const rows: TimelineState['rows'] = DAY_PERIODS.map(p => ({ period: p.id, label: p.label, hour: p.hour, demandVph: 0, result: null }));
    this.setState({ timeline: { status: 'running', progress: 0, rows, error: null, key } });
    try {
      for (let i = 0; i < DAY_PERIODS.length; i++) {
        const p = DAY_PERIODS[i];
        // Land-use trips follow the half of the day; the hour's share of daily traffic scales them
        const period = p.hour < 12 ? 'AM_Peak' : 'PM_Peak';
        const ctx = { ...this.getContext(), period } as SimulationContext;
        const base = this.calibratedPlan ?? compileAreaDemand(ctx, area, new Map(this.getRoads().map(r => [r.id, r])), { through: this.state.demandSettings.through });
        if (!base) throw new Error('No traffic can be estimated for this area.');
        const reference = this.calibratedPlan ? COUNT_HOURS[this.state.timeOfDay.countPeak] : COUNT_HOURS[p.hour < 12 ? 'AM' : 'PM'];
        const factor = hourFactor(profile, p.hour, reference, this.state.timeOfDay.day);
        const run = startAnalysisJob(this.analysisJob(base, area, section, DEFAULT_ANALYSIS.measureS, { hourFactor: factor, seeds: [DEFAULT_TRAFFIC_SEED] }), progress => {
          if (generation === this.timelineGeneration) this.setState({ timeline: { ...this.state.timeline, progress: (i + progress) / DAY_PERIODS.length } });
        });
        this.timelineRun = run;
        const out = await run.promise;
        if (generation !== this.timelineGeneration) return false;
        rows[i] = { ...rows[i], demandVph: base.provenance.vehiclesPerHour * factor, result: out.result };
        this.setState({ timeline: { ...this.state.timeline, rows: [...rows], progress: (i + 1) / DAY_PERIODS.length } });
      }
      this.timelineRun = null;
      this.setState({ timeline: { ...this.state.timeline, status: 'ready', progress: 1 } });
      return true;
    } catch (err) {
      if (generation !== this.timelineGeneration) return false;
      this.timelineRun = null;
      this.setState({ timeline: { ...this.state.timeline, status: 'error', error: err instanceof Error ? err.message : String(err) } });
      return false;
    }
  }

  /** Stops the time-of-day runs (clear: also forget their rows). */
  public cancelTimeline(clear = false) {
    this.timelineGeneration++;
    this.timelineRun?.cancel();
    this.timelineRun = null;
    if (clear) { if (this.state.timeline.rows.length || this.state.timeline.status !== 'idle') this.setState({ timeline: EMPTY_TIMELINE }); }
    else if (this.state.timeline.status === 'running') this.setState({ timeline: { ...this.state.timeline, status: 'idle', progress: 0 } });
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
    this.setState({ comparison: { baseline: null, current: null, result: null, staleReason: null, running: false, progress: 0, demandChanged: false, showingProposal: false } });
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
