"""
Pure functions of the Traffic Data Manager: record validation, period
arithmetic, veh/h and PCU/h conversion, hourly aggregation.

Rule (same as backend/observed/counts.py): validation never repairs data. A
record that is wrong or incomplete is reported with the reason; it is not
rounded, clipped, defaulted or dropped here.
"""

from __future__ import annotations

import datetime
import re
from typing import Any, Iterable

REF_KINDS = ("road_direction", "junction_approach", "turn")
DIRECTIONS = ("fwd", "bwd", "both")
TURNS = ("left", "straight", "right", "u_turn")
DAY_TYPES = ("weekday", "saturday", "sunday", "holiday", "weekend", "all_days")
KINDS = ("measured", "estimated", "manual")
ROLES = ("validation", "calibration", "unused")

_TIME = re.compile(r"^(\d{1,2}):(\d{2})(?::\d{2})?$")


class MissingPcuFactor(ValueError):
    """A class with vehicles has no factor in the chosen set: conversion is refused, not guessed."""

    def __init__(self, classes: list[str], set_name: str):
        super().__init__(f"PCU factor set '{set_name}' has no factor for: {', '.join(classes)}")
        self.classes = classes


def parse_minutes(value: Any) -> int | None:
    """'HH:MM' (or datetime.time) → minutes after midnight; '24:00' → 1440. None when not a time."""
    if isinstance(value, datetime.time):
        return value.hour * 60 + value.minute
    if isinstance(value, datetime.datetime):
        return value.hour * 60 + value.minute
    if not isinstance(value, str):
        return None
    m = _TIME.match(value.strip())
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if mi > 59 or h > 24 or (h == 24 and mi != 0):
        return None
    return h * 60 + mi


