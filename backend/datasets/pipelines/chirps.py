"""CHIRPS v2 daily rainfall, AREA-AVERAGED over the Pune study box, via the SERVIR ClimateSERV API (no auth).

Why not data.chc.ucsb.edu: its robots.txt is 'User-agent: * / Disallow: /' (checked 2026-11-13), so automated
downloads there are not done. IRI Data Library mirror was unreachable from the sandbox.
CLI: python -m datasets.pipelines.chirps [acquire|process|all]
Classification: estimated (satellite + gauge blend, 0.05 deg). A box average is a smoothed field: it is NOT point
rainfall and NOT a design-storm / IDF source.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import sys
import time
from pathlib import Path

import numpy as np

from ._common import DERIVED_DIR, PUNE_BBOX, USER_AGENT, file_entry, now_ist, raw_dir, write_manifest, write_processing
from .licences import licence_block

API = "https://climateserv.servirglobal.net/api"
DATATYPE_CHIRPS = 0
OPERATION_AVERAGE = 5
PERIODS = (("01/01/1986", "12/31/2005"), ("01/01/2006", "12/31/2025"))  # API limit: 20 years per request
VERSION = "v1"


def bbox_polygon(bbox=PUNE_BBOX) -> dict:
    x0, y0, x1, y1 = bbox
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def parse_series(payload: dict) -> list[tuple[str, float]]:
    """ClimateSERV getDataFromRequest JSON -> [(ISO date, mm/day)], dropping fill values (< 0)."""
    out = []
    for r in payload.get("data", []):
        v = r.get("value", {}).get("avg")
        if v is None or v < 0:
            continue
        m, d, y = r["date"].split("/")
        out.append((f"{int(y):04d}-{int(m):02d}-{int(d):02d}", float(v)))
    return sorted(out)


def aggregate(series: list[tuple[str, float]]) -> dict:
    """Annual totals, monthly climatology and annual max 1-day (box-average) from a daily series."""
    by_year: dict[int, list[float]] = {}
    by_month: dict[tuple[int, int], float] = {}
    for d, v in series:
        y, m = int(d[:4]), int(d[5:7])
        by_year.setdefault(y, []).append(v)
        by_month[(y, m)] = by_month.get((y, m), 0.0) + v
    years = sorted(y for y, vals in by_year.items() if len(vals) >= 365)
    annual = {y: round(sum(by_year[y]), 1) for y in years}
    clim = {m: round(float(np.mean([by_month[(y, m)] for y in years if (y, m) in by_month])), 1) for m in range(1, 13)} if years else {}
    rx1 = {y: round(max(by_year[y]), 1) for y in years}
    return {"complete_years": years, "annual_total_mm": annual, "monthly_climatology_mm": clim, "annual_max_1day_mm": rx1}


def _get(url: str, params: dict | None = None):
    import requests

    r = requests.get(url, params=params, timeout=120, headers={"User-Agent": USER_AGENT})
    r.raise_for_status()
    return r


def acquire() -> Path:
    d = raw_dir("chirps_v2_climateserv")
    ents = []
    for b, e in PERIODS:
        params = {"datatype": DATATYPE_CHIRPS, "begintime": b, "endtime": e, "intervaltype": 0,
                  "operationtype": OPERATION_AVERAGE, "geometry": json.dumps(bbox_polygon())}
        job = _get(f"{API}/submitDataRequest/", params).json()[0]
        for _ in range(120):
            prog = _get(f"{API}/getDataRequestProgress/", {"id": job}).json()
            if prog and float(prog[0]) >= 100:
                break
            time.sleep(5)
        res = _get(f"{API}/getDataFromRequest/", {"id": job})
        fn = d / f"chirps_daily_boxavg_{b[-4:]}-{e[-4:]}.json"
        fn.write_bytes(res.content)
        ents.append(file_entry(fn, url=res.url, retrieved_at=now_ist(), request=params, job_id=job,
                               notes="ClimateSERV area-average (operationtype=5) of UCSB CHIRPS (datatype 0), daily"))
        time.sleep(3)
    write_manifest(d, {"source_id": "chirps_v2_climateserv", "licence": licence_block("chirps_v2"),
                       "service": "SERVIR ClimateSERV API https://climateserv.servirglobal.net/develop-api",
                       "service_terms": "UNKNOWN (no terms page found for the API); data licence is CHIRPS public domain",
                       "classification": "estimated (CHIRPS v2: satellite IR + station blend, 0.05 deg)",
                       "robots_note": "data.chc.ucsb.edu robots.txt disallows all agents (checked 2026-11-13); not used"}, ents)
    return d


def _latest() -> Path:
    base = raw_dir("chirps_v2_climateserv").parent
    return sorted(p for p in base.iterdir() if (p / "manifest.json").exists())[-1]


def process() -> Path:
    raw = _latest()
    out = DERIVED_DIR / "rainfall_chirps_boxavg" / VERSION
    out.mkdir(parents=True, exist_ok=True)
    inputs = sorted(raw.glob("chirps_daily_boxavg_*.json"))
    series: list[tuple[str, float]] = []
    for p in inputs:
        series += parse_series(json.loads(p.read_text()))
    series = sorted(dict(series).items())
    fcsv = out / "chirps_daily_mm_boxavg.csv"
    with open(fcsv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "rain_mm_box_average"])
        w.writerows(series)
    agg = aggregate(series)
    fj = out / "chirps_summary.json"
    fj.write_text(json.dumps(agg, indent=2))
    ann = list(agg["annual_total_mm"].values())
    first = dt.date.fromisoformat(series[0][0]) if series else None
    last = dt.date.fromisoformat(series[-1][0]) if series else None
    gaps = (last - first).days + 1 - len(series) if series else None
    validation = {"days": len(series), "first": str(first), "last": str(last), "missing_days": gaps,
                  "annual_mean_mm": round(float(np.mean(ann)), 1) if ann else None,
                  "annual_min_max_mm": [min(ann), max(ann)] if ann else None,
                  "jun_sep_share_pct": round(100 * sum(agg["monthly_climatology_mm"].get(m, 0) for m in (6, 7, 8, 9))
                                             / max(sum(agg["monthly_climatology_mm"].values()), 1e-9), 1) if ann else None,
                  "negative_values": int(sum(1 for _, v in series if v < 0))}
    write_processing(out, pipeline="datasets.pipelines.chirps", inputs=inputs,
                     parameters={"bbox": PUNE_BBOX, "operation": "area average", "datatype": DATATYPE_CHIRPS},
                     outputs=[fcsv, fj], validation=validation, classification="estimated", suitability="screening",
                     notes="CHIRPS (Funk et al. 2015). Box-average of 0.05 deg cells; underestimates local intense "
                           "rainfall; not an IDF/design-storm source. Compare with IMD gauges before any use.")
    return out


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("acquire", "all"):
        print("raw:", acquire())
    if step in ("process", "all"):
        print("derived:", process())
