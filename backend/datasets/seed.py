"""
Registry seeds (idempotent; a row is inserted only when its id is absent, never overwritten):

1. Datasets already in the app, with the metadata the repo actually holds (sources, dates, sha256 computed 2026-11-13 IST).
2. Gap datasets: themes a feature needs that are not acquired (no version → `not_acquired`).
3. UrbanOS features and their dataset dependencies (the capability → data matrix, DATA_QUALITY_AND_PROVENANCE.md §5).
4. `sync_catalogues`: mirrors environment_layers, subsurface_datasets and td_datasets into the registry (their own tables
   and APIs are untouched; the mirror adds immutable versions when the source row changes).
"""
from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from planning.audit import acting_as

from .models import DsDatasetEntity, DsDatasetVersionEntity, DsFeatureDependencyEntity, DsFeatureEntity
from .quality import run_checks
from .registry import add_version, ensure_dataset, ensure_source, find_version_by_fingerprint, fingerprint, versions_of

SEED_ACTOR = "system (dataset registry seed)"
SEED_HASH_MAX = 20 * 1024 * 1024   # large files are hashed only by an explicit quality run
ODBL = "OpenStreetMap data: Open Data Commons Open Database License (ODbL) 1.0, © OpenStreetMap contributors"
ODBL_URL = "https://www.openstreetmap.org/copyright"
OSM_DATE = "2026-11-01T21:21:36Z"   # osmosis_replication_timestamp in the .pbf header (seq 1846) = 2026-11-02 02:51 IST

SOURCES = [
    dict(id="geofabrik", name="Geofabrik download server (OpenStreetMap extracts)", publisher="Geofabrik GmbH; data © OpenStreetMap contributors",
         url="https://download.geofabrik.de/asia/india/western-zone.html", access_method="download", licence_text=ODBL, licence_url=ODBL_URL,
         robots_notes="Bulk .osm.pbf downloads are the intended use; daily diffs via https://download.geofabrik.de/asia/india/western-zone-updates (pbf header). Rate: one file per update.",
         tos_notes="Attribution to OpenStreetMap contributors required; derived databases are share-alike under ODbL.", official=False),
    dict(id="twincity_app", name="TwinCity / UrbanOS application database", publisher="this application (local)", url="",
         access_method="local", licence_text="n/a (internal); OSM-derived content inherits ODbL", licence_url=ODBL_URL),
    dict(id="journalpressindia_nicmar", name="NICMAR conference chapter (Journal Press India)", publisher="Journal Press India / NICMAR",
         url="https://doi.org/10.17492/jpi/nicmar/2507129", access_method="download", licence_text="UNKNOWN (chapter PDF; no licence statement recorded in the repo)"),
    dict(id="zenodo_kureshi2026", name="Kureshi et al. 2026 (Zenodo)", publisher="Zenodo / authors", url="https://zenodo.org/records/21712996",
         access_method="download", licence_text="CC BY 4.0 (as recorded in backend/data/observed_counts/pune_west_2026.json)",
         licence_url="https://creativecommons.org/licenses/by/4.0/"),
    dict(id="pmc_cmp2008_opencity", name="Comprehensive Mobility Plan for Pune City 2008 (OpenCity mirror)", publisher="Pune Municipal Corporation (via OpenCity)",
         url="https://data.opencity.in/dataset/bb6b3dc4-6ff5-42bf-b41f-3d823a4e8ef8", access_method="download",
         licence_text="UNKNOWN (as labelled by OpenCity; not recorded)", official=True),
    dict(id="mendeley_xnf2k6n288", name="Heterogeneous Traffic Count Dataset, Pune (Mendeley Data)", publisher="Matange & Abraham (Mendeley Data)",
         url="https://data.mendeley.com/datasets/xnf2k6n288/1", access_method="download", licence_text="CC BY 4.0",
         licence_url="https://creativecommons.org/licenses/by/4.0/"),
    dict(id="repo_compilations", name="Compilations in this repository (cited secondary sources)", publisher="this repository (authors of backend/data/*)",
         url="", access_method="manual", licence_text="Compilation of cited values; each source's own terms apply (TomTom, TraffiCure: proprietary, quoted values only)"),
    dict(id="cesium_ion", name="Cesium ion (streamed imagery and Cesium World Terrain)", publisher="Cesium GS, Inc.", url="https://cesium.com/platform/cesium-ion/",
         access_method="stream", licence_text="Cesium ion Terms of Service (not stored offline; §2.2.2 restricts offline copying — EGR A9, EXCERPT)",
         licence_url="https://cesium.com/legal/terms-of-service", tos_notes="Streaming only; never cache/export as a dataset.", registration_required=True),
    dict(id="sumo_hbefa4", name="SUMO HBEFA4-based emission model coefficients", publisher="Eclipse SUMO (DLR) / INFRAS HBEFA",
         url="https://sumo.dlr.de/docs/Models/Emissions/HBEFA4-based.html", access_method="manual", licence_text="EPL-2.0 (SUMO source)",
         licence_url="https://www.eclipse.org/legal/epl-2.0/"),
    dict(id="arai_2007", name="ARAI (2007) Emission Factor development for Indian Vehicles", publisher="Automotive Research Association of India",
         url="", access_method="manual", licence_text="UNKNOWN", official=True),
]

