# Demand estimation from counts (ODME) and fuel & emissions

Mission §5 (counts as calibration evidence, not demand), §6 (evidence-based calibration, validation), §13 (fuel from speed,
acceleration and idling; same frozen demand in comparisons). Branch `urban-mobility-platform`, 2026-11-11.
Labels: **UNIT-TESTED** (vitest), **HEADLESS-RUN** (app code run headlessly on a copy of the project DB, not in a browser),
**BROWSER-VERIFIED**, **UNTESTED**. Every number this module produces is **estimated**.

## 1. ODME — what it does

`engine/demand/odme.ts` (estimator), `engine/demand/odmeAssignment.ts` (the app's assignment as the inner problem).

- **Method:** Spiess (1990), *A gradient approach for the O-D matrix adjustment problem*, CRT Publication 693, Université de
  Montréal, http://www.spiess.ch/emme2/demadj/demadj.html (choice and alternatives: RESEARCH_AND_TECHNICAL_DECISIONS.md A2).
  Bi-level: minimise ½ Σ_c w_c (m_c − ĉ_c)² where m_c is the volume the **existing Frank-Wolfe user-equilibrium assignment**
  (`staticAssignment.ts`) puts on count c. Each iteration: gradient from the assignment's stored path proportions
  (∂Z/∂g_i = Σ_k p_ik Σ_{a∈k} r_a), multiplicative update g_i ← g_i (1 − λ ∂Z/∂g_i), exact step length of the linearised
  problem, λ ∂Z/∂g_i < 1 (positivity), then a full re-assignment (new equilibrium, new proportions).
- **Not a multiplier:** each OD cell gets its own factor from the gradient; a cell absent from the prior stays absent
  (no OD pair is invented). There is no global scale.
- **Additions (all reported in the run's provenance):** cell factor bounds, default 0.25–4 (the bounds the app's IPF seeding
  already uses, `calibration/ipf.ts`; an app choice, not a standard); optional regularisation toward the prior
  (engine option only), + ½ μ Σ (g − ĝ)²/ĝ (GLS-style, Cascetta 1984), default μ = 0 = Spiess as published (the UI runs
  μ = 0: at real volumes small μ has no effect, §4); a step that
  raises Z after re-assignment is halved (max 4 times) and, if it still does, discarded (the iteration is reported with
  `accepted: false`, the previous matrix is kept).
- **Count → model:** a road-direction count is compared with the busiest link of that road in that direction (as
  `countValidation.ts` does); `both` = fwd + bwd. Turning counts are not yet matched to assignment movements (skipped, reason
  shown). Units: veh/h at the modelled hour (PCU/h only if the user asks for it in `countsToConstraints`).
- **Held-out counts:** only Traffic Data datasets with role **Calibration** become constraints (`data/odmeConstraints.ts`).
  **Validation** datasets are returned as `heldOutDatasetIds`; `estimateOd` throws `HeldOutCountError` if a count from one is
  passed. Validation counts are only evaluated before/after on the assignment (TAG M3.1 §3.3.8: report fitted and
  independent counts separately).
- **TAG M3.1 Table 5 change statistics** (`matrixChangeStats`, limits from DfT TAG M3.1 May 2026 Table 5 as recorded in A2):
  cell values slope 0.98–1.02 and R² > 0.95; trip ends slope 0.99–1.01 and R² > 0.98; trip-length mean and SD within 5%
  (lengths held at the prior assignment's path lengths, so only the matrix change moves them); sector-to-sector within 5%.
  Intercepts are reported with no pass/fail (TAG says "near zero" without a number). Sectors = compass quadrant (N/E/S/W) of
  each OD end around the study area's centre (app definition; TAG leaves sectors to the modeller). A breach is shown in red
  and recorded as `changeWithinTag: false`; it is never hidden or used to stop the run.
- **Output = a new demand version.** `odmeDemandVersion` returns a new `DemandPlan` (each trip × its cell's factor) with
  `provenance.odme`: prior content key and label, hour and hour factor, calibration dataset ids, constraint ids, held-out
  dataset ids, iterations and routings run, convergence and stop reason, options, cell count and bounded cells, Table 5
  statistics, fit per count, demand before/after, timestamp. The prior plan object is not modified (tested).
- **Opt-in per run:** Simulate → Details → *Checks against traffic counts* → **Estimate demand from calibration counts**.
  It shows iterations, the Table 5 table, GEH before → after on the calibration counts ("fitted: not independent evidence")
  and on the validation counts ("held out, never fitted"), and a tick box **Run the analysis on this estimated demand**.
  `SimulationMode.studyPlan` returns the estimated version only while ticked **and** while its prior key and hour match the
  current prior; otherwise it silently falls back and the card says why. Saving a baseline freezes whichever plan is in use
  (scenarios then run on that frozen version); `frozenAssumptions()` records `demandEstimatedFromCounts` (prior key, datasets,
  iterations, hour, demand key). Toggling invalidates an open comparison.

**Limitations (stated in the UI).** ODME is under-determined (Spiess 1990): with few counts many matrices fit equally; the
estimate stays near the prior and can still be wrong. It cannot fix network errors or the edge-to-edge structure of area
demand (OVERHAUL §24.3b): the cordon flows of a 2–3 km area are re-weighted, nothing more. Static, one hour; no peak
spreading. Runs on the main thread (each iteration is ≥ 1 area assignment; a 3 km central area takes seconds per routing).

## 2. ODME tests — **UNIT-TESTED** (`engine/testing/Odme.test.ts`, 9 tests, all SYNTHETIC)

4 × 4 grid (400 m, one lane each way), 8 zones, 56-cell known true matrix, prior = truth × (1 ± 35%) fixed pattern, counts =
true-assignment link volumes as Traffic Data rows.
- counts on half the roads: mean GEH on the calibration counts 1.62 → 0.53; matrix RMSE against the truth lower than the
  prior's; objective non-increasing; every iteration reported;
- zero prior cells stay zero; with bounds [0.9, 1.1] every factor stays inside;
- validation rows: held out by `countsToConstraints`; multiplying every validation count by 5 leaves the estimate
  bit-identical; passing them to the estimator throws;
- new demand version: prior plan unchanged (JSON-equal), `priorKey` = content key of the prior, datasets, iterations,
  Table 5 entries, new content key;
- μ = 50 moves the cells less than μ = 0;
- Table 5 on a hand-checkable 4-cell fixture: unchanged matrix passes; uniform +10% fails slope and sector but not R² or
  trip length; doubling the longest cell moves the mean trip length +9.52% (3.0 → 3.2857 km, by hand); regression helper
  against a hand computation.

## 3. Real-area run — **HEADLESS-RUN**, see §4 results

Harness `engine/testing/OdmeRealArea.test.ts` (opt-in, `ODME_REAL=1`; same set-up as the §24 harness: app `SimulationMode`
on a copy of `twincity.db` dumped through the API, backend on port 8305 with the local OSM index for roads and mapped signals).
Observations: OVERHAUL §24.1 CMP 2008 screen-line counts (both directions, veh/h, each site's own peak hour), grades B/C.
Split rule, fixed before running: within each area, the sites listed in id order, alternately calibration / validation.
Two areas, because ODME is for one hour: **PM 18:00**, 3 km round Shivaji Bridge (evening sites, 18–19 h); **AM 11:00**, 3 km
round Sambhaji Bridge (morning sites, 10–11 h). Counts at the adjacent hour (19 h, 10 h) are used as the modelled hour — an
assumption, stated. Z-Bridge is excluded (not routable, `motor_vehicle=no`, §24.3).

## 4. Real-area results (μ = 0, Spiess as published) — **HEADLESS-RUN**, 2026-11-11, commit of this doc's branch

Run list: `backend/data/observed_validation/runs/runs_odme.json`. Raw output (not committed):
`/workspace/work/um-odme-run/odme_real_mu0.json`. Assignment-level volumes (routed demand), not simulated throughput.

| Area / hour | Demand (veh/h at the hour) prior → estimated | Iterations (routings) | Stop | Cells at a bound | Signals |
|---|---|---|---|---|---|
| 3 km round Shivaji Bridge, 18:00 | 45,598 → 56,500 (+24%), 100% edge-to-edge through traffic, 3,378 OD cells | 7 accepted (13) | 8th step raised Z after re-assignment, discarded | 18 (factor range 0.83–4.0) | mapped |
| 3 km round Sambhaji Bridge, 11:00 | 31,362 → 31,309 (−0.2%), 100% through, 2,237 cells | 9 accepted (16) | 10th step discarded | 55 (0.49–4.0) | **estimated** (the signal request failed in this run) |

Sites not in the 3 km areas (no link of their ways): Mhatre and Yerwada + Ambedkar (PM), Raja Ram and Wadia ROB (AM).

| Half | Site (count hour) | Observed | Before | After | GEH before → after |
|---|---|---|---|---|---|
| calibration | ROB near Sancheti Hospital (19 h, grade C) | 6,600 | 5,085 | 6,797 | 19.8 → 2.4 |
| calibration | Shinde Bridge (18 h) | 4,986 | 3,051 | 4,764 | 30.5 → 3.2 |
| calibration | Sambhaji Bridge (11 h) | 5,042 | 6,421 | 5,096 | 18.2 → 0.8 |
| calibration | Tilak Bridge (10 h) | 2,213 | 1,012 | 2,000 | 29.9 → 4.6 |
| **validation** | Sangam Bridge (19 h, grade C) | 16,012 | 5,926 | 9,686 | 96.3 → 55.8 |
| **validation** | Shivaji Bridge (18 h) | 7,470 | 3,814 | 4,514 | 48.7 → 38.2 |
| **validation** | S. M. Joshi Bridge (11 h) | 4,302 | 1,759 | 1,489 | 46.2 → **52.3** (worse) |

- **Calibration half (fitted, not evidence):** GEH < 5 at 0/4 → 4/4; mean GEH 24.6 → 2.8. Expected: these counts were fitted.
- **Validation half (held out):** GEH < 5 at 0/3 → **0/3**; mean GEH 63.7 → 48.8; total 11,499 → 15,689 against 27,784
  counted. Two sites move toward their counts (largely because the PM estimate adds 24% demand overall), one moves away. With
  3 held-out sites this says nothing reliable either way; it does **not** show the estimate generalises, and the model
  remains **NOT VALIDATED** (TAG M3.1 asks GEH < 5 at > 85% of sites).
- **TAG M3.1 Table 5: breached in both areas.** PM: cell slope 1.10, cell R² 0.82, trip-end slope 1.35 / R² 0.87, largest
  sector change 75%; AM: cell slope 0.95, cell R² 0.59, trip ends 0.94 / 0.85, sector 33%. Trip-length mean/SD changes
  within 5% in both. TAG's guidance is that estimation should not make significant changes to the prior; here the counts
  pull the edge-to-edge prior a long way, which matches OVERHAUL §24.3b/§24.7 #4: the error is where area demand comes from
  (cordon flows of whatever area is selected), and re-weighting those cordon pairs fixes the fitted bridges without fixing
  the others. **Conclusion: do not use this estimate as "the" demand; it is a diagnostic.** The UI shows the breach in red.
- Caveats: counts from 2008 against a 2026 network; counts at 19 h / 10 h treated as the run's 18 h / 11 h; grade C sites
  (Sancheti, Sangam) have inferred mappings; one area ran with estimated signals; 7 sites only; split rule fixed in advance
  (id order, alternate) but with so few sites any split is fragile.

**Regularisation check (μ = 1, same runs; raw `/workspace/work/um-odme-run/odme_real_mu1.json`).** Practically no
difference: calibration GEH after 0.2 / 0.9 / 0.3 / 4.2, validation 55.6 / 37.0 / 52.9, Table 5 breached the same way (PM cell
R² 0.80, sector 71%; AM cell R² 0.56, sector 33%). Reason: the count term is unweighted (veh/h)² as in Spiess, while the
prior term is (veh/h)²/(veh/h), so μ = 0.1–1 is orders of magnitude too small to hold the matrix at these volumes. The UI's
μ choices therefore do little; a scale-consistent weighting (e.g. counts weighted 1/count, GLS) is an open item — not tuned
here to make the result look better. The AM area ran with **estimated** signals in both runs (the signal request failed).

## 5. Fuel and emissions — what it does

`engine/emissions/hbefa4.ts`, `engine/emissions/emissions.ts`; wired in `TrafficMicroSim` (per vehicle step), `analysisJob`
(per seed, then mean), `RoadAnalysisResult.emissions` / `.areaEmissions`, `ScenarioComparison` (`emissions` deltas),
UI: Simulate → Details → *Fuel and emissions (estimated)*, and the Compare result.

- **Model (corridor micro-simulation):** SUMO's HBEFA4-based instantaneous model (HBEFA 4.2; SUMO's default since 1.23.0):
  E(v,a) = max(0, f0 + f1 v + f2 a + f3 v² + f4 v³ + f5 a v + f6 a v²) mg/s, flat road; zero while coasting (v > 0.1 m/s and
  a below SUMO's coasting deceleration for the class's mass and frontal area); at standstill f0 applies = **idling, engine
  on** (SUMO default). Sources opened 2026-11-11: https://sumo.dlr.de/docs/Models/Emissions/HBEFA4-based.html and
  `src/utils/emissions/HelpersHBEFA4.{h,cpp}`, `PollutantsInterface.cpp`, `SUMOVTypeParameter.cpp`, `SUMOVehicleClass.cpp`,
  `PHEMConstants.h` in github.com/eclipse-sumo/sumo (HelpersHBEFA4.cpp at commit 7a4786a, 2026-01-09). Coefficients copied
  verbatim; fuel density 742 g/L petrol, 836 g/L diesel (SUMO's values).
- **Every step:** speed at the end of the 0.25 s step and the step's *actual* acceleration ((v_new − v_old)/dt, after the
  simulator's collision/stop-line limits), for every vehicle on the network, during the measured window only (warm-up
  excluded); totals per class, idle time and idle fuel, vehicle-km; mean over seeds; per hour = × 3600 / window.
- **Classes (all European; STAND-INs flagged in data and UI):** car → PC_petrol_Euro-4; two-wheeler → MC_4S_le250cc_Euro-4
  (**stand-in**); auto-rickshaw → MC_4S_le250cc_Euro-4 (**stand-in**: HBEFA has no three-wheeler; body weight and CNG not
  represented); bus → UBus_Std_gt15-18t_Euro-IV_SCR; truck → RT_le7.5t_Euro-IV_SCR; minibus → LCV_diesel_M+N1-I_Euro-4
  (stand-in). Euro-4/IV vintage and fuel type are app assumptions (Pune fleet mix unknown). SUMO's fit errors for FC: 4.32%,
  2.42%, 18.57%, 5.73%, 7.97% (fit to HBEFA, not accuracy for Pune).
- **Area cross-check (shown separately):** ARAI (2007) *Emission Factor development for Indian Vehicles*, Table I g/km
  (http://learning-cleanairasia.org/lms/library/ga2/07-Air-Quality-Monitoring-Project-Indian-Clean-Air-Programme-(ICAP).pdf,
  opened 2026-11-11), rows 20, 37, 30, 59, 62, 55 (see `ARAI_2007`), × vehicle-km per class of the whole area assignment
  (path flows × path length × class share). CO2, NOx, PM only (ARAI gives no fuel; motorcycle PM "NA" → PM reported without
  that class, and the UI says so). Distance-based: never used for scenario deltas.
- **Compare:** corridor fuel (L/h), CO2 (kg/h), NOx (g/h), PM (g/h), idle veh·h per h, before/after with seed agreement, on the
  same frozen demand and seeds as every other comparison measure. Shown as its own block and **not part of the verdict**.

## 6. Emissions tests — **UNIT-TESTED** (`engine/testing/Emissions.test.ts`, 7 tests; trajectories SYNTHETIC)

Hand computation from the published coefficients (car, fuel, 50 km/h steady: 493.1 + 5.054 v + 0.03887 v³ mg/s); idling > 0
for every class, 60 s idle = 60 s idle time, idle fuel = all fuel, 0 km; acceleration raises fuel at equal speed (car, 2W,
bus, truck); coasting gives 0; **not distance-only:** a stop-start trip over the same 1,000 m burns more fuel and CO2 than a
steady one; totals = sum of classes, per hour = × 3600/window, seeds averaged, litres = grams / 742; ARAI = g/km × km with PM
missing class listed. Plus `RoadAnalysis.test.ts` (existing comparison test, extended): a real analysis job produces emissions
for both seeds and an ARAI estimate, and a re-run of the same job compares with zero change on every emissions row.

**Idle rates (read before using totals).** The published HBEFA4 fit's standstill term for PC petrol Euro-4 is
f0 = 493 mg/s fuel (≈ 2.4 L/h); for the motorcycle class 74 mg/s (≈ 0.36 L/h). These are the coefficients as published by
SUMO; they were not checked against measured idle consumption of Indian vehicles, so in a saturated corridor (where idling
is a large share of fuel) the absolute totals are uncertain. Differences between scenarios on the same demand are the
intended use.

## 8. Browser verification (2026-11-11, headless Chromium + SwiftShader, backend on a copy of twincity.db, port 8305/4505)

Script `/workspace/work/um-odme-run/e2e.py` (scratch, not committed); screens `/workspace/work/um-odme-run/shots/`.
SYNTHETIC Traffic-data datasets created through the API on the DB copy: *SYNTHETIC ODME calibration* (Shivaji Bridge
`osm_22841323`, 09:00–10:00 weekday, fwd 1,500 / bwd 1,300 veh/h) and *SYNTHETIC ODME validation* (Jangli Maharaj Path
`osm_217431357` fwd 1,020 veh/h). These numbers are invented; the GEH values below say nothing about model accuracy.

| Step | Result | Label |
|---|---|---|
| Simulate Shivaji Bridge, 2 km, 09:00 → Details → Fuel and emissions | card shows corridor fuel 1,530.9 L/h, CO₂ 3,610.6 kg/h, NOx 7,698 g/h, PM 1,070.7 g/h, idling 712.7 veh·h/h (55% of fuel), 10,284 veh·km/h; per-class rows with HBEFA class and "stand-in" for two-wheeler/auto; ARAI cross-check block (103,696 veh·km/h, CO₂ 10,179 kg/h, PM without two-wheelers) with sources | BROWSER-VERIFIED |
| Details → Checks against traffic counts → Estimate demand from calibration counts | 45 s; 3 accepted iterations (9 routings), demand 29,200 → 29,840 veh/h, 1,212 cells, 20 at a bound; Table 5: trip-end slope 0.926, trip-end R² 0.949, sector 29.7% → "OUTSIDE limits" in red; calibration GEH 24.6 → 17.0 (bwd), 9.2 → 0.5 (fwd); validation (held out) 43.5 → 43.5 | BROWSER-VERIFIED |
| Tick "Run the analysis on this estimated demand" | analysis re-ran (141 s) on the ODME version: demand label "ESTIMATED FROM CALIBRATION COUNTS … OUTSIDE TAG M3.1 Table 5 limits"; corridor fuel 1,557.4 L/h; `frozenAssumptions().demandEstimatedFromCounts` = prior key, dataset, 3 iterations, 09:00 | BROWSER-VERIFIED |
| Save existing city + Compare (same network, ODME demand frozen) | in-page `ComparisonResult`: verdict no change, inputs matched, every emissions row before = after, change 0 | BROWSER-VERIFIED (engine state in the page); the Compare emissions block's rendering was not captured by the script → **UNTESTED** visually |

## 9. Not done / open

- Scale-consistent regularisation / count weighting (GLS); turning-count constraints in ODME; ODME in a Web Worker; per-dataset count weights from provenance (all weights 1).
- Emissions: slope (terrain) not passed (flat road); fleet vintage / fuel mix not user-editable; no Indian instantaneous
  2W/3W model exists in the sources opened; scenario HTML/CSV report does not yet include emissions or ODME provenance.
