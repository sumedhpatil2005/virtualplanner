# VirtualPlanner overhaul: simulation, analysis and comparison

Branch `realistic-traffic`, from `98a4966`. This document answers the overhaul brief section by section (the numbers §1 to §11 follow the brief, and code comments point to them). For each improvement: what was wrong, why, what changed, how it was verified, and what remains uncertain. §12 separates what is implemented, tested, estimated and left for later; §13 lists the decisions that need the project owner.

## Summary

- The Shivaji Bridge "congestion" in the original report came mainly from a **100 km/h free-flow default** on an untagged urban trunk road and a uniform 1,800 veh/h/lane capacity. Speeds are now capped at 50 km/h on untagged urban roads (MoRTH 2018, Maharashtra 2019), capacities follow IRC:106-1990 in PCU, and LOS follows Indo-HCM.
- The cause the panel gave ("a queue from another junction") was a default sentence. The simulator now records why each vehicle waits and traces queues to where they start; a cause is stated only when the runs agree.
- A mid-overhaul run blamed a **fictional** demo road ("Pune Central Boulevard", ~230 m south of the bridge). Sample objects are now excluded from Simulate. Earlier Shivaji Bridge figures are contaminated by them.
- The whole-area micro-simulation could not carry a 2 km area (55% of demand entered). It is replaced by a **two-tier model**: static user-equilibrium assignment for the area and a 700 m micro-simulation around the road, 3 seeds, ~41–54 s in the browser instead of ~210 s per seed.
- Final Shivaji Bridge result (AM, estimated demand): **severely congested in all 3 runs**, south-east at 5 km/h (LOS F) while the bridge is at 33% of capacity; 87% of that delay is queueing traced to the Shivaji Bridge / Bajirao Road junction. Widening the bridge makes no clear difference.
- Demand is the weakest part. The model puts **~23%** of the 2008 counted volume on Shivaji Bridge (PMC CMP 2008). This is reported, not corrected; choosing a demand source is the main open decision (§13).
- Live controls now have a real lifecycle with Stop; "Play 24 h" (which did not simulate a day) is replaced by Compare times of day; the panel is split into What's wrong / Improve & compare / Details; comparisons use frozen demand and seeds and no longer call a trade-off "Better". Both issues from the final browser round are fixed: a cause is named only when most runs agree, and comparisons now share random numbers between baseline and proposal (streams keyed by OD, not by list position), which the identical neighbourhood change for two unrelated edits exposed (§10.2, §10.3).

Wording used throughout:

- **Measured**: a count or observation from a cited source.
- **Estimated**: modelled demand or model output. All area demand is estimated.
- **Hypothetical**: a what-if (scaled demand, a proposal drawn in Build).

Every figure below says which of these it is.

---

## 1. Simulation controls and lifecycle

**What was wrong.** On Shivaji Bridge the live simulation could be paused or restarted but not stopped. Closing the panel hid the vehicles while timers, the worker and the animation loop kept running, so reopening showed a simulation that had "continued". A saved selection and an active simulation were the same thing in the state.

**Why.** The live view, the analysis and the time-of-day player each owned their own timers and were started implicitly by selecting a road. Leaving Simulate only hid the vehicle layer.

**What changed** (`SimulationMode.ts`, `SimulationPanel.tsx`, `SimulationHud.tsx`):

- One lifecycle for the live view: *idle* (nothing computing), *preparing* (waiting for the analysis, then running the warm-up off screen), *running*, *paused*. Stop returns to idle and releases the simulator, the animation frame, timers and vehicles.
- Selecting a road runs the **analysis** (a finite job) and nothing else. The live view starts only on **Watch live traffic**.
- **Leaving Simulate (closing the panel or switching mode) stops every computation**: live view, warm-up, analysis, comparison, time-of-day runs. If a long run was stopped this way, the panel says so once when reopened. The selection and finished results stay, so reopening shows the last result with nothing running.
- Pause, Restart, Stop and speed (1×, 5×, 20×) sit in the live bar at the top of the panel, not under Advanced. A `resources()` report says what is computing, for tests and for the panel.

**Verified.**

- Unit tests (`Overhaul.test.ts`, "live view lifecycle"): does not start by itself, starts on request after a warm-up, stops completely; closing Simulate stops everything and reopening keeps the result and starts nothing; closing during a running analysis stops it and says so.
- Browser, Shivaji Bridge 2 km (headless Chromium, production build of this branch before the final UI commits; the lifecycle code did not change afterwards): Watch live → *preparing* → *running* in 6.6 s, 738 vehicles, starting at t = 300 s (the warm-up); Pause froze the clock ("Paused · 0:13", animation frame off); Resume kept the 5× speed; Restart re-ran the warm-up; **Stop: every resource off** (no live sim, no animation frame, no timers, 0 vehicles) and the analysis result kept; closing while running → everything off, no HUD; reopening → same result, nothing running. Re-checked on the final build at Nal Stop and on a Wakad road (§10).

**Uncertain.** In SwiftShader (software WebGL) the 5× speed step did not advance measurably in a 4 s sample; frame rate there is not representative of a real GPU, and speed accuracy on hardware was not measured.

## 2. What "Play 24 h" did

**What was wrong.** It did not simulate a day. It multiplied arrival rates once per simulated minute, so no hour ever reached its own traffic state, and the switch from morning to evening land use at noon cleared every vehicle.

**What changed.** "Play 24 h" was removed. The panel has a **When** selector (Morning peak 09:00, Midday 14:00, Evening peak 19:00, Night 23:00); changing it re-runs the analysis for that hour. **Compare times of day** (Improve & compare tab) runs the analysis at all four periods on the same network (one seed each, so differences under about 10% are noise) and shows them side by side.

**Verified.** Browser, Shivaji Bridge 2 km: four rows in 49 s; demand 28,500 / 19,824 / 28,500 / 5,218 veh/h (AM / midday / PM / night, estimated); south-east speed 3.4, 3.6, 3.4, 26 km/h.

**Uncertain.** For Shivaji Bridge the morning and evening rows are identical. Both peak hours have a profile factor of 1 (they are the reference hours), and the area's demand is almost all through traffic from edge flows that do not depend on the peak, so nothing differs between them. Real tidal (morning in, evening out) flows are not represented for through traffic. This is a limit of the demand model (§5), not of the selector.

## 3. Is the congestion real?

The brief's report: eastbound 482 veh/h at 13% of capacity and 44 km/h, westbound 201 veh/h at 6% and 29 km/h, free flow 100 km/h, "Congested", blamed on a queue from another junction.

**What was wrong, and why.**

1. **Free-flow speed of 100 km/h.** The importer gave every OSM road with no `maxspeed` tag a class default: 100 km/h for trunk, so Shivaji Bridge (way 22841323, trunk, untagged) was "free-flowing" at 100. Ordinary urban speeds of 27 to 44 km/h were under half of that, so they read as congested. Simulated vehicles also drove at up to 100 km/h.
2. **Capacity.** 1,800 veh/h per lane, uniform, in vehicles rather than PCU, so with 64% two-wheelers the v/c ratios (13%, 6%) were not comparable with Indian standards.
3. **The congestion label** compared speed with that 100 km/h, so it could not separate a slow-but-normal road from a jammed one.
4. **The cause** was a heuristic ("a queue from further on") with no measurement of where the waiting happened.

**What changed.**

- `roadParameters.ts`: free-flow speed from the way's own `maxspeed`, else one tagged on a connected piece of the same road, else an urban default by class (50 / 40 / 30 / 20 km/h), never above **50 km/h** in a municipal area. Sources: MoRTH S.O. 1522(E) (2018) and the 2019 Maharashtra notification (60 km/h cars, 50 km/h motorcycles in municipal areas); two-wheelers are 64% of Shivaji Bridge traffic (CMP 2008), so the mixed stream gets the motorcycle limit. Shivaji Bridge now runs at 45 km/h (north-west) and 37 km/h (south-east): the speeds OSM tags on connected pieces of the same road.
- Mid-block capacity in PCU/h from **IRC:106-1990** (design service volume / 0.70): 2,143 PCU/h for this two-lane carriageway. Stop-line capacity at signals uses Indo-HCM saturation flow × g/C.
- Level of service from speed as a share of free flow (Indo-HCM urban streets), per direction, in each seed. The status shows whether all seeds agree.
- **Delay attribution** in the simulator. Each vehicle's delay on the section is split into waiting at a signal, stopped behind a queue from further on, giving way or crossing, and slow in moving traffic. **Queue tracing** follows a stopped queue downstream, link by link, to the junction where it starts, and says what holds it there (signal, conflicting turns, or the exit is full). The explanation is given only when the trace is found in the runs; otherwise the panel says no single cause stands out.

**Verified.** Unit tests (`Overhaul.test.ts`): speeds and their basis; IRC:106 capacities; LOS grading; delay charged to the queue from a signal further on, and that signal found. Shivaji Bridge results are in §3a.

### 3a. Shivaji Bridge, 2 km area, morning peak 09:00 (estimated demand)

| | Before: browser (the brief) | Before: `98a4966` code, 3 seeds (node) | Mid-overhaul, **fictional sample objects still simulated** (browser, 3 seeds) | Final (browser, production build, 3 seeds) |
|---|---|---|---|---|
| Free-flow speed used | 100 km/h | 68–69 km/h (mix of 100 km/h and tagged pieces) | 45 NW / 37 SE | 45 NW / 37 SE |
| Traffic that got through (veh/h) | 482 E / 201 W | 715–804 S / 585–616 N | 402 NW (316–481) / 178 SE (165–194) | **816 NW (763–890) / 515 SE (418–599)** |
| Traffic routed along it (veh/h) | n/a | 1,444 S / 2,582 N | 808 / 502 | 1,286 / 673 |
| Share of capacity | 13% / 6% (veh, 1,800/lane) | 20–22% / 16–17% (veh, 1,800/lane) | 40% / 25% (PCU, IRC:106) | **63% / 33%** (routed, PCU, IRC:106) |
| Mean speed | 44 / 29 km/h | 27–39 / 29–37 km/h | 31.7 / 23.7 km/h | **22.3 / 4.6 km/h** |
| Status | Congested | congested / underused / congested (seeds disagree) | moderate (moderate, moderate, slow) | **Severely congested, all 3 runs** (LOS D NW, F SE) |
| Cause given | queue from another junction (not checked) | (heuristic) | queue traced to **"Pune Central Boulevard / Niranjav Madhav Marg"**: a fictional road (2 of 3 runs) | 87% of the SE delay (255 of 295 s per vehicle) is stopped time behind a queue **traced to Shivaji Bridge / Bajirao Road**, held by conflicting turns (85 s per vehicle there), 3 of 3 runs |
| Share of routed demand that entered the simulation | n/a | 55% of 28,200 (whole area, 5,000-vehicle limit) | 74% of 13,910 (700 m neighbourhood) | 88% of 13,764 (700 m neighbourhood) |

Sources (working files, not in the repository): the brief; `vp-overhaul/probe_before_am.log`; `vp-overhaul/e2e/setup_a.json`; `vp-overhaul/e2e2/setup_shivajiF.out.json`. The mid-overhaul column came from an earlier build, so other changes also landed between it and the final column. Not all of the difference is the sample objects.

**The fictional sample-object finding.** An empty project is seeded with demo objects (`loadSampleData`): a 1 km "Pune Central Boulevard", "Tech Corridor Lane", a signalised "Boulevard Intersection" and two blocks. They sit at 18.5204 N 73.8567 E, about 230 m south of the real Shivaji Bridge. Simulate treated them as real roads. The Shivaji Bridge study routed real traffic over the fictional boulevard, and the "cause" of the bridge's congestion was traced to a junction that does not exist (270 s delay there). Fix: `objects/sampleObjects.ts` matches the samples by id **and** name (so a renamed, adopted sample counts as the user's), and Simulate leaves them out. They stay on the map and in Build until deleted. Test: `SampleObjects.test.ts`. The before columns in older docs (ROAD_ANALYSIS.md, CALIBRATION.md) predate this. Any Shivaji Bridge figure produced before it is contaminated.

**Is the final result real?** It is consistent within the model. All three seeds agree, the trace is found in all three, and the delay split shows the south-east direction is slow because the road ahead is full, not because the bridge is too narrow (33% of capacity). Widening the bridge makes no clear difference (§8). Two cautions:

- The binding element is a **simulated junction**, and simulated junctions are known to pass fewer vehicles than counted Pune junctions (20–56% of routed demand at the counted junctions; CALIBRATION.md §3, §9). Part of the 5 km/h may be the model's junction capacity, not the real one.
- **No measured speed or travel time** on Shivaji Bridge was used. Severity is not validated. A travel-time survey or probe data for the bridge at 09:00 would settle it.

## 4. The selected road: focus, warm-up and visibility

**What was wrong.** Vehicles appeared across distant parts of the network while the selected road stayed nearly empty, and the user had to run at 20× before it filled.

**Why.** The live simulation ran the whole 2 km area from empty. By Little's law the area's ~28,000 veh/h × ~9 min mean trip time is about 4,200 vehicles on the road at once even with no congestion, against a 5,000-vehicle simulator limit. Half the demand waited outside the area, the network filled from the edges inward, and the selected road was reached last.

**What changed.**

- The whole area is assigned by **static user equilibrium** (§9). Only the selected road's **neighbourhood** (700 m along the roads from it) is simulated vehicle by vehicle, fed by the paths the assignment sends through it. Each trip enters where its path enters the neighbourhood.
- The live view starts from the **same 300 s warm-up the analysis counts from**, computed off screen. Vehicles are already on the roads in a state the model reached itself. None are placed by hand.
- The camera focuses on the section (both carriageways, followed across OSM pieces of the same name between main junctions). Map overlays show **the traced queue**, **where its traffic comes from and goes** (select-link, from stored assignment paths) and **how full each road is** (assignment v/c). Overlays recolour the existing stretches in place instead of rebuilding them, and junction dots shrink with distance and hide beyond 2.5 km, so they no longer cover the map.
- Nothing forces traffic onto the selected road. An optional "focus" load under Advanced adds labelled extra through traffic.

**Verified.** Browser, final build: the live view is running 6.6 s after Watch live, with vehicles on the section at t = 300 s (§1). All three overlays render on Shivaji Bridge (`F03`, `F04`, `F05`). Switching overlays four times left the scene's primitive count unchanged (407), consistent with recolouring in place rather than rebuilding. In the 2 km map view the junction dots are small and do not swamp the roads (`F01`).

**Uncertain.** The routes (select-link) overlay is thin, and its colour is close to the study area's base colour at full-area zoom. It renders, but it is not as legible as the how-full overlay. Road labels in headless screenshots lose some glyphs ("usha hau ejuri ar Road" for Kushabhau Jejurikar Road). This looks like the software-rendering font atlas, but it was not checked on a GPU browser.

## 5. Demand: what it is based on, and how far to trust it

**Audit (Shivaji Bridge 2 km, AM).** 28,500 veh/h of estimated demand, of which about 98% is **through traffic**: flows at the edge of the area, set per lane by road class (arterial 500 veh/h/lane/direction, the low end of counted west-Pune approaches; trunk the same; collector 300). These are balanced edge-to-edge by Furness. The area's own buildings add little, because OSM buildings in the old city are sparsely attributed and jobs are under-counted. Trip generation (PCMC CMP 2018), trip lengths (Pune CMP 2018 Table 9) and the vehicle mix (Gunjan Chowk counts) are cited in ROAD_ANALYSIS.md §3. Nothing is fitted to Shivaji Bridge.

**Independent check (new).** The PMC Comprehensive Mobility Plan (2008) counted the Mula-Mutha river bridges (Table 4.1; annexure Table 8). Those counts are now in `backend/data/observed_screenlines/pune_cmp2008_river.json`, served at `/api/observed-screenlines/{id}`, and compared with the model's bridge volumes in the panel's Details tab. They are **not** calibration targets: they are 18 years old, and some bridges have been rebuilt or paired since. Shivaji Bridge in 2008: **7,470 veh/h** both directions in the peak hour (18:00–19:00), 64% two-wheelers.

| Shivaji Bridge, both directions | veh/h | Share of the 2008 count |
|---|---|---|
| 2008 count, peak hour 18:00–19:00 (measured) | 7,470 | 100% |
| Model, area assignment on the bridge (estimated) | 1,711 | **23%** |
| Model, routed along the 548 m section | 1,959 | 26% |
| Model, got through the simulation | 1,331 | 18% |

Other bridges in the same run (model ÷ 2008 count, at 09:00, both directions): Sambhaji 916 / 5,042 (18%; the count has no two-wheelers, which are banned on Lakdi Pul, and the model does not apply the ban); Tilak 1,660 / 2,213 (75%); Shinde 4,144 / 4,986 (83%); Dengale not comparable (rebuilt as a one-way pair). Z-Bridge and S. M. Joshi are outside the 2 km area. The counts are for each bridge's own peak hour (10:00–19:00), so this is an order-of-magnitude check only.

The model carries roughly a quarter of what the bridge carried in 2008, and traffic has very likely grown since. **Estimated demand is far too low on this bridge**, even though the area as a whole has 28,500 veh/h. The earlier "~18%" figure was the simulated throughput, not the assignment volume. Likely reasons: edge flows of 500 veh/h/lane are a west-Pune suburban figure, not a central river crossing; the old city's trip ends are missing from OSM; and one-way and turn restrictions in the core spread traffic over parallel bridges in the model. This is reported, not corrected: scaling demand to one count would make the other bridges and junctions wrong in unknown ways.

**What changed.**

- The screenline file, the endpoint and its tests (`backend/observed/screenlines.py`, `backend/tests/test_screenlines.py`), and the check in the panel (`calibration/screenlines.ts`). A bridge whose layout has changed since 2008 (Dengale) is marked not comparable.
- Demand stays labelled *Estimated · not counted* everywhere. A what-if multiplier is labelled *Hypothetical*.

**Tried and not enabled.** Using OSM buildings as land use (trip ends generated from building footprints across the area) was tested on Shivaji Bridge 2 km: the assignment took about 21 s and did not converge. It is left off.

**Uncertain.** The demand source is the open question (§13). Without a citywide OD matrix or current counts, absolute volumes in the old city are not credible. Directions of change in comparisons (same demand on both sides) are more reliable than levels.

## 6. User experience

**What was wrong.** One long right-hand panel mixed results, research notes, calibration and settings. Basic controls sat under Advanced.

**What changed** (`RoadAnalysisPanel.tsx`, `SimulationPanel.tsx`, `TimeOfDayPanel.tsx`, `ui/kit.tsx`). The panel follows the brief's flow: pick a road → **1 · What's wrong** → **2 · Improve & compare** → **Details**.

- Header: road, length, area size. **When** selector, and the live bar (Watch live traffic, Pause, Restart, Stop, speed).
- *What's wrong*: one status line with its level of service and whether the runs agree, an Estimated badge, then each direction (speed vs free flow, traffic, time to drive it, share of capacity), then **Why** (the delay split and the traced queue, with *Show the queue on the map*).
- *Improve & compare*: suggestions each tied to a finding (§7), Compare times of day, and **Test a change** (save the existing city → edit in Build → Compare).
- *Details*: demand evidence, screenline and junction counts, calibration, model notes and settings.

**Verified.** Screenshots `F02` (What's wrong), `F06` and `F07` (comparison), all viewed. No overflow or clipped text was seen. The comparison table keeps Existing and Proposal in separate columns, with the % change and "only 2 of 3 runs" on their own lines.

**Uncertain.** No usability test with a first-time user has been done. The What's wrong tab is still long at 2 km (about 2,300 px with Why expanded).

## 6a. Direction of travel on the map

**What was wrong.** *Each direction* said "Towards the north-west" and "Towards the south-east", but nothing on the map showed which carriageway was which, and the camera frames a road from the side (Shivaji Bridge opens looking west-south-west), so "north-west" pointed right on screen.

**What changed.**

- **Compass** (`MapCompass.tsx`, bottom left beside Layers). The needle points to north on screen and the readout gives the camera heading ("W 248°"). It reads `camera.heading` after each rendered frame (`useCameraHeading.ts`, `scene.postRender`) and re-renders only when the heading moved by 1° or more. Clicking it turns the map north-up about the point at the centre of the screen, keeping tilt and distance.
- **Arrows on the road** (`DirectionArrows.ts`). Each direction gets a few short `PolylineArrowMaterialProperty` polylines (about one per 90 m, at most 8 per run of road) following its geometry in travel order. They are offset 4 m to the left of travel, because traffic keeps left, so the two directions of a two-way road sit side by side. They also have a depth-fail material, so they stay visible under the road mesh. All arrows of one direction share one colour and one width property, so highlighting changes those two values and rebuilds nothing. Arrows are drawn while the analysis on show belongs to the selected section and are removed otherwise (`SimulationMode.syncArrows`).
- **Panel** (`RoadAnalysisPanel.tsx`). Each direction card starts with a swatch in the direction's map colour (`DIRECTION_COLORS`: orange, violet, ...) holding an arrow glyph turned to `bearing − camera heading`, so it points the way the arrows run on screen right now. Next to it are the compass word, the bearing in degrees and, where one is known, the landmark. The word, the degrees and the glyph all use the same bearing: for an opposite pair, their shared axis (at most 15° from each direction's own bearing; on Shivaji Bridge, 0.6°). A new direction list (another road, hour or proposal) clears the highlight, and an index outside the list is ignored. Hovering over a card highlights its arrows (thicker and lighter) and dims the other direction's. Clicking a card pins the highlight and flies to frame that direction, keeping the current heading. Clicking an arrow on the map pins its direction and highlights the matching card (`TwinCityEngine.handleSimulationClick` → `directionOfArrowId`).

**How the direction is computed** (`directions.ts`, `RoadAnalysis.sectionDirections`).

- Links of the section are taken with their points in travel order. The network already stores a backward link's points reversed. Before this change the code reversed the drawn segment, which gave the same result, except in its fallback path, where the points ended up reversed twice.
- Links are grouped by bearing (within 70°). Each group's bearing is the sum of its links' start-to-end displacements in metres (east offsets scaled by cos latitude), so it is the bearing of the whole run. Before, it was the bearing of whichever link came first, which a short kink at a junction could swing.
- Compass word: eight points, 45° each, with boundaries at 22.5° and so on. Two directions running opposite ways (more than 150° apart) are labelled from their shared axis, so one road never reads "north" one way and "south-east" the other when the rounding falls either side of a boundary.
- Screen arrow: `screenArrowDeg(bearing, heading) = bearing − heading` (degrees, clockwise from screen-up). This is exact for a camera looking straight down. On a tilted view it is the direction in the ground plane seen from the camera's heading, which is what the map arrows show.