# (dataset kwargs, version kwargs | None, files)
EXISTING = [
    (dict(id="osm_geofabrik_western_zone", title="OpenStreetMap extract — India western zone (Geofabrik)", theme="osm_extract", source_id="geofabrik",
          description="Raw .osm.pbf behind every OSM-derived layer in the app (roads, buildings, metro, water, heritage, trees, railway).",
          limitations="Crowd-sourced; completeness in Pune UNKNOWN. Absence of a feature proves nothing.", max_age_days=90,
          backs_catalogue=[], update_check={"method": "http_head", "url": "https://download.geofabrik.de/asia/india/western-zone-latest.osm.pbf"}),
     dict(version_label="2026-11-01T21:21:36Z", observation_end=OSM_DATE, source_updated_date=OSM_DATE,
          retrieved_at="2026-11-02T11:38:22Z (file mtime; download log not kept)",
          sha256="15660b2094c5414e0e2a2d7b4304ef3db42cbb123375cc10feab4d5bdb4bec19",
          coverage_bbox_json=[67.3022349, 14.370845, 80.913619, 25.446575], crs="EPSG:4326", resolution="vector (mapped features)",
          format="osm.pbf (osmium 1.16.0 writer)", size_bytes=221868283, data_class="observed", suitability="screening",
          accuracy_statement="", licence_text=ODBL, licence_url=ODBL_URL,
          notes="Coverage bbox from the pbf HeaderBBox; replication seq 1846. Classed observed (contributor mapping), suitable for screening only.",
          stats_json={"replication_url": "https://download.geofabrik.de/asia/india/western-zone-updates", "replication_seq": 1846}),
     [dict(path="data/osm/western-zone-latest.osm.pbf", sha256="15660b2094c5414e0e2a2d7b4304ef3db42cbb123375cc10feab4d5bdb4bec19",
           size_bytes=221868283, format="osm.pbf", role="raw", url="https://download.geofabrik.de/asia/india/western-zone-latest.osm.pbf")]),
    (dict(id="osm_local_index", title="Local OSM index (roads, signals, buildings, metro)", theme="road_network", source_id="geofabrik",
          description="SQLite + R*Tree built by `python -m osm.build_index` from the Geofabrik extract; read by Design (OSM import), study areas, feasibility, coordination (metro).",
          limitations="OSM centrelines; widths/lanes only where tagged; metro tunnel depths UNKNOWN.", max_age_days=90, backs_catalogue=["osm_metro"]),
     dict(version_label="built 2026-11-02 17:30 IST", observation_end=OSM_DATE, retrieved_at="2026-11-02T12:00:41Z (built; file mtime)",
          sha256="6cf1846f731b1440519be7c17ad89047c357eab893b1d8473f78037476c6a598", coverage_bbox_json=[73.55, 18.3, 74.2, 18.85],
          crs="EPSG:4326", resolution="vector", format="sqlite (rtree)", size_bytes=174723072, data_class="derived", suitability="screening",
          licence_text=ODBL, licence_url=ODBL_URL, notes="meta: capabilities roads, signals, buildings, metro; clip bbox 73.55–74.2 E, 18.3–18.85 N.",
          stats_json={"capabilities": ["roads", "signals", "buildings", "metro"]}),
     [dict(path="data/osm/osm_index.db", sha256="6cf1846f731b1440519be7c17ad89047c357eab893b1d8473f78037476c6a598", size_bytes=174723072, format="sqlite", role="derived")]),
    (dict(id="osm_feasibility_layers", title="OSM feasibility layers (water, heritage, trees, railway)", theme="water_features", source_id="geofabrik",
          description="`python -m feasibility.build_layers` output (TWINCITY_FEAS_LAYERS). Feeds feasibility screening and Environment overlays.",
          limitations="Heritage = locators only (no ASI limits); trees sparse; unmapped nallahs missing.", max_age_days=90,
          backs_catalogue=["osm_water", "osm_heritage", "osm_trees", "osm_railway"]),
     dict(version_label="built 2026-11-11 16:08 IST", observation_end=OSM_DATE, retrieved_at="2026-11-11T16:08:00+05:30 (built)",
          sha256="21924cea867eba0f89db2feabe1e092ce045a34bd1f66ec1e633b8f7f5be3f8e", coverage_bbox_json=[73.55, 18.3, 74.2, 18.85],
          crs="EPSG:4326", resolution="vector", format="sqlite", size_bytes=7884800, data_class="derived", suitability="screening",
          licence_text=ODBL, licence_url=ODBL_URL, stats_json={"features": {"water": 1409, "heritage": 71, "trees": 17695, "railway": 659}},
          notes="sha256 is of the copy used by the 2026-11-13 browser runs (/workspace/work/uos-env-e2e/db/); the default path backend/data/osm/feasibility_layers.db may be absent — then the checksum check fails and the layers are unavailable."),
     [dict(path="data/osm/feasibility_layers.db", sha256="21924cea867eba0f89db2feabe1e092ce045a34bd1f66ec1e633b8f7f5be3f8e", size_bytes=7884800, format="sqlite", role="derived")]),
    (dict(id="twincity_base_osm_objects", title="Base city model: OSM roads and buildings in twincity.db", theme="buildings", source_id="twincity_app",
          description="Base-scenario city_objects imported from the OSM index by the frontend importer (2026-11-02 → 2026-11-04): 18,271 roads, 2,429 buildings (counts on 2026-11-13).",
          limitations="Building height/floors/population are importer defaults (estimated), not surveyed. Road widths partly estimated from tags.", max_age_days=90),
     dict(version_label="twincity.db 2026-11-05", observation_end=OSM_DATE, retrieved_at="2026-11-04T18:04:08Z (last base object written)",
          coverage_bbox_json=[73.72, 18.49, 73.89, 18.6215], crs="EPSG:4326", resolution="vector", format="sqlite rows (city_objects)",
          data_class="derived", suitability="visualisation", licence_text=ODBL, licence_url=ODBL_URL,
          stats_json={"roads": 18271, "buildings": 2429, "study_area_tiles": 1324},
          notes="Coverage = union bbox of the 1,324 study-area tiles (areas table). Attributes such as height are estimated → visualisation only."),
     []),
    (dict(id="twincity_demo_seed", title="Demonstration seed objects (zones, gateways, sample buildings)", theme="demo_seed", source_id="twincity_app",
          description="16 sample buildings ('Cyber IT Park' …), 2 roads, 1 junction, 8 demand zones with population/employment, 5 gateways created by seed.py.",
          limitations="SYNTHETIC: made-up names and numbers; zone population/employment are not census values."),
     dict(version_label="seed.py", retrieved_at="2026-11-02T12:23:42Z", crs="EPSG:4326", format="sqlite rows", data_class="synthetic",
          suitability="visualisation", licence_text="n/a (synthetic)", stats_json={"buildings": 16, "roads": 2, "junctions": 1, "zones": 8, "gateways": 5}),
     []),
    (dict(id="observed_counts_pune_west_2026", title="Peak-hour classified turning counts, six west-Pune junctions", theme="traffic_counts",
          source_id="journalpressindia_nicmar", max_age_days=1095,
          description="backend/data/observed_counts/pune_west_2026.json — transcribed from Khandekar et al. 2025 (NICMAR) and cross-checked with Kureshi et al. 2026.",
          limitations="Survey date and AM/PM peak not stated by the sources; junction coordinates not in the file."),
     dict(version_label="1.0.0", observation_end=None, published_date="2025-07", retrieved_at="2026-11-02 (committed; see git log)",
          sha256="86a68d68511716ac09cdbe588e6e3a366c66224deb06c9953b19d156a984530f", crs="n/a (junction ids matched to OSM ways)",
          resolution="6 junctions, peak hour", format="json", size_bytes=27534, data_class="observed", suitability="screening",
          licence_text="UNKNOWN (NICMAR chapter); Kureshi 2026 CC BY 4.0", licence_url="https://creativecommons.org/licenses/by/4.0/",
          notes="Source PDF sha256 d291d2cea6ea87588ae0872115231016b7a5aa4621bf0384f35811b38edc720b (recorded in the file)."),
     [dict(path="data/observed_counts/pune_west_2026.json", sha256="86a68d68511716ac09cdbe588e6e3a366c66224deb06c9953b19d156a984530f", size_bytes=27534, format="json", role="derived")]),
    (dict(id="cmp2008_river_screenline", title="Mula-Mutha river bridges screen line (CMP 2008)", theme="traffic_validation", source_id="pmc_cmp2008_opencity",
          max_age_days=1095, description="backend/data/observed_screenlines/pune_cmp2008_river.json (CMP 2008 Table 4.1 + annexure Table 8).",
          limitations="2008 counts (~18 years old); some bridges changed since."),
     dict(version_label="pune_cmp2008_river", observation_start="2008", observation_end="2008", published_date="2008",
          sha256="584b9b9bb9d8a9692b84efea7d64196ed757a29fab9a21ba09d86aa54fd59168", crs="n/a (bridges matched to OSM ways by name)",
          resolution="7 stations, 12 h + peak hour", format="json", size_bytes=3286, data_class="observed", suitability="screening",
          licence_text="UNKNOWN (as labelled by OpenCity; not recorded)"),
     [dict(path="data/observed_screenlines/pune_cmp2008_river.json", sha256="584b9b9bb9d8a9692b84efea7d64196ed757a29fab9a21ba09d86aa54fd59168", size_bytes=3286, format="json", role="derived")]),
    (dict(id="pune_network_validation_v1", title="Independent validation observations (counts, speeds) v1", theme="traffic_validation", source_id="repo_compilations",
          max_age_days=1095, description="backend/data/observed_validation/pune_network_validation_v1.json: 16 counts, corridor/hourly/city speeds from CMP 2008, IJETT 2017, TraffiCure 2026, TomTom 2025, NICMAR 2025; graded A/B/C.",
          limitations="Validation only (never fitted). Mixed vintages 2008–2026; TomTom/TraffiCure are proprietary products quoted, not raw data."),
     dict(version_label="v1 (2026-11-09)", observation_start="2008", observation_end="2026-08-19", published_date="2026-11-09",
          sha256="2d055371c5e2ca8b0d81c012d89d4c863c24392dfde501502bf6bfcf98c7659b", crs="n/a (matched to OSM ways)", format="json",
          size_bytes=15644, data_class="observed", suitability="screening", licence_text="Mixed; each cited source's terms apply (see file)"),
     [dict(path="data/observed_validation/pune_network_validation_v1.json", sha256="2d055371c5e2ca8b0d81c012d89d4c863c24392dfde501502bf6bfcf98c7659b", size_bytes=15644, format="json", role="derived")]),
    (dict(id="mendeley_pune_2023_counts", title="Pune CCTV classified counts, Jan 2023 (hourly aggregates)", theme="traffic_counts", source_id="mendeley_xnf2k6n288",
          max_age_days=1095, description="backend/data/diurnal/mendeley_pune_2023_hourly.json — per camera/day/hour, parsed by backend/observed/diurnal/parse_mendeley_pune.py.",
          limitations="8 cameras, ~09:00–12:00 only, 11–18 Jan 2023."),
     dict(version_label="2023-01", observation_start="2023-01-11", observation_end="2023-01-18", published_date="2026",
          sha256="1f6030838707cee6a4c7cb5fada20a16f63619c99ab71d4b507aaa89cee0660d", crs="n/a (camera locations by name)", resolution="hourly, 8 cameras",
          format="json", size_bytes=38210, data_class="observed", suitability="screening", licence_text="CC BY 4.0",
          licence_url="https://creativecommons.org/licenses/by/4.0/", notes="Source zip sha256 648e9c33dfa8feeb48c8f3d25abff7625c8c69e117324cdf20254c566ccd03c4."),
     [dict(path="data/diurnal/mendeley_pune_2023_hourly.json", sha256="1f6030838707cee6a4c7cb5fada20a16f63619c99ab71d4b507aaa89cee0660d", size_bytes=38210, format="json", role="derived")]),
    (dict(id="pune_hourly_profile_v1", title="Pune hour-of-day traffic profile v1", theme="diurnal_profile", source_id="repo_compilations", max_age_days=1095,
          description="backend/data/diurnal/pune_hourly_profile_v1.json: weekday 08–19 measured (IJETT 2017 + Mendeley 2023), other hours filled from TomTom 2025 congestion; weekend derived.",
          limitations="Night hours and weekends are model fills (estimated), not counts."),
     dict(version_label="v1 (2026-11-02)", observation_start="2017", observation_end="2025", published_date="2026-11-02",
          sha256="3519ce494232fb720eef99edf9b8a39cfd51ad4f857e8b03ce4c0c70006d150e", crs="n/a (city-wide)", resolution="hourly", format="json",
          size_bytes=16916, data_class="derived", suitability="screening", licence_text="Compilation; source terms apply"),
     [dict(path="data/diurnal/pune_hourly_profile_v1.json", sha256="3519ce494232fb720eef99edf9b8a39cfd51ad4f857e8b03ce4c0c70006d150e", size_bytes=16916, format="json", role="derived")]),
    (dict(id="network_corrections_pune_west_v1", title="Local OSM corrections at the six counted junctions", theme="network_corrections", source_id="repo_compilations",
          description="backend/data/network_corrections/pune_west_v1.json: 24 corrections applied on top of OSM when the simulation network is built (OSM itself never edited).",
          limitations="Inferred from survey turning counts + left-hand-traffic rule; each correction can be disabled."),
     dict(version_label="1.0.0", observation_end=OSM_DATE, sha256="5f60da2ea709250cf813680c2a8bf2833525d7f7d6b31adcef7236f3e18466e5",
          crs="n/a (OSM way ids)", format="json", size_bytes=23018, data_class="inferred", suitability="screening",
          licence_text="ODbL 1.0 applies to the OSM ids/derived network", licence_url=ODBL_URL),
     [dict(path="data/network_corrections/pune_west_v1.json", sha256="5f60da2ea709250cf813680c2a8bf2833525d7f7d6b31adcef7236f3e18466e5", size_bytes=23018, format="json", role="derived")]),
    (dict(id="cesium_ion_imagery", title="Base-map imagery (Cesium ion, streamed)", theme="base_map_imagery", source_id="cesium_ion",
          description="Streamed imagery tiles for the 3D globe. Not stored. In this sandbox the imagery request returns 401 (URBANOS_OVERVIEW §5).",
          limitations="Visualisation only; never analysis data."),
     dict(version_label="streamed", crs="EPSG:3857 / EPSG:4326 tiles", format="streamed tiles", data_class="observed", suitability="visualisation",
          licence_text="Cesium ion Terms of Service", licence_url="https://cesium.com/legal/terms-of-service", retrieved_at=None,
          coverage_bbox_json=[-180, -90, 180, 90]),
     []),
    (dict(id="cesium_world_terrain", title="Cesium World Terrain (streamed, visual)", theme="terrain_visual", source_id="cesium_ion",
          description="Streamed terrain used by the globe and TerrainHeightField sampling (0.01° cells).",
          limitations="ion terms forbid offline storage → not an analysis DEM (EGR A9). Underground ground line stays UNKNOWN."),
     dict(version_label="streamed", crs="EPSG:4326 (heights: ellipsoid/EGM, per Cesium)", format="quantized-mesh (streamed)", data_class="derived",
          suitability="visualisation", licence_text="Cesium ion Terms of Service", licence_url="https://cesium.com/legal/terms-of-service",
          coverage_bbox_json=[-180, -90, 180, 90]),
     []),
    (dict(id="hbefa4_sumo_coefficients", title="HBEFA4-based emission coefficients (SUMO), stand-ins for Indian classes", theme="emission_factors",
          source_id="sumo_hbefa4", description="Coefficients copied into the frontend emission engine (docs/ODME_AND_EMISSIONS.md).",
          limitations="European fleet; auto-rickshaw and two-wheeler mapped to stand-in classes — not Pune accuracy."),
     dict(version_label="HBEFA 4.2 (SUMO HelpersHBEFA4.cpp @7a4786a, 2026-01-09)", published_date="2026-01-09", crs="n/a", format="code constants",
          data_class="estimated", suitability="screening", licence_text="EPL-2.0", licence_url="https://www.eclipse.org/legal/epl-2.0/"),
     []),
    (dict(id="arai_2007_emission_factors", title="ARAI 2007 emission factors (area cross-check)", theme="emission_factors", source_id="arai_2007",
          max_age_days=3650, description="Table I g/km rows used for the area cross-check (docs/ODME_AND_EMISSIONS.md).",
          limitations="2007 vehicle technology; CO2/NOx/PM only."),
     dict(version_label="2007", published_date="2007", crs="n/a", format="code constants", data_class="observed", suitability="screening",
          licence_text="UNKNOWN"),
     []),
]

