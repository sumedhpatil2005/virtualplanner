# Traffic Data Manager

Mission §5 (Traffic Data Manager), §19 traffic data tests, §22.6/22.7. Branch `urban-mobility-platform`, 2026-11-11.
Labels: **BROWSER-VERIFIED**, **UNIT-TESTED** (pytest / vitest), **UNTESTED**. All data used in tests and browser checks is **SYNTHETIC** and labelled so (`synthetic: true` on the dataset, "SYNTHETIC" in names/provider); none of it is an observation.

## 1. What it is

Users enter, import and manage traffic counts they already hold (surveys, ATCC, video counts, studies). Every dataset carries its provenance. Counts are **evidence at a place**: they are compared with the model after a run and are made available, as typed constraints, to a future matrix estimator (ODME). They never overwrite or become demand.

| Quantity | Meaning | Where in the app |
|---|---|---|
| Traffic demand | trips that want to travel (OD matrix) | `AreaDemand` / `StudyDemand` plan (unchanged by this module) |
| Observed count | vehicles counted passing a point in a period | Traffic data datasets (this module) |
| Network throughput | vehicles that got through the simulated network | micro-simulation `linkVph` |

The comparison table shows all three side by side (count, routed = assigned demand on that road-direction, simulated = got through) and never substitutes one for another.

## 2. Data model (backend, additive tables)

`backend/traffic_data/models.py`; created by `Base.metadata.create_all` next to the existing tables, which are not touched. Verified on a copy of the real `twincity.db` (20,732 objects, 1,324 areas, 1 scenario before and after; five `td_*` tables added and seeded) — **UNIT-TESTED** by start-up on the copy, not a migration framework.

| Table | Purpose |
|---|---|
| `td_datasets` | provenance: name, provider (source), kind `measured`/`estimated`/`manual`, method, collected_from/to, location, period represented, vehicle classification, assumptions, adjustments, PCU factor set (exact version id), role `validation`/`calibration`/`unused`, entered_by, created/updated, imported file name + SHA-256 + import report (rejected rows), `synthetic` flag |
| `td_count_records` | `ref_kind` `road_direction` (road_id = stable city-object id + direction `fwd`/`bwd`/`both` relative to the drawn direction, + free direction label), `junction_approach` (junction_ref + approach_road_id), `turn` (junction_ref, from_road_id, to_road_id, turn); day_type `weekday`/`saturday`/`sunday`/`holiday`/`weekend`/`all_days`; date; period start/end (any length within a day); vehicles per class (JSON) and/or total; notes, quality flag, source row |
| `td_vehicle_classes` | extensible; seeded two_wheeler, car, auto_rickshaw, bus, lcv, hcv, other |
| `td_pcu_factor_sets` | versioned `(set_key, version)`; a version row is never updated; an edit = new version with a required change note; datasets point at the version they used |
| `td_audit_log` | every create / update / delete / import of datasets, records, classes, PCU sets with actor, time and before/after JSON |

