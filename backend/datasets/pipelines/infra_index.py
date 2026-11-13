"""
Spatial index of the municipal infrastructure layers (PMC via OpenCity) and the merged OSM + Microsoft + Google buildings
layer, for bbox queries from the API (Explore layers, coordination conflict detection). docs/urbanos/INFRASTRUCTURE_DATA.md.

Output: <derived>/infra_index/<version>/infra_index.sqlite + processing.json
  layers(id, title, grp, dataset_id, …, licence, data_class, suitability, notes, feature_count, bbox)
  f_<layer>(fid INTEGER PRIMARY KEY, ext_id, props JSON, wkb BLOB)   — geometry WGS84 (EPSG:4326) WKB
  r_<layer>  (SQLite R*Tree: fid, min_lon, max_lon, min_lat, max_lat)

Rules (documented, deterministic):
- Inputs are the derived GeoJSON / FlatGeobuf outputs named in each source's processing.json (sha256 verified). Raw files
  are never read or modified here.
- Storm-water drains: only rows with category == "Storm water drains" (9,187) are storm drains. Rows with a sewer category
  (Road_Sewer, Nalla_Sewer, River_Sewer) carry sewer ids (KN-CO-…, drainaige_ Collection/Trunk sewer) and are sewer rows
  published inside the storm-water file: dropped here (the sewer layer is the PMC sewer file as published). Rows with
  category "Nalla" (3,227) are dropped too (the separate PMC nalla layer carries nallas). Counts are written to validation.
- Sewer depth: invert depth = cover (top) level − invert level, at each end, only when both levels are present, positive and
  cover > invert; pipe top depth = invert depth − internal diameter (pipe wall thickness UNKNOWN). Both levels are DESIGN
  values as published: flagged unverified. Otherwise depth UNKNOWN (null). Nothing is filled in.
- Buildings: every feature keeps its source, source id, confidence (Google only; Microsoft and OSM have none → null),
  OSM-agreement status and class: OSM = observed (volunteer-mapped), ML = inferred. Height is null (UNKNOWN) unless an OSM
  `height` tag is present (taken as tagged, metres, observed by volunteers); `building:levels` is reported as tagged, never
  converted to a height.

CLI: python -m datasets.pipelines.infra_index [--version v1] [--layers a,b] [--skip-buildings]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import time
from pathlib import Path

from .gov_common import derived_root, git_commit, git_dirty, now_ist, sha256_file

OPENCITY_LICENCE_NOTE = ("Licence statements conflict (docs/urbanos/catalogue/india.md): CKAN licence field as quoted; OpenCity FAQ "
                         "'All our data is under ODbL… credit OpenCity'; OpenCity site terms 'non-commercial and / or personal use only'. "
                         "UrbanOS treats reuse as NON-COMMERCIAL with attribution 'OpenCity + Pune Municipal Corporation' until PMC confirms.")
OPENCITY_LICENCE_URL = "https://opencity.in/faqs/"
GROUP_MUNI = "Municipal infrastructure (PMC via OpenCity)"
GROUP_BLD = "Buildings (OSM + Microsoft + Google)"
KML_JUNK = {"FolderPath", "SymbolID", "AltMode", "Base", "Clamped", "Extruded", "Snippet", "PopupInfo", "styleUrl", "visibility",
            "drawOrder", "icon", "begin", "end", "timestamp", "tessellate", "extrude", "altitudeMode", "description"}

# (layer_id, dataset_id, title, subgroup, data_class, suitability, active, notes, keep-props | None = all)
LAYERS: list[tuple] = [
    ("sewer", "pmc_sewage_pipelines", "Sewer network (PMC)", "Drainage & sewer", "observed", "screening", True,
     "PMC sewer records as published. Cover/invert levels are DESIGN values, unverified; depth shown only where both are present. ASCE 38 QL-D when used for coordination.",
     ["pipeline_i", "drainaige_", "material_o", "pipeline_d", "tl_start_m", "tl_end_man", "start_inve", "end_invert", "start_manh",
      "end_manhol", "sd_name", "phase", "remarks", "label", "prabhag_no", "slope"]),
    ("storm_drains", "pmc_stormwater_drains", "Storm-water drains (PMC, labelled only)", "Drainage & sewer", "observed", "screening", True,
     "Only rows labelled 'Storm water drains' (sewer and nalla rows of the same file dropped; rule in INFRASTRUCTURE_DATA.md §3). No levels or sizes published: depth UNKNOWN.",
     ["basin_name", "category", "descriptio", "i_length", "OBJECTID"]),
    ("swd_chambers", "pmc_swd_chambers", "Storm-water chambers (PMC)", "Drainage & sewer", "observed", "screening", True, "Chamber points as published.", None),
    ("swd_utility_chambers", "pmc_swd_utility_chambers", "SWD utility chambers (PMC)", "Drainage & sewer", "observed", "screening", True, "Utility chamber points as published.", None),
    ("nallas", "pmc_nallas", "Nallas (PMC)", "Water", "observed", "screening", True, "Stream centrelines as published.", None),
    ("rivers", "pmc_rivers", "Rivers (PMC)", "Water", "observed", "screening", True, "River polygons as published — not flood lines.", None),
    ("water_bodies", "water_bodies_census_pune_2023", "Water bodies census 2023", "Water", "observed", "screening", True,
     "Water bodies census 2023 points (CKAN licence: Creative Commons Non-Commercial).", None),
    ("road_centreline", "pmc_road_centerline", "Road centreline (PMC)", "Roads & transport", "observed", "screening", True, "Centrelines only; width / right of way not included.", None),
    ("bus_stops", "pmpml_bus_stops", "PMPML bus stops", "Roads & transport", "observed", "screening", True, "Stops as published by PMPML (via OpenCity).", None),
    ("bus_depots", "pmpml_bus_depots", "PMPML bus depots", "Roads & transport", "observed", "screening", True, "Depots as published.", None),
    ("wards_2025", "pmc_electoral_wards_2025", "Electoral wards 2025 (latest)", "Boundaries", "observed", "screening", True, "Latest published electoral wards — the active version.", None),
    ("wards_2022", "pmc_electoral_wards_2022", "Electoral wards 2022", "Boundaries", "observed", "screening", False, "Earlier version (kept for history).", None),
    ("wards_2017", "pmc_electoral_wards_2017", "Electoral wards 2017", "Boundaries", "observed", "screening", False, "Earlier version (kept for history).", None),
    ("wards_2012", "pmc_electoral_wards_2012", "Electoral wards 2012", "Boundaries", "observed", "screening", False, "Earlier version (kept for history).", None),
    ("admin_wards_2017", "pmc_admin_wards_2017", "Administrative wards 2017", "Boundaries", "observed", "screening", True, "Ward offices (administrative), 2017 as published.", None),
    ("prabhag", "pmc_prabhag_boundary", "Prabhag boundary", "Boundaries", "observed", "screening", True, "Vintage not stated by the publisher.", None),
    ("zones", "pmc_zones", "PMC zones", "Boundaries", "observed", "screening", True, "Zones as published.", None),
    ("revenue_parcels", "pmc_revenue_map", "Revenue parcels (gut / TPS)", "Boundaries", "observed", "screening", True,
     "Revenue map as published — not a legal cadastral record.", None),
    ("fire_stations", "pmc_fire_stations", "Fire stations", "Facilities", "observed", "screening", True, "As published.", None),
    ("public_toilets", "pmc_public_toilets", "Public toilets", "Facilities", "observed", "screening", True, "As published.", None),
    ("parks", "pmc_parks_gardens", "Parks and gardens", "Facilities", "observed", "screening", True, "As published.", None),
    ("libraries", "pune_libraries", "Libraries", "Facilities", "observed", "screening", True, "As published.", None),
    ("crematoriums", "pmc_crematoriums", "Crematoriums / burial grounds", "Facilities", "observed", "screening", True, "As published.", None),
    ("stps", "pmc_stps", "Sewage treatment plants (existing + proposed)", "Facilities", "observed", "screening", True,
     "Includes PROPOSED plants as published: not every polygon exists.", None),
]

SEWER_CATEGORIES = {"Road_Sewer", "Nalla_Sewer", "River_Sewer"}


def _latest_dir(dataset_id: str) -> Path | None:
    base = derived_root() / dataset_id
    if not base.is_dir():
        return None
    ds = sorted([d for d in base.iterdir() if (d / "processing.json").exists()])
    return ds[-1] if ds else None


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def sewer_depths(p: dict) -> dict:
    """Depths below cover from published cover (tl_*) and invert levels. DESIGN values, unverified; None = UNKNOWN."""
    out: dict = {"depth_basis": "UNKNOWN (cover and/or invert level not published for this pipe)", "levels_status": "design, unverified"}
    ends = []
    for tl_k, inv_k in (("tl_start_m", "start_inve"), ("tl_end_man", "end_invert")):
        tl, inv = _num(p.get(tl_k)), _num(p.get(inv_k))
        if tl is not None and inv is not None and tl > 0 and inv > 0 and tl > inv:
            ends.append(tl - inv)
    dia_mm = _num(p.get("pipeline_d"))
    dia = dia_mm / 1000.0 if dia_mm and dia_mm > 0 else None
    out["diameter_m"] = dia
    if ends:
        inv_max, inv_min = max(ends), min(ends)
        out["invert_depth_max_m"] = round(inv_max, 3)
        out["invert_depth_min_m"] = round(inv_min, 3)
        top = inv_min - dia if dia is not None else None
        out["top_depth_m"] = round(top, 3) if top is not None and top >= 0 else None
        out["depth_basis"] = (f"cover level − invert level at {len(ends)} end(s), from PMC DESIGN levels (unverified)"
                              + ("" if out["top_depth_m"] is not None else "; top of pipe UNKNOWN (diameter missing or larger than invert depth)"))
    else:
        out["invert_depth_max_m"] = out["invert_depth_min_m"] = out["top_depth_m"] = None
    return out


def _input_meta(proc: dict) -> dict:
    """licence / CKAN last-modified of the raw resource behind a derived dataset (from the raw manifest by sha256)."""
    inp = (proc.get("inputs") or [{}])[0]
    meta = {"licence_as_stated": inp.get("licence_as_stated") or "UNKNOWN", "source_url": inp.get("url"),
            "ckan_dataset": inp.get("ckan_dataset"), "original_publisher": inp.get("original_publisher") or "UNKNOWN",
            "source_updated": None, "retrieved_at": None}
    f = inp.get("file")
    if f:
        man = Path(f).parent / "manifest.json"
        try:
            m = json.loads(man.read_text())
            for e in m.get("files", []):
                if e.get("sha256") == inp.get("sha256") or e.get("file") == Path(f).name:
                    meta["source_updated"] = (e.get("ckan_last_modified_utc") + " UTC (CKAN last_modified)") if e.get("ckan_last_modified_utc") else None
                    meta["retrieved_at"] = e.get("retrieved_at")
                    break
        except (OSError, ValueError):
            pass
    return meta


def _create_layer_tables(con: sqlite3.Connection, lid: str) -> None:
    con.execute(f"DROP TABLE IF EXISTS f_{lid}")
    con.execute(f"DROP TABLE IF EXISTS r_{lid}")
    con.execute(f"CREATE TABLE f_{lid} (fid INTEGER PRIMARY KEY, ext_id TEXT, props TEXT NOT NULL, wkb BLOB NOT NULL)")
    con.execute(f"CREATE VIRTUAL TABLE r_{lid} USING rtree(fid, min_lon, max_lon, min_lat, max_lat)")


def _insert(con, lid: str, rows: list[tuple]) -> None:
    """rows: (fid, ext_id, props_json, wkb, (x0, y0, x1, y1))"""
    con.executemany(f"INSERT INTO f_{lid} VALUES (?,?,?,?)", [(r[0], r[1], r[2], r[3]) for r in rows])
    con.executemany(f"INSERT INTO r_{lid} VALUES (?,?,?,?,?)", [(r[0], r[4][0], r[4][2], r[4][1], r[4][3]) for r in rows])


def build_vector_layer(con, spec: tuple, report: dict) -> dict | None:
    import shapely
    from shapely.geometry import shape
    lid, did, title, sub, dc, suit, active, notes, keep = spec
    d = _latest_dir(did)
    if d is None:
        report["missing"].append(did)
        return None
    proc = json.loads((d / "processing.json").read_text())
    out = (proc.get("outputs") or [{}])[0]
    path = d / (out.get("file") or out.get("path"))
    sha = sha256_file(path)
    if out.get("sha256") and out["sha256"] != sha:
        raise RuntimeError(f"{path}: sha256 {sha} != processing.json {out['sha256']}")
    doc = json.loads(path.read_text())
    _create_layer_tables(con, lid)
    rows, stats = [], {"read": 0, "written": 0, "dropped": {}}
    x0 = y0 = 1e9
    x1 = y1 = -1e9
    for i, f in enumerate(doc.get("features", []), start=1):
        stats["read"] += 1
        p = f.get("properties") or {}
        if lid == "storm_drains":
            cat = p.get("category")
            if cat != "Storm water drains":
                key = "sewer category (sewer rows inside the storm-water file)" if cat in SEWER_CATEGORIES else f"category {cat!r}"
                stats["dropped"][key] = stats["dropped"].get(key, 0) + 1
                continue
        g = f.get("geometry")
        if not g:
            stats["dropped"]["null geometry"] = stats["dropped"].get("null geometry", 0) + 1
            continue
        geom = shape(g)
        props = {k: v for k, v in p.items() if v not in (None, "", "0") and k not in KML_JUNK and (keep is None or k in keep)}
        if lid == "sewer":
            props.update(sewer_depths(p))
        bx = geom.bounds
        x0, y0, x1, y1 = min(x0, bx[0]), min(y0, bx[1]), max(x1, bx[2]), max(y1, bx[3])
        rows.append((i, str(f.get("id") or p.get("id") or p.get("objectid") or i), json.dumps(props, ensure_ascii=False, separators=(",", ":")),
                     shapely.to_wkb(geom), bx))
        if len(rows) >= 20000:
            _insert(con, lid, rows)
            stats["written"] += len(rows)
            rows = []
    if rows:
        _insert(con, lid, rows)
        stats["written"] += len(rows)
    m = _input_meta(proc)
    lic = m["licence_as_stated"]
    con.execute("INSERT OR REPLACE INTO layers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        lid, title, GROUP_MUNI, sub, did, str(d), sha, m["original_publisher"], "OpenCity (data.opencity.in)", m["source_url"],
        f"{lic}. {OPENCITY_LICENCE_NOTE}", OPENCITY_LICENCE_URL, m["source_updated"], m["retrieved_at"], dc, suit,
        json.dumps({"active": active, "notes": notes, "feature_count": stats["written"], "bbox": [x0, y0, x1, y1] if stats["written"] else None,
                    "geometry_types": (proc.get("validation") or {}).get("geometry_types")}), None))
    report["layers"][lid] = {"input": str(path), "sha256": sha, **stats}
    return {"path": str(path), "sha256": sha}


def _osm_height_tags(osm_index: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not osm_index.exists():
        return out
    con = sqlite3.connect(f"file:{osm_index}?mode=ro", uri=True)
    q = ("select element from infrastructure where category='buildings' and "
         "(element like '%\"height\"%' or element like '%building:levels%')")
    for (el,) in con.execute(q):
        e = json.loads(el)
        t = e.get("tags") or {}
        rec = {}
        if "height" in t:
            m = re.match(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*(m)?\s*$", str(t["height"]))
            rec["height_tag"] = t["height"]
            rec["height_m"] = float(m.group(1)) if m else None   # non-metric / unparsable tag → UNKNOWN
        if "building:levels" in t:
            rec["levels_tag"] = t["building:levels"]
        if rec:
            out[f"{e['type']}/{e['id']}"] = rec
    con.close()
    return out


def build_buildings(con, report: dict, chunk: int = 150000) -> dict | None:
    import numpy as np
    import pyogrio
    import shapely
    d = _latest_dir("buildings_comparison")
    if d is None:
        report["missing"].append("buildings_comparison")
        return None
    proc = json.loads((d / "processing.json").read_text())
    out = next(o for o in proc["outputs"] if str(o.get("path") or o.get("file")).endswith(".fgb"))
    path = d / (out.get("path") or out.get("file"))
    t0 = time.time()
    sha = sha256_file(path)
    if out.get("sha256") and out["sha256"] != sha:
        raise RuntimeError(f"{path}: sha256 mismatch")
    osm_inp = next((i for i in proc.get("inputs", []) if str(i.get("path", "")).endswith("osm_index.db")), None)
    tags = _osm_height_tags(Path(osm_inp["path"])) if osm_inp else {}
    info = pyogrio.read_info(str(path))
    n = int(info["features"])
    _create_layer_tables(con, "buildings")
    stats = {"read": 0, "written": 0, "osm_height_tags_found": len(tags), "osm_with_height_m": 0, "by_source_status": {}}
    from pyproj import Transformer
    tr = Transformer.from_crs(32643, 4326, always_xy=True)
    fid = 0
    x0 = y0 = 1e9
    x1 = y1 = -1e9
    for skip in range(0, n, chunk):
        df = pyogrio.read_dataframe(str(path), skip_features=skip, max_features=chunk)
        geoms = shapely.transform(df.geometry.values, lambda xy: np.column_stack(tr.transform(xy[:, 0], xy[:, 1])))
        geoms = shapely.set_precision(geoms, 1e-7)
        wkbs = shapely.to_wkb(geoms)
        bnds = shapely.bounds(geoms)
        rows = []
        for j, r in enumerate(df.itertuples(index=False)):
            fid += 1
            src = r.source
            conf = None if r.confidence is None or r.confidence != r.confidence or r.confidence < 0 else round(float(r.confidence), 4)
            props = {"source": src, "source_id": r.source_id, "status": r.status, "confidence": conf,
                     "area_m2": None if r.area_m2 != r.area_m2 else round(float(r.area_m2), 1),
                     "data_class": "observed" if src == "osm" else "inferred",
                     "osm_overlap_frac": None if r.osm_overlap_frac != r.osm_overlap_frac else round(float(r.osm_overlap_frac), 3),
                     "height_m": None, "height_basis": "UNKNOWN (not tagged)"}
            if src == "osm":
                props["osm_building"] = r.osm_building
                t = tags.get(r.source_id)
                if t:
                    if t.get("height_m") is not None:
                        props["height_m"] = t["height_m"]
                        props["height_basis"] = f"OSM height tag '{t['height_tag']}' (volunteer-mapped)"
                        stats["osm_with_height_m"] += 1
                    if t.get("levels_tag"):
                        props["levels_tag"] = t["levels_tag"]
            k = f"{src}|{r.status}"
            stats["by_source_status"][k] = stats["by_source_status"].get(k, 0) + 1
            b = bnds[j]
            x0, y0, x1, y1 = min(x0, b[0]), min(y0, b[1]), max(x1, b[2]), max(y1, b[3])
            rows.append((fid, r.source_id, json.dumps(props, separators=(",", ":")), wkbs[j], tuple(b)))
        _insert(con, "buildings", rows)
        con.commit()
        stats["read"] += len(df)
        stats["written"] += len(rows)
        print(f"buildings {stats['written']}/{n} ({time.time() - t0:.0f}s)", flush=True)
        del df, geoms, wkbs, rows
    con.execute("INSERT OR REPLACE INTO layers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        "buildings", "Building footprints (OSM + Microsoft + Google, merged)", GROUP_BLD, "Buildings", "buildings_comparison", str(d), sha,
        "OpenStreetMap contributors; Microsoft; Google", "Geofabrik OSM extract; Microsoft GlobalMLBuildingFootprints; Google Open Buildings v3",
        None,
        "Per source, as stated by each publisher (datasets/pipelines/licences.py): OSM — ODbL 1.0 (© OpenStreetMap contributors); Microsoft Global ML Building Footprints — CDLA Permissive 2.0; Google Open Buildings v3 — CC BY 4.0 or ODbL 1.0 (user's choice). OSM-derived parts of the merged layer: ODbL share-alike applies.",
        "https://www.openstreetmap.org/copyright", "OSM 2026-11-02 02:51 IST; ML sources as of their releases (see raw manifests)", proc.get("run_at"),
        "derived", "screening",
        json.dumps({"active": True, "feature_count": stats["written"], "bbox": [x0, y0, x1, y1],
                    "notes": "Each footprint keeps its source. OSM = observed (volunteer-mapped); Microsoft / Google = inferred (ML). Status: osm | agrees_with_osm (ML footprint ≥30% covered by OSM) | ml_only_candidate. Height UNKNOWN unless an OSM height tag exists."}),
        None))
    report["layers"]["buildings"] = {"input": str(path), "sha256": sha, **stats, "seconds": round(time.time() - t0)}
    return {"path": str(path), "sha256": sha}


SCHEMA = """CREATE TABLE IF NOT EXISTS layers (id TEXT PRIMARY KEY, title TEXT, grp TEXT, subgroup TEXT, dataset_id TEXT, dataset_dir TEXT,
 input_sha256 TEXT, publisher TEXT, via TEXT, source_url TEXT, licence TEXT, licence_url TEXT, source_updated TEXT, retrieved_at TEXT,
 data_class TEXT, suitability TEXT, meta TEXT, reserved TEXT)"""


def run(version: str = "v1", only: list[str] | None = None, skip_buildings: bool = False) -> Path:
    out_dir = derived_root() / "infra_index" / version
    out_dir.mkdir(parents=True, exist_ok=True)
    db_path = out_dir / "infra_index.sqlite"
    tmp = out_dir / "infra_index.sqlite.partial"
    if only and db_path.exists():
        import shutil
        shutil.copyfile(db_path, tmp)
    elif tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.execute("PRAGMA journal_mode=OFF")
    con.execute("PRAGMA synchronous=OFF")
    con.execute(SCHEMA)
    report = {"layers": {}, "missing": []}
    inputs = []
    for spec in LAYERS:
        if only and spec[0] not in only:
            continue
        r = build_vector_layer(con, spec, report)
        con.commit()
        if r:
            inputs.append(r)
        print(f"{spec[0]}: {report['layers'].get(spec[0], {}).get('written')}", flush=True)
    if not skip_buildings and (not only or "buildings" in only):
        r = build_buildings(con, report)
        if r:
            inputs.append(r)
    con.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    con.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", [("built_at", now_ist()), ("git_commit", git_commit()), ("crs", "EPSG:4326")])
    con.commit()
    con.execute("VACUUM") if os.environ.get("INFRA_INDEX_VACUUM") else None
    con.close()
    os.replace(tmp, db_path)
    prev = {}
    pp = out_dir / "processing.json"
    if only and pp.exists():
        try:
            prev = json.loads(pp.read_text())
        except ValueError:
            prev = {}
    layers_report = {**(prev.get("validation", {}).get("layers", {})), **report["layers"]}
    in_by_path = {i["path"]: i for i in (prev.get("inputs") or [])}
    in_by_path.update({i["path"]: i for i in inputs})
    doc = {
        "pipeline": "datasets.pipelines.infra_index", "git_commit": git_commit(), "git_dirty_datasets": git_dirty(), "run_at": now_ist(),
        "dataset_id": "infra_index", "title": "Municipal infrastructure + merged buildings spatial index (SQLite R*Tree)",
        "theme": "utilities", "data_class": "derived", "suitability": "screening", "crs": "EPSG:4326",
        "coverage_bbox": [73.70, 18.40, 74.05, 18.70],
        "licence": "Inherited per layer (see layers table): OpenCity/PMC layers — conflicting statements, treated NON-COMMERCIAL with attribution; buildings — OSM ODbL 1.0 (share-alike) / Microsoft CDLA Permissive 2.0 / Google CC BY 4.0 or ODbL.",
        "inputs": list(in_by_path.values()),
        "parameters": {"geometry": "WGS84 WKB, precision 1e-7° for buildings, others as published", "storm_drain_rule": "category == 'Storm water drains'",
                       "sewer_depth_rule": "cover level − invert level per end, only when both > 0 and cover > invert; DESIGN values, unverified",
                       "building_height_rule": "OSM height tag only (metres); else UNKNOWN"},
        "outputs": [{"file": "infra_index.sqlite", "sha256": sha256_file(db_path), "size_bytes": db_path.stat().st_size}],
        "validation": {"layers": layers_report, "missing_inputs": report["missing"]},
        "notes": "Index only: no value is added except the sewer depths computed from published design levels (flagged unverified).",
    }
    pp.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    return db_path


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--version", default="v1")
    ap.add_argument("--layers", default=None, help="comma list of layer ids to (re)build; others kept")
    ap.add_argument("--skip-buildings", action="store_true")
    a = ap.parse_args(argv)
    print(run(a.version, a.layers.split(",") if a.layers else None, a.skip_buildings))


if __name__ == "__main__":
    main()
