/**
 * Spatial Feasibility Engine (mission §7): computes site attributes for a drawn
 * proposal from the data that is actually available, each with a certainty
 * label and its dataset, then hands them to the investigation planner.
 *
 * Asymmetry rule (docs/INVESTIGATION_REQUIREMENTS.md §3): data may RESTRICT
 * (a mapped building in the influence zone is "verified from available data")
 * but an ABSENCE in OSM never clears a constraint — it is `unknown`, or at most
 * a screening value labelled `estimated` where the spec says so (distance to
 * the nearest *mapped* waterway). The engine never returns "feasible".
 */
import {
  bboxAround, centroid, lineLengthM, polylineDistance, polylineToPolygonDistance, projector,
  type LngLat, type Projector, type XY,
} from './geometry';
import { planInvestigations, resolveThresholds, RULES } from './investigationPlanner';
import type {
  CityContextObject, FeasibilityAssessment, Finding, OsmElement, ProposalInput, ProposalType, SiteAttribute,
  SiteAttributes, SiteData, SiteLayerKey,
} from './types';

export const ENGINE_VERSION = 'feasibility-engine 1.0 (2026-11-11)';

export const UNDERGROUND_TYPES: ProposalType[] = ['tunnel', 'underground_road'];
export const PROPOSAL_TYPE_LABEL: Record<ProposalType, string> = {
  new_road: 'New road', road_widening: 'Road widening', additional_lane: 'Additional lane', junction_redesign: 'Junction redesign',
  bridge: 'Bridge', flyover: 'Flyover', underpass: 'Underpass', elevated_corridor: 'Elevated corridor', interchange: 'Interchange',
  ramp_link: 'Ramp / connecting link', tunnel: 'Tunnel', underground_road: 'Underground road',
};

/** Search radius for "nearest mapped feature" lookups (m). Beyond it the value is unknown. */
export const SEARCH_RADIUS_M = 1000;

interface Feat { kind: 'point' | 'line' | 'polygon'; rings: XY[][]; tags: Record<string, string>; label: string; ref: string }

function elementToFeat(e: OsmElement, pr: Projector, forcePolygon = false): Feat | null {
  const tags = e.tags ?? {};
  const label = tags.name || tags['name:en'] || '';
  const ref = `OSM ${e.type === 'area' ? (e as { fromWay?: boolean }).fromWay ? 'way' : 'relation' : e.type} ${e.id}`;
  const conv = (g: { lon: number; lat: number }[]) => g.map(p => pr.toXY([p.lon, p.lat]));
  if (e.type === 'node' && e.lon !== undefined && e.lat !== undefined) return { kind: 'point', rings: [[pr.toXY([e.lon, e.lat])]], tags, label, ref };
  if (e.type === 'area' && e.outer?.length) return { kind: 'polygon', rings: e.outer.map(conv), tags, label, ref };
  if (e.type === 'relation' && e.members?.length) {
    const outers = e.members.filter(m => m.role !== 'inner').map(m => conv(m.geometry));
    return outers.length ? { kind: 'polygon', rings: outers, tags, label, ref } : null;
  }
  if (e.type === 'way' && e.geometry && e.geometry.length >= 2) {
    const g = conv(e.geometry);
    const closed = e.geometry.length >= 4 && e.geometry[0].lon === e.geometry[e.geometry.length - 1].lon && e.geometry[0].lat === e.geometry[e.geometry.length - 1].lat;
    return { kind: forcePolygon || (closed && !tags.waterway && !tags.highway && !tags.railway) ? 'polygon' : 'line', rings: [g], tags, label, ref };
  }
  return null;
}

function distTo(f: Feat, line: XY[]): number {
  let best = Infinity;
  for (const r of f.rings) best = Math.min(best, f.kind === 'polygon' ? polylineToPolygonDistance(line, r) : polylineDistance(line, r));
  return best;
}

const fmtM = (m: number) => (m < 10 ? m.toFixed(1) : Math.round(m).toString()) + ' m';
const attr = (value: SiteAttribute['value'], certainty: SiteAttribute['certainty'], source: string, note?: string): SiteAttribute =>
  ({ value, certainty, source, ...(note ? { note } : {}) });

