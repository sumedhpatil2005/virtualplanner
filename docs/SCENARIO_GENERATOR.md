# Intelligent scenario generator and multi-objective comparison

Mission §8 (causes before interventions), §11 (generator), §12 (isolation), §13 (comparison, fair comparison, priorities); §22 principles 5, 8, 10, 11, 12. Worktree `um-gen`, 2026-11-11, base 581be85.

Labels: **UNIT-TESTED** (Vitest, synthetic fixtures), **BROWSER-VERIFIED** (built app in Chromium against a copy of the project database), **UNTESTED**. Everything the generator states about traffic is **model output (ESTIMATED)** from the estimated demand; the model does not meet TAG M3.1 validation criteria (docs/OVERHAUL.md §24), so sizes of effects are indicative and directions under frozen demand are more reliable than absolute values.

## 1. What it does

Simulate → select a road → wait for the analysis → tab **2 · Improve & compare** → **Generate candidate scenarios**:

1. **Diagnose & propose**: classifies the run's problem locations by cause (§2) and builds candidate interventions (§3).
2. **Create N proposal scenarios**: one isolated proposal per candidate (scenario copy-on-write, docs/SCENARIOS_AND_VERSIONING.md). Drawn geometry goes through the Build drawing path; a topology check runs; physical candidates get a feasibility screening; a version "Generated (v1)" is saved with the rationale, evidence, assumptions, limitations, classes, topology and feasibility summary in its note. The baseline scenario is active again afterwards. Each proposal is an ordinary scenario: **Open** it, edit roads/lanes/junctions/signals/flyover geometry with the Build tools, revalidate (level-crossing panel, feasibility panel), rerun, save versions, restore.
3. **Evaluate on the frozen baseline**: captures (or reuses) the Compare baseline (frozen demand plan, hour, seeds) and runs every candidate with `SimulationMode.runComparison` — the same frozen demand, hour factor, seeds, warm-up and measured period. Every candidate row is checked with `checkRunInputs` against the baseline run; any differing input is listed and marks the row "≠".
4. **Comparison table**: scenarios × metrics with definition/source/noise tooltips; priority checkboxes choose the objectives; the Pareto set is highlighted (★); dominated rows say by whom and on what; an optional weighted ranking is shown beside it with its weights and normalisation; clicking a row explains improved / worse / assumptions / missing data / confidence / investigation needed.

Code: `frontend/src/engine/generator/{diagnosis,candidates,apply,evaluate,compare,session}.ts`, `frontend/src/components/ScenarioGeneratorPanel.tsx` (mounted in `RoadAnalysisPanel.ImproveView`, one line). `SimulationMode` gained `generatorContext()` and `suspendAutoAnalysis` (the batch suppresses the automatic re-analysis after each scenario switch). Nothing else changed in existing modules; `ScenarioComparison.ts` (Compare) is untouched — the generator only reads its results.

## 2. Bottleneck diagnosis (`diagnosis.ts`)

### 2.1 Evidence used (all from the run; nothing new is simulated)

| Evidence | Where it comes from | Scope |
|---|---|---|
| Delay per vehicle by cause (signal, blocked, give-way, conflict, other) | `RoadAnalysisResult.directions[].delay` (corridor micro-simulation delay attribution) | the selected road's directions, at their downstream junction |
| Signal plan the run used (phases, greens, cycle, amber/all-red) | `junctionDraft.lastRunControl` (the plan the Build junction editor starts from) | signalised junctions matched by `junctionGroups.junctionNear` |
| Demand per approach / phase | assignment volumes `areaLinkVph` × fleet mean PCU (TrafficMicroSim shares × IRC:106 factors = 1.05) | |
| Saturation flow | Indo-HCM width-based (signalTiming.ts) on lanes × 3.5 m (assumed lane width, as RoadAnalysis) | |
| Queue origin | `cause.chain` (queue traced downstream, seeds agreeing) | |
| Demand / capacity | direction `demandPcu / capacityPcu` (IRC:106 mid-block or stop line); area bottlenecks: assignment v/c | |
| Lanes in / out | network node at the location | |
| Upstream signal, cycles | `r.junctions`, `r.signalCycles` within 400 m along the direction | |
| No-alternative share | `areaBottlenecks[].noAlternativeShare` (assignment path table) | |
| Detour ratio | Dijkstra on the area graph around the stretch (≈300 m up/downstream along the busiest links) avoiding it, ÷ straight-line distance | |

