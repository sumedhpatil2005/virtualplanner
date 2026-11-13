# UrbanOS dataset catalogue — Indian government and Pune sources

Owner: gov-sources agent, UrbanOS Phase 2. Written 2026-11-13 (IST). Study box: lon 73.70–74.05, lat 18.40–18.70 (WGS84). Engineering CRS: EPSG:32643.

## How to read this file

**Status of each source.** Every source below carries one of these labels:
- **DOWNLOADED**: the files are in the raw store with sha256 hashes in `manifest.json`.
- **PROBED**: HTTP requests were made and their responses recorded, but no dataset was bulk-downloaded.
- **READ**: the page or PDF was opened.
- **EXCERPT**: only a search-result excerpt was seen.
- **UNREACHABLE**: a connection from the sandbox timed out or failed on 2026-11-13. This does not prove the site is down.

**Verification labels.**
- Pipelines are **HEADLESS-RUN**: each one ran end to end in the sandbox on 2026-11-13.
- Parsers are **UNIT-TESTED**: `backend/tests/test_gov_pipelines.py` has 13 tests with tiny fixtures in `backend/tests/fixtures/gov/`.
- Nothing is wired into the UI, so nothing here is BROWSER-VERIFIED.

**Storage.** Same convention as `global.md`.
- Raw files: `/workspace/work/urbanos-data/raw/<source_id>/2026-11-13/`, with a `manifest.json`.
- Derived files: `/workspace/work/urbanos-data/derived/<dataset_id>/2026-11-13/`, with a `processing.json`.
- Nothing is in git except the pipeline code, the CKAN catalogue snapshot `backend/datasets/pipelines/opencity_pune_catalogue.json` (metadata only) and the test fixtures.
- Env overrides: `URBANOS_DATA_ROOT` (alias `URBANOS_DATA_HOME`), `URBANOS_RAW_DIR`, `URBANOS_DERIVED_DIR`. See `backend/datasets/pipelines/gov_common.py`.

**Raw volume from this agent: about 2.18 GB.**

| Source | Size |
|---|---|
| OpenCity | 1,360.8 MB in 96 files |
| IMD | 661.6 MB in 26 files |
| NWDP | 117.5 MB in 4 files |
| OGC capabilities and probes | about 25 MB |

**Commands.** Run everything from `cd backend`.
- Generic fetcher, rate limited and resumable: `python -m datasets.pipelines.gov_fetch …`
- Per-source pipelines: `opencity_pune {ingest,derive}`, `opencity_trees`, `imd_rainfall`, `nwdp_groundwater`, `cpcb_air_quality`.

**Honesty rules.**
- Every derived layer is classed (observed, inferred, estimated, derived) and given a suitability.
- Nothing here is rated **engineering**. No source states a positional or vertical accuracy for Pune.
- A layer that is present does not make any simulation valid. The traffic model still FAILS TAG M3.1.

---

## 1. OpenCity CKAN: Pune datasets (`opencity_pune`) — DOWNLOADED

**Publisher (mirror).** OpenCity, a programme of the Oorvani Foundation. Portal: https://data.opencity.in.

**Original publishers.** Recorded per dataset:
- Pune Municipal Corporation (PMC) for the 40 `organization=pune-municipal-corporation` datasets. Their CKAN "Source" is http://opendata.punecorporation.org or https://pmc.gov.in.
- For the 17 other `groups=pune` datasets: CPCB, Ministry of Jal Shakti, SLUSI, MoSPI, ORGI, DGCA, punemetrorail.org, praja.org, cBalance.

**Licence, as stated.** All three statements apply at once.
1. CKAN `license_title` per dataset: "Other (Public Domain)" for all 40 PMC datasets and most of the others. Two exceptions:
   - water-bodies census: "Creative Commons Non-Commercial (Any)"
   - cBalance reports: "Creative Commons Attribution Share-Alike"
