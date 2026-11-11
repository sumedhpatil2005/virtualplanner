# System architecture: current system audit and target architecture

Branch `urban-mobility-platform` (base `e788b7f`, upstream `realistic-traffic`). Written 2026-11-11.

**How to read this document.** Part 1 audits the code as it is. Every statement about the current system names the file it comes from. Labels:
- **CODE-READ**: taken from reading the source in this worktree; not executed for this document.
- **DOC-REPORTED**: reported in an earlier engineering record (`docs/OVERHAUL.md`, `docs/CALIBRATION.md`, `docs/ROAD_ANALYSIS.md`), with that record's own label (UNIT-TESTED / BROWSER-VERIFIED / headless).
- **SUSPECTED**: a defect inferred from reading the code that has **not** been reproduced. Each one needs a test before anyone acts on it.

Part 2 is the target architecture. It is a **design, not an implementation**: nothing in Part 2 exists yet unless it says so.

Research behind the modelling choices (OD estimation, assignment, PCU, emissions, validation, multi-objective comparison) is in `docs/RESEARCH_AND_TECHNICAL_DECISIONS.md`, part A.

---

## Part 1. The current system

### 1.1 Shape of the application

| Layer | Technology | Where | Size (lines, approx.) |
|---|---|---|---|
| Frontend | React 18 + TypeScript + Vite, CesiumJS 3D globe | `frontend/src/` | ~37,600 TS/TSX (excl. tests) |
| Engine (runs in the browser and in Web Workers) | TypeScript, no framework | `frontend/src/engine/` | most of the above |
| Backend | FastAPI + SQLAlchemy, SQLite (`DATABASE_URL` may point to PostgreSQL, untested) | `backend/` | ~3,900 Python |
| Local OSM index | SQLite built from a Geofabrik `.osm.pbf` | `backend/osm/build_index.py`, `backend/osm/index.py` | |
| Observed data | JSON files with schema checks | `backend/data/observed_*`, `backend/observed/*.py` | |
| SUMO | optional spike only (Hinjewadi) | `backend/sumo/`, `backend/api/sim_router.py` | not in the main workflow |

All traffic modelling (network build, demand, assignment, micro-simulation, calibration, comparison) runs **in the browser engine**, mostly in Web Workers (`simulation/analysis.worker.ts`, `simulation/traffic.worker.ts`). The backend stores objects and serves reference data; it does no modelling. This matters for the target design: there is one modelling implementation (TypeScript), and headless harnesses run it under Vitest/Node (`engine/testing/*.test.ts`). CODE-READ.

### 1.2 Persistence and APIs (CODE-READ)

Tables (`backend/models/models.py`):

| Table | Columns | Notes |
|---|---|---|
| `scenarios` | id, name, description, year | No parent, no version, no frozen inputs, no created_by. |
| `city_objects` | id (PK), type, name, layer_id, scenario_id (indexed), geometry_geojson, properties_json, created_at, updated_at | Every `CityObject` is one row; type-specific fields live in `properties_json`. `id` is a global primary key, so the same object id cannot exist twice (see 1.6, scenario overrides). |
| `areas` | id, name, polygon_geojson, bbox | Study areas ("Map Selected Area"). |

There is **no table** for traffic datasets, counts, demand matrices, simulation runs/results, feasibility findings, documents, reviews, users or audit history.

Endpoints (`backend/main.py` mounts all under `/api`):

| Router | Endpoints |
|---|---|
| `api/router.py` | `GET/POST /scenarios`, `DELETE /scenarios/{id}` (deletes its objects); `GET /objects?scenario_id=`, `POST /objects`, `POST /objects/batch`, `DELETE /objects/{id}`, `POST /objects/batch/delete`; `GET/POST /areas`, `DELETE /areas/{id}` |
| `api/osm_router.py` | `GET /osm/status`, `/osm/ways?bbox=`, `/osm/signals`, `/osm/buildings`, `/osm/metro`, infrastructure categories (from the local index; `TWINCITY_OSM_INDEX` selects the file) |
| `api/observed_router.py` | `GET /observed-counts`, `/observed-counts/{id}` (junction turning counts), `/diurnal-profile/{id}`, `/network-corrections`, `/network-corrections/{id}`, `/observed-screenlines/{id}` — all **read-only, file-backed** |
| `api/sim_router.py` | `GET /sim/status`, `POST /sim/spike` (SUMO, Phase-0 only) |

