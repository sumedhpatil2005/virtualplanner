"""Air-quality station series (CPCB/MPCB/IITM 15-min) and rainfall summaries (IMD 0.25° grid, CHIRPS box average, IMD
district via NWDP). Values are read as stored by the pipelines; aggregation states the sample count per bucket so a
sparse day is visible as sparse. No interpolation between stations or cells; rainfall statistics are descriptive only
(not IDF curves, not design storms)."""
from __future__ import annotations

import json
import re
from functools import lru_cache

from . import paths

AQ = ("cpcb_caaqms_pune", "2026-11-13")
AQ_PARAMS = {"pm25_ugm3": ("PM2.5", "µg/m³"), "pm10_ugm3": ("PM10", "µg/m³"), "no2_ugm3": ("NO₂", "µg/m³"),
             "so2_ugm3": ("SO₂", "µg/m³"), "co_mgm3": ("CO", "mg/m³"), "o3_ugm3": ("O₃", "µg/m³")}
IMD = ("imd_rainfall_025_pune", "2026-11-13")
CHIRPS = ("rainfall_chirps_boxavg", "v1")
NWDP = ("imd_district_rainfall_pune", "2026-11-13")
_TS = re.compile(r"(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}) (AM|PM)")


def parse_ist(s: str) -> str | None:
    """Any supported timestamp ('Mon 2024-01-01 5:30 AM IST (UTC+05:30)', ISO with offset, ...) → ISO 8601 with offset,
    or None. The stated zone is honoured (previously every human-form value was labelled +05:30 whatever it said)."""
    from datasets.timeutil import iso, parse_ts
    d = parse_ts(s)
    return iso(d) if d else None


def _bound(s: str, name: str, end: bool = False):
    """start/end query value → aware pandas Timestamp in IST. A date-only end is inclusive of that whole day."""
    import pandas as pd

    from datasets.timeutil import is_date_only, parse_ts
    d = parse_ts(s)
    if d is None:
        raise ValueError(f"{name} must be a date (YYYY-MM-DD) or ISO 8601 timestamp with zone")
    t = pd.Timestamp(d).tz_convert("Asia/Kolkata")
    return t + pd.Timedelta(days=1) if end and is_date_only(s.strip()) else t


@lru_cache(maxsize=2)
def _aq(path: str, mtime: float):
    import pandas as pd
    df = pd.read_csv(path)
    # stored as ISO 8601 with +05:30; the human form is accepted too (parse_ist)
    ts = df["timestamp_ist"].astype(str)
    iso = ts.where(ts.str.match(r"^\d{4}-\d{2}-\d{2}T"), ts.map(lambda x: parse_ist(x) or ""))
    df["t"] = pd.to_datetime(iso, errors="coerce", utc=True).dt.tz_convert("Asia/Kolkata")
    df = df[df["t"].notna()]
    return df


def aq_frame():
    p = paths.derived(*AQ, "aq_15min_pune.csv")
    return _aq(str(p), p.stat().st_mtime)


def aq_stations() -> dict:
    gj = json.loads(paths.derived(*AQ, "stations_pune.geojson").read_text())
    df = aq_frame()
    out = []
    for f in gj["features"]:
        p = dict(f["properties"])
        sid = p["station_id"]
        sub = df[df.station_id == sid]
        params = {}
        for k, (lab, unit) in AQ_PARAMS.items():
            s = sub[k].dropna() if k in sub else []
            if len(s):
                params[k] = {"label": lab, "unit": unit, "samples": int(len(s)),
                             "first": sub.loc[s.index, "t"].min().isoformat(), "last": sub.loc[s.index, "t"].max().isoformat()}
        coords = f["geometry"]["coordinates"] if f.get("geometry") else None
        out.append({**p, "lon": coords[0] if coords else None, "lat": coords[1] if coords else None,
                    "rows": int(len(sub)), "parameters": params,
                    "has_series": bool(len(sub))})
    return {"stations": out, "parameters": {k: {"label": v[0], "unit": v[1]} for k, v in AQ_PARAMS.items()},
            "note": "Observed concentrations as published (CPCB CCR via OpenCity). Station coordinates from the CPCB CAAQMS list PDF; "
                    "stations missing from that list have UNKNOWN coordinates and are not drawn. No interpolated surface."}


