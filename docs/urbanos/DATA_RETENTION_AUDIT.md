# UrbanOS / VirtualPlanner — Data Retention Audit (READ-ONLY)

Generated Sat 2026-11-14 ~12:30 IST (UTC+05:30). Nothing was deleted, moved or modified. Registry read with `sqlite3 mode=ro` from `/workspace/work/virtualplanner/backend/twincity.db` (tables ds_dataset_versions, ds_files, ds_sources). Sizes are apparent bytes (sum of st_size); `du` block usage on JuiceFS is slightly higher. sha256 computed for every file in web/downloads, urbanos-data and every file > 50 MB in scope (plus all feasibility_layers.db copies and backend/data).

Scope: `/workspace/web/downloads`, `/workspace/work/urbanos-data/{raw,derived}`, repo-local data in `/workspace/work/virtualplanner`, every UrbanOS/VirtualPlanner harness, run, worktree and scratch dir in `/workspace/work`. `/workspace/work/export` ignored (zip being written). Unrelated dirs are listed in §8 and excluded from totals and plan.

## 1. Totals per class (in scope)

| Class | Items | Files | Bytes | Size |
|---|---:|---:|---:|---:|
| Original source | 31 | 264 | 3,318,276,411 | 3.1 GiB |
| Derived – active | 48 | 142 | 3,331,357,078 | 3.1 GiB |
| Derived – superseded | 2 | 29 | 80,700,973 | 77.0 MiB |
| Temporary processing | 87 | 33317 | 8,107,062,006 | 7.6 GiB |
| Reproducible download | 98 | 98 | 1,513,687,252 | 1.4 GiB |
| **Total** | 266 | 33850 | **16,351,083,720** | **15.2 GiB** |

| Reclaimable | Bytes | Size |
|---|---:|---:|
| Phase A – safe to delete now | 4,927,925,382 | 4.6 GiB |
| Phase B – delete only after stated precondition | 4,569,897,109 | 4.3 GiB |
| **A + B** | **9,497,822,491** | **8.8 GiB** |

## 2. Findings that need action before any cleanup

1. **Registry file missing in repo:** `backend/data/osm/feasibility_layers.db` (registry dsv_40ea7de6978d, sha256 21924cea…, 7,884,800 B) does not exist. The only copies are 11 sha256-identical files inside harness dirs (um-feas-run, um-smoke-run, uos-env-e2e, uos-envdata-e2e, uos-infra-e2e, uos-polish-e2e, uos-qa-e2e, uos-qa2-e2e, uos-qa3-e2e, uos-qab-e2e, urbanos/audit/e2e). Restore one copy before deleting any of those harnesses (command in §9, step 0).
2. **Elevation version mismatch:** registry ACTIVE = `elevation_copdem30/v1`; v2 and v3 are `pending_review` (v3 supersedes v2 supersedes v1) but app code (`terrain/dem.py DEFAULT_VERSION="v3"`, `envdata/catalogue.py`) reads **v3**. Another agent created `twincity.db.bak-2026-11-14-pre-dem-v3` and `uos-dem-compare/` at 12:22 IST today, so the promotion is in progress — do not touch elevation dirs until it lands.
3. **Dangling registry rows:** 10 ds_files rows for `raw/bhuvan_wms_samples/2026-11-13/*.png` point at PNGs deliberately deleted on 2026-11-13 (Bhuvan ToS). Data decision was right; registry should mark them withdrawn.
4. **Hash drift:** `derived/pmc_tree_census_2019_index/v1/processing.json` no longer matches its ds_files sha256 (edited after registration; data files match).
5. **Duplicate registry rows:** esa_worldcover_2021_v200, google_open_buildings_v3, ms_global_ml_buildings, landcover_worldcover2021/v1, pmc_tree_census_2019_index/v1 each have an `active` row and a `pending_review` re-registration pointing at the same directory (no extra disk use).
6. **OpenCity staging duplicates:** 98 files in web/downloads (1.51 GB) are sha256-identical to manifest-referenced raw files, including 2 browser re-downloads with “(1)” in the name. The opencity manifest also names a `catalogue_snapshot` file (opencity_pune_catalogue.json) that is not on disk.
7. **Mendeley unzip:** `web/downloads/pune_mendeley/traffic/` (1.81 GB) is the unzipped content of `traffic.zip` (15.6 MB, sha256 recorded in registry); all 115 entries match by name and byte size.

## 3. web/downloads

| Path | Bytes | Size | Class | Required | Hash-identical copy | Recommendation | Note |
|---|---:|---:|---|---|---|---|---|
| `downloads/pune_mendeley/traffic/` | 1,812,118,340 | 1.7 GiB | Temporary processing | no (registry uses backend/data/diurnal/mendeley_pune_2023_hourly.json) | pune_mendeley/traffic.zip (all 115 entries name+byte-size identical) | safe to delete | unzipped copy of traffic.zip (1.81 GB uncompressed) |
| `downloads/pune_refs/cmp2018.pdf` | 43,268,498 | 41.3 MiB | Original source | provenance/reference |  | keep | reference document; not in a manifest, no URL/hash recorded |
| `downloads/pune_refs/cmp2008.pdf` | 34,495,353 | 32.9 MiB | Original source | provenance/reference |  | keep | reference document; not in a manifest, no URL/hash recorded |
| `downloads/pune_mendeley/traffic.zip` | 15,582,506 | 14.9 MiB | Original source | provenance (sha256 648e9c33… recorded in registry dsv_d5668149c9db notes) |  | keep | Mendeley xnf2k6n288 v1, CC BY 4.0; only copy |
| `downloads/pune_refs/indohcm_snippets.pdf` | 1,948,364 | 1.9 MiB | Original source | provenance/reference |  | keep | reference document; not in a manifest, no URL/hash recorded |
| `downloads/vp/zenodo.pdf` | 1,589,771 | 1.5 MiB | Original source | provenance/reference |  | keep | reference document; not in a manifest, no URL/hash recorded |
| `downloads/pune_refs/cmp2018.txt` | 1,321,016 | 1.3 MiB | Temporary processing | no |  | keep (tiny; text extraction of the PDF beside it) | regenerable from PDF |
| `downloads/pune_refs/ijaem.pdf` | 600,738 | 586.7 KiB | Original source | provenance/reference |  | keep | reference document; not in a manifest, no URL/hash recorded |
| `downloads/vp/nicmar.pdf` | 454,331 | 443.7 KiB | Original source | provenance (sha256 d291d2ce… recorded in registry dsv_b9bacd5ca4eb notes) |  | keep | source PDF of observed_counts_pune_west_2026; licence UNKNOWN |
| `downloads/pune_refs/cmp2008.txt` | 445,788 | 435.3 KiB | Temporary processing | no |  | keep (tiny; text extraction of the PDF beside it) | regenerable from PDF |
| `downloads/opencity_ckan_package_search_groups_pune-1f6aaea3.pdf` | 344,884 | 336.8 KiB | Original source | provenance (catalogue snapshot) |  | keep | printed CKAN catalogue page; not in a manifest |
| `downloads/opencity_ckan_package_search_organization_pune-municipal-corporation-92fab1bc.pdf` | 184,806 | 180.5 KiB | Original source | provenance (catalogue snapshot) |  | keep | printed CKAN catalogue page; not in a manifest |
| `downloads/pune_refs/indohcm.txt` | 156,281 | 152.6 KiB | Temporary processing | no |  | keep (tiny; text extraction of the PDF beside it) | regenerable from PDF |
| `downloads/pune_refs/ijaem.txt` | 42,606 | 41.6 KiB | Temporary processing | no |  | keep (tiny; text extraction of the PDF beside it) | regenerable from PDF |
| `downloads/pune_mendeley/README.docx` | 32,121 | 31.4 KiB | Original source | provenance |  | keep | Mendeley dataset docs |
| `downloads/vp/nicmar.txt` | 25,667 | 25.1 KiB | Temporary processing | no |  | keep (tiny; text extraction of the PDF beside it) | regenerable from PDF |
| `downloads/vp/zenodo.txt` | 19,972 | 19.5 KiB | Temporary processing | no |  | keep (tiny; text extraction of the PDF beside it) | regenerable from PDF |
| `downloads/pune_refs/pdfcoffee.html` | 5,444 | 5.3 KiB | Temporary processing | no |  | safe to delete | failed download: HTML "under maintenance" / Cloudflare challenge page, not the document |
| `downloads/pune_mendeley/data_dictionary.csv` | 648 | 648 B | Original source | provenance |  | keep | Mendeley dataset docs |
| `downloads/pune_refs/iisc14.pdf` | 165 | 165 B | Temporary processing | no |  | safe to delete | failed download: HTML "under maintenance" / Cloudflare challenge page, not the document |
| `downloads/<uuid>-<hash>.csv/.kml/.kmz` + `pmc_*`, `pune-*-iitm/mpcb*` (98 files, per-file list in Appendix A) | 1,513,687,252 | 1.4 GiB | Reproducible download | no | yes – each sha256-identical to a file in `urbanos-data/raw/opencity_pune/2026-11-13/` | safe to delete | OpenCity browser staging folder used by `opencity_pune ingest --staging` |

## 4. urbanos-data/raw (original source data)

All raw sources are originals as downloaded, referenced by `manifest.json` and by the registry. Recommendation for every row: **keep** (required by registry; most have URL + sha256 recorded and could be re-downloaded, but upstream versions drift).

