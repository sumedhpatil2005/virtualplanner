import React, { useMemo } from 'react';
import type { CityObject, UndergroundAlignmentObject } from '../../engine/objects/types';
import { ALIGNMENT_KIND_LABEL, chainages } from '../../engine/underground/alignmentGeometry';
import { scale } from '../../engine/underground/sectionLayout';
import { layoutElevationProfile, mapUtmChainage } from '../../engine/underground/terrainProfile';
import type { SubsurfaceEvidence, TerrainProfile } from '../../lib/terrainApi';
import { CertaintyBadge } from '../ui/badges/CertaintyBadge';
import { fmtM } from './common';
import { useUndergroundStore } from './undergroundStore';

const W = 880, H = 200;
const C = {
  axis: 'var(--text-3, #8B95A3)', grid: 'var(--border, #2C3540)', ground: '#a3a380', own: '#f59e0b',
  unknown: 'var(--unknown, #94a3b8)', cross: '#38bdf8', sewer: '#c084fc', text: 'var(--text-2, #A9B3C1)',
};
const TYPE_LABEL: Partial<Record<CityObject['type'], string>> = {
  road: 'Road', flyover: 'Flyover', metro_flyover: 'Double-deck', metro_line: 'Metro (elevated)', building: 'Building', utility: 'Utility', underground_alignment: 'Alignment',
};
const isHypo = (c: string) => c === 'hypothetical' || c === 'unknown';
const f1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'Unknown' : v.toFixed(1));

