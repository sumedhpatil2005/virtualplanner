import React from 'react';
import { Eye, Hammer, Activity, type LucideIcon } from 'lucide-react';
import { engineInstance, type AppMode } from '../engine/TwinCityEngine';
import { useAppMode } from '../hooks/useAppMode';

const MODES: { id: AppMode; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'view', label: 'View', icon: Eye, hint: 'Look around and see details of what you have built' },
  { id: 'build', label: 'Build', icon: Hammer, hint: 'Draw and edit roads, flyovers, metro and buildings' },
  { id: 'simulate', label: 'Simulate', icon: Activity, hint: 'Run traffic around any road you click' },
];

/** The three things the app does, always one click away. */
export const ModeBar: React.FC = () => {
  const mode = useAppMode();
  return (
    <nav
      data-coach="mode-switch"
      aria-label="Mode"
      className="flex items-center gap-1 p-1 rounded-2xl bg-slate-950/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/40 pointer-events-auto"
    >
      {MODES.map(m => {
        const Icon = m.icon;
        const active = mode === m.id;
        return (
          <button
            key={m.id}
            onClick={() => engineInstance.setAppMode(m.id)}
            aria-pressed={active}
            title={m.hint}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition cursor-pointer ${
              active
                ? m.id === 'simulate' ? 'bg-cyan-500 text-slate-950' : m.id === 'build' ? 'bg-indigo-500 text-white' : 'bg-white text-slate-950'
                : 'text-slate-300 hover:text-white hover:bg-white/5'
            }`}
          >
            <Icon size={16} />
            {m.label}
          </button>
        );
      })}
    </nav>
  );
};
