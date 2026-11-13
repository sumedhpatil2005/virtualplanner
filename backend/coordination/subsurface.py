"""
Subsurface record import: AGS4 subset (PROJ, LOCA, GEOL, WSTK, ISPT) and CSV templates for boreholes; CSV / JSON for
utility records with an ASCE 38 quality level. No dependency (plain csv parsing).

AGS4 headings used (AGS4 data dictionary, open-geotechnical unofficial copy of the dictionary, READ 2026-11-13:
https://open-geotechnical.github.io/unofficial-ags4-data-dict/group/LOCA.html , .../GEOL.html , .../ISPT.html):
LOCA_ID, LOCA_TYPE, LOCA_NATE, LOCA_NATN, LOCA_GREF, LOCA_GL, LOCA_FDEP; GEOL_TOP, GEOL_BASE, GEOL_DESC, GEOL_LEG,
GEOL_GEOL; ISPT_TOP, ISPT_NVAL. LOCA_LAT / LOCA_LON and WSTK_DEP are read when present (headings not re-verified this
session). A location is taken from LOCA_LAT/LOCA_LON, or from LOCA_NATE/LOCA_NATN when the grid is EPSG:32643 / UTM 43N
(stated in LOCA_GREF or declared by the importer); otherwise the location is UNKNOWN and the record is kept without geometry.

Depth certainty for utilities (ASCE 38-22 quality levels, as summarised in docs/urbanos/PRODUCT_UX_RESEARCH.md §3,
source EXCERPT): only QL-A (exposed/measured) depth is `measured`; QL-B/C/D depth is `estimated`; no QL = `unknown`
quality (depth, when given, `estimated`); no depth = `unknown`.
"""
from __future__ import annotations

import csv
import io
import re
from typing import Optional

from .geometry import from_utm

QL_CERTAINTY = {"QL-A": "measured", "QL-B": "estimated", "QL-C": "estimated", "QL-D": "estimated"}


def _f(v) -> Optional[float]:
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_ags4(text: str) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    cur, heads = None, None
    for row in csv.reader(io.StringIO(text)):
        if not row or not any(c.strip() for c in row):
            continue
        tag = row[0].strip().upper()
        if tag == "GROUP":
            cur, heads = row[1].strip().upper(), None
            groups.setdefault(cur, [])
        elif tag == "HEADING" and cur:
            heads = [h.strip().upper() for h in row[1:]]
        elif tag == "DATA" and cur and heads:
            groups[cur].append(dict(zip(heads, [c.strip() for c in row[1:]])))
    return groups


def _is_utm43(gref: str) -> bool:
    g = (gref or "").upper().replace(" ", "")
    return "32643" in g or "UTM43N" in g or "UTMZONE43N" in g


def boreholes_from_ags4(text: str, grid_epsg: Optional[int] = None) -> tuple[list[dict], list[str], dict]:
    g = parse_ags4(text)
    warnings: list[str] = []
    if "LOCA" not in g:
        raise ValueError("No LOCA group: not an AGS4 file this importer can read (needs GROUP/HEADING/DATA rows)")
    proj = (g.get("PROJ") or [{}])[0]
    out: dict[str, dict] = {}
    for loc in g["LOCA"]:
        lid = loc.get("LOCA_ID") or ""
        if not lid:
            warnings.append("LOCA row without LOCA_ID skipped")
            continue
        lon, lat = _f(loc.get("LOCA_LON")), _f(loc.get("LOCA_LAT"))
        note = ""
        if lon is None or lat is None:
            e, n = _f(loc.get("LOCA_NATE")), _f(loc.get("LOCA_NATN"))
            if e is not None and n is not None and (_is_utm43(loc.get("LOCA_GREF", "")) or grid_epsg == 32643):
                lon, lat = from_utm(e, n)
                note = "location from LOCA_NATE/NATN (EPSG:32643 " + ("stated in LOCA_GREF" if _is_utm43(loc.get("LOCA_GREF", "")) else "declared by importer") + ")"
            else:
                lon = lat = None
                note = "location UNKNOWN (no LOCA_LAT/LOCA_LON and grid is not EPSG:32643)"
                warnings.append(f"{lid}: {note}")
        else:
            note = "location from LOCA_LAT/LOCA_LON"
        out[lid] = {"external_id": lid, "lon": lon, "lat": lat, "location_note": note, "ground_level_m": _f(loc.get("LOCA_GL")),
                    "final_depth_m": _f(loc.get("LOCA_FDEP")), "strata": [], "water_strikes": [], "spt": [],
                    "properties": {"LOCA_TYPE": loc.get("LOCA_TYPE"), "LOCA_GREF": loc.get("LOCA_GREF"), "PROJ_ID": proj.get("PROJ_ID"), "PROJ_NAME": proj.get("PROJ_NAME")}}
    for gr in g.get("GEOL", []):
        b = out.get(gr.get("LOCA_ID", ""))
        if b is None:
            warnings.append(f"GEOL row for unknown LOCA_ID {gr.get('LOCA_ID')!r} skipped")
            continue
        b["strata"].append({"top_m": _f(gr.get("GEOL_TOP")), "base_m": _f(gr.get("GEOL_BASE")), "description": gr.get("GEOL_DESC", ""),
                            "legend": gr.get("GEOL_LEG"), "geology": gr.get("GEOL_GEOL")})
    for w in g.get("WSTK", []):
        b = out.get(w.get("LOCA_ID", ""))
        if b is not None and _f(w.get("WSTK_DEP")) is not None:
            b["water_strikes"].append(_f(w.get("WSTK_DEP")))
    for s in g.get("ISPT", []):
        b = out.get(s.get("LOCA_ID", ""))
        if b is not None:
            b["spt"].append({"top_m": _f(s.get("ISPT_TOP")), "n": _f(s.get("ISPT_NVAL"))})
    used = sorted(k for k in g if k in ("PROJ", "LOCA", "GEOL", "WSTK", "ISPT"))
    ignored = sorted(k for k in g if k not in used)
    if ignored:
        warnings.append("AGS4 groups not imported (outside the subset): " + ", ".join(ignored))
    return list(out.values()), warnings, {"groups_used": used, "groups_ignored": ignored, "proj": proj}


