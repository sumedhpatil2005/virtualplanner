import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Keyboard, X } from 'lucide-react';
import { TOOLS } from '../tools';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const GENERAL: [string, string][] = [
  ['Esc', 'Cancel drawing, or go back'],
  ['Enter', 'Finish the current line or polygon'],
  ['Double-click', 'Finish the current line or polygon'],
  ['Right-click point', 'Remove a placed point'],
  ['Ctrl + Z', 'Undo'],
  ['Ctrl + Y', 'Redo (also Ctrl + Shift + Z)'],
  ['Delete', 'Delete selected object'],
  ['R / Shift + R', 'Rotate selected metro station ±15°'],
  ['?', 'Show / hide this list'],
  ['Shift + click', 'Simulate: add or remove a road, for a corridor'],
  ['Esc', 'Simulate: choose another road, then back to View'],
];

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="px-1.5 py-0.5 rounded-md bg-slate-800 border border-slate-600/60 text-sm font-mono text-slate-100 whitespace-nowrap">
    {children}
  </kbd>
);

export const ShortcutsOverlay: React.FC<Props> = ({ isOpen, onClose }) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="glass-panel w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900/95 p-5 shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Keyboard size={16} className="text-indigo-400" /> Keyboard shortcuts
          </h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs">
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-semibold">General</div>
            {GENERAL.map(([k, d]) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <span className="text-slate-300">{d}</span>
                <Kbd>{k}</Kbd>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Tools <span className="normal-case text-slate-500">(in Build mode)</span></div>
            {TOOLS.filter(t => t.hotkey).map(t => (
              <div key={t.mode} className="flex items-center justify-between gap-3">
                <span className="text-slate-300">{t.label}</span>
                <Kbd>{t.hotkey}</Kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
