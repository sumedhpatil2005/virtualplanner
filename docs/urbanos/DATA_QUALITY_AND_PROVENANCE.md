# Data quality, provenance and feature readiness (UrbanOS Phase 2, 2026-11-13)

Owner: dataset-intelligence work package (worktree `uos-wt-dsi`). Ingestion and storage: `DATA_INGESTION_ARCHITECTURE.md`.
Datasets already in the app: `catalogue/dsi.md`. Labels: **UNIT-TESTED**, **HEADLESS-RUN**, **BROWSER-VERIFIED**, **UNTESTED**.

> A registered dataset is evidence that a file exists with this provenance. It is not a validation of any model that uses it.
> The traffic model still **fails TAG M3.1**; the registry caps every traffic/emissions feature at *partial* and says why.

## 1. Vocabulary (binding; `backend/datasets/vocab.py`, `GET /api/datasets/vocabulary`)

| Axis | Values | Rule |
|---|---|---|
| Data class (per version) | observed · inferred · estimated · derived · synthetic | missing = *not classified* → cannot satisfy anything. **Synthetic never satisfies a dependency.** |
| Suitability (per version) | visualisation < screening < engineering | engineering only with a stated accuracy **and** an official source, else recorded as screening with a warning |
| Dataset status (computed) | available · synthetic · pending_review · not_acquired | not_acquired = UNKNOWN, never zero |
| Review status (per version) | active · pending_review · superseded · rejected | one active version per dataset |
| Quality check result | pass · warn · fail · unknown · not_applicable | a check that cannot run is unknown/not_applicable, never pass |
| Feature status (computed) | ready · partial · blocked | §5 |

## 2. Registry tables (additive, prefix `ds_`; existing tables untouched)

| Table | Content | Mutability |
|---|---|---|
| `ds_sources` | publisher, URL, access method (api/ogc/download/manual/rti/local/stream), licence text **as stated** + URL, robots / ToS notes, official, registration required | insert; seeds never overwrite |
| `ds_datasets` | title, theme, source, catalogue_ref (mirrored table row), backs_catalogue, recommended sources, limitations, staleness threshold, update-check endpoint | metadata editable (`PATCH`, audited) |
| `ds_dataset_versions` | observation start/end, published, source updated, retrieved_at (zone as recorded), sha256, coverage bbox / polygon, CRS, resolution, format, size, class, suitability, accuracy, licence at retrieval, HTTP headers, stats, origin + path, fingerprint, supersedes | **immutable** (ORM guard raises; no delete); only review fields change, class/suitability may be filled once if empty |
| `ds_files` | role (raw/derived/manifest), path, sha256, size, format, URL | insert |
| `ds_processing_runs` | pipeline, git commit, parameters, inputs (path, sha256, matched version), outputs, validation, times | insert |
| `ds_quality_checks` | check, status, value, detail, run time | append-only |
| `ds_features`, `ds_feature_dependencies` | feature (workspace, capability, status cap + reason, wired + note) → theme / preferred dataset, required quality, required/optional | seeded |
| `ds_update_checks` | method, URL, ETag, Last-Modified, Content-Length, catalogue modified, result, new version | insert |

