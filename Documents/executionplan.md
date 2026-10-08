# TwinCity — Execution Plan

> Consolidated plan covering UI/UX, correctness, performance, the SUMO traffic simulation engine, and backend hardening.
> 9 phases, 72 numbered items. Item numbers are stable — reference them in commits and issues.

---

## 1. Context

TwinCity is a Cesium-based 3D digital-twin urban planning tool for Pune (Hinjewadi/Wakad), built as a BE final-year project. It loads ~3,914 buildings and ~3,512 roads from a FastAPI/SQLite backend and renders them with batched Cesium primitives.

The engine underneath is genuinely good — a real spatial hash grid with Amanatides-Woo traversal, LOD tiles, a Web Worker traffic model, an 876-line demand-matrix compiler. **That work is not in question.** Two things are wrong, and they compound each other.

### 1.1 The product wrapped around the engine misleads the user

| Problem | Evidence |
|---|---|
| **Loses work silently** | `ObjectManager` never checks `res.ok` — an HTTP 500 is indistinguishable from a successful save. No offline indicator anywhere. |
| **Undo lies** | `historyManager.pushState` is called from exactly one place (`EditingEngine.ts:123`). Deletes, field edits and OSM imports push nothing. |
| **A JS error destroys the session** | `main.tsx` replaces `#root` with a stack trace on any error, wiping React, Cesium and all unsaved work. |
| **Controls are decorative** | 15 opacity sliders, the satellite/terrain toggles and an entire Activity Profile editor write values nothing reads. "18% congestion drop" is a hardcoded `if` chain. |
| **Undiscoverable** | Zero keyboard shortcuts. No onboarding. `Toolbar.tsx:250` hides 11 of 12 tools behind an unexplained toggle inside a collapsed, unlabeled 48px circle. |

### 1.2 The traffic simulation cannot answer the question the project exists to ask

`SimulationManager.ts:303` sets:

```ts
agent.speed = (edge.speedLimit || 50) / 3.6;
```

Every vehicle moves at the speed limit, always. There is **no car-following, no queueing, no vehicle-to-vehicle interaction**. The congestion value at `:331` only tints roads — it never feeds back into driving behaviour.

**Therefore widening a road from 1 lane to 4 changes nothing today.** The cars were already at free-flow speed. This is not a patchable bug: free-flow kinematics structurally cannot represent congestion. Replacing this with SUMO (a validated microsimulator) is the core new work in this plan, and it is the honest justification to put in the report.

### 1.3 Intended outcome

A planning tool that a planner can trust and operate without being taught, whose every displayed number traces to something real, and which can genuinely answer *"if I build this flyover, what happens to traffic?"*

### 1.4 Decisions taken

- Wire decorative controls up for real rather than deleting them.
- Desktop-only — fix overlap at 1366×768, no tablet/mobile breakpoints.
- Build to production/industry standard throughout, but treat public deployment as out of scope for now.
- Simulate **cordon-scoped study areas**, not the full city (see Phase 5, item 36).

---

## 2. Phase sequence at a glance

| Phase | Theme | Size | Why here |
|---|---|---|---|
| 0 | Foundations & SUMO risk spike | S | Hygiene must precede commits; spike de-risks the biggest unknown on day one |
| 1 | Trust & data integrity | S | Nothing else matters if the app discards work |
| 2 | Usability & onboarding | M | Cheap, and it's what an examiner experiences first |
| 3 | Honesty — wire the fake controls | M | Activity Profile feeds SUMO demand, so it must precede Phase 5 |
| 4 | Performance & scalability | M | SUMO will stream thousands of vehicles into these hotspots |
| 5 | SUMO traffic engine | L | The headline feature; depends on 3 and 4 |
| 6 | Simulation UX & analysis | M | Turns the engine into the demo |
| 7 | Backend production hardening | M | Industry-grade; not deploy-gated |
| 8 | Architecture, tests & accessibility | M | Portfolio and maintainability |

> **Cross-cutting rule, from Phase 1 onward:** every number rendered in the UI must trace to a computation, and every failure must be visible to the user. No exceptions, no placeholders.

---

## Phase 0 — Foundations & SUMO risk spike

Do this first. It's small, and two items here prevent expensive mistakes later.

