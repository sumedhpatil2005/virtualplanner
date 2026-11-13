"""CPCB/MPCB/IITM CAAQMS air quality for Pune: station points + 15-min observations.

Inputs (raw store):
  raw/cpcb_caaqms_station_list/<date>/caaqms_list_All_India.pdf   (CPCB CCR, public PDF)
  raw/opencity_pune/<date>/pune-*-20*.csv  (OpenCity mirror of CPCB CCR 15-minute station data,
                                            dataset 'pune-hourly-air-quality-reports')
  cd backend && python -m datasets.pipelines.cpcb_air_quality --raw-date 2026-11-13

Outputs derived/cpcb_caaqms_pune/<version>/:
  stations_pune.geojson   stations from the CPCB list inside the study box (+ ones seen only in data,
                          geometry null, coordinates UNKNOWN)
  aq_15min_pune.csv       station_id, timestamp_ist (ISO 8601 +05:30), PM2.5, PM10, NO2, SO2, CO, O3
Class: observed (continuous analysers). Suitability: screening/context at the station only. No
spatial surface is produced (point stations cannot be interpolated to streets honestly).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from . import gov_common as gc

DATASET_ID = "cpcb_caaqms_pune"
ROW_RE = re.compile(r"^\s*(?P<city>Pune|Pimpri[- ]Chinchwad)\s{2,}(?P<name>.+?)\s{2,}(?P<agency>[A-Z]+)\s+(?P<lat>\d+\.\d+)\s+(?P<lon>\d+\.\d+)\s+#(?P<code>\d+)\s*$")
POLL = {"PM2.5 (µg/m³)": "pm25_ugm3", "PM10 (µg/m³)": "pm10_ugm3", "NO2 (µg/m³)": "no2_ugm3",
        "SO2 (µg/m³)": "so2_ugm3", "CO (mg/m³)": "co_mgm3", "Ozone (µg/m³)": "o3_ugm3"}


def parse_station_lines(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        m = ROW_RE.match(line)
        if m:
            d = m.groupdict()
            out.append({"station_id": f"site_{d['code']}", "name": d["name"].strip(), "agency": d["agency"],
                        "city": d["city"], "lat": float(d["lat"]), "lon": float(d["lon"])})
    return out


def parse_ts(s: str) -> str | None:
    """Source timestamps are ISO 8601 UTC, e.g. 2024-01-01T00:00:00.000000+0000 -> IST ISO string."""
    s = (s or "").strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S%z"):
        try:
            return dt.datetime.strptime(s, fmt).astimezone(gc.IST).isoformat(timespec="minutes")
        except ValueError:
            continue
    return None


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--raw-date", required=True)
    p.add_argument("--version")
    a = p.parse_args(argv)
    home = gc.data_home() / "raw"
    pdf = home / "cpcb_caaqms_station_list" / a.raw_date / "caaqms_list_All_India.pdf"
    text = subprocess.check_output(["pdftotext", "-layout", str(pdf), "-"], text=True)
    stations = {s["station_id"]: s for s in parse_station_lines(text)
                if gc.PUNE_BBOX[0] <= s["lon"] <= gc.PUNE_BBOX[2] and gc.PUNE_BBOX[1] <= s["lat"] <= gc.PUNE_BBOX[3]}
    rd = home / "opencity_pune" / a.raw_date
    man = {e["file"]: e for e in json.loads((rd / "manifest.json").read_text())["files"]}
    files = sorted(f for f in man if re.match(r"pune-.*-20\d\d(-\d\d)?\.csv$", f))
    out = gc.derived_dir(DATASET_ID, a.version or a.raw_date)
    stats = defaultdict(Counter)
    meta: dict[str, dict] = {}
    obs = out / "aq_15min_pune.csv"
    with open(obs, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["station_id", "timestamp_ist"] + list(POLL.values()))
        for f in files:
            with open(rd / f, encoding="utf-8", errors="replace", newline="") as src:
                for r in csv.DictReader(src):
                    sid = r.get("Station ID", "").strip()
                    st = stats[sid]
                    st["rows"] += 1
                    ts = parse_ts(r.get("Timestamp", ""))
                    if not ts:
                        st["bad_timestamp"] += 1
                        continue
                    vals = []
                    for col in POLL:
                        v = (r.get(col) or "").strip()
                        try:
                            x = float(v)
                            if x < 0:
                                st[f"negative:{POLL[col]}"] += 1
                                x = None
                        except ValueError:
                            x = None
                        if x is not None:
                            st[f"present:{POLL[col]}"] += 1
                        vals.append("" if x is None else x)
                    if all(v == "" for v in vals):
                        st["all_pollutants_blank"] += 1
                        continue
                    w.writerow([sid, ts] + vals)
                    st["written"] += 1
                    m = meta.setdefault(sid, {"name": r.get("Station Name"), "first": ts, "last": ts, "file": f})
                    m["first"], m["last"] = min(m["first"], ts), max(m["last"], ts)
    feats = []
    for sid in sorted(set(stations) | set(meta)):
        s = stations.get(sid)
        props = {"station_id": sid, "name": (s or {}).get("name") or meta.get(sid, {}).get("name"),
                 "agency": (s or {}).get("agency"), "in_cpcb_list_pdf": bool(s),
                 "data_first": meta.get(sid, {}).get("first"), "data_last": meta.get(sid, {}).get("last"),
                 "coordinates_status": "observed (CPCB list)" if s else "UNKNOWN (station not in CPCB list PDF)",
                 "classification": "observed"}
        if sid in stats:
            r = stats[sid]["rows"] or 1
            props["completeness_pm25"] = round(stats[sid]["present:pm25_ugm3"] / r, 3)
            props["completeness_pm10"] = round(stats[sid]["present:pm10_ugm3"] / r, 3)
            props["completeness_no2"] = round(stats[sid]["present:no2_ugm3"] / r, 3)
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]} if s else None})
    gj = out / "stations_pune.geojson"
    gj.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False))
    gc.write_processing(out, pipeline="datasets.pipelines.cpcb_air_quality",
                        inputs=[{"file": str(pdf), "sha256": gc.sha256_file(pdf)}] + [{"file": f, "sha256": man[f]["sha256"], "url": man[f]["url"]} for f in files],
                        parameters={"study_bbox_wgs84": gc.PUNE_BBOX, "timestamp": "source ISO 8601 UTC (+0000) -> converted to IST (+05:30)",
                                    "negative_values": "set to blank and counted"},
                        outputs=[obs, gj], validation={k: dict(v) for k, v in stats.items()} | {"stations_in_pdf_bbox": len(stations)},
                        notes="Observed concentrations as published (CPCB CCR via OpenCity mirror). No interpolation.")
    print(json.dumps({"stations_pdf": len(stations), "stations_data": len(meta), "rows": {k: v["written"] for k, v in stats.items()}}, indent=1))


if __name__ == "__main__":
    main()
