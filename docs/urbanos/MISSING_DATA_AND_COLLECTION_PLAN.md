# Missing and restricted data: how to obtain or create it responsibly

First draft 2026-11-13 (IST) by the gov-sources agent (inputs `PUNE_DATA_AVAILABILITY.md`, `catalogue/india.md`).
Reconciled 2026-11-14 00:30 IST into one plan with the remote-sensing draft that sat at the end of `catalogue/global.md`
(now §1a and §4.6 here; global.md keeps a pointer). Per-dataset status, licence and blocked features are generated from the
registry in `DATA_SOURCE_CATALOGUE.md` (`python -m datasets.catalogue_doc`); this file is the plan, not the inventory.

Contents: §1 priorities · §1a what remote sensing can and cannot substitute · §2 requests to authorities (+ §2.8 request
register) · §3 georeferencing official PDFs · §4 field protocols (+ §4.6 ML only where measurable) · §5 what the app does
meanwhile · §6 accounts and keys that need a user decision.

## Rules for everything in this plan

These rules bind every step below.

- **Nothing is fabricated.** A gap stays **UNKNOWN** in the app until real data arrives.
- **Provenance.** Every new record carries who collected it, when (ISO date with zone), by what method, at what accuracy, and its class (observed / derived / estimated).
- **Raw evidence is kept.** Scans, field sheets, video hashes and RTI replies are stored unmodified in `raw/<source_id>/<date>/` with a manifest.
- **Unverified references.** Standards and legal provisions named here were **not opened this session** and are marked *(verify)*. Never quote a clause from them until someone has read it.
- **Personal data.** Blur faces and number plates, keep no personal identifiers, and minimise collection. The Digital Personal Data Protection Act 2023 applies *(verify scope)*.

## 1. Priority list

Ranking runs from what blocks the most UrbanOS features to the least.

| # | Missing / restricted | Blocks | Best route |
|---|---|---|---|
| 1 | DP 2017 zoning, reservations and DP road widths (vector) | DP compliance, feasibility | Ask PMC for permission to use the AutoDCR GeoServer layers (§2.1); fallback is georeferencing the sanctioned DP sheets (§3) |
| 2 | Statutory red/blue flood lines (vector, with order/date) | flood screening, underground | Written request to WRD (Khadakwasla Irrigation Division), plus permission for PMC `Red_Blue` (§2.1, §2.2); fallback §3 |
| 3 | Water-supply network, metro tunnels, other utilities (depth) | underground conflicts | RTI / data requests to PMC Water Supply, MahaMetro, MNGL, MSEDCL (§2.3); then field verification (§4.3) |
| 4 | Geology 1:50K and boreholes | underground, foundations | GSI registration (user decision); site investigation (§4.4) |
| 5 | Traffic counts and speeds | traffic model validation (TAG M3.1 fail) | Field count programme (§4.1) plus requests to Pune Traffic Police / PSCDCL (§2.4) |
| 6 | Census-ward boundaries (2011) and Census 2027 results | population maps | Directorate of Census Operations Maharashtra (§2.5); Census 2027 tables once published |
| 7 | IDF curves for Pune | storm-drain design | IMD (data supply portal / request) (§2.6) |
| 8 | PMC portal items behind CAPTCHA (trees 2024, traffic details, BRT stops, prabhag coordinates) | trees, transit, traffic | **A person** downloads them through the portal form; ingest as raw with manifest (§2.7) |
| 9 | SLUSI micro-watersheds and the 2025 admin-ward GeoJSON (OpenCity) | watershed context, wards | Manual download (browser renders them inline); ingest with `opencity_pune ingest` |
| 10 | Bhuvan CartoDEM, GSI, data.gov.in API, OpenAQ | DEM cross-check, geology, AQ | **Each needs an account or key. Decision for the user/coordinator**; no account was created (§6) |
| 11 | Bare-earth DTM (LiDAR) or survey levels along drains | drain inverts, flood depths (the Copernicus DEM is a DSM) | Ask PMC Drainage / PMRDA whether a LiDAR or survey-level dataset exists (§2.1); otherwise survey on a project corridor (§4.3) |
| 12 | Building use, storeys and height | massing, population, emissions | PMC property-tax / building-permission records (request, §2.1); OSM `height` only where tagged; Microsoft heights are −1 (absent) |
| 13 | Official PCMC boundary (and the PMC limit as a polygon) | wards, land-cover statistics | PCMC / PMC GIS cells (§2.1). PMC ward polygons are acquired via OpenCity, but the land-cover zone statistics still use community-traced (inferred) datameet wards |

