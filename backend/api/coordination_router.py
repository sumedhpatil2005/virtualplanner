"""
Shared city model & coordination API (`/api/coordination`, docs/urbanos/COORDINATION_AND_SUBSURFACE.md).

Proposal elements (3D extents) per planning project, user-configurable clearance rules, conflict detection across
projects + baseline + subsurface records, conflict status (open/acknowledged/resolved; never edits a project),
stale-assessment indicators computed on read, subsurface record import (AGS4 subset / CSV / JSON) and the environment
layer catalogue. Every write goes through the ORM, so planning.audit writes the append-only audit_log entry.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_
from sqlalchemy.orm import Session

from coordination import geometry as G
from coordination import service as S
from coordination import subsurface as SUB
from coordination.models import (CERTAINTIES, CONFLICT_CLASSES, CONFLICT_STATUSES, ELEMENT_KINDS, ENGINE_VERSION,
                                 ENV_DOMAINS, QUALITY_LEVELS, RULE_TYPES, ClearanceRuleEntity, CoordinationConflictEntity,
                                 CoordinationRunEntity, EnvironmentLayerEntity, ProposalElementEntity,
                                 SubsurfaceDatasetEntity, SubsurfaceRecordEntity)
from coordination.seed import live_status
from database.connection import get_db
from feasibility.models import FeasibilityAssessmentEntity
from models.models import ScenarioEntity, ScenarioRunEntity, ScenarioVersionEntity
from planning.audit import acting_as
from planning.models import PlanningProjectLinkEntity

router = APIRouter(prefix="/coordination", tags=["coordination"])

CLASS_LABEL = {
    "conflict": "Conflict (horizontal and vertical clash within the data and rules)",
    "potential_conflict": "Potential conflict — depth (or footprint width) UNKNOWN, cannot be excluded",
    "vertically_separated": "Vertically separated (gap shown; adequacy UNKNOWN unless a vertical clearance is set)",
    "no_conflict_within_available_data": "No conflict within the available data (not proof of no conflict)",
    "unknown_no_coverage": "UNKNOWN — no data covers this area",
}


def _iso(d) -> Optional[str]:
    return d.isoformat() + "Z" if d else None


def _load(s, default=None):
    return S._load(s, default)


def _project(db: Session, pid: str):
    if not S.project_exists(db, pid):
        raise HTTPException(404, "Planning project not found")


# ── vocabulary ───────────────────────────────────────────────────────────────

@router.get("/vocabulary")
def vocabulary():
    return {"element_kinds": ELEMENT_KINDS, "certainties": CERTAINTIES, "conflict_classes": CONFLICT_CLASSES,
            "conflict_class_labels": CLASS_LABEL, "conflict_statuses": CONFLICT_STATUSES, "rule_types": RULE_TYPES,
            "quality_levels": QUALITY_LEVELS, "environment_domains": ENV_DOMAINS, "crs_distances": f"EPSG:{G.UTM_EPSG} (UTM zone 43N)",
            "z_convention": "metres relative to local ground, up positive; null = UNKNOWN (never 0)",
            "engine_version": ENGINE_VERSION,
            "borehole_csv_columns": SUB.BOREHOLE_CSV_COLUMNS, "utility_csv_columns": SUB.UTILITY_CSV_COLUMNS}


# ── proposal elements ────────────────────────────────────────────────────────

class ProfilePoint(BaseModel):
    chainage_m: float
    z_min_m: Optional[float] = None
    z_max_m: Optional[float] = None


class ElementIn(BaseModel):
    kind: str
    name: str = ""
    scenario_id: Optional[str] = None
    scenario_version_id: Optional[str] = None
    element_ref: Optional[str] = None
    geometry: Optional[dict] = Field(default=None, description="GeoJSON Point/LineString/Polygon in EPSG:4326")
    width_m: Optional[float] = Field(default=None, gt=0)
    z_min_m: Optional[float] = None
    z_max_m: Optional[float] = None
    z_ref: Literal["ground", "msl", "unknown"] = "ground"
    profile: Optional[list[ProfilePoint]] = None
    clearance_m: Optional[float] = Field(default=None, ge=0)
    construction_phase: Literal["permanent", "temporary_works"] = "permanent"
    provenance: str = ""
    certainty: Literal["measured", "estimated", "hypothetical", "unknown"] = "unknown"
    created_by: str = Field(min_length=1)

    @field_validator("kind")
    @classmethod
    def _kind(cls, v):
        if v not in ELEMENT_KINDS:
            raise ValueError(f"kind must be one of {ELEMENT_KINDS}")
        return v


class ElementPatch(BaseModel):
    edited_by: str = Field(min_length=1)
    name: Optional[str] = None
    kind: Optional[str] = None
    geometry: Optional[dict] = None
    width_m: Optional[float] = Field(default=None, gt=0)
    z_min_m: Optional[float] = None
    z_max_m: Optional[float] = None
    profile: Optional[list[ProfilePoint]] = None
    clearance_m: Optional[float] = Field(default=None, ge=0)
    scenario_version_id: Optional[str] = None
    provenance: Optional[str] = None
    certainty: Optional[Literal["measured", "estimated", "hypothetical", "unknown"]] = None
    clear_fields: list[str] = Field(default=[], description="fields to set back to null (UNKNOWN), e.g. ['z_min_m']")


def _validate_geometry(g: dict) -> None:
    try:
        G.project_geojson(g)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"Invalid geometry: {e}") from e


def _validate_refs(db: Session, sid: Optional[str], vid: Optional[str]) -> None:
    if sid and db.get(ScenarioEntity, sid) is None:
        raise HTTPException(422, "scenario_id does not exist")
    if vid:
        v = db.get(ScenarioVersionEntity, vid)
        if v is None or (sid and v.scenario_id != sid):
            raise HTTPException(422, "scenario_version_id does not exist or belongs to another scenario")


def _z_check(zmin, zmax):
    if zmin is not None and zmax is not None and zmin > zmax:
        raise HTTPException(422, "z_min_m must be <= z_max_m (metres relative to ground, up positive)")


def _element_dict(db: Session, e: ProposalElementEntity) -> dict:
    g, w, notes = S.element_geometry(db, e)
    return {"id": e.id, "project_id": e.project_id, "kind": e.kind, "name": e.name, "scenario_id": e.scenario_id,
            "scenario_version_id": e.scenario_version_id, "element_ref": e.element_ref, "geometry": g,
            "own_geometry": bool(e.geometry_geojson), "width_m": w, "z_min_m": e.z_min_m, "z_max_m": e.z_max_m,
            "z_ref": e.z_ref, "z_known": {"z_min": e.z_min_m is not None, "z_max": e.z_max_m is not None},
            "profile": _load(e.profile_json), "clearance_m": e.clearance_m, "construction_phase": e.construction_phase,
            "provenance": e.provenance, "certainty": e.certainty, "notes": notes,
            "created_by": e.created_by, "created_at": _iso(e.created_at), "updated_at": _iso(e.updated_at)}


@router.post("/projects/{pid}/elements", status_code=201)
def create_element(pid: str, body: ElementIn, db: Session = Depends(get_db)):
    _project(db, pid)
    if not body.geometry and not body.element_ref:
        raise HTTPException(422, "Give geometry (GeoJSON) or element_ref (an object id in the scenario)")
    if body.geometry:
        _validate_geometry(body.geometry)
    if body.scenario_version_id and not body.scenario_id:
        v = db.get(ScenarioVersionEntity, body.scenario_version_id)
        body.scenario_id = v.scenario_id if v else None
    _validate_refs(db, body.scenario_id, body.scenario_version_id)
    _z_check(body.z_min_m, body.z_max_m)
    e = ProposalElementEntity(
        id=f"pel_{uuid.uuid4().hex[:12]}", project_id=pid, scenario_id=body.scenario_id, scenario_version_id=body.scenario_version_id,
        element_ref=body.element_ref, geometry_geojson=json.dumps(body.geometry) if body.geometry else None, kind=body.kind,
        name=body.name, width_m=body.width_m, z_min_m=body.z_min_m, z_max_m=body.z_max_m, z_ref=body.z_ref,
        profile_json=json.dumps([p.model_dump() for p in body.profile]) if body.profile else None, clearance_m=body.clearance_m,
        construction_phase=body.construction_phase, provenance=body.provenance, certainty=body.certainty, created_by=body.created_by)
    if e.geometry_geojson is None and S.element_geometry(db, e)[0] is None:
        raise HTTPException(422, "element_ref could not be resolved to a geometry in that scenario / version")
    with acting_as(body.created_by):
        db.add(e)
        db.commit()
    db.refresh(e)
    return _element_dict(db, e)


@router.get("/projects/{pid}/elements")
def list_elements(pid: str, db: Session = Depends(get_db)):
    _project(db, pid)
    return [_element_dict(db, e) for e in db.query(ProposalElementEntity).filter(ProposalElementEntity.project_id == pid).order_by(ProposalElementEntity.created_at)]


@router.get("/elements/{eid}")
def get_element(eid: str, db: Session = Depends(get_db)):
    e = db.get(ProposalElementEntity, eid)
    if e is None:
        raise HTTPException(404, "Element not found")
    return _element_dict(db, e)


@router.patch("/elements/{eid}")
def patch_element(eid: str, body: ElementPatch, db: Session = Depends(get_db)):
    e = db.get(ProposalElementEntity, eid)
    if e is None:
        raise HTTPException(404, "Element not found")
    data = body.model_dump(exclude_unset=True)
    if "kind" in data and data["kind"] not in ELEMENT_KINDS:
        raise HTTPException(422, f"kind must be one of {ELEMENT_KINDS}")
    if data.get("geometry"):
        _validate_geometry(data["geometry"])
    if data.get("scenario_version_id"):
        _validate_refs(db, e.scenario_id, data["scenario_version_id"])
    for k in ("name", "kind", "width_m", "z_min_m", "z_max_m", "clearance_m", "scenario_version_id", "provenance", "certainty"):
        if data.get(k) is not None:
            setattr(e, k, data[k])
    if data.get("geometry"):
        e.geometry_geojson = json.dumps(data["geometry"])
    if data.get("profile") is not None:
        e.profile_json = json.dumps(data["profile"])
    for k in body.clear_fields:
        if k in ("width_m", "z_min_m", "z_max_m", "clearance_m", "scenario_version_id"):
            setattr(e, k, None)
        elif k == "profile":
            e.profile_json = None
        else:
            raise HTTPException(422, f"cannot clear {k}")
    _z_check(e.z_min_m, e.z_max_m)
    with acting_as(body.edited_by):
        db.commit()
    db.refresh(e)
    return _element_dict(db, e)


@router.delete("/elements/{eid}")
def delete_element(eid: str, removed_by: str = Query(..., min_length=1), db: Session = Depends(get_db)):
    e = db.get(ProposalElementEntity, eid)
    if e is None:
        raise HTTPException(404, "Element not found")
    with acting_as(removed_by):
        db.delete(e)
        db.commit()
    return {"deleted": eid, "note": "earlier coordination runs keep their findings and now show as stale"}


# ── clearance rules ──────────────────────────────────────────────────────────

class RuleIn(BaseModel):
    label: str = Field(min_length=1)
    rule_type: Literal["permission_distance", "engineering_clearance"]
    subject_kind: str = "*"
    other_kind: str = "*"
    horizontal_m: Optional[float] = Field(default=None, ge=0)
    vertical_m: Optional[float] = Field(default=None, ge=0)
    citation: Optional[str] = None
    note: str = ""
    created_by: str = Field(min_length=1)


class RulePatch(BaseModel):
    edited_by: str = Field(min_length=1)
    label: Optional[str] = None
    horizontal_m: Optional[float] = Field(default=None, ge=0)
    vertical_m: Optional[float] = Field(default=None, ge=0)
    subject_kind: Optional[str] = None
    other_kind: Optional[str] = None
    active: Optional[bool] = None
    note: Optional[str] = None
    citation: Optional[str] = None
    clear_fields: list[str] = []


def _rule_dict(r: ClearanceRuleEntity) -> dict:
    return {"id": r.id, "label": r.label, "rule_type": r.rule_type, "subject_kind": r.subject_kind, "other_kind": r.other_kind,
            "horizontal_m": r.horizontal_m, "vertical_m": r.vertical_m,
            "horizontal_label": "UNKNOWN (not set)" if r.horizontal_m is None else f"{r.horizontal_m:g} m",
            "vertical_label": "UNKNOWN (not set)" if r.vertical_m is None else f"{r.vertical_m:g} m",
            "basis": r.basis, "is_permission_distance": r.rule_type == "permission_distance",
            "is_engineering_clearance": r.rule_type == "engineering_clearance",
            "basis_label": ("Permission distance cited from a source — NOT an engineering clearance" if r.basis == "cited_permission_distance"
                            else "Entered by a user — not a cited standard"),
            "citation": r.citation, "note": r.note, "active": r.active, "created_by": r.created_by,
            "created_at": _iso(r.created_at), "updated_at": _iso(r.updated_at)}


@router.get("/clearance-rules")
def list_rules(db: Session = Depends(get_db)):
    rules = [_rule_dict(r) for r in db.query(ClearanceRuleEntity).order_by(ClearanceRuleEntity.created_at, ClearanceRuleEntity.id)]
    return {"rules": rules, "rule_set_hash": S.rules_snapshot(db)[1],
            "engineering_clearances_note": "No engineering clearance is pre-filled: every engineering clearance is UNKNOWN until a user enters one. "
                                           "Without one, the horizontal test is physical footprint overlap only."}


@router.post("/clearance-rules", status_code=201)
def create_rule(body: RuleIn, db: Session = Depends(get_db)):
    r = ClearanceRuleEntity(id=f"rule_{uuid.uuid4().hex[:10]}", basis="user_entered", active=True, **body.model_dump())
    with acting_as(body.created_by):
        db.add(r)
        db.commit()
    db.refresh(r)
    return _rule_dict(r)


@router.patch("/clearance-rules/{rid}")
def patch_rule(rid: str, body: RulePatch, db: Session = Depends(get_db)):
    r = db.get(ClearanceRuleEntity, rid)
    if r is None:
        raise HTTPException(404, "Rule not found")
    data = body.model_dump(exclude_unset=True)
    values_changed = False
    for k in ("label", "horizontal_m", "vertical_m", "subject_kind", "other_kind", "active", "note", "citation"):
        if data.get(k) is not None and getattr(r, k) != data[k]:
            values_changed |= k in ("horizontal_m", "vertical_m", "subject_kind", "other_kind")
            setattr(r, k, data[k])
    for k in body.clear_fields:
        if k not in ("horizontal_m", "vertical_m", "citation"):
            raise HTTPException(422, f"cannot clear {k}")
        values_changed |= k != "citation" and getattr(r, k) is not None
        setattr(r, k, None)
    if values_changed and r.basis == "cited_permission_distance":
        r.basis = "user_entered"  # a changed value is no longer the cited one
        r.note = (r.note + " | Values changed by a user: no longer the cited permission distance.").strip(" |")
    with acting_as(body.edited_by):
        db.commit()
    db.refresh(r)
    return _rule_dict(r)


# ── detection, runs, conflicts ───────────────────────────────────────────────

class DetectIn(BaseModel):
    run_by: str = Field(min_length=1)
    screening_radius_m: float = Field(default=S.DEFAULT_SCREENING_RADIUS_M, gt=0, le=1000)


def _conflict_dict(c: CoordinationConflictEntity) -> dict:
    return {"id": c.id, "run_id": c.run_id, "project_a_id": c.project_a_id, "element_a_id": c.element_a_id, "segment_a": c.segment_a,
            "b_type": c.b_type, "project_b_id": c.project_b_id, "b_ref": c.b_ref, "segment_b": c.segment_b,
            "class": c.conflict_class, "class_label": CLASS_LABEL[c.conflict_class],
            "horizontal_distance_m": c.horizontal_distance_m, "vertical_gap_m": c.vertical_gap_m, "certainty": c.certainty,
            "reasons": _load(c.reasons_json, []), "permission_triggers": _load(c.permission_triggers_json, []),
            "evidence": _load(c.evidence_json, {}), "status": c.status, "status_by": c.status_by, "status_note": c.status_note,
            "status_at": _iso(c.status_at), "status_carried_from": c.status_carried_from, "created_at": _iso(c.created_at)}


def _run_dict(db: Session, r: CoordinationRunEntity, with_conflicts: bool = False) -> dict:
    d = {"id": r.id, "project_id": r.project_id, "engine_version": r.engine_version, "created_by": r.created_by,
         "created_at": _iso(r.created_at), "summary": _load(r.summary_json, {}), "inputs": _load(r.inputs_json, {}),
         "stale": S.stale_coordination_run(db, r)}
    if with_conflicts:
        d["conflicts"] = [_conflict_dict(c) for c in db.query(CoordinationConflictEntity).filter(CoordinationConflictEntity.run_id == r.id)
                          .order_by(CoordinationConflictEntity.created_at)]
    return d


@router.post("/projects/{pid}/detect", status_code=201)
def detect(pid: str, body: DetectIn, db: Session = Depends(get_db)):
    _project(db, pid)
    with acting_as(body.run_by):
        run = S.run_detection(db, pid, body.run_by, body.screening_radius_m)
        db.commit()
    return _run_dict(db, db.get(CoordinationRunEntity, run.id), with_conflicts=True)


@router.get("/projects/{pid}/runs")
def list_runs(pid: str, db: Session = Depends(get_db)):
    _project(db, pid)
    return [_run_dict(db, r) for r in db.query(CoordinationRunEntity).filter(CoordinationRunEntity.project_id == pid).order_by(CoordinationRunEntity.created_at.desc())]


@router.get("/runs/{rid}")
def get_run(rid: str, db: Session = Depends(get_db)):
    r = db.get(CoordinationRunEntity, rid)
    if r is None:
        raise HTTPException(404, "Run not found")
    return _run_dict(db, r, with_conflicts=True)


def _latest_runs(db: Session) -> dict[str, CoordinationRunEntity]:
    out: dict[str, CoordinationRunEntity] = {}
    for r in db.query(CoordinationRunEntity).order_by(CoordinationRunEntity.created_at):
        out[r.project_id] = r
    return out


@router.get("/projects/{pid}/conflicts")
def project_conflicts(pid: str, include_clear: bool = False, db: Session = Depends(get_db)):
    """Issues visible to BOTH projects: findings of every project's latest run where this project is side A or side B."""
    _project(db, pid)
    latest = _latest_runs(db)
    run_ids = [r.id for r in latest.values()]
    q = db.query(CoordinationConflictEntity).filter(CoordinationConflictEntity.run_id.in_(run_ids),
                                                    or_(CoordinationConflictEntity.project_a_id == pid, CoordinationConflictEntity.project_b_id == pid))
    rows = q.order_by(CoordinationConflictEntity.created_at).all()
    if not include_clear:
        rows = [c for c in rows if c.conflict_class != "no_conflict_within_available_data" or _load(c.permission_triggers_json, [])]
    stale = {r.id: S.stale_coordination_run(db, r) for r in latest.values() if r.id in {c.run_id for c in rows}}
    rows.sort(key=lambda c: (G.SEVERITY.get(c.conflict_class, 9), c.horizontal_distance_m if c.horizontal_distance_m is not None else 1e9))
    return {"project_id": pid, "issues": [{**_conflict_dict(c), "raised_by_project": c.project_a_id,
                                           "other_project": c.project_b_id if c.project_a_id == pid else c.project_a_id,
                                           "run_stale": stale.get(c.run_id)} for c in rows],
            "note": "Findings never edit either project. 'No conflict within available data' is not proof of no conflict."}