BOREHOLE_CSV_COLUMNS = ["borehole_id", "lon", "lat", "ground_level_m", "final_depth_m", "stratum_top_m", "stratum_base_m",
                        "description", "water_strike_m", "spt_top_m", "spt_n"]
UTILITY_CSV_COLUMNS = ["utility_id", "utility_type", "owner", "geometry", "depth_m", "diameter_m", "quality_level", "survey_method"]


def boreholes_from_csv(text: str) -> tuple[list[dict], list[str], dict]:
    rd = csv.DictReader(io.StringIO(text))
    if not rd.fieldnames or "borehole_id" not in [f.strip() for f in rd.fieldnames]:
        raise ValueError("CSV needs a header row with at least borehole_id (template: " + ",".join(BOREHOLE_CSV_COLUMNS) + ")")
    out: dict[str, dict] = {}
    warnings: list[str] = []
    for i, r in enumerate(rd, start=2):
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        bid = r.get("borehole_id")
        if not bid:
            warnings.append(f"row {i}: no borehole_id, skipped")
            continue
        b = out.get(bid)
        if b is None:
            lon, lat = _f(r.get("lon")), _f(r.get("lat"))
            b = out[bid] = {"external_id": bid, "lon": lon, "lat": lat,
                            "location_note": "location from CSV lon/lat" if lon is not None and lat is not None else "location UNKNOWN",
                            "ground_level_m": _f(r.get("ground_level_m")), "final_depth_m": _f(r.get("final_depth_m")),
                            "strata": [], "water_strikes": [], "spt": [], "properties": {}}
            if lon is None or lat is None:
                warnings.append(f"{bid}: location UNKNOWN")
        if _f(r.get("stratum_top_m")) is not None or r.get("description"):
            b["strata"].append({"top_m": _f(r.get("stratum_top_m")), "base_m": _f(r.get("stratum_base_m")), "description": r.get("description", "")})
        if _f(r.get("water_strike_m")) is not None:
            b["water_strikes"].append(_f(r.get("water_strike_m")))
        if _f(r.get("spt_top_m")) is not None:
            b["spt"].append({"top_m": _f(r.get("spt_top_m")), "n": _f(r.get("spt_n"))})
    return list(out.values()), warnings, {"columns": rd.fieldnames}


def _parse_line(text: str) -> Optional[dict]:
    t = (text or "").strip()
    if not t:
        return None
    m = re.match(r"^\s*LINESTRING\s*\((.*)\)\s*$", t, re.I)
    body = m.group(1) if m else t
    sep = "," if m else ";"
    pts = []
    for p in body.split(sep):
        xy = p.strip().split()
        if len(xy) >= 2:
            pts.append([float(xy[0]), float(xy[1])])
    if len(pts) >= 2:
        return {"type": "LineString", "coordinates": pts}
    if len(pts) == 1:
        return {"type": "Point", "coordinates": pts[0]}
    return None


def utility_record(raw: dict, i: int, warnings: list[str]) -> dict:
    uid = str(raw.get("utility_id") or raw.get("id") or f"row{i}")
    geom = raw.get("geometry")
    if isinstance(geom, str):
        try:
            geom = _parse_line(geom)
        except ValueError:
            geom = None
    if not geom:
        warnings.append(f"{uid}: geometry UNKNOWN (record kept without location)")
    ql = (raw.get("quality_level") or "").strip().upper().replace("QL", "QL-").replace("QL--", "QL-") or None
    if ql and ql not in QL_CERTAINTY:
        warnings.append(f"{uid}: quality level {raw.get('quality_level')!r} not one of QL-A..QL-D — treated as UNKNOWN")
        ql = None
    depth, dia = _f(raw.get("depth_m")), _f(raw.get("diameter_m"))
    if depth is None:
        cert = "unknown"
    elif ql:
        cert = QL_CERTAINTY[ql]
    else:
        cert = "estimated"
        warnings.append(f"{uid}: depth given without an ASCE 38 quality level — depth treated as estimated")
    z_max = -depth if depth is not None else None
    z_min = -(depth + dia) if depth is not None and dia is not None else None
    if depth is not None and dia is None:
        warnings.append(f"{uid}: diameter UNKNOWN — bottom of utility (z_min) UNKNOWN")
    return {"external_id": uid, "geometry": geom, "utility_type": raw.get("utility_type") or None, "owner": raw.get("owner") or None,
            "depth_m": depth, "diameter_m": dia, "quality_level": ql, "survey_method": raw.get("survey_method") or None,
            "z_min_m": z_min, "z_max_m": z_max, "z_certainty": cert}


def utilities_from_csv(text: str) -> tuple[list[dict], list[str], dict]:
    rd = csv.DictReader(io.StringIO(text))
    if not rd.fieldnames or "utility_id" not in [f.strip() for f in rd.fieldnames]:
        raise ValueError("CSV needs a header row with at least utility_id (template: " + ",".join(UTILITY_CSV_COLUMNS) + ")")
    warnings: list[str] = []
    recs = [utility_record({k.strip(): v for k, v in r.items() if k}, i, warnings) for i, r in enumerate(rd, start=2)]
    return recs, warnings, {"columns": rd.fieldnames}
