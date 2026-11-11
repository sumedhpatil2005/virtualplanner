"""
/api/feasibility — Infrastructure Feasibility Engine storage, site data,
Investigation Requirements Documents, evidence and review history
(docs/FEASIBILITY_ENGINE.md).

The engine itself runs in the frontend (engine/feasibility/), where the drawn
proposal and the scenario's city model live; this router serves the site-data
layers it reads and stores each run as an immutable assessment. Documents are
generated here from the stored assessment, so a document always matches a
recorded engine run.

Review records are append-only (no PUT/PATCH/DELETE routes; the ORM refuses
updates). No review status means approval.
"""

from __future__ import annotations

import base64
import binascii
import datetime
import hashlib
import json
import os
import re
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.orm import Session

from database.connection import get_db
from feasibility import docgen
from feasibility.layers import FeasibilityLayers
from feasibility.models import (  # noqa: F401  (registers the fs_* tables)
    REVIEW_STATUSES, EvidenceEntity, FeasibilityAssessmentEntity, InvestigationDocumentEntity, ReviewRecordEntity,
)
from osm.index import DATA_DIR, OsmIndex, parse_boxes

router = APIRouter(prefix="/feasibility", tags=["feasibility"])
osm_index = OsmIndex()  # honours TWINCITY_OSM_INDEX
layers = FeasibilityLayers()


def files_dir() -> str:
    """Where generated documents and evidence files are kept (read per call so tests can redirect it)."""
    return os.environ.get("TWINCITY_FEAS_FILES", os.path.join(DATA_DIR, "feasibility_files"))
MAX_EVIDENCE_BYTES = 20 * 1024 * 1024
PROVENANCE = ("measured", "estimated", "model_output", "assumption", "unknown")


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _iso(d: datetime.datetime | None) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S") if d else ""


def _store(sub: str, name: str, data: bytes) -> str:
    folder = os.path.join(files_dir(), sub)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    with open(path, "wb") as f:
        f.write(data)
    return path