## 1a. What remote sensing can and cannot substitute (merged from catalogue/global.md)

**Can substitute, at screening level, with the stated accuracy:**
- **Terrain and indicative drainage.** Copernicus DEM GLO-30 (publisher spec: under 4 m LE90 absolute) is enough for slope
  classes, ridge and valley context, and catchment screening. It **cannot** give invert levels, drain capacity or flood
  depths: that needs a bare-earth DTM (LiDAR or ground survey) plus PMC storm-water drain records (priority 11).
- **Building presence and footprint extent.** OSM plus Microsoft plus Google gives near-complete roof coverage. It
  **cannot** give use, storeys, height, age, structure type or legal status (priority 12).
- **Land cover, vegetation and open water.** ESA WorldCover (ML classifier output, class *inferred*), Sentinel-2 NDVI/MNDWI
  and JRC GSW. They **cannot** give land use, zoning or ownership: the Development Plan and land records are needed (priority 1).
- **Rainfall climatology.** CHIRPS (estimate). It **cannot** give design rainfall or IDF curves: IMD gauge records are
  needed (priority 7).

**Cannot substitute — these stay UNKNOWN until collected:** underground utilities (water, sewer and storm-water levels,
power, gas, telecom); groundwater depth between the NWDP wells; geology and geotechnical properties (SoilGrids masks the
city, so even screening is absent there); traffic observations; drain network levels; building heights and storeys.

## 2. Requests to authorities

### General notes on RTI requests

- **Law.** These are requests under the Right to Information Act 2005. Section 6(1) covers the application and section 7(1) the 30-day reply *(verify)*.
- **Address.** Each request goes to the Public Information Officer (PIO) of the named public authority.
- **Fee.** Pay the fee set by the Maharashtra RTI Rules or the central rules *(verify the current amount)*.
- **Format.** Ask for **electronic copies in the native GIS format** (SHP, GDB, DWG or KML), with CRS, survey date and accuracy notes. Ask for "inspection" if copies are refused.

### 2.1 Pune Municipal Corporation (PIO, the respective department, PMC Main Building, Shivajinagar, Pune 411005)

**GIS Cell / Building Development (AutoDCR).** Ask for written permission, and the licence terms, to use these layers of the AutoDCR GeoServer (`https://iwmsgis.pmc.gov.in/geoserver/AutoDCR`) in a non-commercial planning tool:
- `PMC_DP`, `PLU_Ward`, `PMC_Reservation`, `DP_Ward_Road`
- `Red_Blue`, `Aviation_data`, `TOD_Zones`, `TDR_Zones`, `Monuments`, `Revenue_1`

For each layer, also ask:
1. The source document and sanctioning order (Government Resolution / notification number and date).
2. The CRS and scale of digitisation.
3. The last-update date.
4. Whether the layer is the sanctioned DP 2017, including later modifications.

**Drainage Department.** For the sewer and storm-water layers published through OpenCity, ask:
1. Are `start_inve`, `end_invert` and `tl_*` surveyed as-built levels, or values from the sewerage master-plan model?
2. What is the datum of these levels (MSL / GTS)?
3. When was the survey done, and by what method?
4. The meaning of `category` = `Road_Sewer` inside the "storm water drains" file.
5. A separate storm-water-only network.

**Water Supply Department.** Ask for the transmission and distribution mains (GIS), with diameter, material, year and depth where recorded.

**Road Department / Traffic Planning Cell.**
- Classified traffic counts and junction surveys since 2015, with location, date and method.
- The PMC portal item "PMC Traffic Details" (id 431).
- The ATMS signal-timing plans.

**Garden (Tree Authority).** Ask for the tree census update (2024 list, id 286), with method and date.

### 2.2 Water Resources Department, Govt of Maharashtra (PIO, Khadakwasla Irrigation Division / Pune Irrigation Circle)

Ask for:
- The blue and red flood lines for the Mula, Mutha, Mula-Mutha, Ram Nadi, Pawana and Indrayani within the Pune Municipal Corporation, PCMC and PMRDA limits, as **digital vectors** with CRS, the design discharges, the approving order and date, and the revision status (NGT/HC directions, MERI 2025 reassessment).
- If vectors do not exist, certified copies of the sheets, with sheet index and scale.

### 2.3 Utilities

**MahaMetro (PIO, Maharashtra Metro Rail Corporation Ltd, Pune).** Ask for:
- As-built alignment (horizontal and vertical) of the underground sections of Line 1 (Range Hill → Swargate) and Line 1B (Swargate → Katraj).
- Tunnel crown and invert levels.
- The station box footprints and protection-zone widths used for NOCs.
- Machine-readable formats.