| Source dir (`urbanos-data/raw/…/2026-11-13`) | Bytes | Size | Files | Registry versions | Licence (registry) | Notes |
|---|---:|---:|---:|---|---|---|
| `opencity_pune` | 1,360,907,067 | 1.3 GiB | 97 | dsv_ee79fc4c0496 active | UNKNOWN | 96/96 data files in manifest, sha256 verified=True; URL recorded for 96; 96 files have sha256-identical copies in web/downloads |
| `imd_gridded_rainfall_025` | 661,588,659 | 630.9 MiB | 27 | dsv_b4e8f204408d active | UNKNOWN | 26/26 data files in manifest, sha256 verified=True; URL recorded for 26 |
| `google_open_buildings_v3` | 292,976,562 | 279.4 MiB | 8 | dsv_8e5be0b703d2 active, dsv_da4ec5273174 pending_review | CC BY 4.0 or ODbL v1.0 (user's choice) | 3/7 data files in manifest, sha256 verified=True; URL recorded for 3; 4 stream marker txt files not in manifest (163 B) |
| `jrc_gsw` | 145,368,757 | 138.6 MiB | 6 | dsv_17fe8a4b33b0 active | Copernicus Programme, free of charge without restriction of use | 5/5 data files in manifest, sha256 verified=True; URL recorded for 5 |
| `esa_worldcover_2021_v200` | 125,767,579 | 119.9 MiB | 2 | dsv_61178e8b7f60 pending_review, dsv_bb271ca4ea4f active | CC-BY 4.0 | 1/1 data files in manifest, sha256 verified=True; URL recorded for 1 |
| `sentinel2_l2a_earthsearch` | 122,339,176 | 116.7 MiB | 13 | dsv_5ad0e9833d17 active | Legal notice on the use of Copernicus Sentinel Data and Service Information | 12/12 data files in manifest, sha256 verified=True; URL recorded for 12 |
| `nwdp_india_wris` | 117,491,379 | 112.0 MiB | 5 | dsv_c275038fa246 active | UNKNOWN | 4/4 data files in manifest, sha256 verified=True; URL recorded for 4 |
| `copernicus_dem_glo30` | 84,774,519 | 80.8 MiB | 3 | dsv_9fdd575ff393 active | Copernicus DEM GLO-30 free licence (ESA user licence / CCM terms) | 2/2 data files in manifest, sha256 verified=True; URL recorded for 2 |
| `ms_global_ml_buildings` | 57,900,388 | 55.2 MiB | 6 | dsv_a3fda9753429 pending_review, dsv_b99621137288 active | CDLA Permissive 2.0 | 5/5 data files in manifest, sha256 verified=True; URL recorded for 5 |
| `bhuvan_ogc_capabilities` | 22,877,695 | 21.8 MiB | 6 | dsv_402f4ce207d9 active | UNKNOWN | 5/5 data files in manifest, sha256 verified=True; URL recorded for 5 |
| `chirps_v2_climateserv` | 2,486,207 | 2.4 MiB | 3 | dsv_6e880dec06d1 active | Public domain (CC0 waiver) | 2/2 data files in manifest, sha256 verified=True; URL recorded for 2 |
| `pmc_autodcr_geoserver_probe` | 1,061,806 | 1.0 MiB | 27 | dsv_9c6f58a40127 active | UNKNOWN | 26/26 data files in manifest, sha256 verified=True; URL recorded for 26 |
| `nasadem_pc` | 886,526 | 865.7 KiB | 3 | dsv_40f7d9fec169 active | UNKNOWN (PC STAC says 'proprietary'; NASA LP DAAC states no restrictions - see catalogue) | 2/2 data files in manifest, sha256 verified=True; URL recorded for 2 |
| `soilgrids_250m_v2` | 720,510 | 703.6 KiB | 33 | dsv_fbae1ba614d0 active | CC BY 4.0 | 32/32 data files in manifest, sha256 verified=True; URL recorded for 32 |
| `datameet_municipal_wards` | 426,471 | 416.5 KiB | 3 | dsv_d6ecc8a52e40 active | CC BY-SA 2.5 India | 2/2 data files in manifest, sha256 verified=True; URL recorded for 2 |
| `nwdp_meta` | 147,423 | 144.0 KiB | 5 | dsv_36320e2e3ef5 active | UNKNOWN | 4/4 data files in manifest, sha256 verified=True; URL recorded for 4 |
| `pmc_opendata_portal_catalogue` | 123,106 | 120.2 KiB | 2 | dsv_fbd95711e27d active | UNKNOWN | 1/1 data files in manifest, sha256 verified=True; URL recorded for 1 |
| `cpcb_caaqms_station_list` | 42,951 | 41.9 KiB | 2 | dsv_1117ef85a961 active | UNKNOWN | 1/1 data files in manifest, sha256 verified=True; URL recorded for 1 |
| `bhuvan_wms_samples` | 19,327 | 18.9 KiB | 1 | dsv_1b5801795ebe active | UNKNOWN | 0/0 data files in manifest, sha256 verified=True; URL recorded for 0; PNGs deliberately deleted 2026-11-13 (Bhuvan ToS) but 10 ds_files rows still point at them |
| **Total raw** | 2,997,906,108 | 2.8 GiB | 252 | | | |

## 5. urbanos-data/derived (per version)

| Dataset / version | Bytes | Size | Files | Class | Required by | Recommendation | Note |
|---|---:|---:|---:|---|---|---|---|
| `infra_index/v1` | 817,825,049 | 779.9 MiB | 2 | Derived – active | registry: dsv_4a42441bf7cf active | keep |  |
| `buildings_comparison/v1` | 622,903,195 | 594.0 MiB | 4 | Derived – active | registry: dsv_e9351ebb02a3 active | keep |  |
| `pmc_tree_census_2019/2026-11-13` | 465,989,711 | 444.4 MiB | 2 | Derived – active | registry: dsv_61c35fb10ce6 active | keep |  |
| `pmc_tree_census_2019_index/v1` | 457,381,141 | 436.2 MiB | 2 | Derived – active | registry: dsv_cd7786f3f943 active, dsv_d48ce2056959 pending_review | keep | processing.json sha256 differs from ds_files (file edited after registration); two registry rows (active + pending_review re-registration) point at the same dir |
| `sentinel2_indices/v1` | 320,741,592 | 305.9 MiB | 10 | Derived – active | registry: dsv_908c70c74df3 active | keep |  |
| `pmc_stormwater_drains/2026-11-13` | 149,589,218 | 142.7 MiB | 2 | Derived – active | registry: dsv_36e9d55d0d17 active | keep |  |
| `pmc_sewage_pipelines/2026-11-13` | 52,578,713 | 50.1 MiB | 2 | Derived – active | registry: dsv_4bd4ad8fcb03 active | keep |  |
| `elevation_copdem30/v2` | 41,131,830 | 39.2 MiB | 16 | Derived – superseded | registry: dsv_c5c69b12179f pending_review | delete only after v3 review decision AND v2 registry row marked superseded/withdrawn | superseded by v3 (half-pixel mosaic shift fix); not referenced by code |
| `elevation_copdem30/v3` | 40,989,963 | 39.1 MiB | 16 | Derived – active | registry: dsv_0d0e82a8c181 pending_review; app code: terrain/dem.py DEFAULT_VERSION + envdata/catalogue.py | keep | pending_review in registry but the version the app uses |
| `elevation_copdem30/v1` | 39,569,143 | 37.7 MiB | 13 | Derived – superseded | registry: dsv_394ee44c2555 active | keep until v3 is promoted to active; then delete only after v1 row archived | still the registry ACTIVE version, but superseded in the chain v1→v2→v3 and app code reads v3; another agent is preparing DEM-v3 promotion (twincity.db.bak-2026-11-14-pre-dem-v3) |
| `pmc_revenue_map/2026-11-13` | 20,139,125 | 19.2 MiB | 2 | Derived – active | registry: dsv_9df956f608b1 active | keep |  |
| `pmc_road_centerline/2026-11-13` | 19,255,102 | 18.4 MiB | 2 | Derived – active | registry: dsv_7cb7353257d7 active | keep |  |
| `cpcb_caaqms_pune/2026-11-13` | 16,541,095 | 15.8 MiB | 3 | Derived – active | registry: dsv_9ddc00d9aaa9 active | keep |  |
| `pmc_sewage_pipelines_fgb/v1` | 14,488,141 | 13.8 MiB | 2 | Derived – active | registry: dsv_f508e111969f active | keep |  |
| `pmc_swd_chambers/2026-11-13` | 5,788,599 | 5.5 MiB | 2 | Derived – active | registry: dsv_ac9ce5d3100d active | keep |  |
| `landcover_worldcover2021/v1` | 5,075,454 | 4.8 MiB | 4 | Derived – active | registry: dsv_f8d5a0c86e12 active, dsv_1e4947f7de84 pending_review | keep | two registry rows (active + pending_review re-registration) point at the same dir |
| `pmc_nallas/2026-11-13` | 1,739,377 | 1.7 MiB | 2 | Derived – active | registry: dsv_4e736cd57078 active | keep |  |
| `pmpml_bus_stops/2026-11-13` | 1,583,512 | 1.5 MiB | 2 | Derived – active | registry: dsv_71771d794eb9 active | keep |  |
| `pmc_swd_utility_chambers/2026-11-13` | 1,260,928 | 1.2 MiB | 2 | Derived – active | registry: dsv_0ea05275e941 active | keep |  |
| `imd_rainfall_025_pune/2026-11-13` | 1,050,424 | 1.0 MiB | 4 | Derived – active | registry: dsv_3cd5094489c6 active | keep |  |
| `pmc_electoral_wards_2012/2026-11-13` | 893,456 | 872.5 KiB | 2 | Derived – active | registry: dsv_17b2d0f5c451 active | keep |  |
| `pmc_prabhag_boundary/2026-11-13` | 870,904 | 850.5 KiB | 2 | Derived – active | registry: dsv_d13036f75e13 active | keep |  |
| `soil_soilgrids250/v1` | 386,012 | 377.0 KiB | 10 | Derived – active | registry: dsv_cc5a73273073 active | keep |  |
| `nwdp_groundwater_pune/2026-11-13` | 327,161 | 319.5 KiB | 3 | Derived – active | registry: dsv_68f81330c8a8 active | keep |  |
| `pmc_parks_gardens/2026-11-13` | 319,481 | 312.0 KiB | 2 | Derived – active | registry: dsv_57653a950431 active | keep |  |
| `rainfall_chirps_boxavg/v1` | 284,262 | 277.6 KiB | 3 | Derived – active | registry: dsv_d1b93f6a754f active | keep |  |
| `surface_water_jrc_gsw/v1` | 280,673 | 274.1 KiB | 7 | Derived – active | registry: dsv_24a38499a32e active | keep |  |
| `pmc_admin_wards_2017/2026-11-13` | 256,879 | 250.9 KiB | 2 | Derived – active | registry: dsv_df2b918666ea active | keep |  |
| `pmc_electoral_wards_2022/2026-11-13` | 216,156 | 211.1 KiB | 2 | Derived – active | registry: dsv_f2fadb51878c active | keep |  |
| `water_bodies_census_pune_2023/2026-11-13` | 215,209 | 210.2 KiB | 2 | Derived – active | registry: dsv_60e4ea4b2464 active | keep |  |
| `pmc_zones/2026-11-13` | 183,192 | 178.9 KiB | 2 | Derived – active | registry: dsv_346c50d5b3da active | keep |  |
| `pmc_electoral_wards_2025/2026-11-13` | 129,051 | 126.0 KiB | 2 | Derived – active | registry: dsv_9241cf24a6f1 active | keep |  |
| `pmc_public_toilets/2026-11-13` | 103,978 | 101.5 KiB | 2 | Derived – active | registry: dsv_24d0cc4f21db active | keep |  |
| `pmc_electoral_wards_2017/2026-11-13` | 86,364 | 84.3 KiB | 2 | Derived – active | registry: dsv_59110cbdeb6e active | keep |  |
| `pmc_rivers/2026-11-13` | 67,163 | 65.6 KiB | 2 | Derived – active | registry: dsv_7a4caa3ec97f active | keep |  |
| `pmc_crematoriums/2026-11-13` | 55,785 | 54.5 KiB | 2 | Derived – active | registry: dsv_f3b55a403562 active | keep |  |
| `census2011_pune_wards/2026-11-13` | 34,836 | 34.0 KiB | 2 | Derived – active | registry: dsv_8d236a6a6504 active | keep |  |
| `pmc_stps/2026-11-13` | 20,035 | 19.6 KiB | 2 | Derived – active | registry: dsv_5b5c8116edb1 active | keep |  |
| `pune_libraries/2026-11-13` | 18,303 | 17.9 KiB | 2 | Derived – active | registry: dsv_015e05583d2a active | keep |  |
| `pmc_fire_stations/2026-11-13` | 6,474 | 6.3 KiB | 2 | Derived – active | registry: dsv_dd8e6e7dab2f active | keep |  |
| `pmpml_bus_depots/2026-11-13` | 4,543 | 4.4 KiB | 2 | Derived – active | registry: dsv_2231d41f1c9c active | keep |  |
| `imd_district_rainfall_pune/2026-11-13` | 3,509 | 3.4 KiB | 2 | Derived – active | registry: dsv_01edde072e57 active | keep |  |
| **Total derived** | 3,100,384,738 | 2.9 GiB | 153 | | | | |

Large active derived sets (infra_index 818 MB, buildings_comparison 623 MB, pmc_tree_census_2019 466 MB, trees_index 457 MB, sentinel2_indices 321 MB) are reproducible from raw via the pipelines and git commits recorded in each processing.json, but are active registry versions read by the app → keep.

## 6. Repo-local data (`/workspace/work/virtualplanner`)

| Path | Bytes | Size | Class | Required | Recommendation | Note |
|---|---:|---:|---|---|---|---|
| `backend/twincity.db` | 136,765,440 | 130.4 MiB | Derived – active | yes – live app DB + dataset registry | keep | gitignored; sha 5026b811dd8d |
| `backend/data/osm/western-zone-latest.osm.pbf` | 221,868,283 | 211.6 MiB | Original source | yes – registry dsv_a54a8387109a (osm_geofabrik_western_zone) | keep | Geofabrik "latest" changes daily → not byte-reproducible; ODbL |
| `backend/data/osm/osm_index.db` | 174,723,072 | 166.6 MiB | Derived – active | yes – registry dsv_c325393efc7d | keep | sha256-identical copy at /workspace/work/vp-int-e2e/db_osm_index.db |
| `backend/data/diurnal` | 56,607 | 55.3 KiB | Derived – active | yes – registry (git-tracked) | keep |  |
| `backend/data/observed_counts` | 27,534 | 26.9 KiB | Derived – active | yes – registry (git-tracked) | keep |  |
| `backend/data/observed_screenlines` | 3,286 | 3.2 KiB | Derived – active | yes – registry (git-tracked) | keep |  |
| `backend/data/observed_validation` | 74,356 | 72.6 KiB | Derived – active | yes – registry (git-tracked) | keep |  |
| `backend/data/network_corrections` | 23,018 | 22.5 KiB | Derived – active | yes – registry (git-tracked) | keep |  |
| `backend/backups` | 820,393 | 801.2 KiB | Temporary processing | no | keep (small audit trail of OSM cleanup) |  |
| `frontend/dist` | 14,856,141 | 14.2 MiB | Temporary processing | no (build output, gitignored) | keep (current build; regenerable with npm run build) |  |
| `backend/data/osm/feasibility_layers.db` | 0 | 0 B | Derived – active | yes – registry dsv_40ea7de6978d (sha256 21924cea…) | MISSING – restore from a harness copy before any harness cleanup | 11 sha256-identical copies exist only in harness dirs (see §5) |

Not data, not counted: `frontend/node_modules` (~378 MB, reinstallable), `.git` (~23 MB).

## 7. DB copies, harness, run, worktree and scratch dirs (`/workspace/work`)

DB copies > 50 MB and their sha256 (none of the twincity.db copies is identical to the live DB `5026b811dd8d…`):

| File | Bytes | sha256 (12) | Identical to |
|---|---:|---|---|
| `qac/before.db` | 136,671,232 | 0b9f2f077139 | — |
| `qac/twincity_copy.db` | 136,720,384 | 89b98cac6193 | — |
| `um-val-run/db/twincity.db` | 73,957,376 | 35424fede9e0 | — |
| `uos-infra-e2e/db/twincity.db` | 137,101,312 | 53f569dc089c | — |
| `uos-mon-run/twincity.db` | 136,802,304 | 1e72a5a71631 | — |
| `uos-qa2-e2e/db/twincity.db` | 137,838,592 | b8523e583e98 | — |
| `uos-qa3-e2e/db/twincity.db` | 139,034,624 | 6d993bfc320f | — |
| `uos-qab-e2e/db/base.db` | 136,683,520 | 35c925a52a30 | — |
| `uos-qab-e2e/db/twincity.db` | 137,109,504 | 3fc961d62449 | — |
| `virtualplanner/backend/data/osm/osm_index.db` | 174,723,072 | 6cf1846f731b | vp-int-e2e/db_osm_index.db |
| `virtualplanner/backend/twincity.db` | 136,765,440 | 5026b811dd8d | — |
| `vp-int-e2e/db_osm_index.db` | 174,723,072 | 6cf1846f731b | virtualplanner/backend/data/osm/osm_index.db |
| `vp-ux2-e2e/db/twincity.db` | 56,561,664 | f317f50807c8 | — |

| Path | Bytes | Size | Class | Required | Hash-identical data inside | Recommendation | Note |
|---|---:|---:|---|---|---|---|---|
| `work/vp-int-e2e/` | 425,145,662 | 405.5 MiB | Temporary processing | no | db_osm_index.db (174.7 MB) sha256-identical to backend/data/osm/osm_index.db | delete only after docs evidence archived (path cited 7× in repo docs) | harness/scratch: db 215.6 MiB, dist 27.2 MiB, json 162.5 MiB |
| `work/vp-junc3/` | 384,226,864 | 366.4 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 93.7 MiB, dist 13.6 MiB, json 254.7 MiB, img 4.4 MiB |
| `work/vp-overhaul/` | 363,323,707 | 346.5 MiB | Temporary processing | no |  | delete only after its notes (BUGS_FIXED.md, COMMIT_AGENT_NOTES.md, FINDINGS.md) are archived | harness/scratch: db 46.8 MiB, dist 147.8 MiB, json 107.1 MiB, img 42.4 MiB, log 1.2 MiB, other 1.1 MiB |
| `work/uos-qab-e2e/` | 311,503,251 | 297.1 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after feasibility_layers.db restored to backend/data/osm | harness/scratch: db 268.6 MiB, dist 28.2 MiB |
| `work/qac/` | 288,708,498 | 275.3 MiB | Temporary processing | no |  | delete only after QA cycle closed (before.db is a pre-change DB snapshot) | harness/scratch: db 260.7 MiB, dist 14.2 MiB |
| `work/vp-shots/` | 227,220,642 | 216.7 MiB | Temporary processing | no |  | safe to delete | harness/scratch: json 181.3 MiB, img 35.3 MiB |
| `work/urbanos/shots/` | 186,922,805 | 178.3 MiB | Temporary processing | no |  | delete only after docs evidence archived (urbanos dir cited in docs) | QA screenshots (evidence, not data) |
| `work/uos-qa3-e2e/` | 166,646,871 | 158.9 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after feasibility_layers.db restored to backend/data/osm | harness/scratch: db 140.1 MiB, dist 14.2 MiB, img 4.0 MiB |
| `work/uos-qa2-e2e/` | 161,011,937 | 153.6 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after feasibility_layers.db restored to backend/data/osm | harness/scratch: db 139.0 MiB, dist 14.2 MiB |
| `work/uos-infra-e2e/` | 159,833,011 | 152.4 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after feasibility_layers.db restored to backend/data/osm | harness/scratch: db 138.3 MiB, dist 14.1 MiB |
| `work/vp-wt-edit-e2e/` | 148,724,375 | 141.8 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 2× in repo docs) | harness/scratch: db 93.7 MiB, dist 13.6 MiB, json 34.5 MiB |
| `work/uos-mon-run/` | 136,850,074 | 130.5 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 130.5 MiB |
| `work/twincity.db.bak-2026-11-14-pre-dem-v3` | 136,740,864 | 130.4 MiB | Temporary processing | IN USE – created 12:22 IST today by another agent |  | keep until DEM-v3 promotion verified | pre-change snapshot of live twincity.db (not hashed; in use) |
| `work/um-odme-run/` | 124,070,549 | 118.3 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 6× in repo docs) | harness/scratch: db 47.0 MiB, json 70.8 MiB |
| `work/vp-shiv2-e2e/` | 120,474,032 | 114.9 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 3× in repo docs) | harness/scratch: db 46.8 MiB, dist 13.6 MiB, json 54.3 MiB |
| `work/vp-wt-final-e2e/` | 98,419,755 | 93.9 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 93.7 MiB |
| `work/vp-sev2-e2e/` | 95,249,369 | 90.8 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 49.1 MiB, dist 41.5 MiB |
| `work/vp-shiv-e2e/` | 91,957,043 | 87.7 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, dist 40.8 MiB |
| `work/vp-sev-e2e/` | 91,834,090 | 87.6 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, dist 40.6 MiB |
| `work/vp-conn/` | 89,861,831 | 85.7 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, json 38.6 MiB |
| `work/vp-overhaul-shots/` | 83,204,047 | 79.3 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 6× in repo docs) | harness/scratch: img 79.3 MiB |
| `work/um-val-run/` | 79,752,423 | 76.1 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) and its notes (doc_head.md, doc_mid1.md, doc_mid2a.md, doc_mid2b.md, doc_mid2c.md, doc_mid2d.md) are archived | harness/scratch: db 70.5 MiB, json 2.5 MiB, other 2.6 MiB |
| `work/um-topo-e2e/` | 78,612,106 | 75.0 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 3× in repo docs) | harness/scratch: db 46.8 MiB, dist 13.6 MiB, json 2.1 MiB, log 9.4 MiB, other 2.6 MiB |
| `work/vp-wt-scope-e2e/` | 77,459,785 | 73.9 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, dist 27.0 MiB |
| `work/uos-qa-e2e/` | 77,453,052 | 73.9 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after docs evidence archived (path cited 2× in repo docs) and feasibility_layers.db restored to backend/data/osm | harness/scratch: db 55.1 MiB, dist 14.1 MiB, img 4.4 MiB |
| `work/vp-wt-recompute-e2e/` | 77,371,204 | 73.8 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, dist 26.9 MiB |
| `work/uos-envdata-e2e/` | 76,698,387 | 73.1 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after feasibility_layers.db restored to backend/data/osm | harness/scratch: db 55.1 MiB, dist 14.1 MiB, img 3.8 MiB |
| `work/um-feas-run/` | 74,843,645 | 71.4 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after docs evidence archived (path cited 3× in repo docs) and feasibility_layers.db restored to backend/data/osm | harness/scratch: db 54.6 MiB, dist 13.7 MiB, img 2.5 MiB |
| `work/vp-wt-edit2-e2e/` | 73,387,954 | 70.0 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 2× in repo docs) | harness/scratch: db 46.9 MiB, dist 13.6 MiB, log 9.4 MiB |
| `work/vp-ux2-e2e/` | 72,665,872 | 69.3 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 53.9 MiB, dist 13.6 MiB, json 1.5 MiB |
| `work/uos-polish-e2e/` | 72,586,764 | 69.2 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after docs evidence archived (path cited 1× in repo docs) and feasibility_layers.db restored to backend/data/osm | harness/scratch: db 55.0 MiB, dist 14.1 MiB |
| `work/uos-env-e2e/` | 72,476,191 | 69.1 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after docs evidence archived (path cited 4× in repo docs) and feasibility_layers.db restored to backend/data/osm | harness/scratch: db 55.0 MiB, dist 14.0 MiB |
| `work/um-smoke-run/` | 72,149,450 | 68.8 MiB | Temporary processing | no | feasibility_layers.db sha256-identical to registry hash | delete only after docs evidence archived (path cited 3× in repo docs) and feasibility_layers.db restored to backend/data/osm | harness/scratch: db 54.6 MiB, dist 13.9 MiB |
| `work/urbanos/audit/e2e/` | 71,861,783 | 68.5 MiB | Temporary processing | no |  | delete only after the code/UI audit closes and feasibility_layers.db is restored | harness DB copies + dist; current audit (CODE_UI_AUDIT.md) |
| `work/uos-shell-e2e/` | 70,189,555 | 66.9 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 47.4 MiB, dist 19.3 MiB |
| `work/uos-dsi-run/` | 68,041,335 | 64.9 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 2× in repo docs) | harness/scratch: db 47.8 MiB, dist 17.0 MiB |
| `work/um-scen-run/` | 66,321,897 | 63.2 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 2× in repo docs) | harness/scratch: db 46.9 MiB, dist 13.6 MiB, img 2.7 MiB |
| `work/um-gen-run/` | 65,581,498 | 62.5 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 3× in repo docs) | harness/scratch: db 47.1 MiB, dist 13.8 MiB, img 1.6 MiB |
| `work/uos-terrain-e2e/` | 65,148,234 | 62.1 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 48.0 MiB, dist 14.1 MiB |
| `work/um-ws-run/` | 65,054,086 | 62.0 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 47.0 MiB, dist 13.8 MiB, img 1.1 MiB |
| `work/um-ui-e2e/` | 64,790,548 | 61.8 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 47.0 MiB, dist 13.8 MiB |
| `work/uos-ug-e2e/` | 64,289,028 | 61.3 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 47.2 MiB, dist 14.0 MiB |
| `work/uos-proj-e2e/` | 64,239,741 | 61.3 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 47.2 MiB, dist 14.0 MiB |
| `work/vp-final2-e2e/` | 63,926,200 | 61.0 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 5× in repo docs) and its notes (sec20.md) are archived | harness/scratch: db 46.8 MiB, dist 13.6 MiB |
| `work/vp-ux-e2e/` | 63,863,681 | 60.9 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 47.0 MiB, dist 13.6 MiB |
| `work/vp-wt-junc-e2e/` | 63,813,201 | 60.9 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 2× in repo docs) and its notes (README.md) are archived | harness/scratch: db 46.8 MiB, dist 13.5 MiB |
| `work/vp-wt-fix3-e2e/` | 63,642,986 | 60.7 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 2× in repo docs) | harness/scratch: db 46.8 MiB, dist 13.6 MiB |
| `work/vp-wt-merged-e2e/` | 63,550,687 | 60.6 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, dist 13.5 MiB |
| `work/vp-jx2/` | 63,540,287 | 60.6 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) | harness/scratch: db 46.8 MiB, dist 13.6 MiB |
| `work/vp-wt-verify-e2e/` | 63,517,182 | 60.6 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, dist 13.5 MiB |
| `work/vp-wt-day-e2e/` | 63,510,819 | 60.6 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, dist 13.5 MiB |
| `work/coep2-scratch/` | 63,384,488 | 60.4 MiB | Temporary processing | no |  | safe to delete | harness/scratch: db 46.8 MiB, dist 13.5 MiB |
| `work/vp-conn-e2e/` | 63,292,963 | 60.4 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) and its notes (README.md) are archived | harness/scratch: db 46.8 MiB, dist 13.5 MiB |
| `work/um-data-run/` | 49,939,495 | 47.6 MiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 2× in repo docs) | harness/scratch: db 46.9 MiB |
| `work/twincity.db.bak-2026-11-13` | 49,106,944 | 46.8 MiB | Temporary processing | no |  | delete only after Phase-2 sign-off (pre-change backup) | size differs from live twincity.db (<50 MB, not hashed) |
| `work/twincity.before-road-analysis.db` | 18,903,040 | 18.0 MiB | Temporary processing | no |  | delete only after Phase-2 sign-off | size differs from live twincity.db (<50 MB, not hashed) |
| `work/urbanos/tools-e2e/` | 14,591,506 | 13.9 MiB | Temporary processing | no |  | safe to delete | palette harness + dist build |
| `work/uos-wt-qa3/` | 11,701,480 | 11.2 MiB | Temporary processing | no |  | safe to remove via git worktree remove | git worktree, detached 2e43d88, clean; patch already in HEAD (git cherry “-”) |
| `work/uos-wt-qa2/` | 11,664,452 | 11.1 MiB | Temporary processing | no |  | safe to remove via git worktree remove | git worktree, detached 3eae27e, clean; patch already in HEAD (git cherry “-”) |
| `work/vp-shiv-scratch/` | 6,723,272 | 6.4 MiB | Temporary processing | no |  | safe to delete | harness/scratch: json 6.4 MiB |
| `work/cal/` | 4,335,463 | 4.1 MiB | Temporary processing | no |  | keep | calibration scratch cited 4× in docs |
| `work/um-odme-scratch/` | 3,546,898 | 3.4 MiB | Temporary processing | no |  | keep | holds SUMO HBEFA4 source + arai.pdf used for registered hbefa4/arai datasets (reference copies) |
| `work/prof/` | 2,488,425 | 2.4 MiB | Temporary processing | no |  | safe to delete | harness/scratch: other 2.4 MiB |
| `work/*.log|*.json|*.patch|*.sh|*.py|*.md (top-level loose files)` | 1,704,528 | 1.6 MiB | Temporary processing | no |  | keep (negligible; briefs/patches may be referenced) | test logs, run JSON, briefs, WIP patches |
| `work/vp-wt-sim-scratch/` | 1,018,487 | 994.6 KiB | Temporary processing | no |  | safe to delete | harness/scratch: logs/scripts |
| `work/doc24tmp/` | 835,132 | 815.6 KiB | Temporary processing | no |  | delete only after its notes (sec24_final.md, sec24_tables.md) are archived | harness/scratch: logs/scripts |
| `work/vp-merge-e2e/` | 373,956 | 365.2 KiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 2× in repo docs) | harness/scratch: logs/scripts |
| `work/vp-int-logs/` | 373,221 | 364.5 KiB | Temporary processing | no |  | safe to delete | harness/scratch: logs/scripts |
| `work/uos-wt-vt-logs/` | 208,443 | 203.6 KiB | Temporary processing | no |  | safe to delete | harness/scratch: logs/scripts |
| `work/um-suite/` | 199,098 | 194.4 KiB | Temporary processing | no |  | safe to delete | harness/scratch: logs/scripts |
| `work/vp-logs/` | 163,790 | 160.0 KiB | Temporary processing | no |  | safe to delete | harness/scratch: logs/scripts |
| `work/uos-qa/` | 137,845 | 134.6 KiB | Temporary processing | no |  | safe to delete | harness/scratch: logs/scripts |
| `work/vp-final2-logs/` | 131,733 | 128.6 KiB | Temporary processing | no |  | safe to delete | harness/scratch: logs/scripts |
| `work/um-topo2-e2e/` | 113,260 | 110.6 KiB | Temporary processing | no |  | delete only after docs evidence archived (path cited 1× in repo docs) and its notes (table.md) are archived | harness/scratch: logs/scripts |
| `work/uos-dem-compare/` | 42,980 | 42.0 KiB | Temporary processing | in use |  | keep (in progress) | created 12:22 IST today by another agent (DEM-v3 comparison) |
| `work/vt-final/` | 436 | 436 B | Temporary processing | no |  | safe to delete | harness/scratch: logs/scripts |
| **Total** | 6,277,250,193 | 5.8 GiB | | | | | |

