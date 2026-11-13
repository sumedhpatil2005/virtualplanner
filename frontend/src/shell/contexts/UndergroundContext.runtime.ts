import { engineInstance } from '../../engine/TwinCityEngine';
import { isAlignment } from '../../engine/underground/alignmentFactory';
import { undergroundView } from '../../engine/underground/UndergroundView';
import { undergroundRenderer } from '../../engine/underground/UndergroundRenderer';
import { useShellStore } from '../useShellStore';

// ---- runtime: underground view while the workspace is open; alignments always drawn -----------------------------
let runtimeStarted = false;
/** Wires the globe view state to the workspace and keeps the 3D alignments in step with the model. Idempotent. */
export function startUndergroundRuntime() {
  if (runtimeStarted || typeof window === 'undefined') return;
  runtimeStarted = true;
  const viewer = () => engineInstance.getViewer?.() ?? null;
  const redraw = () => {
    const v = viewer();
    if (!v) return;
    undergroundRenderer.attach(v);
    const sel = engineInstance.selection.getSelection()[0] ?? null;
    undergroundRenderer.renderAlignments(engineInstance.objects.getAll().filter(isAlignment), sel);
  };
  const syncView = (ws: string) => { if (ws === 'underground') undergroundView.enter(viewer()); else undergroundView.leave(); };
  engineInstance.objects.onChange(redraw);
  engineInstance.scenarios.onChange(redraw);
  engineInstance.selection.onChange(redraw);
  useShellStore.subscribe((s, prev) => { if (s.workspace !== prev.workspace) syncView(s.workspace); });
  // The viewer is created after the shell module loads: catch up once it exists
  const wait = window.setInterval(() => {
    if (!viewer()) return;
    window.clearInterval(wait);
    redraw();
    syncView(useShellStore.getState().workspace);
  }, 250);
}

