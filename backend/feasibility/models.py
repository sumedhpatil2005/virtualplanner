"""
Feasibility & investigation tables (docs/FEASIBILITY_ENGINE.md §5;
docs/SYSTEM_ARCHITECTURE.md §2.4). Additive: created by create_all next to the
existing tables; nothing here alters scenarios / city_objects.

- fs_assessments: an immutable snapshot of one engine run (site attributes,
  findings, investigation plan) for a proposal. Bound to scenario id + version
  when the scenario module provides a version, else to proposal object ids.
  A re-assessment is a new row, never an update.
- fs_documents: each generated Investigation Requirements Document (file +
  sha256 + the free-text inputs used).
- fs_evidence: uploaded investigation results (file + sha256 + description).
- fs_reviews: APPEND-ONLY review records. The ORM refuses UPDATE and DELETE.
  No status value means approval (REVIEW_STATUSES).
"""

from __future__ import annotations

import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, event

from database.connection import Base

# Review vocabulary: none of these is an approval. "external_approval_recorded_unverified"
# records that a user SAYS an outside authority issued something; this tool has not verified it.
REVIEW_STATUSES = (
    "not_started",
    "in_review",
    "information_requested",
    "reviewed_not_approval",
    "external_approval_recorded_unverified",
)
REVIEW_STATUS_LABEL = {
    "not_started": "Not started",
    "in_review": "In review",
    "information_requested": "Information requested",
    "reviewed_not_approval": "Reviewed \u2014 not an approval",
    "external_approval_recorded_unverified": "External approval recorded (unverified by this tool)",
}


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


class FeasibilityAssessmentEntity(Base):
    __tablename__ = "fs_assessments"

    id = Column(String, primary_key=True)
    scenario_id = Column(String, nullable=False, index=True)
    scenario_version = Column(String, nullable=True)
    proposal_object_ids_json = Column(Text, nullable=False)
    proposal_type = Column(String, nullable=False)
    name = Column(String, nullable=False)
    engine_version = Column(String, nullable=False)
    rules_version = Column(String, nullable=False)
    assessment_json = Column(Text, nullable=False)
    assessment_sha256 = Column(String, nullable=False)
    created_by = Column(String, nullable=False, default="anonymous")
    created_at = Column(DateTime, default=_now)


class InvestigationDocumentEntity(Base):
    __tablename__ = "fs_documents"

    id = Column(String, primary_key=True)
    assessment_id = Column(String, ForeignKey("fs_assessments.id"), nullable=False, index=True)
    format = Column(String, nullable=False)  # pdf | docx
    file_name = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    file_sha256 = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    template_version = Column(String, nullable=False)
    inputs_json = Column(Text, nullable=False, default="{}")
    generated_by = Column(String, nullable=False, default="anonymous")
    generated_at = Column(DateTime, default=_now)


class EvidenceEntity(Base):
    __tablename__ = "fs_evidence"

    id = Column(String, primary_key=True)
    assessment_id = Column(String, ForeignKey("fs_assessments.id"), nullable=False, index=True)
    investigation_id = Column(String, nullable=True)  # e.g. 'geotechnical_investigation'
    file_name = Column(String, nullable=False)
    content_type = Column(String, nullable=False, default="application/octet-stream")
    file_path = Column(String, nullable=False)
    file_sha256 = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    description = Column(Text, nullable=False)
    provenance = Column(String, nullable=False, default="unknown")  # measured | estimated | model_output | assumption | unknown
    uploaded_by = Column(String, nullable=False)
    uploaded_at = Column(DateTime, default=_now)


class ReviewRecordEntity(Base):
    __tablename__ = "fs_reviews"

    id = Column(String, primary_key=True)
    seq = Column(Integer, nullable=False)  # order within the assessment, 1..n
    assessment_id = Column(String, ForeignKey("fs_assessments.id"), nullable=False, index=True)
    item_type = Column(String, nullable=False, default="assessment")  # assessment | investigation | finding | document
    item_id = Column(String, nullable=True)
    reviewer_name = Column(String, nullable=False)
    reviewer_role = Column(String, nullable=False)
    organisation = Column(String, nullable=False, default="")
    status = Column(String, nullable=False)
    notes = Column(Text, nullable=False, default="")
    evidence_ids_json = Column(Text, nullable=False, default="[]")
    external_reference = Column(Text, nullable=True)
    supersedes = Column(String, nullable=True)
    created_at = Column(DateTime, default=_now)


class AppendOnlyViolation(RuntimeError):
    pass


@event.listens_for(ReviewRecordEntity, "before_update")
def _no_update(mapper, connection, target):  # noqa: ARG001
    raise AppendOnlyViolation("Review records are append-only; add a new record that supersedes this one.")


@event.listens_for(ReviewRecordEntity, "before_delete")
def _no_delete(mapper, connection, target):  # noqa: ARG001
    raise AppendOnlyViolation("Review records are append-only and cannot be deleted.")