## 8. Out of scope (not UrbanOS data; excluded from totals and plan)

| Dir | Bytes | Size | What |
|---|---:|---:|---|
| `work/sect` | 4,155,881,791 | 3.9 GiB | SECT marketing videos/images (user's employer work) |
| `work/chr` | 518,506,112 | 494.5 MiB | Chromium runtime used by screenshot tooling |
| `work/export` | 432,220,579 | 412.2 MiB | zip export being written now (ignored per brief) |
| `work/brief` | 79,562,201 | 75.9 MiB | personal daily-brief scratch (calendar/mail) |
| `work/vv` | 7,515,094 | 7.2 MiB | other project |
| `work/shots` | 7,230,922 | 6.9 MiB | portfolio screenshots |
| `work/qtlibs` | 5,601,323 | 5.3 MiB | Qt runtime .debs (tooling) |
| `work/promo` | 4,585,252 | 4.4 MiB | mail promo scratch |
| `work/vv-redesign` | 3,458,695 | 3.3 MiB | other project |
| `work/inbox` | 1,514,292 | 1.4 MiB | mail scratch |
| `work/adios` | 253,033 | 247.1 KiB | other project |
| `work/profile2` | 140,429 | 137.1 KiB | GitHub profile work |
| `work/p2repo` | 127,977 | 125.0 KiB | GitHub profile work |
| `work/vv-analytics` | 9,017 | 8.8 KiB | other project |

## 9. Licence / redistribution flags

| Data (paths) | Licence as recorded | Redistribution risk | Handling |
|---|---|---|---|
| OpenCity: `raw/opencity_pune` (1.36 GB), its 98 staging copies in web/downloads, all `derived/pmc_*`, `pmpml_*`, `pune_libraries`, `census2011_pune_wards`, `water_bodies_census_pune_2023`, `pmc_tree_census_2019*`, and the OpenCity layers inside `infra_index/v1` | Conflicting: CKAN “Other (Public Domain)”; OpenCity FAQ ODbL + credit; site T&C “non-commercial and/or personal use only”; water-bodies census “CC Non-Commercial” | **HIGH** | Treat as non-commercial + attribution (OpenCity + PMC). Do not ship raw files or derived DBs in a public/commercial bundle or the export zip without clearance. |
| `raw/pmc_autodcr_geoserver_probe`, `raw/pmc_opendata_portal_catalogue` | UNKNOWN; PMC SmartGIS terms “personal and non-commercial … no copying/derivative works” | **HIGH** | Keep internal only. |
| `raw/bhuvan_ogc_capabilities` (+ deleted WMS PNGs) | UNKNOWN; Bhuvan ToS forbid copying without NRSC authorisation | **HIGH** | Capabilities XML only; do not redistribute; PNGs already deleted. |
| `raw/imd_gridded_rainfall_025`, `derived/imd_*` | UNKNOWN (IMD data policy not recorded) | **HIGH** until verified | Internal only; verify IMD terms. |
| `raw/nwdp_india_wris`, `raw/nwdp_meta`, `derived/nwdp_groundwater_pune`, `raw/cpcb_caaqms_station_list`, `derived/cpcb_caaqms_pune` | UNKNOWN | MEDIUM–HIGH | Internal only until terms recorded. |
| `raw/chirps_v2_climateserv`, `derived/rainfall_chirps_boxavg` | Data: CHIRPS public domain (CC0); ClimateSERV API terms UNKNOWN | LOW (data) / unknown (service) | Redistribution of values fine; cite CHC. |
| `raw/nasadem_pc` | UNKNOWN (Planetary Computer STAC says “proprietary”; NASA LP DAAC says no restrictions) | MEDIUM | Resolve before redistribution. |
| `raw/google_open_buildings_v3`, Google part of `buildings_comparison/v1` | CC BY 4.0 or ODbL 1.0 (user’s choice) | LOW | Attribution. |
| `raw/ms_global_ml_buildings`, MS part of `buildings_comparison/v1` | CDLA Permissive 2.0 | LOW | Keep licence notice. |
| `backend/data/osm/*` (pbf, osm_index.db, feasibility_layers.db), OSM part of `buildings_comparison/v1` and `infra_index/v1`, `twincity.db` | ODbL 1.0 | MEDIUM (share-alike) | Attribution; derived databases distributed publicly must be ODbL. |
| `raw/datameet_municipal_wards` | CC BY-SA 2.5 India | MEDIUM (share-alike) | Attribution + share-alike on derivatives. |
| `raw/soilgrids_250m_v2`, `derived/soil_soilgrids250` | CC BY 4.0 | LOW | Attribution (ISRIC). |
| `raw/esa_worldcover_2021_v200`, `derived/landcover_worldcover2021` | CC BY 4.0 | LOW | Attribution (ESA WorldCover). |
| `raw/copernicus_dem_glo30`, `derived/elevation_copdem30/*` | Copernicus DEM GLO-30 free licence (ESA/CCM terms) | LOW–MEDIUM | Redistribution allowed with the required Copernicus/DLR/Airbus attribution notice; check notice wording. |
| `raw/sentinel2_l2a_earthsearch`, `derived/sentinel2_indices` | Copernicus Sentinel data legal notice (free, full, open) | LOW | “Contains modified Copernicus Sentinel data [year]”. |
| `raw/jrc_gsw`, `derived/surface_water_jrc_gsw` | Copernicus, free without restriction | LOW | Attribution (EC JRC/Google). |
| `web/downloads/pune_mendeley/*`, `backend/data/diurnal/mendeley_*` | CC BY 4.0 | LOW | Attribution (Matange & Abraham). |
| `web/downloads/pune_refs/*` (CMP 2008/2018 reports, papers), `web/downloads/vp/nicmar.pdf`, `work/um-odme-scratch/arai.pdf` | UNKNOWN / publisher copyright (zenodo.pdf: CC BY 4.0) | **HIGH** for the PDFs | Reference copies only; never redistribute. |
| Cesium ion imagery / world terrain | Cesium ion ToS – streaming only | n/a (nothing stored) | Never cache/export. |

## 10. Proposed cleanup plan (NOT executed)

Run from any directory. Each step lists bytes reclaimed. Re-run `sha256sum` checks before deleting duplicates if anything changed since this audit.

### Step 0 — preconditions (copy, no deletion)
```bash
# restore the registered feasibility layers DB into the repo (sha256 must be 21924cea867eba0f89db2feabe1e092ce045a34bd1f66ec1e633b8f7f5be3f8e)
cp -p /workspace/work/uos-env-e2e/db/feasibility_layers.db /workspace/work/virtualplanner/backend/data/osm/feasibility_layers.db
sha256sum /workspace/work/virtualplanner/backend/data/osm/feasibility_layers.db
```

### Phase A — safe to delete now (4,927,925,382 B = 4.6 GiB)
```bash
# A1. OpenCity staging duplicates in web/downloads (98 files, 1,513,687,252 B); every file is sha256-identical to urbanos-data/raw/opencity_pune/2026-11-13/*
rm -- "/workspace/web/downloads/cc44fea1-9b26-434d-845b-bae31e4b3c3b-b9dfc0a6.csv"
rm -- "/workspace/web/downloads/bf2cf429-a2cc-432d-8877-c1bd8a81ea43-89c5d4dc.csv"
rm -- "/workspace/web/downloads/be079045-316a-4778-9bb8-3574120978c6-b5f00ce3.csv"
rm -- "/workspace/web/downloads/9d4847bb-7779-4edd-95bb-127a9c90e3b6 (1)-ebd3c7c7.csv"
rm -- "/workspace/web/downloads/9d4847bb-7779-4edd-95bb-127a9c90e3b6-d9024938.csv"
rm -- "/workspace/web/downloads/3733b659-d5a0-4cba-9591-9c72dcd297c6-ec62ebb3.csv"
rm -- "/workspace/web/downloads/f80bd708-7746-4e09-8f91-62dc55d31d34-dcbec09e.csv"
rm -- "/workspace/web/downloads/5490ebe1-a81b-4abb-a712-3da3992754bf-d0f0a7e0.csv"
rm -- "/workspace/web/downloads/0a20a244-1731-4f44-addc-56cd4a10d3bf-ea4e150c.csv"
rm -- "/workspace/web/downloads/a804de00-6e6f-41ae-aeef-769ef2db1f83-51c79d06.csv"
rm -- "/workspace/web/downloads/8c560da7-be95-4fc3-8ed6-a1b1d0b87512-b41a6015.csv"
rm -- "/workspace/web/downloads/28abdbf7-726c-475e-ad1d-b25819fbf74a-2149194f.csv"
rm -- "/workspace/web/downloads/d33ee2b8-b206-422c-8006-b1d99b3fe494-aa6a97e5.csv"
rm -- "/workspace/web/downloads/8052c6c0-c1a3-455e-a8d1-e7e2c5938472-3272e8e5.csv"
rm -- "/workspace/web/downloads/d3ab6046-986a-4aaa-8595-722089f99784-be92ed21.csv"
rm -- "/workspace/web/downloads/db5b5bcb-20f4-42df-89ee-85dee72446da (1)-d6d69fd4.csv"
rm -- "/workspace/web/downloads/db5b5bcb-20f4-42df-89ee-85dee72446da-5e16ef21.csv"
rm -- "/workspace/web/downloads/ca24d160-8b76-4215-bd66-61082476acd9-a135bb1e.csv"
rm -- "/workspace/web/downloads/4390b641-12ad-4438-bc6b-c938ea7ae5de-2f2ce66b.kmz"
rm -- "/workspace/web/downloads/pune-katraj-dairy-mpcb-2024-25-aec5830b.csv"
rm -- "/workspace/web/downloads/pmc_swd_chambers-0332a087.kml"
rm -- "/workspace/web/downloads/pune-bhumkar-nagar-iitm-2024-25-83057006.csv"
rm -- "/workspace/web/downloads/pune-karve-road-mpcb-2024-25-a1e5e020.csv"
rm -- "/workspace/web/downloads/pmc_sewage_pipeline-891222be.kmz"
rm -- "/workspace/web/downloads/20c62d61-11e7-4eee-8200-6dc0c3fe640b-c098b02e.kml"
rm -- "/workspace/web/downloads/pune-bhosari-iitm-2024-25-319a10fe.csv"
rm -- "/workspace/web/downloads/46c96db4-af62-4b84-a479-5a0279a8f44a-8f4f916c.kml"
rm -- "/workspace/web/downloads/pune-hadapsar-iitm-2024-25-9e060051.csv"
rm -- "/workspace/web/downloads/a76a14a9-07ce-4a36-bba5-8f8c12351c6b-1cb96444.kmz"
rm -- "/workspace/web/downloads/9bb3235e-e9db-485d-b303-68ef8fd6bcd7-48f763f3.kmz"
rm -- "/workspace/web/downloads/pune-alandi-iitm-2024-25-a60d67f9.csv"
rm -- "/workspace/web/downloads/58e49c60-4e2b-4238-9a3e-173d4abccbca-64552637.csv"
rm -- "/workspace/web/downloads/pmc_swd_utlitiy_chambers-f8bd3a1d.kml"
rm -- "/workspace/web/downloads/3f7228b1-092e-4c66-a62f-6895cf33fbcd-e66b1db1.kml"
rm -- "/workspace/web/downloads/pune-dhankawadi-iitm-2025-b2d3dd7b.csv"
rm -- "/workspace/web/downloads/06209242-c2c6-40f7-b70c-db0783cb7ccd-a20049c0.kml"
rm -- "/workspace/web/downloads/a97cdf95-402a-461b-8bd6-3eb55103ee91-d802e07a.kml"
rm -- "/workspace/web/downloads/74e8e3f7-d96a-4574-842b-e2d77c1db4fc-9b780151.csv"
rm -- "/workspace/web/downloads/bbbd1d45-23fd-442c-8b1d-6fc48a1064a0-8db3f3b5.kml"
rm -- "/workspace/web/downloads/b26b0ee3-60a3-4f1a-a45c-94b24fb9434a-3ce612b7.kml"
rm -- "/workspace/web/downloads/f1d88eea-0aab-4d8c-8c23-2acc84c1bd6a-9af9d9bc.kml"
rm -- "/workspace/web/downloads/905dfc93-7e5e-4821-b6ef-86b4f49f14b1-6195c2da.csv"
rm -- "/workspace/web/downloads/f421cdb4-57de-42ad-bd16-0bfd54e79cae-145ef487.csv"
rm -- "/workspace/web/downloads/24b7649d-0039-4dee-872a-621fa2b129d2-6f709a4b.kml"
rm -- "/workspace/web/downloads/611403c6-d9cf-4736-b33d-0626965ae50d-80144b72.csv"
rm -- "/workspace/web/downloads/b7a3f392-238c-4c55-a3ed-0c13fd4aaa0a-b2a8c644.kml"
rm -- "/workspace/web/downloads/882111ee-f944-4bff-b796-7baf97cf55a6-9cfc0ec3.kml"
rm -- "/workspace/web/downloads/697e0d85-930c-4990-972f-1ad9eac2db05-30035000.csv"
rm -- "/workspace/web/downloads/fbf99e33-887b-4a97-8861-fe44d24cb48a-563e6438.csv"
rm -- "/workspace/web/downloads/10d58630-44a1-49a5-a168-e0b4a7368081-8ac05bdd.csv"
rm -- "/workspace/web/downloads/c91c0878-b4f9-419f-8d7c-97eb6c7a9083-0570a5df.csv"
rm -- "/workspace/web/downloads/pmc_cremation_grounds-c67f1b98.kml"
rm -- "/workspace/web/downloads/3db44ac9-ef90-41c4-b915-ff751de81679-2f232a97.csv"
rm -- "/workspace/web/downloads/a9407013-dba4-48fe-afda-bb951f4f3cfe-81bfb8a8.csv"
rm -- "/workspace/web/downloads/7ac0c4c7-01a3-4311-8617-41a0b1cf03d9-a7598052.csv"
rm -- "/workspace/web/downloads/6c9be432-4a82-4661-972f-e4ac9be0d252-23e5fcd5.csv"
rm -- "/workspace/web/downloads/117354a8-7bea-4ebe-9aa4-560fcb877aa6-c04791a0.csv"
rm -- "/workspace/web/downloads/5ec1c512-c3f1-4ef6-81eb-4a5147241377-d21b0aec.csv"
rm -- "/workspace/web/downloads/b408de88-b9f0-48ad-af37-d6554088fb8d-ff35119e.kml"
rm -- "/workspace/web/downloads/b0d9ef1f-14d7-4c93-a498-3ffb7c86737c-db3ed5dc.kml"
rm -- "/workspace/web/downloads/3121d40a-a37e-4936-86ce-c1872bf9446c-ea90f628.kml"
rm -- "/workspace/web/downloads/9beb555b-b3b8-4f3b-947c-b33ba33615a5-9ff76158.kml"
rm -- "/workspace/web/downloads/1384de7a-99ea-4d61-8cdb-bee9f5554551-9aa7ef7e.csv"
rm -- "/workspace/web/downloads/fcaa315c-2d63-42ad-81b6-07e7c02debf4-c7f65c24.csv"
rm -- "/workspace/web/downloads/bce229f1-23a9-4805-acd0-e21a6c72691b-04d23913.csv"
rm -- "/workspace/web/downloads/932cbc17-1ef0-4c1c-ada6-fa63221b4459-95dd1aee.csv"
rm -- "/workspace/web/downloads/6a6d0a58-9d4e-442b-a473-9ce40c271cae-a28543d9.csv"
rm -- "/workspace/web/downloads/2ca165f9-5e5b-4bd0-8a5d-f4e4ad40744c-8b51eaba.csv"
rm -- "/workspace/web/downloads/edd85f6d-6b53-47ed-8221-8e2ca22c4eee-fa318f3c.csv"
rm -- "/workspace/web/downloads/d185bb0c-2307-4a7d-9106-11cd61570165-4d2c6025.kml"
rm -- "/workspace/web/downloads/aa1addf9-77d6-4990-b65c-20f0439fa1f5-6dcbdae6.csv"
rm -- "/workspace/web/downloads/aa134345-e92d-4eab-9485-416b48e576cc-4258f417.csv"
rm -- "/workspace/web/downloads/d8a3e772-2d5d-4e19-bbb0-fe04915c96aa-3a1d1677.csv"
rm -- "/workspace/web/downloads/ca9dc822-ba6d-49da-8f19-bb504a4c2fbd-cceee89c.csv"
rm -- "/workspace/web/downloads/1ae309d5-fd61-49d3-a57c-200519791ec8-50871bf8.csv"
rm -- "/workspace/web/downloads/17f84424-1769-45a2-84d5-76f0089f7e3a-82d9074f.kml"
rm -- "/workspace/web/downloads/6e3b9e85-8e0f-4c9f-8ae3-378b63b29aab-d1a2ec18.csv"
rm -- "/workspace/web/downloads/76785b37-893d-4c11-ac39-ad4dfb5e2db8-0c7c85eb.csv"
rm -- "/workspace/web/downloads/56d3f45a-73d8-42b1-8b49-6360a393dc83-3549ae58.csv"
rm -- "/workspace/web/downloads/422ee293-5102-4e9b-94bb-53716e7640cb-1a077bec.csv"
rm -- "/workspace/web/downloads/26eb7645-7ab7-4940-a8bb-e9ce0e76042e-5ba96c05.csv"
rm -- "/workspace/web/downloads/b04cc181-c7b2-4082-aace-817be8f4cc98-69a930a3.csv"
rm -- "/workspace/web/downloads/6a9f1d50-db92-4cfa-9da4-e8b335bf7b63-f8d90693.csv"
rm -- "/workspace/web/downloads/bdba1205-b27e-4ffe-bfa2-24fcf5d5d453-959a964c.csv"
rm -- "/workspace/web/downloads/be6efc3d-d549-4073-a582-8c87d6b0df7d-14850f29.csv"
rm -- "/workspace/web/downloads/bbec3f00-e6cf-45bf-88fa-3808c4737ba0-65594f9a.csv"
rm -- "/workspace/web/downloads/ad3c3c8a-6df0-4297-86cc-5db40b7ac3f9-430191bf.csv"
rm -- "/workspace/web/downloads/a7f9edd5-8709-4022-bae6-8197274886e5-a78e812a.csv"
rm -- "/workspace/web/downloads/6ef882ea-3421-4937-999a-a0ced5023db5-f12b0752.csv"
rm -- "/workspace/web/downloads/5148c621-ba7f-4b98-bc6c-66aedbefa059-11913fca.csv"
rm -- "/workspace/web/downloads/634d3dd6-9f05-41b0-90fc-296fe724b18d-fbf3dc7b.csv"
rm -- "/workspace/web/downloads/d27e7726-1321-426a-9cb3-8a20d9707cc9-ddef1dd6.csv"
rm -- "/workspace/web/downloads/8ac18a93-8941-4afa-8db2-a9b972ad78c2-0872c9cb.csv"
rm -- "/workspace/web/downloads/f973a508-9638-4a9d-9277-5c2f8edf94aa-4d81b75e.csv"
rm -- "/workspace/web/downloads/ce0ec751-8caa-4aa5-a2a4-d1746c9a2d6a-8cebeb47.csv"
rm -- "/workspace/web/downloads/e0eb81c3-901e-4126-a5b5-3d216672bfd4-ec2d574d.csv"
rm -- "/workspace/web/downloads/6e691ac8-99d4-4f1f-aab6-2d08f828b4c8-b7d3653e.csv"
rm -- "/workspace/web/downloads/83e4a2e3-9e6c-4714-b1fe-933293d8f622-0b62e5c7.csv"
# A2. unzipped Mendeley copy (1,812,118,340 B); traffic.zip kept
rm -rf -- "/workspace/web/downloads/pune_mendeley/traffic"
# A3. failed downloads (HTML error pages)
rm -- "/workspace/web/downloads/pune_refs/iisc14.pdf" "/workspace/web/downloads/pune_refs/pdfcoffee.html"
# A4. merged git worktrees (patches already in HEAD)
git -C /workspace/work/virtualplanner worktree remove /workspace/work/uos-wt-qa2
git -C /workspace/work/virtualplanner worktree remove /workspace/work/uos-wt-qa3
# A5. harness / scratch dirs with no registry dependency and no doc citations
rm -rf -- "/workspace/work/coep2-scratch"   # 63,384,488 B
rm -rf -- "/workspace/work/prof"   # 2,488,425 B
rm -rf -- "/workspace/work/um-suite"   # 199,098 B
rm -rf -- "/workspace/work/uos-qa"   # 137,845 B
rm -rf -- "/workspace/work/uos-terrain-e2e"   # 65,148,234 B
rm -rf -- "/workspace/work/uos-wt-vt-logs"   # 208,443 B
rm -rf -- "/workspace/work/urbanos/tools-e2e"   # 14,591,506 B
rm -rf -- "/workspace/work/vp-conn"   # 89,861,831 B
rm -rf -- "/workspace/work/vp-final2-logs"   # 131,733 B
rm -rf -- "/workspace/work/vp-int-logs"   # 373,221 B
rm -rf -- "/workspace/work/vp-junc3"   # 384,226,864 B
rm -rf -- "/workspace/work/vp-logs"   # 163,790 B
rm -rf -- "/workspace/work/vp-sev-e2e"   # 91,834,090 B
rm -rf -- "/workspace/work/vp-sev2-e2e"   # 95,249,369 B
rm -rf -- "/workspace/work/vp-shiv-e2e"   # 91,957,043 B
rm -rf -- "/workspace/work/vp-shiv-scratch"   # 6,723,272 B
rm -rf -- "/workspace/work/vp-shots"   # 227,220,642 B
rm -rf -- "/workspace/work/vp-wt-day-e2e"   # 63,510,819 B
rm -rf -- "/workspace/work/vp-wt-final-e2e"   # 98,419,755 B
rm -rf -- "/workspace/work/vp-wt-merged-e2e"   # 63,550,687 B
rm -rf -- "/workspace/work/vp-wt-recompute-e2e"   # 77,371,204 B
rm -rf -- "/workspace/work/vp-wt-scope-e2e"   # 77,459,785 B
rm -rf -- "/workspace/work/vp-wt-sim-scratch"   # 1,018,487 B
rm -rf -- "/workspace/work/vp-wt-verify-e2e"   # 63,517,182 B
rm -rf -- "/workspace/work/vt-final"   # 436 B
```

### Phase B — delete only after the stated condition (4,569,897,109 B = 4.3 GiB)

| Condition | Bytes | Command |
|---|---:|---|
| delete only after Phase-2 sign-off | 18,903,040 | `rm -rf -- "/workspace/work/twincity.before-road-analysis.db"` |
| delete only after Phase-2 sign-off (pre-change backup) | 49,106,944 | `rm -rf -- "/workspace/work/twincity.db.bak-2026-11-13"` |
| delete only after QA cycle closed (before.db is a pre-change DB snapshot) | 288,708,498 | `rm -rf -- "/workspace/work/qac"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 64,790,548 | `rm -rf -- "/workspace/work/um-ui-e2e"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 65,054,086 | `rm -rf -- "/workspace/work/um-ws-run"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 136,850,074 | `rm -rf -- "/workspace/work/uos-mon-run"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 64,239,741 | `rm -rf -- "/workspace/work/uos-proj-e2e"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 70,189,555 | `rm -rf -- "/workspace/work/uos-shell-e2e"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 64,289,028 | `rm -rf -- "/workspace/work/uos-ug-e2e"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 63,540,287 | `rm -rf -- "/workspace/work/vp-jx2"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 63,863,681 | `rm -rf -- "/workspace/work/vp-ux-e2e"` |
| delete only after docs evidence archived (path cited 1× in repo docs) | 72,665,872 | `rm -rf -- "/workspace/work/vp-ux2-e2e"` |
| delete only after docs evidence archived (path cited 1× in repo docs) and feasibility_layers.db restored to backend/data/osm | 72,586,764 | `rm -rf -- "/workspace/work/uos-polish-e2e"` |
| delete only after docs evidence archived (path cited 1× in repo docs) and its notes (README.md) are archived | 63,292,963 | `rm -rf -- "/workspace/work/vp-conn-e2e"` |
| delete only after docs evidence archived (path cited 1× in repo docs) and its notes (doc_head.md, doc_mid1.md, doc_mid2a.md, doc_mid2b.md, doc_mid2c.md, doc_mid2d.md) are archived | 79,752,423 | `rm -rf -- "/workspace/work/um-val-run"` |
| delete only after docs evidence archived (path cited 1× in repo docs) and its notes (table.md) are archived | 113,260 | `rm -rf -- "/workspace/work/um-topo2-e2e"` |
| delete only after docs evidence archived (path cited 2× in repo docs) | 49,939,495 | `rm -rf -- "/workspace/work/um-data-run"` |
| delete only after docs evidence archived (path cited 2× in repo docs) | 66,321,897 | `rm -rf -- "/workspace/work/um-scen-run"` |
| delete only after docs evidence archived (path cited 2× in repo docs) | 68,041,335 | `rm -rf -- "/workspace/work/uos-dsi-run"` |
| delete only after docs evidence archived (path cited 2× in repo docs) | 373,956 | `rm -rf -- "/workspace/work/vp-merge-e2e"` |
| delete only after docs evidence archived (path cited 2× in repo docs) | 148,724,375 | `rm -rf -- "/workspace/work/vp-wt-edit-e2e"` |
| delete only after docs evidence archived (path cited 2× in repo docs) | 73,387,954 | `rm -rf -- "/workspace/work/vp-wt-edit2-e2e"` |
| delete only after docs evidence archived (path cited 2× in repo docs) | 63,642,986 | `rm -rf -- "/workspace/work/vp-wt-fix3-e2e"` |
| delete only after docs evidence archived (path cited 2× in repo docs) and feasibility_layers.db restored to backend/data/osm | 77,453,052 | `rm -rf -- "/workspace/work/uos-qa-e2e"` |
| delete only after docs evidence archived (path cited 2× in repo docs) and its notes (README.md) are archived | 63,813,201 | `rm -rf -- "/workspace/work/vp-wt-junc-e2e"` |
| delete only after docs evidence archived (path cited 3× in repo docs) | 65,581,498 | `rm -rf -- "/workspace/work/um-gen-run"` |
| delete only after docs evidence archived (path cited 3× in repo docs) | 78,612,106 | `rm -rf -- "/workspace/work/um-topo-e2e"` |
| delete only after docs evidence archived (path cited 3× in repo docs) | 120,474,032 | `rm -rf -- "/workspace/work/vp-shiv2-e2e"` |
| delete only after docs evidence archived (path cited 3× in repo docs) and feasibility_layers.db restored to backend/data/osm | 74,843,645 | `rm -rf -- "/workspace/work/um-feas-run"` |
| delete only after docs evidence archived (path cited 3× in repo docs) and feasibility_layers.db restored to backend/data/osm | 72,149,450 | `rm -rf -- "/workspace/work/um-smoke-run"` |
| delete only after docs evidence archived (path cited 4× in repo docs) and feasibility_layers.db restored to backend/data/osm | 72,476,191 | `rm -rf -- "/workspace/work/uos-env-e2e"` |
| delete only after docs evidence archived (path cited 5× in repo docs) and its notes (sec20.md) are archived | 63,926,200 | `rm -rf -- "/workspace/work/vp-final2-e2e"` |
| delete only after docs evidence archived (path cited 6× in repo docs) | 124,070,549 | `rm -rf -- "/workspace/work/um-odme-run"` |
| delete only after docs evidence archived (path cited 6× in repo docs) | 83,204,047 | `rm -rf -- "/workspace/work/vp-overhaul-shots"` |
| delete only after docs evidence archived (path cited 7× in repo docs) | 425,145,662 | `rm -rf -- "/workspace/work/vp-int-e2e"` |
| delete only after docs evidence archived (urbanos dir cited in docs) | 186,922,805 | `rm -rf -- "/workspace/work/urbanos/shots"` |
| delete only after feasibility_layers.db restored to backend/data/osm | 76,698,387 | `rm -rf -- "/workspace/work/uos-envdata-e2e"` |
| delete only after feasibility_layers.db restored to backend/data/osm | 159,833,011 | `rm -rf -- "/workspace/work/uos-infra-e2e"` |
| delete only after feasibility_layers.db restored to backend/data/osm | 161,011,937 | `rm -rf -- "/workspace/work/uos-qa2-e2e"` |
| delete only after feasibility_layers.db restored to backend/data/osm | 166,646,871 | `rm -rf -- "/workspace/work/uos-qa3-e2e"` |
| delete only after feasibility_layers.db restored to backend/data/osm | 311,503,251 | `rm -rf -- "/workspace/work/uos-qab-e2e"` |
| delete only after its notes (BUGS_FIXED.md, COMMIT_AGENT_NOTES.md, FINDINGS.md) are archived | 363,323,707 | `rm -rf -- "/workspace/work/vp-overhaul"` |
| delete only after its notes (sec24_final.md, sec24_tables.md) are archived | 835,132 | `rm -rf -- "/workspace/work/doc24tmp"` |
| delete only after the code/UI audit closes and feasibility_layers.db is restored | 71,861,783 | `rm -rf -- "/workspace/work/urbanos/audit/e2e"` |
| delete only after v3 review decision AND v2 registry row marked superseded/withdrawn | 41,131,830 | `rm -rf -- "/workspace/work/urbanos-data/derived/elevation_copdem30/v2"` |

Keep: everything under `urbanos-data/raw`, all active derived versions, elevation v1 (until v3 promoted) and v3, repo `backend/data/**`, `backend/twincity.db`, `twincity.db.bak-2026-11-14-pre-dem-v3`, `uos-dem-compare/`, OpenCity CKAN PDFs, Mendeley zip/docs, reference PDFs.

**Total reclaimable: 9,497,822,491 B (8.8 GiB)** — 4.6 GiB immediately, 4.3 GiB after preconditions.

## Appendix A — OpenCity staging duplicates (web/downloads → raw)

| web/downloads file | Bytes | Identical raw file (`urbanos-data/raw/opencity_pune/2026-11-13/`) | sha256 (16) |
|---|---:|---|---|
| `cc44fea1-9b26-434d-845b-bae31e4b3c3b-b9dfc0a6.csv` | 81,840,451 | `cc44fea1-9b26-434d-845b-bae31e4b3c3b.csv` | 9b9c8519df6810ae |
| `bf2cf429-a2cc-432d-8877-c1bd8a81ea43-89c5d4dc.csv` | 78,803,302 | `bf2cf429-a2cc-432d-8877-c1bd8a81ea43.csv` | bcdb0761588682df |
| `be079045-316a-4778-9bb8-3574120978c6-b5f00ce3.csv` | 78,481,091 | `be079045-316a-4778-9bb8-3574120978c6.csv` | f04622777ee8e6bf |
| `9d4847bb-7779-4edd-95bb-127a9c90e3b6 (1)-ebd3c7c7.csv` | 77,191,225 | `9d4847bb-7779-4edd-95bb-127a9c90e3b6.csv` | b5fbca0321df5178 |
| `9d4847bb-7779-4edd-95bb-127a9c90e3b6-d9024938.csv` | 77,191,225 | `9d4847bb-7779-4edd-95bb-127a9c90e3b6.csv` | b5fbca0321df5178 |
| `3733b659-d5a0-4cba-9591-9c72dcd297c6-ec62ebb3.csv` | 77,167,851 | `3733b659-d5a0-4cba-9591-9c72dcd297c6.csv` | 9de817da211d4788 |
| `f80bd708-7746-4e09-8f91-62dc55d31d34-dcbec09e.csv` | 76,962,528 | `f80bd708-7746-4e09-8f91-62dc55d31d34.csv` | ec48efe188ea9df3 |
| `5490ebe1-a81b-4abb-a712-3da3992754bf-d0f0a7e0.csv` | 76,868,702 | `5490ebe1-a81b-4abb-a712-3da3992754bf.csv` | e518b7b288af9a81 |
| `0a20a244-1731-4f44-addc-56cd4a10d3bf-ea4e150c.csv` | 76,808,237 | `0a20a244-1731-4f44-addc-56cd4a10d3bf.csv` | 2e01389ff4fb9a32 |
| `a804de00-6e6f-41ae-aeef-769ef2db1f83-51c79d06.csv` | 76,752,424 | `a804de00-6e6f-41ae-aeef-769ef2db1f83.csv` | 9e03df9533e4ac79 |
| `8c560da7-be95-4fc3-8ed6-a1b1d0b87512-b41a6015.csv` | 76,693,181 | `8c560da7-be95-4fc3-8ed6-a1b1d0b87512.csv` | d47fd635a22a2ca6 |
| `28abdbf7-726c-475e-ad1d-b25819fbf74a-2149194f.csv` | 76,673,781 | `28abdbf7-726c-475e-ad1d-b25819fbf74a.csv` | f0d15b89dadbba86 |
| `d33ee2b8-b206-422c-8006-b1d99b3fe494-aa6a97e5.csv` | 76,235,171 | `d33ee2b8-b206-422c-8006-b1d99b3fe494.csv` | d99aa513b83e3871 |
| `8052c6c0-c1a3-455e-a8d1-e7e2c5938472-3272e8e5.csv` | 76,011,238 | `8052c6c0-c1a3-455e-a8d1-e7e2c5938472.csv` | 303407641f64e84b |
| `d3ab6046-986a-4aaa-8595-722089f99784-be92ed21.csv` | 75,905,977 | `d3ab6046-986a-4aaa-8595-722089f99784.csv` | a795fb8c18ae5796 |
| `db5b5bcb-20f4-42df-89ee-85dee72446da (1)-d6d69fd4.csv` | 75,709,757 | `db5b5bcb-20f4-42df-89ee-85dee72446da.csv` | f711f91b8f4d77b3 |
| `db5b5bcb-20f4-42df-89ee-85dee72446da-5e16ef21.csv` | 75,709,757 | `db5b5bcb-20f4-42df-89ee-85dee72446da.csv` | f711f91b8f4d77b3 |
| `ca24d160-8b76-4215-bd66-61082476acd9-a135bb1e.csv` | 75,641,050 | `ca24d160-8b76-4215-bd66-61082476acd9.csv` | a1dfac3fec09056e |
| `4390b641-12ad-4438-bc6b-c938ea7ae5de-2f2ce66b.kmz` | 22,184,109 | `4390b641-12ad-4438-bc6b-c938ea7ae5de.kmz` | 46dc617d4aa9c703 |
| `pune-katraj-dairy-mpcb-2024-25-aec5830b.csv` | 12,392,945 | `pune-katraj-dairy-mpcb-2024-25.csv` | 5c630d31699d5365 |
| `pmc_swd_chambers-0332a087.kml` | 11,797,881 | `pmc_swd_chambers.kml` | b0f09ed8d495ad4d |
| `pune-bhumkar-nagar-iitm-2024-25-83057006.csv` | 11,151,401 | `pune-bhumkar-nagar-iitm-2024-25.csv` | 82ce36fdbe9586d3 |
| `pune-karve-road-mpcb-2024-25-a1e5e020.csv` | 10,104,589 | `pune-karve-road-mpcb-2024-25.csv` | b8e538746f52a09a |
| `pmc_sewage_pipeline-891222be.kmz` | 8,233,433 | `pmc_sewage_pipeline.kmz` | a322e1d510e36bb5 |
| `20c62d61-11e7-4eee-8200-6dc0c3fe640b-c098b02e.kml` | 6,758,124 | `20c62d61-11e7-4eee-8200-6dc0c3fe640b.kml` | 5a0f9c4f7cf4de6d |
| `pune-bhosari-iitm-2024-25-319a10fe.csv` | 5,533,047 | `pune-bhosari-iitm-2024-25.csv` | 520e5fc73db3f06a |
| `46c96db4-af62-4b84-a479-5a0279a8f44a-8f4f916c.kml` | 5,065,991 | `46c96db4-af62-4b84-a479-5a0279a8f44a.kml` | 297000e1fdb55585 |
| `pune-hadapsar-iitm-2024-25-9e060051.csv` | 4,356,470 | `pune-hadapsar-iitm-2024-25.csv` | 386590d5a7c333d0 |
| `a76a14a9-07ce-4a36-bba5-8f8c12351c6b-1cb96444.kmz` | 3,947,453 | `a76a14a9-07ce-4a36-bba5-8f8c12351c6b.kmz` | 0813bd34d91d5b1c |
| `9bb3235e-e9db-485d-b303-68ef8fd6bcd7-48f763f3.kmz` | 3,937,838 | `9bb3235e-e9db-485d-b303-68ef8fd6bcd7.kmz` | 5ac370ef0504741c |
| `pune-alandi-iitm-2024-25-a60d67f9.csv` | 3,833,770 | `pune-alandi-iitm-2024-25.csv` | d01c3c285f92cc4d |
| `58e49c60-4e2b-4238-9a3e-173d4abccbca-64552637.csv` | 2,904,344 | `58e49c60-4e2b-4238-9a3e-173d4abccbca.csv` | 76ca08b6fc170c4f |
| `pmc_swd_utlitiy_chambers-f8bd3a1d.kml` | 2,774,676 | `pmc_swd_utlitiy_chambers.kml` | c9d96d2e0da7ec5b |
| `3f7228b1-092e-4c66-a62f-6895cf33fbcd-e66b1db1.kml` | 2,761,475 | `3f7228b1-092e-4c66-a62f-6895cf33fbcd.kml` | 97991846b24cc396 |
| `pune-dhankawadi-iitm-2025-b2d3dd7b.csv` | 2,596,505 | `pune-dhankawadi-iitm-2025.csv` | 0defe2f353e1191c |
| `06209242-c2c6-40f7-b70c-db0783cb7ccd-a20049c0.kml` | 1,019,386 | `06209242-c2c6-40f7-b70c-db0783cb7ccd.kml` | 24935f2685cb0afb |
| `a97cdf95-402a-461b-8bd6-3eb55103ee91-d802e07a.kml` | 983,023 | `a97cdf95-402a-461b-8bd6-3eb55103ee91.kml` | 741076ca8df55877 |
| `74e8e3f7-d96a-4574-842b-e2d77c1db4fc-9b780151.csv` | 615,249 | `74e8e3f7-d96a-4574-842b-e2d77c1db4fc.csv` | ffa9936b75b0ee54 |
| `bbbd1d45-23fd-442c-8b1d-6fc48a1064a0-8db3f3b5.kml` | 461,901 | `bbbd1d45-23fd-442c-8b1d-6fc48a1064a0.kml` | e9b2f9f0e8711150 |
| `b26b0ee3-60a3-4f1a-a45c-94b24fb9434a-3ce612b7.kml` | 278,633 | `b26b0ee3-60a3-4f1a-a45c-94b24fb9434a.kml` | 41f225b4da0e2fc8 |
| `f1d88eea-0aab-4d8c-8c23-2acc84c1bd6a-9af9d9bc.kml` | 271,656 | `f1d88eea-0aab-4d8c-8c23-2acc84c1bd6a.kml` | ee70d034575f2bdd |
| `905dfc93-7e5e-4821-b6ef-86b4f49f14b1-6195c2da.csv` | 269,210 | `905dfc93-7e5e-4821-b6ef-86b4f49f14b1.csv` | 567cdece34d22d0f |
| `f421cdb4-57de-42ad-bd16-0bfd54e79cae-145ef487.csv` | 221,666 | `f421cdb4-57de-42ad-bd16-0bfd54e79cae.csv` | 76ba60a60f0dd0a1 |
| `24b7649d-0039-4dee-872a-621fa2b129d2-6f709a4b.kml` | 218,820 | `24b7649d-0039-4dee-872a-621fa2b129d2.kml` | 8eec5d51170fe9ec |
| `611403c6-d9cf-4736-b33d-0626965ae50d-80144b72.csv` | 218,697 | `611403c6-d9cf-4736-b33d-0626965ae50d.csv` | 337888b6fad009de |
| `b7a3f392-238c-4c55-a3ed-0c13fd4aaa0a-b2a8c644.kml` | 191,370 | `b7a3f392-238c-4c55-a3ed-0c13fd4aaa0a.kml` | d4b781697d9fb327 |
| `882111ee-f944-4bff-b796-7baf97cf55a6-9cfc0ec3.kml` | 183,463 | `882111ee-f944-4bff-b796-7baf97cf55a6.kml` | 2ba961b444654c9b |
| `697e0d85-930c-4990-972f-1ad9eac2db05-30035000.csv` | 145,157 | `697e0d85-930c-4990-972f-1ad9eac2db05.csv` | 072d5d1a767d3e89 |
| `fbf99e33-887b-4a97-8861-fe44d24cb48a-563e6438.csv` | 136,965 | `fbf99e33-887b-4a97-8861-fe44d24cb48a.csv` | aa8d2c4472089288 |
| `10d58630-44a1-49a5-a168-e0b4a7368081-8ac05bdd.csv` | 136,960 | `10d58630-44a1-49a5-a168-e0b4a7368081.csv` | 3e836b2b0b8932c3 |
| `c91c0878-b4f9-419f-8d7c-97eb6c7a9083-0570a5df.csv` | 115,593 | `c91c0878-b4f9-419f-8d7c-97eb6c7a9083.csv` | 932653d6c3b3a0d9 |
| `pmc_cremation_grounds-c67f1b98.kml` | 113,694 | `pmc_cremation_grounds.kml` | d985e3d8427f0b55 |
| `3db44ac9-ef90-41c4-b915-ff751de81679-2f232a97.csv` | 108,982 | `3db44ac9-ef90-41c4-b915-ff751de81679.csv` | 1ccd767e4810f838 |
| `a9407013-dba4-48fe-afda-bb951f4f3cfe-81bfb8a8.csv` | 105,994 | `a9407013-dba4-48fe-afda-bb951f4f3cfe.csv` | df9b8d5a034f58a6 |
| `7ac0c4c7-01a3-4311-8617-41a0b1cf03d9-a7598052.csv` | 101,861 | `7ac0c4c7-01a3-4311-8617-41a0b1cf03d9.csv` | 5fd0710d3081569a |
| `6c9be432-4a82-4661-972f-e4ac9be0d252-23e5fcd5.csv` | 101,772 | `6c9be432-4a82-4661-972f-e4ac9be0d252.csv` | d7603bd882bb63b6 |
| `117354a8-7bea-4ebe-9aa4-560fcb877aa6-c04791a0.csv` | 93,804 | `117354a8-7bea-4ebe-9aa4-560fcb877aa6.csv` | 22b3e365bc53d645 |
| `5ec1c512-c3f1-4ef6-81eb-4a5147241377-d21b0aec.csv` | 93,649 | `5ec1c512-c3f1-4ef6-81eb-4a5147241377.csv` | d894cf235c259907 |
| `b408de88-b9f0-48ad-af37-d6554088fb8d-ff35119e.kml` | 90,934 | `b408de88-b9f0-48ad-af37-d6554088fb8d.kml` | f0525fd9a4defdc0 |
| `b0d9ef1f-14d7-4c93-a498-3ffb7c86737c-db3ed5dc.kml` | 70,784 | `b0d9ef1f-14d7-4c93-a498-3ffb7c86737c.kml` | cc994ff0612563f2 |
| `3121d40a-a37e-4936-86ce-c1872bf9446c-ea90f628.kml` | 36,987 | `3121d40a-a37e-4936-86ce-c1872bf9446c.kml` | 8c8cab23359eeb83 |
| `9beb555b-b3b8-4f3b-947c-b33ba33615a5-9ff76158.kml` | 35,788 | `9beb555b-b3b8-4f3b-947c-b33ba33615a5.kml` | 9ed406abc40be7df |
| `1384de7a-99ea-4d61-8cdb-bee9f5554551-9aa7ef7e.csv` | 33,572 | `1384de7a-99ea-4d61-8cdb-bee9f5554551.csv` | d8c0ebe531e34080 |
| `fcaa315c-2d63-42ad-81b6-07e7c02debf4-c7f65c24.csv` | 28,504 | `fcaa315c-2d63-42ad-81b6-07e7c02debf4.csv` | bd7a9c3e6135976f |
| `bce229f1-23a9-4805-acd0-e21a6c72691b-04d23913.csv` | 27,570 | `bce229f1-23a9-4805-acd0-e21a6c72691b.csv` | d47760fa5c9cc2a8 |
| `932cbc17-1ef0-4c1c-ada6-fa63221b4459-95dd1aee.csv` | 25,482 | `932cbc17-1ef0-4c1c-ada6-fa63221b4459.csv` | 8ac9486376f05e1f |
| `6a6d0a58-9d4e-442b-a473-9ce40c271cae-a28543d9.csv` | 21,781 | `6a6d0a58-9d4e-442b-a473-9ce40c271cae.csv` | 6682501dae81e34e |
| `2ca165f9-5e5b-4bd0-8a5d-f4e4ad40744c-8b51eaba.csv` | 18,686 | `2ca165f9-5e5b-4bd0-8a5d-f4e4ad40744c.csv` | 7856686907814984 |
| `edd85f6d-6b53-47ed-8221-8e2ca22c4eee-fa318f3c.csv` | 15,875 | `edd85f6d-6b53-47ed-8221-8e2ca22c4eee.csv` | d481f61d04862abb |
| `d185bb0c-2307-4a7d-9106-11cd61570165-4d2c6025.kml` | 12,990 | `d185bb0c-2307-4a7d-9106-11cd61570165.kml` | 2e1a8a52db5d7464 |
| `aa1addf9-77d6-4990-b65c-20f0439fa1f5-6dcbdae6.csv` | 12,796 | `aa1addf9-77d6-4990-b65c-20f0439fa1f5.csv` | 84b47692d99abc13 |
| `aa134345-e92d-4eab-9485-416b48e576cc-4258f417.csv` | 10,727 | `aa134345-e92d-4eab-9485-416b48e576cc.csv` | 99062d5b6f61dd20 |
| `d8a3e772-2d5d-4e19-bbb0-fe04915c96aa-3a1d1677.csv` | 10,486 | `d8a3e772-2d5d-4e19-bbb0-fe04915c96aa.csv` | fbb6cd74c1c7530f |
| `ca9dc822-ba6d-49da-8f19-bb504a4c2fbd-cceee89c.csv` | 10,057 | `ca9dc822-ba6d-49da-8f19-bb504a4c2fbd.csv` | fe73b077f659e552 |
| `1ae309d5-fd61-49d3-a57c-200519791ec8-50871bf8.csv` | 7,722 | `1ae309d5-fd61-49d3-a57c-200519791ec8.csv` | 28c14b7e9197d9a7 |
| `17f84424-1769-45a2-84d5-76f0089f7e3a-82d9074f.kml` | 7,618 | `17f84424-1769-45a2-84d5-76f0089f7e3a.kml` | df2c0883c7c6c9a7 |
| `6e3b9e85-8e0f-4c9f-8ae3-378b63b29aab-d1a2ec18.csv` | 5,509 | `6e3b9e85-8e0f-4c9f-8ae3-378b63b29aab.csv` | 0535ab1b77be32ea |
| `76785b37-893d-4c11-ac39-ad4dfb5e2db8-0c7c85eb.csv` | 4,958 | `76785b37-893d-4c11-ac39-ad4dfb5e2db8.csv` | 26f6b91bc0c5275b |
| `56d3f45a-73d8-42b1-8b49-6360a393dc83-3549ae58.csv` | 3,610 | `56d3f45a-73d8-42b1-8b49-6360a393dc83.csv` | ecc91f90feb2eff3 |
| `422ee293-5102-4e9b-94bb-53716e7640cb-1a077bec.csv` | 3,594 | `422ee293-5102-4e9b-94bb-53716e7640cb.csv` | d035b96d449c4c28 |
| `26eb7645-7ab7-4940-a8bb-e9ce0e76042e-5ba96c05.csv` | 3,399 | `26eb7645-7ab7-4940-a8bb-e9ce0e76042e.csv` | e46efe7c8fe3d8b5 |
| `b04cc181-c7b2-4082-aace-817be8f4cc98-69a930a3.csv` | 2,883 | `b04cc181-c7b2-4082-aace-817be8f4cc98.csv` | d1be257b1cd4b12c |
| `6a9f1d50-db92-4cfa-9da4-e8b335bf7b63-f8d90693.csv` | 2,688 | `6a9f1d50-db92-4cfa-9da4-e8b335bf7b63.csv` | d99920ce52866a1f |
| `bdba1205-b27e-4ffe-bfa2-24fcf5d5d453-959a964c.csv` | 2,346 | `bdba1205-b27e-4ffe-bfa2-24fcf5d5d453.csv` | 8c4d6e6fa1447876 |
| `be6efc3d-d549-4073-a582-8c87d6b0df7d-14850f29.csv` | 1,387 | `be6efc3d-d549-4073-a582-8c87d6b0df7d.csv` | 8ed4282901e27bb3 |
| `bbec3f00-e6cf-45bf-88fa-3808c4737ba0-65594f9a.csv` | 1,366 | `bbec3f00-e6cf-45bf-88fa-3808c4737ba0.csv` | bbfd6a1cb996efae |
| `ad3c3c8a-6df0-4297-86cc-5db40b7ac3f9-430191bf.csv` | 1,107 | `ad3c3c8a-6df0-4297-86cc-5db40b7ac3f9.csv` | 220070d9f75a6c01 |
| `a7f9edd5-8709-4022-bae6-8197274886e5-a78e812a.csv` | 1,041 | `a7f9edd5-8709-4022-bae6-8197274886e5.csv` | 4ba6159dcbeb91f9 |
| `6ef882ea-3421-4937-999a-a0ced5023db5-f12b0752.csv` | 1,027 | `6ef882ea-3421-4937-999a-a0ced5023db5.csv` | cbbd25f911d1a4ca |
| `5148c621-ba7f-4b98-bc6c-66aedbefa059-11913fca.csv` | 958 | `5148c621-ba7f-4b98-bc6c-66aedbefa059.csv` | 5894ead8ba400948 |
| `634d3dd6-9f05-41b0-90fc-296fe724b18d-fbf3dc7b.csv` | 958 | `634d3dd6-9f05-41b0-90fc-296fe724b18d.csv` | e1095d87b837f0e2 |
| `d27e7726-1321-426a-9cb3-8a20d9707cc9-ddef1dd6.csv` | 881 | `d27e7726-1321-426a-9cb3-8a20d9707cc9.csv` | c747a65825bfbfc4 |
| `8ac18a93-8941-4afa-8db2-a9b972ad78c2-0872c9cb.csv` | 633 | `8ac18a93-8941-4afa-8db2-a9b972ad78c2.csv` | 46cfc4e363d78c29 |
| `f973a508-9638-4a9d-9277-5c2f8edf94aa-4d81b75e.csv` | 553 | `f973a508-9638-4a9d-9277-5c2f8edf94aa.csv` | 57e00ccdce302434 |
| `ce0ec751-8caa-4aa5-a2a4-d1746c9a2d6a-8cebeb47.csv` | 513 | `ce0ec751-8caa-4aa5-a2a4-d1746c9a2d6a.csv` | dc9f61fb0872c709 |
| `e0eb81c3-901e-4126-a5b5-3d216672bfd4-ec2d574d.csv` | 386 | `e0eb81c3-901e-4126-a5b5-3d216672bfd4.csv` | 766e9993597073fd |
| `6e691ac8-99d4-4f1f-aab6-2d08f828b4c8-b7d3653e.csv` | 350 | `6e691ac8-99d4-4f1f-aab6-2d08f828b4c8.csv` | 6d0f6ee1ec0a12ba |
| `83e4a2e3-9e6c-4714-b1fe-933293d8f622-0b62e5c7.csv` | 242 | `83e4a2e3-9e6c-4714-b1fe-933293d8f622.csv` | ef27462c840f6a6d |

## Method
- sha256 over full file contents (nice/ionice idle class). Manifests: every data file in all 19 raw manifests matched its recorded sha256.
- Registry: `ds_dataset_versions` (review_status, supersedes_id, origin_path) and `ds_files` (path, sha256); every ds_files path checked for existence and hash.
- Doc citations: `/workspace/work/<dir>` strings grepped in repo docs/, README, Documents/, backend/datasets, frontend/src.
- Out-of-scope and in-progress items were left out of the plan on purpose.
