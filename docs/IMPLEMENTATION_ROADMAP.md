# Implementation roadmap — urban-mobility-platform

Branch `urban-mobility-platform`, created 2026-11-11 from upstream `realistic-traffic` at `e788b7f`. Not merged into `main`.
Labels: BROWSER-VERIFIED, UNIT-TESTED, HEADLESS-RUN (app code run without the page), UNTESTED.

## Why the order differs slightly from the mission's suggested phases

1. **Scenario isolation moved to the very start of Phase 1.** The audit (SYSTEM_ARCHITECTURE.md) found that editing or deleting a base road inside a proposal wrote to the baseline. Every later module (generator, comparison, workspace) depends on isolation, so it had to be fixed first (6 of 7 isolation cases failed before the fix).
2. **Traffic data before ODME.** ODME needs counts with provenance and a calibration/validation split; the Traffic Data Manager provides both.
3. **Feasibility before the generator.** Physical candidates must be screened before they are proposed, so the generator calls the feasibility engine.
4. **Calibration was not applied.** The mission forbids multipliers; the evidence-based calibration (city-wide land use and edge flows) needs data the repo does not have. It is the top continuation item.

## Status by phase

### Phase 1 — Foundation and correctness
| Item | Status | Doc |
|---|---|---|
| Repository audit, target architecture | Done | SYSTEM_ARCHITECTURE.md |
| Topology reconstruction (at-grade crossings become junctions; flyover/tunnel/layer/embankment/cutting crossings held apart; uncertain-level confirmation workflow; builder joins only where points lie on a road) | Done. UNIT-TESTED (whole-DB property test, 11 cases × 200 samples), 4 cases BROWSER-VERIFIED | TOPOLOGY_RECONSTRUCTION.md |
| Scenario copy-on-write isolation, versions, restore, frozen run inputs, assumption differences in Compare | Done. UNIT-TESTED + BROWSER-VERIFIED (Duplicate and Compare run recording not browser-run) | SCENARIOS_AND_VERSIONING.md |
| Simulation validation re-run on current code | Done (HEADLESS-RUN). Model NOT validated | ENGINEERING_VALIDATION.md |

### Phase 2 — Traffic data
| Item | Status | Doc |
|---|---|---|
| Datasets with provenance, counts (road-direction, approach, turning, hourly, day type), extensible classes, versioned IRC:106 PCU sets | Done. UNIT-TESTED + BROWSER-VERIFIED | TRAFFIC_DATA.md |
| CSV/XLSX import with preview, mapping, per-row errors | Done. BROWSER-VERIFIED | TRAFFIC_DATA.md |
| Observed vs routed vs simulated with GEH after a run | Done. BROWSER-VERIFIED (synthetic counts) | TRAFFIC_DATA.md |
| ODME (Spiess 1990) from calibration counts, held-out validation, TAG Table 5 limits | Done. UNIT-TESTED, HEADLESS-RUN, UI BROWSER-VERIFIED. Real-area result fails validation | ODME_AND_EMISSIONS.md |
| Fuel and emissions (SUMO HBEFA4, speed + acceleration + idling) | Done. UNIT-TESTED; Compare rendering UNTESTED | ODME_AND_EMISSIONS.md |

### Phase 3 — Feasibility and interventions
| Item | Status | Doc |
|---|---|---|
| Feasibility engine with six certainty labels; never returns "feasible" | Done. UNIT-TESTED + BROWSER-VERIFIED | FEASIBILITY_ENGINE.md |
| Investigation rules (22 rules, 23 investigations, tri-state) | Done | INVESTIGATION_REQUIREMENTS.md |
| Investigation Requirements Document (PDF + DOCX, 18 sections, disclaimer), evidence upload, append-only reviews with no "approved" status | Done. BROWSER-VERIFIED (PDF), DOCX UNIT-TESTED | FEASIBILITY_ENGINE.md |
| Bottleneck diagnosis by cause (7 causes) | Done. UNIT-TESTED + BROWSER-VERIFIED (Shivajinagar) | SCENARIO_GENERATOR.md |

### Phase 4 — Scenario generation
| Item | Status | Doc |
|---|---|---|
| Candidates A (signals, turn bans, one-way), B (bus lane), D (flyover), F (+lane, connector) as isolated proposals with versions and rationale | Done. 4 candidates BROWSER-VERIFIED; flyover/connector headless only | SCENARIO_GENERATOR.md |
| Candidates C (parking/loading) and E (underground) | Not implemented: no data on parking, loading or ground conditions; E can be drawn and assessed manually | — |

### Phase 5 — Comparison and workspace
| Item | Status | Doc |
|---|---|---|
| Multi-objective comparison: Pareto over chosen priorities, unknowns never dominate, noise per seed, weighted ranking only beside it | Done. UNIT-TESTED + BROWSER-VERIFIED | SCENARIO_GENERATOR.md |
| Planning projects, links, append-only audit log (ORM + SQLite triggers), decision record (not statutory approval), project report PDF/DOCX | Done. UNIT-TESTED + BROWSER-VERIFIED (PDF) | PLANNING_WORKSPACE.md |
| Responsive layout 1920 → 390 px | Done. BROWSER-VERIFIED at 6 viewports | ENGINEERING_VALIDATION.md §9 |

## Continuation plan (priority order, with reasons)

1. **Evidence-based demand (blocks model validity).** Land use for all of Pune (Pune DP 2017 / census ward data) plus edge flows cut from one city-wide assignment; then ODME with more counts split before fitting. Reason: §24 shows −30% volume and AM = PM from edge-only demand; no setting can fix that.
2. **Fresh counts.** The 2008 CMP counts are old; the Home card on 2024 bridge counts is the next data source to try. Store them through the Traffic Data Manager as measured, split calibration/validation.
3. **Authentication and actor attribution.** Reviewer and "entered by" names are self-declared; the frontend does not send `X-Actor`. Needed before any authority use.
4. **Topology open items.** cross-uncertain sample #30 (H. K. Firodia Bridge, crossing 1.7 m from its end shares a node; suspected 6.7 m node clustering); 20 roads changed by the builder rule not inspected one by one; GROUND_M = 0.5 m is a judgement.
5. **Merge model.** The gap model caps kerb merges near HCM 2010 levels (OVERHAUL §28); the same-lane safety fix awaits the user's go-ahead.
6. **Generator gaps.** Signal offsets (simulator has none), bus benefits/mode shift/induced demand, C and E candidates once data exists, flyover/connector in the browser, COEP area.
7. **Data layers.** Flood lines (WRD), ASI limits, PMC heritage list, RoW lines, utilities, boreholes: import paths exist only as "unknown" today.
8. **Turning-count validation, ODME in a Web Worker, emissions in the HTML report, review staleness after version change, audit hash chain.**

## Decisions needed from the owner
- Approve or reject the PROPOSED calibrations (ENGINEERING_VALIDATION.md §7).
- Confirm the four self-set screening thresholds (50 m water, 30 m buildings, 50 m heritage, 3 m depth) or set project values.
- Same-lane merge safety fix (OVERHAUL §28.7).
- Whether and when to push/merge this branch beyond `upstream/urban-mobility-platform`.
