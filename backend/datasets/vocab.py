"""Controlled vocabulary of the dataset registry (docs/urbanos/DATA_QUALITY_AND_PROVENANCE.md §2)."""
from __future__ import annotations

import os

DATA_CLASSES = ("observed", "inferred", "estimated", "derived", "synthetic")
SUITABILITY = ("visualisation", "screening", "engineering")
SUITABILITY_RANK = {None: 0, "visualisation": 1, "screening": 2, "engineering": 3}
ACCESS_METHODS = ("api", "ogc", "download", "manual", "rti", "local", "stream")
REVIEW_STATUSES = ("active", "pending_review", "superseded", "rejected")
CHECK_STATUSES = ("pass", "warn", "fail", "unknown", "not_applicable")
FEATURE_STATUSES = ("ready", "partial", "blocked")

# Pune study area (brief, WGS84): PMC + PCMC + surroundings
PUNE_BBOX = (73.70, 18.40, 74.05, 18.70)
ENGINEERING_CRS = "EPSG:32643"

# Theme vocabulary: dependencies name a theme; any registered dataset of that theme can satisfy it.
THEMES = {
    "base_map_imagery": "Base-map imagery (streamed)",
    "terrain_visual": "Visual terrain (streamed)",
    "osm_extract": "OpenStreetMap extract (raw)",
    "road_network": "Road network",
    "buildings": "Building footprints",
    "metro_alignment": "Metro alignments and stations",
    "water_features": "Water bodies and waterways",
    "heritage_locators": "Heritage locators",
    "trees": "Trees (point features)",
    "railway": "Railways (non-metro)",
    "flood_lines": "Flood lines / flood hazard",
    "dem": "Digital elevation model (analysis)",
    "drainage_network": "Storm-water drainage network",
    "rainfall": "Rainfall / IDF",
    "groundwater": "Groundwater levels",
    "geology": "Geology",
    "soil": "Soil",
    "boreholes": "Borehole logs",
    "utilities": "Utility records",
    "air_quality": "Air quality (measured)",
    "noise": "Noise (measured)",
    "land_surface_temperature": "Land surface temperature",
    "land_cover": "Land cover",
    "tree_census": "Tree census",
    "seismic_zone": "Seismic zone",
    "traffic_counts": "Traffic counts",
    "traffic_speeds": "Traffic speeds / travel times",
    "traffic_validation": "Independent traffic validation observations",
    "travel_demand": "Travel demand (OD / household survey)",
    "diurnal_profile": "Hour-of-day traffic profile",
    "network_corrections": "Local network corrections",
    "population": "Population",
    "admin_boundaries": "Administrative / ward boundaries",
    "protected_monuments": "Protected monument limits (ASI / state)",
    "heritage_list": "Municipal heritage list",
    "dp_road_lines": "Development-plan road lines / right of way",
    "metro_structures": "Metro structure levels (tunnel crown/invert, deck)",
    "vehicle_fleet": "Vehicle fleet composition",
    "emission_factors": "Emission factors",
    "demo_seed": "Demonstration seed objects",
    "satellite_imagery": "Satellite imagery and derived indices",
    "other": "Other",
}

# Synonyms accepted from manifests written by other agents
THEME_SYNONYMS = {
    "elevation": "dem", "terrain": "dem", "srtm": "dem", "copernicus_dem": "dem", "dsm": "dem",
    "flood": "flood_lines", "flood_hazard": "flood_lines", "drainage": "drainage_network", "stormwater": "drainage_network",
    "census": "population", "worldpop": "population", "wards": "admin_boundaries", "boundaries": "admin_boundaries",
    "aqi": "air_quality", "air": "air_quality", "lst": "land_surface_temperature", "heat": "land_surface_temperature",
    "landcover": "land_cover", "worldcover": "land_cover", "osm": "osm_extract", "roads": "road_network",
    "precipitation": "rainfall", "imd": "rainfall", "counts": "traffic_counts", "speeds": "traffic_speeds",
    "heritage": "heritage_locators", "monuments": "protected_monuments", "trees_census": "tree_census",
    "geotech": "boreholes", "sentinel2": "satellite_imagery", "imagery": "satellite_imagery", "ndvi": "satellite_imagery",
    "surface_water": "water_features", "gsw": "water_features", "nasadem": "dem", "copdem": "dem", "worldcover2021": "land_cover", "groundwater_levels": "groundwater", "water": "water_features", "waterways": "water_features",
}


def norm_theme(t: str | None) -> str:
    if not t:
        return "other"
    k = str(t).strip().lower().replace("-", "_").replace(" ", "_")
    k = THEME_SYNONYMS.get(k, k)
    return k if k in THEMES else "other"


# keywords looked for in a dataset / source id when a manifest names no theme (first match wins)
THEME_KEYWORDS = [("dem", "dem"), ("elevation", "dem"), ("nasadem", "dem"), ("worldcover", "land_cover"), ("landcover", "land_cover"),
                  ("land_cover", "land_cover"), ("building", "buildings"), ("ward", "admin_boundaries"), ("boundar", "admin_boundaries"),
                  ("gsw", "water_features"), ("surface_water", "water_features"), ("sentinel", "satellite_imagery"),
                  ("landsat", "land_surface_temperature"), ("census", "population"), ("worldpop", "population"), ("flood", "flood_lines"),
                  ("rain", "rainfall"), ("imd", "rainfall"), ("aqi", "air_quality"), ("caaqms", "air_quality"), ("cpcb", "air_quality"),
                  ("groundwater", "groundwater"), ("cgwb", "groundwater"), ("geolog", "geology"), ("borehole", "boreholes"),
                  ("tree", "tree_census"), ("osm", "osm_extract"), ("traffic", "traffic_counts"), ("count", "traffic_counts"),
                  ("metro", "metro_alignment"), ("drain", "drainage_network"), ("seismic", "seismic_zone"), ("soil", "soil")]


def guess_theme(*ids: str | None) -> str:
    for i in ids:
        k = (i or "").lower()
        for kw, theme in THEME_KEYWORDS:
            if kw in k:
                return theme
    return "other"


def data_root() -> str:
    """`URBANOS_DATA_DIR` (default `backend/data/urbanos`): holds raw/ and derived/ trees."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.environ.get("URBANOS_DATA_DIR", os.path.join(here, "data", "urbanos"))