CONFLICT_EXPORT_DISCLAIMER = ("Coordination screening findings from records in this tool. Not an engineering assessment, statutory approval, "
                             "NOC or permit. 'No conflict within available data' is not proof of no conflict; empty depth/width = UNKNOWN.")
CONFLICT_EXPORT_COLUMNS = ["finding_id", "class", "class_label", "status", "status_by", "status_note", "raised_by_project",
                           "other_project", "element_a_id", "b_type", "b_ref", "horizontal_distance_m", "vertical_gap_m",
                           "certainty", "permission_triggers", "reasons", "run_id", "run_stale", "created_at"]


@router.get("/projects/{pid}/conflicts/export")
def export_conflicts(pid: str, format: Literal["csv"] = "csv", requested_by: str = Query(default=""),
                     include_clear: bool = False, db: Session = Depends(get_db)):
    """Conflict summary (CSV) of the issues visible to this project; recorded as an `export` audit entry with the file's sha256."""
    import csv
    import io

    from fastapi import Response

    from planning import audit as _audit

    data = project_conflicts(pid, include_clear=include_clear, db=db)
    buf = io.StringIO()
    buf.write(f"# {CONFLICT_EXPORT_DISCLAIMER}\n")
    buf.write(f"# project={pid} exported_at={datetime.datetime.utcnow().isoformat(timespec='seconds')}Z engine={ENGINE_VERSION}\n")
    w = csv.writer(buf)
    w.writerow(CONFLICT_EXPORT_COLUMNS)
    for i in data["issues"]:
        st = i.get("run_stale") or {}
        w.writerow([i["id"], i["class"], i["class_label"], i["status"], i["status_by"] or "", i["status_note"] or "",
                    i["raised_by_project"], i["other_project"] or "", i["element_a_id"], i["b_type"], i["b_ref"],
                    "" if i["horizontal_distance_m"] is None else round(i["horizontal_distance_m"], 2),
                    "" if i["vertical_gap_m"] is None else round(i["vertical_gap_m"], 2), i["certainty"],
                    "; ".join(f"{t['label']} ({t['distance_m']:.1f} m <= {t['threshold_m']} m)" for t in i["permission_triggers"]),
                    " | ".join(i["reasons"]), i["run_id"],
                    "UNKNOWN" if st.get("stale") is None else ("stale" if st.get("stale") else "current"), i["created_at"]])
    body = buf.getvalue().encode("utf-8")
    sha = hashlib.sha256(body).hexdigest()
    _audit.record(db, action="export", entity_type="project_report", entity_id=pid, actor=requested_by or None,
                  label="CSV conflict summary", parent_type="project", parent_id=pid, after_hash=f"sha256:{sha}")
    db.commit()
    return Response(content=body, media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="conflict-summary-{pid}.csv"', "X-Report-SHA256": sha,
        "Access-Control-Expose-Headers": "X-Report-SHA256, Content-Disposition"})


