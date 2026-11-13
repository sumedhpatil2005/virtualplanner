"""Environment data catalogue: real Pune datasets on disk (derived/ trees + processing.json), what they may be used for,
and the rows that are blocked or rejected with their reason. Status is computed on read from the files; nothing here
claims data that is not on disk. Licences are quoted from the raw manifests (raw/<source>/<date>/manifest.json).

Row fields (all present, unknown → "UNKNOWN" / null, never omitted):
  id, group, name, kind (raster|vector|points|stations|series|none), status (available|missing|blocked|rejected),
  status_reason, source, publisher, licence, licence_url, attribution, data_date, vintage_note, data_class,
  suitability, limitations, legend, variants, processing {pipeline, git_commit, run_at, file, sha256},
  covers (coordination catalogue ids this row supersedes in the Environment workspace), bounds [w,s,e,n].
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import paths

PUNE_BBOX = [73.70, 18.40, 74.05, 18.70]

# ESA WorldCover v200 class codes and colours as published in the product user manual (PUM v2.0, Table 1)
WORLDCOVER_CLASSES = [
    (10, "Tree cover", "#006400"), (20, "Shrubland", "#ffbb22"), (30, "Grassland", "#ffff4c"),
    (40, "Cropland", "#f096ff"), (50, "Built-up", "#fa0000"), (60, "Bare / sparse vegetation", "#b4b4b4"),
    (70, "Snow and ice", "#f0f0f0"), (80, "Permanent water bodies", "#0064c8"), (90, "Herbaceous wetland", "#0096a0"),
    (95, "Mangroves", "#00cf75"), (100, "Moss and lichen", "#fae6a0"),
]
CATCHMENT_COLOURS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0"]

NDVI_RAMP = [(-0.2, "#8c510a"), (0.1, "#d8b365"), (0.3, "#f6e8c3"), (0.5, "#a6d96a"), (0.8, "#1a9641")]
MNDWI_RAMP = [(-0.6, "#d9c7a7"), (-0.2, "#f2efe9"), (0.0, "#9ecae1"), (0.3, "#3182bd"), (0.6, "#08306b")]
OCC_RAMP = [(1, "#c6dbef"), (25, "#6baed6"), (50, "#3182bd"), (75, "#08519c"), (100, "#08306b")]

LIC_ESA_WC = ("CC-BY 4.0 (ESA WorldCover project / VITO)", "https://registry.opendata.aws/esa-worldcover-vito/")
LIC_S2 = ("Legal notice on the use of Copernicus Sentinel Data and Service Information (free, full and open access)",
          "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice.pdf")
LIC_JRC = ("Copernicus Programme: provided free of charge, without restriction of use", "https://global-surface-water.appspot.com/download")
LIC_COPDEM = ("Copernicus DEM GLO-30 free licence (ESA user licence / CCM terms)",
              "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM")
LIC_SOIL = ("CC BY 4.0 (ISRIC SoilGrids)", "https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_02.html")
LIC_OPENCITY = ("CKAN licence_title: Other (Public Domain); OpenCity FAQ: data under ODbL unless stated; credit OpenCity",
                "https://opencity.in/faqs/")
LIC_IMD_GRID = ("UNKNOWN — no licence stated on the download page; IMD asks to cite Pai et al. (2014) and disclaims liability",
                "https://imdpune.gov.in/cmpg/Griddata/Rainfall_25_Bin.html")
LIC_NWDP_IMD = ("UNKNOWN — NWDP licence field empty for the IMD district rainfall dataset", "https://nwdp.nwic.gov.in/")
LIC_CHIRPS = ("Public domain (CC0 waiver)", "https://www.chc.ucsb.edu/data/chirps")


@dataclass
class Layer:
    id: str
    group: str
    name: str
    kind: str
    dataset: str | None
    version: str | None
    file: str | None
    source: str
    publisher: str
    licence: tuple[str, str]
    data_date: str | None
    data_class: str
    suitability: str
    limitations: str
    attribution: str = ""
    vintage_note: str = ""
    legend: dict | None = None
    variants: list[dict] = field(default_factory=list)
    covers: list[str] = field(default_factory=list)
    fixed_status: str | None = None      # blocked | rejected (never available)
    status_reason: str = ""
    render: dict | None = None           # raster renderer spec (internal)
    extra_files: list[str] = field(default_factory=list)


def _cat_legend(classes) -> dict:
    return {"type": "categorical", "items": [{"value": v, "label": l, "color": c} for v, l, c in classes]}


def _ramp_legend(stops, unit: str, label: str) -> dict:
    return {"type": "ramp", "unit": unit, "label": label, "stops": [{"value": v, "color": c} for v, c in stops]}


S2_LIM = ("Single-scene index (one cloud-screened Sentinel-2 L2A date each); values change with season, soil moisture and "
          "phenology. Not a vegetation inventory or water mask; two dates are not a trend.")
SOIL_LIM = ("SoilGrids 2.0 global machine-learning predictions at 250 m, 0–30 cm weighted; urban areas are masked by the "
            "producer. NOT for foundation design, bearing capacity or infiltration design. Hydrologic soil group not assigned.")
SOIL_PROPS = [("clay", "Clay", "%", [(30, "#fff5eb"), (36, "#fdbe85"), (40, "#e6550d"), (45, "#7f2704")]),
              ("sand", "Sand", "%", [(25, "#fffbe6"), (31, "#fee391"), (35, "#ec7014"), (40, "#662506")]),
              ("silt", "Silt", "%", [(20, "#f7fcf5"), (24, "#a1d99b"), (27, "#41ab5d"), (32, "#00441b")]),
              ("soc", "Soil organic carbon", "g/kg", [(5, "#ffffe5"), (10, "#d9f0a3"), (15, "#78c679"), (25, "#004529")]),
              ("bdod", "Bulk density", "kg/dm³", [(1.3, "#f7fbff"), (1.45, "#9ecae1"), (1.5, "#3182bd"), (1.6, "#08306b")]),
              ("awc_proxy", "Available water (proxy, wv0033−wv1500)", "vol%", [(5, "#fff7fb"), (10, "#a6bddb"), (15, "#3690c0"), (20, "#014636")])]

LAYERS: list[Layer] = [
    # ── vegetation / land cover ──
    Layer("landcover_worldcover2021", "vegetation", "Land cover — ESA WorldCover 2021 (10 m)", "raster",
          "landcover_worldcover2021", "v1", "worldcover2021_epsg4326.tif",
          "ESA WorldCover 10 m 2021 v200", "ESA WorldCover project / VITO", LIC_ESA_WC, "2021 (annual product)", "derived", "screening",
          "Model output from Sentinel-1/2 (2021). Classes are not land use or zoning; small features (narrow roads, single trees) "
          "are mixed into neighbours. Areas are pixel counts × 100 m² on the EPSG:32643 copy.",
          attribution="© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
          legend=_cat_legend(WORLDCOVER_CLASSES), covers=["land_cover"],
          render={"mode": "categorical", "palette": {v: c for v, _, c in WORLDCOVER_CLASSES}},
          extra_files=["worldcover2021_epsg32643_10m.tif", "class_areas.json"]),
    Layer("s2_ndvi", "vegetation", "Vegetation index NDVI — Sentinel-2 L2A", "raster",
          "sentinel2_indices", "v1", "ndvi_recent_43QCA_20251114.tif",
          "Sentinel-2 L2A (Earth Search COGs), tile 43QCA", "ESA / European Commission (Copernicus)", LIC_S2, "2025-11-14 (scene date, UTC)",
          "derived", "screening", S2_LIM, attribution="Contains modified Copernicus Sentinel data 2019, 2025",
          legend=_ramp_legend(NDVI_RAMP, "index", "NDVI (−1…1)"),
          variants=[{"id": "2025", "label": "2025-11-14", "file": "ndvi_recent_43QCA_20251114.tif", "data_date": "2025-11-14 (scene date, UTC)"},
                    {"id": "2019", "label": "2019-11-26 (comparison)", "file": "ndvi_baseline_43QCA_20191126.tif", "data_date": "2019-11-26 (scene date, UTC)"}],
          render={"mode": "ramp", "stops": NDVI_RAMP}),
    Layer("tree_census_2019", "vegetation", "Tree census 2019 — PMC (4.0 M trees)", "points",
          "pmc_tree_census_2019_index", "v1", "trees_index.sqlite",
          "Pune Tree Census 2019 (OpenCity mirror of PMC data, 17 CSV parts)", "Pune Municipal Corporation (via OpenCity)", LIC_OPENCITY,
          "2019 (census vintage per dataset title)", "observed", "screening",
          "2019 vintage: trees have been felled and planted since. Attributes (species, girth, height, canopy, condition, ownership) "
          "are as published; out-of-range values are kept, not corrected. A tree survey under the Maharashtra (Urban Areas) "
          "Protection and Preservation of Trees Act is still required for any site.",
          vintage_note="2019 vintage — a Trees Act survey is still required", covers=["tree_census"],
          legend={"type": "categorical", "items": [{"label": "Tree (census point)", "color": "#2e7d32"}, {"label": "Tree flagged is_rare", "color": "#c0ca33"},
                                                   {"label": "Cluster (size ∝ count)", "color": "#2e7d32"}]}),
    # ── water & flooding ──
    Layer("s2_mndwi", "water", "Water index MNDWI — Sentinel-2 L2A", "raster",
          "sentinel2_indices", "v1", "mndwi_recent_43QCA_20251114.tif",
          "Sentinel-2 L2A (Earth Search COGs), tile 43QCA", "ESA / European Commission (Copernicus)", LIC_S2, "2025-11-14 (scene date, UTC)",
          "derived", "screening", S2_LIM + " MNDWI > 0 often marks open water but also wet soil and shadows.",
          attribution="Contains modified Copernicus Sentinel data 2019, 2025", legend=_ramp_legend(MNDWI_RAMP, "index", "MNDWI (−1…1)"),
          variants=[{"id": "2025", "label": "2025-11-14", "file": "mndwi_recent_43QCA_20251114.tif", "data_date": "2025-11-14 (scene date, UTC)"},
                    {"id": "2019", "label": "2019-11-26 (comparison)", "file": "mndwi_baseline_43QCA_20191126.tif", "data_date": "2019-11-26 (scene date, UTC)"}],
          render={"mode": "ramp", "stops": MNDWI_RAMP}),
    Layer("jrc_gsw_occurrence", "water", "Surface water occurrence — JRC Global Surface Water v1.5", "raster",
          "surface_water_jrc_gsw", "v1", "gsw_v1_5_occurrence_epsg4326.tif",
          "JRC Global Surface Water v1.5 (1984–2024, Landsat)", "European Commission JRC / Google", LIC_JRC, "1984–2024 (v1.5 observation period, per file name)",
          "derived", "screening",
          "Occurrence = % of valid Landsat observations classified as water (30 m). It is NOT a flood return period, flood extent or "
          "inundation depth. Narrow nallas and channels are below the resolution.",
          attribution="Source: EC JRC/Google; Pekel et al. 2016, Nature 540, 418–422",
          legend=_ramp_legend(OCC_RAMP, "%", "Water occurrence (% of observations)"),
          render={"mode": "ramp", "stops": OCC_RAMP, "transparent_below": 1}),
    Layer("dem_streams", "water", "Derived streams (D8 flow paths ≥ 1 km²) — from Copernicus GLO-30", "vector",
          "elevation_copdem30", "v3", "streams_derived_epsg32643.geojson",
          "Copernicus DEM GLO-30 → Priority-Flood+ε + D8 (UrbanOS elevation pipeline v3)", "ESA / Copernicus (DLR, Airbus DS); derived by UrbanOS", LIC_COPDEM,
          "2011–2015 (TanDEM-X acquisitions)", "derived", "screening",
          "Computed from a DSM (buildings and trees included): in dense urban fabric flow paths follow rooftops and canopy, not "
          "drains. Partial catchments where rivers enter from outside the study box. Screening only; not a drainage network.",
          attribution="produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
          legend={"type": "line", "items": [{"label": "Derived flow path", "color": "#29b6f6"}]}, covers=["dem"]),
    Layer("dem_catchments", "water", "Derived catchments (edge outlets ≥ 10 km²) — from Copernicus GLO-30", "raster",
          "elevation_copdem30", "v3", "catchments_edge_outlets_epsg32643.tif",
          "Copernicus DEM GLO-30 → D8 edge-outlet catchments (UrbanOS elevation pipeline v3)", "ESA / Copernicus (DLR, Airbus DS); derived by UrbanOS", LIC_COPDEM,
          "2011–2015 (TanDEM-X acquisitions)", "derived", "screening",
          "DSM-based (see derived streams). Catchments are clipped to the study box and drain to its edge; the Mula/Mutha headwaters "
          "lie outside, so these are partial. Screening only.",
          legend=_cat_legend([(i + 1, f"Catchment {i + 1}", c) for i, c in enumerate(CATCHMENT_COLOURS)]),
          render={"mode": "categorical", "palette": {i + 1: c for i, c in enumerate(CATCHMENT_COLOURS)}, "alpha": 150},
          extra_files=["catchment_outlets.json"]),
    Layer("flood_lines_pmc", "water", "Flood lines (blue/red) — PMC AutoDCR Red_Blue / WRD", "none",
          None, None, None, "PMC AutoDCR GeoServer layer Red_Blue; WRD statutory sheets", "Pune Municipal Corporation / Water Resources Department",
          ("UNKNOWN (restricted)", ""), None, "observed", "screening",
          "Statutory flood lines are not in UrbanOS: they stay UNKNOWN and are never treated as no flood risk.",
          fixed_status="blocked", covers=["flood_lines"],
          status_reason="Restricted: PMC AutoDCR Red_Blue needs PMC permission (licence, source date and order unknown); WRD sheets are "
                        "scanned PDFs. Request route: docs/urbanos/MISSING_DATA_AND_COLLECTION_PLAN.md item 2."),
    Layer("flood_model", "water", "Flood hazard model (inundation depth / extent)", "none",
          None, None, None, "—", "—", ("n/a", ""), None, "synthetic", "visualisation",
          "UrbanOS has no flood model. JRC occurrence, derived streams and catchments are context layers, not flood hazard.",
          fixed_status="blocked",
          status_reason="No flood model: needs statutory flood lines, a bare-earth DEM, drainage inverts and design rainfall (IDF), none of which are available."),
    Layer("s2_builtup_change", "other", "Built-up change 2019→2025 — Sentinel-2 rule", "none",
          "sentinel2_indices", "v1", "builtup_change_2019-11-26_to_2025-11-14.tif",
          "Sentinel-2 L2A, NDBI/NDVI/MNDWI threshold rule", "derived by UrbanOS", LIC_S2, "2019-11-26 → 2025-11-14", "derived", "visualisation",
          "Not drawn.", fixed_status="rejected",
          status_reason="Rejected: the rule agrees poorly with WorldCover 2021 built-up (2025 scene F1 0.457, precision 0.616, recall 0.363, "
                        "IoU 0.296; 2019 F1 0.536) and mixes real change with phenology and soil-moisture differences. Judged unreliable."),
    # ── ground ──
    Layer("soil_soilgrids", "ground", "Soil properties 0–30 cm — SoilGrids 2.0 (250 m)", "raster",
          "soil_soilgrids250", "v1", "soil_clay_0-30cm_epsg32643_250m.tif",
          "SoilGrids 2.0 (ISRIC), 0–5/5–15/15–30 cm weighted", "ISRIC — World Soil Information", LIC_SOIL, "UNKNOWN (SoilGrids 2.0; release date not recorded in the manifest)",
          "estimated", "screening", SOIL_LIM, attribution="SoilGrids 2.0, ISRIC (CC BY 4.0)",
          legend=_ramp_legend(SOIL_PROPS[0][3], SOIL_PROPS[0][2], SOIL_PROPS[0][1]),
          variants=[{"id": k, "label": f"{lab} ({u})", "file": f"soil_{k}_0-30cm_epsg32643_250m.tif",
                     "legend": _ramp_legend(stops, u, lab)} for k, lab, u, stops in SOIL_PROPS],
          covers=["soil"], render={"mode": "ramp", "stops": SOIL_PROPS[0][3]}),
    # ── air ──
    Layer("air_cpcb_caaqms", "air", "Air quality — CPCB/MPCB/IITM continuous stations (15-min, 2024–25)", "stations",
          "cpcb_caaqms_pune", "2026-11-13", "aq_15min_pune.csv",
          "CPCB CCR station data via the OpenCity mirror; station list: CPCB CAAQMS PDF", "CPCB / MPCB / IITM (via OpenCity)", LIC_OPENCITY,
          "2024-01-01 to 2025 (per station, IST)", "observed", "screening",
          "Point measurements at 8 listed stations (7 with downloaded series). Concentrations as published; negative values blanked. "
          "No interpolated surface: values do not represent locations away from the station.",
          covers=["air_quality"], extra_files=["stations_pune.geojson"],
          legend={"type": "categorical", "items": [{"label": "Station with downloaded series", "color": "#ffb300"},
                                                   {"label": "Listed station, no series downloaded", "color": "#808080"}]}),
    # ── rainfall ──
    Layer("rain_imd_025", "water", "Rainfall — IMD 0.25° gridded daily (2000–2025)", "series",
          "imd_rainfall_025_pune", "2026-11-13", "pune_cells_daily.csv",
          "IMD 0.25° gridded daily rainfall (Pai et al. 2014)", "India Meteorological Department, Pune", LIC_IMD_GRID,
          "2000-01-01 to 2025-12-31 (daily, IMD day)", "derived", "screening",
          "4 cells of ~27 km; gridded analysis interpolated from gauges. 12 cell-years are flagged suspect (> 3× median annual). "
          "Not IDF curves, not design storms.", extra_files=["pune_cells_annual_totals.csv", "pune_cells.geojson"]),
    Layer("rain_chirps", "water", "Rainfall — CHIRPS v2 daily, study-box average (1986–2025)", "series",
          "rainfall_chirps_boxavg", "v1", "chirps_daily_mm_boxavg.csv",
          "CHIRPS v2.0 via ClimateSERV (box average of 0.05° cells)", "Climate Hazards Center, UC Santa Barbara", LIC_CHIRPS,
          "1986-01-01 to 2025-12-31", "estimated", "screening",
          "Satellite+gauge blend averaged over the whole study box; underestimates local intense rainfall. Not IDF / design storms."),
    Layer("rain_nwdp_district", "water", "Rainfall — IMD district daily, Pune (NWDP)", "series",
          "imd_district_rainfall_pune", "2026-11-13", "imd_district_daily_rainfall_pune.csv",
          "IMD district-wise daily rainfall on the National Water Data Portal", "IMD via NWIC (NWDP)", LIC_NWDP_IMD,
          "2026-08-19 onwards (as published)", "observed", "screening",
          "District average (whole Pune district); only 86 days published. Not IDF / design storms."),
]

BY_ID = {l.id: l for l in LAYERS}


def file_path(l: Layer, variant: str | None = None):
    if not l.dataset or not l.version:
        return None
    f = l.file
    if variant and l.variants:
        v = next((x for x in l.variants if x["id"] == variant), None)
        if v is None:
            return None
        f = v["file"]
    return paths.derived(l.dataset, l.version, f) if f else None


def _bounds(l: Layer) -> list[float] | None:
    if l.kind != "raster":
        return PUNE_BBOX if l.kind in ("vector", "points") else None
    p = file_path(l)
    try:
        import rasterio
        from rasterio.warp import transform_bounds
        with rasterio.open(p) as s:
            return [round(v, 5) for v in transform_bounds(s.crs, "EPSG:4326", *s.bounds)]
    except Exception:  # noqa: BLE001
        return None


def row(l: Layer) -> dict[str, Any]:
    p = file_path(l)
    if l.fixed_status:
        status, reason = l.fixed_status, l.status_reason
    elif p is not None and p.exists():
        status, reason = "available", ""
    else:
        status, reason = "missing", f"Expected file not found: {p} (run the pipeline; set URBANOS_DATA_DIR)."
    pj = paths.processing(l.dataset, l.version) if l.dataset and l.version else None
    proc = None
    if pj is not None:
        proc = {"pipeline": pj.get("pipeline"), "git_commit": pj.get("git_commit"), "run_at": pj.get("run_at"),
                "file": l.file, "sha256": paths.output_sha(l.dataset, l.version, l.file) if l.file else None,
                "classification": pj.get("classification"), "suitability": pj.get("suitability"), "notes": pj.get("notes")}
    legend = l.legend
    if legend and l.id == "landcover_worldcover2021" and pj:
        present = set(((pj.get("validation") or {}).get("classes_present") or []))
        if present:   # show only classes that occur in the study area (per processing.json validation)
            legend = {**legend, "items": [i for i in legend["items"] if i["value"] in present]}
    if legend and l.id == "dem_catchments":
        try:   # label each catchment with its area inside the study box, as computed by the pipeline
            import json as _json
            areas = {o["id"]: o["area_km2"] for o in _json.loads(paths.derived(l.dataset, l.version, "catchment_outlets.json").read_text())}
            legend = {**legend, "items": [{**i, "label": f"{i['label']} · {areas[i['value']]:,.1f} km² in box" if i["value"] in areas else i["label"]}
                                          for i in legend["items"]]}
        except (OSError, ValueError, KeyError):
            pass
    variants = [{k: v for k, v in x.items() if k != "file"} | {"available": bool(file_path(l, x["id"]) and file_path(l, x["id"]).exists())}
                for x in l.variants]
    return {"id": l.id, "group": l.group, "name": l.name, "kind": l.kind, "status": status, "status_reason": reason,
            "source": l.source, "publisher": l.publisher, "licence": l.licence[0] or "UNKNOWN", "licence_url": l.licence[1] or None,
            "attribution": l.attribution, "data_date": l.data_date, "vintage_note": l.vintage_note, "data_class": l.data_class,
            "suitability": l.suitability, "limitations": l.limitations, "legend": legend, "variants": variants,
            "covers": l.covers, "processing": proc, "bounds": _bounds(l) if status == "available" else None}


def catalogue() -> dict:
    return {"layers": [row(l) for l in LAYERS],
            "note": "Real datasets on disk (derived from raw downloads; see each row's processing). Status is computed on read. "
                    "Blocked and rejected rows are listed with their reason and never drawn. Absence of a feature on a layer "
                    "proves nothing.",
            "data_dir": str(paths.derived_dir())}
