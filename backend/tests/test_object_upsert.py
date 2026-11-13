"""Saving an object twice with one id (a create and an immediate edit, possibly at the same time) is an upsert:
never a UNIQUE-constraint 500. Synthetic objects."""
import threading
import uuid

from sqlalchemy.exc import IntegrityError

from database.connection import SessionLocal
from api import router as router_mod
from api.router import CityObjectSchema, save_object, save_objects_batch
from models.models import CityObjectEntity


def _obj(oid, depth=20.0, name="SYNTHETIC alignment"):
    return {"id": oid, "type": "underground_alignment", "name": name, "layerId": "underground", "scenarioId": "base",
            "coordinates": [[73.85, 18.52, 0], [73.86, 18.52, 0]], "properties": {"depthM": depth}}


def _row(client, oid):
    return [o for o in client.get("/api/objects", params={"scenario_id": "base"}).json() if o["id"] == oid]


def test_create_then_edit_same_id_updates(client):
    oid = f"syn_{uuid.uuid4().hex[:8]}"
    assert client.post("/api/objects", json=_obj(oid)).status_code == 201
    assert client.post("/api/objects", json=_obj(oid, depth=25.0, name="edited")).status_code == 201
    rows = _row(client, oid)
    assert len(rows) == 1 and rows[0]["properties"]["depthM"] == 25.0 and rows[0]["name"] == "edited"


def test_insert_race_becomes_update(client):
    """The lookup misses (the other request has not committed yet) and the insert collides: applied as an update."""
    oid = f"syn_{uuid.uuid4().hex[:8]}"
    assert client.post("/api/objects", json=_obj(oid)).status_code == 201
    db = SessionLocal()
    real_query = db.query
    calls = {"n": 0}

    class _Miss:
        def __init__(self, q): self.q = q
        def filter(self, *a, **k): return _Miss(self.q.filter(*a, **k))
        def first(self): return None

    def query(*a, **k):
        calls["n"] += 1
        q = real_query(*a, **k)
        return _Miss(q) if calls["n"] == 1 else q  # first lookup sees no row, as in the race

    db.query = query
    try:
        save_object(CityObjectSchema(**_obj(oid, depth=31.0, name="edited in race")), db)
    finally:
        db.close()
    rows = _row(client, oid)
    assert len(rows) == 1 and rows[0]["properties"]["depthM"] == 31.0 and rows[0]["name"] == "edited in race"


def test_concurrent_saves_of_a_new_id_never_500(client):
    oid = f"syn_{uuid.uuid4().hex[:8]}"
    codes, errors = [], []

    def go(depth):
        try:
            codes.append(client.post("/api/objects", json=_obj(oid, depth=depth)).status_code)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=go, args=(d,)) for d in (10.0, 11.0, 12.0, 13.0)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errors and codes == [201] * 4
    assert len(_row(client, oid)) == 1


def test_batch_with_repeated_id_keeps_last(client):
    oid = f"syn_{uuid.uuid4().hex[:8]}"
    r = client.post("/api/objects/batch", json=[_obj(oid, depth=1.0), _obj(oid, depth=2.0)])
    assert r.status_code == 201
    rows = _row(client, oid)
    assert len(rows) == 1 and rows[0]["properties"]["depthM"] == 2.0