### 2.2 Rules, metrics and thresholds

| Cause | Metric shown | Rule | Threshold basis |
|---|---|---|---|
| Signal timing | degree of saturation per phase x = y·C/g (g = G + amber − 2 s); Y = Σ critical y | some x > 1 while Y < 0.9 → medium/high; else signal share of delay ≥ 0.5 and cycle off Webster C0 by > 30 % → low | x > 1 = cycle failure (definition); 0.9 = signalTiming.MAX_FLOW_RATIO_SUM (Webster valid for Y < 1, Webster 1958); 30 % HYPOTHETICAL |
| Excessive demand | Y ≥ 0.9 at a signal (no fixed timing serves it; Y ≥ 1 high) or demand/capacity ≥ 1 on a stretch | | as above; capacity basis stated per finding |
| Uncoordinated signals | observed signal delay ÷ Webster uniform delay for random arrivals d1 = C(1−λ)²/(2(1−λx)) | ratio ≥ 1.3 with an upstream signal ≤ 400 m; medium if cycles differ > 10 s and ratio ≥ 1.6 | HYPOTHETICAL thresholds. Concept: HCM progression factor PF = (1−P)f_PA/(1−g/C) (HCM 2000 eq. 16-11), PF > 1 = unfavourable arrivals. **Arrival on red is inferred from delay, not counted** (the simulator records no arrival-on-green share). |
| Turning conflicts | (give-way + conflict delay) ÷ total delay | ≥ 0.4 (≥ 0.6 high), total ≥ 10 s | HYPOTHETICAL |
| Merge | lanes in → lanes out | lane drop and (demand/capacity ≥ 0.85 or merge-type delay share ≥ 0.5) | 0.85: the v/c band RoadAnalysis uses |
| Downstream spillback | share of delay stopped behind a full road ahead; seeds agreeing on the origin | ≥ 0.25; confidence high = all seeds, medium = majority, else low | RoadAnalysis traces chains from 0.25 |
| Poor connectivity | detour ratio of the best alternative route; no-alternative share | ratio ≥ 1.6 or share ≥ 0.5 | ratio: HYPOTHETICAL, after route directness (network ÷ straight-line distance; Dill 2004 quotes 1.6–1.8 as "indirect" for walking networks — a walking value, used here only as a screening point); 0.5 = RoadAnalysis NO_ALTERNATIVE_LABEL_SHARE |

Every finding carries `confidence`, the metric with its threshold and basis, supporting metrics and `certainty: 'model output (ESTIMATED)'`. Area-only locations (assignment, no delay attribution) rarely exceed medium. A location with no rule satisfied shows "No cause with enough evidence"; with no candidate at all the panel says to investigate on site (counts, queue observation) — the same restraint as `improvements.ts`.

Not covered (no evidence in the model): parking/loading, pedestrian conflicts, public-transport interactions, incorrect lane use, access management (mission §8 list). They are never reported.

## 3. Candidates (`candidates.ts`)

### 3.1 Rules (cause → candidate)

| Category | Candidate | Generated when | Edit (in the proposal) |
|---|---|---|---|
| A | Signal retiming (Webster) | signal timing / excessive demand / uncoordinated at a signal with a run plan | junction edit: same phases, greens by Webster on the run's assigned demand (`websterTiming`) |
| A | Common cycle (coordination) | uncoordinated, cycles differ > 5 s | junction edit on the upstream signal's cycle (no offsets: the simulator has no offset control) |
| A | Retime where the queue starts / signalise it | downstream spillback (root junction) | junction edit at the root |
| A | Turn ban | turning conflicts | `bannedMovements` = right turns (opposed in left-hand traffic) of the worst approach; control kept as run (`asRun`) |
| A | Signal control | turning conflicts at an unsignalised ≥ 3-arm junction | one phase per approach, Webster greens |
| A | One-way | conflicts or demand at capacity, two-way section, a parallel main road with v/c < 0.6 nearby, road drawn along the heavier direction | `isOneWay` via the Build road-field edit |
| B | Bus priority lane | excessive demand, ≥ 2 lanes in the direction | −1 general lane (lane reallocation); **bus benefit not modelled** |
| F | +1 lane where narrowest | excessive demand or merge with ≥ medium confidence | `lanesForward/lanesBackward` +1 on the binding ways |
| D | Conceptual flyover | signalised junction, excessive demand ≥ medium, through direction found | drawn flyover ~150 m up the approach → over the junction → ~150 m down the exit |
| F | New connector | poor connectivity (≥ medium, or link < 300 m) and a main road ending without a connection within 800 m | drawn 2-lane local road from that end to the nearest node of another road at the same level (40–400 m) |