Observed data are curated JSON files with a validating loader (`backend/observed/counts.py`: schema `twincity.observed_counts/v1`, N/S/E/W approaches × left/straight/right, classes LV/HV/TW, cited source required, "validation never repairs data"). This is a good provenance pattern to generalise, but users cannot enter or import data: files are added by developers. CODE-READ.

Browser-side storage: IndexedDB key-value cache (`engine/storage/localCache.ts`) for OSM signals, checked OSM tiles and **the ids of OSM roads the user deleted** (`osm-deleted`). Undo/redo history is in memory only (`engine/history/HistoryManager.ts`). Simulation results, the frozen baseline demand and comparisons are in memory only (`simulation/SimulationMode.ts`, field `baselinePlan`). CODE-READ.

### 1.3 How the network is represented

**Objects** (`engine/objects/types.ts`, `CityObject` union): `road`, `junction`, `flyover`, `metro_flyover`, `metro_line`, `metro_station`, `building`, `utility`, `zone`, `gateway`.

- `RoadObject`: polyline `coordinates: [lon, lat, elevation][]`, optional `sourceCoordinates` (as imported), `sections?: RoadSectionProfile[]` (per vertex range: carriageway A/B with direction, lanes, lane width, roadside widths, median, reserved spaces, `ProvenanceMetadata` with source/confidence/verification), legacy scalar fields (`roadClass`, `laneCount`, `speedLimit`, `isOneWay`, `trafficCapacity`, …), `osmProvenance?: OSMProvenance` (`osmId`, `originalTags`, `layer`, `bridge`, `tunnel`, `roundabout`, `clip` for pieces cut at a study-area edge), `flyoverImpact` for ramp-merge capacity cuts.
- `JunctionObject`: point, `connectedRoads`, `hasSignals`, `signalTiming`; or, for an edit of an imported OSM junction, `importedJunction: JunctionEditSpec` (control, phases, priority, banned turns, lane connections) keyed by the logical junction's stable id (`simulation/junctionControl.ts`).
- `FlyoverObject` / `MetroFlyoverObject`: drawn decks with `elevation`, `pierSpacing`, `groundCoordinates`, `feasibilityResult` (from `simulation/BridgeFeasibilityEngine.ts`), `surfaceRoadIds`.
- `ZoneObject` / `GatewayObject`: demand zones and cordon gateways with `provenance.source: 'estimated' | 'synthetic' | 'observed' | 'survey'`.
- `UtilityObject` (`utilityType`, `depth`) exists but nothing reads it for feasibility.

**Heights / grade separation.** OSM gives `layer`, `bridge`, `tunnel` but no heights. `objects/bridgeElevation.ts` derives deck heights per layer (deck over a known lower road stands at its layer height; ramps descend at `RAMP_GRADE` onto the approach roads until the first at-grade junction; decks over "nothing known" use a conservative profile; tunnels via `isOsmTunnel`, layer < 0, are lowered; user-drawn/edited roads are never raised). Heights are worked out in memory on every load (`ObjectManager.liftBridges`) and never written back. CODE-READ.

**The traffic graph is derived, not stored.** `simulation/TrafficNetworkBuilder.ts` (`build(roads)`) turns the visible drivable objects (`road | flyover | metro_flyover`, see `StudyAreaExplorer.ts`, `SimulationManager.ts`) into `TrafficNetwork { nodes, edges }` (`objects/trafficTypes.ts`) every time:
- Roads with intact OSM topology (`objects/osmTopology.ts: hasOsmTopology` — imported, ends unmoved, no `geometryModified`) join **only at OSM nodes they share**, never by crossing.
- User-drawn or reshaped roads join by geometry: segment intersections and endpoints within the builder tolerance (~6 m, spatial-hash buckets).
- A crossing is a junction only when the two roads are at the same level: |Δz| ≤ `GRADE_SEPARATION_M = 3.0` m and the same OSM `layer`; otherwise it is recorded as a `GradeSeparation` (bridge/tunnel/mapping gap) and not connected. A shared OSM node joins at any height (bridge end nodes). CODE-READ; heading and zero-length fixes UNIT-TESTED per OVERHAUL §28.1.
- Edges are per road piece between nodes (`roadId_segmentIdx`), with lanes, direction, speed, capacity.