# Gap datasets: (id, title, theme, limitation, recommended sources)
GAPS = [
    ("gap_population_census", "Population by ward / small area", "population",
     "Not acquired — UNKNOWN. Demo zone populations are SYNTHETIC.", [{"name": "Census of India 2011 (ward-level PCA)", "publisher": "Office of the Registrar General & Census Commissioner", "url": "", "licence": "UNKNOWN"}]),
    ("gap_admin_wards", "PMC / PCMC ward boundaries", "admin_boundaries", "Not acquired — UNKNOWN.", []),
    ("gap_travel_demand", "Travel demand (OD matrix / household survey)", "travel_demand",
     "Not acquired — UNKNOWN. The simulator's demand is generated from zones + ODME, not observed OD.", []),
    ("gap_vehicle_fleet", "Vehicle fleet composition (registrations)", "vehicle_fleet", "Not acquired — UNKNOWN. Simulator mix is an assumption.", []),
    ("gap_rainfall_idf", "Rainfall / IDF curves", "rainfall", "Not acquired — UNKNOWN.", []),
    ("gap_asi_protected_limits", "ASI / state protected monument limits", "protected_monuments",
     "Not acquired — UNKNOWN. AMASR permission distances cannot fire without limits.", []),
    ("gap_pmc_heritage_list", "PMC heritage list", "heritage_list", "Not acquired — UNKNOWN.", []),
    ("gap_dp_road_lines", "Development-plan road lines / right of way", "dp_road_lines", "Not acquired — UNKNOWN. An OSM width tag is not the legal RoW.", []),
    ("gap_metro_structures", "Metro tunnel crown/invert and viaduct levels", "metro_structures", "Not openly available — UNKNOWN (MahaMetro).", []),
    ("gap_traffic_speeds", "Measured link speeds / travel times (time series)", "traffic_speeds", "Not acquired as data; only quoted aggregates in the validation file.", []),
    ("gap_utilities", "Utility network records (PMC / MSEDCL / MNGL)", "utilities", "No open network; only imported subsurface records (if any).", []),
    ("gap_boreholes", "Borehole logs", "boreholes", "None openly available; only imported subsurface records (if any).", []),
]

