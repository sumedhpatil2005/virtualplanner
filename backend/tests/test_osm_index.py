"""The local OpenStreetMap road index: building it from an extract, and serving roads and signals."""

import api.osm_router as osm_router
from osm.build_index import build
from osm.index import OsmIndex

OSM_XML = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6" generator="test">
  <node id="1" lat="18.5300" lon="73.8500" version="1"/>
  <node id="2" lat="18.5300" lon="73.8600" version="1"/>
  <node id="3" lat="18.5400" lon="73.8600" version="1"/>
  <node id="4" lat="18.9000" lon="73.9000" version="1"/>
  <node id="5" lat="18.9100" lon="73.9100" version="1"/>
  <node id="6" lat="18.5350" lon="73.8550" version="1">
    <tag k="highway" v="traffic_signals"/>
  </node>
  <way id="100" version="1">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="primary"/><tag k="name" v="Sangamwadi Road"/>
  </way>
  <way id="101" version="1">
    <nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/>
  </way>
  <way id="102" version="1">
    <nd ref="1"/><nd ref="3"/>
    <tag k="highway" v="footway"/>
  </way>
  <way id="103" version="1">
    <nd ref="4"/><nd ref="5"/>
    <tag k="highway" v="primary"/>
  </way>
</osm>
"""

BBOX = (73.80, 18.50, 73.90, 18.60)


def make_index(tmp_path) -> OsmIndex:
    src = tmp_path / "extract.osm"
    src.write_text(OSM_XML, encoding="utf-8")
    out = tmp_path / "index.db"
    result = build(str(src), BBOX, str(out))
    assert result["ways"] == 2  # primary + residential inside; footway and the far road left out
    assert result["signals"] == 1
    return OsmIndex(str(out))


def test_builds_roads_and_signals_inside_the_region(tmp_path):
    index = make_index(tmp_path)
    status = index.status()
    assert status["available"] and status["ways"] == 2 and status["signals"] == 1
    assert status["bbox"] == list(BBOX)

    ways = index.ways([(73.849, 18.529, 73.851, 18.531)])  # touches way 100 only
    assert [w["id"] for w in ways] == [100]
    assert ways[0]["tags"]["name"] == "Sangamwadi Road"
    assert ways[0]["geometry"][0] == {"lon": 73.85, "lat": 18.53}

    both = index.ways([(73.849, 18.529, 73.851, 18.531), (73.859, 18.535, 73.861, 18.541)])
    assert sorted(w["id"] for w in both) == [100, 101]
    assert [s["id"] for s in index.signals([BBOX])] == [6]
    assert index.covers([BBOX]) and not index.covers([(73.0, 18.0, 73.1, 18.1)])


def test_serves_roads_like_overpass(tmp_path, client, monkeypatch):
    monkeypatch.setattr(osm_router, "index", make_index(tmp_path))
    res = client.get("/api/osm/ways", params={"bbox": "73.80,18.50,73.90,18.60"})
    assert res.status_code == 200
    assert sorted(e["id"] for e in res.json()["elements"]) == [100, 101]
    assert res.json()["elements"][0]["type"] == "way"

    sig = client.get("/api/osm/signals", params={"bbox": "73.80,18.50,73.90,18.60"})
    assert sig.json()["elements"] == [{"type": "node", "id": 6, "lon": 73.855, "lat": 18.535}]

    # Outside the indexed region the frontend must fall back to Overpass
    assert client.get("/api/osm/ways", params={"bbox": "72.0,18.0,72.1,18.1"}).status_code == 416
    assert client.get("/api/osm/ways", params={"bbox": "bad"}).status_code == 400


def test_reports_a_missing_index(tmp_path, client, monkeypatch):
    monkeypatch.setattr(osm_router, "index", OsmIndex(str(tmp_path / "none.db")))
    assert client.get("/api/osm/status").json() == {"available": False}
    assert client.get("/api/osm/ways", params={"bbox": "73.80,18.50,73.90,18.60"}).status_code == 404


def test_indexes_buildings_metro_and_complete_multipolygons(tmp_path, client, monkeypatch):
    extra = """
      <node id="10" lat="18.532" lon="73.851" version="1"/>
      <node id="11" lat="18.532" lon="73.852" version="1"/>
      <node id="12" lat="18.533" lon="73.852" version="1"/>
      <node id="13" lat="18.533" lon="73.851" version="1"/>
      <node id="20" lat="18.535" lon="73.857" version="1"><tag k="railway" v="station"/><tag k="station" v="subway"/></node>
      <way id="200" version="1"><nd ref="10"/><nd ref="11"/><nd ref="12"/><nd ref="13"/><nd ref="10"/><tag k="building" v="yes"/></way>
      <way id="201" version="1"><nd ref="10"/><nd ref="11"/><nd ref="12"/></way>
      <way id="202" version="1"><nd ref="12"/><nd ref="13"/><nd ref="10"/></way>
      <way id="203" version="1"><nd ref="10"/><nd ref="12"/><tag k="railway" v="subway"/><tag k="tunnel" v="yes"/></way>
      <relation id="200" version="1"><member type="way" ref="201" role="outer"/><member type="way" ref="202" role="outer"/><tag k="type" v="multipolygon"/><tag k="building" v="yes"/></relation>
      <relation id="204" version="1"><member type="way" ref="201" role="outer"/><tag k="type" v="multipolygon"/><tag k="building" v="yes"/></relation>
    """
    # OSM streams require nodes before ways and ways before relations.
    xml = OSM_XML.replace('  <way id="100"', extra[:extra.index('      <way id="200"')] + '  <way id="100"').replace('</osm>', extra[extra.index('      <way id="200"'):] + '</osm>')
    source = tmp_path / "features.osm"
    source.write_text(xml, encoding="utf-8")
    output = tmp_path / "features.db"
    build(str(source), BBOX, str(output))
    index = OsmIndex(str(output))
    assert index.status()["capabilities"] == ["roads", "signals", "buildings", "metro"]
    buildings = index.infrastructure("buildings", [BBOX])
    assert {(el["type"], el["id"]) for el in buildings} == {("way", 200), ("relation", 200)}
    relation = next(el for el in buildings if el["type"] == "relation")
    assert relation["members"][0]["geometry"][0] == relation["members"][0]["geometry"][-1]
    metro = index.infrastructure("metro", [BBOX])
    assert {(el["type"], el["id"]) for el in metro} == {("node", 20), ("way", 203)}
    monkeypatch.setattr(osm_router, "index", index)
    assert client.get("/api/osm/buildings", params={"bbox": "73.80,18.50,73.90,18.60"}).status_code == 200
    assert client.get("/api/osm/metro", params={"bbox": "73.80,18.50,73.90,18.60"}).json()["elements"] == metro


def test_old_indexes_advertise_only_the_categories_they_hold(tmp_path, client, monkeypatch):
    import sqlite3
    index = make_index(tmp_path)
    with sqlite3.connect(index.path) as db:
        db.execute("DELETE FROM meta WHERE key = 'capabilities'")
        db.execute("DROP TABLE infrastructure")
        db.execute("DROP TABLE infrastructure_rtree")
    assert index.status()["capabilities"] == ["roads", "signals"]
    monkeypatch.setattr(osm_router, "index", index)
    assert client.get("/api/osm/buildings", params={"bbox": "73.80,18.50,73.90,18.60"}).status_code == 409
    assert len(index.ways([BBOX])) == 2
