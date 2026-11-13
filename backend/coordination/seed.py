"""
Idempotent seeds: clearance rules (ONLY cited permission distances) and the environment-layer catalogue (metadata only;
recommended sources from docs/urbanos/ENGINEERING_GIS_RESEARCH.md §C). Inserted through the ORM, so audited.
A seed row is inserted only when its id is absent: a user's edit to a seeded row is never overwritten.
"""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from planning.audit import acting_as

from .models import ClearanceRuleEntity, EnvironmentLayerEntity

SEED_ACTOR = "system (seed)"

METRO_KINDS = "metro,metro_tunnel,metro_viaduct,metro_station"
_S9 = ("Indian Express, 'Pune Metro issues no-NOC, no-work warning after Shukrawar Peth tunnel breach', 17 Apr 2026 — "
       "https://indianexpress.com/article/cities/pune/noc-mandatory-pune-metro-warns-of-action-over-borewell-drilling-near-tunnels-10641841/ "
       "(MahaMetro spokesperson: development within 20 m of either the elevated or underground metro route needs a metro NOC). "
       "MahaMetro notice https://www.punemetrorail.org/download/Notice-for-NOC.pdf not read (scanned). Repo: docs/RESEARCH_FEASIBILITY_AND_INVESTIGATION.md §1.7, S9.")
_AMASR = ("AMASR Act 1958 as amended 2010, s.20A (prohibited area 100 m) and s.20B (regulated area, a further 200 m, i.e. 100–300 m) — "
          "NMA FAQ https://nma.gov.in/show_content.php?lang=1&level=0&lid=9&ls_id=14&nma_type=0 (NMA, updated 24 Feb 2025, READ); "
          "Act text https://prsindia.org/files/bills_acts/acts_parliament/2010/ancient-monuments-and-archaeological-sites-and-remains-act-2010.pdf "
          "(Gazette of India 29 Mar 2010, EXCERPT). Repo: docs/RESEARCH_FEASIBILITY_AND_INVESTIGATION.md §1.4, S1/S2.")

RULE_SEEDS = [
    dict(id="metro_noc_20m", label="Metro NOC trigger: within 20 m of an elevated or underground metro route",
         rule_type="permission_distance", subject_kind="*", other_kind=METRO_KINDS, horizontal_m=20.0, vertical_m=None,
         basis="cited_permission_distance", citation=_S9,
         note="PERMISSION DISTANCE, NOT AN ENGINEERING CLEARANCE. Says when a metro NOC is needed; says nothing about whether "
              "a work is physically safe inside or outside 20 m. Measured here from the OSM / entered centreline (estimated), "
              "not from the authority's surveyed route."),
    dict(id="amasr_prohibited_100m", label="AMASR prohibited area: 100 m from the limit of a protected monument/area",
         rule_type="permission_distance", subject_kind="*", other_kind="protected_monument", horizontal_m=100.0, vertical_m=None,
         basis="cited_permission_distance", citation=_AMASR,
         note="PERMISSION DISTANCE, NOT AN ENGINEERING CLEARANCE. Minimum, extendable by notification; measured from the protected "
              "LIMIT, which is not in OSM — a point or footprint gives an estimated buffer. Protected monuments are not imported (UNKNOWN)."),
    dict(id="amasr_regulated_300m", label="AMASR regulated area: 100–300 m from the limit of a protected monument/area",
         rule_type="permission_distance", subject_kind="*", other_kind="protected_monument", horizontal_m=300.0, vertical_m=None,
         basis="cited_permission_distance", citation=_AMASR,
         note="PERMISSION DISTANCE, NOT AN ENGINEERING CLEARANCE. Minimum, extendable by notification. Protected monuments are not imported (UNKNOWN)."),
]


def _rec(name, publisher, url, licence, notes):
    return {"name": name, "publisher": publisher, "url": url, "licence": licence, "notes": notes,
            "status": "recommended source (metadata only; not imported)"}