ENV_THEME = {"flood_lines": "flood_lines", "groundwater_levels": "groundwater", "soil": "soil", "geology": "geology",
             "air_quality": "air_quality", "noise": "noise", "land_surface_temperature": "land_surface_temperature",
             "land_cover": "land_cover", "tree_census": "tree_census", "drainage_network": "drainage_network",
             "seismic_zone": "seismic_zone", "dem": "dem"}

# Feature → dependencies (theme, dataset_id | None, required quality, required, note)
V, S, E = "visualisation", "screening", "engineering"
FEATURES = [
    ("explore.globe", "explore", "Explore", "3D globe and base map", None, None,
     [("base_map_imagery", "cesium_ion_imagery", V, True, "imagery tiles"), ("terrain_visual", "cesium_world_terrain", V, False, "visual terrain")]),
    ("explore.city_model", "explore", "Explore", "Roads and buildings of the base city model", None, None,
     [("buildings", "twincity_base_osm_objects", V, True, "base objects"), ("road_network", "osm_local_index", V, True, "OSM roads")]),
    ("design.osm_import", "design", "Design", "Import roads/buildings from OSM for a study area", None, None,
     [("road_network", "osm_local_index", S, True, "local index (no Overpass)")]),
    ("design.feasibility_screening", "design", "Design", "Feasibility screening and investigation requirements", "partial",
     "Screening only: flood lines, protected limits, RoW, utilities and ground data are UNKNOWN, so they always appear as data gaps.",
     [("road_network", "osm_local_index", S, True, "buildings, roads, metro"), ("water_features", "osm_feasibility_layers", S, True, "water/heritage/trees/railway"),
      ("flood_lines", None, S, True, "WRD blue/red lines"), ("protected_monuments", None, S, True, "ASI limits"),
      ("dp_road_lines", None, S, False, "RoW"), ("utilities", None, S, False, "utility records"), ("boreholes", None, S, False, "ground data")]),
    ("underground.alignment_profile", "underground", "Underground", "Underground alignment long-section with ground line", None, None,
     [("dem", None, S, True, "ground line (else flat datum, UNKNOWN)"), ("boreholes", None, S, False, "strata on profile")]),
    ("underground.utility_conflicts", "underground", "Underground", "Utility conflict screening", None, None,
     [("utilities", None, S, True, "utility records with depth + QL"), ("metro_alignment", "osm_local_index", S, False, "OSM metro centrelines")]),
    ("underground.metro_clearance", "underground", "Underground", "Metro vertical clearance check", None, None,
     [("metro_alignment", "osm_local_index", S, True, "plan position"), ("metro_structures", None, E, True, "tunnel crown/invert, deck levels")]),
    ("underground.ground_model", "underground", "Underground", "Ground model (geology, groundwater)", None, None,
     [("boreholes", None, S, True, ""), ("geology", None, S, True, ""), ("groundwater", None, S, True, "")]),
    ("environment.constraint_overlays", "environment", "Environment", "Water, heritage, railway, metro overlays", None, None,
     [("water_features", "osm_feasibility_layers", V, True, ""), ("metro_alignment", "osm_local_index", V, False, "")]),
    ("environment.air_quality", "environment", "Environment", "Measured air quality", None, None, [("air_quality", None, S, True, "CAAQMS stations")]),
    ("environment.noise", "environment", "Environment", "Noise (measured)", None, None, [("noise", None, S, True, "")]),
    ("environment.heat", "environment", "Environment", "Urban heat (LST)", None, None, [("land_surface_temperature", None, S, True, "")]),
    ("environment.vegetation", "environment", "Environment", "Land cover and trees", None, None,
     [("land_cover", None, S, True, ""), ("tree_census", None, S, False, "OSM trees are sparse")]),
    ("environment.seismic", "environment", "Environment", "Seismic zone", None, None, [("seismic_zone", None, S, True, "IS 1893 map, TO VERIFY")]),
    ("flood.screening", "environment", "Flood/drainage", "Flood-hazard screening", None, None,
     [("flood_lines", None, S, True, ""), ("dem", None, S, True, "low points, flow paths"), ("rainfall", None, S, False, "")]),
    ("flood.drainage_model", "environment", "Flood/drainage", "Storm-water drainage model (SWMM)", None, None,
     [("drainage_network", None, E, True, "pipes/nallas with inverts"), ("dem", None, E, True, ""), ("rainfall", None, E, True, "IDF")]),
    ("traffic.simulation", "simulate", "Traffic", "Traffic assignment and micro-simulation", "partial",
     "Model FAILS validation (TAG M3.1: 0 of 15 counts within GEH 5; river screen line −30.5%). Compare options, not forecasts.",
     [("road_network", "osm_local_index", S, True, "network"), ("network_corrections", None, S, False, "local fixes"),
      ("diurnal_profile", None, S, True, "hour factors"), ("travel_demand", None, S, True, "observed OD (zones are SYNTHETIC)"),
      ("traffic_counts", None, S, True, "calibration counts")]),
    ("traffic.validation", "simulate", "Traffic", "Validation against independent observations", "partial",
     "Validation data exists but the model fails it (TAG M3.1).",
     [("traffic_validation", None, S, True, ""), ("traffic_speeds", None, S, False, "speed time series")]),
    ("emissions.estimate", "simulate", "Emissions", "Traffic emissions estimate", "partial",
     "Emissions inherit the traffic model's validation failure and European HBEFA stand-ins.",
     [("emission_factors", "hbefa4_sumo_coefficients", S, True, ""), ("vehicle_fleet", None, S, True, "Pune fleet mix"),
      ("traffic_counts", None, S, True, "flows (via the traffic model)")]),
    ("population.exposure", "projects", "Population", "Population and employment by area", None, None,
     [("population", None, S, True, "census / ward population"), ("admin_boundaries", None, S, True, "ward polygons")]),
    ("coordination.conflict_detection", "projects", "Coordination", "Cross-project and baseline conflict detection", None, None,
     [("buildings", "twincity_base_osm_objects", V, True, "baseline roads (structure depth UNKNOWN)"), ("metro_alignment", "osm_local_index", S, True, "OSM metro"),
      ("utilities", None, S, False, "utility records")]),
    ("coordination.heritage_permission", "projects", "Coordination", "AMASR / heritage permission triggers", None, None,
     [("protected_monuments", None, S, True, "notified limits"), ("heritage_list", None, S, False, "PMC list")]),
]


