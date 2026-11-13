# UrbanOS — Codebase & UI audit (BEFORE state)

Branch `urbanos-city-planning-redesign` at `837183c` (= `urban-mobility-platform` HEAD), read-only. Audited 2026-11-13.
Method: CODE-READ of `frontend/src` and `backend/`, the module docs in `docs/`, and BROWSER screenshots of the built app (Chromium/SwiftShader, built with `VITE_API_BASE=http://127.0.0.1:8311`, served on :4511, backend :8311 on a **copy** of `backend/twincity.db` + OSM index + feasibility layers DB). No code changed, no commits.
Verification labels below are copied from the module docs (docs/IMPLEMENTATION_ROADMAP.md, docs/ENGINEERING_VALIDATION.md §3/§10); this audit did not re-run tests.

**Non-negotiable carry-over:** docs/ENGINEERING_VALIDATION.md §0/§5 — *the traffic model is NOT validated*; it FAILS every testable UK DfT TAG M3.1 criterion (counts GEH<5 0/15, river screen line −30.5%, section speeds 4/21, corridor-hour speeds 27/120, city speed 2/9). Every traffic/emissions number the UI shows is ESTIMATED model output for comparing options on the same inputs. The redesign must keep this visible (today it is shown via Simulate panel caveats/"Source and caveats" disclosures and ODME/count-check cards).

---

## 1. Architecture map

### 1.1 Frontend (React 19 + Vite 8 + TS, Tailwind v4, CesiumJS 1.143, lucide-react icons)
`frontend/src` ≈ 60.6k lines incl. tests (93 test files under `engine/testing/`).