Ask PMRDA / the Line 3 concessionaire for the same information on Line 3.

**MNGL (city gas), MSEDCL (HT/LT cables), BSNL and other telecom licensees.** Ask for network maps within the study area, with depth where recorded, to be used for conflict screening. Expect refusals on security grounds; record each refusal as the result.

### 2.4 Pune City Traffic Police and PSCDCL

Ask for:
- Junction-level classified counts.
- ATCC/ANPR aggregate volumes (no plate data).
- Corridor travel times from ATMS/ICCC.
- For each item: method, period and equipment.

### 2.5 Directorate of Census Operations, Maharashtra (Mumbai)

- Census 2011 ward boundaries for Pune M.Corp. (and PCMC) matching the PCA ward codes.
- Release schedule for Census 2027 ward-level tables.

### 2.6 IMD (Pune / data supply portal)

- Short-duration rainfall (hourly or self-recording gauge) for the Pune stations: Shivajinagar, Lohegaon, Pashan.
- Any published intensity-duration-frequency curves.
- The terms of supply.
- Ask for an explanation of the 2005 and 2009 outliers in the 0.25° grid at 74.0E 18.5N.

### 2.7 PMC portal items behind the CAPTCHA (and other browser-only sources)

- A person (the user, or a coordinator acting with the user's consent) fills the purpose form honestly and downloads the file.
- The file is then placed in a staging folder and ingested **unmodified**, with a manifest that records "downloaded manually via portal form on <date>".
- The CAPTCHA is not automated.
- The same applies to OpenCity (data.opencity.in): it serves a Cloudflare challenge to scripted clients (seen again by the
  update monitor, 2026-11-14 00:0x IST: HTTP 403). Downloads and update checks for OpenCity layers are done by a person in
  a browser; the challenge is never bypassed.

### 2.8 Request register (one line per request; update when sent / answered)

No request below has been recorded as sent: there is no RTI or reply evidence under `raw/` (checked 2026-11-14 IST).
Status therefore reads **not sent**. When one is sent, store the application and every reply unmodified in
`raw/rti_<authority>/<date>/` with a manifest, and change the status here.

| # | Authority (PIO / office) | Ask (section) | Route | Unblocks (priority) | Status |
|---|---|---|---|---|---|
| R1 | PMC — GIS Cell / Building Development (AutoDCR) | **Written permission and licence terms** for `PMC_DP`, `PLU_Ward`, `PMC_Reservation`, `DP_Ward_Road`, `Red_Blue`, `Aviation_data`, `TOD_Zones`, `TDR_Zones`, `Monuments`, `Revenue_1` on `https://iwmsgis.pmc.gov.in/geoserver/AutoDCR` (§2.1). The service answers without login and its capabilities say "AccessConstraints NONE", but no licence is published, so only capabilities were probed | permission letter (+ RTI for the sanctioning orders) | 1, 2 | not sent |
| R2 | PMC — Drainage Department | Meaning, datum and survey method of sewer/storm-water levels; storm-water-only network; any LiDAR / survey levels (§2.1) | RTI | 3, 11 | not sent |
| R3 | PMC — Water Supply Department | Transmission and distribution mains with diameter, material, year, depth (§2.1) | RTI | 3 | not sent |
| R4 | PMC — Road Department / Traffic Planning Cell | Classified counts since 2015, portal item 431, ATMS signal plans (§2.1) | RTI | 5 | not sent |
| R5 | PMC — Garden Department (Tree Authority) | Tree census 2024 update, method and date (§2.1) | RTI or portal form (§2.7) | 8 | not sent |
| R6 | PMC — Property Tax / Building Permission | Building use, storeys, height per property (aggregated, no personal data) (§2.1) | RTI | 12 | not sent |
| R7 | WRD Maharashtra — Khadakwasla Irrigation Division | Blue/red flood lines as vectors with orders and revision status (§2.2) | RTI | 2 | not sent |
| R8 | MahaMetro (Pune) and PMRDA / Line 3 concessionaire | As-built underground alignment, crown/invert levels, protection zones (§2.3) | RTI | 3 | not sent |
| R9 | MNGL, MSEDCL, BSNL / telecom licensees | Network maps with depth for conflict screening (§2.3) | data request (refusal recorded as the result) | 3 | not sent |
| R10 | Pune City Traffic Police; PSCDCL | Junction counts, ATCC/ANPR aggregates, ICCC travel times (§2.4) | RTI / data request | 5 | not sent |
| R11 | Directorate of Census Operations, Maharashtra | Census 2011 ward boundaries matching PCA codes; Census 2027 schedule (§2.5) | RTI / request | 6 | not sent |
| R12 | IMD Pune (data supply portal) | Short-duration rainfall, IDF curves, terms; 2005/2009 grid outliers (§2.6) | data supply request (may carry a fee — UNKNOWN) | 7 | not sent |
| R13 | PCMC GIS cell | Official PCMC boundary and ward polygons with CRS and date | RTI / request | 13 | not sent |

## 3. Georeferencing official PDFs (DP sheets, flood-line sheets, metro alignment maps)

This is a fallback only, used when the vector is refused or does not exist.

1. **Source.** Use only official sheets: PMC/PCMC/PMRDA DP sheets and WRD flood-line sheets. Store the PDF unmodified in raw, with its sha256 and the order / date printed on it.
2. **Control points.**
   - Use at least 8 well-spread GCPs per sheet. Use sheet grid ticks and printed coordinates first; survey monuments or clear permanent features second.
   - Take GCP coordinates from an independent reference: DGPS field points, or the Survey of India grid. **Never** take them from the layer being checked.
   - OSM or imagery-derived GCPs may be used only if labelled as such, and they lower the result to visualisation.
3. **Transform.** Use the lowest order that meets the residual target: affine, then 1st-order polynomial, then thin-plate spline only with justification. Report the per-GCP residuals, the RMSE in metres and the transform parameters.
4. **Validation.** Hold out at least 3 checkpoints. If checkpoint RMSE is above the sheet's graphical accuracy (about 0.5 mm × scale denominator *(rule of thumb, not a standard)*), mark the result "visualisation only".
5. **Digitising.** Digitise only lines printed on the sheet. Never complete or extrapolate gaps; leave them UNKNOWN. Two people digitise independently and differences above tolerance are reviewed.
6. **Labelling.** Class **derived** ("georeferenced and digitised from <sheet id>, <order/date>"). Suitability **screening**, never engineering or statutory. Every finding cites the sheet.

## 4. Field data collection

### 4.1 Traffic counts and speeds (for TAG M3.1 validation)

**Design**
- Choose count sites from the model's validation needs: screenlines (river crossings), cordons and key junctions.
- Count sites used for calibration are not reused for validation.

**Method**
- Video-based classified turning-movement counts at junctions and link counts on screenlines, in 15-minute bins.
- Vehicle classes: two-wheeler, three-wheeler (auto), car/taxi, LCV, bus (PMPML / private), truck (2-axle / multi-axle), bicycle, pedestrian.
- PCU conversion only with a cited source, such as Indo-HCM 2017 or IRC:106-1990 *(verify)*. Keep the raw class counts.

**Timing**
- Representative weekdays (Tue–Thu), outside holidays, exam days, festivals and heavy-rain days. Record the weather.
- Cover at least the AM and PM peaks plus one off-peak period. A 16-hour day at a subset of sites gives profiles.

**Quality assurance**
- A second person re-counts 10 % of intervals, and the discrepancy is reported.
- Camera position, field of view and occlusions are logged.
- Video hashes are stored. Faces and plates are blurred before any sharing.

**Speeds**
- Floating-car runs: at least 6 runs per direction per period, with GPS at 1 Hz.
- Or an anonymised aggregate from a provider whose licence allows it.
- Report the mean, the spread and the sample size.

**Records:** `observed`, with collector, date, method and site photos. A validation pass/fail is computed only from these records.

### 4.2 Trees (update of the 2019 census for a project site)

- Do a site walk-over before any design decision: species, girth at 1.37 m *(verify the measurement height used by the Tree Authority)*, condition, and a photo for each tree.
- Do the stake-out with GNSS, recording the accuracy.
- Match against the census id. Trees not found are marked "not found on <date>", **never deleted**.

### 4.3 Utilities on a project corridor

**Desk:** layers from §2.3.

**Field**
- A GPR / EM locator survey, with the survey quality level declared.
- Trial pits at conflict points, to confirm depth.
- Manhole lifting to measure inverts against the PMC design values.

**Records:** observed, per pit or chamber, with photographs and a datum-tied level.

### 4.4 Geotechnical (boreholes)

- Commission a site investigation through a licensed agency, following the relevant BIS code on subsurface investigation for foundations (IS 1892 *(verify edition)*).
- Logs are delivered in AGS4/CSV for the app's importer.
- Interpretation of Deccan basalt flows (weathered zones, vesicular/amygdaloidal, red bole) is done by the geotechnical engineer, not by the app.

### 4.5 Sensors (air and noise) — optional, project scale

**Air**
- Low-cost PM sensors are "indicative".
- Collocate them for at least 2 weeks with a CAAQMS station (for example Karve Road MPCB, site_292) and publish the calibration.
- Never present them as regulatory values.

**Noise**
- Class 1 sound level meters to IEC 61672-1 *(verify)*. Report LAeq per period against the zone limits of the Noise Pollution (Regulation and Control) Rules 2000.
- These are measured values only. CNOSSOS estimates must stay labelled "estimate".

### 4.6 Machine learning only where it can be measured (merged from catalogue/global.md)

1. **Footprint datasets vs ground truth.** Draw a stratified random sample of about 400 one-hectare cells from
   `coverage_grid_1km` (buildings pipeline output), stratified by OSM completeness ratio and density. Label building
   outlines manually against recent imagery that is licensed for tracing. Report precision, recall and IoU for each of OSM,
   Microsoft and Google, with confidence intervals; only then choose a gap-fill threshold. The current IoU tables measure
   agreement between datasets, not accuracy.
2. **Built-up change.** Do not use the NDBI rule (F1 0.46 against WorldCover 2021, catalogue/global.md §3). If change
   detection is needed, train or evaluate on manually labelled change / no-change samples from Sentinel-2 composites and
   report F1; otherwise show WorldCover (or GHSL) snapshots only.
3. **Soil and terrain-derived proxies.** No ML until borehole or SPT records exist to validate against (§4.4).
4. **Classes.** Any ML output (footprints, land-cover labels, a fitted model) is registered as **inferred**, never observed
   or derived (registry overrides `correct_stated_class`, 2026-11-13: Microsoft/Google footprints, ESA WorldCover).

## 5. What the app does meanwhile

- Each missing theme stays a gap row in the dataset registry (DSI agent), with the reason (blocked / unreachable / none found) and a link to the relevant section of this plan.
- A feature that needs a missing theme shows UNKNOWN, never a default value.
- Requests sent and replies received are logged with dates in `raw/<source_id>/` as evidence. When a request is refused, the refusal itself is recorded.
- Sources that are acquired are watched by `python -m datasets.update_monitor` (metadata probes only; robots.txt and crawl
  delays honoured). A newer upstream is shown as "update available" in the Data catalogue; it is never downloaded or
  activated automatically.

## 6. Accounts, keys and registrations that need a user decision

Per the binding brief, no account was created and no key requested. Each line is a decision for the user/coordinator.
Sources are the catalogue entries named; quoted conditions are as recorded there (EXCERPT where marked).

| Account / key | Unlocks | Recorded in | Status |
|---|---|---|---|
| Bhuvan (NRSC) login | NOEDA downloads, e.g. CartoDEM 1″ (capped at 10 tiles/day per the help page, EXCERPT) | catalogue/india.md §4 | not registered |
| GSI Bhukosh / NGDR login | 1:50K geology download ("To download data Login required", EXCERPT); site timed out from the sandbox | catalogue/india.md §5 | not registered; geology UNKNOWN |
| data.gov.in API key | OGD India API | catalogue/india.md §10 | not requested |
| OpenAQ API key | AQ API v3 | catalogue/india.md §8 | not requested |
| JAXA registration | ALOS AW3D30 DSM | catalogue/global.md §8 | not registered |
| NASA Earthdata login | NASADEM via LP DAAC (the Planetary Computer mirror was used instead) | catalogue/global.md §8 | not registered |
| Google Earth Engine account | Dynamic World land cover | catalogue/global.md §2, §8 | not registered |
| Copernicus Data Space account | Sentinel-1/2, DEM (AWS / Earth Search mirrors used instead) | catalogue/global.md §3, §8 | not registered |
| Copernicus CDS API key | ERA5 | catalogue/global.md §7, §8 | not requested |
| Planetary Computer SAS token (whether it needs an account: UNKNOWN; terms UNKNOWN) | update checks on the NASADEM blob (anonymous HEAD refused: HTTP 409 "Public access is not permitted", 2026-11-14 IST) | update_targets.json | not requested; NASADEM is a fixed 2000 product |

Browser-only (no account, but a person must do it): PMC portal items behind the CAPTCHA (§2.7), CPCB CCR downloads
(CAPTCHA, PUNE_DATA_AVAILABILITY §7), OpenCity layers (Cloudflare challenge).
