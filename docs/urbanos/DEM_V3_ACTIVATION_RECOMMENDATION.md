# DEM `elevation_copdem30` v3 — activation recommendation (for a human reviewer)

Status 2026-11-14 00:30 IST: **v1 active, v2 and v3 `pending_review`. Nothing was activated by the agent.** Activation is a
human decision: Reports → Data catalogue → dataset `elevation_copdem30` → Versions → v3 → **Activate** (reviewer name
required), or `POST /api/datasets/versions/{id}/review {"decision":"activate","reviewer":"<name>","note":"…"}`.


**Update Sat 2026-11-14 12:22 IST: v3 ACTIVATED** (`dsv_0d0e82a8c181` active, v1 `dsv_394ee44c2555` superseded, v2 still
pending_review) through `POST /api/datasets/versions/{id}/review` after a measured re-comparison — see
[DEM_V1_V3_COMPARISON.md](DEM_V1_V3_COMPARISON.md). The registry and the app now agree on v3. The text below is the
pre-activation recommendation, kept as written.
## Recommendation
**Activate v3** (supersedes v1; reject v2 or leave it superseded-by-skip). Suitability stays **screening**, class stays
**derived** (Copernicus GLO-30 is a DSM: buildings and trees included; not bare earth; no Pune-specific vertical accuracy).
Nothing in this recommendation raises the DEM to engineering use.

## Evidence
| # | Check | v1 (active) | v3 (pending) | Label |
|---|---|---|---|---|
| 1 | Grid origin of `dem_copglo30_epsg4326.tif` vs raw Copernicus pixel edges (raw tile `AREA_OR_POINT=Point`, edges at 72.999861° E / 19.000139° N + k″) | 73.700000° E, 18.700000° N — half a pixel off the source grid | 73.699861° E, 18.700139° N — on the source grid (`parameters.mosaic_bounds_snapped`) | HEADLESS-RUN |
| 2 | Value at each pixel centre vs the raw tile pixel at the same location (3,4xx random pixels, N18E073 tile, seed 42) | bit-identical in 1.6 %; RMSE 2.95 m; bit-identical (100 %) only to the raw pixel half a pixel to the west → data displaced ≈ 0.5 px (≈ 15 m) | bit-identical in **100 %**; RMSE **0.000 m** | HEADLESS-RUN (this agent, 2026-11-14 00:1x IST; output `/workspace/work/uos-mon-run/dem_grid_check.txt`) |
| 3 | v2 (same as v1 except hydrology library) | same half-pixel offset as v1 (bit-identical 1.7 % at zero offset) | — | HEADLESS-RUN |
| 4 | API sampling vs raw-tile bilinear, 800 points (QA agent) | RMSE 1.81 m at zero offset; best when the query is shifted +15 m E/N | RMSE 0.42 m, mean +0.005 m, best at zero offset | HEADLESS-RUN (reported in TERRAIN_AND_SUBSURFACE_DATA.md §2a; not re-run here) |
| 5 | Copernicus − NASADEM difference (QA agent) | RMSE 3.93 m, LE90 5.93 m | RMSE 2.77 m, LE90 4.38 m | HEADLESS-RUN (§2a; not re-run here) |
| 6 | Fix covered by a test | — | `datasets/tests/test_hydro.py::test_snap_bounds_keeps_pixel_is_point_tiles_unshifted` | UNIT-TESTED |
| 7 | Output integrity | — | all 15 outputs re-hashed = processing.json sha256 (41.0 MB) | HEADLESS-RUN |
| 8 | Code provenance | git `346e871`, `git_dirty_datasets: false`, hydrology via pysheds 0.5 (GPL-3.0, since removed from requirements) | git `b2bffe9`, `git_dirty_datasets: false`, own numpy D8 (`_hydro.py`) | git cat-file: both commits exist |
| 9 | Inputs | same raw tiles (sha256 `e5e127b1a1b5…`, `1a44c053a6ef…`) | same | HEADLESS-RUN |
| 10 | Hydrology on the corrected grid (QA agent) | — | 702 stream segments (v2: 705); 5 edge-outlet catchments ≥ 10 km² (v2: 6) | §2a |

## Why it matters now: the registry and the app disagree
Since commit `3713eb4` the application already **reads v3** (`terrain/dem.py` `DEFAULT_VERSION = "v3"`, env
`URBANOS_DEM_VERSION`; `envdata/catalogue.py` streams and catchments from v3), while the registry's **active** version is
v1. The Data catalogue therefore shows provenance (sha256, git commit, processing history) for a file the features do not
use. Activating v3 removes that inconsistency. If a reviewer **rejects** v3 instead, the app should be pinned back
(`URBANOS_DEM_VERSION=v1`) so the registry and the app agree again — and the 15 m shift returns.

## What does not change
- DSM, not bare earth: flow paths in dense urban fabric follow roofs and canopy; streams/catchments are screening only.
- Vertical datum EGM2008; publisher spec (global): absolute vertical < 4 m LE90 — no Pune-specific accuracy statement.
- Raw tiles and the v1/v2 directories stay on disk unchanged; activation only changes `review_status` (v1 → superseded,
  readable, rollback = activate v1 again).
- The update monitor reports the upstream Copernicus tiles **unchanged** (ETag/Last-Modified/Content-Length equal to the
  acquisition, 2026-11-14 00:0x IST), so v3 is built from the current upstream files.
