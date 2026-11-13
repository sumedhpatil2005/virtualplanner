"""Terrain + subsurface evidence API (docs/urbanos/TERRAIN_AND_SUBSURFACE_DATA.md).

GET  /api/terrain/info                       DEM dataset + version + accuracy statement
GET  /api/terrain/point?lon=&lat=            bilinear DSM elevation at a point
POST /api/terrain/points   {points}          up to 500 points
POST /api/terrain/profile  {coordinates, step_m}
GET  /api/terrain/overlays                   hillshade / slope overlay metadata (bounds, legend, source, date)
GET  /api/terrain/overlays/{name}.png        pre-rendered overlay image (EPSG:4326)
POST /api/terrain/subsurface-evidence {coordinates, radius_km, max_wells, sewer_near_m}
Every response is screening-grade and carries the DSM warning.
"""
from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database.connection import get_db
from terrain import dem as D
from terrain import evidence as EV

router = APIRouter(prefix="/terrain", tags=["terrain"])
OVERLAYS = ("hillshade", "slope")


def _dem():
    try:
        return D.get_dem()
    except D.DemUnavailable as e:
        raise HTTPException(503, str(e))


def _meta(db, dem) -> dict:
    return dem.describe(D.registry_version(db, D.DATASET_ID, dem.version))


class ProfileBody(BaseModel):
    coordinates: List[List[float]] = Field(..., min_length=2, max_length=2000)
    step_m: float = Field(30.0, gt=0, le=1000)


class PointsBody(BaseModel):
    points: List[List[float]] = Field(..., min_length=1, max_length=500)


class EvidenceBody(BaseModel):
    coordinates: List[List[float]] = Field(..., min_length=2, max_length=2000)
    radius_km: float = Field(3.0, gt=0, le=20)
    max_wells: int = Field(8, ge=1, le=30)
    sewer_near_m: float = Field(50.0, ge=0, le=500)


def _check_ll(c):
    if len(c) < 2 or not (-180 <= c[0] <= 180 and -90 <= c[1] <= 90):
        raise HTTPException(422, f"invalid lon/lat {c}")


@router.get("/info")
def info(db: Session = Depends(get_db)):
    dem = _dem()
    return {"dataset": _meta(db, dem)}


@router.get("/point")
def point(lon: float, lat: float, db: Session = Depends(get_db)):
    _check_ll([lon, lat])
    dem = _dem()
    return {**dem.sample_lonlat(lon, lat), "dataset": _meta(db, dem)}


@router.post("/points")
def points(body: PointsBody, db: Session = Depends(get_db)):
    for c in body.points:
        _check_ll(c)
    dem = _dem()
    return {"points": [dem.sample_lonlat(c[0], c[1]) for c in body.points], "dataset": _meta(db, dem)}


@router.post("/profile")
def profile(body: ProfileBody, db: Session = Depends(get_db)):
    for c in body.coordinates:
        _check_ll(c)
    dem = _dem()
    try:
        prof = dem.profile(body.coordinates, body.step_m)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {**prof, "dataset": _meta(db, dem)}


@router.get("/overlays")
def overlays(db: Session = Depends(get_db)):
    dem = _dem()
    f = dem.dir / "overlays.json"
    if not f.exists():
        raise HTTPException(404, f"no overlays in {dem.version}; re-run python -m datasets.pipelines.elevation process")
    meta = json.loads(f.read_text())
    for k, o in meta.get("overlays", {}).items():
        o["url"] = f"/api/terrain/overlays/{k}.png"
    rv = D.registry_version(db, D.DATASET_ID, dem.version)
    meta.update({"dataset_id": D.DATASET_ID, "version": dem.version, "dataset_version_id": (rv or {}).get("id"),
                 "data_date": "Copernicus DEM GLO-30 2021 release (acquisitions 2011-2015)",
                 "processed_at": dem.processing.get("run_at"), "warning": D.DSM_WARNING})
    return meta


@router.get("/overlays/{name}.png")
def overlay_png(name: str):
    if name not in OVERLAYS:
        raise HTTPException(404, "unknown overlay")
    dem = _dem()
    f = dem.dir / f"overlay_{name}_epsg4326.png"
    if not f.exists():
        raise HTTPException(404, "overlay not rendered")
    return FileResponse(f, media_type="image/png", headers={"Cache-Control": "max-age=3600"})


@router.post("/subsurface-evidence")
def subsurface_evidence(body: EvidenceBody, db: Session = Depends(get_db)):
    for c in body.coordinates:
        _check_ll(c)
    dem = None
    try:
        dem = D.get_dem()
    except D.DemUnavailable:
        pass
    try:
        res = EV.evidence(body.coordinates, body.radius_km, body.max_wells, body.sewer_near_m, db=db, dem=dem)
    except ValueError as e:
        raise HTTPException(422, str(e))
    res["dem"] = _meta(db, dem) if dem else None
    return res
