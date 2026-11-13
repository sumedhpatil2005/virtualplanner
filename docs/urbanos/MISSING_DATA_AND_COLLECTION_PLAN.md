# Missing and restricted data: how to obtain or create it responsibly (draft)

Draft written 2026-11-13 (IST) by the gov-sources agent. Inputs: `PUNE_DATA_AVAILABILITY.md` and `catalogue/india.md`.

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
| 10 | Bhuvan CartoDEM, GSI, data.gov.in API, OpenAQ | DEM cross-check, geology, AQ | **Each needs an account or key. Decision for the user/coordinator**; no account was created |

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

### 2.7 PMC portal items behind the CAPTCHA

- A person (the user, or a coordinator acting with the user's consent) fills the purpose form honestly and downloads the file.
- The file is then placed in a staging folder and ingested **unmodified**, with a manifest that records "downloaded manually via portal form on <date>".
- The CAPTCHA is not automated.

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

## 5. What the app does meanwhile

- Each missing theme stays a gap row in the dataset registry (DSI agent), with the reason (blocked / unreachable / none found) and a link to the relevant section of this plan.
- A feature that needs a missing theme shows UNKNOWN, never a default value.
- Requests sent and replies received are logged with dates in `raw/<source_id>/` as evidence. When a request is refused, the refusal itself is recorded.
