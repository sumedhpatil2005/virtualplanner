"""
Scenario change sets, versions and frozen run inputs (docs/SCENARIOS_AND_VERSIONING.md).

A proposal = its baseline ('base') + a change set keyed by object id:
  add     the proposal's own objects (city_objects rows with scenario_id = proposal; legacy storage, unchanged)
  modify  the proposal's version of a base object, same id (scenario_object_changes, op 'modify')
  delete  a base object hidden in the proposal: a tombstone (scenario_object_changes, op 'delete')
The baseline rows are never written by these endpoints. Versions are immutable snapshots of the change set plus the
assumptions they were saved with; restoring a version makes a new head and a new version, it never edits history.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from database.connection import get_db
from models.models import (
    CityObjectEntity,
    ScenarioEntity,
    ScenarioObjectChangeEntity,
    ScenarioRunEntity,
    ScenarioVersionChangeEntity,
    ScenarioVersionEntity,
)

router = APIRouter()
BASE = "base"


# ── Schemas ──────────────────────────────────────────────────────────────────────────────────────────────────────

class ObjectPayload(BaseModel):
    id: str
    type: str
    name: str
    layerId: str
    scenarioId: Optional[str] = None
    coordinates: List[Any]
    properties: Dict[str, Any] = {}


class ChangeIn(BaseModel):
    objectId: str = Field(min_length=1)
    # 'revert' removes the proposal's change, so the object is the baseline's again
    op: Literal["modify", "delete", "revert"]
    object: Optional[ObjectPayload] = None


class VersionIn(BaseModel):
    label: str = Field(default="", max_length=120)
    note: str = Field(default="", max_length=1000)
    assumptions: Dict[str, Any] = {}


class ForkIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    year: int = Field(ge=1900, le=2200)


class RunIn(BaseModel):
    scenarioId: str
    scenarioVersionId: Optional[str] = None
    inputs: Dict[str, Any]
    results: Optional[Dict[str, Any]] = None


class CompareIn(BaseModel):
    runA: str
    runB: str


# ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

def _load(s: Optional[str], default):
    try:
        return json.loads(s) if s else default
    except Exception:
        return default


def _object_dict(oid: str, type_: str, name: str, layer_id: str, scenario_id: str, geom: str, props: str) -> dict:
    return {"id": oid, "type": type_, "name": name, "layerId": layer_id, "scenarioId": scenario_id,
            "coordinates": _load(geom, []), "properties": _load(props, {})}


def _proposal(db: Session, sid: str) -> ScenarioEntity:
    if sid == BASE:
        raise HTTPException(status_code=400, detail="The baseline is not a change set; edit it in the base scenario")
    scn = db.get(ScenarioEntity, sid)
    if not scn:
        raise HTTPException(status_code=404, detail="Scenario not found")
    return scn


def _canon(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


_FINGERPRINTS: Dict[tuple, str] = {}


def baseline_fingerprint(db: Session, baseline_id: str = BASE) -> str:
    """sha256 over the baseline objects' content (id, type, name, layer, geometry, properties), in id order.
    Cached per (database, baseline, row count, latest updated_at): every API write of a row sets updated_at, so a
    change through the API always recomputes it (a write made outside the API without updated_at would not)."""
    sig = db.query(func.count(CityObjectEntity.id), func.max(CityObjectEntity.updated_at)).filter(CityObjectEntity.scenario_id == baseline_id).one()
    key = (str(db.get_bind().url), baseline_id, sig[0], str(sig[1]))
    if key in _FINGERPRINTS:
        return _FINGERPRINTS[key]
    _FINGERPRINTS[key] = fp = _baseline_fingerprint(db, baseline_id)
    return fp


def _baseline_fingerprint(db: Session, baseline_id: str) -> str:
    h = hashlib.sha256()
    rows = (db.query(CityObjectEntity.id, CityObjectEntity.type, CityObjectEntity.name, CityObjectEntity.layer_id,
                     CityObjectEntity.geometry_geojson, CityObjectEntity.properties_json)
            .filter(CityObjectEntity.scenario_id == baseline_id).order_by(CityObjectEntity.id))
    n = 0
    for r in rows:
        n += 1
        # Geometry and properties are hashed as parsed JSON, so key order or whitespace in storage does not matter
        h.update(_canon([r[0], r[1], r[2], r[3], _load(r[4], None), _load(r[5], None)]).encode())
        h.update(b"\n")
    return f"sha256:{h.hexdigest()}:{n}"


def head_change_set(db: Session, sid: str) -> List[dict]:
    """The proposal's current change set: its adds (own objects) then its modifies/deletes of base objects, in order."""
    out: List[dict] = []
    adds = (db.query(CityObjectEntity).filter(CityObjectEntity.scenario_id == sid)
            .order_by(CityObjectEntity.created_at, CityObjectEntity.id).all())
    for i, e in enumerate(adds):
        out.append({"objectId": e.id, "op": "add", "seq": i,
                    "object": _object_dict(e.id, e.type, e.name, e.layer_id, sid, e.geometry_geojson, e.properties_json)})
    base_seq = len(out)
    for c in db.query(ScenarioObjectChangeEntity).filter(ScenarioObjectChangeEntity.scenario_id == sid).order_by(ScenarioObjectChangeEntity.seq):
        item = {"objectId": c.object_id, "op": c.op, "seq": base_seq + c.seq}
        if c.op == "modify":
            item["object"] = _object_dict(c.object_id, c.type, c.name, c.layer_id, sid, c.geometry_geojson, c.properties_json)
        out.append(item)
    return out


