"""
The single append-only audit log, written by SQLAlchemy session hooks (docs/PLANNING_WORKSPACE.md §3).

Why session hooks instead of a call in every router: every create/update/delete of a tracked record goes through a
Session flush (or an ORM bulk statement), so one listener here covers the existing routers (scenarios, scenario
changes, versions, runs, traffic datasets, count records, PCU sets, feasibility assessments, evidence, documents,
reviews) and the planning router without editing them, and a new endpoint cannot forget to audit.

Each entry stores actor, action, entity type/id, parent, sha256 of the row's column values before and after, and the
time. Values themselves are not copied (no duplicate state): the hash lets anyone check a row against the log.
Actor: there is no authentication. It is taken from the `X-Actor` request header if the client sent one, else from
the record's own who-field (created_by, entered_by, uploaded_by, reviewer_name, ...), else from the traffic-data
audit row of the same flush; otherwise "unattributed". `actor_source` (header | request_field | record_field | td_audit | none) says which, so nobody mistakes it for identity.
"""
from __future__ import annotations

import contextlib
import contextvars
import datetime
import hashlib
import json
from typing import Any

from sqlalchemy import event, inspect, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.base import NO_VALUE

from .models import APPEND_ONLY_TRIGGERS, AuditLogEntity

# (actor, source): set by the X-Actor middleware ("header") or by a router from a request field ("request_field")
current_actor: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar("planning_actor", default=None)


@contextlib.contextmanager
def acting_as(name: str | None):
    """A who-field of the request (e.g. edited_by) names the actor of the writes inside, unless X-Actor was sent."""
    tok = current_actor.set(current_actor.get() or ((name, "request_field") if name else None))
    try:
        yield
    finally:
        current_actor.reset(tok)

# entity class name -> (entity_type, parent_type, parent attr, label attr, actor attrs)
_SPEC_BY_NAME: dict[str, tuple] = {
    "ScenarioEntity": ("scenario", None, None, "name", ()),
    "ScenarioObjectChangeEntity": ("scenario_change", "scenario", "scenario_id", "name", ()),
    "ScenarioVersionEntity": ("scenario_version", "scenario", "scenario_id", "label", ()),
    "ScenarioRunEntity": ("run", "scenario", "scenario_id", None, ()),
    "TrafficDatasetEntity": ("dataset", None, None, "name", ("entered_by",)),
    "CountRecordEntity": ("count_record", "dataset", "dataset_id", None, ()),
    "PcuFactorSetEntity": ("pcu_set", None, None, "name", ("created_by",)),
    "VehicleClassEntity": ("vehicle_class", None, None, "label", ("created_by",)),
    "FeasibilityAssessmentEntity": ("assessment", "scenario", "scenario_id", "name", ("created_by",)),
    "EvidenceEntity": ("evidence", "assessment", "assessment_id", "file_name", ("uploaded_by",)),
    "InvestigationDocumentEntity": ("document", "assessment", "assessment_id", "file_name", ("generated_by",)),
    "ReviewRecordEntity": ("review", "assessment", "assessment_id", "status", ("reviewer_name",)),
    "PlanningProjectEntity": ("project", None, None, "name", ("created_by",)),
    "PlanningProjectLinkEntity": ("project_link", "project", "project_id", "entity_type", ("added_by",)),
    "PlanningDecisionEntity": ("decision", "project", "project_id", None, ("decided_by",)),
}
TRACKED_TYPES = sorted({s[0] for s in _SPEC_BY_NAME.values()})
_TD_ENTITY = {"dataset": "dataset", "record": "count_record", "pcu_set": "pcu_set", "vehicle_class": "vehicle_class"}


def _spec(obj: Any):
    return _SPEC_BY_NAME.get(type(obj).__name__)


def _jsonable(v: Any) -> Any:
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    return v


def row_hash(values: dict) -> str:
    return "sha256:" + hashlib.sha256(json.dumps({k: _jsonable(v) for k, v in values.items()}, sort_keys=True,
                                                 separators=(",", ":"), default=str).encode()).hexdigest()


def _columns(obj: Any) -> list[str]:
    return [c.key for c in inspect(type(obj)).column_attrs]


def _after_values(obj: Any) -> dict:
    return {k: getattr(obj, k) for k in _columns(obj)}


def _before_values(obj: Any) -> tuple[dict, list[str]]:
    st = inspect(obj)
    vals, changed = {}, []
    for k in _columns(obj):
        h = st.attrs[k].history
        if h.deleted:
            vals[k] = h.deleted[0]
            changed.append(k)
        elif h.unchanged:
            vals[k] = h.unchanged[0]
        elif h.added:  # set from an unloaded / None value
            vals[k] = None
            changed.append(k)
        else:
            lv = st.attrs[k].loaded_value
            vals[k] = None if lv is NO_VALUE else lv
    return vals, changed


def _row_actor(values: dict, spec: tuple, action: str) -> tuple[str | None, str]:
    """Header / request field now; otherwise resolved at commit (traffic-data audit row of the same action, then for a
    create the record's own who-field). A record's who-field names its creator, so it never attributes an update/delete."""
    a = current_actor.get()
    if a:
        return a
    if action == "create":
        for attr in spec[4]:
            if values.get(attr):
                return None, "record_field:" + str(values[attr])
    return None, "none"


def _pk_of(cls, values: dict) -> str:
    return "/".join(str(values[c.key]) for c in inspect(cls).primary_key)


