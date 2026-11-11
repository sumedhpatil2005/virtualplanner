"""
Scenario change sets, versions, restore, frozen run inputs and the schema migration
(docs/SCENARIOS_AND_VERSIONING.md). All objects are synthetic test fixtures.
"""
import json
import os
import shutil
import sqlite3
import tempfile
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker


def _obj(oid, sid, lanes=2, x=73.7):
    return {"id": oid, "type": "road", "name": oid, "layerId": "roads", "scenarioId": sid,
            "coordinates": [[x, 18.5, 0], [x + 0.01, 18.5, 0]], "properties": {"laneCount": lanes}}


def _scenario(client, name="P"):
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    assert client.post("/api/scenarios", json={"id": sid, "name": name, "description": "", "year": 2030}).status_code == 201
    return sid


def _base(client, n=3):
    ids = [f"osm_{uuid.uuid4().hex[:8]}" for _ in range(n)]
    assert client.post("/api/objects/batch", json=[_obj(i, "base", x=73.7 + k * 0.01) for k, i in enumerate(ids)]).status_code == 201
    return ids


def _base_rows(client, ids):
    rows = {o["id"]: o for o in client.get("/api/objects", params={"scenario_id": "base"}).json() if o["id"] in ids}
    return json.dumps(rows, sort_keys=True)


def _view(client, sid):
    return {o["id"]: o for o in client.get(f"/api/scenarios/{sid}/materialised").json()}


def test_modify_and_tombstone_live_in_the_proposal_only(client):
    ids = _base(client)
    before = _base_rows(client, ids)
    sid = _scenario(client)
    mod = _obj(ids[0], sid, lanes=6)
    r = client.post(f"/api/scenarios/{sid}/changes", json=[{"objectId": ids[0], "op": "modify", "object": mod},
                                                          {"objectId": ids[1], "op": "delete"}])
    assert r.status_code == 200
    view = _view(client, sid)
    assert view[ids[0]]["properties"]["laneCount"] == 6
    assert ids[1] not in view
    assert ids[2] in view
    assert _base_rows(client, ids) == before
    # Revert puts the baseline object back in the proposal
    client.post(f"/api/scenarios/{sid}/changes", json=[{"objectId": ids[1], "op": "revert"}])
    assert ids[1] in _view(client, sid)


def test_changes_are_refused_for_non_base_objects_and_the_baseline(client):
    sid = _scenario(client)
    own = f"own_{uuid.uuid4().hex[:6]}"
    client.post("/api/objects", json=_obj(own, sid))
    assert client.post(f"/api/scenarios/{sid}/changes", json=[{"objectId": own, "op": "delete"}]).status_code == 400
    assert client.post("/api/scenarios/base/changes", json=[{"objectId": own, "op": "delete"}]).status_code == 400


def test_three_proposals_from_one_baseline_are_independent(client):
    ids = _base(client)
    before = _base_rows(client, ids)
    a, b, c = (_scenario(client, n) for n in "ABC")
    client.post(f"/api/scenarios/{a}/changes", json=[{"objectId": ids[0], "op": "modify", "object": _obj(ids[0], a, lanes=4)}])
    client.post(f"/api/scenarios/{b}/changes", json=[{"objectId": ids[0], "op": "delete"}])
    va, vb = _view(client, a), _view(client, b)
    client.post(f"/api/scenarios/{c}/changes", json=[{"objectId": ids[0], "op": "modify", "object": _obj(ids[0], c, lanes=8)}])
    client.post("/api/objects", json=_obj(f"new_{c}", c))
    assert _view(client, a) == va and _view(client, b) == vb
    assert _view(client, c)[ids[0]]["properties"]["laneCount"] == 8
    assert f"new_{c}" not in _view(client, a)
    assert _base_rows(client, ids) == before


def test_legacy_upsert_cannot_move_a_base_row_into_a_proposal(client):
    ids = _base(client, 1)
    sid = _scenario(client)
    assert client.post("/api/objects", json=_obj(ids[0], sid, lanes=4)).status_code == 409
    assert client.post("/api/objects/batch", json=[_obj(ids[0], sid, lanes=4)]).status_code == 409