def change_set_hash(changes: List[dict]) -> str:
    """Order-independent hash of a change set (keyed by object id; each id appears once)."""
    keyed = sorted(([c["objectId"], c["op"], c.get("object")] for c in changes), key=lambda x: x[0])
    return "sha256:" + hashlib.sha256(_canon(keyed).encode()).hexdigest()


def _version_dict(v: ScenarioVersionEntity) -> dict:
    return {"id": v.id, "scenarioId": v.scenario_id, "number": v.number, "label": v.label, "note": v.note or "",
            "parentVersionId": v.parent_version_id, "restoredFromVersionId": v.restored_from_version_id,
            "baselineId": v.baseline_id, "baselineFingerprint": v.baseline_fingerprint,
            "changeSetHash": v.change_set_hash, "changeCount": v.change_count,
            "assumptions": _load(v.assumptions_json, {}),
            "createdAt": v.created_at.isoformat() + "Z" if v.created_at else None}


def _version_changes(db: Session, vid: str, sid: str) -> List[dict]:
    out = []
    for c in db.query(ScenarioVersionChangeEntity).filter(ScenarioVersionChangeEntity.version_id == vid).order_by(ScenarioVersionChangeEntity.seq):
        item = {"objectId": c.object_id, "op": c.op, "seq": c.seq}
        if c.op in ("add", "modify"):
            item["object"] = _object_dict(c.object_id, c.type, c.name, c.layer_id, sid, c.geometry_geojson, c.properties_json)
        out.append(item)
    return out


def _latest_version(db: Session, sid: str) -> Optional[ScenarioVersionEntity]:
    return (db.query(ScenarioVersionEntity).filter(ScenarioVersionEntity.scenario_id == sid)
            .order_by(ScenarioVersionEntity.number.desc()).first())


def _save_version(db: Session, scn: ScenarioEntity, label: str, note: str, assumptions: dict,
                  restored_from: Optional[str] = None) -> ScenarioVersionEntity:
    changes = head_change_set(db, scn.id)
    latest = _latest_version(db, scn.id)
    number = (latest.number if latest else 0) + 1
    v = ScenarioVersionEntity(
        id=f"ver_{uuid.uuid4().hex[:12]}", scenario_id=scn.id, number=number, label=label or f"Version {number}",
        note=note, parent_version_id=latest.id if latest else None, restored_from_version_id=restored_from,
        baseline_id=scn.baseline_id or BASE, baseline_fingerprint=baseline_fingerprint(db, scn.baseline_id or BASE),
        change_set_hash=change_set_hash(changes), change_count=len(changes), assumptions_json=_canon(assumptions or {}),
    )
    db.add(v)
    for c in changes:
        o = c.get("object") or {}
        db.add(ScenarioVersionChangeEntity(
            version_id=v.id, object_id=c["objectId"], op=c["op"], seq=c["seq"], type=o.get("type"), name=o.get("name"),
            layer_id=o.get("layerId"), geometry_geojson=json.dumps(o["coordinates"]) if o else None,
            properties_json=json.dumps(o.get("properties", {})) if o else None))
    return v


def _next_seq(db: Session, sid: str) -> int:
    m = db.query(func.max(ScenarioObjectChangeEntity.seq)).filter(ScenarioObjectChangeEntity.scenario_id == sid).scalar()
    return (m or 0) + 1


