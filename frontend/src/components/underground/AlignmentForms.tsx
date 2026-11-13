import React, { useState } from 'react';
import { engineInstance } from '../../engine/TwinCityEngine';
import type { UndergroundAlignmentKind, UndergroundAlignmentObject, UndergroundSection } from '../../engine/objects/types';
import type { Certainty } from '../../engine/objects/certainty';
import { ALIGNMENT_KIND_LABEL, alignmentProfile } from '../../engine/underground/alignmentGeometry';
import { ALIGNMENT_KINDS, cleanDepth, withAllDepths, withKind, withSection, withVertexDepth } from '../../engine/underground/alignmentFactory';
import { CertaintyBadge } from '../ui/badges/CertaintyBadge';
import { CERTAINTY_OPTIONS, commitAlignment, field, input, inputStyle, lbl, labelStyle, note } from './common';

const num = (s: string): number | null => (s.trim() === '' ? null : Number(s));

/** Section shape + dimension inputs; a blank dimension is UNKNOWN (null), never 0. */
export const SectionFields: React.FC<{ section: UndergroundSection; onChange: (s: UndergroundSection) => void; idBase: string }> = ({ section, onChange, idBase }) => (
  <div className="flex flex-col gap-2">
    <div className={field}>
      <label className={lbl} style={labelStyle} htmlFor={`${idBase}-shape`}>Cross-section</label>
      <select id={`${idBase}-shape`} data-testid={`${idBase}-shape`} className={input} style={inputStyle} value={section.shape}
        onChange={e => onChange(e.target.value === 'box'
          ? { shape: 'box', widthM: section.shape === 'circular' ? section.diameterM : section.widthM, heightM: section.shape === 'circular' ? section.diameterM : section.heightM }
          : { shape: 'circular', diameterM: section.shape === 'box' ? section.widthM : section.diameterM })}>
        <option value="circular">Circular (bored)</option>
        <option value="box">Box / rectangular</option>
      </select>
    </div>
    {section.shape === 'circular' ? (
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor={`${idBase}-dia`}>Outer diameter (m)</label>
        <input id={`${idBase}-dia`} data-testid={`${idBase}-diameter`} type="number" min={0.1} step={0.1} placeholder="Unknown" className={input} style={inputStyle}
          value={section.diameterM ?? ''} onChange={e => onChange({ shape: 'circular', diameterM: num(e.target.value) })} />
      </div>
    ) : (
      <div className="grid grid-cols-2 gap-2">
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor={`${idBase}-w`}>Width (m)</label>
          <input id={`${idBase}-w`} data-testid={`${idBase}-width`} type="number" min={0.1} step={0.1} placeholder="Unknown" className={input} style={inputStyle}
            value={section.widthM ?? ''} onChange={e => onChange({ ...section, widthM: num(e.target.value) })} />
        </div>
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor={`${idBase}-h`}>Height (m)</label>
          <input id={`${idBase}-h`} data-testid={`${idBase}-height`} type="number" min={0.1} step={0.1} placeholder="Unknown" className={input} style={inputStyle}
            value={section.heightM ?? ''} onChange={e => onChange({ ...section, heightM: num(e.target.value) })} />
        </div>
      </div>
    )}
  </div>
);

const CertaintySelect: React.FC<{ value: Certainty; onChange: (c: Certainty) => void; id: string; label: string; testId?: string; short?: boolean }> = ({ value, onChange, id, label, testId, short }) => (
  <select id={id} aria-label={label} data-testid={testId} className={input} style={short ? { ...inputStyle, width: 92 } : inputStyle} value={value} onChange={e => onChange(e.target.value as Certainty)}>
    {CERTAINTY_OPTIONS.filter(o => !short || o.value !== 'unknown').map(o => <option key={o.value} value={o.value}>{short ? o.label.split(' ')[0] : o.label}</option>)}
  </select>
);

