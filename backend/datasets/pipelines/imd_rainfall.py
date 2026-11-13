"""IMD Pune gridded daily rainfall 0.25 deg (Pai et al. 2014) -> Pune cells.

Source page : https://imdpune.gov.in/cmpg/Griddata/Rainfall_25_Bin.html
Download    : POST https://imdpune.gov.in/cmpg/Griddata/rainfall.php  form field rain=<YEAR>
              (no login; returns Rainfall/ind<YEAR>_rfp25.grd, application/octet-stream)
Format      : unformatted direct-access float32 (little endian), one record per day,
              135 (lon 66.5..100.0 E) x 129 (lat 6.5..38.5 N) points, lon fastest,
              south to north; UNDEF -999.0; mm/day. (page text, read 2026-11-13)

Usage:  cd backend && python -m datasets.pipelines.imd_rainfall --years 2000-2025
Derived: derived/imd_rainfall_025_pune/<version>/pune_cells_daily.csv, pune_cells.geojson
Class: observed-derived (station analysis interpolated to grid by IMD) -> "derived";
suitability: screening (regional climate context), NOT drainage design (cell ~27 km).
"""
from __future__ import annotations

import argparse
import array
import calendar
import csv
import json
from pathlib import Path

from . import gov_common as gc

SOURCE_ID = "imd_gridded_rainfall_025"
DATASET_ID = "imd_rainfall_025_pune"
PAGE_URL = "https://imdpune.gov.in/cmpg/Griddata/Rainfall_25_Bin.html"
POST_URL = "https://imdpune.gov.in/cmpg/Griddata/rainfall.php"
NX, NY = 135, 129
LON0, LAT0, STEP = 66.5, 6.5, 0.25
UNDEF = -999.0
LICENCE = ("No licence stated on the download page. Page asks: 'Should you refer to our product in your "
           "paper/presentation, please cite Pai et al. (2014)' and carries an IMD disclaimer (no liability).")


def read_grd(data: bytes, year: int) -> array.array:
    ndays = 366 if calendar.isleap(year) else 365
    a = array.array("f")
    a.frombytes(data)
    if len(a) != ndays * NX * NY:
        raise ValueError(f"unexpected size for {year}: {len(a)} floats, expected {ndays * NX * NY}")
    return a


def cell_index(lon: float, lat: float) -> tuple[int, int]:
    return round((lon - LON0) / STEP), round((lat - LAT0) / STEP)


def cells_for_bbox(bbox=gc.PUNE_BBOX) -> list[tuple[float, float]]:
    """Grid points whose 0.25 deg cell (centre +/- 0.125) overlaps bbox."""
    minx, miny, maxx, maxy = bbox
    out = []
    for j in range(NY):
        lat = LAT0 + j * STEP
        if lat + STEP / 2 <= miny or lat - STEP / 2 >= maxy:
            continue
        for i in range(NX):
            lon = LON0 + i * STEP
            if lon + STEP / 2 <= minx or lon - STEP / 2 >= maxx:
                continue
            out.append((round(lon, 3), round(lat, 3)))
    return out


def extract(a: array.array, year: int, cells: list[tuple[float, float]]):
    ndays = len(a) // (NX * NY)
    start = __import__("datetime").date(year, 1, 1)
    for d in range(ndays):
        day = start + __import__("datetime").timedelta(days=d)
        for lon, lat in cells:
            i, j = cell_index(lon, lat)
            v = a[d * NX * NY + j * NX + i]
            yield day.isoformat(), lon, lat, (None if v <= UNDEF + 1 else round(float(v), 2))


def flag_suspect_years(annual: dict, factor: float = 3.0) -> set:
    """Cell-years whose annual total exceeds factor x the cell's median annual total.
    Values are NOT altered; the flag is for reviewers (e.g. 2005 and 2009 at 74.0E 18.5N)."""
    import statistics
    by_cell: dict = {}
    for (y, lon, lat), v in annual.items():
        by_cell.setdefault((lon, lat), []).append(v)
    med = {k: statistics.median(v) for k, v in by_cell.items()}
    return {(y, lon, lat) for (y, lon, lat), v in annual.items() if v > factor * med[(lon, lat)]}