def _replace_head(db: Session, sid: str, changes: List[dict]) -> None:
    """Makes the proposal's head exactly `changes` (adds, modifies, deletes). Baseline rows are not touched."""
    add_ids = [c["objectId"] for c in changes if c["op"] == "add"]
    # An add's id must not be another scenario's row (or a base row)
    for i in range(0, len(add_ids), 500):
        clash = (db.query(CityObjectEntity.id, CityObjectEntity.scenario_id)
                 .filter(CityObjectEntity.id.in_(add_ids[i:i + 500]), CityObjectEntity.scenario_id != sid).first())
        if clash:
            raise HTTPException(status_code=409, detail=f"Object id {clash[0]} now belongs to scenario {clash[1]}")
    db.query(CityObjectEntity).filter(CityObjectEntity.scenario_id == sid).delete(synchronize_session=False)
    db.query(ScenarioObjectChangeEntity).filter(ScenarioObjectChangeEntity.scenario_id == sid).delete(synchronize_session=False)
    seq = 0
    for c in changes:
        o = c.get("object") or {}
        if c["op"] == "add":
            db.add(CityObjectEntity(id=c["objectId"], type=o["type"], name=o["name"], layer_id=o["layerId"], scenario_id=sid,
                                    geometry_geojson=json.dumps(o["coordinates"]), properties_json=json.dumps(o.get("properties", {}))))
        else:
            seq += 1
            db.add(ScenarioObjectChangeEntity(
                scenario_id=sid, object_id=c["objectId"], op=c["op"], seq=seq, type=o.get("type"), name=o.get("name"),
                layer_id=o.get("layerId"), geometry_geojson=json.dumps(o["coordinates"]) if o else None,
                properties_json=json.dumps(o.get("properties", {})) if o else None))


# ── Change sets ──────────────────────────────────────────────────────────────────────────────────────────────────

@router.get("/scenario-changes")
def list_changes(scenario_id: Optional[str] = None, db: Session = Depends(get_db)):
    """Modifies and deletes of base objects (all proposals, or one). Adds are the proposal's rows of /objects."""
    q = db.query(ScenarioObjectChangeEntity)
    if scenario_id:
        q = q.filter(ScenarioObjectChangeEntity.scenario_id == scenario_id)
    out = []
    for c in q.order_by(ScenarioObjectChangeEntity.scenario_id, ScenarioObjectChangeEntity.seq):
        item = {"scenarioId": c.scenario_id, "objectId": c.object_id, "op": c.op, "seq": c.seq}
        if c.op == "modify":
            item["object"] = _object_dict(c.object_id, c.type, c.name, c.layer_id, c.scenario_id, c.geometry_geojson, c.properties_json)
        out.append(item)
    return out


@router.post("/scenarios/{sid}/changes")
def write_changes(sid: str, changes: List[ChangeIn], db: Session = Depends(get_db)):
    """Records a proposal's modifies/tombstones of base objects, or reverts them. Base rows are never written."""
    _proposal(db, sid)
    ids = list({c.objectId for c in changes})
    base_ids = set()
    for i in range(0, len(ids), 500):
        base_ids |= {r[0] for r in db.query(CityObjectEntity.id).filter(CityObjectEntity.id.in_(ids[i:i + 500]), CityObjectEntity.scenario_id == BASE)}
    seq = _next_seq(db, sid)
    for c in changes:
        if c.op != "revert" and c.objectId not in base_ids:
            raise HTTPException(status_code=400, detail=f"{c.objectId} is not a baseline object: a proposal's own objects are saved through /objects")
        row = db.get(ScenarioObjectChangeEntity, (sid, c.objectId))
        if c.op == "revert":
            if row:
                db.delete(row)
            continue
        if c.op == "modify":
            if not c.object or c.object.id != c.objectId:
                raise HTTPException(status_code=400, detail="A modify needs the whole object, with the same id")
        o = c.object
        if not row:
            row = ScenarioObjectChangeEntity(scenario_id=sid, object_id=c.objectId)
            db.add(row)
        row.op, row.seq = c.op, seq
        seq += 1
        row.type = o.type if o else None
        row.name = o.name if o else None
        row.layer_id = o.layerId if o else None
        row.geometry_geojson = json.dumps(o.coordinates) if o else None
        row.properties_json = json.dumps(o.properties) if o else None
        row.updated_at = datetime.datetime.utcnow()
        db.flush()
    db.commit()
    return {"status": "success", "count": len(changes)}


@router.get("/scenarios/{sid}/change-set")
def get_change_set(sid: str, db: Session = Depends(get_db)):
    scn = _proposal(db, sid)
    changes = head_change_set(db, sid)
    return {"scenarioId": sid, "baselineId": scn.baseline_id or BASE, "changeSetHash": change_set_hash(changes), "changes": changes}