EGR_C = "docs/urbanos/ENGINEERING_GIS_RESEARCH.md §C (accessed 2026-11-13)"
LAYER_SEEDS = [
    dict(id="flood_lines", domain="flood", name="Flood lines (blue/red), Pune rivers",
         recommended=[_rec("Red and Blue Line maps", "Water Resources Dept, Govt of Maharashtra", "https://wrd.maharashtra.gov.in/Site/1321/Red-and-Blue-Line-Maps", "UNKNOWN",
                           "Scanned PDF sheets, no vector; legally contested and under revision; must be georeferenced")],
         limitations="Not imported — UNKNOWN. No flood finding is produced without an imported, cited layer."),
    dict(id="groundwater_levels", domain="groundwater", name="Groundwater levels (wells)",
         recommended=[_rec("Groundwater levels (manual quarterly & telemetry)", "CGWB via NWIC India-WRIS / National Water Data Portal",
                           "https://nwdp.nwic.gov.in/dataset/gwl-manual-quarterly-central-ground-water-board-department", "UNKNOWN", "Sparse point wells"),
                      _rec("Aquifer map & groundwater management plan, Pune district", "Central Ground Water Board",
                           "https://cgwb.gov.in/sites/default/files/2022-11/pune.pdf", "UNKNOWN (Govt publication)", "District scale, not site-specific")],
         limitations="Not imported — UNKNOWN."),
    dict(id="soil", domain="soil", name="Soil / near-surface ground conditions", recommended=[],
         limitations="Not imported — UNKNOWN. No open Pune soil dataset identified in EGR §C; site boreholes (subsurface records) are the only source here."),
    dict(id="geology", domain="geology", name="Geological map",
         recommended=[_rec("GSI geological maps (Bhukosh)", "Geological Survey of India", "https://bhukosh.gsi.gov.in/Bhukosh/MapViewer.aspx",
                           "Single-user, non-transferable licence (GSI Data Sharing & Accessibility Policy 2019)", "Cannot be redistributed in a shared model")],
         limitations="Not imported — UNKNOWN."),
    dict(id="air_quality", domain="air", name="Air-quality monitoring stations",
         recommended=[_rec("CAAQMS stations", "CPCB / MPCB / IITM", "https://airquality.cpcb.gov.in/ccr_docs/caaqms_list_all_india.pdf", "UNKNOWN", "Points only; no spatial surface")],
         limitations="Not imported — UNKNOWN. (Modelled emissions from the simulator are model output, not air quality.)"),
    dict(id="noise", domain="noise", name="Noise monitoring stations",
         recommended=[_rec("Real-time noise (NANMN)", "CPCB / MPCB", "https://cpcb.gov.in/Real-Time-Noise-Data/", "UNKNOWN", "Pune station status UNKNOWN")],
         limitations="Not imported — UNKNOWN."),
    dict(id="land_surface_temperature", domain="heat", name="Land surface temperature",
         recommended=[_rec("Landsat Collection 2 Surface Temperature", "USGS", "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature", "USGS public domain", "~100 m native thermal")],
         limitations="Not imported — UNKNOWN."),
    dict(id="land_cover", domain="vegetation", name="Land cover",
         recommended=[_rec("ESA WorldCover 2021 v200", "ESA / VITO", "https://esa-worldcover.org/en/data-access", "CC BY 4.0", "10 m; Pune accuracy UNKNOWN")],
         limitations="Not imported — UNKNOWN."),
    dict(id="tree_census", domain="vegetation", name="Tree census",
         recommended=[_rec("PMC Tree Census 2019 (OpenCity mirror)", "PMC via OpenCity", "https://data.opencity.in/dataset?organization=pune-municipal-corporation", "as labelled by OpenCity", "2019 vintage; schema UNKNOWN")],
         limitations="Not imported — UNKNOWN. OSM natural=tree (feasibility layers) is sparse and indicative only."),
    dict(id="drainage_network", domain="drainage", name="Storm-water drainage network",
         recommended=[], limitations="Not imported — UNKNOWN. No open PMC network with inverts found (EGR §C)."),
    dict(id="seismic_zone", domain="seismic", name="Seismic zone (IS 1893)",
         recommended=[_rec("IS 1893 (Part 1) seismic zone map", "Bureau of Indian Standards", "", "UNKNOWN", "Pune = Zone III per secondary sources only — TO VERIFY against the BIS map")],
         limitations="Not imported — UNKNOWN."),
    dict(id="dem", domain="terrain", name="Digital elevation model (analysis)",
         recommended=[_rec("Copernicus DEM GLO-30", "ESA / Copernicus", "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
                           "Free licence with attribution", "30 m DSM (includes buildings/trees); screening only")],
         limitations="Not imported — UNKNOWN. Cesium World Terrain is visual only (streamed, ion terms), not analysis data."),
    # OSM-derived layers: status computed on read from the local files (available only when the file exists)
    dict(id="osm_water", domain="water", name="Water bodies & waterways (OSM)", recommended=[],
         limitations="OSM presence is evidence a feature exists; absence proves nothing. Completeness UNKNOWN.", osm="feasibility:water"),
    dict(id="osm_heritage", domain="heritage", name="Heritage locators (OSM historic/heritage)", recommended=[],
         limitations="Locator only: ASI protected limits and the PMC heritage list are NOT in OSM.", osm="feasibility:heritage"),
    dict(id="osm_trees", domain="vegetation", name="Trees (OSM natural=tree)", recommended=[],
         limitations="Sparse in Pune; indicative only.", osm="feasibility:trees"),
    dict(id="osm_railway", domain="railway", name="Railways, non-metro (OSM)", recommended=[], limitations="OSM centrelines.", osm="feasibility:railway"),
    dict(id="osm_metro", domain="metro", name="Metro alignments & stations (OSM)", recommended=[
        _rec("Pune Metro project profile / alignment map", "MahaMetro", "https://www.punemetrorail.org/alignment-map", "UNKNOWN", "PDF maps; no official GIS; tunnel depths UNKNOWN")],
         limitations="OSM centrelines; tunnel crown/invert and deck levels UNKNOWN.", osm="osm_index:metro"),
]


