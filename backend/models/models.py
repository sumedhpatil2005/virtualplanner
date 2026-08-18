from sqlalchemy import Column, String, Integer, DateTime, Float
from database.connection import Base
import datetime

class ScenarioEntity(Base):
  __tablename__ = "scenarios"

  id = Column(String, primary_key=True, index=True)
  name = Column(String, nullable=False)
  description = Column(String)
  year = Column(Integer, default=2026)

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
