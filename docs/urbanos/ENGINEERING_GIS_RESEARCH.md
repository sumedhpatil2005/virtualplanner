# UrbanOS — Engineering, GIS, Data & ML Research

Branch context: `urbanos-city-planning-redesign` (from `urban-mobility-platform` 837183c). Written 2026-11-13 by the engineering-research agent. **No application code was changed.**

Builds on (does not repeat): `docs/RESEARCH_AND_TECHNICAL_DECISIONS.md` (traffic modelling, ODME, emissions, comparison), `docs/RESEARCH_FEASIBILITY_AND_INVESTIGATION.md` (statutory constraints: AMASR, flood lines, Trees Act, metro NOC, geology, utilities — its sources S1–S27 are referred to as "RFI S#"), `docs/SYSTEM_ARCHITECTURE.md` (modular monolith, tables, APIs).

**Labels used.** Source status: **READ** (page/PDF opened this session and passage read) · **EXCERPT** (search-result excerpt only, page not opened) · **REPO** (checked in this repository / sandbox). Recommendation: **ADOPT NOW / LATER / NOT NEEDED**. Data status: **UNKNOWN** = not found or not verified; never treated as a pass. Every "accessed" date is 2026-11-13 unless a publication date is given.

---

## 0. Repository / sandbox facts this research relies on (REPO, checked 2026-11-13)

| Fact | Evidence |
|---|---|
| Backend persistence is SQLite via SQLAlchemy; `geoalchemy2` and `psycopg2-binary` are listed in `backend/requirements.txt` but **no Python file imports them** | `grep geoalchemy2\|psycopg backend/**/*.py` → no hits |
| Python's bundled SQLite (3.46.1) has the **R\*Tree module** compiled in | `CREATE VIRTUAL TABLE … USING rtree` succeeded |
| **No GDAL, SpatiaLite, SUMO or netconvert binaries** in the sandbox; `shapely`/`geopandas` not installed | `command -v ogr2ogr gdalinfo spatialite sumo netconvert` → none; `import shapely` → ModuleNotFoundError |
| SUMO in repo is a Phase-0 spike + stub (`backend/sumo/spike.py`, `service.py` "Phase 5 stub"); emissions use a TypeScript port of SUMO's HBEFA4 model (`engine/emissions/hbefa4.ts`, see `docs/ODME_AND_EMISSIONS.md`) | file read |
| **Terrain:** the only terrain is **Cesium World Terrain streamed from Cesium ion** (`createWorldTerrainAsync`, `TwinCityEngine.ts` ~l.403–440). It needs `VITE_CESIUM_ION_TOKEN`; `frontend/.env` has the value `proxy-managed`. Ground heights are sampled into `engine/terrain/TerrainHeightField.ts` (0.01° cells, 41×41 samples ≈ 27 m spacing). **No DEM/GeoTIFF/HGT file exists in the repo.** | file read; `find -iname '*.tif*' -o -iname '*.hgt'` → none |
| Objects: `UtilityObject {utilityType, depth (m below ground), capacity}` exists but nothing reads `depth` for feasibility (SYSTEM_ARCHITECTURE §1.3); metro lines/flyovers carry `elevation`; OSM `layer/bridge/tunnel` drive heights (`bridgeElevation.ts`) | `engine/objects/types.ts` |
| Already built for versioning/coordination: `scenario_object_changes` (copy-on-write overrides + tombstones), immutable `scenario_versions` with `baseline_fingerprint` + `change_set_hash`, `scenario_runs` (frozen inputs), `planning_projects` (with `baseline_fingerprint`, `baseline_changed_since_created`), `planning_project_links`, append-only `planning_decisions` and `audit_log` | `backend/models/models.py`, `backend/planning/models.py`, `api/planning_router.py` |
| Frontend 3D stack: CesiumJS `^1.143.0` only (no MapLibre/deck.gl/three/turf) | `frontend/package.json` |
| Sandbox: 2 CPUs, ~7 GB RAM shared | `free -g`; brief |

---

## A. Technology evaluation

