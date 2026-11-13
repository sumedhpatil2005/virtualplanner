import React, { useMemo } from 'react';
import { TrainFrontTunnel } from 'lucide-react';
import type { CityObject, UndergroundAlignmentObject } from '../../engine/objects/types';
import { engineInstance } from '../../engine/TwinCityEngine';
import { ALIGNMENT_KIND_LABEL } from '../../engine/underground/alignmentGeometry';
import { layoutProfile, layoutSection, scale } from '../../engine/underground/sectionLayout';
import { EmptyState } from '../ui/EmptyState';
import { CertaintyBadge } from '../ui/badges/CertaintyBadge';
import { useEngineObjects } from '../../shell/useEngineObjects';
import { fmtM, useActiveAlignment } from './common';
import { useUndergroundStore } from './undergroundStore';

const W = 880, H = 180;
const C = {
  axis: 'var(--text-3, #8B95A3)', grid: 'var(--border, #2C3540)', ground: 'var(--text-2, #A9B3C1)', own: '#f59e0b',
  unknown: 'var(--unknown, #94a3b8)', cross: '#38bdf8', text: 'var(--text-2, #A9B3C1)',
};
const TYPE_LABEL: Partial<Record<CityObject['type'], string>> = {
  road: 'Road', flyover: 'Flyover', metro_flyover: 'Double-deck', metro_line: 'Metro (elevated)', building: 'Building', utility: 'Utility', underground_alignment: 'Alignment',
};
const isHypo = (c: string) => c === 'hypothetical' || c === 'unknown';

const NoAlignment: React.FC = () => (
  <EmptyState icon={TrainFrontTunnel} title="No underground alignment in this alternative"
    action={{ label: 'Draw an alignment', onClick: () => engineInstance.editing.setMode('draw_underground'), 'data-testid': 'ug-drawer-draw' }}>
    Draw one with the Tunnel tool; its long-section and cross-sections appear here.
  </EmptyState>
);

const GroundLine: React.FC<{ x0: number; x1: number; y: number }> = ({ x0, x1, y }) => (
  <g data-testid="ug-ground-line">
    <line x1={x0} x2={x1} y1={y} y2={y} stroke={C.ground} strokeWidth={1.5} strokeDasharray="6 4" />
    <text x={x0 + 4} y={y - 4} fontSize={10} fill={C.ground}>Ground = flat datum 0 m · no terrain data — UNKNOWN</text>
  </g>
);

/** Long-section: chainage vs depth below the flat ground datum, with crossings of other objects from the model. */
export const ProfileView: React.FC = () => {
  const { active } = useActiveAlignment();
  const all = useEngineObjects();
  if (!active) return <NoAlignment />;
  return <ProfileSvg a={active} others={all} />;
};

