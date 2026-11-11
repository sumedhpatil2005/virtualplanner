"""
CSV / Excel import: file → table → (column mapping) → records + per-row errors.

Nothing is saved here. Cells are read as printed; a value that does not parse
is an error on that row (with the row number as in the file, header = row 1),
never coerced. Integer-valued floats from Excel (120.0) are accepted as 120;
120.5 is an error.
"""

from __future__ import annotations

import csv
import datetime
import hashlib
import io
import re
from typing import Any

from .core import validate_record

MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 50_000

# Target fields a column can be mapped to (class columns are 'class:<code>')
FIELDS = [
    "ref_kind", "road_id", "direction", "direction_label", "junction_ref", "approach_road_id",
    "from_road_id", "to_road_id", "turn", "day_type", "count_date", "period_start", "period_end",
    "hour", "total_count", "lon", "lat", "quality_flag", "notes",
]

SYNONYMS = {
    "ref_kind": ["refkind", "kind", "type", "counttype", "reftype"],
    "road_id": ["roadid", "road", "objectid", "linkid", "roadref"],
    "direction": ["direction", "dir"],
    "direction_label": ["directionlabel", "towards", "dirlabel", "bound"],
    "junction_ref": ["junction", "junctionid", "junctionref", "intersection"],
    "approach_road_id": ["approach", "approachroad", "approachroadid"],
    "from_road_id": ["from", "fromroad", "fromroadid"],
    "to_road_id": ["to", "toroad", "toroadid"],
    "turn": ["turn", "movement"],
    "day_type": ["daytype", "day"],
    "count_date": ["date", "countdate", "surveydate"],
    "period_start": ["start", "periodstart", "from_time", "starttime", "timefrom"],
    "period_end": ["end", "periodend", "endtime", "timeto"],
    "hour": ["hour", "hr"],
    "total_count": ["total", "totalcount", "vehicles", "count", "allvehicles"],
    "lon": ["lon", "lng", "longitude"],
    "lat": ["lat", "latitude"],
    "quality_flag": ["quality", "qualityflag", "flag"],
    "notes": ["notes", "note", "remarks", "comment"],
}
CLASS_SYNONYMS = {
    "two_wheeler": ["twowheeler", "2w", "tw", "twowheelers", "motorcycle", "scooter"],
    "car": ["car", "cars", "lmv"],
    "auto_rickshaw": ["autorickshaw", "auto", "3w", "threewheeler", "autos"],
    "bus": ["bus", "buses"],
    "lcv": ["lcv", "lightcommercial"],
    "hcv": ["hcv", "truck", "trucks", "heavycommercial"],
    "other": ["other", "others"],
}


class ImportFileError(ValueError):
    pass


def norm(h: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(h).lower())


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_table(file_name: str, data: bytes, sheet: str | None = None) -> tuple[list[str], list[list[Any]], list[str]]:
    """(header, rows, sheet names). Rows keep raw cell values."""
    if len(data) > MAX_BYTES:
        raise ImportFileError(f"file is larger than {MAX_BYTES // (1024 * 1024)} MB")
    lower = file_name.lower()
    if lower.endswith(".xlsx"):
        import openpyxl  # minimal dependency, listed in requirements.txt

        try:
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception as ex:  # noqa: BLE001 - report any unreadable workbook
            raise ImportFileError(f"not a readable .xlsx workbook ({ex.__class__.__name__})") from ex
        names = wb.sheetnames
        if sheet and sheet not in names:
            raise ImportFileError(f"sheet '{sheet}' not found; sheets: {', '.join(names)}")
        ws = wb[sheet or names[0]]
        all_rows = [list(r) for r in ws.iter_rows(values_only=True)]
        wb.close()
    elif lower.endswith(".csv") or lower.endswith(".txt"):
        names = []
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as ex:
            raise ImportFileError("CSV must be UTF-8 encoded") from ex
        all_rows = [r for r in csv.reader(io.StringIO(text))]
    else:
        raise ImportFileError("only .csv and .xlsx files are supported (.xls: save as .xlsx first)")
    # drop fully empty trailing/blank rows but keep their numbering for the rest
    if not all_rows or not any(c not in (None, "") for c in all_rows[0]):
        raise ImportFileError("the first row must be a header row")
    header = ["" if c is None else str(c).strip() for c in all_rows[0]]
    rows = all_rows[1:]
    if len(rows) > MAX_ROWS:
        raise ImportFileError(f"more than {MAX_ROWS} rows; split the file")
    return header, rows, names


