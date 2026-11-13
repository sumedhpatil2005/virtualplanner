# Shared city model, project coordination, subsurface records, environment catalogue (backend)

Branch `urbanos-city-planning-redesign`, worktree `uos-wt-coord`. Date: 2026-11-13. Implements UX_ARCHITECTURE §6–8 (binding)
and ENGINEERING_GIS_RESEARCH (EGR) §D, §E, §C. **Backend only** plus one typed client (`frontend/src/lib/coordinationApi.ts`); no UI.

Labels: **UNIT-TESTED** (pytest), **SMOKE-RUN** (run in-process against a *copy* of `twincity.db` + the local OSM index, not a test),
**UNTESTED**. All test geometry, depths and records are **SYNTHETIC**. Nothing here is an engineering assessment or a permission.

## 1. What it adds (additive only)

| Table | Content | Mutability |
|---|---|---|
| `project_proposal_elements` | project_id (a `planning_projects` row), scenario_id / scenario_version_id (optional), `element_ref` (object id resolved from the version, else the scenario head, else baseline) **or** own GeoJSON geometry (EPSG:4326), kind, width_m (footprint width / outer diameter), `z_min_m`/`z_max_m` (m relative to ground, up positive; **NULL = UNKNOWN**), z_ref, `profile_json` [{chainage_m, z_min_m, z_max_m}] for segmented alignments, clearance_m (user), construction_phase, provenance, certainty (measured / estimated / hypothetical / unknown) | edit/delete by the owning project's users (audited) |
| `clearance_rules` | label, rule_type (`permission_distance` \| `engineering_clearance`), subject_kind / other_kind (comma list or `*`), horizontal_m / vertical_m (**NULL = UNKNOWN**), basis (`cited_permission_distance` \| `user_entered`), citation, note, active | user-configurable (audited); changing a cited value turns it into `user_entered` |
| `coordination_runs` | project, frozen input hashes (§4), summary, engine version | insert only |
| `coordination_conflicts` | one finding: element A (+segment), side B (`project_element` / `baseline_road` / `osm_metro` / `subsurface_utility` / `layer` / `project`), project_b_id, class, horizontal distance, vertical gap, certainty, reasons, permission triggers, evidence (both sides' z, width-known, kinds, rule ids, CRS), status open/acknowledged/resolved + actor + note | only the status fields change (audited) |
| `subsurface_datasets` | one imported file: record type, format, file sha256, publisher, source URL, licence (default `UNKNOWN`), data date, stated coverage bbox (NULL = UNKNOWN), provenance, warnings, supersedes_id, importer | insert only |
| `subsurface_records` | borehole (point, ground level, final depth, strata, water strikes, SPT) or utility (line, type, owner, depth, diameter, ASCE 38 QL, survey method, derived z range and z certainty) | insert only |
| `environment_layers` | catalogue: domain, status, source, licence, date, recommended sources (EGR §C, metadata only), limitations | seeded; OSM-derived rows' status computed on read |

Existing tables are only **read**: `planning_projects`, `planning_project_links`, `scenarios`, `scenario_object_changes`,
`scenario_versions` / `scenario_version_changes`, `scenario_runs`, `fs_assessments`, `city_objects`, `areas`, and the local OSM
index. `main.py` gained 4 lines (import router, seed, include router). Audit: the new entity classes are registered in
`planning.audit`'s spec table from `coordination/models.py`, so the existing session hooks write `audit_log` for every
create/update/delete, with the actor from `X-Actor` or the request's who-field (`created_by`, `edited_by`, `removed_by`,
`run_by`, `actor`, `imported_by`). Seeds are audited as `system (seed)`. Elements' events have the project as parent, so they
appear in the project's audit timeline.

Dependencies: `shapely>=2.0`, `pyproj>=3.6` added to `backend/requirements.txt` (installed in the sandbox: shapely 2.2.0,
pyproj 3.8.0; EPSG:32643 transform works offline). Distances are computed in **UTM zone 43N (EPSG:32643)**.

## 2. API (`/api/coordination`)

