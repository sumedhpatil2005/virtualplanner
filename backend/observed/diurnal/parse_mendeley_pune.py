"""Parse the Mendeley "Heterogeneous Traffic Count Dataset, Pune (Jan 2023)" into
hourly flow rates with explicit coverage.

Source: Matange, A. & Abraham, J. (2026). Heterogeneous Traffic Count Dataset,
Pune (Jan 2023). Mendeley Data, V1. doi:10.17632/xnf2k6n288.1 (CC BY 4.0).
Footage: Traffic Police Commissioner, Pune. Junctions: Alankar, Jehangir, RTO Chowk.

Raw file structure (verified by inspection, not stated in the README):
  * one timestamp per second (HH:MM:SS); ~25 rows per direction per second
    (one per video frame); values are CUMULATIVE counts since session start.
  * a `_one.csv` file continues the session but restarts its counters at 0.
  * counters also restart whenever a new recording session begins.
We therefore take the LAST frame per direction per second, difference
consecutive seconds within a session, and treat any of these as a session
break (no flow credited, no coverage credited):
  - time going backwards or a gap > MAX_GAP_S seconds,
  - any counter decreasing (reset).
Flow for an hour = sum(increments in that hour) / covered_seconds * 3600.
Hours with < MIN_COVER_S seconds of coverage are reported as NOT covered.
Nothing is interpolated here.
"""
from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

CLASSES = ("car", "motorbike", "bus", "truck")
MAX_GAP_S = 60
MIN_COVER_S = 15 * 60  # an hour needs >=15 min of footage to count as observed

# 11-18 Jan 2023: weekday names (11 Jan 2023 was a Wednesday)
DOW = {11: "Wed", 12: "Thu", 13: "Fri", 14: "Sat", 15: "Sun", 16: "Mon", 17: "Tue", 18: "Wed"}
WEEKEND = {14, 15}


def _secs(t: str) -> int | None:
    try:
        h, m, s = t.split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)
    except ValueError:
        return None


def read_session_file(path: Path):
    """Yield (second_of_day, {dir: (car, mb, bus, truck)}) using the last frame per second."""
    cur_t = None
    cur: dict[str, tuple[int, ...]] = {}
    with path.open(newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 6 or row[0] in ("", "Time") or "" in row[2:6]:
                continue
            t = _secs(row[0])
            if t is None:
                continue
            if t != cur_t:
                if cur_t is not None and len(cur) == 4:
                    yield cur_t, cur
                cur_t, cur = t, {}
            cur[row[1]] = tuple(int(x) for x in row[2:6])
    if cur_t is not None and len(cur) == 4:
        yield cur_t, cur


def hourly_for_file(path: Path):
    """Return {hour: {"veh": {...class: count}, "cover_s": seconds}}."""
    out: dict[int, dict] = defaultdict(lambda: {"veh": defaultdict(int), "cover_s": 0})
    prev_t, prev = None, None
    for t, snap in read_session_file(path):
        if prev is not None:
            dt = t - prev_t
            reset = any(snap[d][i] < prev[d][i] for d in snap if d in prev for i in range(4))
            if 0 < dt <= MAX_GAP_S and not reset and set(snap) == set(prev):
                h = (prev_t // 3600) % 24
                out[h]["cover_s"] += dt
                for d in snap:
                    for i, c in enumerate(CLASSES):
                        out[h]["veh"][c] += snap[d][i] - prev[d][i]
        prev_t, prev = t, snap
    return out


def parse(root: Path):
    """Return per-camera-day hourly records."""
    records = []
    for f in sorted(root.rglob("*.csv")):
        stem = f.stem.replace("_one", "")
        cam, day = stem.split("_")
        day = int(day)
        for h, rec in hourly_for_file(f).items():
            records.append({
                "camera": cam, "junction": cam[0], "day": day, "hour": h,
                "cover_s": rec["cover_s"], "veh": dict(rec["veh"]), "file": f.name,
            })
    # merge primary + _one for the same camera/day/hour
    merged: dict[tuple, dict] = {}
    for r in records:
        k = (r["camera"], r["day"], r["hour"])
        m = merged.setdefault(k, {"camera": r["camera"], "junction": r["junction"], "day": r["day"],
                                   "hour": r["hour"], "cover_s": 0, "veh": defaultdict(int)})
        m["cover_s"] += r["cover_s"]
        for c, v in r["veh"].items():
            m["veh"][c] += v
    return list(merged.values())


def build_profile(records, min_cover_s=MIN_COVER_S):
    """Hourly profile per day type. Each camera's hourly rates are normalised by that
    camera's own mean rate over the hours it covers on the same day type, so cameras of
    different volume contribute shape only. Returns per-hour index + coverage."""
    out = {}
    for daytype, days in (("weekday", [d for d in DOW if d not in WEEKEND]), ("weekend", sorted(WEEKEND))):
        cam_rates: dict[str, dict[int, list[float]]] = defaultdict(lambda: defaultdict(list))
        for r in records:
            if r["day"] in days and r["cover_s"] >= min_cover_s:
                tot = sum(r["veh"].values())
                cam_rates[r["camera"]][r["hour"]].append(tot / r["cover_s"] * 3600)
        idx: dict[int, list[float]] = defaultdict(list)
        cover: dict[int, dict] = defaultdict(lambda: {"cameras": set(), "camera_days": 0})
        for cam, hours in cam_rates.items():
            mean_h = {h: sum(v) / len(v) for h, v in hours.items()}
            if len(mean_h) < 3:
                continue  # one or two hours cannot carry a shape
            base = sum(mean_h.values()) / len(mean_h)
            if base <= 0:
                continue
            for h, v in mean_h.items():
                idx[h].append(v / base)
                cover[h]["cameras"].add(cam)
                cover[h]["camera_days"] += len(hours[h])
        out[daytype] = {
            h: {"index": sum(v) / len(v), "n_cameras": len(cover[h]["cameras"]),
                "camera_days": cover[h]["camera_days"], "cameras": sorted(cover[h]["cameras"])}
            for h, v in sorted(idx.items())
        }
    return out


def _main():
    root = Path(sys.argv[1])
    recs = parse_parallel(root)
    json.dump(recs, open(sys.argv[2], "w"), default=lambda o: dict(o), indent=0)
    prof = build_profile(recs)
    print(json.dumps(prof, indent=1, default=list))


def _file_job(f: str):
    p = Path(f)
    stem = p.stem.replace("_one", "")
    cam, day = stem.split("_")
    return [{"camera": cam, "junction": cam[0], "day": int(day), "hour": h, "cover_s": rec["cover_s"],
             "veh": dict(rec["veh"]), "file": p.name} for h, rec in hourly_for_file(p).items()]


def parse_parallel(root: Path, procs: int = 8):
    """Same as parse() but one process per file (the raw CSVs total ~100M rows)."""
    from multiprocessing import Pool
    files = [str(f) for f in sorted(root.rglob("*.csv"))]
    with Pool(procs) as pool:
        records = [r for chunk in pool.map(_file_job, files) for r in chunk]
    merged: dict[tuple, dict] = {}
    for r in records:
        k = (r["camera"], r["day"], r["hour"])
        m = merged.setdefault(k, {"camera": r["camera"], "junction": r["junction"], "day": r["day"],
                                   "hour": r["hour"], "cover_s": 0, "veh": defaultdict(int)})
        m["cover_s"] += r["cover_s"]
        for c, v in r["veh"].items():
            m["veh"][c] += v
    return [dict(m, veh=dict(m["veh"])) for m in merged.values()]


if __name__ == "__main__":
    _main()
