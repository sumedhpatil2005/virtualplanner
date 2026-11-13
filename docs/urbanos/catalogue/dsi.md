# Catalogue fragment: datasets already in the app (registry seeds, 2026-11-13)

Seeded by `backend/datasets/seed.py` (insert-only). sha256 values computed 2026-11-13 IST on the files named. Classes and
suitability as the registry records them; see `../DATA_QUALITY_AND_PROVENANCE.md` for the vocabulary.

| Registry id | What | Source / licence (as stated) | Data date | Class · suitability | File · sha256 |
|---|---|---|---|---|---|
| `osm_geofabrik_western_zone` | OSM extract, India western zone (bbox 67.30–80.91 E, 14.37–25.45 N from the pbf header) | Geofabrik; ODbL 1.0 © OpenStreetMap contributors (openstreetmap.org/copyright) | 2026-11-01T21:21:36Z (replication seq 1846); retrieved 2026-11-02T11:38Z (file mtime) | observed · screening | `backend/data/osm/western-zone-latest.osm.pbf` (221,868,283 B) · `15660b2094c5414e0e2a2d7b4304ef3db42cbb123375cc10feab4d5bdb4bec19` |
| `osm_local_index` | roads, signals, buildings, metro (SQLite + R*Tree), bbox 73.55–74.2 E, 18.3–18.85 N | derived from the above; ODbL | built 2026-11-02 17:30 IST | derived · screening | `backend/data/osm/osm_index.db` (174,723,072 B) · `6cf1846f731b1440519be7c17ad89047c357eab893b1d8473f78037476c6a598` |
| `osm_feasibility_layers` | water 1,409 · heritage 71 · trees 17,695 · railway 659 | derived; ODbL | built 2026-11-11 16:08 IST from the same extract | derived · screening | `backend/data/osm/feasibility_layers.db` (7,884,800 B; sha of the copy in `/workspace/work/uos-env-e2e/db/`) · `21924cea867eba0f89db2feabe1e092ce045a34bd1f66ec1e633b8f7f5be3f8e` — **absent at the default path in the main checkout** |
| `twincity_base_osm_objects` | base-scenario roads 18,271 and buildings 2,429 in `twincity.db` (1,324 study-area tiles, bbox 73.72–73.89 E, 18.49–18.62 N) | app database; OSM-derived (ODbL) | written 2026-11-02 → 2026-11-04 | derived · visualisation (heights/floors/population are importer defaults = estimated) | rows, no file hash |
| `twincity_demo_seed` | 16 sample buildings, 2 roads, 1 junction, 8 demand zones (population/employment), 5 gateways | `seed.py` | — | **synthetic** · visualisation | rows |
| `observed_counts_pune_west_2026` | peak-hour classified turning counts, 6 west-Pune junctions | Khandekar et al. 2025 (NICMAR, licence UNKNOWN); Kureshi et al. 2026 (Zenodo, CC BY 4.0) | published 2025-07; survey date not stated | observed · screening | `backend/data/observed_counts/pune_west_2026.json` · `86a68d68511716ac09cdbe588e6e3a366c66224deb06c9953b19d156a984530f` |
| `cmp2008_river_screenline` | Mula-Mutha bridges screen line, 12 h + peak hour | PMC CMP 2008 via OpenCity (licence UNKNOWN) | 2008 (staleness **fail**) | observed · screening | `backend/data/observed_screenlines/pune_cmp2008_river.json` · `584b9b9bb9d8a9692b84efea7d64196ed757a29fab9a21ba09d86aa54fd59168` |
| `pune_network_validation_v1` | 16 counts + corridor/hourly/city speeds, graded A/B/C (validation only) | compilation: CMP 2008, IJETT 2017, TraffiCure 2026, TomTom 2025, NICMAR 2025 — each source's terms | 2008 → 2026-08-19 | observed · screening | `backend/data/observed_validation/pune_network_validation_v1.json` · `2d055371c5e2ca8b0d81c012d89d4c863c24392dfde501502bf6bfcf98c7659b` |
| `mendeley_pune_2023_counts` | CCTV classified counts, 8 cameras, ~09–12 h | Matange & Abraham, Mendeley Data doi:10.17632/xnf2k6n288.1, CC BY 4.0 | 2023-01-11 → 2023-01-18 | observed · screening | `backend/data/diurnal/mendeley_pune_2023_hourly.json` · `1f6030838707cee6a4c7cb5fada20a16f63619c99ab71d4b507aaa89cee0660d` |
| `pune_hourly_profile_v1` | hour-of-day share, weekday/weekend (08–19 measured, rest filled from TomTom congestion) | compilation | 2017–2025 inputs, built 2026-11-02 | derived · screening | `backend/data/diurnal/pune_hourly_profile_v1.json` · `3519ce494232fb720eef99edf9b8a39cfd51ad4f857e8b03ce4c0c70006d150e` |
| `network_corrections_pune_west_v1` | 24 local OSM corrections at the counted junctions | repo; ODbL for the OSM ids | OSM 2026-11-01 | inferred · screening | `backend/data/network_corrections/pune_west_v1.json` · `5f60da2ea709250cf813680c2a8bf2833525d7f7d6b31adcef7236f3e18466e5` |
| `cesium_ion_imagery`, `cesium_world_terrain` | streamed globe imagery and terrain | Cesium ion Terms of Service (not stored offline) | streamed | observed / derived · visualisation | none (streamed; 401 in the sandbox) |
| `hbefa4_sumo_coefficients` | emission coefficients (HBEFA 4.2 via SUMO, stand-ins for Indian classes) | EPL-2.0 (SUMO) | 2026-01-09 (commit 7a4786a) | estimated · screening | code constants |
| `arai_2007_emission_factors` | ARAI 2007 g/km factors (area cross-check) | ARAI; licence UNKNOWN | 2007 | observed · screening | code constants |

Mirrored on every catalogue read (their own APIs unchanged): `environment_layers` → `env:<id>` (12 not acquired: flood lines,
groundwater, soil, geology, air quality, noise, LST, land cover, tree census, drainage, seismic zone, DEM); `subsurface_datasets` →
`subsurface:<id>`; `td_datasets` → `traffic:<id>` (synthetic flag honoured).

Gap entries (themes a feature needs; no version = not acquired): `gap_population_census`, `gap_admin_wards`, `gap_travel_demand`,
`gap_vehicle_fleet`, `gap_rainfall_idf`, `gap_asi_protected_limits`, `gap_pmc_heritage_list`, `gap_dp_road_lines`,
`gap_metro_structures`, `gap_traffic_speeds`, `gap_utilities`, `gap_boreholes`. Any imported dataset of the same theme satisfies
the dependency instead (the gap row stays as the record of what was missing).
