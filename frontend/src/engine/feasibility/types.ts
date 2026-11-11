import type { LngLat } from './geometry';

/** Certainty labels (mission §7; docs/INVESTIGATION_REQUIREMENTS.md §3). */
export type Certainty =
  | 'verified_from_available_data'
  | 'estimated'
  | 'inferred'
  | 'unknown'
  | 'requires_field_investigation'
  | 'requires_professional_assessment';

export const CERTAINTY_LABEL: Record<Certainty, string> = {
  verified_from_available_data: 'Verified from available data',
  estimated: 'Estimated',
  inferred: 'Inferred',
  unknown: 'Unknown',
  requires_field_investigation: 'Requires field investigation',
  requires_professional_assessment: 'Requires professional assessment',
};

export type ProposalType =
  | 'junction_redesign' | 'road_widening' | 'additional_lane' | 'new_road' | 'bridge'
  | 'flyover' | 'underpass' | 'elevated_corridor' | 'interchange' | 'ramp_link'
  | 'tunnel' | 'underground_road';

export type ProposalLevel = 'surface' | 'elevated' | 'underground';

export interface ProposalInput {
  name: string;
  scenarioId: string;
  /** Immutable scenario version, when the scenario module provides one. */
  scenarioVersion?: string | null;
  objectIds: string[];
  proposalType: ProposalType;
  level: ProposalLevel;
  line: LngLat[];
  widthM: number;
  /** Max excavation/foundation depth if the user knows it; null = unknown. */
  excavationDepthM: number | null;
}

export type AttrValue = number | boolean | string;
export interface SiteAttribute {
  value: AttrValue | 'unknown';
  certainty: Certainty;
  source: string;
  note?: string;
}
export type SiteAttributes = Record<string, SiteAttribute>;

export type FindingTopic =
  | 'buildings' | 'land_row' | 'existing_roads' | 'structures' | 'metro' | 'railway'
  | 'water' | 'flood' | 'heritage' | 'trees' | 'utilities' | 'ground' | 'proposal';

export interface Finding {
  id: string;
  topic: FindingTopic;
  /** constraint = data shows something that restricts; gap = data missing; context = neutral fact */
  kind: 'constraint' | 'gap' | 'context';
  statement: string;
  certainty: Certainty;
  source: string;
  attr?: string;
}

export interface LayerStatus {
  available: boolean;
  source?: string;
  dataTimestamp?: string | null;
  reason?: string;
}

/** Overpass-shaped OSM elements as served by /api/feasibility/site-data. */
export interface OsmElement {
  type: 'node' | 'way' | 'relation' | 'area';
  id: number;
  tags?: Record<string, string>;
  lon?: number; lat?: number;
  geometry?: { lon: number; lat: number }[];
  members?: { role: string; geometry: { lon: number; lat: number }[] }[];
  outer?: { lon: number; lat: number }[][];
}

export type SiteLayerKey = 'buildings' | 'metro' | 'roads' | 'water' | 'heritage' | 'trees' | 'railway';

export interface SiteData {
  bbox: [number, number, number, number];
  layers: Record<SiteLayerKey, LayerStatus>;
  elements: Partial<Record<SiteLayerKey, OsmElement[]>>;
}

/** Objects of the current scenario's city model that bear on the site (not the proposal itself). */
export interface CityContextObject {
  id: string;
  type: 'building' | 'road' | 'flyover' | 'metro_line' | 'metro_flyover' | 'utility';
  name: string;
  coordinates: [number, number, number][];
  osmId?: number;
  widthM?: number;
  rowWidthM?: number;
  rowConfidence?: string;
  utilityType?: string;
  tunnel?: boolean;
  bridge?: boolean;
}

export type Tri = true | false | 'unknown';

export interface RuleResult {
  id: string;
  title: string;
  applies: boolean;
  result: Tri;
  missing: string[];
  /** attribute → value/certainty used, so an excluded rule says what excluded it */
  evidence: { attr: string; value: AttrValue | 'unknown'; certainty: Certainty; source: string }[];
}

export interface RequiredInvestigation {
  id: string;
  name: string;
  methods: string[];
  deliverables: string[];
  disciplines: string[];
  standards: string[];
  authorities: string[];
  triggeredBy: string[];
  sourceRefs: string[];
  certainty: Certainty;
  /** at least one triggering rule evaluated unknown (fired on missing data) */
  firedOnMissingData: boolean;
}

export interface PlanFlag { ruleId: string; severity: 'critical' | 'high' | 'info'; text: string; onMissingData: boolean }
export interface DataGap { ruleId: string; title: string; attrs: string[] }

export interface InvestigationPlan {
  rulesVersion: string;
  ruleResults: RuleResult[];
  investigations: RequiredInvestigation[];
  flags: PlanFlag[];
  dataGaps: DataGap[];
  disciplines: string[];
  standards: string[];
  authorities: string[];
  sources: { id: string; title: string; url?: string; evidence?: string }[];
  thresholdsUsed: { key: string; value: number; unit?: string; basis: string; note?: string }[];
}

export interface FeasibilityAssessment {
  engineVersion: string;
  assessedAt: string;
  proposal: ProposalInput;
  lengthM: number;
  centroid: LngLat;
  siteAttributes: SiteAttributes;
  findings: Finding[];
  plan: InvestigationPlan;
  layers: Record<SiteLayerKey, LayerStatus>;
  disclaimer: string;
  /** Never 'feasible'. The engine screens; it does not decide. */
  verdict: 'screening_only';
}