class StatusIn(BaseModel):
    status: Literal["open", "acknowledged", "resolved"]
    actor: str = Field(min_length=1)
    note: str = Field(min_length=1)


@router.patch("/conflicts/{cid}/status")
def set_status(cid: str, body: StatusIn, db: Session = Depends(get_db)):
    c = db.get(CoordinationConflictEntity, cid)
    if c is None:
        raise HTTPException(404, "Finding not found")
    c.status, c.status_by, c.status_note, c.status_at = body.status, body.actor, body.note, datetime.datetime.utcnow()
    with acting_as(body.actor):
        db.commit()
    db.refresh(c)
    out = _conflict_dict(c)
    out["note"] = "Status records a person's response in this tool; it does not change the finding, either project, or any approval."
    return out


# ── staleness ────────────────────────────────────────────────────────────────

@router.get("/stale/{kind}/{oid}")
def stale_one(kind: Literal["run", "assessment", "coordination_run"], oid: str, db: Session = Depends(get_db)):
    if kind == "run":
        r = db.get(ScenarioRunEntity, oid)
        if r is None:
            raise HTTPException(404, "Run not found")
        return {"kind": kind, "id": oid, **S.stale_sim_run(db, r)}
    if kind == "assessment":
        a = db.get(FeasibilityAssessmentEntity, oid)
        if a is None:
            raise HTTPException(404, "Assessment not found")
        return {"kind": kind, "id": oid, **S.stale_assessment(db, a)}
    cr = db.get(CoordinationRunEntity, oid)
    if cr is None:
        raise HTTPException(404, "Coordination run not found")
    return {"kind": kind, "id": oid, **S.stale_coordination_run(db, cr)}