def fmt_minutes(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def period_minutes(start: str, end: str) -> int:
    return parse_minutes(end) - parse_minutes(start)  # type: ignore[operator]


def is_count(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def validate_record(r: dict, known_classes: Iterable[str], road_exists=None) -> list[dict]:
    """Problems with one count record as [{field, message}] (empty when valid).

    ``road_exists(id) -> bool`` checks road references against the network when given.
    """
    errs: list[dict] = []

    def err(field: str, message: str):
        errs.append({"field": field, "message": message})

    known = set(known_classes)
    kind = r.get("ref_kind")
    if kind not in REF_KINDS:
        err("ref_kind", f"must be one of {', '.join(REF_KINDS)}")
    if kind == "road_direction":
        if not r.get("road_id"):
            err("road_id", "required for a road count")
        if r.get("direction") not in DIRECTIONS:
            err("direction", f"must be one of {', '.join(DIRECTIONS)} (relative to the road's drawn direction)")
    elif kind == "junction_approach":
        if not r.get("junction_ref"):
            err("junction_ref", "required for a junction approach count")
        if not r.get("approach_road_id"):
            err("approach_road_id", "required: the road the traffic arrives on")
    elif kind == "turn":
        if not r.get("junction_ref"):
            err("junction_ref", "required for a turning count")
        if not r.get("from_road_id"):
            err("from_road_id", "required for a turning count")
        if not r.get("to_road_id"):
            err("to_road_id", "required for a turning count")
        if r.get("turn") not in (None, "", *TURNS):
            err("turn", f"must be one of {', '.join(TURNS)} or empty")
    if road_exists is not None:
        for f in ("road_id", "approach_road_id", "from_road_id", "to_road_id"):
            v = r.get(f)
            if v and not road_exists(v):
                err(f, f"road '{v}' is not in the network")

    if r.get("day_type") not in DAY_TYPES:
        err("day_type", f"must be one of {', '.join(DAY_TYPES)}")
    d = r.get("count_date")
    if d not in (None, ""):
        try:
            datetime.date.fromisoformat(str(d))
        except ValueError:
            err("count_date", "must be an ISO date YYYY-MM-DD")

    s, e = parse_minutes(r.get("period_start")), parse_minutes(r.get("period_end"))
    if s is None:
        err("period_start", "must be a time HH:MM")
    if e is None:
        err("period_end", "must be a time HH:MM (24:00 allowed)")
    if s is not None and e is not None:
        if s >= 1440:
            err("period_start", "must be before 24:00")
        elif e <= s:
            err("period_end", "must be after period_start (a period cannot cross midnight; split it)")

    cc = r.get("class_counts") or {}
    total = r.get("total_count")
    if not isinstance(cc, dict):
        err("class_counts", "must be an object of class → vehicles")
        cc = {}
    for code, v in cc.items():
        if code not in known:
            err(f"class:{code}", f"unknown vehicle class '{code}' (add it to the vehicle classes first)")
        if not is_count(v):
            err(f"class:{code}", "must be a whole number ≥ 0")
    if total is not None and not is_count(total):
        err("total_count", "must be a whole number ≥ 0")
    if not cc and total is None:
        err("class_counts", "no vehicles counted: give class counts or a total")
    if cc and is_count(total) and all(is_count(v) for v in cc.values()) and sum(cc.values()) != total:
        err("total_count", f"total {total} does not equal the sum of the classes ({sum(cc.values())}); not corrected")
    return errs


def vehicles(r: dict) -> int:
    cc = r.get("class_counts") or {}
    return sum(cc.values()) if cc else int(r.get("total_count") or 0)


def veh_per_hour(r: dict) -> float:
    """Vehicles in the period → hourly flow rate (veh/h)."""
    return vehicles(r) * 60.0 / period_minutes(r["period_start"], r["period_end"])


def pcu(class_counts: dict[str, int], factors: dict[str, float], set_name: str) -> float:
    """Σ vehicles × factor. Refuses (MissingPcuFactor) when a counted class has no factor."""
    missing = sorted(c for c, v in class_counts.items() if v and c not in factors)
    if missing:
        raise MissingPcuFactor(missing, set_name)
    return float(sum(v * factors[c] for c, v in class_counts.items() if v))


def pcu_per_hour(r: dict, factors: dict[str, float] | None, set_name: str) -> tuple[float | None, str | None]:
    """(PCU/h, reason when not computable). Unclassified totals cannot be converted."""
    if factors is None:
        return None, "no PCU factor set chosen for this dataset"
    cc = r.get("class_counts") or {}
    if not cc:
        return None, "unclassified count: PCU needs vehicle classes"
    try:
        return pcu(cc, factors, set_name) * 60.0 / period_minutes(r["period_start"], r["period_end"]), None
    except MissingPcuFactor as ex:
        return None, str(ex)


def location_key(r: dict) -> tuple:
    return (r.get("ref_kind"), r.get("road_id"), r.get("direction"), r.get("junction_ref"),
            r.get("approach_road_id"), r.get("from_road_id"), r.get("to_road_id"))


def hourly(records: list[dict]) -> list[dict]:
    """Group one dataset's records into clock hours per location, day type and date.

    A clock hour gets a flow only when its records tile it completely
    (e.g. 4 × 15 min, or one 60-min record); sub-hour records that do not cover
    the hour are reported as ``complete: False`` with the minutes counted and no
    veh/h. Records longer than an hour are reported on their own (``span``), as a
    mean rate over their period, never spread silently across hours.
    """
    groups: dict[tuple, list[dict]] = {}
    out: list[dict] = []
    for r in records:
        s, e = parse_minutes(r["period_start"]), parse_minutes(r["period_end"])
        if e - s > 60 or s // 60 != (e - 1) // 60:
            out.append({"key": location_key(r), "day_type": r["day_type"], "count_date": r.get("count_date"),
                        "hour": s // 60, "period": f"{r['period_start']}–{r['period_end']}", "span": True,
                        "complete": True, "minutes": e - s, "veh_h": veh_per_hour(r),
                        "class_counts": dict(r.get("class_counts") or {}), "records": [r.get("id")]})
            continue
        groups.setdefault((location_key(r), r["day_type"], r.get("count_date"), s // 60), []).append(r)
    for (key, day, date, hour), rs in groups.items():
        rs = sorted(rs, key=lambda x: parse_minutes(x["period_start"]))
        covered, cursor, overlap = 0, hour * 60, False
        for x in rs:
            xs, xe = parse_minutes(x["period_start"]), parse_minutes(x["period_end"])
            if xs < cursor:
                overlap = True
            cursor = max(cursor, xe)
            covered += xe - xs
        complete = not overlap and covered == 60
        cc: dict[str, int] = {}
        classified = all(x.get("class_counts") for x in rs)
        for x in rs:
            for c, v in (x.get("class_counts") or {}).items():
                cc[c] = cc.get(c, 0) + v
        veh = sum(vehicles(x) for x in rs)
        out.append({"key": key, "day_type": day, "count_date": date, "hour": hour,
                    "period": f"{fmt_minutes(hour * 60)}–{fmt_minutes(hour * 60 + 60)}", "span": False,
                    "complete": complete, "overlap": overlap, "minutes": covered,
                    "veh_h": float(veh) if complete else None,
                    "class_counts": cc if classified else {}, "records": [x.get("id") for x in rs]})
    out.sort(key=lambda o: (str(o["key"]), o["day_type"], str(o["count_date"]), o["hour"]))
    return out
