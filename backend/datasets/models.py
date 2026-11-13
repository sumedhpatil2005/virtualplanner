"""
Dataset registry tables (additive; prefix `ds_`). Existing tables are never altered.

Immutability: a `ds_dataset_versions` row is content-immutable. Only its review fields (review_status, reviewed_by,
reviewed_at, review_note) and — once, when the importer left them empty — data_class / suitability may change; any
other change raises. Versions are never deleted. A newer version never replaces the active one silently: it is
registered as `pending_review` and becomes active only through an explicit review.
"""
from __future__ import annotations

import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, event, inspect

from database.connection import Base


def _now():
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


class DsSourceEntity(Base):
    __tablename__ = "ds_sources"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    publisher = Column(String, nullable=False, default="UNKNOWN")
    url = Column(Text, nullable=False, default="")
    access_method = Column(String, nullable=False, default="manual")   # api|ogc|download|manual|rti|local|stream
    licence_text = Column(Text, nullable=False, default="UNKNOWN")      # exactly as the publisher states it
    licence_url = Column(Text, nullable=False, default="")
    robots_notes = Column(Text, nullable=False, default="")
    tos_notes = Column(Text, nullable=False, default="")
    official = Column(Boolean, nullable=False, default=False)            # government / statutory publisher
    registration_required = Column(Boolean, nullable=False, default=False)
    notes = Column(Text, nullable=False, default="")
    origin = Column(String, nullable=False, default="seed")             # seed|manifest|catalogue_sync|api
    created_at = Column(DateTime, default=_now)


class DsDatasetEntity(Base):
    __tablename__ = "ds_datasets"

    id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    theme = Column(String, nullable=False, default="other", index=True)
    source_id = Column(String, nullable=True, index=True)
    # where the record is mirrored from, e.g. "environment_layers:flood_lines", "subsurface_datasets:<id>", "td_datasets:<id>"
    catalogue_ref = Column(String, nullable=True, index=True)
    backs_catalogue_json = Column(Text, nullable=False, default="[]")   # environment_layers ids this dataset backs
    recommended_sources_json = Column(Text, nullable=False, default="[]")
    limitations = Column(Text, nullable=False, default="")
    max_age_days = Column(Integer, nullable=True)                       # staleness threshold; NULL = not assessed
    update_check_json = Column(Text, nullable=False, default="{}")      # {"method": "http_head"|"ckan", "url": ...}
    origin = Column(String, nullable=False, default="seed")
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class DsDatasetVersionEntity(Base):
    __tablename__ = "ds_dataset_versions"

    id = Column(String, primary_key=True)
    dataset_id = Column(String, nullable=False, index=True)
    version_label = Column(String, nullable=False)
    observation_start = Column(String, nullable=True)     # ISO date(-time with zone); NULL = UNKNOWN
    observation_end = Column(String, nullable=True)
    published_date = Column(String, nullable=True)
    source_updated_date = Column(String, nullable=True)
    retrieved_at = Column(String, nullable=True)          # ISO with zone; NULL = never stored locally (streamed)
    sha256 = Column(String, nullable=True)                # of the primary file (or of the manifest when many files)
    coverage_bbox_json = Column(Text, nullable=True)      # [minLon,minLat,maxLon,maxLat] WGS84; NULL = UNKNOWN
    coverage_geojson = Column(Text, nullable=True)
    crs = Column(String, nullable=True)
    resolution = Column(String, nullable=True)            # e.g. "30 m", "point", "1:50,000"
    format = Column(String, nullable=True)
    size_bytes = Column(Integer, nullable=True)
    data_class = Column(String, nullable=True)            # observed|inferred|estimated|derived|synthetic; NULL = not classified
    suitability = Column(String, nullable=True)           # visualisation|screening|engineering; NULL = not stated
    accuracy_statement = Column(Text, nullable=False, default="")
    licence_text = Column(Text, nullable=False, default="UNKNOWN")   # as stated at retrieval
    licence_url = Column(Text, nullable=False, default="")
    http_json = Column(Text, nullable=False, default="{}")           # etag / last-modified / content-length at retrieval
    stats_json = Column(Text, nullable=False, default="{}")          # feature counts etc. as recorded
    notes = Column(Text, nullable=False, default="")
    origin = Column(String, nullable=False, default="seed")          # seed|manifest|processing|catalogue_sync|update_check|api
    origin_path = Column(Text, nullable=True)                         # manifest / processing.json directory
    fingerprint = Column(String, nullable=True, index=True)           # idempotency key of the registration
    supersedes_id = Column(String, nullable=True)
    review_status = Column(String, nullable=False, default="pending_review")
    reviewed_by = Column(String, nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    review_note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)


class DsFileEntity(Base):
    __tablename__ = "ds_files"

    id = Column(String, primary_key=True)
    version_id = Column(String, nullable=False, index=True)
    role = Column(String, nullable=False, default="raw")   # raw|derived|aux|manifest
    path = Column(Text, nullable=False)                    # absolute, or relative to URBANOS_DATA_DIR / backend
    sha256 = Column(String, nullable=True)
    size_bytes = Column(Integer, nullable=True)
    format = Column(String, nullable=True)
    url = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)


