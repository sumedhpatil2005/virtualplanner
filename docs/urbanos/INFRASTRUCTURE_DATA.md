# Infrastructure data in Explore and coordination; registry classification

Branch `urbanos-city-planning-redesign`, worktree `uos-wt-infra` (from 3b8b1e1). Date: Fri 2026-11-13 (IST, UTC+05:30).
Labels: **UNIT-TESTED** (pytest / vitest), **HEADLESS-RUN** (CLI against the real data on disk), **BROWSER-VERIFIED**
(1440×900 headless Chromium, screenshots under `/workspace/work/urbanos/shots/p2/infra-*.png`), **UNTESTED**.
All fixtures in tests are SYNTHETIC. Nothing here is an engineering assessment.

Data root: the code reads `URBANOS_DATA_DIR` (canonical), then `URBANOS_DATA_ROOT` (pipelines' name), then the registry default
`backend/data/urbanos`. Runs on this sandbox use `URBANOS_DATA_DIR=/workspace/work/urbanos-data`.

## 1. Registry classification (no "classification fail" for acquired data)

- `backend/datasets/classification_overrides.json` (committed) gives every acquisition directory that existed on 2026-11-13
  (19 raw sources, 37 derived datasets + the two added here; 58 entries) a **theme, data class, suitability and reason**,
  taken from each directory's own manifest / processing.json notes. Raw files and manifests are never edited.
- `python -m datasets.importer` applies it **fill-only**: a class / suitability / theme a manifest states always wins
  (e.g. the Microsoft / Google raw manifests say `derived (ML detections…)` → kept). `engineering` is never accepted from
  the file (recorded as screening). New registrations carry the reason in the version notes; an **already-registered**
  version whose class/suitability is NULL is filled once (the registry's fill-once rule) and the reason is recorded as the
  latest `classification` quality check (versions are otherwise immutable). Theme is corrected only where the importer had
  guessed it. Re-running is idempotent. New theme: `land_parcels` (revenue / cadastral parcels).
- HEADLESS-RUN on a fresh DB with the real data root: 56 directories registered, **0 classification checks failing**.
  UNIT-TESTED: new + already-registered versions, engineering refused, idempotent, committed file well-formed.
- A directory created after 2026-11-13 without a stated class stays unclassified (honest) until an entry is added.

## 2. Spatial index (`python -m datasets.pipelines.infra_index`)

`<data>/derived/infra_index/v1/infra_index.sqlite` (+ processing.json with inputs' sha256, rules, per-layer counts):
one table `f_<layer>` (WGS84 WKB + JSON attributes) and one SQLite **R*Tree** `r_<layer>` per layer, plus `layers` (title,
publisher, via, licence as stated + UrbanOS note, CKAN last-modified, retrieved, class, suitability, active flag). Built
from the derived outputs named in each source's processing.json (sha256 verified), never from raw files. ~818 MB; full
build ≈ 2.5 min (buildings 1,665,214 footprints read from the 622 MB FlatGeobuf in 150k chunks, reprojected 32643→4326).

| Layer | Features | Notes |
|---|---|---|
| sewer | 44,482 | depth computed only where cover and invert levels are published: 44,482 with invert depth, 44,077 with a top-of-pipe depth (the rest: diameter > invert depth) — DESIGN levels, **unverified** |
| storm_drains | 9,187 | only rows labelled `Storm water drains`; rule below |
| swd_chambers / swd_utility_chambers | 22,771 / 4,233 | points as published |
| nallas / rivers / water_bodies (census 2023) | 3,075 / 12 / 225 | rivers are not flood lines; water-body census licence "Creative Commons Non-Commercial (Any)" |
| road_centreline (PMC) | 25,485 | no width / RoW |
| wards_2025 (active) / 2022 / 2017 / 2012 (versions) | 41 / 58 / 41 / 76 | older versions kept, flagged `version` in Explore |
| admin_wards_2017 / prabhag / zones | 15 / 72 / 5 | |
| revenue_parcels | 29,140 | not a legal cadastral record |
| bus_stops / bus_depots | 4,659 / 9 | PMPML |
| fire_stations, public_toilets, parks, libraries, crematoriums, stps | 14, 547, 198, 56, 81, 20 | STPs include PROPOSED plants |
| buildings | 1,665,214 | OSM 288,482 (observed, volunteer-mapped); Google 1,128,393 and Microsoft 248,339 (inferred, ML); status osm / agrees_with_osm / ml_only_candidate |

**Storm-water de-duplication rule.** The OpenCity "PMC Stormwater Drains" file has 141,341 lines. Only 9,187 have
`category = "Storm water drains"`. 128,927 rows have a sewer category (`Road_Sewer` 122,737, `Nalla_Sewer` 4,908,
`River_Sewer` 1,282) and carry sewer attributes (`pipeline_i` KN-CO-…, `drainaige_` Collection/Trunk sewer); 44,619 of their
ids also occur in the sewer file. They are dropped from the storm-drain layer and **not** merged into the sewer layer (the
sewer layer is the PMC sewer file as published; the extra ~84k sewer-like rows are a recorded discrepancy, not data we
can verify). 3,227 rows with category `Nalla` are dropped (the separate nalla layer carries nallas). Counts are in
processing.json → `validation.layers.storm_drains.dropped`. Storm drains publish no levels or sizes.

**Buildings.** Heights: none of the three sources gives a usable height here (Microsoft −1, Google v3 polygons none); a
height is set only from an OSM `height` tag in metres (706 footprints; 4,262 have a height or `building:levels` tag;
levels are shown as tagged, never converted). Everything else: height **UNKNOWN**. Confidence: Google only.

Licences (per layer, shown in the inspector): OpenCity/PMC — CKAN field as quoted ("Other (Public Domain)"), OpenCity FAQ
(ODbL, credit OpenCity) and site terms ("non-commercial and / or personal use only") conflict → UrbanOS treats reuse as
**non-commercial**, credit OpenCity + PMC (catalogue/india.md). Buildings — OSM ODbL 1.0; Microsoft CDLA Permissive 2.0;
Google CC BY 4.0 or ODbL 1.0.

## 3. API `/api/infra` (backend/api/infra_router.py, datasets/infra_store.py)

| Endpoint | Behaviour |
|---|---|
| `GET /layers` | index status, groups → layers with provenance, feature cap (2,000; max 5,000), census summary, traffic-count statement |
| `GET /layers/{id}/features?bbox=&limit=` | R*Tree bbox + exact intersect, capped; `total_in_bbox`, `returned`, `not_shown`, message "N shown; M more in this view not shown". Dense layers (buildings, sewer, revenue, road centreline, chambers) refuse views > 0.0625 deg² ("zoom in") |
| `GET /census2011` | Census 2011 table (not mappable) |
| `GET /traffic-counts` | "none from official sources" statement + restricted source |
| `GET /docs/collection-plan` | MISSING_DATA_AND_COLLECTION_PLAN.md as text (link target in the UI) |

Timing (HEADLESS-RUN): 1 km² of buildings 1.3 s (10,450 candidates, 2,000 sent); 2×2 km sewer 0.9 s; wards 0.04 s.

## 4. Explore

Layer tree → groups **"Municipal infrastructure (PMC via OpenCity)"** (Drainage & sewer, Water, Roads & transport,
Boundaries, Facilities) and **"Buildings (OSM + Microsoft + Google)"**; each toggle loads the camera view's features,
reloads when the camera stops, and shows "N in view" or "N shown · M more in view not shown (cap) — zoom in". Click a
drawn feature → **Map feature** inspector: layer, source, source date (UNKNOWN when not published), retrieved, licence
(non-commercial flagged), class, suitability, then attributes (sewer: depth to invert "DESIGN levels, unverified",
diameter, QL-D; building: confidence, OSM agreement, height UNKNOWN unless tagged). Population (historical): the Census
2011 table is **listed, not drawn** (below). Entity ids `muni:<layer>:<fid>` are ignored by the engine's object picker.

## 5. Population — Census 2011

`python -m datasets.pipelines.census2011_wards` → `derived/census2011_pune_wards/2026-11-13/` (observed, screening,
historical). 145 rows / 144 census-ward numbers (number 1 appears under both Sangamwadi (Yerawada) and Yewalewadi, as
published), 15 ward offices, 3,132,143 people; the publisher's 14 office subtotals all equal the sum of their wards.
**Not mappable**: no 2011 census-ward boundary file exists in the acquisitions; current polygons use other units
(electoral 2012/2017/2022/2025, prabhag, admin wards 2017); office names resemble 2017 admin wards but boundaries were
redrawn — a name match is not a geography match. `population.exposure` stays unwired (only SYNTHETIC zones).

## 6. Traffic counts

No official, openly published traffic counts for Pune were found (PUNE_DATA_AVAILABILITY.md); **none are invented**.
Registered: source `pmc_opendata_portal` and dataset `pmc_portal_traffic_details` (portal dataset 431 "PMC Traffic Details",
xlsx, **RESTRICTED**: purpose form with CAPTCHA, not accessed; contents UNKNOWN). The UI shows "Traffic counts: none from
official sources — collection plan" in Simulate (context panel → Data) and Projects → Data, linking to the plan.
The traffic model still FAILS TAG M3.1.

## 7. Registry features (appended; `wired` set only for these)

`explore.municipal_layers`, `coordination.building_conflicts`, `coordination.municipal_utility_conflicts`,
`population.census_2011_table` — all `wired=true`, status capped at partial with reasons. Existing rows are untouched
(seeds never overwrite).

## 8. Gaps / not done

- Sewer levels are design values; no survey (QL-B/A) exists. Storm drains: no depth/size. Network completeness UNKNOWN.
- Building foundation depths do not exist in any source; heights mostly UNKNOWN.
- The Underground UI (owned elsewhere) maps every conflict `b_type`; findings of the new `building` type need a label there
  (the shared TS union was left unchanged to avoid breaking it). Underground's records list no longer receives the 53,669
  reference records without a bbox (`reference_datasets_not_listed` in the response).
- Rebuilding a single layer copies the 818 MB index first (slow on this filesystem); a full rebuild is faster.
