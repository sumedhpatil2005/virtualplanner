# UrbanOS dataset catalogue — global open geospatial sources (Pune)

Owner: geo-acquisition agent, UrbanOS Phase 2. Written 2026-11-13 (IST). Study box: lon 73.70–74.05, lat 18.40–18.70 (WGS84). Engineering CRS: EPSG:32643.

**Verification labels.** All pipelines below are **HEADLESS-RUN** (each one ran end to end in the sandbox on 2026-11-13). Their pure functions are **UNIT-TESTED**: `backend/datasets/tests/test_pipeline_functions.py`, 13 tests, run with `cd backend && python -m pytest datasets/tests`. Nothing is wired into the UI, so nothing here is BROWSER-VERIFIED.

**Storage.** Raw files sit under `/workspace/work/urbanos-data/raw/<source_id>/2026-11-13/` with a `manifest.json`. Derived files sit under `/workspace/work/urbanos-data/derived/<dataset_id>/v1/` with a `processing.json`. None of these files are in git.

**Paths can be overridden.** Set `URBANOS_DATA_ROOT`, `URBANOS_RAW_DIR` or `URBANOS_DERIVED_DIR` (see `backend/datasets/pipelines/_common.py`). For the buildings pipeline, `TWINCITY_OSM_INDEX` points at the local OSM index.

**Running a pipeline.** Run `cd backend && python -m datasets.pipelines.<name> [acquire|process|all]`. The pipeline names are `elevation`, `landcover`, `sentinel2`, `surface_water`, `buildings`, `soil` and `chirps`.

**Raw volume.** The raw data for these sources totals 834 MB, under the brief's limit of about 3 GB. Large files were clipped early: Sentinel-2 bands by window reads, Open Buildings by streaming and filtering.

**Honesty rules for every derived layer.** Each layer carries a classification (observed, inferred, estimated or derived) and a suitability. No layer here is rated at **engineering** grade: none of these sources is an official survey with stated local accuracy. The most any layer reaches is screening. Some are visualisation only.

---

## 1. Copernicus DEM GLO-30 (elevation, DSM)

**Publisher and access.**
- Publisher: ESA / Copernicus (DLR, Airbus DS). The AWS mirror is managed by Sinergise.
- Dataset page: https://registry.opendata.aws/copernicus-dem/
- Licence page: https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM
- Licence (quoted from the licence page): "The GLO-30 and GLO-90 datasets are available worldwide with a free license."
- Required notice for modified data: "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved".
- Access: anonymous HTTPS from the `copernicus-dem-30m` S3 bucket (2021 release). No account is needed.

**What was downloaded.** Two complete 1°×1° COG tiles:
- `N18_00_E073_00`: 45.8 MB, sha256 `e5e127b1a1…`
- `N18_00_E074_00`: 39.0 MB, sha256 `1a44c053a6…`
- Both tiles have Last-Modified 2022-05-09.

**Format and spec.**
- Native CRS EPSG:4326 at 1″ spacing. Vertical datum EGM2008.
- Data epoch: TanDEM-X acquisitions 2011–2015.
- Publisher accuracy spec:
  - Absolute vertical: under 4 m LE90.
  - Relative vertical: under 2 m for slopes up to 20%, under 4 m for steeper slopes.
  - Absolute horizontal: under 6 m CE90.

**Derived outputs** (`derived/elevation_copdem30/v1`, about 50 MB, all COG):
- DEM in EPSG:4326 (native grid, clipped).
- DEM in EPSG:32643 at 30 m (bilinear resampling).
- Hillshade and slope in degrees.
- Filled DEM.
- A hydro-conditioned DEM (float64).
- D8 flow direction (ESRI codes) and flow accumulation in cells.
- `streams_derived_epsg32643.geojson`: 705 stream segments, starting where contributing area reaches 1 km².
- A catchment label raster and `catchment_outlets.json`: 6 outlet catchments of at least 10 km², 1,143 km² in total. The largest is 862 km² and drains east along the Mula-Mutha.

**Hydrology method.** pysheds 0.5's `resolve_flats` left unresolved flats on the river surfaces, which the DEM flattens, and that cut the catchments off mid-river. So conditioning uses our own Priority-Flood with an ε of 1 mm per cell (Barnes et al. 2014), in `_raster.priority_flood_epsilon`. In v1, pysheds then computed D8 flow, accumulation, catchments and the river network on that conditioned DEM. **Since v2 (2026-11-13) this is our own numpy D8** (`backend/datasets/pipelines/_hydro.py`); v1 stays on disk and the comparison is in v2's processing.json (see TERRAIN_AND_SUBSURFACE_DATA.md §2).