export const ProfileSvg: React.FC<{ a: UndergroundAlignmentObject; others: readonly CityObject[] }> = ({ a, others: objs }) => {
  const L = useMemo(() => layoutProfile(a, objs, { width: W, height: H }), [a, objs]);
  const chainage = useUndergroundStore(s => s.sectionChainageM);
  const setChainage = useUndergroundStore(s => s.setSectionChainage);
  const y0 = scale(L.y, 0);
  const bottomY = H - L.box.bottom;
  const hypo = L.profile.vertices.some(v => isHypo(v.certainty));
  return (
    <div className="flex flex-col gap-1" data-testid="ug-profile">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-2">
        <span className="text-text-1 font-medium">{a.name} · {ALIGNMENT_KIND_LABEL[a.alignmentKind]}</span>
        <span>Length {Math.round(L.profile.lengthM)} m</span>
        <span>Deepest known {fmtM(L.profile.maxKnownDepthM)}</span>
        {L.profile.unknownDepthCount > 0 && <span className="text-unknown" data-testid="ug-profile-unknown-count">{L.profile.unknownDepthCount} vertex depth{L.profile.unknownDepthCount > 1 ? 's' : ''} UNKNOWN</span>}
        <span>{L.crossings.length} crossing{L.crossings.length === 1 ? '' : 's'} with model objects</span>
        <span>Vertical scale exaggerated; click to set the cross-section chainage</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: H, minWidth: 560 }} role="img"
        aria-label={`Long-section of ${a.name}: chainage 0 to ${Math.round(L.profile.lengthM)} m, depth below flat ground datum`}
        onClick={e => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setChainage(Math.max(0, Math.min(L.profile.lengthM, L.x.d0 + ((px - L.x.r0) / (L.x.r1 - L.x.r0)) * (L.x.d1 - L.x.d0))));
        }}>
        {/* grid + axes */}
        {L.yTicks.map(t => (
          <g key={`y${t}`}>
            <line x1={L.box.left} x2={W - L.box.right} y1={scale(L.y, t)} y2={scale(L.y, t)} stroke={C.grid} strokeWidth={0.5} />
            <text x={L.box.left - 4} y={scale(L.y, t) + 3} fontSize={10} textAnchor="end" fill={C.axis}>{t}</text>
          </g>
        ))}
        {L.xTicks.map(t => (
          <text key={`x${t}`} x={scale(L.x, t)} y={H - 10} fontSize={10} textAnchor="middle" fill={C.axis}>{t}</text>
        ))}
        <text x={4} y={12} fontSize={10} fill={C.axis}>depth m ↓</text>
        <text x={W - L.box.right} y={H - 1} fontSize={10} textAnchor="end" fill={C.axis}>chainage m →</text>
        <GroundLine x0={L.box.left} x1={W - L.box.right} y={y0} />
        {/* the alignment */}
        {L.bands.map((pts, i) => (
          <polygon key={`b${i}`} points={pts.map(p => p.join(',')).join(' ')} fill={C.own} fillOpacity={hypo ? 0.25 : 0.45} stroke={C.own} strokeDasharray={hypo ? '5 3' : undefined} data-testid="ug-profile-band" />
        ))}
        {L.crownRuns.map((pts, i) => (
          <polyline key={`c${i}`} points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke={C.own} strokeWidth={2} strokeDasharray={hypo ? '5 3' : undefined} />
        ))}
        {L.unknownVertices.map((u, i) => (
          <g key={`u${i}`} data-testid="ug-profile-unknown">
            <line x1={u.x} x2={u.x} y1={y0} y2={bottomY} stroke={C.unknown} strokeDasharray="2 3" />
            <circle cx={u.x} cy={y0 + 12} r={8} fill="var(--surface-2, #1E252E)" stroke={C.unknown} />
            <text x={u.x} y={y0 + 16} fontSize={11} textAnchor="middle" fill={C.unknown}>?</text>
          </g>
        ))}
        {/* crossings with model objects */}
        {L.crossings.map((c, i) => {
          const x = scale(L.x, c.chainageM);
          const showLabel = i === 0 || x - scale(L.x, L.crossings[i - 1].chainageM) > 70;
          const top = c.extent.topDepthM, bot = c.extent.bottomDepthM;
          const yt = top === null ? y0 : Math.max(L.box.top, scale(L.y, top));
          return (
            <g key={`x${i}`} data-testid="ug-profile-crossing">
              <title>{`${TYPE_LABEL[c.objectType] ?? c.objectType}: ${c.name} at ch ${Math.round(c.chainageM)} m — top ${fmtM(top)}, bottom ${fmtM(bot)} (${c.extent.certainty}). ${c.extent.note}`}</title>
              {bot !== null && top !== null
                ? <rect x={x - 3} y={yt} width={6} height={Math.max(2, scale(L.y, bot) - yt)} fill={C.cross} fillOpacity={0.8} />
                : <line x1={x} x2={x} y1={yt} y2={bottomY} stroke={C.cross} strokeWidth={2} strokeDasharray="1 4" />}
              <circle cx={x} cy={yt} r={3} fill={C.cross} />
              {showLabel && <text x={x + 3} y={bottomY - 4} fontSize={9} fill={C.text}>{(TYPE_LABEL[c.objectType] ?? c.objectType)}{bot === null ? ' · depth ?' : ''}</text>}
            </g>
          );
        })}
        {/* section marker */}
        <line x1={scale(L.x, chainage)} x2={scale(L.x, chainage)} y1={L.box.top} y2={bottomY} stroke="var(--accent, #3b82f6)" strokeWidth={1} data-testid="ug-profile-section-marker" />
      </svg>
      <div className="flex flex-wrap items-center gap-2 text-meta text-text-3">
        <span>Depths: <CertaintyBadge certainty={L.profile.vertices.some(v => v.certainty === 'unknown') ? 'unknown' : L.profile.vertices.some(v => v.certainty === 'hypothetical') ? 'hypothetical' : L.profile.vertices.some(v => v.certainty === 'estimated') ? 'estimated' : 'measured'} compact /></span>
        <span>Dotted blue = crossing whose depth extent is UNKNOWN in the model (road structure, pier foundations, building basements are not modelled).</span>
      </div>
    </div>
  );
};

/** Cross-section perpendicular to the alignment at the chosen chainage. */
export const CrossSectionView: React.FC = () => {
  const { active } = useActiveAlignment();
  const all = useEngineObjects();
  if (!active) return <NoAlignment />;
  return <CrossSectionSvg a={active} others={all} />;
};

