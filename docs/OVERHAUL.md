# VirtualPlanner overhaul: simulation, analysis and comparison

Branch `realistic-traffic`, from `98a4966`. This document answers the overhaul brief section by section (the numbers §1 to §11 follow the brief, and code comments point to them). For each improvement: what was wrong, why, what changed, how it was verified, and what remains uncertain. §12 separates what is implemented, tested, estimated and left for later; §13 lists the decisions that need the project owner.

## Summary

- The Shivaji Bridge "congestion" in the original report came mainly from a **100 km/h free-flow default** on an untagged urban trunk road and a uniform 1,800 veh/h/lane capacity. Speeds are now capped at 50 km/h on untagged urban roads (MoRTH 2018, Maharashtra 2019), capacities follow IRC:106-1990 in PCU, and LOS follows Indo-HCM.
- The cause the panel gave ("a queue from another junction") was a default sentence. The simulator now records why each vehicle waits and traces queues to where they start; a cause is stated only when the runs agree.
- A mid-overhaul run blamed a **fictional** demo road ("Pune Central Boulevard", ~230 m south of the bridge). Sample objects are now excluded from Simulate. Earlier Shivaji Bridge figures are contaminated by them.
- The whole-area micro-simulation could not carry a 2 km area (55% of demand entered). It is replaced by a **two-tier model**: static user-equilibrium assignment for the area and a 700 m micro-simulation around the road, 3 seeds, ~41–54 s in the browser instead of ~210 s per seed.
- Final Shivaji Bridge result (AM, estimated demand): **severely congested in all 3 runs**, south-east at 5 km/h (LOS F) while the bridge is at 33% of capacity; 87% of that delay is queueing traced to the Shivaji Bridge / Bajirao Road junction. Widening the bridge makes no clear difference.
- Demand is the weakest part. The model puts **~23%** of the 2008 counted volume on Shivaji Bridge (PMC CMP 2008). This is reported, not corrected; choosing a demand source is the main open decision (§13).
- Live controls now have a real lifecycle with Stop; "Play 24 h" (which did not simulate a day) is replaced by Compare times of day; the panel is split into What's wrong / Improve & compare / Details; comparisons use frozen demand and seeds and no longer call a trade-off "Better". Two issues from the final browser round are open: a cause can still be named from 1 of 3 runs, and the neighbourhood change in comparisons needs an A/A check (§10.3).

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

**Uncertain.** The final browser round found the neighbourhood trip-time and delay change almost identical for these two unrelated edits; an A/A check is needed before the neighbourhood part of these verdicts is trusted (§10.2, §10.3 issue 3). Confidence is *low* when the neighbourhood is over-loaded (more routed than its junctions pass). Three seeds are a minimum. Junction delay agreement shows "0 of 3" when per-seed end-junction delays are missing, which reads oddly.

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

Recorded on the final code (after commit `8796aa6`, the last code change before shipping; earlier figures at `352ed55` in brackets):

| Check | Result |
|---|---|
| `npx vitest run --config vitest.config.ts --pool=threads --maxWorkers=1` | 46 files: 43 passed, 3 skipped (opt-in harnesses); **362 tests: 359 passed, 3 skipped, 0 failed** (239 s) [361 / 358 / 3 at `352ed55`] |
| `tsc -b` | no errors |
| `oxlint` | 0 errors, 5 warnings (pre-existing unused variables in untouched files) |
| backend `pytest` | **52 passed** |

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

**Open question about the neighbourhood figures (§10.3, issue 3).** The neighbourhood change is almost identical for the two unrelated edits: trip time 237.09 vs 237.18 s, delay 167.96 vs 167.94 s, both from the same 208.5 / 142.3 s baseline. Two different edits giving the same result to 0.1 s suggests the proposal run differs from the baseline for a reason other than the edit (warm-start, assignment state, measurement window or vehicle population). An A/A comparison (a no-op edit) was queued to check this. **A/A result: PENDING** (`vp-overhaul/e2e3/aa.results.json` not yet written). **Until it is resolved, the "+14% trip time / +18% delay" part of the Mixed verdict for proposal 2 should not be relied on**. The bridge-level figures (−34% drive time) come from the same proposal runs, so they are provisional too until the A/A result is known.


**Screenshots** (`vp-overhaul-shots/`, working directory, not in the repository): F01 (2 km map, junction dots), F02 (What's wrong), F03–F05 (queue, routes and how-full overlays), F06–F07 (comparison), F08 (comparison overlay). All were viewed.

### 10.3 Issues found in the final browser round, and their status

From `vp-overhaul/e2e3/BUGS.md`:

1. **Cause named from a minority of runs (medium).** The rule is that a cause is named only when runs agree. `RoadAnalysis.ts` (`chainFor()`) takes the most common queue root with no minimum agreement, and the spill-back text is used whenever a root exists. On the Wakad lane the panel names a junction found in 1 of 3 runs. Expected: fall back to "could not be traced to one junction consistently". Shivaji Bridge and Nal Stop are unaffected (3 of 3). **Fixed in `8796aa6`**: a cause is named only when most runs (2 of 3, or the single run) trace the queue to the same junction; otherwise the panel says the queue could not be traced consistently, names the minority trace with its count ("found in only 1 of 3 runs") and marks nothing on the map. Unit-tested (`Overhaul.test.ts`); the Wakad lane was not re-run in the browser after the fix.
2. **"found in all 1 runs" (low, wording)** when a single seed is analysed. **Fixed in `8796aa6`** ("in the one run analysed").
3. **Identical neighbourhood change for unrelated edits (needs check).** See §10.2, comparison re-check. This bears directly on the comparison verdicts. A/A check pending.
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

- Unit and integration: lifecycle, speeds and capacities, LOS, delay attribution and tracing, sample-object exclusion, screenlines, comparison agreement and verdict (§10.1).
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