def aq_series(station: str, param: str, agg: str = "day", start: str | None = None, end: str | None = None) -> dict:
    from datasets.timeutil import is_date_only
    if param not in AQ_PARAMS:
        raise ValueError(f"unknown parameter {param}")
    df = aq_frame()
    known = {f["properties"]["station_id"] for f in json.loads(paths.derived(*AQ, "stations_pune.geojson").read_text())["features"]}
    if station not in known:
        raise LookupError(f"unknown station {station}")
    sub = df[df.station_id == station][["t", param]].dropna()
    if start:
        sub = sub[sub.t >= _bound(start, "start")]
    if end:
        e = _bound(end, "end", end=True)
        sub = sub[sub.t < e] if is_date_only(end.strip()) else sub[sub.t <= e]
    if agg == "raw":
        if len(sub) > 20000:
            raise ValueError("more than 20,000 samples; narrow the date range or use agg=hour/day")
        pts = [{"t": t.isoformat(), "v": float(v), "n": 1} for t, v in zip(sub.t, sub[param])]
    else:
        rule = {"hour": "h", "day": "D", "month": "MS"}.get(agg)
        if rule is None:
            raise ValueError("agg must be raw, hour, day or month")
        g = sub.set_index("t")[param].resample(rule)
        m, n, mx = g.mean(), g.count(), g.max()
        pts = [{"t": t.isoformat(), "v": round(float(m[t]), 2), "max": round(float(mx[t]), 2), "n": int(n[t])}
               for t in m.index if n[t] > 0]
    lab, unit = AQ_PARAMS[param]
    return {"station_id": station, "parameter": param, "label": lab, "unit": unit, "agg": agg,
            "samples_per_full_bucket": {"raw": 1, "hour": 4, "day": 96, "month": None}[agg],
            "first": pts[0]["t"] if pts else None, "last": pts[-1]["t"] if pts else None, "points": pts,
            "data_class": "observed", "note": "Bucket mean of 15-min values as published; n = samples present (96 per full day). "
                                              "No gap filling. Not a compliance assessment against NAAQS."}


def _read_csv(ds, name):
    import pandas as pd
    return pd.read_csv(paths.derived(*ds, name))


def rainfall_summary() -> dict:
    import pandas as pd
    daily = _read_csv(IMD, "pune_cells_daily.csv")
    daily["date"] = pd.to_datetime(daily["date"])
    ann = _read_csv(IMD, "pune_cells_annual_totals.csv")
    ann["qa_flag"] = ann["qa_flag"].fillna("").astype(str).str.strip()
    cells = []
    for (lon, lat), g in daily.groupby(["cell_lon", "cell_lat"]):
        g = g.set_index("date")["rain_mm"]
        monthly_tot = g.resample("MS").sum()
        clim = monthly_tot.groupby(monthly_tot.index.month).mean()
        yearly_max = g.groupby(g.index.year).agg(["max", "idxmax"])
        a = ann[(ann.cell_lon == lon) & (ann.cell_lat == lat)].sort_values("year")
        top = g.idxmax()
        cells.append({
            "cell_lon": lon, "cell_lat": lat, "resolution_deg": 0.25,
            "annual": [{"year": int(r.year), "mm": float(r.annual_mm), "qa_flag": r.qa_flag or None} for r in a.itertuples()],
            "monthly_mean_mm": [{"month": int(m), "mm": round(float(v), 1)} for m, v in clim.items()],
            "daily_max_by_year": [{"year": int(y), "mm": float(r["max"]), "date": r["idxmax"].date().isoformat()} for y, r in yearly_max.iterrows()],
            "daily_max": {"mm": float(g.max()), "date": top.date().isoformat()},
            "suspect_years": [int(r.year) for r in a.itertuples() if r.qa_flag],
        })
    pj = paths.processing(*IMD) or {}
    ch = json.loads(paths.derived(*CHIRPS, "chirps_summary.json").read_text())
    cd = _read_csv(CHIRPS, "chirps_daily_mm_boxavg.csv")
    nw = _read_csv(NWDP, "imd_district_daily_rainfall_pune.csv")
    return {
        "imd_grid": {"cells": cells, "period": "2000-01-01 to 2025-12-31 (IMD day)",
                     "suspect_cell_years": (pj.get("validation") or {}).get("suspect_cell_years_gt_3x_median", []),
                     "suspect_rule": "annual total > 3 × the cell's median annual total (flag as stored by the pipeline; values not altered)"},
        "chirps_box": {"annual_total_mm": ch.get("annual_total_mm"), "monthly_climatology_mm": ch.get("monthly_climatology_mm"),
                       "annual_max_1day_mm": ch.get("annual_max_1day_mm"), "days": int(len(cd)),
                       "first": str(cd["date"].iloc[0]), "last": str(cd["date"].iloc[-1])},
        "nwdp_district": {"rows": [{k: (None if (isinstance(v, float) and v != v) else v) for k, v in r.items()} for r in nw.to_dict("records")],
                          "first": str(nw["date"].min()), "last": str(nw["date"].max())},
        "statement": "Descriptive rainfall statistics only: NOT IDF curves, NOT design storms. Gridded cells are ~27 km; CHIRPS is a "
                     "whole-box average; the district series is a district average.",
    }


def rainfall_daily(cell_lon: float, cell_lat: float, year: int) -> dict:
    import pandas as pd
    d = _read_csv(IMD, "pune_cells_daily.csv")
    d = d[(d.cell_lon == cell_lon) & (d.cell_lat == cell_lat) & (d.date.str.startswith(str(year)))]
    if d.empty:
        raise ValueError("no data for that cell/year")
    return {"cell_lon": cell_lon, "cell_lat": cell_lat, "year": year,
            "points": [{"date": r.date, "mm": float(r.rain_mm)} for r in d.itertuples()], "unit": "mm/day"}
