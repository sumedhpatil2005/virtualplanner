import React, { useState } from 'react';
import { ChevronDown, Info, type LucideIcon } from 'lucide-react';
import { TONE_CHIP, TONE_TEXT, losTone, type Tone } from './vizTones';

/**
 * Small visual building blocks for the analysis panels: chips, KPI cards,
 * bars and collapsed disclosures. Plain CSS/SVG-free markup in the panel's
 * own palette (slate-950 glass, cyan accent), no chart library.
 */

export const Chip: React.FC<{ tone?: Tone; icon?: LucideIcon; title?: string; children: React.ReactNode; className?: string; testId?: string; size?: 'sm' | 'md' }> = ({ tone = 'neutral', icon: Icon, title, children, className = '', testId, size = 'sm' }) => (
  <span title={title} data-testid={testId}
    className={`inline-flex items-center gap-1 rounded-full border whitespace-nowrap ${size === 'md' ? 'px-2.5 py-1 text-sm font-semibold' : 'px-2 py-0.5 text-[11px] font-medium'} ${TONE_CHIP[tone]} ${className}`}>
    {Icon && <Icon size={size === 'md' ? 14 : 11} aria-hidden />}{children}
  </span>
);

/** Level of service letter in a coloured square. */
export const LosBadge: React.FC<{ los: string | null | undefined; size?: 'sm' | 'lg' }> = ({ los, size = 'sm' }) => {
  const t = losTone(los);
  return (
    <span title={`Level of service ${los ?? 'unknown'} (Indo-HCM 2017, urban streets: travel speed as a share of free-flow speed; A best, F worst)`} data-testid="los-badge"
      className={`inline-flex items-center justify-center rounded-md border font-bold tabular-nums ${size === 'lg' ? 'h-8 w-8 text-lg' : 'h-5 min-w-5 px-1 text-[11px]'} ${TONE_CHIP[t]}`}>{los ?? '—'}</span>
  );
};

/** A horizontal bar: value as a share of max, optionally with a marker (e.g. capacity at 100%). */
export const Meter: React.FC<{ value: number; max?: number; color: string; title?: string; height?: 'xs' | 'sm' | 'md'; marker?: number; testId?: string; track?: string }> = ({ value, max = 1, color, title, height = 'sm', marker, testId, track = 'bg-white/10' }) => {
  const pct = max > 0 ? Math.max(0, Math.min(100, (100 * value) / max)) : 0;
  const h = height === 'xs' ? 'h-1' : height === 'md' ? 'h-2.5' : 'h-1.5';
  return (
    <div className={`relative ${h} w-full rounded-full ${track} overflow-hidden`} title={title} data-testid={testId}>
      <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: color }} />
      {marker !== undefined && max > 0 && <div className="absolute top-0 bottom-0 w-px bg-white/60" style={{ left: `${Math.min(100, (100 * marker) / max)}%` }} />}
    </div>
  );
};

export interface BarPart { key: string; label: string; value: number; color: string }

/** One stacked bar with a legend underneath (values shown as given, with their unit). */
export const StackedBar: React.FC<{ parts: BarPart[]; unit?: string; total?: number; testId?: string; legendCols?: 1 | 2; height?: 'sm' | 'md' }> = ({ parts, unit = '', total, testId, legendCols = 2, height = 'md' }) => {
  const sum = Math.max(1e-9, total ?? parts.reduce((n, p) => n + p.value, 0));
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className={`flex ${height === 'md' ? 'h-3' : 'h-2'} w-full rounded-full overflow-hidden bg-white/10`}>
        {parts.map(p => p.value > 0 && <div key={p.key} style={{ width: `${(100 * p.value) / sum}%`, background: p.color }} title={`${p.label}: ${Math.round(p.value)}${unit}`} />)}
      </div>
      <ul className={`grid ${legendCols === 2 ? 'grid-cols-2' : 'grid-cols-1'} gap-x-3 gap-y-0.5 text-[11px] text-slate-400`}>
        {parts.map(p => (
          <li key={p.key} className="flex items-center gap-1.5 min-w-0">
            <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: p.color }} />
            <span className="truncate" title={p.label}>{p.label}</span>
            <span className="ml-auto text-slate-200 tabular-nums shrink-0">{Math.round(p.value)}{unit}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** A compact figure: label, big value with unit, one line under it. */
export const KpiCard: React.FC<{ label: string; value: React.ReactNode; unit?: string; sub?: React.ReactNode; tone?: Tone; title?: string; testId?: string; children?: React.ReactNode }> = ({ label, value, unit, sub, tone = 'neutral', title, testId, children }) => (
  <div className="rounded-xl border border-white/5 bg-white/[0.04] px-2.5 py-2 min-w-0" title={title} data-testid={testId}>
    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 truncate">{label}</div>
    <div className={`mt-0.5 flex items-baseline gap-0.5 leading-none ${TONE_TEXT[tone]}`}>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      {unit && <span className="text-[11px] font-medium text-slate-400">{unit}</span>}
    </div>
    {sub && <div className="mt-1 text-[10px] text-slate-500 truncate">{sub}</div>}
    {children}
  </div>
);

/** A section closed by default, for methodology, assumptions and per-run detail. */
export const Disclosure: React.FC<{ title: string; icon?: LucideIcon; children: React.ReactNode; defaultOpen?: boolean; testId?: string; aside?: React.ReactNode; tone?: 'plain' | 'subtle' }> = ({ title, icon: Icon, children, defaultOpen = false, testId, aside, tone = 'plain' }) => (
  <details className={`group rounded-xl border ${tone === 'subtle' ? 'border-white/5 bg-transparent' : 'border-white/10 bg-white/[0.02]'}`} open={defaultOpen || undefined} data-testid={testId}>
    <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white list-none [&::-webkit-details-marker]:hidden">
      {Icon && <Icon size={13} className="text-slate-500 shrink-0" />}
      <span className="flex-1">{title}</span>
      {aside && <span className="text-[11px] text-slate-500">{aside}</span>}
      <ChevronDown size={14} className="transition group-open:rotate-180 shrink-0" />
    </summary>
    <div className="space-y-2 border-t border-white/5 px-3 py-2.5 text-xs text-slate-400 leading-snug">{children}</div>
  </details>
);

/** A small (i) button that shows an explanation underneath when pressed. */
export const InfoToggle: React.FC<{ label?: string; children: React.ReactNode; testId?: string }> = ({ label = 'Why?', children, testId }) => {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testId}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-cyan-200 cursor-pointer">
        <Info size={12} />{label}
      </button>
      {open && <div className="mt-1.5 text-[11px] leading-snug text-slate-400 space-y-1">{children}</div>}
    </div>
  );
};

/** A card frame for one analysis block. */
export const Card: React.FC<{ children: React.ReactNode; className?: string; testId?: string; tone?: 'plain' | 'warn' | 'good' | 'accent'; data?: Record<string, string> }> = ({ children, className = '', testId, tone = 'plain', data }) => (
  <div data-testid={testId} {...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
    className={`rounded-xl border p-3 space-y-2.5 ${tone === 'warn' ? 'border-amber-400/25 bg-amber-500/[0.06]' : tone === 'good' ? 'border-emerald-400/20 bg-emerald-500/5' : tone === 'accent' ? 'border-indigo-400/25 bg-indigo-500/[0.06]' : 'border-white/10 bg-white/[0.03]'} ${className}`}>
    {children}
  </div>
);