@router.post("/scenarios/{sid}/fork", status_code=status.HTTP_201_CREATED)
def fork_scenario(sid: str, body: ForkIn, db: Session = Depends(get_db)):
    """A new proposal on the same baseline with a copy of `sid`'s change set (sid 'base' gives an empty proposal).
    Modifies and deletes keep the base object's id; the source's own objects get new ids (stem__newId)."""
    if db.get(ScenarioEntity, body.id):
        raise HTTPException(status_code=409, detail="Scenario id exists")
    changes: List[dict] = []
    if sid != BASE:
        _proposal(db, sid)
        for c in head_change_set(db, sid):
            c = json.loads(json.dumps(c))
            if c["op"] == "add":
                new_id = f"{c['objectId'].split('__')[0]}__{body.id}"
                c["objectId"] = new_id
                c["object"]["id"] = new_id
            changes.append(c)
    db.add(ScenarioEntity(id=body.id, name=body.name, description=body.description, year=body.year, kind="proposal",
                          baseline_id=BASE, parent_scenario_id=sid if sid != BASE else None))
    db.flush()
    _replace_head(db, body.id, changes)
    db.commit()
    return {"id": body.id, "parentScenarioId": sid if sid != BASE else None, "changes": head_change_set(db, body.id)}


@router.get("/scenarios/{sid}/materialised")
def materialise_head(sid: str, db: Session = Depends(get_db)):
    """baseline ⊕ head change set: every object the proposal shows."""
    scn = _proposal(db, sid)
    return _materialise(db, scn.baseline_id or BASE, head_change_set(db, sid))


def _materialise(db: Session, baseline_id: str, changes: List[dict]) -> List[dict]:
    by_id = {c["objectId"]: c for c in changes}
    out = []
    for e in db.query(CityObjectEntity).filter(CityObjectEntity.scenario_id == baseline_id).order_by(CityObjectEntity.id):
        c = by_id.get(e.id)
        if c is None:
            out.append(_object_dict(e.id, e.type, e.name, e.layer_id, baseline_id, e.geometry_geojson, e.properties_json))
        elif c["op"] == "modify":
            out.append(c["object"])
        # delete: tombstone, not shown
    out.extend(c["object"] for c in changes if c["op"] == "add")
    return out


# ── Versions ─────────────────────────────────────────────────────────────────────────────────────────────────────

@router.post("/scenarios/{sid}/versions", status_code=status.HTTP_201_CREATED)
def save_version(sid: str, body: VersionIn, db: Session = Depends(get_db)):
    scn = _proposal(db, sid)
    v = _save_version(db, scn, body.label.strip(), body.note.strip(), body.assumptions)
    db.commit()
    return _version_dict(v)


@router.get("/scenarios/{sid}/versions")
def list_versions(sid: str, db: Session = Depends(get_db)):
    _proposal(db, sid)
    head = change_set_hash(head_change_set(db, sid))
    versions = (db.query(ScenarioVersionEntity).filter(ScenarioVersionEntity.scenario_id == sid)
                .order_by(ScenarioVersionEntity.number.desc()).all())
    return {"scenarioId": sid, "headChangeSetHash": head, "baselineFingerprint": baseline_fingerprint(db),
            "versions": [_version_dict(v) for v in versions]}


@router.get("/scenario-versions/{vid}")
def get_version(vid: str, db: Session = Depends(get_db)):
    v = db.get(ScenarioVersionEntity, vid)
    if not v:
        raise HTTPException(status_code=404, detail="Version not found")
    return {**_version_dict(v), "changes": _version_changes(db, vid, v.scenario_id)}


@router.get("/scenario-versions/{vid}/objects")
def materialise_version(vid: str, db: Session = Depends(get_db)):
    """baseline (as it is now) ⊕ the version's change set. The version's baseline fingerprint says whether the
    baseline has changed since the version was saved (`baselineChanged`)."""
    v = db.get(ScenarioVersionEntity, vid)
    if not v:
        raise HTTPException(status_code=404, detail="Version not found")
    now = baseline_fingerprint(db, v.baseline_id)
    return {"versionId": vid, "baselineChanged": now != v.baseline_fingerprint,
            "objects": _materialise(db, v.baseline_id, _version_changes(db, vid, v.scenario_id))}