**Editing → topology.** `editing/EditingEngine.ts`: `finalizeDrawing` carries new road ends onto a nearby road at the same level (`editing/autoConnect.ts`, `AUTO_CONNECT_M = 25` m), then `insertJunctionIntoIntersectedRoads` inserts a vertex into an existing road **only where the new line's two endpoints** land mid-segment at the same level (|Δz| ≤ `SAME_LEVEL_M`); `connectRoadEnd` / `editing/roadGaps.ts` join near-miss ends. Mid-line crossings of a drawn road are not split in the object model; they become junctions only if the builder's geometric intersection finds them at the same level. All changes of one action go into one `batch` history diff. Edit isolation and exact undo/redo across a stratified sample of road kinds are tested by `engine/testing/NetworkEditIsolation.test.ts` + `editHarness.ts` (DOC-REPORTED §27, UNIT-TESTED).

**Junctions as logical groups.** `simulation/junctionGroups.ts` groups OSM nodes and short internal pieces (signal boxes, dual-carriageway squares, slip-lane ends) into one logical junction with approaches and exits; it never changes geometry. Network-wide counts and fixes: OVERHAUL §26 (UNIT-TESTED, headless over the whole DB network). Signal boxes run as one controller (OVERHAUL §28.1, UNIT-TESTED).

**Signals.** Mapped `highway=traffic_signals` from the local OSM index (`/api/osm/signals`, cached in IndexedDB); when unavailable the app **estimates** signals from road class (OVERHAUL §24 notes 14 of 182 runs fell back). Fixed-time plans from Webster (`simulation/signalTiming.ts`), editable per junction (`junctionControl.ts`, `editing/junctionDraft.ts`). CODE-READ.

**Corrections layer.** `backend/data/network_corrections/*.json` applied by `simulation/networkCorrections.ts` (versioned local fixes to OSM; public OSM is never edited; proposed OSM edits in `docs/PROPOSED_OSM_EDITS.md`). CODE-READ.

### 1.4 How demand, vehicles, routes and results are represented

- **Vehicle classes** (`simulation/TrafficMicroSim.ts`, `VEHICLE_TYPES`): `two_wheeler` (share 0.520, PCU 0.75), `car` (0.312, 1.0), `auto` (0.112, 2.0), `bus` (0.035, 2.2), `truck` (0.021, 2.2), legacy `bus_auto`. PCU values match IRC:106-1990 Table 1 at the composition each class has (≥10%: TW 0.75, auto 2.0; <10%: truck/bus 2.2) — see research doc A4. There is no LCV class and no extensible category list.
- **Demand** (`simulation/AreaDemand.ts`, `StudyDemand.ts`, `DemandMatrixCompiler.ts`, `tripRates.ts`, `modeSplit.ts`): a study-area plan in three labelled parts — internal trips (Erlang-2 trip-length deterrence with CMP 2018 mean trip lengths), land-use ↔ edge trips, and through traffic on arterial/collector roads crossing the cordon, the last derived from **assumed peak-hour flow per lane at the area edge by road class**. Trip rates from Pune CMP 2018/2008. `DemandProvenance` labels: project-estimate, synthetic, calibrated, hypothetical. Time of day: `simulation/timeOfDay.ts` scales a peak plan by the Pune diurnal profile (`backend/data/diurnal`).
- **Assignment** (`simulation/staticAssignment.ts`): Frank-Wolfe deterministic user equilibrium, BPR link cost `t0(1+0.15(x/c)^4)`, `t0` = length/free speed + Webster uniform signal delay; capacity in PCU/h = min(IRC:106 mid-block capacity from `roadParameters.ts`, Indo-HCM width-based saturation flow × g/C at signalised approaches); stores path flows for select-link.
- **Micro-simulation** (`simulation/TrafficMicroSim.ts`, 3,420 lines): IDM car-following, left-hand traffic, real lane counts, signals/priority/gap acceptance, seeded RNG streams keyed by identity (common random numbers between baseline and proposal), gridlock removals counted. Run only on the **corridor neighbourhood** of a selected road, fed by assignment paths (`simulation/analysisJob.ts`, default warm-up 300 s, measure 900 s, several seeds).
- **Results**: `RoadAnalysisResult` (`simulation/RoadAnalysis.ts`: Indo-HCM urban-street LOS from speed/FFS, delay attribution by cause), assignment volumes/v/c, comparison (`simulation/ScenarioComparison.ts`), improvement suggestions traced to findings (`simulation/improvements.ts`), report export (`engine/report/scenarioReport.ts`: printable HTML + CSV, HCM 2000 control-delay LOS marked indicative). All in memory; nothing is persisted with its inputs.
- **Calibration/validation** (`engine/calibration/`): GEH (`geh.ts`), bounded IPF scaling of OD trips to junction turning counts with count-seeded trips (`ipf.ts`, `calibration.ts`, `junctionMovements.ts`), screen lines (`screenlines.ts`), observed counts loader (`observedCounts.ts`). Validation harnesses are opt-in tests (`NetworkValidation.test.ts` with `VAL24=1`, `JunctionValidation.test.ts` with `VAL_DUMP`).

