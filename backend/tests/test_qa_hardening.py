"""QA hardening (2026-11-13): bbox/geometry validation, timestamp parsing, version ordering, SQLite retry/leaks,
reprojection helper. SYNTHETIC inputs only."""
import datetime as dt
import math
import sqlite3

import pytest

from datasets import infra_store as IS
from datasets import paths
from datasets.timeutil import IST, UTC, iso, is_date_only, parse_ts


# ── timestamps ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("s,expect", [
    ("2026-11-02T02:51:00+05:30", dt.datetime(2026, 11, 2, 2, 51, tzinfo=IST)),
    ("2026-11-01T21:21:00Z", dt.datetime(2026, 11, 1, 21, 21, tzinfo=UTC)),
    ("Mon 2026-11-02 2:51 AM IST", dt.datetime(2026, 11, 2, 2, 51, tzinfo=IST)),
    ("Mon 2026-11-02 2:51 AM IST (UTC+05:30)", dt.datetime(2026, 11, 2, 2, 51, tzinfo=IST)),
    ("Mon 2026-11-02 12:05 AM IST", dt.datetime(2026, 11, 2, 0, 5, tzinfo=IST)),
    ("Mon 2026-11-02 12:05 PM IST", dt.datetime(2026, 11, 2, 12, 5, tzinfo=IST)),
    ("Sun 2026-11-01 9:21 PM UTC", dt.datetime(2026, 11, 1, 21, 21, tzinfo=UTC)),
    ("Tue, 03 Nov 2026 10:00:00 GMT", dt.datetime(2026, 11, 3, 10, 0, tzinfo=UTC)),
    ("2026-11-02", dt.datetime(2026, 11, 2, tzinfo=IST)),
])
def test_parse_ts_forms_are_the_same_instant(s, expect):
    d = parse_ts(s)
    assert d is not None and d.tzinfo is not None and d == expect


def test_parse_ts_refuses_guesses():
    assert parse_ts("Mon 2026-11-02 2:51 AM PST") is None   # unknown abbreviation: not guessed as IST
    assert parse_ts("2026-13-40") is None and parse_ts("") is None and parse_ts("soon") is None
    assert parse_ts("2026-11-02 13:05 PM IST") is None       # 13 PM is not a time
    with pytest.raises(ValueError):
        iso(dt.datetime(2026, 1, 1))                       # writers never emit a naive timestamp
    assert iso(parse_ts("Mon 2026-11-02 2:51 AM IST")) == "2026-11-02T02:51:00+05:30"
    assert is_date_only("2026-11-02") and not is_date_only("2026-11-02T00:00:00+05:30")


def test_series_parse_ist_honours_stated_zone():
    from envdata.series import parse_ist
    assert parse_ist("Mon 2024-01-01 5:30 AM IST (UTC+05:30)") == "2024-01-01T05:30:00+05:30"
    # previously labelled +05:30 whatever the string said
    assert parse_ist("Mon 2024-01-01 5:30 AM UTC") == "2024-01-01T05:30:00+00:00"


def test_staleness_parse_date_keeps_stated_calendar_day():
    from datasets.quality import _parse_date
    assert _parse_date("2026-11-02T02:51:00+05:30").date().isoformat() == "2026-11-02"
    assert _parse_date("Tue, 03 Nov 2026 10:00:00 GMT").date().isoformat() == "2026-11-03"
    assert _parse_date("2021-06").date().isoformat() == "2021-06-28"


# ── bbox validation ──────────────────────────────────────────────────────────

BAD_BBOXES = ["nan,18.4,74,18.7", "73.7,18.4,inf,18.7", "73.7,18.4,1e9,18.7", "74,18.4,73.7,18.7",  # inverted
              "179,18,-179,19",  # antimeridian
              "73.7,18.4,74", "a,b,c,d", "73.7,-95,74,18.7", "73.7,18.7,74,18.7"]


@pytest.mark.parametrize("b", BAD_BBOXES)
def test_bbox_parsers_reject(b):
    from api.infra_router import parse_bbox as infra_bbox
    from envdata.render import parse_bbox as env_bbox
    with pytest.raises(ValueError):
        env_bbox(b)
    with pytest.raises(ValueError):
        infra_bbox(b)


def test_bbox_parsers_accept_pune():
    from api.infra_router import parse_bbox as infra_bbox
    from envdata.render import parse_bbox as env_bbox
    assert env_bbox("73.7,18.4,74.05,18.7") == infra_bbox("73.7,18.4,74.05,18.7") == [73.7, 18.4, 74.05, 18.7]


@pytest.mark.parametrize("b", ["nan,18.4,74,18.7", "73.7,18.4,inf,18.7", "74,18.4,73.7,18.7"])
def test_bbox_endpoints_422_not_500(client, b):
    assert client.get("/api/infra/layers/buildings/features", params={"bbox": b}).status_code == 422
    r = client.get("/api/env-data/trees", params={"bbox": b})
    assert r.status_code in (404, 409, 422)  # 404/409 when the tree index / layer is absent in this environment


# ── polygon validation ───────────────────────────────────────────────────────

