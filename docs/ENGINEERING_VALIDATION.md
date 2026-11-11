# Engineering validation

Mission §6 (simulation reliability: validation framework, observed vs simulated, thresholds explained, no claim of validation without evidence), §19 (testing and acceptance), §20 deliverable 5. Branch `urban-mobility-platform`.

**Verdict first: the traffic model is NOT validated.** On the current integrated code it fails every TAG M3.1 acceptance criterion that could be tested against Pune observations (counts, screen line, journey speeds), by margins far larger than the age of the data can explain. The software is tested (its code does what it is specified to do); the model's numbers are not accurate enough to be used as forecasts of Pune traffic. Numbers the app shows must be read as **estimated**, for comparing options on the same inputs, not as predictions.

Labels used here: **UNIT-TESTED** (vitest, synthetic or database-export fixtures), **HEADLESS-RUN** (the app's own analysis code run under Node on a copy of the project database, not in a browser), **BROWSER-VERIFIED**, **UNTESTED**; and for data: **measured** (an observation), **estimated** (model output), **hypothetical** (model output with an option that is not shipped), **unknown**.

## 1. Scope

This document separates two different questions:

| Question | Evidence | Where |
|---|---|---|
| **Software correctness**: does the code do what it is specified to do (topology rules, ODME maths, emission formulae, scenario isolation, comparison on identical inputs, …)? | Automated tests (unit, property, integration), TypeScript, lint, build, browser checks | §3 (placeholder for the coordinator), module docs |
| **Model accuracy**: do the simulated volumes and speeds match measured Pune traffic? | The §24 validation harness against observations, with stated acceptance criteria | §4–§5 (this part) |

Passing tests says nothing about model accuracy: a correctly implemented model with wrong demand gives wrong volumes reliably. Conversely, the validation failures below are not software bugs unless stated; they are measured gaps between the model and Pune.

The simulation-validation part (§4–§7) reproduces docs/OVERHAUL.md §24 on the integrated head **`c916854`** (topology reconstruction, scenarios and versioning, traffic data, ODME, emissions, feasibility, scenario generator, responsive layout), **with no parameter changed**, and compares it with the historical §24 table.

## 2. Test strategy

- **Unit and property tests (vitest, pytest):** each module's rules on synthetic fixtures with hand-checkable answers, plus property tests over the real network export (topology: docs/TOPOLOGY_RECONSTRUCTION.md §3; ODME: docs/ODME_AND_EMISSIONS.md §2; emissions §6; scenarios: docs/SCENARIOS_AND_VERSIONING.md; feasibility: docs/FEASIBILITY_ENGINE.md). These establish software correctness only.
- **Headless validation against observations (this document §4):** the opt-in harness `frontend/src/engine/testing/NetworkValidation.test.ts` (`VAL24=1`, skipped in the normal suite) drives `SimulationMode` (the code behind the Simulate panel) on a copy of the project database, one run per id, and writes JSON lines; `backend/data/observed_validation/analyze_validation.py` turns them into tables. Observations: `backend/data/observed_validation/pune_network_validation_v1.json` (sources and grades in OVERHAUL §24.1).
- **Calibration vs validation data are kept apart.** Counts used to fit anything (ODME calibration half) are never reported as validation evidence (TAG M3.1 §3.3.8: report fitted and independent data separately).
- **Browser verification:** screens and flows checked in Chromium against the project database (module docs; integrated pass §10).
- **No tuning to pass.** No default was changed to improve any number here; calibration options are listed as PROPOSED (§7).

## 3. Automated test results

Integrated branch head (before final docs commit), run 2026-11-11 by the coordinator on the 2-CPU sandbox:

| Check | Result |
|---|---|
| vitest, all 86 test files, one file at a time | 665 passed, 7 skipped (opt-in harnesses), 0 failed. One file (AccessRestriction) first hit a worker-start timeout under load; re-run alone: 8/8 passed |
| backend pytest (whole suite) | 102 passed, 0 failed |
| TypeScript (`tsc --noEmit -p tsconfig.app.json`) | 0 errors (one error at EditingEngine.ts:331 introduced by the topology work was fixed in 0332083) |
| oxlint `src` | 0 errors, 7 warnings (5 pre-existing) |
| `vite build` | succeeds |
| End-to-end | No Playwright suite in the repo; browser checks are per-module scripts (see §10) |

Opt-in harnesses not in the normal suite: NetworkValidation (VAL24=1, §5), OdmeRealArea, TopologyProperty whole-DB mode, DayInvestigation, JunctionValidation, PerformanceBench, WakadRealism.

## 4. Simulation validation: method and thresholds

**What was run (HEADLESS-RUN, 2026-11-11 12:55–14:10 UTC = 18:25–19:40 IST).**
- Code: worktree `um-val`, detached at **`c916854`**. No parameter, default or test changed. Harness and analysis script are byte-identical to the ones used for OVERHAUL §24 (`git diff e788b7f c916854 -- frontend/src/engine/testing/NetworkValidation.test.ts` is empty; `analyze_validation.py` unchanged).
- Data: backend on port **8211** with a fresh copy of `twincity.db` (the original, last modified 2026-11-05, not written) and the local OSM index for roads and mapped signals (`TWINCITY_OSM_INDEX=/workspace/work/vp-int-e2e/db_osm_index.db`). City objects: the API dump `/workspace/work/um-odme-run/db_dump.json` (18,273 roads; the two demo sample roads are excluded by the harness, `isSampleObject`).
- Runs: the committed run lists in `backend/data/observed_validation/runs/` — 13 count runs, 21 section-speed runs (micro-simulation, seeds 42/7/11), 11 corridor sweeps (assignment, 24 h), 10 area sweeps (assignment, 9 hours). One vitest process per run id, strictly sequential (≈ 20–130 s each).
- Signals: a run whose mapped-signal request failed (the app then **estimates** signals from road classes, as it does in the browser when the signal source fails) was re-run up to twice. Final state: **52 of 55 runs on mapped signals**; still estimated after two retries: `s_sinhagad_03`, `s_sinhagad_19`, `a_wakad` (§8). The historical table had 14 of 182 runs estimated, including `c_rajaram_10`, `s_sinhagad_03`, `s_sinhagad_09`, `d_nagar`, `d_baner`, `d_koregaon`, `a_baner`, `a_wakad`, all of which are on mapped signals here except Sinhagad 03 and Wakad.
- Raw output (not committed, scratch): `/workspace/work/um-val-run/final/*.jsonl`, tables `final/sec24_tables.md`, `final/summary.json`; per-run logs `out/`, `retry/`; diff script `compare.py`.
- Reproduce: OVERHAUL §24.10 with `VAL24_API=http://127.0.0.1:8211`.

**Observations** (measured; sources, dates, URLs and grades A/B/C in OVERHAUL §24.1 and `pune_network_validation_v1.json`): PMC CMP 2008 classified counts at 9 river crossings and 3 rail crossings (2008); Nagar Road at Gunjan Chowk, Thakur et al. 2017 (IJETT 47(2)); CMP 2008 Table 4.10 test-car journey speeds (8 corridors, 2008); TraffiCure "Best time to leave – Pune" probe speeds by hour (5 corridors + citywide, data updated 2026-08-19); TomTom Traffic Index 2025.

**Acceptance criteria used: UK DfT TAG unit M3.1, *Highway Assignment Modelling*, May 2026** (https://assets.publishing.service.gov.uk/media/6a033d074fb0713aa63ea802/tag-m3-1-highway-assignment-modelling.pdf; criteria as recorded in RESEARCH_AND_TECHNICAL_DECISIONS.md A5):
- **Link flows (Table 2):** GEH < 5, or the flow criterion (within 100 veh/h below 700 veh/h; within 15% from 700 to 2,700; within 400 veh/h above 2,700), at **> 85% of sites**. TAG §3.3.10: meeting either criterion is satisfactory. GEH = √(2 (M − C)² / (M + C)).
- **Screen lines (Table 1):** modelled total within **5%** of the counted total for all or nearly all (95%) screen lines.
- **Journey times (Table 3):** within **15%** on **> 85% of routes**. Applied here to section speeds, corridor-hour speeds and city speed by hour (speed ±15% is the same test as time ±15% only approximately: 15% slower speed = 17.6% longer time; the speed form is what OVERHAUL §24 used and is kept for comparability).
- TAG §3.2.2: meeting the criteria does not by itself make a model fit for purpose, and failing them does not by itself make it unfit; here the failures are large and systematic (§5.6), so they are treated as disqualifying for forecasting use.

**Why FHWA Traffic Analysis Toolbox Vol. III is not used for the verdict.**
- The **2004** Vol. III targets (link flows within 15% for 700–2,700 veh/h, GEH < 5 at > 85% of cases, sum of flows within 5%, journey times within 15%; https://ops.fhwa.dot.gov/trafficanalysistools/tat_vol3/sect5.htm) are the same family as TAG's; applying them would give the same verdicts, so they add nothing.
- The **2019 update** (FHWA-HOP-18-036, April 2019, Chapter 5, https://ops.fhwa.dot.gov/publications/fhwahop18036/chapter5.htm, opened 2026-11-11) replaced them with four criteria built on **day-to-day variation of the observations**: pick a representative day per travel condition from many observed days (cluster analysis), build variation envelopes from the standard deviation σ(t) of each 15-minute interval across the days in the cluster, and test the simulation against those envelopes (Criterion I: 95% within c_r(t) ± 1.96σ(t); II: two-thirds and both critical intervals within ±1σ; III: bounded dynamic absolute error ≤ the mean deviation of the other observed days from the representative day; IV: systematic error ≤ ⅓ of that). The update also advises against calibrating to a synthetic average day.
- Our observations cannot support this: each count site has **one** survey (2008 or 2017) for **one** hour, so there is no σ(t), no cluster of days, no representative day and no BDAE threshold; TraffiCure and TomTom publish **averages** by hour (the synthetic average day the update advises against), not daily series; and the observations are hourly, not 15-minute. The 2019 criteria are therefore **not applicable**, not passed or failed. Using them would need multi-day 15-minute counts (FHWA's worked example uses 12 observed AM peak periods for one travel condition) and speeds at bottlenecks in the study area.

**Status column:** PASS / FAIL against the TAG criterion for the whole set (> 85% of sites or routes), with the per-row result shown. "Calibration status" is **uncalibrated** throughout: no parameter was fitted to these observations.

## 5. Simulation validation: results on `c916854`

### 5.0 Summary against the historical §24 table

| Test (TAG M3.1 criterion) | Required | §24 table (runs at `6be175b`, documented in `e788b7f`) | **Now (`c916854`)** | Status | Changed? |
|---|---|---|---|---|---|
| Counts, GEH < 5 (assigned volume) | > 85% of sites | 0 / 15 | **0 / 15** (mean GEH 32.3) | **FAIL** | no |
| Counts, flow criterion | > 85% of sites | 0 / 15 | **0 / 15** | **FAIL** | no |
| Counts, total bias | — | −30% (82,267 vs 117,359) | **−30%** (82,256 vs 117,359) | — | −11 veh/h (Sambhaji) |
| Counts, simulated throughput GEH < 5 | (reference) | 0 / 14, mean GEH 68.9 | 0 / 14, mean GEH 67.8 | FAIL | small, sim only |
| River screen line (9 crossings) | within 5% | 54,504 vs 78,357 (−30%) | **54,493 vs 78,357 (−30.5%)** | **FAIL** | −11 veh/h |
| Section speeds within 15% (micro-sim) | > 85% of 21 | 7 / 21, MAPE 32%, bias −15% | **4 / 21**, MAPE 38%, bias −18% | **FAIL** | yes (§5.7) |
| Corridor-hour speeds within 15% (assignment, 5 TraffiCure corridors × 24 h) | > 85% of 120 | 23 / 120, MAPE 58%, bias +45% | **27 / 120**, MAPE 54%, bias +40% | **FAIL** | yes: Baner now on mapped signals |
| City speed by hour within 15% (mean of 10 areas vs TraffiCure citywide) | > 85% of 9 | 1 / 9, MAPE 35%, bias +35% | **2 / 9** (03:00, 09:00), MAPE 32%, bias +32% | **FAIL** | yes: 03:00 ratio 1.15 → 1.14 (Baner area on mapped signals) |

**The model does NOT meet any acceptance criterion, on the current code as before.** No verdict changed. The changes in the speed rows are explained in §5.7; none comes from the integrated work since `e788b7f`.

### 5.1 Traffic counts (veh/h, both directions, at the counted hour)

GEH and the flow criterion are on the **assigned** volume (the user-equilibrium assignment of the study area, which is what TAG compares); "got through" is what the micro-simulation actually passed in the same hour (mean of 3 seeds). Each site is run in its own 2 km study area at its own hour. Difference = model − observed; error % = difference / observed.


**All 15 sites (assigned):** GEH < 5 at 0/15 (0%), GEH < 10 at 2/15, flow criterion 0/15, mean GEH 32.3, MAPE 36%, bias −30%, median model/count 0.69, %RMSE 39%; total 82,256 vs 117,359 veh/h. **FAIL.**
**Got through (simulated, 14 sites):** GEH < 5 at 0/14, mean GEH 67.8, bias −63%, median 0.40. Most counted sections are LOS F in the simulation (55–98% of routed demand served).

By group (assigned): grade B 12 sites, bias −38%; grade C (grouped / inferred mapping) 3 sites, −15%; morning 09–11 h −29%, evening 18–19 h −32%; river bridges −30%; rail crossings −5%; Gunjan Chowk 2017 −41%. Every OSM class is biased low (trunk −29% … tertiary −48%). Identical to the §24 table to the rounding shown.

### 5.2 Screen line

| Screen line | Crossings | Observed veh/h | Model veh/h | Difference | Error % | Threshold | Status |
|---|---|---|---|---|---|---|---|
| River (CMP 2008 screen line 2), each crossing at its own counted hour, from its own 2 km area | 9 (Z-Bridge contributes 0: not routable) | 78,357 | 54,493 | −23,864 | −30.5% | ±5% | **FAIL** |
| Rail (CMP 2008 screen line 1) | 3 of 10 sites mapped | — | — | — | — | — | not evaluated: incomplete screen line (7 sites could not be tied to an OSM way) |

### 5.3 Section speeds (micro-simulation, 21 corridor-hours)

Observed: TraffiCure 2026 probe speed (one direction, hour of day) and CMP 2008 test-car peak speed (both directions). Model: simulated speed on the analysis section round the seed road, matching direction (CMP rows: mean of directions). Error % = model/observed − 1.


**All 21:** within 15% at **4/21 (19%)**, MAPE 38%, mean bias −18%, median model/observed 0.73. **FAIL** (> 85% required). By hour: 03:00 2/5, 09:00 1/11, 19:00 1/5. CMP 2008 corridors 1/8 (bias −37%); TraffiCure 3/13 (bias −6%). Sinhagad Road 03:00 and 19:00 ran with **estimated** signals (§4).

### 5.4 Corridor-hour speeds (assignment, 5 TraffiCure corridors × 24 h)


**27 / 120 within 15% (23%). FAIL.** Night (00–05 h) is close (bias −3%); by day the assignment is far too fast (midday +71%, evening +84%), as in §24.4b.

### 5.5 City speed by hour (10 study areas, assignment, vehicle-km weighted, vs TraffiCure citywide)


**2 / 9 hours within 15% (03:00 ratio 1.14, 09:00 ratio 1.03). FAIL.** Wakad ran with estimated signals (§4).

### 5.6 Why it fails (unchanged from OVERHAUL §24.3b and §24.5; confirmed by the plan contents of these runs)

- **Area demand is 100% edge-to-edge in central Pune.** In the 7 central areas (and every counted-site area) the demand plan has no internal or land-use trips: all of it is cordon-to-cordon through traffic placed at a fixed flow per lane by road class wherever the selected area's boundary cuts a road. Land use exists only in west Pune (Baner, Wakad, Hinjawadi). The volume shown on a bridge is therefore a property of the selected study area, not of the bridge (×1.2–4.0 for the same bridge, OVERHAUL §24.3b).
- **Morning = evening.** Without land use, the 09:00 and 19:00 plans are identical (e.g. central 29,200 = 29,200 veh/h, same speed to 0.01 km/h); observed evenings are 8–22% slower.
- **Two speed errors in opposite directions:** the assignment is too fast by day (the network is not loaded enough by this demand), while micro-simulated sections where cordon flows converge jam (LOS F) and are too slow.
- These are structural (demand composition), not parameter values; this is why no single parameter was tuned (§7).

### 5.7 What changed since the §24 table, and why (by commit)

The §24 runs were made on `6be175b` (= `1941fc5` + harness hooks, 2026-11-09), which already contained the **heading fix `71d55d0`**, but **not** `e8a1ec8` (signal boxes vs editing; arms within 35° grouped in box phases), `27dab4b` (a mapped signal box recorded once, as one plan), `a6e30e7` (**slip class**: `trunk_link`/`secondary_link` take their parent's class instead of `local`; 45 + 55 roads), `6a6f128` (exact-point node wins in the builder; unedited whole-database network stated identical) or `c59b6a0` (carriageway/section ranking by implied class). All of these are ancestors of `e788b7f`.

**Attribution test (HEADLESS-RUN).** Four runs were repeated on a clean export of `e788b7f` (`git archive`, same harness, same backend and dump): `c_tilak_10`, `c_sambhaji_11`, `s_baner_19`, `s_deccancollege_09`. In all four, the assigned volumes, simulated volumes and every direction's speed are **identical between `e788b7f` and `c916854`**, and all four differ from `6be175b` the same way (e.g. Baner Road 19:00 westbound 29.1 → 5.8 km/h; Tilak Bridge got-through 980 → 1,056; Sambhaji assigned 4,056 → 4,045). So:

| Change | Cause | Evidence |
|---|---|---|
| Simulated volumes and section speeds moved at most sites (section speeds 7/21 → 4/21) | Code between `6be175b` and `e788b7f`, chiefly the signal-box changes `e8a1ec8` / `27dab4b` (phases and plans of mapped boxes act only in the micro-simulation and in signal delay) | 4/4 sampled runs identical at `e788b7f` and `c916854`; assigned volumes unchanged at 12 of 13 count runs while simulated values moved (which signal changes do and demand changes would not). Which of the pre-`e788b7f` commits moves each row was not bisected further (inference from what each commit touches). |
| Sambhaji Bridge assigned 4,056 → 4,045 (−11 veh/h), screen line −11 | Slip-road class `a6e30e7` (inferred) | Present at `e788b7f` already; the area road-class table shows highway km 60 → 63, arterial 306 → 308, local 2,661 → 2,657, consistent with slip roads moving out of `local` |
| Corridor-hour 23 → 27/120, city 1/9 → 2/9, Nagar/Koregaon/Baner assignment speeds | **Signal state**, not code: `d_baner`, `d_nagar`, `d_koregaon`, `a_baner` had estimated signals in the §24 runs and mapped signals now | Every assignment-level speed difference between the two runs is in exactly these runs (other sweeps identical to the 0.01 km/h, apart from Wakad / Hinjawadi ±0.04 km/h) |
| Raja Ram Bridge got-through 2,568 → 2,992 veh/h (assigned unchanged 7,093) | Signal state: estimated in the §24 run, mapped now (plus the pre-`e788b7f` signal code) | `c_rajaram_10` signals error → ready (second attempt) |
| Sinhagad Road 09:00 and 19:00 section speeds swapped (29.3 ↔ 20.1 km/h etc.) | Signal state flipped: 09:00 was estimated then and mapped now; 19:00 the reverse | The estimated-signal run reproduces the old estimated-signal value exactly (6.3 / 29.3 km/h) — signal state alone moves this section ±50% |
| **Topology reconstruction (`2c261e7`, `9a26bae`)**: builder joins OSM way points to drawn or edited roads only where they lie on them (≤ 0.5 m instead of 6.6 m) | **No effect measured** on these runs | The project network used here has no drawn roads (the two demo samples are excluded) and unedited OSM ways still join at shared nodes; 4/4 sampled runs identical across the integrated commits. The coordinator's note that the builder change affects 20 roads in the database was not re-derived here; if those roads lie in any study area, their effect is below what changed any number above. |
| Scenarios, traffic data, ODME, emissions, feasibility, generator, responsive | No effect on the default model | ODME is opt-in (§6); emissions only read simulator state (same simulated values with and without it, by the 4/4 identity); the others do not touch the analysis path. |

## 6. ODME (demand estimation from counts): calibration vs held-out validation

Source: docs/ODME_AND_EMISSIONS.md §3–§4 (**HEADLESS-RUN**, 2026-11-11, μ = 0, Spiess 1990 as published; run list `backend/data/observed_validation/runs/runs_odme.json`; raw output `/workspace/work/um-odme-run/odme_real_mu0.json`, not committed). Not re-run here: ODME is opt-in and changes nothing in the default model, so the default-model validation above is unaffected by it. Split rule fixed before running: within each area, sites in id order, alternately calibration / validation.

| Half | Sites | GEH < 5 before → after | Mean GEH before → after | Counts as evidence? |
|---|---|---|---|---|
| Calibration (fitted) | Sancheti ROB, Shinde, Sambhaji, Tilak | 0/4 → 4/4 | 24.6 → 2.8 | **No.** These counts were fitted; a good fit is expected and proves nothing (TAG M3.1 §3.3.8). |
| **Validation (held out)** | Sangam, Shivaji, S. M. Joshi | 0/3 → **0/3** | 63.7 → 48.8 (S. M. Joshi got worse, 46.2 → 52.3) | Yes, but 3 sites is far too few to say anything reliable. |

- Held-out total 11,499 → 15,689 veh/h against 27,784 counted.
- **TAG M3.1 Table 5 (matrix change limits) breached in both areas** (PM: cell slope 1.10, cell R² 0.82, trip-end slope 1.35 / R² 0.87, sector change up to 75%; AM: cell R² 0.59, trip-end R² 0.85, sector 33%). The counts pull the edge-to-edge prior a long way, which is the structural problem of §5.6, not something ODME can fix.
- One of the two ODME areas (AM, Sambhaji) ran with **estimated** signals.
- **Conclusion:** the ODME estimate is a diagnostic, not "the" demand; the fitted counts are **not** validation evidence; the held-out result (0/3) does not show the estimate generalises. The model remains **NOT VALIDATED**.

## 7. Calibration candidates — PROPOSED, NOT APPLIED

Evidence-based options from docs/RESEARCH_AND_TECHNICAL_DECISIONS.md (A1, A2, A4) and OVERHAUL §24.6–24.7. None was applied; no default changed. The project owner decides on each.

| # | Candidate | Evidence | What it would address | Status / risk |
|---|---|---|---|---|
| 1 | **Where area demand comes from: land use for all of PMC, and cordon (edge) flows cut from one fixed city-wide assignment** (sub-area / windowing) instead of class-based per-lane flows at the cordon of whatever area is selected | §5.6: 100% of central-Pune area demand is edge-to-edge through traffic; the same bridge's volume changes ×1.2–4.0 with the study area alone (OVERHAUL §24.3b); AM = PM. RESEARCH A1: land use + gravity distribution is the structurally plausible prior; CMP 2018 mean motorised trip length 4.7–8.5 km vs a 2 km area. Data: Census 2011 ward population projected; CMP 2018 zone employment. | Area dependence, AM/PM identity, the −30% count bias, evening vs morning difference (partly) | **PROPOSED.** Not prototyped (city-wide run, ~18k roads). Largest expected effect; largest data and run-time effort. |
| 2 | **ODME with more counts**, as the correction step after #1 (RESEARCH A2: Spiess 1990, already implemented and opt-in) | §6: with 4 calibration counts the fit is local; 0/3 held-out. TAG M3.1 asks screen lines of ≥ 5 links and independent validation counts. Needs recent (2023+) classified counts at many more sites, split into calibration and validation **before** fitting. | Residual demand error once the demand structure is right | **PROPOSED.** Must keep validation counts held out (the code enforces it); must respect Table 5 change limits. Running it on the current edge-to-edge prior breaches Table 5 (§6). |
| 3 | **PCU factor sets by context** (mid-block IRC:106-1990 vs stop-line dynamic PCU, Patel & Dhamaniya 2021 TRR 2675(11), doi:10.1177/03611981211018694) (RESEARCH A4) | Mid-block vs stop-line PCU for two-wheelers differ ×2–3; the prototype (all links) moved GEH < 5 from 0 to 1 of 15 but made daytime corridor speeds faster still (OVERHAUL §24.6). Indo-HCM 2017 stop-line tables not yet read first-hand. | Signal capacity in mixed traffic | **PROPOSED.** Needs per-link (stop-line vs mid-block) PCU in the assignment; wait for #1. |
| — | 50 km/h cap on tagged maxspeed; reference hour; Z-Bridge access / Sambhaji two-wheeler ban corrections | OVERHAUL §24.7 #2, #6, #7 | Small effects (speed cap: corridor MAPE 58% → 54% in the prototype) | PROPOSED in §24.7; unchanged. |
| ✗ | Global demand scale (×1.43) or raising edge flow per lane (×1.8) | OVERHAUL §24.7 #3, #5 | — | **Rejected:** circular (fitted to the same counts) or breaks speeds (area speed 10 km/h). Listed so nobody applies them. |

## 8. Known failures

**Model accuracy (validation):**
- Counts: GEH < 5 at 0 of 15 sites; flow criterion 0 of 15; screen line −30%. FAIL (§5.1–5.2).
- Section speeds within 15%: see §5.3 table. FAIL.
- Corridor assignment speeds by hour and city speed by hour: FAIL, with daytime speeds too high in the assignment and too low in saturated micro-simulated sections (§5.4–5.5).
- Morning and evening give the same demand in every area without land use (§5.6). Observed evenings are slower.
- Z-Bridge cannot carry traffic (`motor_vehicle=no` in OSM) against 3,928 veh/h counted in 2008; Sambhaji Bridge's two-wheeler ban is not modelled.

**Harness / environment:**
- **Signal loading is intermittent in headless runs.** The local OSM index request occasionally fails under load; the app then falls back to Overpass (unreachable from the sandbox, `/api/interpreter` 404) and **estimates** signals from road classes. Each such run was retried up to twice; runs still on estimated signals are listed in §5.0. In the app this fallback is visible to the user as "signals estimated".
- Z-Bridge is not routable, so it is "not run" in the counts table.

## 9. Responsive layout

BROWSER-VERIFIED by measuring bounding boxes in Chromium at each viewport, 10 UI states each, before (9c5876c) and after (10e1f0f).

| viewport | overlaps | off-screen | unreachable controls | Cesium buttons covered | targets <44 px |
|---|---|---|---|---|---|
| 1920×1080 | 2→0 | 0→0 | 2→0 | 3→0 | 315→315 |
| 1366×768 | 12→0 | 0→0 | 5→0 | 3→0 | 315→316 |
| 1024×768 | 16→0 | 0→0 | 9→0 | 3→0 | 315→298 |
| 834×1112 | 19→0 | 0→0 | 15→0 | 7→0 | 315→3 |
| 768×1024 | 33→0 | 0→0 | 28→0 | 24→0 | 315→3 |
| 390×844 | 49→0 | 22→0 | 207→0 | 46→0 | 310→3 |
Below 920 px: bottom-sheet panels, icon Mode bar 44 px, Layers hides sheet. Open: 3 checkboxes (One-way, Central divider, Footpath) 14 px in PropertiesPanel; live HUD hidden <760 px (pre-existing); not measured: tool pop-ups, open Layers, dialogs, landscape, real touch. Harness /workspace/work/um-ui-e2e/, screenshots vp-overhaul-shots/um-ui-*.png. Desktop targets <44 px are not a desktop requirement.

## 10. Browser verification

One integrated regression pass on head **`58e41ec`** (all modules combined) in Chromium (headless, SwiftShader), 2026-11-11. Each module had been browser-verified alone on partial heads (module docs); this pass checks they still work together in one session. Built app (`vite build`, `VITE_API_BASE=http://127.0.0.1:8310`) on :4510, backend on :8310 against a **copy** of the project DB with `TWINCITY_OSM_INDEX` (mapped signals) and the feasibility layers DB built earlier by `python -m feasibility.build_layers`. External tile/Ion requests proxied; Google Fonts blocked. All traffic counts used are **SYNTHETIC**. Harness: `/workspace/work/um-smoke-run/e2e/smoke.py` (reuses the topology `lib.js`/`topo.js`, layout `layout2.js`, and the data/generator/feasibility/planning flows of the module harnesses); results `results_main.json` (+ `results_rerun8.json`); screenshots `vp-overhaul-shots/um-smoke-*.png`. Steps ran in the order 1, 2, 5, 6, 8, 3, 4, 7, 9, 10 in one page (one reload inside 3/4).

**Result: 10 / 10 pass. Console errors: 2 in total, both `Failed to load resource: net::ERR_FAILED` from the blocked font requests; no page errors.** No code was changed.

| # | Check | Result | Label | Evidence |
|---|---|---|---|---|
| 1 | App loads | pass | BROWSER-VERIFIED | 20,732 base objects loaded; only console errors are the 2 blocked external requests. `um-smoke-01-loaded.png` |
| 2 | Area analysis at 09:00 (COEP seed `osm_218681353` Veer Santaji Ghorpade Road, 1.5 km) | pass | BROWSER-VERIFIED; values are model output (estimated) | Status ready in 83 s, result "severe", headline shown. `um-smoke-02-analysis-0900.png` |
| 3 | New proposal; road drawn across an at-grade road → junction; undo/redo exact; baseline unchanged after reload | pass | BROWSER-VERIFIED | Proposal `scn_tlh5wcfl`; 81 m road `dx3izog47` across Residential Road `osm_1010245033` (ground level). One shared node `node_73.85387_18.52541_0.0`, crossed road gained a vertex, shortest route passes through the junction. Undo / redo / undo: 0 objects differ from the before / edited / before states (keys sorted, `updatedAt` excluded); network key and deleted-OSM list restored. After reload: base view SHA-256 identical (20,732 objects), backend base rows identical, drawn road still in the proposal. Observation: the edit also changed `osm_238836092` (coordinates, sections; proposal copy), most likely an end snapped onto it (inferred, not inspected). `um-smoke-03a-junction.png` (camera did not frame the junction; the evidence is the recorded data) |
| 4 | Save version, restore | pass | BROWSER-VERIFIED | v1 "with road" → road undone → v2 "road removed" → restore v1 → v3 "Restored version 1" with the road back; backend v3 carries `restoredFromVersionId`. `um-smoke-04-versions-restored.png` |
| 5 | Import SYNTHETIC CSV as validation, re-run → observed vs simulated | pass | BROWSER-VERIFIED (SYNTHETIC counts) | 2-row CSV imported (role `validation`); after re-run the table lists `osm_218681353` fwd 09:00–10:00: observed 1,169, routed 4,035 (GEH 56.2), simulated 1,168 (GEH 0.0); the bwd row is reported "not compared". The near-equal simulated figure is a coincidence of the synthetic numbers: the run is seeded and its outputs (e.g. fuel 2,952.03 L/h) were identical before and after the import, so the counts did not feed the simulation. Harness omission: the "Synthetic test / demo data" box was not ticked, so the dataset is stored `synthetic=false` although its name and provider say SYNTHETIC. `um-smoke-05a-dataset-imported.png`, `um-smoke-05b-observed-vs-simulated.png` |
| 6 | Emissions card in run details | pass | BROWSER-VERIFIED; values estimated | Card shows fuel 2,952.0 L/h, CO₂ 6,932.9 kg/h, NOx, PM, idling share, per-class rows, marked ESTIMATED (SUMO HBEFA4 classes, stand-ins for 2W/auto). `um-smoke-06-emissions-card.png` |
| 7 | Feasibility on the drawn road → PDF | pass | BROWSER-VERIFIED; findings are screening (estimated / verified-from-available-data per finding) | Assess site on `dx3izog47`: 13 findings (e.g. 2 mapped buildings intersect the 10 m footprint). PDF downloaded, 13 pages, 64,994 B, text extractable. `um-smoke-07a-feasibility.png`, `um-smoke-07b-feasibility-pdf-01.png` |
| 8 | Generator: candidates, evaluate ≥ 2, Pareto table with fuel | pass | BROWSER-VERIFIED; values model output (estimated) | 6 candidates for the COEP area; 2 kept (both signal retimings) to bound run time; created and evaluated in 202 s, both ok (verdict "mixed"). Table: baseline + 2 rows, Pareto column rendered (baseline in the Pareto set, both retimings dominated), fuel 2,952 / 2,957 / 2,856 L/h and CO₂ populated. Base view unchanged after create and evaluate. Steps 1, 2, 8 re-run once only to retake the table screenshot (first capture was blank: panel clipped): same candidates, evaluated in 207 s, identical fuel values. Fuel is not a default Pareto objective (its checkbox is off), and the table scrolls horizontally, so the fuel column is outside the screenshot; values are from the DOM (`results_main.json`, `results_rerun8.json`). `um-smoke-08-pareto-table.png` |
| 9 | Planning project: create, attach scenario + dataset, export PDF | pass | BROWSER-VERIFIED | Project "SYNTHETIC smoke project COEP" with links SCENARIO "SMOKE proposal: new road crossing" and TRAFFIC DATASET "SYNTHETIC smoke counts COEP [measured]"; report PDF 39,449 B naming both. `um-smoke-09a-planning-panel.png`, `um-smoke-09b-planning-pdf-1.png` |
| 10 | 390×844 and 768×1024: Build and Simulate panels | pass | BROWSER-VERIFIED (layout geometry; no real touch device) | Bounding-box measurement (§9 method) in 4 states: 0 overlaps, 0 off-screen, 0 unreachable controls, 0 Cesium buttons covered, no horizontal page overflow; 3 ellipsis-truncated texts per state (version labels). `um-smoke-10-{390x844,768x1024}-{build,simulate}.png` |

Not covered by this pass: Through-the-day runs, ODME estimation run, DOCX export, evidence upload/review, flyover/tunnel topology cases, real touch input. These remain as verified in the module docs on their partial heads.

## 11. Limitations

- **Age of the counts.** Bridge counts are from the PMC CMP 2008 survey and Gunjan Chowk from 2017; the network is 2026. TAG M3.1 assumes counts from the model year, so count failures are indicative, not precise errors. They still point one way: growth since 2008 would make today's flows higher, and the model is mostly below the 2008 counts. Crossings built since 2008 split traffic differently; grade-C sites group today's crossings into 2008 sites by inference.
- **Probe speed vs section speed.** TraffiCure (2026) and TomTom (2025) report probe travel speed over whole routes including junction delay; CMP 2008 used a test car over 2–6 km. The model's simulated speed is on a 0.27–2.2 km analysis section; the assignment speed is the mean of two directions while TraffiCure gives one. A 15% band is tight for that mismatch; it is applied as TAG states it, not widened.
- **Mapping inference.** TraffiCure corridors are mapped from end-point names only (grade C); CMP corridors by road name to one section; count sites to OSM ways by name and position.
- **Each count site is judged from its own 2 km study area at its own hour**, so the screen-line total sums different areas — itself a symptom of the demand structure (§5.6).
- **Simulated values** are means over seeds 42/7/11; assignment values are deterministic. Seed spread is shown per row in the raw output.
- **Headless only.** None of these numbers was read off the page; the harness drives the same `SimulationMode` code the Simulate panel uses.
- **Not done:** queue lengths, junction delays and network throughput (no Pune observations of these were found); class-mix and turning comparisons at Gunjan Chowk; weekend hours; a city-wide run.