E (underground) is not generated: tunnels need ground data the tool does not have; the flyover candidate's feasibility screening lists the investigations a tunnel would need equally. C (parking, loading, freight, encroachment) is not generated: no data on them in the model.

Management candidates come first; physical ones last and only with ≥ medium evidence for a capacity cause (mission §8 "do not recommend widening or new roads as the default").

### 3.2 Per candidate
Rationale with the numbers, evidence (each cause's metric/threshold/confidence), assumptions, limitations, `physical`, feasibility proposal type, cost/disruption class, land take.

### 3.3 Cost, land and disruption: never invented
- **Works cost class** 1–5 by type of works (retiming 1 … flyover 5), labelled "Ordinal class from the type of works only. Not a cost estimate". Basis for placing timing changes lowest: FHWA *Traffic Signal Timing Manual* (FHWA-HOP-08-024, 2008, ch. 1 §1.1, §1.1.5: retiming "one of the most cost effective ways…", benefits ≈ 40:1 in US studies) — https://ops.fhwa.dot.gov/publications/fhwahop08024/chapter1.htm (opened). The order of the physical classes (lane < new road < structure) is this tool's ordinal judgement, not a sourced rate.
- **Land take**: 0 only for measures without physical works (true by construction). Physical: "unknown" unless the feasibility screening infers works outside the existing right of way (`outsideExistingRoW = true`, inferred/estimated, with its certainty shown). No DP road-line data exist, so absence of a finding is never "no land".
- **Disruption class** 1–5 by works type; not a programme.

## 4. Isolation, topology, feasibility (`apply.ts`, `session.ts`)

- `applyCandidate` refuses to run unless its own proposal is active (throws for the baseline). Junction edits: `applyJunctionEdit`; road fields: `commitRoadFieldEdit` (the Build properties path, one Undo step); drawings: in the app the Build drawing path (`EditingEngine.finalizeDrawing`: auto-connect ends, `reconstructCrossings` — uncertain level crossings are flagged, not joined — flyover ramp capacity cut), headless a plain add.
- `checkCandidateTopology` builds the traffic graph of the proposal with `TrafficNetworkBuilder` and checks each drawn object: both ends share a node with other roads, a route leads onto and off it, and lists unconfirmed level crossings.
- Physical candidates: `proposalFromObject` → `fetchSiteData` → `assessFeasibility` → `saveAssessment` (the same engine/storage as the Feasibility panel, so the assessment opens there for the object); the panel shows findings, required investigations, critical flags and the right-of-way finding with its certainty.

## 5. Comparison (`compare.ts`, `evaluate.ts`)

Metric registry: mean trip time, mean delay, trips completed (throughput — not demand, not a count), share of routed traffic served, longest junction queue, speed on the selected road, total vehicle-hours in the area (assignment), fuel and CO₂ (**not available**: `engine/emissions` is not in this build; the metric reads `result.emissions` when another module provides it), works cost class, land take, disruption class. Each has definition, unit, direction, source and noise threshold (the thresholds of `ScenarioComparison.ts`).

Pareto (research decision A7): a dominates b if, on every selected objective, a is better or tied and strictly better on one. A difference is real only above the noise threshold **and** in every seed (per-seed values; queue length has none, so noise only). **An unknown value can neither dominate nor be dominated** — the pair is reported as incomparable on that objective. Weighted ranking: min-max normalised, weights shown, unknowns not ranked, with the Das & Dennis (1997) caveat, beside the Pareto set. No TOPSIS/AHP (rank reversal; research A7).

Explanation per scenario: improved / worse (beyond noise vs the baseline), assumptions (input check first; candidate assumptions), missing data (unknown / not available metrics), confidence (`compareAnalyses` confidence; forced to low when inputs differ), investigation needed (limitations + feasibility investigations).

## 6. Tests (UNIT-TESTED, `frontend/src/engine/testing/ScenarioGenerator.test.ts`, 16 cases, synthetic)

- Diagnosis: one fixture per cause (signal timing x > 1 with Y < 0.9; excessive demand Y ≥ 0.9 and v/c ≥ 1; uncoordinated with 2× random-arrival delay vs random-like arrivals; turning conflicts incl. too-little-delay; merge vs no lane drop; spillback confidence by seed agreement 3/2/1; poor connectivity; nothing → nothing).
- Webster plan keeps the phase structure.
- Pareto: set and "dominated by whom on what"; unknowns can neither dominate nor be dominated; noise band and seed disagreement are ties; weighted ranking lists weights and skips unknowns; explanations list differing inputs and force low confidence.
- End to end on a synthetic signalised grid: real run → diagnosis; forced evidence generates retiming, turn ban, bus lane, widening, flyover, connector (management first); each candidate applied in its own proposal of a real `ObjectManager`: **the baseline view and every other proposal are byte-identical after each** and the stored base objects are unchanged; applying with the baseline active throws; **drawn flyover and connector pass the topology check**; two candidates evaluated: **job inputs identical to the baseline's (same plan object, seeds, hour factor, warm-up, measured period)**, **same inputs → identical per-seed results (reproducible)**, rows' input checks match; a row with other seeds is flagged.

## 7. Browser verification

BROWSER_RESULTS

## 8. Limits and next steps

- Diagnosis covers the selected road's directions (micro-simulation) and the 3 worst area bottlenecks (assignment only). A city-wide sweep would run the analysis per hotspot (cost: one corridor run each).
- Arrival on red is inferred from delay; the simulator should record arrivals on green per approach to measure it (HCM platoon ratio).
- Signal coordination is limited to a common cycle; offsets are not modelled by the simulator.
- Turn-ban volumes and bus benefits are not modelled; mode shift and induced demand are not modelled (frozen demand by design).
- Emissions/fuel: wire `engine/emissions` output into `RoadAnalysisResult.emissions` (the registry already reads it) when that module lands.
- Candidate runs reuse the Compare baseline of the road on show; evaluating a different road needs a new baseline (the existing rule).
- Feasibility right-of-way remains unknown in most places (no DP road-line data); land take is therefore mostly "unknown" for physical candidates, which keeps them out of dominance on that objective.

## 9. Sources

| Claim | Source | Opened? |
|---|---|---|
| Webster optimum cycle and green split | Webster (1958), RRL Technical Paper 39, as implemented and cited in `signalTiming.ts` (APSEd worked example, IJERA 9(4) 2019) | via the existing cited implementation |
| Progression factor / arrival type concept | HCM 2000 ch. 16, eq. 16-11 PF = (1−P)f_PA/(1−g/C), as quoted in Strong Concepts, "Incorporating the Effects of Traffic Signal Progression into the IQA method" https://www.strongconcepts.com/Publications/06PPR2TRB.pdf and IIT Bombay NPTEL notes https://www.civil.iitb.ac.in/tvm/nptel/574_SignalLos/web/web.html | search excerpts only (not opened in full) |
| Route directness = network ÷ straight-line distance; 1.6–1.8 "indirect" (walking) | Dill, J. (2004), *Measuring network connectivity for bicycling and walking*, TRB Annual Meeting; https://web.pdx.edu/~jdill/Dill_ACSP_paper_2003.pdf | search excerpts only |
| Retiming is among the most cost-effective measures; ≈ 40:1 | FHWA Traffic Signal Timing Manual, FHWA-HOP-08-024 (2008), ch. 1 | opened |
| Weighted-sum limits; TOPSIS/AHP rank reversal | docs/RESEARCH_AND_TECHNICAL_DECISIONS.md A7 (Das & Dennis 1997; García-Cascales & Lamata 2012; Belton & Gear 1983) | bibliographic records (as stated there) |