2. OpenCity FAQ, https://opencity.in/faqs/ (READ via browser, 2026-11-13): "All our data is under Open Data Commons Open Database License (ODbL)… For commercial purposes, follow the licensing guidelines mentioned on the dataset… Validate the usage guidelines on the original source as well." The FAQ also asks users to credit OpenCity.
3. Site terms, https://opencity.in/terms-and-conditions/ (READ): "You are permitted to print or download extracts from these pages for non-commercial and / or personal use only".

**⇒ Licence conflict.** UrbanOS records all three statements. Treat reuse as **non-commercial, attribution "OpenCity + original publisher"** until PMC confirms otherwise.

**Access.**
- CKAN API `package_search` is public, but the domain sits behind a Cloudflare "verify you are human" check. Scripted clients get HTTP 403 ("Just a moment…"; tested 2026-11-13 21:05 IST).
- robots.txt allows `/` and states `Content-Signal: search=yes,ai-train=no,use=reference`.
- The check was passed once by a normal browser session. No login exists or was used.
- `opencity_pune ingest` copies the browser downloads unmodified and verifies each file's byte size against CKAN `size`. The result was 96 of 96 matching.
- HTTP headers and ETag could not be captured, because the browser environment had no network API. The manifest records the CKAN `last_modified` instead.

**Enumerated.**
- `fq=organization:pune-municipal-corporation`: 40 datasets.
- `fq=groups:pune`: 57 datasets, the same 40 plus 17 others.
- 335 resources in all.
- The full snapshot is `opencity_pune_catalogue.json`.

**Downloaded.** 96 files, 1,360.8 MB:
- all 24 Pune KML/KMZ layers
- 1 tree-census series (17 parts)
- 17 air-quality files
- census, health, school, slum, water, sewage, road and footpath CSVs

**Not downloaded.** Not downloaded on purpose or out of scope:
- budgets, election and UDISE (school statistics) files
- Thane and Maharashtra-wide water-census KMLs (180 MB)
- PDFs: CDP 2041, CMP 2008, Climate Action Plan, Metro DPR 2015
- 2 GeoJSONs: `pune_administative_wards_2025.geojson` (223 KB) and SLUSI `pune_micro_watersheds.geojson` (13.4 MB). They are served as `application/geo+json`, which Chrome renders inline, and they could not be saved as raw bytes. **To fix:** download them manually, or ask OpenCity for a direct link.

**Derived layers.** `opencity_pune derive`; EPSG:4326 in and out (KML 2.2 mandates WGS84). A feature is kept if its bbox intersects the study box; geometries are not cut. Invalid geometries were repaired with `shapely.make_valid`, and the repairs are counted.