@pytest.mark.parametrize("g", [
    {"type": "Polygon"},                                                       # no coordinates
    {"type": "Polygon", "coordinates": [[[73.8, 18.5], [73.81, 18.5]]]},        # too few points
    {"type": "Polygon", "coordinates": [[[73.8, 18.5], [float("nan"), 18.5], [73.81, 18.51], [73.8, 18.5]]]},
    {"type": "Polygon", "coordinates": [[[73.8, 18.5], [273.8, 18.5], [73.81, 18.51], [73.8, 18.5]]]},
    {"type": "LineString", "coordinates": [[73.8, 18.5], [73.81, 18.5]]},
    "not a dict",
])
def test_polygon_validation(g):
    from envdata.render import polygon_4326
    with pytest.raises(ValueError):
        polygon_4326(g)


def test_tree_count_large_polygon_refused(tmp_path, monkeypatch):
    from envdata import trees
    monkeypatch.setattr(trees, "MAX_POLYGON_CANDIDATES", 5)
    p = tmp_path / "derived" / trees.DATASET / trees.VERSION
    p.mkdir(parents=True)
    import csv
    csvp = tmp_path / "t.csv"
    with open(csvp, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["lon", "lat", "id", "girth_cm", "height_m", "canopy_dia_m", "condition", "ownership", "botanical_name",
                    "common_name", "local_name", "ward", "is_rare"])
        for k in range(20):
            w.writerow([73.80 + k * 0.001, 18.50, k + 1, 1, 1, 1, "Healthy", "Private", "x", "x", "x", "1", "FALSE"])
    from datasets.pipelines import tree_index
    tree_index.build(csvp, p / trees.FILE)
    monkeypatch.setenv("URBANOS_DERIVED_DIR", str(tmp_path / "derived"))
    trees._local.__dict__.clear()
    ring = [[73.79, 18.49], [73.83, 18.49], [73.83, 18.51], [73.79, 18.51], [73.79, 18.49]]
    with pytest.raises(ValueError, match="too large"):
        trees.count_in_polygon({"type": "Polygon", "coordinates": [ring]})
    small = [[73.7995, 18.4995], [73.8015, 18.4995], [73.8015, 18.5005], [73.7995, 18.5005], [73.7995, 18.4995]]
    assert trees.count_in_polygon({"type": "Polygon", "coordinates": [small]})["count"] == 2
    trees._local.__dict__.clear()


# ── versions, sqlite ─────────────────────────────────────────────────────────

def test_version_dirs_natural_order(tmp_path, monkeypatch):
    monkeypatch.setenv("URBANOS_DERIVED_DIR", str(tmp_path))
    for v in ("v1", "v2", "v9", "v10"):
        (tmp_path / "ds" / v).mkdir(parents=True)
        (tmp_path / "ds" / v / "processing.json").write_text("{}")
    assert [p.name for p in paths.derived_versions("ds")] == ["v1", "v2", "v9", "v10"]
    assert paths.derived_version_dir("ds").name == "v10"
    assert sorted(["2026-11-13", "2026-02-01"], key=paths.version_key) == ["2026-02-01", "2026-11-13"]


def _mk_index(path):
    con = sqlite3.connect(path)
    con.executescript("create table meta(key text, value text); insert into meta values('built_at','2026-11-13T22:00:00+05:30');"
                      "create table layers(id text, grp text, subgroup text, meta text, reserved text);")
    con.commit()
    con.close()


def test_infra_store_retry_and_no_connection_leak(tmp_path, monkeypatch):
    a, b = tmp_path / "a.sqlite", tmp_path / "b.sqlite"
    _mk_index(a)
    _mk_index(b)
    monkeypatch.setenv("URBANOS_INFRA_INDEX", str(a))
    IS._reset()
    assert IS.status()["available"]
    first = IS._LOCAL.con[1]
    monkeypatch.setenv("URBANOS_INFRA_INDEX", str(b))
    assert IS.status()["available"]
    with pytest.raises(sqlite3.ProgrammingError):     # the stale connection was closed, not leaked
        first.execute("select 1")
    calls = {"n": 0}

    @IS._retry
    def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.DatabaseError("database disk image is malformed")
        return "ok"
    assert flaky() == "ok" and calls["n"] == 2
    IS._reset()


# ── reprojection helper ──────────────────────────────────────────────────────

def test_reproject_matches_point_transform_and_no_deprecation():
    import warnings

    from shapely.geometry import shape

    from coordination.geometry import _TO_UTM, project_geojson, to_utm
    g = {"type": "MultiLineString", "coordinates": [[[73.8567, 18.5204], [73.86, 18.53]]]}
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        u = project_geojson(g)
    x, y = to_utm(73.8567, 18.5204)
    assert math.isclose(list(u.geoms[0].coords)[0][0], x) and math.isclose(list(u.geoms[0].coords)[0][1], y)
    assert shape(g).geom_type == u.geom_type and _TO_UTM is not None


def test_aq_series_bounds_accept_zoned_iso_and_human_form():
    import pandas as pd

    from envdata.series import _bound
    assert _bound("2026-11-02", "start") == pd.Timestamp("2026-11-02T00:00:00+05:30")
    assert _bound("2026-11-02", "end", end=True) == pd.Timestamp("2026-11-03T00:00:00+05:30")  # whole day inclusive
    # a zoned ISO bound used to raise inside pandas (tz passed twice) -> 422; now it is the instant it states
    assert _bound("2026-11-01T21:00:00Z", "end", end=True) == pd.Timestamp("2026-11-02T02:30:00+05:30")
    assert _bound("Mon 2026-11-02 2:51 AM IST", "start") == pd.Timestamp("2026-11-02T02:51:00+05:30")
    with pytest.raises(ValueError):
        _bound("next week", "start")