**Licence flag (resolved 2026-11-13).** pysheds (GPL-3.0-or-later) has been removed from requirements.txt and from every import; hydrology is our own code. A test (`datasets/tests/test_hydro.py::test_pysheds_not_required`) keeps it out.

**Quality checks.**
- Clip covers 100% of the box; 99.9% of cells are valid. Elevation runs from 519.5 to 1149.7 m.
- The UTM grid is 98.6% valid; its corners fall outside the rotated box.
- Depression filling added a mean of 0.06 m and a maximum of 24.9 m. Deep fills are DSM artefacts or quarries and reservoirs.
- Comparison with NASADEM (SRTM, February 2000; anonymous Planetary Computer SAS token, window extract only):
  - Copernicus minus NASADEM: mean +1.17 m, standard deviation 3.75 m, RMSE 3.93 m, LE90 of the absolute difference 5.9 m.
  - The positive tail is consistent with construction and tree growth since 2000. That reading is inferred, not verified.
  - The EGM2008 vs EGM96 datum difference was not corrected.

**Suitability: SCREENING.**
- Use it for terrain context, visual relief, slope classes, indicative drainage lines and catchment screening.
- Do not use it for drainage design, levels, cut and fill, or flood depth. It is a DSM: roofs and canopy are included, so in the dense core the flow paths follow buildings, not drains or nalas.

**Supports in UrbanOS:** the Environment terrain layer, slope constraint screening in feasibility, indicative catchment context for drainage reviews, and hillshade basemaps.

**Limitations.**
- Catchments clipped to the box are partial for rivers that enter from upstream (Khadakwasla, Pawana).
- No DTM (bare earth) is available openly. ALOS AW3D30 needs a JAXA registration, so per the brief we did not register.

## 2. ESA WorldCover 2021 v200 (land cover)

**Publisher and access.**
- Publisher: ESA WorldCover project / VITO.
- Licence page: https://registry.opendata.aws/esa-worldcover-vito/, which states "License: CC-BY 4.0".
- Access: anonymous HTTPS from the `esa-worldcover` S3 bucket.

**What was downloaded.** The complete 3°×3° tile N18E072: 125.8 MB, sha256 `2d28650e0e…`, Last-Modified 2022-10-26.

**Format.** 10 m grid, EPSG:4326, 11 classes. Model output: a classifier run on Sentinel-1 and Sentinel-2 imagery from 2021.

**Derived outputs** (`derived/landcover_worldcover2021/v1`):
- Clip in EPSG:4326 (native) and in EPSG:32643 at 10 m (nearest-neighbour resampling).
- `class_areas.json`.

**Zones.** No official PMC or PCMC boundary was available to this agent. The zones are therefore **inferred**: the union of DataMeet's community-traced electoral wards.
- PMC 2022 wards: 58 wards, 506.9 km².
- PCMC wards: 66 wards, 176.7 km².
- Wards source: https://github.com/datameet/Municipal_Spatial_Data. The licence is "Creative Commons Attribution-ShareAlike 2.5 India" (stated in the Pune and PCMC Readme files). The 2022 PMC wards are also published under MIT by answerquest.
- Both unions extend slightly beyond the box, so area outside it is not counted.

**Class shares (% of mapped area).**

| Zone | Area counted | Built-up | Tree | Grass | Crop | Shrub | Water |
|---|---|---|---|---|---|---|---|
| Study box | 1,226 km² | 27.0 | 14.4 | 22.0 | 21.6 | 11.3 | 1.4 |
| PMC (inferred zone) | 501 km² | 35.9 | 17.4 | 17.9 | 12.3 | 13.3 | 1.0 |
| PCMC (inferred zone) | 173 km² | 50.1 | 11.6 | 14.9 | 15.3 | 3.4 | 0.3 |

**Suitability: SCREENING.** Use it for green-cover and built-up context and land-cover constraint layers. It is not a land-use or zoning map.

**Limitations.** The 2021 snapshot is a model output with no Pune-specific accuracy figure. Dynamic World was not attempted: it is served through Earth Engine, which needs an account.

## 3. Sentinel-2 L2A (Element84 Earth Search STAC, no auth)

