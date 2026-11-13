# Data ingestion architecture (UrbanOS Phase 2, 2026-11-13)

Owner: dataset-intelligence work package (worktree `uos-wt-dsi`). Companion: `DATA_QUALITY_AND_PROVENANCE.md` (registry,
quality, feature readiness). Labels: **UNIT-TESTED** (pytest/vitest), **HEADLESS-RUN** (run in-process / CLI against a copy of
`twincity.db`), **BROWSER-VERIFIED**, **UNTESTED**. Times are IST (UTC+05:30) unless a zone is given.

## 1. How data flows today (audit, read from the code on 2026-11-13)

```
Geofabrik western-zone-latest.osm.pbf (222 MB, OSM data 2026-11-01T21:21:36Z, seq 1846)
 ├─ python -m osm.build_index ─────────► osm_index.db (175 MB, SQLite+R*Tree; roads, signals, buildings, metro; bbox 73.55–74.2 E, 18.3–18.85 N)
 │      read by: /api/osm/{status,ways,signals,buildings,metro} → frontend OSM importer (Design → Data → Import from OSM)
 │               → city_objects (twincity.db, scenario 'base'); feasibility site-data; coordination (OSM metro side B)
 └─ python -m feasibility.build_layers ► feasibility_layers.db (7.9 MB; water 1,409 · heritage 71 · trees 17,695 · railway 659)
        read by: /api/feasibility/site-data → FeasibilityPanel (engine runs in the browser) and Environment overlays;
                 environment_layers catalogue rows osm_* (status computed on read)
backend/data/{observed_counts,observed_screenlines,observed_validation,diurnal,network_corrections}/*.json (committed)
        read by: /api/observed-counts, /api/observed-screenlines, /api/diurnal-profile, /api/network-corrections
                 → engine/calibration/observedCounts.ts, screenlines.ts, simulation/timeOfDay.ts, SimulationMode.ts
twincity.db (49 MB on the dev copy):
  city_objects (20,732: 18,273 roads incl. 2 demo, 2,445 buildings incl. 16 demo, 8 zones, 5 gateways, 1 junction), areas (1,324 tiles)
  scenarios / scenario_object_changes / scenario_versions(+changes) / scenario_runs     ← Design / Simulate (copy-on-write proposals)
  td_* (Traffic Data Manager counts, PCU sets)  fs_* (feasibility assessments, documents, evidence, reviews)
  planning_* + audit_log (projects, links, decisions)  coordination tables + subsurface_* + environment_layers
  ds_* (this work: dataset registry)
Cesium ion (streamed imagery + Cesium World Terrain) → globe only; ion terms forbid storing it (EGR A9). 401 in this sandbox.
```

How the workspaces consume inputs:

| Workspace / engine | Reads | Writes |
|---|---|---|
| Explore | city_objects of the active alternative (via the engine), Cesium imagery/terrain | — |
| Design | OSM index (import), city_objects, scenario tables | scenario changes / versions |
| Feasibility engine (browser) | `/api/feasibility/site-data` (OSM index + feasibility layers) + the scenario's city model | `fs_*` |
| Underground | subsurface_* (imported AGS4/CSV/JSON), city_objects; flat datum (no DEM read) | proposal elements, subsurface_* |
| Environment | `environment_layers` catalogue, feasibility layers, OSM metro, session emissions | — |
| Simulate (traffic, ODME, emissions) | city_objects network, OSM corrections, diurnal profile, observed counts/screen lines, td_* counts | scenario_runs |
| Projects / Coordination | planning_*, project elements, base roads, OSM metro, utility records, scenario versions | coordination_runs / conflicts |

Findings of the audit:
- Provenance existed per subsystem (td_datasets, subsurface_datasets, environment_layers, JSON headers in `backend/data`) but there
  was **no single place** saying which dataset feeds which feature, how current it is, or whether a newer one exists.
- The feasibility layers default path (`backend/data/osm/feasibility_layers.db`) is **absent** in the main checkout; the layers
  only work when `TWINCITY_FEAS_LAYERS` points at a built copy. The registry's checksum check now reports this.
- Base buildings carry importer defaults (height 9 m / 3 floors / 36 residents) — **estimated**, not observed.
- 8 demand zones, 5 gateways, 16 sample buildings, 2 roads, 1 junction are **synthetic** seed objects that the simulator still uses
  for demand; the registry classes them `synthetic`, so no feature counts them as data.

## 2. Storage decision (with volumes)

| Volume today | Size | Rows / features |
|---|---|---|
| twincity.db (all app state) | 49 MB | 20.7 k objects; registry adds ~100–300 rows |
| osm_index.db / pbf | 175 / 222 MB | full western zone of India |
| `/workspace/work/urbanos-data` (other agents, 2026-11-13) | raw 1.4 GB, derived 1.2 GB | largest: building comparison FlatGeobuf 595 MB (from 1.13 M Google, 0.25 M Microsoft and 0.29 M OSM footprints in the study box), Sentinel-2 indices 306 MB, PMC storm-water 143 MB |