Sources, datasets, versions and update checks are registered with `planning.audit`, so every create/review/patch writes
`audit_log` (actor from `X-Actor` or the request's who-field).

## 3. Versions and review
- First version of a dataset → active (nothing to replace). Every later version (changed manifest, new acquisition date, update
  check, mirrored row edited) → `pending_review`. `POST /api/datasets/versions/{id}/review {decision: activate|reject, reviewer}`;
  activating supersedes the previous active version, which stays readable (rollback = activate a superseded version).
- The reviewer may fill a missing class/suitability once (not `engineering`).

## 4. Quality checks (`backend/datasets/quality.py`; run at registration, `POST /versions/{id}/quality` re-runs)

| Check | Pass | Warn | Fail | Unknown / n.a. |
|---|---|---|---|---|
| classification | class and suitability recorded | — | either missing | — |
| licence | text + URL | text without URL, or UNKNOWN | — | — |
| crs | pyproj recognises the (first) EPSG code | — | unrecognised | not recorded / "n/a" |
| pune_coverage | ≥ 99 % of the study box (73.70–74.05 E, 18.40–18.70 N) inside the stated bbox/polygon | partial | no overlap | no coverage stated |
| staleness | data date ≤ threshold | ≤ 3× threshold | older | no threshold or no date |
| checksum | every file present and sha256 matches | — | mismatch or file missing | not hashed (no sha / > 2 GB; seeds hash ≤ 20 MB) |
| geometry_validity | GeoJSON ≤ 50 MB, or base city objects: no invalid/empty geometry | < 1 % invalid | ≥ 1 % | other formats: checked by the producing pipeline (unknown) |
| duplicates | no duplicate ids / exact geometries (base objects: OSM element shared by two objects of one type) | duplicates found | — | as above |

A version fails a dependency on `fail` of classification, checksum, pune_coverage, crs or geometry_validity. Staleness and licence
only add a warning to the reason (an 18-year-old screen line is still the only river screen line — shown, not hidden).

## 5. Feature readiness (`registry.feature_status`)
For each dependency the best candidate dataset (preferred id first, then any dataset of the theme) is classed: satisfied ·
insufficient_quality · quality_fail · unclassified · synthetic_only · pending_review · missing. Feature = **ready** when every
required dependency is satisfied; **partial** when some required dependency is satisfied or present at lower quality; else
**blocked**. A status cap (traffic, emissions, feasibility) can only lower the status, with its reason first. `wired = false`
says the feature's code does **not** read the data yet (e.g. a DEM is registered but the Underground profile still draws a flat
datum) — the UI shows "Not wired into the feature yet".

## 6. Capability → data requirements matrix

Status = registry on a copy of `twincity.db` with `/workspace/work/urbanos-data` imported (HEADLESS-RUN, 2026-11-13 ~21:40 IST).

| Capability (feature ids) | Minimum inputs | Quality needed (vis / screening / engineering) | Current status |
|---|---|---|---|
| **Explore** (explore.globe, explore.city_model) | base imagery; OSM roads + buildings; building heights | vis; heights need survey or LiDAR for anything beyond vis | **ready (vis)**. Heights are importer defaults (estimated). Imagery streamed (401 in sandbox). Google/Microsoft footprints registered (raw unclassified; comparison derived, screening). |
| **Design** (design.osm_import, design.feasibility_screening) | OSM network; flood lines; ASI limits; DP road lines / RoW; utilities; ground data | screening; land/RoW decisions need engineering (official DP, cadastre) | osm_import **ready**; feasibility **partial**: flood lines, ASI limits, RoW, utilities, boreholes not acquired. |
| **Underground** (alignment_profile, utility_conflicts, metro_clearance, ground_model) | bare-earth DTM; utility records with depth + ASCE 38 QL; boreholes; geology; groundwater; metro structure levels | screening for routing; **engineering** for clearances (surveyed QL-A, official structure levels) | profile: data **ready** (Copernicus DSM derived, screening) but **not wired**, and a DSM is not bare earth; utilities **blocked** (PMC sewage/SWD files registered, unclassified, no depths); metro clearance **partial** (OSM plan only); ground model **blocked**. |
| **Environment** (constraint_overlays, vegetation, air_quality, noise, heat, seismic) | OSM water/heritage/rail; land cover; LST; CAAQMS stations; noise stations; BIS seismic map | screening | overlays **ready**; vegetation data **ready** (WorldCover derived) **not wired**; air, noise, heat, seismic **blocked**. |
| **Flood/drainage** (flood.screening, flood.drainage_model) | flood lines; DEM; rainfall; drainage network with inverts | screening = flood lines + DEM; SWMM = **engineering** network + DTM + IDF | screening **partial** (DEM + CHIRPS box average present, flood lines missing; not wired); drainage model **partial/blocked** (no inverts; DEM and rainfall only screening). |
| **Traffic** (traffic.simulation, traffic.validation) | network; corrections; diurnal profile; observed OD / demand; counts at screen lines; speed series | screening for option comparison; forecasts need a model that passes TAG M3.1 | **partial**, capped: demand is synthetic zones + ODME (no observed OD); counts: 6 junctions (2025, date unstated), CCTV 3 h (2023), CMP 2008; **fails TAG M3.1**. |
| **Emissions** (emissions.estimate) | link flows by class + speed; Pune fleet mix; emission factors | screening | **partial**, capped: inherits traffic failure; HBEFA4 stand-ins; fleet mix not acquired. |
| **Population** (population.exposure) | census / ward population; ward boundaries | screening | **blocked**: no population data (zones synthetic); ward boundaries registered but unclassified (datameet = inferred). |
| **Coordination** (conflict_detection, heritage_permission) | project elements; base roads; OSM metro; utilities; ASI limits | screening; clearances engineering | detection **ready (screening)** with depths UNKNOWN; heritage permission **blocked** (no limits). |