### 1.5 End-to-end workflow as implemented (CODE-READ)

1. **Import**: "Map Selected Area" (`editing/studyAreaImport.ts`, `editing/LocalOsmIndex.ts` → `/api/osm/ways`; `editing/OverpassClient.ts` as fallback, unreachable from the sandbox) clips OSM ways to the area polygon, creates `RoadObject`s (`scenarioId = 'base'`), drops non-drivable ways (`editing/osmDrivability.ts`), skips user-deleted OSM ids, saves to `/api/objects/batch`.
2. **Load**: `ObjectManager` loads `/api/objects`, repairs sections (`objects/roadSections.ts`), derives bridge heights.
3. **Edit** (Build mode): draw roads/flyovers/junctions, edit properties (`editing/roadEdits.ts: commitRoadFieldEdit`, lane-scope rules §16/§27.7), junction editor (`components/JunctionPanel.tsx`), delete; every change is a `HistoryDiff` and is synced to the backend per object.
4. **Simulate** (Simulation mode, network read-only): select a road → `SimulationMode` builds the area network, demand plan (estimate, optionally calibrated to counts), assignment, corridor micro-simulation on several seeds, `RoadAnalysis`.
5. **Compare**: "save baseline" freezes the demand plan (`structuredClone(plan)`), then the proposal network is analysed on the same frozen demand, hour and seeds (`compareAnalyses`); verdict better/worse/mixed/no_change with seed-consistency rules.
6. **Report**: HTML/CSV export.

### 1.6 What already satisfies parts of the vision (reuse, do not duplicate)

