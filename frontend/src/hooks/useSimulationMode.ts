import { useSyncExternalStore } from 'react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { SimulationModeState } from '../engine/simulation/SimulationMode';

/** Simulation mode state (active flag, study area), re-rendering on every change. */
export function useSimulationMode(): SimulationModeState {
  return useSyncExternalStore(engineInstance.simMode.subscribe, engineInstance.simMode.getState);
}