```
main.tsx (13) → App.tsx (200)            ← the whole shell; no router, no layout component
├─ Viewport3D (128)                      ← Cesium viewer host; engineInstance owns the scene
├─ top-left dock (inline in App)
│   ├─ "TwinCity" card + Keyboard button (ShortcutsOverlay) + ConnectionBadge
│   ├─ ScenarioSelector (251) ── ScenarioVersions (141)        ← base/proposal select, New/Duplicate/Edit/Delete, "Compare with Base City", versions
│   ├─ pill "Traffic data"     → TrafficDataPanel (502)         (forces View mode)
│   ├─ pill "Planning projects"→ PlanningPanel (272)            (forces View mode)
│   └─ (Build only) Toolbar (466) ← tools.ts (TOOLS list)       ← centred top on wide windows via CSS
├─ ModeBar (44)                          ← View | Build | Simulate (top centre)
├─ panel-dock (right, ONE panel chosen by a ternary in App.tsx L74-81)
│   ├─ simulate            → SimulationPanel (333)
│   │     ├─ tabs: 1 Understand / 2 Improve & compare / 3 Details
│   │     ├─ RoadAnalysisPanel (499) + RoadAnalysisPieces (452): UnderstandView, ImproveView, DemandEvidence, CountChecks, TimesOfDay
│   │     │     ├─ ScenarioGeneratorPanel (170)  ← generator/Pareto lives INSIDE Improve tab
│   │     │     ├─ OdmeAndEmissions (136): OdmeCard, EmissionsCard, EmissionsCompare
│   │     │     ├─ TrafficCountChecks (96), ScenarioDeltaTable (108), JunctionCompareCard (49), LaneBottleneckCard (87)
│   │     ├─ CalibrationPanel (226), TimeOfDayPanel (70)
│   ├─ build + ljunction:* → JunctionPanel (235)  (imported junction editor)
│   ├─ build + selection   → PropertiesPanel (2330!)  ← inspector for every object type
│   │     ├─ FeasibilityPanel (310)  ← only reachable here, only for road/flyover/metro_flyover objects (base or proposal; `feasibility/proposal.ts isProposalObject` checks type, not scenario) via "Feasibility & investigations →"
│   │     ├─ RoadGapPanel (77), LevelCrossingPanel (41), LaneScopeControl (91)+laneScopeStore
│   ├─ view + data open    → TrafficDataPanel
│   ├─ view + plan open    → PlanningPanel
│   └─ view                → InfoPanel (299) "Your projects" list / object details
├─ layers-dock: "Layers" pill → LayerManager (109) (bottom-left), MapCompass (50)
├─ SimulationHud (47) (simulate only), toast (window.showToast global), ConfirmDialog, ShortcutsOverlay, CoachMarks
└─ ui/: kit.tsx (SidePanel, PanelHeader, PanelBody, Section, Figure, Facts, Button, Segmented, Notice),
        viz.tsx (Chip, LosBadge, Meter, StackedBar, KpiCard, Disclosure, InfoToggle, Card), SourceBadge, dataSource, ErrorBoundary
```
- **hooks/**: `useAppMode`/`useSelectedId` (useSyncExternalStore over the engine), `useSimulationMode`, `useKeyboardShortcuts` (1–9 tool hotkeys, Delete, Ctrl+Z/Y, `?`), `useCameraHeading`.
- **lib/**: `api.ts` (211: `API_BASE` from `VITE_API_BASE` default `http://localhost:8000`, `apiGet/Post/Delete/Batch`, `ApiError`, `connectionState` store feeding ConnectionBadge), `cesiumToken.ts`, `format.ts`.
- **engine/** (framework-free TS, the real app): `TwinCityEngine.ts` (2120; singleton `engineInstance`, also on `window.engineInstance`; app mode, selection, scenarios, junction editor, camera), `editing/` (EditingEngine 1775, SnapManager, roadEdits, junctionEdits, levelCrossings, roadGaps, studyAreaImport, LocalOsmIndex, OverpassClient), `objects/` (ObjectManager 779, types 351, bridgeElevation, osmTopology…), `simulation/` (TrafficMicroSim 3431, SimulationMode 1958, StudyAreaExplorer 1015, RoadAnalysis 980, DemandMatrixCompiler 842, TrafficNetworkBuilder 713, staticAssignment, junctionControl/Groups, AreaDemand, ScenarioComparison, BridgeFeasibilityEngine), `rendering/` (RenderManager, ProceduralGeometryGenerator 2364, renderers/*, vehicles/), `scenarios/` (ScenarioManager, versions, scenarioFilter, scenarioComparison), `calibration/` (geh, ipf, screenlines, observedCounts, junctionMovements), `demand/` (odme, odmeAssignment), `emissions/` (hbefa4, emissions), `data/` (trafficData, countValidation, odmeConstraints), `feasibility/` (feasibilityApi, siteAssessment, investigationPlanner, investigationRules.json, proposal, geometry), `generator/` (diagnosis, candidates, apply, evaluate, compare, session — `window.generatorSession`), `planning/planningApi.ts`, `report/scenarioReport.ts`, `history/HistoryManager`, `layers/LayerManager`, `selection/`, `storage/localCache`, `terrain/`.
- **State management:** no Redux/router. `engineInstance` is the single source of truth with hand-rolled `onChange/subscribe` emitters; React reads it via `useSyncExternalStore` or `useEffect` + `setVersion`. `zustand` and `@tanstack/react-query` are in package.json but **unused** (grep finds no import). Panel open/closed state is local `useState` in App.tsx. Toasts via a `window.showToast` global.
- **How modes work:** `AppMode = 'view' | 'build' | 'simulate'` held by the engine (`setAppMode`). Simulate locks editing (`EditingEngine.setLocked`, select only). Traffic data and Planning projects are *not* modes: their pills force View mode and toggle booleans. The right panel is one ternary (precedence: simulate > junction editor > PropertiesPanel > data > plan > InfoPanel).

### 1.2 Build Mode tools (frontend/src/components/tools.ts, EditingEngine.ts L560-820)

| # | Hotkey | Short label / tooltip | Icon (lucide) | What it really creates | Misleading? |
|---|---|---|---|---|---|
|1|1| Select / "Select Object" | MousePointer | selection | — |
|2|2| Road / "Draw Road Path" | Route | `road` at ground; class highway/arterial/collector/local sets width, lanes, speed, capacity defaults; splits crossed roads into junctions; topology reconstruction | OK; only Settings = class |
|3|3| Building / "Draw Building Footprint" | Building | `building`; **floors = `Math.random()*15+2`**, population = floors×15, water 150 L/p/d, electricity 6 kWh/p/d, year 2026 | **Yes — random height/population is fabricated data**, "Zoning" dropdown is really building use |
|4|4| Junction / "Create Road Junction" | **Compass** | `junction` joining ≥2 approaches at one level, signals on, 90 s cycle | Icon = compass (also the app logo and MapCompass) |
|5|5| Flyover / "Draw Elevated Flyover" | **Layers** | `flyover`, arterial 4-lane, deck 6 m, piers 30 m; ramps profiled | Icon = Layers (same as the Layers button) |
|6|6| Metro / "Draw Elevated Metro Line" | Train | `metro_line`, 2 tracks, **always elevated 12 m** | No underground option at all |
|7|7| Metro+road / "Draw Metro + Flyover" | **Hammer** | `metro_flyover` double-deck (road 6 m + metro 12 m) | Hammer = the Build mode icon; label unclear |
|8|8| Station / "Place Metro Station" | MapPin | `metro_station` elevated 12 m, aligns to nearest track | Name says "Elevated Metro Station #…" |
|9|9| Utility / "Lay Utility Conduit" | **Settings (gear)** | `utility` water/electricity/sewage/fiber, **depth fixed 1.5 m**, capacity 100 | Gear icon reads as "settings"; the only subsurface tool, buried as #9; no depth/diameter/profile; Layers lists "Gas Mains" but no gas type exists |
|10|—| Zone / "Create Demand Zone (Polygon)" | Square | `zone` with **default 10,000 pop / 5,000 jobs**, land-use mix 50/30/10/10, provenance `estimated`, confidence **0.8** | Layer is called "Zoning Map" but this is a traffic demand zone; defaults look like data |
|11|—| Gateway / "Create Traffic Gateway" | DoorOpen | `gateway` snapped to nearest network node; inbound/outbound flows AM 500/300… and mode split defaults | Error says "within 300m" but threshold is 0.004° ≈ 440 m; flows are invented defaults |
|12|—| Draw area / "Draw Area and Map Selected Area (import infrastructure)" | Globe | polygon → saved study area → OSM import (roads, buildings, metro, signals; clip or whole features) via local OSM index | Not a drawing tool — it is data import; most complex pop-over in the app |
| | | Undo / Redo | Undo2/Redo2 | history | — |

Tools are one flat strip of 12 × 64 px buttons, no grouping (surface / structures / transit / subsurface / analysis zones / data). Bridges, tunnels, drainage, underground metro: **absent** as tools (tunnels/bridges exist only as imported OSM tags). Each active tool opens a "Settings" pop-over under the button.

### 1.3 Backend (FastAPI + SQLAlchemy + SQLite; `backend/main.py` 76 lines mounts 11 routers under `/api`; CORS `*`; no auth)

| Router (file, lines) | Prefix | Endpoints |
|---|---|---|
| `api/router.py` (256) | — | GET/POST `/scenarios`, DELETE `/scenarios/{id}`; GET/POST `/objects`, POST `/objects/batch`, DELETE `/objects/{id}`, POST `/objects/batch/delete`; GET/POST `/areas`, DELETE `/areas/{id}` |
| `api/scenario_router.py` (474) | — | `/scenario-changes`, `/scenarios/{sid}/changes|change-set|fork|materialised|versions`, `/scenario-versions/{vid}` (+`/objects`, `/restore`), `/runs` (POST/GET), `/runs/{rid}`, `/runs/compare` |
| `api/sim_router.py` (162) | `/sim` | GET `/status`, POST `/spike` (SUMO) |
| `api/osm_router.py` (60) | — | `/osm/status|ways|signals|buildings|metro` (local OSM index; Overpass unreachable) |
| `api/observed_router.py` (62) | `/observed-counts`, `/diurnal-profile`, `/network-corrections`, `/observed-screenlines` | curated observation reads |
| `api/traffic_data_router.py` (605) | `/traffic-data` | vehicle-classes, pcu-sets (+versions), `/pcu/convert`, datasets CRUD, `/datasets/{id}/records|hourly|audit`, `/records/{id}` PUT/DELETE, `/counts`, `/import/preview`, `/import/commit`, `/audit` |
| `api/feasibility_router.py` (372) | `/feasibility` | `/site-data`, `/status`, `/assessments` (+`/{aid}`, `/evidence`, `/reviews`, `/documents`), `/evidence/{eid}/download`, `/documents/{did}/download` |
| `api/planning_router.py` (336) | `/planning` | `/status-vocabulary`, `/projects` CRUD, `/projects/{pid}/links` (+DELETE), `/linkable`, `/decisions`, `/projects/{pid}/audit`, `/audit`, `/projects/{pid}/report` |

Packages: `models/models.py` (scenarios, city_objects, areas, scenario_object_changes, scenario_versions, scenario_version_changes, scenario_runs), `planning/` (models: planning_projects, planning_project_links, planning_decisions, audit_log [append-only, ORM + SQLite triggers]; `audit.py`; `report.py` PDF/DOCX), `feasibility/` (models fs_assessments/fs_documents/fs_evidence/fs_reviews; `layers.py` reads `TWINCITY_FEAS_LAYERS`; `build_layers.py`; `docgen.py` Investigation Requirements Document PDF/DOCX), `traffic_data/` (td_vehicle_classes, td_pcu_factor_sets, td_datasets, td_count_records, td_audit_log; `importer.py` CSV/XLSX), `sumo/service.py` (HBEFA4 emissions spike), `osm/` (`index.py` via `TWINCITY_OSM_INDEX`, `build_index.py`), `observed/` (counts, diurnal, screenlines, junction_match, network_corrections, oneway_audit), `database/` (connection, migrations). Backend non-router code + models ≈ 3.6k lines; 14 pytest files (102 passed per ENGINEERING_VALIDATION §3).

---

## 2. Capability inventory = preservation checklist

Labels from docs (B = BROWSER-VERIFIED, U = UNIT-TESTED, H = HEADLESS-RUN, UNT = UNTESTED). "Depth" = clicks from a fresh load to reach it.

| Capability | Where in UI today (depth) | Code | Verification (doc) |
|---|---|---|---|
| 3D city view, imagery/terrain, 20,732 base objects | always (0) | Viewport3D, engine/rendering | B (§10 #1) |
| Layers (satellite, terrain, roads, buildings, junctions, metro, zones, gateways, 5 utility layers, traffic-network debug) | Layers pill bottom-left (1) | LayerManager.tsx, engine/layers | — |
| Mode switching View/Build/Simulate | ModeBar (1) | ModeBar.tsx, TwinCityEngine.setAppMode | B |
| Object inspector (all types: road lanes/sections/carriageways, flyover, metro, station heading, building, utility, zone, gateway) + delete | Build → click object (2) | PropertiesPanel.tsx (2330) | U (many), B partial |
| View-mode object details / "Your projects" (list of user-built objects) | View, right panel (0–1) | InfoPanel.tsx | — |
| Drawing tools (12, §1.2), snapping, auto-connect, undo/redo | Build toolbar (2) | Toolbar, tools.ts, EditingEngine, SnapManager, HistoryManager | U + B (road/junction) |
| Topology reconstruction (at-grade → junction; flyover/tunnel/layer held apart; uncertain-level confirmation) | implicit on draw; LevelCrossingPanel in inspector | levelCrossings.ts, osmTopology, TrafficNetworkBuilder | U (property test 11×200), 4 cases B (TOPOLOGY_RECONSTRUCTION.md) |
| Road gaps / lane scope edits | inspector sub-panels | RoadGapPanel, LaneScopeControl, roadGaps.ts, roadEdits.ts | U |
| Imported junction editor (control, signal plan, phases, lane connections, turning movements) | Build → road → "Select junction" (3) | JunctionPanel.tsx, junctionEdits/junctionDraft | U (JunctionEditing) + B (OVERHAUL §23) |
| OSM study-area import ("Map Selected Area", clip vs whole features, categories, retry/resume) | Build → Draw area tool (3) | Toolbar.tsx, studyAreaImport.ts, LocalOsmIndex, /api/osm | U (MapSelectedArea, StudyAreaImport) + B |
| Scenarios: baseline vs proposal, copy-on-write isolation, new/duplicate/edit/delete | ScenarioSelector top-left (1–2) | ScenarioSelector, ScenarioManager, scenario_router | U + B (Duplicate not browser-run) |
| Scenario versions (save, restore, stale-baseline flag, frozen run inputs) | ScenarioSelector → versions (2) | ScenarioVersions.tsx, scenarios/versions.ts, /scenario-versions | U + B (§10 #4) |
| "Compare with Base City" (object/population/water/lane-km diff) | ScenarioSelector checkbox, proposals only (2) | scenarios/scenarioComparison.ts | — |
| Area traffic analysis (pick road, range, hour; status/LOS/headline; why/bottlenecks) | Simulate → click road (2) | SimulationPanel, RoadAnalysisPanel/Pieces, SimulationMode, RoadAnalysis, StudyAreaExplorer, TrafficMicroSim | B (§10 #2); values ESTIMATED, model NOT validated |
| Live micro-simulation view (play, speed, vehicle inspector, HUD) | Simulate → live controls (3) | SimulationHud, TrafficMicroSim, MicroTrafficVisualizer | B (OVERHAUL) |
| Proposal vs baseline traffic comparison (delta KPIs, junction compare, assumptions differences) | Simulate tab 2 (3) | ScenarioComparison.ts, ScenarioDeltaTable, JunctionCompareCard | U + B |
| Through-the-day (24 h timeline, stale-row dimming) | Simulate (TimeOfDayPanel/TimesOfDay) (3) | TimeOfDayPanel, timeOfDayView, RoadAnalysisPanel.TimesOfDay | U (TimeOfDay, TimelineStale*); not in §10 integrated pass |
| Calibration panel (network model, screenlines, GEH) | Simulate tab 3 Details (3) | CalibrationPanel, engine/calibration | U |
| Traffic Data Manager (datasets with provenance, measured/estimated/synthetic, calibration/validation role, IRC:106 PCU sets, manual entry, road picker, per-dataset audit) | "Traffic data" pill (1) | TrafficDataPanel, traffic_data_router, traffic_data/ | U + B |
| CSV/XLSX import wizard (preview, column mapping, per-row errors) | Traffic data → Import (2) | TrafficDataPanel import-wizard, importer.py | B |
| Observed vs routed vs simulated with GEH | Simulate → Details → "Checks against traffic counts" (4) | TrafficCountChecks, countValidation.ts | B (synthetic counts, §10 #5) |
| ODME (Spiess 1990, calibration counts, held-out validation, TAG Table 5 limits) | Simulate → Details → ODME card (4) | OdmeAndEmissions.OdmeCard, demand/odme*.ts | U, H, UI B; real-area result FAILS validation |
| Fuel & emissions (SUMO HBEFA4 classes, speed+accel+idling; per class) | Simulate → Details → "Fuel and emissions" (4) | EmissionsCard, emissions/hbefa4.ts, sumo/ | U + B (§10 #6); Compare rendering UNT |
| SUMO spike / status | (no UI; backend) | sim_router, sumo/service.py | — |
| Bottleneck diagnosis by cause (7 causes) | Simulate → tab 2 → "Diagnose & propose" (4) | generator/diagnosis.ts, ScenarioGeneratorPanel | U + B |
| Scenario generator (candidates A signals/turn bans/one-way, B bus lane, D flyover, F +lane/connector; each an isolated proposal) | same (4–5) | generator/candidates, apply, evaluate, session | 4 candidate kinds B; flyover/connector headless only; C/E not implemented |
| Multi-objective comparison (Pareto, noise/ties, unknowns never dominate, optional weighted ranking) | generator table (5–6) | generator/compare.ts | U + B (§10 #8) |
| Feasibility screening (findings with 6 certainty labels, never "feasible"; layers: water, buildings, heritage, depth thresholds) | Build → select road/flyover → "Feasibility & investigations →" → Assess site (3–4) | FeasibilityPanel, engine/feasibility, feasibility_router, feasibility/layers | U + B (§10 #7) |
| Investigation rules (22 rules, 23 investigations, tri-state) + checklist | Feasibility panel | investigationRules.json, investigationPlanner.ts | U |
| Investigation Requirements Document PDF + DOCX (18 sections, disclaimer) | Feasibility panel → Documents | feasibility/docgen.py | PDF B, DOCX U |
| Evidence upload / append-only reviews (no "approved" status) | Feasibility panel | fs_evidence, fs_reviews | U; not in §10 |
| Legacy bridge feasibility (pass/warn/fail) | PropertiesPanel (flyover) | simulation/BridgeFeasibilityEngine.ts | U — note: lacks "unknown" state (SYSTEM_ARCHITECTURE §1.7 #16) |
| Planning projects (create, status vocabulary, attach scenario/version/dataset/assessment/run by reference, baseline fingerprint stale flag) | "Planning projects" pill (1) | PlanningPanel, planning_router, planning/models | U + B (§10 #9) |
| Decision record (not statutory approval) | Planning project detail (3) | planning_decisions | U + B |
| Append-only audit history (planning + traffic data) | Planning project → Audit timeline; Traffic data audit | planning/audit.py (+SQLite triggers), td_audit_log | U + B |
| Project report PDF/DOCX | Planning project → Report (3) | planning/report.py | PDF B, DOCX U |
| Scenario report (HTML) | (engine/report/scenarioReport.ts) | scenarioReport.ts | — (no emissions in HTML report: roadmap #8) |
| Observed datasets (curated counts, diurnal profile, screenlines, network corrections) | consumed by Simulate | observed/, observed_router | U (pytest) |
| Keyboard shortcuts, coach marks, connection badge, confirm-delete | header / overlays | ui/* | — |
| Responsive layout 1920→390 (bottom sheets <920 px) | global CSS | index.css "Narrow windows" | B (§9, 6 viewports) |

---

## 3. Usability problems

**Navigation depth & discoverability**
- The capabilities that make this a *planning* tool are the deepest: feasibility is 3–4 steps away and **only from Build's inspector of a road, flyover or metro+flyover** (Build → select → "Feasibility & investigations →" → Assess site); metro lines, stations, utilities and buildings cannot be screened, although the feasibility engine itself already knows proposal types `tunnel`, `underground_road`, `underpass`, `bridge`, `interchange`, `elevated_corridor` with level surface/elevated/underground (`engine/feasibility/proposal.ts`) — the only place "underground" exists as a first-class concept today; the generator is inside Simulate → tab 2 → button; ODME, emissions and count checks are inside Simulate → tab 3 → collapsed `<summary>` blocks (depth 4).
- Two entry points live as pills under the scenario selector (Traffic data, Planning projects) and silently force View mode; Build's toolbar is rendered inside the top-left dock but CSS-moved to top centre. Three different placement idioms for top-level navigation.
- One right panel at a time chosen by a 6-way ternary: opening Traffic data closes Planning and vice versa; selecting an object in Build replaces everything. No persistent inspector vs. tool panel separation.

**Overlapping / confusing concepts**
- "Your projects" (InfoPanel = list of objects you drew) vs **"Planning projects"** (PlanningPanel = coordination records) — same word, unrelated things, both visible on load.
- "Scenario" vs "Proposal" vs "Version" vs "Base City" vs "baseline" vs "The existing city": ScenarioSelector uses "New Proposal", "Duplicate Scenario", "Edit Scenario", "Compare with Base City"; the generator says "proposal scenario". Users cannot tell a version (snapshot of one proposal) from a scenario (an alternative) from a planning project (container).
- Two unrelated "comparisons": `scenarios/scenarioComparison.ts` (object/population diff under "Compare with Base City") vs `simulation/ScenarioComparison.ts` (traffic deltas in Simulate) (SYSTEM_ARCHITECTURE §1.7 #5).
- "Zoning Map" layer = traffic demand zones; Build "Zoning" dropdown = building use.
- Mode names are verbs about software (View/Build/Simulate), not planning activities; environmental/underground work has no home.

**Text-heavy panels (quoted from code)**
- ScenarioGeneratorPanel: "Finds the causes of the worst places in this analysis, proposes interventions (traffic management first), creates each as its own proposal scenario (the baseline is never changed), runs each on the baseline's frozen demand, hour and seeds, and compares them." and "★ = not beaten on every selected objective by another scenario (Pareto set). Differences within the noise threshold, or not shown by every seed, are ties. Ordinal classes are not money. n/a: no emissions model in this build." (the last clause is **stale** — emissions exist).
- TrafficDataPanel: "Validation datasets are compared with the simulation after a run (Simulate → Details → Checks against traffic counts). Calibration datasets are reserved for matrix estimation, which is not implemented yet." — **stale/incorrect**: ODME is implemented (IMPLEMENTATION_ROADMAP Phase 2).
- Toolbar Draw-area pop-over: a 60-word paragraph on clip vs whole features plus two near-identical button pairs ("Map Selected Area" / "Import whole features" / "Import all, whole features").
- SimulationPanel Details: clause-level standards prose inline ("Mid-block: IRC:106-1990 Table 2 design service volumes divided by 0.70 (LOS C, clause 8.1)…"). Good content, wrong place — belongs in expandable "method" details.
- PlanningPanel: report section list as a sentence ("Summary, baseline, datasets with provenance labels, scenarios, versions and run inputs, comparison from run records, …").

**Validation verdict is not visible where results are read (CRITICAL for the redesign)**
- The Simulate headline (shot `1440x900-13-…`) shows "Severely congested", KPIs (2 km/h, 767 s/veh, V/C 440%, LOS F) and a reassuring "3/3 runs agree" chip, with small ESTIMATED (demand) / SIMULATED (speeds) chips. Nowhere in the UI is the project-level verdict of docs/ENGINEERING_VALIDATION.md (model NOT validated; fails TAG M3.1 counts 0/15, screen line −30.5%, speeds 4/21) stated. grep of `components/` finds "Not validated" only inside the ODME card (`OdmeAndEmissions.tsx` L85, depth 4) and the per-run GEH line in `TrafficCountChecks.tsx`. Seed-agreement ("3/3 runs agree") measures stochastic stability, not accuracy, and can be misread as confidence. The new Simulation workspace must carry a persistent, unmissable "Model not validated — comparisons only" status (linking the validation table), per the brief.
- Traffic data header: "Counts you enter or import. Evidence for checking the model, never demand." — contradicts the ODME / "Calibrate demand" buttons (CalibrationPanel L50) that do use calibration counts to adjust demand.

**Layout defects seen in the BEFORE screenshots (BROWSER-OBSERVED, 1440×900)**
- Below 1560 px wide (1700 with a panel, 1830 with a wide panel) `index.css` L136-147 turns the Build toolbar into a 4-column grid inside the scrolling top-left column. Its absolutely-positioned "Settings" pop-overs then **overlap the tool buttons** (Road: "Settings / CLASS / Local" drawn over the Flyover/Utility rows) or are **clipped by the column** (Draw area: only the "Settings" header is visible, the whole import UI is cut off), and undo/redo sit greyed in a half-hidden row. Shots `1440x900-04-…`, `1440x900-06-…`. ENGINEERING_VALIDATION §9 lists "tool pop-ups" as *not measured*; this is that gap. 1440×900 is a common laptop size — Build is effectively broken at the size most planners will use.
- With a proposal active and "Compare with Base City" + Versions expanded (shot `1440x900-20-…`), the top-left column grows to ~680 px; the Traffic data / Planning projects pills are squeezed against the versions box and the Build toolbar is pushed below them, so **only the first 4 of 12 tools are visible** (the rest require scrolling a column that sits behind the Layers/compass dock). The left column carries identity, scenario management, versions, comparison, two navigation pills and the tool palette at once — the root cause of most layout fights.
- Map imagery: satellite/terrain tiles did not load in the sandbox (external Ion/imagery requests); the globe shows as flat blue with the road network. This is an environment limitation of the screenshots, not of the app.

**Fictional demo objects presented as user work**: on load "Your projects — 32 things you have built" lists demo objects stored in the base scenario: the 5 fictional samples of `engine/objects/sampleObjects.ts` (Pune Central Boulevard, TwinTowers Block A…) plus a seeded "Hinjewadi" demo in `TwinCityEngine.ts` ≈L1990-2060 (buildings such as Infosys Hinjawadi Campus, Megapolis Splendour Complex with invented population/employment/height, demand zones and gateways with invented flows, provenance `estimated`, confidence 0.8). Simulate excludes the 5 tracked samples only; the UI marks none of them as demo data. A planning platform must label or hide demo objects.

**Fabricated-looking defaults (honesty issue, not just UX)**: random building floors/population; demand-zone 10,000/5,000 with confidence 0.8; gateway flows; utility depth 1.5 m. The redesign must surface these as "assumed default — edit" or remove them (brief rule: no fake data).

**Styling**
- Tailwind v4 utility classes inline everywhere (PropertiesPanel alone: 542 `className=`); a small kit (`ui/kit.tsx`, `ui/viz.tsx`) exists but is used unevenly — Toolbar, ScenarioSelector, PlanningPanel/FeasibilityPanel/ScenarioGeneratorPanel mix raw `<button className="rounded bg-sky-700 px-2 py-1 text-xs">` with kit `Button`.
- `index.css` is small (234 lines: theme animations, Cesium overrides, dock positioning and the <920 px bottom-sheet rules) — **layout lives in CSS class hooks** (`panel-open`, `panel-wide-open`, `layers-open`, `.top-left-dock`, `.build-toolbar`, `.mode-bar-wrap`, `.panel-dock`) that App.tsx toggles. Any new shell must replace these together.
- Inline `style={{}}` is rare (≈24 uses, mostly widths in viz/RoadAnalysisPieces) — not a blocker.
- Accent colours per area are ad hoc (indigo Build, cyan Simulate, emerald Traffic data, violet Planning, orange Feasibility, sky generator); font stack 'Outfit','Inter' requested from Google Fonts (blocked offline → fallback).
- Icon reuse collisions: Compass (logo, junction tool), Layers (Layers button, flyover tool), Hammer (Build mode, Metro+road tool), Settings gear (utility tool).

**Hard-to-refactor components (lines)**: PropertiesPanel 2330 (all object types in one file), TrafficDataPanel 502, RoadAnalysisPanel 499, Toolbar 466 (tools + OSM import + modals), RoadAnalysisPieces 452, SimulationPanel 333, FeasibilityPanel 310; engine: TrafficMicroSim 3431, ProceduralGeometryGenerator 2364, TwinCityEngine 2120, SimulationMode 1958, EditingEngine 1775.

---

## 4. Recommended refactor seams

1. **App shell = rewrite App.tsx only.** Everything is driven by `engineInstance` + `useAppMode/useSelectedId`; panels are self-contained `SidePanel`s that take at most `onClose`/`obj`. A new `AppShell` (left workspace rail + layer panel + right inspector + bottom drawer) can mount the same components unchanged. Replace the CSS dock hooks in `index.css` in the same commit; keep the <920 px bottom-sheet behaviour (ENGINEERING_VALIDATION §9 measured it).
2. **Workspace → existing component mapping (reuse as-is first):**
   - City Explorer: Viewport3D, LayerManager (layer panel), InfoPanel object details (inspector), MapCompass.
   - Infrastructure Planning: Toolbar split into a categorised tool palette driven by `tools.ts` (add `category` field; keep `EditingMode` ids and hotkeys so `useKeyboardShortcuts` + tests keep working), PropertiesPanel/JunctionPanel as inspector, ScenarioSelector+ScenarioVersions as an "Alternatives" switcher.
   - Underground: start from `draw_utility` (utility objects, `depth`), utility layers, OSM tunnel/layer tags in topology; feasibility depth threshold. No subsurface data exists → foundation only, UNKNOWN by default.
   - Environmental: feasibility layers (water bodies, heritage, buildings) + EmissionsCard; flood/ground data absent (roadmap #7).
   - Simulation & Analysis: SimulationPanel + RoadAnalysisPanel unchanged inside the inspector/drawer; move Details cards (Calibration, ODME, Emissions, Count checks, Through-the-day) into the bottom drawer as tabs.
   - Projects & Coordination: PlanningPanel (projects, links, decisions, audit) + generator comparison as "Alternatives"; TrafficDataPanel as "Data".
   - Reports: planning report PDF/DOCX + Investigation Requirements Document PDF/DOCX endpoints + scenarioReport.
3. **Lift FeasibilityPanel out of PropertiesPanel** (it already takes `obj` + `onBack`): mount it from the inspector of any linear object and from a project; its proposal-type list (tunnel/underground_road/underpass…) is the natural seed for the Underground workspace. Low risk.
4. **Split PropertiesPanel by object type** behind the same export (road/flyover/metro/station/building/utility/zone/gateway files) — mechanical, but do it after the shell lands; JunctionEditing tests import from components.
5. **Panel-state store**: replace App.tsx booleans with a tiny store (zustand is already a dependency) holding `workspace`, `inspector`, `drawerTab`; keep `engine.setAppMode` as the engine-facing contract (Simulate locks editing).
6. **Terminology layer**: centralise labels (mode, tool, scenario/proposal/version/project) in one file so renames don't touch logic; fix the stale texts listed in §3.

**Tests a redesign must keep green** (vitest `include: src/engine/testing/**/*.test.ts`, jsdom; 86 files run, 665 pass / 7 skipped per ENGINEERING_VALIDATION §3; backend pytest 102 pass):
- Import UI components directly: `RoadAnalysisPanelPieces.test.ts` (RoadAnalysisPieces, roadAnalysisView, ui/viz), `TimelineStalePanel.test.ts` (RoadAnalysisPanel.TimesOfDay), `TimeOfDay.test.ts` (timeOfDayView), `ThroughTrafficOff.test.ts` (roadAnalysisView.causeLine), `ScenarioPanelPieces.test.ts` (ScenarioDeltaTable), `LaneBottleneckCard.test.ts`, `LaneScopeStore.test.ts` (laneScopeStore), `JunctionEditing.test.ts` (JunctionCompareCard). **Keep these export names/paths or move with re-exports.**
- Behaviour tests that pin UI-facing engine contracts: `EditingWorkflow`, `HonestControls`, `SimulateFlow`, `StartupTest`, `ScenarioIsolation`, `EditIsolation*`, `NetworkEditIsolation`, `MapSelectedArea`, `StudyAreaImport`, `ZoningWorkflow`, `FeasibilityEngine`, `ScenarioGenerator`, `TrafficData`, `Odme`, `Emissions`.
- No Playwright suite in repo; browser regressions are external harnesses relying on `data-testid`s (open-traffic-data, open-planning, traffic-data-panel, import-*, gen-*, feasibility-*, planning `project-*`/`link-*`/`export-*`, save-version, version-list, emissions-card, odme-*, junction-*) and `aria-label`s ("New proposal", "Compare with base city", `aside[aria-label="Simulate traffic"]`, "Planning projects"), plus `#scenario-select`. **Preserve these test ids** so /workspace/work/um-smoke-run/e2e/smoke.py and this audit's harness can re-run as AFTER checks.
- Gates: `npx tsc -p tsconfig.app.json --noEmit` (0 errors), `oxlint` (0 errors), `vite build`.

