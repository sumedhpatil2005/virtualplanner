"""
Shared city model / coordination / subsurface (docs/urbanos/COORDINATION_AND_SUBSURFACE.md).
All geometry, depths and records here are SYNTHETIC (made up for tests; not Pune data).
"""
import hashlib
import os
import sqlite3
import uuid

import pytest

from tests.test_feasibility import _assessment

LAT = 18.53          # synthetic test corridor (inside the study area created below)
AREA = [73.79, 18.49, 73.87, 18.56]


def _db_path():
    return os.environ["DATABASE_URL"].replace("sqlite:///", "")


@pytest.fixture(autouse=True)
def _area(client):
    if not any(a["id"] == "coord_test_area" for a in client.get("/api/areas").json()):
        x0, y0, x1, y1 = AREA
        r = client.post("/api/areas", json={"id": "coord_test_area", "name": "SYNTHETIC coordination test area",
                                            "polygonCoordinates": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                                            "minLat": y0, "maxLat": y1, "minLon": x0, "maxLon": x1})
        assert r.status_code in (200, 201), r.text
        # one SYNTHETIC base road inside the area, away from the test corridors (the baseline needs content to cover anything)
        r = client.post("/api/objects", json={"id": "coord_base_road", "type": "road", "name": "SYNTHETIC base road", "layerId": "roads",
                                              "scenarioId": "base", "coordinates": [[73.860, 18.495, 0], [73.865, 18.495, 0]], "properties": {"width": 10}})
        assert r.status_code == 201, r.text


