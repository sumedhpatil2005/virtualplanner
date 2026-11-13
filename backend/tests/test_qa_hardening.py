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


# ── API path / URL confinement ───────────────────────────────────────────────

def test_import_root_confined(client):
    r = client.post("/api/datasets/import", json={"root": "/etc", "dry_run": True})
    assert r.status_code == 400


def test_registered_file_paths_confined_and_update_url_ssrf(client):
    did = "qa_conf_test"
    client.post("/api/datasets", json={"id": did, "title": "QA", "created_by": "qa"})
    for bad in ("/etc/passwd", "../../../etc/passwd", "raw/../../../../etc/hostname"):
        r = client.post(f"/api/datasets/{did}/versions", json={"registered_by": "qa", "files": [{"path": bad}]})
        assert r.status_code == 400, (bad, r.text)
    for url in ("file:///etc/passwd", "http://127.0.0.1:8000/x", "http://169.254.169.254/latest", "ftp://example.org/x"):
        r = client.patch(f"/api/datasets/{did}", json={"edited_by": "qa", "update_check": {"method": "http_head", "url": url}})
        assert r.status_code == 400, (url, r.text)


def test_boreholes_one_bad_record_does_not_hide_the_others():
    import json as _json
    from types import SimpleNamespace

    from terrain import evidence as EV

    def rec(i, geom):
        return SimpleNamespace(id=f"b{i}", external_id=f"BH{i}", dataset_id="d", geometry_geojson=geom, final_depth_m=10.0,
                               ground_level_m=None)

    class DB:
        def scalars(self, _stmt):
            return [rec(1, "{not json"), rec(2, None),
                    rec(3, _json.dumps({"type": "Point", "coordinates": [73.8571, 18.5205]}))]
    al = EV.Alignment([[73.8560, 18.5200], [73.8580, 18.5210]])
    out = EV.boreholes(al, 1.0, db=DB())
    assert out["status"] == "ok" and [r["external_id"] for r in out["records"]] == ["BH3"]
    assert out["n_skipped"] == 2


def test_tree_index_reopened_after_replacement(tmp_path, monkeypatch):
    import csv
    import os as _os
    import time

    from datasets.pipelines import tree_index
    from envdata import trees
    monkeypatch.setenv("URBANOS_DERIVED_DIR", str(tmp_path / "derived"))
    out = tmp_path / "derived" / trees.DATASET / trees.VERSION
    out.mkdir(parents=True)

    def build(n):
        p = tmp_path / f"t{n}.csv"
        with open(p, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["lon", "lat", "id", "girth_cm", "height_m", "canopy_dia_m", "condition", "ownership", "botanical_name",
                        "common_name", "local_name", "ward", "is_rare"])
            for k in range(n):
                w.writerow([73.80 + k * 0.0001, 18.50, k + 1, 1, 1, 1, "Healthy", "Private", "x", "x", "x", "1", "FALSE"])
        tree_index.build(p, out / trees.FILE)
    trees._local.__dict__.clear()
    build(3)
    b = [73.79, 18.49, 73.81, 18.51]
    assert trees.query(b)["total"] == 3
    old = trees._local.conn
    time.sleep(0.02)
    build(5)
    _os.utime(out / trees.FILE, None)
    assert trees.query(b)["total"] == 5
    with pytest.raises(sqlite3.ProgrammingError):
        old.execute("select 1")
    trees._close()


def test_provenance_check_flags_mismatch_and_resolves_bare_names(tmp_path):
    import hashlib
    import json as _json

    from datasets import provenance_check as PC
    raw = tmp_path / "raw" / "src" / "2026-11-13"
    raw.mkdir(parents=True)
    (raw / "a.csv").write_bytes(b"SYNTHETIC a")
    (raw / "b.csv").write_bytes(b"SYNTHETIC b")
    sa, sb = (hashlib.sha256(b"SYNTHETIC " + x).hexdigest() for x in (b"a", b"b"))
    (raw / "manifest.json").write_text(_json.dumps({"files": [{"file": "a.csv", "sha256": sa}, {"file": "b.csv", "sha256": sb}]}))
    d = tmp_path / "derived" / "ds" / "v1"
    d.mkdir(parents=True)
    (d / "out.txt").write_bytes(b"out")
    (d / "processing.json").write_text(_json.dumps({
        "git_commit": "0000000000000000000000000000000000000000",
        "inputs": [{"file": "a.csv", "sha256": sa}, {"path": str(raw / "b.csv"), "sha256": "f" * 64}],
        "outputs": [{"path": "out.txt", "sha256": hashlib.sha256(b"out").hexdigest()}]}))
    rep = PC.check(tmp_path, hash_files=True)
    st = [i["status"] for i in rep["rows"][0]["inputs"]]
    assert st == ["match", "MISMATCH"]
    assert rep["rows"][0]["outputs"][0]["disk"] == "disk_match"
    assert any("not a commit" in p for p in rep["problems"]) and any("MISMATCH" not in p and "b.csv" in p for p in rep["problems"])


