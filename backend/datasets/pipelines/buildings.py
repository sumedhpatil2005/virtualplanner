"""Building footprints: Google Open Buildings v3 + Microsoft GlobalML vs OSM (osm_index.db).

CLI: python -m datasets.pipelines.buildings [acquire|process|all]
Outputs a merged CONFLICT-DETECTION layer (every feature keeps its source) plus comparison statistics.
ML footprints are DERIVED (model detections); OSM is community-mapped (observed, completeness unknown).
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import math
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np

from ._common import (DERIVED_DIR, ENGINEERING_EPSG, PUNE_BBOX, USER_AGENT, download, file_entry, now_ist,
                      raw_dir, write_manifest, write_processing)
from .licences import licence_block

OB_TILE_URL = "https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip/{token}_buildings.csv.gz"
OB_TILES_INDEX = "https://openbuildings-public-dot-gweb-research.uw.r.appspot.com/public/tiles.geojson"
OB_THRESHOLDS = "https://storage.googleapis.com/open-buildings-data/v3/score_thresholds_s2_level_4.csv"
MS_LINKS = "https://bfppub.blob.core.windows.net/%24web/2026-08-13/dataset-links.csv"
OSM_INDEX = Path(os.environ.get("TWINCITY_OSM_INDEX", Path(__file__).resolve().parents[2] / "data/osm/osm_index.db"))
VERSION = "v1"
SAMPLE_N = 3000
SEED = 42
GRID_M = 1000.0


# ---------------- pure functions (unit-tested) ----------------
def quadkey(lon: float, lat: float, zoom: int) -> str:
    """Bing Maps tile quadkey for a WGS84 point."""
    lat = max(min(lat, 85.05112878), -85.05112878)
    s = math.sin(math.radians(lat))
    x = (lon + 180.0) / 360.0
    y = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
    n = 1 << zoom
    tx, ty = min(n - 1, int(x * n)), min(n - 1, int(y * n))
    q = []
    for i in range(zoom, 0, -1):
        m = 1 << (i - 1)
        q.append(str((1 if tx & m else 0) + (2 if ty & m else 0)))
    return "".join(q)


def quadkeys_for_bbox(bbox, zoom: int = 9, steps: int = 8) -> set[str]:
    x0, y0, x1, y1 = bbox
    return {quadkey(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * j / steps, zoom)
            for i in range(steps + 1) for j in range(steps + 1)}


def centroid_in_bbox(lat: float, lon: float, bbox=PUNE_BBOX) -> bool:
    return bbox[1] <= lat <= bbox[3] and bbox[0] <= lon <= bbox[2]


def iou(a, b) -> float:
    inter = a.intersection(b).area
    if inter == 0:
        return 0.0
    return float(inter / (a.area + b.area - inter))


def best_iou(geom, candidates) -> float:
    return max((iou(geom, c) for c in candidates), default=0.0)


# ---------------- acquisition ----------------
def stream_filter_ob(url: str, out_csv: Path, bbox=PUNE_BBOX) -> dict:
    """Stream the (multi-GB) gz CSV once, hash the full original, keep rows whose centroid is in bbox."""
    import requests

    md5, sha = hashlib.md5(), hashlib.sha256()

    class Tee(io.RawIOBase):
        def __init__(self, it):
            self.it, self.buf = it, b""

        def readable(self):
            return True

        def readinto(self, b):
            while not self.buf:
                try:
                    chunk = next(self.it)
                except StopIteration:
                    return 0
                md5.update(chunk)
                sha.update(chunk)
                self.buf = chunk
            n = min(len(b), len(self.buf))
            b[:n], self.buf = self.buf[:n], self.buf[n:]
            return n

    with requests.get(url, stream=True, timeout=120, headers={"User-Agent": USER_AGENT}) as r:
        r.raise_for_status()
        hdr = {k: v for k, v in r.headers.items() if k.lower() in ("content-length", "etag", "last-modified", "x-goog-hash")}
        rows = kept = 0
        with gzip.open(io.BufferedReader(Tee(r.iter_content(1 << 20)), 1 << 20), "rt") as gz, open(out_csv, "w") as fo:
            header = gz.readline()
            fo.write(header)
            for line in gz:
                rows += 1
                la, lo = line.split(",", 2)[:2]
                if centroid_in_bbox(float(la), float(lo), bbox):
                    fo.write(line)
                    kept += 1
    return {"source_md5": md5.hexdigest(), "source_sha256": sha.hexdigest(), "http_headers": hdr,
            "rows_scanned": rows, "rows_kept": kept}


def acquire() -> list[Path]:
    import requests
    from shapely.geometry import box, shape

    dirs = []
    # Microsoft GlobalML: level-9 quadkey tiles
    d = raw_dir("ms_global_ml_buildings")
    links = download(MS_LINKS, d)
    want = quadkeys_for_bbox(PUNE_BBOX)
    ents = [links]
    with open(d / links["filename"]) as f:
        for row in csv.DictReader(f):
            if row["QuadKey"] in want and row["Location"] == "India":
                ents.append(download(row["Url"], d, f"India_qk{row['QuadKey']}.csv.gz",
                                     note=f"whole original tile quadkey {row['QuadKey']} (geojsonl in .csv.gz)"))
    write_manifest(d, {"source_id": "ms_global_ml_buildings", "licence": licence_block("ms_global_ml_buildings"),
                       "classification": "derived (ML detections from Bing imagery 2014-2024)"}, ents)
    dirs.append(d)
    # Google Open Buildings v3
    d = raw_dir("google_open_buildings_v3")
    ents = [download(OB_THRESHOLDS, d), download(OB_TILES_INDEX, d, "tiles.geojson")]
    tiles = json.loads((d / "tiles.geojson").read_text())
    for ft in tiles["features"]:
        if shape(ft["geometry"]).intersects(box(*PUNE_BBOX)):
            tok = ft["properties"]["tile_id"]
            out = d / f"{tok}_buildings_pune_bbox_centroid_filter.csv"
            if not out.exists():
                info = stream_filter_ob(OB_TILE_URL.format(token=tok), out)
            else:
                info = json.loads((d / "manifest.json").read_text()).get("stream_info", {}) if (d / "manifest.json").exists() else {}
            ents.append(file_entry(out, url=OB_TILE_URL.format(token=tok), retrieved_at=now_ist(),
                                   notes=f"rows of S2 L4 tile {tok} ({ft['properties'].get('size_mb')} MB gz original, not stored) "
                                         "whose centroid lat/long fall in the study bbox; rows byte-identical to source",
                                   **({"stream": info} if info else {})))
    write_manifest(d, {"source_id": "google_open_buildings_v3", "licence": licence_block("google_open_buildings_v3"),
                       "classification": "derived (ML detections, inference May 2023)"}, ents)
    dirs.append(d)
    return dirs


# ---------------- processing ----------------
def _latest(source_id: str) -> Path:
    base = raw_dir(source_id).parent
    return sorted(p for p in base.iterdir() if (p / "manifest.json").exists())[-1]


def load_ob(raw: Path):
    import geopandas as gpd
    import pandas as pd
    import shapely

    frames = []
    for p in sorted(raw.glob("*_buildings_pune_bbox_centroid_filter.csv")):
        df = pd.read_csv(p)
        df["geometry"] = shapely.from_wkt(df["geometry"].values)
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    g = gpd.GeoDataFrame(df[["confidence", "full_plus_code", "geometry"]], geometry="geometry", crs=4326)
    g["source"] = "google_open_buildings_v3"
    g["source_id"] = g.pop("full_plus_code")
    return g


def load_ms(raw: Path):
    import geopandas as gpd
    from shapely.geometry import shape

    geoms, conf, height, ids = [], [], [], []
    for p in sorted(raw.glob("India_qk*.csv.gz")):
        with gzip.open(p, "rt") as f:
            for i, line in enumerate(f):
                ft = json.loads(line)
                g = shape(ft["geometry"])
                c = g.centroid
                if not centroid_in_bbox(c.y, c.x):
                    continue
                pr = ft.get("properties") or {}
                geoms.append(g); conf.append(pr.get("confidence", -1)); height.append(pr.get("height", -1))
                ids.append(f"{p.stem.split('_qk')[1].split('.')[0]}:{i}")
    g = gpd.GeoDataFrame({"confidence": conf, "height_m": height, "source_id": ids}, geometry=geoms, crs=4326)
    g["source"] = "ms_global_ml_buildings"
    return g


def load_osm(db: Path = OSM_INDEX):
    import geopandas as gpd
    from shapely.geometry import Polygon

    con = sqlite3.connect(db)
    x0, y0, x1, y1 = PUNE_BBOX
    q = ("select i.element from infrastructure i join infrastructure_rtree r on r.id=i.key "
         "where i.category='buildings' and r.max_lon>=? and r.min_lon<=? and r.max_lat>=? and r.min_lat<=?")
    geoms, ids, tags = [], [], []
    bad = 0
    for (el,) in con.execute(q, (x0, x1, y0, y1)):
        e = json.loads(el)
        pts = [(p["lon"], p["lat"]) for p in e.get("geometry", [])]
        if len(pts) < 4:
            bad += 1
            continue
        g = Polygon(pts)
        c = g.centroid
        if not centroid_in_bbox(c.y, c.x):
            continue
        geoms.append(g); ids.append(f"{e['type']}/{e['id']}"); tags.append(e.get("tags", {}).get("building", "yes"))
    meta = dict(con.execute("select key,value from meta").fetchall())
    g = gpd.GeoDataFrame({"source_id": ids, "osm_building": tags}, geometry=geoms, crs=4326)
    g["source"] = "osm"
    g.attrs["unbuildable_rings"] = bad
    g.attrs["osm_meta"] = meta
    return g


def validity(g) -> dict:
    import shapely

    inv = ~shapely.is_valid(g.geometry.values)
    n_inv = int(inv.sum())
    if n_inv:
        g.loc[inv, "geometry"] = shapely.make_valid(g.geometry.values[inv])
    return {"features": int(len(g)), "invalid_before_fix": n_inv, "empty": int(g.geometry.is_empty.sum())}


def process() -> Path:
    import geopandas as gpd
    import pandas as pd
    import shapely
    from shapely.strtree import STRtree

    out = DERIVED_DIR / "buildings_comparison" / VERSION
    out.mkdir(parents=True, exist_ok=True)
    ob_raw, ms_raw = _latest("google_open_buildings_v3"), _latest("ms_global_ml_buildings")
    src = {"google_open_buildings_v3": load_ob(ob_raw), "ms_global_ml_buildings": load_ms(ms_raw), "osm": load_osm()}
    thr = None
    with open(ob_raw / "score_thresholds_s2_level_4.csv") as f:
        for row in csv.DictReader(f):
            if row["s2_token"] == "3bd":
                thr = {k: float(v) for k, v in row.items() if k.startswith("confidence_threshold")}
    stats = {"ob_tile_3bd_thresholds": thr}
    for k, g in src.items():
        v = validity(g)
        g.to_crs(ENGINEERING_EPSG, inplace=True)
        g["area_m2"] = g.geometry.area.round(1)
        v.update({"total_area_km2": round(float(g.area_m2.sum()) / 1e6, 2), "median_area_m2": float(g.area_m2.median()),
                  "p5_area_m2": float(g.area_m2.quantile(.05)), "p95_area_m2": float(g.area_m2.quantile(.95))})
        if "confidence" in g:
            c = g.confidence[g.confidence >= 0]
            v["confidence_present_fraction"] = round(float(len(c)) / max(len(g), 1), 3)
            if len(c):
                v["confidence_median"] = float(c.median())
        stats[k] = v
    stats["osm"]["osm_meta"] = src["osm"].attrs.get("osm_meta")
    stats["osm"]["rings_with_lt4_points_skipped"] = src["osm"].attrs.get("unbuildable_rings")
    if thr:
        ob = src["google_open_buildings_v3"]
        stats["google_open_buildings_v3"]["count_ge_90pct_precision_thr"] = int((ob.confidence >= thr["confidence_threshold_90%_precision"]).sum())

    # ---- IoU samples ----
    rng = np.random.default_rng(SEED)
    trees = {k: STRtree(g.geometry.values) for k, g in src.items()}

    def sample_match(a: str, b: str) -> dict:
        ga = src[a].geometry.values
        idx = rng.choice(len(ga), size=min(SAMPLE_N, len(ga)), replace=False)
        gb = src[b].geometry.values
        ious = []
        for i in idx:
            cand = trees[b].query(ga[i], predicate="intersects")
            ious.append(best_iou(ga[i], gb[cand]))
        ious = np.array(ious)
        return {"n": int(len(ious)), "match_iou_ge_0.5": round(float((ious >= .5).mean()), 3),
                "match_iou_ge_0.3": round(float((ious >= .3).mean()), 3), "no_overlap": round(float((ious == 0).mean()), 3),
                "median_best_iou": round(float(np.median(ious)), 3)}

    pairs = [("osm", "google_open_buildings_v3"), ("osm", "ms_global_ml_buildings"),
             ("google_open_buildings_v3", "osm"), ("ms_global_ml_buildings", "osm"),
             ("google_open_buildings_v3", "ms_global_ml_buildings"), ("ms_global_ml_buildings", "google_open_buildings_v3")]
    stats["iou_samples"] = {f"{a}->{b}": sample_match(a, b) for a, b in pairs}

    # ---- per-feature overlap with OSM (conflict flags) ----
    osm_geoms = src["osm"].geometry.values
    for k in ("google_open_buildings_v3", "ms_global_ml_buildings"):
        g = src[k]
        li, ri = trees["osm"].query(g.geometry.values, predicate="intersects")
        inter = shapely.area(shapely.intersection(g.geometry.values[li], osm_geoms[ri]))
        frac = pd.Series(inter, index=li).groupby(level=0).sum()
        g["osm_overlap_frac"] = 0.0
        g.loc[g.index[frac.index], "osm_overlap_frac"] = (frac.values / g.area_m2.values[frac.index]).clip(0, 1).round(3)
        g["in_osm"] = g.osm_overlap_frac >= 0.3
    # OSM features: matched by any ML source
    o = src["osm"]
    for k, col in (("google_open_buildings_v3", "in_google"), ("ms_global_ml_buildings", "in_ms")):
        li, ri = trees[k].query(o.geometry.values, predicate="intersects")
        o[col] = False
        o.loc[o.index[np.unique(li)], col] = True

    # ---- 1 km coverage grid ----
    from shapely.geometry import box as sbox

    allb = gpd.GeoSeries([sbox(*PUNE_BBOX)], crs=4326).to_crs(ENGINEERING_EPSG).total_bounds
    xs = np.arange(math.floor(allb[0] / GRID_M) * GRID_M, allb[2], GRID_M)
    ys = np.arange(math.floor(allb[1] / GRID_M) * GRID_M, allb[3], GRID_M)
    cells = gpd.GeoDataFrame(geometry=[sbox(x, y, x + GRID_M, y + GRID_M) for x in xs for y in ys], crs=ENGINEERING_EPSG)
    for k, short in (("osm", "osm"), ("google_open_buildings_v3", "gob"), ("ms_global_ml_buildings", "ms")):
        c = src[k].geometry.centroid
        j = gpd.sjoin(gpd.GeoDataFrame({"a": src[k].area_m2.values}, geometry=c.values, crs=ENGINEERING_EPSG), cells,
                      predicate="within")
        agg = j.groupby("index_right").agg(n=("a", "size"), area=("a", "sum"))
        cells[f"{short}_n"] = agg.n.reindex(cells.index).fillna(0).astype(int)
        cells[f"{short}_area_m2"] = agg.area.reindex(cells.index).fillna(0).round(0)
    ml_max = cells[["gob_area_m2", "ms_area_m2"]].max(axis=1)
    cells["osm_completeness_vs_ml"] = np.where(ml_max > 0, (cells.osm_area_m2 / ml_max).round(3), np.nan)
    cells.to_crs(4326).to_file(out / "coverage_grid_1km.geojson", driver="GeoJSON")
    built = cells[ml_max > 20000]  # cells with >2% ML-detected roof cover
    stats["coverage_grid"] = {"cells": int(len(cells)), "cells_ml_built_gt_2pct": int(len(built)),
                              "osm_area_ratio_median_in_built_cells": float(built.osm_completeness_vs_ml.median()),
                              "built_cells_osm_ratio_lt_0.5": int((built.osm_completeness_vs_ml < .5).sum())}

    # ---- merged conflict-detection layer ----
    cols = ["source", "source_id", "confidence", "area_m2", "osm_overlap_frac", "in_osm", "in_google", "in_ms",
            "height_m", "osm_building", "geometry"]
    merged = pd.concat([g.reindex(columns=cols) for g in src.values()], ignore_index=True)
    merged = gpd.GeoDataFrame(merged, geometry="geometry", crs=ENGINEERING_EPSG)
    merged["class"] = np.where(merged.source == "osm", "observed(community-mapped)", "derived(ML)")
    merged["status"] = np.select(
        [merged.source == "osm",
         merged.in_osm.fillna(False).astype(bool),
         merged.source != "osm"],
        ["osm", "agrees_with_osm", "ml_only_candidate"], default="")
    fgb = out / "buildings_merged_conflict_epsg32643.fgb"
    if fgb.exists():
        fgb.unlink()
    merged.to_file(fgb, driver="FlatGeobuf")
    stats["merged"] = merged.groupby(["source", "status"]).size().rename("n").reset_index().to_dict("records")
    (out / "stats.json").write_text(json.dumps(stats, indent=2, default=float))
    inputs = [p for d in (ob_raw, ms_raw) for p in d.iterdir() if p.suffix in (".csv", ".gz")] + [OSM_INDEX]
    write_processing(out, pipeline="datasets.pipelines.buildings", inputs=inputs,
                     parameters={"bbox": PUNE_BBOX, "centroid_filter": True, "iou_sample_n": SAMPLE_N, "seed": SEED,
                                 "in_osm_rule": "ML footprint area overlapped by OSM >= 30%", "grid_m": GRID_M},
                     outputs=[fgb, out / "coverage_grid_1km.geojson", out / "stats.json"], validation=stats,
                     suitability="screening",
                     notes="Agreement with OSM is NOT ground truth: OSM completeness in Pune is unknown; a manual "
                           "imagery-checked sample is required to estimate precision/recall (see catalogue).")
    return out


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("acquire", "all"):
        print("raw:", acquire())
    if step in ("process", "all"):
        print("derived:", process())
