# Topology reconstruction: connecting drawn roads, bridges, flyovers, tunnels and ramps

Mission §4 (City Network Editor and automatic topology reconstruction) and §19 (network topology tests). Worktree `um-topo`, 2026-11-11. Builds on docs/OVERHAUL.md §27 (edit isolation harness, level-aware snapping 47f93fa, Connect node fix d3a8e4e).

Labels: **UNIT-TESTED** (vitest, synthetic fixtures or the database export), **BROWSER-VERIFIED** (app in Chromium against the project database), **UNTESTED**. Heights are **estimated** by the model from OSM tags (bridgeElevation: 6.5 m per deck level, ramps at 5 %); nothing here is a measured height.

## 1. How a drawn road gets connected (audit of the code before this work, e788b7f)

| step | code | what it does |
|---|---|---|
| click | `EditingEngine.addDrawingPoint` → `SnapManager.findSnap` | snaps a click to a nearby road point; Road/Junction tools only to points within 2.5 m of the click height (47f93fa) |
| finish | `joinedToNetwork` → `autoConnect.connectEnds` | each end within 25 m of a road at the same level (≤ 3 m) is carried onto it (moved if ≤ 3 m, else a connector point is added) |
| finish | `insertJunctionIntoIntersectedRoads` | a road the **end** lies on (≤ 0.5 m, same level ± 3 m, not within 2 % of its ends) gets a vertex at the end, in the same Undo step |
| finish (flyover) | `flyoverFeasibility` | capacity cut of surface roads, same Undo step (§27) |
| simulate | `TrafficNetworkBuilder.build` | two unedited OSM ways join only at shared OSM nodes; any other pair (a drawn or edited road involved) joins by geometry: segment crossings at the same level (≤ 3 m), and any vertex within ~6.6 m (`JOIN_TOLERANCE_DEG`) of the other road's segment; nodes cluster within 6.6 m at the same level |

Findings per case (before; the property test in §3 measures them):

| case | objects split? | graph connected? | problems found |
|---|---|---|---|
| end on a road mid-segment | yes, one vertex | yes | none |
| end on an existing junction node | no (already a vertex) | yes | none |
| road crossing an at-grade road mid-way | **no** (neither road gets a vertex) | yes, the builder joins the crossing | the junction exists only in the derived graph, not in the objects: junction tools, rendering, `Road ends`, the crossing's identity under later edits do not see it |
| crossing a flyover / bridge deck (> 3 m above) | no | no (grade separation) | none |
| crossing a tunnel / underpass (> 3 m below) | no | no | none (no tunnel deeper than 3 m in the fixture; database has 158 such segments) |
| crossing a bridge-, tunnel- or layer-tagged piece at ≈ the same modelled height, or a ramp/embankment 0.5–3 m up | no | **yes, joined** | the builder guessed a junction from equal heights although the tags say the road passes over/under (OSM Key:layer: joining ways at a crossing destroys the vertical order); no way for the user to say which |
| ramp foot (Flyover tool) on a ground road | yes at the foot | yes | the drawn flyover's own ramp crossing other ground roads at < 3 m height joined them in the graph (same as above) |
| road end onto a bridge end (clicked at deck height) | no (already a vertex) | yes | none |
| 3+ roads at one point | first end splits; later ends land on that vertex | yes, one node | none once later arms are clicked on the junction (the snap) |
| moving an endpoint | there is no endpoint drag for a finished road; the drawing point can be dragged before finishing, and `Road ends: Connect` (§27) moves an end | yes (only the final point splits) | none |
| delete and reconnect | the junction vertex inserted on the joined road stays after the drawn road is deleted (harmless: no edge split, heights unchanged; undo exact) | yes | none |
| any: an OSM way's point 0.5–6.6 m from a drawn road | no | **yes, joined** | the builder's 6.6 m tolerance (meant for ends the user draws short) also joined an OSM way's end or vertex that only comes near a drawn/edited road |
| undo/redo | — | — | exact in every case (§27 fixes hold) |

## 2. Rules (after this work)