def test_versions_are_immutable_and_restore_makes_a_new_head(client):
    ids = _base(client)
    sid = _scenario(client)
    client.post(f"/api/scenarios/{sid}/changes", json=[{"objectId": ids[0], "op": "delete"}])
    assumptions = {"demandVersion": "estimate:abc", "seeds": [1, 2, 3], "period": "am", "signalTiming": "webster"}
    v1 = client.post(f"/api/scenarios/{sid}/versions", json={"label": "Tombstone", "assumptions": assumptions}).json()
    assert v1["number"] == 1 and v1["changeCount"] == 1 and v1["assumptions"] == assumptions
    # Edit after v1: revert the tombstone, modify another, add an own object
    client.post(f"/api/scenarios/{sid}/changes", json=[{"objectId": ids[0], "op": "revert"},
                                                      {"objectId": ids[1], "op": "modify", "object": _obj(ids[1], sid, lanes=5)}])
    client.post("/api/objects", json=_obj(f"own_{sid}", sid))
    head_before_restore = client.get(f"/api/scenarios/{sid}/change-set").json()
    v1_full = client.get(f"/api/scenario-versions/{v1['id']}").json()

    r = client.post(f"/api/scenario-versions/{v1['id']}/restore", json={}).json()
    assert r["autoSaved"]["number"] == 2 and r["autoSaved"]["changeSetHash"] == head_before_restore["changeSetHash"]
    assert r["version"]["number"] == 3 and r["version"]["restoredFromVersionId"] == v1["id"]
    assert r["version"]["changeSetHash"] == v1["changeSetHash"]
    assert r["version"]["assumptions"] == assumptions
    view = _view(client, sid)
    assert ids[0] not in view and view[ids[1]]["properties"]["laneCount"] == 2 and f"own_{sid}" not in view
    # History unchanged: v1 is exactly as saved, v2 holds the pre-restore head (nothing lost)
    assert client.get(f"/api/scenario-versions/{v1['id']}").json() == v1_full
    v2 = client.get(f"/api/scenario-versions/{r['autoSaved']['id']}").json()
    assert {c["objectId"]: c["op"] for c in v2["changes"]} == {c["objectId"]: c["op"] for c in head_before_restore["changes"]}
    listed = client.get(f"/api/scenarios/{sid}/versions").json()
    assert [v["number"] for v in listed["versions"]] == [3, 2, 1]
    assert listed["headChangeSetHash"] == v1["changeSetHash"]
    # Restoring v2 brings the own object and the modify back
    client.post(f"/api/scenario-versions/{v2['id']}/restore", json={})
    view = _view(client, sid)
    assert f"own_{sid}" in view and view[ids[1]]["properties"]["laneCount"] == 5 and ids[0] in view


def test_version_materialisation_flags_a_changed_baseline(client):
    ids = _base(client, 1)
    sid = _scenario(client)
    v = client.post(f"/api/scenarios/{sid}/versions", json={"label": "empty"}).json()
    assert client.get(f"/api/scenario-versions/{v['id']}/objects").json()["baselineChanged"] is False
    client.post("/api/objects", json=_obj(ids[0], "base", lanes=3))  # someone edits the baseline itself
    assert client.get(f"/api/scenario-versions/{v['id']}/objects").json()["baselineChanged"] is True


def test_fork_copies_the_change_set_keyed_by_base_ids(client):
    ids = _base(client)
    a = _scenario(client)
    client.post(f"/api/scenarios/{a}/changes", json=[{"objectId": ids[0], "op": "modify", "object": _obj(ids[0], a, lanes=4)},
                                                    {"objectId": ids[1], "op": "delete"}])
    client.post("/api/objects", json=_obj(f"road1__{a}", a))
    b = f"scn_{uuid.uuid4().hex[:8]}"
    r = client.post(f"/api/scenarios/{a}/fork", json={"id": b, "name": "B", "description": "", "year": 2031})
    assert r.status_code == 201
    vb = _view(client, b)
    assert vb[ids[0]]["properties"]["laneCount"] == 4 and ids[1] not in vb and f"road1__{b}" in vb and f"road1__{a}" not in vb
    # Editing the copy leaves the source alone
    va = _view(client, a)
    client.post(f"/api/scenarios/{b}/changes", json=[{"objectId": ids[1], "op": "revert"}])
    assert _view(client, a) == va
    assert next(s for s in client.get("/api/scenarios").json() if s["id"] == b)


def test_delete_scenario_removes_its_changes_and_versions_not_the_baseline(client):
    ids = _base(client, 1)
    before = _base_rows(client, ids)
    sid = _scenario(client)
    client.post(f"/api/scenarios/{sid}/changes", json=[{"objectId": ids[0], "op": "delete"}])
    v = client.post(f"/api/scenarios/{sid}/versions", json={}).json()
    assert client.delete(f"/api/scenarios/{sid}").status_code == 200
    assert client.get(f"/api/scenario-changes", params={"scenario_id": sid}).json() == []
    assert client.get(f"/api/scenario-versions/{v['id']}").status_code == 404
    assert _base_rows(client, ids) == before


def test_runs_record_frozen_inputs_and_compare_lists_differences(client):
    _base(client, 1)
    sid = _scenario(client)
    inputs = {"demandKey": "k1", "trips": 120, "plannedVph": 5000, "hour": 9, "hourFactor": 1.0, "seeds": [1, 2, 3],
              "warmupS": 300, "measureS": 900, "signalTiming": "webster", "signalSource": "mapped"}
    ra = client.post("/api/runs", json={"scenarioId": "base", "inputs": inputs}).json()
    rb = client.post("/api/runs", json={"scenarioId": sid, "inputs": inputs}).json()
    same = client.post("/api/runs/compare", json={"runA": ra["id"], "runB": rb["id"]}).json()
    assert same["fair"] is True and same["differences"] == []
    rc = client.post("/api/runs", json={"scenarioId": sid, "inputs": {**inputs, "hour": 19, "seeds": [4, 5, 6]}}).json()
    diff = client.post("/api/runs/compare", json={"runA": ra["id"], "runB": rc["id"]}).json()
    assert diff["fair"] is False
    assert {d["field"] for d in diff["differences"]} == {"hour", "seeds"}
    assert client.get(f"/api/runs/{rc['id']}").json()["inputs"]["hour"] == 19


