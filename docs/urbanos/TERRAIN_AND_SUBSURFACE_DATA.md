# Terrain and subsurface evidence data (UrbanOS Phase 2, 2026-11-13)

Worktree `uos-wt-terrain` (agent uos-terrain-ug). Labels: **BROWSER-VERIFIED** (Chromium + SwiftShader, local backend on a DB
copy), **UNIT-TESTED** (pytest / vitest), **HEADLESS-RUN** (pipeline run on the real data), **UNTESTED**.
Every value here is **screening** grade. Missing = UNKNOWN, never 0, never interpolated across.

## 1. Data directory (one helper)
`backend/datasets/paths.py` is the only place that resolves paths; pipelines (`_common.py`, `gov_common.py`), the registry
(`vocab.data_root`), the importer and the terrain API call it at call time.

| Order | Source | Value |
|---|---|---|
| 1 | `URBANOS_DATA_DIR` | canonical |
| 2 | `URBANOS_DATA_ROOT` | alias (Wave-1 geo pipelines) |
| 3 | `URBANOS_DATA_HOME` | alias (Wave-1 gov pipelines) |
| 4 | `/workspace/work/urbanos-data` | if the directory exists (raw data is never committed, so this sandbox store is where real data lives) |
| 5 | `backend/data/urbanos` | repo fallback (empty in a fresh clone) |

`URBANOS_RAW_DIR` / `URBANOS_DERIVED_DIR` override the sub-roots. `URBANOS_DEM_VERSION` (default `v3`) pins the DEM the API
samples. Tests: `backend/tests/test_data_paths.py` (UNIT-TESTED).

## 2a. Elevation v3: half-pixel georeferencing shift fixed (QA, 2026-11-13 23:4x IST)
- Defect: v1 and v2 built the EPSG:4326 mosaic with `rasterio.merge(bounds=PUNE_BBOX)`. Copernicus (and NASADEM) tiles are
  pixel-is-point (pixel edges at ±0.5″), so merge copied every pixel into a cell offset by half a pixel: v1/v2 data sit
  ~14.6 m east and ~15.4 m north of their true position. Found by sampling the API at 800 random points against bilinear
  interpolation of the raw tile: RMSE 1.81 m at zero offset, 1.17–1.51 m when the query was shifted +15 m E/N.
- Fix: `_raster.snap_bounds()` expands the bounds to whole source pixels before merging (`datasets/tests/test_hydro.py::
  test_snap_bounds_keeps_pixel_is_point_tiles_unshifted`, UNIT-TESTED). v3 = v2 code + this fix (HEADLESS-RUN; processing.json
  pins the commit; mosaic bounds recorded as `parameters.mosaic_bounds_snapped`).
- Result: API vs raw-tile bilinear RMSE **0.42 m**, mean +0.005 m, best at zero offset; COP − NASADEM RMSE 3.93 → 2.77 m
  (LE90 5.93 → 4.38 m). Hydrology re-derived on the corrected grid: 702 stream segments (v2 705), 5 edge-outlet catchments
  ≥ 10 km² (v2 6). The API, Explore streams/catchments and the registry feature notes now use v3; v1/v2 stay on disk unchanged.

## 2. Elevation pipeline v2: pysheds (GPL-3.0) removed
- `python -m datasets.pipelines.elevation process` → `derived/elevation_copdem30/v2/` (HEADLESS-RUN 2026-11-13 22:1x IST, git
  commit in processing.json, `git_dirty_datasets: false`). v1 (pysheds 0.5) is kept unchanged on disk.
- Hydrology is our own numpy code, `backend/datasets/pipelines/_hydro.py`: Priority-Flood+ε conditioning (Barnes et al.
  2014, already ours in `_raster.py`), D8 steepest descent (diagonal distance √2·cell, ESRI codes, ties in dirmap order),
  accumulation in descending conditioned elevation, catchment labelling in ascending elevation, stream segments split at
  confluences. pysheds is gone from `requirements.txt` and every import; `test_hydro.py::test_pysheds_not_required` keeps it out.
