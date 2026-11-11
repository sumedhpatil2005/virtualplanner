"""
Feasibility storage, documents and review history (docs/FEASIBILITY_ENGINE.md).
Assessment payloads here are SYNTHETIC fixtures shaped like the frontend
engine's output; the engine's own logic is unit-tested in vitest.
"""

import base64
import io
import json
import zipfile

import pytest

from feasibility import docgen
from feasibility.models import AppendOnlyViolation, ReviewRecordEntity


@pytest.fixture(autouse=True)
def _files_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("TWINCITY_FEAS_FILES", str(tmp_path / "feasibility_files"))


def _assessment(ptype="tunnel", level="underground", investigations=None, findings=None):
    investigations = investigations or [
        {"id": "geotechnical_investigation", "name": "Subsurface (geotechnical) investigation", "methods": ["Boreholes with SPT"], "deliverables": ["Factual geotechnical report"],
         "disciplines": ["Geotechnical engineer"], "standards": ["IS 1892:2021 to identify and verify"], "authorities": ["Project owner's engineer"],
         "triggeredBy": ["R03", "R14"], "sourceRefs": ["S16"], "certainty": "requires_field_investigation", "firedOnMissingData": False},
        {"id": "tunnel_engineering_studies", "name": "Tunnel engineering studies", "methods": ["Ventilation and fire-life-safety concept"], "deliverables": ["Fire and life safety strategy"],
         "disciplines": ["Tunnel engineer"], "standards": ["IRC:SP:91-2019 Guidelines for Road Tunnels to identify and verify"], "authorities": ["Fire brigade to identify and verify"],
         "triggeredBy": ["R03"], "sourceRefs": ["S18"], "certainty": "requires_field_investigation", "firedOnMissingData": False},
    ]
    return {
        "engineVersion": "synthetic-fixture", "assessedAt": "2026-11-11T10:00:00Z", "verdict": "screening_only", "lengthM": 420,
        "centroid": [73.8553, 18.5196], "disclaimer": "x",
        "proposal": {"name": f"Synthetic {ptype}", "scenarioId": "base", "objectIds": ["obj-1"], "proposalType": ptype, "level": level,
                     "line": [[73.853, 18.519], [73.857, 18.520]], "widthM": 12, "excavationDepthM": None},
        "siteAttributes": {
            "buildingsInInfluenceZone": {"value": 14, "certainty": "verified_from_available_data", "source": "OSM building=*"},
            "withinBlueLine": {"value": "unknown", "certainty": "unknown", "source": "WRD flood-line layer not imported"},
        },
        "findings": findings if findings is not None else [
            {"id": "F01", "topic": "buildings", "kind": "constraint", "statement": "14 mapped building(s) within 36 m", "certainty": "verified_from_available_data", "source": "OSM building=*"},
            {"id": "F02", "topic": "flood", "kind": "gap", "statement": "Blue/red flood-line status is unknown", "certainty": "unknown", "source": "WRD (not imported)"},
        ],
        "plan": {"rulesVersion": "investigationRules v1", "investigations": investigations,
                 "flags": [{"ruleId": "R03", "severity": "critical", "text": "Underground conditions are unknown until investigated.", "onMissingData": False}],
                 "dataGaps": [{"ruleId": "R09", "title": "Inside blue flood line", "attrs": ["withinBlueLine"]}],
                 "disciplines": sorted({d for i in investigations for d in i["disciplines"]}),
                 "standards": [s for i in investigations for s in i["standards"]], "authorities": [s for i in investigations for s in i["authorities"]],
                 "sources": [{"id": "S16", "title": "GSI", "url": "https://example.org/gsi", "evidence": "READ"}],
                 "thresholdsUsed": [{"key": "influenceZoneM", "value": 30, "unit": "m", "basis": "hypothetical", "note": "screening"}]},
        "layers": {},
    }


