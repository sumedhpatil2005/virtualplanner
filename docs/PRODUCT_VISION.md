# Product Vision — Urban Mobility & Infrastructure Planning Platform

Status: design document (2026-11-11). Nothing in this file is an implementation claim. What exists today is documented in `docs/OVERHAUL.md`, `docs/CALIBRATION.md` and `docs/ROAD_ANALYSIS.md`; architecture decisions live in `docs/SYSTEM_ARCHITECTURE.md` and `docs/RESEARCH_AND_TECHNICAL_DECISIONS.md` (owned by another workstream). Research behind the feasibility and investigation parts is in `docs/RESEARCH_FEASIBILITY_AND_INVESTIGATION.md`; the investigation generator is specified in `docs/INVESTIGATION_REQUIREMENTS.md`.

## 1. Vision

A **data-driven decision-support workspace** in which a city authority can see how its road network performs today, find out *why* it fails where it fails, try realistic alternatives in isolated scenarios, compare them on consistent assumptions, and hand a structured, honest brief to the professionals who must investigate and approve anything physical.

The platform is built for dense, constrained cities such as Pune: little free land, old building stock, heritage precincts (Pune Municipal Corporation lists 251 heritage properties in three grades — see research doc §2.4), rivers with statutory flood lines, a partly underground metro, and utilities under almost every road. In such a city the honest answer to congestion is usually *not* "widen it" or "build a flyover". The tool's job is to show the cheaper, faster, reversible options first, and when a physical intervention is still worth considering, to say plainly what is not known about it and who must find out.

## 2. Users