**Publisher and access.**
- Publisher: ESA / EU Copernicus. COGs are hosted by Element 84 (Earth Search v1).
- Licence: https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice.pdf, which says "users shall have a free, full and open access to Copernicus Sentinel Data and Service Information without any express or implied warranty…".
- Required notice: "Contains modified Copernicus Sentinel data [Year]".

**Scenes.** Both cover MGRS tile 43QCA, which fully contains the box, and are seasonally matched (November, post-monsoon):
- Recent: `S2C_43QCA_20251114_0_L2A`, cloud cover 0.0004%.
- Baseline: `S2A_43QCA_20191126_1_L2A`, cloud cover 1.3%, processing baseline 05.00.

**What was downloaded.** Window reads in each source's own CRS (EPSG:32643), with pixel values unmodified, of five bands: B03, B04, B08, B11 (20 m) and SCL (20 m). Also the two STAC items. Total 122 MB, 12 files.

**Derived outputs** (`derived/sentinel2_indices/v1`, 320 MB):
- NDVI, NDWI, MNDWI and NDBI for each date, float32 at 10 m in EPSG:32643, masked using SCL classes 4, 5, 6, 7 and 11.
- `builtup_change_2019-11-26_to_2025-11-14.tif`.

**Quality findings.**
1. **Earth Search declares `offset: -0.1` but the DNs are already harmonised.** Red DN median is about 750, and 1% of DNs are below 300. `effective_offset()` detects this per band and applies an offset of 0; the decision is logged in processing.json. Applying the declared offset made the indices go out of range. A validation check (`in_range_-1_1`) caught it.
2. **The simple built-up rule (NDBI > 0, NDVI < 0.25, MNDWI < 0) is weak.**
   - Agreement with WorldCover 2021 built-up for 2025: precision 0.62, recall 0.36, F1 0.46.
   - For 2019: F1 0.54.
   - The change map shows 8,190 ha of "gain" and 10,013 ha of "loss". That net loss is implausible for a growing city. The change layer is dominated by phenology and soil-moisture noise and **must not be shown as urban growth**.

**Suitability.** NDVI and MNDWI are fine for **visualisation and screening** (green and water context). The built-up change layer is **visualisation-only, flagged unreliable**.

**Next steps.**
- Switch to Earth Search's `sentinel-2-c1-l2a` collection, which is properly harmonised.
- Use composites of several dates.
- Evaluate against manually labelled samples (see §9).

**Sentinel-1.**
- Earth Search `sentinel-1-grd` sits in a requester-pays bucket, which needs AWS credentials, so it was not used.
- Microsoft Planetary Computer `sentinel-1-rtc` (CC-BY-4.0 per its STAC record) is reachable with an anonymous SAS token. It is feasible, but was **not acquired in this run**.
- Copernicus Data Space needs a free account, so we did not register.

## 4. JRC Global Surface Water (surface water)

**Publisher and access.**
- Publisher: EC Joint Research Centre / Google.
- Licence: https://global-surface-water.appspot.com/download, which says "All data here is produced under the Copernicus Programme and is provided free of charge, without restriction of use."
- Required citation: Pekel et al. 2016, *Nature* 540:418–422, with the attribution "Source: EC JRC/Google".

**What was downloaded.** Complete 10°×10° tiles for 70E_20N:
- v1.5 (1984–2024, the current version, from the CloudFerro listing linked by JRC): occurrence (51.6 MB, sha256 `6853d90184…`), extent (10.7 MB) and seasonality (14.6 MB).
- v1.4 (1984–2021, deprecated, from Google storage): occurrence (49.1 MB) and extent (19.3 MB), kept for comparison.

**Derived outputs** (`derived/surface_water_jrc_gsw/v1`):
- Window clips on the native 0.00025° grid (about 27 m), with no resampling.
- v1.5 occurrence also as EPSG:32643 at 30 m (nearest-neighbour).

**Quality checks.**
- Ever water: 24.9 km². Occurrence of 50% or more: 9.7 km². Occurrence of 90% or more: 5.7 km².
- v1.5 vs v1.4: mean difference −0.003; 5.8% of water pixels changed by more than 10 percentage points.
- No out-of-range occurrence values (the publisher fixed these on 2026-11-10).

**Suitability: SCREENING.** Use it for permanent and seasonal water context and river-corridor context.

**Limitations.** At 30 m Landsat resolution it cannot see nalas or drains narrower than about 30 m. It is not a flood-hazard or inundation layer. The Landsat Collection 1/2 co-registration offset can reach about one pixel.