**1. Repo hygiene, before any more commits.**
There is **no `.gitignore` in the repo at all**. `twincity.db` (23 MB) is committed, as are `__pycache__/*.pyc`. Every data change produces a 23 MB binary diff, and two people editing the city produce an unmergeable conflict. Add `.gitignore`, `git rm --cached` the DB and pycache, ship a small seed script instead.

**2. Wire up the test runner.**
Ten `*.test.ts` files (~2,072 lines) import `vitest`, but vitest is not a dependency, there is no `test` script, and `tsconfig.app.json` **excludes** `src/engine/testing` — so they aren't even typechecked. Add vitest + a `test` script now, so everything after this phase can be written with tests. Make `StartupTest.test.ts:10` hermetic (it currently hits live `localhost:8000` and passes vacuously when the backend is down).

**3. Centralise configuration.**
`http://localhost:8000` is hardcoded in three files (`ObjectManager.ts:8`, `EditingEngine.ts:12`, `TwinCityEngine.ts:674`). Route through `import.meta.env.VITE_API_BASE`. Add a typed API client module so error handling lands in one place rather than being duplicated at every call site.

**4. CI.**
GitHub Actions running `tsc --noEmit`, `npm run lint`, `npm test`, and later `pytest`. Cheap, and it's the difference between "student project" and "engineered project" to a reviewer.

**5. SUMO spike — timebox to one day.**
Take **one** Hinjewadi corridor. Hand-export `.nod.xml`/`.edg.xml`, run `netconvert`, run headless `sumo` with `randomTrips.py` demand, stream vehicle positions over a WebSocket into the existing `VehicleVisualizer`. No UI, no scenarios, no comparison.

> If cars move sensibly along that corridor in Cesium, the rest is incremental. If network conversion fights you, you learn it on day one instead of week six. **Do not start Phase 5 until this spike works.**

---

## Phase 1 — Trust & data integrity

The only genuinely non-negotiable phase.

**6. Real save feedback.**
`ObjectManager.ts:25-67` — check `res.ok` in all four sync methods (`syncPost`, `syncDelete`, `syncPostMultiple`, `syncDeleteMultiple`); throw on failure. Add a connection-state store (`online | saving | offline`) on the engine, surfaced as a persistent badge in `App.tsx`'s shell. Reuse the existing `window.showToast` (`App.tsx:17-29`) for one-off failures. Same treatment for `EditingEngine.fetchSavedAreas:389`, where a dead backend currently renders identically to an empty project.

**7. Make Undo honest.**
Call `historyManager.pushState` from every mutation site, not just `EditingEngine.ts:123`:
- `PropertiesPanel.handleDelete:395`
- `PropertiesPanel.handleUpdateField:133`
- the building draft save (~`:464`)
- the three OSM importers (`EditingEngine.ts:731, 893, 1036`)
- `deleteArea`

Skip the phantom snapshot on failed validation — `EditingEngine.ts:119-132` pushes *before* the 1-point early return.

**8. Replace snapshot history with diffs.**
`HistoryManager.ts:28` does `JSON.parse(JSON.stringify(objects))` over ~7,400 objects, up to 30 deep, plus a parallel redo stack — up to 60 full copies of the city in memory, with a multi-MB synchronous stall on every draw. Store structural diffs. Doing this *now*, while adding call sites in item 7, is much cheaper than retrofitting later.

**9. Confirm destructive actions.**
`PropertiesPanel.tsx:411-417` — the delete button sits 6px from the close button, with no confirmation and no undo. Add a confirm step, matching the pattern already at `Toolbar.tsx:121`.

**10. Replace the app-nuking error handlers.**
Delete both `innerHTML` handlers in `main.tsx:1-26`; add a real React `ErrorBoundary` around `<App/>` with a Reload action and a collapsed technical detail block. (They also interpolate `event.message` straight into `innerHTML`.)

**11. Stop swallowing simulation failures.**
`SimulationManager.ts:188-193, 256-261` return silently when the network isn't built or no route resolves — the user sees a spinner flicker and nothing else. Surface a real reason.

**Verify:** kill the backend mid-session → offline badge, failure toasts, nothing claimed as saved. Draw a road → delete 3 buildings → edit a field → Undo three times reverses exactly those three, in order.

---

## Phase 2 — Usability & onboarding

