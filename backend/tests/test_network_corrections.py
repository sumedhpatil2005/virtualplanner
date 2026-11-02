"""Network-correction layer: shipped file, validation, API, and the left-hand-traffic audit."""

import copy
import json
import os

import pytest

from observed import network_corrections as nc
from observed.oneway_audit import pair_side, audit, DB

FILE = os.path.join(nc.DATA_DIR, "pune_west_v1.json")


@pytest.fixture()
def layer():
    with open(FILE, encoding="utf-8") as f:
        return json.load(f)


def test_shipped_layer_is_valid_and_every_correction_cites_evidence(layer):
    assert nc.validate(layer) == []
    assert layer["corrections"], "the layer should not be empty"
    for c in layer["corrections"]:
        assert c["evidence"] and all(isinstance(e, str) and len(e) > 30 for e in c["evidence"])
        assert c["proposed_osm_edit"]
        assert c["enabled"] is True
    # Corrections are tied to counted junctions
    with open(os.path.join(os.path.dirname(nc.DATA_DIR), "observed_counts", "pune_west_2026.json"), encoding="utf-8") as f:
        junctions = {j["id"] for j in json.load(f)["junctions"]}
    assert {c["junction_id"] for c in layer["corrections"]} <= junctions


def test_validation_rejects_bad_corrections(layer):
    bad = copy.deepcopy(layer)
    bad["corrections"][0]["evidence"] = []
    bad["corrections"][1]["action"] = "delete_way"
    bad["corrections"][2]["id"] = bad["corrections"][3]["id"]
    problems = nc.validate(bad)
    assert any("no evidence" in p for p in problems)
    assert any("unknown action" in p for p in problems)
    assert any("repeated" in p for p in problems)


def test_api_serves_the_layer(client):
    r = client.get("/api/network-corrections")
    assert r.status_code == 200 and any(l["id"] == "pune_west_v1" for l in r.json()["layers"])
    r = client.get("/api/network-corrections/pune_west_v1")
    assert r.status_code == 200 and r.json()["schema"] == nc.SCHEMA
    assert client.get("/api/network-corrections/nope").status_code == 404


def _line(x0, y0, x1, y1, n=5, lat0=18.6, lon0=73.7):
    k = 1 / 111320
    kx = k / 0.9477  # cos(18.6 deg)
    return [(lon0 + (x0 + (x1 - x0) * i / (n - 1)) * kx, lat0 + (y0 + (y1 - y0) * i / (n - 1)) * k) for i in range(n)]


def test_pair_side_follows_the_keep_left_rule():
    # Driving on the left, eastbound traffic uses the northern carriageway and westbound the
    # southern one: each has its opposite carriageway on its right. That pair passes.
    east_north = _line(0, 15, 400, 15)
    west_south = _line(400, 0, 0, 0)
    r = pair_side(east_north, west_south)
    assert r["left_m"] < 0 and r["same_direction"] is False and "reversed" not in r
    # Both drawn eastbound: the southern way has its partner on its left, so it is the one
    # drawn backwards (it should be westbound), whichever way round the pair is given.
    east_south = _line(0, 0, 400, 0)
    assert pair_side(east_south, east_north)["reversed"] == "a"
    assert pair_side(east_north, east_south)["reversed"] == "b"


@pytest.mark.skipif(not os.path.exists(DB), reason="local OSM index not built")
def test_audit_confirms_the_shipped_reversals(layer):
    pairs = {"kasturi-ne-1": (614201110, 614201109), "kasturi-ne-4": (1533733545, 1533733544), "kasturi-nw-1": (838579438, 1209324408),
             "infosys-n-1": (60976073, 60975032), "infosys-e-1": (239840575, 568110941)}
    rows = {cid: r for cid, r in zip(pairs, audit(list(pairs.values())))}
    by_id = {c["id"]: c for c in layer["corrections"]}
    for cid, r in rows.items():
        assert r["same_direction"], cid
        assert r["reversed_way"] == by_id[cid]["osm_way_id"], cid
    # Correctly mapped pairs pass: opposite directions, partner on the right
    ok = audit([(613849580, 1255451481), (567724270, 838579431)])
    assert all(not r["same_direction"] and r["left_m"] < 0 for r in ok)