| dataset_id | Features in box | Geometry | QA notes (processing.json) | Vintage (CKAN last_modified / title) |
|---|---|---|---|---|
| `pmc_admin_wards_2017` | 15 | Polygon | 0 invalid | 2017 |
| `pmc_electoral_wards_2012/2017/2022/2025` | 76 / 41 / 58 / 41 | Polygon (2025: one MultiPolygon) | 0 invalid | per title |
| `pmc_prabhag_boundary` | 72 | Polygon | — | undated |
| `pmc_zones` | 5 | Polygon | 1 repaired | undated |
| `pmc_revenue_map` (gut / village / TPS) | 29,140 | Polygon | 9 repaired, 8 outside box; `tps` filled 8.7 % | undated |
| `pmc_road_centerline` | 25,485 | LineString | 3,105 km; no road name, class or width attributes | undated |
| `pmc_sewage_pipelines` | 44,482 | LineString | 660 km. `start_inve`/`end_invert` and `tl_*` filled 100 %; cover = tl − invert, median 1.1 m, 0 negative. `material_o` = "RCC" for 100 % (looks like a default). `depth_2017…2047` = design horizons. | KMZ uploaded 2025-12-08 |
| `pmc_stormwater_drains` | 141,341 | LineString | 3,708 km. **44,492 features are geometrically identical to sewage features.** Categories: Road_Sewer 122,737, Storm water drains 9,187, Nalla_Sewer 4,908, Nalla 3,227. Inverts filled 91 %. | 2025-11-25 |
| `pmc_swd_chambers` / `pmc_swd_utility_chambers` | 22,771 / 4,233 | Point | utility chambers: 2,481 duplicate points | 2025-12-08 |
| `pmc_nallas` / `pmc_rivers` | 3,075 lines (1,010 km) / 12 polygons | — | 30 duplicate lines | 2025-11-25 |
| `pmc_parks_gardens`, `pmc_crematoriums`, `pmc_stps` | 198 / 81 / 20 | Polygon | — | — |
| `pmc_public_toilets`, `pmc_fire_stations`, `pune_libraries` | 547 / 14 / 56 | Point | 29 / 0 / 2 duplicates | — |
| `pmpml_bus_stops` / `pmpml_bus_depots` | 4,659 (of 5,624) / 9 | Point | GTFS-style stop fields; 59 duplicates | source "opendata.punecorporation.org"; date UNKNOWN |
| `water_bodies_census_pune_2023` | 225 (of 3,680) | Point | **licence CC-NC** | 2023 census |
| `pmc_tree_census_2019` (`opencity_trees`) | **4,009,623 trees** | Point (CSV) | 1 row without geometry; 0 duplicate ids. Condition: Healthy 3,834,092, Average 125,715, Dead 40,890, Poor 8,926. `is_rare` 51,410. Canopy outside 0.1–60 m: 38,630. In the source, `northing`/`easting` hold lat/lon degrees. | 2019 per title |

**Classification and suitability.**
- All layers: **observed** (as published by the agency; survey method and accuracy UNKNOWN). Suitability: **screening**.
- The sewer and SWD invert levels look like sewerage-master-plan **design/model** values: horizon-year depths, a uniform material, `source_ass` = "Pipeline". Treat them as "UNVERIFIED design values", not as surveyed as-builts.

**UrbanOS features supported.**
- Ward and zone context: the census-join key is missing, see §12.
- Underground: sewer and drain screening with invert levels. Conflicts must say "design value, unverified".
- Trees Act screening, using the 2019 tree points.
- Bus-stop catchments.
- Revenue and gut-number lookup.
- Water-body proximity.

**CSV tables, raw only.** All are ward or prabhag aggregates, without geometry unless noted.
- Census 2011 ward table: 146 census wards plus "… Total" subtotal rows. The rows excluding subtotals sum to 3,287,556; the table includes later-merged villages.
- Roads and footpaths 2016 (per prabhag, length and % paved).
- SWD coverage 2016, and primary drain channels 2012.
- Hospitals: government 50, private 228 and dispensaries 30, with lat/lon; plus hospitals with capacity (742).
- Schools: UDISE lists of 1,246–1,254 schools.
- Slums 2009 / 2017.
- WTP 2012, STP 2017, rainfall 1980–2019 (annual).
- PMPML route list (1,030 routes).
- AQ "AQI" tables 2017–2023 (hourly AQI per month), and 15-min concentrations 2024–25 (§8).

---

## 2. PMC open data portal (`pmc_opendata_portal_catalogue`) — PROBED, catalogue only

- **Publisher:** Pune Municipal Corporation. Site https://opendata.pmc.gov.in; API https://opendataapi.pmc.gov.in/.
- **Licence:** the open-data policy page (NDSAP-based) is https://opendata.pmc.gov.in/open-data-policy (EXCERPT in ENGINEERING_GIS_RESEARCH §C). No per-dataset licence appears in the API (`license` field absent).
- **Access:** `GET /datasets?page=0&size=300` returns all **238** datasets with titles and formats.
  - Formats: xlsx 157, pdf 76, odt 46, csv 22, json 19, xls 4.
  - Each file download first POSTs a purpose form (name, mobile, e-mail) with a **CAPTCHA** (`/dataset-files/{id}/save-download-purpose`).
  - **We did not automate it and did not bypass it.** No dataset files were downloaded.