| Vision module | Existing pieces to reuse | Evidence |
|---|---|---|
| 1 Network editor & topology | `TrafficNetworkBuilder` (level-aware, OSM-node topology, grade-separation records), `autoConnect.ts`, `roadGaps.ts`, `EditingEngine.insertJunctionIntoIntersectedRoads`, `bridgeElevation.ts`, `junctionGroups.ts`, `HistoryManager` batch diffs, `NetworkEditIsolation.test.ts` harness, `networkCorrections.ts` | OVERHAUL §21, §26, §27, §28 (UNIT-TESTED; some BROWSER-VERIFIED) |
| 2 Traffic data manager | `backend/observed/counts.py` validating loader and schema pattern, `observedCounts.ts`, `screenlines.ts`, diurnal profile pipeline, PCU factors stated per file, `DemandProvenance`/`ProvenanceMetadata` types | CALIBRATION.md §1 |
| 3 Simulation engine | `staticAssignment.ts`, `TrafficMicroSim.ts`, `analysisJob.ts` (deterministic, worker-safe), `calibration/*`, `NetworkValidation.test.ts` | OVERHAUL §18–§24 |
| 4 Feasibility | `BridgeFeasibilityEngine.ts` (IRC:SP-73 ramp grade, median width for piers — constants cited in file, not re-verified here), `RoadSectionProfile` (ROW width, reserved spaces, `wideningPossible`, provenance/confidence), `UtilityObject`, OSM buildings/metro layers via `/api/osm/*` | CODE-READ |
| 5 Investigation documents | `report/scenarioReport.ts` (source-carrying HTML/CSV) as the rendering pattern | CODE-READ |
| 6 Scenario generator | `improvements.ts` (suggestions traced to analysis findings; "investigate" when the cause is unclear) as the diagnosis front end | OVERHAUL §7 |
| 7 Comparison | `ScenarioComparison.ts` (same frozen demand, seeds, noise threshold, "nothing seriously worse elsewhere") | OVERHAUL §8 |
| 8 Workspace | `ScenarioManager`, `scenarios` table | CODE-READ |

### 1.7 Gaps, technical debt and wrong assumptions

**Scenario isolation and versioning**
1. **SUSPECTED — base objects edited in place while a proposal is active.** `editing/roadEdits.ts: commitRoadFieldEdit` and `history/HistoryManager.ts: deleteWithHistory` call `objects.update` / `objects.delete` on whatever object is selected, with no copy-on-write into the active scenario; `ObjectManager.delete` on a base object also records it in `osm-deleted`. If the UI lets a user select and edit a base road while a proposal is active, the baseline itself changes. `filterObjectsForScenario` supports overrides (same id in the proposal) but nothing in these paths creates one. Must be reproduced first (`EditIsolation.test.ts` is about unrelated objects, not about base-vs-proposal).
2. **SUSPECTED — override ids cannot coexist with the base row.** `city_objects.id` is the primary key, and override-by-same-id needs two rows with one id. `TwinCityEngine.createScenarioFrom` copies a proposal's objects with new ids `stem__scnId`, so a copied override would no longer replace its base object (it would appear next to it).
3. **SUSPECTED — no way to delete a base object inside a proposal** (no tombstone); and lane-scope edits read `objects.getAll()` across all scenarios (`roadEdits.ts` line ~265).
4. No scenario versions, parent/branch, restore, frozen inputs (demand, hour, seeds, code version), or persisted results; the baseline freeze lives only in memory (`SimulationMode.baselinePlan`). Reproducibility across sessions is not possible.
5. `scenarios/scenarioComparison.ts` (population/water/lane-km deltas) duplicates the name of `simulation/ScenarioComparison.ts` (traffic comparison) — two unrelated "comparisons".

**Topology**
6. The object model is not split at mid-line crossings; topology is recomputed by the builder from geometry each run. This is a sound "derived graph" design, but it means connectivity is only known after a build, the UI cannot show the user which crossings became junctions, and there is no stored node identity for drawn roads (only OSM node ids and positional junction ids).
7. Elevation is inferred from `layer`/`bridge`/`tunnel` plus heuristics; there is no confirmation workflow for uncertain crossings (mission §4 asks for one). `GradeSeparation` records exist and could feed it.
8. Two tolerances must stay consistent by convention: `autoConnect.ts` (25 m, Δz) and the builder (~6 m, `GRADE_SEPARATION_M`). No single topology module owns them.

**Traffic data and demand**
9. No user data entry/import, no dataset/provenance tables, no directional/hourly/weekday-weekend structure beyond the curated junction-count JSON. Vehicle classes are fixed (no LCV; HV lumps bus/truck in counts).
10. Through traffic at the cordon comes from **assumed per-lane flows by road class** (`AreaDemand.ts`), i.e. an edge-only estimate; counts are used only by IPF scaling at counted junctions (bounded 0.25–4) inside one study area. There is no network-wide matrix estimation against link/screen-line counts, and no check of how far estimation moves the prior (TAG M3.1 Table 5).
11. Demand vs count vs throughput are kept apart in the comparison and accounting code (OVERHAUL §20), but no data model enforces the distinction for user-supplied data.