def _entry(cls, values: dict, action: str, before: dict | None, after: dict | None, changed: list[str] | None) -> dict:
    spec = _SPEC_BY_NAME[cls.__name__]
    actor, src = _row_actor(values, spec, action)
    label = values.get(spec[3]) if spec[3] else ""
    pid = values.get(spec[2]) if spec[2] else None
    return dict(at=datetime.datetime.utcnow(), actor=actor, actor_source=src, action=action, entity_type=spec[0],
                entity_id=_pk_of(cls, values), parent_type=spec[1], parent_id=str(pid) if pid is not None else None,
                label=str(label or "")[:200], changed_fields=json.dumps(changed) if changed else None,
                before_hash=row_hash(before) if before is not None else None, after_hash=row_hash(after) if after is not None else None)


def _pending(session: Session) -> list[dict]:
    return session.info.setdefault("_audit_pending", [])


@event.listens_for(Session, "before_flush")
def _before_flush(session: Session, flush_context, instances):  # noqa: ARG001
    td = session.info.setdefault("_audit_td", {})
    for o in session.new:
        if type(o).__name__ == "TrafficDataAuditEntity" and o.entity in _TD_ENTITY:
            td[(_TD_ENTITY[o.entity], str(o.entity_id))] = o.actor
    out = _pending(session)
    for o in session.dirty:
        if not _spec(o) or not session.is_modified(o, include_collections=False):
            continue
        before, changed = _before_values(o)
        after = _after_values(o)
        changed = [k for k in changed if k != "updated_at"]
        if changed and row_hash(before) != row_hash(after):
            out.append(_entry(type(o), after, "update", before, after, changed))
    for o in session.deleted:
        if _spec(o):
            before, _ = _before_values(o)
            out.append(_entry(type(o), before, "delete", before, None, None))
    session.info.setdefault("_audit_new", []).extend(o for o in session.new if _spec(o))


@event.listens_for(Session, "after_flush_postexec")
def _after_flush(session: Session, flush_context):  # noqa: ARG001
    """Creates are captured after the flush so autoincrement ids and column defaults are known."""
    out = _pending(session)
    for o in session.info.pop("_audit_new", []):
        if inspect(o).persistent:
            v = _after_values(o)
            out.append(_entry(type(o), v, "create", None, v, None))


@event.listens_for(Session, "do_orm_execute")
def _bulk(state):
    """ORM bulk DELETE/UPDATE (`query(...).delete()`) bypasses flush events: capture each affected row first.
    Rows are read as plain tuples (not entities), so nothing is added to the identity map."""
    if not (state.is_delete or state.is_update):
        return
    table = getattr(state.statement, "table", None)
    if table is None or table.name == "audit_log":
        return
    from database.connection import Base
    cls = next((m.class_ for m in Base.registry.mappers if m.local_table.name == table.name), None)
    if cls is None or cls.__name__ not in _SPEC_BY_NAME:
        return
    keys = [c.key for c in inspect(cls).column_attrs]
    q = select(*[getattr(cls, k) for k in keys])
    if state.statement.whereclause is not None:
        q = q.where(state.statement.whereclause)
    with state.session.no_autoflush:
        rows = state.session.connection().execute(q).all()
    out = _pending(state.session)
    for r in rows:
        v = dict(zip(keys, r))
        out.append(_entry(cls, v, "delete" if state.is_delete else "update", v, None, None))


@event.listens_for(Session, "before_commit")
def _before_commit(session: Session):
    session.flush()
    pend = session.info.pop("_audit_pending", [])
    td = session.info.pop("_audit_td", {})
    if not pend:
        return
    for e in pend:
        if e["actor"] is None:
            a = td.get((e["entity_type"], e["entity_id"])) or (td.get((e["parent_type"], e["parent_id"])) if e["parent_type"] else None)
            if a:
                e["actor"], e["actor_source"] = a, "td_audit"
            elif e["actor_source"].startswith("record_field:"):
                e["actor"], e["actor_source"] = e["actor_source"].split(":", 1)[1], "record_field"
            else:
                e["actor"], e["actor_source"] = "unattributed", "none"
    session.connection().execute(AuditLogEntity.__table__.insert(), pend)


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session):
    for k in ("_audit_pending", "_audit_td", "_audit_new"):
        session.info.pop(k, None)


def record(session: Session, *, action: str, entity_type: str, entity_id: str, actor: str | None, label: str = "",
           parent_type: str | None = None, parent_id: str | None = None, after_hash: str | None = None) -> None:
    """Explicit entry for events that are not row writes (e.g. a report export)."""
    a, src = current_actor.get() or ((actor, "request_field") if actor else ("unattributed", "none"))
    session.add(AuditLogEntity(at=datetime.datetime.utcnow(), actor=a, actor_source=src,
                               action=action, entity_type=entity_type, entity_id=entity_id, parent_type=parent_type,
                               parent_id=parent_id, label=label[:200], after_hash=after_hash))


def install_triggers(engine) -> list[str]:
    """Idempotent: database-level append-only guard for audit_log and planning_decisions (SQLite)."""
    if not str(engine.url).startswith("sqlite"):
        return []
    with engine.begin() as conn:
        for stmt in APPEND_ONLY_TRIGGERS:
            conn.exec_driver_sql(stmt)
    return list(APPEND_ONLY_TRIGGERS)