@router.get("/projects/{pid}/stale")
def project_stale(pid: str, db: Session = Depends(get_db)):
    """Stale indicators for every assessment attached to the project: simulation/ODME/emissions run records (attached runs and
    runs of attached scenarios), feasibility assessments, and the project's coordination runs."""
    _project(db, pid)
    links = db.query(PlanningProjectLinkEntity).filter(PlanningProjectLinkEntity.project_id == pid).all()
    run_ids = {l.entity_id for l in links if l.entity_type == "run"}
    sids = {l.entity_id for l in links if l.entity_type == "scenario"}
    if sids:
        run_ids |= {r.id for r in db.query(ScenarioRunEntity.id).filter(ScenarioRunEntity.scenario_id.in_(sids))}
    out = {"project_id": pid, "runs": [], "assessments": [], "coordination_runs": []}
    for rid in sorted(run_ids):
        r = db.get(ScenarioRunEntity, rid)
        if r is not None:
            out["runs"].append({"id": rid, "scenario_id": r.scenario_id, "created_at": _iso(r.created_at), **S.stale_sim_run(db, r)})
    for l in links:
        if l.entity_type == "assessment":
            a = db.get(FeasibilityAssessmentEntity, l.entity_id)
            if a is not None:
                out["assessments"].append({"id": a.id, "name": a.name, **S.stale_assessment(db, a)})
    for cr in db.query(CoordinationRunEntity).filter(CoordinationRunEntity.project_id == pid).order_by(CoordinationRunEntity.created_at.desc()):
        out["coordination_runs"].append({"id": cr.id, "created_at": _iso(cr.created_at), **S.stale_coordination_run(db, cr)})
    return out