class DsProcessingRunEntity(Base):
    __tablename__ = "ds_processing_runs"

    id = Column(String, primary_key=True)
    version_id = Column(String, nullable=False, index=True)     # the output version
    pipeline = Column(Text, nullable=False, default="UNKNOWN")
    git_commit = Column(String, nullable=True)
    params_json = Column(Text, nullable=False, default="{}")
    inputs_json = Column(Text, nullable=False, default="[]")    # [{path, sha256, version_id?}]
    outputs_json = Column(Text, nullable=False, default="[]")
    validation_json = Column(Text, nullable=False, default="{}")
    started_at = Column(String, nullable=True)
    finished_at = Column(String, nullable=True)
    origin_path = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)


class DsQualityCheckEntity(Base):
    """Append-only: each run of a check is a new row; the latest per (version, check) is current."""
    __tablename__ = "ds_quality_checks"

    id = Column(String, primary_key=True)
    version_id = Column(String, nullable=False, index=True)
    check = Column(String, nullable=False)     # crs|pune_coverage|staleness|checksum|geometry_validity|duplicates|classification|licence
    status = Column(String, nullable=False)    # pass|warn|fail|unknown|not_applicable
    value = Column(String, nullable=True)
    detail = Column(Text, nullable=False, default="")
    run_at = Column(DateTime, default=_now)


class DsFeatureEntity(Base):
    __tablename__ = "ds_features"

    id = Column(String, primary_key=True)
    workspace = Column(String, nullable=False)       # explore|design|underground|environment|simulate|projects|reports
    capability = Column(String, nullable=False)      # Explore|Design|Underground|Environment|Flood/drainage|Traffic|Emissions|Population|Coordination
    name = Column(String, nullable=False)
    description = Column(Text, nullable=False, default="")
    status_cap = Column(String, nullable=True)       # the best status the feature can show (e.g. partial: validation fails)
    status_cap_reason = Column(Text, nullable=True)
    # whether the feature's code reads these datasets today (data can be ready while the feature still ignores it)
    wired = Column(Boolean, nullable=True)
    wiring_note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)


class DsFeatureDependencyEntity(Base):
    __tablename__ = "ds_feature_dependencies"

    id = Column(String, primary_key=True)
    feature_id = Column(String, nullable=False, index=True)
    theme = Column(String, nullable=False)
    dataset_id = Column(String, nullable=True)       # a specific dataset; NULL = any dataset of the theme
    required_quality = Column(String, nullable=False)  # visualisation|screening|engineering
    required = Column(Boolean, nullable=False, default=True)
    note = Column(Text, nullable=False, default="")


class DsUpdateCheckEntity(Base):
    __tablename__ = "ds_update_checks"

    id = Column(String, primary_key=True)
    dataset_id = Column(String, nullable=False, index=True)
    method = Column(String, nullable=False)           # http_head|ckan|ckan_url|stac_latest|github_release|geofabrik|none
    url = Column(Text, nullable=True)
    etag = Column(String, nullable=True)
    last_modified = Column(String, nullable=True)
    catalogue_modified = Column(String, nullable=True)
    content_length = Column(String, nullable=True)
    result = Column(String, nullable=False)           # unchanged|changed|update_available|first_seen|error|not_checkable
    detail = Column(Text, nullable=False, default="")
    new_version_id = Column(String, nullable=True)
    checked_by = Column(String, nullable=False, default="system")
    checked_at = Column(DateTime, default=_now)


MUTABLE_VERSION_FIELDS = {"review_status", "reviewed_by", "reviewed_at", "review_note"}
FILL_ONCE_VERSION_FIELDS = {"data_class", "suitability"}


class ImmutableVersionError(RuntimeError):
    pass


@event.listens_for(DsDatasetVersionEntity, "before_update")
def _guard_version(mapper, connection, target):  # noqa: ARG001
    st = inspect(target)
    for attr in st.attrs:
        h = attr.history
        if not h.has_changes():
            continue
        if attr.key in MUTABLE_VERSION_FIELDS:
            continue
        if attr.key in FILL_ONCE_VERSION_FIELDS and all(v is None for v in (h.deleted or ())):
            continue  # classification filled once at review, never changed after
        raise ImmutableVersionError(f"dataset version {target.id}: '{attr.key}' is immutable (register a new version)")


@event.listens_for(DsDatasetVersionEntity, "before_delete")
def _no_delete(mapper, connection, target):  # noqa: ARG001
    raise ImmutableVersionError("dataset versions are never deleted")


@event.listens_for(DsQualityCheckEntity, "before_update")
def _qc_append_only(mapper, connection, target):  # noqa: ARG001
    raise ImmutableVersionError("quality checks are append-only")


def _register_audit() -> None:
    from planning import audit
    audit._SPEC_BY_NAME.update({
        "DsSourceEntity": ("ds_source", None, None, "name", ()),
        "DsDatasetEntity": ("ds_dataset", None, None, "title", ()),
        "DsDatasetVersionEntity": ("ds_dataset_version", "ds_dataset", "dataset_id", "version_label", ("reviewed_by",)),
        "DsUpdateCheckEntity": ("ds_update_check", "ds_dataset", "dataset_id", "result", ("checked_by",)),
    })
    for t in ("ds_source", "ds_dataset", "ds_dataset_version", "ds_update_check"):
        if t not in audit.TRACKED_TYPES:
            audit.TRACKED_TYPES.append(t)


_register_audit()