| Endpoint | Behaviour |
|---|---|
| `GET /vocabulary` | kinds, certainties, classes + labels, statuses, rule types, QL levels, domains, CRS, z convention, CSV templates |
| `POST/GET /projects/{pid}/elements`, `GET/PATCH/DELETE /elements/{eid}` | geometry or element_ref required; ref must resolve; version must belong to the scenario; z_min ≤ z_max; `clear_fields` sets a value back to UNKNOWN; DELETE needs `removed_by` |
| `GET/POST /clearance-rules`, `PATCH /clearance-rules/{rid}` | list includes `rule_set_hash` and the note that no engineering clearance is pre-filled |
| `POST /projects/{pid}/detect` `{run_by, screening_radius_m=50}` | runs detection for the project vs **all other projects + baseline roads + OSM metro + utility records**; returns the run with findings |
| `GET /projects/{pid}/runs`, `GET /runs/{rid}` | runs with summary, inputs, **stale verdict** |
| `GET /projects/{pid}/conflicts[?include_clear=true]` | issues **visible to both projects**: findings of every project's latest run where this project is side A or B, most severe first, with `raised_by_project`, `other_project`, `run_stale` |
| `PATCH /conflicts/{cid}/status` `{status, actor, note}` | records a response; never changes the finding or either project |
| `GET /stale/{run\|assessment\|coordination_run}/{id}`, `GET /projects/{pid}/stale` | stale indicators computed on read (§4) |
| `POST /subsurface/import` | `{record_type: borehole\|utility, format: ags4\|csv\|json, content \| records, name, file_name, publisher, source_url, licence, data_date, coverage_bbox, provenance, project_id, grid_epsg, supersedes_id, imported_by}` |
| `GET /subsurface/datasets[?project_id]`, `GET /subsurface/datasets/{id}`, `GET /subsurface/records[?bbox&record_type]` | records with provenance via their dataset |
| `GET /environment-layers` | catalogue with live status for OSM-derived layers |

## 3. Detection algorithm (EGR §D3; `coordination/geometry.py`, `coordination/service.py`)

1. **Extents.** Each element → GeoJSON → UTM 43N. A LineString is **segmented per vertex** (merged if > 400 pieces); each segment
   gets its own z range from the profile (envelope of interpolated values at both ends and profile points inside; any missing
   value → UNKNOWN) or the element's z_min/z_max. Footprint = segment buffered by width/2 (flat caps); points by width/2;
   polygons as drawn. Width NULL → bare centreline, flagged `width_known=false`. z_ref other than `ground` → depth UNKNOWN (no
   ground model to convert).
2. **Side B layers.** Other projects' elements (same resolution); **baseline roads** (`city_objects`, scenario `base`, type road;
   width from properties when present; at-grade `z_max = 0`, structure depth `z_min` **UNKNOWN**; certainty estimated);
   **OSM metro** from the local index (`railway=subway` etc.; tunnel/layer<0 → `metro_tunnel`, bridge/layer>0 → `metro_viaduct`,
   nodes → `metro_station`; **z and width UNKNOWN**; centreline is OSM's, not MahaMetro's); **utility records** (z from depth and
   diameter, width = diameter).
3. **Candidates** via a Shapely STRtree per layer, query radius = max(screening radius, largest active rule distance) + 1 m.
4. **Horizontal**: `d = distance(footprintA, footprintB)` in metres. Required = max(applicable engineering `horizontal_m`, element
   `clearance_m`s); none set → physical overlap only (reason recorded). Hit if `d ≤ required`; if not, and either width is UNKNOWN
   and `d ≤ screening radius` → horizontal UNKNOWN.
5. **Vertical** (interval arithmetic, Shapely ignores z): gap = A.z_min − B.z_max (A above) or B.z_min − A.z_max (B above),
   each only when both bounds are known. A positive gap → separated by that gap; all four bounds known and no positive gap →
   overlap (0); otherwise **UNKNOWN**. Required vertical = max(engineering `vertical_m`, element clearances) or UNKNOWN.
6. **Class**: horizontal miss → `no_conflict_within_available_data` (not stored per pair unless a permission distance fires);
   vertical separated → `vertically_separated` (gap shown; if no vertical clearance is set the reason says adequacy is UNKNOWN; if
   the gap is below a set clearance it is a hit); hit+hit → `conflict`; otherwise → `potential_conflict` (depth UNKNOWN, or width
   UNKNOWN). Segment pairs are aggregated to one finding per (element, B object), keeping the most severe and nearest.