Junction references (`junction_ref`) are free strings (e.g. the engine's logical junction id `ljunction:…`) and are not checked against the network; road references **are** checked against `city_objects` (drivable types).

Hourly profile: records are grouped per location × day type × date × clock hour. An hour gets a flow only when its records tile all 60 minutes without overlap (e.g. 4 × 15 min); a partly counted hour is reported as incomplete with the minutes counted and **no** veh/h (no extrapolation). A record longer than one hour is reported as one span with its mean rate, not spread over hours. Weekday/weekend profiles are the same rows filtered by day type.

## 3. PCU

Seeded sets, all citing IRC:106-1990 *Guidelines for Capacity of Urban Roads in Plain Areas*, Indian Roads Congress, 1990, clause 7, Table 1 (scanned text opened 2026-11-11, https://archive.org/stream/gov.in.irc.106.1990/irc.gov.in.106.1990_djvu.txt). Values re-read from that text: two-wheeler 0.5 / 0.75; car, pick-up van 1.0 / 1.0; auto-rickshaw 1.2 / 2.0; LCV 1.4 / 2.0; truck or bus 2.2 / 3.7 (5% composition / 10% and above). Clause 2.1: the guidelines apply to mid-block sections; these are not stop-line factors.

| set_key | factors |
|---|---|
| `irc106-1990-t1-5pct` | 5% column for every class |
| `irc106-1990-t1-10pct` | 10%+ column for every class |
| `irc106-1990-t1-app-mix` | column per class by the simulator's assumed mix (TrafficMicroSim `VEHICLE_TYPES`: 2W 52%, car 31%, auto 11% → 10%+; bus 3.5%, truck 2.1% → 5%); LCV share unknown, assumed < 10% (1.4). This reproduces the PCU values the simulator already uses. The mix is an estimate. |

`bus` and `hcv` both take "Truck or Bus". IRC gives no factor for `other`: conversion of a count with `other` vehicles is **refused** (reported, never guessed) until a user adds a factor in a new version with a source. Unclassified totals have no PCU. Every PCU/h value is shown with the set name and version. Dynamic / stop-line PCUs (Indo-HCM 2017, Patel & Dhamaniya 2021) are not seeded: the sources were not opened first-hand (research doc A4).

## 4. Validation use (counts vs model)

- Datasets with role **Validation** feed the table "Your traffic data (validation datasets)" in Simulate → Details → *Checks against traffic counts* (`components/TrafficCountChecks.tsx`, logic `engine/data/countValidation.ts`, GEH from `engine/calibration/geh.ts`).
- Per count: observed veh/h, routed (area assignment `areaLinkVph`, busiest piece of that road in that direction), GEH, simulated (corridor micro-sim `linkVph`, only where the road is in the simulated corridor; otherwise "–", not 0), GEH; summary share with GEH < 5 against the TAG M3.1 85% target, "too few counts to judge" under 5 counts; CSV export.
- Only complete clock-hour counts at the run's hour and day type weekday/all_days are compared (the diurnal profile is a weekday profile). Everything else is listed under "not compared" with the reason. Junction-approach and turning counts are **not compared yet** (needs matching to junction movements, `calibration/junctionMovements.ts`).
- Data choice: "Measured + manual", "Estimated", or "All (kept apart)". With All, measured and estimated rows of the same road appear as separate rows with their badges; nothing is averaged. The API needs an explicit `kinds=` list to return estimated data at all.
- Nothing is fitted to these counts.

## 5. ODME interface (not implemented)

`engine/data/odmeConstraints.ts`: `countsToConstraints(rows, edgeIds, {hour, dayTypes, unit, allowEstimated})` → `LinkCountConstraint` / `TurnCountConstraint` with dataset id and kind; only role **Calibration** datasets become constraints; Validation datasets are returned as `heldOutDatasetIds` and must be refused by an estimator (TAG M3.1 §3.3.8); estimated data only with `allowEstimated`; PCU/h only where convertible. `OdmeEstimator.estimate({prior, constraints, limits, heldOutDatasetIds})` must return the fit per constraint and TAG M3.1 Table 5 change statistics with pass/fail (`TAG_M31_TABLE5`), never hiding a breach. **UNIT-TESTED** (mapping only).

## 6. API (`/api/traffic-data`)

`GET/POST /vehicle-classes`; `GET /pcu-sets`, `POST /pcu-sets`, `POST /pcu-sets/{set_key}/versions` (no PUT/DELETE); `POST /pcu/convert`; `GET/POST /datasets`, `GET/PATCH/DELETE /datasets/{id}` (PATCH needs `edited_by`, DELETE needs `deleted_by`; both audited, delete keeps the records in the audit `before`); `GET /datasets/{id}/audit`; `POST /datasets/{id}/records` (all-or-nothing, every problem returned per record); `PUT/DELETE /records/{id}`; `GET /datasets/{id}/hourly?road_id=`; `GET /counts?role=&kinds=&day_type=` (engine read, one row per dataset × location × hour); `POST /import/preview`, `POST /import/commit`; `GET /audit`.

Import: JSON body with the file as base64 (avoids a multipart dependency). `.csv` (UTF-8) and `.xlsx` (openpyxl, added to requirements.txt); `.xls` refused with a message. Preview reads the file, suggests a column mapping from header names (exact synonyms only; the user confirms/edits), applies optional per-file defaults (count type, day type) and validates every row; errors carry the file row number (header = row 1). Commit refuses a file with invalid rows unless `skip_invalid`, and then stores every rejected row with its errors in the dataset's import report. Values are never coerced: 120.0 from Excel is 120, 120.5 is an error; a total that disagrees with the class sum is an error, not corrected. Limits: 5 MB, 50,000 rows.

## 7. UI

"Traffic data" pill under the scenario selector opens a View-mode side panel (`components/TrafficDataPanel.tsx`): Datasets (provenance badges Measured / Estimated / Manual + Synthetic, role switch Validation / Calibration / Not used, details incl. PCU set and rejected import rows, delete); Enter (new or existing dataset with provenance form, road picked on the map, direction labelled by compass from the drawn direction, day type, period, counts per class → live veh/h and PCU/h with the factor-set name); Import (file → mapping table → per-row errors → provenance → import, with the explicit "valid rows only" choice); By road (hourly table per dataset with veh/h, PCU/h, incomplete hours marked). Who made a change is a free-text name (no authentication exists in the app).

## 8. Tests

- `backend/tests/test_traffic_data.py` (18 tests, **UNIT-TESTED**): seeded/extensible classes; IRC Table 1 both columns; PCU conversion with a named set; refusal on a missing factor; set versioning (old version unchanged, change note required, no PUT); manual entry with veh/h + PCU/h, directional fwd/bwd; invalid records all-or-nothing (unknown road, bad direction, negative, fractional, reversed period, empty, total mismatch, unknown class); turning + approach counts; hourly profile (15-min tiling, incomplete hour not extrapolated, Sunday separate); long period as span; measured vs estimated not merged; provenance required + audited edits; CSV preview mapping + per-row errors with file row numbers; commit refuse/skip with rejected rows kept; XLSX with times, dates, defaults, fractional cell rejected, unreadable file, .xls refused; bad mapping; audited delete.
- `frontend/src/engine/testing/TrafficData.test.ts` (11 tests, **UNIT-TESTED**): PCU, refusal, rates, compass labels; road-direction flow lookup (no id-prefix confusion, missing direction = null not 0); observed/routed/simulated/GEH at run hour; measured/estimated kept apart; skip reasons; ODME constraint mapping (calibration only, validation held out, estimated opt-in, pcu/h, turns, Table 5 limits).
- Browser: see §9.

## 9. Browser verification (2026-11-11, headless Chromium + SwiftShader, backend on a copy of twincity.db)

Script: `/workspace/work/um-data-run/e2e.py` (scratch, not committed). All data SYNTHETIC. Road: `osm_22841323` (Shivaji Bridge). The road was "picked" by setting the engine selection, which is what a map click does; the Cesium pick itself was not driven headless.

| Step | Result | Label |
|---|---|---|
| Manual entry, new Manual dataset, direction "Against (towards S)", 09:00–09:15, 2W 210 / car 100 / auto 30 / bus 5 / other 0 | live and saved: 1,380 veh/h, 1,314 PCU/h, "PCU by IRC:106-1990 Table 1, column per class by the app's default mix (v1)" (hand check: 345 × 4; (157.5+100+60+11) × 4) | BROWSER-VERIFIED |
| Car "12.5" | rejected before saving ("Not whole numbers") | BROWSER-VERIFIED |
| Import of a 5-row SYNTHETIC CSV (2 bad rows) | mapping suggested from headers; "3 valid · 2 with problems"; Row 5 bad direction, Row 6 unknown road; Import button disabled until "Import only the 3 valid rows" ticked; dataset shows MEASURED + SYNTHETIC badges, file SHA-256 and both rejected rows | BROWSER-VERIFIED |
| By road | 09:00 towards N 1,510 veh/h / 1,441 PCU/h; towards S 1,334; 10:00 towards N 1,428; the manual 15-min record shown as "15 min" with no veh/h | BROWSER-VERIFIED |
| Simulate Shivaji Bridge, 09:00 weekday, 2 km (run 137 s, status ready) → Details → Checks against traffic counts | Observed / Routed / GEH / Simulated / GEH: bwd 1,334 / 552 / 25.5 / 221 / 39.9; fwd 1,510 / 1,878 / 8.9 / 1,781 / 6.7; "2 counts not compared" (10:00 count; 15-min manual record) | BROWSER-VERIFIED |
| "All (kept apart)" with an extra SYNTHETIC Estimated dataset (fwd 09:00, total 1,700) on the same road-direction | three rows: measured fwd 1,510 and estimated fwd 1,700 listed separately with their badges (GEH 8.9 vs 4.2 routed), not averaged; "Measured + manual" view shows only the two measured rows | BROWSER-VERIFIED |
| Re-run in a fresh page | identical routed/simulated values (552, 221, 1,878, 1,781): deterministic for the same network, hour and seeds | BROWSER-VERIFIED |

Note: the imported test dataset was created without ticking "Synthetic" (its name and provider say SYNTHETIC); the badge therefore shows only MEASURED for it. Screens: `/workspace/work/um-data-run/shots/` (scratch).

The GEH values above compare the model with **made-up** counts; they say nothing about model accuracy.

## 10. Not done / limits

- No ODME estimator (interface only). No calibration use of counts in the existing IPF calibration (that still reads the curated junction-count files).
- Junction-approach and turning counts are stored, validated, shown per road, and mapped to ODME constraints, but not compared with the model.
- Counts are not shown on the 3D map (no layer).
- No authentication: `entered_by` is what the user types.
- A dataset role change does not re-run anything; the comparison table re-reads counts when opened.
- Observed-vs-simulated is not yet in the exported HTML/CSV scenario report (`engine/report/scenarioReport.ts`); it has its own CSV button.