| User | What they need from the tool | What they must never get from it |
|---|---|---|
| **City authorities / decision makers** (municipal commissioner's office, PMC road & traffic departments, PMRDA, elected committees) | A small set of defensible alternatives with trade-offs, costs-of-uncertainty and next steps; a record of who reviewed what | A single "best" score, or a statement that something is approved, safe or buildable |
| **Urban / transport planners** | City-wide view of demand, network gaps and corridors; scenario versions they can share; links to DP road lines and reservations where imported | Map "empty space" presented as available land |
| **Traffic engineers** (traffic police engineering cell, consultants) | Junction-level diagnosis (signal timing, turning conflicts, merges, downstream blocking), editable signal plans, reproducible simulation runs, validation against counts | Model output dressed up as measured data |
| **Infrastructure / specialist teams** (structural, geotechnical, environmental, utilities, heritage) | A project-specific investigation brief: what to survey, by which method, what deliverable, which authority to verify with | A generic checklist presented as an assessment |
| **Reviewers** | A place to attach evidence, record a status and leave an auditable trail | A "reviewed" tick that reads as statutory approval |

## 3. Core workflow

```
baseline → data → diagnose → propose → feasibility → simulate → compare → investigate → review
```

1. **Baseline** — load or build the city network (OSM import + edits), freeze it as the immutable baseline. Topology is validated: a road that looks connected must be connected in the graph; a geometric crossing (bridge over road) is not a junction (principles 3–4).
2. **Data** — import and hand-enter measured counts, speeds, signal plans, turning ratios, each with provenance (who, when, how measured). Counts, demand and throughput are separate quantities (principle 7). Estimates stay labelled as estimates.
3. **Diagnose** — simulate the baseline, validate against observations, and attribute each congestion hotspot to a *cause* (signal timing, uncoordinated signals, turning conflicts, merge, downstream restriction, lane misuse, parking/loading, pedestrian conflicts, bus interaction, excess demand, missing connectivity, access management). If the model does not validate at a location, the diagnosis says so.
4. **Propose** — generate candidate interventions matched to the diagnosed cause, management-first (research doc §3). Each candidate is an editable, simulatable scenario, never a text suggestion, and never written into the baseline.
5. **Feasibility** — screen physical candidates against available spatial data (buildings, right-of-way, water bodies and flood lines, heritage zones, metro proximity, trees, utilities if known). Every finding carries a certainty label: *verified from available data / estimated / inferred / unknown / requires field investigation / requires professional assessment*. Missing data is "unknown", never "clear".
6. **Simulate** — run each scenario on the same frozen demand, period, seed and assumptions as the baseline.
7. **Compare** — multi-metric comparison (travel time, delay, queues, throughput, fuel via a speed/acceleration/idle-aware model, emissions, cost class, land take, disruption) with Pareto-front presentation and user-set priorities; differences in assumptions are shown, trade-offs are explained, nothing is called universally best.
8. **Investigate** — for any physical candidate worth pursuing, generate the investigation requirements document (18 sections, mission §10): required surveys, methods, deliverables, disciplines, standards and authorities *to identify and verify*, open risks, and blank space for findings.
9. **Review** — upload evidence, record reviewer, status and date per item. Review status is an internal planning record. It is not, and is never displayed as, engineering or statutory approval.

## 4. The eight functional modules

| # | Module | Mission § | Responsibility (one line) |
|---|---|---|---|
| 1 | **City Network Editor & Topology** | §4 | Import, edit and validate the road graph; elevation-aware connectivity (bridges/underpasses don't create false junctions); lanes, turns, signals. |
| 2 | **Traffic Data Manager** | §5 | Manual entry and import of counts/speeds/signal plans with provenance; strict separation of measured vs estimated; counts ≠ demand ≠ throughput. |
| 3 | **Traffic Simulation & Validation** | §6 | Reproducible runs (seeded), warm-up handling, validation against observations (e.g. GEH-style checks already used in OVERHAUL §24), failure reporting. |
| 4 | **Infrastructure & Spatial Feasibility Engine** | §7 | Screen proposals against spatial layers; produce certainty-labelled findings; accept user-imported layers (DP road lines, flood lines, utility maps, survey results). |
| 5 | **Intervention & Proposal Generator** | §§8, 11 | Cause → intervention-category mapping; generate conceptual geometry or control changes as candidate scenarios; revalidate topology. |
| 6 | **Scenario Isolation & Version Management** | §12 | Baseline immutability, per-scenario edits/results/history, restore previous versions, reproducible inputs. Builds on the existing `ScenarioManager`. |
| 7 | **Scenario Comparison & Multi-objective Evaluation** | §13 | Same-demand comparisons, Pareto set, priority weighting shown transparently, "what got better / worse / unknown". Builds on existing `scenarioComparison`. |
| 8 | **Investigation Requirements & Authority Workspace** | §§9, 10, 14 | Rule-based investigation brief generator (`docs/INVESTIGATION_REQUIREMENTS.md`, `frontend/src/engine/feasibility/investigationRules.json`), PDF/DOCX export, evidence upload, review records, audit history. Builds on existing `report/scenarioReport`. |

## 5. Principles (binding — mission §22)

1. Correctness over appearance.
2. City-wide reliability over fixing a few showcase junctions.
3. A road that looks connected must be connected in the simulation graph.
4. A geometric crossing must not automatically become a junction.
5. Generated proposals never damage the original network.
6. Measured traffic data stays distinguishable from estimates.
7. Counts, demand and throughput are not interchangeable.
8. Unknown physical and geological conditions stay unknown.
9. The application does not certify construction safety or replace qualified professionals.
10. Scenario comparisons use consistent assumptions and demand.
11. Every recommendation is explainable and evidence-backed.
12. Simulation outputs are reproducible.
13. Existing functionality is not sacrificed for new features.
14. Failed tests and validation results are never hidden.
15. No merge or deployment without explicit permission.

Derived product rules used across the feasibility/investigation modules:

- **Management before concrete.** The generator always produces at least one non-construction option when the diagnosed cause allows it, and ranks construction options only after it.
- **Empty map ≠ available land.** Absence of a building polygon, tree point or utility line in a dataset is recorded as *unknown*, with the dataset named.
- **Thresholds come from a source or are labelled hypothetical.** Statutory distances (e.g. AMASR 100 m / 300 m, Pune Metro 20 m NOC zone) carry their citation; engineering screening distances with no statutory basis are shown as configurable, *hypothetical* defaults.
- **Clause numbers are never invented.** Standards and authorities appear as "to identify and verify"; a specific clause is cited only when it was read.

## 6. What the tool is NOT

- **Not a certification or approval system.** It cannot grant, imply or record statutory approval (environmental clearance, heritage NOC, tree-felling permission, metro NOC, building/development permission, traffic notification). A "reviewed" status is an internal planning record only.
- **Not a structural, geotechnical or safety assessment.** It does not design foundations, linings, ventilation or fire systems, and does not say a tunnel, bridge or flyover is safe or constructible.
- **Not a land-title or acquisition tool.** It cannot establish ownership, encumbrances or compensation; land take is a screening estimate from available footprints.
- **Not a legal opinion.** Applicability of laws (e.g. whether an EIA Notification 2006 entry applies) is flagged for verification with the authority, not decided.
- **Not a substitute for field surveys.** Utility, soil, groundwater, tree and building-condition data must come from surveys commissioned by the authority; the tool tells them which surveys and why.
- **Not a demand forecast of record.** Demand used in scenarios is the frozen baseline (plus explicit, labelled changes); long-term travel-demand forecasting is out of scope unless imported.

## 7. Success criteria (product level)

- An authority can go from a congested location to (a) a cause attribution with stated confidence, (b) ≥2 management alternatives and, where relevant, physical alternatives, (c) a same-demand comparison, and (d) for any physical alternative, an investigation brief whose every line is either sourced or marked *to verify / unknown*.
- No output anywhere says or implies "approved", "safe", "feasible" (unqualified) or "land available".
- Every number in a report is tagged measured / estimated / model output / assumption / unknown.