/** Long-section on an elevation axis: DSM ground line, crown/invert at ground − depth, crossings, PMC sewer inverts (QL-D). */
export const ElevationProfileSvg: React.FC<{ a: UndergroundAlignmentObject; others: readonly CityObject[]; prof: TerrainProfile; evidence: SubsurfaceEvidence | null; evidenceNote?: string | null }> = ({ a, others, prof, evidence, evidenceNote }) => {
  const sewers = useMemo(() => {
    if (!evidence) return [];
    const vFe = chainages(a.coordinates);
    return evidence.sewers.crossings.map(c => ({ ...c, chainageM: mapUtmChainage(c.chainage_m_utm, prof.vertex_chainage_m_utm, vFe) }));
  }, [a.coordinates, evidence, prof.vertex_chainage_m_utm]);
  const L = useMemo(() => layoutElevationProfile(a, others, prof, sewers, { width: W, height: H }), [a, others, prof, sewers]);
  const chainage = useUndergroundStore(s => s.sectionChainageM);
  const setChainage = useUndergroundStore(s => s.setSectionChainage);
  const ds = prof.dataset;
  const bottomY = H - L.box.bottom;
  const hypo = L.ep.vertices.some(v => isHypo(v.certainty));
  const unknownDepths = L.ep.vertices.filter(v => v.crownDepthM === null).length;
  return (
    <div className="flex flex-col gap-1" data-testid="ug-profile">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-2">
        <span className="text-text-1 font-medium">{a.name} · {ALIGNMENT_KIND_LABEL[a.alignmentKind]}</span>
        <span>Length {Math.round(L.ep.lengthM)} m</span>
        <span data-testid="ug-profile-dem-coverage">DEM coverage {Math.round(L.ep.coverageFraction * 100)} % of samples</span>
        {unknownDepths > 0 && <span className="text-unknown" data-testid="ug-profile-unknown-count">{unknownDepths} vertex depth{unknownDepths > 1 ? 's' : ''} UNKNOWN</span>}
        <span>{L.crossings.length} model crossing{L.crossings.length === 1 ? '' : 's'} · {evidenceNote ? <span data-testid="ug-profile-evidence-note">{evidenceNote}</span> : `${L.sewers.length} PMC sewer crossing${L.sewers.length === 1 ? '' : 's'}`}</span>
        <span>Vertical scale exaggerated; click to set the cross-section chainage</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: H, minWidth: 560 }} role="img" data-testid="ug-profile-elevation"
        aria-label={`Long-section of ${a.name} on elevation (m, EGM2008) with DSM ground line`}
        onClick={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setChainage(Math.max(0, Math.min(L.ep.lengthM, L.x.d0 + ((px - L.x.r0) / (L.x.r1 - L.x.r0)) * (L.x.d1 - L.x.d0))));
        }}>
        {L.yTicks.map(t => (
          <g key={`y${t}`}>
            <line x1={L.box.left} x2={W - L.box.right} y1={scale(L.y, t)} y2={scale(L.y, t)} stroke={C.grid} strokeWidth={0.5} />
            <text x={L.box.left - 4} y={scale(L.y, t) + 3} fontSize={10} textAnchor="end" fill={C.axis}>{t}</text>
          </g>
        ))}
        {L.xTicks.map(t => <text key={`x${t}`} x={scale(L.x, t)} y={H - 10} fontSize={10} textAnchor="middle" fill={C.axis}>{t}</text>)}
        <text x={4} y={12} fontSize={10} fill={C.axis}>m EGM2008 ↑</text>
        <text x={W - L.box.right} y={H - 1} fontSize={10} textAnchor="end" fill={C.axis}>chainage m →</text>
        {/* provenance label on the chart */}
        <text x={W - L.box.right - 2} y={12} fontSize={10} textAnchor="end" fill={C.ground} data-testid="ug-profile-provenance">
          Ground: Copernicus GLO-30 {ds.surface} {ds.version}{ds.dataset_version_id ? ` (${ds.dataset_version_id})` : ''} · EGM2008 · {ds.warning}
        </text>
        {/* ground */}
        {L.groundPaths.map((pts, i) => (
          <polyline key={`g${i}`} points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke={C.ground} strokeWidth={1.8} data-testid="ug-ground-line-dem" />
        ))}
        {L.unknownSpans.map(([x0, x1], i) => (
          <g key={`ug${i}`} data-testid="ug-ground-unknown">
            <rect x={x0} y={L.box.top} width={Math.max(2, x1 - x0)} height={bottomY - L.box.top} fill={C.unknown} fillOpacity={0.08} />
            <text x={(x0 + x1) / 2} y={L.box.top + 12} fontSize={10} textAnchor="middle" fill={C.unknown}>Ground UNKNOWN — outside DEM coverage</text>
          </g>
        ))}
        {/* the alignment */}
        {L.bands.map((pts, i) => (
          <polygon key={`b${i}`} points={pts.map(p => p.join(',')).join(' ')} fill={C.own} fillOpacity={hypo ? 0.25 : 0.45} stroke={C.own} strokeDasharray={hypo ? '5 3' : undefined} data-testid="ug-profile-band" />
        ))}
        {L.crownRuns.map((pts, i) => (
          <polyline key={`c${i}`} points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke={C.own} strokeWidth={2} strokeDasharray={hypo ? '5 3' : undefined} />
        ))}
        {L.unknownVertices.map((u, i) => (
          <g key={`u${i}`} data-testid="ug-profile-unknown">
            <title>{`Vertex at ch ${Math.round(u.chainageM)} m: ${u.reason}`}</title>
            <line x1={u.x} x2={u.x} y1={L.box.top} y2={bottomY} stroke={C.unknown} strokeDasharray="2 3" />
            <circle cx={u.x} cy={L.box.top + 26} r={8} fill="var(--surface-2, #1E252E)" stroke={C.unknown} />
            <text x={u.x} y={L.box.top + 30} fontSize={11} textAnchor="middle" fill={C.unknown}>?</text>
          </g>
        ))}
        {/* crossings with model objects: depth extents are relative to ground, placed on the DSM where it is known */}
        {L.crossings.map((c, i) => {
          const x = scale(L.x, c.chainageM);
          const top = c.extent.topDepthM, bot = c.extent.bottomDepthM;
          const yt = c.groundM === null ? L.box.top : scale(L.y, c.groundM - (top ?? 0));
          return (
            <g key={`x${i}`} data-testid="ug-profile-crossing">
              <title>{`${TYPE_LABEL[c.objectType] ?? c.objectType}: ${c.name} at ch ${Math.round(c.chainageM)} m — top ${fmtM(top)}, bottom ${fmtM(bot)} below ground (${c.extent.certainty}). ${c.extent.note}`}</title>
              {bot !== null && top !== null && c.groundM !== null
                ? <rect x={x - 3} y={yt} width={6} height={Math.max(2, scale(L.y, c.groundM - bot) - yt)} fill={C.cross} fillOpacity={0.8} />
                : <line x1={x} x2={x} y1={yt} y2={bottomY} stroke={C.cross} strokeWidth={1.5} strokeDasharray="1 4" />}
              <circle cx={x} cy={yt} r={2.5} fill={C.cross} />
            </g>
          );
        })}
        {/* PMC sewer crossings: published invert level (design/unverified, QL-D, datum not stated) */}
        {L.sewers.map((s, i) => (
          <g key={`s${i}`} data-testid="ug-profile-sewer">
            <title>{`PMC sewer ${s.label} (${s.c.type ?? 'type ?'}, Ø ${fmtM(s.diameterM, 2)}) at ch ${Math.round(s.chainageM)} m — invert ${f1(s.invertM)} m as published (design/unverified, ASCE 38 QL-D, datum not stated); DSM ${f1(s.c.dsm_at_crossing_m)} m; invert ${f1(s.c.invert_below_dsm_m)} m below DSM. ${s.c.level_method}`}</title>
            {s.y !== null
              ? <><line x1={s.x} x2={s.x} y1={s.y} y2={s.y - 6} stroke={C.sewer} strokeWidth={1} /><circle cx={s.x} cy={s.y} r={3.5} fill="none" stroke={C.sewer} strokeWidth={1.5} /></>
              : <text x={s.x} y={bottomY - 4} fontSize={10} textAnchor="middle" fill={C.sewer}>?</text>}
          </g>
        ))}
        <line x1={scale(L.x, chainage)} x2={scale(L.x, chainage)} y1={L.box.top} y2={bottomY} stroke="var(--accent, #3b82f6)" strokeWidth={1} data-testid="ug-profile-section-marker" />
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-text-2" data-testid="ug-profile-vertices">
        {L.ep.vertices.map((v, i) => (
          <span key={i} data-testid="ug-profile-vertex">
            V{i + 1} ch {Math.round(v.chainageM)} m · crown {v.crownElevM === null ? 'Unknown' : `${v.crownElevM.toFixed(1)} m EGM2008`} · {v.crownDepthM === null ? 'depth Unknown' : `${v.crownDepthM.toFixed(1)} m below DSM`}
            {v.groundM === null ? ' · ground Unknown' : ` (DSM ${v.groundM.toFixed(1)} m)`}
          </span>
        ))}
        {L.ep.runs.map((r, i) => r.minCoverM !== null && (
          <span key={`r${i}`} data-testid="ug-profile-min-cover" style={r.minCoverM < 0 ? { color: 'var(--warning, #fbbf24)' } : undefined}>
            {r.minCoverM < 0
              ? `Run ${i + 1}: crown ${(-r.minCoverM).toFixed(1)} m ABOVE the DSM at ch ${Math.round(r.minCoverChainageM ?? 0)} m on a straight grade between vertices — add a vertex or deepen (DSM includes buildings/trees)`
              : `Least crown depth below DSM on run ${i + 1}: ${r.minCoverM.toFixed(1)} m at ch ${Math.round(r.minCoverChainageM ?? 0)} m (straight grade between vertices)`}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-meta text-text-3">
        <span>Depths: <CertaintyBadge certainty={L.ep.vertices.some(v => v.certainty === 'unknown') ? 'unknown' : L.ep.vertices.some(v => v.certainty === 'hypothetical') ? 'hypothetical' : L.ep.vertices.some(v => v.certainty === 'estimated') ? 'estimated' : 'measured'} compact /></span>
        <span data-testid="ug-profile-dem-note">Ground = {ds.product}, {ds.vertical_datum}; {ds.vertical_accuracy} {ds.warning}. Suitability: {ds.suitability}. Depths stay relative to the DSM.</span>
        {L.sewers.length > 0 && <span>Purple ○ = PMC sewer invert as published — design/unverified, ASCE 38 QL-D, vertical datum not stated.</span>}
      </div>
    </div>
  );
};
