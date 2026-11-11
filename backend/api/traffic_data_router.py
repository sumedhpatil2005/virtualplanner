"""
/api/traffic-data — Traffic Data Manager (docs/TRAFFIC_DATA.md).

Datasets with provenance, count records (road-direction, junction approach,
turning movement; any period; by vehicle class), vehicle classes, versioned PCU
factor sets, CSV/XLSX import (preview → mapping → commit) and an audit trail.

Counts are evidence about traffic at a place. Nothing here turns them into
demand: the engine reads them for validation/calibration only (GET /counts).
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from database.connection import get_db
from models.models import CityObjectEntity
from traffic_data import core, importer
from traffic_data.models import (
    CountRecordEntity, PcuFactorSetEntity, TrafficDataAuditEntity, TrafficDatasetEntity, VehicleClassEntity,
)

router = APIRouter(prefix="/traffic-data", tags=["traffic-data"])

DRIVABLE = ("road", "flyover", "metro_flyover")

Kind = Literal["measured", "estimated", "manual"]
Role = Literal["validation", "calibration", "unused"]


# ── schemas ────────────────────────────────────────────────────────────────────

class DatasetIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    provider: str = Field(min_length=1, max_length=300, description="Data source or provider")
    kind: Kind
    method: str = Field(default="", max_length=300)
    collected_from: Optional[str] = None
    collected_to: Optional[str] = None
    location_desc: str = Field(min_length=1, max_length=500)
    period_desc: str = Field(min_length=1, max_length=300)
    classification: str = Field(min_length=1, max_length=300)
    assumptions: str = Field(default="", max_length=4000)
    adjustments: str = Field(default="", max_length=4000)
    pcu_factor_set_id: Optional[int] = None
    role: Role = "unused"
    entered_by: str = Field(min_length=1, max_length=120)
    synthetic: bool = False

    @field_validator("collected_from", "collected_to")
    @classmethod
    def _date(cls, v):
        if v in (None, ""):
            return None
        import datetime
        datetime.date.fromisoformat(v)
        return v


class DatasetPatch(BaseModel):
    """Edits are audited; entered_by here is who made the edit."""
    edited_by: str = Field(min_length=1, max_length=120)
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    provider: Optional[str] = Field(default=None, min_length=1)
    kind: Optional[Kind] = None
    method: Optional[str] = None
    collected_from: Optional[str] = None
    collected_to: Optional[str] = None
    location_desc: Optional[str] = Field(default=None, min_length=1)
    period_desc: Optional[str] = Field(default=None, min_length=1)
    classification: Optional[str] = Field(default=None, min_length=1)
    assumptions: Optional[str] = None
    adjustments: Optional[str] = None
    pcu_factor_set_id: Optional[int] = None
    role: Optional[Role] = None


class RecordIn(BaseModel):
    ref_kind: str
    road_id: Optional[str] = None
    direction: Optional[str] = None
    direction_label: str = ""
    junction_ref: Optional[str] = None
    approach_road_id: Optional[str] = None
    from_road_id: Optional[str] = None
    to_road_id: Optional[str] = None
    turn: Optional[str] = None
    day_type: str
    count_date: Optional[str] = None
    period_start: str
    period_end: str
    class_counts: dict[str, Any] = Field(default_factory=dict)
    total_count: Optional[Any] = None
    lon: Optional[float] = None
    lat: Optional[float] = None
    quality_flag: str = ""
    notes: str = ""


class RecordsIn(BaseModel):
    entered_by: str = Field(min_length=1, max_length=120)
    records: list[RecordIn] = Field(min_length=1, max_length=5000)


class VehicleClassIn(BaseModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{1,40}$")
    label: str = Field(min_length=1, max_length=80)
    description: str = ""
    created_by: str = Field(min_length=1, max_length=120)


class PcuSetIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    context: Literal["midblock", "signalised", "other"] = "midblock"
    source_citation: str = Field(min_length=1, max_length=4000, description="Where the factors come from; 'user judgement' must be said as such")
    source_url: str = ""
    assumptions: str = ""
    factors: dict[str, float]
    created_by: str = Field(min_length=1, max_length=120)
    change_note: str = Field(default="", max_length=2000)

    @field_validator("factors")
    @classmethod
    def _positive(cls, v):
        if not v:
            raise ValueError("at least one factor")
        for k, f in v.items():
            if not (f > 0 and f < 20):
                raise ValueError(f"factor for {k} must be > 0 and < 20")
        return v


class ImportIn(BaseModel):
    file_name: str = Field(min_length=1, max_length=260)
    content_base64: str
    sheet: Optional[str] = None
    mapping: Optional[dict[str, str]] = None  # column → field ('class:<code>' for classes)
    defaults: dict[str, Any] = Field(default_factory=dict)  # field → value for every row (e.g. day_type)


class ImportCommitIn(ImportIn):
    mapping: dict[str, str]
    dataset: DatasetIn
    skip_invalid: bool = False  # commit valid rows only; rejected rows are kept in the import report


# ── helpers ───────────────────────────────────────────────────────────────────

def _dt(v):
    return v.isoformat() + "Z" if v else None


def _audit(db: Session, entity: str, entity_id: str, action: str, actor: str, before=None, after=None):
    db.add(TrafficDataAuditEntity(entity=entity, entity_id=str(entity_id), action=action, actor=actor,
                                  before_json=None if before is None else json.dumps(before, default=str),
                                  after_json=None if after is None else json.dumps(after, default=str)))


def _class_codes(db: Session) -> list[str]:
    return [c.code for c in db.query(VehicleClassEntity).order_by(VehicleClassEntity.sort_order).all()]


def _road_checker(db: Session):
    cache: dict[str, bool] = {}

    def exists(rid: str) -> bool:
        if rid not in cache:
            o = db.get(CityObjectEntity, rid)
            cache[rid] = o is not None and o.type in DRIVABLE
        return cache[rid]
    return exists


def _pcu_out(s: PcuFactorSetEntity, latest: bool | None = None) -> dict:
    return {"id": s.id, "set_key": s.set_key, "version": s.version, "name": s.name, "context": s.context,
            "source_citation": s.source_citation, "source_url": s.source_url, "assumptions": s.assumptions,
            "factors": json.loads(s.factors_json), "change_note": s.change_note, "builtin": s.builtin,
            "created_by": s.created_by, "created_at": _dt(s.created_at), "latest": latest}


def _dataset_out(d: TrafficDatasetEntity, n_records: int | None = None) -> dict:
    return {"id": d.id, "name": d.name, "provider": d.provider, "kind": d.kind, "method": d.method,
            "collected_from": d.collected_from, "collected_to": d.collected_to, "location_desc": d.location_desc,
            "period_desc": d.period_desc, "classification": d.classification, "assumptions": d.assumptions,
            "adjustments": d.adjustments, "pcu_factor_set_id": d.pcu_factor_set_id, "role": d.role,
            "entered_by": d.entered_by, "imported_file_name": d.imported_file_name,
            "imported_file_sha256": d.imported_file_sha256,
            "import_report": json.loads(d.import_report_json) if d.import_report_json else None,
            "synthetic": bool(d.synthetic), "created_at": _dt(d.created_at), "updated_at": _dt(d.updated_at),
            "record_count": n_records}


def _record_dict(r: CountRecordEntity) -> dict:
    return {"id": r.id, "dataset_id": r.dataset_id, "ref_kind": r.ref_kind, "road_id": r.road_id,
            "direction": r.direction, "direction_label": r.direction_label or "", "junction_ref": r.junction_ref,
            "approach_road_id": r.approach_road_id, "from_road_id": r.from_road_id, "to_road_id": r.to_road_id,
            "turn": r.turn, "day_type": r.day_type, "count_date": r.count_date, "period_start": r.period_start,
            "period_end": r.period_end, "class_counts": json.loads(r.class_counts_json or "{}"),
            "total_count": r.total_count, "lon": float(r.lon) if r.lon else None, "lat": float(r.lat) if r.lat else None,
            "quality_flag": r.quality_flag or "", "notes": r.notes or "", "source_row": r.source_row}


def _with_rates(rec: dict, factors: dict | None, set_name: str) -> dict:
    rec = dict(rec)
    rec["vehicles"] = core.vehicles(rec)
    rec["period_minutes"] = core.period_minutes(rec["period_start"], rec["period_end"])
    rec["veh_h"] = core.veh_per_hour(rec)
    rec["pcu_h"], rec["pcu_note"] = core.pcu_per_hour(rec, factors, set_name)
    return rec


def _factors_of(db: Session, d: TrafficDatasetEntity) -> tuple[dict | None, str, dict | None]:
    if d.pcu_factor_set_id is None:
        return None, "", None
    s = db.get(PcuFactorSetEntity, d.pcu_factor_set_id)
    if s is None:
        return None, "", None
    return json.loads(s.factors_json), f"{s.name} (v{s.version})", _pcu_out(s)


def _entity_from(rec: dict, dataset_id: str, source_row: int | None = None) -> CountRecordEntity:
    return CountRecordEntity(
        dataset_id=dataset_id, ref_kind=rec["ref_kind"], road_id=rec.get("road_id"), direction=rec.get("direction"),
        direction_label=rec.get("direction_label") or "", junction_ref=rec.get("junction_ref"),
        approach_road_id=rec.get("approach_road_id"), from_road_id=rec.get("from_road_id"),
        to_road_id=rec.get("to_road_id"), turn=rec.get("turn") or None, day_type=rec["day_type"],
        count_date=rec.get("count_date") or None,
        period_start=core.fmt_minutes(core.parse_minutes(rec["period_start"])),
        period_end=core.fmt_minutes(core.parse_minutes(rec["period_end"])),
        class_counts_json=json.dumps(rec.get("class_counts") or {}, sort_keys=True),
        total_count=rec.get("total_count"), lon=None if rec.get("lon") in (None, "") else str(rec["lon"]),
        lat=None if rec.get("lat") in (None, "") else str(rec["lat"]), quality_flag=rec.get("quality_flag") or "",
        notes=rec.get("notes") or "", source_row=source_row)


def _check_pcu_set(db: Session, set_id: Optional[int]):
    if set_id is not None and db.get(PcuFactorSetEntity, set_id) is None:
        raise HTTPException(status_code=422, detail=f"PCU factor set {set_id} does not exist")


def _get_dataset(db: Session, dataset_id: str) -> TrafficDatasetEntity:
    d = db.get(TrafficDatasetEntity, dataset_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return d


# ── vehicle classes & PCU sets ────────────────────────────────────────────────

@router.get("/vehicle-classes")
def list_classes(db: Session = Depends(get_db)):
    return [{"code": c.code, "label": c.label, "description": c.description, "builtin": c.builtin, "sort_order": c.sort_order}
            for c in db.query(VehicleClassEntity).order_by(VehicleClassEntity.sort_order, VehicleClassEntity.code).all()]


@router.post("/vehicle-classes", status_code=status.HTTP_201_CREATED)
def add_class(body: VehicleClassIn, db: Session = Depends(get_db)):
    if db.get(VehicleClassEntity, body.code):
        raise HTTPException(status_code=409, detail="A vehicle class with this code exists")
    c = VehicleClassEntity(code=body.code, label=body.label, description=body.description, sort_order=100, builtin=False, created_by=body.created_by)
    db.add(c)
    _audit(db, "vehicle_class", body.code, "create", body.created_by, after=body.model_dump())
    db.commit()
    return {"code": c.code, "label": c.label, "description": c.description, "builtin": False, "sort_order": 100}


@router.get("/pcu-sets")
def list_pcu_sets(db: Session = Depends(get_db)):
    rows = db.query(PcuFactorSetEntity).order_by(PcuFactorSetEntity.set_key, PcuFactorSetEntity.version).all()
    latest = {}
    for s in rows:
        latest[s.set_key] = max(latest.get(s.set_key, 0), s.version)
    return [_pcu_out(s, s.version == latest[s.set_key]) for s in rows]


def _validate_factor_classes(db: Session, factors: dict):
    unknown = sorted(set(factors) - set(_class_codes(db)))
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown vehicle classes: {', '.join(unknown)}")


@router.post("/pcu-sets", status_code=status.HTTP_201_CREATED)
def create_pcu_set(body: PcuSetIn, db: Session = Depends(get_db)):
    _validate_factor_classes(db, body.factors)
    key = "user-" + uuid.uuid4().hex[:10]
    s = PcuFactorSetEntity(set_key=key, version=1, name=body.name, context=body.context, source_citation=body.source_citation,
                           source_url=body.source_url, assumptions=body.assumptions, factors_json=json.dumps(body.factors, sort_keys=True),
                           change_note=body.change_note or "created", builtin=False, created_by=body.created_by)
    db.add(s)
    db.flush()
    _audit(db, "pcu_set", str(s.id), "create", body.created_by, after=_pcu_out(s))
    db.commit()
    return _pcu_out(s, True)


@router.post("/pcu-sets/{set_key}/versions", status_code=status.HTTP_201_CREATED)
def new_pcu_version(set_key: str, body: PcuSetIn, db: Session = Depends(get_db)):
    """An edit of a factor set: a new version; earlier versions (and datasets pointing at them) are untouched."""
    prev = db.query(PcuFactorSetEntity).filter_by(set_key=set_key).order_by(PcuFactorSetEntity.version.desc()).first()
    if prev is None:
        raise HTTPException(status_code=404, detail="PCU factor set not found")
    if not body.change_note.strip():
        raise HTTPException(status_code=422, detail="change_note is required: say what changed and why")
    _validate_factor_classes(db, body.factors)
    s = PcuFactorSetEntity(set_key=set_key, version=prev.version + 1, name=body.name, context=body.context,
                           source_citation=body.source_citation, source_url=body.source_url, assumptions=body.assumptions,
                           factors_json=json.dumps(body.factors, sort_keys=True), change_note=body.change_note,
                           builtin=False, created_by=body.created_by)
    db.add(s)
    db.flush()
    _audit(db, "pcu_set", str(s.id), "create_version", body.created_by, before=_pcu_out(prev), after=_pcu_out(s))
    db.commit()
    return _pcu_out(s, True)


class ConvertIn(BaseModel):
    pcu_factor_set_id: int
    class_counts: dict[str, int]
    period_minutes: int = Field(default=60, gt=0, le=1440)


@router.post("/pcu/convert")
def convert(body: ConvertIn, db: Session = Depends(get_db)):
    s = db.get(PcuFactorSetEntity, body.pcu_factor_set_id)
    if s is None:
        raise HTTPException(status_code=404, detail="PCU factor set not found")
    if any(not core.is_count(v) for v in body.class_counts.values()):
        raise HTTPException(status_code=422, detail="class counts must be whole numbers ≥ 0")
    name = f"{s.name} (v{s.version})"
    try:
        p = core.pcu(body.class_counts, json.loads(s.factors_json), name)
    except core.MissingPcuFactor as ex:
        raise HTTPException(status_code=422, detail=str(ex)) from ex
    veh = sum(body.class_counts.values())
    k = 60.0 / body.period_minutes
    return {"vehicles": veh, "pcu": p, "veh_h": veh * k, "pcu_h": p * k, "factor_set": _pcu_out(s)}


# ── datasets ──────────────────────────────────────────────────────────────────

@router.get("/datasets")
def list_datasets(db: Session = Depends(get_db)):
    out = []
    for d in db.query(TrafficDatasetEntity).order_by(TrafficDatasetEntity.created_at.desc()).all():
        n = db.query(CountRecordEntity).filter_by(dataset_id=d.id).count()
        out.append(_dataset_out(d, n))
    return out


@router.post("/datasets", status_code=status.HTTP_201_CREATED)
def create_dataset(body: DatasetIn, db: Session = Depends(get_db)):
    _check_pcu_set(db, body.pcu_factor_set_id)
    d = TrafficDatasetEntity(id="tds_" + uuid.uuid4().hex[:12], **body.model_dump())
    db.add(d)
    _audit(db, "dataset", d.id, "create", body.entered_by, after=body.model_dump())
    db.commit()
    return _dataset_out(d, 0)


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str, db: Session = Depends(get_db)):
    d = _get_dataset(db, dataset_id)
    factors, set_name, pcu_set = _factors_of(db, d)
    recs = [_with_rates(_record_dict(r), factors, set_name)
            for r in db.query(CountRecordEntity).filter_by(dataset_id=d.id).order_by(CountRecordEntity.id).all()]
    return {**_dataset_out(d, len(recs)), "pcu_set": pcu_set, "records": recs}


@router.patch("/datasets/{dataset_id}")
def patch_dataset(dataset_id: str, body: DatasetPatch, db: Session = Depends(get_db)):
    d = _get_dataset(db, dataset_id)
    changes = body.model_dump(exclude_unset=True)
    actor = changes.pop("edited_by")
    if "pcu_factor_set_id" in changes:
        _check_pcu_set(db, changes["pcu_factor_set_id"])
    before = _dataset_out(d)
    for k, v in changes.items():
        setattr(d, k, v)
    _audit(db, "dataset", d.id, "update", actor, before={k: before[k] for k in changes}, after=changes)
    db.commit()
    return _dataset_out(d, db.query(CountRecordEntity).filter_by(dataset_id=d.id).count())


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str, deleted_by: str = Query(min_length=1), db: Session = Depends(get_db)):
    d = _get_dataset(db, dataset_id)
    recs = db.query(CountRecordEntity).filter_by(dataset_id=d.id).all()
    _audit(db, "dataset", d.id, "delete", deleted_by, before={**_dataset_out(d, len(recs)), "records": [_record_dict(r) for r in recs]})
    for r in recs:
        db.delete(r)
    db.delete(d)
    db.commit()
    return {"status": "deleted", "records": len(recs)}


@router.get("/datasets/{dataset_id}/audit")
def dataset_audit(dataset_id: str, db: Session = Depends(get_db)):
    rec_ids = [str(r.id) for r in db.query(CountRecordEntity.id).filter_by(dataset_id=dataset_id).all()]
    q = db.query(TrafficDataAuditEntity).filter(
        ((TrafficDataAuditEntity.entity == "dataset") & (TrafficDataAuditEntity.entity_id == dataset_id))
        | ((TrafficDataAuditEntity.entity == "record") & (TrafficDataAuditEntity.entity_id.in_(rec_ids or ["-"]))))
    return [{"entity": a.entity, "entity_id": a.entity_id, "action": a.action, "actor": a.actor, "at": _dt(a.at),
             "before": json.loads(a.before_json) if a.before_json else None,
             "after": json.loads(a.after_json) if a.after_json else None} for a in q.order_by(TrafficDataAuditEntity.id).all()]


# ── records ───────────────────────────────────────────────────────────────────

@router.post("/datasets/{dataset_id}/records", status_code=status.HTTP_201_CREATED)
def add_records(dataset_id: str, body: RecordsIn, db: Session = Depends(get_db)):
    """Manual entry. All-or-nothing: if any record is invalid, nothing is saved and every problem is returned."""
    d = _get_dataset(db, dataset_id)
    codes, exists = _class_codes(db), _road_checker(db)
    problems = []
    recs = [r.model_dump() for r in body.records]
    for i, rec in enumerate(recs):
        errs = core.validate_record(rec, codes, exists)
        if errs:
            problems.append({"index": i, "errors": errs})
    if problems:
        raise HTTPException(status_code=422, detail={"message": "records not saved", "problems": problems})
    factors, set_name, _ = _factors_of(db, d)
    saved = []
    for rec in recs:
        e = _entity_from(rec, d.id)
        db.add(e)
        db.flush()
        _audit(db, "record", str(e.id), "create", body.entered_by, after=_record_dict(e))
        saved.append(_with_rates(_record_dict(e), factors, set_name))
    db.commit()
    return saved


@router.put("/records/{record_id}")
def update_record(record_id: int, body: RecordIn, edited_by: str = Query(min_length=1), db: Session = Depends(get_db)):
    r = db.get(CountRecordEntity, record_id)
    if r is None:
        raise HTTPException(status_code=404, detail="Record not found")
    rec = body.model_dump()
    errs = core.validate_record(rec, _class_codes(db), _road_checker(db))
    if errs:
        raise HTTPException(status_code=422, detail={"message": "record not saved", "problems": [{"index": 0, "errors": errs}]})
    before = _record_dict(r)
    new = _entity_from(rec, r.dataset_id, r.source_row)
    for col in ("ref_kind", "road_id", "direction", "direction_label", "junction_ref", "approach_road_id", "from_road_id",
                "to_road_id", "turn", "day_type", "count_date", "period_start", "period_end", "class_counts_json",
                "total_count", "lon", "lat", "quality_flag", "notes"):
        setattr(r, col, getattr(new, col))
    _audit(db, "record", str(r.id), "update", edited_by, before=before, after=_record_dict(r))
    db.commit()
    return _record_dict(r)


@router.delete("/records/{record_id}")
def delete_record(record_id: int, deleted_by: str = Query(min_length=1), db: Session = Depends(get_db)):
    r = db.get(CountRecordEntity, record_id)
    if r is None:
        raise HTTPException(status_code=404, detail="Record not found")
    _audit(db, "record", str(r.id), "delete", deleted_by, before=_record_dict(r))
    db.delete(r)
    db.commit()
    return {"status": "deleted"}


@router.get("/datasets/{dataset_id}/hourly")
def dataset_hourly(dataset_id: str, road_id: Optional[str] = None, db: Session = Depends(get_db)):
    """Clock-hour flows per location and day type (weekday/weekend profile), with PCU/h by the dataset's factor set."""
    d = _get_dataset(db, dataset_id)
    q = db.query(CountRecordEntity).filter_by(dataset_id=d.id)
    if road_id:
        q = q.filter((CountRecordEntity.road_id == road_id) | (CountRecordEntity.approach_road_id == road_id)
                     | (CountRecordEntity.from_road_id == road_id))
    recs = [_record_dict(r) for r in q.all()]
    factors, set_name, _ = _factors_of(db, d)
    rows = core.hourly(recs)
    for h in rows:
        h["key"] = dict(zip(("ref_kind", "road_id", "direction", "junction_ref", "approach_road_id", "from_road_id", "to_road_id"), h["key"]))
        if h["veh_h"] is not None and h["class_counts"]:
            p, note = core.pcu_per_hour({"class_counts": h["class_counts"], "period_start": "00:00",
                                         "period_end": core.fmt_minutes(h["minutes"])}, factors, set_name)
            h["pcu_h"], h["pcu_note"] = p, note
        else:
            h["pcu_h"], h["pcu_note"] = None, ("incomplete hour" if h["veh_h"] is None else "unclassified count")
    return {"dataset": _dataset_out(d, len(recs)), "pcu_set_name": set_name or None, "hours": rows}