**12. First-run coach marks.**
One-time dismissible overlay (persisted in `localStorage`) pointing at the toolbar FAB, the Analyze/Plan switch, and the properties panel. Three labels and a "Got it" — not a multi-step tour.

**13. Un-hide the tools.**
`Toolbar.tsx:250` silently filters 11 tools out in Analyze mode with no hint they exist. Show them disabled with a "Switch to Plan mode to edit" hint. Give the panel FABs (`App.tsx:69-115`, `Toolbar.tsx:199`) visible text labels, not just `title=`.

**14. Keyboard shortcuts — there are currently zero.**
A repo-wide grep for `onKeyDown` / `keydown` returns nothing. Add `Esc` (cancel draw), `Ctrl+Z`/`Ctrl+Y`, `Delete`, and `1-9` for tools, plus a `?` overlay. Register in one hook so cleanup is centralised.

**15. Fix the drawing instructions, which are factually wrong.**
In `Viewport3D.tsx:94-103`:
- `draw_metro_flyover` has **no** HUD string and renders an empty pill.
- `place_station` and `draw_gateway` say "click once", but `TwinCityEngine.ts:306-317` only auto-finalizes `draw_junction` — the others need a double-click. Make those two auto-finalize; one click is the better interaction.
- The `import_osm` string describes a workflow that doesn't exist. The real flow is draw area → save → select → import.

**16. Make tools sticky.**
`EditingEngine.ts:380-381` forces `setMode('select')` after every finalize. Drawing ten roads costs twenty extra clicks.

**17. Fix panel overlap at 1366×768.**
`Toolbar.tsx:197`'s magic `top-[20.5rem]` collides with `ScenarioSelector` once comparison mode expands it; the settings popover (`Toolbar.tsx:270`, `bottom-14`) clips off the top of the screen. Reposition `.cesium-viewer-toolbar` — `PropertiesPanel` is open by default and buries Cesium's home / 2D-3D / **base layer picker** / fullscreen controls.

**18. Housekeeping that reads as unfinished.**
- `index.html:6` still says `<title>frontend</title>` with the default Vite favicon.
- `index.css:12` requests Outfit/Inter but neither font is ever loaded.
- `App.tsx:32` puts `select-none` on the root, so no coordinate or ID can be copied.
- `PropertiesPanel.tsx:84` logs every object on every change.
- Three animation classes (`animate-fade-in`, `animate-scale-in`, `animate-spin-slow`) are used 8 times but never defined — nothing animates.
- Delete the dead 184-line `App.css`.

**Verify:** clear `localStorage`, hard reload, hand it to someone who has never seen it; they draw a road unaided.

---

## Phase 3 — Honesty: wire the fake controls

Ordered by effort-to-value. Items 22–23 are prerequisites for SUMO demand in Phase 5.

**19. Layer opacity + satellite/terrain.**
`layers/LayerManager.ts:63-69` stores `opacity` but no renderer reads it — 15 sliders that do nothing. Apply it to primitive appearances in the three renderers, and wire `satellite`/`terrain` (`:19-20`) to `viewer.imageryLayers` and `terrainProvider`, which nothing currently touches.

**20. Fix the layer-ID bug.**
`EditingEngine.ts:205` emits `electricity_util`; the registry declares `electric_util` (`LayerManager.ts:28`); `TwinCityEngine.ts:157-170` remaps `fiber_util`→`electric_util`. Net effect: toggling "Electric Grid" hides *fiber*, and user-drawn electricity conduits can never be hidden.

**21. Delete the hardcoded metric.**
`ScenarioSelector.tsx:74-78` returns 18/8/32% travel-time savings from a literal `if` chain, rendered with a confident green trend icon. Remove it now; Phase 6 replaces it with a real SUMO-derived figure. An invented number beside real ones discredits every number in the panel.

**22. Wire the Activity Profile editor.**
`PropertiesPanel.tsx:1285-1404` — peak windows, mode split and trip generation all write to `draft.activityProfile`, which `DemandMatrixCompiler.ts` never reads (0 references). Feed it into the compiler alongside `accessPoints`, which *is* consumed (`DemandMatrixCompiler.ts:145-150`).
Fix the key mismatch while there: the panel writes `'walk'`, the compiler expects `'walking'`, and the `splitKey` remap at `:680` doesn't cover it — the walking share is silently dropped.