# ── Migration of an existing database ────────────────────────────────────────────────────────────────────────────

LEGACY_SCHEMA = """
CREATE TABLE scenarios (id VARCHAR NOT NULL PRIMARY KEY, name VARCHAR NOT NULL, description VARCHAR, year INTEGER);
CREATE TABLE city_objects (id VARCHAR NOT NULL PRIMARY KEY, type VARCHAR NOT NULL, name VARCHAR NOT NULL,
  layer_id VARCHAR NOT NULL, scenario_id VARCHAR NOT NULL, geometry_geojson VARCHAR NOT NULL, properties_json VARCHAR,
  created_at DATETIME, updated_at DATETIME);
CREATE TABLE areas (id VARCHAR NOT NULL PRIMARY KEY, name VARCHAR NOT NULL, polygon_geojson VARCHAR NOT NULL,
  min_lat FLOAT NOT NULL, max_lat FLOAT NOT NULL, min_lon FLOAT NOT NULL, max_lon FLOAT NOT NULL, created_at DATETIME);
"""


def _dump(path):
    con = sqlite3.connect(path)
    out = {t: con.execute(f"SELECT * FROM {t} ORDER BY id").fetchall() for t in ("city_objects", "areas")}
    out["scenarios"] = con.execute("SELECT id, name, description, year FROM scenarios ORDER BY id").fetchall()
    con.close()
    return out


def _migrate_and_check(path):
    from database.connection import Base
    from database.migrations import migrate
    from api.scenario_router import head_change_set, _save_version, change_set_hash
    from models.models import ScenarioEntity

    before = _dump(path)
    eng = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(bind=eng)
    first = migrate(eng)
    assert migrate(eng) == []  # idempotent
    cols = {c["name"] for c in inspect(eng).get_columns("scenarios")}
    assert {"kind", "baseline_id", "parent_scenario_id", "created_at"} <= cols
    assert _dump(path) == before  # no row of the old tables changed
    S = sessionmaker(bind=eng)
    with S() as db:
        for scn in db.query(ScenarioEntity).filter(ScenarioEntity.id != "base"):
            assert scn.kind == "proposal" and scn.baseline_id == "base"
            own = [r for r in before["city_objects"] if r[4] == scn.id]
            changes = head_change_set(db, scn.id)
            assert sorted(c["objectId"] for c in changes) == sorted(r[0] for r in own)
            assert all(c["op"] == "add" for c in changes)
            v = _save_version(db, scn, "after migration", "", {})
            db.commit()
            assert v.change_count == len(own) and v.change_set_hash == change_set_hash(changes)
    eng.dispose()
    return first


def test_migration_of_a_synthetic_legacy_database_loses_nothing(tmp_path):
    path = tmp_path / "legacy.db"
    con = sqlite3.connect(path)
    con.executescript(LEGACY_SCHEMA)
    con.execute("INSERT INTO scenarios VALUES ('base','Current City (Base)','',2026), ('scn_old','Old proposal','x',2030)")
    for i in range(5):
        con.execute("INSERT INTO city_objects VALUES (?,?,?,?,?,?,?,?,?)", (f"osm_{i}", "road", f"r{i}", "roads", "base", "[[73.7,18.5,0],[73.71,18.5,0]]", '{"laneCount":2}', None, None))
    con.execute("INSERT INTO city_objects VALUES (?,?,?,?,?,?,?,?,?)", ("road_x__scn_old", "road", "new", "roads", "scn_old", "[[73.7,18.6,0],[73.71,18.6,0]]", '{"laneCount":4}', None, None))
    con.commit(); con.close()
    assert len(_migrate_and_check(path)) == 4


REAL_DB = Path("/workspace/work/virtualplanner/backend/twincity.db")


@pytest.mark.skipif(not REAL_DB.exists(), reason="project database copy not available")
def test_migration_of_a_copy_of_the_project_database_loses_nothing(tmp_path):
    path = tmp_path / "copy.db"
    shutil.copy(REAL_DB, path)  # never the original
    # The project DB holds no proposals; add a legacy-shaped one (synthetic) so the migration has one to carry
    con = sqlite3.connect(path)
    con.execute("INSERT INTO scenarios (id, name, description, year) VALUES ('scn_legacy','Legacy proposal','synthetic',2030)")
    con.execute("INSERT INTO city_objects (id,type,name,layer_id,scenario_id,geometry_geojson,properties_json) VALUES ('legacy_road__scn_legacy','road','synthetic','roads','scn_legacy','[[73.8,18.5,0],[73.81,18.5,0]]','{}')")
    con.commit(); con.close()
    n_before = sqlite3.connect(path).execute("SELECT count(*) FROM city_objects").fetchone()[0]
    _migrate_and_check(path)
    assert sqlite3.connect(path).execute("SELECT count(*) FROM city_objects").fetchone()[0] == n_before
