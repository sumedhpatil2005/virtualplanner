"""
Planning & Approval Workspace tables (docs/PLANNING_WORKSPACE.md). Additive: created by `create_all`; no existing table
changes. A project REFERENCES existing records (scenarios, scenario versions, runs, td_datasets, fs_assessments); it
never copies them, so there is one source of truth for each.

Status vocabulary has no "approved" value. A decision row is a "planning decision recorded in this tool"; it is not an
engineering assessment and not a statutory approval, sanction or permit (DECISION_KIND_LABEL).
"""
from __future__ import annotations

import datetime

from sqlalchemy import Column, DateTime, Float, Integer, String, Text, UniqueConstraint, event

from database.connection import Base

PROJECT_STATUSES = ("draft", "under_study", "under_review", "decision_recorded")
PROJECT_STATUS_LABEL = {
    "draft": "Draft",
    "under_study": "Under study",
    "under_review": "Under review",
    "decision_recorded": "Decision recorded (in this tool; not a statutory approval)",
}
LINK_TYPES = ("scenario", "scenario_version", "run", "dataset", "assessment")
DECISION_KIND_LABEL = "Planning decision recorded in this tool \u2014 not an engineering assessment and not a statutory approval, sanction or permit"
EVIDENCE_REF_TYPES = ("evidence", "review", "document", "assessment", "dataset", "run", "scenario_version")


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


class PlanningProjectEntity(Base):
    __tablename__ = "planning_projects"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    area_id = Column(String, nullable=True)  # an existing `areas` row (study area), optional
    min_lon = Column(Float, nullable=True)
    min_lat = Column(Float, nullable=True)
    max_lon = Column(Float, nullable=True)
    max_lat = Column(Float, nullable=True)
    baseline_id = Column(String, nullable=False, default="base")
    baseline_fingerprint = Column(String, nullable=False)  # of the baseline when the project was created
    status = Column(String, nullable=False, default="draft")
    # The alternative (an attached scenario) the project team marks as preferred; a working flag, not a decision.
    preferred_scenario_id = Column(String, nullable=True)
    created_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class PlanningProjectLinkEntity(Base):
    """A reference from a project to an existing record. One table for all link types (validated by the API)."""
    __tablename__ = "planning_project_links"
    __table_args__ = (UniqueConstraint("project_id", "entity_type", "entity_id", name="uq_project_link"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(String, nullable=False, index=True)
    entity_type = Column(String, nullable=False)  # LINK_TYPES
    entity_id = Column(String, nullable=False)
    note = Column(Text, nullable=False, default="")
    added_by = Column(String, nullable=False)
    added_at = Column(DateTime, default=_now)


class PlanningDecisionEntity(Base):
    """Append-only. A later decision supersedes an earlier one by reference; nothing is edited or deleted."""
    __tablename__ = "planning_decisions"

    id = Column(String, primary_key=True)
    project_id = Column(String, nullable=False, index=True)
    seq = Column(Integer, nullable=False)
    decision_text = Column(Text, nullable=False)
    decided_by = Column(String, nullable=False)
    role = Column(String, nullable=False, default="")
    organisation = Column(String, nullable=False, default="")
    scenario_id = Column(String, nullable=True)
    scenario_version_id = Column(String, nullable=True)
    evidence_refs_json = Column(Text, nullable=False, default="[]")  # [{type, id}]
    supersedes = Column(String, nullable=True)
    created_at = Column(DateTime, default=_now)


class AuditLogEntity(Base):
    """The single append-only audit log (SYSTEM_ARCHITECTURE §2.4). Written by planning.audit session hooks."""
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    at = Column(DateTime, default=_now, index=True)
    actor = Column(String, nullable=False)
    actor_source = Column(String, nullable=False)  # header | request_field | record_field | td_audit | none  (no authentication)
    action = Column(String, nullable=False)  # create | update | delete | export
    entity_type = Column(String, nullable=False, index=True)
    entity_id = Column(String, nullable=False, index=True)
    parent_type = Column(String, nullable=True)
    parent_id = Column(String, nullable=True, index=True)
    label = Column(String, nullable=False, default="")
    changed_fields = Column(Text, nullable=True)  # JSON list, updates only
    before_hash = Column(String, nullable=True)
    after_hash = Column(String, nullable=True)


class AppendOnlyViolation(RuntimeError):
    pass


for _cls, _what in ((AuditLogEntity, "Audit log entries"), (PlanningDecisionEntity, "Planning decisions")):
    def _mk(what):
        def _no_update(mapper, connection, target):  # noqa: ARG001
            raise AppendOnlyViolation(f"{what} are append-only.")
        return _no_update
    event.listen(_cls, "before_update", _mk(_what))
    event.listen(_cls, "before_delete", _mk(_what))


# Database-level guard (SQLite triggers): also stops bulk UPDATE/DELETE statements that bypass the ORM.
APPEND_ONLY_TRIGGERS = [
    f"CREATE TRIGGER IF NOT EXISTS {t}_no_{op.lower()} BEFORE {op} ON {t} BEGIN SELECT RAISE(ABORT, '{t} is append-only'); END"
    for t in ("audit_log", "planning_decisions") for op in ("UPDATE", "DELETE")
]