**Model accuracy (separate from software correctness)**
12. DOC-REPORTED (OVERHAUL §24.2, headless, 2026-11-09 code): GEH < 5 at 0 of 15 sites; river screen line 54,504 vs 78,357 veh/h (−30%); section speeds 7/21 within 15%; city speed by hour 1/9. **The model does not meet TAG M3.1 criteria.** Not re-run for this document.
13. **Wrong assumption in an earlier record:** OVERHAUL §24.2 says "FHWA Traffic Analysis Toolbox Vol. III uses the same targets" as TAG M3.1. The 2019 update of Vol. III (FHWA-HOP-18-036) does not use GEH thresholds for calibration; it uses variation envelopes built from several days of observed data (Criteria I–IV: 95% of simulated outputs within ±1.96σ, two-thirds within 1σ, bounded dynamic absolute and systematic error). Source and detail: research doc A5. The 2004 edition's GEH-based targets should not be attributed to the 2019 guide.
14. Micro-simulation runs only on a corridor neighbourhood; city-wide behaviour comes from static assignment (no dynamic loading, no spillback across the area).

**Missing modules**
15. No fuel/emissions model (no reference to fuel, CO2 or emissions anywhere in `frontend/src`).
16. No feasibility data layers (land use, ROW, heritage, water bodies, utilities as data), no certainty labels on findings, no investigation documents, no reviews/evidence, no users or audit trail. `BridgeFeasibilityEngine` returns pass/warn/fail with no "unknown / requires field investigation" state.
17. Backend has no authentication; CORS `*` (`main.py`, comment says restrict in production).

---

## Part 2. Target architecture

### 2.1 Principles

- **One modular monolith.** Keep the current split: TypeScript engine for modelling (browser + workers + headless Node for tests/validation), FastAPI for persistence, provenance, reference data and document generation. No microservices. New backend code goes into routers + modules in `backend/`; new engine code into `frontend/src/engine/<module>/`.
- **Derived graph stays derived**, but topology gets one owner module and a stored, inspectable result per scenario version.
- **Immutable inputs, reproducible runs.** A run is identified by (scenario version, demand version, datasets used, period, seeds, engine version). Results are stored with that key.
- **Certainty is data.** Every count, demand cell, feasibility finding and document item carries a `certainty` / `source_kind` field; the UI and reports render it; code never upgrades it.

### 2.2 The eight modules mapped onto the codebase

| # | Module | Engine (TypeScript) | Backend (Python) | UI |
|---|---|---|---|---|
| 1 | City Network Editor & topology | New `engine/topology/` owning: `TopologyService.reconcile(changedIds, scenarioView)` → splits/junction updates as one history batch; level rules moved from `TrafficNetworkBuilder` + `autoConnect` into `topology/levels.ts` (single `GRADE_SEPARATION_M`, `SAME_LEVEL_M`, snap tolerances); `topology/validate.ts` (zero-length, duplicate nodes, visually-near-but-disconnected ends from `roadGaps.ts`, crossings without junction or grade-separation decision). Reuse `TrafficNetworkBuilder`, `bridgeElevation`, `junctionGroups`, `HistoryManager`. | `crossing_decisions` table (user confirmations of uncertain crossings) | Build mode + "Topology check" panel listing `GradeSeparation`s and uncertain crossings for confirm/correct |
| 2 | Traffic Data Manager | `engine/data/` (`pcu.ts` with versioned factor sets, `countsModel.ts` types mirroring the API) | `backend/traffic_data/` (import, validation, column mapping, CSV/XLSX via `openpyxl`), router `/api/traffic-data` | Data panel: datasets list, manual entry grid, import wizard with preview/errors |
| 3 | Simulation engine | Existing `simulation/*` + new `engine/demand/odme.ts` (matrix estimation, see research A2), `engine/emissions/` (research A6), `engine/validation/` (lift the opt-in harness logic into a library that both the UI and tests call) | `runs` tables (2.4); run artefacts stored as JSON blobs | Simulate panel shows run id, inputs, validation table |
| 4 | Feasibility engine | `engine/feasibility/` — rules over geometry + layers returning `Finding`s; `BridgeFeasibilityEngine` becomes one rule set and gains `unknown` | `backend/feasibility/` layer import (GeoJSON), `/api/feasibility` | Findings list on the proposal, each with certainty and evidence |
| 5 | Investigation & documents | — | `backend/documents/` templates per proposal type (logic in `docs/INVESTIGATION_REQUIREMENTS.md`), DOCX via `python-docx`, PDF via HTML→PDF (choice to be confirmed; no new heavy dependency without a decision record) | Document view, download, evidence upload |
| 6 | Scenario generator | `engine/generator/` — diagnosis from `RoadAnalysis` delay attribution + `improvements.ts`, candidate builders (signal plan, turn ban, one-way, lane-use, conceptual link/flyover geometry) that emit **scenario edits**, never base edits; each candidate passes `topology/validate` before simulation | `generated_by` / rationale columns on scenario versions | "Candidates" list; open → normal Build editing |
| 7 | Comparison & optimisation | Extend `simulation/ScenarioComparison.ts`: metric registry (definition, unit, source, direction), Pareto filter, optional user-weighted view shown **beside** the Pareto set (research A7) | `comparisons` table | Side-by-side table, trade-off chart, "what got worse" |
| 8 | Planning & approval workspace | — | `projects`, `reviews`, `evidence`, `audit_log`; simple user identity (header-based to start; real auth is a separate decision) | Project home, review history |