def seed_coordination(session_factory) -> None:
    with session_factory() as db, acting_as(SEED_ACTOR):
        _seed(db)
        db.commit()


def _seed(db: Session) -> None:
    for r in RULE_SEEDS:
        if db.get(ClearanceRuleEntity, r["id"]) is None:
            db.add(ClearanceRuleEntity(created_by=SEED_ACTOR, active=True, **r))
    for l in LAYER_SEEDS:
        if db.get(EnvironmentLayerEntity, l["id"]) is None:
            src = l.get("osm")
            db.add(EnvironmentLayerEntity(
                id=l["id"], domain=l["domain"], name=l["name"], status="not_imported",
                source=(f"OpenStreetMap via local file ({src}); status computed on read" if src else ""),
                licence="ODbL 1.0 (OSM)" if src else "UNKNOWN",
                recommended_sources_json=json.dumps(l["recommended"]), limitations=l["limitations"], created_by=SEED_ACTOR))


def live_status(layer: EnvironmentLayerEntity) -> dict:
    """For OSM-derived rows: available only if the local file exists and holds the category."""
    seed = next((s for s in LAYER_SEEDS if s["id"] == layer.id), None)
    src = seed.get("osm") if seed else None
    if not src:
        return {"status": layer.status, "status_source": "catalogue"}
    try:
        if src.startswith("feasibility:"):
            from feasibility.layers import FeasibilityLayers
            st = FeasibilityLayers().status()
            cat = src.split(":", 1)[1]
            ok = st.get("available") and cat in (st.get("categories") or [])
            return {"status": "available" if ok else "not_imported", "status_source": "computed_on_read",
                    "data_date": st.get("dataTimestamp") if ok else None, "feature_count": (st.get("counts") or {}).get(cat) if ok else None,
                    "coverage_bbox": st.get("bbox") if ok else None}
        from osm.index import OsmIndex
        st = OsmIndex().status()
        ok = st.get("available") and "metro" in (st.get("capabilities") or [])
        return {"status": "available" if ok else "not_imported", "status_source": "computed_on_read",
                "data_date": st.get("dataTimestamp") if ok else None, "coverage_bbox": st.get("bbox") if ok else None}
    except Exception:  # noqa: BLE001
        return {"status": "not_imported", "status_source": "computed_on_read (file unreadable)"}
