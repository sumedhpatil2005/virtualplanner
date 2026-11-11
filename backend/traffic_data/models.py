"""
Traffic Data Manager tables (docs/TRAFFIC_DATA.md, docs/SYSTEM_ARCHITECTURE.md §2.4).

Additive only: these tables are created by ``Base.metadata.create_all`` next to
the existing ones, which SQLAlchemy never alters, so an existing twincity.db is
safe. Nothing here touches ``scenarios`` / ``city_objects`` / ``areas``.

Design rules (mission §5, §22.6/22.7):
- every dataset records its provenance and whether it is measured, estimated
  or manually entered; records never move between datasets, and nothing here
  averages or merges datasets;
- a count is a count at a place (veh over a period), not demand and not
  throughput;
- PCU factor sets are versioned: a version row is never updated; an edit is a
  new version, and a dataset points at the exact version it used.
"""

from __future__ import annotations

import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint

from database.connection import Base


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


class VehicleClassEntity(Base):
    __tablename__ = "td_vehicle_classes"

    code = Column(String, primary_key=True)  # e.g. 'two_wheeler'
    label = Column(String, nullable=False)
    description = Column(String, default="")
    sort_order = Column(Integer, default=100)
    builtin = Column(Boolean, default=False)
    created_by = Column(String, nullable=False, default="system")
    created_at = Column(DateTime, default=_now)


class PcuFactorSetEntity(Base):
    __tablename__ = "td_pcu_factor_sets"
    __table_args__ = (UniqueConstraint("set_key", "version", name="uq_pcu_set_version"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    set_key = Column(String, nullable=False, index=True)  # stable name across versions
    version = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    context = Column(String, nullable=False, default="midblock")  # midblock | signalised | other
    source_citation = Column(Text, nullable=False)
    source_url = Column(String, default="")
    assumptions = Column(Text, default="")
    factors_json = Column(Text, nullable=False)  # {class_code: factor}
    change_note = Column(Text, default="")
    builtin = Column(Boolean, default=False)
    created_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=_now)


class TrafficDatasetEntity(Base):
    __tablename__ = "td_datasets"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    provider = Column(String, nullable=False)  # data source or provider
    kind = Column(String, nullable=False)  # measured | estimated | manual
    method = Column(String, default="")  # e.g. manual classified count, video, ATCC
    collected_from = Column(String, nullable=True)  # ISO date
    collected_to = Column(String, nullable=True)
    location_desc = Column(String, nullable=False)
    period_desc = Column(String, nullable=False)  # time period represented
    classification = Column(String, nullable=False)  # which vehicle classes the data distinguishes
    assumptions = Column(Text, default="")
    adjustments = Column(Text, default="")  # factors applied (seasonal, expansion...), never applied silently
    pcu_factor_set_id = Column(Integer, ForeignKey("td_pcu_factor_sets.id"), nullable=True)
    role = Column(String, nullable=False, default="unused")  # validation | calibration | unused
    entered_by = Column(String, nullable=False)
    imported_file_name = Column(String, nullable=True)
    imported_file_sha256 = Column(String, nullable=True)
    import_report_json = Column(Text, nullable=True)
    synthetic = Column(Boolean, default=False)  # test/demo fixtures must say so
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class CountRecordEntity(Base):
    __tablename__ = "td_count_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    dataset_id = Column(String, ForeignKey("td_datasets.id"), nullable=False, index=True)
    ref_kind = Column(String, nullable=False)  # road_direction | junction_approach | turn
    road_id = Column(String, nullable=True, index=True)  # stable city object id (road_direction)
    direction = Column(String, nullable=True)  # fwd | bwd | both (relative to the road's drawn direction)
    direction_label = Column(String, default="")  # as the survey names it, e.g. "towards Swargate"
    junction_ref = Column(String, nullable=True)
    approach_road_id = Column(String, nullable=True)
    from_road_id = Column(String, nullable=True)
    to_road_id = Column(String, nullable=True)
    turn = Column(String, nullable=True)  # left | straight | right | u_turn
    day_type = Column(String, nullable=False)  # weekday | saturday | sunday | holiday | weekend | all_days
    count_date = Column(String, nullable=True)
    period_start = Column(String, nullable=False)  # HH:MM
    period_end = Column(String, nullable=False)  # HH:MM (24:00 allowed)
    class_counts_json = Column(Text, nullable=False, default="{}")  # {class_code: vehicles in the period}
    total_count = Column(Integer, nullable=True)  # vehicles in the period (when unclassified, or as printed)
    lon = Column(String, nullable=True)
    lat = Column(String, nullable=True)
    quality_flag = Column(String, default="")
    notes = Column(Text, default="")
    source_row = Column(Integer, nullable=True)  # row in the imported file
    created_at = Column(DateTime, default=_now)


class TrafficDataAuditEntity(Base):
    __tablename__ = "td_audit_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    entity = Column(String, nullable=False)  # dataset | record | pcu_set | vehicle_class
    entity_id = Column(String, nullable=False, index=True)
    action = Column(String, nullable=False)  # create | update | delete | import
    actor = Column(String, nullable=False)
    at = Column(DateTime, default=_now)
    before_json = Column(Text, nullable=True)
    after_json = Column(Text, nullable=True)