| # | Technology | Licence (source) | What it would give us | Recommendation | Reason |
|---|---|---|---|---|---|
| A1 | **Keep plain SQLite** (+ built-in R\*Tree for bbox indexing; geometry as GeoJSON text as today) | public domain (SQLite) | Zero new dependencies; bbox prefilter for conflict detection via R\*Tree | **ADOPT NOW** | All current tables are SQLite; Python's SQLite already has R\*Tree (REPO). Conflict detection on project-scale datasets (hundreds–thousands of features) needs a bbox prefilter + exact geometry test, not a spatial server. |
| A2 | **SQLite + SpatiaLite** | MPL 1.1 / GPL 2.0+ / LGPL 2.1+ tri-licence — gaia-gis.it, https://www.gaia-gis.it/fossil/libspatialite/index (EXCERPT/curl, accessed) | Spatial SQL (buffers, intersections, CRS transforms) inside SQLite | **NOT NEEDED now; LATER only if** spatial SQL in the DB becomes necessary | Needs the `mod_spatialite` native extension (not installed; REPO) on every machine; same algorithms are available in Shapely without a DB-level native dependency. |
| A3 | **PostgreSQL + PostGIS** | GPL-2.0-or-later; PostGIS FAQ states ordinary use (loading/querying) does not make your app GPL — https://postgis.net/documentation/faq/gpl-license/ (PostGIS PSC, 2022-02-01, EXCERPT); GitHub licence GPL-2.0 (REPO via API) | True 3D predicates: `ST_3DIntersects`, `ST_3DDWithin` with N-D GiST index — https://postgis.net/docs/ST_3DDWithin.html (PostGIS manual, accessed, EXCERPT); raster, topology, multi-user concurrency | **LATER** (when the app is deployed multi-user / city-wide layers exceed what in-process filtering handles) | Requires a DB server, migration of every table, and ops work; `DATABASE_URL` may already point to PostgreSQL but is "untested" (SYSTEM_ARCHITECTURE §1.1). Design the conflict data model (§D) so geometry + z-range columns port 1:1 to PostGIS. |
| A4 | **Shapely 2.x** | BSD-3-Clause — PyPI metadata `shapely 2.2.0` (REPO via PyPI JSON API, accessed) | Exact 2D buffer/intersection/distance on footprints, GEOS-backed, wheels available | **ADOPT NOW (backend)** for conflict detection & feasibility geometry | Small pure-wheel dependency. **Caveat (READ/EXCERPT):** Shapely is planar; "a third z coordinate … has no effect on geometric analysis. All operations are performed in the x‑y plane" — Shapely user manual https://shapely.readthedocs.io/en/stable/manual.html (accessed, EXCERPT); `buffer()` discards Z (Shapely FAQ). ⇒ vertical separation must be computed separately (§D3). Geometry must be projected to a metric CRS (UTM 43N, EPSG:32643, covers Pune at ~73.8°E) before buffering — via `pyproj` (dependency of GeoPandas; not yet verified installed). |
| A5 | **GeoPandas** | BSD-3-Clause (PyPI `geopandas 1.2.0`, REPO) | DataFrame-based bulk GIS, file I/O via pyogrio/GDAL | **LATER** (import/ETL pipeline for large datasets: WorldCover clips, building footprints) | Pulls pandas + pyproj + pyogrio(GDAL); heavy for a 2-CPU sandbox and not needed for project-scale conflict checks. |
| A6 | **GDAL/OGR** (via `pyogrio` wheels, which bundle GDAL) | GDAL MIT (PyPI `GDAL 3.13.3`); pyogrio MIT (REPO) | Read Shapefile, GeoPackage, KML/KMZ, DXF, GML — the formats PMC/OpenCity/Bhuvan/GSI actually publish (§C) | **LATER (first in line)** — adopt when the import wizard needs non-GeoJSON formats | KML/KMZ and SHP are the common Pune formats (OpenCity PMC datasets list KML/KMZ/GeoJSON/CSV — §C). Until then: GeoJSON-only import with explicit "convert to GeoJSON" message. |
| A7 | **Rasterio** | BSD-3-Clause (PyPI `rasterio 1.5.2`, REPO) | Read DEM / LST / land-cover GeoTIFF, sample, clip, slope | **LATER** — only when a raster (DEM, Landsat ST, WorldCover) is imported | No raster exists in the repo (REPO). Slope/low-point screening (§E5) needs it or a small hand-written GeoTIFF reader. |
| A8 | **OSMnx** | MIT (PyPI `osmnx 2.1.1`, REPO) | Street-network graphs from OSM | **NOT NEEDED** | OSMnx downloads networks/features from the **Overpass API** and geocodes with Nominatim — https://osmnx.readthedocs.io/en/stable/getting-started.html (G. Boeing, OSMnx 2.1.1 docs, READ). Overpass is unreachable here (brief) and the repo already has its own pyosmium-based local OSM index + TypeScript network builder + topology module. OSMnx would be a second, conflicting topology implementation. |
| A9 | **CesiumJS** (already used) | Apache-2.0 (GitHub API, REPO) | 3D globe, 3D Tiles, terrain, below-ground viewing | **KEEP / ADOPT NOW** as the single map/3D engine | It is the only renderer in the app; supports the underground use case (globe translucency / camera below terrain) needed for Underground Planning. **Caveat (READ):** Cesium World Terrain is an ion service; ion ToS §2.2.2 restricts offline copying/storage, the community plan is evaluation-only for commercial use (Cesium staff, community.cesium.com, 2023-12-13, EXCERPT), and terms "must be inaccessible to third parties" — https://cesium.com/legal/terms-of-service (Cesium, accessed, EXCERPT). ⇒ Do **not** cache/export CWT heights as a dataset; for analysis use an open DEM (Copernicus GLO-30) imported locally. |
| A10 | **MapLibre GL JS** | BSD-3-Clause (LICENSE.txt, "Copyright (c) 2023, MapLibre contributors", REPO via raw GitHub) | Fast 2D vector-tile map | **NOT NEEDED now** | A second map engine would duplicate layer management, picking and editing. Cesium already supports 2D/Columbus views. Revisit only if a lightweight 2D-only report/map export is needed. |
| A11 | **deck.gl** | MIT (GitHub API, REPO) | GPU data layers (heatmaps, hexbins, large point sets) | **NOT NEEDED now; LATER** if heat/AQ/large-raster visualisation outgrows Cesium primitives | Interop with Cesium is not native; adds a second render loop. |
| A12 | **Three.js** | MIT (GitHub API, REPO) | Low-level WebGL | **NOT NEEDED** | Cesium already renders the globe; Three.js would only be useful for an isolated cross-section/profile viewer, which is better drawn as **2D SVG** (§E1). |
| A13 | **SUMO** | EPL-2.0 (GitHub API, REPO) | Microscopic traffic simulation, netconvert, HBEFA emissions | **LATER** (keep the existing spike; do not make it a dependency of the main workflow) | Binaries absent in the sandbox (REPO). The in-browser IDM engine is the one modelling implementation (SYSTEM_ARCHITECTURE §1.1). SUMO is worth it only as an **independent cross-check** of the in-house engine on a corridor, which supports the open validation failure (TAG M3.1) rather than hiding it. |
| A14 | **EPA SWMM 5.2** + **pyswmm** | SWMM: public domain — "released in the Public Domain", https://usepa.github.io/Stormwater-Management-Model (US EPA, accessed, EXCERPT); pyswmm: BSD-2-Clause (PyPI `pyswmm 2.2.0`, REPO) | Physically based urban drainage (runoff + pipe/channel hydraulics) | **LATER** — adopt when a drainage network (pipes/nallas with inverts, sizes) and rainfall are imported | Headless-friendly (pip wheels with engine 5.1.14–5.2.4 — PyPI pyswmm page, 2026-10-01, EXCERPT). Without PMC storm-water network geometry + inverts (UNKNOWN, §C) a SWMM model would be fabricated. Foundation now: a "drainage network" layer slot with required SWMM fields (§E3). |
| A15 | **HEC-RAS** (river hydraulics, flood lines) | Free; "Use is not restricted … without charge"; HEC gives no support to non-USACE users; terms of use must be accepted — https://www.hec.usace.army.mil/software/hec-ras/download.aspx (USACE HEC, accessed, EXCERPT); T&C https://www.hec.usace.army.mil/confluence/rasdocs/rasum/latest/terms-and-conditions-of-use (EXCERPT). Not open source. | 1D/2D river flood modelling | **NOT NEEDED in-app; LATER as an external tool** | **Headless feasibility:** official Linux compute engines (`RasGeomPreprocess`, `RasUnsteady`, `RasSteady`) exist for 6.5/6.6 ("compiled for x64 … under RHEL 8") — HEC-RAS 6.6 Linux release notes https://www.hec.usace.army.mil/software/hec-ras/documentation/HEC-RAS_66_Linux_Build_Release_Notes.pdf (USACE, EXCERPT); 7.0.2 setup "includes Linux compiled compute engines" (download page, EXCERPT); HEC-RAS 2025 "designed … to run headless … on Linux" (HEC news, Fall 2024, EXCERPT). **But** geometry/terrain preprocessing (RAS Mapper) is Windows-GUI-centred; third-party tooling runs it under Wine (rascommander.info, EXCERPT). Building a model needs surveyed river cross-sections, a terrain model, and boundary flows — none present. Flood lines for Pune are a **statutory WRD product** (RFI §1.5); the app should import them, not recompute them. |
| A16 | **GemPy** (implicit 3D geological modelling) | EUPL-1.2 — https://github.com/gempy-project/gempy (GemPy developers, LICENSE, EXCERPT); PyPI 2026.0.3 (2026-06-18, EXCERPT) | 3D stratigraphic surfaces interpolated from boreholes + orientations | **LATER (low priority)** | Requires boreholes with interpreted contacts and orientation data; Pune basalt flows (compact vs vesicular-amygdaloidal, weathered zones, red bole — RFI S16) are site-specific. With zero boreholes it would produce a fictional geology. Also adds PyTorch-scale dependencies. |
| A17 | **AGS4** borehole transfer format | Published by the Association of Geotechnical and Geoenvironmental Specialists; Edition 4.2, Dec 2025 — https://www.ags.org.uk/content/uploads/2026/01/AGS-v-4-2-December-2025.pdf (AGS, 2026-01-30, EXCERPT). Format: groups (PROJ, LOCA, GEOL, …) of headings in a structured text/CSV-like file (PRONOM fmt/1649, The National Archives, EXCERPT) | Standard borehole/lab/in-situ test import | **ADOPT NOW (minimal subset)** — parse PROJ/LOCA/GEOL/SAMP/ISPT/WSTK only, no dependency (plain CSV-like parsing) | Lets the platform hold *real* borehole logs with provenance. Whether Indian consultants deliver AGS4 is **UNKNOWN**; also accept a simple CSV template. |
| A18 | **DIGGS** (Data Interchange for Geotechnical & Geoenvironmental Specialists) | ASCE Geo-Institute; GML/XML schema, v3.0 — https://geoinstitute.org/special-projects/diggs (Geo-Institute, EXCERPT) | XML borehole exchange | **LATER** | Heavier (GML schema); converters AGS4↔DIGGS exist (Geosetta, EXCERPT). Support AGS4/CSV first. |
| A19 | **Noise: CNOSSOS-EU** | Commission Directive (EU) 2015/996 of 19 May 2015, OJ L168, 1.7.2015 — https://publications.europa.eu/resource/cellar/a2af495c-1fe0-11e5-a342-01aa75ed71a1.0006.02/DOC_1 (EU Publications Office, EXCERPT); corrigendum OJ L5, 10.1.2018 (EPA Ireland guidance, 2025, EXCERPT) | Road-traffic noise emission (per vehicle category, octave bands 63 Hz–8 kHz) + propagation → Lden/Lnight | **LATER** (deterministic engineering calc, implementable in TS from the directive text) | Inputs need traffic flows by category and speeds (we have modelled, **unvalidated** flows — validation FAILS TAG M3.1), road surface, building geometry & heights (partial). CNOSSOS default coefficients are calibrated to **European fleets**; Indian 2W/auto-rickshaw categories have no CNOSSOS coefficients ⇒ output would be "estimate, method not calibrated for Indian fleet". India's regulatory reference is the **Noise Pollution (Regulation and Control) Rules, 2000** (MoEF, S.O.123(E), 14 Feb 2000) with zone categories industrial/commercial/residential/silence — https://cpcb.nic.in/regulation-control (CPCB, EXCERPT). Comparison against those limits must use **measured** levels, not CNOSSOS estimates. |
| A20 | **Heat: Landsat Collection 2 Level-2 Surface Temperature** | USGS; public domain distribution (USGS policy; eo-atlas, EXCERPT) | Land surface temperature (LST) maps for urban heat screening | **LATER** (deterministic, no ML) — import a pre-processed GeoTIFF; app shows it with date/time of overpass | ST from TIRS band 10, Kelvin = DN×0.00341802+149.0 — https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature (USGS, EXCERPT); delivered on a 30 m grid but TIRS native resolution is 100 m (Landsat 8/9) — USGS L8-9 C2 L2 Product Guide LSDS-1619 (EXCERPT) and NASA NTRS Landsat C2 paper ("nominal resolution of the TIR data is coarser, 60–120 m", EXCERPT). **Limitations to show in UI:** single morning overpass snapshot (not air temperature, not peak heat), ~100 m effective detail, cloud gaps in monsoon. |
| A21 | **Air quality: CPCB/MPCB CAAQMS** | Government data (terms on CPCB CCR portal UNKNOWN) | Measured hourly PM2.5/PM10/NO2/O3/CO/SO2 at stations | **ADOPT (data import) LATER**; **dispersion modelling NOT NEEDED now** | Pune stations are listed by CPCB (e.g. Savitribai Phule Pune University – MPCB; Revenue Colony‑Shivajinagar, MIT‑Kothrud, Mhada Colony, Panchawati‑Pashan, Transport Nagar‑Nigdi – IITM) — CPCB CAAQMS list https://airquality.cpcb.gov.in/ccr_docs/caaqms_list_all_india.pdf (CPCB, EXCERPT). Point stations cannot be interpolated into a street-level map honestly; a dispersion model (e.g. line-source) would need meteorology + validated emissions; our emissions are HBEFA-based estimates on unvalidated flows. Show stations as points with timestamps; no surfaces. |

