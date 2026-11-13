"""
Shared city model, project coordination and subsurface tables (docs/urbanos/COORDINATION_AND_SUBSURFACE.md).

Additive only: created by `create_all`; no existing table or column changes meaning. Planning projects, scenarios,
scenario versions and the baseline are REFERENCED (ids + fingerprints / hashes), never copied or edited.

Vocabulary that must never be read as a pass:
- z_min_m / z_max_m NULL = UNKNOWN (never 0). Metres relative to local ground, up positive (a tunnel crown 12 m below
  ground is z_max_m = -12).
- certainty: measured | estimated | hypothetical | unknown.
- conflict classes: conflict | potential_conflict | vertically_separated | no_conflict_within_available_data |
  unknown_no_coverage. Absence of data is `unknown_no_coverage`, never "clear".
- clearance rules are seeded ONLY with cited permission distances (metro 20 m NOC, AMASR 100 m / 300 m), labelled as
  permission distances, not engineering clearances. Every engineering clearance is unset (UNKNOWN) until a user enters it.

Every write is audited by planning.audit session hooks (the entity specs are registered at the bottom of this file).
"""
from __future__ import annotations

import datetime

from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, Text

from database.connection import Base

CERTAINTIES = ("measured", "estimated", "hypothetical", "unknown")
ELEMENT_KINDS = ("road", "road_widening", "flyover", "bridge", "metro_tunnel", "metro_viaduct", "metro_station",
                 "tunnel", "utility", "pipeline", "drainage", "building", "foundation", "pier", "excavation",
                 "protected_monument", "other")
CONFLICT_CLASSES = ("conflict", "potential_conflict", "vertically_separated", "no_conflict_within_available_data",
                    "unknown_no_coverage")
CONFLICT_STATUSES = ("open", "acknowledged", "resolved")
RULE_TYPES = ("permission_distance", "engineering_clearance")
RULE_BASES = ("cited_permission_distance", "user_entered")
QUALITY_LEVELS = ("QL-A", "QL-B", "QL-C", "QL-D")
ENV_DOMAINS = ("flood", "groundwater", "soil", "geology", "air", "noise", "heat", "vegetation", "water", "heritage",
               "drainage", "seismic", "terrain", "metro", "railway")
ENGINE_VERSION = "coordination-engine 1.0 (2026-11-13)"


def _now() -> datetime.datetime:
    return datetime.datetime.utcnow()


class ProposalElementEntity(Base):
    """One element of a project's proposal with its 3D extent. Either references an object (element_ref, resolved from
    the scenario version / head) or carries its own geometry (GeoJSON, WGS84)."""
    __tablename__ = "project_proposal_elements"

    id = Column(String, primary_key=True)
    project_id = Column(String, nullable=False, index=True)
    scenario_id = Column(String, nullable=True)
    scenario_version_id = Column(String, nullable=True)
    element_ref = Column(String, nullable=True)            # city object id inside the scenario (version)
    geometry_geojson = Column(Text, nullable=True)         # own geometry {type, coordinates} in EPSG:4326
    kind = Column(String, nullable=False)                  # ELEMENT_KINDS
    name = Column(String, nullable=False, default="")
    width_m = Column(Float, nullable=True)                 # footprint width / outer diameter; NULL = UNKNOWN
    z_min_m = Column(Float, nullable=True)                 # NULL = UNKNOWN
    z_max_m = Column(Float, nullable=True)                 # NULL = UNKNOWN
    z_ref = Column(String, nullable=False, default="ground")
    profile_json = Column(Text, nullable=True)             # [{chainage_m, z_min_m, z_max_m}] for segmented alignments
    clearance_m = Column(Float, nullable=True)             # user-set clearance for this element; NULL = none set
    construction_phase = Column(String, nullable=False, default="permanent")  # permanent | temporary_works
    provenance = Column(Text, nullable=False, default="")
    certainty = Column(String, nullable=False, default="unknown")
    created_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class ClearanceRuleEntity(Base):
    __tablename__ = "clearance_rules"

    id = Column(String, primary_key=True)
    label = Column(String, nullable=False)
    rule_type = Column(String, nullable=False)             # RULE_TYPES
    subject_kind = Column(String, nullable=False, default="*")
    other_kind = Column(String, nullable=False, default="*")  # comma-separated kinds or '*'
    horizontal_m = Column(Float, nullable=True)            # NULL = UNKNOWN (not set)
    vertical_m = Column(Float, nullable=True)              # NULL = UNKNOWN (not set)
    basis = Column(String, nullable=False)                 # RULE_BASES
    citation = Column(Text, nullable=True)
    note = Column(Text, nullable=False, default="")
    active = Column(Boolean, nullable=False, default=True)
    created_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class CoordinationRunEntity(Base):
    """One detection run: frozen input hashes + summary. Never updated."""
    __tablename__ = "coordination_runs"

    id = Column(String, primary_key=True)
    project_id = Column(String, nullable=False, index=True)
    inputs_json = Column(Text, nullable=False)
    summary_json = Column(Text, nullable=False)
    engine_version = Column(String, nullable=False)
    created_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=_now)