def _create(client, **kw):
    r = client.post("/api/feasibility/assessments", json={"scenario_id": "base", "proposal_object_ids": ["obj-1"], "assessment": _assessment(**kw)})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_assessment_must_be_screening_only(client):
    bad = _assessment()
    bad["verdict"] = "feasible"
    r = client.post("/api/feasibility/assessments", json={"scenario_id": "base", "proposal_object_ids": ["o"], "assessment": bad})
    assert r.status_code == 422


def test_assessment_roundtrip_and_filter(client):
    aid = _create(client)
    got = client.get(f"/api/feasibility/assessments/{aid}").json()
    assert got["proposal_type"] == "tunnel" and got["assessment"]["verdict"] == "screening_only"
    assert len(got["assessment_sha256"]) == 64
    assert any(a["id"] == aid for a in client.get("/api/feasibility/assessments", params={"object_id": "obj-1"}).json())


def _docx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("word/document.xml").decode() + "".join(z.read(n).decode() for n in z.namelist() if n.startswith("word/header") or n.startswith("word/footer"))
    import re
    return re.sub(r"<[^>]+>", "", xml)


def _pdf_text(data: bytes) -> str:
    # fpdf2 compresses content streams; read text back with its own parser-free approach: decompress streams.
    import re
    import zlib
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        try:
            out.append(zlib.decompress(m.group(1)).decode("latin-1"))
        except zlib.error:
            pass
    return "\n".join(out)


@pytest.mark.parametrize("fmt", ["pdf", "docx"])
def test_document_generation_both_formats(client, fmt):
    aid = _create(client)
    r = client.post(f"/api/feasibility/assessments/{aid}/documents", json={"format": fmt, "project_name": "Test tunnel"})
    assert r.status_code == 201, r.text
    doc = r.json()
    dl = client.get(doc["download_url"])
    assert dl.status_code == 200 and len(dl.content) == doc["size_bytes"] > 1000
    if fmt == "pdf":
        assert dl.content.startswith(b"%PDF")
    else:
        assert dl.content[:2] == b"PK"
        text = _docx_text(dl.content)
        for i, t in enumerate(docgen.SECTION_TITLES, 1):
            assert f"{i}. {t}" in text, t
        assert "NOT a statutory or any other approval" in text
        assert docgen.HEADER_TEXT in text  # header/footer


def test_document_model_has_18_sections_disclaimer_and_blank_space():
    m = docgen.build_model(_assessment(), {"id": "a1", "scenario_id": "base", "proposal_object_ids": ["obj-1"]}, {}, [], [])
    assert [s.num for s in m.sections] == list(range(1, 19))
    assert [s.title for s in m.sections] == docgen.SECTION_TITLES
    assert any(b.kind == "blank" for b in m.sections[15].blocks)  # §16 space for findings
    assert "to identify and verify" in m.sections[13].title
    # missing user inputs are stated as missing, never invented
    assert m.sections[6].blocks[0].text.startswith("None attached")
    assert m.sections[5].blocks[0].text.startswith("Unknown")
    # §15 never empty and carries the data gaps
    risks = m.sections[14].blocks[0].items
    assert any("Data gap" in r for r in risks) and any("CRITICAL" in r for r in risks)
    # findings keep their certainty labels
    rows = m.sections[8].blocks[1].rows
    assert ["F02", "Blue/red flood-line status is unknown", "Unknown", "WRD (not imported)"] in rows


def test_pdf_contains_all_sections_text():
    m = docgen.build_model(_assessment(), {"id": "a1", "scenario_id": "base", "proposal_object_ids": ["obj-1"]}, {}, [], [])
    data = docgen.render_pdf(m)
    assert data.startswith(b"%PDF")
    # With an embedded TTF font, text is glyph-encoded; check structure via page count and size instead,
    # and via the core-font fallback path for readable text.
    import feasibility.docgen as dg
    orig = dg._find_font
    dg._find_font = lambda: None
    try:
        txt = _pdf_text(dg.render_pdf(m))
    finally:
        dg._find_font = orig
    flat = txt.replace(") Tj", "").replace("(", "")
    for i, t in enumerate(docgen.SECTION_TITLES, 1):
        assert f"{i}. {t.split()[0]}" in flat, t
    assert "Not an engineering assessment or statutory approval" in flat


