"""Timestamp parsing/writing for dataset metadata (manifests, processing.json, registry rows, API query params).

Writers emit ISO 8601 with an explicit offset (``iso()``). Readers accept what has actually been seen in the store:
  * ISO 8601: ``2026-11-02T02:51:00+05:30``, ``...Z``, ``2026-11-02T02:51`` (naive -> default zone), ``2026-11-02``
  * the human form some tools rewrite ISO strings into: ``Mon 2026-11-02 2:51 AM IST`` / ``... IST (UTC+05:30)``,
    also with ``UTC``/``GMT`` or an explicit ``UTC+hh:mm`` and optional seconds
  * RFC 1123 (HTTP Last-Modified): ``Tue, 03 Nov 2026 10:00:00 GMT``
A zone abbreviation other than IST/UTC/GMT/Z with no numeric offset is NOT guessed: ``parse_ts`` returns None.
No third-party imports.
"""
from __future__ import annotations

import datetime as _dt
import re
from email.utils import parsedate_to_datetime

IST = _dt.timezone(_dt.timedelta(hours=5, minutes=30), "IST")
UTC = _dt.timezone.utc
_ZONES = {"IST": IST, "UTC": UTC, "GMT": UTC, "Z": UTC}
_HUMAN = re.compile(
    r"(?P<date>\d{4}-\d{2}-\d{2})[ T]+(?P<h>\d{1,2}):(?P<m>\d{2})(?::(?P<s>\d{2}))?\s*(?P<ampm>AM|PM|am|pm)?"
    r"\s*(?P<abbr>[A-Za-z]{1,5})?\s*(?:\(?\s*(?:UTC|GMT)\s*(?P<off>[+-]\d{1,2}(?::?\d{2})?)\s*\)?)?")
_DATE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})\s*$")


def _offset(s: str) -> _dt.timezone:
    sign = -1 if s[0] == "-" else 1
    s = s[1:].replace(":", "")
    h, m = (int(s[:-2] or 0), int(s[-2:])) if len(s) > 2 else (int(s), 0)
    return _dt.timezone(sign * _dt.timedelta(hours=h, minutes=m))


def parse_ts(s, default_tz: _dt.tzinfo = IST) -> _dt.datetime | None:
    """Any supported timestamp string -> timezone-aware datetime, or None when it cannot be parsed unambiguously.
    A naive value (no zone stated) takes ``default_tz`` (IST: every UrbanOS writer that omitted a zone wrote IST)."""
    if s is None:
        return None
    if isinstance(s, _dt.datetime):
        return s if s.tzinfo else s.replace(tzinfo=default_tz)
    s = str(s).strip()
    if not s:
        return None
    m = _DATE.match(s)
    if m:
        try:
            return _dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=default_tz)
        except ValueError:
            return None
    try:
        d = _dt.datetime.fromisoformat(s.replace("Z", "+00:00") if s.endswith("Z") else s)
        return d if d.tzinfo else d.replace(tzinfo=default_tz)
    except ValueError:
        pass
    if "," in s[:5]:
        try:
            d = parsedate_to_datetime(s)
            return d if d.tzinfo else d.replace(tzinfo=UTC)
        except (TypeError, ValueError, IndexError):
            pass
    m = _HUMAN.search(s)
    if not m:
        return None
    h, mi, sec = int(m.group("h")), int(m.group("m")), int(m.group("s") or 0)
    if m.group("ampm"):
        if not 1 <= h <= 12:
            return None
        h = h % 12 + (12 if m.group("ampm").upper() == "PM" else 0)
    if m.group("off"):
        tz: _dt.tzinfo = _offset(m.group("off"))
    elif m.group("abbr") and m.group("abbr").upper() not in ("AM", "PM"):
        tz = _ZONES.get(m.group("abbr").upper())
        if tz is None:
            return None  # unknown abbreviation: do not guess
    else:
        tz = default_tz
    try:
        y, mo, d = (int(x) for x in m.group("date").split("-"))
        return _dt.datetime(y, mo, d, h, mi, sec, tzinfo=tz)
    except ValueError:
        return None


def iso(d: _dt.datetime | None, tz: _dt.tzinfo | None = None) -> str | None:
    """Aware datetime -> ISO 8601 with offset (seconds precision). Naive input is refused rather than guessed."""
    if d is None:
        return None
    if d.tzinfo is None:
        raise ValueError("naive datetime: state its zone")
    return (d.astimezone(tz) if tz else d).isoformat(timespec="seconds")


def is_date_only(s) -> bool:
    return isinstance(s, str) and bool(_DATE.match(s))