**23. Normalize the mode-split sliders.**
`PropertiesPanel.tsx:2270-2292` — six independent 0-100 sliders that are semantically a distribution, with no total and no validation. Set all six to 100 and the compiler emits 600% of the trips. Constrain to sum to 100%.

**24. Make scenarios real.**
`ScenarioManager.ts:59-62`'s `addScenario` is never called; four hardcoded scenarios promise flood drainage and cycle paths that don't exist as data. Let users create, duplicate, rename and delete scenarios — the object model already supports versioning via `getFilteredObjects`. This becomes the backbone of before/after comparison in Phase 6, so do it properly.

**25. Delete the fake backend simulation.**
`router.py:162-198` returns derived constants. Remove the endpoint — Phase 5 replaces it with a real SUMO service. Two simulation paths where one is fake is worse than one honest path.

---

## Phase 4 — Performance & scalability

Verified hotspots, all firing on every state change across ~7,400 objects. These must land before SUMO streams thousands of vehicles through the same paths.

**26. `RenderManager.ts:51`** — `JSON.stringify(existing) !== JSON.stringify(obj)` runs for all ~7,400 objects on every change, and since `ObjectManager.update:261` always stamps a fresh `updatedAt`, the `||` short-circuit almost never saves you. Toggling one layer checkbox ≈ 14,800 stringifies of objects carrying full coordinate arrays. Replace with a version counter.

**27. `ProceduralGeometryGenerator.ts:449`** — every road rebuilds a filtered junction array from all objects: 3,512 × 7,400 ≈ 26M iterations at startup. Same pattern at `:983, :1553, :1861, :2081`. Build type-indexed collections **once** in `RenderManager` and pass them down.

**28. `TwinCityEngine.ts:150,165`** — `getFilteredObjects` runs `all.some(...)` inside `all.filter(...)`, plus a `layers.getAll()` per object where `getAll` allocates a fresh array each call. Hoist both into `Map`s built once per invocation.

**29. `SimulationManager.ts:328-346`** — repaints every road in the city every 100 ms; `RoadRenderer.setRoadColor:167-181` then scans every tile inside a try/catch. Iterate occupied roads only, tracking a dirty set to reset.

**30. Engine lifecycle — add `dispose()`.**
There is none anywhere. `Viewport3D.tsx:60` destroys the viewer while `RenderManager`, `LODController`, `TrafficNetworkVisualizer` and an undestroyed `ScreenSpaceEventHandler` keep referencing it. Under React 19 StrictMode's double-mount this orphans every primitive from the first mount and attaches a second camera listener. Terminate the worker, destroy the handler, remove the camera listener, call `renderManagerInstance.clear()` (currently dead code nothing invokes), cancel timers — and call it from the effect cleanup.

**31. Defer writes during drags.**
Zone-vertex dragging calls `objects.update` on every `MOUSE_MOVE` (`TwinCityEngine.ts:260`), emitting a POST per mouse event *and* triggering a full Cesium entity teardown/rebuild per frame. Throttle to `rAF`, POST once on mouse-up.

**32. Build only the LOD tier in use.**
`BuildingRenderer.ts:187-258` builds and uploads all three LOD levels per tile, then hides two with `prim.show` — roughly 3× GPU memory and compile cost for 3,914 buildings. Build lazily on threshold crossing. Same pattern in `RoadRenderer.ts:267-289` and `TransitRenderer.ts:263-287`.

**33. Overpass client robustness.**
`EditingEngine.ts:1045-1076` has no `AbortController` and no timeout — a hung mirror hangs the UI forever behind a spinner with no cancel. 429 isn't special-cased, so it hammers all three mirrors back-to-back, which is what gets a client IP-banned. Add timeout, exponential backoff, mirror cooldown, and a cancel button.

**34. Cap the mesh cache.**
`cache/MeshCache.ts` is a bare unbounded `Map` — ~7,400 full mesh sets stay resident forever. Add LRU eviction with a size budget.

**Verify:** with ~7,400 objects, toggle a layer with no frame hitch; `window.twincity_fps` (`TwinCityEngine.ts:115-128`) holds steady while panning. Record before/after numbers — they belong in the report.

---

## Phase 5 — SUMO traffic engine

The headline feature. **Do not start until the Phase 0 spike works.**

### 5.1 What survives and what goes

You've already built the two hardest translation layers. SUMO consumes almost exactly what you produce:

| You have | SUMO input | Fit |
|---|---|---|
| `TrafficNetwork.nodes` (coords, signals, `allowedMovements`) | `.nod.xml` + `.con.xml` + `.tll.xml` | Near 1:1 |
| `TrafficEdge` (lanes, `speedLimit`, `direction`, `length`) | `.edg.xml` | Near 1:1 |
| `DemandMatrixCompiler` OD pairs (876 lines) | `.od` → `od2trips` → `.rou.xml` | Direct |
| `VehicleVisualizer` (`PointPrimitiveCollection`) | TraCI position stream | Direct |

- **Replaced (~700 lines out):** `VehicleAgent.ts`, `Pathfinder.ts`, and the tick loop in `SimulationManager`.
- **Kept and promoted:** `TrafficNetworkBuilder` (528) and `DemandMatrixCompiler` (876) become *exporters*.

> Frame it this way in the report: *"I built the network and demand model; I delegated car-following physics to a validated microsimulator."* That is a much stronger position than hand-rolled traffic physics.

### 5.2 Architecture

SUMO is native C++ and cannot run in the browser — but you already have a Python backend, and SUMO's control interface is Python. This finally gives the backend a real purpose.

```
Browser (Cesium)                FastAPI backend              SUMO
  ├── POST /api/sim/run ────────>│  write .nod/.edg/.rou
  │    {areaId, scenarioId, seed}│  netconvert ───────────────>│
  │                              │  libsumo.start() ──────────>│
  │<── WS /ws/sim/{runId} ───────┤  simulationStep() <────────>│
  │    binary frames @10Hz       │
```

### 5.3 Items

**35. SUMO service module in the backend.**
Use **`libsumo`** rather than `traci` — same API, in-process instead of over a socket, several times faster. Tradeoff is one simulation per process, fine for a single-user tool. Isolate behind an interface so swapping to `traci` for concurrency later is a one-file change.

**36. Cordon-scoped simulation, not full-city.**
The user draws or picks an **area**, and only that sub-network is simulated. This is standard transport practice (*sub-area cordon modelling*), not a shortcut — say so in the report. Both required concepts already exist and should be reused rather than reinvented:

- **Saved areas** already carry `min_lat/max_lat/min_lon/max_lon` on `AreaEntity` and already scope OSM import. Same UI, same mental model.
- **Gateways** (`draw_gateway`, `GatewayObject` with mode splits) already sit on boundary roads — exactly the boundary-flow mechanism a cordon needs.

Cutting a sub-network out of a city means traffic still enters and leaves at the edges; ignore that and you've simulated an island where every intervention looks good. Auto-detect roads crossing the cordon and prompt for gateways where missing.

> **Critical sizing rule: scope by area, never by a single road.** A new lane or bridge helps *because traffic redistributes off parallel routes*. If the alternatives aren't inside the cordon there is nothing to redistribute, and before/after shows nothing — the same failure as today's free-flow engine, for a different reason. Make the cordon 2–3× the corridor length in every direction; err large.

State the two limitations explicitly in the UI and report: effects outside the cordon aren't captured (congestion may be pushed to the boundary), and gateway flows are held fixed, so regional rerouting isn't modelled. Both are accepted limitations — naming them yourself is far stronger than being asked.

**37. Network exporter.**
Cordon-filtered `TrafficNetwork` → `.nod.xml`/`.edg.xml`/`.con.xml`/`.tll.xml` → `netconvert`. **Regenerate on every run** rather than patching incrementally — deterministic, single source of truth, user edits automatically included. Scoping also shrinks the topology-debugging surface, which is the dominant cost in this phase.

**38. Demand exporter.**
`DemandMatrixCompiler` output (now including the Activity Profile from item 22) → internal OD matrix → `od2trips` → `duarouter`, **plus gateway inflow/outflow** for trips crossing the cordon boundary.

**39. Route choice — the decision that makes or breaks the demo.**
If routes are fixed, **adding a bridge changes nothing**, because nobody's route knows it exists. Support both:

- `--device.rerouting.probability 1.0` for the live interactive demo (drivers re-evaluate on current travel times).
- `duaIterate.py` (Dynamic User Equilibrium) for the numbers in the report.

Label which mode produced which number in the UI. That distinction alone will impress an examiner.