7. **Layer-level findings** for each element where no pair was found: `no_conflict_within_available_data` only if the layer
   covers the element's bbox, else `unknown_no_coverage`. Coverage: baseline = union bbox of `areas` (else the extent of base
   roads, labelled estimated; no base roads → not covered); OSM metro = index bbox; utilities = a dataset's **stated**
   `coverage_bbox` (none stated → UNKNOWN, because absence of records proves nothing); other projects = a `project:{id}` row.
   An element whose geometry cannot be resolved → `unknown_no_coverage` with the reason.
8. **Permission distances** (directional: subject_kind = the work, other_kind = the protected asset) are reported as
   `permission_triggers` on the finding — "trigger for an NOC/permission, NOT an engineering clearance" — never as a class. They
   fire for A's work near B, and for B's work near A only when B is itself a proposal (an existing road is not a work).
9. **Isolation**: detection inserts `coordination_runs` + `coordination_conflicts` only. Status of an earlier finding is carried
   forward (`status_carried_from`) only for the same pair key **and** the same class; a class change reopens it.
10. Certainty of a finding = worst of the two sides; `potential_conflict` is always `unknown`.

## 4. Stale-assessment indicators (EGR §D5; computed on read, nothing stored)

Verdict `{stale: true | false | null(UNKNOWN), reasons[], not_checked[], label}`. Old results stay readable.

