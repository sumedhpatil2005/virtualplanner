import { useShellStore } from '../useShellStore';

export type SimulateDrawerTabId = 'calibration' | 'odme' | 'emissions' | 'counts' | 'day';

/** Opens one of the Simulate drawer tabs (used by links in the study panel). */
export function openSimulateDrawer(tab: SimulateDrawerTabId): void {
  const st = useShellStore.getState();
  st.setDrawerTab(tab);
  st.setDrawerOpen(true);
}