class CoordinationConflictEntity(Base):
    """A computed finding. Only status / status_by / status_note / status_at ever change (audited). Never edits a project."""
    __tablename__ = "coordination_conflicts"

    id = Column(String, primary_key=True)
    run_id = Column(String, nullable=False, index=True)
    project_a_id = Column(String, nullable=False, index=True)
    element_a_id = Column(String, nullable=False)
    segment_a = Column(Integer, nullable=True)
    b_type = Column(String, nullable=False)    # project_element | baseline_road | osm_metro | subsurface_utility | layer
    project_b_id = Column(String, nullable=True, index=True)
    b_ref = Column(String, nullable=False)
    segment_b = Column(Integer, nullable=True)
    pair_key = Column(String, nullable=False, index=True)
    conflict_class = Column(String, nullable=False)
    horizontal_distance_m = Column(Float, nullable=True)
    vertical_gap_m = Column(Float, nullable=True)
    certainty = Column(String, nullable=False)
    reasons_json = Column(Text, nullable=False, default="[]")
    permission_triggers_json = Column(Text, nullable=False, default="[]")
    evidence_json = Column(Text, nullable=False, default="{}")
    status = Column(String, nullable=False, default="open")
    status_by = Column(String, nullable=True)
    status_note = Column(Text, nullable=True)
    status_at = Column(DateTime, nullable=True)
    status_carried_from = Column(String, nullable=True)
    created_at = Column(DateTime, default=_now)


class SubsurfaceDatasetEntity(Base):
    """One imported file (AGS4 subset / CSV / JSON). Never edited; a corrected file is a new dataset."""
    __tablename__ = "subsurface_datasets"

    id = Column(String, primary_key=True)
    project_id = Column(String, nullable=True, index=True)
    record_type = Column(String, nullable=False)          # borehole | utility
    format = Column(String, nullable=False)               # ags4 | csv | json
    name = Column(String, nullable=False)
    file_name = Column(String, nullable=True)
    file_sha256 = Column(String, nullable=True)
    publisher = Column(String, nullable=False, default="")
    source_url = Column(String, nullable=False, default="")
    licence = Column(String, nullable=False, default="UNKNOWN")
    data_date = Column(String, nullable=True)            # vintage of the data (as stated by the importer)
    coverage_bbox_json = Column(Text, nullable=True)     # stated coverage [minLon,minLat,maxLon,maxLat]; NULL = UNKNOWN
    provenance = Column(Text, nullable=False, default="")
    record_count = Column(Integer, nullable=False, default=0)
    warnings_json = Column(Text, nullable=False, default="[]")
    supersedes_id = Column(String, nullable=True)
    imported_by = Column(String, nullable=False)
    imported_at = Column(DateTime, default=_now)


class SubsurfaceRecordEntity(Base):
    __tablename__ = "subsurface_records"

    id = Column(String, primary_key=True)
    dataset_id = Column(String, nullable=False, index=True)
    record_type = Column(String, nullable=False)          # borehole | utility
    external_id = Column(String, nullable=False)
    geometry_geojson = Column(Text, nullable=True)        # Point (borehole) / LineString (utility); NULL = location UNKNOWN
    location_note = Column(String, nullable=False, default="")
    ground_level_m = Column(Float, nullable=True)         # borehole LOCA_GL (datum as in the file)
    final_depth_m = Column(Float, nullable=True)
    strata_json = Column(Text, nullable=True)             # [{top_m, base_m, description, legend, geology}]
    water_strikes_json = Column(Text, nullable=True)      # [depth_m]
    spt_json = Column(Text, nullable=True)                # [{top_m, n}]
    utility_type = Column(String, nullable=True)
    owner = Column(String, nullable=True)
    depth_m = Column(Float, nullable=True)                # depth below ground to top of utility; NULL = UNKNOWN
    diameter_m = Column(Float, nullable=True)
    quality_level = Column(String, nullable=True)         # ASCE 38 QL-A..QL-D; NULL = UNKNOWN
    survey_method = Column(String, nullable=True)
    z_min_m = Column(Float, nullable=True)
    z_max_m = Column(Float, nullable=True)
    z_certainty = Column(String, nullable=False, default="unknown")
    properties_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=_now)


class EnvironmentLayerEntity(Base):
    """Catalogue entry. Seeded rows say what is NOT imported and which source is recommended (metadata only)."""
    __tablename__ = "environment_layers"

    id = Column(String, primary_key=True)
    domain = Column(String, nullable=False)
    name = Column(String, nullable=False)
    status = Column(String, nullable=False, default="not_imported")  # available | not_imported
    source = Column(Text, nullable=False, default="")
    licence = Column(Text, nullable=False, default="UNKNOWN")
    data_date = Column(String, nullable=True)
    recommended_sources_json = Column(Text, nullable=False, default="[]")
    limitations = Column(Text, nullable=False, default="")
    created_by = Column(String, nullable=False, default="system (catalogue seed)")
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


# ── audit registration (planning.audit tracks entities by class name; additive) ─────────────────────────────────────
def _register_audit() -> None:
    from planning import audit
    audit._SPEC_BY_NAME.update({
        "ProposalElementEntity": ("proposal_element", "project", "project_id", "name", ("created_by",)),
        "ClearanceRuleEntity": ("clearance_rule", None, None, "label", ("created_by",)),
        "CoordinationRunEntity": ("coordination_run", "project", "project_id", None, ("created_by",)),
        "CoordinationConflictEntity": ("coordination_conflict", "project", "project_a_id", "conflict_class", ()),
        "SubsurfaceDatasetEntity": ("subsurface_dataset", "project", "project_id", "name", ("imported_by",)),
        "SubsurfaceRecordEntity": ("subsurface_record", "subsurface_dataset", "dataset_id", "external_id", ()),
        "EnvironmentLayerEntity": ("environment_layer", None, None, "name", ("created_by",)),
    })
    for t in ("proposal_element", "clearance_rule", "coordination_run", "coordination_conflict", "subsurface_dataset",
              "subsurface_record", "environment_layer"):
        if t not in audit.TRACKED_TYPES:
            audit.TRACKED_TYPES.append(t)


_register_audit()