# ── subsurface records ───────────────────────────────────────────────────────

class ImportIn(BaseModel):
    record_type: Literal["borehole", "utility"]
    format: Literal["ags4", "csv", "json"]
    content: Optional[str] = Field(default=None, description="file text (ags4 / csv)")
    records: Optional[list[dict]] = Field(default=None, description="format json: utility records")
    name: str = Field(min_length=1)
    file_name: Optional[str] = None
    publisher: str = ""
    source_url: str = ""
    licence: str = "UNKNOWN"
    data_date: Optional[str] = None
    coverage_bbox: Optional[list[float]] = Field(default=None, description="[minLon,minLat,maxLon,maxLat] the dataset is stated to cover completely")
    provenance: str = ""
    project_id: Optional[str] = None
    grid_epsg: Optional[int] = Field(default=None, description="AGS4: the grid of LOCA_NATE/NATN when LOCA_GREF does not say (only 32643 supported)")
    supersedes_id: Optional[str] = None
    imported_by: str = Field(min_length=1)


def _dataset_dict(d: SubsurfaceDatasetEntity) -> dict:
    return {"id": d.id, "project_id": d.project_id, "record_type": d.record_type, "format": d.format, "name": d.name,
            "file_name": d.file_name, "file_sha256": d.file_sha256, "publisher": d.publisher, "source_url": d.source_url,
            "licence": d.licence, "data_date": d.data_date, "coverage_bbox": _load(d.coverage_bbox_json),
            "coverage_label": "stated by importer" if d.coverage_bbox_json else "UNKNOWN (absence of records proves nothing)",
            "provenance": d.provenance, "record_count": d.record_count, "warnings": _load(d.warnings_json, []),
            "supersedes_id": d.supersedes_id, "imported_by": d.imported_by, "imported_at": _iso(d.imported_at)}