- **Relevant titles.** Each needs a manual download by a person or a request to PMC:

| id | Title | Format |
|---|---|---|
| 431 | PMC Traffic Details | xlsx |
| 286 | List of Trees in Pune City 2024 | xlsx; newer than the 2019 census |
| 422 | BRT & Non BRT Route Details & Bus Stop LatLong | xls |
| 312 | List of All Electoral Wards (Prabhags) with Geographic Coordinates | csv / json |
| 425 / 426 / 423 | Footpath details / Length of roads prabhag-wise / Condition of roads | — |
| 428 / 429 | On-street parking / Parked roads | — |
| 433 | Road fatalities by mode | — |
| 439 | Temperature & rainfall 2020–2024 | — |
| 275 | PMC Census Data 2011 | — |
| 304 | Regional Disaster Management Plan 2014-15 | — |

---

## 3. PMC AutoDCR GeoServer (`pmc_autodcr_geoserver_probe`) — PROBED, verification only

- **Publisher:** Pune Municipal Corporation. Service https://iwmsgis.pmc.gov.in/geoserver/AutoDCR/wms (WMS 1.3.0), with WFS at `/geoserver/AutoDCR/ows`. It is used by the AutoDCR building-permission viewer at https://iwmsgis.pmc.gov.in/geopulse/autodcr/.
- **Licence: UNKNOWN.**
  - Capabilities state `<AccessConstraints>NONE</AccessConstraints>` and `<Fees>NONE</Fees>`, which is not a reuse licence.
  - robots.txt: `Allow: /`.
  - No terms page was found.
- **Layers.** 30 layers, with WFS `resultType=hits` counts where they returned:
  - `Red_Blue` (river flood-line zones): **14 features**. The sample attribute is `flood_line: "bank to blue line"` with remark "No building construction".
  - `PLU_Ward` (proposed land use): 329.
  - `PMC_Reservation`: 833.
  - `DP_Ward_Road`: 77.
  - `TOD_Zones`: 38. Native CRS EPSG:32643; the others are 4326.
  - `Aviation_data` (NDA / Lohegaon height zones with elevations): 28.
  - `Monuments`: 9. The sample includes staff names, so do not surface them.
  - `Lake`: 6.
  - `PMC_Boundary`: 1.
  - `PMC_DP`: the hits query errored, but WMS renders it.
  - Plus `TDR_Zones`, `Revenue_1`, `Village_Boundary`, `Railway_Buffer`, `CCZM`, `DevelopmentRestriction` and others.
- **What we stored.** Capabilities, hit counts, one sample feature per layer, and 4 WMS renders (1 MB in all).
- **Not bulk-downloaded.** This is an operational permitting service with no published licence, so a full copy needs PMC's written permission (see MISSING_DATA_AND_COLLECTION_PLAN §2.1).
- **Suitability if obtained:** screening. Statutory status (sanctioned DP, approved flood lines) must be confirmed per layer; the source date is UNKNOWN.
- **Features it would support:** DP/zoning overlay, flood-line screening, aviation height limits, TOD zones, monument proximity.

---

## 4. Bhuvan / NRSC OGC services (`bhuvan_ogc_capabilities`, `bhuvan_wms_samples`) — PROBED

**Publisher.** NRSC / ISRO.

**What responds.**
- WMS capabilities (all saved):
  - `bhuvan-vec1…/bhuvan/wms`: 6,678 layers.
  - `bhuvan-vec2…`: 4,530.
  - `bhuvan-vec3…`: 3,581.
  - `bhuvan-ras2…/cgi-bin/LULC250K.exe`: MapServer.
- Not available: WFS ("Service WFS is disabled"); WMTS `gwc/service/wmts` timed out; `bhuvan-ras1/ras2 /bhuvan/wms` returned 404.

