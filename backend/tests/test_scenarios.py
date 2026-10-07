import uuid


def _object(obj_id: str, scenario_id: str) -> dict:
    return {
        "id": obj_id,
        "type": "road",
        "name": obj_id,
        "layerId": "roads",
        "scenarioId": scenario_id,
        "coordinates": [[73.7, 18.5, 0], [73.71, 18.5, 0]],
        "properties": {"laneCount": 2},
    }


def test_base_scenario_exists_on_startup(client):
    ids = [s["id"] for s in client.get("/api/scenarios").json()]
    assert "base" in ids


def test_create_rename_and_list_scenario(client):
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    res = client.post("/api/scenarios", json={"id": sid, "name": "Flyover A", "description": "", "year": 2030})
    assert res.status_code == 201

    res = client.post("/api/scenarios", json={"id": sid, "name": "Flyover A (v2)", "description": "renamed", "year": 2031})
    assert res.status_code == 201

    match = [s for s in client.get("/api/scenarios").json() if s["id"] == sid]
    assert match == [{"id": sid, "name": "Flyover A (v2)", "description": "renamed", "year": 2031}]


def test_delete_scenario_removes_its_objects_only(client):
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    client.post("/api/scenarios", json={"id": sid, "name": "Temp", "description": "", "year": 2030})
    own_id, base_id = f"own_{sid}", f"base_{sid}"
    assert client.post("/api/objects", json=_object(own_id, sid)).status_code == 201
    assert client.post("/api/objects", json=_object(base_id, "base")).status_code == 201

    res = client.delete(f"/api/scenarios/{sid}")
    assert res.status_code == 200
    assert res.json()["deletedObjects"] == 1

    remaining = {o["id"] for o in client.get("/api/objects").json()}
    assert own_id not in remaining
    assert base_id in remaining
    assert sid not in [s["id"] for s in client.get("/api/scenarios").json()]


def test_base_scenario_cannot_be_deleted(client):
    assert client.delete("/api/scenarios/base").status_code == 400


def test_invalid_scenario_is_rejected(client):
    res = client.post("/api/scenarios", json={"id": "x", "name": "", "description": "", "year": 2030})
    assert res.status_code == 422


def test_fake_simulation_endpoint_is_gone(client):
    res = client.post("/api/simulations/run", json={"simulationType": "traffic", "scenarioId": "base"})
    assert res.status_code in (404, 405)
