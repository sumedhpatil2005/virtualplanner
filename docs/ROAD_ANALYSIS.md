# Road analysis: why a selected road ran nearly empty, what changed, what was verified

> **Update (overhaul, November 2026).** The analysis now assigns the whole study area by static user equilibrium and micro-simulates only the selected road's 700 m neighbourhood with 3 seeds; free-flow speeds are capped at 50 km/h on untagged urban roads, capacities follow IRC:106 in PCU, and the fictional sample objects are excluded from Simulate. Figures in §4–§6 below were produced by the earlier whole-area simulation (one seed, 5,000-vehicle limit) and are kept as the record of that stage; they are **superseded** for current behaviour by §7 here and by docs/OVERHAUL.md. Any Shivaji Bridge figure produced before the sample-object exclusion is invalid (its queue was traced to the fictional "Pune Central Boulevard").

Branch `realistic-traffic`. Applies to the Simulate panel's road analysis (select a road, read what is happening on it and test a change).

## 1. What was wrong

Selecting Veer Santaji Ghorpade (VSG) Road with a 2 km study area showed about 96 veh/h on a 3-lane arterial. That was a modelling artefact, not a finding. Causes, each confirmed on the regression cases (§4):

1. **No edge or through traffic.** Once the project had any demand, the area's edge flows were switched off, so every trip started and ended inside the 2 km area.
2. **Trips far too short.** Destinations were drawn by 1/d² gravity over the 32 nearest candidates. Pune motorised trips average 4.7–8.5 km (CMP 2018, Table 9); 57% of VSG's demand had routes under 1 km.
3. **25–35% of demand silently dropped**: trip ends with no drivable route (one-way streets, cut-off pieces) were lost without being reported.
4. **Few workplaces in OSM.** VSG's area holds about 368k modelled residents but 1.9k jobs, so PM-peak demand (jobs as origins) collapsed to 71 veh/h.
5. **"Selected road" was one OSM way piece**, 152 m long and one carriageway of a divided road: one direction of travel.
6. **Cut ends carried no flow.** Roads cut at the edge of a "Map Selected Area" import had no traffic entering or leaving there.
7. **Zone demand at a single point** (the centroid) instead of spread over the zone's streets.
8. **Traffic was forced onto the road.** The live view's default "Through this road" mode sent 2,016 veh/h of synthetic trips through the selected road (screenshot `before_panel_vsg.png`).

## 2. What changed

