"""Groundwater levels (CGWB + Maharashtra GSDA) and IMD district rainfall from the
National Water Data Portal (nwdp.nwic.gov.in, CKAN) -> Pune study-area extracts.

Raw (fetched with gov_fetch, robots Crawl-Delay 10 s honoured):
  raw/nwdp_india_wris/<date>/gwl_manual_quarterly_cgwb_mh_1991_2020.csv
  raw/nwdp_india_wris/<date>/gwl_manual_quarterly_cgwb_mh_2021_2025.csv
  raw/nwdp_india_wris/<date>/ground_water_level_manual_quarterly_maharashtra_1970_2025.csv  (GSDA)
  raw/nwdp_india_wris/<date>/rainfall_districtwise_daily_imd.csv

  cd backend && python -m datasets.pipelines.nwdp_groundwater --raw-date 2026-11-13

Outputs (derived/nwdp_groundwater_pune/<version>/):
  gwl_observations_pune.csv  station_id, agency, source_file, date (ISO), depth_to_water_m_bgl
  gwl_stations_pune.geojson  one point per well: n_obs, first/last date, last value, well type/depth
Class: observed (manual dip measurements, metres below ground level). Suitability: screening.
A well reading is a point value in fractured/weathered basalt; it does NOT describe groundwater
between wells (no interpolation is produced here on purpose).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
from collections import defaultdict
from pathlib import Path

from . import gov_common as gc

SOURCE_ID = "nwdp_india_wris"
DATASET_ID = "nwdp_groundwater_pune"
RAIN_DATASET_ID = "imd_district_rainfall_pune"


def _num(s):
    try:
        v = float(str(s).strip())
        return v
    except (TypeError, ValueError):
        return None


def parse_date(s: str) -> str | None:
    s = (s or "").strip()
    for fmt in ("%d-%m-%Y %H:%M", "%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def in_bbox(lon, lat, box=gc.PUNE_BBOX) -> bool:
    return lon is not None and lat is not None and box[0] <= lon <= box[2] and box[1] <= lat <= box[3]


def norm_row(row: dict, kind: str, source_file: str) -> dict | None:
    """Map both CGWB and GSDA schemas onto one record. Headers have stray spaces/newlines."""
    r = {(k or "").strip().replace("\n", " "): (v or "").strip() for k, v in row.items()}
    if kind == "cgwb":
        lat, lon = _num(r.get("Latitude")), _num(r.get("Longitude"))
        return {"station_id": f"CGWB:{r.get('Station')}", "agency": r.get("Agency") or "CGWB",
                "district": r.get("District"), "village": r.get("Village"), "lat": lat, "lon": lon,
                "date": parse_date(r.get("Data Acquisition Time", "")),
                "value": _num(r.get("Groundwater Level Quarterly Manual (meter)")),
                "well_type": None, "well_depth_m": None, "aquifer": None, "rl_msl": _num(r.get("RL_MSL")),
                "source_file": source_file}
    lat, lon = _num(r.get("Latitude")), _num(r.get("Longitude"))
    return {"station_id": f"GSDA:{r.get('Well ID')}", "agency": r.get("Agency") or "GSDA",
            "district": r.get("District Name"), "village": r.get("Village"), "lat": lat, "lon": lon,
            "date": parse_date(r.get("Date of Monitoring", "")), "value": _num(r.get("Water Level, m bgl")),
            "well_type": r.get("Well Type (Dug Well, Piezometer)"), "well_depth_m": _num(r.get("Well Depth, m")),
            "aquifer": r.get("Aquifer Tapped (Unconfined, Semi-Confined, Confined)"), "rl_msl": None,
            "source_file": source_file}


GWL_FILES = [("gwl_manual_quarterly_cgwb_mh_1991_2020.csv", "cgwb"),
             ("gwl_manual_quarterly_cgwb_mh_2021_2025.csv", "cgwb"),
             ("ground_water_level_manual_quarterly_maharashtra_1970_2025.csv", "gsda")]


def extract_gwl(raw: Path, out: Path) -> dict:
    stats = defaultdict(int)
    stations: dict[str, dict] = {}
    seen = set()
    obs_path = out / "gwl_observations_pune.csv"
    with open(obs_path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["station_id", "agency", "date", "depth_to_water_m_bgl", "source_file"])
        for fname, kind in GWL_FILES:
            f = raw / fname
            if not f.exists():
                stats[f"missing:{fname}"] += 1
                continue
            with open(f, encoding="utf-8", errors="replace", newline="") as src:
                for row in csv.DictReader(src):
                    stats["rows_read"] += 1
                    r = norm_row(row, kind, fname)
                    if not r or not in_bbox(r["lon"], r["lat"]):
                        continue
                    stats["rows_in_bbox"] += 1
                    if r["date"] is None:
                        stats["bad_date"] += 1
                        continue
                    if r["value"] is None:
                        stats["missing_value"] += 1
                        continue
                    if r["value"] < -5 or r["value"] > 200:
                        stats["implausible_value_dropped"] += 1
                        continue
                    key = (r["station_id"], r["date"], r["value"])
                    if key in seen:
                        stats["duplicate_dropped"] += 1
                        continue
                    seen.add(key)
                    w.writerow([r["station_id"], r["agency"], r["date"], r["value"], fname])
                    stats["observations_written"] += 1
                    s = stations.setdefault(r["station_id"], {k: r[k] for k in ("station_id", "agency", "district", "village", "lat", "lon", "well_type", "well_depth_m", "aquifer", "rl_msl")} | {"n_obs": 0, "first_date": r["date"], "last_date": r["date"], "last_value_m_bgl": r["value"]})
                    s["n_obs"] += 1
                    if r["date"] < s["first_date"]:
                        s["first_date"] = r["date"]
                    if r["date"] >= s["last_date"]:
                        s["last_date"], s["last_value_m_bgl"] = r["date"], r["value"]
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
              "properties": {k: v for k, v in s.items() if k not in ("lat", "lon")} | {"classification": "observed"}}
             for s in stations.values()]
    st_path = out / "gwl_stations_pune.geojson"
    st_path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False))
    stats["stations"] = len(stations)
    stats["stations_by_agency"] = dict(__import__("collections").Counter(s["agency"] for s in stations.values()))
    dates = [s["last_date"] for s in stations.values()]
    stats["latest_observation"] = max(dates) if dates else None
    return {"outputs": [obs_path, st_path], "stats": dict(stats)}


def extract_rain(raw: Path, out: Path) -> dict:
    f = raw / "rainfall_districtwise_daily_imd.csv"
    stats = defaultdict(int)
    path = out / "imd_district_daily_rainfall_pune.csv"
    with open(f, encoding="utf-8", errors="replace", newline="") as src, open(path, "w", newline="") as fh:
        rd = csv.DictReader(src)
        cols = [c for c in rd.fieldnames]
        w = csv.writer(fh)
        w.writerow(["date", "district", "daily_actual_mm", "daily_normal_mm", "daily_departure_pct", "daily_category"])
        for row in rd:
            stats["rows_read"] += 1
            r = {(k or "").strip().replace("\n", " "): (v or "").strip() for k, v in row.items()}
            if r.get("District", "").strip().upper() != "PUNE":
                continue
            d = parse_date(r.get("Date", ""))
            if not d:
                stats["bad_date"] += 1
                continue
            w.writerow([d, r["District"], _num(r.get("Daily Actual")), _num(r.get("Daily Normal")),
                        _num(r.get("Daily Departure Per")), r.get("Daily Category")])
            stats["rows_written"] += 1
    stats["columns"] = len(cols)
    return {"outputs": [path], "stats": dict(stats)}


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--raw-date", required=True)
    p.add_argument("--version")
    a = p.parse_args(argv)
    raw = gc.data_home() / "raw" / SOURCE_ID / a.raw_date
    man = {e["file"]: e for e in json.loads((raw / "manifest.json").read_text())["files"]}
    ver = a.version or a.raw_date
    out = gc.derived_dir(DATASET_ID, ver)
    g = extract_gwl(raw, out)
    gc.write_processing(out, pipeline="datasets.pipelines.nwdp_groundwater (gwl)",
                        inputs=[{"file": f, "sha256": man[f]["sha256"], "url": man[f]["url"]} for f, _ in GWL_FILES if f in man],
                        parameters={"study_bbox_wgs84": gc.PUNE_BBOX, "plausible_range_m_bgl": [-5, 200], "dedupe_key": "station,date,value"},
                        outputs=g["outputs"], validation=g["stats"],
                        notes="Observed manual depth-to-water (m bgl). Not interpolated. Licence: NWDP CKAN 'Other (Open)'.")
    out2 = gc.derived_dir(RAIN_DATASET_ID, ver)
    rr = extract_rain(raw, out2)
    rf = "rainfall_districtwise_daily_imd.csv"
    gc.write_processing(out2, pipeline="datasets.pipelines.nwdp_groundwater (rain)",
                        inputs=[{"file": rf, "sha256": man[rf]["sha256"], "url": man[rf]["url"]}] if rf in man else [],
                        parameters={"district": "PUNE"}, outputs=rr["outputs"], validation=rr["stats"],
                        notes="IMD district-average daily rainfall as published on NWDP (licence field empty -> UNKNOWN).")
    print(json.dumps({"gwl": g["stats"], "rain": rr["stats"]}, indent=1))


if __name__ == "__main__":
    main()
