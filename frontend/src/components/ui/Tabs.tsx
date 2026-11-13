import React, { useRef } from 'react';

export interface TabDef<T extends string> {
  id: T;
  label: string;
  /** Tooltip / longer description. */
  hint?: string;
  'data-testid'?: string;
}

/**
 * WAI-ARIA tabs (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): role=tablist/tab, aria-selected, roving tabindex,
 * Left/Right/Home/End move between tabs. Labels are one word where possible (PRODUCT_UX_RESEARCH §2.1, Kepler.gl).
 * The tab panel is rendered by the caller with <TabPanel>.
 */
export function Tabs<T extends string>({ tabs, value, onChange, label, idBase }: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="uos-tabs">
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={el => { refs.current[i] = el; }}
            role="tab"
            type="button"
            id={`${idBase}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            title={t.hint}
            data-testid={t['data-testid']}
            onClick={() => onChange(t.id)}
            onKeyDown={e => onKey(e, i)}
            className={`uos-tab ${selected ? 'is-active' : ''}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const TabPanel: React.FC<{ idBase: string; id: string; children: React.ReactNode; className?: string }> = ({ idBase, id, children, className = '' }) => (
  <div role="tabpanel" id={`${idBase}-panel-${id}`} aria-labelledby={`${idBase}-tab-${id}`} className={className}>
    {children}
  </div>
);
