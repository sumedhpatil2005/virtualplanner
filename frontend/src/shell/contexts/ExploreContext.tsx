import React, { useMemo } from 'react';
import { LayerManager } from '../../components/LayerManager';
import { MetricTile } from '../../components/ui/MetricTile';
import { PanelSection } from '../../components/ui/Panel';
import { useEngineObjects } from '../useEngineObjects';
import { engineInstance } from '../../engine/TwinCityEngine';

/** Explore: the layer registry (existing LayerManager, unchanged) and counts of what is in the active alternative. */
export const ExploreContext: React.FC = () => {
  const objects = useEngineObjects();
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const o of objects) c[o.type] = (c[o.type] ?? 0) + 1;
    return c;
  }, [objects]);
  const alt = engineInstance.scenarios.getActiveScenario();
  return (
    <div className="space-y-5">
      <PanelSection title="Layers">
        <div className="uos-embed-layers"><LayerManager /></div>
      </PanelSection>
      <PanelSection title="In this alternative" aside={alt?.name}>
        <div className="grid grid-cols-2 gap-2" data-testid="explore-counts">
          <MetricTile label="Roads" value={counts.road ?? 0} />
          <MetricTile label="Buildings" value={counts.building ?? 0} />
          <MetricTile label="Flyovers" value={(counts.flyover ?? 0) + (counts.metro_flyover ?? 0)} />
          <MetricTile label="Metro lines" value={counts.metro_line ?? 0} />
          <MetricTile label="Stations" value={counts.metro_station ?? 0} />
          <MetricTile label="Utilities" value={counts.utility ?? 0} />
        </div>
        <p className="text-meta text-text-3">Object counts loaded in the scene (base city plus this alternative’s changes). Areas not imported are not counted.</p>
      </PanelSection>
    </div>
  );
};
