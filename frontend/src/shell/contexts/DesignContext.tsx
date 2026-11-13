import React from 'react';
import { Toolbar } from '../../components/Toolbar';
import { ScenarioSelector } from '../../components/ScenarioSelector';
import { PanelSection } from '../../components/ui/Panel';

/**
 * MOUNT POINT for the Design tool palette. Today it renders the existing Toolbar (tools.ts, hotkeys 1–9) unchanged.
 * The categorised ToolPalette built by the design-tools work replaces the body of this one component; nothing else in
 * the shell needs to change.
 */
export const DesignToolPalette: React.FC = () => (
  <div className="uos-embed-toolbar" data-slot="design-tool-palette"><Toolbar /></div>
);

/**
 * Design workspace context panel: tools, then Alternatives (existing ScenarioSelector, which owns #scenario-select,
 * "New proposal", "Compare with base city" and ScenarioVersions). While Design is open the top bar's alternative chip
 * points here instead of mounting a second ScenarioSelector (the select's id must stay unique).
 */
export const DesignContext: React.FC = () => (
  <div className="space-y-5">
    <PanelSection title="Tools">
      <DesignToolPalette />
    </PanelSection>
    <PanelSection title="Alternatives">
      <div id="uos-alternatives" className="uos-embed-card"><ScenarioSelector /></div>
    </PanelSection>
  </div>
);