| Area | Change | Code |
|---|---|---|
| Demand | Three labelled parts: **internal** (trip-length deterrence from CMP 2018 mean lengths, Erlang-2), **area ↔ edge** (the share of each trip end's trips longer than its distance to the edge leave or arrive by roads crossing the edge), **through** (residual edge flow balanced edge-to-edge by Furness, trimmed so no entry or exit carries more than its edge flow). | `AreaDemand.ts` |
| Demand | Directed reachability: internal destinations only where the origin can drive (strongly connected components); edge trips only to and from reachable edge points; what cannot be routed is reported as "left out", not dropped silently. A closed network keeps all trips inside. | `AreaDemand.ts` |
| Demand | Residual zone activity spread over the zone's streets by frontage; cut ends of mapped areas carry edge flow. | `AreaDemand.ts` |
| Section | The road is followed across OSM pieces of the same name/ref (suffixes like Road/Marg ignored), both carriageways, until the next main road of another name or 900 m each way. A clicked piece that ends at a main road now stops there too (it used to run one link past it). | `roadSection.ts` |
| Simulator | Section watching by segment, per-link and select-link counters, OD arrivals from a min-heap (large areas have 10k+ OD streams), served-vehicle and vehicle-limit counters. | `TrafficMicroSim.ts` |
| Analysis | One repeatable run (fixed demand, seed, hour; one route-feedback iteration; 300 s warm-up, 900 s counted) in a Web Worker. | `analysisJob.ts`, `analysis.worker.ts`, `analysisRunner.ts` |
| Analysis | **Capacity check**: share of routable demand that got onto the roads, time at the 5,000-vehicle limit, gridlock removals. When the network cannot take the demand the panel says so first ("Demand exceeds what the modelled network can carry…"), and volumes are labelled as what got through. | `RoadAnalysis.ts` (`loadCheck`) |
| Analysis | **No route feedback from a jammed run**: delays measured past capacity reflect gridlock, not route choice (every jammed link got the 10× cost cap and VSG's traffic was pushed onto side streets: 8 veh/h on VSG in the browser before this fix). Routes stay at free-flow fastest, and the panel says routes were not adapted. | `analysisJob.ts` |
| Scenarios | The proposal runs on the baseline's **frozen demand**, seed and hour. A land-use change no longer blocks the comparison: it is flagged, the infrastructure comparison still runs on the old demand, and "Include it" runs a **development scenario**, labelled as such. Caveats for noise, overload, and runs whose route adaptation differs. | `ScenarioComparison.ts`, `SimulationMode.ts` |
| Panel | Simple default view: what's happening (status, volume per direction against capacity, why), where its traffic comes from and goes (select-link, map view), what limits it, improvements to explore, test a change. Live traffic, demand evidence, calibration, network checks and model notes are under **Advanced**. Hypothetical demand (what-if scaling) carries a Hypothetical badge and label. After a Build edit, a **Proposal** badge marks "What's happening" whenever it shows the edited network rather than the saved existing city (`comparison.showingProposal`). The comparison table keeps Existing and Proposal in separate padded columns, with the % change on its own line. | `RoadAnalysisPanel.tsx`, `ScenarioDeltaTable.tsx`, `SimulationPanel.tsx` |

Nothing forces traffic onto the selected road: its volume is whatever the area's demand chooses to route over it.

## 3. Demand sources and assumptions

| Item | Value | Source / status |
|---|---|---|
| Trip generation | 0.87 motorised trips/person/day, peak-hour share 7.8%, mode split and occupancy | PCMC CMP 2018 Tables 6–7 (p. E-5); CMP 2008 Table 4.7 |
| Mean trip length | 7.54 km two-wheeler, 4.68 auto, 8.54 car, 6.25 bus | Pune CMP 2018 Table 9 |
| Trip-length spread | Erlang, shape 2 | **Assumption** |
| Arterial edge flow | 500 veh/h per lane per direction | Low end of counted approaches at five west-Pune junctions (867–2,679 veh/h on 2–3 lanes; NICMAR 2025 / Kureshi 2026, `backend/data/observed_counts/pune_west_2026.json`) |
| Collector edge flow | 300 veh/h/lane | **Assumption** (no counts) |
| Trunk/motorway edge flow | 500 veh/h per lane per direction (the arterial value) | **Assumption** (no counts) |
| Through routing | 3× preference for leaving on the road it came in on | **Assumption** |
| Vehicle mix of edge/through traffic | Gunjan Chowk classified counts | Thakur et al. 2017 |
| Buildings | residents/jobs from OSM floors × 12 people by category | Importer; jobs under-counted (§5) |

All demand is labelled "Estimated … Not measured on these roads" in the panel.

## 4. Results (verified)

Section volumes, veh/h in the counted hour. *Before* = commit `c212dc7` logic (OSM buildings, internal-only gravity demand, single way piece). *After* = final code on this branch (`651fc2f`), app-equivalent analysis job (`RoadProbe3`: analysisJob defaults, 300 s warm-up, 900 s counted, seed 42, Webster signals, project land use; AM and PM periods).

| Case | Before | After (node, app job) | Status after |
|---|---|---|---|
| VSG Road, 2 km area | 96 (152 m piece, one direction) | 1,567 NE / 293 SW (732 m section, both carriageways) | Congested; **demand exceeds modelled capacity**: 58% of the 28,898 veh/h of demand entered, 22% of the hour at the 5,000-vehicle limit, routes not adapted |
| Dange Chowk Road, 2 km | 696 AM (one direction, 136 m piece) / 0 PM | AM 709 N / 412 S; PM 1,027 N / 434 S (1,563 m section) | Congested; demand exceeds modelled capacity (66% AM / 69% PM entered, 27–28% of the hour at the vehicle limit) |
| Balewadi High Street (Ganraj area), 1 km | 1,050 AM (one direction) | AM 1,064 S / 376 N; PM 889 S / 214 N (1,506 m section) | Congested at its end junction (Ganraj); 94% AM / 96% PM of demand entered |
| Rutuja Park Lane No. 1 (local street, Baner), 1 km | 18 | AM 4 / 4; PM 2 / 0 (176 m) | Almost no traffic: a residential lane whose buildings' trips mostly leave the area by main roads; area slightly overloaded (81% AM / 78% PM entered) |

What the demand is made of (veh/h, AM): VSG 28,898 all through (the project's buildings and zones do not reach this area, so its demand is edge-to-edge traffic on the crossing main roads); Dange 416 internal, 10,206 area ↔ edge, 15,727 through (1,284 left out beyond reach); Balewadi High Street 615 / 1,267 / 6,798; Rutuja 5 / 1,486 / 5,321.

Counted junctions, entering veh/h (count / model demand through the junction / served in the run):

| Junction | Count | Before: demand / served | After (AM): demand / served | After (PM): demand / served |
|---|---|---|---|---|
| Ganraj Chowk | 8,296 | 1,461 / 1,452 | 5,345 / 2,968 (56%) | 4,652 / 1,796 (39%) |
| Panchratna Chowk | 6,315 | 1,192 / 1,020 | 6,217 / 1,860 (30%) | 6,445 / 2,196 (34%) |
| Kasturi Chowk | 6,200 | 856 / 846 | 10,924 / 2,192 (20%) | 9,823 / 2,588 (26%) |
| Infosys Circle Ph. 1 | 4,243 | 2,716 / 1,506 | 3,939 / 1,288 (33%) | 3,778 / 1,592 (42%) |
| Sakharam Waghmare Chowk | 3,974 | no simulated road enters | no simulated road enters | no simulated road enters |

Ganraj from the Balewadi High Street area; the other four from the Dange Chowk area. Sources: `vp-shots/road-analysis/final_probe_vsg.json` and `final_probe_rest.json` (after, final code); `after6.json` (before-logic variant on the current simulator); `before_probe.json` (before-code section volumes, commit `c212dc7`). These files are in the working directory, not the repository.

What this shows: demand now reaches the counted junctions at the counted magnitude (except Kasturi, §5); the simulated junctions serve 20–56% of it.

## 5. Limitations and data gaps

- **Junction capacity is the binding limit.** Even with the counted demand placed exactly at single junctions, the simulator passes 41–68% of the counted volumes (CALIBRATION.md §3, §4.4: Webster Y = 1.46 at Ganraj, 1.11 at Kasturi). In area runs, counted junctions serve 20–56% of the demand routed through them (§4). The likely causes (approach-wise phasing where real junctions run opposing approaches together or free left turns; mid-block IRC:106 PCU factors used at stop lines) need a measured phase plan or a junction PCU source. The real phase plans at these junctions are not known, and nothing was tuned to hide the shortfall. Until then large areas jam: VSG and Dange Chowk reach the 5,000-vehicle limit. This is reported in the panel, not hidden, and part of it is a model limit.
- **Kasturi overestimate**: model demand 9,800–10,900 veh/h through Kasturi against 6,200 counted. Kasturi sits where several edge arterials meet, and the 500 veh/h/lane edge flow is applied to every lane of every crossing arterial; the area's own buildings add on top. Not corrected: a per-road edge flow needs counts on those roads.
- **Assumed edge flows**: arterial 500 veh/h/lane per direction is the low end of counted approaches; collector 300 veh/h/lane and trunk/motorway 500 veh/h/lane (the arterial value) are assumptions with no counts behind them; local streets get none.
- **Low OSM job counts**: workplaces are rarely tagged, so internal and PM-peak productions are low; trips without a destination in the area leave it by the edge.
- **One seed, one hour**: every figure here is one run (seed 42); differences under 5% (10% junction delay) are reported as no change.
- **Route adaptation off when overloaded**: in jammed areas routes are free-flow fastest; a proposal and baseline that differ in this get a caveat.
- **Runtime**: a 2 km central-Pune area (≈1,850 roads, 117 edge points, ~29k veh/h) takes about 3 min in node (163–182 s on the final code) and 2–4 min in the browser worker; 1 km areas take 10–25 s.
- **Sakharam Waghmare** shows no simulated road entering it (OSM ring vs four-arm survey; CALIBRATION.md §4.8).

## 6. Verification

All on the final code of this branch (UI fixes `945a4ca`, `629a2fa`, tests `651fc2f`; analysis code unchanged since `257d1ef`).

**Automated checks** (working tree at `651fc2f`):

| Check | Result |
|---|---|
| `npx vitest run --config vitest.config.ts` | 43 committed test files: 346 tests, 343 passed, 3 skipped (opt-in harnesses), 0 failed. With the six uncommitted `*.scratch.test.ts` probes in the working tree: 49 files, 352 tests, 344 passed, 8 skipped. |
| `tsc -b` | no errors |
| `oxlint src` | 0 errors, 5 warnings (pre-existing unused variables) |
| backend `pytest` | 50 passed |

Tests that cover this work include `RoadAnalysis.test.ts` (section following, area demand parts and reachability, select-link counts, capacity check, no route feedback from a jammed run), `StudyDemandSimulation.test.ts` (frozen-demand scenario comparison, development scenario) and `ScenarioPanelPieces.test.ts` (comparison table keeps Existing and Proposal in separate padded cells with the % change on its own line; the Proposal flag is set only while the analysis on show ran on a network edited since the baseline, and clears when the edit is undone or the baseline cleared).

**Section and junction figures**: §4, from `RoadProbe3` (app-equivalent analysis job) on the final code. Runtime in node: VSG 2 km 163 s, Dange Chowk 2 km 178–182 s, 1 km areas 11–24 s.

**Browser run** (headless Chromium, SwiftShader WebGL; Vite dev server and FastAPI backend; script `vp-shots/road-analysis/e2e/setup_scn.js`): Balewadi High Street, 1 km area, 19:00. Analysis of the existing city: 889 veh/h southbound, 214 northbound, the same as the node PM run in §4. Baseline saved, the section widened by one lane per carriageway in Build (4 road pieces), analysis re-run, then Compare: *Road: Better, Area: Better*: traffic on the road 1,103 → 1,418 veh/h (+29%), speed 6 → 9 km/h, worst end-junction delay 157 → 97 s (−38%), vehicles queued 177 → 144, share of demand entering 96% → 94%, trips completed 985 → 1,140, mean trip time 389 → 376 s (−3%, inside the 5% noise band), mean delay 290 → 274 s. After the edit the panel's state reported `showingProposal: true` and the Proposal badge was on screen.

**Screenshots** (`vp-shots/road-analysis/`, working directory, not in the repository):

- `final_proposal_badge.png`: "What's happening" after the Build edit, with the PROPOSAL badge and "Network as edited in Build, not the existing city" above the status.
- `final_comparison_table.png` (crop of `final_comparison_panel.png`): the comparison after the fix; Existing and Proposal values in separate columns (e.g. mean trip time 389 s | 376 s), each % change on its own line under the proposal value.
- `final_panel_advanced_expanded.png`: the whole panel at a 6,000 px viewport with Live traffic, Demand evidence and How the model works expanded, down to the end of the panel; demand shown as its three labelled parts (308 internal, 1,267 area ↔ edge, 7,097 through, PM, proposal network) with the counted-junction table.
- Earlier, still valid: `before_panel_vsg.png` (the ~96 veh/h before state), `after_vsg_selectlink.png`.

**Not verified**: VSG and Dange Chowk were not re-run in the browser on the final code (the node job is the same code path and seed; an earlier browser VSG run on this branch gave 1,493 NE / 230 SW). One seed only. No junction is calibrated (CALIBRATION.md).

## 7. Current figures (overhaul)

Full detail, sources and caveats: docs/OVERHAUL.md.

**Shivaji Bridge, 2 km area, 09:00, 3 seeds (browser, production build, estimated demand 28,500 veh/h, ~98% through traffic):** north-west 816 veh/h (763–890 over the runs) at 22 km/h against 45 km/h free flow, LOS D; south-east 515 veh/h (418–599) at 5 km/h against 37 km/h, LOS F; *severely congested* in all 3 runs. 87% of the south-east delay is stopped time behind a queue traced to Shivaji Bridge / Bajirao Road (conflicting turns), found in all 3 runs. The bridge itself is at 33–63% of its IRC:106 capacity. The earlier report (482 / 201 veh/h, 44 / 29 km/h against a 100 km/h free flow, "Congested") came from the 100 km/h class default and the uniform 1,800 veh/h/lane capacity, and a mid-overhaul run blamed a queue at a fictional junction from the sample objects.

**Screenline check:** the area assignment puts 1,711 veh/h (both directions) on Shivaji Bridge against 7,470 counted in the 2008 peak hour (PMC CMP 2008), **23%**; 1,331 veh/h got through the simulation (18%). The demand is too low on this central crossing; it is reported, not scaled.

**Comparison verdicts** (same demand, hour and seeds): widening Shivaji Bridge by one lane per carriageway → *no clear change*; widening `osm_282054960` on the traced queue from 1 to 2 lanes → *mixed (trade-off)*: the bridge's travel time −34% in every run, but neighbourhood trip time +14% and delay +18% in every run. Both were reported as "Better" before the agreement and verdict fixes.

**Checks on the final tree:** vitest 361 tests (358 passed, 3 skipped, 0 failed); `tsc -b` clean; oxlint 0 errors (5 pre-existing warnings); backend pytest 52 passed. Browser E2E results per check: docs/OVERHAUL.md §10.
