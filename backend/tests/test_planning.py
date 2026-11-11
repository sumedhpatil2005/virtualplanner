"""
Planning & Approval Workspace (docs/PLANNING_WORKSPACE.md): audit log, links, decisions, report, migration.
All data here is SYNTHETIC (fixtures from the feasibility and traffic-data tests).
"""
import base64
import io
import re
import shutil
import sqlite3
import uuid
import zipfile
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DatabaseError, IntegrityError

from database.connection import SessionLocal
from planning.models import AppendOnlyViolation, AuditLogEntity, PlanningDecisionEntity
from tests.test_feasibility import _create as _assessment
from tests.test_traffic_data import _dataset, _rec, _road


@pytest.fixture(autouse=True)
def _files_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("TWINCITY_FEAS_FILES", str(tmp_path / "feasibility_files"))


def _scenario(client, name="Proposal P (synthetic)"):
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    assert client.post("/api/scenarios", json={"id": sid, "name": name, "description": "synthetic", "year": 2030}).status_code == 201
    return sid


def _events(client, **params):
    return client.get("/api/planning/audit", params={"limit": 5000, **params}).json()


def _has(evts, etype, action, eid=None):
    return any(e["entity_type"] == etype and e["action"] == action and (eid is None or e["entity_id"] == eid) for e in evts)


def _project(client, **kw):
    r = client.post("/api/planning/projects", json={"name": "Synthetic corridor study", "description": "SYNTHETIC test", "created_by": "Planner A", **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_audit_written_for_each_entity_type(client):
    # scenario create / update / delete
    sid = _scenario(client)
    client.post("/api/scenarios", json={"id": sid, "name": "Renamed", "description": "synthetic", "year": 2030})
    ev = _events(client, entity_id=sid)
    assert _has(ev, "scenario", "create", sid) and _has(ev, "scenario", "update", sid)
    upd = next(e for e in ev if e["entity_type"] == "scenario" and e["action"] == "update")
    assert upd["changed_fields"] == ["name"] and upd["before_hash"] != upd["after_hash"] and upd["before_hash"].startswith("sha256:")
    # scenario change + version + run
    road = _road(client)
    client.post(f"/api/scenarios/{sid}/changes", json=[{"objectId": road, "op": "delete"}])
    v = client.post(f"/api/scenarios/{sid}/versions", json={"label": "v-syn", "assumptions": {"hour": 9}}).json()
    run = client.post("/api/runs", json={"scenarioId": sid, "inputs": {"hour": 9}, "results": {"totalVph": 100}}).json()
    ev = _events(client, entity_id=sid)
    assert _has(ev, "scenario_change", "create") and _has(ev, "scenario_version", "create", v["id"]) and _has(ev, "run", "create", run["id"])
    # dataset create / update / delete, records create / update / delete
    ds = _dataset(client)
    rec = client.post(f"/api/traffic-data/datasets/{ds['id']}/records", json={"entered_by": "Counter B", "records": [_rec(road), _rec(road, period_start="09:00", period_end="10:00")]})
    assert rec.status_code == 201, rec.text
    rid = rec.json()[0]["id"]
    client.patch(f"/api/traffic-data/datasets/{ds['id']}", json={"edited_by": "Editor C", "role": "calibration"})
    ev = _events(client, entity_id=ds["id"])
    assert _has(ev, "dataset", "create", ds["id"]) and _has(ev, "count_record", "create")
    upd = next(e for e in ev if e["entity_type"] == "dataset" and e["action"] == "update")
    assert upd["actor"] == "Editor C" and upd["actor_source"] == "td_audit"
    recs = [e for e in ev if e["entity_type"] == "count_record" and e["action"] == "create"]
    assert len(recs) == 2 and all(e["actor"] == "Counter B" for e in recs)
    if rid is not None:
        client.delete(f"/api/traffic-data/records/{rid}", params={"deleted_by": "Editor C"})
        assert _has(_events(client, entity_id=ds["id"]), "count_record", "delete", str(rid))
    # assessment, evidence, review, document
    aid = _assessment(client)
    evi = client.post(f"/api/feasibility/assessments/{aid}/evidence", json={"file_name": "bh.txt", "content_base64": base64.b64encode(b"synthetic").decode(),
                                                                         "description": "Synthetic log", "uploaded_by": "Uploader D", "provenance": "measured"}).json()
    rv = client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "Reviewer E", "reviewer_role": "Geotech", "status": "in_review"}).json()
    ev = _events(client, entity_id=aid)
    assert _has(ev, "assessment", "create", aid) and _has(ev, "evidence", "create", evi["id"]) and _has(ev, "review", "create", rv["id"])
    assert next(e for e in ev if e["entity_type"] == "review")["actor"] == "Reviewer E"
    # dataset delete removes its records: each is logged
    client.delete(f"/api/traffic-data/datasets/{ds['id']}", params={"deleted_by": "Editor C"})
    ev = _events(client, entity_id=ds["id"])
    dd = next(e for e in ev if e["entity_type"] == "dataset" and e["action"] == "delete")
    assert dd["actor"] == "Editor C" and dd["after_hash"] is None and dd["before_hash"]
    # scenario delete: its versions (bulk delete) and the scenario are logged
    client.delete(f"/api/scenarios/{sid}")
    ev = _events(client, entity_id=sid)
    assert _has(ev, "scenario", "delete", sid) and _has(ev, "scenario_version", "delete", v["id"]) and _has(ev, "scenario_change", "delete")


