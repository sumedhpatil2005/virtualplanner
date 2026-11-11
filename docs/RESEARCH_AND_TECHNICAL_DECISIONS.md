# Research and technical decisions

Branch `urban-mobility-platform`. Part A (traffic modelling) written 2026-11-11. Other parts (topology, feasibility, investigation, scenario versioning) are to be added by their owners under Parts B onwards.

**Rules for this document.** Every engineering claim cites a source that was opened for this document (URL given; "opened" means the page or PDF was fetched and the cited passage read). Where only a secondary quotation or the bibliographic record was available, the entry says so. Nothing here is a measurement of Pune traffic; the app's own validation results are in `docs/OVERHAUL.md` §24 and will move to `docs/ENGINEERING_VALIDATION.md`.

Each decision has: **Problem · Alternatives · Comparison · Chosen for this app · Assumptions · Limitations · How it will be tested.** "Chosen" means chosen for design; nothing in Part A is implemented yet unless it says *(exists: file)*.

---

## Part A. Traffic modelling

### A1. OD demand: how the prior matrix is formed

**Problem.** The simulator needs vehicle trips between origins and destinations. The app currently builds a study-area plan from land use and an edge (cordon) estimate *(exists: `simulation/AreaDemand.ts`, `DemandMatrixCompiler.ts`, `tripRates.ts`)*: internal trips with an Erlang-2 trip-length deterrence, land-use ↔ edge trips, and through traffic from **assumed peak-hour flow per lane by road class** at the cordon. The mission requires that observed counts are not treated as demand, and that demand is plausible.

