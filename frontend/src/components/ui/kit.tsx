import React from 'react';
import { ArrowLeft, X, type LucideIcon } from 'lucide-react';

/**
 * Shared building blocks for the side panels, so every panel reads the same:
 * 14 px body text, 12 px labels, large figures, one primary action.
 */

export const SidePanel: React.FC<{ children: React.ReactNode; label: string }> = ({ children, label }) => (
  <aside
    aria-label={label}
    className="w-[22rem] max-h-full flex flex-col rounded-2xl bg-slate-950/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/40 overflow-hidden pointer-events-auto animate-fade-in"
  >
    {children}
  </aside>
);

export const PanelHeader: React.FC<{
  title: string;
  subtitle?: React.ReactNode;
  onBack?: () => void;
  backLabel?: string;
  onClose?: () => void;
  closeLabel?: string;
  accessory?: React.ReactNode;
}> = ({ title, subtitle, onBack, backLabel = 'Back', onClose, closeLabel = 'Close', accessory }) => (
  <header className="px-4 pt-3.5 pb-3 border-b border-white/10 shrink-0">
    {onBack && (
      <button
        onClick={onBack}
        className="-ml-1 mb-2 inline-flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-white/5 cursor-pointer transition"
      >
        <ArrowLeft size={16} /> {backLabel}
      </button>
    )}
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <h2 className="text-base font-semibold text-white leading-snug break-words">{title}</h2>
        {subtitle && <div className="text-sm text-slate-400 mt-0.5">{subtitle}</div>}
      </div>
      {accessory}
      {onClose && (
        <button
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="p-1.5 -mr-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 cursor-pointer transition"
        >
          <X size={18} />
        </button>
      )}
    </div>
  </header>
);

export const PanelBody: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">{children}</div>
);

export const Section: React.FC<{ title?: string; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, aside, children }) => (
  <section className="space-y-2">
    {(title || aside) && (
      <div className="flex items-baseline justify-between gap-2">
        {title && <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>}
        {aside && <span className="text-xs text-slate-500">{aside}</span>}
      </div>
    )}
    {children}
  </section>
);

export const Figure: React.FC<{ label: string; value: string; hint?: string; tone?: 'good' | 'warn' | 'bad' }> = ({ label, value, hint, tone }) => (
  <div className="rounded-xl bg-white/[0.04] border border-white/5 px-3 py-2.5">
    <div className="text-xs text-slate-400">{label}</div>
    <div className={`text-xl font-semibold tabular-nums leading-tight mt-0.5 ${
      tone === 'good' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-rose-300' : 'text-white'
    }`}>{value}</div>
    {hint && <div className="text-xs text-slate-500 mt-0.5">{hint}</div>}
  </div>
);

/** Label / value rows, for facts about an object. */
export const Facts: React.FC<{ rows: [string, React.ReactNode][] }> = ({ rows }) => (
  <dl className="rounded-xl bg-white/[0.04] border border-white/5 divide-y divide-white/5">
    {rows.map(([k, v]) => (
      <div key={k} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
        <dt className="text-slate-400">{k}</dt>
        <dd className="text-slate-100 font-medium text-right">{v}</dd>
      </div>
    ))}
  </dl>
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'sm';
  /** Spin the icon (loading). */
  spin?: boolean;
};

export const Button: React.FC<ButtonProps> = ({ icon: Icon, variant = 'secondary', size = 'md', spin, className = '', children, ...rest }) => (
  <button
    {...rest}
    className={`inline-flex items-center justify-center font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
      size === 'sm' ? 'gap-1.5 rounded-lg px-2 py-1 text-xs' : 'gap-2 rounded-xl px-3.5 py-2 text-sm'
    } ${
      variant === 'primary'
        ? 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
        : variant === 'ghost'
          ? 'text-slate-300 hover:text-white hover:bg-white/5'
          : 'bg-white/[0.07] text-slate-100 hover:bg-white/[0.12] border border-white/10'
    } ${className}`}
  >
    {Icon && <Icon size={size === 'sm' ? 14 : 16} className={spin ? 'animate-spin' : undefined} />}
    {children}
  </button>
);

/** One choice from a few, e.g. 1 km / 2 km / 3 km. */
export function Segmented<T extends string | number>({ options, value, onChange, label }: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-xl bg-white/[0.04] border border-white/10 p-1">
      {options.map(o => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-lg px-2 py-1.5 text-sm font-medium transition cursor-pointer ${
            o.value === value ? 'bg-white text-slate-950 shadow' : 'text-slate-300 hover:text-white'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Notice: React.FC<{ tone?: 'info' | 'warn' | 'bad' | 'good'; icon?: LucideIcon; spin?: boolean; children: React.ReactNode; action?: React.ReactNode }> = ({ tone = 'info', icon: Icon, spin, children, action }) => (
  <div className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${
    tone === 'warn' ? 'bg-amber-500/10 border-amber-400/20 text-amber-100'
    : tone === 'bad' ? 'bg-rose-500/10 border-rose-400/20 text-rose-100'
    : tone === 'good' ? 'bg-emerald-500/10 border-emerald-400/20 text-emerald-100'
    : 'bg-cyan-500/10 border-cyan-400/20 text-cyan-50'
  }`}>
    {Icon && <Icon size={16} className={`shrink-0 mt-0.5 ${spin ? 'animate-spin' : ''}`} />}
    <div className="flex-1 leading-snug">{children}</div>
    {action}
  </div>
);
