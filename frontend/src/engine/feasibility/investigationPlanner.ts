/**
 * Applies investigationRules.json (docs/INVESTIGATION_REQUIREMENTS.md §2) to
 * site attributes: tri-state, conservative. A rule that evaluates `unknown`
 * fires exactly like a `true` rule and adds a data-gap entry — missing data
 * never suppresses an investigation (mission §7, principle 8).
 */
import rulesJson from './investigationRules.json';
import type {
  AttrValue, Certainty, DataGap, InvestigationPlan, PlanFlag, ProposalType, RequiredInvestigation, RuleResult, SiteAttributes, Tri,
} from './types';

interface Cond { attr: string; op: 'eq' | 'gt' | 'lte' | 'in'; value?: unknown; threshold?: string }
interface Rule {
  id: string; title: string; proposalTypes: string[];
  when: { all?: Cond[]; any?: Cond[] };
  require: string[]; flags: { severity: 'critical' | 'high' | 'info'; text: string }[];
  sourceRefs: string[]; defaultCertainty?: Certainty;
}
interface Threshold { value: number; unit?: string; basis: string; note?: string; sourceRefs?: string[] }
export interface RulesData {
  schemaVersion: number; disclaimer: string;
  thresholds: Record<string, Threshold>;
  investigations: Record<string, { name: string; methods: string[]; deliverables: string[]; disciplines: string[]; standards: string[]; authorities: string[]; sourceRefs: string[]; certainty?: Certainty }>;
  rules: Rule[];
  sources: Record<string, { title: string; url?: string; evidence?: string }>;
}

export const RULES = rulesJson as unknown as RulesData;
export const RULES_VERSION = `investigationRules v${RULES.schemaVersion} (${(rulesJson as { generatedOn?: string }).generatedOn ?? 'n/d'})`;

/** Hypothetical screening thresholds may be overridden per project; statutory/authority values may not. */
export function resolveThresholds(overrides: Record<string, number> = {}): Record<string, Threshold> {
  const out: Record<string, Threshold> = {};
  for (const [k, t] of Object.entries(RULES.thresholds)) {
    out[k] = { ...t };
    if (overrides[k] !== undefined && t.basis === 'hypothetical' && Number.isFinite(overrides[k])) {
      out[k] = { ...t, value: overrides[k], note: `${t.note ?? ''} (project override; default ${t.value})`.trim() };
    }
  }
  return out;
}

const isUnknown = (v: unknown) => v === undefined || v === null || v === 'unknown';

export function evalCond(c: Cond, site: SiteAttributes, th: Record<string, Threshold>): Tri {
  const v = site[c.attr]?.value;
  if (isUnknown(v)) return 'unknown';
  const ref = c.threshold ? th[c.threshold]?.value : c.value;
  if (ref === undefined) return 'unknown';
  switch (c.op) {
    case 'eq': return v === ref;
    case 'gt': return typeof v === 'number' && typeof ref === 'number' ? v > ref : 'unknown';
    case 'lte': return typeof v === 'number' && typeof ref === 'number' ? v <= ref : 'unknown';
    case 'in': return Array.isArray(ref) ? ref.includes(v) : 'unknown';
    default: return 'unknown';
  }
}

export function evalAll(rs: Tri[]): Tri {
  if (rs.some(r => r === false)) return false;
  if (rs.every(r => r === true)) return true;
  return 'unknown';
}
export function evalAny(rs: Tri[]): Tri {
  if (rs.some(r => r === true)) return true;
  if (rs.length > 0 && rs.every(r => r === false)) return false;
  return 'unknown';
}

