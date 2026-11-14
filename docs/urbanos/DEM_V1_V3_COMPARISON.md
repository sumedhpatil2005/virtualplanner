# DEM `elevation_copdem30` — v1 vs v3 (v2 briefly): measured comparison and activation decision

Status Sat 2026-11-14 12:22 IST: **v3 activated** in the Dataset Registry (v1 → `superseded`, readable, rollback = activate
v1 again; v2 left `pending_review`, recommended for rejection). The app already read v3 (since `3713eb4`), so the
registry/app mismatch is gone without a code change. Suitability stays **screening** (Copernicus GLO-30 is a DSM).

Every number below was measured from the files on disk on 2026-11-14 with rasterio 1.5.2 / numpy 2.5 — not taken from
`processing.json` or earlier docs. Reproduce:

```
cd backend
python -m datasets.tools.dem_version_compare --out /tmp/compare.json        # grids, coverage, nodata, raw-truth, diffs
python -m datasets.tools.dem_version_impact  --out /tmp/impact.json          # transects (/api/terrain/profile),
                                                                             # sewers (/api/terrain/subsurface-evidence), streams
```
Result files of this run: `/workspace/work/uos-dem-compare/compare.json`, `/workspace/work/uos-dem-compare/impact.json`
(sandbox, not committed).

## 1. Decision
**Activate v3.** It meets every condition of the decision rule:

| Condition | Evidence (measured) | Met |
|---|---|---|
| Full coverage of the study box (lon 73.70–74.05, lat 18.40–18.70) | v3: **0** nodata cells in the box (EPSG:4326 and UTM). v1: **1,080** nodata cells (0.079 %) = the whole easternmost column (lon 74.0497–74.0500) | yes |
| Same or better quality | App sampler vs raw Copernicus tile (bilinear), 4,000 random points: v3 RMSE **0.40 m**, v1 **2.25 m**. v3 best-matches the source at zero offset; v1 best at (−15 m E, −15 m N). Independent check vs 44,482 PMC sewer manhole top levels: spread (NMAD) v3 **2.19 m** vs v1 **2.51 m** | yes |
| Provenance clean | Same two raw tiles (sha256 `e5e127b1a1b5…`, `1a44c053a6ef…`) for v1/v2/v3; all 15 v3 outputs re-hashed = `processing.json`; `git_dirty_datasets: false`; hydrology by own numpy D8 (v1 used GPL-3.0 pysheds, since removed) | yes (caveat §6) |
| Licence fine | Copernicus DEM GLO-30 free licence, attribution recorded in the raw manifest; unchanged between versions | yes |

Activation used the registry's own mechanism — `POST /api/datasets/versions/dsv_0d0e82a8c181/review`
`{"decision":"activate", …}` (→ `registry.review_version`), not a hand edit. DB backed up first to
`/workspace/work/twincity.db.bak-2026-11-14-pre-dem-v3` (sqlite backup API, `integrity_check ok`).

## 2. Product facts (all three versions)