export const CrossSectionSvg: React.FC<{ a: UndergroundAlignmentObject; others: readonly CityObject[] }> = ({ a, others: objs }) => {
  const chainage = useUndergroundStore(s => s.sectionChainageM);
  const half = useUndergroundStore(s => s.sectionHalfWidthM);
  const { setSectionChainage, setSectionHalfWidth } = useUndergroundStore.getState();
  const L = useMemo(() => layoutSection(a, chainage, half, objs, { width: W, height: H }), [a, chainage, half, objs]);
  const y0 = scale(L.y, 0);
  const own = L.own;
  const ownInfo = L.section.own;
  const len = Math.round(layoutProfile(a, [], { width: 10, height: 10 }).profile.lengthM);
  return (
    <div className="flex flex-col gap-1" data-testid="ug-section">
      <div className="flex flex-wrap items-center gap-3 text-meta text-text-2">
        <label className="flex items-center gap-2">Chainage
          <input type="range" min={0} max={Math.max(1, len)} step={1} value={Math.min(chainage, len)} onChange={e => setSectionChainage(Number(e.target.value))} aria-label="Cross-section chainage (m)" data-testid="ug-section-chainage" style={{ width: 220 }} />
          <span className="tabular-nums text-text-1" data-testid="ug-section-chainage-value">{Math.round(L.section.chainageM)} m</span>
        </label>
        <label className="flex items-center gap-2">Window ±
          <input type="number" min={5} max={500} step={5} value={half} onChange={e => setSectionHalfWidth(Number(e.target.value))} aria-label="Cross-section half-width (m)" className="rounded border px-1 py-0.5 w-16" style={{ background: 'var(--surface-2)', borderColor: 'var(--border-strong)', color: 'var(--text-1)' }} /> m
        </label>
        <span>Crown here {fmtM(ownInfo.crownDepthM)} <CertaintyBadge certainty={ownInfo.certainty} compact /></span>
        <span>Section {ownInfo.section.shape === 'circular' ? `Ø ${fmtM(ownInfo.widthM)}` : `${fmtM(ownInfo.widthM)} × ${fmtM(ownInfo.heightM)}`} <CertaintyBadge certainty={a.sectionCertainty} compact /></span>
        <span>{L.section.items.length} object{L.section.items.length === 1 ? '' : 's'} cut</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: H, minWidth: 560 }} role="img" aria-label={`Cross-section of ${a.name} at chainage ${Math.round(L.section.chainageM)} m`}>
        {L.yTicks.map(t => (
          <g key={`y${t}`}>
            <line x1={L.box.left} x2={W - L.box.right} y1={scale(L.y, t)} y2={scale(L.y, t)} stroke={C.grid} strokeWidth={0.5} />
            <text x={L.box.left - 4} y={scale(L.y, t) + 3} fontSize={10} textAnchor="end" fill={C.axis}>{t}</text>
          </g>
        ))}
        {L.xTicks.map(t => <text key={`x${t}`} x={scale(L.x, t)} y={H - 10} fontSize={10} textAnchor="middle" fill={C.axis}>{t}</text>)}
        <text x={4} y={12} fontSize={10} fill={C.axis}>depth m ↓</text>
        <text x={W - L.box.right} y={H - 1} fontSize={10} textAnchor="end" fill={C.axis}>offset m (left − / right +, facing chainage) · scales differ</text>
        <GroundLine x0={L.box.left} x1={W - L.box.right} y={y0} />
        <line x1={scale(L.x, 0)} x2={scale(L.x, 0)} y1={L.box.top} y2={H - L.box.bottom} stroke={C.grid} strokeDasharray="3 3" />
        {own && own.shape === 'circular' && <ellipse cx={own.cx} cy={own.cy} rx={own.rx} ry={own.ry} fill={C.own} fillOpacity={0.35} stroke={C.own} strokeWidth={2} strokeDasharray={isHypo(L.section.own.certainty) ? '5 3' : undefined} data-testid="ug-section-own" />}
        {own && own.shape === 'box' && <rect x={own.x} y={own.y} width={own.w} height={own.h} fill={C.own} fillOpacity={0.35} stroke={C.own} strokeWidth={2} strokeDasharray={isHypo(L.section.own.certainty) ? '5 3' : undefined} data-testid="ug-section-own" />}
        {!own && (
          <g data-testid="ug-section-own-unknown">
            <text x={scale(L.x, 0)} y={y0 + 30} fontSize={12} textAnchor="middle" fill={C.unknown}>Structure position UNKNOWN here (depth or section size not entered)</text>
          </g>
        )}
        {L.section.items.map((it, i) => {
          const x = scale(L.x, it.offsetM);
          const top = it.extent.topDepthM, bot = it.extent.bottomDepthM;
          const yt = top === null ? y0 : Math.max(L.box.top, scale(L.y, top));
          const halfW = it.widthM !== null ? Math.abs(scale(L.x, it.widthM / 2) - scale(L.x, 0)) : 2;
          return (
            <g key={i} data-testid="ug-section-item">
              <title>{`${TYPE_LABEL[it.objectType] ?? it.objectType}: ${it.name} at ${it.offsetM.toFixed(1)} m — top ${fmtM(top)}, bottom ${fmtM(bot)}, width ${fmtM(it.widthM)} (${it.extent.certainty}). ${it.extent.note}`}</title>
              {bot !== null && top !== null
                ? <rect x={x - halfW} y={yt} width={halfW * 2} height={Math.max(2, scale(L.y, bot) - yt)} fill={C.cross} fillOpacity={0.7} />
                : <>
                    <rect x={x - halfW} y={yt - 2} width={halfW * 2} height={4} fill={C.cross} />
                    <line x1={x} x2={x} y1={yt} y2={H - L.box.bottom} stroke={C.cross} strokeWidth={2} strokeDasharray="1 4" />
                  </>}
              <text x={x} y={H - L.box.bottom - 4 - (i % 2) * 10} fontSize={9} textAnchor="middle" fill={C.text}>{TYPE_LABEL[it.objectType] ?? it.objectType}{bot === null ? ' · depth ?' : ''}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};