def _project(client, name="SYNTHETIC project"):
    r = client.post("/api/planning/projects", json={"name": name, "description": "SYNTHETIC", "created_by": "Planner T"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _line(x0, y0, x1, y1):
    return {"type": "LineString", "coordinates": [[x0, y0], [x1, y1]]}


def _el(client, pid, kind, geometry, **kw):
    body = {"kind": kind, "name": kw.pop("name", kind), "geometry": geometry, "created_by": "Planner T", **kw}
    r = client.post(f"/api/coordination/projects/{pid}/elements", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _detect(client, pid, **kw):
    r = client.post(f"/api/coordination/projects/{pid}/detect", json={"run_by": "Coordinator T", **kw})
    assert r.status_code == 201, r.text
    return r.json()


def _by(run, element_id, b_ref=None, b_type=None):
    return [c for c in run["conflicts"] if c["element_a_id"] == element_id and (b_ref is None or c["b_ref"] == b_ref)
            and (b_type is None or c["b_type"] == b_type)]


def _snapshot(tables):
    con = sqlite3.connect(_db_path())
    out = {}
    for t in tables:
        rows = con.execute(f"SELECT * FROM {t} ORDER BY 1").fetchall()
        out[t] = hashlib.sha256(repr(rows).encode()).hexdigest()
    con.close()
    return out


def _corridor(client):
    """Project A: an underground metro tunnel; project B: crossing works at several depths; project C: far away."""
    a, b, c = _project(client, "SYNTHETIC metro A"), _project(client, "SYNTHETIC utilities B"), _project(client, "SYNTHETIC far C")
    tunnel = _el(client, a, "metro_tunnel", _line(73.800, LAT, 73.810, LAT), width_m=6, z_min_m=-18, z_max_m=-12, certainty="estimated",
                 provenance="SYNTHETIC design depth")
    pipe = _el(client, b, "pipeline", _line(73.805, LAT - 0.001, 73.805, LAT + 0.001), width_m=1, z_min_m=-2.5, z_max_m=-1.5, certainty="estimated")
    drain = _el(client, b, "drainage", _line(73.803, LAT - 0.001, 73.803, LAT + 0.001), width_m=2, z_min_m=-14, z_max_m=-10, certainty="hypothetical")
    pier = _el(client, b, "pier", {"type": "Point", "coordinates": [73.808, LAT]}, width_m=2, z_max_m=0)  # foundation depth UNKNOWN
    far = _el(client, c, "road_widening", _line(73.800, LAT + 0.02, 73.810, LAT + 0.02), width_m=7, z_min_m=-1, z_max_m=0)
    return a, b, c, tunnel, pipe, drain, pier, far


def test_unknown_depth_is_null_not_zero(client):
    pid = _project(client)
    e = _el(client, pid, "utility", _line(73.80, 18.52, 73.801, 18.52))
    assert e["z_min_m"] is None and e["z_max_m"] is None and e["z_known"] == {"z_min": False, "z_max": False}
    assert e["certainty"] == "unknown" and e["width_m"] is None
    assert client.post(f"/api/coordination/projects/{pid}/elements", json={"kind": "road", "created_by": "x"}).status_code == 422
    assert client.post(f"/api/coordination/projects/{pid}/elements", json={"kind": "spaceship", "geometry": _line(73.8, 18.5, 73.81, 18.5), "created_by": "x"}).status_code == 422
    bad = client.post(f"/api/coordination/projects/{pid}/elements", json={"kind": "road", "geometry": _line(73.8, 18.5, 73.81, 18.5), "z_min_m": 1, "z_max_m": -1, "created_by": "x"})
    assert bad.status_code == 422


def test_each_conflict_class_and_both_projects_see_issues(client):
    a, b, c, tunnel, pipe, drain, pier, far = _corridor(client)
    run = _detect(client, a)
    t = tunnel["id"]
    drain_row = _by(run, t, drain["id"])[0]
    assert drain_row["class"] == "conflict" and drain_row["vertical_gap_m"] == 0 and drain_row["project_b_id"] == b
    pipe_row = _by(run, t, pipe["id"])[0]
    assert pipe_row["class"] == "vertically_separated" and pipe_row["vertical_gap_m"] == pytest.approx(9.5)
    assert any("required vertical clearance UNKNOWN" in r for r in pipe_row["reasons"])
    # the cited metro permission distance is reported as a trigger, never as an engineering clearance
    assert any(tr["rule_id"] == "metro_noc_20m" and "NOT an engineering clearance" in tr["note"] for tr in pipe_row["permission_triggers"])
    pier_row = _by(run, t, pier["id"])[0]
    assert pier_row["class"] == "potential_conflict" and pier_row["vertical_gap_m"] is None and pier_row["certainty"] == "unknown"
    assert any("depth UNKNOWN" in r for r in pier_row["reasons"])
    # far project: nothing within the screening radius -> "no conflict within available data" (not "clear")
    far_row = _by(run, t, f"project:{c}")[0]
    assert far_row["class"] == "no_conflict_within_available_data" and far_row["project_b_id"] == c
    # baseline roads: the corridor lies in the study area but has no base road -> no conflict within available data
    assert _by(run, t, "baseline_road")[0]["class"] == "no_conflict_within_available_data"
    # utility records: no imported dataset states coverage here -> UNKNOWN, never clear
    assert _by(run, t, "subsurface_utility")[0]["class"] == "unknown_no_coverage"
    # outside every data coverage -> unknown_no_coverage for the baseline too
    d = _project(client, "SYNTHETIC outside D")
    out = _el(client, d, "road", _line(74.40, 18.90, 74.41, 18.90), width_m=7, z_min_m=-1, z_max_m=0)
    run_d = _detect(client, d)
    assert _by(run_d, out["id"], "baseline_road")[0]["class"] == "unknown_no_coverage"
    # issues are visible to BOTH projects
    ib = client.get(f"/api/coordination/projects/{b}/conflicts").json()["issues"]
    assert any(i["id"] == drain_row["id"] and i["raised_by_project"] == a and i["other_project"] == a for i in ib)
    ia = client.get(f"/api/coordination/projects/{a}/conflicts").json()["issues"]
    assert ia[0]["class"] == "conflict"  # most severe first
    assert run["summary"]["counts"]["conflict"] >= 1


def test_width_unknown_cannot_be_excluded(client):
    a, b = _project(client), _project(client)
    t = _el(client, a, "tunnel", _line(73.820, LAT, 73.825, LAT), width_m=8, z_min_m=-20, z_max_m=-10)
    near = _el(client, b, "utility", _line(73.8225, LAT + 0.0001, 73.8226, LAT + 0.0002), z_min_m=-15, z_max_m=-14)  # width UNKNOWN, ~11 m away
    run = _detect(client, a)
    row = _by(run, t["id"], near["id"])[0]
    assert row["class"] == "potential_conflict" and any("footprint width UNKNOWN" in r for r in row["reasons"])


def test_user_engineering_clearance_turns_gap_into_conflict(client):
    a, b = _project(client), _project(client)
    t = _el(client, a, "tunnel", _line(73.830, LAT, 73.835, LAT), width_m=8, z_min_m=-20, z_max_m=-10)
    p = _el(client, b, "pipeline", _line(73.8325, LAT - 0.001, 73.8325, LAT + 0.001), width_m=1, z_min_m=-8, z_max_m=-7, clearance_m=3)
    row = _by(_detect(client, a), t["id"], p["id"])[0]
    assert row["class"] == "conflict" and row["vertical_gap_m"] == pytest.approx(2.0)
    assert any("< required 3.00 m" in r for r in row["reasons"])


def test_detection_never_mutates_projects(client):
    a, b, c, tunnel, *_ = _corridor(client)
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    client.post("/api/scenarios", json={"id": sid, "name": "SYNTHETIC proposal", "description": "", "year": 2030})
    client.post("/api/objects", json={"id": f"own_{sid}", "type": "road", "name": "own road", "layerId": "roads", "scenarioId": sid,
                                      "coordinates": [[73.806, LAT - 0.002, 0], [73.806, LAT + 0.002, 0]], "properties": {"width": 12}})
    v = client.post(f"/api/scenarios/{sid}/versions", json={"label": "v1"}).json()
    ref = _el(client, b, "road", None, element_ref=f"own_{sid}", scenario_version_id=v["id"], z_min_m=-1.5, z_max_m=0)
    assert ref["width_m"] == 12 and ref["geometry"]["type"] == "LineString" and ref["scenario_id"] == sid
    tables = ["planning_projects", "planning_project_links", "scenarios", "scenario_object_changes", "scenario_versions",
              "scenario_version_changes", "city_objects", "project_proposal_elements", "clearance_rules", "subsurface_records"]
    before = _snapshot(tables)
    r1, r2 = _detect(client, a), _detect(client, b)
    assert _snapshot(tables) == before
    assert any(x["b_ref"] == ref["id"] for x in r1["conflicts"])
    # acknowledging a finding changes only the finding's status (audited), never a project
    cid = next(x["id"] for x in r1["conflicts"] if x["class"] == "conflict")
    s = client.patch(f"/api/coordination/conflicts/{cid}/status", json={"status": "acknowledged", "actor": "Engineer B", "note": "SYNTHETIC: diversion under study"})
    assert s.status_code == 200 and s.json()["status"] == "acknowledged"
    assert _snapshot(tables) == before
    ev = client.get("/api/planning/audit", params={"entity_type": "coordination_conflict", "entity_id": cid}).json()
    assert any(e["action"] == "update" and e["actor"] == "Engineer B" for e in ev)
    # a re-run carries the acknowledgement forward for the same pair and class
    r3 = _detect(client, a)
    again = next(x for x in r3["conflicts"] if x["class"] == "conflict" and x["element_a_id"] == tunnel["id"])
    assert again["status"] == "acknowledged" and again["status_carried_from"] == cid
    assert client.patch(f"/api/coordination/conflicts/{cid}/status", json={"status": "approved", "actor": "x", "note": "y"}).status_code == 422


def test_stale_after_version_change_and_other_inputs(client):
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    client.post("/api/scenarios", json={"id": sid, "name": "SYNTHETIC stale", "description": "", "year": 2030})
    client.post("/api/objects", json={"id": f"o_{sid}", "type": "road", "name": "r", "layerId": "roads", "scenarioId": sid,
                                      "coordinates": [[73.84, LAT, 0], [73.845, LAT, 0]], "properties": {"width": 10}})
    v1 = client.post(f"/api/scenarios/{sid}/versions", json={"label": "v1"}).json()
    a, b = _project(client), _project(client)
    client.post(f"/api/planning/projects/{a}/links", json={"entity_type": "scenario", "entity_id": sid, "added_by": "Planner T"})
    _el(client, a, "road", None, element_ref=f"o_{sid}", scenario_version_id=v1["id"], z_min_m=-1, z_max_m=0)
    eb = _el(client, b, "utility", _line(73.842, LAT - 0.001, 73.842, LAT + 0.001), width_m=1, z_min_m=-3, z_max_m=-2)
    run = client.post("/api/runs", json={"scenarioId": sid, "scenarioVersionId": v1["id"], "inputs": {"hour": 9}, "results": {"odme": {"iterations": 3}}}).json()
    fs = client.post("/api/feasibility/assessments", json={"scenario_id": sid, "scenario_version": v1["id"], "proposal_object_ids": [f"o_{sid}"], "assessment": _assessment()})
    assert fs.status_code == 201, fs.text
    fs_nov = client.post("/api/feasibility/assessments", json={"scenario_id": sid, "proposal_object_ids": [f"o_{sid}"], "assessment": _assessment()}).json()["id"]
    client.post(f"/api/planning/projects/{a}/links", json={"entity_type": "assessment", "entity_id": fs.json()["id"], "added_by": "Planner T"})
    cr = _detect(client, a)
    assert cr["stale"]["stale"] is False and cr["stale"]["reasons"] == []
    assert client.get(f"/api/coordination/stale/run/{run['id']}").json()["stale"] is False
    st = client.get(f"/api/coordination/stale/run/{run['id']}").json()
    assert st["run_kind"] == "simulation+odme"
    assert client.get(f"/api/coordination/stale/assessment/{fs.json()['id']}").json()["stale"] is False
    nov = client.get(f"/api/coordination/stale/assessment/{fs_nov}").json()
    assert nov["stale"] is None and "UNKNOWN" in nov["label"]
    # a new version of the scenario
    client.post(f"/api/scenarios/{sid}/versions", json={"label": "v2"})
    s = client.get(f"/api/coordination/stale/coordination_run/{cr['id']}").json()
    assert s["stale"] is True and f"scenario_version_superseded:{sid}" in s["reasons"]
    assert "newer_scenario_version" in client.get(f"/api/coordination/stale/run/{run['id']}").json()["reasons"]
    assert "newer_scenario_version" in client.get(f"/api/coordination/stale/assessment/{fs.json()['id']}").json()["reasons"]
    # the other project changes -> cross-project staleness
    client.patch(f"/api/coordination/elements/{eb['id']}", json={"edited_by": "Engineer B", "z_min_m": -6})
    s = client.get(f"/api/coordination/stale/coordination_run/{cr['id']}").json()
    assert f"other_project_changed:{b}" in s["reasons"]
    # a user rule changes the rule set
    client.post("/api/coordination/clearance-rules", json={"label": "SYNTHETIC user rule", "rule_type": "engineering_clearance",
                                                         "other_kind": "spaceship", "horizontal_m": 1, "created_by": "Engineer B"})
    assert "clearance_rules_changed" in client.get(f"/api/coordination/stale/coordination_run/{cr['id']}").json()["reasons"]
    ps = client.get(f"/api/coordination/projects/{a}/stale").json()
    assert ps["runs"] and ps["runs"][0]["stale"] is True and ps["assessments"][0]["stale"] is True and ps["coordination_runs"][0]["stale"] is True
    # old results stay readable
    assert client.get(f"/api/coordination/runs/{cr['id']}").json()["conflicts"]


AGS = '''"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","SYN-1","SYNTHETIC test investigation"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_NATE","LOCA_NATN","LOCA_GREF","LOCA_GL","LOCA_FDEP"
"UNIT","","","m","m","","m","m"
"TYPE","ID","PA","2DP","2DP","PA","2DP","2DP"
"DATA","BH01","CP","378613.25","2049210.00","EPSG:32643","560.10","15.00"
"DATA","BH02","CP","","","","561.00","8.50"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_LEG"
"UNIT","","m","m","",""
"TYPE","ID","2DP","2DP","X","PA"
"DATA","BH01","0.00","2.40","SYNTHETIC brown silty clay","CL"
"DATA","BH01","2.40","15.00","SYNTHETIC weathered basalt","BA"

"GROUP","ISPT"
"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL"
"UNIT","","m",""
"TYPE","ID","2DP","0DP"
"DATA","BH01","1.50","12"

"GROUP","SAMP"
"HEADING","LOCA_ID","SAMP_TOP"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","1.00"
'''


def test_ags4_and_csv_import_with_provenance(client):
    r = client.post("/api/coordination/subsurface/import", json={
        "record_type": "borehole", "format": "ags4", "content": AGS, "name": "SYNTHETIC AGS4", "file_name": "syn.ags",
        "publisher": "SYNTHETIC consultant", "licence": "test-only", "data_date": "2026-10-01", "imported_by": "Geotech T"})
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["file_sha256"] == "sha256:" + hashlib.sha256(AGS.encode()).hexdigest()
    assert d["licence"] == "test-only" and d["publisher"] == "SYNTHETIC consultant" and d["data_date"] == "2026-10-01"
    assert d["record_count"] == 2 and d["meta"]["groups_used"] == ["GEOL", "ISPT", "LOCA", "PROJ"]
    assert any("SAMP" in w for w in d["warnings"]) and any("BH02" in w and "UNKNOWN" in w for w in d["warnings"])
    bh1 = next(x for x in d["records"] if x["external_id"] == "BH01")
    lon, lat = bh1["geometry"]["coordinates"]
    assert lon == pytest.approx(73.85, abs=1e-4) and lat == pytest.approx(18.53, abs=1e-3)
    assert len(bh1["strata"]) == 2 and bh1["strata"][1]["description"] == "SYNTHETIC weathered basalt" and bh1["spt"][0]["n"] == 12
    assert bh1["z_min_m"] == -15 and bh1["ground_level_m"] == 560.10
    bh2 = next(x for x in d["records"] if x["external_id"] == "BH02")
    assert bh2["geometry"] is None and "UNKNOWN" in bh2["location_note"]
    ev = client.get("/api/planning/audit", params={"entity_id": d["id"]}).json()
    assert any(e["entity_type"] == "subsurface_dataset" and e["action"] == "create" and e["actor"] == "Geotech T" for e in ev)
    assert sum(1 for e in ev if e["entity_type"] == "subsurface_record") == 2
    # borehole CSV template
    csv_bh = "borehole_id,lon,lat,ground_level_m,final_depth_m,stratum_top_m,stratum_base_m,description,water_strike_m\n" \
             "C1,73.851,18.531,559,10,0,3,SYNTHETIC fill,\nC1,73.851,18.531,559,10,3,10,SYNTHETIC basalt,4.2\n"
    c = client.post("/api/coordination/subsurface/import", json={"record_type": "borehole", "format": "csv", "content": csv_bh,
                                                                  "name": "SYNTHETIC CSV", "imported_by": "Geotech T"}).json()
    assert c["record_count"] == 1 and c["licence"] == "UNKNOWN" and len(c["records"][0]["strata"]) == 2 and c["records"][0]["water_strikes"] == [4.2]
    assert client.post("/api/coordination/subsurface/import", json={"record_type": "borehole", "format": "ags4", "content": "nonsense",
                                                                     "name": "x", "imported_by": "x"}).status_code == 422


def test_utility_quality_levels_and_detection_against_records(client):
    csv_u = ("utility_id,utility_type,owner,geometry,depth_m,diameter_m,quality_level,survey_method\n"
             "U1,water,SYNTHETIC owner,73.8505 18.5395;73.8505 18.5405,1.2,0.6,QL-A,trial_pit\n"
             "U2,sewer,,73.8515 18.5395;73.8515 18.5405,2.0,,QL-D,record\n"
             "U3,telecom,,73.8525 18.5395;73.8525 18.5405,,,,\n")
    r = client.post("/api/coordination/subsurface/import", json={"record_type": "utility", "format": "csv", "content": csv_u,
                                                                  "name": "SYNTHETIC utility records", "coverage_bbox": [73.849, 18.538, 73.854, 18.542],
                                                                  "imported_by": "Utility T"})
    assert r.status_code == 201, r.text
    recs = {x["external_id"]: x for x in r.json()["records"]}
    assert recs["U1"]["z_certainty"] == "measured" and recs["U1"]["z_max_m"] == -1.2 and recs["U1"]["z_min_m"] == pytest.approx(-1.8)
    assert recs["U2"]["z_certainty"] == "estimated" and recs["U2"]["z_min_m"] is None
    assert recs["U3"]["z_certainty"] == "unknown" and recs["U3"]["quality_level"] == "UNKNOWN"
    p = _project(client)
    road = _el(client, p, "road_widening", _line(73.8500, 18.5400, 73.8530, 18.5400), width_m=8, z_min_m=-1.5, z_max_m=0, certainty="estimated")
    run = _detect(client, p)
    got = {c["b_ref"]: c for c in _by(run, road["id"], b_type="subsurface_utility")}
    assert got[recs["U1"]["id"]]["class"] == "conflict"
    assert got[recs["U2"]["id"]]["class"] == "vertically_separated"  # 2.0 m top below a 1.5 m excavation
    assert got[recs["U3"]["id"]]["class"] == "potential_conflict"     # depth UNKNOWN
    far = _el(client, p, "road", _line(73.8600, 18.5500, 73.8610, 18.5500), width_m=7, z_min_m=-1, z_max_m=0)
    run2 = _detect(client, p)
    assert _by(run2, far["id"], "subsurface_utility")[0]["class"] == "unknown_no_coverage"
    assert "subsurface_data_changed" not in client.get(f"/api/coordination/stale/coordination_run/{run2['id']}").json()["reasons"]


def test_environment_catalogue_status(client):
    layers = {l["id"]: l for l in client.get("/api/coordination/environment-layers").json()["layers"]}
    for lid in ("flood_lines", "groundwater_levels", "soil", "geology", "air_quality", "noise", "land_surface_temperature", "drainage_network"):
        assert layers[lid]["status"] == "not_imported" and layers[lid]["status_label"] == "Not imported — UNKNOWN"
    assert layers["flood_lines"]["recommended_sources"][0]["url"].startswith("https://wrd.maharashtra.gov.in")
    assert "metadata only" in layers["flood_lines"]["recommended_sources"][0]["status"]
    assert layers["osm_metro"]["status_source"] == "computed_on_read"
    assert {l["domain"] for l in layers.values()} >= {"flood", "groundwater", "soil", "geology", "air", "noise", "heat", "vegetation", "water", "heritage"}


def test_rule_defaults_are_cited_permission_distances_only(client):
    data = client.get("/api/coordination/clearance-rules").json()
    seeded = {r["id"]: r for r in data["rules"] if r["created_by"] == "system (seed)"}
    assert set(seeded) == {"metro_noc_20m", "amasr_prohibited_100m", "amasr_regulated_300m"}
    assert [seeded[k]["horizontal_m"] for k in ("metro_noc_20m", "amasr_prohibited_100m", "amasr_regulated_300m")] == [20, 100, 300]
    for r in seeded.values():
        assert r["rule_type"] == "permission_distance" and r["basis"] == "cited_permission_distance" and not r["is_engineering_clearance"]
        assert "NOT an engineering clearance" in r["basis_label"] and "NOT AN ENGINEERING CLEARANCE" in r["note"]
        assert "https://" in r["citation"] and r["vertical_m"] is None and r["vertical_label"] == "UNKNOWN (not set)"
    assert not any(r["rule_type"] == "engineering_clearance" and r["created_by"] == "system (seed)" for r in data["rules"])
    assert "UNKNOWN" in data["engineering_clearances_note"]
    ev = client.get("/api/planning/audit", params={"entity_type": "clearance_rule", "entity_id": "metro_noc_20m"}).json()
    assert any(e["action"] == "create" and e["actor"] == "system (seed)" for e in ev)
    # changing a cited value makes it a user value (and is audited) — runs last in this file: it edits a seeded row
    p = client.patch("/api/coordination/clearance-rules/amasr_regulated_300m", json={"edited_by": "Planner T", "horizontal_m": 350}).json()
    assert p["basis"] == "user_entered" and "no longer the cited" in p["note"]
    ev = client.get("/api/planning/audit", params={"entity_type": "clearance_rule", "entity_id": "amasr_regulated_300m"}).json()
    assert any(e["action"] == "update" and e["actor"] == "Planner T" for e in ev)
    client.patch("/api/coordination/clearance-rules/amasr_regulated_300m", json={"edited_by": "Planner T", "horizontal_m": 300})


def test_proposals_checked_against_baseline_roads(client):
    p = _project(client)
    fly = _el(client, p, "flyover", _line(73.8625, 18.4940, 73.8625, 18.4960), width_m=12, z_min_m=6.5, z_max_m=8.0, certainty="hypothetical")
    tun = _el(client, p, "metro_tunnel", _line(73.8630, 18.4940, 73.8630, 18.4960), width_m=8, z_min_m=-20, z_max_m=-12)
    run = _detect(client, p)
    f = _by(run, fly["id"], "coord_base_road")[0]
    assert f["b_type"] == "baseline_road" and f["class"] == "vertically_separated" and f["vertical_gap_m"] == pytest.approx(6.5)
    t = _by(run, tun["id"], "coord_base_road")[0]
    # base road structure depth is not recorded -> UNKNOWN, so a tunnel under it cannot be cleared
    assert t["class"] == "potential_conflict" and t["evidence"]["b"]["z_min_m"] is None and t["evidence"]["b"]["z_max_m"] == 0
    # an existing road is not a work: the metro NOC distance (directional) does not fire for it
    assert t["permission_triggers"] == []


def test_osm_metro_baseline_when_index_present(client):
    from osm.index import OsmIndex
    st = OsmIndex().status()
    if not st.get("available") or "metro" not in st.get("capabilities", []):
        pytest.skip("no local OSM index with metro (TWINCITY_OSM_INDEX)")
    p = _project(client)
    # SYNTHETIC excavation across central Pune; whatever OSM metro is near it has UNKNOWN depth
    e = _el(client, p, "excavation", _line(73.84, 18.50, 73.88, 18.54), width_m=10, z_min_m=-6, z_max_m=0)
    rows = _by(_detect(client, p), e["id"], b_type="osm_metro")
    assert rows and all(r["class"] in ("potential_conflict", "no_conflict_within_available_data") for r in rows)
    assert all(r["evidence"]["b"]["z_min_m"] is None for r in rows)