**Pune layers that rendered** (GetMap HTTP 200 image/png on 2026-11-13):
- `nuis:MH_PU_*`, NUIS 1:10k urban layers for Pune: builtup, road, drainage, waterbodies, …
- `sisdpv2:MH_Pune_lulc_v2`: SIS-DP 1:10k LULC.
- `lulc:MH_LULC50K_1516`.
- `geomorphology:MH_GM50K_0506`.
- `lineament:MH_LN50K_0506`.
- `soil:MH_SO_50K`.
- `hs:LUHS_MH_PUNE_2005/2015`.
- `gw:MH_PREMONSOON_1999_2016`.
- `sdv:mh_Pune_slope`.
- `iwmp:MH_PUNE_drn`.
- Also listed: `watershed:MH_WS`, `disaster:MH_SLIM_2017`, `vector:cdem_*` (CartoDEM index).
- `GetFeatureInfo` returns full vector geometry as JSON.

**Licence: Bhuvan Terms of Service**, https://bhuvan.nrsc.gov.in/terms.php (READ 2026-11-13). Without prior written authorisation you must not:
- "Copy, translate, modify, or make derivative works of the content"
- "Redistribute … or otherwise make the content available to third parties"
- "Use the website in a manner that gives you … access to mass downloads or bulk feeds of any content, including … numerical latitude or longitude coordinates"

The terms also say: "Image data and map data … are provided for viewing purposes only."

**What we did.**
- Deleted the 10 sample PNGs after reading the terms; the manifest keeps the evidence.
- Did **not** harvest vectors through GetFeatureInfo.
- Bhuvan NOEDA downloads (for example CartoDEM 1″) need a Bhuvan login and are capped at 10 tiles/day (help page EXCERPT). **Not registered. Reported to the coordinator.**

**Suitability.** Live WMS display as a **visualisation** overlay with "© NRSC/ISRO Bhuvan" attribution, if the coordinator accepts the ToS for live viewing. No storage, no analysis.

---

## 5. GSI Bhukosh / NGDR (geology) — UNREACHABLE from the sandbox; EXCERPT only

- Site: https://bhukosh.gsi.gov.in (timed out 2026-11-13).
- Per the excerpts (search 2026-11-13):
  - Guests can view.
  - "Registered users … Downloading the data … as per prevalent policy".
  - The GSI Data Sharing & Accessibility Policy 2019 says 1:50K geology "will be placed in public domain" and served through OGC services, but the web application grants "only single user license".
  - NGDR (geodataindia.gov.in): "Can view Maps without Login. To download data Login required".
- Community redistributions exist (for example GitHub ramSeraph "NGDR_Lithology_50k", which tags itself "not-so-open"). **Not used**: the licence chain is unclear.
- **Status:** blocked (registration). A Pune geology WMS is UNKNOWN until the site can be reached. Geology stays **UNKNOWN** in the app.

---

## 6. National Water Data Portal, NWIC (`nwdp_india_wris`, `nwdp_meta`) — DOWNLOADED

- **Publisher:** NWIC, Ministry of Jal Shakti. Producers: CGWB, the Maharashtra Groundwater Department (GSDA) and IMD. Site: https://nwdp.nwic.gov.in (CKAN).
- **Licence:** CKAN `license_title` "Other (Open)" (`isopen: true`) for the CGWB and GSDA datasets. The IMD `rainfall-daily-imd` licence field is **empty**, so UNKNOWN.
- **Access:** public CKAN API and direct CSV URLs, no key. robots.txt `Crawl-Delay: 10` was honoured (10 s between requests).

**Downloaded (117.5 MB).**

| File | Size |
|---|---|
| `gwl_manual_quarterly_cgwb_mh_1991_2020.csv` | 14.0 MB |
| `…_2021_2025.csv` | 1.75 MB |
| `ground_water_level_manual_quarterly_maharashtra_1970_2025.csv` (GSDA) | 91.5 MB |
| `rainfall_districtwise_daily_imd.csv` | 10.3 MB |

