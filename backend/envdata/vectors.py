"""Bbox vector API for derived line/point layers (streams from the DEM). The GeoJSON (EPSG:32643) is reprojected to WGS84
once per file version and held with an STRtree; responses are capped with an explicit "N more not shown" count."""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Sequence

from . import paths
from .catalogue import Layer

MAX_LIMIT = 5000


@lru_cache(maxsize=4)
def _load(path: str, mtime: float):
    from pyproj import Transformer
    from shapely import STRtree
    from shapely.geometry import shape
    from shapely.ops import transform
    gj = json.loads(open(path).read())
    t = Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True)
    geoms, props = [], []
    for f in gj["features"]:
        g = transform(t.transform, shape(f["geometry"]))
        geoms.append(g)
        props.append({**(f.get("properties") or {}), "fid": f.get("id")})
    return geoms, props, STRtree(geoms)


def features(layer: Layer, bbox: Sequence[float], limit: int = 2000) -> dict:
    from shapely.geometry import box, mapping
    p = paths.derived(layer.dataset, layer.version, layer.file)
    geoms, props, tree = _load(str(p), p.stat().st_mtime)
    b = box(*bbox)
    idx = [int(i) for i in tree.query(b, predicate="intersects")]
    limit = max(1, min(MAX_LIMIT, int(limit)))
    # longest first, so a capped response keeps the main channels
    idx.sort(key=lambda i: -geoms[i].length)
    keep = idx[:limit]
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": props[i].get("fid"), "properties": props[i],
         "geometry": mapping(geoms[i].simplify(0.00005, preserve_topology=False))} for i in keep]}
    return {"total": len(idx), "returned": len(keep), "not_shown": len(idx) - len(keep), "limit": limit, "geojson": fc}