def _record_dict(r: SubsurfaceRecordEntity) -> dict:
    return {"id": r.id, "dataset_id": r.dataset_id, "record_type": r.record_type, "external_id": r.external_id,
            "geometry": _load(r.geometry_geojson), "location_note": r.location_note, "ground_level_m": r.ground_level_m,
            "final_depth_m": r.final_depth_m, "strata": _load(r.strata_json, []), "water_strikes": _load(r.water_strikes_json, []),
            "spt": _load(r.spt_json, []), "utility_type": r.utility_type, "owner": r.owner, "depth_m": r.depth_m,
            "diameter_m": r.diameter_m, "quality_level": r.quality_level or ("UNKNOWN" if r.record_type == "utility" else None),
            "survey_method": r.survey_method, "z_min_m": r.z_min_m, "z_max_m": r.z_max_m, "z_certainty": r.z_certainty,
            "properties": _load(r.properties_json, {})}


@router.post("/subsurface/import", status_code=201)
def import_subsurface(body: ImportIn, db: Session = Depends(get_db)):
    if body.project_id:
        _project(db, body.project_id)
    if body.format in ("ags4", "csv") and not body.content:
        raise HTTPException(422, "content (file text) is required for ags4 / csv")
    if body.format == "json" and (body.record_type != "utility" or not body.records):
        raise HTTPException(422, "format json takes utility records in 'records'")
    if body.format == "ags4" and body.record_type != "borehole":
        raise HTTPException(422, "AGS4 import reads boreholes (LOCA/GEOL/WSTK/ISPT)")
    try:
        if body.record_type == "borehole":
            recs, warnings, meta = (SUB.boreholes_from_ags4(body.content, body.grid_epsg) if body.format == "ags4" else SUB.boreholes_from_csv(body.content))
        elif body.format == "csv":
            recs, warnings, meta = SUB.utilities_from_csv(body.content)
        else:
            warnings, meta = [], {}
            recs = [SUB.utility_record(r, i, warnings) for i, r in enumerate(body.records, start=1)]
    except (ValueError, KeyError) as e:
        raise HTTPException(422, f"Could not read the file: {e}") from e
    if not recs:
        raise HTTPException(422, "No records found")
    raw = body.content if body.content is not None else json.dumps(body.records, sort_keys=True)
    d = SubsurfaceDatasetEntity(
        id=f"ssd_{uuid.uuid4().hex[:12]}", project_id=body.project_id, record_type=body.record_type, format=body.format,
        name=body.name, file_name=body.file_name, file_sha256="sha256:" + hashlib.sha256(raw.encode()).hexdigest(),
        publisher=body.publisher, source_url=body.source_url, licence=body.licence or "UNKNOWN", data_date=body.data_date,
        coverage_bbox_json=json.dumps(body.coverage_bbox) if body.coverage_bbox else None,
        provenance=body.provenance or f"imported by {body.imported_by} from {body.file_name or body.format}",
        record_count=len(recs), warnings_json=json.dumps(warnings), supersedes_id=body.supersedes_id, imported_by=body.imported_by)
    rows = []
    for r in recs:
        if body.record_type == "borehole":
            geom = {"type": "Point", "coordinates": [r["lon"], r["lat"]]} if r["lon"] is not None and r["lat"] is not None else None
            fd = r["final_depth_m"]
            rows.append(SubsurfaceRecordEntity(
                id=f"ssr_{uuid.uuid4().hex[:12]}", dataset_id=d.id, record_type="borehole", external_id=r["external_id"],
                geometry_geojson=json.dumps(geom) if geom else None, location_note=r["location_note"], ground_level_m=r["ground_level_m"],
                final_depth_m=fd, strata_json=json.dumps(r["strata"]), water_strikes_json=json.dumps(r["water_strikes"]),
                spt_json=json.dumps(r["spt"]), z_max_m=0.0 if fd is not None else None, z_min_m=-fd if fd is not None else None,
                z_certainty="measured" if fd is not None else "unknown", properties_json=json.dumps(r["properties"])))
        else:
            rows.append(SubsurfaceRecordEntity(
                id=f"ssr_{uuid.uuid4().hex[:12]}", dataset_id=d.id, record_type="utility", external_id=r["external_id"],
                geometry_geojson=json.dumps(r["geometry"]) if r["geometry"] else None,
                location_note="from record" if r["geometry"] else "location UNKNOWN", utility_type=r["utility_type"], owner=r["owner"],
                depth_m=r["depth_m"], diameter_m=r["diameter_m"], quality_level=r["quality_level"], survey_method=r["survey_method"],
                z_min_m=r["z_min_m"], z_max_m=r["z_max_m"], z_certainty=r["z_certainty"]))
    with acting_as(body.imported_by):
        db.add(d)
        db.add_all(rows)
        db.commit()
    return {**_dataset_dict(d), "meta": meta, "records": [_record_dict(r) for r in rows]}


