import { useEffect, useState } from 'react';
import { engineInstance } from '../engine/TwinCityEngine';
import type { CityObject } from '../engine/objects/types';

/** Re-renders when the scene's objects or the active alternative change; returns the active alternative's objects. */
export function useEngineObjects<T extends CityObject = CityObject>(filter: (o: CityObject) => o is T): T[];
export function useEngineObjects(filter?: (o: CityObject) => boolean): CityObject[];
export function useEngineObjects(filter?: (o: CityObject) => boolean): CityObject[] {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion(v => v + 1);
    const a = engineInstance.objects.onChange(bump);
    const b = engineInstance.scenarios.onChange(bump);
    return () => { a?.(); b?.(); };
  }, []);
  void version;
  const all = engineInstance.objects.getAll();
  return filter ? all.filter(filter) : all;
}
