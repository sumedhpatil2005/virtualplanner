import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FileDown, FileText, Upload, ClipboardCheck, ShieldAlert, ScanSearch } from 'lucide-react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { CityObject } from '../engine/objects/types';
import { filterObjectsForScenario } from '../engine/scenarios/scenarioFilter';
import { assessFeasibility, nearBBox, PROPOSAL_TYPE_LABEL, siteBBox } from '../engine/feasibility/siteAssessment';
import { cityContext, defaultLevel, defaultProposalType, PROPOSAL_TYPES_FOR, proposalFromObject } from '../engine/feasibility/proposal';
import { CERTAINTY_LABEL, type Certainty, type FeasibilityAssessment, type ProposalLevel, type ProposalType } from '../engine/feasibility/types';
import {
  addReview, documentUrl, fetchSiteData, generateDocument, getAssessment, listAssessments, listDocuments, listEvidence, listReviews, REVIEW_STATUS_LABEL,
  saveAssessment, uploadEvidence, type DocumentRecord, type EvidenceRecord, type ReviewRecord, type ReviewStatus, type StoredAssessment,
} from '../engine/feasibility/feasibilityApi';
import { Button, Notice, Section, Segmented } from './ui/kit';

const CHIP: Record<Certainty, string> = {
  verified_from_available_data: 'bg-sky-500/15 text-sky-200 border-sky-400/30',
  estimated: 'bg-amber-500/15 text-amber-200 border-amber-400/30',
  inferred: 'bg-violet-500/15 text-violet-200 border-violet-400/30',
  unknown: 'bg-slate-500/20 text-slate-200 border-slate-400/30',
  requires_field_investigation: 'bg-orange-500/15 text-orange-200 border-orange-400/30',
  requires_professional_assessment: 'bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-400/30',
};
const CertChip: React.FC<{ c: Certainty }> = ({ c }) => (
  <span className={`inline-block shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${CHIP[c]}`}>{CERTAINTY_LABEL[c]}</span>
);
const input = 'w-full bg-slate-900/80 border border-slate-700/50 rounded-lg px-2 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-cyan-500';
const LEVELS: { value: ProposalLevel; label: string }[] = [{ value: 'surface', label: 'Surface' }, { value: 'elevated', label: 'Elevated' }, { value: 'underground', label: 'Underground' }];

type ProposalObj = Extract<CityObject, { type: 'road' | 'flyover' | 'metro_flyover' }>;

