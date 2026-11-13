"""Streaming KML/KMZ -> GeoJSON-feature reader (stdlib only, no GDAL).

Handles what the Pune portals actually publish (OGR/QGIS and Google Earth exports):
Placemark with Point / LineString / Polygon (outer + inner rings) / MultiGeometry,
attributes from ExtendedData/SchemaData/SimpleData and ExtendedData/Data/value,
plus <name>. Coordinates are KML lon,lat[,alt] in WGS84 (KML 2.2 mandates
EPSG:4326), so no reprojection is needed; altitude is kept only if non-zero.
Memory: iterparse + element clearing, so the 363 MB SWD KML streams fine.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import IO, Iterator
from xml.etree import ElementTree as ET


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _parse_coords(text: str | None) -> list[list[float]]:
    pts = []
    for tok in (text or "").replace("\n", " ").replace("\t", " ").split(" "):
        tok = tok.strip()
        if not tok:
            continue
        parts = tok.split(",")
        if len(parts) < 2:
            continue
        try:
            xy = [float(parts[0]), float(parts[1])]
        except ValueError:
            continue
        if len(parts) > 2:
            try:
                z = float(parts[2])
                if z != 0.0:
                    xy.append(z)
            except ValueError:
                pass
        pts.append(xy)
    return pts


def _children(el, name):
    return [c for c in el if _local(c.tag) == name]


def _find_desc(el, name):
    for c in el.iter():
        if _local(c.tag) == name:
            return c
    return None


def _geom(el) -> dict | None:
    t = _local(el.tag)
    if t == "Point":
        c = _find_desc(el, "coordinates")
        pts = _parse_coords(c.text if c is not None else None)
        return {"type": "Point", "coordinates": pts[0]} if pts else None
    if t == "LineString" or t == "LinearRing":
        c = _find_desc(el, "coordinates")
        pts = _parse_coords(c.text if c is not None else None)
        return {"type": "LineString", "coordinates": pts} if len(pts) >= 2 else None
    if t == "Polygon":
        rings = []
        for bname in ("outerBoundaryIs", "innerBoundaryIs"):
            for b in _children(el, bname):
                c = _find_desc(b, "coordinates")
                pts = _parse_coords(c.text if c is not None else None)
                if len(pts) >= 3:
                    if pts[0] != pts[-1]:
                        pts.append(list(pts[0]))
                    rings.append(pts)
        return {"type": "Polygon", "coordinates": rings} if rings else None
    if t == "MultiGeometry":
        parts = [g for g in (_geom(c) for c in el) if g]
        if not parts:
            return None
        kinds = {p["type"] for p in parts}
        if kinds == {"Point"}:
            return {"type": "MultiPoint", "coordinates": [p["coordinates"] for p in parts]} if len(parts) > 1 else parts[0]
        if kinds == {"LineString"}:
            return {"type": "MultiLineString", "coordinates": [p["coordinates"] for p in parts]} if len(parts) > 1 else parts[0]
        if kinds == {"Polygon"}:
            return {"type": "MultiPolygon", "coordinates": [p["coordinates"] for p in parts]} if len(parts) > 1 else parts[0]
        # flatten nested multis of the same base kind
        flat = []
        for p in parts:
            if p["type"].startswith("Multi"):
                base = p["type"][5:]
                flat += [{"type": base, "coordinates": c} for c in p["coordinates"]]
            else:
                flat.append(p)
        kinds = {p["type"] for p in flat}
        if len(kinds) == 1:
            k = kinds.pop()
            return {"type": "Multi" + k, "coordinates": [p["coordinates"] for p in flat]}
        return {"type": "GeometryCollection", "geometries": flat}
    return None


GEOM_TAGS = {"Point", "LineString", "Polygon", "MultiGeometry", "LinearRing"}


def placemark_to_feature(pm) -> dict:
    props: dict = {}
    geom = None
    for c in pm:
        t = _local(c.tag)
        if t == "name" and c.text and c.text.strip():
            props["name"] = c.text.strip()
        elif t == "ExtendedData":
            for d in c.iter():
                dt = _local(d.tag)
                if dt == "SimpleData":
                    props[d.get("name")] = (d.text or "").strip()
                elif dt == "Data":
                    v = _find_desc(d, "value")
                    props[d.get("name")] = (v.text or "").strip() if v is not None else ""
        elif t in GEOM_TAGS and geom is None:
            geom = _geom(c)
    fid = pm.get("id")
    f = {"type": "Feature", "properties": props, "geometry": geom}
    if fid:
        f["id"] = fid
    return f


def open_kml_stream(path: Path) -> IO[bytes]:
    if path.suffix.lower() == ".kmz" or zipfile.is_zipfile(path):
        z = zipfile.ZipFile(path)
        names = [n for n in z.namelist() if n.lower().endswith(".kml")]
        if not names:
            raise ValueError(f"{path}: KMZ contains no .kml")
        main = "doc.kml" if "doc.kml" in names else names[0]
        return z.open(main)
    return open(path, "rb")


def iter_features(source: Path | bytes) -> Iterator[dict]:
    fh = io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else open_kml_stream(Path(source))
    try:
        for event, el in ET.iterparse(fh, events=("end",)):
            if _local(el.tag) == "Placemark":
                yield placemark_to_feature(el)
                el.clear()
    finally:
        fh.close()
