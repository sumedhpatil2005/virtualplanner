"""
Quality checks on a dataset version (append-only results; docs/urbanos/DATA_QUALITY_AND_PROVENANCE.md §4).

Checks: classification, licence, crs, pune_coverage, staleness, checksum (files on disk), geometry_validity and
duplicates (GeoJSON files up to 50 MB, or the base city objects in the app database). A check that cannot be run says
`unknown` or `not_applicable` with the reason — never `pass`.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re

from sqlalchemy import text
from sqlalchemy.orm import Session

from .models import DsDatasetEntity, DsDatasetVersionEntity, DsFileEntity, DsQualityCheckEntity
from .registry import _j, new_id
from .vocab import PUNE_BBOX, data_root

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOJSON_MAX_BYTES = 50 * 1024 * 1024
HASH_MAX_BYTES = 2 * 1024 ** 3


# registry paths whose real location the app reads from an environment variable
ENV_OVERRIDES = {"data/osm/osm_index.db": "TWINCITY_OSM_INDEX", "data/osm/feasibility_layers.db": "TWINCITY_FEAS_LAYERS"}


def resolve_path(p: str) -> str:
    env = ENV_OVERRIDES.get(p)
    if env and os.environ.get(env):
        return os.environ[env]
    if os.path.isabs(p):
        return p
    for base in (data_root(), BACKEND_DIR, os.path.dirname(BACKEND_DIR)):
        cand = os.path.join(base, p)
        if os.path.exists(cand):
            return cand
    return os.path.join(data_root(), p)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _parse_date(s: str | None) -> datetime.datetime | None:
    if not s:
        return None
    m = re.match(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", str(s).strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2) or 12), int(m.group(3) or 28)
    try:
        return datetime.datetime(y, mo, d)
    except ValueError:
        return None


def bbox_fraction_of_pune(bbox) -> float | None:
    if not bbox or len(bbox) != 4:
        return None
    a0, b0, a1, b1 = PUNE_BBOX
    x0, y0, x1, y1 = (float(v) for v in bbox)
    ix = max(0.0, min(a1, x1) - max(a0, x0))
    iy = max(0.0, min(b1, y1) - max(b0, y0))
    return (ix * iy) / ((a1 - a0) * (b1 - b0))


def _polygon_fraction(geojson) -> float | None:
    try:
        from shapely.geometry import box, shape
        g = shape(geojson.get("geometry", geojson) if isinstance(geojson, dict) and geojson.get("type") == "Feature" else geojson)
        pune = box(*PUNE_BBOX)
        return g.intersection(pune).area / pune.area
    except Exception:  # noqa: BLE001
        return None


def _add(db: Session, version_id: str, check: str, status: str, detail: str, value=None) -> dict:
    row = DsQualityCheckEntity(id=new_id("dsq"), version_id=version_id, check=check, status=status, detail=detail,
                               value=None if value is None else str(value))
    db.add(row)
    return {"check": check, "status": status, "detail": detail, "value": row.value}


def run_checks(db: Session, v: DsDatasetVersionEntity, *, hash_files: bool = True, hash_max_bytes: int = HASH_MAX_BYTES,
               now: datetime.datetime | None = None) -> list[dict]:
    now = now or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    ds = db.get(DsDatasetEntity, v.dataset_id)
    out: list[dict] = []
    stats = _j(v.stats_json, {}) or {}

    # classification
    if v.data_class and v.suitability:
        out.append(_add(db, v.id, "classification", "pass", f"{v.data_class}; suitable for {v.suitability}"))
    else:
        out.append(_add(db, v.id, "classification", "fail",
                        "data class and/or suitability not recorded — the version cannot satisfy a feature until reviewed"))

    # licence
    lic = (v.licence_text or "").strip()
    if not lic or lic.upper().startswith("UNKNOWN"):
        out.append(_add(db, v.id, "licence", "warn", "licence UNKNOWN — reuse and redistribution not established"))
    else:
        out.append(_add(db, v.id, "licence", "pass" if v.licence_url else "warn",
                        lic[:200] + ("" if v.licence_url else " (no licence URL recorded)")))

    # CRS
    if not v.crs:
        out.append(_add(db, v.id, "crs", "unknown", "CRS not recorded"))
    elif v.crs.lower().startswith("n/a"):
        out.append(_add(db, v.id, "crs", "not_applicable", v.crs))
    else:
        try:
            from pyproj import CRS
            m = re.search(r"EPSG:\d+", v.crs)
            c = CRS.from_user_input(m.group(0) if m else v.crs)
            out.append(_add(db, v.id, "crs", "pass", f"{c.to_string()} — {c.name}", c.to_epsg()))
        except Exception as e:  # noqa: BLE001
            out.append(_add(db, v.id, "crs", "fail", f"CRS '{v.crs}' not recognised: {e}"[:300]))

    # coverage of the Pune study box
    frac = _polygon_fraction(_j(v.coverage_geojson)) if v.coverage_geojson else bbox_fraction_of_pune(_j(v.coverage_bbox_json))
    if frac is None:
        out.append(_add(db, v.id, "pune_coverage", "unknown", "coverage not stated — absence of features proves nothing"))
    else:
        pct = round(frac * 100, 1)
        st = "pass" if frac >= 0.99 else "warn" if frac > 0 else "fail"
        out.append(_add(db, v.id, "pune_coverage", st,
                        f"{pct}% of the Pune study box {list(PUNE_BBOX)} inside the stated coverage"
                        + (" (from the bounding box; the polygon may be smaller)" if not v.coverage_geojson else ""), pct))

    # staleness
    ref_s = v.observation_end or v.source_updated_date or v.published_date or v.observation_start
    ref = _parse_date(ref_s)
    if ds is None or ds.max_age_days is None:
        out.append(_add(db, v.id, "staleness", "not_applicable" if ref else "unknown",
                        "no staleness threshold set for this dataset" + (f"; reference date {ref_s}" if ref else "; no data date recorded")))
    elif ref is None:
        out.append(_add(db, v.id, "staleness", "unknown", "no observation / publication / update date recorded"))
    else:
        age = (now - ref).days
        st = "pass" if age <= ds.max_age_days else "warn" if age <= 3 * ds.max_age_days else "fail"
        out.append(_add(db, v.id, "staleness", st, f"data date {ref_s}: {age} days old (threshold {ds.max_age_days} days)", age))

    # checksum of files on disk
    files = list(db.query(DsFileEntity).filter(DsFileEntity.version_id == v.id))
    if not files:
        out.append(_add(db, v.id, "checksum", "not_applicable" if v.retrieved_at is None else "unknown",
                        "nothing stored locally (streamed or catalogue-only)" if v.retrieved_at is None else "no files registered"))
    else:
        missing, bad, ok, skipped = [], [], [], []
        for f in files:
            p = resolve_path(f.path)
            if not os.path.exists(p):
                missing.append(f.path)
                continue
            if not f.sha256 or not hash_files or os.path.getsize(p) > hash_max_bytes:
                skipped.append(f.path)
                continue
            (ok if sha256_file(p) == f.sha256 else bad).append(f.path)
        if bad:
            out.append(_add(db, v.id, "checksum", "fail", f"sha256 mismatch: {', '.join(bad)}"))
        elif missing:
            out.append(_add(db, v.id, "checksum", "fail", f"file not present at the recorded path: {', '.join(missing)}"))
        elif skipped and not ok:
            out.append(_add(db, v.id, "checksum", "unknown", f"present, not hashed (no recorded sha256 or too large): {', '.join(skipped)}"))
        else:
            out.append(_add(db, v.id, "checksum", "pass", f"{len(ok)} file(s) present, sha256 matches"
                            + (f"; {len(skipped)} not hashed" if skipped else "")))

    # geometry validity + duplicates
    geo = _geometry_checks(db, v, ds, files)
    for check, status, detail, value in geo:
        out.append(_add(db, v.id, check, status, detail, value))
    db.flush()
    return out


def _geometry_checks(db: Session, v, ds, files) -> list[tuple]:
    if ds is not None and ds.id == "twincity_base_osm_objects":
        return _city_object_checks(db, osm=True)
    if ds is not None and ds.id == "twincity_demo_seed":
        return _city_object_checks(db, osm=False)
    gj = [f for f in files if (f.format or "").lower() in ("geojson", "json") or f.path.lower().endswith(".geojson")]
    for f in gj:
        p = resolve_path(f.path)
        if not os.path.exists(p) or os.path.getsize(p) > GEOJSON_MAX_BYTES:
            continue
        try:
            with open(p, encoding="utf-8") as fh:
                doc = json.load(fh)
        except Exception as e:  # noqa: BLE001
            return [("geometry_validity", "fail", f"{f.path}: not readable JSON ({e})"[:300], None),
                    ("duplicates", "unknown", "file not readable", None)]
        feats = doc.get("features") if isinstance(doc, dict) else None
        if feats is None:
            continue
        return _feature_checks(feats, f.path)
    fmts = {(f.format or os.path.splitext(f.path)[1].lstrip(".")).lower() for f in files}
    if not files:
        return [("geometry_validity", "not_applicable", "no local file", None), ("duplicates", "not_applicable", "no local file", None)]
    why = f"no reader in the registry for format(s) {sorted(fmts)} — checked by the producing pipeline (see processing validation)"
    return [("geometry_validity", "unknown", why, None), ("duplicates", "unknown", why, None)]


def _feature_checks(feats: list, label: str) -> list[tuple]:
    from shapely import wkb
    from shapely.geometry import shape
    invalid = empty = 0
    ids: dict = {}
    geoms: dict = {}
    for ft in feats:
        g = ft.get("geometry")
        if not g:
            empty += 1
            continue
        try:
            s = shape(g)
        except Exception:  # noqa: BLE001
            invalid += 1
            continue
        if s.is_empty:
            empty += 1
        elif not s.is_valid:
            invalid += 1
        k = wkb.dumps(s, hex=True) if not s.is_empty else None
        if k:
            geoms[k] = geoms.get(k, 0) + 1
        fid = ft.get("id") or (ft.get("properties") or {}).get("id")
        if fid is not None:
            ids[fid] = ids.get(fid, 0) + 1
    n = len(feats)
    dup_ids = sum(c - 1 for c in ids.values() if c > 1)
    dup_geoms = sum(c - 1 for c in geoms.values() if c > 1)
    gv = ("pass" if invalid == 0 and empty == 0 else "warn" if invalid / max(n, 1) < 0.01 else "fail",
          f"{label}: {n} features, {invalid} invalid, {empty} without geometry", invalid)
    du = ("pass" if dup_ids == 0 and dup_geoms == 0 else "warn",
          f"{dup_ids} duplicate ids, {dup_geoms} exact duplicate geometries", dup_ids + dup_geoms)
    return [("geometry_validity",) + gv, ("duplicates",) + du]


def _object_shape(typ: str, coords):
    """city_objects.geometry_geojson holds a bare coordinate list ([lon, lat, z] ...), or a GeoJSON geometry."""
    from shapely.geometry import LineString, Point, Polygon, shape
    if isinstance(coords, dict):
        return shape(coords)
    if not isinstance(coords, list) or not coords:
        return None
    if isinstance(coords[0], (int, float)):
        return Point(coords[:2])
    pts = [tuple(c[:2]) for c in coords]
    if len(pts) == 1:
        return Point(pts[0])
    if typ in ("building", "zone", "area", "park", "land_use") and len(pts) >= 3:
        return Polygon(pts)
    return LineString(pts)


def _city_object_checks(db: Session, osm: bool) -> list[tuple]:
    cond = "(properties_json LIKE '%osmProvenance%' OR properties_json LIKE '%\"osmId\"%')"
    if not osm:
        cond = "NOT " + cond
    rows = db.execute(text(f"SELECT id, type, geometry_geojson, properties_json FROM city_objects WHERE scenario_id = 'base' AND {cond}")).all()
    if not rows:
        return [("geometry_validity", "unknown", "no base city objects in this database", 0), ("duplicates", "unknown", "no base city objects", 0)]
    invalid = 0
    osm_ids: dict = {}
    for _id, typ, g, props in rows:
        try:
            s = _object_shape(typ, json.loads(g))
            if s is None or s.is_empty or not s.is_valid:
                invalid += 1
        except Exception:  # noqa: BLE001
            invalid += 1
        if osm:
            m = re.search(r'"osmSourceId":\s*"([^"]+)"', props or "") or re.search(r'"osmId":\s*(\d+)', props or "")
            if m:
                key = (typ, m.group(1))
                osm_ids[key] = osm_ids.get(key, 0) + 1
    n = len(rows)
    dups = sum(c - 1 for c in osm_ids.values() if c > 1)
    return [("geometry_validity", "pass" if invalid == 0 else "warn" if invalid / n < 0.01 else "fail",
             f"{n} base objects in the app database, {invalid} invalid/empty geometries (planar validity of lon/lat)", invalid),
            ("duplicates", ("pass" if dups == 0 else "warn") if osm else "not_applicable",
             f"{dups} objects share an OSM element with another object of the same type" if osm else "demo objects have no OSM id", dups)]