**40. Indian traffic heterogeneity — the research-grade differentiator.**
SUMO's default car-following assumes lane discipline, which does not describe Pune. Enable the **sublane model** (`--lateral-resolution 0.8`) so two-wheelers filter between cars as they actually do, and set a realistic fleet (~60% two-wheeler, ~30% car, ~10% bus/auto) with per-`vType` parameters.

> Most SUMO work assumes Western lane discipline. Explicitly modelling Indian mixed traffic is a defensible contribution, and it's configuration plus a calibration argument — not a new codebase.

**41. Position streaming.**
WebSocket at 10 Hz, packed `Float32Array`/`Int16Array` — not JSON (5,000 vehicles as JSON at 10 Hz will not hold). Send only vehicles in the camera frustum; aggregate the rest to per-edge density. Frontend interpolates between frames to 60 fps.

**42. Simulation quality telemetry.**
SUMO deadlocks at oversaturated junctions and teleports vehicles after `--time-to-teleport`. **Teleport count is a results-validity metric** — surface it in the UI rather than hiding it. Also track collisions, departures vs. insertions-delayed, and mean network speed.

**43. Reproducibility.**
SUMO is a native binary dependency; "works on my machine" will bite you at demo time. Provide a `docker-compose` with SUMO pinned to a version, plus a documented local-install path.

### 5.4 The hard part, stated plainly

**Network topology quality is the #1 failure mode and likely ~40% of this phase's effort.** `netconvert` on messy user-drawn or OSM geometry produces broken junctions; the symptom is vehicles teleporting, deadlocking, or refusing to depart. Budget real time in `--junctions.join`, `--remove-edges.isolated`, `--geometry.remove`, and netconvert's warning log.

> Treat a clean netconvert run (zero errors, warnings triaged) as an explicit acceptance gate.

---

## Phase 6 — Simulation UX & analysis

Turning the engine into the demo. This is what the examiner actually sees.

**44. Vehicle rendering by LOD.**
Keep the `VehicleVisualizer` architecture, swap primitive type by distance:

| Distance | Representation | Scales to |
|---|---|---|
| < 300 m | Instanced glTF car models, rotated by SUMO heading | ~500 |
| 300 m – 1.5 km | `BillboardCollection`, top-down car sprites, `rotation` = heading | ~20,000 |
| > 1.5 km | Points, or per-edge density heatmap | unlimited |

Billboards carry most of the demo — a rotated top-down sprite at city scale reads exactly like SimCity. Copy the threshold pattern already in `BuildingRenderer`.

**45. Colour vehicles by speed** (green → amber → red) rather than fixed orange. Makes congestion legible with no UI at all. Drive the existing `setRoadColor` road tinting from SUMO's real mean edge speed instead of the current vehicle count.

**46. Before/after comparison, done honestly.**
This is the money shot, and these are the things that stop it being a lie:

- **Same random seed** for baseline and proposal. Different seeds on identical networks produce different results — reporting that as improvement is the most common way these comparisons deceive.
- **Multiple replications** — 5–10 seeds per scenario, report **mean ± std dev**. If the improvement is smaller than the spread, say it's inconclusive.
- **Discard warm-up** — the first ~15 simulated minutes just fill an empty network and flatter every scenario.
- **Report ranges, not false precision** — "12–18% reduction", never "16.34%".
- **Show assumptions in the UI** — demand source, seed, duration, warm-up, replication count, rerouting mode, cordon extent, teleport count — beside every result.

**47. Calibrate at least one corridor.**
Compare simulated travel time on one Hinjewadi road against real Google Maps typical times at 9am. Even one calibrated corridor moves this from "plausible" to "defensible" — and if it's off by 3×, you need to know before the viva, not during.

**48. Results panel with real charts.**
Time-series of mean speed / total delay, LOS distribution (you already have the `levelOfService` type in `TrafficSimResult`), and a baseline-vs-proposal delta view. Consider a time-synced "ghost" of the baseline run alongside the proposal.

**49. Emissions and fuel — nearly free, big narrative payoff.**
SUMO ships HBEFA4 models: `getCO2Emission()`, `getFuelConsumption()`, plus Harmonoise for noise. *"This flyover cuts 340 tonnes CO₂/year"* is a far stronger planning claim than a travel-time percentage, and it's one API call.

