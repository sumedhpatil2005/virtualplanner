from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from database.connection import get_db
from models.models import CityObjectEntity, ScenarioEntity, AreaEntity
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import json
import datetime

router = APIRouter()

class ScenarioSchema(BaseModel):
    id: str
    name: str
    description: str
    year: int

class CityObjectSchema(BaseModel):
    id: str
    type: str
    name: str
    layerId: str
    scenarioId: str
    coordinates: List[Any]
    properties: Dict[str, Any]

class SimRequestSchema(BaseModel):
    simulationType: str
    scenarioId: str

class BatchDeleteSchema(BaseModel):
    ids: List[str]

class AreaSchema(BaseModel):
    id: str
    name: str
    polygonCoordinates: List[Any]
    minLat: float
    maxLat: float
    minLon: float
    maxLon: float

@router.get("/scenarios", response_model=List[ScenarioSchema])
def get_scenarios(db: Session = Depends(get_db)):
    scenarios = db.query(ScenarioEntity).all()
    if not scenarios:
        # Prepopulate default scenarios
        defaults = [
            ScenarioEntity(id="base", name="Current City (Base)", description="Existing layout of the city infrastructure.", year=2026),
            ScenarioEntity(id="proposal_2028", name="2028 Green Metro & Flyover Expansion", description="Proposed metro lines and arterial flyover connections.", year=2028),
            ScenarioEntity(id="proposal_2030", name="2030 Smart Grid & Flood Drainage", description="Upgraded storm-water management and smart power utility installations.", year=2030)
        ]
        for s in defaults:
            db.add(s)
        db.commit()
        scenarios = db.query(ScenarioEntity).all()
    return [ScenarioSchema(id=s.id, name=s.name, description=s.description, year=s.year) for s in scenarios]

@router.get("/objects", response_model=List[CityObjectSchema])
def get_objects(scenario_id: Optional[str] = None, db: Session = Depends(get_db)):
    query = db.query(CityObjectEntity)
    if scenario_id:
        query = query.filter(CityObjectEntity.scenario_id == scenario_id)
    entities = query.all()
    
    results = []
    for ent in entities:
        try:
            coords = json.loads(ent.geometry_geojson)
            props = json.loads(ent.properties_json)
        except Exception:
            coords = []
            props = {}
            
        results.append(CityObjectSchema(
            id=ent.id,
            type=ent.type,
            name=ent.name,
            layerId=ent.layer_id,
            scenarioId=ent.scenario_id,
            coordinates=coords,
            properties=props
        ))
    return results

@router.post("/objects", status_code=status.HTTP_201_CREATED)
def save_object(obj: CityObjectSchema, db: Session = Depends(get_db)):
    existing = db.query(CityObjectEntity).filter(CityObjectEntity.id == obj.id).first()
    
    geom_str = json.dumps(obj.coordinates)
    props_str = json.dumps(obj.properties)
    
    if existing:
        existing.name = obj.name
        existing.type = obj.type
        existing.layer_id = obj.layerId
        existing.scenario_id = obj.scenarioId
        existing.geometry_geojson = geom_str
        existing.properties_json = props_str
        existing.updated_at = datetime.datetime.utcnow()
    else:
        new_entity = CityObjectEntity(
            id=obj.id,
            type=obj.type,
            name=obj.name,
            layer_id=obj.layerId,
            scenario_id=obj.scenarioId,
            geometry_geojson=geom_str,
            properties_json=props_str
        )
        db.add(new_entity)
        
    db.commit()
    return {"status": "success", "message": "Object saved successfully"}

@router.post("/objects/batch", status_code=status.HTTP_201_CREATED)
def save_objects_batch(objs: List[CityObjectSchema], db: Session = Depends(get_db)):
    for obj in objs:
        existing = db.query(CityObjectEntity).filter(CityObjectEntity.id == obj.id).first()
        geom_str = json.dumps(obj.coordinates)
        props_str = json.dumps(obj.properties)
        
        if existing:
            existing.name = obj.name
            existing.type = obj.type
            existing.layer_id = obj.layerId
            existing.scenario_id = obj.scenarioId
            existing.geometry_geojson = geom_str
            existing.properties_json = props_str
            existing.updated_at = datetime.datetime.utcnow()
        else:
            new_entity = CityObjectEntity(
                id=obj.id,
                type=obj.type,
                name=obj.name,
                layer_id=obj.layerId,
                scenario_id=obj.scenarioId,
                geometry_geojson=geom_str,
                properties_json=props_str
            )
            db.add(new_entity)
            
    db.commit()
    return {"status": "success", "message": f"{len(objs)} objects saved successfully"}