| | v1 | v2 | v3 |
|---|---|---|---|
| Registry id / status now | `dsv_394ee44c2555` / superseded | `dsv_c5c69b12179f` / pending_review | `dsv_0d0e82a8c181` / **active** |
| Source product | Copernicus DEM GLO-30 Public, 2021 release (AWS COG tiles N18E073, N18E074; `Last-Modified` 2022-05-09; TanDEM-X acquisitions 2011–2015) | same | same |
| Raw tile metadata | EPSG:4326, 1″ (0.000277778°), float32, `AREA_OR_POINT=Point`, nodata none, **no vertical CRS in the file** | same | same |
| Vertical datum | EGM2008 (EPSG:3855), metres — **from the publisher, not the file**: Copernicus DEM Product Handbook Table 1 ("Vertical EGM2008 (EPSG 3855)… Vertical Unit meters", https://dataspace.copernicus.eu/sites/default/files/media/files/2026-10/geo1988-copernicusdem-spe-002_producthandbook_i6.1.pdf); Earth Engine catalogue ("The DSM uses the EGM2008 vertical datum: EPSG:3855", https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_DEM_GLO30); raw manifest `vertical_datum` | same | same |
| Units | metres (product spec); GeoTIFF unit tag empty in all files | same | same |
| EPSG:4326 file | 1080 × 1260, origin 73.700000 / 18.700000 (half a pixel off the source grid), nodata −32767: 1,080 cells | identical to v1 | 1081 × 1261, origin 73.699861 / 18.700139 (= source pixel edges), 0 nodata |
| UTM file (served by `/api/terrain`) | EPSG:32643, 30 m, 1115 × 1239, nodata NaN 19,798 (1,080 inside box) | identical to v1 (grid diff = 0.000 m everywhere) | EPSG:32643, 30 m, 1115 × 1238, same origin, NaN 15,352 (**0** inside box) |
| Elevation range (UTM) | 519.5 – 1147.7 m | same | 519.5 – 1149.4 m |
| Pipeline commit recorded | `346e871` (pysheds 0.5 D8) | `fc58a15` (own numpy D8) | `b2bffe9` (own D8 + snapped mosaic bounds) |
| Stream segments / length | 705 / 946.0 km | 705 / 946.0 km | 702 / 947.4 km |
| Edge-outlet catchments ≥ 10 km² | 6 | 6 | 5 |
| Overlays (hillshade/slope PNG) | **none** (`/api/terrain/overlays` would 404) | yes | yes |

v2 = v1 bit-for-bit in elevation (grid difference 0.000 m on all 1,361,621 cells); it differs only in the hydrology
library. It carries the same half-pixel shift and the same missing column, so it has no reason to be active.

## 3. Elevation differences, v3 − v1 (common UTM grid, cells inside the study box)

| Statistic | Value |
|---|---|
| Cells compared | 1,361,621 |
| Mean | −0.13 m |
| RMS | 2.11 m |
| p5 / p95 | −3.29 m / +2.64 m |
| LE90 (|Δ|) | 2.95 m |
| Max |Δ| | 20.17 m |
| Share |Δ| > 1 m / > 5 m | 34.1 % / 4.6 % |
| Slope (deg) v3 − v1 | RMS 2.80°, max |Δ| 81.7° (single cells on cliffs/building edges) |

**Where the differences cluster** — on slope, i.e. a planimetric shift, not a vertical bias:

| Stratum | Cells | RMS Δ | p95 |Δ| |
|---|---|---|---|
| Slope 0–2° | 562,925 | 0.52 m | 1.03 m |
| Slope 2–5° | 463,382 | 1.09 m | 2.06 m |
| Slope 5–10° | 181,799 | 2.11 m | 3.83 m |
| Slope 10–20° | 103,047 | 4.18 m | 7.11 m |
| Slope ≥ 20° | 48,880 | 7.50 m | 12.00 m |
| Water (JRC GSW occurrence ≥ 50 %) | 10,801 | 0.69 m | 1.06 m |
| Box rim (≤ 2 cells) | 8,254 | 2.98 m | 7.38 m |
| Tile seam lon 74.000 ± 60 m | 4,425 | 1.97 m | 4.26 m (no seam effect: same as elsewhere, 2.11 m) |

A linear fit Δ ≈ a·∂z/∂E + b·∂z/∂N explains **R² = 0.71** of the difference and implies v1 reports, at each point, the
surface ≈ 11 m west / 16 m south of it (features displaced ≈ 19 m north-east). The offset search agrees: v1 vs raw is
best at (−15 m, −15 m) with RMSE 1.07 m (2.29 m at zero offset); v3 is best at zero offset (0.40 m). Flat water
surfaces barely change; hill flanks change most.

Raw-truth check (app sampler `terrain.dem.Dem.sample_xy` − raw-tile bilinear, 4,000 random points, seed 42):

| | Mean | RMS | p5 / p95 | Max |Δ| | |Δ| > 1 m |
|---|---|---|---|---|---|
| v1 (= v2) | +0.14 m | 2.25 m | −2.74 / +3.53 m | 16.43 m | 35.7 % |
| v3 | +0.01 m | 0.40 m | −0.59 / +0.58 m | 2.99 m | 3.3 % |

(v3's residual 0.40 m is the second resampling, 4326 → 30 m UTM, not a shift.)

## 4. Terrain profiles along real transects (`POST /api/terrain/profile`, step 30 m, v1 vs v3)

| Transect | Length | Δ v3 − v1: mean / RMS / p5 / p95 / max |Δ| | Relief v1 → v3 | Note |
|---|---|---|---|---|
| T1 Pune Metro Purple Line underground section (OSM way 586112436, `railway=subway tunnel=yes`, Range Hills → Swargate) | 5,454 m | −0.32 / 1.02 / −1.91 / +1.15 / **3.42 m** (ch 1,192 m, 73.84996 E 18.53053 N: 558.26 → 561.68) | 48.35 → 47.39 m | 0 nodata in both |
| T2 Mutha river crossing N–S at lon 73.8530 (lat 18.513–18.525; crosses 159 m of PMC river polygon) | 1,328 m | −0.38 / 1.38 / −2.39 / +1.60 / **3.66 m** (bank, ch 915 m) | 32.07 → 31.27 m | lowest point 537.69 m at ch 974 (v1) → 536.85 m at ch 944 (v3): the channel moves 30 m south |
| T3 Parvati hill W–E at lat 18.4967 | 1,900 m | +0.24 / 1.34 / −0.98 / +2.77 / **5.28 m** (east flank, ch 831 m: 638.21 → 643.49) | 86.13 → 87.76 m | summit 652.42 → 654.92 m (same chainage) |
| T4 Vetal Tekdi W–E at lat 18.5270 | 4,223 m | −0.76 / 1.79 / −3.77 / +0.98 / **7.76 m** (west flank, ch 539 m: 659.35 → 651.59) | 131.41 → 130.79 m | summit 697.16 → 695.85 m (same chainage) |

There is **no underground alignment in the main DB** (`city_objects` holds no `underground_alignment`;
`project_proposal_elements` is empty), so T1 uses the real OSM metro tunnel from the app's OSM index instead.

## 5. Impact on app outputs

**(a) Underground profiles and depth below ground.** Depths are entered relative to ground per vertex; crown elevation at a
vertex = DSM − depth; between vertices the crown is a straight grade and the depth below the DSM there is
ground(ch) − crown(ch) (`frontend/src/engine/underground/terrainProfile.ts`). Changing v1 → v3 therefore:
- shifts crown **elevations** at vertices by the local Δ: on T1 with 4 vertices −0.48 / −0.16 / +0.22 / −1.61 m;
- changes the drawn **depth below ground between vertices** by Δground − (lerp of Δ at the vertices): T1 with 4 vertices
  RMS 1.05 m, p5/p95 −1.81/+1.71 m, max 3.74 m; with 68 evenly spaced vertices (~80 m) RMS 0.63 m, max 2.55 m.
- **Utility crossing depths** (`/api/terrain/subsurface-evidence`, PMC sewers, QL-D): T1 crosses 20 sewers in both
  versions (same pipes); `invert_below_dsm_m` changes by mean −0.57 m, RMS 0.96 m, max 1.90 m. The datum check along T1
  (DSM − manhole top level, 82 pipes) moves from median 6.99 m (p10–p90 3.57–10.13) to 5.34 m (3.46–9.88). City-wide
  (44,482 pipes with a top level): median 3.89 → 3.80 m, NMAD 2.51 → **2.19 m**, IQR 3.41 → **2.98 m** — v3 sits more
  consistently on the street network. The published invert/top levels themselves do not change (they are PMC values).
- None of this changes a clearance between two buried objects at the same crossing point (both are relative to the same
  ground sample); it changes absolute levels and the DSM-relative depths the Profile draws.

**(b) Environmental flow paths (`dem_streams`, threshold 1 km²).** Counts barely move (705 → 702 segments, 946.0 → 947.4 km;
catchments 6 → 5), but the lines move: only 26.8 % of v3 stream length lies within 15 m of v1 streams (68.6 % within
30 m, 88.6 % within 60 m) — the half-pixel shift relocates the D8 paths by about a cell. Against PMC drainage
(3,075 nallas, 1,009.9 km, plus 12 river polygons), inside the PMC data hull:

| Overlap | v1 | v2 | v3 |
|---|---|---|---|
| Stream length within 30 m of a PMC nalla/river | 43.34 % | 43.87 % | **44.18 %** |
| … within 60 m / 100 m | 57.47 / 66.88 % | 57.70 / 67.58 % | 57.65 / 67.17 % |
| PMC nalla length within 30 m of a stream | 26.22 % | 26.45 % | **27.77 %** |
| … within 60 m / 100 m | 41.23 / 50.86 % | 41.49 / 51.21 % | 41.53 / 50.71 % |

v3 is slightly better at the tight (30 m) tolerance and equal within noise at 60–100 m. Flow paths remain screening only
(DSM: roofs and canopy steer D8 in dense fabric).

## 6. Caveats and what this does not show
- **Recorded commits are pre-rewrite objects.** `346e871` (v1), `fc58a15` (v2) and `b2bffe9` (v3) exist in the object store
  but are **not reachable from this branch** (history was rewritten; on-branch equivalents with identical messages:
  `d2d9730`, `2a22ef3`, `fb6592d`). `git diff b2bffe9 fb6592d -- backend/datasets/pipelines` is empty, and
  `elevation.py` / `_hydro.py` are unchanged from `b2bffe9` to HEAD. Do not `git gc --prune` until the next pipeline run
  records a reachable commit. This applies equally to v1, so it does not favour v1.
- Upstream has a newer **Copernicus GLO-30 2024_1** release (Earth Engine marks the 2021 collection as superseded). All three
  versions use the 2021 release; moving to 2024_1 would be a new raw acquisition and a v4, not part of this decision.
- No Pune survey control: absolute accuracy is the publisher's global spec (< 4 m LE90). The PMC manhole comparison is a
  consistency check (datum of PMC levels UNKNOWN), not an accuracy statement.
- Nothing needed regenerating: no derived dataset outside `elevation_copdem30` lists a v1 file among its `processing.json`
  inputs (grep of all `derived/*/*/processing.json`), and v3's streams, catchments, slope, hillshade and overlays were
  already derived from the v3 DEM in the same run. v1/v2 directories untouched.
- Importer re-run on the main DB after activation: 61 directories `unchanged`, statuses kept (v1 superseded, v2
  pending_review, v3 active); it also filled 46 empty dataset titles from `classification_overrides.json`, which shows in
  the regenerated `DATA_SOURCE_CATALOGUE.md`.