def seed_registry(session_factory) -> None:
    with session_factory() as db, acting_as(SEED_ACTOR):
        _seed(db)
        sync_catalogues(db)
        db.commit()


def _seed(db: Session) -> None:
    for s in SOURCES:
        s = dict(s)
        ensure_source(db, s.pop("id"), **s)
    for dkw, vkw, files in EXISTING:
        dkw = dict(dkw)
        did = dkw.pop("id")
        backs = dkw.pop("backs_catalogue", [])
        uc = dkw.pop("update_check", {})
        is_new = db.get(DsDatasetEntity, did) is None
        ensure_dataset(db, did, backs_catalogue_json=backs, update_check_json=uc, origin="seed", **dkw)
        if is_new and vkw is not None and not versions_of(db, did):
            v = add_version(db, did, files=files, origin="seed", fingerprint=fingerprint("seed", did, vkw.get("version_label")), **dict(vkw))
            run_checks(db, v, hash_max_bytes=SEED_HASH_MAX)
    for gid, title, theme, lim, rec in GAPS:
        ensure_dataset(db, gid, title=title, theme=theme, limitations=lim, recommended_sources_json=rec, origin="seed")
    for fid, ws, cap, name, cap_status, cap_reason, deps in FEATURES:
        if db.get(DsFeatureEntity, fid) is None:
            db.add(DsFeatureEntity(id=fid, workspace=ws, capability=cap, name=name, status_cap=cap_status, status_cap_reason=cap_reason))
            for i, (theme, did, q, req, note) in enumerate(deps):
                db.add(DsFeatureDependencyEntity(id=f"{fid}#{i}", feature_id=fid, theme=theme, dataset_id=did, required_quality=q,
                                                 required=req, note=note))
    db.flush()


