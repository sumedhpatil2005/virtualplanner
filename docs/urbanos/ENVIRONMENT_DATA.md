# Environment data — real Pune datasets in the Environment workspace (2026-11-13 IST)

Owner: environment-intelligence wiring (worktree uos-wt-envdata). Binding inputs: urbanos-p2 brief (honesty rules, storage
convention), DATA_INGESTION_ARCHITECTURE.md, DATA_QUALITY_AND_PROVENANCE.md, each dataset's `processing.json`.

## What is wired

| Catalogue id | Dataset (derived file) | Class · suitability | On screen |
|---|---|---|---|
| `landcover_worldcover2021` | ESA WorldCover 2021 v200, 10 m (`landcover_worldcover2021/v1`) | derived · screening | overlay + legend (classes present in the study area only) + class areas for the camera view or the selected proposal footprint |
| `s2_ndvi` | Sentinel-2 L2A NDVI, scene 2025-11-14 (default) and 2019-11-26 (comparison) | derived · screening | overlay, scene-date selector, ramp legend |
| `s2_mndwi` | Sentinel-2 L2A MNDWI, same two scenes | derived · screening | overlay, scene-date selector |
| `jrc_gsw_occurrence` | JRC Global Surface Water v1.5 occurrence, 30 m | derived · screening | overlay (0 % transparent) |
| `dem_streams` | D8 flow paths ≥ 1 km² from Copernicus GLO-30 (DSM) | derived · screening | bbox vector API, longest first, cap 2,000 + "N more not shown" |
| `dem_catchments` | Catchments to the study-box edge ≥ 10 km² | derived · screening | overlay, legend with each catchment's area in the box (km²) |
| `soil_soilgrids` | SoilGrids 2.0, 0–30 cm: clay, sand, silt, SOC, bulk density, AWC proxy | estimated · screening | overlay, property selector, per-property legend |
| `tree_census_2019` | PMC Tree Census 2019, 4,009,623 points | observed · screening; 2019 vintage | bbox API: points (≤ 3,000 in view) or grid clusters with the total |
| `air_cpcb_caaqms` | CPCB/MPCB/IITM stations, 15-min series 2024–25 | observed · screening | station markers (8 with listed coordinates; 3 with UNKNOWN coordinates listed, not drawn) + panel: station, parameter, daily/monthly mean chart, data dates, sample counts |
| `rain_imd_025`, `rain_chirps`, `rain_nwdp_district` | IMD 0.25° gridded 2000–2025 (4 cells), CHIRPS v2 box average 1986–2025, IMD district daily (NWDP, 86 days) | derived / estimated / observed · screening | rainfall panel: annual totals with stored suspect flags, monthly means, highest daily totals, CHIRPS annual line. States **not IDF curves, not design storms** |
| `flood_lines_pmc` | PMC AutoDCR Red_Blue / WRD sheets | — | **blocked**: restricted, needs PMC permission (MISSING_DATA_AND_COLLECTION_PLAN item 2); never drawn |
| `flood_model` | — | — | **blocked**: UrbanOS has no flood model |
| `s2_builtup_change` | Sentinel-2 built-up change rule 2019→2025 | — | **rejected**: vs WorldCover 2021 built-up F1 0.457 (P 0.616, R 0.363, IoU 0.296) on the 2025 scene; mixes phenology/soil moisture with change |

Each row shows source · data date · licence (`DataStatus`), data class and suitability, vintage note, attribution when
shown, limitations and provenance (pipeline, git commit, run time, output file sha256 — read from `processing.json`,
not recomputed). Licences are quoted from the raw manifests; IMD gridded and NWDP-IMD licences are **UNKNOWN** as stated.
Rows of the coordination catalogue (`/api/coordination/environment-layers`) that are "Not imported" and covered by a real
dataset (`covers`: land_cover, tree_census, air_quality, soil, flood_lines, dem) are replaced by the real row; available
OSM rows stay. Nothing in this catalogue is engineering-grade.

## Backend (`backend/envdata/`, `backend/api/envdata_router.py`, prefix `/api/env-data`, read-only)
- `GET /catalogue` — rows above; status computed on read (`available` only if the file exists; else `missing` with the path).
- `GET /layers/{id}/render.png?bbox=W,S,E,N&width=&variant=` — `rasterio.warp.reproject` of the requested window onto an
  EPSG:4326 grid (nearest for classes, bilinear for indices/soil), coloured by the legend, nodata/NaN/outside → transparent,
  PNG ≤ 1600 px, disk cache keyed by file mtime/size, variant, bbox, size (`URBANOS_RENDER_CACHE`, default
  `/tmp/urbanos-render-cache`). Blocked/rejected → 409; vector layers → 422; file missing → 404.
- `GET|POST /layers/landcover_worldcover2021/areas` — class areas (km², %) inside a bbox or a GeoJSON polygon from the
  EPSG:32643 10 m copy (pixel centre in polygon × 100 m²); > 2,000 km² → 422; no overlap → empty classes +
  `out_of_coverage` (UNKNOWN, not zero). Without bbox: the pipeline's precomputed study-box/PMC/PCMC areas.
- `GET /layers/dem_streams/features?bbox=&limit=` — STRtree over the reprojected GeoJSON, cap ≤ 5,000.
- `GET /trees?bbox=&limit=` / `POST /trees/count` — R*Tree index (`datasets.pipelines.tree_index`, below); exact
  float64 filter after the float32 R*Tree overlap; clusters from pre-aggregated grids (0.04/0.01/0.0025/0.000625°),
  finest level with ≤ 1,500 cells in view.
- `GET /air/stations`, `GET /air/series?station=&param=&agg=raw|hour|day|month` — bucket means of the published 15-min
  values with `n` per bucket (96 = full day); no gap filling, no interpolation; unknown station → 404.
- `GET /rainfall/summary`, `GET /rainfall/daily?cell_lon=&cell_lat=&year=`.
- Paths: `URBANOS_DATA_DIR` (canonical; aliases `URBANOS_DATA_ROOT`, `URBANOS_DATA_HOME`), `URBANOS_DERIVED_DIR` overrides;
  default `backend/data/urbanos` if it holds `derived/`, else `/workspace/work/urbanos-data`.

New pipeline: `python -m datasets.pipelines.tree_index` → `derived/pmc_tree_census_2019_index/v1/trees_index.sqlite`
(436 MiB) + `processing.json` (4,009,623 rows, 429 species, 0 skipped; attributes as published). Built
2026-11-13 22:15 IST from an uncommitted pipeline file; the code is identical to commit 38a02df (re-run to pin the commit).

## Registry
`datasets/seed.py` (append-only): `wired=True` for environment.vegetation and environment.air_quality; new features
environment.surface_water, environment.rainfall, environment.soil, environment.terrain_hydrology (wired). `flood.screening`
stays `wired=False` (context layers are not flood screening). The seed now upgrades a stored `False` to `True` when the
code starts reading data (never downgrades). Readiness still depends on the registry having the geo/gov manifests imported
and classified (other agents).

## Feasibility screening
Not changed: its rules have a `treesInFootprint` slot, but wiring the census into it needs an async fetch inside the
synchronous site assessment; left for a follow-up (`POST /api/env-data/trees/count` is ready for it). No rule reads land
cover or JRC water (no slot), so none was added.

## Verification
See ENVIRONMENT_EXPLORE_SIMULATE.md § Environment data run report.