---

## 5. BEFORE screenshots

Folder `/workspace/work/urbanos/shots/before/`. Harness `/workspace/work/urbanos/audit/e2e/shots.py` (results `results.json`, log `run.log`). Data created only in the DB copy: proposal "AUDIT proposal (before shots)" + one drawn road, planning project "AUDIT project (before shots)". (List filled in below after the run.)

All BROWSER-CAPTURED on `837183c` (built bundle, Chromium headless/SwiftShader), 2026-11-13. Satellite/terrain imagery did not load in the sandbox (globe shows flat blue); everything else is the real UI. Traffic numbers in shots 13–17 are model output: **ESTIMATED, model NOT validated** (ENGINEERING_VALIDATION). The proposal, road and project in shots 18–25 are audit fixtures in the DB copy (SYNTHETIC).

| File | State shown | What it evidences |
|---|---|---|
| `1440x900-01-initial-load-view-mode.png` | Load, View mode | Left column (name, scenario, Traffic data, Planning projects), Mode bar, "Your projects — 32 things you have built" listing demo objects |
| `1440x900-02-layers-open.png` | Layers open | Flat layer list (Satellite…Fiber, "Zoning Map", "Show Traffic Network") |
| `1440x900-03-build-mode-toolbar.png` | Build, Select | 12-tool grid in the left column (no categories) |
| `1440x900-04-build-tool-road-settings.png` | Road tool active | Settings pop-over **overlapping** Flyover/Utility rows |
| `1440x900-05-build-tool-utility-settings.png` | Utility tool active | Gear icon; trunk type only, no depth/diameter |
| `1440x900-06-build-tool-draw-area-import.png` | Draw area tool | Import pop-over **clipped** (only "Settings" header visible) |
| `1440x900-07-build-road-selected-inspector.png` | Base road `osm_218681353` selected | PropertiesPanel: Feasibility link, junction offer, class, lanes, scope, widths… |
| `1440x900-08-build-junction-editor.png` | Imported junction open | JunctionPanel: approaches/exits, control, signal plan |
| `1440x900-09-traffic-data-manager.png` | Traffic data (empty) | Tabs Datasets/Enter/Import/By road; "never demand" header |
| `1440x900-11-planning-projects-list.png` | Planning projects (empty) | Name field + New planning project |
| `1440x900-12-simulate-pick-road.png` | Simulate, no road | Pick-a-road state |
| `1440x900-13-simulate-results-understand.png` | Analysis 09:00, 1.5 km | Headline "Severely congested", KPIs, "3/3 runs agree", no validation verdict |
| `1440x900-14-simulate-improve-compare.png` | Tab 2 | Improve & compare entry |
| `1440x900-15-generator-diagnosis-candidates.png` | Diagnose & propose | Dense diagnosis text, "Create 6 proposal scenarios" |
| `1440x900-16-simulate-details.png` | Tab 3 Details | Collapsed technical sections |
| `1440x900-17-simulate-emissions-card.png` | Fuel and emissions open | EmissionsCard (ESTIMATED) |
| `1440x900-18-new-proposal-dialog.png` | New proposal dialog | Scenario creation |
| `1440x900-19-proposal-road-selected.png` | Drawn road in proposal | "PROPOSED STATE" inspector |
| `1440x900-20-scenario-compare-with-base.png` | Compare with Base City + Versions | Left column overflow: only 4 tools visible |
| `1440x900-21-feasibility-panel-before-assess.png` | Feasibility panel | Proposal type, Surface/Elevated/Underground, depth "unknown" |
| `1440x900-22-feasibility-findings.png` | After Assess site | 4 constraints / 5 unknowns / 15 investigations, CRITICAL flags |
| `1440x900-23-feasibility-investigations.png` | Investigations section | Checklist / documents |
| `1440x900-24-planning-project-detail.png` | Project with scenario attached | Status, attached records, decision record disclaimer |
| `1440x900-25-planning-project-audit.png` | Audit timeline / report | Append-only log, PDF/DOCX |
| `1024x768-01-initial-load-view-mode.png` | Load at tablet-landscape | — |
| `1024x768-04-build-tool-road-settings.png` | Road tool | Same pop-over overlap |
| `1024x768-07-build-road-selected-inspector.png` | Road inspector | — |
| `1024x768-09-traffic-data-manager.png` | Traffic data | — |
| `1024x768-10-traffic-data-import-wizard.png` | Import tab | CSV/XLSX import wizard (follow-up run) |
| `1024x768-11-planning-projects-list.png` | Planning projects | — |
| `1024x768-13-simulate-results-understand.png` | Simulate results | Panel ≈ 42% of width, icon-only Mode bar |
| `1024x768-15-generator-diagnosis-candidates.png` | Generator | — |
| `1024x768-22-feasibility-panel.png` | Feasibility | Feasibility panel at tablet width (follow-up run; an earlier capture caught the panel mid fade-in at opacity 0 — harness timing, not a product defect) |