Decision — **no rewrite**:
1. **SQLite stays** for application state and the registry (single user, small row counts; R*Tree already used). ADOPT NOW.
2. **Large vectors stay in files**, never in `twincity.db`: **FlatGeobuf** for big read-only layers (built-in spatial index, bbox
   reads; already written by the buildings pipeline) and **GeoPackage** where a deliverable needs several layers/attributes or
   QGIS editing. Read with **pyogrio** (installed; MIT). ADOPT NOW for pipelines; the app reads them through bbox endpoints.
3. **Rasters as Cloud-Optimised GeoTIFF**, EPSG:32643 for analysis (30 m DEM, 10 m land cover) and EPSG:4326 for display; read
   windows with **rasterio** (installed; BSD-3). ADOPT NOW for pipelines.
4. **PostGIS: LATER**, when any of these becomes true: concurrent multi-user editing; server-side joins across multi-million-feature
   layers on every request; true 3D predicates (EGR A3); deployment beyond one machine. The `ds_*` tables are plain columns
   (geometry as GeoJSON/bbox text) and port 1:1.

## 3. On-disk convention (coordinator decision, adopted unchanged)

```
$URBANOS_DATA_DIR (resolved by backend/datasets/paths.py - see §6)
  raw/<source_id>/<YYYY-MM-DD>/<original files> + manifest.json        never modified, never committed
  derived/<dataset_id>/<version>/<outputs> + processing.json (+ optional manifest.json)
```

Registration rules (`backend/datasets/importer.py`, CLI `python -m datasets.importer [--root DIR] [--dry-run]`, API
`POST /api/datasets/import`):
- One directory = one registration. Fingerprint = sha256 of manifest/processing **content** + relative path. Unchanged → nothing.
- Changed manifest in the same directory, or a new date/version directory → a **new immutable version**. The first version of a
  dataset is active; any later one is `pending_review` and never replaces the active one until a reviewer activates it.
- Half-written / invalid JSON is **skipped and reported** (agents write concurrently); one bad directory never stops a scan
  (each directory runs in a savepoint).
- Accepted shapes (both seen on 2026-11-13): top-level `sha256/filename` or `files[]` with `filename|path|name`, per-file
  `url`, `retrieved_at`, `http_headers`; `licence` as text or `{licence_name|name|text, quote, url, publisher,
  attribution_required, verified_at}`; class as `data_class` or free text `classification` (first word must be one of the five
  classes, the full text is kept); processing `run_at|finished_at`, `parameters.bbox` as coverage, CRS from `crs`,
  `validation.crs|rasters[0].crs` or an `epsg32643` file name (labelled "from file name"). Unknown keys are kept in
  `stats.manifest_extra`. NaN/Infinity in validation JSON become null.
- **Nothing is assumed**: missing suitability/class → version is *not classified* (quality check `classification: fail`) and cannot
  satisfy a feature until a reviewer fills them (once) at review. Missing licence → `UNKNOWN`. Missing coverage → `UNKNOWN`.
- Theme: `theme|category|domain` if stated; otherwise guessed from the id (keyword table in `datasets/vocab.py`) **with a warning**;
  correct with `PATCH /api/datasets/{id}` (dataset metadata only, audited).
- Lineage: processing inputs are matched to registered files by sha256; a derived dataset with no stated licence inherits it when
  all inputs share one licence, else records "Inherited from inputs, each applies: …" with a warning. Unmatched inputs are counted.

Request to acquisition agents (to make their data count): add `"suitability"` (`visualisation|screening|engineering`) and a
`"theme"` (vocabulary in `GET /api/datasets/vocabulary`) to raw manifests, and an accuracy statement where the publisher gives one.

## 4. Catalogues absorbed, not duplicated

`sync_catalogues()` (startup and every `GET /api/datasets`) mirrors existing tables into the registry; their own tables and APIs
are untouched (`/api/coordination/environment-layers`, `/api/coordination/subsurface/*`, `/api/traffic-data/*` — UNIT-TESTED):
- `environment_layers` → `env:<id>` datasets (recommended sources carried over); the OSM-derived rows are **backed** by
  `osm_feasibility_layers` / `osm_local_index` (`backs_catalogue`) instead of being mirrored twice.
- `subsurface_datasets` → `subsurface:<id>` (theme boreholes/utilities; synthetic when the name/publisher/provenance says so;
  utilities `observed` only if every record is QL-A).
- `td_datasets` → `traffic:<id>` (synthetic flag honoured; an edited dataset → new pending version).

