import { useCallback, useEffect } from 'react';
import { coordinationApi } from '../../lib/coordinationApi';
import { engineInstance } from '../../engine/TwinCityEngine';
import { undergroundRenderer } from '../../engine/underground/UndergroundRenderer';
import { useUndergroundStore } from './undergroundStore';

export const USER_KEY = 'td-user';

/** Loads datasets + records from /api/coordination/subsurface and draws them on the map. */
export function useSubsurfaceRecords() {
  const s = useUndergroundStore();
  const reload = useCallback(async () => {
    const st = useUndergroundStore.getState();
    st.setRecords({ recordsState: 'loading', recordsError: null });
    try {
      const [datasets, recs] = await Promise.all([coordinationApi.listDatasets(), coordinationApi.listRecords()]);
      st.setRecords({ datasets, records: recs.records, recordsState: 'loaded' });
      undergroundRenderer.attach(engineInstance.getViewer());
      undergroundRenderer.renderRecords(recs.records);
    } catch (e) {
      st.setRecords({ recordsState: 'error', recordsError: (e as Error).message });
    }
  }, []);
  useEffect(() => { if (useUndergroundStore.getState().recordsState === 'idle') void reload(); }, [reload]);
  return { ...s, reload };
}