**Alternatives.**
1. *Four-step style trip generation + gravity distribution* from land use (population, employment) with a deterrence function and trip-end balancing. Standard parameters and transferable-rate tables exist (NCHRP Report 716, *Travel Demand Forecasting: Parameters and Techniques*, TRB 2012, https://nap.nationalacademies.org/catalog/14665 — opened: catalogue page). Pune-specific rates exist in the Pune CMP 2018 (already cited in `tripRates.ts`).
2. *Edge-only (cordon) demand*: generate trips between boundary entries/exits so that cordon volumes match assumed or counted flows. Cheap, but cordon totals do not determine the OD pattern: many matrices give the same edge totals (the general underdetermination result, A2).
3. *Survey-based matrix* (household or roadside OD surveys): best evidence, normally unavailable to the app; must be importable when an authority has one.
4. *Big-data matrices* (mobile phone / probe OD): not available; would be an import, like 3.

**Comparison.** Alternative 1 gives a structurally plausible pattern (short trips more frequent, trips balanced to land use) but its rates are city-averages and the zone system in the app is a 2 km study area, so most trips cross the cordon (the code's own note: CMP 2018 mean motorised trip lengths 4.7–8.5 km vs a 2 km area). Alternative 2 alone cannot distinguish through traffic from local traffic. The current hybrid (1 inside + 2 at the edge) is reasonable as a **prior**, provided the per-lane edge flows are labelled assumptions and are then corrected by counts (A2), not tuned by hand.

**Chosen.** Keep the current hybrid as the *prior* (`demand_versions.method = 'estimate'`), with every component labelled (`DemandProvenance`: project-estimate). Add: (a) import of a survey/external matrix as a prior (`method = 'imported'`); (b) a city-level prior from zones (`ZoneObject`) when the user defines them, so study areas can be cordoned from a larger matrix instead of inventing edge flows (TAG M3.1 §2.2.13 describes cordoning a larger model and warns that variants must not significantly change cordon flows — opened, see A2 source).

**Assumptions.** Trip rates and mode shares from CMP 2018 apply to the area; peak-hour share as in `tripRates.ts`; per-lane edge flows by class are assumptions until counts exist.

**Limitations.** Without counts the prior is unvalidated; the edge estimate is the largest single source of uncertainty (OVERHAUL §24: model volumes mostly below counts).

**Tests.** Unit: trip-end balance (row/column sums equal generated productions/attractions within tolerance); deterrence produces the configured mean trip length on a synthetic grid (**synthetic fixture**). Property test: total cordon in = cordon out + net internal production. Report the prior's screen-line fit **before** any estimation (TAG M3.1 §3.3, screen-line guidance: "the prior matrix should be assigned and tested against this criterion before any impact of matrix estim[ation]").

---

### A2. OD matrix estimation from counts (ODME)

**Problem.** Authorities have counts (links, turns, screen lines), not OD matrices. Counts must constrain demand without being mistaken for it. The app currently scales trips by bounded IPF at counted junctions inside one study area *(exists: `calibration/ipf.ts`, `calibration.ts`, factor bounds 0.25–4, count-seeded trips)*; the after-GEH is measured on the same counts that were fitted, and the code says so.

**Underdetermination (the core fact).** "Since the matrix estimation problem … is highly underdetermined, it usually admits an infinite number of optimal solutions, i.e. possible demand matrices which all reflect the observed volumes equally well" — Spiess (1990), *A gradient approach for the O-D matrix adjustment problem*, CRT Publication 693, Université de Montréal; text opened at http://www.spiess.ch/emme2/demadj/demadj.html. SUMO's routeSampler documentation states the same for route selection: "generally an underdetermined problem … if there are insufficient constraints … the chosen solution may appear implausible", and warns that full optimisation "may lead to implausible distribution of cars among the candidate routes" because "edge counts do not constrain the solution space very much" (https://sumo.dlr.de/docs/Tools/Turns.html, opened; page edited 2026-10-12). PTV's Visum help says the same: count objects are far fewer than OD pairs, so the matrix is under-determined (https://cgi.ptvgroup.com/vision-help/VISUM_2021_ENG/Content/1_Nachfragemodell/1_3_Methodische_Grundlagen_von_VStromFuzzy.htm, search excerpt only).

Every method therefore adds prior information (a seed matrix) and an objective that stays close to it.

**Alternatives.**

| Method | Idea | Source (opened unless noted) |
|---|---|---|
| Entropy / information minimisation (ME2) | Most likely matrix consistent with counts and a prior, given known path proportions; gravity-like result | Van Zuylen & Willumsen (1980), *The most likely trip matrix estimated from traffic counts*, Transp. Res. B 14(3):281–293, doi:10.1016/0191-2615(80)90008-9 — abstract (ScienceDirect / IDEAS). Assumes path proportions are known (proportional assignment). |
| Generalised least squares (GLS) | Minimise weighted squared deviations from both the prior matrix and the counts; weights = inverse error variances; counts with measurement error are allowed | Cascetta (1984), Transp. Res. B 18(4–5):289–299, doi:10.1016/0191-2615(84)90012-2 — abstract; full text copy https://behrisch.de/en/lehre/lvws0809/verkehr/GLSEstimator.pdf (first page read) |
| Gradient (bi-level with equilibrium assignment) | Minimise ½Σ(v_a − v̂_a)² subject to v = assign(g); steepest descent with multiplicative updates so the prior's structure (zero cells, unused paths) is preserved; each iteration ≈ two equilibrium assignments | Spiess (1990), above |
| Dynamic (time-dependent) ODME | Linear approximations of the assignment matrix from a mesoscopic simulator, iterated | Toledo & Kolechkina (2013), IEEE T-ITS 14(2):618–626, doi:10.1109/TITS.2012.2226211 — abstract (Technion PDF https://toledo.net.technion.ac.il/files/2016/02/IEEE-ITS_ODEstimation_13.pdf) |
| Bayesian simulation-based calibration (Cadyts) | Individual-level choice calibration with time-dependent counts; the simulator is the prior | Flötteröd, Bierlaire & Nagel (2011), Transp. Sci. 45(4):541–561, doi:10.1287/trsc.1100.0367 — abstract via Crossref; SUMO wrapper https://sumo.dlr.de/docs/Contributed/Cadyts.html (opened) |
| Route sampling to counts (routeSampler) | Sample routes from a candidate set until counts are met; optional LP optimisation; reports GEH and mismatch per location | SUMO docs, above |
| Fuzzy counts + entropy (TFlowFuzzy) | Counts as fuzzy intervals, entropy-maximising correction; Visum also offers least squares (static and dynamic) | Friedrich, Nökel & Mott, *Keeping passenger surveys up-to-date: a fuzzy approach* (TRB, PTV), https://www.isv.uni-stuttgart.de/vuv/publikationen/downloads/200001_Fr_TFlowFuzzy_TRB.pdf (search excerpt); PTV Visum FAQ https://www.ptvgroup.com/en-us/products/ptv-visum/faqs (search excerpt) |

**Comparison for this app.**
- The app already has a deterministic Frank-Wolfe assignment with stored path flows *(exists: `staticAssignment.ts`)*. That makes **Spiess-style gradient adjustment** and **GLS on the path-flow assignment matrix** cheap to implement in TypeScript, in-engine, without new dependencies.
- ME2/IPF (what exists) is the proportional-assignment special case: fine at one junction, but it ignores that matrix changes reroute traffic under congestion.
- Dynamic ODME and Cadyts need a network-wide dynamic loader the app does not have (micro-sim is corridor-only); out of scope now.
- GLS lets the app express **count reliability** (manual 1-hour count vs permanent ATC) through weights, which fits the provenance model; Spiess's multiplicative update preserves the prior's zero structure, which protects against inventing OD pairs.

**Chosen.** Implement a bi-level estimator in `engine/demand/odme.ts`: outer loop = Spiess gradient step on a GLS objective `Σ_a w_a (v_a − ĉ_a)² + λ Σ_od u_od (g_od − ĝ_od)²` (weights from count quality and prior confidence); inner = existing Frank-Wolfe UE; multiplicative updates (no new OD pairs); per-step bounds. Keep `ipf.ts` for single-junction count seeding. Each run writes an estimation report with **TAG M3.1 Table 5 change statistics**: matrix zonal cell values slope 0.98–1.02, intercept near zero, R² > 0.95; zonal trip ends slope 0.99–1.01, R² > 0.98; trip-length distribution means and standard deviations within 5%; sector-to-sector differences within 5% (TAG M3.1 May 2026, Table 5, opened: https://assets.publishing.service.gov.uk/media/6a033d074fb0713aa63ea802/tag-m3-1-highway-assignment-modelling.pdf). TAG says "matrix estimation should not be allowed to make significant changes to the prior matrices in order that the validation [criteria are met]"; when limits are exceeded the app shows it and does not hide it.

**Assumptions.** Counts are for the modelled period and day type, or are explicitly factored (the factor is stored in `traffic_datasets.adjustments`); counts are converted to the assignment unit (PCU/h) with a stated factor set (A4); route choice is UE.

**Limitations.** Estimation cannot fix network errors (wrong lanes, missing links); TAG says when guidelines are not met the analyst "should review the assumptions and quality of data … but should not impose constraints just to i[mprove validation]" (§3.3.9). With few counts the result stays close to the prior and may still be wrong. Static ODME does not capture peak spreading.

**Tests.** (1) **Synthetic recovery** (labelled synthetic): known true matrix on a grid, perturbed prior, counts on a subset of links → estimator reduces count error, never creates OD pairs absent from the prior, respects bounds. (2) Underdetermination test: two different true matrices with identical counts → estimator returns the one closer to the prior (documents the behaviour, not a bug). (3) Hold-out: counts split into estimation and **independent validation** sets (TAG §3.3.8 requires separate reporting); validation GEH reported only on the hold-out set. (4) Table 5 statistics computed and asserted in a unit test on a fixture where they are known.

---

### A3. Assignment: static user equilibrium vs dynamic traffic assignment

**Problem.** Route choice and link loads for a whole study area or city; the micro-simulator alone cannot carry area demand (OVERHAUL §9).

**Alternatives.**
1. *Static deterministic UE, Frank-Wolfe, BPR* — Sheffi (1985), *Urban Transportation Networks*, Prentice-Hall, ch. 5 (book PDF hosted by MIT: https://web.mit.edu/sheffi/www/selectedMedia/sheffi_urban_trans_networks.pdf, opened, PDF resolves). *(exists: `staticAssignment.ts`)*
2. *Static UE with better algorithms* (bush/path-based, faster to tight gaps) — same equilibrium, better convergence.
3. *Dynamic traffic assignment (DTA)*: time-dependent loading with queues and spillback; simulation-based DUE as in SUMO `duaIterate.py` (https://sumo.dlr.de/docs/Demand/Dynamic_User_Assignment.html, opened) or mesoscopic models. TRB Circular E-C153, *Dynamic Traffic Assignment: A Primer* (June 2011), https://onlinepubs.trb.org/onlinepubs/circulars/ec153.pdf (opened, title page read).
4. *Corridor micro-simulation fed by the static paths* *(exists: `analysisJob.ts`)*.

**Comparison.** Static UE is deterministic, seconds to run, and is what TAG M3.1 validates against (link flows, screen lines, journey times, with convergence %GAP < 0.1% or "at least stable with convergence fully documented", Table 4, opened). It cannot represent queues spilling back beyond a link or time-dependent demand within the hour. DTA can, but needs a city-wide dynamic loader, much more compute, and its own calibration; the app's micro-simulator is corridor-only.

**Chosen.** Keep static UE as the area/city model, add **convergence reporting** (relative gap per run, stored in `runs`, flagged when > 0.1% — TAG Table 4) and keep corridor micro-simulation for queues/signals. Record DTA as future work behind the same run interface (a run kind), not a rewrite.

**Assumptions.** Within-hour stationarity; BPR (α 0.15, β 4) as in the code; signal delay as Webster uniform delay.

**Limitations.** BPR permits v/c > 1 (no hard capacity); spillback between corridor and area is not modelled; hourly slices are independent.

**Tests.** Existing `AssignmentFeedback.test.ts`, `ComparisonAgreement.test.ts`; add a Braess/two-route analytic UE fixture (equal travel times on used routes within gap), and a convergence regression asserting the reported gap is computed from the Frank-Wolfe lower bound.

---

### A4. Vehicle classes and PCU conversion

**Problem.** Counts arrive by class; capacity is in PCU; mixed Indian traffic (≈52% two-wheelers in the app's default mix) makes PCU choice material.

**Sources.**
- **IRC:106-1990**, *Guidelines for Capacity of Urban Roads in Plain Areas*, Table 1 "Recommended PCU factors for various types of vehicles on urban roads" (scanned code opened at https://archive.org/stream/gov.in.irc.106.1990/irc.gov.in.106.1990_djvu.txt): by composition 5% / 10% and above — two-wheeler 0.5 / 0.75; passenger car, pick-up van 1.0 / 1.0; auto-rickshaw 1.2 / 2.0; LCV 1.4 / 2.0; truck or bus 2.2 / 3.7; agricultural tractor-trailer 4.0 / 5.0; cycle 0.4 / 0.5; cycle-rickshaw 1.5 / 2.0. `docs/CALIBRATION.md` §1 notes clause 2.1 limits IRC:106 to mid-block sections.
- **Indo-HCM 2017** (CSIR-CRRI, December 2017; page https://crridom.gov.in/en/indian-highway-capacity-manual, opened; sold at Rs 3,500, procedure https://crridom.gov.in/sites/default/files/files/Procedure%20to%20buy%20Indo-HCM.pdf). **The manual itself was not opened for this document**; values the app uses from it are secondary quotations (CALIBRATION.md §1). Its use of dynamic PCU is known from the research it builds on, e.g. Dhamaniya & Chandra (2016), TRR 2553:108–116 (listed in the reference list of the paper below; not opened).
- **Patel & Dhamaniya (2021)**, *Developing Mixed Traffic Equivalency Factors to Estimate Saturation Flow at Urban Signalized Intersections*, TRR 2675(11):601–611, doi:10.1177/03611981211018694 (abstract opened): time-occupancy PCUs at signalised intersections in three Indian metros; observed dynamic PCU ranges: two-wheelers 0.12–0.32, three-wheelers 0.45–0.80, big cars 1.40–1.80, LCV 1.60–2.20, heavy vehicles 3.50–6.50; PCUs vary significantly with composition and flow; proposes a flow equivalency factor (FEF).

**Alternatives.** (1) IRC:106 static factors; (2) dynamic PCU regression models (Indo-HCM / Patel & Dhamaniya), context-specific (mid-block vs stop line); (3) no PCU — model classes explicitly in the micro-simulator (already done there) and use PCU only for capacity comparisons.

**Comparison.** Mid-block vs stop-line PCUs differ by a factor of 2–3 for two-wheelers (IRC 0.75 vs 0.12–0.32 at saturated green). Using a mid-block factor at a stop line overstates two-wheeler demand on a signalised approach; the reverse understates mid-block load. Dynamic models need composition and flow inputs the app has, but their coefficients are in sources not opened here.

**Chosen.** Versioned **PCU factor sets** (`pcu_factor_sets`) with a `context` field: default `IRC106-1990-midblock` (as now, composition-dependent) for link capacity; a stop-line set entered only from an opened source (to be added when Indo-HCM tables are obtained); user-defined sets allowed and labelled. Every converted count stores which set was used. Classes extensible (`vehicle_classes`), seeded with 2W, car, auto, bus, LCV, HCV, other; LCV gets IRC 1.4/2.0.

**Assumptions.** Composition threshold read from the dataset's own class shares; IRC values apply to mid-block.

**Limitations.** Static factors ignore flow-dependence; the app's current single PCU per class is not context-dependent; Indo-HCM not verified first-hand.

**Tests.** Table-driven unit test reproducing IRC:106 Table 1 both composition columns; conversion of a classified count to PCU with a named set; refusal to convert when the set lacks a class; round-trip of a set through the API.

---

### A5. Calibration and validation standards

**Problem.** Decide what "validated" means, report it honestly, and keep calibration separate from validation.

**Sources (all opened).**
- **UK DfT TAG unit M3.1, Highway Assignment Modelling, May 2026** (URL in A2). Screen lines: modelled within 5% of counts for "all or nearly all screenlines (ie 95%)" (Table 1); screen lines normally ≥ 5 links; comparisons reported separately for data used in matrix development, screen lines used as constraints, and independent validation (§3.3.8). Link flows/turns: GEH and absolute/percentage criteria are "broadly consistent and flows that meet either criterion should be regarded as satisfactory" (§3.3.10, Table 2 — the app's OVERHAUL §24.2 restates the thresholds: within 100 veh/h below 700, 15% for 700–2,700, 400 veh/h above 2,700, or GEH < 5, at > 85% of sites). Journey times within 15% on > 85% of routes (Table 3). Convergence Table 4. ODME change limits Table 5 (A2). And: meeting the criteria "does not guarantee that a model is 'fit for purpose'", and failing them does not mean it is unfit (§3.2.2).
- **FHWA Traffic Analysis Toolbox Volume III, 2019 Update** (FHWA-HOP-18-036, April 2019), https://ops.fhwa.dot.gov/publications/fhwahop18036/index.htm and chapter 5 https://ops.fhwa.dot.gov/publications/fhwahop18036/chapter5.htm. Calibration uses **travel conditions** (clusters of observed days) and **variation envelopes**: Criterion I — 95% of simulated outputs within c_r(t) ± 1.96σ(t) (relaxed to one outlier with < 20 intervals); Criterion II — two-thirds of results and both critical intervals within 1σ; Criterion III — bounded dynamic absolute error ≤ the day-to-day variation; Criterion IV — systematic error ≤ ⅓ of that threshold. The 2019 guide does not use GEH targets in its calibration chapter. **Correction to OVERHAUL §24.2**, which says FHWA uses the same targets as TAG.
- **Indo-HCM 2017**: capacity and LOS methods for Indian roads (not opened; see A4).

**Alternatives.** (1) TAG M3.1 static criteria (single-day/hour counts and journey times); (2) FHWA 2019 variation envelopes (need multi-day observations per travel condition); (3) both, chosen by data available.

**Comparison.** Pune data the app holds are single-period counts (2008, 2017, 2025 studies) and hour-of-day probe speeds (TraffiCure, TomTom) — enough for TAG-style tests, not for FHWA envelopes (no day-to-day σ). FHWA's method is the right one once an authority supplies multi-day detector data.

**Chosen.** Validation library `engine/validation/` reporting, per item: observed, modelled, difference, % error, GEH, criterion, pass/fail, data year and grade, and whether the item was used in calibration. Criteria set **TAG-M3.1-2026** by default; **FHWA-2019-envelope** offered only when a dataset has ≥ the days needed to compute σ(t) per interval (count recorded with the dataset). Model-year mismatch (e.g. 2008 counts vs 2026 network) is shown on every row, as OVERHAUL §24 already does. The verdict "validated" is never shown; the panel shows criteria met / not met.

**Assumptions.** Counts are correct as published; probe speeds represent the mapped corridor (graded C where the corridor geometry is inferred).

**Limitations.** Old counts make failures indicative only; small numbers of sites make percentage criteria coarse.

**Tests.** Unit tests of GEH and flow-criterion arithmetic against TAG's definitions (the hand checks in OVERHAUL §24.2 become fixtures); FHWA Criteria I–IV computed on a synthetic multi-day fixture (labelled synthetic) with a known outcome; test that items flagged "used in calibration" are excluded from the independent-validation summary.

---

### A6. Fuel consumption and emissions

**Problem.** Compare scenarios on fuel and emissions from speed, acceleration and idling, not distance (mission §13).

**Alternatives.**

| Model | Type | Inputs | Fit for Indian fleet | Source (opened) |
|---|---|---|---|---|
| COPERT 5 (EMEP/EEA Guidebook) | Average-speed functions by vehicle category/Euro class | Fleet, mileage, speed, temperature | European categories; no Indian 2W/3W classes as such | https://www.emisia.com/utilities/copert/ ("EU standard … uses vehicle population, mileage, speed"; part of the EMEP/EEA guidebook); Guidebook 2023 https://www.eea.europa.eu/en/analysis/publications/emep-eea-guidebook-2023 |
| HBEFA (4.x) | Emission factors per "traffic situation" (road type × speed limit × level of service) | Traffic situation mix | European fleets | https://www.hbefa.net/ ("emission factors for all current vehicle categories … for a wide variety of traffic situations") |
| SUMO HBEFA-based (v2.1/3.1/4.2) | Continuous reformulation of HBEFA as functions of instantaneous speed and acceleration; outputs CO2, CO, HC, NOx, PMx, fuel | Per-vehicle speed/acceleration each step | European classes; default `HBEFA3/PC_G_EU4` | https://sumo.dlr.de/docs/Models/Emissions.html; https://sumo.dlr.de/docs/Models/Emissions/HBEFA4-based.html |
| PHEMlight / PHEMlight5 (TU Graz) | Power-based instantaneous model | Speed, acceleration, slope, vehicle data | Only two public classes (PC_D_EU4, PC_G_EU4); others licensed | https://sumo.dlr.de/docs/Models/Emissions/PHEMlight.html |
| US EPA MOVES (MOVES6 latest, Oct 2026) | Operating-mode based; national, county and project scale | Link drive schedules / op-mode distributions | US fleet | https://www.epa.gov/moves, https://www.epa.gov/moves/latest-version-motor-vehicle-emission-simulator-moves |
| VT-Micro | Regression on instantaneous speed and acceleration for hot-stabilised emissions/fuel | Speed, acceleration | US light-duty vehicles and trucks | Rakha, Ahn & Trani (2004), Transp. Res. D 9(1):49–74, doi:10.1016/S1361-9209(03)00054-3 (bibliographic record via Crossref; model form not re-read) |
| ARAI / CPCB emission factors (2007) | Cycle-average g/km by category, vintage and engine size; idle in g/min | Vehicle-km by class/vintage | Indian vehicles incl. 2W, 3W, buses | ARAI report AFL/2006-07/IOCL/Emission Factor Project, 17 Aug 2007, http://learning-cleanairasia.org/lms/library/ga2/07-Air-Quality-Monitoring-Project-Indian-Clean-Air-Programme-(ICAP).pdf (opened): 89 vehicles, ~450 tests, 62 factors; Indian Driving Cycle for 2W/3W/pre-2000 4W, Modified IDC for post-2000 cars; "sample size … even to the extent of only one vehicle for some categories" |

**Comparison.** Only instantaneous models (SUMO HBEFA-based, PHEMlight, VT-Micro) respond to acceleration and idling in a micro-simulation — required by the mission — but none is calibrated for Indian two-/three-wheelers. ARAI factors are Indian but cycle-averaged (they cannot distinguish a smoother from a stop-start flow at the same distance) and pre-date BS-IV/BS-VI vehicles. COPERT/HBEFA average-speed or traffic-situation factors can be applied to assignment outputs (speed per link) but are European.

**Chosen.** Two clearly labelled layers:
1. **Micro-simulation (corridor):** instantaneous fuel/CO2 per vehicle per step using the SUMO HBEFA4-based functional form with published coefficients, mapped class-by-class (car → passenger-car class, bus/truck → heavy-duty classes; two-wheeler and auto mapped to the closest available class **and flagged "proxy class — not calibrated for Indian 2W/3W"**). Idling counted explicitly (SUMO notes engines run while stopped unless start/stop is set; the app defaults to running, stated).
2. **Assignment (area):** link-level estimate from speed-dependent factors (COPERT/HBEFA-style) as a coarse cross-check, plus ARAI g/km as the Indian reference for CO2/fuel totals, with vintage assumptions stored.
Results always shown as *estimated*, with the factor source, and compared only between scenarios on the same demand, fleet mix and model (differences are more robust than absolutes). The exact coefficient files must be copied from an opened source when implemented; none are written into this document.

**Assumptions.** Fleet vintage mix (unknown for Pune; user-set, default labelled assumption); flat roads unless terrain slope is supplied; hot-stabilised engines.

**Limitations.** No model here is validated for Pune traffic; 2W/3W instantaneous emissions are proxies; ARAI 2007 factors cover old vintages and small samples.

**Tests.** Unit: zero fuel when coasting per model rule, positive idle fuel, monotonic increase with acceleration at constant speed; scenario test — same distance, stop-start trajectory consumes more than steady trajectory (this is the mission's "not distance only" requirement as an assertion); regression against a hand-computed value from the published coefficient table for one class.

---

### A7. Multi-objective comparison of scenarios

**Problem.** Authorities weigh travel time, fuel, cost, land acquisition, disruption; the mission forbids hiding trade-offs behind an unexplained score.

**Alternatives and their known problems.**
- *Weighted sum* of normalised criteria: simple, but cannot reach points on non-convex parts of the Pareto front and an even spread of weights does not give an even spread of solutions — Das & Dennis (1997), *A closer look at drawbacks of minimizing weighted sums of objectives for Pareto set generation*, Structural Optimization, doi:10.1007/BF01197559 (record via Crossref). Survey: Marler & Arora (2004), *Survey of multi-objective optimization methods for engineering*, Struct. Multidisc. Optim., doi:10.1007/s00158-003-0368-6 (record via Crossref).
- *Pareto (non-dominated) set*: no weights; shows which options are not beaten on every criterion; does not pick one.
- *TOPSIS*: ranks by distance to ideal/anti-ideal; subject to **rank reversal** when alternatives are added or removed — García-Cascales & Lamata (2012), *On rank reversal and TOPSIS method*, Math. Comput. Modelling, doi:10.1016/j.mcm.2011.12.022 (record via Crossref).
- *AHP*: pairwise-comparison weights; rank reversal shown by Belton & Gear (1983), *On a short-coming of Saaty's method of analytic hierarchies*, Omega, doi:10.1016/0305-0483(83)90047-6 (record via Crossref).

(Full texts of these four were not opened; only their bibliographic records. The stated results are the papers' titles/subjects and are widely cited, but should be re-read before quoting specifics.)

**Comparison.** The candidate set in this app is small (a handful of scenarios), so computing the exact Pareto set is trivial and loses nothing. Any single ranking depends on weights and normalisation and, for TOPSIS/AHP, on which other options are in the set — a property that would let a ranking change when an irrelevant option is added, which is unacceptable for an auditable public decision.

**Chosen.** (1) Metric registry: each metric has definition, unit, direction, source run, uncertainty (seed spread) and certainty label; metrics with missing data are shown as *missing*, never zero. (2) Pareto filter over the metrics the user selects; dominated options are listed with the option that dominates them and on which metrics. (3) Optional user-weighted ranking shown **next to** the Pareto set, with the weights, normalisation and a note that weighted sums can miss non-convex trade-offs; sensitivity shown by recomputing the ranking over a weight range. (4) No TOPSIS/AHP by default; if added later, they must report rank stability under add/remove of alternatives. (5) Comparability guard (exists in spirit: `ScenarioComparison.ts` uses the same frozen demand, hour and seeds): the comparison refuses or flags when runs differ in demand version, period, seeds or engine version, listing the differences.

**Assumptions.** Metrics are independent enough to show side by side; costs and land figures come from user input or feasibility findings with their certainty.

**Limitations.** Pareto sets grow with the number of metrics (with many metrics most options are non-dominated); seed noise can make dominance unstable — dominance is declared only when the difference exceeds the run's noise threshold in every seed (same rule as the existing verdict).

**Tests.** Unit: Pareto filter on hand-made fixtures (including ties and noise-band ties); weighted-sum example where a non-convex Pareto point is never selected (documents the limitation); comparability guard rejects runs with different demand versions; missing metric is not treated as best or worst.

---

### A8. Source register (Part A)

| # | Source | Publisher, date | URL | Opened? |
|---|---|---|---|---|
| 1 | TAG unit M3.1 Highway Assignment Modelling | UK DfT, May 2026 | https://assets.publishing.service.gov.uk/media/6a033d074fb0713aa63ea802/tag-m3-1-highway-assignment-modelling.pdf | Yes (Tables 1, 2, 4, 5; §§2.2.13, 3.2.2, 3.3.8–3.3.10) |
| 2 | Traffic Analysis Toolbox Vol. III, 2019 Update (FHWA-HOP-18-036) | FHWA, Apr 2019 | https://ops.fhwa.dot.gov/publications/fhwahop18036/chapter5.htm | Yes (ch. 5 Criteria I–IV) |
| 3 | IRC:106-1990 Guidelines for Capacity of Urban Roads in Plain Areas | Indian Roads Congress, 1990 | https://archive.org/stream/gov.in.irc.106.1990/irc.gov.in.106.1990_djvu.txt | Yes (Table 1) |
| 4 | Indian Highway Capacity Manual (Indo-HCM) | CSIR-CRRI, Dec 2017 | https://crridom.gov.in/en/indian-highway-capacity-manual | Product page only; manual not opened |
| 5 | Patel & Dhamaniya, TRR 2675(11):601–611 | TRB/SAGE, 2021 | https://doi.org/10.1177/03611981211018694 | Abstract |
| 6 | Spiess, Gradient approach for O-D matrix adjustment, CRT Pub. 693 | 1990 | http://www.spiess.ch/emme2/demadj/demadj.html | Yes |
| 7 | Van Zuylen & Willumsen, Transp. Res. B 14(3):281–293 | Elsevier, 1980 | https://doi.org/10.1016/0191-2615(80)90008-9 | Abstract |
| 8 | Cascetta, Transp. Res. B 18(4–5):289–299 | Elsevier, 1984 | https://doi.org/10.1016/0191-2615(84)90012-2 | Abstract + first page |
| 9 | Toledo & Kolechkina, IEEE T-ITS 14(2):618–626 | IEEE, 2013 | https://doi.org/10.1109/TITS.2012.2226211 | Abstract |
| 10 | Flötteröd, Bierlaire & Nagel, Transp. Sci. 45(4):541–561 | INFORMS, 2011 | https://doi.org/10.1287/trsc.1100.0367 | Abstract |
| 11 | SUMO routeSampler / Turns | Eclipse SUMO, edited 2026-10-12 | https://sumo.dlr.de/docs/Tools/Turns.html | Yes |
| 12 | SUMO Cadyts | Eclipse SUMO | https://sumo.dlr.de/docs/Contributed/Cadyts.html | Yes |
| 13 | SUMO Dynamic User Assignment | Eclipse SUMO | https://sumo.dlr.de/docs/Demand/Dynamic_User_Assignment.html | Yes |
| 14 | PTV Visum TFlowFuzzy / Least squares | PTV | https://www.ptvgroup.com/en-us/products/ptv-visum/faqs | Search excerpt only |
| 15 | Sheffi, Urban Transportation Networks | Prentice-Hall, 1985 | https://web.mit.edu/sheffi/www/selectedMedia/sheffi_urban_trans_networks.pdf | PDF resolves; ch. 5 not re-read |
| 16 | DTA: A Primer, TRB Circular E-C153 | TRB, Jun 2011 | https://onlinepubs.trb.org/onlinepubs/circulars/ec153.pdf | Title pages |
| 17 | NCHRP Report 716 | TRB, 2012 | https://nap.nationalacademies.org/catalog/14665 | Catalogue page |
| 18 | SUMO Emissions; HBEFA4-based; PHEMlight | Eclipse SUMO, edited 2026-10-25 | https://sumo.dlr.de/docs/Models/Emissions.html | Yes |
| 19 | COPERT | Emisia | https://www.emisia.com/utilities/copert/ | Yes |
| 20 | EMEP/EEA Guidebook 2023 | EEA | https://www.eea.europa.eu/en/analysis/publications/emep-eea-guidebook-2023 | Page resolves |
| 21 | HBEFA | INFRAS et al. | https://www.hbefa.net/ | Yes |
| 22 | MOVES (MOVES6) | US EPA, Oct 2026 | https://www.epa.gov/moves/latest-version-motor-vehicle-emission-simulator-moves | Yes |
| 23 | Rakha, Ahn & Trani, VT-Micro, Transp. Res. D 9(1):49–74 | Elsevier, 2004 | https://doi.org/10.1016/S1361-9209(03)00054-3 | Bibliographic record |
| 24 | ARAI, Emission Factor development for Indian Vehicles | ARAI/CPCB, 17 Aug 2007 | http://learning-cleanairasia.org/lms/library/ga2/07-Air-Quality-Monitoring-Project-Indian-Clean-Air-Programme-(ICAP).pdf | Yes |
| 25 | Das & Dennis (1997) | Structural Optimization | https://doi.org/10.1007/BF01197559 | Record |
| 26 | Marler & Arora (2004) | Struct. Multidisc. Optim. | https://doi.org/10.1007/s00158-003-0368-6 | Record |
| 27 | García-Cascales & Lamata (2012) | Math. Comput. Modelling | https://doi.org/10.1016/j.mcm.2011.12.022 | Record |
| 28 | Belton & Gear (1983) | Omega | https://doi.org/10.1016/0305-0483(83)90047-6 | Record |

**Open items requiring verification.** Indo-HCM 2017 tables (saturation flow, dynamic PCU, LOS) must be read from the purchased manual before the app cites them as primary; the SUMO HBEFA4 coefficient tables must be copied from the SUMO source when emissions are implemented; Pune fleet vintage mix is unknown and must come from the RTO or a study.
