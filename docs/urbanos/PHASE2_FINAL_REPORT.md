# UrbanOS Phase 2: real data for Pune — final report

Branch `urbanos-city-planning-redesign` (local only, not pushed, not merged). Report written 2026-11-14 04:30 IST at tip 2c4d65e.
Labels: BROWSER-VERIFIED (seen in a real headless Chromium run of the built app), UNIT-TESTED, HEADLESS-RUN (script run, not UI), UNTESTED.

## 1. Research and sources
- 101 datasets registered in the Dataset Registry (`/api/datasets`), every one with source, licence, access route, date, CRS, coverage and review state. Full list: `DATA_SOURCE_CATALOGUE.md` (generated from the registry). Availability by theme: `PUNE_DATA_AVAILABILITY.md`.
- Study area PMC + PCMC, WGS84 lon 73.70–74.05, lat 18.40–18.70; engineering CRS EPSG:32643.

## 2. Downloads (raw originals preserved)
- 19 sources under `urbanos-data/raw/<source>/<date>/` with `manifest.json` (URL, hash, size, licence, retrieval time), 2.8 GB: Copernicus DEM GLO-30, NASADEM, ESA WorldCover 2021, JRC GSW, SoilGrids 250 m, Sentinel-2 L2A (Earth Search), Google Open Buildings v3, Microsoft ML buildings, CHIRPS v2, IMD 0.25° gridded rainfall, NWDP India-WRIS, CPCB CAAQMS station list, datameet municipal wards, OpenCity Pune (PMC GIS layers), PMC open-data catalogue, Bhuvan OGC capabilities + WMS samples, PMC AutoDCR GeoServer (probe only).

## 3. Imports and derived data
- 41 derived datasets under `urbanos-data/derived/<dataset>/<version>/` with `processing.json` (inputs, code commit, parameters), 2.9 GB. Reproducible from raw via the `backend/datasets` pipeline; importer re-run on the real DB exit 0.
- Includes elevation (Copernicus 30 m, v1/v2/v3), land cover, surface water, soil, Sentinel-2 indices, CHIRPS/IMD rainfall, CPCB air quality, NWDP groundwater levels, PMC sewer pipelines, storm-water drains and chambers, STPs, nallas, rivers, road centreline, wards (2012/2017/2022/2025, admin, prabhag), tree census 2019, parks, fire stations, PMPML bus stops/depots, buildings comparison.

## 4. Features using real data
- Explore: terrain readout, buildings (capped 2,000 of 2,315 in view), PMC sewer/storm-water layers, inspector with provenance.
- Underground: alignment profile against DEM, utility crossings with ASCE 38 quality level (QL-D where depth is not recorded), soil evidence, conflict check.
- Environment: flow paths from DEM, land cover, surface water, rainfall, air quality, groundwater.
- Projects: conflict detection against real sewer and building data, with source and depth basis shown.
- Reports: dataset catalogue, suitability, update-available status.
- Update monitor (`python -m datasets.update_monitor`): checks 66 sources for newer versions by metadata only; never downloads; respects robots.txt.

## 5. Gaps (nothing invented)
- Not publicly found: PMPML GTFS, metro alignment and tunnel depths, traffic counts and speeds, IDF curves, boreholes, water-supply network, sewer invert levels for most pipes.
- Behind accounts or keys not registered: Bhuvan, GSI Bhukosh, data.gov.in (503), OpenAQ, Copernicus Data Space, ERA5/CDS, ALOS AW3D30, Earth Engine, PMC portal (CAPTCHA).
- Unreachable from the sandbox: India-WRIS portal, Bhukosh, PMRDA, MRSAC, cgwb.gov.in. OpenCity returns 403 (Cloudflare) to scripts; not bypassed.
- No utility, groundwater, geology or traffic observation was generated. A downloaded dataset does not validate any simulation.

## 6. Generated / inferred data
- Classified `inferred`: WorldCover land cover, Google and Microsoft ML building footprints, DEM-derived flow paths, Sentinel-2 indices. Shown with honesty badges.
- Traffic model remains a model: it FAILS TAG M3.1 (GEH<5 on 0 of 15 counts, screen line −30.5%).

## 7. Field and official requests needed
- PMC AutoDCR GeoServer access (request drafted in `MISSING_DATA_AND_COLLECTION_PLAN.md`), RTI requests, borehole logs, sewer invert-level survey, classified traffic counts, official Census and PMC/PCMC ward boundaries.

## 8. Quality and provenance
- Every dataset has a review state, licence and origin (`DATA_QUALITY_AND_PROVENANCE.md`); 0 "classification fail" and 0 bare-id titles in Reports (BROWSER-VERIFIED).
- CHIRPS terms UNKNOWN; OpenCity licence treatment needs a decision.

## 9. Tests and screenshots
- pytest 254 passed, 3 skipped (missing local OSM index) (UNIT-TESTED, backend unchanged since).
- vitest 772 passed, 7 skipped, 0 failed across 102 files at 2c4d65e (UNIT-TESTED).
- tsc 0 errors; oxlint 0 errors; vite build ok.
- Browser tour of all 7 workspaces at 1440×900 and 1024×768 (BROWSER-VERIFIED): no clipping (Underground soil table scrolls sideways by design), no stale layers after toggles, shell never scrolls, timestamps carry a zone, units on values. Console: only the sandbox ion 401 and blocked Google Fonts.
- Error/slow/out-of-coverage/toggle-off-while-loading harnesses for terrain, infra and environment (BROWSER-VERIFIED); found and fixed the Environment flow-paths layer that never drew.
- Create-then-quick-edit no longer double-posts (was a server 500); verified at 1440 and 1024 (BROWSER-VERIFIED).
- Screenshots: `/workspace/work/urbanos/shots/p2/` (qa2-, qa3-, qa4- prefixes).

## 10. Known open items (not claimed fixed)
- Base imagery: the sandbox's Cesium ion token is refused (401), so real base imagery has never been seen here. The app now shows a lasting notice instead of a blank globe. UNTESTED with a valid token.
- DEM: registry's active version is v1 while the app reads v3; activation of v3 is recommended (`DEM_V3_ACTIVATION_RECOMMENDATION.md`) and awaits a decision.
- Storm-water drains (150 MB) are not indexed for Explore; the merged 622 MB buildings layer is not wired at full size.
- Projects open takes about 31 s on the 1024 harness DB; slow but working.
- Traffic model fails M3.1 (see §6).

## 11. Decisions needed from the user
1. Push permission for this branch.
2. Activate DEM v3.
3. PMC GeoServer request and which accounts/keys to register.
4. OpenCity licence treatment; CHIRPS terms.
5. Traffic model: thresholds, calibration, same-lane merge fix, counts source, whether validation is acceptable.
6. Earlier UI deviations (rail width, light theme, tablet layout, Simulate tab structure, 390 px drawer scroll).
7. Deleting `/workspace/web/downloads` staging copies (~1.4–3.2 GB).