### 2.3 Data flow

```
OSM index / user drawing ──► objects (city_objects, scenario_id, version)
                                   │  TopologyService.reconcile (history batch)
                                   ▼
                        scenario version (frozen object set)
                                   │  TrafficNetworkBuilder (derived graph) + topology/validate
traffic datasets ──► counts (veh/h by class, PCU via factor set) ──┐
       │ (measured / estimated / manual, never merged silently)     │
       ▼                                                            ▼
prior demand (AreaDemand / zones) ──► ODME (constrained by counts, TAG Table 5 limits) ──► demand version
                                   │
                                   ▼
            run = (scenario version, demand version, period, seeds, engine version)
            static assignment ──► corridor/area micro-sim ──► results + emissions
                                   │
            validation (independent counts only) ──► validation report (pass/fail kept)
                                   │
            comparison (same demand version & period unless user changes them; differences listed)
                                   │
            feasibility findings + investigation document + reviews (certainty labels throughout)
```

Counts used to estimate demand are kept separate from counts held back for validation (TAG M3.1 §3.3.8 asks for the two to be reported separately).

### 2.4 Proposed tables (SQLAlchemy, SQLite first; additive migrations, existing tables untouched)

```
projects(id, name, description, created_by, created_at)

scenarios            + project_id, parent_scenario_id, kind('baseline'|'proposal'|'generated'), created_by
scenario_versions(id, scenario_id, number, parent_version_id, label, created_by, created_at,
                  object_snapshot_hash, generated_by NULL, rationale_json NULL)
scenario_version_objects(version_id, object_id, op('upsert'|'delete'), object_json)   -- delta vs base version
    -- fixes 1.7 #2/#3: overrides and deletions keyed by (version, object_id), no PK clash with base rows

traffic_datasets(id, project_id, name, provider, collected_from, collected_to, location_desc,
                 source_kind('measured'|'estimated'|'manual'), method, assumptions, adjustments,
                 pcu_factor_set_id, entered_by, imported_file_name, imported_file_sha256, created_at)
count_records(id, dataset_id, ref_kind('road_direction'|'junction_approach'|'turn'|'screenline'),
              road_ref, osm_way_id, from_ref, to_ref, direction, lon, lat,
              period_start, period_end, day_type('weekday'|'saturday'|'sunday'|'holiday'),
              vehicle_class, count, unit('veh'|'veh/h'|'pcu/h'), quality_flag, notes)
vehicle_classes(id, code, label, default_pcu_set_id)          -- extensible: 2W, car, auto, bus, LCV, HCV, other
pcu_factor_sets(id, name, source_citation, context('midblock'|'signalised'), factors_json)

demand_versions(id, project_id, method('estimate'|'odme'|'imported'), prior_version_id,
                datasets_used_json, estimation_report_json, created_at)
runs(id, scenario_version_id, demand_version_id, period, seeds_json, engine_version, options_json,
     status, started_at, finished_at)
run_results(run_id, kind('assignment'|'microsim'|'emissions'|'validation'), payload_json)
comparisons(id, baseline_run_id, proposal_run_id, assumptions_diff_json, result_json)

feasibility_layers(id, project_id, kind, source, licence, collected_at, geometry_ref)
feasibility_findings(id, scenario_version_id, rule_id, subject_ref,
                     certainty('verified'|'estimated'|'inferred'|'unknown'|'field_investigation'|'professional_assessment'),
                     statement, evidence_json, created_at)
investigation_documents(id, scenario_version_id, proposal_type, template_version, generated_at,
                        file_path, file_sha256)
evidence(id, document_id, item_key, file_path, file_sha256, uploaded_by, uploaded_at, description)
reviews(id, document_id, item_key NULL, reviewer, discipline, status('not_started'|'in_review'|'information_received'|'reviewed'),
        comment, created_at)                                  -- 'reviewed' never means approved; no approval status exists
audit_log(id, actor, action, entity, entity_id, before_hash, after_hash, at)
```