| Assessment | Reasons checked |
|---|---|
| Coordination run | `project_elements_changed` (hash of every element's resolved content, incl. head geometry for head refs), `scenario_version_superseded:{sid}`, `scenario_head_changed:{sid}`, `other_project_added/changed:{pid}`, `baseline_changed` (existing baseline fingerprint), `clearance_rules_changed` (rule-set hash), `subsurface_data_changed`, `osm_index_changed`, `engine_version_changed` |
| Simulation / ODME / emissions run record (`scenario_runs`; kind labelled from keys in inputs/results) | `newer_scenario_version`, `scenario_changed_since_run` (head change-set hash ≠ run's), `baseline_changed`; not checked: engine build (frontend build id unknown to the server) |
| Feasibility assessment (`fs_assessments`) | when `scenario_version` is a version id: `newer_scenario_version`, `scenario_changed_since_version`, `baseline_changed`; when it is not recorded → **stale = null (UNKNOWN)**; not checked: feasibility engine/rules version |

## 5. Clearance rules (seeded only with cited permission distances)

| id | Distance | Basis / source |
|---|---|---|
| `metro_noc_20m` | 20 m from the elevated or underground metro route (kinds metro, metro_tunnel, metro_viaduct, metro_station) | Indian Express, 17 Apr 2026 (MahaMetro spokesperson) https://indianexpress.com/article/cities/pune/noc-mandatory-pune-metro-warns-of-action-over-borewell-drilling-near-tunnels-10641841/ — RFI S9; MahaMetro notice PDF not read |
| `amasr_prohibited_100m` | 100 m from the protected limit (kind protected_monument) | AMASR Act s.20A — NMA FAQ (READ, updated 24 Feb 2025) and Act text (EXCERPT) — RFI S1/S2 |
| `amasr_regulated_300m` | 300 m (100–300 m regulated) | AMASR Act s.20B — as above |

All three: `rule_type=permission_distance`, `basis=cited_permission_distance`, `vertical_m` UNKNOWN, note "PERMISSION DISTANCE,
NOT AN ENGINEERING CLEARANCE". **No engineering clearance is seeded** (no IRC/IS value was read; it would be invented).

## 6. Subsurface records (EGR §E2/E3)

- **AGS4 subset** (PROJ, LOCA, GEOL, WSTK, ISPT; other groups listed as ignored). Headings used: LOCA_ID, LOCA_TYPE, LOCA_NATE,
  LOCA_NATN, LOCA_GREF, LOCA_GL, LOCA_FDEP, GEOL_TOP/BASE/DESC/LEG/GEOL, ISPT_TOP/NVAL — checked against the AGS4 dictionary
  (unofficial copy, https://open-geotechnical.github.io/unofficial-ags4-data-dict/group/LOCA.html, GEOL.html, ISPT.html, READ
  2026-11-13; AGS 4.2 Dec 2025 PDF GEOL table, EXCERPT). LOCA_LAT/LOCA_LON and WSTK_DEP are read if present but were **not
  verified** this session. Location: lat/lon, or NATE/NATN only when the grid is EPSG:32643 (LOCA_GREF or importer's
  `grid_epsg`); otherwise **location UNKNOWN** (record kept without geometry, warning).
- **CSV templates**: boreholes `borehole_id,lon,lat,ground_level_m,final_depth_m,stratum_top_m,stratum_base_m,description,water_strike_m,spt_top_m,spt_n`
  (one row per stratum); utilities `utility_id,utility_type,owner,geometry("lon lat;lon lat" or WKT LINESTRING),depth_m,diameter_m,quality_level,survey_method`; JSON utility records with GeoJSON geometry.
- **Utility depth certainty** (ASCE 38-22 QLs as summarised in PRODUCT_UX_RESEARCH §3, EXCERPT; standard text not read):
  QL-A → measured; QL-B/C/D → estimated; no QL with depth → estimated (+warning); no depth → unknown. Diameter UNKNOWN → bottom
  (z_min) UNKNOWN. Whether ASCE 38 is used in India is UNKNOWN.
- Provenance: file sha256, publisher, source URL, licence (`UNKNOWN` default), data date, importer, timestamp; all audited.

## 7. Environment catalogue (EGR §C, UX §8)

17 rows: flood lines, groundwater, soil, geology (GSI single-user licence), air quality, noise, land-surface temperature, land
cover, tree census, drainage, seismic zone (TO VERIFY), DEM — all **Not imported — UNKNOWN** with recommended source metadata;
OSM water / heritage (locator only) / trees / railway (from `feasibility_layers.db`) and OSM metro (from the OSM index) —
status **computed on read** (available only when the file exists). There is **no import path** for raster/vector environment
layers in this work (none implemented → none offered).

## 8. What is UNKNOWN / not done

- Pune metro tunnel crown/invert and viaduct deck levels (not in OSM) → every proposal near OSM metro is at best
  `potential_conflict`. Baseline road structure depth → tunnels under existing roads are `potential_conflict`.
- No engineering clearance values (IRC/IS not read). Without user values, horizontal = physical overlap only and vertical
  adequacy is UNKNOWN.
- Protected-monument limits are not imported, so the AMASR rules have nothing to fire against unless a user enters a
  `protected_monument` element.
- No ground model: `z_ref=msl` elements are treated as depth UNKNOWN. No DEM-based checks.
- Utilities: only what is imported; coverage only as stated by the importer. No utility network from PMC/MSEDCL/MNGL exists.
- Borehole interpolation, long-section projection, georeferencing helper (EGR §E1/E6/E7) — not implemented.
- Engine build / feasibility engine version cannot be compared server-side (listed in `not_checked`).
- The UI (Underground/Environment workspaces) is not part of this work; the typed client is UNTESTED in a browser (tsc + oxlint clean).

## 9. Verification

- `backend/tests/test_coordination.py` — **UNIT-TESTED** (11 pass + 1 skipped without an OSM index; the OSM test passes with
  `TWINCITY_OSM_INDEX` set): unknown depth stays null; every class incl. unknown depth and no coverage; both projects see an
  issue; width-unknown cannot be excluded; user clearance turns a gap into a conflict; baseline road checks (flyover over road →
  separated 6.5 m, metro tunnel under road → potential, no NOC trigger for an existing road); OSM metro depth UNKNOWN;
  **isolation** (table hashes of projects, links, scenarios, changes, versions, city_objects, elements, rules, records identical
  before/after two detections and a status change); status audited and carried forward; **staleness** after a new scenario
  version (coordination run, simulation+ODME run, assessment), another project's change, a rule change, and UNKNOWN when no
  version was recorded; **AGS4/CSV import with provenance** (sha256, licence, publisher, date, ignored group, unknown location,
  audit entries); utility QLs and detection against records incl. coverage; environment catalogue; **rule defaults labelled**.
- Full backend suite: **111 passed, 3 skipped** (the original 100 passed + 2 skipped stay green; the third skip is the OSM-metro test without an index).
- **SMOKE-RUN** on a copy of `twincity.db` (18,273 base roads → 81,585 segments) with the local OSM index: a SYNTHETIC 3 km
  metro tunnel → 74 potential conflicts with base roads (road depth UNKNOWN), 4 OSM metro potential conflicts with the NOC
  trigger, utilities `unknown_no_coverage`; first detection 5.5–6.4 s (baseline segments cached per fingerprint afterwards); stale
  check 0.1 s.
