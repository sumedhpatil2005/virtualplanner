import React from 'react';
import { PanelRight } from 'lucide-react';
import { useShellStore } from './useShellStore';

/**
 * Shown in a context panel that summarises the selection (Explore, Environment) while the inspector is closed — on
 * one-overlay sizes a selection keeps the context panel instead of replacing it. Opens the inspector (real action).
 */
export const SelectionDetailsButton: React.FC = () => {
  const inspectorOpen = useShellStore(s => s.inspectorOpen);
  const setInspectorOpen = useShellStore(s => s.setInspectorOpen);
  if (inspectorOpen) return null;
  return (
    <button type="button" className="uos-btn uos-btn-sm" data-testid="open-inspector" onClick={() => setInspectorOpen(true)}>
      <PanelRight size={14} aria-hidden />Open details
    </button>
  );
};