**Bottom line (A):** for the current transformation adopt only **Shapely (+pyproj)**, the **SQLite R\*Tree**, and a **minimal AGS4/CSV borehole parser**; keep **CesiumJS** as the only renderer. Everything else is gated on data that is not present.

---

## B. Capability classification (deterministic GIS / engineering simulation / ML)

Legend: **1 = deterministic GIS/spatial**, **2 = engineering/physics simulation**, **3 = ML/AI**. "Status" = what exists in the repo (REPO) or what blocks it.

| Workspace | Capability | Class | Status / blocker | ML appropriate? |
|---|---|---|---|---|
| City Explorer | Layer display (OSM roads/buildings/metro, imported layers), identify, measure | 1 | exists (OSM index, Cesium) | No |
| City Explorer | Buffer / proximity queries (e.g. "within 20 m of metro alignment", "within 100/300 m of protected monument") | 1 | to build with Shapely; distances from RFI §1.4, §1.7 | No — fixed geometric rule |
| City Explorer | Land-use / land-cover display | 1 (consume) | import WorldCover / Dynamic World rasters (they are ML products — we *consume*, not train) | We consume published ML outputs with their stated accuracy (WorldCover 2021 overall 76.7% — ESA PVR v2.0, 2022-10-29, EXCERPT) |
| Infrastructure Planning | Road/junction/flyover/bridge geometry, lane sections, grade separation, topology | 1 | exists (`bridgeElevation`, topology module) | No |
| Infrastructure Planning | Feasibility findings (heritage, flood line, trees, metro NOC, RoW) | 1 (rule over geometry + layers) | exists partially (feasibility engine); layer coverage UNKNOWN | **No** — statutory rules are deterministic; ML would invent "feasibility probabilities" |
| Infrastructure Planning | Investigation requirements / document generation | rule-based (not ML) | exists | **No** |
| Underground Planning | Alignment (plan) + vertical profile (chainage vs depth), cross-section drawing | 1 | to build (§E1) | No |
| Underground Planning | Clearance/conflict check vs utilities, foundations, metro tunnels | 1 (2.5D geometry) | to build (§D) | **No** — clearance is geometric; thresholds are user inputs |
| Underground Planning | Borehole display, strata columns along alignment | 1 | to build (§E2) | No |
| Underground Planning | Geological surface interpolation between boreholes | 2/geostatistics (kriging / implicit) | LATER (GemPy) and only with enough boreholes | **No** (geostatistics, not ML) |
| Underground Planning | Tunnel settlement / ground-movement estimation | 2 | NOT NOW — needs geotechnical parameters; empirical methods require professional calibration | No |
| Environmental | Flood-line constraint (blue/red line) | 1 | layer slot; data = WRD scanned maps → must be georeferenced (§C) | **No** |
| Environmental | Drainage / pluvial flooding | 2 (SWMM) | LATER; network data UNKNOWN | No (physics model) |
| Environmental | River flood levels | 2 (HEC-RAS, external) | NOT in-app; import WRD/CWPRS results | No |
| Environmental | Slope, low points, flow accumulation from DEM | 1 | needs a local DEM (§E5) | No |
| Environmental | Groundwater depth display | 1 | import CGWB/GSDA well levels (points) | No — interpolation between sparse wells must be labelled estimate |
| Environmental | Geology / seismic zone context | 1 | import GSI layer (licence-restricted, §C); seismic zone = attribute | No |
| Environmental | Noise (Lden) | 2 (CNOSSOS-EU) | LATER; fleet calibration gap | No |
| Environmental | Air quality | measured points (1); dispersion would be 2 | stations import LATER | No for now |
| Environmental | Heat (LST) | 1 (consume Landsat ST) | LATER | No |
| Environmental | Vegetation (NDVI from Sentinel-2) | 1 (band arithmetic) | LATER | No |
| Environmental | Tree impact count | 1 (count trees in footprint) | PMC Tree Census 2019 on OpenCity (§C) | No |
| Simulation & Analysis | Assignment, micro-simulation, ODME, emissions | 2 | exists; **validation FAILS TAG M3.1** (ENGINEERING_VALIDATION.md) | No — keep physics/behavioural models |
| Simulation & Analysis | Short-term traffic forecasting (next 15–60 min) | **3** | **blocked**: requires continuous per-link counts over months; DCRNN-style models were trained on 207 loop detectors at 5-min resolution for 4 months (METR-LA) — Li et al., ICLR 2018, https://arxiv.org/pdf/1707.01926 (EXCERPT). Pune has no such open feed (UNKNOWN). | **Yes, genuinely ML — but only after counts exist** |
| Simulation & Analysis | Demand estimation (OD) | 2/statistical (ODME) | exists | No — ODME with TAG limits, not black-box ML |
| Projects & Coordination | Conflict detection, stale-assessment flags, versioning, audit | 1 + data rules | §D | **No** |
| Reports | Feasibility/environmental/traffic/comparison reports | templating over stored results | exists (DOCX/PDF) | **No** (no LLM-written engineering conclusions) |
| Data ingestion | Building footprint gap-fill (where OSM is missing) | 3 (consume) | import Google Open Buildings v3 / Microsoft footprints with their confidence scores (§C) | Yes — **consume** existing ML datasets; do not train our own (no labelled Pune data, no GPU in sandbox) |
| Data ingestion | Building/land-use detection from new imagery (own model) | 3 | LATER, only if a project needs a newer vintage than the published datasets; needs licensed high-res imagery (UNKNOWN) | Yes — legitimate ML use, deferred |
| Data ingestion | Georeferencing scanned DP / flood-line PDFs | 1 (manual control points + affine/polynomial) | to build (simple control-point tool) LATER | No — ML auto-georeferencing would hide error; RMS of control points must be shown |

