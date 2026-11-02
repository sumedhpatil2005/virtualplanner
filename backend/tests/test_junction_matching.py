"""Locating counted junctions in an OSM index (a small synthetic one, and the real one when present)."""

import json
import math
import os
import sqlite3

import pytest

from observed.junction_match import match_junction, distance_m
from osm.index import SCHEMA, INDEX_PATH

LAT0, LON0 = 18.59, 73.74
KX = 111_320 * math.cos(math.radians(LAT0))


def pt(dx_m, dy_m):
    return [round(LON0 + dx_m / KX, 7), round(LAT0 + dy_m / 111_320, 7)]


def build(path, ways):
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    for wid, tags, coords in ways:
        db.execute("INSERT INTO ways VALUES (?, ?, ?)", (wid, json.dumps(tags), json.dumps(coords)))
        lons = [c[0] for c in coords]
        lats = [c[1] for c in coords]
        db.execute("INSERT INTO ways_rtree VALUES (?, ?, ?, ?, ?)", (wid, min(lons), max(lons), min(lats), max(lats)))
    db.commit()
    db.close()


@pytest.fixture()
def toy(tmp_path):
    centre, far = pt(0, 0), pt(400, 0)
    ring = [pt(400 + 20 * math.cos(a), 20 * math.sin(a)) for a in [i * math.pi / 4 for i in range(8)]]
    ring.append(ring[0])
    ways = [
        # A crossroads of a primary (through way: two arms) and a residential street ending there twice
        (1, {"highway": "primary", "name": "Main Road"}, [pt(-200, 0), centre, pt(200, 0)]),
        (2, {"highway": "residential", "name": "North Lane"}, [pt(0, 150), centre]),
        (3, {"highway": "residential", "name": "South Lane"}, [centre, pt(0, -150)]),
        # A roundabout at x=400 with three arms
        (10, {"highway": "primary", "junction": "roundabout", "name": "Test Circle"}, ring),
        (11, {"highway": "primary"}, [pt(200, 0), ring[4]]),
        (12, {"highway": "secondary"}, [ring[0], pt(600, 0)]),
        (13, {"highway": "tertiary"}, [ring[2], pt(400, 200)]),
        # A footway does not make a junction
        (20, {"highway": "footway"}, [pt(-100, 100), pt(-100, 0)]),
        # Two residential streets crossing: no major road
        (30, {"highway": "residential"}, [pt(-100, 300), pt(-100, 400), pt(-100, 500)]),
        (31, {"highway": "residential"}, [pt(-200, 400), pt(-100, 400), pt(0, 400)]),
    ]
    path = tmp_path / "toy.db"
    build(str(path), ways)
    return str(path)


def test_finds_the_crossroads_nearest_the_anchor(toy):
    a = pt(15, 10)
    m = match_junction(toy, a[0], a[1], radius_m=60)
    assert m.kind == "intersection" and m.arms == 4
    assert m.distance_from_anchor_m == pytest.approx(math.hypot(15, 10), abs=0.5)
    assert set(m.way_ids) == {1, 2, 3}
    assert "Main Road" in m.road_names


def test_a_roundabout_is_one_junction_at_its_centre(toy):
    a = pt(410, 5)
    m = match_junction(toy, a[0], a[1], radius_m=60)
    assert m.kind == "roundabout" and m.arms == 3
    assert distance_m(m.lon, m.lat, *pt(400, 0)) < 3
    assert 10 in m.way_ids


def test_nothing_within_the_radius_is_none_not_a_guess(toy):
    a = pt(-150, -300)
    assert match_junction(toy, a[0], a[1], radius_m=60) is None


def test_minor_only_junctions_need_require_major_off(toy):
    a = pt(-100, 400)
    assert match_junction(toy, a[0], a[1], radius_m=30) is None
    m = match_junction(toy, a[0], a[1], radius_m=30, require_major=False)
    assert m is not None and m.arms == 4


REAL = os.path.exists(INDEX_PATH)
COUNTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "observed_counts", "pune_west_2026.json")


@pytest.mark.skipif(not REAL, reason="local OSM index not built")
def test_count_file_locations_reproduce_from_the_real_index():
    doc = json.load(open(COUNTS, encoding="utf-8"))
    for j in doc["junctions"]:
        loc = j["location"]
        a = loc["anchor"]
        m = match_junction(INDEX_PATH, a["lon"], a["lat"], loc["search_radius_m"], loc["require_major_road"])
        assert m is not None, j["id"]
        assert distance_m(m.lon, m.lat, loc["lon"], loc["lat"]) < 1.0, j["id"]
        assert m.kind == loc["matched"]["kind"]
