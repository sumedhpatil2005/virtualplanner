"""
Traffic Data Manager (docs/TRAFFIC_DATA.md). All counts here are SYNTHETIC test
fixtures, not observations.
"""

import base64
import io
import uuid

import pytest

from traffic_data import core
from traffic_data.seed import IRC106_TABLE1

SYN = "SYNTHETIC test fixture"


def _road(client, rid=None):
    rid = rid or f"td_road_{uuid.uuid4().hex[:8]}"
    res = client.post("/api/objects", json={"id": rid, "type": "road", "name": rid, "layerId": "roads", "scenarioId": "base",
                                            "coordinates": [[73.85, 18.5, 0], [73.86, 18.5, 0]], "properties": {}})
    assert res.status_code == 201
    return rid


def _set_id(client, key="irc106-1990-t1-10pct", version=1):
    return next(s["id"] for s in client.get("/api/traffic-data/pcu-sets").json() if s["set_key"] == key and s["version"] == version)


def _dataset(client, kind="measured", role="validation", **kw):
    body = {"name": f"{SYN} {kind}", "provider": SYN, "kind": kind, "location_desc": "synthetic", "period_desc": "08:00–10:00",
            "classification": "7-class", "entered_by": "pytest", "role": role, "synthetic": True,
            "pcu_factor_set_id": _set_id(client), **kw}
    res = client.post("/api/traffic-data/datasets", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def _rec(road, **kw):
    return {"ref_kind": "road_direction", "road_id": road, "direction": "fwd", "day_type": "weekday",
            "period_start": "08:00", "period_end": "09:00", "class_counts": {"two_wheeler": 400, "car": 200, "bus": 10}, **kw}


# ── seed / classes / PCU ──────────────────────────────────────────────────────

def test_vehicle_classes_seeded_and_extensible(client):
    codes = [c["code"] for c in client.get("/api/traffic-data/vehicle-classes").json()]
    for c in ("two_wheeler", "car", "auto_rickshaw", "bus", "lcv", "hcv", "other"):
        assert c in codes
    res = client.post("/api/traffic-data/vehicle-classes", json={"code": "e_rickshaw", "label": "E-rickshaw", "created_by": "pytest"})
    assert res.status_code == 201
    assert "e_rickshaw" in [c["code"] for c in client.get("/api/traffic-data/vehicle-classes").json()]
    assert client.post("/api/traffic-data/vehicle-classes", json={"code": "e_rickshaw", "label": "x", "created_by": "p"}).status_code == 409


@pytest.mark.parametrize("col,idx", [("irc106-1990-t1-5pct", 0), ("irc106-1990-t1-10pct", 1)])
def test_irc106_table1_both_columns(client, col, idx):
    s = next(s for s in client.get("/api/traffic-data/pcu-sets").json() if s["set_key"] == col and s["version"] == 1)
    assert s["builtin"] and "IRC:106-1990" in s["source_citation"] and "archive.org" in s["source_url"]
    for cls, vals in IRC106_TABLE1.items():
        assert s["factors"][cls] == vals[idx]
    # values as printed in Table 1 (5% / 10%+)
    assert (s["factors"]["two_wheeler"], s["factors"]["auto_rickshaw"], s["factors"]["bus"]) == [(0.5, 1.2, 2.2), (0.75, 2.0, 3.7)][idx]
    assert "other" not in s["factors"]


def test_pcu_conversion_with_named_set(client):
    sid = _set_id(client)
    res = client.post("/api/traffic-data/pcu/convert", json={"pcu_factor_set_id": sid, "class_counts": {"two_wheeler": 100, "car": 50, "bus": 2}, "period_minutes": 15})
    assert res.status_code == 200
    j = res.json()
    assert j["pcu"] == pytest.approx(100 * 0.75 + 50 + 2 * 3.7)
    assert j["veh_h"] == 152 * 4 and j["pcu_h"] == pytest.approx(j["pcu"] * 4)
    assert j["factor_set"]["name"].startswith("IRC:106-1990")


def test_pcu_conversion_refused_when_class_missing(client):
    res = client.post("/api/traffic-data/pcu/convert", json={"pcu_factor_set_id": _set_id(client), "class_counts": {"car": 10, "other": 3}})
    assert res.status_code == 422 and "other" in res.json()["detail"]
    with pytest.raises(core.MissingPcuFactor):
        core.pcu({"other": 1}, {"car": 1.0}, "x")


def test_pcu_set_edit_creates_version_and_never_changes_old(client):
    old = next(s for s in client.get("/api/traffic-data/pcu-sets").json() if s["set_key"] == "irc106-1990-t1-app-mix" and s["version"] == 1)
    body = {"name": old["name"] + " + other", "source_citation": "user judgement (pytest)", "factors": {**old["factors"], "other": 1.0},
            "created_by": "pytest", "change_note": ""}
    assert client.post("/api/traffic-data/pcu-sets/irc106-1990-t1-app-mix/versions", json=body).status_code == 422  # note required
    body["change_note"] = "add 'other' = 1.0 by judgement"
    res = client.post("/api/traffic-data/pcu-sets/irc106-1990-t1-app-mix/versions", json=body)
    assert res.status_code == 201 and res.json()["version"] == 2
    sets = client.get("/api/traffic-data/pcu-sets").json()
    v1 = next(s for s in sets if s["id"] == old["id"])
    assert v1["factors"] == old["factors"] and v1["latest"] is False
    assert client.put(f"/api/traffic-data/pcu-sets/{old['id']}", json=body).status_code in (404, 405)
    # round trip of a user set
    res = client.post("/api/traffic-data/pcu-sets", json={"name": "Stop-line trial", "context": "signalised", "source_citation": "user judgement",
                                                          "factors": {"car": 1.0, "two_wheeler": 0.3}, "created_by": "pytest"})
    assert res.status_code == 201 and res.json()["factors"] == {"car": 1.0, "two_wheeler": 0.3}
    assert client.post("/api/traffic-data/pcu-sets", json={"name": "bad", "source_citation": "x", "factors": {"spaceship": 1.0}, "created_by": "p"}).status_code == 422


# ── manual entry, directional, turning, hourly, classification ────────────────

def test_manual_entry_directional_counts_with_veh_and_pcu(client):
    road = _road(client)
    ds = _dataset(client, kind="manual")
    res = client.post(f"/api/traffic-data/datasets/{ds['id']}/records", json={"entered_by": "pytest", "records": [
        _rec(road, direction="fwd", direction_label="towards east"),
        _rec(road, direction="bwd", class_counts={"two_wheeler": 100, "car": 100}),
    ]})
    assert res.status_code == 201, res.text
    fwd, bwd = res.json()
    assert fwd["veh_h"] == 610 and fwd["pcu_h"] == pytest.approx(400 * 0.75 + 200 + 10 * 3.7)
    assert bwd["direction"] == "bwd" and bwd["veh_h"] == 200
    got = client.get(f"/api/traffic-data/datasets/{ds['id']}").json()
    assert got["kind"] == "manual" and {r["direction"] for r in got["records"]} == {"fwd", "bwd"}
    assert got["pcu_set"]["set_key"] == "irc106-1990-t1-10pct"


def test_unknown_road_and_bad_values_rejected_all_or_nothing(client):
    road = _road(client)
    ds = _dataset(client)
    res = client.post(f"/api/traffic-data/datasets/{ds['id']}/records", json={"entered_by": "pytest", "records": [
        _rec(road),
        _rec("no_such_road"),
        _rec(road, direction="north"),
        _rec(road, class_counts={"car": -3}),
        _rec(road, class_counts={"car": 2.5}),
        _rec(road, period_start="09:00", period_end="08:00"),
        _rec(road, class_counts={}, total_count=None),
        _rec(road, class_counts={"car": 10, "bus": 5}, total_count=20),
        _rec(road, class_counts={"spaceship": 1}),
    ]})
    assert res.status_code == 422
    probs = {p["index"]: p["errors"] for p in res.json()["detail"]["problems"]}
    assert set(probs) == {1, 2, 3, 4, 5, 6, 7, 8}
    assert any("not in the network" in e["message"] for e in probs[1])
    assert any("not corrected" in e["message"] for e in probs[7])
    assert client.get(f"/api/traffic-data/datasets/{ds['id']}").json()["records"] == []  # nothing saved


def test_turning_and_approach_counts(client):
    a, b = _road(client), _road(client)
    ds = _dataset(client)
    res = client.post(f"/api/traffic-data/datasets/{ds['id']}/records", json={"entered_by": "pytest", "records": [
        {"ref_kind": "turn", "junction_ref": "ljunction:syn1", "from_road_id": a, "to_road_id": b, "turn": "right",
         "day_type": "weekday", "period_start": "08:00", "period_end": "08:15", "class_counts": {"car": 30, "auto_rickshaw": 10}},
        {"ref_kind": "junction_approach", "junction_ref": "ljunction:syn1", "approach_road_id": a,
         "day_type": "weekday", "period_start": "08:00", "period_end": "09:00", "total_count": 900},
    ]})
    assert res.status_code == 201, res.text
    turn, appr = res.json()
    assert turn["veh_h"] == 160 and turn["pcu_h"] == pytest.approx((30 + 10 * 2.0) * 4)
    assert appr["veh_h"] == 900 and appr["pcu_h"] is None and "unclassified" in appr["pcu_note"]
    bad = client.post(f"/api/traffic-data/datasets/{ds['id']}/records", json={"entered_by": "p", "records": [
        {"ref_kind": "turn", "junction_ref": "j", "from_road_id": a, "day_type": "weekday", "period_start": "08:00", "period_end": "09:00", "total_count": 1, "turn": "sideways"}]})
    fields = {e["field"] for e in bad.json()["detail"]["problems"][0]["errors"]}
    assert {"to_road_id", "turn"} <= fields


def test_hourly_profile_weekday_weekend_and_incomplete_hours(client):
    road = _road(client)
    ds = _dataset(client)
    recs = [_rec(road, period_start=f"08:{m:02d}", period_end=f"{'09:00' if m == 45 else f'08:{m + 15:02d}'}", class_counts={"car": 100, "two_wheeler": 50}) for m in (0, 15, 30, 45)]
    recs += [_rec(road, period_start="09:00", period_end="09:15", class_counts={"car": 70})]  # only a quarter of 09:00
    recs += [_rec(road, day_type="sunday", period_start="08:00", period_end="09:00", class_counts={"car": 120})]
    assert client.post(f"/api/traffic-data/datasets/{ds['id']}/records", json={"entered_by": "p", "records": recs}).status_code == 201
    hours = client.get(f"/api/traffic-data/datasets/{ds['id']}/hourly?road_id={road}").json()["hours"]
    wk8 = next(h for h in hours if h["day_type"] == "weekday" and h["hour"] == 8)
    assert wk8["complete"] and wk8["veh_h"] == 600 and wk8["class_counts"] == {"car": 400, "two_wheeler": 200}
    assert wk8["pcu_h"] == pytest.approx(400 + 200 * 0.75)
    wk9 = next(h for h in hours if h["day_type"] == "weekday" and h["hour"] == 9)
    assert not wk9["complete"] and wk9["veh_h"] is None and wk9["minutes"] == 15  # not extrapolated
    sun = next(h for h in hours if h["day_type"] == "sunday")
    assert sun["veh_h"] == 120


def test_long_period_reported_as_span_not_spread():
    r = {"id": 1, "ref_kind": "road_direction", "road_id": "x", "direction": "fwd", "day_type": "weekday",
         "period_start": "07:00", "period_end": "10:00", "class_counts": {"car": 900}}
    (h,) = core.hourly([r])
    assert h["span"] and h["veh_h"] == 300 and h["minutes"] == 180


# ── measured vs estimated ─────────────────────────────────────────────────────

def test_measured_and_estimated_never_merged(client):
    road = _road(client)
    m = _dataset(client, kind="measured")
    e = _dataset(client, kind="estimated")
    for ds, n in ((m, 500), (e, 800)):
        client.post(f"/api/traffic-data/datasets/{ds['id']}/records", json={"entered_by": "p", "records": [_rec(road, class_counts={"car": n})]})
    only_measured = [r for r in client.get("/api/traffic-data/counts?role=validation").json() if r["road_id"] == road]
    assert [(r["kind"], r["veh_h"]) for r in only_measured] == [("measured", 500)]
    both = [r for r in client.get("/api/traffic-data/counts?role=validation&kinds=measured,estimated").json() if r["road_id"] == road]
    assert sorted((r["kind"], r["veh_h"]) for r in both) == [("estimated", 800), ("measured", 500)]  # two rows, not 650
    assert client.get("/api/traffic-data/counts?kinds=guessed").status_code == 422


def test_dataset_requires_provenance_and_edits_are_audited(client):
    res = client.post("/api/traffic-data/datasets", json={"name": "x", "provider": "", "kind": "measured", "location_desc": "",
                                                          "period_desc": "", "classification": "", "entered_by": ""})
    assert res.status_code == 422
    assert client.post("/api/traffic-data/datasets", json={"name": "x", "provider": "p", "kind": "guess", "location_desc": "l",
                                                           "period_desc": "p", "classification": "c", "entered_by": "e"}).status_code == 422
    ds = _dataset(client, role="unused")
    res = client.patch(f"/api/traffic-data/datasets/{ds['id']}", json={"edited_by": "reviewer", "role": "validation", "adjustments": "none"})
    assert res.status_code == 200 and res.json()["role"] == "validation"
    log = client.get(f"/api/traffic-data/datasets/{ds['id']}/audit").json()
    assert [a["action"] for a in log] == ["create", "update"]
    assert log[1]["actor"] == "reviewer" and log[1]["before"]["role"] == "unused" and log[1]["after"]["role"] == "validation"


# ── import ────────────────────────────────────────────────────────────────────

def _b64(s: bytes) -> str:
    return base64.b64encode(s).decode()


CSV_HEAD = "Road ID,Direction,Day type,Hour,2W,Car,Auto,Bus,LCV,HCV,Total,Remarks\n"


def _import_body(client, data: bytes, name="syn.csv", mapping=None, **kw):
    return {"file_name": name, "content_base64": _b64(data), "mapping": mapping, "defaults": {"ref_kind": "road_direction"}, **kw}


def test_csv_preview_suggests_mapping_and_reports_row_errors(client):
    road = _road(client)
    csv = (CSV_HEAD
           + f"{road},fwd,weekday,8,400,200,50,10,5,2,667,{SYN}\n"
           + f"{road},bwd,weekday,8,300,150,40,8,4,1,503,{SYN}\n"
           + f"{road},sideways,weekday,8,1,1,1,1,1,1,6,bad direction\n"
           + f"missing_road,fwd,weekday,9,1,1,1,1,1,1,6,unknown road\n"
           + f"{road},fwd,weekday,25,1,1,1,1,1,1,6,bad hour\n"
           + f"{road},fwd,weekday,10,1.5,1,1,1,1,1,6,fraction\n"
           + f"{road},fwd,weekday,11,10,10,0,0,0,0,25,total mismatch\n"
           + ",,,,,,,,,,,\n").encode()
    res = client.post("/api/traffic-data/import/preview", json=_import_body(client, csv))
    assert res.status_code == 200, res.text
    j = res.json()
    m = j["mapping"]
    assert m["Road ID"] == "road_id" and m["2W"] == "class:two_wheeler" and m["Auto"] == "class:auto_rickshaw" and m["Hour"] == "hour" and m["Total"] == "total_count"
    assert j["row_count"] == 7 and j["valid_count"] == 2 and j["error_count"] == 5
    bad_rows = {p["row"] for p in j["invalid_rows"]}
    assert bad_rows == {4, 5, 6, 7, 8}  # file rows (header = 1); blank row skipped


def test_csv_commit_refuses_invalid_unless_skip_and_keeps_rejects(client):
    road = _road(client)
    csv = (CSV_HEAD + f"{road},fwd,weekday,8,400,200,50,10,5,2,667,{SYN}\n" + f"{road},fwd,weekday,9,x,1,1,1,1,1,6,bad\n").encode()
    pre = client.post("/api/traffic-data/import/preview", json=_import_body(client, csv)).json()
    meta = {"name": f"{SYN} import", "provider": SYN, "kind": "measured", "location_desc": "syn", "period_desc": "08–10",
            "classification": "7-class", "entered_by": "pytest", "synthetic": True, "pcu_factor_set_id": _set_id(client)}
    body = _import_body(client, csv, mapping=pre["mapping"], dataset=meta)
    res = client.post("/api/traffic-data/import/commit", json=body)
    assert res.status_code == 422 and "nothing imported" in res.json()["detail"]["message"]
    res = client.post("/api/traffic-data/import/commit", json={**body, "skip_invalid": True})
    assert res.status_code == 201, res.text
    ds = client.get(f"/api/traffic-data/datasets/{res.json()['id']}").json()
    assert len(ds["records"]) == 1 and ds["records"][0]["source_row"] == 2 and ds["records"][0]["veh_h"] == 667
    rep = ds["import_report"]
    assert rep["rejected"] == 1 and rep["rejected_rows"][0]["row"] == 3 and ds["imported_file_sha256"]


def test_xlsx_import_with_times_and_defaults(client):
    openpyxl = pytest.importorskip("openpyxl")
    import datetime
    road = _road(client)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Counts"
    ws.append(["road", "dir", "start", "end", "Car", "Bus", "Other", "date"])
    ws.append([road, "fwd", datetime.time(8, 0), datetime.time(8, 15), 120.0, 3, 1, datetime.datetime(2026, 3, 4)])
    ws.append([road, "fwd", "08:15", "08:30", 110, 2, 0, "2026-03-04"])
    ws.append([road, "fwd", "08:30", "08:45", 105.5, 2, 0, "2026-03-04"])
    buf = io.BytesIO()
    wb.save(buf)
    data = buf.getvalue()
    res = client.post("/api/traffic-data/import/preview", json={**_import_body(client, data, name="syn.xlsx"), "defaults": {"ref_kind": "road_direction", "day_type": "weekday"}})
    assert res.status_code == 200, res.text
    j = res.json()
    assert j["sheets"] == ["Counts"] and j["mapping"]["start"] == "period_start" and j["mapping"]["Other"] == "class:other"
    assert j["valid_count"] == 2 and j["invalid_rows"][0]["row"] == 4
    ok = j["rows"][0]["record"]
    assert ok["period_start"] == "08:00" and ok["count_date"] == "2026-03-04" and ok["class_counts"] == {"car": 120, "bus": 3, "other": 1}
    assert client.post("/api/traffic-data/import/preview", json=_import_body(client, b"not a zip", name="x.xlsx")).status_code == 422
    assert client.post("/api/traffic-data/import/preview", json=_import_body(client, b"a,b", name="x.xls")).status_code == 422


def test_import_bad_mapping_target(client):
    res = client.post("/api/traffic-data/import/preview", json=_import_body(client, CSV_HEAD.encode(), mapping={"Road ID": "nonsense"}))
    assert res.status_code == 422


def test_delete_dataset_audited(client):
    road = _road(client)
    ds = _dataset(client)
    client.post(f"/api/traffic-data/datasets/{ds['id']}/records", json={"entered_by": "p", "records": [_rec(road)]})
    assert client.delete(f"/api/traffic-data/datasets/{ds['id']}?deleted_by=pytest").json()["records"] == 1
    assert client.get(f"/api/traffic-data/datasets/{ds['id']}").status_code == 404
    log = client.get(f"/api/traffic-data/datasets/{ds['id']}/audit").json()
    assert log[-1]["action"] == "delete" and log[-1]["before"]["records"][0]["road_id"] == road