/** Settings for the next alignment drawn with the Tunnel tool (EditingEngine.underground*). */
export const UndergroundToolSettings: React.FC = () => {
  const e = engineInstance.editing;
  const [, bump] = useState(0);
  const set = (fn: () => void) => { fn(); bump(n => n + 1); };
  return (
    <div className="flex flex-col gap-2" data-testid="underground-tool-settings">
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ug-tool-kind">Alignment type</label>
        <select id="ug-tool-kind" data-testid="ug-tool-kind" className={input} style={inputStyle} value={e.undergroundKind}
          onChange={ev => set(() => e.setUndergroundKind(ev.target.value as UndergroundAlignmentKind))}>
          {ALIGNMENT_KINDS.map(k => <option key={k} value={k}>{ALIGNMENT_KIND_LABEL[k]}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ug-tool-depth">Crown depth (m)</label>
          <input id="ug-tool-depth" data-testid="ug-tool-depth" type="number" min={0} step={0.5} placeholder="Unknown" className={input} style={inputStyle}
            value={e.undergroundCrownDepthM ?? ''} onChange={ev => set(() => { e.undergroundCrownDepthM = cleanDepth(num(ev.target.value)); })} />
        </div>
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ug-tool-depth-cert">Depth is <CertaintyBadge certainty={e.undergroundCrownDepthM === null ? 'unknown' : e.undergroundDepthCertainty} compact /></label>
          <CertaintySelect id="ug-tool-depth-cert" label="Depth certainty" value={e.undergroundDepthCertainty} onChange={c => set(() => { e.undergroundDepthCertainty = c; })} testId="ug-tool-depth-certainty" />
        </div>
      </div>
      <SectionFields idBase="ug-tool-section" section={e.undergroundSection} onChange={s => set(() => { e.undergroundSection = s; })} />
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ug-tool-sec-cert">Section is <CertaintyBadge certainty={e.undergroundSectionCertainty} compact /></label>
        <CertaintySelect id="ug-tool-sec-cert" label="Section certainty" value={e.undergroundSectionCertainty} onChange={c => set(() => { e.undergroundSectionCertainty = c; })} />
      </div>
      <p className="text-[11px]" style={note}>Defaults per type are drawing placeholders, not standards. Depth is below a flat ground datum (no terrain data). Set each vertex's depth after drawing.</p>
    </div>
  );
};

/** Inspector-style editor for one alignment: type, section, and the vertical profile (depth per vertex). */
export const AlignmentEditor: React.FC<{ a: UndergroundAlignmentObject }> = ({ a }) => {
  const p = alignmentProfile(a);
  const [allDepth, setAllDepth] = useState('');
  return (
    <div className="flex flex-col gap-3" data-testid="alignment-editor">
      <div className="grid grid-cols-2 gap-2">
        <div className={field}>
          <label className={lbl} style={labelStyle} htmlFor="ug-kind">Type</label>
          <select id="ug-kind" data-testid="ug-kind" className={input} style={inputStyle} value={a.alignmentKind}
            onChange={e => commitAlignment(a, withKind(a, e.target.value as UndergroundAlignmentKind), 'Change alignment type')}>
            {ALIGNMENT_KINDS.map(k => <option key={k} value={k}>{ALIGNMENT_KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className={field}>
          <span className={lbl} style={labelStyle}>Length</span>
          <span className="text-body tabular-nums text-text-1 py-1">{Math.round(p.lengthM).toLocaleString('en-IN')} m (plan)</span>
        </div>
      </div>
      <SectionFields idBase="ug-section" section={a.section} onChange={s => commitAlignment(a, withSection(a, s), 'Edit cross-section', `${a.id}:section`)} />
      <div className={field}>
        <label className={lbl} style={labelStyle} htmlFor="ug-sec-cert">Section is <CertaintyBadge certainty={a.sectionCertainty} compact /></label>
        <CertaintySelect id="ug-sec-cert" label="Section certainty" value={a.sectionCertainty} onChange={c => commitAlignment(a, withSection(a, a.section, c), 'Section certainty')} />
      </div>
      <div>
        <div className="flex items-end gap-2 mb-1">
          <div className={`${field} flex-1`}>
            <label className={lbl} style={labelStyle} htmlFor="ug-all-depth">Set all vertices (m)</label>
            <input id="ug-all-depth" data-testid="ug-all-depth" type="number" min={0} step={0.5} placeholder="crown depth" className={input} style={inputStyle} value={allDepth} onChange={e => setAllDepth(e.target.value)} />
          </div>
          <button type="button" className="uos-btn uos-btn-sm" data-testid="ug-apply-all-depth" disabled={allDepth.trim() === '' || cleanDepth(Number(allDepth)) === null}
            onClick={() => { commitAlignment(a, withAllDepths(a, Number(allDepth), 'hypothetical'), 'Set all depths'); setAllDepth(''); }}>Apply</button>
        </div>
        <table className="uos-table" data-testid="ug-vertex-table">
          <thead><tr><th>#</th><th className="num">Chainage</th><th>Crown depth (m)</th><th>Certainty</th><th className="num">Grade</th></tr></thead>
          <tbody>
            {p.vertices.map((v, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className="num">{Math.round(v.chainageM)} m</td>
                <td>
                  <input aria-label={`Crown depth at vertex ${i + 1} (m)`} data-testid={`ug-depth-${i}`} type="number" min={0} step={0.5} placeholder="Unknown"
                    className={input} style={{ ...inputStyle, width: 76 }} value={v.crownDepthM ?? ''}
                    onChange={e => commitAlignment(a, withVertexDepth(a, i, { crownDepthM: num(e.target.value) }), `Depth at vertex ${i + 1}`, `${a.id}:depth:${i}`)} />
                </td>
                <td>
                  {v.crownDepthM === null ? <CertaintyBadge certainty="unknown" compact note="No depth entered" /> : (
                    <CertaintySelect id={`ug-cert-${i}`} label={`Depth certainty at vertex ${i + 1}`} testId={`ug-cert-${i}`} short value={v.certainty}
                      onChange={c => commitAlignment(a, withVertexDepth(a, i, { certainty: c }), `Depth certainty at vertex ${i + 1}`)} />
                  )}
                </td>
                <td className="num" title="Δcrown / Δchainage to the next vertex; + = getting deeper">
                  {i < p.gradientsPct.length ? (p.gradientsPct[i] === null ? '—' : `${(p.gradientsPct[i] as number).toFixed(2)} %`) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] mt-1" style={note}>Depth = crown (top of structure) below the flat ground datum. Blank = Unknown: never interpolated across, shown as "?" on the profile.</p>
      </div>
    </div>
  );
};