def test_x_actor_header_attributes_writes(client):
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    client.post("/api/scenarios", json={"id": sid, "name": "H", "description": "", "year": 2030}, headers={"X-Actor": "Header Person"})
    e = next(e for e in _events(client, entity_id=sid) if e["action"] == "create")
    assert e["actor"] == "Header Person" and e["actor_source"] == "header"
    sid2 = _scenario(client)
    e2 = next(e for e in _events(client, entity_id=sid2) if e["action"] == "create")
    assert e2["actor"] == "unattributed" and e2["actor_source"] == "none"


def test_audit_log_is_append_only(client):
    _scenario(client)
    with SessionLocal() as s:
        row = s.query(AuditLogEntity).order_by(AuditLogEntity.id.desc()).first()
        row.actor = "tampered"
        with pytest.raises(AppendOnlyViolation):
            s.commit()
        s.rollback()
        with pytest.raises(AppendOnlyViolation):
            s.delete(s.get(AuditLogEntity, row.id))
            s.commit()
        s.rollback()
        # bulk statements bypass the ORM: the database trigger refuses them
        with pytest.raises(DatabaseError):
            s.execute(text("UPDATE audit_log SET actor='x'"))
        s.rollback()
        with pytest.raises(DatabaseError):
            s.query(AuditLogEntity).delete()
        s.rollback()
    for verb in ("put", "patch", "delete"):
        assert getattr(client, verb)("/api/planning/audit").status_code == 405


def test_project_links_timeline_and_status(client):
    sid = _scenario(client)
    ds = _dataset(client)
    aid = _assessment(client)
    p = _project(client, bbox=[73.84, 18.50, 73.87, 18.53])
    assert p["status"] == "draft" and p["baseline_fingerprint"].startswith("sha256:") and p["baseline_changed_since_created"] is False
    for t, i in (("scenario", sid), ("dataset", ds["id"]), ("assessment", aid)):
        r = client.post(f"/api/planning/projects/{p['id']}/links", json={"entity_type": t, "entity_id": i, "added_by": "Planner A"})
        assert r.status_code == 201, r.text
    assert client.post(f"/api/planning/projects/{p['id']}/links", json={"entity_type": "dataset", "entity_id": ds["id"], "added_by": "x"}).status_code == 409
    assert client.post(f"/api/planning/projects/{p['id']}/links", json={"entity_type": "dataset", "entity_id": "nope", "added_by": "x"}).status_code == 422
    assert client.post(f"/api/planning/projects/{p['id']}/links", json={"entity_type": "approval", "entity_id": "x", "added_by": "x"}).status_code == 422
    got = client.get(f"/api/planning/projects/{p['id']}").json()
    assert {(l["entity_type"], l["entity_id"]) for l in got["links"]} == {("scenario", sid), ("dataset", ds["id"]), ("assessment", aid)}
    # later activity on a linked record appears in the project's timeline
    client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "Reviewer E", "reviewer_role": "Geotech", "status": "in_review"})
    client.post(f"/api/scenarios/{sid}/versions", json={"label": "frozen", "assumptions": {}})
    tl = client.get(f"/api/planning/projects/{p['id']}/audit").json()["events"]
    kinds = {(e["entity_type"], e["action"]) for e in tl}
    assert {("project", "create"), ("project_link", "create"), ("review", "create"), ("scenario_version", "create"), ("dataset", "create"), ("assessment", "create")} <= kinds
    # unrelated records stay out
    other = _scenario(client)
    assert not any(e["entity_id"] == other for e in client.get(f"/api/planning/projects/{p['id']}/audit").json()["events"])
    # status changes are audited with the editor; 'decision_recorded' cannot be set by PATCH
    assert client.patch(f"/api/planning/projects/{p['id']}", json={"edited_by": "Planner A", "status": "under_study"}).json()["status"] == "under_study"
    assert client.patch(f"/api/planning/projects/{p['id']}", json={"edited_by": "Planner A", "status": "decision_recorded"}).status_code == 422
    assert client.patch(f"/api/planning/projects/{p['id']}", json={"edited_by": "Planner A", "status": "approved"}).status_code == 422
    e = next(e for e in client.get(f"/api/planning/projects/{p['id']}/audit").json()["events"] if e["entity_type"] == "project" and e["action"] == "update")
    assert e["actor"] == "Planner A" and e["actor_source"] == "request_field" and e["changed_fields"] == ["status"]
    # unlink leaves the record itself untouched
    lid = next(l["id"] for l in got["links"] if l["entity_type"] == "dataset")
    assert client.delete(f"/api/planning/projects/{p['id']}/links/{lid}", params={"removed_by": "Planner A"}).status_code == 200
    assert client.get(f"/api/traffic-data/datasets/{ds['id']}").status_code == 200


