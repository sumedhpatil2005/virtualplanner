import React from 'react';
import ToolPalette from '../../components/design/ToolPalette';
import { ScenarioSelector } from '../../components/ScenarioSelector';
import { PanelSection } from '../../components/ui/Panel';

/**
 * MOUNT POINT for the Design tool palette. Renders the categorised ToolPalette (tools.ts categories, hotkeys 1–9). Only one bar is mounted at a time (each owns an import-progress overlay).
 * The categorised ToolPalette built by the design-tools work replaces the body of this one component; nothing else in
 * the shell needs to change.
 */
export const DesignToolPalette: React.FC = () => (
  <div data-slot="design-tool-palette"><ToolPalette /></div>
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