## 5. Building footprints — Google Open Buildings v3, Microsoft GlobalML, OSM

**Google Open Buildings v3.**
- Source page: https://sites.research.google/gr/open-buildings/
- Licence: "shared under the … (CC BY-4.0) license and the … (ODbL) v1.0 license. As the user, you can pick which of the two licenses you prefer…"
- How it was acquired: S2 level-4 tile `3bd` is 4.81 GB gzipped. It was **streamed once and not stored**. Its MD5 `db301128…` matches the publisher's `x-goog-hash`. Rows whose centroid falls in the box were kept, byte-identical to the source: 1,128,393 rows, 292.6 MB, sha256 `5d1763457d…`.
- The per-tile score thresholds file was also downloaded.

**Microsoft GlobalML Building Footprints.**
- Source page: https://github.com/microsoft/GlobalMLBuildingFootprints
- Licence: "This data is licensed by Microsoft under the CDLA Permissive 2.0."
- What was downloaded: four complete India tiles at quadkey level 9 (`123301200` to `123301203`, 57.9 MB in total), taken from the 2026-08-13 `dataset-links.csv`.

**OSM.** Local `osm_index.db`, built from Geofabrik western-zone data dated 2026-11-02 (ODbL).

**Comparison** (`derived/buildings_comparison/v1/stats.json`; footprints counted by centroid in the box; areas in EPSG:32643):