def test_decision_is_not_an_approval(client):
    vocab = client.get("/api/planning/status-vocabulary").json()
    assert vocab["has_approved_status"] is False
    assert not any("approv" in s["value"] for s in vocab["project_statuses"])
    sid = _scenario(client)
    v = client.post(f"/api/scenarios/{sid}/versions", json={"label": "Option A", "assumptions": {"hour": 9}}).json()
    aid = _assessment(client)
    p = _project(client)
    pid = p["id"]
    # the version must belong to an attached scenario
    body = {"decision_text": "Proceed to detailed investigation of Option A (synthetic).", "decided_by": "Committee chair (synthetic)", "role": "Chair",
            "scenario_version_id": v["id"], "evidence_refs": [{"type": "assessment", "id": aid}]}
    assert client.post(f"/api/planning/projects/{pid}/decisions", json=body).status_code == 422
    client.post(f"/api/planning/projects/{pid}/links", json={"entity_type": "scenario", "entity_id": sid, "added_by": "Planner A"})
    assert client.post(f"/api/planning/projects/{pid}/decisions", json={**body, "evidence_refs": [{"type": "evidence", "id": "missing"}]}).status_code == 422
    d = client.post(f"/api/planning/projects/{pid}/decisions", json=body)
    assert d.status_code == 201, d.text
    d = d.json()
    assert d["is_statutory_approval"] is False and d["kind"] == "planning_decision_recorded_in_tool"
    assert "not a statutory approval" in d["kind_label"] and "recorded in this tool" in d["kind_label"].lower()
    assert d["scenario_id"] == sid
    got = client.get(f"/api/planning/projects/{pid}").json()
    assert got["status"] == "decision_recorded" and "not a statutory approval" in got["status_label"]
    # decisions are append-only; a second one supersedes the first by reference
    d2 = client.post(f"/api/planning/projects/{pid}/decisions", json={"decision_text": "Revised (synthetic).", "decided_by": "Chair"}).json()
    assert d2["seq"] == 2 and d2["supersedes"] == d["id"]
    with SessionLocal() as s:
        row = s.get(PlanningDecisionEntity, d["id"])
        row.decision_text = "edited"
        with pytest.raises(AppendOnlyViolation):
            s.commit()
        s.rollback()
        with pytest.raises(DatabaseError):
            s.execute(text("DELETE FROM planning_decisions"))
        s.rollback()
    ev = client.get(f"/api/planning/projects/{pid}/audit").json()["events"]
    assert _has(ev, "decision", "create", d["id"]) and next(e for e in ev if e["entity_id"] == d["id"])["actor"] == "Committee chair (synthetic)"


def _pdf_text(data: bytes) -> str:
    """Text of an fpdf2 PDF (uncompressed text operators are not guaranteed): use pdftotext when available."""
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(data)
    try:
        return subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, check=True).stdout
    except (FileNotFoundError, subprocess.CalledProcessError):
        pytest.skip("pdftotext not available")


def _docx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = "".join(z.read(n).decode() for n in z.namelist() if n.startswith("word/") and n.endswith(".xml"))
    return re.sub(r"<[^>]+>", " ", xml)