# ── counts for the engine (validation / calibration evidence) ─────────────────

@router.get("/counts")
def counts_for_engine(
    role: Optional[Role] = None,
    kinds: str = Query(default="measured", description="comma list of measured,estimated,manual; a combination must be asked for"),
    dataset_ids: Optional[str] = None,
    day_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """Clock-hour count rows for the engine, one row per dataset × location × hour.

    Rows are never merged across datasets: two datasets counting the same road
    give two rows, each labelled with its dataset kind.
    """
    wanted = [k for k in kinds.split(",") if k]
    bad = [k for k in wanted if k not in core.KINDS]
    if bad:
        raise HTTPException(status_code=422, detail=f"unknown kinds: {', '.join(bad)}")
    q = db.query(TrafficDatasetEntity).filter(TrafficDatasetEntity.kind.in_(wanted))
    if role:
        q = q.filter(TrafficDatasetEntity.role == role)
    if dataset_ids:
        q = q.filter(TrafficDatasetEntity.id.in_(dataset_ids.split(",")))
    out = []
    for d in q.all():
        factors, set_name, _ = _factors_of(db, d)
        recs = [_record_dict(r) for r in db.query(CountRecordEntity).filter_by(dataset_id=d.id).all()]
        if day_type:
            recs = [r for r in recs if r["day_type"] == day_type]
        for h in core.hourly(recs):
            key = dict(zip(("ref_kind", "road_id", "direction", "junction_ref", "approach_road_id", "from_road_id", "to_road_id"), h["key"]))
            pcu_h = None
            if h["veh_h"] is not None and h["class_counts"]:
                pcu_h, _ = core.pcu_per_hour({"class_counts": h["class_counts"], "period_start": "00:00",
                                              "period_end": core.fmt_minutes(h["minutes"])}, factors, set_name)
            out.append({**key, "dataset_id": d.id, "dataset_name": d.name, "kind": d.kind, "role": d.role,
                        "synthetic": bool(d.synthetic), "day_type": h["day_type"], "count_date": h["count_date"],
                        "hour": h["hour"], "period": h["period"], "span": h["span"], "complete": h["complete"],
                        "minutes": h["minutes"], "veh_h": h["veh_h"], "pcu_h": pcu_h, "pcu_set_name": set_name or None,
                        "class_counts": h["class_counts"]})
    return out


# ── import ────────────────────────────────────────────────────────────────────

def _decode(b64: str) -> bytes:
    try:
        return base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as ex:
        raise HTTPException(status_code=422, detail="content_base64 is not valid base64") from ex


@router.post("/import/preview")
def import_preview(body: ImportIn, db: Session = Depends(get_db)):
    """Read the file, suggest a mapping, and (with a mapping) validate every row. Saves nothing."""
    data = _decode(body.content_base64)
    codes = _class_codes(db)
    try:
        header, rows, sheets = importer.read_table(body.file_name, data, body.sheet)
        mapping = body.mapping if body.mapping is not None else importer.suggest_mapping(header, codes)
        parsed = importer.parse_rows(header, rows, mapping, body.defaults, codes, _road_checker(db))
    except importer.ImportFileError as ex:
        raise HTTPException(status_code=422, detail=str(ex)) from ex
    invalid = [p for p in parsed if p["errors"]]
    return {
        "file_name": body.file_name, "sha256": importer.sha256(data), "sheets": sheets, "columns": header,
        "fields": importer.FIELDS, "class_codes": codes, "mapping": mapping, "suggested": body.mapping is None,
        "sample": [[importer._text(c) for c in r] for r in rows[:15]],
        "row_count": len(parsed), "valid_count": len(parsed) - len(invalid), "error_count": len(invalid),
        "rows": parsed[:200], "invalid_rows": invalid[:500],
    }


@router.post("/import/commit", status_code=status.HTTP_201_CREATED)
def import_commit(body: ImportCommitIn, db: Session = Depends(get_db)):
    """Create a dataset from a file. With invalid rows: refused unless skip_invalid, and then every rejected
    row is kept in the dataset's import report (never dropped silently, never fixed)."""
    data = _decode(body.content_base64)
    codes = _class_codes(db)
    _check_pcu_set(db, body.dataset.pcu_factor_set_id)
    try:
        header, rows, _ = importer.read_table(body.file_name, data, body.sheet)
        parsed = importer.parse_rows(header, rows, body.mapping, body.defaults, codes, _road_checker(db))
    except importer.ImportFileError as ex:
        raise HTTPException(status_code=422, detail=str(ex)) from ex
    invalid = [p for p in parsed if p["errors"]]
    valid = [p for p in parsed if not p["errors"]]
    if invalid and not body.skip_invalid:
        raise HTTPException(status_code=422, detail={"message": f"{len(invalid)} of {len(parsed)} rows are invalid; nothing imported",
                                                     "invalid_rows": invalid[:500]})
    if not valid:
        raise HTTPException(status_code=422, detail={"message": "no valid rows to import", "invalid_rows": invalid[:500]})
    report = {"file_name": body.file_name, "sha256": importer.sha256(data), "sheet": body.sheet, "mapping": body.mapping,
              "defaults": body.defaults, "rows_in_file": len(parsed), "imported": len(valid), "rejected": len(invalid),
              "rejected_rows": [{"row": p["row"], "errors": p["errors"]} for p in invalid]}
    d = TrafficDatasetEntity(id="tds_" + uuid.uuid4().hex[:12], **body.dataset.model_dump(),
                             imported_file_name=body.file_name, imported_file_sha256=report["sha256"],
                             import_report_json=json.dumps(report))
    db.add(d)
    for p in valid:
        db.add(_entity_from(p["record"], d.id, p["row"]))
    _audit(db, "dataset", d.id, "import", body.dataset.entered_by, after={**body.dataset.model_dump(), "import": {k: v for k, v in report.items() if k != "rejected_rows"}})
    db.commit()
    return _dataset_out(d, len(valid))


@router.get("/audit")
def audit_log(limit: int = Query(default=200, le=2000), db: Session = Depends(get_db)):
    return [{"entity": a.entity, "entity_id": a.entity_id, "action": a.action, "actor": a.actor, "at": _dt(a.at)}
            for a in db.query(TrafficDataAuditEntity).order_by(TrafficDataAuditEntity.id.desc()).limit(limit).all()]
