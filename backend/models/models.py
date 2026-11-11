from sqlalchemy import Column, String, Integer, DateTime, Float, Index
from database.connection import Base
import datetime

class ScenarioEntity(Base):
  __tablename__ = "scenarios"

  id = Column(String, primary_key=True, index=True)
  name = Column(String, nullable=False)
  description = Column(String)
  year = Column(Integer, default=2026)
  # Added by database.migrations (nullable: rows from before the migration keep NULL = a proposal on 'base')
  kind = Column(String, nullable=True)                # 'baseline' | 'proposal'
  baseline_id = Column(String, nullable=True)         # the baseline this proposal is a change set on ('base')
  parent_scenario_id = Column(String, nullable=True)  # the scenario it was duplicated from, if any
  created_at = Column(DateTime, nullable=True, default=datetime.datetime.utcnow)

class CityObjectEntity(Base):
  __tablename__ = "city_objects"

  id = Column(String, primary_key=True, index=True)
  type = Column(String, nullable=False) # 'road', 'building', 'junction', 'flyover', 'utility'
  name = Column(String, nullable=False)
  layer_id = Column(String, nullable=False)
  scenario_id = Column(String, nullable=False, index=True)
  
  # Coordinate geometry serialized as GeoJSON string
  geometry_geojson = Column(String, nullable=False)
  
  # Extra fields (laneCount, height, occupancy, waterDemand) serialized as JSON string
  properties_json = Column(String, default="{}")
  
  created_at = Column(DateTime, default=datetime.datetime.utcnow)
  updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class AreaEntity(Base):
  __tablename__ = "areas"

  id = Column(String, primary_key=True, index=True)
  name = Column(String, nullable=False)
  polygon_geojson = Column(String, nullable=False) # JSON serialized coordinates: [[lng, lat], ...]
  min_lat = Column(Float, nullable=False)
  max_lat = Column(Float, nullable=False)
  min_lon = Column(Float, nullable=False)
  max_lon = Column(Float, nullable=False)
  created_at = Column(DateTime, default=datetime.datetime.utcnow)


# ── Scenario change sets and versions (docs/SCENARIOS_AND_VERSIONING.md) ─────────────────────────────────────────
# A proposal is its baseline plus a change set keyed by object id:
#   add     a proposal's own object: a row of city_objects with scenario_id = the proposal (unchanged legacy storage)
#   modify  the proposal's version of a BASE object, same id: a row here (op 'modify'); the base row is untouched
#   delete  the proposal hides a BASE object (tombstone): a row here (op 'delete'); the base row is untouched
# (scenario_id, object_id) is the key, so an override never clashes with the base row's primary key.

class ScenarioObjectChangeEntity(Base):
  __tablename__ = "scenario_object_changes"

  scenario_id = Column(String, primary_key=True)
  object_id = Column(String, primary_key=True)
  op = Column(String, nullable=False)          # 'modify' | 'delete'
  seq = Column(Integer, nullable=False, default=0)  # order of the latest write within the scenario
  type = Column(String, nullable=True)
  name = Column(String, nullable=True)
  layer_id = Column(String, nullable=True)
  geometry_geojson = Column(String, nullable=True)
  properties_json = Column(String, nullable=True)
  updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)


class ScenarioVersionEntity(Base):
  """An immutable snapshot of a scenario's change set and the assumptions it was saved with. Never updated."""
  __tablename__ = "scenario_versions"

  id = Column(String, primary_key=True)
  scenario_id = Column(String, nullable=False, index=True)
  number = Column(Integer, nullable=False)
  label = Column(String, nullable=False)
  note = Column(String, nullable=True)
  parent_version_id = Column(String, nullable=True)        # the version that was latest when this one was saved
  restored_from_version_id = Column(String, nullable=True)  # set when the version was made by a restore
  baseline_id = Column(String, nullable=False, default="base")
  baseline_fingerprint = Column(String, nullable=False)    # sha256 of the baseline objects' content at save time
  change_set_hash = Column(String, nullable=False)
  change_count = Column(Integer, nullable=False)
  assumptions_json = Column(String, nullable=False, default="{}")  # demand version, seeds, period, signal mode...
  created_at = Column(DateTime, default=datetime.datetime.utcnow)


class ScenarioVersionChangeEntity(Base):
  __tablename__ = "scenario_version_changes"

  version_id = Column(String, primary_key=True)
  object_id = Column(String, primary_key=True)
  op = Column(String, nullable=False)      # 'add' | 'modify' | 'delete'
  seq = Column(Integer, nullable=False)
  type = Column(String, nullable=True)
  name = Column(String, nullable=True)
  layer_id = Column(String, nullable=True)
  geometry_geojson = Column(String, nullable=True)
  properties_json = Column(String, nullable=True)


class ScenarioRunEntity(Base):
  """Frozen inputs (and an optional result summary) of one simulation run of a scenario, so comparisons can be checked."""
  __tablename__ = "scenario_runs"

  id = Column(String, primary_key=True)
  scenario_id = Column(String, nullable=False, index=True)
  scenario_version_id = Column(String, nullable=True)
  change_set_hash = Column(String, nullable=False)
  baseline_fingerprint = Column(String, nullable=False)
  inputs_json = Column(String, nullable=False)
  results_json = Column(String, nullable=True)
  created_at = Column(DateTime, default=datetime.datetime.utcnow)