**50. Signal retiming as a zero-concrete alternative.**
SUMO supports actuated signals. Show that re-timing existing signals achieves a large share of the flyover's benefit at a fraction of the cost.

> A planning tool that can argue *against* building something is far more credible than one that always says "build more."

**51. Time-of-day scenarios.**
Hinjewadi's IT commute is famously directional — heavy inbound at 9am, outbound at 6pm. A fix that helps one peak and hurts the other is a genuinely interesting result, and it's locally grounded.

**52. Flood × traffic coupling — your strongest novelty angle.**
You already compute `FloodSimResult.floodedRoadIds` with depths. Feed that into SUMO by closing edges or cutting their speed. Monsoon traffic in Pune is a real, locally urgent question, and it reuses code you have already written.

**53. Optional, if time allows — induced demand / Braess's paradox.**
Adding capacity attracts trips and can make things *worse*. Demonstrating that on a real Pune network would be a distinction-level result: reproducing a known planning fallacy with your own instrument.

---

## Phase 7 — Backend production hardening

Industry-grade regardless of whether you deploy. The SUMO service makes this backend load-bearing, so it can no longer be a toy.

**54. Error handling on every write path.**
There is no `try`/`except` and **no `db.rollback()` anywhere**; every `commit()` (`router.py:113,143,159,244`) can surface a raw 500 with a stack trace. Add a global exception handler and a typed error contract.

**55. Stop swallowing corrupt data.**
`router.py:68-73` and `:205-208` catch bare `Exception` and substitute `coords=[]`/`props={}` — corrupt geometry is served to the frontend as an empty object with no log and no warning. Silent data loss.

**56. Structured logging.**
The backend does not import `logging` at all. Add structured logs with request IDs; essential once SUMO runs are long-lived and asynchronous.

**57. Migrations.**
Schema comes solely from `Base.metadata.create_all` (`main.py:7`), which is create-if-not-exists only — it will never add a column or an index. Add Alembic. Depends on item 1 having untracked the DB.

**58. `GET /api/objects` scalability.**
Returns all ~7,400 rows with no pagination, no bbox filter and no gzip, doing ~15,000 `json.loads` plus ~7,400 Pydantic constructions per request. Add `GZipMiddleware` first (largest win per line), then bbox columns on `city_objects` + spatial filtering. `AreaEntity` already stores min/max lat/lon; `city_objects` stores none, so this needs the migration from item 57.

**59. Fix the N+1 writer.**
`POST /api/objects/batch` issues one `SELECT` per object in a Python loop (`router.py:119`) — saving 3,900 objects means 3,900 SELECTs. Use a single `id IN (...)` prefetch plus a native upsert.

**60. `GET /api/scenarios` writes on read** (`:48-56`) and races itself into an `IntegrityError` on concurrent first requests. Move seeding to a startup task or the seed script.

