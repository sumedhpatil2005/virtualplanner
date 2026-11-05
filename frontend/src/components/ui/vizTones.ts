/** Tones of the analysis panels' chips, figures and bars (shared by ui/viz.tsx and the panels). */

export type Tone = 'neutral' | 'good' | 'ok' | 'warn' | 'alert' | 'bad' | 'info' | 'accent';

export const TONE_CHIP: Record<Tone, string> = {
  neutral: 'text-slate-300 bg-white/[0.04] border-white/10',
  good: 'text-emerald-200 bg-emerald-500/15 border-emerald-400/30',
  ok: 'text-lime-200 bg-lime-500/15 border-lime-400/30',
  warn: 'text-amber-200 bg-amber-500/15 border-amber-400/30',
  alert: 'text-orange-200 bg-orange-500/15 border-orange-400/30',
  bad: 'text-rose-200 bg-rose-500/15 border-rose-400/30',
  info: 'text-cyan-200 bg-cyan-500/10 border-cyan-400/30',
  accent: 'text-indigo-200 bg-indigo-500/15 border-indigo-400/30',
};
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-white', good: 'text-emerald-300', ok: 'text-lime-300', warn: 'text-amber-300', alert: 'text-orange-300', bad: 'text-rose-300', info: 'text-cyan-300', accent: 'text-indigo-300',
};
export const TONE_FILL: Record<Tone, string> = {
  neutral: '#94a3b8', good: '#34d399', ok: '#a3e635', warn: '#fbbf24', alert: '#fb923c', bad: '#f43f5e', info: '#22d3ee', accent: '#818cf8',
};

/** Level of service letter to tone (Indo-HCM A-F). */
export const losTone = (los: string | null | undefined): Tone =>
  los === 'A' || los === 'B' ? 'good' : los === 'C' ? 'ok' : los === 'D' ? 'warn' : los === 'E' ? 'alert' : los === 'F' ? 'bad' : 'neutral';
