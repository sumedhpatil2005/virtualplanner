"""Environment data API (docs/urbanos/ENVIRONMENT_DATA.md): catalogue of real derived datasets, server-rendered raster
views, capped bbox vector/point APIs, air-quality station series and rainfall summaries. Read-only."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response

from envdata import catalogue as cat
from envdata import render, series, trees, vectors

router = APIRouter(prefix="/env-data", tags=["environment-data"])


def _layer(lid: str, kind: str | None = None) -> cat.Layer:
    l = cat.BY_ID.get(lid)
    if l is None:
        raise HTTPException(404, f"Unknown layer {lid}")
    if l.fixed_status:
        raise HTTPException(409, f"{l.name}: {l.fixed_status} — {l.status_reason}")
    if kind and l.kind != kind:
        raise HTTPException(422, f"{lid} is a {l.kind} layer")
    return l


def _bbox(s: str) -> list[float]:
    try:
        return render.parse_bbox(s)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/catalogue")
def get_catalogue():
    return cat.catalogue()


@router.get("/layers/{lid}/render.png")
def render_layer(lid: str, bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat (WGS84)"),
                 width: int = Query(1024, ge=16, le=4096), variant: Optional[str] = None):
    l = _layer(lid, "raster")
    if variant and not any(v["id"] == variant for v in l.variants):
        raise HTTPException(422, f"unknown variant {variant}")
    try:
        data, meta = render.render_png(l, _bbox(bbox), width, variant)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return Response(data, media_type="image/png", headers={
        "X-UOS-Bounds": ",".join(str(v) for v in meta["bounds"]), "X-UOS-File": meta["file"], "X-UOS-Cache": meta["cache"],
        "Access-Control-Expose-Headers": "X-UOS-Bounds, X-UOS-File, X-UOS-Cache", "Cache-Control": "max-age=3600"})


@router.get("/layers/landcover_worldcover2021/areas")
def landcover_areas_bbox(bbox: Optional[str] = None):
    l = _layer("landcover_worldcover2021")
    if not bbox:
        return {"scope": "study area and inferred PMC/PCMC zones (precomputed)", **(render.landcover_city_areas(l) or {})}
    b = _bbox(bbox)
    geom = {"type": "Polygon", "coordinates": [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]]}
    try:
        return {"scope": "view", "bbox": b, **render.landcover_areas(l, geom)}
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/layers/landcover_worldcover2021/areas")
def landcover_areas_polygon(geometry: dict = Body(..., embed=True), label: str = Body("area", embed=True)):
    l = _layer("landcover_worldcover2021")
    if geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(422, "geometry must be a GeoJSON Polygon or MultiPolygon (WGS84)")
    try:
        return {"scope": label, **render.landcover_areas(l, geometry)}
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/layers/{lid}/features")
def layer_features(lid: str, bbox: str = Query(...), limit: int = Query(2000, ge=1, le=vectors.MAX_LIMIT)):
    l = _layer(lid, "vector")
    return vectors.features(l, _bbox(bbox), limit)


@router.get("/trees")
def tree_points(bbox: str = Query(...), limit: int = Query(2000, ge=1, le=trees.MAX_LIMIT)):
    _layer("tree_census_2019")
    if not trees.db_path().exists():
        raise HTTPException(404, "tree index not built: python -m datasets.pipelines.tree_index")
    return trees.query(_bbox(bbox), limit)


@router.post("/trees/count")
def tree_count(geometry: dict = Body(..., embed=True)):
    _layer("tree_census_2019")
    if not trees.db_path().exists():
        raise HTTPException(404, "tree index not built")
    return trees.count_in_polygon(geometry)


@router.get("/air/stations")
def air_stations():
    _layer("air_cpcb_caaqms")
    return series.aq_stations()


@router.get("/air/series")
def air_series(station: str, param: str = "pm25_ugm3", agg: str = "day", start: Optional[str] = None, end: Optional[str] = None):
    _layer("air_cpcb_caaqms")
    try:
        return series.aq_series(station, param, agg, start, end)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/rainfall/summary")
def rainfall_summary():
    return series.rainfall_summary()


@router.get("/rainfall/daily")
def rainfall_daily(cell_lon: float, cell_lat: float, year: int):
    try:
        return series.rainfall_daily(cell_lon, cell_lat, year)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