| Source | Features | Roof area | Median area | Invalid geometries (fixed with `make_valid`) |
|---|---|---|---|---|
| Google OB v3 | 1,128,393 (425,282 at or above the tile's 90%-precision threshold of 0.81) | 123.1 km² | 60.5 m² | 0 |
| Microsoft ML | 248,339 (confidence absent: −1) | 65.2 km² | 153 m² | 7 |
| OSM | 288,482 (1,906 rings skipped for having fewer than 4 points) | 72.9 km² | 133 m² | 0 |

**IoU samples** (3,000 random features per direction, seed 42, best IoU against the other source):
- OSM → Google: 11% match at IoU ≥ 0.5 and 44% at IoU ≥ 0.3; 4% have no overlap at all.
- OSM → Microsoft: 23% match at IoU ≥ 0.5; 34% have no overlap.
- Google → OSM: 54% have no overlap.
- Microsoft → OSM: 35% have no overlap.

**Reading these numbers.**
- Google splits dense urban fabric into many small pieces (median 60 m²), so its per-building IoU is low even where it covers the same roofs.
- These figures measure **agreement, not accuracy**: OSM's completeness in Pune is unknown.

**1 km coverage grid** (`coverage_grid_1km.geojson`). In the 883 cells where ML roof cover exceeds 2%, OSM roof area is a median 0.57 times the ML maximum, and 364 cells fall below 0.5. This is a map of where OSM is likely incomplete.

**Merged conflict-detection layer.**
- File: `buildings_merged_conflict_epsg32643.fgb` (FlatGeobuf, 622 MB, 1.66 M features).
- Each feature keeps `source`, `source_id`, `confidence`, `area_m2`, `osm_overlap_frac`, `in_osm`, `in_google`, `in_ms` and `class`.
- `status` is one of `osm`, `agrees_with_osm` (an ML footprint at least 30% covered by OSM) or `ml_only_candidate`.
- Counts:
  - Google: 375,029 agree with OSM; 753,364 are ML-only.
  - Microsoft: 145,109 agree; 103,230 are ML-only.

**Recommendation.**
- Use OSM as the primary layer.
- Use Microsoft (larger, cleaner polygons) as the first gap-filler.
- Use Google, at or above its 90%-precision threshold, as a second gap-filler.
- Never merge geometries silently. The UI should show `ml_only_candidate` as "unverified ML detection".
- Validate with a manual imagery sample before using counts for anything numeric (see §9).

**Suitability.** Screening and visualisation. ML footprints are **derived**; OSM is **observed (community)**.

**Supports in UrbanOS:** coordination clash checks against building footprints, the Explore buildings layer, density proxies, and flagging OSM gaps.

## 6. SoilGrids 250 m v2.0 (soil)

**Publisher and access.**
- Publisher: ISRIC – World Soil Information.
- Licence: https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_02.html, which says "Since 2019, SoilGrids products are provided under the CC BY 4.0…".
- Access: WCS 2.0.1 GetCoverage subsets on the **native Homolosine 250 m grid**, so there is no server-side resampling. Requests were rate-limited to one per second.

**What was downloaded.** 32 subsets (0.7 MB): clay, sand, silt, bdod, soc, cfvo, wv0033 and wv1500, each at depths 0–5, 5–15, 15–30 and 30–60 cm, all as means. Unit conversion factors are taken from the publisher's layer page.

**Derived outputs** (`derived/soil_soilgrids250/v1`): EPSG:32643 rasters at 250 m of 0–30 cm thickness-weighted means, plus an AWC proxy (wv0033 − wv1500, in vol%).

**Medians (0–30 cm).**
- Clay 39.2%, sand 34.6%, silt 26.3%.
- Bulk density 1.50 kg/dm³. SOC 12.1 g/kg. Coarse fragments 18.1 vol%. AWC proxy 14.4 vol%.
- USDA texture comes out only as clay or clay loam.
- Sand + silt + clay sums to 99.9–100.1%.

**The publisher masks urban areas.** Its mask removes ESA CCI 2015 "Urban" cells. Result: 64% of WorldCover built-up cells in the box have **no SoilGrids value**, against 7% elsewhere. The WCS writes masked cells as 0, which we treat as nodata.

**Suitability: SCREENING only.** The publisher says its models explain 30–70% of variance. Values vary little across Pune, which reflects the model's smoothness, not the ground. No hydrologic soil group was assigned, because that would need a verified NRCS table and local data.

**This can never stand in for site investigation** (boreholes, SPT, lab tests, or the Deccan basalt geology the brief marks UNKNOWN).

## 7. CHIRPS v2 rainfall (climate fallback)

**Publisher and licence.**
- Publisher: Climate Hazards Center, UC Santa Barbara.
- Licence: https://www.chc.ucsb.edu/data/chirps, which says "…has waived all copyright… CHIRPS data is in the public domain".

**Access.**
- `data.chc.ucsb.edu/robots.txt` reads `User-agent: * Disallow: /` (checked 2026-11-13), so **we did not script downloads there**.
- The IRI Data Library mirror was unreachable from the sandbox.
- Data came instead from the **SERVIR ClimateSERV API** (documented at https://climateserv.servirglobal.net/develop-api; no auth). The API has a 20-year limit per request, so two requests were made. Each returned a daily average of UCSB CHIRPS (datatype 0) over the study box.
- No terms page was found for the API itself, so its service terms are recorded as UNKNOWN.

**What was downloaded.** Two JSON files, 2.5 MB in total, covering 1986-01-01 to 2025-12-31: 14,610 days with no gaps.

**Derived outputs** (`derived/rainfall_chirps_boxavg/v1`): a daily CSV and a summary.
- Mean annual rainfall: 874 mm, ranging 553–1,340 mm.
- June–September share: 82.9%. July mean: 211 mm.
- Largest box-average 1-day value: 119.9 mm, in 2006.

**Suitability: SCREENING.** Use it for seasonality and inter-annual context.

**Limitations.** This is a box average of 0.05° cells. It underestimates local intensity and is **not an IDF or design-storm source**. Compare it with IMD gauge or gridded data, which is the government agent's lane.

**Not acquired.** Spatial CHIRPS grids and CHIRPS v3. **ERA5** needs a Copernicus CDS key, so we did not register.

## 8. Other sources checked and not acquired

| Source | Reason |
|---|---|
| ALOS AW3D30 | JAXA registration required (stop rule) |
| NASADEM via LP DAAC | Earthdata login required. Used the Planetary Computer mirror instead, comparison only. Licence on that mirror's STAC is "proprietary"; recorded as UNKNOWN. |
| Dynamic World | Earth Engine account required |
| Copernicus Data Space (Sentinel-1/2, DEM) | Free account required (stop rule). Used the AWS and Earth Search mirrors instead. |
| ERA5 | CDS API key required |
| Sentinel-1 RTC (Planetary Computer) | Feasible without auth. Deferred (time). |

---

## Remote sensing: what it can and cannot substitute — moved

The draft that stood here was reconciled into `../MISSING_DATA_AND_COLLECTION_PLAN.md` on 2026-11-14 IST: §1a (what remote
sensing can and cannot substitute), §1 priorities 11–13 (collection priorities it exposed) and §4.6 (machine learning only
where it can be measured). That plan is the single source; nothing was dropped.
