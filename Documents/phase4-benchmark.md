# Phase 4 — Performance benchmark (before / after)

Synthetic city at production scale: 3,914 buildings, 3,512 roads, 400 junctions, plus a 200-object proposal (8,026 objects).
Measured with `frontend/src/engine/testing/PerformanceBench.test.ts` in Node 22 (Vitest, jsdom) with Cesium mocked, so the figures cover the JavaScript work only — not GPU upload or frame rate. Median of two runs each.

Reproduce (PowerShell, in `frontend/`):

```
$env:BENCH=1; $env:BENCH_OUT="bench.json"; npx vitest run --config vitest.config.ts PerformanceBench
```

| Hot path | Plan item | Before | After | Change |
|---|---|---|---|---|
| Reconcile with no changes (e.g. toggling a layer) | 26 | 52 ms | 2 ms | ~26× faster |
| Reconcile after editing one object | 26 | 50 ms | 2 ms | ~25× faster |
| First render: reconcile + build all tiles | 27, 34 | 612 ms (478 + 134) | 275 ms (25 + 250) | ~2.2× faster |
| One traffic tick: re-colour every road (runs every 100 ms) | 29 | 277–347 ms | 4 ms | ~75× faster |
| Scenario filter with a proposal active | 28 | 664 ms | 1.3 ms | ~500× faster |
| GPU primitives built (camera at 800 m) | 32 | 3,429 | 1,955 | −43% |

Notes for the report:

- **Traffic tick:** before, one tick took 3× longer than the 100 ms tick interval, so the simulation could not keep up. Recolouring touched every tile for every road (and every road on every tick); now only occupied roads and only their own tiles.
- **Change detection:** `RenderManager` compared `JSON.stringify` of every object on every change. `ObjectManager` never mutates stored objects, so object identity now serves as the change version.
- **First render:** meshes are generated lazily when a tile is first built, using one per-batch spatial/type index instead of scanning every object per road, junction and station. Unviewed tiles cost nothing.
- **LOD:** only layers visible at the current camera height are built; zooming across a threshold adds the missing layers once, and zooming back only toggles visibility.
- **Mesh cache:** now an LRU with a 256 MB byte budget; evicted meshes are regenerated on demand. (The synthetic city holds ~276k vertices, far below the budget; the cap matters for large OSM imports.)

Still to verify in the browser (needs WebGL): with the real ~7,400-object city, toggle a layer and watch `window.twincity_fps` while panning.