export function evaluateRule(rule: Rule, type: ProposalType, site: SiteAttributes, th: Record<string, Threshold>): RuleResult {
  const applies = rule.proposalTypes.includes(type);
  const conds = [...(rule.when.all ?? []), ...(rule.when.any ?? [])];
  const evidence = conds.map(c => {
    const a = site[c.attr];
    return { attr: c.attr, value: (a?.value ?? 'unknown') as AttrValue | 'unknown', certainty: (a?.certainty ?? 'unknown') as Certainty, source: a?.source ?? 'not computed' };
  });
  if (!applies) return { id: rule.id, title: rule.title, applies, result: false, missing: [], evidence: [] };
  const allR = (rule.when.all ?? []).map(c => evalCond(c, site, th));
  const anyR = (rule.when.any ?? []).map(c => evalCond(c, site, th));
  let result: Tri;
  if (allR.length === 0 && anyR.length === 0) result = true;
  else if (anyR.length === 0) result = evalAll(allR);
  else if (allR.length === 0) result = evalAny(anyR);
  else result = evalAll([evalAll(allR), evalAny(anyR)]);
  const missing = result === 'unknown' ? [...new Set(conds.filter(c => evalCond(c, site, th) === 'unknown').map(c => c.attr))] : [];
  return { id: rule.id, title: rule.title, applies, result, missing, evidence };
}

export function planInvestigations(type: ProposalType, site: SiteAttributes, overrides: Record<string, number> = {}): InvestigationPlan {
  const th = resolveThresholds(overrides);
  const ruleResults = RULES.rules.map(r => evaluateRule(r, type, site, th));
  const byId = new Map<string, RequiredInvestigation>();
  const flags: PlanFlag[] = [];
  const dataGaps: DataGap[] = [];
  const usedThresholds = new Set<string>();
  for (const rule of RULES.rules) {
    const rr = ruleResults.find(x => x.id === rule.id)!;
    if (!rr.applies) continue;
    for (const c of [...(rule.when.all ?? []), ...(rule.when.any ?? [])]) if (c.threshold) usedThresholds.add(c.threshold);
    if (rr.result === false) continue;
    const onMissing = rr.result === 'unknown';
    if (onMissing) dataGaps.push({ ruleId: rule.id, title: rule.title, attrs: rr.missing });
    for (const f of rule.flags) flags.push({ ruleId: rule.id, severity: f.severity, text: f.text, onMissingData: onMissing });
    for (const invId of rule.require) {
      const def = RULES.investigations[invId];
      if (!def) continue;
      const cur = byId.get(invId);
      if (cur) {
        if (!cur.triggeredBy.includes(rule.id)) cur.triggeredBy.push(rule.id);
        cur.sourceRefs = [...new Set([...cur.sourceRefs, ...rule.sourceRefs, ...def.sourceRefs])];
      } else {
        byId.set(invId, {
          id: invId, name: def.name, methods: def.methods, deliverables: def.deliverables, disciplines: def.disciplines,
          standards: def.standards, authorities: def.authorities, triggeredBy: [rule.id],
          sourceRefs: [...new Set([...rule.sourceRefs, ...def.sourceRefs])],
          certainty: def.certainty ?? rule.defaultCertainty ?? 'requires_field_investigation',
          firedOnMissingData: onMissing,
        });
      }
    }
  }
  const sev = { critical: 0, high: 1, info: 2 } as const;
  flags.sort((a, b) => sev[a.severity] - sev[b.severity]);
  const investigations = [...byId.values()];
  // A deduplicated investigation is "fired on missing data" only if every triggering rule was unknown.
  for (const inv of investigations) {
    inv.firedOnMissingData = inv.triggeredBy.every(id => ruleResults.find(r => r.id === id)?.result === 'unknown');
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  const refs = uniq(investigations.flatMap(i => i.sourceRefs));
  return {
    rulesVersion: RULES_VERSION,
    ruleResults,
    investigations,
    flags,
    dataGaps,
    disciplines: uniq(investigations.flatMap(i => i.disciplines)),
    standards: uniq(investigations.flatMap(i => i.standards)),
    authorities: uniq(investigations.flatMap(i => i.authorities)),
    sources: refs.filter(r => RULES.sources[r]).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map(r => ({ id: r, ...RULES.sources[r] })),
    thresholdsUsed: [...usedThresholds].map(k => ({ key: k, value: th[k].value, unit: th[k].unit, basis: th[k].basis, note: th[k].note })),
  };
}
