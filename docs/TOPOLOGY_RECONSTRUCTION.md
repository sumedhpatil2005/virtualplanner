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

Database export, 200 samples per case, seed 4242, `VP_STRICT=0`. Each cell gives failing samples / violations, then the violations by rule. Columns:
- **before**: the test run on the code before this work, e788b7f (previous agent, `/workspace/work/um-topo-e2e/before-db/`).
- **9a26bae**: the integrated head this work started from (`/workspace/work/um-topo2-e2e/head-9a26bae/`).
- **dd2bc36**: the shared-node fix, `embankment`/`cutting`, and the proposal test (`dd2bc36/`).
- **77739d1**: the end-next-to-held-apart-crossing builder fix (`77739d1/`). This run was interrupted after `multi`: those 9 cases were parsed from the log (`after-part1.log`), and `move-end` and `delete-reconnect` were re-run alone with the same per-case seeds (`after-part2.log`).

From dd2bc36 on, the uncertain pool includes `embankment`/`cutting` segments (530 → 1274), so cross-uncertain samples partly different places than in the 9a26bae column. The other pools are unchanged apart from ground 30455 → 30418. The oracle gained one exemption in dd2bc36 (a crossing at a node the crossed road shares in OSM with a road the new road joins there, §4 item 6). It was hit 4 times in ramp-foot and in no other case of the 77739d1 run. **UNIT-TESTED** (property test on real data, not browser).

| case | samples | before (e788b7f): failing samples / violations | by rule | 9a26bae | by rule | dd2bc36 | by rule | 77739d1 | by rule |
|---|---|---|---|---|---|---|---|---|---|
| end-mid | 200 | 64 / 81 | at-grade crossing not split in the objects 77, uncertain crossing joined without confirmation 2, uncertain crossing not flagged for confirmation 2 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| end-node | 200 | 77 / 97 | at-grade crossing not split in the objects 97 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| cross-grade | 200 | 200 / 283 | at-grade crossing not split in the objects 277, uncertain crossing joined without confirmation 3, uncertain crossing not flagged for confirmation 3 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| cross-flyover | 200 | 178 / 345 | at-grade crossing not split in the objects 313, uncertain crossing not flagged for confirmation 18, uncertain crossing joined without confirmation 14 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| cross-tunnel | 200 | 189 / 376 | at-grade crossing not split in the objects 352, uncertain crossing not flagged for confirmation 13, uncertain crossing joined without confirmation 11 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| cross-uncertain | 200 | 197 / 551 | uncertain crossing not flagged for confirmation 252, uncertain crossing joined without confirmation 217, at-grade crossing not split in the objects 82 | 1 / 3 | uncertain crossing not flagged for confirmation 3 | 2 / 3 | uncertain crossing joined without confirmation 1, end on a road but not joined in the graph 1, road given a vertex but not joined 1 | 1 / 1 | uncertain crossing joined without confirmation 1 |
| ramp-foot | 200 | 29 / 56 | uncertain crossing not flagged for confirmation 31, uncertain crossing joined without confirmation 24, false junction at grade-separated crossing 1 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| bridge-end | 200 | 86 / 136 | at-grade crossing not split in the objects 67, uncertain crossing not flagged for confirmation 39, uncertain crossing joined without confirmation 30 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| multi | 200 | 120 / 224 | at-grade crossing not split in the objects 224 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| move-end | 200 | 47 / 51 | at-grade crossing not split in the objects 51 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |
| delete-reconnect | 200 | 47 / 55 | at-grade crossing not split in the objects 55 | 0 / 0 | none | 0 / 0 | none | 0 / 0 | none |

The remaining violation (cross-uncertain sample 30, 77739d1 and dd2bc36) is open: see §6.

## 4. Root causes fixed

All **UNIT-TESTED** (synthetic fixtures in `TopologyReconstruction.test.ts`, `TopologyScenario.test.ts`) and property-tested on the database export (§3).