def test_stated_class_correction_registers_new_pending_version(client, monkeypatch):
    import hashlib
    import json as _json
    import os as _os
    import tempfile
    root = tempfile.mkdtemp(prefix="urbanos-qa-class-")
    d = _os.path.join(root, "raw", "t_ml_fp", "2026-11-13")
    _os.makedirs(d)
    with open(_os.path.join(d, "fp.csv"), "wb") as f:
        f.write(b"SYNTHETIC footprints")
    man = {"source_id": "t_ml_fp", "licence": "SYNTHETIC", "classification": "derived (ML detections)", "suitability": "screening",
           "files": [{"file": "fp.csv", "sha256": hashlib.sha256(b"SYNTHETIC footprints").hexdigest()}]}
    with open(_os.path.join(d, "manifest.json"), "w") as f:
        _json.dump(man, f)
    ov = _os.path.join(root, "ov.json")
    monkeypatch.setenv("URBANOS_CLASSIFICATION_OVERRIDES", _os.path.join(root, "absent.json"))
    client.post("/api/datasets/import", json={"root": root})
    first = client.get("/api/datasets/t_ml_fp").json()["active_version"]
    assert first["data_class"] == "derived"
    with open(ov, "w") as f:
        _json.dump({"datasets": {"t_ml_fp": {"theme": "buildings", "data_class": "inferred", "suitability": "screening", "reason": "SYN",
                                            "correct_stated_class": {"from": "derived", "to": "inferred", "reason": "SYNTHETIC ML"}}}}, f)
    monkeypatch.setenv("URBANOS_CLASSIFICATION_OVERRIDES", ov)
    rep = client.post("/api/datasets/import", json={"root": root}).json()
    e = next(x for x in rep["entries"] if "t_ml_fp" in x["dir"])
    assert e["result"] == "registered" and e["review_status"] == "pending_review"
    ds = client.get("/api/datasets/t_ml_fp").json()
    assert ds["active_version"]["id"] == first["id"] and ds["active_version"]["data_class"] == "derived"  # active untouched
    new = next(v for v in ds["versions"] if v["id"] == e["version_id"])
    assert new["data_class"] == "inferred" and "SYNTHETIC ML" in new["notes"]
    rep2 = client.post("/api/datasets/import", json={"root": root}).json()  # idempotent
    assert next(x for x in rep2["entries"] if "t_ml_fp" in x["dir"])["result"] == "unchanged"


def test_building_read_cap_is_reported_and_queries_per_box(monkeypatch):
    from shapely.geometry import box as sbox

    from coordination import service as S
    from datasets import infra_store
    calls = []
    monkeypatch.setattr(infra_store, "status", lambda: {"available": True, "fingerprint": "x"})
    monkeypatch.setattr(infra_store, "layer", lambda lid: {"id": lid, "bbox": [73.7, 18.4, 74.05, 18.7], "dataset_id": "buildings_comparison"})

    def near(lid, b, where=None, max_features=0):
        calls.append(tuple(b))
        return [(i + int(b[0] * 1000), "e", {"source": "osm", "status": "osm", "height_m": None}, sbox(b[0], b[1], b[0] + 1e-4, b[1] + 1e-4))
                for i in range(3)]
    monkeypatch.setattr(infra_store, "features_near", near)
    boxes = [(73.80, 18.50, 73.801, 18.501), (73.90, 18.60, 73.901, 18.601)]
    segs, meta = S.building_segments(boxes)
    assert calls == boxes and meta["read"] == 6 and meta["capped"] is False    # per box, not the union box
    monkeypatch.setattr(S, "BUILDING_MAX", 2)
    segs, meta = S.building_segments(boxes)
    assert meta["capped"] is True and meta["read"] == 2


def test_update_probe_refuses_non_public_targets_and_redirects():
    import urllib.error
    import urllib.request

    from datasets import updates
    with pytest.raises(ValueError):
        updates._http("HEAD", "http://127.0.0.1:1/x")
    assert updates.non_public_reason("file:///etc/passwd") and updates.non_public_reason("http://10.0.0.1/")
    h = updates._PublicRedirects()
    req = urllib.request.Request("https://example.org/a")
    with pytest.raises(urllib.error.URLError):
        h.redirect_request(req, None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data")