@router.post("/scenario-versions/{vid}/restore")
def restore_version(vid: str, body: Optional[VersionIn] = None, db: Session = Depends(get_db)):
    """Makes the version's change set the proposal's head again. The current head is first saved as a version when it
    is not already one (nothing is lost), then a new version records the restore. No version is edited or removed."""
    v = db.get(ScenarioVersionEntity, vid)
    if not v:
        raise HTTPException(status_code=404, detail="Version not found")
    scn = _proposal(db, v.scenario_id)
    assumptions = (body.assumptions if body else {}) or {}
    latest = _latest_version(db, scn.id)
    auto = None
    if not latest or latest.change_set_hash != change_set_hash(head_change_set(db, scn.id)):
        auto = _save_version(db, scn, "Unsaved changes before restore", f"Saved automatically before restoring version {v.number}", assumptions)
        db.flush()
    _replace_head(db, scn.id, _version_changes(db, vid, scn.id))
    db.flush()
    # The restored version's assumptions come back with it
    new = _save_version(db, scn, f"Restored version {v.number}", (body.note if body else "") or f"Restore of {v.label}",
                        _load(v.assumptions_json, {}), restored_from=v.id)
    db.commit()
    return {"autoSaved": _version_dict(auto) if auto else None, "version": _version_dict(new),
            "changes": head_change_set(db, scn.id)}


# ── Runs: frozen inputs ──────────────────────────────────────────────────────────────────────────────────────────

# Inputs that must match for a fair comparison (mission §13). Anything else in `inputs` is listed if it differs too.
FAIR_KEYS = ["demandKey", "demandVersion", "trips", "plannedVph", "hour", "hourFactor", "dayType", "seeds", "warmupS",
             "measureS", "signalTiming", "signalSource", "demandLevel", "networkCorrections", "engineVersion"]


def _run_dict(r: ScenarioRunEntity) -> dict:
    return {"id": r.id, "scenarioId": r.scenario_id, "scenarioVersionId": r.scenario_version_id,
            "changeSetHash": r.change_set_hash, "baselineFingerprint": r.baseline_fingerprint,
            "inputs": _load(r.inputs_json, {}), "results": _load(r.results_json, None),
            "createdAt": r.created_at.isoformat() + "Z" if r.created_at else None}


@router.post("/runs", status_code=status.HTTP_201_CREATED)
def record_run(body: RunIn, db: Session = Depends(get_db)):
    """Stores a run's frozen inputs with the scenario state it ran on (change-set hash, baseline fingerprint)."""
    if body.scenarioId == BASE:
        cs_hash = change_set_hash([])
    else:
        _proposal(db, body.scenarioId)
        cs_hash = change_set_hash(head_change_set(db, body.scenarioId))
    if body.scenarioVersionId and not db.get(ScenarioVersionEntity, body.scenarioVersionId):
        raise HTTPException(status_code=404, detail="Version not found")
    r = ScenarioRunEntity(id=f"run_{uuid.uuid4().hex[:12]}", scenario_id=body.scenarioId, scenario_version_id=body.scenarioVersionId,
                          change_set_hash=cs_hash, baseline_fingerprint=baseline_fingerprint(db), inputs_json=_canon(body.inputs),
                          results_json=_canon(body.results) if body.results is not None else None)
    db.add(r)
    db.commit()
    return _run_dict(r)


@router.get("/runs")
def list_runs(scenario_id: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(ScenarioRunEntity)
    if scenario_id:
        q = q.filter(ScenarioRunEntity.scenario_id == scenario_id)
    return [_run_dict(r) for r in q.order_by(ScenarioRunEntity.created_at.desc()).limit(200)]


@router.get("/runs/{rid}")
def get_run(rid: str, db: Session = Depends(get_db)):
    r = db.get(ScenarioRunEntity, rid)
    if not r:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_dict(r)


def assumption_differences(a: dict, b: dict) -> List[dict]:
    """Every input that differs between two runs, fairness-critical keys first."""
    keys = FAIR_KEYS + sorted((set(a) | set(b)) - set(FAIR_KEYS))
    out = []
    for k in keys:
        if k not in a and k not in b:
            continue
        if _canon(a.get(k)) != _canon(b.get(k)):
            out.append({"field": k, "a": a.get(k), "b": b.get(k), "fairnessCritical": k in FAIR_KEYS})
    return out


@router.post("/runs/compare")
def compare_runs(body: CompareIn, db: Session = Depends(get_db)):
    ra, rb = db.get(ScenarioRunEntity, body.runA), db.get(ScenarioRunEntity, body.runB)
    if not ra or not rb:
        raise HTTPException(status_code=404, detail="Run not found")
    diffs = assumption_differences(_load(ra.inputs_json, {}), _load(rb.inputs_json, {}))
    same_baseline = ra.baseline_fingerprint == rb.baseline_fingerprint
    return {"runA": _run_dict(ra), "runB": _run_dict(rb), "sameBaseline": same_baseline,
            "fair": same_baseline and not any(d["fairnessCritical"] for d in diffs), "differences": diffs}