def suggest_mapping(header: list[str], class_codes: list[str]) -> dict[str, str]:
    """Column → field, by header name. Only exact synonym matches; the user confirms."""
    out: dict[str, str] = {}
    used: set[str] = set()
    for col in header:
        n = norm(col)
        if not n:
            continue
        for code in class_codes:
            if n == norm(code) or n in CLASS_SYNONYMS.get(code, []) or n == "class" + norm(code):
                t = f"class:{code}"
                if t not in used:
                    out[col] = t
                    used.add(t)
                break
        if col in out:
            continue
        for f in FIELDS:
            if f not in used and (n == norm(f) or n in SYNONYMS.get(f, [])):
                out[col] = f
                used.add(f)
                break
    return out


def _int(v: Any) -> tuple[int | None, str | None]:
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None, None
    if isinstance(v, bool):
        return None, "not a number"
    if isinstance(v, int):
        return v, None
    if isinstance(v, float):
        return (int(v), None) if v.is_integer() else (None, f"'{v}' is not a whole number")
    s = str(v).strip().replace(",", "")
    if re.fullmatch(r"-?\d+", s):
        return int(s), None
    if re.fullmatch(r"-?\d+\.0+", s):
        return int(float(s)), None
    return None, f"'{v}' is not a whole number"


def _text(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime.datetime):
        return v.date().isoformat() if (v.hour, v.minute, v.second) == (0, 0, 0) else v.isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, datetime.time):
        return f"{v.hour:02d}:{v.minute:02d}"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    s = str(v).strip()
    return s or None


def build_record(header: list[str], row: list[Any], mapping: dict[str, str], defaults: dict[str, Any]) -> tuple[dict, list[dict]]:
    """One file row → (record dict, parse errors). Validation of content is separate."""
    errs: list[dict] = []
    rec: dict[str, Any] = {"class_counts": {}}
    for k, v in (defaults or {}).items():
        if k in FIELDS and v not in (None, ""):
            rec[k] = v
    for i, col in enumerate(header):
        target = mapping.get(col)
        if not target or i >= len(row):
            continue
        raw = row[i]
        if target.startswith("class:"):
            n, e = _int(raw)
            if e:
                errs.append({"field": target, "message": e, "value": _text(raw)})
            elif n is not None:
                rec["class_counts"][target[6:]] = n
        elif target == "total_count":
            n, e = _int(raw)
            if e:
                errs.append({"field": target, "message": e, "value": _text(raw)})
            elif n is not None:
                rec["total_count"] = n
        elif target == "hour":
            n, e = _int(raw)
            if e or (n is not None and not 0 <= n <= 23):
                errs.append({"field": "hour", "message": e or "hour must be 0–23", "value": _text(raw)})
            elif n is not None:
                rec["period_start"], rec["period_end"] = f"{n:02d}:00", f"{n + 1:02d}:00"
        else:
            t = _text(raw)
            if t is not None:
                rec[target] = t.lower() if target in ("ref_kind", "direction", "day_type", "turn") else t
    if "class_counts" in rec and not rec["class_counts"]:
        rec["class_counts"] = {}
    return rec, errs


def parse_rows(header, rows, mapping, defaults, class_codes, road_exists=None) -> list[dict]:
    """[{row, record, errors}] for every non-empty row; row numbers as in the file."""
    unknown = [t for t in mapping.values() if t and not (t in FIELDS or (t.startswith("class:") and t[6:] in class_codes))]
    if unknown:
        raise ImportFileError(f"mapping targets not recognised: {', '.join(sorted(set(unknown)))}")
    missing_cols = [c for c in mapping if c not in header]
    if missing_cols:
        raise ImportFileError(f"mapped columns not in the file: {', '.join(missing_cols)}")
    out = []
    for n, row in enumerate(rows, start=2):
        if not any(c not in (None, "") and str(c).strip() != "" for c in row):
            continue
        rec, errs = build_record(header, row, mapping, defaults)
        errs += validate_record(rec, class_codes, road_exists)
        out.append({"row": n, "record": rec, "errors": errs})
    return out