**Not downloaded.** GSDA telemetry, six-hourly 2021–2025 (529 MB) and 2026–2030 (150 MB). Its size is out of budget; it can be streamed and filtered later.

**Derived** (`nwdp_groundwater`).
- `nwdp_groundwater_pune`: **36 wells** in the box (CGWB 15, GSDA 21) and 2,849 observations, 1974 → 2025-10-01.
  - Manual depth to water, m bgl. 7 rows had a missing value. No RL for GSDA wells.
  - Classification: **observed**. Suitability: screening, at the well point only. **No interpolation.**
- `imd_district_rainfall_pune`: the NWDP file only covers 2026-08-19 → 2026-11-13 for Pune (86 rows).

**Features supported.** Groundwater context in the Underground and Environment workspaces, as point wells with time series.

---

## 7. IMD Pune gridded rainfall 0.25° (`imd_gridded_rainfall_025`) — DOWNLOADED

- **Publisher:** IMD Pune, Climate Research & Services. Page: https://imdpune.gov.in/cmpg/Griddata/Rainfall_25_Bin.html (READ).
- **Licence:** **none stated.** The page asks: "Should you refer to our product … please cite Pai et al. (2014)". It carries a disclaimer of liability.
- **Access:** POST `rainfall.php` with `rain=<year>`. No login. Years 1901–2025 are listed.
- **Downloaded:** 2000–2025, 26 files, 661.6 MB, about 25.4 MB each. Every file passed the size check (ndays × 135 × 129 × 4 bytes).
- **Format:** float32 little-endian, lon fastest, south to north, UNDEF −999. Checked against the Fortran/C sample on the page and against plausible values (Mumbai July 2024 = 1,533 mm).

**Derived** (`imd_rainfall_025_pune`).
- The 4 cells overlapping the box: 73.75/74.00 E × 18.50/18.75 N.
- Daily CSV (37,988 rows, 0 UNDEF), annual totals and the cell polygons.
- **QA flag:** 12 cell-years have more than 3× the cell's median annual total, for example **2005 at 74.0 E 18.5 N = 6,495 mm**.
  - Values are kept unaltered and flagged `suspect_gt_3x_median`.
  - Possible causes: interpolation from ghat stations, or source errors. UNVERIFIED.
- **Suitability:** screening of regional climate only. A cell is about 27 km across, so it is **not** usable for storm-drain design. IDF curves are still missing.

---

## 8. CPCB CAAQMS air quality (`cpcb_caaqms_station_list`, plus OpenCity AQ files) — DOWNLOADED

- **Publisher:** CPCB Central Control Room, with stations run by MPCB and IITM.
- **Station list:** https://app.cpcbccr.com/ccr_docs/caaqms_list_All_India.pdf (40.9 KB, licence UNKNOWN). It gives 8 Pune stations with coordinates: site_292, 5404–5410.
- **CCR portal downloads:** need an interactive form with a CAPTCHA (third-party blog, EXCERPT). **Not automated.**
- **15-minute data instead:** the OpenCity mirror (`pune-hourly-air-quality-reports`, licence "Other (Public Domain)", 2026-01-15).
  - 7 stations, 2024-01-01 → 2025-12-31. Timestamps are ISO **UTC** in the source; the pipeline converts them to IST.
  - Rows written: site_5405 24,872 · 5406 37,588 · 5407 29,792 · 292 45,424 · 5766 55,410 · 5988 52,647 · 6012 17,664.
  - Two stations in the data (5766, 5988) are not in the CPCB PDF. Their coordinates are UNKNOWN, so their geometry is null.
- **Derived:** `cpcb_caaqms_pune` (`stations_pune.geojson`, `aq_15min_pune.csv`). Classification: **observed**. Suitability: screening at the station only. No surfaces.
- **OpenAQ:** API v3 needs an API key ("Sign up for an OpenAQ API key"). **Stopped and reported.**

---

## 9. Census