@router.delete("/objects/{id}")
def delete_object(id: str, db: Session = Depends(get_db)):
    existing = db.query(CityObjectEntity).filter(CityObjectEntity.id == id).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Object not found")
    db.delete(existing)
    db.commit()
    return {"status": "success", "message": "Object deleted successfully"}

@router.post("/objects/batch/delete")
def delete_objects_batch(req: BatchDeleteSchema, db: Session = Depends(get_db)):
    db.query(CityObjectEntity).filter(CityObjectEntity.id.in_(req.ids)).delete(synchronize_session=False)
    db.commit()
    return {"status": "success", "message": f"{len(req.ids)} objects deleted successfully"}

@router.post("/simulations/run")
def run_simulation(req: SimRequestSchema, db: Session = Depends(get_db)):
    entities = db.query(CityObjectEntity).filter(CityObjectEntity.scenario_id == req.scenarioId).all()
    
    if req.simulationType == "traffic":
        total_roads = sum(1 for e in entities if e.type == "road")
        total_junctions = sum(1 for e in entities if e.type == "junction")
        return {
            "status": "completed",
            "metrics": {
                "averageSpeed": 48.2 if total_roads > 2 else 55.0,
                "congestionIndex": 1.25 if total_junctions > 1 else 1.05,
                "processedRoads": total_roads
            }
        }
    elif req.simulationType == "flood":
        total_buildings = sum(1 for e in entities if e.type == "building")
        return {
            "status": "completed",
            "metrics": {
                "floodedBuildings": max(0, total_buildings - 1),
                "maxWaterDepth": 1.8,
                "riskLevel": "Moderate"
            }
        }
    elif req.simulationType == "population":
        total_buildings = sum(1 for e in entities if e.type == "building")
        return {
            "status": "completed",
            "metrics": {
                "servedPopulation": total_buildings * 60,
                "densityIndex": 1250,
                "powerDemandMWh": total_buildings * 0.36
            }
        }
    else:
        raise HTTPException(status_code=400, detail="Invalid simulation type")

@router.get("/areas", response_model=List[AreaSchema])
def get_areas(db: Session = Depends(get_db)):
    areas = db.query(AreaEntity).all()
    results = []
    for a in areas:
        try:
            coords = json.loads(a.polygon_geojson)
        except Exception:
            coords = []
        results.append(AreaSchema(
            id=a.id,
            name=a.name,
            polygonCoordinates=coords,
            minLat=a.min_lat,
            maxLat=a.max_lat,
            minLon=a.min_lon,
            maxLon=a.max_lon
        ))
    return results

@router.post("/areas", status_code=status.HTTP_201_CREATED)
def save_area(area: AreaSchema, db: Session = Depends(get_db)):
    existing = db.query(AreaEntity).filter(AreaEntity.id == area.id).first()
    geom_str = json.dumps(area.polygonCoordinates)
    
    if existing:
        existing.name = area.name
        existing.polygon_geojson = geom_str
        existing.min_lat = area.minLat
        existing.max_lat = area.maxLat
        existing.min_lon = area.minLon
        existing.max_lon = area.maxLon
    else:
        new_area = AreaEntity(
            id=area.id,
            name=area.name,
            polygon_geojson=geom_str,
            min_lat=area.minLat,
            max_lat=area.maxLat,
            min_lon=area.minLon,
            max_lon=area.maxLon
        )
        db.add(new_area)
        
    db.commit()
    return {"status": "success", "message": "Area saved successfully"}

@router.delete("/areas/{id}")
def delete_area(id: str, db: Session = Depends(get_db)):
    existing = db.query(AreaEntity).filter(AreaEntity.id == id).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Area not found")
    db.delete(existing)
    db.commit()
    return {"status": "success", "message": "Area deleted successfully"}