/** Build mode → selected drawn road/flyover → "Feasibility & investigations". */
export const FeasibilityPanel: React.FC<{ obj: ProposalObj; onBack: () => void }> = ({ obj, onBack }) => {
  const [ptype, setPtype] = useState<ProposalType>(() => defaultProposalType(obj));
  const [level, setLevel] = useState<ProposalLevel>(() => defaultLevel(defaultProposalType(obj)));
  const [width, setWidth] = useState<number>((obj as { width?: number }).width ?? 7);
  const [depth, setDepth] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stored, setStored] = useState<StoredAssessment | null>(null);
  const [a, setA] = useState<FeasibilityAssessment | null>(null);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [docIn, setDocIn] = useState({ project_name: obj.name, location_description: '', reason: '', responsible_team: '' });
  const [rev, setRev] = useState<{ reviewer_name: string; reviewer_role: string; status: ReviewStatus; notes: string; item: string; evidence_ids: string[]; external_reference: string }>(
    { reviewer_name: '', reviewer_role: '', status: 'in_review', notes: '', item: '', evidence_ids: [], external_reference: '' });
  const [ev, setEv] = useState<{ file: File | null; description: string; uploaded_by: string; investigation_id: string; provenance: string }>(
    { file: null, description: '', uploaded_by: '', investigation_id: '', provenance: 'measured' });

  const loadRecords = useCallback(async (id: string) => {
    const [r, e, d] = await Promise.all([listReviews(id), listEvidence(id), listDocuments(id)]);
    setReviews(r); setEvidence(e); setDocs(d);
  }, []);

  // Reopen the latest stored assessment for this object, if any.
  useEffect(() => {
    let live = true;
    listAssessments(obj.id).then(async list => {
      if (!live || !list.length) return;
      const full = await getAssessment(list[0].id);
      if (!live || !full.assessment) return;
      setStored(full); setA(full.assessment);
      setPtype(full.assessment.proposal.proposalType); setLevel(full.assessment.proposal.level); setWidth(full.assessment.proposal.widthM);
      await loadRecords(full.id);
    }).catch(() => { /* backend offline: the panel still assesses on demand */ });
    return () => { live = false; };
  }, [obj.id, loadRecords]);

  const run = async () => {
    setBusy('assess'); setError(null);
    try {
      const p = proposalFromObject(obj, ptype, { level, widthM: width, excavationDepthM: depth.trim() === '' ? null : Number(depth) });
      const site = await fetchSiteData(siteBBox(p), nearBBox(p));
      const scen = engineInstance.scenarios.getActiveScenarioId();
      const context = cityContext(filterObjectsForScenario(engineInstance.objects.getAll(), scen));
      const res = assessFeasibility(p, site, context);
      const s = await saveAssessment(res);
      setA(res); setStored(s);
      await loadRecords(s.id);
    } catch (e) { setError(`Assessment failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const gen = async (fmt: 'pdf' | 'docx') => {
    if (!stored) return;
    setBusy(fmt); setError(null);
    try {
      const d = await generateDocument(stored.id, fmt, docIn);
      setDocs(x => [...x, d]);
      const link = document.createElement('a');
      link.href = documentUrl(d); link.download = d.file_name; link.rel = 'noopener';
      document.body.appendChild(link); link.click(); link.remove();
    } catch (e) { setError(`Document generation failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const upload = async () => {
    if (!stored || !ev.file) return;
    setBusy('upload'); setError(null);
    try {
      const r = await uploadEvidence(stored.id, ev.file, { description: ev.description, uploaded_by: ev.uploaded_by, investigation_id: ev.investigation_id || null, provenance: ev.provenance });
      setEvidence(x => [...x, r]); setEv(s => ({ ...s, file: null, description: '' }));
    } catch (e) { setError(`Upload failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const submitReview = async () => {
    if (!stored) return;
    setBusy('review'); setError(null);
    try {
      const r = await addReview(stored.id, {
        reviewer_name: rev.reviewer_name, reviewer_role: rev.reviewer_role, status: rev.status, notes: rev.notes, evidence_ids: rev.evidence_ids,
        item_type: rev.item ? 'investigation' : 'assessment', item_id: rev.item || null,
        ...(rev.status === 'external_approval_recorded_unverified' ? { external_reference: rev.external_reference } : {}),
      });
      setReviews(x => [...x, r]); setRev(s => ({ ...s, notes: '', evidence_ids: [], external_reference: '' }));
    } catch (e) { setError(`Review not recorded: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const latestStatus = useMemo(() => {
    const m = new Map<string, ReviewRecord>();
    for (const r of reviews) if (r.item_id) m.set(r.item_id, r);
    return m;
  }, [reviews]);
  const stale = !!a && (a.proposal.proposalType !== ptype || a.proposal.level !== level || a.proposal.widthM !== width);
  const constraints = a?.findings.filter(f => f.kind === 'constraint').length ?? 0;
  const gaps = a?.findings.filter(f => f.kind === 'gap').length ?? 0;
  const types = PROPOSAL_TYPES_FOR[obj.type];

  return (
    <div data-testid="feasibility-panel" className="w-[24rem] max-h-full rounded-2xl flex flex-col pointer-events-auto bg-slate-950/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/40 overflow-hidden animate-fade-in">
      <header className="px-4 pt-3.5 pb-3 border-b border-white/10 shrink-0">
        <button onClick={onBack} className="-ml-1 mb-2 inline-flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-white/5 cursor-pointer transition">
          <ArrowLeft size={16} /> Properties
        </button>
        <h2 className="text-base font-semibold text-white leading-snug">Feasibility &amp; investigations</h2>
        <div className="text-sm text-slate-400 mt-0.5 truncate">{obj.name}</div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <Notice tone="warn" icon={ShieldAlert}>
          Screening from available data only. Unknown stays unknown. This is not an engineering assessment or any approval.
        </Notice>

        <Section title="Proposal">
          <label className="block text-xs text-slate-400">Type
            <select aria-label="Proposal type" className={`${input} mt-1`} value={ptype} onChange={e => { const t = e.target.value as ProposalType; setPtype(t); setLevel(defaultLevel(t)); }}>
              {types.map(t => <option key={t} value={t}>{PROPOSAL_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <Segmented label="Level" options={LEVELS} value={level} onChange={setLevel} />
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-slate-400">Width (m)
              <input aria-label="Width (m)" type="number" min={1} step={0.5} className={`${input} mt-1`} value={width} onChange={e => setWidth(Number(e.target.value))} />
            </label>
            <label className="block text-xs text-slate-400">Depth (m), if known
              <input aria-label="Excavation depth (m)" type="number" min={0} step={0.5} placeholder="unknown" className={`${input} mt-1`} value={depth} onChange={e => setDepth(e.target.value)} />
            </label>
          </div>
          <Button variant="primary" icon={ScanSearch} spin={busy === 'assess'} disabled={!!busy || width <= 0} onClick={run} className="w-full">
            {a ? (stale ? 'Re-assess with these settings' : 'Re-assess site') : 'Assess site'}
          </Button>
          {stored && <div className="text-xs text-slate-500">Assessment {stored.id.slice(0, 8)} · {stored.created_at} UTC · {a?.lengthM} m{stale ? ' · settings changed, not yet re-assessed' : ''}</div>}
        </Section>

        {error && <Notice tone="bad">{error}</Notice>}

        {a && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-white/[0.04] border border-white/5 py-2"><div className="text-lg font-semibold text-rose-200">{constraints}</div><div className="text-[11px] text-slate-400">constraints in data</div></div>
              <div className="rounded-xl bg-white/[0.04] border border-white/5 py-2"><div className="text-lg font-semibold text-slate-200">{gaps}</div><div className="text-[11px] text-slate-400">unknowns</div></div>
              <div className="rounded-xl bg-white/[0.04] border border-white/5 py-2"><div className="text-lg font-semibold text-orange-200">{a.plan.investigations.length}</div><div className="text-[11px] text-slate-400">investigations</div></div>
            </div>

            {a.plan.flags.filter(f => f.severity !== 'info').length > 0 && (
              <Section title="Critical and high flags">
                <ul className="space-y-1.5">
                  {a.plan.flags.filter(f => f.severity !== 'info').map((f, i) => (
                    <li key={i} className={`rounded-lg border px-2.5 py-2 text-xs leading-snug ${f.severity === 'critical' ? 'border-rose-400/30 bg-rose-500/10 text-rose-100' : 'border-amber-400/25 bg-amber-500/10 text-amber-100'}`}>
                      <span className="font-semibold uppercase mr-1">{f.severity}</span>{f.text} <span className="text-slate-400">({f.ruleId}{f.onMissingData ? ', on missing data' : ''})</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Findings" aside={`${a.findings.length}`}>
              <ul className="space-y-1.5" data-testid="feasibility-findings">
                {a.findings.map(f => (
                  <li key={f.id} className="rounded-lg bg-white/[0.03] border border-white/5 px-2.5 py-2">
                    <div className="flex items-start gap-2"><CertChip c={f.certainty} /><span className="text-xs text-slate-500 ml-auto">{f.topic.replace('_', ' ')}</span></div>
                    <div className="text-[13px] text-slate-100 mt-1 leading-snug">{f.statement}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">Source: {f.source}</div>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Investigations checklist" aside="status from review history">
              <ul className="space-y-1.5" data-testid="feasibility-investigations">
                {a.plan.investigations.map(inv => {
                  const st = latestStatus.get(inv.id);
                  return (
                    <li key={inv.id} className="rounded-lg bg-white/[0.03] border border-white/5 px-2.5 py-2">
                      <details>
                        <summary className="cursor-pointer list-none flex items-start gap-2">
                          <ClipboardCheck size={14} className="mt-0.5 shrink-0 text-orange-300" />
                          <span className="text-[13px] text-slate-100 leading-snug flex-1">{inv.name}</span>
                          <span className="text-[11px] text-slate-400 shrink-0">{st ? REVIEW_STATUS_LABEL[st.status] : 'Not started'}</span>
                        </summary>
                        <div className="mt-1.5 pl-5 space-y-1 text-xs text-slate-300">
                          <div className="text-slate-500">Rules {inv.triggeredBy.join(', ')}{inv.firedOnMissingData ? ' · required because data is missing' : ''}</div>
                          <div><span className="text-slate-500">Methods: </span>{inv.methods.join('; ')}</div>
                          <div><span className="text-slate-500">Deliverables: </span>{inv.deliverables.join('; ')}</div>
                          <div><span className="text-slate-500">Disciplines: </span>{inv.disciplines.join(', ')}</div>
                          <div><span className="text-slate-500">Authorities to verify: </span>{inv.authorities.join('; ')}</div>
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </Section>

            <Section title="Investigation requirements document">
              <input aria-label="Project name" className={input} placeholder="Project name" value={docIn.project_name} onChange={e => setDocIn(s => ({ ...s, project_name: e.target.value }))} />
              <input aria-label="Locality / ward" className={input} placeholder="Locality / ward (optional)" value={docIn.location_description} onChange={e => setDocIn(s => ({ ...s, location_description: e.target.value }))} />
              <textarea aria-label="Reason for considering" className={input} rows={2} placeholder="Reason for considering the proposal (optional; left as 'not provided' otherwise)" value={docIn.reason} onChange={e => setDocIn(s => ({ ...s, reason: e.target.value }))} />
              <input aria-label="Responsible team" className={input} placeholder="Responsible team (optional)" value={docIn.responsible_team} onChange={e => setDocIn(s => ({ ...s, responsible_team: e.target.value }))} />
              <div className="grid grid-cols-2 gap-2">
                <Button icon={FileDown} spin={busy === 'pdf'} disabled={!!busy || !stored} onClick={() => gen('pdf')}>PDF</Button>
                <Button icon={FileText} spin={busy === 'docx'} disabled={!!busy || !stored} onClick={() => gen('docx')}>DOCX</Button>
              </div>
              {docs.length > 0 && (
                <ul className="text-xs space-y-1" data-testid="feasibility-documents">
                  {docs.map(d => <li key={d.id}><a className="text-cyan-300 hover:underline" href={documentUrl(d)} download={d.file_name}>{d.file_name}</a> <span className="text-slate-500">· {(d.size_bytes / 1024).toFixed(0)} KB · {d.generated_at}</span></li>)}
                </ul>
              )}
            </Section>

            <Section title="Evidence" aside={`${evidence.length} file(s)`}>
              {evidence.length > 0 && (
                <ul className="text-xs space-y-1">
                  {evidence.map(e => <li key={e.id} className="text-slate-300">{e.file_name} — {e.description} <span className="text-slate-500">({e.investigation_id ?? 'general'}, {e.provenance}, {e.uploaded_by}, sha256 {e.file_sha256.slice(0, 10)}…)</span></li>)}
                </ul>
              )}
              <input aria-label="Evidence file" type="file" className="block w-full text-xs text-slate-300 file:mr-2 file:rounded-lg file:border-0 file:bg-white/10 file:px-2 file:py-1 file:text-slate-100" onChange={e => setEv(s => ({ ...s, file: e.target.files?.[0] ?? null }))} />
              <input aria-label="Evidence description" className={input} placeholder="What is this file? (required)" value={ev.description} onChange={e => setEv(s => ({ ...s, description: e.target.value }))} />
              <div className="grid grid-cols-2 gap-2">
                <input aria-label="Uploaded by" className={input} placeholder="Uploaded by" value={ev.uploaded_by} onChange={e => setEv(s => ({ ...s, uploaded_by: e.target.value }))} />
                <select aria-label="Evidence provenance" className={input} value={ev.provenance} onChange={e => setEv(s => ({ ...s, provenance: e.target.value }))}>
                  {['measured', 'estimated', 'model_output', 'assumption', 'unknown'].map(p => <option key={p} value={p}>{p.replace('_', ' ')}</option>)}
                </select>
              </div>
              <select aria-label="Evidence for investigation" className={input} value={ev.investigation_id} onChange={e => setEv(s => ({ ...s, investigation_id: e.target.value }))}>
                <option value="">General (whole assessment)</option>
                {a.plan.investigations.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
              <Button icon={Upload} spin={busy === 'upload'} disabled={!!busy || !stored || !ev.file || ev.description.trim().length < 3 || !ev.uploaded_by.trim()} onClick={upload} className="w-full">Upload evidence</Button>
            </Section>

            <Section title="Review history" aside="append-only">
              <Notice tone="info">A review records who looked at what, with which evidence. No status here means engineering or statutory approval.</Notice>
              {reviews.length === 0 ? <div className="text-xs text-slate-500">No review records yet.</div> : (
                <ol className="space-y-1.5" data-testid="feasibility-reviews">
                  {reviews.map(r => (
                    <li key={r.id} className="rounded-lg bg-white/[0.03] border border-white/5 px-2.5 py-2 text-xs">
                      <div className="flex gap-2"><span className="text-slate-500">#{r.seq}</span><span className="text-slate-100 font-medium">{r.status_label}</span><span className="ml-auto text-slate-500">{r.created_at}</span></div>
                      <div className="text-slate-300">{r.reviewer_name} · {r.reviewer_role}{r.item_id ? ` · ${r.item_id}` : ' · whole assessment'}</div>
                      {r.external_reference && <div className="text-amber-200">External reference (recorded by user, not verified): {r.external_reference}</div>}
                      {r.evidence_ids.length > 0 && <div className="text-slate-500">Evidence: {r.evidence_ids.map(id => evidence.find(e => e.id === id)?.file_name ?? id.slice(0, 8)).join(', ')}</div>}
                      {r.notes && <div className="text-slate-400 mt-0.5">{r.notes}</div>}
                    </li>
                  ))}
                </ol>
              )}
              <div className="grid grid-cols-2 gap-2">
                <input aria-label="Reviewer name" className={input} placeholder="Reviewer name" value={rev.reviewer_name} onChange={e => setRev(s => ({ ...s, reviewer_name: e.target.value }))} />
                <input aria-label="Reviewer role" className={input} placeholder="Role / discipline" value={rev.reviewer_role} onChange={e => setRev(s => ({ ...s, reviewer_role: e.target.value }))} />
              </div>
              <select aria-label="Review status" className={input} value={rev.status} onChange={e => setRev(s => ({ ...s, status: e.target.value as ReviewStatus }))}>
                {(Object.keys(REVIEW_STATUS_LABEL) as ReviewStatus[]).map(s => <option key={s} value={s}>{REVIEW_STATUS_LABEL[s]}</option>)}
              </select>
              <select aria-label="Review item" className={input} value={rev.item} onChange={e => setRev(s => ({ ...s, item: e.target.value }))}>
                <option value="">Whole assessment</option>
                {a.plan.investigations.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
              {rev.status === 'external_approval_recorded_unverified' && (
                <input aria-label="External reference" className={input} placeholder="Authority, reference no., date (required)" value={rev.external_reference} onChange={e => setRev(s => ({ ...s, external_reference: e.target.value }))} />
              )}
              {evidence.length > 0 && (
                <div className="space-y-1">{evidence.map(e => (
                  <label key={e.id} className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={rev.evidence_ids.includes(e.id)} onChange={x => setRev(s => ({ ...s, evidence_ids: x.target.checked ? [...s.evidence_ids, e.id] : s.evidence_ids.filter(i => i !== e.id) }))} />
                    {e.file_name}
                  </label>
                ))}</div>
              )}
              <textarea aria-label="Review notes" className={input} rows={2} placeholder="Notes" value={rev.notes} onChange={e => setRev(s => ({ ...s, notes: e.target.value }))} />
              <Button icon={ClipboardCheck} spin={busy === 'review'} disabled={!!busy || !stored || !rev.reviewer_name.trim() || !rev.reviewer_role.trim() || (rev.status === 'external_approval_recorded_unverified' && !rev.external_reference.trim())} onClick={submitReview} className="w-full">Add review record</Button>
            </Section>

            <div className="text-[11px] text-slate-500 leading-snug">{a.disclaimer} Engine: {a.engineVersion}; {a.plan.rulesVersion}.</div>
          </>
        )}
      </div>
    </div>
  );
};
