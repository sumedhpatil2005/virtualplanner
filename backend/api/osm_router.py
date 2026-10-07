"""
Roads and traffic signals from the local OpenStreetMap index (see osm/index.py).

Answers are shaped like the Overpass API's (`{"elements": [...]}`), so the
frontend imports them with the same code it uses for Overpass.
"""

from fastapi import APIRouter, HTTPException, Query

from osm.index import OsmIndex, parse_boxes

router = APIRouter()
index = OsmIndex()

BBOX_HELP = "One or more boxes as minLng,minLat,maxLng,maxLat, separated by ';'"


def _boxes(bbox: str):
    try:
        boxes = parse_boxes(bbox)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not index.available():
        raise HTTPException(status_code=404, detail="The local OpenStreetMap index has not been built. Run: python -m osm.build_index")
    if not index.covers(boxes):
        raise HTTPException(status_code=416, detail="The local OpenStreetMap index does not cover this area.")
    return boxes


@router.get("/osm/status")
def osm_status():
    return index.status()


@router.get("/osm/ways")
def osm_ways(bbox: str = Query(..., description=BBOX_HELP)):
    return {"elements": index.ways(_boxes(bbox))}


@router.get("/osm/signals")
def osm_signals(bbox: str = Query(..., description=BBOX_HELP)):
    return {"elements": index.signals(_boxes(bbox))}