Not captured: 1440 Import tab (first-run click missed; the duplicate was deleted), live micro-simulation playback, through-the-day timeline run, ODME run, generator evaluation/Pareto table (≈200 s run; see existing `/workspace/work/vp-overhaul-shots/um-smoke-08-pareto-table.png`). `1440x900-01` was re-taken by the follow-up runs (same state). Console errors in the run: only `Failed to load resource: net::ERR_FAILED` (blocked fonts/imagery); no page errors.

---
## 6. Top findings for the redesign (summary)
1. Model-validation verdict (TAG M3.1 FAIL) is invisible at the point results are read; must become a persistent status in Simulation.
2. Build is broken at ≤1560 px: tool pop-overs overlap/clip; with versions open only 4 of 12 tools are visible.
3. Build tools: flat, mis-iconed (Compass/Layers/Hammer/Gear collide with app chrome), elevated-only metro, no tunnels/bridges/drainage, "Draw area" is import not drawing, and several tools write invented defaults (random building floors, zone 10k/5k at confidence 0.8, gateway flows, utility depth 1.5 m).
4. "Your projects" vs "Planning projects", scenario/proposal/version/base terminology, two unrelated "comparisons".
5. Planning capabilities (feasibility, generator, ODME, emissions, count checks) sit 3–5 levels deep inside Build/Simulate panels; Traffic data and Planning are pills that hijack View mode.
6. Stale UI text: "Calibration … matrix estimation, which is not implemented yet" (ODME exists); "n/a: no emissions model in this build" (emissions exist); "never demand" vs Calibrate demand.
7. Seams: App.tsx (200 lines) + index.css dock rules are the only shell code; every panel is a self-contained SidePanel over `engineInstance` → a new shell can wrap them unchanged. Keep component export paths used by 8 vitest files and all `data-testid`s used by the browser harnesses.