1. **At-grade crossing not in the objects** (2c261e7). A drawn road crossing a ground road mid-way was joined only in the derived graph. `EditingEngine.reconstructCrossings` now puts the junction vertex on both roads in the drawing's Undo step. Accounts for the "not split in the objects" rule in every case of the before column.
2. **Uncertain-level crossings guessed as junctions** (2c261e7). Bridge/tunnel/layer-tagged pieces at ≈ the same modelled height, and ramps 0.5–3 m up, were joined by the builder because the heights matched. They are now flagged (`levelCrossings`, `decision: 'unconfirmed'`) and held apart until the user picks Confirm junction or Keep separate.
3. **OSM way points joined to a drawn road from up to 6.6 m away** (2c261e7). The builder now joins a point of an unedited OSM way to a drawn or edited road only where the point lies on that road (≤ 0.5 m). The drawn road's own ends keep the tolerance.
4. **Two crossings within 0.5 m on the drawn road made a sliver segment** (15c737f). They now share one junction point.
5. **A drawn end lying on a road was not joined when a held-apart crossing was within 8 m** (9a26bae; cross-uncertain sample 122). The builder's guard around held-apart crossings suppressed the end's T-junction. A road's own end lying on the other road (≤ 0.5 m) now always joins.
6. **Inconsistent flag at an OSM shared node** (dd2bc36; cross-uncertain sample 95, the "3 crossings with a layer=-1 road not flagged"). Cause: the drawn road's ends snapped to both ends of `osm_814906035` (Deccan PMPML Bus Stand Road, `layer=-1`, no tunnel tag), so the road ran along it. Its junction with the ground way `osm_814906036` reused that way's vertex, and that vertex is an OSM node shared with `osm_814906035`. Crossings are found on the line *before* junction points move it, so the touch at the shared node was never classified. A line that crossed there directly *was* flagged, so the behaviour depended on geometry. The shared node is where OSM itself joins the two ways at grade (Key:layer: ways are joined only where they meet), so the right answer is "junction, no flag" either way. `reconstructCrossings` now drops a level flag at a node the crossed road shares exactly with the road the junction is made with. The property-test oracle got the matching exemption, the same as its existing exemption for "through the other road's own end". Verdict: a genuine inconsistency, but harmless in the graph (the node was legitimately shared). Unit test: "crossing a layer=-1 road exactly at the node it shares with a ground road" (fails without the fix: `['osm_11','osm_12']` instead of `['osm_12']`).
   - Residual, **UNTESTED**: moving the drawn line ≤ 0.5 m onto a reused vertex could make it touch a third, tagged road that does *not* share that node. That crossing would not be classified, and the builder could join it by geometry. This was not seen in the 2,200 database samples.
7. **An end on a road next to a held-apart crossing of the same road** (77739d1; cross-uncertain sample 110 in the dd2bc36 run). The drawn road's last segment crossed `osm_817909485` (`tunnel=yes`, `layer=-1`, service road, modelled at 0 m) 1.2 m from its end, and the end lay on that road. The crossing was correctly flagged. The end got its T-junction vertex on the tunnel road, but the graph did not join them. The 9a26bae exemption only let the drawn road's *own* end through the 8 m guard. The tunnel road's vertex at that end is not *its* end, so the tunnel road was never split there, and an end that coincides with a vertex of the other road does not split it from the other side. The builder now also exempts a vertex lying on (≤ 0.5 m) the other road's end (`atEndOf`). Unit test: "a drawn end on a layer=-1 road 1.1 m from where the drawn road crosses it" (fails without the fix).
8. **`embankment=*` / `cutting=*`** (dd2bc36): read as level evidence (§2). Unit test: an `embankment=yes` or `cutting=yes` road is flagged and not joined; an `embankment=no` road is an ordinary junction.
9. **Proposals** (dd2bc36, test only, no fix needed). In a proposal, a drawn road crossing one base road and ending on another writes no vertex into the baseline rows. `ObjectManager.update` copies on write, so both base roads get proposal overrides (`modify` change-set writes). The baseline view stays byte-identical, and nothing is posted to `/api/objects`. The proposal's network joins the new road to both. Undo removes the overrides and redo restores them exactly. Confirm junction on an uncertain crossing in a proposal also overrides the crossed base road, not its row. Base objects are deep-frozen in the test, so any in-place write would throw. **UNIT-TESTED** (`TopologyScenario.test.ts`); **UNTESTED** in the browser.

