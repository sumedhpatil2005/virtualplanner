import { useEffect, useState } from 'react';
import { engineInstance } from '../engine/TwinCityEngine';

/** Smallest heading change (degrees) worth a re-render: keeps rotating the map from re-rendering React every frame. */
const STEP_DEG = 1;

/**
 * The map camera's heading in radians (Cesium camera.heading: 0 = looking
 * north, clockwise), kept current while the map is rotated. Read after each
 * rendered frame (scene.postRender) and passed on only when it moved by at
 * least STEP_DEG, so a still camera costs nothing.
 */
export function useCameraHeading(): number {
  const [heading, setHeading] = useState(0);
  useEffect(() => {
    let attached: any = null;
    let off: (() => void) | null = null;
    let last = Number.NaN;
    const detach = () => { off?.(); off = null; attached = null; };
    // Follows the engine's viewer: attaches when it appears and again if it is replaced (checked once a second)
    const sync = () => {
      const viewer = engineInstance.getViewer();
      const live = viewer && !viewer.isDestroyed?.() ? viewer : null;
      if (live === attached) return;
      detach();
      if (!live) return;
      attached = live;
      last = Number.NaN;
      const read = () => {
        const h = live.camera.heading;
        if (!Number.isFinite(h)) return;
        const diff = Math.abs(((h - last) * 180) / Math.PI) % 360;
        if (Number.isNaN(last) || Math.min(diff, 360 - diff) >= STEP_DEG) { last = h; setHeading(h); }
      };
      read();
      off = live.scene.postRender.addEventListener(read);
    };
    sync();
    const timer = setInterval(sync, 1000);
    return () => { clearInterval(timer); detach(); };
  }, []);
  return heading;
}