**61. Validate and bound inputs.**
`coordinates: List[Any]` and `properties: Dict[str, Any]` accept arbitrary nested JSON with no size cap; `BatchDeleteSchema.ids` and the batch POST list have no `max_items` (a large list will blow SQLite's variable limit as a raw 500). Constrain `type` to a `Literal`, add `ge/le` on lat/lon, validate `min <= max`.

**62. Referential integrity.**
Zero `ForeignKey` and zero `relationship()` declarations — `city_objects.scenario_id` is a bare string, so orphan rows are possible and cascade deletes don't exist. Matters much more now that scenarios are user-created (item 24).

**63. Fix CORS.**
`main.py:18-21` uses `allow_origins=["*"]` with `allow_credentials=True`. That combination is invalid per the CORS spec; Starlette works around it by echoing the caller's Origin back, which makes *every* origin credentialed-trusted. Use an explicit origin list from config.

**64. Client-supplied primary keys.**
`router.py:88,119,222` let any client overwrite any object by id. Server-generate ids, or scope them per user/session. Full authentication stays out of scope until you deploy, but this is a correctness issue too, not only security.

**65. Backend tests.**
There are currently zero. Add pytest + httpx contract tests for every route, plus tests for the SUMO exporters — network/demand XML generation is exactly the kind of pure transformation that is cheap to test and expensive to debug in the wild.

---

## Phase 8 — Architecture, tests & accessibility

**66. Split the god objects.**

| File | Lines | Note |
|---|---|---|
| `PropertiesPanel.tsx` | 2,297 | 11 components in one file; 260-line `handleUpdateField` belongs in the engine |
| `ProceduralGeometryGenerator.ts` | 2,349 | No LOD-level separation |
| `TwinCityEngine.ts` | 1,232 | ~390 lines are hardcoded seed data — move to fixtures |
| `EditingEngine.ts` | 1,077 | Drawing + areas CRUD + 3 OSM importers + Overpass client |

**67. Unify the state layer.**
The observer pattern is hand-rolled and duplicated **six times** with near-identical code (`ObjectManager:69`, `EditingEngine:46`, `SelectionEngine:10`, `LayerManager:39`, `HistoryManager:15`, `ScenarioManager`). Notifications carry no payload, so `TwinCityEngine.ts:86` reconciles everything on every change regardless of what actually changed. Either adopt `zustand` (already a dependency, zero imports) or consolidate into one typed emitter with change payloads.

**68. Add React memoization.**
There is not a single `useMemo`, `useCallback`, or `React.memo` in the codebase. `PropertiesPanel.tsx:100-111` refilters all objects and runs three reduces over 3,914 buildings on every change, then `setSelectedObj({...current})` at `:117` creates a new identity every time, defeating downstream memoization. `PropertiesPanel.tsx:1427-1434` has an interval whose effect body retriggers its own dependency.

**69. Drop dead dependencies.**
`@tanstack/react-query` has zero imports (adopt it for the API client from item 3, or remove). `geoalchemy2` and `psycopg2-binary` are in `requirements.txt` and never imported while running on SQLite.

**70. Move dev-only code out of the bundle.**
`PerformanceTester.ts` (243 lines) is imported by `TwinCityEngine.ts:30` and bound to `window` with no UI entry point.

**71. Accessibility.**
Repo-wide, `aria-`, `role=`, `tabIndex`, `htmlFor` and `onKeyDown` return **zero** matches. `focus:outline-none` appears 44 times, 32 with no replacement ring — the app is not keyboard-operable. Add labels to the ~25 icon-only buttons, restore focus rings, add focus traps to modals (`Toolbar.tsx:471` has no autofocus, no Enter-to-submit, no Esc-to-close).

**72. Contrast pass.**
Body text runs 8–11px in `slate-500` on 60%-alpha glass over a live 3D scene, so real contrast is non-deterministic and often below AA. Raise the minimum size and increase panel background opacity.

---

## 3. Recommended sequencing

**0 → 1 → 2 → 3 → 4 → 5 → 6** is the project. Phases 7 and 8 can run interleaved during waiting periods (long DUA iterations, netconvert debugging) rather than as a separate block at the end.

If the semester compresses:

| Situation | Do this |
|---|---|
| **Minimum credible project** | 0, 1, 3 (items 21–25), 5, 6 (items 44–48). Real simulation with honest comparison, even if the UI stays rough. |
| **Minimum credible demo** | Phase 1 alone, plus items 15 and 18. Highest value per hour in the whole plan. |
| **Never cut** | Item 5 (the spike), 36 (cordon sizing), 39 (rerouting), 46 (comparison methodology). |

> Cutting any one of those four produces a demo that looks fine and is wrong.

---

## 4. Verification

**Run:**
```
cd backend && .venv\Scripts\python.exe main.py
cd frontend && npm run dev
```

| Phase | Acceptance test |
|---|---|
| 1 — Trust | Kill the backend mid-session → offline badge, failure toasts, no false success. Draw → delete → edit → Undo ×3 reverses exactly those three, in order. |
| 2 — Onboarding | Clear `localStorage`, hard reload, hand it to someone who has never seen it; they draw a road unaided. |
| 3 — Honesty | Move every slider and check every displayed number traces to a computation. |
| 4 — Performance | ~7,400 objects, toggle a layer with no frame hitch; `window.twincity_fps` steady while panning. Record before/after. |
| 5 — SUMO | netconvert runs with zero errors and triaged warnings; a 1-hour sim completes with teleport count near zero; **widening a road measurably changes travel time** — the test the current engine cannot pass. |
| 6 — Comparison | Same scenario, same seed, twice → identical results. Different seeds → quantify the spread, and confirm reported improvements exceed it. |
| CI | `tsc --noEmit`, `npm run lint`, `npm test`, `pytest` all green. |