def test_document_vocabulary_never_claims_approval_or_feasibility():
    m = docgen.build_model(_assessment(), {"id": "a1", "scenario_id": "base", "proposal_object_ids": ["obj-1"]}, {},
                           [{"seq": 1, "created_at": "2026-11-11", "reviewer_name": "A", "reviewer_role": "Geotech", "organisation": "", "item_type": "assessment",
                             "item_id": None, "status": "reviewed_not_approval", "evidence_ids": [], "notes": "", "external_reference": None}], [])
    text = json.dumps([[b.__dict__ for b in s.blocks] for s in m.sections]).lower()
    for bad in ("approved", "is feasible", "proposal is safe", "certified safe", "land is available"):
        assert bad not in text, bad


def test_proposal_specific_documents_differ():
    tunnel = docgen.build_model(_assessment(), {"id": "t"}, {}, [], [])
    fly = docgen.build_model(_assessment("flyover", "elevated", investigations=[
        {"id": "structure_design_basis", "name": "Structure design basis (bridge/grade separator)", "methods": ["Span arrangement"], "deliverables": ["Design basis report"],
         "disciplines": ["Bridge/structural engineer"], "standards": ["IRC:SP:90-2023"], "authorities": ["Owner's proof consultant"], "triggeredBy": ["R20"], "sourceRefs": [],
         "certainty": "requires_field_investigation", "firedOnMissingData": False}]), {"id": "f"}, {}, [], [])
    t10 = [r[0] for r in tunnel.sections[9].blocks[1].rows]
    f10 = [r[0] for r in fly.sections[9].blocks[1].rows]
    assert "Tunnel engineering studies" in t10 and "Tunnel engineering studies" not in f10
    assert "Structure design basis (bridge/grade separator)" in f10


def test_evidence_upload_hash_and_validation(client):
    aid = _create(client)
    payload = b"borehole log BH-1 (synthetic)"
    r = client.post(f"/api/feasibility/assessments/{aid}/evidence", json={
        "file_name": "bh1.txt", "content_base64": base64.b64encode(payload).decode(), "description": "Synthetic borehole log",
        "uploaded_by": "Tester", "investigation_id": "geotechnical_investigation", "provenance": "measured"})
    assert r.status_code == 201, r.text
    import hashlib
    assert r.json()["file_sha256"] == hashlib.sha256(payload).hexdigest()
    assert client.get(f"/api/feasibility/evidence/{r.json()['id']}/download").content == payload
    bad = client.post(f"/api/feasibility/assessments/{aid}/evidence", json={
        "file_name": "x.txt", "content_base64": base64.b64encode(b"x").decode(), "description": "wrong item", "uploaded_by": "T", "investigation_id": "railway_interface"})
    assert bad.status_code == 400
    nodesc = client.post(f"/api/feasibility/assessments/{aid}/evidence", json={
        "file_name": "x.txt", "content_base64": base64.b64encode(b"x").decode(), "description": "", "uploaded_by": "T"})
    assert nodesc.status_code == 422


