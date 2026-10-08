from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from database.connection import get_db
from models.models import CityObjectEntity, ScenarioEntity, AreaEntity
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
import json
import datetime

router = APIRouter()

BASE_SCENARIO_ID = "base"

class ScenarioSchema(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    year: int = Field(ge=1900, le=2200)

class CityObjectSchema(BaseModel):
    id: str
    type: str
    name: str
    layerId: str
    scenarioId: str
    coordinates: List[Any]
    properties: Dict[str, Any]

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
    # Read-only: the base scenario is ensured at startup (see seed.ensure_base_scenario)
    scenarios = db.query(ScenarioEntity).all()
    return [ScenarioSchema(id=s.id, name=s.name, description=s.description or "", year=s.year or 2026) for s in scenarios]

@router.post("/scenarios", status_code=status.HTTP_201_CREATED, response_model=ScenarioSchema)
def save_scenario(scenario: ScenarioSchema, db: Session = Depends(get_db)):
    """Create a scenario, or rename/update an existing one."""
    existing = db.get(ScenarioEntity, scenario.id)
    if existing:
        existing.name = scenario.name
        existing.description = scenario.description
        existing.year = scenario.year
    else:
        db.add(ScenarioEntity(id=scenario.id, name=scenario.name, description=scenario.description, year=scenario.year))
    db.commit()
    return scenario

@router.delete("/scenarios/{id}")
def delete_scenario(id: str, db: Session = Depends(get_db)):
    """Delete a proposal scenario together with every object that belongs to it."""
    if id == BASE_SCENARIO_ID:
        raise HTTPException(status_code=400, detail="The base scenario cannot be deleted")
    existing = db.get(ScenarioEntity, id)
    if not existing:
        raise HTTPException(status_code=404, detail="Scenario not found")
    removed = db.query(CityObjectEntity).filter(CityObjectEntity.scenario_id == id).delete(synchronize_session=False)
    db.delete(existing)
    db.commit()
    return {"status": "success", "message": f"Scenario deleted with {removed} objects", "deletedObjects": removed}

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
    # Rows already saved, looked up a few hundred at a time rather than one query per object
    ids = [obj.id for obj in objs]
    saved = {}
    for i in range(0, len(ids), 500):
        for row in db.query(CityObjectEntity).filter(CityObjectEntity.id.in_(ids[i:i + 500])):
            saved[row.id] = row
    for obj in objs:
        existing = saved.get(obj.id)
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