**Landmarks** (`downstreamLandmark`). These never invent a name. Each is read from the end of the direction's longest run:

1. *towards X*: go straight on from the end (turn of at most 50°). Unnamed pieces and pieces of the section's own roads (matched by name, not by `ref`, because a national-highway ref is shared by different roads) are followed for up to 400 m. The first piece with a real name (an OSM `name` or `name:en`, never an importer placeholder such as "Tertiary Road") gives X. A signed OSM `destination` on a one-way piece driven forwards is used first. If two straight-on roads with different names are within 15° of each other, it is a fork and the step gives no name.
2. *to the junction with X*: otherwise, the main road (collector or larger, real name, not one of the section's own) at the end node.
3. Otherwise, only the compass word.

**Verified** (Pune OSM, from the analysis dump and in the browser).

| Road | Direction | Bearing (geometry) | Label shown | Landmark |
|---|---|---|---|---|
| Shivaji Bridge | 73.8552,18.5211 → 73.8536,18.5250 | 337.9° | North-west · 337° | none: ahead, Shivaji Road forks against Sadguru Morya Gosavi Underpass, and the end junction has no named main road |
| Shivaji Bridge | 73.8537,18.5249 → 73.8554,18.5212 | 156.7° | South-east · 157° | none: Shivaji Road continues for 400 m, and the end junction meets an unnamed trunk link |
| Veer Santaji Ghorpade Marg | SW / NE | 226° / 47° | South-west / North-east | towards Shivaji Road / to the junction with Dengle Bridge |
| Lokmanya Tilak Marg | NW / SE | 306° / 128° | North-west / South-east | junction with Lalbahadur Shashtri Marg / Chhatrapati Sambhaji Path |
| Baba Bhide Bridge | NW / SE | 306° / 126° | North-west / South-east | towards Jagannath Kaniram Kasat Path / none |

Shivaji Bridge runs at 338°/158°, almost exactly on the boundary between north-west and north (337.5°). The pair is labelled from its shared axis (337.3°) as north-west and south-east, matching the earlier analysis. The panel shows the axis in degrees (337° / 157°), so a reader can see that it is close to the boundary. Browser verification (headless Chromium, SwiftShader, 2026-11-05; values read from the page, no screenshots, because the CPU renderer timed out on captures): default camera 248°, panel glyphs 90°/270°, map arrows on screen at 87–92°/265–272°; rotated to 128° with 45° tilt, glyphs 210°/30°, map arrows at 214–225°/24–40° (the gap is tilt perspective). No landmark name was shown for Shivaji Bridge, so none was invented. Hover, click and dimming are covered by code review and unit tests only, not checked in a browser.

**Uncertain.** The landmark covers only the first named road ahead. It does not give place names (such as "Deccan") unless OSM carries a `destination` sign, because the network holds road names, not place names. On a strongly tilted perspective view, the glyph angle is the ground-plane direction, so it can differ by a few degrees from the arrow's apparent angle near the screen edge.

## 7. Usefulness for planning: suggestions traced to findings

`improvements.ts`: each suggestion carries the finding and number that motivate it. Examples: "fix the junction where the queue starts" with that junction's share of the delay and run agreement; "retime the signal" when the delay is at the section's own signal; "no spare parallel route" when 100% of the road's traffic only crosses the area. Where the analysis cannot point to a cause, the suggestion is to **investigate** (a count, a travel-time survey), not to build. Suggestions are things to test with Compare, not results. On Shivaji Bridge: fix Shivaji Bridge / Bajirao Road (84% of the SE delay, 3 of 3 runs); a bypass would need a wider study; the result is borderline when runs disagree.

## 8. Reliable comparisons

**What changed** (`ScenarioComparison.ts`). Existing and proposal run on the **same frozen demand, hour and seeds**. The area assignment re-routes that demand on the edited network. Measures are reported at three levels: the selected road (simulated), its neighbourhood (simulated), and the whole area (assignment: total vehicle-hours, stretches over capacity, unreachable trips). The comparison also lists roads that gain and lose, new bottlenecks, and a map of v/c change.

Two errors were fixed in this round:

1. **Agreement.** A simulated change counts as good or bad only if **every seed** shows it, including speed. Speed was previously checked against no per-seed values, so a speed gain seen in 2 of 3 runs was called "better... in every run".
2. **Overall verdict** (this commit). "Better" required only that the road or neighbourhood verdict was better and neither was *worse*. A neighbourhood that was *mixed* still let the overall verdict say "Better". Now **any measure that gets worse in every run, at any level, rules out "Better"**. The verdict becomes *Mixed* with a trade-off summary that names what improved and what got worse. The existing guards remain (no new over-capacity bottleneck, no rise in area travel time). Test: `ComparisonAgreement.test.ts` (trip time +14% and delay +18% in all runs → mixed; neighbourhood mixed → not better; a loss in only some runs does not block better).

**Verified in the browser** (final build, Shivaji Bridge 2 km, AM, 3 seeds):

| Proposal | Road | Neighbourhood | Area | **Overall** | Key figures |
|---|---|---|---|---|---|
| Widen Shivaji Bridge +1 lane per carriageway (11 pieces) | no clear change | no clear change | no clear change | **No clear change** (confidence low) | speed 15 → 19 km/h (+20%, only 2 of 3 runs); time to drive 204 → 180 s (2 of 3); neighbourhood trip time +14% (2 of 3); area 3,932 → 3,932 veh·h; over-capacity stretches 592 → 588 |
| Widen `osm_282054960` (on the traced queue beyond the bridge) 1 → 2 lanes | **better** | mixed | no clear change | **Mixed (trade-off)** (confidence medium) | time to drive it 204 → 135 s (−34%, 3 of 3); speed 15 → 19 km/h (+22%, 3 of 3); gridlock removals 163 → 129 (−21%); **neighbourhood trip time +14%, mean delay +18%, in every run** |

Before this round, the same two proposals were reported as **Better** and **Better** (`e2e2/shivaji2.log`). The bridge result came from a speed gain in 2 of 3 runs, the second while neighbourhood trip time rose 14% in all three. Comparison runtime: about 40–50 s for the baseline and about 55 s for the proposal.

**Uncertain.** The two verdicts above were measured before the common-random-numbers fix (§10.2, *Identical neighbourhood change*) and are superseded by the re-run there: bridge widening **No clear change**, `osm_282054960` **Mixed** (road better, neighbourhood delay +7% in every run). Confidence is *low* when the neighbourhood is over-loaded (more routed than its junctions pass). Three seeds are a minimum: in this over-loaded neighbourhood one seed can move the mean trip time by 30 s or more, so a neighbourhood change under about 10% is within run-to-run variation. Junction delay agreement shows "0 of 3" when per-seed end-junction delays are missing, which reads oddly.

## 9. Architecture

**What changed.** Two models, each doing what it is good at:

- **Whole area: static user-equilibrium assignment** (`staticAssignment.ts`; Frank–Wolfe, BPR link costs t₀(1 + 0.15(v/c)⁴), capacities from IRC:106 and Indo-HCM, PCU flows). It gives every road's volume and v/c, bottlenecks, select-link from stored path flows, and sub-area demand. It is deterministic and runs in about 1.3–1.9 s for a 2 km central-Pune area (60 iterations, relative gap 0.003).
- **Neighbourhood: micro-simulation** (IDM, Indian mixed traffic, Webster signals, gap acceptance) on the 700 m corridor, fed by assignment paths, with 3 seeds, 300 s warm-up and 900 s counted. This is where queues, spill-back and junction conflicts are modelled.
- `analysisJob.ts` ties them together in a Web Worker. The same inputs give the same result. Results are kept per network, demand and hour key across closing and reopening.

**Why.** The micro-simulator alone could not carry a 2 km area (§4), and route choice came from one jammed run.

**Not modelled.** Queues and spill-back in the assignment (a link over capacity only costs more), turn bans, signal coordination, vehicle-class bans (Lakdi Pul two-wheeler ban), public transport.

## 9a. Performance

**What was wrong.** On the `98a4966` code one seed of the Shivaji Bridge 2 km analysis took about 210 s (node, same machine), and only 55% of the area's demand entered the simulation because of the 5,000-vehicle limit (§4). Analysis time grew with the area, not with the road the user asked about.

**Why.** The whole 2 km area (4,005 roads, about 417 km of road, 3,901 junctions in the final run) was simulated vehicle by vehicle, from empty, to answer a question about one 548 m section.

**What changed.** The two-tier model (§9): the area assignment is cheap and deterministic; the expensive simulation is limited to the 700 m neighbourhood. The compiled road network is reused between runs on the same network (`reusedBuild`), and results are cached per network, demand and hour.

**Verified** (figures from the browser runs on the production build unless stated):

| Step | Before | After |
|---|---|---|
| One seed, Shivaji Bridge 2 km, AM (node) | ~210 s | ~17 s |
| Area assignment (60 iterations, gap 0.003) | n/a | 1.2–1.9 s |
| Full analysis in the browser, 3 seeds (Shivaji Bridge 2 km) | n/a | 41–54 s from selecting the road |
| Other places, 3 seeds (browser) | n/a | Karve Road at Nal Stop 77 s; a Wakad lane 49 s |
| Compare times of day (4 periods, 1 seed each) | n/a | 49 s |
| Comparison (baseline + proposal, 3 seeds each) | n/a | ~40–50 s + ~55 s |
| Live view from Watch live to running (warm-up off screen) | n/a | 3.3–6.6 s |

**Uncertain.** All browser timings are headless Chromium with software WebGL on a shared machine; a planner's laptop will differ. Nal Stop is slower because its neighbourhood is heavily over-loaded (more vehicles queued in the simulation). Timings for study areas larger than 2 km are not recorded here.

## 10. Verification

### 10.1 Test counts

Recorded after the common-random-numbers fix (§10.2, *Identical neighbourhood change*); figures at `8796aa6` and `352ed55` in brackets:

| Check | Result |
|---|---|
| `npx vitest run --config vitest.config.ts --pool=threads --maxWorkers=1` | 47 files: 44 passed, 3 skipped (opt-in harnesses); **364 tests: 361 passed, 3 skipped, 0 failed** (195 s) [362 / 359 / 3 at `8796aa6`; 361 / 358 / 3 at `352ed55`] |
| `tsc -b` | no errors |
| `oxlint` | 0 errors, 5 warnings (pre-existing unused variables in untouched files) |
| backend `pytest` | **52 passed** |

With the direction-of-travel work (§6a, new `Directions.test.ts`, 17 tests): vitest 48 files (45 passed, 3 skipped), **381 tests: 378 passed, 3 skipped, 0 failed**; `tsc -b` no errors; `oxlint` 0 errors, 5 warnings (the same pre-existing ones); backend pytest **52 passed**.

Before the overhaul (at `651fc2f`): 346 vitest tests (343 passed, 3 skipped), backend pytest 50 passed.

### 10.2 Browser end-to-end (final build)

Headless Chromium + SwiftShader, **static production build** served on :4173, FastAPI on :8000; harness `vp-overhaul/harness3.py`, scripts in `vp-overhaul/e2e2/` (working files, not in the repository). AM 09:00, 3 seeds unless stated.

| Place | Selecting the road started anything? | Result | Cause given | Live view | Stop |
|---|---|---|---|---|---|
| Shivaji Bridge, 2 km (`osm_22841323`, 548 m) | No (idle, all resources off) | Severely congested, 3 of 3 runs; NW 816 veh/h LOS D, SE 515 veh/h at 5 km/h LOS F | Queue traced to Shivaji Bridge / Bajirao Road (conflicting turns), 3 of 3 runs | Running 6.6 s after Watch live, 738 vehicles at t = 300 s (build before the final UI commits; §1) | All resources off, result kept |
| Karve Road at Nal Stop (`osm_1043506203`, 303 m) | No | Severely congested, 3 of 3 runs; SW 1,216 veh/h (130% of IRC:106 mid-block capacity routed), NE 659 veh/h at 1.5 km/h, LOS F | 87% of NE delay stopped behind a queue traced to Karve Road / Vishnushastri Chiplunkar Path, held by its signal (167 s per vehicle), 3 of 3 runs | Running after 3.4 s, 1,044 vehicles at t = 300 s | All resources off, result kept |
| Bhausaheb Kalatenagar Lane 1, Wakad (`osm_448904789`, 373 m, a minor lane) | No | Runs disagree (congested / flowing / no traffic); 10 veh/h westbound, 0 eastbound | Queue traced to Datta Mandir Road / Rambhau Kalate path in **1 of 3 runs only**, yet still given as the cause (with "found in 1 of 3 runs"). This broke the agreement rule; fixed afterwards in `8796aa6` (§10.3, issue 1) | Running after 3.3 s, 568 vehicles | All resources off, result kept |

The Wakad lane is included because it is a case where the model should **not** be confident: almost no traffic is routed on it. The panel does report the status disagreement ("Runs disagree: congested / flowing / almost no traffic"), but at the time of this run it still named a cause from one run (fixed since; §10.3).

The Shivaji Bridge result was identical across three separate browser runs of the final build (`shivajiF`, `seedsF`, `aaF`: same volumes, ranges, LOS and cause), which is consistent with the analysis being deterministic for a given network, demand, hour and seeds.

**Additional round (e2e3).** A second browser round on the final build (`vp-overhaul/e2e3/`) re-ran each Shivaji Bridge seed alone, the other places, and both comparisons. Its results are folded in below. **PENDING at the time of writing:** the e2e3 round had not finished (no `DONE` marker after 40 minutes): the A/A comparison (`aa.results.json`), the 3 km area run (`area3k.results.json`), the main Shivaji walk-through (`main.results.json`, partial) and the `places.md` summary were not available.

#### Per seed, Shivaji Bridge 2 km, AM

Source: `vp-overhaul/e2e3/seeds.md` (production build, each seed run alone in the browser, headless Chromium, 2 CPUs).

| Seed | Direction | Routed veh/h | Got through veh/h | % of capacity (routed) | Speed km/h (free flow) | LOS | Delay s/veh (of which stopped behind queue) | Status | Queue traced to | Runtime |
|---|---|---|---|---|---|---|---|---|---|---|
| 42 | NW | 1,286 | 794 | 63% | 19.7 (45) | D | 45 (0) | Severe | Shivaji Bridge / Bajirao Road | 18.0 s |
| | SE | 673 | 418 | 33% | 3.4 (37) | F | 406 (376) | | | |
| 7 | NW | 1,286 | 763 | 63% | 23.5 (45) | D | 32 (1) | Severe | Shivaji Bridge / Bajirao Road | 16.9 s |
| | SE | 673 | 599 | 33% | 4.3 (37) | F | 317 (300) | | | |
| 11 | NW | 1,286 | 890 | 63% | 24.3 (45) | D | 30 (0) | Severe | Shivaji Bridge / Bajirao Road | 17.7 s |
| | SE | 673 | 528 | 33% | 7.6 (37) | F | 161 (90) | | | |
| **3 seeds together** | | | NW 816, SE 515 | | | D / F | SE 295 (255) | Severe, 3 of 3 | same junction, 3 of 3 | 42.6 s (assignment 1.9 s, simulation 38.3 s) |

What this shows:

- The assignment is deterministic: routed volumes are identical across seeds (1,286 / 673 veh/h). Only the simulation varies.
- The status, LOS and traced junction agree in every seed. The size of the problem does not: the south-east delay ranges from 161 to 406 s per vehicle, and the share that is queueing from 56% (seed 11) to 95% (seed 7). The headline "87%" is the mean over the three runs; one seed alone could give a quite different number.
- The 3-seed means equal the means of the single-seed runs (e.g. SE delay (406 + 317 + 161) / 3 = 295 s), so the combined result is consistent with its parts.
- Share of routed demand that entered the neighbourhood: 88%, 87%, 89%.
- Minor wording issue seen: a single-seed run's cause text says "found in all 1 runs". Not a correctness problem; worth rewording.


#### Other places

Source: `vp-overhaul/e2e3/nalstop.results.json`, `wakad.results.json` (a `places.md` summary had not been written when this was compiled; figures are taken from the raw results). Same build as the per-seed runs; AM 09:00, 3 seeds. These runs reproduced the §10.2 results exactly (same volumes, ranges, LOS, causes). Analysis took 118 s (Nal Stop) and 83 s (Wakad) because they ran alongside another browser; alone they took 77 s and 49 s (§10.2). Lifecycle on both: selecting the road started nothing; Watch live reached *running* in 7.7 s / 3.0 s (1,044 / 568 vehicles at t = 300 s); Stop turned every resource off and kept the result. The traced-queue and routes overlays rendered on both.

Panel status lines as shown: Nal Stop "Severely congested · Same in all 3 runs"; Wakad "Slow · Runs disagree: congested / flowing / almost no traffic".

**PENDING:** `places.md` (summary of the places round) and the 3 km Shivaji Bridge area run were not available when this was written.


#### Comparison re-check

Source: `vp-overhaul/e2e3/compare.md` (production build containing `fc5a7dd`, the trade-off verdict commit; Shivaji Bridge 2 km, AM, seeds 42/7/11; edits reverted after each proposal).

| Proposal | Road | Neighbourhood | Area | Overall | Confidence | Key figures (existing → proposal, runs agreeing) |
|---|---|---|---|---|---|---|
| Widen Shivaji Bridge +1 lane per carriageway (11 pieces) | no clear change | no clear change | no clear change | **No clear change** | low | time to drive 204 → 180 s (−11%, 2/3); speed 15.5 → 18.6 km/h (+20%, 2/3); neighbourhood trip time 209 → 237 s (+14%, 2/3), delay 142 → 168 s (+18%, 2/3); area 3,932 → 3,932 veh·h; over-capacity stretches 592 → 588 |
| Widen `osm_282054960` 1 → 2 lanes | **better** | mixed | no clear change | **Mixed (trade-off)** | medium | time to drive 204 → 135 s (−34%, 3/3); speed +22% (3/3); gridlock removals 163 → 129 (−21%, 3/3); neighbourhood trip time +14%, delay +18% (**3/3, worse**) |

Both verdicts follow the agreement and trade-off rules, and they reproduce the earlier engineer runs (§8). Runtime: baseline 42–62 s, comparison 64–66 s (two browsers were running at the time).

#### Identical neighbourhood change for unrelated edits: root cause and fix

**What was seen.** The two proposals above gave almost the same neighbourhood change: trip time 208.5 → 237.09 vs 237.18 s (+14%), delay 142.3 → 167.96 vs 167.94 s (+18%). An A/A comparison (no edit) gave exactly zero, as did a no-op edit.

**What was measured** (production build of `36d63a9`, headless Chromium, Shivaji Bridge 2 km, AM 09:00, seeds 42/7/11; scripts and logs in `vp-overhaul/samefix/`, working files, not in the repository):

1. *The job sent to the simulation differs only where the edit is.* Before and after each edit the inputs were hashed and diffed in the page (`samefix/js/diag.js`): every road, every area and neighbourhood edge, the neighbourhood's road set, nodes and bounds, signals (85), placed junctions, count junctions, the section, the demand plan (5,425 OD pairs) and the options. A no-op edit and an edit far outside the area changed nothing; a road widened outside the neighbourhood changed only its own 2 edges; `osm_282054960` only its 1 edge; the bridge only its 11 roads (18 edges). Every revert restored every hash. So neighbourhood boundary, vehicle set, warm-up, demand plan, signals and id re-indexing on re-map were ruled out.
2. *The two equal means are made of different runs.* Per seed (trip time s, seeds 42 / 7 / 11): baseline 179.6 / 232.6 / 213.4; `osm_282054960` 215.1 / 243.1 / 253.4 (mean 237.18); bridge 257.4 / 253.3 / 200.6 (mean 237.09). The bridge proposal is *faster* than the baseline in seed 11 and the other is not; the means agree to 0.1 s by coincidence. Delay follows trip time (delay = trip time − free-flow time, and free-flow time hardly changed), so the second match is not independent of the first.
3. *The neighbourhood's random numbers were not common to baseline and proposal.* Each OD stream of the simulation (its arrivals) was seeded from its **index** in the neighbourhood trip list (`TrafficMicroSim.ts`, `seed ^ (index + 1)·φ`), and each driver's desired speed came from one shared stream in spawn order. That list is rebuilt from the area assignment on every run (`subareaDemand`), so any edit that re-routes traffic reorders it. Measured: the bridge edit kept 670 of 690 trips but only **320 at the same index** (first difference at index 45), so most ODs received another OD's arrival times; the `osm_282054960` edit left all 690 at the same index. A control edit (`osm_218881250`, inside the 2 km area but outside the 700 m neighbourhood) moved per-seed neighbourhood trip time by +15 / −25 / +20 s and made the bridge's drive time **+28% worse in 3 of 3 runs** (203.5 → 259.7 s), which the comparison would have reported as a real effect; an edit outside the area gave exactly zero.

**Root cause (supported, with the limits stated below).** Comparisons were meant to use common random numbers (the code comment said so), but the streams were keyed by list position, not by OD. Any edit that changes routing anywhere in the area re-drew the whole neighbourhood's traffic, so the neighbourhood (and road) change of such a proposal mixed the edit's effect with seed-to-seed variation that in this over-loaded neighbourhood is ±30 s per run. The identical figures for the two edits were a coincidence of three-run means on top of that; no shared artefact common to every edit was found (the A/A, the no-op and the far edit all gave exactly zero).

**Fix** (`TrafficMicroSim.ts`): each OD stream is seeded from the run seed and the stream's identity (entry and exit node, vehicle class, the links it is held to; identical streams by occurrence), and the driver's desired speed is drawn from that stream; streams that fall due in the same step are taken in time and identity order, not list order; signal offsets are drawn per junction from its node id instead of from one shared stream in construction order. The baseline is a new realisation of the same model: the Shivaji analysis is still severe in 3 of 3 runs with the queue traced to Shivaji Bridge / Bajirao Road in 3 of 3 (NW 628 veh/h LOS D, SE 515 veh/h at 3.9 km/h LOS F; the per-seed table above predates the fix).

**Verified after the fix** (same build procedure, `samefix/cmp1.results.json`; baseline neighbourhood trip time 218.4 s, delay 151.8 s, drive time 229.2 s):

| Edit | Drive time on the bridge, s (42 / 7 / 11) | Neighbourhood trip time | Neighbourhood delay | Overall verdict |
|---|---|---|---|---|
| Baseline | 240.6 / 276.8 / 170.1 | 227.4 / 202.9 / 225.0 s | 162.7 / 134.0 / 158.9 s | — |
| A road outside the 2 km area (`osm_856199593`) | identical | **0.0%** (3/3 identical) | **0.0%** | No clear change |
| A road in the area, outside the neighbourhood (`osm_218881250`) | 240.6 / 255.9 / 167.7 (−3%) | +1.0% (seeds 42 and 11 identical; 7: +6.5 s) | +1.5% | No clear change (was: bridge drive time +28% worse, 3/3) |
| Widen `osm_282054960` 1 → 2 lanes | 90.7 / 168.5 / 76.9 (**−51%, 3/3**) | 238.3 / 202.5 / 251.3 s: **+5.6%** (2/3) | +6.6% (**3/3**) | **Mixed**: road better (drive time −51%, speed +19%), neighbourhood delay +7% in every run |
| Widen Shivaji Bridge +1 lane per carriageway | 216.6 / 332.7 / 147.4 (+1%, 1/3) | 225.3 / 221.8 / 260.3 s: **+7.9%** (2/3) | +10.2% (2/3) | **No clear change** (low confidence) |

The two edits no longer give the same neighbourhood change (+5.6% / +6.6% against +7.9% / +10.2%). The bridge comparison was run a second and third time in fresh browser sessions and gave the same figures to the last digit (+7.95% trip time, +10.24% delay, No clear change); the panel is in `vp-overhaul-shots/S14_compare_bridge_after_fix_neighbourhood.png` (S10, S11: the same run, top of the panel), viewed. The causes rule is unchanged: a change counts only when every run agrees, and a cause is named only when at least 2 of 3 runs agree.

**Still uncertain.** (a) The bridge widening re-routes traffic inside the neighbourhood (25 new and 20 dropped neighbourhood trips, 712 veh/h of shifted flow), so its streams legitimately differ; its per-seed spread (seed 11 +35 s, seed 42 −2 s) is the over-loaded network's response, not a stream artefact, and three seeds cannot size it. (b) Gridlock removals fall with both widenings (156 → 134 and 137); removed vehicles never complete a trip, so part of the rise in mean trip time may be vehicles that now finish instead of being removed (a measurement effect, estimated, not measured). (c) This was measured at one place, one hour and three seeds; the new figures are model output on estimated demand. (d) The size of a neighbourhood change is not robust across realisations: `osm_282054960` gave +14% trip time on the old streams (where its trip list was unchanged, so that run was already on common numbers) and +5.6% on the new ones; the direction (delay up, drive time down) held in both. (e) Edits that change the *network nodes* at an OD's ends (moving a junction) still give that OD a new stream; lane, speed and capacity edits do not.


**Screenshots** (`vp-overhaul-shots/`, working directory, not in the repository): F01 (2 km map, junction dots), F02 (What's wrong), F03–F05 (queue, routes and how-full overlays), F06–F07 (comparison), F08 (comparison overlay). All were viewed.

### 10.3 Issues found in the final browser round, and their status

From `vp-overhaul/e2e3/BUGS.md`:

1. **Cause named from a minority of runs (medium).** The rule is that a cause is named only when runs agree. `RoadAnalysis.ts` (`chainFor()`) takes the most common queue root with no minimum agreement, and the spill-back text is used whenever a root exists. On the Wakad lane the panel names a junction found in 1 of 3 runs. Expected: fall back to "could not be traced to one junction consistently". Shivaji Bridge and Nal Stop are unaffected (3 of 3). **Fixed in `8796aa6`**: a cause is named only when most runs (2 of 3, or the single run) trace the queue to the same junction; otherwise the panel says the queue could not be traced consistently, names the minority trace with its count ("found in only 1 of 3 runs") and marks nothing on the map. Unit-tested (`Overhaul.test.ts`); the Wakad lane was not re-run in the browser after the fix.
2. **"found in all 1 runs" (low, wording)** when a single seed is analysed. **Fixed in `8796aa6`** ("in the one run analysed").
3. **Identical neighbourhood change for unrelated edits (high).** Not an artefact common to every edit (A/A, no-op and an edit outside the area all give exactly zero), but it exposed a real fault: the simulation's random streams were keyed by each trip's position in the neighbourhood trip list, which any re-routing edit reorders, so baseline and proposal did not share random numbers and the proposal's neighbourhood was re-drawn. The equal means were a coincidence of different per-seed runs. **Fixed** (streams keyed by OD identity, per-junction signal offsets); regression test `EditIsolation.test.ts`; both Shivaji comparisons re-run in the browser (§10.2, *Identical neighbourhood change*). The earlier comparison figures in §8 and §10.2 predate the fix.
4. **"Worst junction delay at its ends" shows "—" for a proposal (low)** with no reason given (proposal 2: existing 17 s). **Fixed in `8796aa6`**: the row now says why ("Not measured in the proposal: the simulation recorded no junction at the road's ends in any run"). Unit-tested.

Layout and readability observations (not blocking): map buttons partly under the panel at 1600 px; the traced-queue label overlapped by the selection marker; on the Wakad lane the camera leaves the lane behind 3D buildings; the routes overlay is low-contrast at 1 km; after changing the area from 2 to 3 km the old 2 km figures stay visible (dimmed) under a "3 km" header until the new run finishes; the comparison map shows little when no roads gain or lose; "time to drive it" uses the simulated direction length, which can be shorter than the header length (Shivaji: 548 m header, ~437 m implied by the NW free-flow time), so the numbers do not reconcile for a reader.

### 10.4 Not verified

- Live speed rate (1×/5×/20×) on real GPU hardware.
- Any measured speed or travel time on the roads tested; severity is a model result.
- Usability with first-time users.

## 11. Reporting

This file, plus the updated ROAD_ANALYSIS.md and CALIBRATION.md.

## 12. Implemented, tested, estimated, future

### Implemented

- Live-view lifecycle (idle / preparing / running / paused; Stop releases everything; leaving Simulate stops all computation; nothing starts without Start).
- Time-of-day selector and Compare times of day (Play 24 h removed).
- Free-flow speed from OSM tags, same-road tags, else an urban default capped at 50 km/h; IRC:106-1990 mid-block and Indo-HCM stop-line capacities in PCU; Indo-HCM LOS.
- Per-vehicle delay attribution and queue tracing in the simulator; a cause is stated only when runs agree.
- Fictional sample objects excluded from Simulate (still on the map).
- Two-tier model: area static user-equilibrium assignment + 700 m neighbourhood micro-simulation, 3 seeds.
- PMC CMP 2008 river screenline check (backend file, endpoint, panel check), validation only.
- Panel restructure (What's wrong / Improve & compare / Details), overlays, findings-linked suggestions.
- Comparison on frozen demand and seeds, per-seed agreement for every measure, trade-off verdict.

### Tested

- Unit and integration: lifecycle, speeds and capacities, LOS, delay attribution and tracing, sample-object exclusion, screenlines, comparison agreement and verdict, common random numbers between baseline and proposal (`EditIsolation.test.ts`: a reordered trip list gives the same run; an edit outside the area changes nothing; one outside the neighbourhood changes it by under 3%; two different edits do not give the same result) (§10.1).

  Two existing tests changed with the fix, both because drivers' speeds no longer share a random stream with signal offsets: the "route disappears" test now cuts the route by an edit (same OD, so the same stream) instead of pointing the trip at a missing node (a different OD); the two-wheeler discharge ceiling is 1.35 of Indo-HCM for 7 m instead of 1.3 (the five queue orders now give 0.94–1.30, before 0.98–1.25; the floor, which is what the test is for, is unchanged).
- Browser, production build: lifecycle and resource release on three places; Shivaji Bridge analysis, overlays, time-of-day comparison and two proposals; Nal Stop and a Wakad lane (§10.2).

### Estimated (model output, not measured)

- All demand (about 98% through traffic on Shivaji Bridge 2 km), and so every volume, speed, LOS and delay figure.
- Free-flow speeds and capacities on untagged roads (standards-based defaults).
- Bridge volumes are about 23% of the 2008 count on Shivaji Bridge; levels in the old city are not credible, directions of change in a comparison are more reliable.

### Known limits (not fixed)

- Simulated junctions pass fewer vehicles than counted Pune junctions (20–56% of routed demand at counted junctions).
- Edge-only demand has no directional (tidal) pattern, so AM = PM for through-dominated areas.
- Vehicle-class bans (e.g. no two-wheelers on Lakdi Pul), turn bans in the assignment, signal coordination and public transport are not modelled.
- 2008 counts are not used for calibration.

### Future work

- A demand source that carries the old city's trips (§13).
- Junction capacity calibration in the simulator.
- Public transport, safety, accessibility, development impacts beyond trip generation.
- Usability testing with planners; speed-rate check on GPU hardware.

## 13. Open decisions for the project owner

1. **Demand source.** Keep the class-based edge flows (cheap, about 4× too low on Shivaji Bridge), or invest in a citywide OD source: CMP 2018 zonal matrices if PMC will share them, current screenline counts, or commercial probe data. This decides whether absolute volumes in the old city can ever be trusted.
2. **50 km/h ceiling.** Applied to untagged urban roads as the mixed-stream limit, from the 2019 Maharashtra notification (60 cars / 50 motorcycles). The alternative is 60 km/h for car-dominated arterials. It changes free-flow speeds, and so LOS, on untagged roads only.
3. **Corridor 700 m and 3 seeds.** 700 m keeps a 2 km analysis to about 40 s in the browser. Junctions further away are only in the assignment, without queues. Three seeds are the minimum for an agreement check, and five would roughly double the time. A larger corridor or more seeds trade time for confidence.

## 14. Build edits and recompute

**Report.** After a change in Build (for example adding a lane to a bridge), does the road analysis recompute on the edited network? Seen in the panel for Sangamwadi Bridge: the 2-lane westbound and the 3-lane eastbound carriageway both showed "2,571 PCU/h mid-block (IRC:106)". COEP Road showed 959% of capacity.

### What was wrong, and why

1. **A lane edit changed one OSM way, but a carriageway is several.** OSM maps Sangamwadi Bridge as one-way ways, all `lanes=2`: eastbound `osm_661187162` (60 m approach), `osm_208004768` (368 m deck), `osm_1151682763` (136 m approach); westbound four more. Build edited only the way you clicked (the deck). The road analysis takes a direction's mid-block capacity from its **narrowest** stretch (`RoadAnalysis.areaContext`, min over links), so it stayed at the 2-lane approaches' 2,571 PCU/h.
2. **The panel's lane figure did not match its capacity.** The direction's `lanes` was a length-weighted mean, rounded: (60×2 + 368×3 + 136×2) / 564 = 2.65, shown as "3 lanes", next to the 2-lane capacity. Together, 1 and 2 give exactly the reported symptom. Reproduced in a unit test on the real OSM roads, and in the browser on the pre-fix build (below).
3. **Undo did not restore the network.** The network key hashed every road including `updatedAt`, which every store update stamps. After undo the unchanged network got a new key, so it read as a proposal against its own baseline and its kept result was not reused.
4. **A result from before the edit stayed on show with nothing to mark it.** In the browser, on the pre-fix build, the pre-edit result was still on show as `ready` 129 s after returning to Simulate, until the re-run started (it waits for pending OSM road and signal loads, which kept failing in this sandbox). Nothing marked it as out of date.
5. **The correction layer overrode lanes set in Build** (found by reading the code, then proved by a test). `pune_west_v1` has 16 `set_lanes` fixes (Sakharam Waghmare Chowk) and one `set_two_way` (`kasturi-ne-3`). These were applied on top of the user's lanes, so a lane edit on those ways was silently reset to 2 in the simulation.

What was checked and is **not** at fault: Build edits bump the simulation's revision (`TwinCityEngine` objects.onChange → `networkChanged`). The road cache, the explorer's compiled graph (`build.revision === revision`) and the demand cache are keyed on it. The analysis key hashes the roads, lanes included. There are no worker-side caches (each job gets a structured clone of the roads). The traffic network builder takes per-direction lanes from the first section's carriageways, and both the assignment (IRC:106 mid-block, Indo-HCM stop line from lanes × 3.5 m) and the micro-simulation (lanes per link) read those. Once the edited roads reach them, everything downstream recomputes.

### Fix

- `engine/editing/roadEdits.ts` (new; the properties panel's road edit moved here unchanged so it can be tested). `carriagewayPieces` makes a lane edit follow the clicked way along pieces of the same road (same name, alt name or ref) that run the same way and have the same lanes in the edited direction. It stops at a junction with a main road of another name, at a fork, or at 900 m. A two-way way drawn the other way round gets its directions swapped. The other carriageway is never included. `PropertiesPanel` applies the edit to all pieces as one undo step and shows a toast naming how many pieces changed.
- `RoadAnalysis.areaContext`: a direction's `lanes` is now the lane count of the stretch its capacity comes from. New fields: `lanesRange`, `narrowestM`, `lengthM`. When lanes vary along a direction, the reasons text adds "its narrowest stretch: 2 lanes on 196 of 564 m". The panel component is not changed; it can show these fields.
- `networkContentKey` (StudyDemand.ts) leaves out `createdAt`/`updatedAt`.
- `RoadAnalysisState.outdated` is true while the result on show belongs to a network, demand or hour that has since changed. It clears when the new result lands. The panel can show it.
- Lane or direction edits mark the section `profileModified`/`manual`. The correction layer then skips its lane fixes on that road (listed in the report as `userOverridden`) but still applies its direction fixes.

### Verification

**Unit tests** (`engine/testing/EditRecompute.test.ts`, 13 tests; fixture `testing/fixtures/sangamwadi.json` = the real imported OSM roads within 1 km of the bridge, from the 2026-11-03 dump; demand is estimated, from the cordon). Each one failed before the fix where noted:

| Test | Before fix | After |
|---|---|---|
| Lane edit on the deck covers the eastbound carriageway (3 ways) and nothing else; every other compiled edge and assignment capacity unchanged | fail (1 way) | pass |
| IRC:106 mid-block capacity of a divided primary: 2 lanes 2,571, 3 lanes 3,857 PCU/h per direction | pass | pass |
| Direction widened on part of its length reports the lanes of its narrowest stretch (2, range 2–3) beside 2,571 | fail ("3") | pass |
| Network key changes after the edit; explorer recompiles on the new revision | pass | pass |
| Micro-simulation links: eastbound pieces 3 lanes, westbound 2 | fail (approaches 2) | pass |
| Undo restores the network key and the assignment exactly | fail (key) | pass |
| Edit outside the study area changes nothing | pass | pass |
| Full analysis job (assignment + micro-simulation): capacities [2,571, 2,571] → [2,571, 3,857]; undo gives the first result back | — | pass |
| SimulationMode end to end: result marked outdated after the edit, new key, re-run 3 lanes / 3,857; undo → first key and identical figures | fail | pass |
| Lanes set in Build survive the shipped `set_lanes` fix | fail (2) | pass |
| Which pieces an edit covers (reversed two-way, stops at main road, different lanes, fork, unnamed, never the other carriageway) | — | pass |

**Browser, measured on the page** (headless Chromium/SwiftShader, production build of the fixed tree at `beefb49`; backend on a *copy* of the project database; Sangamwadi Bridge `osm_208004768`, 1,000 m range, default hour, 3 seeds; the lane edit made through Build's own Lanes control). Overpass was unreachable from the sandbox (connection failures and 429), so roads came from the project database and fresh OSM signal positions were not loaded. The figures are model output (estimated demand). The panel values were read from the page state; no screenshots were taken.

| | Westbound | Eastbound |
|---|---|---|
| Before | 2 lanes, 2,571 PCU/h, 1,395 veh/h routed, v/c 0.57, 1,298 veh/h through, 22.9 km/h, LOS B | 2 lanes, 2,571 PCU/h, 1,546 veh/h routed, v/c 0.63, 1,132 veh/h through (1,115–1,152), 35.8 km/h, LOS C |
| After adding a lane (store: the 3 eastbound ways → 3 lanes, westbound 2) | 2 lanes, 2,571, v/c 0.57, 1,289 veh/h, 23.4 km/h | **3 lanes, 3,857 PCU/h, v/c 0.42**, 1,110 veh/h (1,069–1,138), 36.9 km/h, LOS C |
| After undo | identical to Before; analysis key back to the first one (`9e71829c`) | identical to Before |

Repeated on the final build (`5270aae`) from a fresh copy of the database: the same Before, After and Undo figures. The result on show was flagged `outdated` from the moment Simulate reopened after the edit, and again after the undo. Its re-run started at 8 s both times. It finished at 99 s and 19 s; another agent's browser was using the CPU during the first. After undo the key was back to `9e71829c` and the directions were identical to Before.

Pre-fix build (`6c425dd`), same steps: the edit changed only `osm_208004768`. The re-run started 129 s after returning to Simulate and gave eastbound **"3 lanes", 2,571 PCU/h, v/c 0.63**: the reported symptom, reproduced.

Reading: widening the bridge's eastbound carriageway lowers its v/c from 0.63 to 0.42 and changes the simulated speed by about 1 km/h. The per-seed ranges overlap, so throughput shows no clear change: the carriageway was not the constraint at this hour.

**Suites:** see the counts in the final report of this change (vitest, `tsc -b`, `oxlint`). Backend not touched.

### Uncertainty and open points

- **Which pieces are "the carriageway"** is a rule of thumb: same name, same direction, same lanes, end-to-end nodes matching to 6 decimals, stopping at a main road of another name, a fork, or 900 m. It can stop early where OSM nodes do not meet exactly, and on a long uniform road it can go further than the user meant. Build no longer offered a way to widen a single way on its own; a "This segment only" scope was added in §16.
- **COEP Road 959%: not reproduced, and not the same cause.** COEP Road is `highway=service`, `lanes=1`, two-way: one lane each way, 643 PCU/h per direction, from its own tags. On the dump's network and demand (2 km, buildings + edge traffic), the assignment puts up to about 1,330 PCU/h on it westbound (about 207%), and the bridge edit leaves that unchanged. Why a campus service road carries through traffic, and where 959% comes from (hour, range or the panel's other figures), was not established.
- The "result on show from before the edit" delay (129 s) was measured once, on the pre-fix build, while Overpass was failing. Its cause was not isolated. The new `outdated` flag makes the state visible but does not shorten the wait. The panel does not show the flag yet.

## 15. Panel redesign: visual analytics instead of prose

**What was wrong.** The side panel read as a report: a headline sentence, a long *Why* paragraph, per-direction "routed vs got through" sentences, origin/destination lists and the same overload warning twice (once in *Why*, once at the bottom). A planner had to read everything to find the problem.

**What changed** (`RoadAnalysisPanel.tsx`, new `RoadAnalysisPieces.tsx`, `roadAnalysisView.ts`, `ui/viz.tsx`, `ui/vizTones.ts`, `ScenarioDeltaTable.tsx`, `SimulationPanel.tsx`). Plain CSS bars, no chart library; same dark navy panel, cyan accent and tab bar.

- **1 · What's wrong.** Status chip coloured by LOS with one short line (worst direction: speed vs free-flow; the full headline is its tooltip); chips for run agreement ("3/3 runs agree" or the disagreeing statuses) and data badges (demand Estimated/Calibrated/Hypothetical, speeds Simulated, Proposal). KPI row for the direction the analysis explains: speed vs free-flow, delay s/veh, v/c %, LOS letter. Direction cards side by side, keeping the swatch colour, the glyph rotated by camera heading, compass word, degrees and landmark, and the hover/focus/click/keyboard wiring from §6a (`hoverDirection`, `pinDirection(i, true)`); each card has a speed bar, a v/c bar, LOS badge, volume (got through / routed) and time. *Why*: one-line cause (a junction is named only for `cause.kind === 'spillback'`, i.e. when most runs agree, with its "n/n runs" chip), a stacked delay bar (signal / queue from ahead / giving way / moving traffic) with legend, the queue map button, and the full cause text and reasons in a collapsed "Explanation in full". **Demand vs throughput**: one card only (the load message is filtered out of the reasons), with the mean share that got onto the roads, one routed-vs-entered bar per seed, chips for vehicles queued at the edge / time at the vehicle limit / gridlock removals, and the model-limit explanation behind an info toggle. Counted traffic (where a screenline count exists): counted / model routes / got through as bars with Observed/Estimated/Simulated badges; source and caveats collapsed. Sources: through/local split bar and top-3 origin and destination share bars (click flies there). Worst places: ranked list with v/c bars on one scale (line at 100%) and a per-row "show on map"; the area load map toggle stays. Suggestion cards (top 3) with a headline figure, "Test it" (to Improve & compare, only for junction/signal/widen/divert suggestions) and the existing Build action. "Per-run detail" (per seed: veh/h, time, share got on, end-junction delay, status; per direction: ranges and LOS by run) collapsed.
- **2 · Improve & compare.** Three-step strip (save / edit in Build / compare). Verdict as a large chip with confidence and "runs agree on n/m changes" chips; road / neighbourhood / area verdicts as three small tiles; the summary sentence stays, confidence text behind an info toggle. The road's time, speed, end-junction delay and traffic are before → after KPI cards with a change pill (green better, red worse, grey no clear change) and an "n/n runs" chip. All other measures are compact rows with paired before/after bars (`DeltaRows`). Winners/losers as v/c before/after bars, rerouting as diverging bars, caveats in a collapsed "Assumptions of this comparison". Suggestions show their figure and *what to check*, with the evidence collapsed. Through the day is a bar per period (road veh/h, coloured by status) with the area veh/h in the tooltip.
- **Details.** Every section now starts closed, including the demand one that used to open by default. Renamed: "Assumptions & data sources: the demand", "Checks against traffic counts (screenlines)", "How this is calculated" (the model text from §3–§5). The What's wrong tab links to it.

**Engine, additive only** (no computation changed): `RoadAnalysisResult.explainedDirection` (the direction the headline and cause describe; before, the panel's delay bar picked the longest delay, which could be a different direction than the headline), `RoadAnalysisResult.loadBySeed` (each run's load check, for the per-seed bars), and `Suggestion.figure` (the headline number already in the evidence text). Existing fields, including every prose string, are unchanged, and older results without the new fields still render (fallbacks in `roadAnalysisView.ts`).

**Verified.**

- `npx tsc -b` clean; `npx oxlint` 5 warnings (all pre-existing); `npx vite build` succeeds; `npx vitest run`: 392 passed, 3 skipped (was 381 + 3 skipped; new `RoadAnalysisPanelPieces.test.ts`, 12 tests, and the comparison table tests rewritten for the new rows). In the last full run the `TrafficMicroSim.test.ts` worker timed out on start-up under load (379 passed); that file passes on its own (13 tests).
- Headless Chromium (SwiftShader, 2 CPUs), production build served locally with a copy of the main checkout's database and OSM index, 2026-11-05. Panel screenshots were taken with the Cesium render loop stopped and the canvas hidden (otherwise captures time out), so the panel is shown over a plain background: `vp-overhaul-shots/panel-shivaji-*.png` and `panel-sangamwadi-*.png`, all viewed.
  - Shivaji Bridge, 09:00: Severely congested, KPI 4 km/h of 37, 357 s/veh, 33%, F; cause line "Queue backing up from Shivaji Bridge / Bajirao Road (conflicting turns)", 3/3 runs; counted 7,470 vs model 1,711 vs 1,049 got through.
  - Sangamwadi Bridge, 09:00: Some delay, cause line "Slow in moving traffic: no single junction stands out" (13 of 13 s is moving-traffic delay), KPI 38 km/h of 50, 13 s/veh, 83%, C; one overload card (43% mean; per seed 8,076 / 9,128 / 8,616 of 19,800 veh/h), "More traffic" appears once on the tab. Widening the bridge by one lane then Compare: No clear change, confidence low, KPI and delta rows rendered with the Proposal badge.
  - All disclosures closed by default on all three tabs (read from the DOM). No element extends past the 432 px panel; after fixes no direction title, KPI or origin label is truncated (the measured check lists `text-overflow`/line-clamp elements that overflow).
  - Direction hover with the real mouse: hovering the east card set `directionFocus.hover = 1`, its map arrows went to width 34 / alpha 1 and the other direction's to 14 / 0.28, and the card showed active; moving away restored 24 / 0.95. Clicking the west card pinned it (34 / 1 against 14 / 0.28).
- **Not verified.** The last two wording changes on the Improve tab ("runs agree on n/m changes" chip; "Test it" shown only for buildable suggestions, "Other times of day" for the no-problem card) were seen in the browser on What's wrong only (`panel-sangamwadi-final-whats-wrong.png`); the final Improve-tab capture was lost when the sandbox restarted, so `panel-sangamwadi-improve-compare.png` shows the earlier chip wording ("0/1 changes in all runs"). A screenshot of the hover state with the map visible (the capture timed out with the canvas rendering, as before); a comparison with a clear better/worse verdict in the browser (both browser comparisons came out "no clear change"; coloured pills are covered by unit tests); narrow-window behaviour other than the fixed 27 rem panel; usability with planners.

**Browser verification, 2026-11-06** (production build of `f607375` plus the fixes below, headless Chromium with SwiftShader on 2 CPUs, backend on a copy of the database; roads from the database because Overpass was unreachable, so the panel shows the "Some roads around this area could not be loaded" notice in every capture; Cesium render loop stopped for the whole session, canvas hidden for captures; values read from the page DOM and `simMode.getState()`; scripts and JSON in `vp-wt-verify-e2e/`, screenshots in `vp-overhaul-shots/verify-*.png`, all viewed; working files, not in the repository).

- *Outdated-result banner* (Sangamwadi Bridge deck, 1 km, 09:00, 3 seeds). First analysis (15 s) and two time-of-day changes (09:00 → 18:00 → 09:00, re-run 11 and 13 s each): no banner and `outdated` never set; the view dims to 0.6 only while running. After a Build lane edit (Sangamwadi deck 2 → 3 lanes eastbound) and back to Simulate: the banner (`role="status"`, the stated wording) is in the DOM 0.3 s after entering, while the re-run is still being scheduled, the old figures (36 km/h, 16 s/veh) are dimmed to 0.6, and the banner goes when the new result lands (key `9e71829c` → `52ab2b45`, 37 km/h, 14 s/veh). Undo after that result: banner again until the re-run lands, back on the first key and figures. **Bug found and fixed:** edit, return to Simulate, then undo *before* the re-run landed: the kept result was correctly reused (no re-run, nothing computing, key back to the baseline) but the flag was only ever set, never cleared, so the banner said "being re-run" indefinitely (`verify-A3-after-undo-while-pending.png`). `SimulationMode.recompute` now sets `outdated` to whether the shown key differs from the current one, in both directions; re-measured: no banner, not dimmed, 5 s later still clear (`verify-A-fixed-3-…`). Regression test added to `EditRecompute.test.ts` (fails without the fix). The banner now sits outside the dimmed block so it keeps full contrast (`verify-A-fixed-1-outdated-banner.png`).
- *Improve & compare* (Shivaji Bridge, 2 km, 09:00, seeds 42/7/11). Panel 432 px wide; on every tab no element extends past the panel and no ellipsis or line-clamp element is cut (measured by script); all disclosures closed by default ("Explanation in full", "Source and caveats", "Per-run detail", "Assumptions of this comparison", suggestion "Evidence"; "About the confidence" `aria-expanded=false`). "Test it" appears on the junction suggestion and not on the "investigate"/through-traffic cards (What's wrong); the no-problem card offers "Other times of day" (Sangamwadi). Verdict chip, "Confidence: …" and "runs agree on n/m changes" chips, Road/Neighbourhood/Area tiles, KPI cards with "n/n runs" chips and delta rows with paired bars all render with the final wording.
  - **The §10.2 "Mixed" result did not reproduce on this tree.** Widening `osm_282054960` 1 → 2 lanes now gives **Better** (road better, neighbourhood better, area no clear change; confidence low; runs agree on 3/3 changes): time to drive 83 → 76 s (−8.6%, 3/3), speed 19 → 21 km/h (+6.8%, 3/3), neighbourhood trip time 233 → 224 s (−3.8%, 3/3), delay 175 → 167 s (−4.6%, under the 5% threshold). The same figures came out to the digit in two separate browser sessions. The baseline itself differs from §10.2 (Shivaji now "Slow", LOS D both ways, 3/3, drive time 83 s against 229 s then; queue still traced to Shivaji Bridge / Bajirao Road in 3/3), so the model changes since `36d63a9` moved it; not investigated further. Green pills render (`verify-B-fixed-2-comparison-result.png`).
  - Red pills in a real comparison: narrowing the Sangamwadi deck section to 1 lane per carriageway gave **Worse** (road no clear change, neighbourhood worse, area worse; new bottleneck Sangamwadi Bridge 128%; trips completed −4.1%, gridlock removals 4 → 10, area driving time +6.3%, over-capacity stretches 33 → 39, all red; `verify-C1-sangamwadi-narrow-comparison.png`). Halving Shivaji Bridge (4 → 2 lanes on its main pieces) gave No clear change; only its "roads that lose" bar is red (`verify-B-fixed-4-…`).
  - **Fixed** in `ScenarioDeltaTable.tsx`: changes under 10% now show one decimal. Before, a −4.6% delay (under its 5% threshold, grey) read "−5%" next to a green "−4%" trip time (3% threshold), which looked contradictory. A measure with no value on one side ("—") now says "no data" instead of "no change".
- **Still unverified / open.** A comparison with a *Mixed* verdict, so the green and red pills side by side in one result (none of the three comparisons gave one). The comparison caveat says "differences under 5% … are shown as no change", but neighbourhood trip time, completed trips and served share use 3% (`ScenarioComparison.ts`), so a green −3.8% sits under a sentence that says otherwise; wording left for the owner of that file. Faint vertical lines behind the panel in the Sangamwadi comparison capture come from page layers behind the semi-transparent panel with the canvas hidden, not from the panel. Hover state with the map visible, narrow windows and planner usability remain unverified as before.

## 16. Lane edit scope

**What.** In Build, a lane change now has a scope, set with a two-option control under the Lanes selects ("Apply lane changes to"):

- **Entire carriageway** (the default): the connected pieces of the same carriageway, exactly as in §14 (`carriagewayPieces`, unchanged).
- **This segment only**: only the selected OpenStreetMap way.

The scope resets to the default when another road is selected. Before anything is applied, the panel shows what the change will cover ("Will change 3 pieces · 564 m"), and the same ways are highlighted on the map in fuchsia. The highlight shows while the lane controls are hovered or focused, or once a scope is clicked (the backward-lanes select previews its own direction). It clears when the edit is applied, on deselect and on a mode switch.

**Why.** §14 made a lane edit cover the whole carriageway, because widening only the clicked way left the bridge's capacity where it was. That left no way to model a deliberate partial widening (for example only a bridge deck), and no way to see beforehand which ways would change. A partial widening is legitimate, but the analysis must then say that the unwidened stretch still sets the capacity. Otherwise the result reads as "the extra lane did nothing".

### Fix

- `engine/editing/roadEdits.ts`: `LaneEditScope` (`'carriageway' | 'segment'`, default `'carriageway'`), `laneEditPieces` and `laneEditPreview` (road ids, count, total length, label). `laneEditPlan` takes the scope as an optional last argument. The preview and the edit use the same function, so the highlighted set is always the applied set.
- UI: `components/LaneScopeControl.tsx` (segmented control, preview line, hover/focus tracking) and `components/laneScopeStore.ts` (the chosen scope). `PropertiesPanel.tsx` wraps the lane selects in it and passes `getLaneEditScope()` to `laneEditPlan`. A multi-piece edit is still one batch undo step. A single-way edit uses the usual coalesced `recordUpdate` and shows the toast "Lanes changed on the selected segment only".
- Map: `engine/rendering/renderers/RoadHighlight.ts` draws one non-pickable polyline primitive over whole ways, lifted 2.5 m, without a depth test. Kinds are `lane-scope` (#e879f9) and `binding` (#fbbf24). It is reached through `engineInstance.highlightRoads(ids, kind)` and `getRoadHighlight()` (ids for tests and the browser check). Clicks still reach the road underneath.
- Analysis (`RoadAnalysis.ts`, additive): each direction now carries `binding` (the OSM way that sets its mid-block capacity: `roadId, name, lanes, lengthM, capacityPcu`, the longest of the narrowest ways) and `bindingSegments` (every way at that capacity). It also carries `roadIds` and `segments` (every way in the direction, with its lanes and length).
- Comparison (`ScenarioComparison.ts`, additive): `laneInsights`, one entry per direction of the selected road containing a way whose lanes differ between baseline and proposal. Each entry has the capacity before and after, `capacityChanged`, `binding`, `bindingEdited`, `bindingMoved`, `signalLimited`, `newBottlenecksNearby` (new over-capacity places within 800 m of an edited way), `kind` (`unchanged_elsewhere | unchanged | raised | lowered`) and a sentence. Edited ways are found by diffing lane fields between the two road maps, so the signature of `compareAnalyses` is unchanged.
- Panel: `components/LaneBottleneckCard.tsx`. `CapacityStretchCard` shows on *What's wrong* when a direction's lanes vary along it. `LaneInsightCard` shows on *Improve & compare* after a comparison. Each has a "Show on map" toggle that highlights the binding ways and a "model output" label. `RoadAnalysisPanel.tsx` changed by only the two insertion lines and one import.
- Undo/redo (`SimulationMode.ts`): finished results are kept by analysis key (last 6). When the network returns to a key already computed (Undo, or Redo), the kept result comes back at once, `outdated` cleared, with no re-run. Before, Undo marked the shown result outdated and re-ran the whole analysis (19 s in the §14 browser run).

### Verification

**Unit tests** (`engine/testing/EditScope.test.ts`, 10 tests, real OSM fixture `testing/fixtures/sangamwadi.json`; `engine/testing/LaneBottleneckCard.test.ts`, 4 render tests). All of the behaviour tests were written first, and every one except the default-scope test failed before the implementation:

| Test | Result |
|---|---|
| Segment scope changes exactly `osm_208004768`; the approaches stay 2 lanes | pass |
| Carriageway scope (and the default) changes the three eastbound ways | pass |
| Preview ids equal applied ids for both scopes; "1 piece · ~368 m", "3 pieces · ~564 m" | pass |
| Both scopes change the network key (three distinct keys); undo restores the original key | pass |
| Segment-only deck edit: eastbound 2,571 PCU/h, lanes range 2–3, binding `osm_1151682763` (2 lanes, ~136 m), binding set = the two approaches | pass |
| Carriageway edit: eastbound 3,857 PCU/h, binding set = all three ways | pass |
| `laneInsights` flags "capacity unchanged, set elsewhere" with the 2-lane way, id and length; reports `raised` without a warning when the edited way binds; nothing for unedited directions | pass |
| SimulationMode, segment: outdated → re-run (new key, 2,571, binding approach) → comparison insight `unchanged_elsewhere` → undo restores the first key **and the same result object** without a re-run → redo restores the edited key and result | pass |
| SimulationMode, carriageway: outdated → re-run 3 lanes / 3,857 → undo restores the first key and result object | pass |

Suites: `npx vitest run` 419 passed, 3 skipped (baseline 405 + 3; +14 new). `npx tsc -b` clean. `npx oxlint` 5 warnings, all pre-existing. `npx vite build` succeeds.

**Browser, measured on the page** (headless Chromium/SwiftShader, 2 CPUs, production build of this tree, backend on a copy of the project database on port 8021, static on 4181/4182, 2026-11-06). Sangamwadi Bridge `osm_208004768`, 1,000 m range, default hour, 3 seeds. Edits were made through Build's own Lanes select and scope buttons, and values were read from page state. Overpass was unreachable (connection failures), so roads came from the database. Figures are model output from estimated demand.

| Step | Key | Eastbound mid-block / lanes (range) | Binding way | Westbound | Time to result |
|---|---|---|---|---|---|
| Baseline | `9e71829c` | 2,571 / 2 (2–2), v/c 0.631, 1,132 veh/h | `osm_208004768` (longest of 3 equal) | 2,571 / 2 | 45 s (+45 s baseline capture) |
| +1 lane, segment only (deck) | `de98be73` | **2,571** / 2 (2–3), v/c 0.631, 1,125 veh/h | **`osm_1151682763`, 2 lanes, 136 m** (+ `osm_661187162`, 60 m) | 2,571 / 2 | 34 s (outdated shown first) |
| Compare (segment) | — | insight `unchanged_elsewhere`, 2,571 → 2,571; verdict "no clear change" | `osm_1151682763` | no insight | 21 s |
| Undo | `9e71829c` | 2,571 / 2 (2–2), identical | — | identical | **2 s, same result object, not outdated** |
| +1 lane, carriageway | `52ab2b45` | **3,857** / 3 (3–3), v/c 0.42, 1,110 veh/h | — | 2,571 / 2 | 16 s |
| Undo | `9e71829c` | 2,571 / 2, identical | — | identical | **2 s, same result object** |

Preview, read from the page: the default scope showed "Will change 3 pieces · 564 m" (ids deck + both approaches). Clicking "This segment only" showed "1 piece · 367 m" with highlight `{kind: lane-scope, roadIds: [osm_208004768]}`, and clicking back showed all three. In both edits the preview ids equalled the changed ways, and the highlight was null after apply. The *What's wrong* card's "Show on map" set the highlight to `{kind: binding, roadIds: [osm_1151682763, osm_661187162]}` and turned it off again. The keys `9e71829c` and `52ab2b45` match the §14 browser run.

Screenshots (all viewed):

- `vp-overhaul-shots/scope-map-preview-segment.png`: the map at resolutionScale 0.5, msaa 1, with the deck highlighted in fuchsia and the properties panel showing the scope control.
- `scope-control-segment.png`: the control with "Will change 1 piece · 367 m · shown on map".
- `scope-bottleneck-whats-wrong.png`: the capacity-stretch card.
- `scope-bottleneck-compare.png`: the lane insight card.

The panel captures were taken with the render loop stopped and the canvas hidden.

### Uncertainty and not verified

- The binding way is the **longest** way at the minimum capacity. With all ways equal (the baseline), that is simply the deck. The cards only appear when lanes actually vary along the direction, or in a comparison where a way's lanes changed.
- `newBottlenecksNearby` (a new over-capacity place within 800 m of an edited way) is covered by the code path and by the existing `newBottlenecks` logic. No browser or fixture case produced one, so its wording was not seen on the page.
- The map screenshot of the binding (amber) highlight was not taken. Its ids were verified from page state only. The carriageway-scope preview highlight was likewise verified by ids, not by screenshot.
- Hover-driven preview (mouse over the lane controls) is implemented but was not exercised with a real pointer in the browser. The browser check used scope clicks, which pin the preview.
- Kept results are in memory only (last 6 keys) and are lost on reload. A result is reused only when the network, demand, study, hour and seeds hash to the same key.

### Merged-build browser verification, 2026-11-06

**Setup.** Production build of the merged tree (`29f1ca4`, scope's kept-result restore plus verify's outdated-flag clearing in `SimulationMode.recompute`), then rebuilt with the fixes below. Headless Chromium with SwiftShader on 2 CPUs shared with two other agents (load average 3 to 8). Backend on a copy of the project database (port 8051), static on 4211. Overpass was unreachable, so roads came from the database and the panel shows "Some roads around this area could not be loaded" throughout. The hour-of-day profile was not loaded (`timeOfDay.status` idle), so the hour factor was 1 at 09:00, as in §14 to §16. All runs: 1,000 m range, 09:00 weekday, seeds 42/7/11. Edits were made through Build's own scope buttons and Lanes select. Values were read from the page DOM, `simMode.getState()` and `engineInstance.getRoadHighlight()`. Road content was compared before and after with every road's sections, lanes, coordinates and flags serialised, timestamps left out (18,273 roads). Scripts and JSON are in `vp-wt-merged-e2e/` and screenshots in `vp-overhaul-shots/merged-*.png`, all viewed. These are working files, not in the repository. All figures are model output on estimated demand.

| Check (Sangamwadi Bridge, deck `osm_208004768`) | Result |
|---|---|
| 1. Scope control | **Pass.** Two radios, "Entire carriageway" (checked by default) and "This segment only". After picking segment, selecting another road resets to carriageway, and so does coming back to the deck. A segment edit changed exactly `osm_208004768`, 2 → 3. A carriageway edit changed exactly `osm_661187162`, `osm_208004768`, `osm_1151682763`. No westbound way changed in either. The westbound deck `osm_227095239` previews its own 4 pieces (563 m) and never an eastbound way. |
| 2. Preview = applied | **Pass.** "Will change 1 piece · 367 m" and "3 pieces · 564 m". In both edits the preview ids equal the ways that changed in the road diff. Highlight `lane-scope` (#e879f9) shows those ids. It is null after apply, after deselect, after Build → View and after Build → Simulate. Map captures: `merged-map-preview-segment.png`, `merged-map-preview-carriageway.png` (resolutionScale 0.5, msaa 1; the deck alone, then deck and both approaches, in fuchsia). |
| 3. Capacity of the narrowest stretch | **Pass.** Segment only: eastbound 2,571 PCU/h, lanes 2 (range 2–3), binding `osm_1151682763` (2 lanes, 136 m) plus `osm_661187162` (60 m). The card names both and says the 3-lane deck "isn't the constraint" (`merged-capacity-stretch.png`). Carriageway: 3,857, lanes 3 (3–3), v/c 0.42. Westbound stays 2,571 throughout. |
| 4. Every edit re-runs | **Pass.** Segment: key `9e71829c` → `de98be73`. Carriageway: key → `52ab2b45`. Both times the banner was in the DOM 0.3 s after entering Simulate, with the old figures dimmed to 0.6. The run started at 10 s and 6 s and landed at 31 s and 37 s, and the banner went with it. The run was a real one, not a relabel: new output object, new assignment (Frank–Wolfe gap 0.00054582 → 0.00054626, area veh·h 282.62 → 282.39 → 282.27) and new micro-simulation per seed (section veh/h 2,500/2,313/2,366 → 2,466/2,374/2,361 → 2,514/2,350/2,409). Link volumes were identical in all three (501 links, Σ 195,855 veh/h): the river crossing leaves the routed traffic no alternative, so only link times change. |
| 5. Undo/redo | **Pass.** Undo after the landed segment result: road diff against the original is empty, key `9e71829c` at once (0 s), the same result object, directions deep-equal, no banner, nothing running. Redo: key `de98be73`, the same edited result object, 0 s. Undo again, and undo of the carriageway edit: the same. Uncached edit (lanes 4, carriageway, and then segment), undo 2.5 s and 6.5 s after entering Simulate, before the re-run started: key `9e71829c`, no banner, not dimmed, still clear 5 s later, road diff empty. Undo while the uncached re-run was **computing** (22%): the kept edited result is back at once, with no banner and no timers or worker left. |
| 6. Banner and Improve & compare UI | **Pass, after the fixes below.** Banner wording: "The network changed since this result. It is being re-run on the edited roads." (`role=status`). Panel 432 px. No element extends past the panel and no text is cut. Every disclosure is closed. Chips: "No clear change", "Confidence: low", "runs agree on 0/1 changes". No "Test it" on the non-buildable "No pressing problem" card. `LaneInsightCard`: segment `unchanged_elsewhere` "Eastbound capacity is still 2,571 PCU/h: it is set by a 2-lane stretch …"; carriageway `raised` "rises from 2,571 to 3,857" (`merged-lane-insight.png`, `merged-improve-compare-seg.png`, `merged-improve-compare-cw.png`). Show on map on both cards sets highlight `binding` `[osm_1151682763, osm_661187162]`. Hide clears it. A mode switch clears it. Both comparisons: verdict no clear change, confidence low. |
| 7. Same inputs in before and after | **Pass** (new `inputs` record, see below). Both comparisons, baseline and proposal: demand key `b9c57ddd`, 255 OD trips, 7,800 veh/h planned, hour 9, hour factor 1, seeds run [42, 7, 11], 900 s measured; `matched: true`. Network keys differ, as they should (`fe617fd9` baseline, `78aa1355` segment, `3dfcf1c9` carriageway). |

**Second road: Nyaymurti Ranade Path** (`osm_22841055`, 1+1 lanes, two-way, 267 m). Carriageway previews "2 pieces · 348 m" (with `osm_750335054`, drawn the other way round). Segment previews "1 piece · 267 m". The edit (forward lanes 1 → 2) changed exactly those two ways: carriageway A on `osm_22841055`, carriageway B on `osm_750335054` (directions swapped as §14 says). Key `80ee6838` → `e01be4bf`, with the banner during the 173 s re-run. Undo: road diff empty, key back at once, same object, directions equal. The north-east direction's capacity stayed at 643 PCU/h. Its binding is now `osm_657054226`, an 11 m 1+1 stub of the same name beyond a one-way 2-lane pair (`osm_1524250062`, `osm_1359564185`). The analysis groups that stub into the direction, but the carriageway rule correctly stops at the one-way pair. So "Entire carriageway" does not reach every way the analysis counts in that direction. The card says which stretch binds. That grouping is `roadSection`/`RoadAnalysis` behaviour and was not changed here.

**Bugs found and fixed**

- **"Stopped the road analysis when you left Simulate" stayed on show over a current result.** Leave Simulate while a re-run is computing (the notice is set), undo in Build, come back: the kept result was correctly restored with no banner, but the notice still said the analysis had been stopped (`merged-after-undo-running.png`, `merged-whats-wrong-baseline.png`). The same happened after a stopped run was re-run and landed. `SimulationMode` now remembers a notice that reports only the road analysis being stopped. It clears that notice when a result for the current key is on show: kept, restored by Undo or Redo, or just landed. A notice that also names a stopped comparison or time-of-day run stays. Regression step added to `EditRecompute.test.ts`. It fails without the fix ("expected 'Stopped the road analysis…' to be null") and passes with it. Browser re-check: notice null and not in the DOM after the same sequence, key `9e71829c`, nothing running.
- **The amber binding highlight was hard to see in Simulate.** It was drawn 9 px wide under the selected road's 16 px seed glow, in exactly the colour (#fbbf24) of the study area's upstream lines (`merged-map-binding-amber.png`). `RoadHighlight` now draws `binding` 22 px wide with a 5 px dark outline (`PolylineOutline` material), still amber and still without a depth test (`merged-map-binding-amber-fixed.png`: the 60 m approach reads as a solid outlined band). `lane-scope` is unchanged. `StudyAreaVisualizer` only exports its glow width as `SEED_GLOW_WIDTH_PX`. Test: `RoadHighlightStyle.test.ts`.
- **A worst-places label was cut.** §17 added "(no other route in the model for N% of its traffic)" to bottleneck labels, and the §15 list clamps labels at 2 lines, so "Old Pune–Mumbai Highway, south-east of the road, 200 m (no other route in the model for 100% of i…" was cut. The clamp is now 3 lines; the full label stays in the tooltip. Re-measured: nothing cut. Test in `RoadAnalysisPanelPieces.test.ts`.
- **A comparison's identical inputs were assumed, not checked.** The proposal ran with `this.analysisSeeds`, which is mutable, rather than the baseline's seeds. The guard compared only the live-view seed, demand level, hour and factor. A seed mismatch only lowered confidence, and a demand mismatch was not detected. Now every `TrafficRunSnapshot` carries `inputs` (demand key, trip count, planned veh/h, hour, factor, the seeds actually run, measured seconds). The proposal runs on the baseline's seeds. `compareAnalyses` takes the two inputs (optional fifth argument) and returns `inputs: { before, after, matched, mismatches }`. When they differ, it sets confidence low, puts "Not like with like: … differ in demand, hour, seeds" first in the caveats, and drops the "Both analyses use the same demand, hour and N seeds" caveat. A development scenario (`withNewDemand`) may differ in demand only. Tests: 3 in `ComparisonAgreement.test.ts`. `EditScope.test.ts` changes `analysisSeeds` to [7] between baseline and proposal, and asserts that the proposal still ran [42] and that the inputs match.

**Not verified or still open**

- Time to result varied with the other agents' load. One segment re-run took 222 s to land (27 s of compute), and the cause of the wait was not isolated; the §14 note about waits on failing OSM loads may apply. The banner was on show throughout.
- The binding highlight's east approach was not framed in a capture. Its ids were read from page state.
- The outlined amber is still the upstream lines' hue. It stands out by width and outline, not colour.
- With the hour-of-day profile not loaded, the hour factor is 1 at any hour. That is the §17 recommendation 3 problem, owned elsewhere; both comparisons matched on factor 1.
- No comparison in this run produced a better, worse or mixed verdict, or a `newBottlenecksNearby` entry.

**Final browser verification, 2026-11-06** (merged build `cec5b53` lineage, headless Chromium, backend on a database copy; Overpass answered HTTP 429 so roads came from the database; Sangamwadi deck, 1 km, seeds 42/7/11; traffic figures are model output, page values measured):
- 09:00 baseline: hour profile loaded on entering Simulate (Details never opened); hourFactor 1 because 09:00 is the reference peak; key `f46f89b3`; demand 10,800 veh/h; 54 stretches over capacity; eastbound 2,571 PCU/h v/c 0.676, westbound 2,571 v/c 0.585.
- Segment scope: preview "1 piece · 367 m" equals the only changed way `osm_208004768`; eastbound stays 2,571 with `osm_1151682763` (2 lanes, 136 m) named as binding; outdated banner shown, cleared when key `20edd2eb` landed at 48.9 s (37.9 s compute).
- Carriageway scope: the 3 eastbound ways changed; eastbound 3,857; key `cfd5d6e5`.
- Undo/redo: exact key at once, same result object, deep-equal result, empty road diff (all roads, timestamps excluded). Undo of an uncached edit (4 lanes, both scopes) before its re-run landed: key restored at once, no banner, nothing running 5 s later.
- Improve & compare (carriageway): `inputs.matched: true`; both sides demand key `f14f495c`, 420 trips, 10,800 veh/h, hour 9, factor 1, seeds [42, 7, 11], 900 s. Verdict "No clear change" (low confidence): traffic through the road 2,331 → 2,350 veh/h, removals 4 → 4, over capacity 54 → 54. 432 px panel, nothing cut, caveats collapsed.
- The 222 s slow landing seen earlier did not recur: re-runs landed in 25–49 s after a 3–10 s wait (likely debounce plus a failing Overpass study-area load; not confirmed).

## 17. COEP Road over-capacity investigation

**Observed.** In the user's browser, the Sangamwadi Bridge analysis (2 km area, clock at 14:00, weekday) listed under *Worst places in the wider area*: "347 stretches over capacity — 1. COEP Road, south-east of the road, 500 m: 959%; 2. Kushabhau Jejurikar Road 788%; 3. COEP Road, 200 m: 959%; Unnamed road 1200 m 595%". A later agent run (project-database roads, Overpass unreachable) found COEP Road at about 207%, and a browser run at 09:00 listed Kushabhau Jejurikar 728%, unnamed 590%, 492%, 492%, 352 over capacity, with no COEP Road in the top four (§14).

COEP Road is OSM way 715551386 (+ 1181761149): `highway=service`, `access=private`, `lanes=1`, `oneway=no`. One lane each way, 643 PCU/h per direction (IRC:106 via `midblockCapacityPcu`), 20 km/h. Its tags were checked against the live OSM API on 2026-11-06 (way version 6, 2025-06-16): unchanged.

### Method

Node/vitest probes (outside the repo, `vp-overhaul/scratch-tests/`) that rebuild exactly what the browser analyses: the project roads (a copy of the project database, 18,273 roads; or the 2026-11-03 dump), the shipped correction layer, `applyUrbanSpeeds`, `StudyAreaExplorer` (Sangamwadi deck `osm_208004768`, 2,000 m, both directions), `compileAreaDemand`, `assignTraffic`, `areaContext`. OSM signal positions: the 85 from the 2026-11-03 dump (the sandbox cannot reach Overpass, so fresh ones could not be loaded). Per run: every COEP link's volume, capacity, v/c, free and loaded time; select-link on the most loaded COEP link (the OD pairs and their paths); shortest times with and without COEP; the bottleneck list as the panel builds it. **Check that the probe is the browser:** at 09:00 with signals it gives 352 over capacity and Kushabhau Jejurikar 728%, unnamed 590%, 492%, 492%: the browser run's figures exactly.

Hour factors: the area estimate is scaled to the peak of the clock's half of the day (`setTimeOfDay`), so 09:00 → 1.0 (AM peak), 14:00 → share(14)/share(19) = 0.05429/0.07805 = **0.696**, with the land-use period PM_Peak. Midday demand is 30% below the morning's. The area holds 2 project buildings, so the demand is 28,600 veh/h of edge-to-edge through traffic at 09:00 (108 cordon points).

### Hypotheses and evidence (all model output; figures measured in the probe)

| Hypothesis | Test | Result |
|---|---|---|
| Different hour | 09:00 vs 14:00, same network | COEP 199% → 107–126%; Kushabhau 728% → 506–528%; over capacity 352 → 216–240. **Midday is lower everywhere.** The user's 14:00 figures (788%, 595%, 347) are at morning level, not midday level. |
| Different network source | Project DB vs the 2026-11-03 dump vs live OSM | DB and dump give the same area (1,415 segments, 108 cordon points) and the same loads. All 67 vehicle ways in a 650 × 280 m box round COEP Road match live OSM tags (API, 2026-11-06). Not the cause, as far as the sandbox's data goes. |
| Buildings / centroid connectors | DB roads + the dump's 12,602 OSM buildings converted as the importer does | COEP 207% at 09:00 (the earlier agent's figure), 126% at 14:00. The 66 buildings on the campus generate almost no trips. Not the cause. |
| Frank–Wolfe not converged | 60 vs 300 iterations, 09:00 | Gap 0.029 → 0.0037; COEP 199% → 198%, Kushabhau 728% → 722%. The 60-iteration cap leaves the gap above its 0.001 target, but the ranking does not move. Not the cause. |
| Units, capacity per direction, one-way handling | Link table | 643 PCU/h per direction for a two-way 1-lane service road; volumes in PCU against PCU capacity. No unit error. |
| Ranking duplicates | Link volumes | The two COEP rows are two links of one chain carrying the same flow (identical v/c), more than 250 m apart, so the 250 m rule kept both. A presentation duplicate, fixed below. |
| Build edit on the bridge | Deck `osm_208004768` eastbound 2 → 3 lanes (the pre-fix edit) | COEP and the top list unchanged to the digit. Not the cause (as §14 found). |
| **A piece of the Mokshagundam Vishweshvarayya Flyover chain missing or disconnected** | Remove each of 31 trunk/primary ways within ~300 m of COEP Road, one at a time, 09:00 | Removing any one of **five** ways gives the user's signature: COEP Road first *and* second at **887–970%**, Kushabhau 678–752%, unnamed 590%, 365–393 over capacity. The five: flyover 327073027 (970%), 661187172 (937%), 317550167 (916%), ground-level trunk 815335438 (914%), trunk_link 208099367 (887%). Every other removal leaves COEP at 0–262%. |

**How COEP Road is used, network intact (09:00).** Westbound, 1,221 veh/h (1,281 PCU, 199%); all of it through traffic from the south-east edge (Veer Santaji Ghorpade Marg, Babasaheb Ambedkar Marg, Sassoon Marg) to Sangamwadi Road and the Old Pune–Mumbai Highway. Path: New Sangam Bridge → trunk (`osm_22841398`) → **COEP Road** → trunk `815335438` → trunk_link `208099367` → Sangamwadi Bridge. The campus road is a 106 s shortcut at free flow (362 s vs 468 s for the largest OD), so user equilibrium loads it until its BPR time matches the public route's.

**With the flyover chain broken (one of the five removed, 09:00).** COEP carries 5,943 veh/h (6,235 PCU, 970%), and **100% of that flow has no other route at all** in the network (reachability with the link removed). Its BPR time is then about 1,270 × free flow, which user equilibrium accepts only because there is no alternative. At the real 14:00 factor the same break gives 617–675%, not 959%.

### Root cause

1. **959% vs 207% are two different networks, not two hours.** 207% (199% without buildings) is the intact network at 09:00. 959% is reproduced only when a piece of the flyover chain beside the campus is missing or not joined: then COEP Road becomes the *only* connection for that traffic, the flow on it is forced, and its v/c is demand divided by one lane's capacity. Together with the morning-level figures elsewhere, the user's list matches *morning demand on a network with that break* (probe, code as the user ran it: 365–393 over capacity, COEP 887–970% in two rows, Kushabhau 678–752%, unnamed 590%).
2. **Why a campus service road carries through traffic at all: a model bug.** The importer keeps `access=private` roads (it drops only `access=no`), and the assignment routed over them like public roads. Routing engines do not: OSRM's car profile lists private/destination/delivery/customers/permit/residents as restricted and charges `max_turn_weight` for a turn from an unrestricted onto a restricted way, so they are used only at the start or end of a trip (https://github.com/Project-OSRM/osrm-backend/blob/master/profiles/car.lua). Planning networks leave private campus roads out of through routing.
3. **Are 500–959% plausible UE outputs?** Only for forced flow. A v/c of 5–10 under BPR (β = 4) means a link time 100–1,500 × free flow, which an equilibrium accepts only if the trips have no other route, or every route across a cut is equally overloaded. In this area both occur: COEP with the break, the living street `osm_1117977442` (590%) and Ganeshkhind Road `osm_838145991` (486%) are 94–100% forced. Kushabhau Jejurikar (728%) has alternatives, but all routes across that part of the area are overloaded. The common driver is the edge demand: 500 veh/h per lane at every arterial cordon lane, Furness-balanced, not limited by what the roads inside can carry (§5, §13.1). Such figures are demand over capacity, not flows that could happen.

### What was not established

- **Why the flyover chain was broken in the user's session.** The sandbox has a copy of the project database, not the user's own, and the user's study-area roads came from Overpass, which the sandbox cannot reach. Code paths that could leave a piece missing or unjoined, none confirmed: (a) a way first imported by a clipped *Map Selected Area* is never completed later, because `fillFromOverpass`/`fillFromLocalOsm` skip any way already present as a piece (`osmWayIdsPresent`); (b) a deleted road stays deleted (`deletedOsmIds`); (c) two ways sharing an OSM node join only if their lifted heights differ by ≤ 3 m (`GRADE_SEPARATION_M`). The flyover pieces are lifted to 4.2–6.5 m at their joins.
- **Why the user's 14:00 figures are at morning level.** With the break, the 14:00 factor gives 617–675%; 959% needs a factor near 1. One code path does this: `setTimeOfDay` uses factor 1 while the hour-of-day profile is not loaded (`next.profile ? … : 1`), but the clock still shows the chosen hour. It is not known whether that happened.
- To check in the user's browser console on the network they analysed:
  `const m = window.engineInstance.simMode; ['osm_22841398','osm_661187172','osm_317550167','osm_327073027','osm_815335438','osm_208099367'].map(id => { const r = m.getRoads().find(x => x.id === id || x.id.startsWith(id + '_')); return [id, r?.id ?? 'MISSING', r && r.coordinates[0][2], r && r.coordinates.at(-1)[2]]; })` and `m.getState().timeOfDay` (status, factor).

### Fix (commit `657130b`)

- `staticAssignment.ts`: `isAccessRestricted(road)` reads the OSM access hierarchy (motor_vehicle, then vehicle, then access, as the importer does). Restricted values: `RESTRICTED_ACCESS` = private, destination, delivery, customers, permit, residents. Every link gets `restricted`. All-or-nothing search runs on (node, on-a-restricted-run) states. Entering a restricted run from a public road costs `RESTRICTED_ENTRY_S` = 10⁷ s, prohibitive but finite: through routes avoid restricted roads whenever a public route exists, and trips starting, ending or forced through them are still routed (no new unrouted demand). A trip starts on a restricted run only where every road out of its origin is restricted. The entry cost is a fixed count per OD set by the layout, so it is left out of reported link times, the relative gap and the line search. With no restricted link in an area, the search is the old one. Assignment time on the 2 km area: 389–403 ms → 421–440 ms (node).
- `RoadAnalysis.ts`: `noAlternativeShare(res, link)` is the share of a stretch's assigned vehicles whose OD has no route without it that the assignment would accept: none at all, or only through more restricted entries. It uses select-link plus a 0-1 search per origin. Each bottleneck carries it (`Bottleneck.noAlternativeShare`, optional). From 50% up, the label adds "(no other route in the model for N% of its traffic)", so the panel shows it without a component change. A second link of the same named road with the same volume (±0.5%) is the same chain and is listed once.
- Tests: `engine/testing/AccessRestriction.test.ts` (6). Synthetic network with a private campus shortcut 1.2 km shorter than a public ring road: through traffic takes the ring road; a trip to a car park on the campus road drives in on it; with no public route, through traffic is still routed over it; the access hierarchy (a more specific `motor_vehicle=yes` opens a private road); a forced stretch is labelled and its chain listed once; a stretch with an acceptable alternative is not forced. 5 of 6 fail on `f607375`.

**Effect on the Sangamwadi area** (DB roads, signals, probe; model output):

| | COEP Road | Over capacity | Top of the list |
|---|---|---|---|
| 09:00, before | 199% | 352 | Kushabhau 728%, unnamed 590%, 492%, 492% |
| 09:00, after | **0%** | 317 | Kushabhau 729%, unnamed 590% *(no other route, 100%)*, 495%, Ganeshkhind Road 511% *(no other route, 100%)* |
| 14:00, before | 107% | 231 | Kushabhau 506%, unnamed 410%, 338% |
| 14:00, after | **0%** | 216 | Kushabhau 506%, unnamed 410% *(100%)*, 338%, Ganeshkhind 355% *(100%)* |
| 09:00, flyover piece 327073027 missing, before | 970% (rows 1 and 2) | 374 | COEP 970%, COEP 970%, Kushabhau 752% |
| same, after | 970% (one row, *no other route, 100%*) | 347 | COEP 970% *(100%)*, Kushabhau 768%, unnamed 590% *(100%)* |

With the network intact, the campus road now carries no through traffic. The 5–10% that used it moves to the trunk roads, so Ganeshkhind Road rises from 486% to 511%. Where the flyover chain is broken, COEP Road keeps its forced flow: the fix cannot invent a missing road. The ranking now says the flow has nowhere else to go, which points at the network rather than the road.

**Suites:** `npx tsc -b` clean; `npx vitest run` 411 passed, 3 skipped (baseline 405 + 3; +6 new); `npx oxlint` 0 errors, 5 warnings (pre-existing).

### Recommendations (not implemented)

1. **Repair or flag broken links before analysing.** Report ways in the study area whose OSM neighbours are missing (a clipped piece whose remainder never loaded) or that share an OSM node with a neighbour without joining (height difference > 3 m). Load the rest of a clipped way when a later study area needs it. A stretch with `noAlternativeShare` ≈ 1 and v/c > 3 is the symptom to look for. Check the living street `osm_1117977442` (73.8623–73.8638 E, 18.5270 N) and Ganeshkhind Road `osm_838145991`, both 100% forced on the intact network.
2. **Constrain edge demand by what the area can carry.** Through demand is set per cordon lane and is not limited by internal cuts (river bridges, rail, flyovers), so the assignment reports v/c of 4–7 on the roads across them. Options: cap each cordon point's flow at its approach capacity, balance demand to screenline capacity, or use counts (§13.1).
3. **Show the time-profile state.** When the profile has not loaded, the analysis runs at factor 1 under whatever hour the clock shows. The panel could say so, or the analysis could wait for the profile.
4. Frank–Wolfe stops at 60 iterations with gap about 0.03 against a 0.001 target. The ranking did not change at 300 iterations (gap 0.004), but the reported gap is above target. Conjugate FW or more iterations would close it for about 0.2 s.
5. The live micro-simulation's own routing (`Pathfinder`, used when you press Start, not for the analysis corridor, which follows the assignment's paths) does not apply the access rule. Not changed here.

### Uncertainty

- The 959% is reproduced by construction (a piece removed). That the user's network had such a break is inferred from a figure-for-figure match: rows 1 and 2 at the same v/c, 887–970%, morning-level loads elsewhere. It is not observed. The user's project database and session were not available.
- Signal positions are the 2026-11-03 OSM extract (85 points), not freshly loaded.
- All volumes are model output on estimated edge demand (§5). They are not counts.

## 18. Junction blocking and deadlocks

**Observed (user report).** "Sometimes vehicles pile up inside intersections, stop moving and block the entire road."

### Method

Node/vitest probes outside the repository (`vp-overhaul/junction/scratch/`: `junctionProbe.scratch.ts`, `JunctionBox.scratch.test.ts`, `Merge.scratch.test.ts`) run the micro-simulation headless for 300 s warm-up + 1,500 s measured, seeds 42, 7 and 11, on:

- the **Shivaji Bridge** neighbourhood as the analysis builds it (2026-11-04 dump of the running app: roads, 85 OSM signals, placed junctions, area demand at AM peak; 700 m corridor, 13,800 veh/h routed through it);
- the **Sangamwadi Bridge** neighbourhood (`fixtures/sangamwadi.json`, correction layer, area demand without buildings; 9,743 veh/h);
- synthetic junctions with a Pune-like mix (50% two-wheelers): a signalised crossroads (900 veh/h per approach, 40% turning; and 800 veh/h, 70% turning), an unsignalised arterial/local crossroads, a T-junction, and three junctions 35 m apart on an arterial (signal, priority, signal) loaded beyond what they pass.

Every 5 simulated seconds the probe lists vehicles stopped (< 0.1 m/s) for over 60 s: inside a junction box (still driving the movement of the junction behind, `arriving`), with their body hanging back over the previous junction, or elsewhere; what each waits on (the vehicle ahead, a signal, no room ahead, a conflicting claim, giving way); the wait-for graph and its cycles; and where each blocked queue starts (following "no room" holds downstream). It also records, at every grant, whether the room on the far side was there or only projected; every gridlock removal (what the vehicle was held by); and stop-line discharge per approach lane. All figures are model output on estimated demand.

**What "gridlock removals" are.** `TrafficMicroSim` removes the front vehicle of a lane after it has stood 180 s (`GRIDLOCK_S`), counts it, and frees its claims. That is a despawn, used as a reporting fallback; it is unchanged, nothing new of the kind was added, and it is counted before and after below.

### Root causes (each in 3 of 3 seeds)

1. **The keep-clear check counted room that could not exist.** Before clearing a vehicle into a junction, `tryGrant` asks for room on the exit lane: the movement's end, the vehicle's length and a standstill gap. It added to the free space how far the lane's last vehicle would roll on while this one reached the line and drove the turn, with no limit. A tail rolling at turning speed (4.5 m/s) was projected 20–35 m on even when it was itself entering a 10–13 m link already full. Each follower saw the one before still rolling, entered, and stopped inside the junction, keeping its claim on the box, so crossing movements were refused; between closely spaced junctions the blocked boxes formed rings. Evidence: of the vehicles that stood over a minute inside a box, the share whose grant rested on projected room (free space short by 9–37 m) was 706/723, 741/760 and 743/760 (Shivaji, seeds 42/7/11), 26/26, 26/26 and 52/52 (Sangamwadi), and all but the pairs riding abreast at the close junctions. Wait-for cycles through vehicles stopped in boxes: close junctions seed 42 (two boxes on a 35 m link, each holding the other's queue), Shivaji seeds 7 and 11.
2. **Merging and crossing were not taken in turn.** Where two approaches that do not give way to each other feed one short lane, or cross, whichever kept the junction busy won every time: a dense turning stream on a 25–40 m movement always found room as its tail rolled on, or kept a claim on the box, while the straight-on queue beside it was refused until its front vehicle was removed. Found at Sangamwadi once the first cause was fixed (`osm_1118894175` into its 13 m, three-lane link, the turning stream from `osm_215075336`; 9, 7 and 1 removals there in seeds 7, 11 and 42), and reproduced on its own: a 13 m link fed by 1,800 veh/h turning and 500 veh/h straight on, both of one class, removes the straight-on front after 180 s in every seed before the fix (3, 3 and 5 removals).

Not causes, as far as the probes show: signal handling (isolated signalised crossroads had no vehicle stuck in a box, no removal and no cycle before the fix, and are identical to the digit after it); amber (a vehicle that can stop does; a cleared platoon gives grants back at red, as before); missing lane connections (lanes map across every junction by `mappedLanes`, and no stuck vehicle in any run was a front vehicle with no movement onward; not examined further). Lane changing at the junction entry does not exist in this model (vehicles keep their lane; a blocked target lane falls back to another lane of the next link at the grant).

### Fix (`TrafficMicroSim.ts`, commit `bd97cdf`)

- `exitRoom`: the rolling tail counts only as far as the lane can close up, its vehicles packed nose to tail at standstill gaps against the lane's own stop line (`packedBack`; a rider abreast takes no length), unless the lane's front vehicle is leaving it (cleared through the next junction, or leaving the area). The room asked for is unchanged: past the movement's end, the vehicle's length and its standstill gap. This applies at signals too: green does not clear a vehicle whose exit is full.
- `lostExitRoom`: a cleared vehicle that can still stop (comfortable deceleration) gives its grant back when the exit lane can no longer take it even closed up. Only the lane's capacity is judged here, not the tail's motion, so a discharging platoon is not held back. Room promised to vehicles cleared earlier is counted in grant order (`Reservation.seq`), so a follower's grant never revokes the leader's.
- `heldFor` / `owesTurn`: a front vehicle held at its line for over `MERGE_TURN_S` = 60 s, for room in a lane another approach also feeds or by a crossing movement, gets the next turn: other approaches may not take that lane or start a movement across its path. Only approaches that do not give way to it are held (at a priority junction the main road keeps its priority; at a signal only a green approach counts), and waits are strictly ordered, so two approaches can never each wait for the other. A vehicle giving way under gap acceptance is not covered: that is priority, not a deadlock.

Tests: `JunctionBlocking.test.ts` (2). The closely spaced junctions, seeds 42 and 11, 900 s: no vehicle stands in a box for over a minute (before: 368 vehicle-seconds, longest 160 s, 5 deadlock events), and the network stays over-loaded (trips finished under 70% of arrivals, mean delay over 120 s). The short-link merge, seeds 42 and 11, 1,200 s: no removal (before: 3 and 5), the straight-on front waits under 120 s (before: 180 s, then removed), trips finished unchanged within noise. Both fail on `29f1ca4`. Full suite 429 passed, 5 skipped (the 2 extra skips are the opt-in scratch probes, which are not committed).

### Before and after (same scenarios, seeds and demand; `29f1ca4` vs `bd97cdf`; 1,500 s measured)

| Scenario | Standing > 60 s in a box (veh-min, 3 seeds) | Removals per seed | Trips finished (mean) | Mean delay s | Standing > 60 s anywhere (veh-min) | Max 5-min PCU/h per lane | Cycles through boxes |
|---|---|---|---|---|---|---|---|
| Shivaji Bridge | 3,946 → 20 | 378/399/373 → 246/240/254 | 2,433 → 2,533 (+4.1%) | 221 → 202 | 50,329 → 45,854 | 1,655 → 1,420 | 2 → 0 |
| Sangamwadi Bridge | 47.8 → 0 | 1/3/1 → 0/0/0 | 3,610 → 3,531 (−2.2%) | 103 → 122 | 756 → 354 | 1,552 → 1,526 | 0 → 0 |
| 3 junctions 35 m apart | 44.5 → 0.3 | 47/16/29 → 10/7/3 | 798 → 1,080 (+35%) | 443 → 386 | 21,676 → 16,735 | 764 → 846 | 1 → 0 |
| Signalised crossroads (both loads) | 0 → 0 | 0 → 0 | unchanged to the digit | unchanged | unchanged | 772 / 704, unchanged | 0 → 0 |
| Unsignalised crossroads | 0 → 0 | 0/0/1 → 0/0/1 | 1,068 → 1,046 (−2.1%) | 98 → 88 | 1,505 → 1,632 | 929 → 906 | 0 → 0 |
| T-junction | 0 → 0 | 0 → 0 | 1,158 → 1,154 | 113 → 108 | 419 → 692 | 1,165 → 1,064 | 0 → 0 |

(Seed order 42/7/11. The probe also reports "give-way" pairs between two side roads as cycles; those edges are approximations, both side roads wait for main-road traffic that keeps moving, so they are left out of the cycle column.)

- **Congestion stays where demand exceeds what the junctions pass.** Shivaji still holds ~1,900 vehicles in the corridor with ~1,950 waiting at its edge, and a mean delay of 200 s; the 35 m junctions still finish only about 60% of arrivals. The queues now stand on the approaches instead of inside the boxes. The deadlock detector (nothing crossing for 60 s with two approaches standing) still fires 75–89 times per Shivaji run (84–99 before): it counts spill-back from a full exit, which is real congestion, as well as boxes blocked from inside.
- **Junction capacity is not inflated.** The highest stop-line discharge over any 5 minutes on any approach lane fell or stayed level in every scenario and is at most 1,526 PCU/h per lane, under a 1,800–1,900 veh/h/lane saturation flow. Peaks over a single minute reached 2,100 vehicles/h per lane before and after (half of them two-wheelers, often abreast).
- **Sangamwadi pays for the turns in throughput.** Trips finished −2.2% and delay +19 s: the straight-on queue now gets its turn into the 13 m link, and each turn costs the turning stream the time its 25–40 m movement takes to clear, longer than the 2 s a real driver would need to slot in (the model keeps a lane strictly single-file, so a merging vehicle goes behind the last vehicle still on the turn). Before, the straight-on front was removed instead.

### Browser check (Sangamwadi Bridge, 09:00)

Headless Chromium (SwiftShader), production builds of `29f1ca4` and `bd97cdf` served statically, backend on a copy of the project database (`vp-overhaul/junction/browser/`). Sangamwadi deck `osm_208004768`, 1,000 m, 09:00, seeds 42/7/11, the app's own analysis (300 s warm-up, 900 s counted); values read from the page state, no screenshots. Overpass was unreachable, so roads came from the database. This neighbourhood carries 9,500 veh/h (the database has buildings, so it is not the same demand as the probe above). Model output.

| | before (`29f1ca4`) | after (`bd97cdf`) |
|---|---|---|
| Gridlock removals per seed | 0 / 4 / 3 | 1 / 3 / 1 |
| Trips finished per seed | 2,420 / 2,348 / 2,309 | 2,400 / 2,291 / 2,281 (−1.6%) |
| Mean delay per seed (s) | 86 / 94 / 85 | 94 / 101 / 98 |
| Share of demand that got on, per seed | 93 / 94 / 94% | 93 / 90 / 90% |
| Deck, eastbound / westbound | 36 km/h LOS C / 23 km/h LOS B | 36 km/h LOS C / 24 km/h LOS B |
| Analysis time | 16 s | 20 s |

The direction matches the probe (fewer removals, slightly fewer trips and more delay on this neighbourhood); the removal counts are too small for three seeds to size the change. Vehicles standing inside boxes are not exposed in the page state, so that measure was not read in the browser. Shivaji Bridge was not run in the browser: its roads come from Overpass, which the sandbox cannot reach.

### Gridlock removals that remain (Shivaji, 3 of 3 seeds)

About 247 removals per 1,500 s at Shivaji (≈590 veh/h, 4% of the 13,800 veh/h routed through), from ≈383 (≈920 veh/h). Following each blocked queue downstream to where it starts: 66–70% start at a **priority junction where a side-road vehicle is refused because main-road traffic is moving through the box** (79–81% of the claims holding them are main-road vehicles already crossing), 16–20% at a vehicle that is moving (stop-and-go), 7–8% at a red signal, and none in a cycle. This is the model's priority rule doing what it says: the side road gets no gap in a dense main-road stream, its queue reaches back, and its front vehicle is removed at 180 s. In Pune a side-road driver would force a gap long before; the model has no forced-gap or priority-reversal behaviour. Adding one would change priority-junction capacity, which is calibrated against counts (CALIBRATION.md), so it was not done here.

### Uncertainty, measured vs estimated

- Everything above is simulation output on estimated demand (Measured: nothing; the junction counts in CALIBRATION.md were not re-run).
- Three seeds and two real places. The causes are stated where all three seeds agree; the sizes vary by seed (Sangamwadi delay +11 to +25 s).
- A vehicle longer than a very short link (a bus on a 9 m link) still hangs back over the previous junction while it waits: 20 vehicle-minutes per three Shivaji runs (432 before). The room check counts an empty short link as having room, and looking two links ahead was not attempted.
- A few vehicles still stop inside a box at Shivaji (4–6 per run), cleared on the rolling tail of a lane whose front vehicle was leaving it and was then held at its own line.
- `MERGE_TURN_S` = 60 s is a judgement, not a calibrated value: long enough that ordinary platoon closing-up changes nothing (isolated junctions unchanged), well under the 180 s removal.

**Final browser verification, 2026-11-06** (fix commit `bd97cdf` appears as `1b11fbe` in the pushed history). Sangamwadi, 1 km, live sim stepped 900 s, seeds 42/7/11; box-stuck time read from simulator internals (model output, measured on the page):

| | 29f1ca4 | junction fix only (same network) | final build |
|---|---|---|---|
| Vehicle-minutes standing > 60 s inside a junction box | 16.3 / 90.6 / 31.5 | 0 / 0 / 0 | 0 / 0 / 0 |
| Gridlock removals per seed | 0 / 4 / 3 | 1 / 3 / 1 | 8 / 1 / 4 |

The final build's removals are not comparable with the other columns: its demand is 10,800 veh/h against 7,800 (network repairs in §19 add entry roads); which repair adds it was not isolated. Shivaji was not run in the browser (its roads need Overpass).

## 19. Network gaps, demand profile and forced overloads

Follow-up to §17. Everything below is model output on estimated demand unless marked measured.

### What was wrong, why, and the fix
1. **Live micro-simulation ignored access restrictions.** §17 kept private/destination roads out of the area assignment only. The live sim still routed 193–252 vehicles per seed through COEP Road per 480 s. Fix: the rule moved to `simulation/accessRestriction.ts` and is used by both (prohibitive but finite cost per restricted stretch). After: 0 for all 3 seeds. Trips that start or end on the campus are still routed (60 veh/h test trips at 09:00, 42 at 14:00; unrouted 0). The old whole-city `SimulationManager`/`Pathfinder` still has no access rule.
2. **Roads cut at a "Map Selected Area" boundary were never completed.** Later loads skipped any way already present as a piece. Fix: a way held only as unedited clipped pieces is replaced by the whole way on later loads (local extract, Overpass, whole-road import). A deleted piece keeps its way out.
3. **Undoing an import recorded its roads as deleted by the user,** so they never came back. Fixed.
4. **Ways sharing an OSM node did not join when their heights differed by > 3 m.** Reproduced on the database: an approach whose shape had been edited kept its stored lifted height (4.25 m) while the deck was at 0 m there. Fix: OSM ways join at a shared node whatever their heights, and a deck meets an edited approach at the approach's stored height.
5. **Underpass ramps were dropped.** A ramp down (negative heights) was taken for a flat approach, leaving four underpasses round Shivajinagar unjoined (Sadguru Morya Gosavi, Bankimchandra Chatopadhyay Path, Mula Road, G. D. Madgulkar). Effect at 09:00: area 1,415 → 1,520 segments, demand 28,718 → 29,620 veh/h, Kushabhau Jejurikar Road 730% → 303%, Ganeshkhind Road 513% → 439%, over capacity 317 → 365.
6. **The hour-of-day profile loaded only when the Details tab was opened,** so choosing Midday in the run bar ran 14:00 at factor 1 (morning-level demand). This matches the user's 14:00 figures. Fix: the profile loads when Simulate opens and before every analysis; results record `hourFactor` and `timeProfile`; the analysis key includes whether the profile was loaded; the run bar shows an amber "profile not loaded" line with Retry.
7. **Forced overloads read as flows.** The worst-places list now labels v/c above 150% as "demand X× its capacity: more than can pass, not a flow", and for forced stretches names the nearest main road that ends without a connection, within 500 m of the stretch's own line (`GAP_NEAR_M`; 1,200 m attached a gap to stretches already forced on the intact network). The gap note has its own amber line so the label clamp cannot hide it.
8. **Network key depended on road list order.** Undoing a deletion put the road back at the end, so the same network keyed apart, re-ran and read as a proposal. The key now hashes roads and junctions in id order.

### Verification
Unit tests: `NetworkGaps.test.ts`, `TimeProfileLoad.test.ts`, clipped-import and underpass tests, access-rule tests, order-independent key test in `EditRecompute.test.ts` (each failed on the old code). Full suite 456 passed, 3 skipped.

Browser (measured on the page, 2026-11-06; roads from the database, Overpass HTTP 429):
- Midday chosen in the run bar with Details never opened: hourFactor 0.6956, demand 7,512 veh/h, 21 stretches over capacity on the 1 km Sangamwadi area (54 at 09:00).
- 2 km Sangamwadi, 14:00, intact network: 243 over capacity, COEP Road 0% (no assigned or simulated traffic).
- Flyover piece `osm_661187172` deleted in Build: COEP Road first at "demand 6.7× its capacity", 100% no other route, gap line naming the Mokshagundam Vishweshvarayya Flyover 100 m away; 252 over capacity. Stretches 813, 946 and 1,273 m away, already 100% forced before the deletion, get no gap note. Undo restores the exact key and the same result object (shown after a 16 s wait whose cause was not found).

### Uncertainty
- Which of causes 2–5 broke the flyover chain in the user's session is not proven, nor that their 14:00 run lacked the profile; the user's database and session were not available.
- The 500 m rule is distance-only: it can name a nearby gap the traffic does not use, or miss a farther one that matters. A rule based on which paths would use the missing link needs the network without the gap, which is exactly what is unknown.
- Edge demand is still not limited by what the area's boundary roads can carry, so forced overloads remain possible on intact networks (they are now labelled as such).

## 20. Vehicle accounting, priority gaps and long vehicles

Follow-up to §18. Figures are model output on estimated demand (09:00) unless marked measured; headless figures come
from vitest runs of the micro-simulation on the project's Shivajinagar and Sangamwadi test networks, seeds 42 / 7 / 11.

### What the "removals" were (correction)
An earlier summary of this work said no vehicle is deleted. That was wrong: as §18 describes, `removeStuckVehicles`
was on by default, and a lane's front vehicle that had stood 180 s (`GRIDLOCK_S`) was deleted and counted as a
"gridlock removal". Those vehicles left the
network without finishing their trip, so the analysis under-counted queues exactly where the network was jammed.
Removal is now **off by default** (`4000000`): gridlock stays on the roads and is reported with its place and cause.
The option remains for experiments.

### Vehicle accounting (`1447938`, `cb66d99`)
Every vehicle the simulation creates is accounted for, per run:
- **generated** = **waiting at the edge** (never got onto the network) + **entered**;
- **entered** = **finished at a destination** inside the area + **left at the edge** + **removed** (by place: in the
  junction box / at the approach line / on the link; by cause: waiting for a gap, held by crossing traffic, red signal,
  no room ahead, lane change, no connection, other) + **on the network now**;
- timeouts are always 0 (the model has no maximum trip time).

Also counted: **gridlock events** (a front vehicle reaching 180 s standing, counted once each, removed or not),
**gridlocked now** (front vehicles standing ≥ 180 s at the end) and `gridlockSites()` (junctions holding them, with
vehicle count, longest wait and causes). The analysis result carries the counters per seed and the worst sites;
Understand shows a **Vehicle accounting** table (seed, entered, finished, on roads, at edge, gridlocked during /
at end, removed) with a conservation check and the worst gridlock site; the live view's figures (Details → Live view
figures) show the accounting line and a notice while vehicles stand gridlocked. Tests: `VehicleAccounting.test.ts`
(conservation in every run, the default is off).

### Root causes found
1. **Real deadlocks through withdrawn clearance on very short links.** On 9–15 m links between two junctions a
   vehicle could be cleared to cross, lose its clearance when the link ahead filled, and stop across the junction box
   behind; two such links feeding each other locked.
2. **Turn-taking spread jams.** Turn-taking (a queue gets its turn against a dense stream) was also granted against
   priority and to vehicles held by a full road ahead, which let blocked traffic enter boxes it could not leave.
3. **Whole-path claims on long turns blocked side roads.** A turning vehicle reserved its whole path through the
   junction until it left, so side-road traffic waited for conflicts long past.
4. **Side roads waited far too long for gaps.** Measured from the simulated grants, the side road's effective critical
   gap was 7.3–8.5 s in all seeds, against 3.8 s in Indo-HCM 2017 for a minor-road movement.
5. **Long vehicles stood across junctions.** A 12 m bus or truck entering a link shorter than itself could not wait
   between two stop lines without blocking the junction behind; independently drawn signal offsets on such links
   could keep the two greens apart for many cycles.

### Fixes
- **Priority gap acceptance with impatience** (`da8ce51`): critical gap 3.8 s (Indo-HCM 2017) falling to a 3.0 s floor
  over 40 s at the line; kinematic time-to-line of the oncoming vehicle; vehicles held at a line stop at it; follow-up
  counts on the vehicle ahead accelerating away; a vehicle's claim on its movement ends once it is past the meeting
  point (conflict-point timing); turn-taking never against priority and only for vehicles held by crossing traffic.
- **Long vehicles** (`b18a928`, `b185010`, `3d6ee72`): a 12 m bus or truck enters a short link only if it can wait
  there clear of the junction behind, or can drive through both junctions (next lane empty or leaving, green on
  arrival, no gap to wait for, room beyond); a vehicle past its stopping point keeps its grant at red as at amber, and
  a cleared vehicle counts as leaving its lane only if it beats the red; heavy vehicles turn at 11 km/h; bus length
  12 m.
- **Closely spaced signals coordinated** (`b18a928`, `bb6d12d`): signalised junctions joined by a link under 60 m run on
  a common cycle (the group's longest) with offsets chosen so traffic released into each short link meets a green at
  its far end (Signal Timing Manual, 2nd ed., NCHRP Report 812). Junctions with the project's own timing (placed
  junctions with a set cycle, and edited junctions of §23) are excluded.
- **Removal off by default** (`4000000`).

### Estimates, not sourced values
The 40 s impatience ramp, the 60 m coordination threshold, the 3–12 s release span used for offsets and the 12 m bus
length are this model's estimates. The 3.8 s base gap is Indo-HCM 2017; the impatience shape follows the
critical-gap reductions with waiting time reported by Kittelson & Vandehey (1991), TRR 1320.

### Side-road capacity against main-road flow (headless, `PriorityGaps.test.ts`)
Car-only tee, side-road right turn (the left turn of right-hand traffic), mean of seeds 42 and 7, follow-up time from
the side road's own discharge (2.72 s); reference capacities by Harders' formula.

| Main-road flow (veh/h) | Model | HCM 2010 (tc 7.1 s, tf 3.5 s) | Indo-HCM (tc 3.8 s) | Floor (tc 3.0 s) |
|---|---|---|---|---|
| 300 | 863 | 656 | 1,077 | 1,151 |
| 600 | 574 | 416 | 873 | 998 |
| 1,200 | 317 | 163 | 567 | 740 |
| 1,600 | 195 | 86 | 421 | 601 |

The model lies between the HCM 2010 and Indo-HCM capacities at every flow, never above the floor-gap capacity.

### Headless results (seeds 42 / 7 / 11)
| Network | Trips completed | Removals | Gridlocked at end | Vehicles in a box > 60 s |
|---|---|---|---|---|
| Shivajinagar | 2,460 / 2,546 / 2,391 | 0 | 76 / 51 / 81 | 0 |
| Sangamwadi | 3,943 / 3,963 / 3,904 | 0 | 0 | 0 |

Shivajinagar's gridlock stands mainly at 18.52247, 73.85314 ("no room ahead"). Tests changed: `delay-index` threshold
0.9 → 0.95 (a one-lane stretch now passes about 1,700 PCU/h/lane, was about 1,430), `PriorityGaps` long-wait
scenario at 2,000 veh/h main flow (was 1,800) so its waits still pass the minute.

### Regression against `c046da3`
Shivajinagar vehicles gridlocked at the end rose from 60 / 40 / 55 to 76 / 51 / 81. Before, many of these vehicles
were deleted after 180 s; now they stay. The count is not like for like, but the larger numbers are real jams left on
the roads, and they are not resolved.

### Limitations
- **Bus starvation under strict priority:** a 12 m bus on a side road needs a longer gap than the impatience floor
  gives, so at high main-road flow it can wait much longer than cars behind it would.
- **Coordination trades throughput:** a common cycle stretches the shorter cycles of a group; offsets favour getting
  traffic through each short link over each junction's own delay.
- Gridlock is reported, not cleared: a run whose network locks keeps its locked queues to the end.

### Final browser verification, 2026-11-07

Production build of `7cc3057` (vite build of this worktree), headless Chromium (SwiftShader) on 2 shared CPUs, backend on a copy of the project database; roads come from the database copy because every Overpass mirror answered 429 or timed out (the panel shows its "could not be loaded" banner). Cesium render loop stopped and canvas hidden for element screenshots. Seeds 42 / 7 / 11, weekday. Scripts, JSON and screenshots are working files outside the repository (`/workspace/work/vp-final2-e2e/`, `/workspace/work/vp-overhaul-shots/final2-*.png`); every screenshot named here was viewed.

Measured in the browser (earlier run of this pass on the same build):

| Sangamwadi Bridge, area 1 km, 09:00 | seed 42 | seed 7 | seed 11 |
|---|---|---|---|
| Entered | 3,334 | 3,341 | 3,294 |
| Finished | 2,590 | 2,699 | 2,643 |
| On the roads at the end | 744 | 642 | 651 |
| Waiting at the edge | 328 | 398 | 456 |
| Gridlock events | 55 | 5 | 7 |
| Gridlocked at the end | 8 | 1 | 3 |

- Removals 0 in every run; the accounting identity held (conservation true); a repeat gave identical counters.
- Gridlocked at the end is 8 / 1 / 3 here against 0 headless: the browser's roads are the database copy, not the
  test network, so the two are not the same network. Worst site 18.53629, 73.85094, "no room ahead".
- Shivajinagar, area 2 km, 29,200 veh/h: trips 2,569 / 2,692 / 2,609, removals 0, gridlocked at the end 12 / 5 / 9
  (headless 76 / 51 / 81; the setups differ: demand, area and roads). Seed 42's worst site 18.52247, 73.85314.
- Vehicle mix: two-wheelers 1,495, cars 888, autos 309, buses 114, trucks 52. Longest time in a junction
  box 18.3 s; longest standing in a box 11.8 s.
- Lane discharge: 143 lane discharges measured, none above 1,900 PCU/h averaged over the run; highest per-lane
  average 1,501 PCU/h; highest 1-minute peak 2,139 PCU/h (a single minute).

This run (2026-11-07): Sangamwadi 1 km at 09:00 gave gridlock removals 0 / 0 / 0 (`gridlockRemovalsVph` 0 for each
seed), served share 0.882 / 0.869 / 0.865 of 11,148 veh/h, and the same bridge figures as §22's 09:00 row to the
digit. Gridlock counts were not re-read in this run.

Checks on `7cc3057` in this run: vitest 516 passed, 5 skipped (66 files; full run 506 passed in 65 files, the 66th,
`EditScope.test.ts`, failed to start its worker ("Timeout waiting for worker to respond") and passed alone, 10 of 10;
`TrafficMicroSim` "keeps up with a large area" passed in the full run, 6.5 s); `oxlint` 0 errors, 5 warnings (unused
imports and catch parameters); `npx tsc -b` clean; `npx vite build` passes.

Test change in this pass (`593bc63`): in `JunctionEditing.test.ts` a minor approach's wait for crossing traffic is now
checked as give-way plus conflict, since the priority rules' conflict-point timing records most of it as conflict
(12.75 s give-way + 166.5 s conflict as the minor approach, 0 as the major). Test expectation only; no engine change.

## 21. Connectivity and carriageway definition

Follow-up to §17 and §19: why the flyover chain beside COEP Road could fall apart in a session, and why the
analysis and Build's "Entire carriageway" could disagree on what a carriageway is. Figures are model output on
estimated demand (09:00 unless stated), measured headless in vitest on a project database export
(`objects.json`, 18,273 roads) and the real OSM ways; no browser run has been made for this section yet.

### Database findings
- The six ways of the chain (Trunk Road `osm_22841398`, Mokshagundam Vishweshvarayya Flyover `osm_661187172`,
  `osm_317550167`, `osm_327073027`, Trunk Road `osm_815335438`, Old Pune–Mumbai Highway `osm_208099367`) are in
  the project database whole (no clipped `_in_area_cut_` pieces), in the base scenario, imported 2026-11-03
  15:10:12 UTC and never edited (`created_at` = `updated_at`, no lane edits, heights as imported).
- On that intact database the old code (20cf16f) gives COEP Road 199% at 09:00 (352 links over capacity), and a
  route from Trunk Road to the Old Pune–Mumbai Highway exists without COEP Road. The 887–970% the user saw is
  therefore not explained by the database alone.

### Reproduced sequences (old code 20cf16f, then this branch)
| Sequence | Old code | This branch |
|---|---|---|
| Database as loaded | chain intact; COEP Road 199% | chain intact; COEP Road 0% (access rule, §17/§19) |
| Approach `osm_22841398` reshaped in Build, saved, reloaded | approach end at 4.25 m, deck start at 0 m: unjoined; no route round COEP Road; **COEP Road 935%** | deck meets the approach at its stored 4.25 m (§19 item 4); route round COEP Road exists; 0% |
| Deleted-OSM list holds `osm_661187172` (a delete, or an earlier undone import) | 937% | 965%: a real deletion still forces the traffic, now labelled forced with the gap named (§19 item 7) |
| Deleted-OSM list holds `osm_327073027` | 970% | 0%, route round COEP Road exists |
| Whole import, undo, then a study-area load | undo recorded all six ways as deleted by the user; the load did not bring them back | undo marks nothing deleted; the load restores the chain (§19 item 3) |
| Clipped Map Selected Area cutting `osm_661187172`, then a study-area load | piece `osm_661187172_in_area_cut_0` kept; `osm_22841398` missing after the clip; no route round COEP Road | the load replaces the piece by the whole way; network as a direct import (§19 item 2) |

### What remains unknown
Which of these happened in the user's session. The database rules out a reshaped approach and a clipped piece
there (whole ways, never edited); what it cannot show is the browser-local deleted-OSM list (IndexedDB) and
anything unsaved. The one-line check, pasted into the user's browser console (also
`vp-conn-e2e/js/c00_chain_check.js`):

```js
(async () => { const C = ['osm_22841398', 'osm_661187172', 'osm_317550167', 'osm_327073027', 'osm_815335438', 'osm_208099367'], o = window.engineInstance.objects, d = await o.deletedOsmIds(); return { chain: C.map(id => { const r = o.getById(id); return { id, present: !!r, deletedByUser: d.has(id), edited: !!r?.sections?.[0]?.provenance?.profileModified, heights: r ? r.coordinates.map(p => +(+p[2]).toFixed(1)).join('/') : null }; }), clippedPieces: o.getAll().filter(r => C.some(id => r.id.startsWith(id + '_'))).map(r => r.id) }; })()
```

All six present, none `deletedByUser`, no clipped pieces: the chain is intact in that session.

### New bug found: heights not worked out again on delete (b0d33e2)
Bridge and approach heights were recomputed when OSM roads were added, not when they were deleted. Two effects:
the whole way that replaced a clipped piece was lifted while the piece was still present, so its heights were
up to 1 m off a direct import's and the same network keyed apart; and an approach kept its ramp after its deck
was deleted. `ObjectManager.delete`/`deleteMultiple` now re-run `liftBridges` when an OSM road goes.

Tests `ImportConnectivity.test.ts` (real ways round COEP Road and Sangamwadi Bridge, `fixtures/coep_osm_ways.json`):
a direct import joins every pair of ways sharing an OSM node at any height (bridges, nine underpass ways, 42
bridge ways) and does not join level-separated crossings without one; a clipped area then a larger load equals a
direct import key for key; undo/redo of an import (nothing marked deleted, keys restored); a reshaped approach
still meets the flyover after a reload; deleting a flyover piece lowers its approach as a reload would, and
undoing the deletion restores the key.

### Carriageway definition (2023870)
**Stub root cause.** On Nyaymurti Ranade Path (`osm_22841055`) the north-east capacity stayed at 643 PCU/h after
"Entire carriageway" +1 lane widened every way the edit reached. The section had taken in `osm_657054226`, an
11 m two-way stub of the same name across Shivaji Road's median, past a major junction and past the road's
one-way stretch: the "other carriageway alongside" rule took any same-name piece whose midpoint lay within 45 m
of the section's line (`ALONGSIDE_M`), and the stub's midpoint lay 5 m beyond the section's end. Its single lane
set the direction's capacity. Fix: alongside means beside the line, not beyond a free end of it.

**One definition.** `carriagewayRun` (`roadSection.ts`) is now the carriageway for both the analysis (a
direction's capacity, lanes and binding stretch, `RoadAnalysis.carriagewayOnly`) and the lane edit scope
(`roadEdits.carriagewayPieces`). Section links outside it still count for the traffic through the road but do
not set a direction's capacity. From the selected way, in the direction of travel, downstream and upstream, the
run continues onto a way only if it is the same road (name, alt/official/old name or ref); of the same kind
(one-way or two-way); travelled the same way from the shared node (a one-way piece only along its drawing); a
slip road exactly when the start is. It stops at:
- a fork: more than one way of the same road continues, of any kind or level (a flyover and its at-grade road, a
  same-name slip road);
- a main road of another name through the joint, or through an inner node of the next way;
- a turn of more than 135° (a U-turn onto the opposite carriageway);
- 900 m (`SECTION_MAX_M`) from the start's midpoint;
- for a lane edit, where the lanes in the edited direction change.

**Interpretation.** "Main road" is collector or above (`roadClass` rank ≥ 2): a residential or local street
crossing does not end a carriageway, a collector, arterial or highway does. A modelling choice, not an OSM rule.

**Property tests** (`CarriagewayProperties.test.ts`, `carriagewayInvariants.ts`), checked independently of how
the run walks (contiguous in the direction of travel, no fork or main road at a joint or inside a piece, never
the opposite carriageway, same road and kind, preview equals edit):

| Set | Old scope | New scope |
|---|---|---|
| Every named way round Sangamwadi, both directions (229 cases) | 13 violations (11 main road inside a piece, 2 forks) | 0 |
| 200 random arterial/highway ways of the database export (221 cases; runs only with `VP_OBJECTS` set) | 100 violations (40 main road inside a piece, 35 opposite carriageway, 16 forks, 8 main road at a joint, 1 not contiguous) | 0 |

`CarriagewayDefinition.test.ts`: on Nyaymurti Ranade Path the edit scope is the two two-way ways in either
direction, the stub is in no direction, each direction is the scope of that direction, and the edit raises the
north-east capacity above 1.5× 643 PCU/h with the binding stretch on the edited ways.

### Corrected roads (residual closed)
The analysis builds its network from the roads with the network corrections applied
(`backend/data/network_corrections`); the lane edit scope read the stored roads. The shipped layer
(`pune_west_v1`) does reverse ways (kasturi, infosys), make one two-way (`kasturi-ne-3`) and one one-way
(`infosys-ring-1`), so they could differ. Both now read the same view: `SimulationMode.roadView` (corrections
applied; free-flow speeds, also applied for the analysis, change nothing the run reads) is passed to
`laneEditPreview`/`laneEditPlan`; the run is found on that view and each piece's field is turned back to the
stored way's drawing direction. Tests on the real Nyaymurti ways with hypothetical layers: a two-way way made
one-way ends the scope where the analysis' direction ends (on the stored roads it had reached one way further);
a reversed way gives the same pieces and fields as without the layer.

### Residual cases
- A stored one-way way that a correction makes two-way: the edit stops before it (the stored way has no lanes
  against its direction, and lanes set in Build switch the correction's lane and two-way fix off), while the
  analysis counts it in that direction. Its capacity can then bind a direction the edit cannot widen; the
  binding segment names it. Tested as such.
- Unnamed roads (no name or ref) are a single way: the run has nothing to match on.
- Ways that meet without a shared OSM node (keyed at ~0.1 m) do not continue a run.
- Carriageways longer than 900 m are cut at 900 m from the start.

### Verification
`npx tsc -b` clean; `npx oxlint` 0 errors (5 warnings, none in these files); `npx vite build` passes; vitest
470 passed, 4 skipped (60 files, run in groups on 2 shared CPUs; the long Simulate tests in `EditScope` and
`EditRecompute` rerun alone when a group hit the 120 s limit). `TimeProfileLoad` "Midday chosen" fails on the
base in another checkout (fixed on the vp-day branch); it passed in these runs. Browser verification is
pending the final integration pass (scripts and expected values: `/workspace/work/vp-conn-e2e/README.md`).

### Final browser verification, 2026-11-07

Production build of `7cc3057` (vite build of this worktree), headless Chromium (SwiftShader) on 2 shared CPUs, backend on a copy of the project database; roads come from the database copy because every Overpass mirror answered 429 or timed out (the panel shows its "could not be loaded" banner). Cesium render loop stopped and canvas hidden for element screenshots. Seeds 42 / 7 / 11, weekday. Scripts, JSON and screenshots are working files outside the repository (`/workspace/work/vp-final2-e2e/`, `/workspace/work/vp-overhaul-shots/final2-*.png`); every screenshot named here was viewed.

Earlier run of this pass: c00, the six-way chain at COEP Road, intact (all present, none deleted by the user, no
clipped pieces). c02, Nyaymurti junction: widening the north-east approach raised its capacity from 643 to
1,286 PCU/h; the stub was excluded from the carriageway; the preview ids equalled the changed ids. Sangamwadi Bridge
eastbound carriageway: 3 pieces, 564 m. c01 (whole import, undo, study-area load) was not run: it needs Overpass.

**This run, Sangamwadi deck `osm_208004768`, 1 km, 09:00, lanes 2 → 3 (`steps_main.json`):**

| Scope | Preview (count, length, ids) | Changed ids | Eastbound capacity, binding | Westbound capacity |
|---|---|---|---|---|
| Before | | | 2,571 PCU/h, deck 2 lanes 367 m | 2,571 PCU/h, `osm_227095239` 2 lanes 260 m |
| This segment only | 1 piece, 367 m, `osm_208004768` | `osm_208004768` | 2,571 PCU/h (lanes 2–3), bound by `osm_1151682763` 2 lanes 136 m | 2,571 PCU/h |
| Entire carriageway | 3 pieces, 564 m, `osm_208004768`, `osm_1151682763`, `osm_661187162` | the same three | 3,857 PCU/h (3 lanes), deck 367 m | 2,571 PCU/h |

- Preview ids equal changed ids in both scopes; the opposite carriageway is untouched (no westbound id changed).
- Segment only: the card says "Eastbound: capacity 2,571 PCU/h is set by its 2-lane stretch of Sangamwadi Bridge:
  osm_1151682763 (136 m), osm_661187162 (60 m). The 3-lane osm_208004768 (367 m) isn't the constraint: widen the
  narrower stretch too to raise it." (screenshot `final2-scope-capacity-stretch-seg.png`); "Show on map" highlights
  those two pieces.
- Undo: every road serialised to JSON (sections, lane count, lanes, one-way, profile flag, coordinates) and compared
  string for string: no difference from before the edit after undo, undo–redo–undo and undo of the carriageway
  edit; the network key returns to `cd3e05f9` and the kept result object is reused (deep-equal). Undo while the
  re-run is still pending also restores the identical roads and result, with nothing left running.
- Carriageway comparison: inputs matched (same demand key, 420 trips, 10,800 veh/h, 09:00, seeds, 900 s); verdict
  "No clear change", confidence low (eastbound demand 1,658 veh/h is already below the old 2,571 PCU/h).

**COEP Road, flyover piece deleted (`steps_coep.json`, `e_chainvol.js`): area 2 km around COEP Road at 14:00**
(factor 0.6956, 20,519 veh/h, roads from the database copy):

| | Before | Flyover piece `osm_661187172` deleted | After undo |
|---|---|---|---|
| Network key | `6662cdee` | `a8dbaa90` (full re-run) | `6662cdee` |
| COEP Road highest v/c | 0 (no assigned flow on its 8 links) | 6.71 | 0 |
| COEP Road highest flow, assignment / micro-sim veh/h | 0 / 0 | 4,113 / 625 | 0 / 0 |
| `osm_661187172` assignment / micro-sim | 4,119 / no counted link | no link (way gone) / no link | 4,119 / no counted link |
| `osm_317550167` (beyond the deleted piece) assignment / micro-sim | 2,972 / no counted link | 0 / no counted link | 2,972 / no counted link |
| Links over capacity | 243 | 252 | 243 |

- After the delete COEP Road is first in "What's wrong": "COEP Road, south-east of the road, 300 m (demand 6.7× its
  capacity: more than can pass, not a flow; no other route in the model for 100% of its traffic; network gap:
  Mokshagundam Vishweshvarayya Flyover ends without a connection 100 m away)", with the line "Network gap:
  Mokshagundam Vishweshvarayya Flyover ends without a connection, 100 m away" (`final2-coep-flyover-gap-card.png`).
  The run lists three gaps 116–127 m from the piece (one one-way trap, two one-way sources).
- The three forced stretches more than 500 m from the piece were already forced before the delete (no other route
  for 100% of their traffic in both runs), so the delete did not create them.
- Volume: the deleted way carries nothing in either the assignment or the micro-simulation, and the way left with no
  connection beyond it (`osm_317550167`) gets 0 veh/h in the assignment and no micro-sim count. Checked for the six
  chain ways only, not for every disconnected road in the area. `osm_661187172` and `osm_317550167` have no
  micro-sim link count even before the delete (their assignment flow is 4,119 and 2,972); why the simulation counts
  no link there was not investigated.
- Undo restores the exact key (`6662cdee`), the same result object (no re-run), no road differing from before
  (serialised compare), and every chain volume to the value before the delete.

## 22. Through the day

User report (screenshot not received): Sangamwadi Bridge, *Through the day*: morning 1,112 veh/h at 3 km/h Severe, midday 1,152 veh/h at 3 km/h Severe, evening 1,144 veh/h at 3 km/h Severe, night 844 veh/h at 12 km/h Congested. Questions: why the same speed and severe congestion all day, and why midday carries more than the morning.

### What was observed

- **Not reproduced on the data available.** On a copy of the main checkout's database (18,273 roads; the local OSM index answered the area's road request, Overpass not used) and on the 1 km test fixture (`fixtures/sangamwadi.json`), the bridge is "Some delay" at both peaks and midday and "Flowing" at night (table below). The user's database and session were not available, so which inputs made their road saturated all day is not known.
- **The user's pattern does appear once demand exceeds what the neighbourhood can pass.** With the demand set to a hypothetical 300% (Details → demand settings), three periods are Severe, the traffic that *got through* is nearly flat (2,522–2,901 veh/h) while the demand routed onto the bridge falls from 9,313 to 6,461 veh/h, and **midday moves more than the peaks** (2,901 against 2,522): the user's two observations together. In that run the westbound queue is mostly stopped behind a full road ahead (189 of 312 s/veh), and 53% of the traffic routed into the neighbourhood never got onto its roads (5,577 vehicles still waiting at its edge at the end). Past capacity, queues back through junctions and block them, so more demand moves fewer vehicles.
- Before this change the row showed only the simulated traffic (`totalVph`, the vehicles that drove the road) labelled "veh/h", next to the speed of the *busier* direction and the status of the *worst* one. A capped figure that does not follow the hour, a speed from one direction and a status from the other, read as an error.

### What was checked and found correct

- **Each period uses its own hour factor** (printed per row, browser and headless): 09:00 ×1.0000 of the 09:00 peak, 14:00 ×0.6956 and 23:00 ×0.1831 of the 19:00 peak, 19:00 ×1.0000. Area demand 10,800 / 7,512 / 10,800 / 1,977 veh/h (420 OD pairs) on the database copy; the area assignment's demand equals it in every period.
- **Nothing is reused or scaled between periods.** Each period runs `runAnalysisJob` with its own trips × factor: a new user-equilibrium assignment of the whole area, a new corridor plan cut from it, and new micro-simulations from an empty network (300 s warm-up, 900 s counted). The rows carried no cache; the main analysis's kept-results cache (key includes hour, factor, profile-loaded, seeds) is not used by them.
- **Profile loading:** with the Details tab never opened, the profile was `loading` on entering Simulate and `ready` before the first analysis (`timeProfile: loaded`), and the time-of-day runs wait for it.
- **Profile source** (`backend/data/diurnal/pune_hourly_profile_v1.json`): 08:00–19:00 are measured (Gunjan Chowk counts, Thakur et al. 2017; 09:00–11:00 averaged with the Mendeley Pune CCTV counts, Jan 2023); all other hours, including 23:00, are estimated from TomTom 2025 congestion by hour (BPR-type inversion anchored to the measured hours). So the evening factor rests on counts and the night factor (0.18 of 19:00) is an estimate.
- **What the figures are:** demand = the assignment's veh/h on the road's links (both directions summed in the row); got through = vehicles entering the road's links during the counted window, length-weighted (includes vehicles still on it at the end); speed = road length over the mean link traversal time of vehicles that completed each link.
- **Level of service** is Indo-HCM urban-street LOS on travel speed / free-flow speed for each direction, F also when the assigned demand exceeds capacity and under 90% of it got through; the road's status is the worse direction. It is measured speed, not demand v/c, except in that forced case.

### Root causes and fixes (`9f35cca`, `c0ffafc`)

1. **The row showed throughput as if it were the road's traffic, with no demand beside it** (`RoadAnalysisPanel.tsx`, new `timeOfDayView.ts`). Each row now shows: hour and factor ("×0.70 of the 19:00 peak"), *Demand* (assigned veh/h) and *Got through* (simulated veh/h) as two bars on one scale, the speed of the direction the status comes from with its free-flow speed, the level of service and what set it ("LOS F: speed 18% of free-flow" or "LOS F: demand 1.22× capacity, 62% of it got through"), the unserved veh/h and why (share that got into the neighbourhood, vehicles still waiting at its edge, gridlock removals), and "Held by a queue traced to <junction> (n/n runs)" when the runs agree on a traced queue. Under the rows, from the rows only: "Congested in all n periods…" with the traced junction and the night demand as a share of capacity, "the simulated traffic is about the same … while the demand ranges …" when throughput is capped, and "Less got through at the peak than at midday …" when it falls with more demand. "Per direction and per run" lists every period × direction with each seed's figures.
2. **One seed per period** (seed 42) while the panel above uses three: a period could disagree with the analysis at the same hour, and run-to-run spread was invisible. The rows now use the analysis seeds (42, 7, 11); the 09:00 row equals the analysis at 09:00 (test).
3. **The periods compiled their own plan, bypassing `studyPlan`:** a hypothetical demand multiplier was ignored in the time-of-day rows (so they described a different demand than the panel). They now use `studyPlan(area, landUsePeriod)`, the same plan as the analysis (calibrated, hypothetical, through-traffic setting, corrections); the reference hour comes from one `referenceHour()` shared with the clock.
4. **Stale rows:** the rows' key was stored but never checked; after a Build edit, a demand-setting or calibration change, the old rows stayed on show unmarked. They are now marked outdated (amber notice, dimmed) when the network, plan, settings, day type, count peak, profile or seeds differ, and current again when changed back (verified in the browser after the ×3 change). Whether the user's rows came from an earlier network (for example one with the §19 flyover gap) is not known; it was possible.
5. **Per-seed LOS ignored the over-capacity rule** the overall LOS uses, so a forced F could show as "runs disagree". Both now use the same rule; `DirectionFlow.losBasis` records which metric decided.
6. **A duplicate analysis on Simulate entry** (found through the flaky `TimeProfileLoad` test, which failed on the base commit too): when the profile arrived while the analysis was still loading counts, the re-run it scheduled 700 ms later cancelled the run in flight and repeated it. `runAnalysis` now clears a pending re-run once it has read the current state (and returns if the road changed meanwhile).

Tests: `TimeOfDay.test.ts` (4; the two engine tests fail on the old `SimulationMode`), opt-in harness `DayInvestigation.test.ts` (`DAY_INV=1`, options `DAY_SCALE`, `DAY_DROP`, `DAY_LANES`, `DAY_SEEDS`, `DAY_ONLY`).

Checks: `npx tsc -b` clean; `npx vitest run` 460 passed, 4 skipped (was 456 / 3; +4 in `TimeOfDay.test.ts`, +1 skipped opt-in harness); `TimeProfileLoad.test.ts` now passes repeatedly (it failed 2 of 3 runs on the base commit); `npx oxlint` 0 errors, 5 old warnings; `npx vite build` succeeds.

### Measured in the browser (2026-11-06)

Production build of the worktree, headless Chromium (SwiftShader) on 2 shared CPUs, backend on a database copy, Cesium render loop stopped and canvas hidden. Sangamwadi Bridge, area 1 km, neighbourhood 700 m, seeds 42 / 7 / 11, weekday, Details tab never opened. Values read from `simMode.getState().timeline` and the DOM; scripts and JSON in `vp-wt-day-e2e/`, screenshots `vp-overhaul-shots/day-final-*.png`, all viewed (`day-final-sangamwadi-1km-demand-x3.png` is from the build before the last table-layout change, so its per-run figures wrap; figures identical) (working files, not in the repository).

**Existing demand (estimate, 10,800 veh/h at the peak):** 87–145 s for the four periods (load from other sessions varied).

| Period | Factor | Direction | Demand veh/h | Got through veh/h (42 / 7 / 11) | Speed km/h (free flow) | LOS (per run) | Status |
|---|---|---|---|---|---|---|---|
| 09:00 | 1.0000 (09:00) | westbound | 1,433 | 1,276 (1,301 / 1,267 / 1,259) | 23.4 (30) | B (BBB) | Some delay 3/3 |
| | | eastbound | 1,658 | 1,077 (1,077 / 1,058 / 1,096) | 36.6 (50) | C (CCC) | |
| 14:00 | 0.6956 (19:00) | eastbound | 1,153 | 999 (992 / 972 / 1,033) | 36.9 (50) | C (CCC) | Some delay 3/3 |
| | | westbound | 997 | 993 (1,038 / 981 / 960) | 24.4 (30) | B (BBB) | |
| 19:00 | 1.0000 (19:00) | as 09:00 | | | | | Some delay 3/3 |
| 23:00 | 0.1831 (19:00) | eastbound | 304 | 326 (378 / 332 / 268) | 38.1 (50) | B (BCB) | Flowing, runs disagree |
| | | westbound | 262 | 278 (287 / 319 / 228) | 26.2 (30) | A (AAA) | |

At the peaks 3,091 veh/h is routed onto the bridge and 2,353 got through. The eastbound shortfall is not on the bridge, which runs at 37 of 50 km/h with no traced queue; it is consistent with the entry limit upstream: 82% of the neighbourhood's demand got onto its roads (525 vehicles waiting at its edge at the end). No queue is traced in any period. A second run of the four periods in the same session, and runs in two later sessions on the final build, gave identical figures to the digit, also for the 300% case (deterministic for the network, demand, hour and seeds). Changing the demand setting marked the rows outdated at once.

**Hypothetical 300% demand:** 135–184 s.

| Period | Factor | Direction | Demand veh/h | Got through veh/h (42 / 7 / 11) | Speed km/h (free flow) | LOS, what set it | Status |
|---|---|---|---|---|---|---|---|
| 09:00 / 19:00 | 1.0000 | westbound | 4,320 | 1,446 (1,430 / 1,645 / 1,263) | 5.2 (30) | F, speed 18% of free flow | Severe 3/3 |
| | | eastbound | 4,993 | 1,076 (1,095 / 1,031 / 1,103) | 36.4 (50) | F, demand 2.04× capacity | |
| 14:00 | 0.6956 | westbound | 2,991 | 1,856 (1,845 / 1,833 / 1,890) | 17.5 (30) | F, demand 1.22× capacity | Severe 3/3 |
| | | eastbound | 3,470 | 1,045 (1,056 / 1,004 / 1,075) | 36.5 (50) | F, demand 1.42× capacity | |
| 23:00 | 0.1831 | eastbound | 911 | 865 (866 / 847 / 881) | 37.0 (50) | C, speed | Some delay 3/3 |
| | | westbound | 787 | 803 (886 / 783 / 740) | 24.6 (30) | B, speed | |

Share of the neighbourhood's demand that got onto its roads: 47% at the peaks, 57% midday, 99% at night; gridlock removals 7, 3 and 0 vehicles per run (mean). The westbound peak delay is 61% stopped behind a full road ahead, but the runs do not trace it to the same junction, so no junction is named (the *Why* rule from §10.3).

### Limitations

- The user's case is not reproduced; the explanation of their figures (demand above what the neighbourhood passes, so the shown traffic is capped and falls at the busiest hours) is shown on a hypothetical demand, not on their data. Their night (844 veh/h at 12 km/h) implies night demand on the road at least that high, about 0.18 of a peak far above this estimate; that is consistent with a calibrated or otherwise much larger demand, a network gap forcing traffic onto the bridge (§19), or rows left from an earlier network (fix 4), and none of these could be checked.
- Speed comes from vehicles that completed a link; vehicles still queued on it at the end are counted in "got through" but not in the speed, so under saturation the speed is optimistic. The 15-minute count after a 5-minute warm-up from an empty network is not a steady state when demand exceeds capacity: queues are still growing when counting stops.
- Even at night (v/c 0.12) the simulated eastbound speed is 38 of 50 km/h (76%, LOS B/C boundary): the free-flow reference is the speed limit-based free-flow time, which simulated vehicles do not reach on this section (probably acceleration from and deceleration to its end junctions; not investigated). Low-volume periods therefore rate up to one band worse than a field free-flow speed would give. Not changed here (it belongs to the simulator's free-flow calibration); the row now prints the percentage so the reader can see it.
- AM = PM under the uncalibrated estimate remains (§19): edge flows have no morning/evening pattern and each peak is the reference of its half of the day. The panel says so.
- The four periods take 1.5–3 minutes in the browser with three seeds (one seed took about 50 s).
- `TrafficMicroSim.test.ts` "keeps up with a large area" (a ms-per-step limit) failed in the full run and alone while other agents' browsers kept the load average near 7 on 2 CPUs; not related to this change.

### Final browser verification, 2026-11-07

Production build of `7cc3057` (vite build of this worktree), headless Chromium (SwiftShader) on 2 shared CPUs, backend on a copy of the project database; roads come from the database copy because every Overpass mirror answered 429 or timed out (the panel shows its "could not be loaded" banner). Cesium render loop stopped and canvas hidden for element screenshots. Seeds 42 / 7 / 11, weekday. Scripts, JSON and screenshots are working files outside the repository (`/workspace/work/vp-final2-e2e/`, `/workspace/work/vp-overhaul-shots/final2-*.png`); every screenshot named here was viewed.

Earlier run of this pass, Sangamwadi Bridge, area 1 km, Details never opened:

| Period | Factor | Direction | Demand veh/h | Got through veh/h | Speed km/h (free flow) | LOS |
|---|---|---|---|---|---|---|
| 09:00 | 1.0 | westbound | 1,433 | 1,304 | 23.3 (30) | B |
| | | eastbound | 1,658 | 1,199 | 35.7 (50) | C |
| 14:00 | 0.6956 | westbound | 997 | 1,023 | 24.0 | B |
| | | eastbound | 1,153 | 1,084 | 36.0 | C |
| 19:00 | 1.0 | as 09:00 | | | | |
| 23:00 | 0.1831 | westbound | 262 | 278 | | A |
| | | eastbound | 304 | 326 | | C (runs C / C / B disagree) |

These differ from the 2026-11-06 table above (for example 09:00 eastbound 1,199 against 1,077 got through). That table
was measured on an earlier build (before the §20 and §23 commits) in another harness; the difference was not traced.

This run (2026-11-07): 09:00 gave the same figures to the digit (westbound 1,433 / 1,304, 23.3 km/h, B; eastbound
1,658 / 1,199, 35.7 km/h, C), and Midday from the run bar gave westbound 997 / 1,023, 24.0 km/h, B and eastbound
1,153 / 1,084, 36.0 km/h, C, also identical, in 11 s, with Details still closed. 19:00 and 23:00 were not re-run.

## 23. Junction-level editing

Build showed an imported (OSM) junction as the single piece that was clicked: a 12 m stub of a divided-road square. Junction-level editing groups the nodes and short pieces of one real junction and edits its control, signal plan, priority, banned turns and lane connections as a whole, applied as one Undo step. Road geometry is never changed.

### Grouping rule (`simulation/junctionGroups.ts`)
Two nodes join when all hold, shortest stretches first:
1. both are junction nodes: at least three distinct stretches meet, or two and a mapped signal within `SIGNAL_NODE_M` = 12 m;
2. a stretch of at most `INTERNAL_MAX_M` = 30 m joins them;
3. the joined group spans at most `MAX_SPAN_M` = 50 m (largest distance between any two members, measured pairwise, not chained).

Then:
- **Slip lanes:** a `*_link` stretch of at most `SLIP_MAX_M` = 120 m whose two ends lie within `SLIP_RADIUS_M` = 70 m of a group's centre pulls those two end nodes in, each on its own. A side road meeting a slip lane's end stays its own junction.
- **Enclosed plain nodes (new, 2026-11-07):** a road that leaves a group and comes back into it through plain (two-stretch) nodes only, within `ENCLOSED_CHAIN_M` = 60 m and within 70 m of the centre, is inside the junction.

Two junctions 60 m apart on one road stay apart: the stretch between them is longer than 30 m, and one group could not span them anyway.

**The reported junction** (Babasaheb Ambedkar Marg / Veer Santaji Ghorpade Road, backend database roads, no signals loaded because of Overpass 429). The browser run showed 12 nodes, 16 internal pieces, 3 slip lanes, 5 approaches and 4 exits, labelled "… / Veer Santaji Ghorpade Marg". It was checked for a neighbouring junction merged in. None was:
- Every member node lies within 52 m of the centre. Each has 3–4 stretches, all belonging to the junction's own roads or slip lanes; no side road meets any of them.
- The nearest other junctions stay separate. A residential T-junction 8.4 m past the south-west slip-lane end (56 m from the centre) is kept out by the slip rule, which pulls in end nodes alone. Another residential junction 16.4 m past the south-east end (68 m out) is also kept out.
- "Veer Santaji Ghorpade Marg" is the last 7.9 m of the north-east-bound carriageway (3 lanes) into the square. OSM splits the way where the name changes, at node 73.8633030, 18.5278790. That node is 2 m from the centre and has a signal in OSM. With signals loaded it is a junction node and joined the group. Without signals it has 2 stretches, so it was a plain node left outside, in the middle of the junction.
- That gap cut one approach in two. The 39.5 m piece from the slip-lane node to the name change showed as an exit "Veer Santaji Ghorpade Road to the north-east", and the 7.9 m Marg piece showed as a second approach "Veer Santaji Ghorpade Marg from the south-west".

The enclosed-plain-node rule fixes this: the chain is 39.5 + 7.9 = 47.4 m, from member to member. After the fix the junction has 13 nodes, 18 internal pieces, 3 slip lanes, 4 approaches (Unnamed road from the north, Babasaheb Ambedkar Marg from the south-east, Veer Santaji Ghorpade Road from the south-west, Arjunrao Pawar Path from the north-west) and 3 exits (Underpass to the north, Babasaheb Ambedkar Marg to the south-east, Veer Santaji Ghorpade Road to the south-west). The id is `jx_961a3746`, the same with or without signals loaded. It was `jx_159364f9` without signals. An edit saved under the old id no longer opens with the junction.

### Ids
- **Junction:** `jx_<FNV-1a hash>` of its member nodes' OSM positions (7 decimals, sorted). The same junction found from only the roads around it, or from the whole city, has the same id.
- **Arm:** `in_` / `out_` + hash of the arm's stretch keys. A stretch key is the road id plus the node position it ends at (approach) or starts at (exit). `chainKeys` hold the pieces further out through plain nodes, up to 60 m, so a network that folded the first piece still matches.
- **Movement:** `approachArmId>exitArmId`.

### Edit storage
An edit is a `JunctionEditSpec` stored on a scenario junction object (`importedJunction`) with id `<junctionId>__<scenarioId>`. It holds its own copy of the arms, so it compiles against any network built from the same roads (the whole city or a study area). It is saved, keyed into the network content key, undone and redone like any other Build object. Imported-junction objects are not rendered and are not placed junctions (`splitJunctionObjects`).

`asRun: true` marks the editor's starting values. With it, the engine keeps its own control (mapped or estimated signals, Webster timing, priority by road class) and only the bans and lane connections apply. Changing the control, a green, amber or all-red, phase membership or the major approaches clears it. A ban or lane change does not.

### Starting plan (`editing/junctionDraft.ts`: `lastRunControl`, `startingDraft`)
The simulator covers one logical junction with several of its own junctions: nodes joined at 16 m with a 30 m span, each with its own control. At the reported junction the run had 7 simulated junctions inside it. Two were signalised, with road-class estimated signals:
- a 5-node one, approach-wise with 4 phases, holding the south-west, north-west and north approaches;
- a 2-node one, 2 phases, holding the south-east approach.

All four approaches enter at priority nodes (the slip-lane ends), and the signals stand on pieces inside the junction. The old code took greens from each approach's own stretch only. It found none, fell back, and showed 5 × 25 s.

The editor now starts from exactly what the run did:
- The run result records `signalLinks` (link → simulated junction and phase) and `signalGreens` (greens per signalised junction), next to `signalCycles` (`RoadAnalysis.runSignalStructure`, from the first seed). The phase is read from the simulator's control table by type-checked element access, because `TrafficMicroSim` has no public accessor and the file was not extended.
- Each approach is followed to the first signal that held it. That is its own stop line; else the piece before it, when the simulator joined the approach's first node into its junction; else the pieces inside it drives on to, breadth first, nearest level.
- The plan takes all phases of the signal that held the most approaches, with greens and amber/all-red as run. A phase that held only internal pieces is kept with no approach (marked `Phase n*`), so the cycle and every approach's green match the run. Phases of any other signal that held approaches are appended.
- An approach no signal held is put in every phase and shown as "always green".
- A run that covered the junction with no signal starts as priority. With no analysis yet, the start is the engine's own default: a mapped signal with one phase per approach at 25/3/2 s, or priority.

The note under Control (`data-testid=junction-start-note`) says which case applies, names how many separate signals the run had and lists the always-green approaches.

Applying the starting values unchanged produces identical results, because of `asRun`.

### Engine wiring (`simulation/junctionControl.ts`)
`compileJunctionEdits` matches each edit to a network: member nodes by OSM position, approach, exit and chain stretches by key, and internal pieces.

Assignment (`staticAssignment.ts`), unless `asRun`:
- an approach of an edited signal gets g/C from the plan (green plus amber minus start-up lost time, per serving phase);
- stop-line capacity = Indo-HCM saturation flow × (entry lanes that feed an exit) × g/C;
- mapped signals at the junction's nodes are ignored.

Banned turns are searched as (node, entry link) states in both routers (`TurnBans`), whether or not `asRun` is set.

Micro-simulation (the hook in `TrafficMicroSim.applyJunctionEdits`, about 55 lines, unchanged since 3b33d07; mapping in `simJunctionSetups`), unless `asRun`:
- every simulated junction of the logical junction runs the one fixed plan, not retimed, with one offset per junction id;
- a link from inside the junction is never stopped (phase −1), and so is an approach in every phase;
- priority uses the marked major links.

Lane connections (`laneMap`) and banned turns in route choice always apply.

### Recompute and undo
Apply writes one history step. The network content key changes, so Simulate shows the analysis as outdated and re-runs. Undo restores the identical content, the original key and the kept result object. Redo restores the edited key and its result. Undo and redo are locked while in Simulate (`HistoryManager.setLocked`), so the browser script switches to Build for them. Improve & compare shows before/after delay per approach of each edited junction (`junctionCompare.ts`, `JunctionCompareCard`).

### Camera
"Open the junction in Build" and opening from a road fly to `junctionFrame` (`editing/junctionEdits.ts`). That is the bounding sphere of everything the preview draws: member nodes, internal pieces, and approach and exit stubs (45 m). The camera sits 2.6 × the radius away, at least 150 m, pitched 60° down. Before, it flew to the centre with a fixed 30 m sphere and 350 m range.

### Tests (`engine/testing/JunctionEditing.test.ts`, 26 tests)
- **Sangamwadi roads (`fixtures/sangamwadi.json`, mapped signals):** the Ambedkar square, Dagadi square, no node in two junctions, stable id from local roads, the 12 m piece finds the junction and a long bridge finds none.
- **Backend DB roads (`fixtures/ambedkar_db.json`, the database's roads within 250 m, no signals):** "Veer Santaji Ghorpade Marg" is inside the junction, with 4 approaches and 3 exits as listed above, the same id, nodes and arms as with signals loaded. Neighbours at 56 m and 68 m stay separate; no member meets a side road. This failed on the old rule.
- **Synthetic layouts:** a divided-road crossing is one junction with 4 approaches and 4 exits. Junctions 60 m apart stay two; 20 m apart they are one. A 2 × 15 m dog-leg through a plain node is absorbed; a 2 × 75 m loop is not.
- **Camera:** every member and internal piece of the real junction lies inside the frame sphere, and the range is at least 2 × the radius.
- **Engine honours an edit (crossroads):**
  - the signal plan runs fixed time in the simulator, and the longer green shortens that approach's delay;
  - the assignment takes g/C and stop-line capacity from the plan;
  - a banned turn is avoided by both routers;
  - priority follows the marked approaches;
  - lane connections restrict lanes.
- **Starting plan:**
  - synthetic run data: phases, greens and cycle as run, an internal-only phase kept, always-green approaches, priority when no signal ran;
  - real simulation on the Sangamwadi roads with Webster-timed estimated signals: the plan's first phases equal the signal's Webster greens, every approach is in its signal's phase or always green;
  - **no-op Apply gives a simulation identical to the last vehicle (link counts, metrics, signal plans) and identical assignment link volumes;**
  - one changed green gives one fixed cycle over every simulated junction of it, and different results;
  - an approach in every phase and internal pieces are never stopped.
- **Draft:** control, green, amber, phase or major-approach changes clear `asRun`; a ban or lane change keeps it. Draft changes, validation and the comparison card are also covered.
- **Whole analysis (`SimulationMode`):**
  - a no-op Apply gives a new network key, a re-run and an identical result object (JSON, timings excluded);
  - a changed green gives a different result;
  - edit → key change → re-run → per-approach comparison → undo restores the identical network and kept result → redo.

### Browser status
- **Partial, before these fixes (2026-11-06, old grouping):** "Open the junction in Build" selected the whole junction: 12 nodes, 16 pieces, 3 slips, 5 approaches, 4 exits, with the preview drawn. The editor showed 5 × 25 s, which is the bug fixed above. Apply, re-run, compare and the offer on the 12 m piece worked. The undo step in that script ran in Simulate, where undo is locked, so it proved nothing; the script is fixed.
- **Pending:** the final integration pass with the corrected scripts in `/workspace/work/vp-wt-junc-e2e/` (`steps_main.json`, `steps_noop.json`, `steps_reload.json`; see its README). Expected: 13 nodes, 18 pieces, 3 slips, 4 approaches, 3 exits, id `jx_961a3746`, and a start note naming the run's signals. A no-op Apply should give an identical result.

### Limitations
- **One link, one phase.** The simulator gives each link one phase. An approach in some but not all phases of an edited plan stops outside its first phase. Only "every phase" (always green) is honoured as such. The assignment does count every serving phase.
- **Several signals become one plan.** When the run had several separate signals inside one junction, the starting plan joins them, base signal first. Once the plan is changed, it runs as one coordinated cycle at every simulated junction of the logical one. Internal pieces then never stop, and the stop lines move to where the approaches enter (the slip-lane ends at the reported junction). This is the intended model of a junction controller, but it is not the run's uncoordinated signals.
- **Starting values come from the first seed only.** Webster greens are rounded to whole seconds in the editor. Neither matters for a no-op Apply, which keeps the engine's own control.
- **Edits under the old id are orphaned.** An edit saved before the grouping fix, under `jx_159364f9`, is still compiled by its node keys, but the editor opens the junction under `jx_961a3746` without it.
- **Proximity rules are heuristics.** The 60 m enclosed-chain and 70 m slip radii are judged on Pune layouts. A real side loop shorter than 60 m whose middle node has only 2 stretches would be taken into the junction.

### Final browser verification, 2026-11-07

Production build of `7cc3057` (vite build of this worktree), headless Chromium (SwiftShader) on 2 shared CPUs, backend on a copy of the project database; roads come from the database copy because every Overpass mirror answered 429 or timed out (the panel shows its "could not be loaded" banner). Cesium render loop stopped and canvas hidden for element screenshots. Seeds 42 / 7 / 11, weekday. Scripts, JSON and screenshots are working files outside the repository (`/workspace/work/vp-final2-e2e/`, `/workspace/work/vp-overhaul-shots/final2-*.png`); every screenshot named here was viewed.

Measured in the browser (earlier run of this pass; not repeated in this run):
- "Open the junction in Build": `jx_961a3746`, 13 nodes, 18 pieces, 3 slips,
  4 approaches, 3 exits, as expected. Camera at 100 m, pitch −60°.
- Starting greens [48, 21, 33, 29] + 48 → 204 s cycle. A no-op Apply gave an identical result.
- +20 s on the south-west approach → 224 s cycle; north-east delay 810 → 446 s; per-approach change SW −78 s,
  NW −78 s, SE +7.5 s, N +227 s. Comparison inputs matched; undo and redo exact; the edit persisted across a reload.
- UI: the centred tool bar ran under a 22rem / 27rem side panel at 1,600 px and covered the junction editor's title;
  fixed in `7cc3057` (compact layout below 1,700 / 1,830 px).