- **Census 2011.** The ward-wise table from PMC is on OpenCity (§1). The PCA at censusindia.gov.in is reachable (HTTP 200) but was not downloaded. Label it **HISTORICAL (2011)**.
- **Census 2021 was not conducted.** It became Census 2027:
  - Houselisting in Maharashtra: 2026-05-16 → 2026-06-14 (PIB, 2026-06-16, EXCERPT).
  - Population enumeration: 2027-01-25 → 2027-02-28, with reference date 2027-03-01 00:00 (ORGI notification reported by The Hindu and PTI, 2026-10-30/31, EXCERPT).
  - **No post-2011 official population counts exist as of 2026-11-13.**
- **Census wards.** No census-ward boundary layer was acquired, so the 2011 table cannot be mapped yet (UNKNOWN). See the collection plan.

---

## 10. Data.gov.in (OGD India) — UNREACHABLE / KEY REQUIRED

- `www.data.gov.in` returned HTTP 503, and `api.data.gov.in` timed out (2026-11-13).
- The API needs a free API key: "Getting an API key: Register at data.gov.in" (themineworks, 2026-06-22, EXCERPT; and library docs).
- **Stopped and reported.** The same IMD and CGWB data were obtained from NWDP (§6) and IMD (§7).

---

## 11. Other sources investigated

**India-WRIS** (indiawris.gov.in): UNREACHABLE (timeout). Its groundwater and rainfall data overlap NWDP. Basins, watersheds and reservoirs (for example Khadakwasla) are not acquired.

**PMRDA public GIS portal** (geoportal.pmrda.gov.in): UNREACHABLE (timeout).
- A PMRDA press note (READ, PDF dated 2026-08) says it carries RP, TP schemes, village limits, ring roads, **Pune Metro corridors**, PWD roads and TOD zones.
- It says flood lines and defence buffers are "being onboarded in phases".
- The draft DP 2021–41 is a sheet-wise viewer.
- Licence UNKNOWN.

**MRSAC geoportal** (geoportal.mrsac.org.in): UNREACHABLE (timeout).

**PCMC.**
- DP and ELU are published as sheet images on pcmcindia.gov.in (EXCERPT).
- The SmartGIS citizen portal terms say "personal and non-commercial use only … prohibited from copying … creating derivative works" (EXCERPT).
- Not acquired.

**MahaMetro.**
- Alignments exist only as PDF maps and DPR PDFs (punemetrorail.org reachable). The 2015 DPR is also on OpenCity.
- **No official GIS file was found.** Tunnel depths are UNKNOWN.
- The Esri India "Pune Metro Rail Network 2024" item has an UNKNOWN licence.

**PMPML transit.**
- **No official GTFS feed was found.**
- The Mobility Database lists a PMPML feed (mdb-3137, source not verified).
- A community GTFS, github.com/croyla/pmpml-gtfs (MIT-0), is built from the Apli-PMPML (Chartr) API. It is unofficial and not used.
- PMC portal item 422 (BRT stops lat/long) is behind the CAPTCHA.

**Traffic.**
- **No official open counts or speeds were found.** The PMC portal has "PMC Traffic Details" (431) behind the CAPTCHA.
- The Pune Smart City ATMS/ICCC feeds are UNKNOWN (not public).
- The traffic model still FAILS TAG M3.1.

**Seismic zone.** As in ENGINEERING_GIS_RESEARCH §C: secondary only, UNVERIFIED.

---

## 12. Gaps that remain UNKNOWN in the app

- Geology and lithology (GSI registration).
- Boreholes.
- Utility depths other than the PMC sewer and drain design values.
- Water-supply network.
- Metro tunnel geometry and depth.
- Statutory flood lines: PMC AutoDCR `Red_Blue` is not released, and the WRD sheets are PDFs.
- DP/zoning vector: AutoDCR is not released, and PMRDA is unreachable.
- Census-ward boundaries.
- Measured traffic counts and speeds.
- DEM: see `global.md`.
- IDF curves.

See `../MISSING_DATA_AND_COLLECTION_PLAN.md`.