### 2.5 Proposed APIs (all under `/api`)

| Area | Endpoints |
|---|---|
| Projects | `GET/POST /projects`, `GET /projects/{id}` |
| Scenario versions | `POST /scenarios/{id}/versions` (freeze current edits), `GET /scenarios/{id}/versions`, `GET /scenario-versions/{vid}/objects` (resolved view), `POST /scenario-versions/{vid}/restore` (creates a new version; never rewrites history) |
| Traffic data | `GET/POST /traffic-data/datasets`, `POST /traffic-data/datasets/{id}/records` (manual), `POST /traffic-data/import/preview` (file + column map → parsed rows + errors, nothing saved), `POST /traffic-data/import/commit`, `GET /traffic-data/pcu-sets` |
| Demand & runs | `POST /demand-versions`, `POST /runs` (store inputs + results posted by the engine), `GET /runs/{id}`, `POST /comparisons` |
| Feasibility | `POST /feasibility/layers` (GeoJSON import), `POST /scenario-versions/{vid}/findings`, `GET …/findings` |
| Documents & reviews | `POST /scenario-versions/{vid}/documents` (generate), `GET /documents/{id}/download?format=docx|pdf`, `POST /documents/{id}/evidence`, `POST /documents/{id}/reviews`, `GET /documents/{id}/reviews` |

Validation rules (Pydantic): non-negative integer counts, period_end > period_start, known vehicle class, unit consistent with period, coordinates in a configured bounding box, `source_kind` required; import preview returns row-level errors and never repairs data (same rule as `observed/counts.py`).

### 2.6 Order of work (dependency-aware)

1. Reproduce 1.7 #1–#3 with tests; if confirmed, fix with copy-on-write into the active scenario plus `scenario_version_objects` (this blocks modules 6–8).
2. `engine/topology/` consolidation and the topology check panel (module 1).
3. Traffic data tables, import, PCU sets (module 2), then ODME (module 3) — ODME needs counts with references to network edges.
4. Run persistence and validation library (module 3), emissions (module 3/7).
5. Feasibility findings with certainty (module 4), documents (module 5).
6. Generator (module 6) only after isolation and validation exist; comparison/Pareto (module 7); workspace/reviews (module 8).

### 2.7 Risks

- Copy-on-write changes object ids seen by history and comparisons; history diffs must record scenario id.
- Moving results to the backend increases payload size (path flows); store summaries plus optional compressed blobs.
- ODME can "fit" counts with implausible matrices (research A2); must ship with TAG Table 5 change limits and an independent validation set, or it will be used to manufacture agreement.
- Emissions factors for Indian fleets are thin (research A6); outputs must carry the factor source and be labelled estimates.