def sync_catalogues(db: Session) -> dict:
    """Mirror existing catalogues into the registry. Idempotent; a changed source row → new pending version."""
    from coordination.models import EnvironmentLayerEntity, SubsurfaceDatasetEntity
    from traffic_data.models import TrafficDatasetEntity
    n = {"environment_layers": 0, "subsurface_datasets": 0, "td_datasets": 0, "new_versions": 0}
    backed = {}
    for d in db.scalars(select(DsDatasetEntity)):
        for ref in json.loads(d.backs_catalogue_json or "[]"):
            backed[ref] = d.id
    for row in db.scalars(select(EnvironmentLayerEntity)):
        n["environment_layers"] += 1
        if row.id in backed:
            continue
        did = f"env:{row.id}"
        ensure_dataset(db, did, title=row.name, theme=ENV_THEME.get(row.id, "other"), catalogue_ref=f"environment_layers:{row.id}",
                       recommended_sources_json=row.recommended_sources_json or "[]", limitations=row.limitations or "",
                       origin="catalogue_sync", description=f"Mirrors the Environment catalogue row '{row.id}' (domain {row.domain}).")
        if row.status == "available":
            fp = fingerprint("env", row.id, row.source, row.licence, row.data_date)
            if find_version_by_fingerprint(db, fp) is None:
                v = add_version(db, did, origin="catalogue_sync", fingerprint=fp, version_label=row.data_date or "catalogue",
                                source_updated_date=row.data_date, licence_text=row.licence or "UNKNOWN", data_class=None, suitability=None,
                                notes=f"Catalogue says available (source: {row.source}). Class/suitability not stated by the catalogue.")
                run_checks(db, v)
                n["new_versions"] += 1
    for sd in db.scalars(select(SubsurfaceDatasetEntity)):
        n["subsurface_datasets"] += 1
        did = f"subsurface:{sd.id}"
        text_blob = f"{sd.name} {sd.publisher} {sd.provenance}".lower()
        synthetic = "synthetic" in text_blob
        theme = "boreholes" if sd.record_type == "borehole" else "utilities"
        ensure_dataset(db, did, title=sd.name, theme=theme, catalogue_ref=f"subsurface_datasets:{sd.id}", origin="catalogue_sync",
                       description=f"Imported {sd.record_type} file ({sd.format}); mirrored from the Underground records.")
        fp = fingerprint("subsurface", sd.id, sd.file_sha256)
        if find_version_by_fingerprint(db, fp) is None:
            dc = "synthetic" if synthetic else ("observed" if sd.record_type == "borehole" else _utility_class(db, sd.id))
            v = add_version(db, did, origin="catalogue_sync", fingerprint=fp, version_label=sd.data_date or sd.id,
                            observation_end=sd.data_date, retrieved_at=sd.imported_at.isoformat() + "Z" if sd.imported_at else None,
                            sha256=sd.file_sha256, coverage_bbox_json=json.loads(sd.coverage_bbox_json) if sd.coverage_bbox_json else None,
                            crs="EPSG:4326", format=sd.format, data_class=dc, suitability="screening", licence_text=sd.licence or "UNKNOWN",
                            stats_json={"records": sd.record_count, "publisher": sd.publisher, "source_url": sd.source_url},
                            notes=f"Imported by {sd.imported_by}. Provenance: {sd.provenance}"[:2000])
            run_checks(db, v)
            n["new_versions"] += 1
    for td in db.scalars(select(TrafficDatasetEntity)):
        n["td_datasets"] += 1
        did = f"traffic:{td.id}"
        ensure_dataset(db, did, title=td.name, theme="traffic_counts", catalogue_ref=f"td_datasets:{td.id}", origin="catalogue_sync",
                       description=f"Traffic Data Manager dataset ({td.kind}, role {td.role}); provider {td.provider}.")
        stamp = td.updated_at.isoformat() if td.updated_at else ""
        fp = fingerprint("td", td.id, stamp, td.imported_file_sha256, bool(td.synthetic))
        if find_version_by_fingerprint(db, fp) is None:
            synthetic = bool(td.synthetic) or "synthetic" in f"{td.name} {td.provider}".lower()
            dc = "synthetic" if synthetic else {"measured": "observed", "manual": "observed", "estimated": "estimated"}.get(td.kind)
            v = add_version(db, did, origin="catalogue_sync", fingerprint=fp, version_label=stamp[:19] or td.id,
                            observation_start=td.collected_from, observation_end=td.collected_to, sha256=td.imported_file_sha256,
                            crs="n/a (road ids of the city model)", format="td_count_records", data_class=dc, suitability="screening",
                            licence_text="UNKNOWN (user-entered; not recorded by the Traffic Data Manager)",
                            notes=f"Provider: {td.provider}; method: {td.method}; entered by {td.entered_by}."
                                  + (" Flagged SYNTHETIC." if synthetic else ""))
            run_checks(db, v)
            n["new_versions"] += 1
    db.flush()
    return n


def _utility_class(db: Session, dataset_id: str) -> str:
    from coordination.models import SubsurfaceRecordEntity
    qls = {r.quality_level for r in db.scalars(select(SubsurfaceRecordEntity).where(SubsurfaceRecordEntity.dataset_id == dataset_id))}
    return "observed" if qls == {"QL-A"} else "estimated"
