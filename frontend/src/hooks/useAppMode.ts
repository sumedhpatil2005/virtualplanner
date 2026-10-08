import { useSyncExternalStore } from 'react';
import { engineInstance, type AppMode } from '../engine/TwinCityEngine';

/** View, Build or Simulate, re-rendering when it changes. */
export function useAppMode(): AppMode {
  return useSyncExternalStore(engineInstance.subscribeAppMode, () => engineInstance.getAppMode());
}

/** The selected object id (first of the selection), re-rendering when it changes. */
export function useSelectedId(): string | null {
  return useSyncExternalStore(
    cb => engineInstance.selection.onChange(cb),
    () => engineInstance.selection.getSelection()[0] ?? null
  );
}