## 5. Browser checks

App in Chromium against a copy of the project database (`/workspace/work/um-topo-e2e/`, screenshots in `shots/`). Run by the previous agent on 2c261e7–9a26bae and not repeated for dd2bc36; the dd2bc36 changes are unit-tested only.

| check | result | label |
|---|---|---|
| road drawn across `osm_1010245033` at grade | junction vertex on both roads; a route found through the new junction | **BROWSER-VERIFIED** |
| ground road drawn under the Sangamwadi bridge deck | deck at 6.5 m (estimated), kept separate (no junction) | **BROWSER-VERIFIED** |
| road end drawn onto a ground-level bridge end | joined at the bridge end | **BROWSER-VERIFIED** |
| crossing an uncertain ramp piece 0.7 m up (estimated) | flagged; **Confirm junction** joined it | **BROWSER-VERIFIED** |
| Undo / Redo of each of the above | exact | **BROWSER-VERIFIED** |

## 6. Not done / limits

- `GROUND_M = 0.5 m` is a chosen threshold, not a standard (**hypothetical**). All heights are model estimates from tags (6.5 m per deck level, 5 % ramps), not measurements.
- The network builder change (§4 fix 3) changed the database network for 20 roads and 12 merged nodes (compared with `/workspace/work/um-topo-e2e/net_before.txt` and `net_after.txt`). They were not inspected one by one. Some may have been real junctions that OSM maps without a shared node. Self-loop edges went from 119 to 63.
- `embankment=*`/`cutting=*` are read as "level unknown" only. No height is modelled for them, and they are not browser-checked.
- **Open, cross-uncertain sample 30 (dd2bc36 run): an uncertain crossing joined in the graph.** The drawn road crosses `osm_229970355` (H. K. Firodia Bridge, `bridge=yes`, `layer=1`, modelled 0–0.98 m) 1.7 m from the bridge's end node, which it shares with the ground road `osm_229970357`. The crossing is flagged, but the new road and the bridge share a graph node 5.4 m away. The cause is not established. The likely cause (**inferred**, not verified) is the builder's node clustering (`JOIN_TOLERANCE_DEG` ≈ 6.7 m), which merges the flagged crossing's surroundings with the bridge-end junction. Not fixed. Keep separate cannot separate them there.
- Residual case of §4 fix 6 (a reused vertex making a new touch with an unshared tagged road): **UNTESTED**.
- Topology in proposals: unit-tested only (§4 item 9).
- The property test samples random locations; 200 per case is not exhaustive. The pools changed with dd2bc36 (`embankment`/`cutting` segments joined the uncertain pool: 530 → 1274), so the dd2bc36 column samples partly different places from the 9a26bae column.
- After a drawn road is deleted, the junction vertex it inserted stays on the other road. This is harmless (§1) and kept on purpose: removing it would change a road the user did not touch.

## 7. Test record (77739d1, 2026-11-11, vitest one file at a time)

TopologyReconstruction 8/8, TopologyScenario 2/2, TopologyProperty on the Sangamwadi fixture 11/11 (strict, 20 per case; no tunnel segment in the fixture), EditIsolationFixes 9/9, EditRecompute 14/14, EditScope 11/11, EditingWorkflow 9/9, RoadLevels 12/12, ScenarioIsolation 10/10, ScenarioPanelPieces 8/8, JunctionEditing 29/29, EditIsolation 2/2, NetworkEditIsolation 10/10. Database property runs are in §3 (non-strict; 1 open violation).