def test_reviews_append_only_and_never_approval(client):
    aid = _create(client)
    ev = client.post(f"/api/feasibility/assessments/{aid}/evidence", json={
        "file_name": "r.pdf", "content_base64": base64.b64encode(b"%PDF-synthetic").decode(), "description": "Synthetic report", "uploaded_by": "T"}).json()
    r1 = client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "R. Kulkarni", "reviewer_role": "Geotechnical engineer",
                                                                       "status": "in_review", "evidence_ids": [ev["id"]], "notes": "started"})
    assert r1.status_code == 201
    r2 = client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "R. Kulkarni", "reviewer_role": "Geotechnical engineer",
                                                                       "status": "reviewed_not_approval", "supersedes": r1.json()["id"]})
    assert r2.status_code == 201
    # there is no 'approved' status
    assert client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "X", "reviewer_role": "Y", "status": "approved"}).status_code == 422
    # external approval needs a reference and is marked unverified
    assert client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "X", "reviewer_role": "Y", "status": "external_approval_recorded_unverified"}).status_code == 422
    r3 = client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "X", "reviewer_role": "Y", "status": "external_approval_recorded_unverified",
                                                                       "external_reference": "MahaMetro NOC ref ABC/123 dated 2026-11-01 (synthetic)"})
    assert r3.status_code == 201 and r3.json()["external_reference_verified"] is False
    # unknown evidence rejected
    assert client.post(f"/api/feasibility/assessments/{aid}/reviews", json={"reviewer_name": "X", "reviewer_role": "Y", "status": "in_review", "evidence_ids": ["nope"]}).status_code == 400
    lst = client.get(f"/api/feasibility/assessments/{aid}/reviews").json()
    assert [r["seq"] for r in lst["reviews"]] == [1, 2, 3]
    assert all(r["is_approval"] is False for r in lst["reviews"])
    assert lst["reviews"][0]["status"] == "in_review"  # first record unchanged after superseding
    # no update/delete routes
    rid = r1.json()["id"]
    for m in ("put", "patch", "delete"):
        assert getattr(client, m)(f"/api/feasibility/assessments/{aid}/reviews/{rid}").status_code in (404, 405)
    # and the ORM itself refuses
    from database.connection import SessionLocal
    with SessionLocal() as s:
        rec = s.get(ReviewRecordEntity, rid)
        rec.notes = "tampered"
        with pytest.raises(AppendOnlyViolation):
            s.commit()
        s.rollback()
        with pytest.raises(AppendOnlyViolation):
            s.delete(s.get(ReviewRecordEntity, rid))
            s.commit()
    # reviews show up in the document's sections 17/18
    doc = client.post(f"/api/feasibility/assessments/{aid}/documents", json={"format": "docx"}).json()
    text = _docx_text(client.get(doc["download_url"]).content)
    assert "R. Kulkarni" in text and "Reviewed — not an approval" in text and "unverified" in text


def test_site_data_reports_missing_layers_as_unavailable(client, monkeypatch):
    from api import feasibility_router as fr
    monkeypatch.setattr(fr.layers, "path", "/nonexistent/layers.db")
    r = client.get("/api/feasibility/site-data", params={"bbox": "73.85,18.51,73.86,18.52"})
    assert r.status_code == 200
    L = r.json()["layers"]
    for k in ("water", "heritage", "trees", "railway"):
        assert L[k]["available"] is False and "reason" in L[k]


def test_pdf_renders_long_real_world_tables():
    """Regression (browser run 2026-11-11): a long finding next to a short id column made fpdf2 fail."""
    long = "Alignment overlaps or touches 23 mapped road way(s): " + "; ".join(f"Road {i} width=12 lanes=4" for i in range(12))
    findings = [{"id": f"F{i:02d}", "topic": "existing_roads", "kind": "context", "statement": long, "certainty": "verified_from_available_data", "source": "OSM highway=* (western-zone-latest.osm.pbf, data Mon 2026-11-02 2:51 AM IST)"} for i in range(1, 20)]
    a = _assessment(findings=findings)
    a["proposal"]["line"] = [[73.85 + i * 1e-4, 18.52] for i in range(120)]
    m = docgen.build_model(a, {"id": "x", "scenario_id": "base", "proposal_object_ids": ["o"]}, {}, [], [])
    assert docgen.render_pdf(m).startswith(b"%PDF")
    assert docgen.render_docx(m)[:2] == b"PK"
