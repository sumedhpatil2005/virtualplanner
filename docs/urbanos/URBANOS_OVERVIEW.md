# UrbanOS: overview of the redesign (2026-11-13)

Branch `urbanos-city-planning-redesign`, created from `urban-mobility-platform` @ 837183c. It is **not pushed and not merged**.
Labels used here: BROWSER-VERIFIED, UNIT-TESTED, HEADLESS-RUN, UNTESTED. Gates and the smoke table are in `URBANOS_VERIFICATION.md`.

**The traffic model still fails validation (TAG M3.1).** Only 0 of 15 count sites fall within GEH 5, and the river screen line is off by −30.5%. The redesign makes this failure visible: a top-bar pill, a banner in every simulation context, and a badge on every traffic, ODME and emissions output. It does not fix the model.

## 1. What changed in the product
| Before | After |
|---|---|
| A single "TwinCity" view with View/Build/Simulate tabs and floating pop-overs that overlapped and clipped at 1440 and 1024 | A map-first shell: top bar (search, alternative, validation pill), a rail with 7 workspaces, a context panel, an inspector and a bottom drawer. Ctrl/⌘ K opens a command palette. The shell has a responsive layout for 1440, 1024, 768 and 390. |
| Build toolbar with ambiguous icons and terms ("Draw area", "Gateway", "Zone") | A categorised tool palette in 8 groups (Roads & lanes, Junctions & signals, Grade separation, Transit, Underground, Land & demand, Data, Edit). Each tool has a lucide icon, a plain name, a shortcut and a tooltip. OSM import is under Data. |
| Tools that made up values (`Math.random()` floors, zone 10,000/5,000 at confidence 0.8, utility depth fixed at 1.5 m) | Defaults are marked hypothetical. A blank value is UNKNOWN, never 0. CertaintyBadge, TrustBadge and DataStatus appear wherever a value is shown. |
| The validation failure did not appear anywhere in the UI | ModelTrustPill and fails-validation badges on simulation, ODME and emissions outputs. |
| Planning projects were a list plus a PDF | Projects & Coordination: project cards; a 7-tab project page (Overview, Alternatives, Assessments, Datasets, Conflicts, Reviews & decisions, Activity); conflicts between projects ("Shared with project X"); a statutory approval flag that is always "No"; the audit trail. |
| No underground planning | Underground workspace: globe opacity and X-ray view; a tunnel/alignment tool with a depth and certainty per vertex; Profile and Cross-section drawer tabs; subsurface record import (AGS4/CSV/JSON with ASCE 38 quality level); conflict check against a project. |
| No environment view | Environment: 17 layers in 8 groups. 5 are available with source, date and licence. 12 are "Not imported · UNKNOWN", each with its limitation and a recommended source. Water and heritage overlays; feasibility screening of a selected proposal. |
| Simulate details were one long text wall | Calibration, ODME, Emissions, Count checks and Through the day are drawer tabs, each rendered once. Explanations are in Disclosures. |
| Reports were scattered | Reports catalogue: project PDF/DOCX, conflict summary CSV, investigation requirement documents and the scenario report. Each shows its scope, inputs, validation status and when it was last generated. |

## 2. Backend additions (only additive; existing tables are read only)
- `/api/coordination/*`: vocabulary, project elements, clearance rules, detection runs and conflicts with status, stale checks, subsurface datasets and records, the environment-layer catalogue, and the conflict CSV export.
- 7 new tables, plus `planning_projects.preferred_scenario_id` added by an idempotent migration.
- Clearance rules seed only distances that have a citation, and they are labelled as permission distances: the metro NOC distance of 20 m and the AMASR distances of 100/300 m. The AMASR rules never fire because monument limits are not imported.
- New dependencies: Shapely and pyproj, for planar geometry in UTM 43N. Vertical separation is computed separately.

## 3. Engines and datasets (details in ENGINEERING_GIS_RESEARCH.md)
- **Adopted now:** SQLite with R*Tree, Shapely + pyproj, a minimal AGS4/CSV importer, and CesiumJS as the only 3D engine.
- **Later:** PostGIS for multi-user use and true 3D predicates; GDAL/pyogrio for KML, SHP and DXF; Rasterio once a DEM exists; SWMM once a drainage network with invert levels exists; SUMO as an independent cross-check; GemPy once enough boreholes exist; CNOSSOS-EU noise (with no Indian fleet coefficients); Landsat surface temperature (LST).
- **Not needed:** MapLibre, deck.gl, Three.js, OSMnx.
- **Missing data that blocks real engineering use** (it shows as UNKNOWN in the app):
  - an offline DEM (the Cesium World Terrain terms forbid storing it offline; Copernicus GLO-30 is the candidate);
  - PMC storm-water and utility records, and metro tunnel depths (not openly available);
  - georeferenced flood lines (only scanned, contested PDFs exist);
  - GSI geology (single-user licence);
  - measured traffic counts and speeds;
  - monument limits.
- IS 1893 (Part 1) 2025 was withdrawn in March 2026, so the 2016 zone map applies. That Pune is in Zone III comes only from secondary sources and is UNVERIFIED.

## 4. Preserved
Every feature on the preservation checklist in CODE_UI_AUDIT.md is still reachable: OSM import, all drawing tools, junction editing, lane edits, scenarios, versions and alternatives, the Traffic Data Manager, ODME, emissions, feasibility and its PDF/DOCX, the generator with Pareto, planning PDF/DOCX and the audit log. Test ids and aria-labels are kept. Some now sit inside a workspace, tab or drawer, so a harness must open those first (see URBANOS_VERIFICATION §2).

## 5. Known limits
- Map tiles do not load in the sandbox (imagery 401), so drawing with real mouse clicks is UNTESTED. The browser tests feed points through the engine's drawing API.
- Light theme: tokens exist, but the older panels still use hard-coded dark colours, so there is no toggle.
- At 390 px the drawer tab strip scrolls sideways.
- Alignment comparison inside a project, locking alternatives, and generating investigation documents from the project page are not built.
- Underground still lacks: a terrain ground line (needs a DEM), clipping/cutaway, boreholes on the long-section, and dragging depths in the SVG.
- An alignment registered from Projects alone becomes kind `other` with UNKNOWN depth (URBANOS_VERIFICATION §5).
- All test projects, counts and records are SYNTHETIC.