@router.get("/subsurface/datasets")
def list_datasets(project_id: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(SubsurfaceDatasetEntity)
    if project_id:
        q = q.filter(SubsurfaceDatasetEntity.project_id == project_id)
    return [_dataset_dict(d) for d in q.order_by(SubsurfaceDatasetEntity.imported_at.desc())]


@router.get("/subsurface/datasets/{did}")
def get_dataset(did: str, db: Session = Depends(get_db)):
    d = db.get(SubsurfaceDatasetEntity, did)
    if d is None:
        raise HTTPException(404, "Dataset not found")
    recs = db.query(SubsurfaceRecordEntity).filter(SubsurfaceRecordEntity.dataset_id == did).all()
    return {**_dataset_dict(d), "records": [_record_dict(r) for r in recs]}


@router.get("/subsurface/records")
def list_records(bbox: Optional[str] = Query(None, description="minLon,minLat,maxLon,maxLat"),
                 record_type: Optional[Literal["borehole", "utility"]] = None,
                 include_reference: bool = Query(False, description="include bulk reference networks (PMC sewer / storm drains) without a bbox"),
                 db: Session = Depends(get_db)):
    from sqlalchemy import and_, or_
    from coordination.models import REFERENCE_DATASET_PREFIX, SubsurfaceRecordExtentEntity as E
    q = db.query(SubsurfaceRecordEntity)
    if record_type:
        q = q.filter(SubsurfaceRecordEntity.record_type == record_type)
    box = None
    if bbox:
        try:
            box = [float(v) for v in bbox.split(",")]
            assert len(box) == 4
        except (ValueError, AssertionError) as e:
            raise HTTPException(422, "bbox must be minLon,minLat,maxLon,maxLat") from e
        q = q.outerjoin(E, E.record_id == SubsurfaceRecordEntity.id).filter(or_(
            E.record_id.is_(None), and_(E.max_lon >= box[0], E.min_lon <= box[2], E.max_lat >= box[1], E.min_lat <= box[3])))
    excluded = []
    if box is None and not include_reference:
        # bulk reference networks (tens of thousands of records) are only listed by bbox; their datasets stay listed
        q = q.filter(~SubsurfaceRecordEntity.dataset_id.like(f"{REFERENCE_DATASET_PREFIX}%"))
        excluded = [{"id": d.id, "name": d.name, "record_count": d.record_count} for d in
                    db.query(SubsurfaceDatasetEntity).filter(SubsurfaceDatasetEntity.id.like(f"{REFERENCE_DATASET_PREFIX}%"))]
    rows = q.all()
    if box:
        from shapely.geometry import box as sbox, shape
        b = sbox(*box)
        rows = [r for r in rows if r.geometry_geojson and shape(_load(r.geometry_geojson)).intersects(b)]
    out = {"records": [_record_dict(r) for r in rows],
           "note": "Only imported records. Absence of a record is not evidence that nothing is there (UNKNOWN)."}
    if excluded:
        out["reference_datasets_not_listed"] = excluded
        out["reference_note"] = "Reference networks are listed only for a bbox (?bbox=…) or with include_reference=true."
    return out


# ── environment layer catalogue ──────────────────────────────────────────────

@router.get("/environment-layers")
def environment_layers(db: Session = Depends(get_db)):
    out = []
    for l in db.query(EnvironmentLayerEntity).order_by(EnvironmentLayerEntity.domain, EnvironmentLayerEntity.id):
        live = live_status(l)
        out.append({"id": l.id, "domain": l.domain, "name": l.name, "source": l.source, "licence": l.licence,
                    "data_date": live.get("data_date") or l.data_date, "recommended_sources": _load(l.recommended_sources_json, []),
                    "limitations": l.limitations, **live,
                    "status_label": "Available" if live["status"] == "available" else "Not imported — UNKNOWN"})
    return {"layers": out, "note": "Recommended sources are metadata only (docs/urbanos/ENGINEERING_GIS_RESEARCH.md §C); nothing is shown as a result without imported data."}