def _full_project(client):
    road = _road(client)
    sid = _scenario(client)
    client.post(f"/api/scenarios/{sid}/changes", json=[{"objectId": road, "op": "delete"}])
    v = client.post(f"/api/scenarios/{sid}/versions", json={"label": "Option A", "assumptions": {"hour": 9, "seeds": [42], "signalTiming": "webster"}}).json()
    client.post("/api/runs", json={"scenarioId": "base", "inputs": {"hour": 9, "seeds": [42]}, "results": {"totalVph": 1200, "meanDelayS": 40.5}})
    client.post("/api/runs", json={"scenarioId": sid, "scenarioVersionId": v["id"], "inputs": {"hour": 9, "seeds": [42]}, "results": {"totalVph": 1150, "meanDelayS": 35.0}})
    ds_m = _dataset(client, kind="measured", name="SYNTHETIC measured counts")
    ds_e = _dataset(client, kind="estimated", name="SYNTHETIC estimated counts", synthetic=False)
    client.post(f"/api/traffic-data/datasets/{ds_m['id']}/records", json={"entered_by": "Counter B", "records": [_rec(road)]})
    aid = _assessment(client)
    client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "Reviewer E", "reviewer_role": "Geotech", "status": "reviewed_not_approval"})
    p = _project(client)
    for t, i in (("scenario", sid), ("dataset", ds_m["id"]), ("dataset", ds_e["id"]), ("assessment", aid)):
        client.post(f"/api/planning/projects/{p['id']}/links", json={"entity_type": t, "entity_id": i, "added_by": "Planner A"})
    client.post(f"/api/planning/projects/{p['id']}/decisions", json={"decision_text": "Proceed to investigations (synthetic).", "decided_by": "Chair", "scenario_version_id": v["id"]})
    return p["id"]


def test_report_pdf_and_docx_carry_labels_and_disclaimer(client):
    pid = _full_project(client)
    r = client.get(f"/api/planning/projects/{pid}/report", params={"format": "docx", "requested_by": "Planner A"})
    assert r.status_code == 200 and r.headers["x-report-sha256"]
    t = _docx_text(r.content)
    for s in ("Not an engineering assessment, statutory approval", "NOT a statutory or any other approval", "Measured + SYNTHETIC", "Estimated",
              "model output", "FAIR comparison", "Verified from available data", "Unknown", "Reviewed \u2014 not an approval",
              "Planning decision recorded in this tool", "not a statutory approval", "Assumptions and unknowns", "Audit trail summary",
              "1,200", "1,150", "-50", "Option A"):
        assert s in t, s
    assert not re.search(r"\bapproved\b", t, re.I)
    ev = client.get(f"/api/planning/projects/{pid}/audit").json()["events"]
    assert _has(ev, "project_report", "export") and next(e for e in ev if e["entity_type"] == "project_report")["actor"] == "Planner A"
    p = client.get(f"/api/planning/projects/{pid}/report", params={"format": "pdf"})
    assert p.status_code == 200 and p.content[:5] == b"%PDF-"
    pt = re.sub(r"\s+", " ", _pdf_text(p.content))
    for s in ("Not an engineering assessment, statutory approval", "Measured + SYNTHETIC", "model output", "Planning decision recorded in", "11. Audit trail summary"):
        assert s in pt, s
    assert not re.search(r"\bapproved\b", pt, re.I)


def test_report_states_missing_items_as_unknown(client):
    p = _project(client)
    t = _docx_text(client.get(f"/api/planning/projects/{p['id']}/report", params={"format": "docx"}).content)
    for s in ("No traffic dataset is attached", "No comparison result is present", "No feasibility assessment is attached", "No decision has been recorded",
              "self-declared"):
        assert s in t, s


REAL_DB = Path("/workspace/work/virtualplanner/backend/twincity.db")


def _migrate(path):
    from database.connection import Base
    from database.migrations import migrate
    from planning.audit import install_triggers
    eng = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(bind=eng)
    migrate(eng)
    install_triggers(eng)
    eng.dispose()


@pytest.mark.skipif(not REAL_DB.exists(), reason="project database copy not available")
def test_migration_on_a_copy_of_the_project_database(tmp_path):
    path = tmp_path / "copy.db"
    shutil.copy(REAL_DB, path)  # never the original
    con = sqlite3.connect(path)
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    cols = {t: ", ".join(r[1] for r in con.execute(f"PRAGMA table_info({t})")) for t in tables}
    before = {t: con.execute(f"SELECT {cols[t]} FROM {t} ORDER BY 1").fetchall() for t in tables}
    con.close()
    _migrate(path)
    _migrate(path)  # idempotent
    con = sqlite3.connect(path)
    for t in tables:
        assert con.execute(f"SELECT {cols[t]} FROM {t} ORDER BY 1").fetchall() == before[t], t  # columns added by migrate() are nullable extras
    for t in ("planning_projects", "planning_project_links", "planning_decisions", "audit_log"):
        assert con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] == 0
    trig = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
    assert {"audit_log_no_update", "audit_log_no_delete", "planning_decisions_no_update", "planning_decisions_no_delete"} <= trig
    con.execute("INSERT INTO audit_log (at, actor, actor_source, action, entity_type, entity_id, label) VALUES ('2026-11-11','t','none','create','x','1','')")
    with pytest.raises(sqlite3.DatabaseError):
        con.execute("DELETE FROM audit_log")
    con.close()
