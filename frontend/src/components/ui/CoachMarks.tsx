import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { OPEN_TOOLBAR_EVENT } from '../tools';

const STORAGE_KEY = 'twincity.onboarding.v2';

interface Mark {
  target: string; // value of the data-coach attribute
  title: string;
  text: string;
  side: 'above' | 'below' | 'left';
}

const MARKS: Mark[] = [
  {
    target: 'mode-switch',
    title: 'View · Build · Simulate',
    text: 'View shows the details of what you built. Build draws roads, flyovers, metro and buildings. Simulate runs traffic around any road you click.',
    side: 'below',
  },
];

const readDismissed = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'done';
  } catch {
    return false;
  }
};

/**
 * One-time first-run overlay pointing at the three things a new user needs.
 * Dismissal persists in localStorage.
 */
export const CoachMarks: React.FC = () => {
  const [visible, setVisible] = useState(() => !readDismissed());
  const [rects, setRects] = useState<Record<string, DOMRect | null>>({});

  const measure = useCallback(() => {
    const next: Record<string, DOMRect | null> = {};
    for (const m of MARKS) {
      const el = document.querySelector(`[data-coach="${m.target}"]`);
      next[m.target] = el ? el.getBoundingClientRect() : null;
    }
    setRects(next);
  }, []);

  useEffect(() => {
    if (!visible) return;
    // The mode switch lives inside the tools bar, so open it for the tour
    window.dispatchEvent(new Event(OPEN_TOOLBAR_EVENT));
    const t = setTimeout(measure, 50);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
    };
  }, [visible, measure]);

  useLayoutEffect(() => {
    if (visible) measure();
  }, [visible, measure]);

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'done');
    } catch {
      // Storage unavailable (private mode) — dismiss for this session only
    }
    setVisible(false);
  };

  if (!visible) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90000] bg-slate-950/55 animate-fade-in" role="dialog" aria-modal="true" aria-label="Getting started">
      {MARKS.map(m => {
        const r = rects[m.target];
        if (!r) return null;
        const style: React.CSSProperties =
          m.side === 'above'
            ? { left: r.left, bottom: window.innerHeight - r.top + 14 }
            : m.side === 'below'
              ? { left: r.left, top: r.bottom + 14 }
              : { right: window.innerWidth - r.left + 14, top: Math.max(16, r.top + 80) };
        return (
          <React.Fragment key={m.target}>
            {/* Highlight ring around the target */}
            <div
              className="fixed rounded-2xl ring-2 ring-amber-400 pointer-events-none"
              style={{ left: r.left - 4, top: r.top - 4, width: r.width + 8, height: r.height + 8 }}
            />
            <div className="fixed w-80 bg-slate-900 rounded-xl border border-amber-400/40 p-3.5 shadow-2xl" style={style}>
              <div className="text-amber-300 text-sm font-bold mb-1">{m.title}</div>
              <div className="text-slate-200 text-sm leading-relaxed">{m.text}</div>
            </div>
          </React.Fragment>
        );
      })}

      <div className="fixed bottom-8 left-1/2 -translate-x-1/2 glass-panel bg-slate-900/95 rounded-2xl border border-white/10 px-5 py-3 flex items-center gap-4 shadow-2xl">
        <span className="text-sm text-slate-300">
          Press <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600/60 font-mono">?</kbd> any time for keyboard shortcuts.
        </span>
        <button
          onClick={dismiss}
          autoFocus
          className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm rounded-lg px-4 py-1.5 cursor-pointer"
        >
          Got it
        </button>
      </div>
    </div>,
    document.body
  );
};
