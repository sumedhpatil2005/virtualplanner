"""PMC Tree Census 2019 point table -> spatially indexed SQLite for bbox serving (Environment workspace).

  cd backend && python -m datasets.pipelines.tree_index [--input-version 2026-11-13] [--version v1]

Input : derived/pmc_tree_census_2019/<input-version>/trees_pune.csv  (output of opencity_trees; never modified)
Output: derived/pmc_tree_census_2019_index/<version>/trees_index.sqlite + processing.json
  trees(id PK = census id, lon, lat, girth_cm, height_m, canopy_dia_m, condition, ownership, species_id, ward, is_rare)
  species(id, botanical_name, common_name, local_name)       -- names exactly as published
  trees_rt                                                    -- R*Tree on (lon, lat)
  grid(level, gx, gy, n, sum_lon, sum_lat)                    -- pre-aggregated counts for clustered views
Attribute values are copied as published (out-of-range values are kept; opencity_trees counted them).
Idempotent: the output file is rebuilt from scratch into a temp file and renamed.
"""
from __future__ import annotations

import argparse
import csv
import os
import sqlite3
import sys
from pathlib import Path

from . import gov_common as gc

DATASET_ID = "pmc_tree_census_2019_index"
INPUT_DATASET = "pmc_tree_census_2019"
# grid cell sizes in degrees (level index -> size); the API picks a level so a view has a bounded number of cells
GRID_LEVELS = [0.04, 0.01, 0.0025, 0.000625]


def _num(v: str):
    v = (v or "").strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def build(src: Path, out: Path) -> dict:
    tmp = out.with_suffix(".sqlite.tmp")
    if tmp.exists():
        tmp.unlink()
    db = sqlite3.connect(tmp)
    db.executescript("""
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-200000;
        CREATE TABLE species(id INTEGER PRIMARY KEY, botanical_name TEXT, common_name TEXT, local_name TEXT);
        CREATE TABLE trees(id INTEGER PRIMARY KEY, lon REAL NOT NULL, lat REAL NOT NULL, girth_cm REAL, height_m REAL,
                           canopy_dia_m REAL, condition TEXT, ownership TEXT, species_id INTEGER, ward TEXT, is_rare INTEGER);
        CREATE VIRTUAL TABLE trees_rt USING rtree(id, minx, maxx, miny, maxy);
        CREATE TABLE grid(level INTEGER, gx INTEGER, gy INTEGER, n INTEGER, sum_lon REAL, sum_lat REAL, PRIMARY KEY(level, gx, gy));
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    """)
    species: dict[tuple, int] = {}
    grids = [dict() for _ in GRID_LEVELS]
    rows = bad = dup = 0
    batch, rt = [], []
    seen_ids: set[int] = set()
    with open(src, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            lon, lat = _num(r["lon"]), _num(r["lat"])
            try:
                tid = int(r["id"])
            except (TypeError, ValueError):
                bad += 1
                continue
            if lon is None or lat is None:
                bad += 1
                continue
            if tid in seen_ids:
                dup += 1
                continue
            seen_ids.add(tid)
            key = (r["botanical_name"], r["common_name"], r["local_name"])
            sid = species.get(key)
            if sid is None:
                sid = species[key] = len(species) + 1
            rare = (r.get("is_rare") or "").strip().upper()
            batch.append((tid, lon, lat, _num(r["girth_cm"]), _num(r["height_m"]), _num(r["canopy_dia_m"]),
                          r["condition"] or None, r["ownership"] or None, sid, r["ward"] or None,
                          1 if rare == "TRUE" else 0 if rare == "FALSE" else None))
            rt.append((tid, lon, lon, lat, lat))
            for i, s in enumerate(GRID_LEVELS):
                k = (int(lon // s), int(lat // s))
                c = grids[i].get(k)
                if c is None:
                    grids[i][k] = [1, lon, lat]
                else:
                    c[0] += 1; c[1] += lon; c[2] += lat
            rows += 1
            if len(batch) >= 50000:
                db.executemany("INSERT INTO trees VALUES (?,?,?,?,?,?,?,?,?,?,?)", batch)
                db.executemany("INSERT INTO trees_rt VALUES (?,?,?,?,?)", rt)
                batch.clear(); rt.clear()
    if batch:
        db.executemany("INSERT INTO trees VALUES (?,?,?,?,?,?,?,?,?,?,?)", batch)
        db.executemany("INSERT INTO trees_rt VALUES (?,?,?,?,?)", rt)
    db.executemany("INSERT INTO species VALUES (?,?,?,?)", [(v, *k) for k, v in species.items()])
    for i, g in enumerate(grids):
        db.executemany("INSERT INTO grid VALUES (?,?,?,?,?,?)", [(i, k[0], k[1], c[0], c[1], c[2]) for k, c in g.items()])
    db.executemany("INSERT INTO meta VALUES (?,?)", [("grid_levels_deg", ",".join(str(s) for s in GRID_LEVELS)),
                                                     ("source_csv", str(src)), ("rows", str(rows))])
    db.commit()
    db.close()
    unchanged = out.exists() and gc.sha256_file(tmp) == gc.sha256_file(out)
    if unchanged:  # idempotent re-run: keep the existing file (same inode) so live read-only connections stay valid
        tmp.unlink()
    else:
        os.replace(tmp, out)
    return {"output_unchanged_from_previous_run": unchanged,
            "rows_indexed": rows, "rows_skipped_bad_id_or_coords": bad, "duplicate_ids_skipped": dup,
            "species_distinct": len(species), "grid_cells_per_level": {str(s): len(g) for s, g in zip(GRID_LEVELS, grids)}}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input-version", default="2026-11-13")
    ap.add_argument("--version", default="v1")
    a = ap.parse_args(argv)
    src = gc.derived_root() / INPUT_DATASET / a.input_version / "trees_pune.csv"
    if not src.exists():
        print(f"missing input {src}", file=sys.stderr)
        return 2
    out_dir = gc.derived_root() / DATASET_ID / a.version
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "trees_index.sqlite"
    v = build(src, out)
    db = sqlite3.connect(f"file:{out}?mode=ro", uri=True)
    v["rtree_rows"] = db.execute("SELECT count(*) FROM trees_rt").fetchone()[0]
    v["grid_level0_total_equals_rows"] = db.execute("SELECT sum(n) FROM grid WHERE level=0").fetchone()[0] == v["rows_indexed"]
    db.close()
    gc.write_processing(out_dir, pipeline="datasets.pipelines.tree_index",
                        inputs=[{"file": str(src), "sha256": gc.sha256_file(src)}],
                        parameters={"grid_levels_deg": GRID_LEVELS, "dedupe": "census id", "attributes": "as published"},
                        outputs=[out], validation=v,
                        notes="Observed (PMC tree census, 2019 vintage) re-packed for bbox serving; no values altered. "
                              "classification: observed; suitability: screening (a Trees Act site survey is still required).")
    print(v)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