Evidence used, in order: OSM `bridge=*`, `tunnel=*`, `layer=*`, `embankment=*`, `cutting=*` tags on the way (OSM wiki Key:layer, https://wiki.openstreetmap.org/wiki/Key:layer, OpenStreetMap Wiki, last edited 2025-12-24, oldid 2934074: layer marks "the vertical relationship between two intersecting features"; "Joining the ways with a shared node at the point where they cross would destroy the vertical order"; layer "provides absolutely no information about … height"; roads on embankments/cuttings should use `embankment=*`/`cutting=*`, not layer. Tag definitions: https://wiki.openstreetmap.org/wiki/Key:bridge, https://wiki.openstreetmap.org/wiki/Key:tunnel; Key:embankment, https://wiki.openstreetmap.org/wiki/Key:embankment, OpenStreetMap Wiki, oldid 3066147, last edited 2026-08-06: `embankment=yes` "The way is raised onto an embankment"; Key:cutting, https://wiki.openstreetmap.org/wiki/Key:cutting, oldid 2971509, last edited 2026-03-28: "An excavated section where the highway or railway is significantly lower than ground level"), whether the other object is a drawn structure (flyover, metro flyover), and the **estimated** heights at the crossing.

`frontend/src/engine/editing/levelCrossings.ts` (`classifyCrossing`):
1. Heights > 3 m apart (`GRADE_SEPARATION_M`, the builder's existing threshold) → **separate**: nothing is joined or changed.
2. Both untagged ground roads and both within 0.5 m (`GROUND_M`) of the ground there → **junction**: `EditingEngine.reconstructCrossings` puts a vertex at the crossing on both roads in the drawing's Undo step (an existing vertex of the crossed road within 0.5 m is reused, so no sliver segment or near-duplicate node); the builder joins them at that shared point.
3. Otherwise → **uncertain**: not joined, not guessed. The new road records `levelCrossings[] = { roadId, point, otherZ, decision: 'unconfirmed', reason }`; the builder keeps an unconfirmed or `separate` crossing apart (at the crossing, and against near-miss vertex joins within 8 m of it). A drawn flyover's mid-span crossings are never junctions: those within 3 m of the other road's height (its ramps) are flagged the same way.
   - UI: after drawing, a toast ("N crossings of the new road could be a bridge, tunnel or ramp: kept separate until you check …"); the selected road's properties show **Crossings to check** with Show / **Confirm junction** / **Keep separate** (`LevelCrossingPanel.tsx`). Confirm inserts the shared vertex on both roads (each at its own height) and sets `decision: 'junction'`; Keep separate sets `'separate'`. One Undo step each; the decision is part of the road object, so it is saved and changes the network key (simulation outputs are invalidated).
   - A crossing through the other road's own end (where it meets the road it continues from) is not flagged: that end is the level of the road it joins.
   - Nor is a crossing exactly at a node the other road shares (in OSM) with a ground road the new road makes its junction with at that node: OSM joins ways only where they meet (Key:layer), so the other road is at grade there (`reconstructCrossings`, `sharedNode`).
   - `embankment=*` / `cutting=*` (any value except `no`) count as level evidence like `layer≠0` (`levelEvidence` → `'embankment'`/`'cutting'`): the model gives such a way no height of its own, so a crossing with it at the same modelled height is flagged, not joined. 61 `embankment=yes` and 19 `cutting=yes` ways in the project database (none also tagged bridge/layer). **UNIT-TESTED** (synthetic), property-tested through the oracle; **UNTESTED** in the browser.
   - `GROUND_M = 0.5 m` is a chosen threshold, not a standard: below it the model's ramp height is within the noise of an at-grade join; above it a road on a 5 % ramp is treated as possibly on an embankment. **hypothetical**. (`embankment=*`/`cutting=*` are read since 2026-11-11, see above.)
4. `TrafficNetworkBuilder`: a point of an unedited OSM way joins a drawn or edited road only where it lies on it (≤ 0.5 m, `ON_ROAD_DEG`); a drawn road's own ends keep the 6.6 m tolerance (ends drawn short).

## 3. Property test (`frontend/src/engine/testing/TopologyProperty.test.ts`)

For each case, VP_N random locations (seeded) across the whole network: random ground segments (≥ 25 m, untagged, at 0 m), deck segments (bridge-tagged, > 5 m), tunnel segments (< −5 m), uncertain segments (bridge/tunnel/layer-tagged within 1 m of the ground), 3+-road junction vertices and bridge ends. A synthetic road is drawn through the code the Build tools run (`addDrawingPoint` with its snap, `finalizeDrawing`, `deleteWithHistory`). Checks (oracle written from tags and heights, independently of the implementation, with the rule of §2): no zero-length segment; only the new road and roads given a vertex at the new road's points change (plus the flyover capacity cut, documented in §27); an end within 0.5 m of a road at the same level shares a graph node with it (within the 6.7 m node clustering); a junction crossing shares a node and is a vertex of both objects; a separate or uncertain crossing shares no node (other than one where the new road legitimately joins another road); every uncertain crossing is flagged and no certain one is; no node of the new road has another node within 1 m at the same level; a route exists from the new road onto every road it joins; undo gives the exact objects back (byte compare of every object, keys sorted, `updatedAt` left out) and redo the exact edited state; the network key on every 10th sample on the database (it hashes all 18k roads). Also per case: 3 arms to one point meet at one node; the end dragged before finishing splits only the final point; delete-and-redraw leaves no duplicate vertex.

Run: `cd frontend; VP_OBJECTS=<export of /api/objects rows> VP_N=200 VP_REPORT=<dir> [VP_CASES=…] [VP_STRICT=0] npx vitest run src/engine/testing/TopologyProperty.test.ts` (fixture: no VP_OBJECTS, 20 per case). Database export used: `/workspace/work/vp-wt-edit-e2e/objects.json` (20,732 objects, 18,273 roads, exported 2026-11-09; not committed).

RESULTS_TABLE

## 4. Root causes fixed

RESULTS_FIXES

## 5. Browser checks

BROWSER_RESULTS

## 6. Not done / limits

LIMITS
