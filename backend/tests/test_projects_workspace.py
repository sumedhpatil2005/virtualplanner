"""
Backend additions for the Projects & Reports workspaces (docs/urbanos/PROJECTS_AND_COORDINATION_UI.md):
preferred alternative flag, element registration from an alternative's own objects, conflict summary CSV export,
and the additive migration. All data SYNTHETIC.
"""
import csv
import io
import uuid

import sqlalchemy

from tests.test_coordination import LAT, _area, _detect, _el, _line, _project  # noqa: F401  (_area is an autouse fixture)


def _scenario(client, name="SYNTHETIC alternative"):
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    assert client.post("/api/scenarios", json={"id": sid, "name": name, "description": "SYNTHETIC", "year": 2030}).status_code == 201
    return sid


def _link(client, pid, sid):
    r = client.post(f"/api/planning/projects/{pid}/links", json={"entity_type": "scenario", "entity_id": sid, "added_by": "Planner T"})
    assert r.status_code == 201, r.text


def test_preferred_alternative_must_be_attached_is_audited_and_clearable(client):
    pid, sid = _project(client), _scenario(client)
    r = client.patch(f"/api/planning/projects/{pid}", json={"edited_by": "Planner T", "preferred_scenario_id": sid})
    assert r.status_code == 422  # not attached yet
    _link(client, pid, sid)
    r = client.patch(f"/api/planning/projects/{pid}", json={"edited_by": "Planner T", "preferred_scenario_id": sid})
    assert r.status_code == 200 and r.json()["preferred_scenario_id"] == sid
    assert any(p["id"] == pid and p["preferred_scenario_id"] == sid for p in client.get("/api/planning/projects").json())
    ev = client.get(f"/api/planning/projects/{pid}/audit").json()["events"]
    upd = [e for e in ev if e["entity_type"] == "project" and e["action"] == "update"]
    assert upd and "preferred_scenario_id" in (upd[-1]["changed_fields"] or []) and upd[-1]["actor"] == "Planner T"
    r = client.patch(f"/api/planning/projects/{pid}", json={"edited_by": "Planner T", "preferred_scenario_id": ""})
    assert r.json()["preferred_scenario_id"] is None
    assert r.json()["status"] == "draft"  # the flag is not a decision and does not change status


def test_element_registered_from_alternative_object_resolves_geometry_and_keeps_unknown_depth(client):
    pid, sid = _project(client), _scenario(client)
    _link(client, pid, sid)
    oid = f"fly_{uuid.uuid4().hex[:6]}"
    r = client.post("/api/objects", json={"id": oid, "type": "flyover", "name": "SYNTHETIC flyover", "layerId": "flyovers", "scenarioId": sid,
                                          "coordinates": [[73.820, LAT, 6], [73.825, LAT, 6]], "properties": {"width": 12, "elevation": 6.5}})
    assert r.status_code == 201, r.text
    # what the UI sends for a flyover: z_min from the design elevation, z_max UNKNOWN (deck thickness not recorded)
    r = client.post(f"/api/coordination/projects/{pid}/elements", json={
        "kind": "flyover", "name": "SYNTHETIC flyover", "scenario_id": sid, "element_ref": oid, "width_m": 12,
        "z_min_m": 6.5, "z_max_m": None, "z_ref": "ground", "certainty": "hypothetical", "created_by": "Planner T"})
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["geometry"]["type"] == "LineString" and not e["own_geometry"]
    assert e["z_max_m"] is None and e["z_known"] == {"z_min": True, "z_max": False}
    # another project's scenario objects are not visible through element_ref
    other = _project(client, "SYNTHETIC other")
    r = client.post(f"/api/coordination/projects/{other}/elements", json={
        "kind": "flyover", "scenario_id": _scenario(client), "element_ref": oid, "created_by": "Planner T"})
    assert r.status_code == 422


def test_conflict_summary_csv_export_lists_findings_unknowns_and_is_audited(client):
    a, b = _project(client, "SYNTHETIC export A"), _project(client, "SYNTHETIC export B")
    ea = _el(client, a, "metro_tunnel", _line(73.840, LAT + 0.01, 73.846, LAT + 0.01), width_m=6, z_min_m=-18, z_max_m=-12)
    _el(client, b, "pipeline", _line(73.843, LAT + 0.009, 73.843, LAT + 0.011), width_m=1)  # depth UNKNOWN
    run = _detect(client, a)
    assert any(c["class"] == "potential_conflict" and c["element_a_id"] == ea["id"] for c in run["conflicts"])
    r = client.get(f"/api/coordination/projects/{a}/conflicts/export?format=csv&requested_by=Reporter%20T")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    text = r.content.decode()
    lines = text.splitlines()
    assert lines[0].startswith("# Coordination screening findings") and "Not an engineering assessment" in lines[0]
    rows = list(csv.DictReader(io.StringIO("\n".join(l for l in lines if not l.startswith("#")))))
    pot = [x for x in rows if x["class"] == "potential_conflict" and x["other_project"] == b]
    assert pot and pot[0]["vertical_gap_m"] == ""  # UNKNOWN stays empty, never 0
    assert pot[0]["run_stale"] in ("current", "stale", "UNKNOWN")
    # B sees the same issue in its own export (shared), and the export is recorded in A's audit
    rb = client.get(f"/api/coordination/projects/{b}/conflicts/export").content.decode()
    assert pot[0]["finding_id"] in rb
    ev = client.get(f"/api/planning/projects/{a}/audit").json()["events"]
    ex = [e for e in ev if e["action"] == "export" and e["label"] == "CSV conflict summary"]
    assert ex and ex[-1]["actor"] == "Reporter T" and ex[-1]["after_hash"].startswith("sha256:")


def test_migration_adds_preferred_column_to_an_existing_table(tmp_path):
    from database.migrations import migrate

    eng = sqlalchemy.create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with eng.begin() as c:
        c.exec_driver_sql("CREATE TABLE planning_projects (id VARCHAR PRIMARY KEY, name VARCHAR)")
        c.exec_driver_sql("INSERT INTO planning_projects VALUES ('p1', 'old')")
    done = migrate(eng)
    assert any("preferred_scenario_id" in s for s in done)
    assert migrate(eng) == []  # idempotent
    with eng.begin() as c:
        assert c.exec_driver_sql("SELECT id, name, preferred_scenario_id FROM planning_projects").fetchall() == [("p1", "old", None)]