- Agreement with v1 (recorded in v2 `processing.json` → `validation.comparison_with_pysheds_v1`), same 1115×1239 30 m grid:
  flow direction **100 %** of 1 361 343 cells with a receiver; the 344 no-receiver cells are the same cells (pysheds codes them
  −1/−2, v2 codes 0); accumulation **identical** (max 957 531 cells); stream cells (> 1 km²) IoU **1.0** (27 015 cells); stream
  features 705 vs 705; catchments 6 vs 6, cell agreement **1.0**, total 1143.4 km². DEM, hillshade, slope, filled and
  conditioned rasters are byte-identical to v1 (same sha256).
- New in v2: `overlay_hillshade_epsg4326.png`, `overlay_slope_epsg4326.png` (on the EPSG:4326 DEM grid, bounds
  73.70–74.05 E, 18.40–18.70 N, a 1-cell rim next to nodata dropped) and `overlays.json` (bounds, legend, source, attribution,
  class `derived`, suitability `visualisation`). Slope classes 0–2 / 2–5 / 5–10 / 10–20 / > 20° are display classes, not criteria.

## 3. Terrain API (`backend/api/terrain_router.py`, `backend/terrain/dem.py`)
| Endpoint | What |
|---|---|
| `GET /api/terrain/info` | DEM dataset block |
| `GET /api/terrain/point?lon=&lat=` | one bilinear sample |
| `POST /api/terrain/points {points}` | ≤ 500 samples |
| `POST /api/terrain/profile {coordinates, step_m=30}` | samples along a polyline (≤ 5000; step grows beyond), each with `chainage_m`, `segment`, `t`, `elevation_m`, `status` |
| `GET /api/terrain/overlays`, `GET /api/terrain/overlays/{hillshade,slope}.png` | overlay metadata + images |
| `POST /api/terrain/subsurface-evidence {coordinates, radius_km=3, max_wells=8, sewer_near_m=50}` | §5 |

- Sampling: `dem_copglo30_epsg32643_30m.tif` (EPSG:32643, 30 m) held in memory (≈ 5.5 MB). Bilinear between the 4 surrounding
  cell centres; a sample touching a nodata cell → `nodata` (null), outside the raster → `outside_coverage` (null). Never filled.