def download(years: list[int], raw_date: str | None = None) -> Path:
    rd = gc.raw_dir(SOURCE_ID, raw_date)
    source = {"source_id": SOURCE_ID, "publisher": "India Meteorological Department (IMD) Pune, Climate Research and Services",
              "page": PAGE_URL, "citation": "Pai D.S. et al. 2014, MAUSAM 65(1):1-18"}
    for y in years:
        dest = rd / f"ind{y}_rfp25.grd"
        if dest.exists():
            continue
        http = gc.http_download(POST_URL, dest, data=f"rain={y}".encode())
        read_grd(dest.read_bytes(), y)  # size check before recording
        gc.write_manifest(rd, source, [gc.manifest_entry(
            dest, POST_URL, method=f"POST rain={y}", http=http, licence=LICENCE, licence_url=PAGE_URL,
            notes="Original binary as served; never modified.")])
    return rd


def process(raw: Path, years: list[int], version: str) -> Path:
    out = gc.derived_dir(DATASET_ID, version)
    cells = cells_for_bbox()
    csv_path = out / "pune_cells_daily.csv"
    inputs, n, missing, annual = [], 0, 0, {}
    with open(csv_path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "cell_lon", "cell_lat", "rain_mm"])
        for y in years:
            f = raw / f"ind{y}_rfp25.grd"
            a = read_grd(f.read_bytes(), y)
            inputs.append({"file": str(f), "sha256": gc.sha256_file(f)})
            for row in extract(a, y, cells):
                w.writerow(row)
                n += 1
                if row[3] is None:
                    missing += 1
                else:
                    annual.setdefault((y, row[1], row[2]), 0.0)
                    annual[(y, row[1], row[2])] += row[3]
    feats = []
    for lon, lat in cells:
        h = STEP / 2
        feats.append({"type": "Feature", "properties": {"cell_lon": lon, "cell_lat": lat, "resolution_deg": STEP},
                      "geometry": {"type": "Polygon", "coordinates": [[[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h]]]}})
    gj = out / "pune_cells.geojson"
    gj.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    ann = out / "pune_cells_annual_totals.csv"
    suspect = flag_suspect_years(annual)
    with open(ann, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["year", "cell_lon", "cell_lat", "annual_mm", "qa_flag"])
        for (y, lon, lat), v in sorted(annual.items()):
            w.writerow([y, lon, lat, round(v, 1), "suspect_gt_3x_median" if (y, lon, lat) in suspect else ""])
    gc.write_processing(out, pipeline="datasets.pipelines.imd_rainfall", inputs=inputs,
                        parameters={"bbox": gc.PUNE_BBOX, "cells": cells, "years": years},
                        outputs=[csv_path, gj, ann],
                        validation={"rows": n, "undef_values": missing, "cells": len(cells),
                                    "suspect_cell_years_gt_3x_median": sorted(f"{y}@{lon},{lat}" for y, lon, lat in suspect),
                                    "check": "file length == ndays*135*129*4 bytes for every year"},
                        notes="Values are IMD gridded analysis (derived from rain-gauge network). Cell ~27 km: screening only.")
    return out


def parse_years(s: str) -> list[int]:
    if "-" in s:
        a, b = s.split("-")
        return list(range(int(a), int(b) + 1))
    return [int(x) for x in s.split(",")]


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--years", default="2000-2025")
    p.add_argument("--raw-date", default=None, help="use an existing raw/<date> folder instead of downloading")
    p.add_argument("--version", default=None)
    args = p.parse_args(argv)
    years = parse_years(args.years)
    raw = gc.raw_root() / SOURCE_ID / args.raw_date if args.raw_date else download(years)
    out = process(raw, years, args.version or raw.name)
    print(out)


if __name__ == "__main__":
    main()
