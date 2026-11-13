# Pune data availability, domain by domain (Indian government and Pune sources)

Written 2026-11-13 (IST) by the gov-sources agent. Each source's details (URLs, licence quotes, hashes, QA) are in `catalogue/india.md`. Global open datasets (DEM, land cover, buildings, Sentinel-2, soil, CHIRPS) are in `catalogue/global.md`; this file refers to them only where they fill a gap.

**Status words used below:**
- **ACQUIRED**: raw file plus manifest, and a derived layer exists.
- **CATALOGUED**: we know the item exists, but we did not download it.
- **BLOCKED**: login, key or CAPTCHA required. Not bypassed.
- **UNREACHABLE**: the sandbox could not connect on 2026-11-13.
- **NONE FOUND**: we found no public source.

Suitability is always **visualisation** or **screening** here. Nothing is engineering grade: no source states its survey method or accuracy for Pune.

## 0. Storage and run

**Storage paths**
- Raw files: `/workspace/work/urbanos-data/raw/<source_id>/2026-11-13/` with `manifest.json` (url, retrieved_at in IST, HTTP headers where capturable, sha256, size, licence as stated).
- Derived files: `/workspace/work/urbanos-data/derived/<dataset_id>/2026-11-13/` with `processing.json` (pipeline, git commit, input sha256, parameters, output sha256, validation).
- The app-side root is `URBANOS_DATA_DIR` (default `backend/data/urbanos`); see the DSI agent's DATA_INGESTION_ARCHITECTURE.md.
- The pipelines use `URBANOS_DATA_ROOT`, `URBANOS_RAW_DIR` and `URBANOS_DERIVED_DIR`.

**To run:** `cd backend && python -m datasets.pipelines.<opencity_pune|opencity_trees|imd_rainfall|nwdp_groundwater|cpcb_air_quality|gov_fetch>`.

**Test status:** HEADLESS-RUN on 2026-11-13, and the parsers are UNIT-TESTED (`backend/tests/test_gov_pipelines.py`, 13 passed).

## 1. Administrative units and population

**Ward boundaries: ACQUIRED** (OpenCity/PMC KML)
- Administrative wards 2017: 15.
- Electoral wards 2012, 2017, 2022 and 2025: 76 / 41 / 58 / 41.
- Prabhag boundaries: 72. Zones: 5.
- The 2025 administrative-ward GeoJSON is not acquired (browser rendered it inline; manual download needed).
- PCMC wards: not acquired here. A DataMeet copy exists in `raw/datameet_municipal_wards` from another agent.
- Suitability: screening. Dates come from dataset titles; vertex accuracy is UNKNOWN.

**Population: HISTORICAL 2011 only**
- Ward-wise table from PMC via OpenCity: 146 census wards plus subtotal rows. The rows without subtotals sum to 3,287,556.
- There is **no census-ward boundary layer**, so the table cannot be mapped yet.
- Census 2021 was not conducted. Census 2027 population enumeration runs 2027-01-25 → 2027-02-28 (reference date 2027-03-01).
- **No official post-2011 counts exist.** Any current population figure in the app must be labelled estimated, with its method.

**Revenue map: ACQUIRED** (gut / village / TPS polygons, 29,140; undated). Screening for land-parcel context. **Not** a legal record: 7/12 extracts and city survey sheets are the authority.

## 2. Planning and zoning (DP)

**PMC DP 2017 vector: BLOCKED (licence UNKNOWN)**
- PMC's AutoDCR GeoServer (`iwmsgis.pmc.gov.in`) publicly serves these layers:
  - `PMC_DP`
  - `PLU_Ward` (329)
  - `PMC_Reservation` (833)
  - `DP_Ward_Road` (77)
  - `TOD_Zones` (38)
  - `TDR_Zones`
  - `Aviation_data` (28 height zones)
  - `Monuments` (9)
  - `Red_Blue` (14 flood-line zones)
- WMS and WFS both work without login, and the capabilities say "AccessConstraints NONE".
- No licence is published, so we only probed it. The next step is a permission request (collection plan §2.1).

**Draft CDP 2041: CATALOGUED** (PDF, OpenCity). **DCPR 2015: CATALOGUED** (PDF).

**PMRDA draft DP 2021–41 and the new public GIS portal: UNREACHABLE.** Per the press note it carries metro corridors, ring roads and TOD; flood lines are "being onboarded".

**PCMC DP: CATALOGUED.** It is published only as sheet images.

**Suitability:** without the statutory vector, DP checks stay "UNKNOWN — consult sanctioned DP sheet".

## 3. Drainage, sewerage and flood

**Sewer network: ACQUIRED**
- 44,482 lines, 660 km, with manhole ids, ground levels (`tl_*`), invert levels (100 % filled), diameter and slope.
- The values look like a sewerage master-plan **model**: design-horizon depths for 2017/2027/2037/2047, every pipe "RCC", and `source_ass` = "Pipeline".
- Class: observed geometry / **UNVERIFIED design attributes**.
- Suitability: screening for underground conflicts. Every finding must say "design value, field verification needed".