## 5. Update checks

`POST /api/datasets/{id}/update-check` — one request, User-Agent `UrbanOS-dataset-registry/1.0`. `http_head` compares ETag /
Last-Modified / Content-Length with the newest recorded version (or the last reference check); `ckan` compares
`metadata_modified`. A change registers a **new version** (`origin update_check`, no sha256, "NOT downloaded", pending review).
Errors and sources with no machine-checkable endpoint are recorded as such.

**Update monitor (2026-11-14): `python -m datasets.update_monitor [--only ids] [--exclude ids] [--plan] [--dry-run]`.**
Probes every dataset listed in `backend/datasets/update_targets.json` (plus any dataset whose own `update_check` is
`http_head`/`ckan`) and appends one `ds_update_checks` row per probed URL, `checked_by "update_monitor (CLI)"`.
- Methods: `http_head` (ETag / Last-Modified / Content-Length vs the raw manifest's recorded headers for the same URL; an
  identity-only difference is re-probed with `Accept-Encoding: gzip`, because pipelines using python-requests stored the gzip
  representation), `ckan` (`package_show`: `metadata_modified` and each acquired resource's `last_modified`), `stac_latest`
  (newest item over the Pune box vs the newest acquired scene), `github_release` (latest release; tags API when the repo
  publishes none), `geofabrik` (region page "contains all OSM data up to"; Geofabrik's robots.txt disallows `.osm.pbf`,
  `state.txt` and `*updates*`). Entries with `method: none` record **why** a source is not machine-checkable.
- Results: `update_available` (newer upstream) · `unchanged` · `changed` (differs, not demonstrably newer) · `first_seen`
  (no acquired reference; becomes the reference) · `error` · `not_checkable`. Unlike the manual API check, the monitor
  **registers no version**: an available update is a row for a reviewer (acquire with the pipeline → importer → review).
  `GET /api/datasets[/{id}]` returns `update_status` (latest verdict per URL, folded); the Data catalogue shows "Update
  available upstream … not downloaded".
- Politeness/safety: robots.txt read once per host per run (RFC 9309: `*`/`$` wildcards, longest match, 4xx = no rules,
  5xx = disallow all); Crawl-delay honoured with a 1 s floor per host (NWDP and Zenodo 10 s from the targets file); public
  http(s) only, every redirect re-checked (SSRF guard from `datasets.updates`); per-request timeout (default 15 s); a host
  that fails at network level or answers 401/403/429 is not contacted again in that run (OpenCity's Cloudflare challenge
  is recorded, never bypassed). Offline: every probe is an `error` row and the run exits 0.
- No scheduler was created: run it by hand or from cron. A full run makes ~70 requests and takes ~3–4 min (NWDP's 10 s
  delay dominates). Tests: `backend/tests/test_update_monitor.py` (mocked HTTP, UNIT-TESTED).

## 6. Configuration

| Variable | Default | Used for |
|---|---|---|
| `URBANOS_DATA_DIR` | `/workspace/work/urbanos-data` if that directory exists, else `backend/data/urbanos` | **canonical** data root (raw/, derived/) for pipelines, importer, registry and the terrain API; one helper `backend/datasets/paths.py` (read at call time). Aliases, lower precedence: `URBANOS_DATA_ROOT`, `URBANOS_DATA_HOME` (Wave-1 names). `URBANOS_RAW_DIR` / `URBANOS_DERIVED_DIR` override the sub-roots. Decision 2026-11-13 (uos-terrain-ug): the sandbox store is the default because raw data is never committed, so a fresh clone falls back to the empty repo path. |
| `URBANOS_DEM_VERSION` | `v3` | derived `elevation_copdem30` version the terrain API samples (falls back to the latest on disk) |
| `TWINCITY_OSM_INDEX`, `TWINCITY_FEAS_LAYERS` | `backend/data/osm/…` | existing readers; the registry's checksum check follows the same override |
| `DATABASE_URL` | `sqlite:///./twincity.db` | all tables incl. `ds_*` |
| `URBANOS_UPDATE_TARGETS` | `backend/datasets/update_targets.json` | update-monitor endpoint list |
| `URBANOS_CLASSIFICATION_OVERRIDES` | `backend/datasets/classification_overrides.json` | registry classification overrides |

## 7. Verification
- `backend/tests/test_datasets.py` — 15 tests, **UNIT-TESTED** (full backend suite 130 passed, 3 skipped).
- **HEADLESS-RUN** 2026-11-13 ~21:35 IST: `python -m datasets.importer` on a copy of `twincity.db` against
  `/workspace/work/urbanos-data` → 48 directories registered; a later re-run → 47 unchanged + 3 new (other agents still writing).
- Browser check: see DATA_QUALITY_AND_PROVENANCE §8.