def _safe_name(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("._")
    return (s or "file")[:80]


# ── site data ──────────────────────────────────────────────────────────────────

@router.get("/site-data")
def site_data(bbox: str = Query(..., description="wide box minLng,minLat,maxLng,maxLat (water, heritage, metro, railway)"),
              near_bbox: Optional[str] = Query(None, description="narrow box for dense layers (buildings, roads, trees)")):
    try:
        (wide,) = parse_boxes(bbox)
        (near,) = parse_boxes(near_bbox) if near_bbox else (wide,)
    except ValueError as e:
        raise HTTPException(400, str(e))
    out_layers: dict = {}
    elements: dict = {}
    st = osm_index.status()
    for key, cat, box in (("buildings", "buildings", near), ("metro", "metro", wide), ("roads", "roads", near)):
        if not st.get("available"):
            out_layers[key] = {"available": False, "reason": "Local OSM index not built"}
            continue
        if cat not in st.get("capabilities", []) or not osm_index.covers([box]):
            out_layers[key] = {"available": False, "reason": "Local OSM index does not cover this area / category"}
            continue
        elements[key] = osm_index.ways([box]) if key == "roads" else osm_index.infrastructure(cat, [box])
        out_layers[key] = {"available": True, "source": f"OpenStreetMap ({st.get('source')})", "dataTimestamp": st.get("dataTimestamp")}
    ls = layers.status()
    for key, box in (("water", wide), ("heritage", wide), ("trees", near), ("railway", wide)):
        if not ls.get("available"):
            out_layers[key] = {"available": False, "reason": "Feasibility layers not built (python -m feasibility.build_layers)"}
            continue
        if key not in ls.get("categories", []) or not layers.covers(box):
            out_layers[key] = {"available": False, "reason": "Feasibility layers do not cover this area"}
            continue
        elements[key] = layers.features(key, [box])
        out_layers[key] = {"available": True, "source": f"OpenStreetMap ({ls.get('source')})", "dataTimestamp": ls.get("dataTimestamp")}
    return {"bbox": list(wide), "layers": out_layers, "elements": elements}


@router.get("/status")
def status():
    return {"osmIndex": osm_index.status(), "layers": layers.status(), "reviewStatuses": list(REVIEW_STATUSES)}


# ── assessments ────────────────────────────────────────────────────────────────

class AssessmentIn(BaseModel):
    scenario_id: str = Field(min_length=1)
    scenario_version: Optional[str] = None
    proposal_object_ids: list[str] = Field(min_length=1)
    created_by: str = Field(default="anonymous", max_length=200)
    assessment: dict

    @model_validator(mode="after")
    def _check(self):
        a = self.assessment
        for k in ("proposal", "siteAttributes", "findings", "plan", "engineVersion"):
            if k not in a:
                raise ValueError(f"assessment.{k} is required")
        if a.get("verdict") != "screening_only":
            raise ValueError("assessment.verdict must be 'screening_only' (the engine screens; it never declares feasibility)")
        if not a["proposal"].get("proposalType"):
            raise ValueError("assessment.proposal.proposalType is required")
        return self


def _assessment_out(e: FeasibilityAssessmentEntity, full: bool = True) -> dict:
    d = {
        "id": e.id, "scenario_id": e.scenario_id, "scenario_version": e.scenario_version,
        "proposal_object_ids": json.loads(e.proposal_object_ids_json), "proposal_type": e.proposal_type, "name": e.name,
        "engine_version": e.engine_version, "rules_version": e.rules_version, "assessment_sha256": e.assessment_sha256,
        "created_by": e.created_by, "created_at": _iso(e.created_at),
    }
    if full:
        d["assessment"] = json.loads(e.assessment_json)
    return d


@router.post("/assessments", status_code=201)
def create_assessment(body: AssessmentIn, db: Session = Depends(get_db)):
    raw = json.dumps(body.assessment, sort_keys=True)
    a = body.assessment
    e = FeasibilityAssessmentEntity(
        id=str(uuid.uuid4()), scenario_id=body.scenario_id, scenario_version=body.scenario_version,
        proposal_object_ids_json=json.dumps(body.proposal_object_ids), proposal_type=a["proposal"]["proposalType"],
        name=str(a["proposal"].get("name") or "proposal")[:200], engine_version=str(a.get("engineVersion")),
        rules_version=str(a.get("plan", {}).get("rulesVersion", "")), assessment_json=raw, assessment_sha256=_sha(raw.encode()),
        created_by=body.created_by or "anonymous",
    )
    db.add(e)
    db.commit()
    return _assessment_out(e)


@router.get("/assessments")
def list_assessments(scenario_id: Optional[str] = None, object_id: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(FeasibilityAssessmentEntity)
    if scenario_id:
        q = q.filter(FeasibilityAssessmentEntity.scenario_id == scenario_id)
    rows = q.order_by(FeasibilityAssessmentEntity.created_at.desc()).all()
    if object_id:
        rows = [r for r in rows if object_id in json.loads(r.proposal_object_ids_json)]
    return [_assessment_out(r, full=False) for r in rows]


def _get_assessment(db: Session, aid: str) -> FeasibilityAssessmentEntity:
    e = db.get(FeasibilityAssessmentEntity, aid)
    if not e:
        raise HTTPException(404, "Assessment not found")
    return e


@router.get("/assessments/{aid}")
def get_assessment(aid: str, db: Session = Depends(get_db)):
    return _assessment_out(_get_assessment(db, aid))


# ── evidence ───────────────────────────────────────────────────────────────────

class EvidenceIn(BaseModel):
    file_name: str = Field(min_length=1, max_length=200)
    content_base64: str = Field(min_length=1)
    content_type: str = Field(default="application/octet-stream", max_length=100)
    description: str = Field(min_length=3, max_length=2000)
    uploaded_by: str = Field(min_length=1, max_length=200)
    investigation_id: Optional[str] = None
    provenance: Literal["measured", "estimated", "model_output", "assumption", "unknown"] = "unknown"


def _evidence_out(e: EvidenceEntity) -> dict:
    return {"id": e.id, "assessment_id": e.assessment_id, "investigation_id": e.investigation_id, "file_name": e.file_name,
            "content_type": e.content_type, "file_sha256": e.file_sha256, "size_bytes": e.size_bytes, "description": e.description,
            "provenance": e.provenance, "uploaded_by": e.uploaded_by, "uploaded_at": _iso(e.uploaded_at)}


@router.post("/assessments/{aid}/evidence", status_code=201)
def upload_evidence(aid: str, body: EvidenceIn, db: Session = Depends(get_db)):
    a = _get_assessment(db, aid)
    try:
        data = base64.b64decode(body.content_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "content_base64 is not valid base64")
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_EVIDENCE_BYTES:
        raise HTTPException(413, f"File larger than {MAX_EVIDENCE_BYTES // (1024 * 1024)} MB")
    if body.investigation_id:
        ids = {i["id"] for i in json.loads(a.assessment_json).get("plan", {}).get("investigations", [])}
        if body.investigation_id not in ids:
            raise HTTPException(400, "investigation_id is not one of this assessment's required investigations")
    eid = str(uuid.uuid4())
    path = _store(os.path.join("evidence", aid), f"{eid}_{_safe_name(body.file_name)}", data)
    e = EvidenceEntity(id=eid, assessment_id=aid, investigation_id=body.investigation_id, file_name=body.file_name, content_type=body.content_type,
                       file_path=path, file_sha256=_sha(data), size_bytes=len(data), description=body.description, provenance=body.provenance,
                       uploaded_by=body.uploaded_by)
    db.add(e)
    db.commit()
    return _evidence_out(e)


@router.get("/assessments/{aid}/evidence")
def list_evidence(aid: str, db: Session = Depends(get_db)):
    _get_assessment(db, aid)
    return [_evidence_out(e) for e in db.query(EvidenceEntity).filter(EvidenceEntity.assessment_id == aid).order_by(EvidenceEntity.uploaded_at).all()]


@router.get("/evidence/{eid}/download")
def download_evidence(eid: str, db: Session = Depends(get_db)):
    e = db.get(EvidenceEntity, eid)
    if not e or not os.path.exists(e.file_path):
        raise HTTPException(404, "Evidence file not found")
    with open(e.file_path, "rb") as f:
        data = f.read()
    if _sha(data) != e.file_sha256:
        raise HTTPException(409, "Stored file no longer matches its recorded SHA-256")
    return Response(data, media_type=e.content_type, headers={"Content-Disposition": f'attachment; filename="{_safe_name(e.file_name)}"'})


# ── reviews (append-only) ──────────────────────────────────────────────────────

class ReviewIn(BaseModel):
    reviewer_name: str = Field(min_length=1, max_length=200)
    reviewer_role: str = Field(min_length=1, max_length=200)
    organisation: str = Field(default="", max_length=200)
    status: Literal["not_started", "in_review", "information_requested", "reviewed_not_approval", "external_approval_recorded_unverified"]
    notes: str = Field(default="", max_length=5000)
    evidence_ids: list[str] = Field(default_factory=list)
    item_type: Literal["assessment", "investigation", "finding", "document"] = "assessment"
    item_id: Optional[str] = None
    external_reference: Optional[str] = Field(default=None, max_length=500)
    supersedes: Optional[str] = None

    @field_validator("notes")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @model_validator(mode="after")
    def _ext(self):
        if self.status == "external_approval_recorded_unverified" and not (self.external_reference or "").strip():
            raise ValueError("Recording an external approval needs the issuing authority's reference (authority, reference, date)")
        return self


def _review_out(r: ReviewRecordEntity) -> dict:
    return {"id": r.id, "seq": r.seq, "assessment_id": r.assessment_id, "item_type": r.item_type, "item_id": r.item_id,
            "reviewer_name": r.reviewer_name, "reviewer_role": r.reviewer_role, "organisation": r.organisation, "status": r.status,
            "status_label": docgen.REVIEW_STATUS_LABEL[r.status], "is_approval": False, "notes": r.notes,
            "evidence_ids": json.loads(r.evidence_ids_json), "external_reference": r.external_reference,
            "external_reference_verified": False if r.external_reference else None, "supersedes": r.supersedes, "created_at": _iso(r.created_at)}


def _reviews(db: Session, aid: str) -> list[ReviewRecordEntity]:
    return db.query(ReviewRecordEntity).filter(ReviewRecordEntity.assessment_id == aid).order_by(ReviewRecordEntity.seq).all()


@router.post("/assessments/{aid}/reviews", status_code=201)
def add_review(aid: str, body: ReviewIn, db: Session = Depends(get_db)):
    _get_assessment(db, aid)
    known = {e.id for e in db.query(EvidenceEntity).filter(EvidenceEntity.assessment_id == aid).all()}
    unknown = [x for x in body.evidence_ids if x not in known]
    if unknown:
        raise HTTPException(400, f"Evidence not found on this assessment: {', '.join(unknown)}")
    existing = _reviews(db, aid)
    if body.supersedes and body.supersedes not in {r.id for r in existing}:
        raise HTTPException(400, "supersedes must reference an earlier review record of this assessment")
    r = ReviewRecordEntity(id=str(uuid.uuid4()), seq=len(existing) + 1, assessment_id=aid, item_type=body.item_type, item_id=body.item_id,
                           reviewer_name=body.reviewer_name.strip(), reviewer_role=body.reviewer_role.strip(), organisation=body.organisation.strip(),
                           status=body.status, notes=body.notes, evidence_ids_json=json.dumps(body.evidence_ids),
                           external_reference=(body.external_reference or None), supersedes=body.supersedes)
    db.add(r)
    db.commit()
    return _review_out(r)


@router.get("/assessments/{aid}/reviews")
def list_reviews(aid: str, db: Session = Depends(get_db)):
    _get_assessment(db, aid)
    rs = [_review_out(r) for r in _reviews(db, aid)]
    return {"reviews": rs, "summary": {"records": len(rs), "note": "Review history only. No record here is an engineering or statutory approval."}}


# ── documents ──────────────────────────────────────────────────────────────────

class DocumentIn(BaseModel):
    format: Literal["pdf", "docx"]
    generated_by: str = Field(default="anonymous", max_length=200)
    project_name: str = Field(default="", max_length=300)
    location_description: str = Field(default="", max_length=500)
    reason: str = Field(default="", max_length=5000)
    reason_provenance: str = Field(default="", max_length=200)
    traffic_conditions: str = Field(default="", max_length=5000)
    traffic_conditions_provenance: str = Field(default="", max_length=200)
    simulation_results: str = Field(default="", max_length=5000)
    simulation_results_provenance: str = Field(default="", max_length=200)
    expected_benefits: str = Field(default="", max_length=5000)
    expected_benefits_provenance: str = Field(default="", max_length=200)
    responsible_team: str = Field(default="", max_length=500)


def _doc_out(d: InvestigationDocumentEntity) -> dict:
    return {"id": d.id, "assessment_id": d.assessment_id, "format": d.format, "file_name": d.file_name, "file_sha256": d.file_sha256,
            "size_bytes": d.size_bytes, "template_version": d.template_version, "generated_by": d.generated_by, "generated_at": _iso(d.generated_at),
            "download_url": f"/api/feasibility/documents/{d.id}/download"}


@router.post("/assessments/{aid}/documents", status_code=201)
def generate_document(aid: str, body: DocumentIn, db: Session = Depends(get_db)):
    a = _get_assessment(db, aid)
    meta = _assessment_out(a, full=False)
    inputs = body.model_dump(exclude={"format", "generated_by"})
    reviews = [_review_out(r) for r in _reviews(db, aid)]
    evidence = [_evidence_out(e) for e in db.query(EvidenceEntity).filter(EvidenceEntity.assessment_id == aid).all()]
    model = docgen.build_model(json.loads(a.assessment_json), meta, inputs, reviews, evidence)
    data = docgen.render(model, body.format)
    did = str(uuid.uuid4())
    fname = f"investigation-requirements_{_safe_name(inputs.get('project_name') or a.name)}_{did[:8]}.{body.format}"
    path = _store(os.path.join("documents", aid), fname, data)
    d = InvestigationDocumentEntity(id=did, assessment_id=aid, format=body.format, file_name=fname, file_path=path, file_sha256=_sha(data),
                                    size_bytes=len(data), template_version=docgen.TEMPLATE_VERSION, inputs_json=json.dumps(inputs),
                                    generated_by=body.generated_by or "anonymous")
    db.add(d)
    db.commit()
    return _doc_out(d)


@router.get("/assessments/{aid}/documents")
def list_documents(aid: str, db: Session = Depends(get_db)):
    _get_assessment(db, aid)
    return [_doc_out(d) for d in db.query(InvestigationDocumentEntity).filter(InvestigationDocumentEntity.assessment_id == aid).order_by(InvestigationDocumentEntity.generated_at).all()]


MEDIA = {"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


@router.get("/documents/{did}/download")
def download_document(did: str, db: Session = Depends(get_db)):
    d = db.get(InvestigationDocumentEntity, did)
    if not d or not os.path.exists(d.file_path):
        raise HTTPException(404, "Document not found")
    with open(d.file_path, "rb") as f:
        data = f.read()
    return Response(data, media_type=MEDIA[d.format], headers={"Content-Disposition": f'attachment; filename="{d.file_name}"'})