**"Stormwater drains" layer: ACQUIRED, quality warning**
- 141,341 lines, 3,708 km.
- 44,492 of them are **identical to sewer features**. Most others are labelled `Road_Sewer`; only 9,187 are "Storm water drains", plus 3,227 "Nalla".
- **Do not present the whole file as a storm-drain network.** Filter by `category` and record the ambiguity.

**SWD chambers: ACQUIRED** (22,771, with pipe diameter). **Nallas: ACQUIRED** (3,075 lines, 1,010 km). **Rivers: ACQUIRED** (12 polygons).

**Coverage tables: ACQUIRED** (prabhag-wise SWD coverage 2016; primary drain channels 2012).

**Flood lines (red/blue)**
- PMC AutoDCR `Red_Blue`: BLOCKED. The licence is unknown, and so is its source date and order.
- WRD statutory sheets: scanned PDFs (ENGINEERING_GIS_RESEARCH §C).
- The app keeps flood lines as UNKNOWN.

**Micro-watersheds (SLUSI): CATALOGUED.** The GeoJSON was not saved.

**Rainfall**
- IMD 0.25° gridded daily, 2000–2025: ACQUIRED, 4 cells. 12 cell-years are flagged suspect (for example 2005 at 74.0E 18.5N, 6,495 mm). Screening only.
- IMD district daily: ACQUIRED, but only since 2026-08-19.
- PMC annual/monthly tables: ACQUIRED.
- **IDF curves: NONE FOUND.**

## 4. Groundwater and geology

**Groundwater levels: ACQUIRED** (NWDP)
- 36 wells in the box: CGWB 15, GSDA 21.
- 2,849 manual readings, 1974 → 2025-10-01, in m bgl.
- Class: observed. Suitability: screening at the well point only. **No surface is interpolated.**
- GSDA telemetry (six-hourly, 529 MB): CATALOGUED.

**CGWB aquifer report for Pune district: UNREACHABLE** (cgwb.gov.in timed out).

**Geology and lithology (GSI 1:50K): BLOCKED** (registration and single-user licence; Bhukosh unreachable). This stays UNKNOWN.

**Bhuvan geomorphology, lineaments and soil (1:50K): visible by WMS only.** The Bhuvan ToS forbid copying and derivative works, so these are a live visualisation overlay at most.

**Boreholes: NONE FOUND.**

## 5. Trees, green and water bodies

**Tree census: ACQUIRED**
- 4,009,623 points with species, girth, height, canopy, condition and a rare flag. The vintage is 2019 per the title.
- Suitability: screening for Trees Act checks; a fresh survey is still required.
- PMC portal "List of Trees 2024": BLOCKED (CAPTCHA form).

**Parks and gardens: ACQUIRED** (198 polygons, plus CSVs).

**Water bodies census 2023: ACQUIRED** (225 points in the box). The licence is **CC-NC**.

## 6. Transport

**Road centreline: ACQUIRED**
- 25,485 lines, 3,105 km.
- No name, class, width or lane attributes. OSM stays the routable network.

**Footpaths and roads: ACQUIRED** (2016, prabhag aggregates only). Footpath geometry: NONE FOUND.

**PMPML transit**
- Stops: ACQUIRED (4,659 in the box). Depots: ACQUIRED (9). Route list: ACQUIRED (1,030 routes, no geometry).
- **Official GTFS: NONE FOUND.** The community GTFS (MIT-0) is unofficial and not used.

**Metro**
- Alignment GIS: NONE FOUND (PDF maps and DPR only). Tunnel depth: UNKNOWN.

**Traffic counts and speeds**
- Official open data: NONE FOUND. PMC "Traffic Details" is BLOCKED (CAPTCHA). Smart City ATMS: not public.
- The traffic model still FAILS TAG M3.1.

## 7. Environment

**Air quality: ACQUIRED**
- 15-minute data for 7 stations, 2024–25, with timestamps converted from UTC to IST. AQI tables for 2017–23.
- The CPCB station list gives coordinates for 8 Pune stations; 2 data stations have UNKNOWN coordinates.
- Points only.
- CPCB CCR direct download: BLOCKED (CAPTCHA). OpenAQ: BLOCKED (API key).

**Noise: NONE FOUND** among the open sources checked this session.

## 8. Social infrastructure

**Hospitals:** ACQUIRED. Government 50, private 228 and dispensaries 30, with lat/lon, plus a capacity table of 742 rows.

**Schools:** ACQUIRED (UDISE lists of about 1,250 schools; the PMC schools CSV has lat/long). **Fire stations:** ACQUIRED (14). **Libraries:** ACQUIRED (56). **Toilets:** ACQUIRED (547). **Crematoriums:** ACQUIRED (81). **STPs:** ACQUIRED (20). **WTPs:** ACQUIRED (2012 table).

**Water-supply network geometry: NONE FOUND.**

## 9. What the app can now honestly claim

**Supported now**
- Ward, zone and prabhag context.
- Bus-stop catchments.
- Tree-census screening.
- Sewer screening, using design values.
- Groundwater point context.
- Air-quality station context.
- Regional rainfall context.

**Still blocked:**
- DP/zoning checks.
- Flood-line checks.
- Geology.
- Metro conflict depths.
- Census mapping.
- Traffic validation.

These stay **UNKNOWN** until the steps in `MISSING_DATA_AND_COLLECTION_PLAN.md` are done.
