"""
Reproduction of docs/SYSTEM_ARCHITECTURE.md §1.7 #2 at the API level: `city_objects.id` is a global primary key, so
a proposal row with a base object's id (the override shape scenarioFilter.ts expects) overwrites the base row.
Synthetic objects. After the fix, overrides go to /api/scenarios/{id}/changes and the legacy upsert refuses to move a
base row into a proposal.
"""
import uuid


def _obj(oid, sid, lanes=2):
    return {"id": oid, "type": "road", "name": oid, "layerId": "roads", "scenarioId": sid,
            "coordinates": [[73.7, 18.5, 0], [73.71, 18.5, 0]], "properties": {"laneCount": lanes}}


def test_posting_a_base_id_into_a_proposal_does_not_change_the_base_row(client):
    sid = f"scn_{uuid.uuid4().hex[:8]}"
    client.post("/api/scenarios", json={"id": sid, "name": "P", "description": "", "year": 2030})
    oid = f"osm_{uuid.uuid4().hex[:8]}"
    assert client.post("/api/objects", json=_obj(oid, "base")).status_code == 201
    client.post("/api/objects", json=_obj(oid, sid, lanes=4))
    base = [o for o in client.get("/api/objects", params={"scenario_id": "base"}).json() if o["id"] == oid]
    assert len(base) == 1 and base[0]["properties"]["laneCount"] == 2