function layerSource(site: SiteData, k: SiteLayerKey, base: string) {
  const L = site.layers[k];
  return L?.available ? `${base} (${L.source ?? 'OSM extract'}${L.dataTimestamp ? `, data ${L.dataTimestamp}` : ''})` : base;
}

export interface AssessOptions { thresholdOverrides?: Record<string, number>; now?: () => Date }

export function assessFeasibility(p: ProposalInput, site: SiteData, city: CityContextObject[], opts: AssessOptions = {}): FeasibilityAssessment {
  const th = resolveThresholds(opts.thresholdOverrides);
  const c = centroid(p.line);
  const pr = projector(c[0], c[1]);
  const line = p.line.map(pt => pr.toXY(pt));
  const half = Math.max(0, p.widthM) / 2;
  const influence = th.influenceZoneM.value;
  const findings: Finding[] = [];
  const A: SiteAttributes = {};
  let fid = 0;
  const add = (f: Omit<Finding, 'id'>) => findings.push({ id: `F${String(++fid).padStart(2, '0')}`, ...f });
  const isUnderground = p.level === 'underground' || UNDERGROUND_TYPES.includes(p.proposalType);
  const feats = (k: SiteLayerKey, poly = false) =>
    (site.elements[k] ?? []).map(e => elementToFeat(e, pr, poly)).filter((x): x is Feat => !!x);
  const L = (k: SiteLayerKey) => !!site.layers[k]?.available;
  const ownIds = new Set(p.objectIds);
  const ctx = city.filter(o => !ownIds.has(o.id));
  const ctxLine = (o: CityContextObject) => o.coordinates.map(q => pr.toXY([q[0], q[1]] as LngLat));

  // ── proposal facts ────────────────────────────────────────────────────────
  A.proposalType = attr(p.proposalType, 'verified_from_available_data', 'Proposal definition (user input)');
  A.hasConstructionFootprint = attr(true, 'inferred', 'Proposal type (physical works)');
  A.isUnderground = attr(isUnderground, 'inferred', `Proposal type/level (${p.level})`);
  A.excavationDepthM = p.excavationDepthM == null
    ? attr('unknown', 'unknown', 'Not provided', 'Excavation/foundation depth is set by design and investigation; not known at screening stage.')
    : attr(p.excavationDepthM, 'estimated', 'User-entered planning assumption');
  add({ topic: 'proposal', kind: 'context', certainty: 'estimated', source: 'Drawn geometry (conceptual, not a design)',
    statement: `${PROPOSAL_TYPE_LABEL[p.proposalType]} at ${p.level} level, ${fmtM(lineLengthM(p.line))} long, ${p.widthM} m wide as drawn.` });

  // ── buildings ─────────────────────────────────────────────────────────────
  const bldgs: { label: string; ref: string; d: number }[] = [];
  const seenOsm = new Set<number>();
  for (const o of ctx.filter(o => o.type === 'building' && o.coordinates.length >= 3)) {
    if (o.osmId) seenOsm.add(o.osmId);
    bldgs.push({ label: o.name, ref: `city object ${o.id}`, d: polylineToPolygonDistance(line, ctxLine(o)) });
  }
  for (const e of site.elements.buildings ?? []) {
    if (seenOsm.has(e.id)) continue;
    const f = elementToFeat(e, pr, true);
    if (f) bldgs.push({ label: f.label, ref: f.ref, d: distTo(f, line) });
  }
  const zone = half + influence;
  const inFootprint = bldgs.filter(b => b.d <= half);
  const inZone = bldgs.filter(b => b.d <= zone);
  const bSrc = layerSource(site, 'buildings', 'OSM building=* + city-model buildings');
  if (!L('buildings') && !ctx.some(o => o.type === 'building')) {
    A.buildingsInInfluenceZone = attr('unknown', 'unknown', 'No building layer available', site.layers.buildings?.reason);
    add({ topic: 'buildings', kind: 'gap', certainty: 'unknown', source: 'Building layer not available', attr: 'buildingsInInfluenceZone',
      statement: 'Buildings near the alignment are unknown: no building data was available for this area.' });
  } else if (inZone.length === 0) {
    A.buildingsInInfluenceZone = attr('unknown', 'unknown', bSrc, 'No mapped building within the zone; OSM absence is not proof of absence (spec: absence = unknown, not zero).');
    add({ topic: 'buildings', kind: 'gap', certainty: 'unknown', source: bSrc, attr: 'buildingsInInfluenceZone',
      statement: `No mapped building within ${fmtM(zone)} of the centreline. Unmapped structures may exist; confirm by topographic survey.` });
  } else {
    A.buildingsInInfluenceZone = attr(inZone.length, 'verified_from_available_data', bSrc, `Influence zone = half width ${fmtM(half)} + ${influence} m (${th.influenceZoneM.basis}). Count is a lower bound.`);
    add({ topic: 'buildings', kind: 'constraint', certainty: 'verified_from_available_data', source: bSrc, attr: 'buildingsInInfluenceZone',
      statement: `${inZone.length} mapped building(s) within ${fmtM(zone)} of the centreline (influence-zone buffer ${influence} m is a hypothetical screening value).` });
    if (inFootprint.length > 0) {
      const names = inFootprint.filter(b => b.label).slice(0, 4).map(b => b.label);
      add({ topic: 'buildings', kind: 'constraint', certainty: 'verified_from_available_data', source: bSrc,
        statement: isUnderground
          ? `${inFootprint.length} mapped building(s) stand directly above the drawn underground footprint${names.length ? ` (e.g. ${names.join(', ')})` : ''}. Foundation depths are unknown.`
          : `${inFootprint.length} mapped building(s) intersect the drawn ${p.widthM} m footprint${names.length ? ` (e.g. ${names.join(', ')})` : ''}: the alignment cannot be built as drawn without affecting them.` });
    }
  }

  // ── existing roads, right-of-way, structures ──────────────────────────────
  const roadFeats = feats('roads');
  const roadsNear = roadFeats.map(f => ({ f, d: distTo(f, line) })).filter(x => x.d <= Math.max(half, 5));
  const tagged = roadsNear.filter(x => x.f.tags.width);
  const ctxRoads = ctx.filter(o => (o.type === 'road' || o.type === 'flyover' || o.type === 'metro_flyover') && o.coordinates.length >= 2)
    .map(o => ({ o, d: polylineDistance(line, ctxLine(o)) })).filter(x => x.d <= Math.max(half, 5));
  if (roadsNear.length || ctxRoads.length) {
    const desc = roadsNear.slice(0, 5).map(x => `${x.f.label || x.f.tags.highway}${x.f.tags.width ? ` width=${x.f.tags.width}` : ''}${x.f.tags.lanes ? ` lanes=${x.f.tags.lanes}` : ''}`);
    add({ topic: 'existing_roads', kind: 'context', certainty: 'verified_from_available_data', source: layerSource(site, 'roads', 'OSM highway=*'),
      statement: `Alignment overlaps or touches ${roadsNear.length} mapped road way(s)${desc.length ? `: ${desc.join('; ')}` : ''}.` });
  }
  const tagWidths = tagged.map(x => parseFloat(x.f.tags.width)).filter(Number.isFinite);
  const rowCtx = ctxRoads.map(x => x.o.rowWidthM).filter((w): w is number => typeof w === 'number' && w > 0);
  if (tagWidths.length) {
    add({ topic: 'land_row', kind: 'context', certainty: 'estimated', source: 'OSM width=* tag',
      statement: `Existing carriageway width tagged in OSM: ${[...new Set(tagWidths)].join(', ')} m. An OSM width tag is not the legal right-of-way.` });
  }
  if (rowCtx.length) {
    add({ topic: 'land_row', kind: 'context', certainty: 'estimated', source: 'City-model road section profile (importer default or user edit)',
      statement: `Road section profile gives a right-of-way of ${[...new Set(rowCtx.map(w => Math.round(w)))].join(', ')} m (confidence: ${ctxRoads.map(x => x.o.rowConfidence ?? 'unknown')[0]}).` });
  }
  const knownRow = [...tagWidths, ...rowCtx];
  if (!isUnderground && inFootprint.length > 0 && p.proposalType !== 'flyover' && p.proposalType !== 'elevated_corridor') {
    A.outsideExistingRoW = attr(true, 'inferred', bSrc, 'Mapped buildings inside the drawn footprint imply land outside any road right-of-way.');
  } else if (!isUnderground && knownRow.length && (p.proposalType === 'road_widening' || p.proposalType === 'additional_lane') && p.widthM > Math.max(...knownRow)) {
    A.outsideExistingRoW = attr(true, 'estimated', 'Drawn width vs OSM width tag / section profile', `Drawn ${p.widthM} m > known ${Math.max(...knownRow)} m.`);
  } else {
    A.outsideExistingRoW = attr('unknown', 'unknown', 'No DP road-line / city-survey boundary imported',
      'Right-of-way is unknown unless the DP road line or city survey boundary is imported (docs/RESEARCH_FEASIBILITY_AND_INVESTIGATION.md).');
  }
  add({ topic: 'land_row', kind: A.outsideExistingRoW.value === true ? 'constraint' : 'gap', certainty: A.outsideExistingRoW.certainty, source: A.outsideExistingRoW.source, attr: 'outsideExistingRoW',
    statement: A.outsideExistingRoW.value === true
      ? 'Footprint appears to extend beyond the existing road; land availability and ownership cannot be established from maps.'
      : 'Whether the footprint stays within the legal right-of-way is unknown (no DP road line imported). An empty-looking map does not prove land is available.' });

  const near = Math.max(zone, 30);
  const structs = roadFeats.filter(f => (f.tags.bridge && f.tags.bridge !== 'no') || (f.tags.tunnel && f.tags.tunnel !== 'no') || Number(f.tags.layer) !== 0 && f.tags.layer !== undefined)
    .map(f => ({ f, d: distTo(f, line) })).filter(x => x.d <= near);
  const ctxStructs = ctx.filter(o => o.type === 'flyover' || o.type === 'metro_flyover' || o.tunnel || o.bridge)
    .filter(o => !(o.osmId && structs.some(x => x.f.ref.endsWith(` ${o.osmId}`))))
    .map(o => ({ o, d: polylineDistance(line, ctxLine(o)) })).filter(x => x.d <= near).sort((a, b) => a.d - b.d);
  if (ctxStructs.length) {
    add({ topic: 'structures', kind: 'constraint', certainty: 'verified_from_available_data', source: 'City-model objects (current scenario)',
      statement: `${ctxStructs.length} flyover/bridge/tunnel object(s) in the city model within ${fmtM(near)} (nearest "${ctxStructs[0].o.name}", ${fmtM(ctxStructs[0].d)}): clearance, foundations and interfaces need design checks.` });
  }
  if (structs.length) {
    const tunnels = structs.filter(x => x.f.tags.tunnel && x.f.tags.tunnel !== 'no');
    const bridges = structs.filter(x => x.f.tags.bridge && x.f.tags.bridge !== 'no');
    add({ topic: 'structures', kind: 'constraint', certainty: 'verified_from_available_data', source: layerSource(site, 'roads', 'OSM bridge=*/tunnel=*/layer=*'),
      statement: `Mapped grade-separated road structures within ${fmtM(near)}: ${bridges.length} bridge/flyover way(s)${bridges[0]?.f.label ? ` (e.g. ${bridges[0].f.label})` : ''}, ${tunnels.length} tunnel/underpass way(s)${tunnels[0]?.f.label ? ` (e.g. ${tunnels[0].f.label})` : ''}. Their foundations and depths are not in the data.` });
  }

  // ── metro ─────────────────────────────────────────────────────────────────
  const metroLines = [
    ...feats('metro').filter(f => f.kind === 'line').map(f => ({ label: f.label || f.tags.name || 'metro alignment', d: distTo(f, line), src: f.ref })),
    ...ctx.filter(o => o.type === 'metro_line' || o.type === 'metro_flyover').map(o => ({ label: o.name, d: polylineDistance(line, ctxLine(o)), src: `city object ${o.id}` })),
  ].sort((a, b) => a.d - b.d);
  const mSrc = layerSource(site, 'metro', 'OSM railway=subway (+ construction) and city-model metro lines');
  if (metroLines.length && metroLines[0].d <= SEARCH_RADIUS_M) {
    A.distanceToMetroM = attr(Math.round(metroLines[0].d * 10) / 10, 'verified_from_available_data', mSrc, 'Distance to mapped alignment centreline, not to the structure edge; MahaMetro records are authoritative.');
    add({ topic: 'metro', kind: metroLines[0].d <= th.metroPlanningAuthorityM.value ? 'constraint' : 'context', certainty: 'verified_from_available_data', source: mSrc, attr: 'distanceToMetroM',
      statement: `Mapped metro alignment "${metroLines[0].label}" is ${fmtM(metroLines[0].d)} from the proposal centreline (MahaMetro NOC threshold ${th.metroNocM.value} m and planning area ${th.metroPlanningAuthorityM.value} m are ${th.metroNocM.basis.replace('_', ' ')}s to confirm).` });
  } else {
    A.distanceToMetroM = attr('unknown', 'unknown', mSrc, `No mapped metro within ${SEARCH_RADIUS_M} m; underground metro alignments may be incompletely mapped.`);
    add({ topic: 'metro', kind: 'gap', certainty: 'unknown', source: mSrc, attr: 'distanceToMetroM',
      statement: `No mapped metro alignment within ${SEARCH_RADIUS_M} m. Absence in OSM is not proof; obtain MahaMetro alignment records.` });
  }

  // ── railway ───────────────────────────────────────────────────────────────
  const RAIL = new Set(['rail', 'light_rail', 'narrow_gauge', 'tram']);
  const rails = feats('railway').filter(f => f.kind === 'line' && (RAIL.has(f.tags.railway) || (f.tags.railway === 'construction' && RAIL.has(f.tags.construction))));
  const rSrc = layerSource(site, 'railway', 'OSM railway=rail/light_rail/narrow_gauge/tram');
  const railD = rails.map(f => ({ f, d: distTo(f, line) })).sort((a, b) => a.d - b.d);
  if (!L('railway')) {
    A.crossesRailway = attr('unknown', 'unknown', 'Railway layer not available', site.layers.railway?.reason);
  } else if (railD.length && railD[0].d <= half) {
    A.crossesRailway = attr(true, 'verified_from_available_data', rSrc);
    add({ topic: 'railway', kind: 'constraint', certainty: 'verified_from_available_data', source: rSrc, attr: 'crossesRailway',
      statement: `Alignment crosses or abuts a mapped railway${railD[0].f.label ? ` (${railD[0].f.label})` : ''}.` });
  } else {
    A.crossesRailway = attr(false, 'estimated', rSrc, railD.length ? `Nearest mapped railway ${fmtM(railD[0].d)}.` : 'No mapped railway in the search area; railway land boundaries are not in OSM.');
  }

  // ── water ─────────────────────────────────────────────────────────────────
  const wSrc = layerSource(site, 'water', 'OSM waterway=* / natural=water / water=*');
  const water = feats('water').map(f => ({ f, d: distTo(f, line) })).sort((a, b) => a.d - b.d);
  if (!L('water')) {
    A.distanceToWaterwayM = attr('unknown', 'unknown', 'Water layer not available', site.layers.water?.reason);
    A.crossesWaterway = attr('unknown', 'unknown', 'Water layer not available', site.layers.water?.reason);
    add({ topic: 'water', kind: 'gap', certainty: 'unknown', source: 'Water layer not available', attr: 'distanceToWaterwayM',
      statement: 'Water bodies and waterways near the proposal are unknown: no water layer was available.' });
  } else {
    const nearest = water[0];
    const crosses = !!nearest && nearest.d <= half;
    A.crossesWaterway = crosses
      ? attr(true, 'verified_from_available_data', wSrc)
      : attr(false, 'estimated', wSrc, 'No mapped waterway crosses the footprint; small drains (nallahs) are often unmapped.');
    if (nearest && nearest.d <= SEARCH_RADIUS_M) {
      const what = nearest.f.label || nearest.f.tags.waterway || nearest.f.tags.water || nearest.f.tags.natural || 'water feature';
      A.distanceToWaterwayM = attr(Math.round(nearest.d * 10) / 10, 'verified_from_available_data', wSrc, 'Distance to the nearest MAPPED water feature; an unmapped one may be closer.');
      add({ topic: 'water', kind: crosses || nearest.d <= th.waterProximityM.value ? 'constraint' : 'context', certainty: 'verified_from_available_data', source: wSrc, attr: 'distanceToWaterwayM',
        statement: crosses ? `Alignment crosses mapped water feature "${what}".` : `Nearest mapped water feature "${what}" is ${fmtM(nearest.d)} away (screening buffer ${th.waterProximityM.value} m is hypothetical).` });
    } else {
      A.distanceToWaterwayM = attr('unknown', 'unknown', wSrc, `No mapped water feature within ${SEARCH_RADIUS_M} m.`);
      add({ topic: 'water', kind: 'gap', certainty: 'unknown', source: wSrc, attr: 'distanceToWaterwayM',
        statement: `No mapped water feature within ${SEARCH_RADIUS_M} m. Not proof of absence; drains and culverts need survey.` });
    }
  }
  A.withinBlueLine = attr('unknown', 'unknown', 'WRD flood-line layer not imported');
  A.withinRedLine = attr('unknown', 'unknown', 'WRD flood-line layer not imported');
  add({ topic: 'flood', kind: 'gap', certainty: 'unknown', source: 'WRD blue/red flood-line plans (not imported)', attr: 'withinBlueLine',
    statement: 'Blue/red flood-line status is unknown: the Water Resources Department flood-line plans have not been imported.' });

  // ── heritage ──────────────────────────────────────────────────────────────
  const hSrc = layerSource(site, 'heritage', 'OSM historic=* / heritage=* (locator only)');
  const her = feats('heritage').map(f => ({ f, d: distTo(f, line) })).sort((a, b) => a.d - b.d);
  const isAsi = (t: Record<string, string>) => t.heritage === '2' || /asi|archaeological survey/i.test(t['heritage:operator'] ?? '') || /asi/i.test(t['ref:asi'] ?? '') || !!t['ref:ASI'];
  const asi = her.filter(x => isAsi(x.f.tags));
  if (asi.length && asi[0].d <= th.asiRegulatedM.value) {
    A.distanceToAsiProtectedLimitM = attr(Math.round(asi[0].d), 'estimated', hSrc,
      'Measured to the OSM feature, not the notified protected limit; the true limit (and thus distance) must come from ASI/NMA.');
  } else {
    A.distanceToAsiProtectedLimitM = attr('unknown', 'unknown', 'ASI protected-limit boundaries not imported',
      asi.length ? `Nearest OSM feature tagged as centrally protected is ${fmtM(asi[0].d)} away; protected limits not in data.` : 'OSM heritage tags do not establish ASI protection status.');
  }
  const herNear = her.filter(x => x.d <= Math.max(th.heritageProximityM.value, 100));
  if (herNear.length) {
    for (const x of herNear.slice(0, 4)) {
      add({ topic: 'heritage', kind: 'constraint', certainty: 'verified_from_available_data', source: `${hSrc}; ${x.f.ref}`,
        statement: `Mapped historic feature "${x.f.label || x.f.tags.historic || x.f.tags.heritage}" (${x.f.tags.historic ?? 'heritage=' + x.f.tags.heritage}) is ${fmtM(x.d)} from the alignment. Statutory status (ASI / PMC list grade) is not established by OSM.` });
    }
  }
  // PMC heritage list (S10) is not in the repository: only a restricting value is ever set from OSM.
  if (herNear.length && herNear[0].d <= th.heritageProximityM.value) {
    A.distanceToListedHeritageM = attr(Math.round(herNear[0].d), 'estimated', hSrc, 'OSM historic feature used as a proxy; PMC list (S10) not imported, listing status unknown.');
  } else {
    A.distanceToListedHeritageM = attr('unknown', 'unknown', 'PMC heritage list (S10) not imported / geocoded');
  }
  add({ topic: 'heritage', kind: 'gap', certainty: 'unknown', source: 'ASI protected limits and PMC heritage list not imported', attr: 'distanceToListedHeritageM',
    statement: 'ASI protected/regulated areas and PMC-listed heritage properties are not in the available data; heritage status near the alignment must be verified.' });

  // ── trees ─────────────────────────────────────────────────────────────────
  const tSrc = layerSource(site, 'trees', 'OSM natural=tree / tree_row (indicative only)');
  const trees = feats('trees').filter(f => distTo(f, line) <= half);
  if (!L('trees')) A.treesInFootprint = attr('unknown', 'unknown', 'Tree layer not available');
  else if (trees.length) {
    A.treesInFootprint = attr(trees.length, 'estimated', tSrc, 'Mapped trees only; OSM tree mapping in Pune is incomplete. A tree census decides.');
    add({ topic: 'trees', kind: 'constraint', certainty: 'estimated', source: tSrc, attr: 'treesInFootprint',
      statement: `${trees.length} mapped tree feature(s) inside the drawn footprint (lower bound; tree census required).` });
  } else {
    A.treesInFootprint = attr('unknown', 'unknown', tSrc, 'No mapped tree in footprint; OSM tree data is sparse.');
    add({ topic: 'trees', kind: 'gap', certainty: 'unknown', source: tSrc, attr: 'treesInFootprint',
      statement: 'Trees in the footprint are unknown: none mapped, but OSM tree coverage is sparse. A tree census is required.' });
  }

  // ── utilities, ground ─────────────────────────────────────────────────────
  const utils = ctx.filter(o => o.type === 'utility').filter(o => polylineDistance(line, ctxLine(o)) <= zone);
  A.utilityDataLevel = utils.length
    ? attr('records', 'verified_from_available_data', 'City-model utility objects (user-entered records)', `${utils.length} utility line(s) recorded near the alignment; positions unverified.`)
    : attr('none', 'verified_from_available_data', 'No utility data in this tool for the site');
  add({ topic: 'utilities', kind: 'gap', certainty: utils.length ? 'estimated' : 'unknown', source: A.utilityDataLevel.source, attr: 'utilityDataLevel',
    statement: utils.length
      ? `${utils.length} recorded utility line(s) (${[...new Set(utils.map(u => u.utilityType))].join(', ')}) near the alignment; positions and depths are unverified records.`
      : 'No utility data is available for this site: water, sewer, storm, power, gas and telecom positions are unknown.' });
  A.geotechDataAvailable = attr(false, 'verified_from_available_data', 'No site geotechnical data imported into this tool');
  A.groundwaterDataAvailable = attr(false, 'verified_from_available_data', 'No site groundwater data imported into this tool');
  add({ topic: 'ground', kind: 'gap', certainty: 'requires_field_investigation', source: 'No borehole / groundwater data in this tool', attr: 'geotechDataAvailable',
    statement: isUnderground
      ? 'Ground and groundwater conditions along the tunnel are unknown. This tool cannot state that the tunnel is safe or constructible.'
      : 'Soil/rock and groundwater conditions at foundation locations are unknown until investigated.' });

  const plan = planInvestigations(p.proposalType, A, opts.thresholdOverrides);
  const layers = Object.fromEntries((['buildings', 'metro', 'roads', 'water', 'heritage', 'trees', 'railway'] as SiteLayerKey[])
    .map(k => [k, site.layers[k] ?? { available: false, reason: 'not requested' }])) as FeasibilityAssessment['layers'];
  return {
    engineVersion: ENGINE_VERSION,
    assessedAt: (opts.now ? opts.now() : new Date()).toISOString(),
    proposal: p,
    lengthM: Math.round(lineLengthM(p.line)),
    centroid: c,
    siteAttributes: A,
    findings,
    plan,
    layers,
    disclaimer: RULES.disclaimer,
    verdict: 'screening_only',
  };
}

/** Bounding box the site-data request should cover for a proposal. */
export function siteBBox(p: Pick<ProposalInput, 'line' | 'widthM'>): [number, number, number, number] {
  return bboxAround(p.line, SEARCH_RADIUS_M + p.widthM);
}
/** Narrow box for dense layers (buildings, roads, trees): footprint + influence zone + margin. */
export function nearBBox(p: Pick<ProposalInput, 'line' | 'widthM'>, influenceM = 30): [number, number, number, number] {
  return bboxAround(p.line, p.widthM / 2 + influenceM + 120);
}