Totals on the final run: 7 ready · 7 partial · 8 blocked (22 features); 89 datasets: 64 available, 1 synthetic, 24 not acquired.
Staleness of human-formatted dates ("Mon 2026-11-02 2:51 AM IST") was read as UNKNOWN in that run; fixed afterwards (UNIT-TESTED), not re-run in the browser.

## 7. API (`/api/datasets`, `backend/api/datasets_router.py`)

`GET /vocabulary` · `GET /sources` · `GET ""` (catalogue; re-syncs mirrored tables; `?theme&status&q`) · `GET /{id}` (versions,
files, processing, quality, update checks, used by features) · `POST ""` · `PATCH /{id}` (metadata) · `POST /{id}/versions` ·
`GET /versions/{vid}` · `POST /versions/{vid}/review` · `POST /versions/{vid}/quality` · `POST /{id}/update-check` ·
`POST /import {root?, dry_run}` · `POST /sync-catalogues` · `GET /features` · `GET /features/{fid}`. Typed client:
`frontend/src/lib/datasetsApi.ts`.

## 8. UI (desktop) and verification
- **Reports → Data catalogue** (`components/data/*`): counts, "Datasets & provenance" and "Feature readiness" open an overlay on the
  map stage (the inspector yields while it is open; Esc closes). Datasets grouped Available / Pending review / Synthetic only /
  Not acquired · UNKNOWN; provenance card (publisher, URLs, access, licence as stated, observation/publication/update/retrieval dates,
  CRS, resolution, format/size, sha256, class chip in the honesty colours, suitability, accuracy — missing = UNKNOWN), coverage
  footprint against the Pune study box, quality-check table, re-run checks, update check, version history with processing runs,
  files and review (activate/reject). Features grouped by capability with dependencies, state, the fails-validation TrustBadge and
  the not-wired chip. Uses DataStatus and TrustBadge.
- **UNIT-TESTED**: `backend/tests/test_datasets.py` (15); `frontend/src/engine/testing/DataCatalogueModel.test.ts` (14).
- **BROWSER-VERIFIED** (1440×900, Chromium/SwiftShader, backend :8321 on a copy of `twincity.db` + import, static :4521; harness
  `/workspace/work/uos-dsi-run/data_check.py`, results `/workspace/work/uos-dsi-run/results.json`): summary 89 datasets (second run, after more manifests landed); overlay
  lists 89 rows in 3 groups; Copernicus-derived DEM card shows licence as stated, CRS EPSG:4326, 100 % Pune coverage, 13 files
  sha256 match, geometry validity of the derived streams; OSM card shows data date 2026-11-01T21:21:36Z; demo seed chip SYNTHETIC;
  22 features rendered (10 not-wired chips, 3 fails-validation badges); no horizontal overflow. Screenshots
  `/workspace/work/urbanos/shots/p2/data-{catalogue-dem,catalogue-osm,features,features-scrolled}-1440x900.png`. Console: imagery 401
  (sandbox) only.

## 9. Not done / limits
- Feature dependencies are seeded from this matrix; reading a registered dataset inside a feature (DEM in Underground, land cover in
  Environment, flood screening) is not implemented — that is what `wired = false` shows.
- Geometry checks read GeoJSON only; FlatGeobuf/GeoPackage/GeoTIFF validity is taken from the producing pipeline's validation.
- Update checks are manual; no schedule. Robots/ToS notes are recorded only where a source states them.
- Theme guesses for manifests without a theme can be wrong (warned; correct with PATCH).