**Where ML is NOT appropriate (explicit):** feasibility verdicts, statutory buffers, clearance/conflict checks, flood lines, structural/geotechnical judgements, emission factors, report conclusions, "filling" UNKNOWN layers, and calibrating/validating the traffic model (ODME + independent validation counts is the method; an ML surrogate fitted to the same counts would mask the TAG M3.1 failure).

**Genuine ML uses (ranked):** (1) consume Google/Microsoft ML building footprints and WorldCover/Dynamic World land cover, displaying their published confidence/accuracy; (2) short-term traffic forecasting **once ≥ several months of continuous counts exist** for the study network; (3) own imagery classification for change detection, only with licensed imagery and labelled samples.

---

## C. Pune data sources

Columns: Name · Publisher · URL · Licence · Coverage · Resolution/scale · Date/vintage · Access · Limitations. "UNKNOWN" = not found/verified this session.

| Name | Publisher | URL | Licence | Coverage | Resolution | Date | Access | Limitations / source status |
|---|---|---|---|---|---|---|---|---|
| OpenStreetMap | OSM Foundation / contributors | https://www.openstreetmap.org ; licence https://osmfoundation.org/wiki/Licence | ODbL 1.0 (share-alike for derived databases) (not re-opened this session; standard OSMF licence) | Global | vector, volunteered | live | Geofabrik extract → repo's local index (REPO) | Completeness for Pune buildings/trees/water **UNKNOWN** (RFI §1.1). Absence never proves feasibility. |
| PMC Open Data Portal (new) | Pune Municipal Corporation | https://opendata.pmc.gov.in/datasets (READ: page loads; dataset list rendered client-side, not enumerated) | NDSAP-based policy page https://opendata.pmc.gov.in/open-data-policy (EXCERPT); dataset-level licence UNKNOWN | PMC limits | varies | portal © 2025 | web download (JS app) | Legacy URL opendata.punecorporation.org listed by re3data with 349 datasets (re3data, EXCERPT) — current dataset count/formats UNKNOWN. |
| OpenCity mirror of PMC datasets | OpenCity (Oorvani Foundation) | https://data.opencity.in/dataset?organization=pune-municipal-corporation | "Other (Public Domain)" as labelled by OpenCity (EXCERPT) | PMC | varies | e.g. Tree Census Aug 2019; Ward maps (KML/GeoJSON); "Pune Footpaths and Roads" (CSV) | CKAN download | Mirror, not the publisher; provenance must record OpenCity + original PMC source. 40 PMC datasets incl. KML/KMZ/GeoJSON (EXCERPT). |
| PMC Tree Census 2019 | PMC (via OpenCity) | https://data.opencity.in/dataset?organization=pune-municipal-corporation (listing "Pune Tree Census 2019", EXCERPT) | as above | PMC | point per tree (presumed — schema UNKNOWN) | Aug 2019 | CSV | 2019 vintage; Trees Act survey still required (RFI §1.6). |
| Pune Smart City (PSCDCL) data | Pune Smart City Development Corp. | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | Not found this session. |
| PMC Development Plan / DCPR 2017, UDCPR 2020 | PMC / UDD Maharashtra | RFI S11, S12 | UNKNOWN (published PDFs) | PMC old limits | sheet scans | DCPR 05/01/2017 | PDF | Must be georeferenced by the user; merged-village status TO VERIFY (RFI §1.2). |
| PMRDA Development Plan | PMRDA | https://www.pmrda.gov.in/en/development-plan (RFI S13) | UNKNOWN | PMR | PDF | draft 2021–2041 | PDF | Status TO VERIFY (RFI §1.2). |
| Bhuvan thematic layers (LULC 1:50K, geomorphology, lineament, flood hazard, Carto DEM) | NRSC / ISRO | RFI S14 | UNKNOWN (use as WMS overlay only) | India | 1:250K/1:50K/1:10K | LULC cycles 2005-06, 2011-12, 2015-16 | OGC WMS/WMTS | Redistribution terms TO VERIFY. |
| CGWB aquifer map & groundwater management plan, Pune district | Central Ground Water Board | https://cgwb.gov.in/sites/default/files/2022-11/pune.pdf (RFI S16) | UNKNOWN (Govt publication) | Pune district | district scale | 2022 PDF | PDF | Not site-specific. |
| Groundwater levels (manual quarterly & telemetry) | CGWB via NWIC India-WRIS / National Water Data Portal | https://indiawris.gov.in/wris/#/groundWater ; https://nwdp.nwic.gov.in/dataset/gwl-manual-quarterly-central-ground-water-board-department | NWDP: UNKNOWN; an India Data Portal copy is labelled "Open Data Commons Attribution License" (ckandev.indiadataportal.com, EXCERPT) | India (wells) | point wells; quarterly / daily telemetry | NWDP updated 2026-11-07 (EXCERPT) | CSV/API (portal); a QGIS plugin notes WRIS may need an Indian IP (GitHub, EXCERPT) | Sparse wells; depth-to-water varies with basalt jointing. GSDA also holds levels since 1972 (gsda.maharashtra.gov.in, EXCERPT). |
| IMD gridded daily rainfall 0.25° | India Meteorological Department, Pune | https://imdpune.gov.in/cmpg/Griddata/Rainfall_25_NetCDF.html (EXCERPT) | UNKNOWN (no licence stated in excerpt) | India | 0.25° (~27 km) | 1901–2024 yearly files; real-time daily separate | NetCDF/binary download | One/two grid cells cover all of Pune → unusable for street-level drainage design; IDF curves for design storms not found (UNKNOWN). |
| CPCB/MPCB CAAQMS air-quality stations | CPCB (CCR), MPCB, IITM | https://airquality.cpcb.gov.in/ccr_docs/caaqms_list_all_india.pdf ; portal https://app.cpcbccr.com | UNKNOWN | Pune ~10 stations (IITM+MPCB; OpenCity hourly 2017–2023 for 10 stations, EXCERPT) | point, 15-min/hourly | live | CCR portal download (limited window per request — urbanemissions.info, 2020, EXCERPT) | Points only; no spatial surface. |
| CPCB/MPCB real-time noise (NANMN) | CPCB / MPCB | https://cpcb.gov.in/Real-Time-Noise-Data/ | UNKNOWN | Pune: 4 PMC + 3 PCMC stations planned under NANMN Phase II (TOI, 2024-02-29, EXCERPT); operational status UNKNOWN | point | — | portal | Manual MPCB surveys exist (Dec 2024 report, EXCERPT). |
| Copernicus DEM GLO-30 | ESA / Copernicus (Airbus) | https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM | Free worldwide licence with attribution notice (Copernicus WorldDEM-30 licence, 2020-10-29, EXCERPT) | Global | 1″ (~30 m); **DSM** (includes buildings/vegetation) | data 2010–2015; release 2023_1/2024_1 | download / Earth Engine / OpenTopography | Abs. vertical accuracy < 4 m (90% LE) — Copernicus DEM Product Handbook (EXCERPT). DSM ⇒ not bare earth in dense city; good for slope screening at > 30 m scale only. **Recommended open DEM.** |
| SRTM / NASADEM 1″ | NASA / USGS LP DAAC | https://lpdaac.usgs.gov (UNKNOWN page not opened) | no restrictions (NASA policy) — secondary (topolines.app, EXCERPT) | 60°N–56°S | ~30 m | 2000 acquisition | download | 2000 vintage; DSM-like. |
| ALOS AW3D30 v4.1 | JAXA EORC | https://www.eorc.jaxa.jp/ALOS/en/dataset/aw3d30/aw3d30_e.htm | Free for commercial & non-commercial use under JAXA terms; credit "© JAXA" (JAXA, EXCERPT) | Global | ~30 m DSM | v4.1 Apr 2024 | registration + download | DSM. |
| Cesium World Terrain | Cesium | https://cesium.com/platform/cesium-ion/content/cesium-world-terrain/ | Cesium ion ToS — streaming only, no offline copy without licence (EXCERPT) | Global | variable | — | ion token (used by app) | Visual ground only; **not** an analysis dataset for us (§A9). |
| ESA WorldCover 2021 v200 | ESA / VITO | https://esa-worldcover.org/en/data-access | CC BY 4.0 (ESA, EXCERPT) | Global | 10 m, 11 classes | 2021 (2020 v100 uses different algorithm — don't diff) | COG tiles 3°×3° | Global OA 76.7% (PVR v2.0, EXCERPT); Pune-specific accuracy UNKNOWN. |
| Dynamic World V1 | Google / WRI | https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1 | CC BY 4.0 with required attribution (EXCERPT) | Global | 10 m, 9 classes, per-image probabilities | 2015-06-27 → present | Earth Engine account required | Per-scene ML probabilities; monsoon cloud gaps. |
| Sentinel-2 L2A | ESA Copernicus | https://dataspace.copernicus.eu | Copernicus free & open data policy (not re-opened this session) | Global | 10/20/60 m | 2015→ | CDSE download/API | Cloud cover Jun–Sep. |
| Landsat C2 L2 Surface Temperature | USGS | https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature | USGS public domain (eo-atlas, EXCERPT) | Global | 30 m grid, ~100 m native (L8/9) | 1982→ | EarthExplorer / Planetary Computer STAC | See §A20. |
| Google Open Buildings v3 | Google Research | https://sites.research.google/gr/open-buildings | CC BY 4.0 **or** ODbL 1.0, user's choice (source.coop / Google, EXCERPT) | Africa, S & SE Asia (incl. India), LatAm | polygons + confidence | inference May 2023 | GeoParquet/CSV, Earth Engine | ML-detected, no heights in v3 polygons (2.5D product separate, UNKNOWN for Pune). |
| Microsoft Global ML Building Footprints | Microsoft / Bing Maps | https://github.com/microsoft/GlobalMLBuildingFootprints (READ) | **CDLA Permissive 2.0** (README & LICENSE, READ, 2026-11-13; older copies/wikis say ODbL — current repo says CDLA-P-2.0) | 225 regions incl. India (128 M edits, India 110 M, Mar 2024) | polygons; some heights (-1 = none) | imagery 2014–2024; refresh 2026-08-13 | `dataset-links.csv` quadkey tiles (GeoJSONL .csv.gz) | South Asia eval: precision 94.8%, recall 76.7% (README, READ). |
| GSI geological maps (Bhukosh) | Geological Survey of India | https://bhukosh.gsi.gov.in/Bhukosh/MapViewer.aspx | **Single-user, limited, non-exclusive, non-transferable licence**, registration required — GSI Data Sharing & Accessibility Policy 2019 (geodataindia.gov.in, 2019-02-12, EXCERPT) | India | Geology 50K, 2M; geomorphology 250K | various | registered download | **Cannot be redistributed** in a shared city model; store only a user-imported copy with licence note. |
| Seismic zone | Bureau of Indian Standards (IS 1893 Part 1) | 2016 map; bharatlas copy from data.gov.in (GODL-India, EXCERPT) | — | India | zones II–V | **IS 1893:2025 (Zone VI added, Nov 2025) was withdrawn in March 2026; 2016 edition reinstated** — ETV Bharat opinion, 2026-03-11 (READ); ClearIAS & learnpro (EXCERPT, report Parliament informed 1 Apr 2026) | — | Pune city = **Zone III** per IS 1893(1):2016 is reported by secondary sources (civilspace.ai, EXCERPT; Pune District Disaster Management Plan 2025-26, citing IS 1893 Part I **2002**, places SW Bhor and Velhe talukas in Zone IV; the excerpt was cut before the rest of the district — https://cdnbbsr.s3waas.gov.in/s36143cc48107351648de16d8367dc5db4/uploads/2025/04/202504071915386014.pdf, EXCERPT). **Status: secondary — TO VERIFY against the BIS map.** |
| Pune Metro alignments | MahaMetro (Lines 1, 2, 1A, 1B); PMRDA / Puneri Metro (Line 3) | https://www.punemetrorail.org/project-profile ; https://www.punemetrorail.org/alignment-map ; DPRs (e.g. PCMC–Nigdi DPR PDF) | UNKNOWN | Lines: L1 PCMC–Swargate 17.4 km (5 UG/9 elev stations), L2 Vanaz–Ramwadi 15.7 km, L1A 4.413 km, L1B Swargate–Katraj 5.46 km (3 UG) — MahaMetro project profile (EXCERPT) | PDF maps / DPR PDFs; **no official GIS file found** | — | PDF; OSM has railway=subway/light_rail geometry (ODbL) | **Tunnel depth/crown levels: UNKNOWN** (not in OSM; DPR may contain profiles — not read). Esri India publishes a "Pune Metro Rail Network 2024" map layer (ArcGIS Online, EXCERPT) — licence UNKNOWN. |
| Flood lines (blue/red) Mula, Mutha, Mula-Mutha, Ram Nadi, Pawana… | Water Resources Dept, Govt of Maharashtra (Khadakwasla Irrigation Div.) | https://wrd.maharashtra.gov.in/Site/1321/Red-and-Blue-Line-Maps (EXCERPT); punefloodcontrol.com/maps.html previously listed Pune sheets but **currently shows "Coming Soon"** (READ 2026-11-13) | UNKNOWN | Pune rivers | **scanned PDF sheets, no vector** (neervazhvu.org, EXCERPT: 513 sheets statewide, Sep 2026) | 2011 Mutha maps; revisions under NGT/HC direction; MERI reassessment 2025 raised design flows (TOI 2025-01-27, EXCERPT) | PDF | Must be georeferenced; the lines are **legally contested and under revision** ⇒ every finding cites sheet + date. |
| CWPRS flood study Mula/Mutha | Central Water & Power Research Station, Pune | news: Punekar News 2026-09-04 (EXCERPT) | — | ~44 km river system | physical model | study announced Sep 2026; **results UNKNOWN/not published** | — | Not available. |
| PMC storm-water / drainage network | PMC | UNKNOWN (a secondary site cites "3,075 open storm-water channels, 1,014 km", neervazhvu.org, EXCERPT — primary source not found) | UNKNOWN | — | — | — | — | No open network geometry with inverts found ⇒ SWMM blocked. |
| Utilities (water, sewer, MSEDCL, MNGL, telecom) | respective owners | UNKNOWN | — | — | — | — | — | Not public; import from project records only (RFI §1.9). |
| Boreholes / geotechnical reports | project consultants, MahaMetro DPR geotech chapters | DPR PDFs list "Geotechnical Investigations" (PCMC–Nigdi DPR contents, EXCERPT) | UNKNOWN | — | — | — | PDF | No open borehole database found for Pune (UNKNOWN). |

---

## D. Shared city model, proposal geometry, conflict detection, staleness, versioning

Builds on the existing tables (REPO §0). New tables are **additive**; nothing existing is altered.

### D1. Layers of the shared model

1. **Baseline assets (immutable per baseline version).** Existing `city_objects` rows with `scenario_id='base'` plus imported reference layers. Add:
   - `datasets(id, name, kind ['vector'|'raster'|'boreholes'|'table'], publisher, source_url, licence, licence_restrictions, vintage_date, retrieved_at, file_name, file_sha256, crs, coverage_wkt_bbox, imported_by, imported_at, redistributable bool, notes)` — one row per imported file; **never edited**; a corrected file is a new dataset row with `supersedes_id`.
   - `dataset_features(dataset_id, feature_id, geometry_geojson, z_min_m, z_max_m, z_ref ['ground'|'msl'|'ellipsoid'|'unknown'], z_source ['measured'|'design'|'estimated'|'unknown'], properties_json)` + R\*Tree `dataset_features_rtree(rowid, min_x, max_x, min_y, max_y)`.
   - `baseline_versions(id, label, fingerprint, created_at, dataset_ids_json)` — the existing `baseline_fingerprint` already hashes baseline objects; extend the fingerprint input to include the dataset sha256 list.
2. **Projects** (`planning_projects`, exists) reference baseline assets by **id + baseline fingerprint**, never by copying them.
3. **Proposals** are scenarios with copy-on-write change sets (`scenario_object_changes`, exists) frozen into `scenario_versions` (exists, immutable, `change_set_hash`).
4. **Proposal 3D extent** (new, additive): `proposal_extents(scenario_version_id, object_id, footprint_geojson (2D, EPSG:4326), z_min_m, z_max_m, z_ref, z_source, buffer_m, buffer_source ['user'|'project_default'|'unknown'], construction_phase ['permanent'|'temporary_works'], computed_at, extent_hash)`. Derived from object geometry:
   - road/junction: footprint = centreline buffered by half carriageway + roadside widths (existing `sections`); z = deck/ground ± structure depth (user input; default **UNKNOWN**, not 0).
   - flyover/bridge/metro viaduct: deck footprint z from `elevation`; piers/foundations as separate extents with **z_min UNKNOWN until the user enters foundation depth**.
   - tunnel / underground metro / pipeline / utility: footprint = alignment buffered by outer radius (diameter/2) or trench width/2; z from vertical profile (§E1): `z_min = invert − lining/bedding`, `z_max = crown + lining`; for `UtilityObject` use `depth` (m below ground) ± diameter/2 with `z_ref='ground'`.
   - Long alignments are **segmented by chainage** (e.g. every profile vertex) so each segment has its own z-range — this is what makes the check 2.5D rather than one big box.

### D2. Clearance rules (user-configurable, hypothetical defaults)

`clearance_rules(id, rule_set_id, subject_kind, other_kind, horizontal_m, vertical_m, basis ['user_entered'|'project_policy'|'cited_standard'], citation NULL, created_by, created_at)` and `clearance_rule_sets(id, name, status, created_by)`.

- Ship **one example rule set named "Hypothetical defaults — not a standard"** whose values are **blank** (or a single illustrative value the UI marks HYPOTHETICAL). The UI forces the user to enter/confirm values; findings computed with an unconfirmed rule carry `certainty='hypothetical'`.
- The only distances the platform may pre-fill with `basis='cited_standard'` are ones already sourced in RFI: metro NOC zone **20 m from elevated/underground route** (RFI §1.7, S9 — a *permission trigger*, not an engineering clearance) and AMASR **100 m / 300 m** (RFI §1.4). No IRC/IS clearance values are pre-filled (not read; would be invented).

### D3. Conflict-detection algorithm (deterministic, 2.5D)

Input: two proposal versions A and B (from any projects) and/or baseline datasets; a rule set.

1. **Candidate pairs (bbox prefilter):** expand each extent's bbox by `max(buffer_m, rule.horizontal_m)` converted to degrees at Pune's latitude (or do it in UTM 43N); query the SQLite R\*Tree. O(n log n).
2. **Horizontal test (exact):** project footprints to EPSG:32643 (pyproj), `d_h = shapely.distance(fpA, fpB)`; horizontal conflict if `d_h ≤ rule.horizontal_m + bufA + bufB` (or `intersects` when rule = 0).
3. **Vertical test (interval arithmetic, because Shapely ignores z):** normalise both z-ranges to a common reference. If either `z_ref` differs and no ground model converts them, or either z is UNKNOWN → **vertical = UNKNOWN**. Else gap `g_v = max(zA_min − zB_max, zB_min − zA_max, 0)`; vertical conflict if `g_v < rule.vertical_m`.
4. **Classification** (never "clear" on missing data):
   - `conflict` — horizontal hit AND vertical hit (both z known);
   - `potential_conflict_z_unknown` — horizontal hit, vertical UNKNOWN;
   - `separated_vertically` — horizontal hit, vertical gap ≥ rule (still listed, with the gap);
   - `no_conflict_within_available_data` — no horizontal hit **and both datasets cover the area**; otherwise `unknown_no_coverage` (dataset `coverage_wkt_bbox` does not contain the extent).
   - Every finding records: rule id + basis, extent hashes, dataset ids + sha256, z_source of each side, computed distances, `certainty` (`measured` only if both geometries are surveyed; else `design`/`estimated`/`hypothetical`/`unknown`).
5. **Persistence:** `conflict_runs(id, inputs_json [version ids, extent hashes, rule_set snapshot, dataset hashes], engine_version, created_at)` and `conflict_findings(run_id, a_ref, b_ref, class, d_h_m, g_v_m, rule_id, certainty, evidence_json)` — append-only, like `scenario_runs`. Exact 3D (`ST_3DDWithin`) becomes a drop-in when/if PostGIS is adopted (§A3).
6. Example from the mission (metro tunnel × water pipeline × road widening): tunnel segments (z −12…−18 m, design) vs pipeline (depth 1.5 m, z_source estimated) → `separated_vertically` with the gap shown; road-widening footprint vs pipeline → horizontal hit, vertical "permanent works at grade vs 1.5 m pipe" → `conflict` under the user's rule; widening vs tunnel → `separated_vertically` **unless** the widening includes piers whose foundation depth is UNKNOWN → `potential_conflict_z_unknown`.

### D4. Proposal isolation and "never silently overwrite"

- Each project only writes its own scenarios/versions (existing copy-on-write; overrides keyed by `(scenario_id, object_id)`).
- Another project's object can only be **referenced** (`planning_project_links`, exists) or **forked** (new scenario that starts from that version id, recording `forked_from_version_id`). No cross-project writes.
- A project may **acknowledge** a conflict (`conflict_acknowledgements(finding_id, project_id, by, at, note)`, append-only) — acknowledgement never changes the finding.

### D5. Stale-assessment rules (explicit indicators, computed on read)

An assessment (feasibility finding set, conflict run, simulation run, report) stores the hashes of its inputs. It is **STALE** when any of:
1. its `scenario_version` is no longer the latest version of that scenario (newer version exists);
2. `baseline_fingerprint` at run time ≠ current baseline fingerprint (already computed for projects: `baseline_changed_since_created`);
3. any referenced dataset has a newer superseding dataset row;
4. any **other project's** version that took part in a conflict run has a newer version (cross-project staleness — the key coordination signal);
5. the clearance rule set used was edited (rule-set snapshot hash differs);
6. the engine version differs (e.g. topology/conflict code changed).

UI shows "Stale — reason(s)", never hides the old result, and offers "re-run" that creates a **new** run row. Reports embed the staleness state at generation time.

### D6. Versioning summary

Immutable: baseline versions, datasets, scenario versions, runs, conflict runs, decisions, audit log. Mutable only: working change sets (`scenario_object_changes`) and draft rule sets. Restore = new version (existing behaviour). All writes go through the existing audit session hooks.

---

## E. Underground & environmental foundations implementable NOW (no external data)

All items below need only the existing stack (+ Shapely/pyproj for E4). Labels: what is **real** vs **user-entered**.

| # | Foundation | What it does (honestly) | Data it needs | Never shows |
|---|---|---|---|---|
| E1 | **Alignment + vertical profile + cross-section editor** | Plan alignment on the Cesium map (existing drawing tools); a profile table of `(chainage_m, ground_level_m [from terrain sample or user], crown/invert or depth_below_ground_m, z_source)`; 2D SVG **long-section** (chainage vs depth, ground line, structure band) and **typical cross-section** (circle/box/trench with dimensions entered by user). Validates monotonic chainage, min-depth vs user rule, gradient (Δz/Δchainage) shown as computed number. | user geometry + entered dimensions; ground line from Cesium terrain sampling **only when terrain is on** (label "visual terrain, ion, not survey") else "ground level UNKNOWN — depths relative to unknown ground" | geology, settlement, structural adequacy |
| E2 | **Borehole / trial-pit record import with provenance** | Import AGS4 subset (PROJ, LOCA, GEOL, WSTK, ISPT) or a CSV template; each record → `dataset_features` point with strata intervals; show columns in 3D (Cesium cylinders below ground) and project them onto the long-section within a user-set offset. Provenance = dataset row (file sha256, publisher, date, licence). | user files | interpolated geology between holes (LATER) |
| E3 | **Utility record import** | GeoJSON/CSV of utilities with `utilityType, depth_m or invert_level, diameter_m, owner, survey_method ['record'|'GPR'|'trial_pit'|'unknown'], quality`. Feeds §D conflict checks with `z_source`. Existing `UtilityObject.depth` becomes `z_source='estimated'` unless a survey method is given. | user files | "no utilities" when none imported → `unknown_no_coverage` |
| E4 | **Conflict & clearance check** (§D3) across projects | deterministic 2.5D | proposal extents + rules | "clear" without coverage |
| E5 | **Environmental layer slots, UNKNOWN until imported** | A registry of slots: Flood lines (WRD blue/red), Drainage network (SWMM-ready fields: node invert, rim, conduit shape/size/roughness), Groundwater wells, Geology (GSI, licence-restricted), Seismic zone (attribute, TO VERIFY), Air-quality stations, Noise stations, LST raster, Land cover raster, Tree census. Each slot shows **"No data — UNKNOWN"** with the source in §C and a link to import. Feasibility rules that depend on a slot return `unknown` with the slot name. | none | any default/assumed layer |
| E6 | **Georeferencing helper for scanned PDFs** (DP sheets, flood-line maps) — LATER-but-simple | user picks ≥3 control points → affine transform; shows RMS error; output stored as an image overlay with `certainty='estimated (georeferenced, RMS x m)'`. | user PDF/PNG | vector "flood line" unless the user digitises it |
| E7 | **DEM-based slope / low-point screening** | **NOT implementable now with honest data**: the repo has **no offline DEM** (REPO). Cesium World Terrain is streamed via ion and its terms restrict storing/redistributing it (§A9), and its provenance/resolution for Pune is not documented to us. ⇒ Implement the code path against an **imported GeoTIFF DEM** (Copernicus GLO-30 recommended, §C) and keep the feature disabled with "requires imported DEM" until one is imported. Must label results "DSM-based (includes buildings/trees), 30 m, screening only". | imported DEM | slope/low points from ion terrain |

Implementation order (suggested): E5 slots + E3/E2 import (provenance) → E1 profile/cross-section → D tables + E4 conflict run → E6 → E7 (when a DEM is supplied).

---

## F. Key recommendations (summary)

1. **Do not add PostGIS, GeoPandas, GDAL, Rasterio, MapLibre, deck.gl, Three.js, OSMnx, GemPy, SWMM or HEC-RAS now.** Each is either redundant with what we have, or gated on data that does not exist in the repo. Adopt **Shapely + pyproj + SQLite R\*Tree** only.
2. **CesiumJS stays the single renderer.** Don't treat Cesium World Terrain as analysis data (licence + provenance); use an imported Copernicus GLO-30 DEM for any slope/low-point work.
3. **Conflict detection = deterministic 2.5D** (exact 2D distance in UTM 43N + z-interval gap), with `potential_conflict_z_unknown` and `unknown_no_coverage` classes, and **user-entered clearance values** (only RFI-cited permission distances pre-filled).
4. **Staleness is computed from hashes** (scenario version, baseline fingerprint, dataset sha256, other project versions, rule-set snapshot, engine version) — the existing `baseline_fingerprint`/`change_set_hash` machinery is the base.
5. **ML only where genuine:** consume Google/Microsoft building footprints and WorldCover/Dynamic World with their published accuracy; short-term traffic forecasting only after months of continuous counts exist. No ML for feasibility, clearance, flood, geology, reports or model calibration.
6. **Pune data reality:** flood lines are scanned, contested PDFs (the punefloodcontrol.com map page is currently offline); metro tunnel depths, drainage networks, utilities and boreholes are **not openly available** → UNKNOWN slots. GSI geology is single-user licensed (no redistribution). Seismic zone: IS 1893:2025 withdrawn (Mar 2026), 2016 map applies; Pune = Zone III per secondary sources, **to verify**.

---

## G. Not established this session (explicit gaps)

- Licence terms of: PMC portal datasets (per dataset), IMD gridded data, CPCB CCR data, Bhuvan layers, MahaMetro DPR drawings, WRD flood-line sheets.
- Pune Smart City (PSCDCL) open data — nothing found.
- OSM completeness for Pune (buildings, trees, water) — not measured.
- Whether Pune geotechnical consultants deliver AGS4 or DIGGS.
- Pune Metro underground tunnel crown/invert levels (DPR profiles not read).
- PMC storm-water network geometry/inverts; IDF curves for Pune.
- Primary BIS confirmation of Pune's seismic zone under IS 1893(1):2016.
- Copernicus DEM / WorldCover accuracy specifically over Pune.
- Whether `pyproj`/`shapely` wheels install cleanly in the sandbox (not attempted — no code changes in this task).
