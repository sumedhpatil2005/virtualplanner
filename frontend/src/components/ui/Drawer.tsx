import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Tabs, TabPanel, type TabDef } from './Tabs';
import { IconButton } from './IconButton';

export interface DrawerTab<T extends string = string> extends TabDef<T> {
  content: React.ReactNode;
}

/**
 * Bottom drawer: one tab strip, one body (PRODUCT_UX_RESEARCH §5.5). Collapsed it shows the tab strip only.
 * Rendered by the shell only when the active workspace registers tabs, so it is never an empty frame.
 */
export function Drawer<T extends string>({ tabs, active, onTab, open, onToggle, label }: {
  tabs: DrawerTab<T>[];
  active: T;
  onTab: (id: T) => void;
  open: boolean;
  onToggle: () => void;
  label: string;
}) {
  const current = tabs.find(t => t.id === active) ?? tabs[0];
  if (!current) return null;
  return (
    <section className={`uos-drawer ${open ? 'is-open' : ''}`} aria-label={label}>
      <div className="uos-drawer-bar">
        <Tabs tabs={tabs} value={current.id} onChange={id => { onTab(id); if (!open) onToggle(); }} label={label} idBase="uos-drawer" />
        <IconButton icon={open ? ChevronDown : ChevronUp} label={open ? 'Collapse drawer' : 'Expand drawer'} onClick={onToggle} size="sm" tooltip="left" aria-expanded={open} />
      </div>
      {open && <TabPanel idBase="uos-drawer" id={current.id} className="uos-drawer-body">{current.content}</TabPanel>}
    </section>
  );
}