- Every response carries `dataset`: `dataset_id`, `version`, `dataset_version_id` (registry id of that version when imported;
  in the e2e DB `dsv_13c29581fe55`, review status `pending_review` — v1 stays the active version until someone reviews),
  file sha256, CRS, resolution, `vertical_datum` "EGM2008 geoid (EPSG:3855)", `vertical_accuracy` = the publisher
  specification read from the raw manifest ("abs vertical < 4 m LE90; rel vertical < 2 m (slope ≤ 20 %) / < 4 m (> 20 %);
  abs horizontal < 6 m CE90"; not validated locally), `warning` "DSM: includes buildings/trees — screening only",
  attribution. Missing DEM → HTTP 503 (evidence still answers, with `dem: null`).
- Tests: `backend/tests/test_terrain.py` (UNIT-TESTED, tiny SYNTHETIC rasters/vectors written by the test).

## 4. Underground profile with ground
- Profile tab: when the server returns ≥ 1 known sample, the long-section is drawn on an **elevation axis (m EGM2008)** with
  the DSM ground line; spans where the ground is UNKNOWN are shaded and labelled "Ground UNKNOWN — outside DEM coverage".
  With no coverage, the service failing, or still loading, the original depth chart is kept with the flat datum labelled
  accordingly ("outside DEM coverage — UNKNOWN", "terrain service unavailable (…) — UNKNOWN", "loading DEM…").
- Depths stay **relative to ground**. Crown elevation at a vertex = DSM at the vertex − entered depth; between vertices the crown
  is a straight grade in elevation. Each vertex line shows chainage, crown m EGM2008, depth below DSM and the DSM value; each run
  reports its least crown depth below the DSM, and warns when the straight grade rises **above** the DSM.
- Chart label: dataset, version, registry id, EGM2008, DSM warning; footer: accuracy statement and suitability.
- Crossings with model objects keep their depth extents (relative to ground) placed on the DSM. PMC sewer crossings are drawn
  at their published invert (purple ○), tooltip: design/unverified, ASCE 38 QL-D, datum not stated, DSM and invert-below-DSM.
- Cross-section: DSM along the section line (debounced 250 ms), drawn relative to the DSM at the axis (depth 0).
- Code: `engine/underground/terrainProfile.ts` (pure, vitest `TerrainProfile.test.ts`), `components/underground/
  ElevationProfile.tsx`, `useTerrain.ts`, `lib/terrainApi.ts`, `SectionViews.tsx`.

## 5. Subsurface evidence near an alignment (drawer tab "Subsurface evidence")
| Item | Source (derived dir) | Shown | Honesty |
|---|---|---|---|
| Groundwater | `nwdp_groundwater_pune/2026-11-13` (CGWB + GSDA manual depth-to-water, 36 wells in the box) | nearest ≤ 8 wells within 3 km of the polyline: distance, latest level (m bgl) + date, observation count, sparkline of the series | "point observation, not interpolated"; well depth / aquifer UNKNOWN (not published) |
| Soil | `soil_soilgrids250/v1` | 0–30 cm clay/sand/silt %, bulk density, coarse fragments, SOC at points every ≈ 250 m (nearest cell) | estimated (ML); urban cells masked by SoilGrids → UNKNOWN; not for foundation design |
| Sewers | `pmc_sewage_pipelines_fgb/v1` (new: FlatGeobuf + spatial index of the OpenCity PMC sewer layer, 44 482 lines; `python -m datasets.pipelines.subsurface_index`) | crossings (chainage, pipe, Ø, invert at crossing linear between the pipe's published start/end inverts, DSM, invert below DSM) + pipes within 50 m (cap 40, "N more not shown") | levels are design/as-recorded, **ASCE 38 QL-D**, datum not stated. A datum check reports DSM − published manhole top level (on the e2e line: median 3.07 m, p10 1.76 m, p90 5.05 m, 820 pipes) |
| Boreholes | user-imported records only (`subsurface_records`, type borehole) | records within 3 km | none → "No borehole records — required: site investigation" + "Import AGS4 borehole logs in Underground → Subsurface records" |

## 6. Explore
Layers → "Terrain (Copernicus DEM)": Hillshade / Slope classes toggles (Cesium `SingleTileImageryProvider` with the stated
rectangle; removed when toggled off), slope legend, hillshade note, "Elevation at cursor" (ellipsoid pick → `GET /point` after
250 ms still) and the selected object's elevation (middle vertex). Source/version/registry id/processing time/DSM warning on screen.

## 7. Registry
Imported with `python -m datasets.importer` (e2e DB): `elevation_copdem30` v2 → `dsv_13c29581fe55` (pending_review),
`pmc_sewage_pipelines_fgb` v1 → `dsv_9cfad542327b` (active). Seed (`datasets/seed.py`): `underground.alignment_profile` wired
= true; new features `underground.subsurface_evidence` (partial, wired) and `explore.terrain_overlay` (wired). Wiring is a
statement about code, so the seed now updates an existing row's `wired`/`wiring_note` when the code's value changes.

## 8. Known limits
- The DSM is not bare earth: in built-up areas the "ground" includes roofs and trees; depth below DSM overstates cover there.
- Crown elevations between vertices assume a straight grade; the model stores depth per vertex only.
- Server chainages are UTM 43N; the editor's are local equirectangular (≤ 0.1 % apart); evidence chainages are mapped
  piecewise through the vertices.
- Stormwater drains (150 MB GeoJSON) are not yet indexed or shown.
