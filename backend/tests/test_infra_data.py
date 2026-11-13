"""
Infrastructure data into the registry, Explore and coordination (docs/urbanos/INFRASTRUCTURE_DATA.md).
Every file, feature, level and footprint here is SYNTHETIC (made up in a temporary directory); nothing is Pune data.
"""
import hashlib
import json
import os
import tempfile

import pytest

X, Y = 73.950, 18.450     # SYNTHETIC location, away from the other tests' corridors


def _w(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = data if isinstance(data, bytes) else json.dumps(data).encode()
    with open(path, "wb") as f:
        f.write(raw)
    return hashlib.sha256(raw).hexdigest()


# ── 1. registry classification overrides ───────────────────────────────────────────────────────────────────────────
def _raw_unclassified(root, sid):
    d = os.path.join(root, "raw", sid, "2026-11-13")
    sha = _w(os.path.join(d, "data.bin"), b"SYNTHETIC")
    _w(os.path.join(d, "manifest.json"), {"url": "https://example.invalid/data.bin", "licence": "SYNTHETIC test licence",
                                          "files": [{"path": "data.bin", "sha256": sha}], "crs": "EPSG:4326",
                                          "coverage_bbox": [73.7, 18.4, 74.05, 18.7]})


def test_overrides_classify_new_and_already_registered_versions(client, monkeypatch):
    root = tempfile.mkdtemp(prefix="urbanos-infra-test-")
    ov = os.path.join(root, "overrides.json")
    _w(ov, {"datasets": {"t_infra_new": {"theme": "utilities", "data_class": "observed", "suitability": "screening", "reason": "SYNTHETIC reason A"},
                         "t_infra_old": {"theme": "drainage_network", "data_class": "observed", "suitability": "engineering", "reason": "SYNTHETIC reason B"}}})
    # registered before the override existed → unclassified, classification check fails
    _raw_unclassified(root, "t_infra_old")
    monkeypatch.setenv("URBANOS_CLASSIFICATION_OVERRIDES", os.path.join(root, "absent.json"))
    client.post("/api/datasets/import", json={"root": root})
    old = client.get("/api/datasets/t_infra_old").json()
    assert old["active_version"]["data_class"] is None
    assert {c["check"]: c["status"] for c in old["active_version"]["quality_checks"]}["classification"] == "fail"
    # with the override: the old version is filled (fill-only), a new dir is registered classified
    _raw_unclassified(root, "t_infra_new")
    monkeypatch.setenv("URBANOS_CLASSIFICATION_OVERRIDES", ov)
    rep = client.post("/api/datasets/import", json={"root": root}).json()
    by = {e["dir"]: e for e in rep["entries"]}
    assert by[os.path.join("raw", "t_infra_old", "2026-11-13")]["result"] == "unchanged"
    assert "class observed" in by[os.path.join("raw", "t_infra_old", "2026-11-13")]["classified_from_overrides"]
    new = client.get("/api/datasets/t_infra_new").json()
    v = new["active_version"]
    assert new["theme"] == "utilities" and v["data_class"] == "observed" and v["suitability"] == "screening"
    assert "SYNTHETIC reason A" in v["notes"]
    old = client.get("/api/datasets/t_infra_old").json()
    v = old["active_version"]
    assert old["theme"] == "drainage_network" and v["data_class"] == "observed"
    assert v["suitability"] == "screening"  # engineering is never set from the overrides file
    cls = {c["check"]: c for c in v["quality_checks"]}["classification"]
    assert cls["status"] == "pass" and "SYNTHETIC reason B" in cls["detail"]
    # idempotent: nothing more to fill
    rep2 = client.post("/api/datasets/import", json={"root": root}).json()
    assert all("classified_from_overrides" not in e for e in rep2["entries"] if "t_infra" in e["dir"])


def test_committed_overrides_cover_known_acquisitions():
    from datasets.importer import load_overrides
    from datasets.vocab import DATA_CLASSES, THEMES
    ov, sha = load_overrides()
    assert sha and len(ov) >= 50
    for did, o in ov.items():
        assert o["theme"] in THEMES and o["data_class"] in DATA_CLASSES and o["suitability"] in ("visualisation", "screening"), did
        assert o.get("reason"), did
    assert ov["pmc_sewage_pipelines"]["theme"] == "utilities" and "DESIGN" in ov["pmc_sewage_pipelines"]["reason"]


# ── 2. infrastructure index pipeline (SYNTHETIC derived inputs) ────────────────────────────────────────────────────
def _fc(feats):
    return {"type": "FeatureCollection", "features": feats}


def _derived(root, did, fname, fc, licence="SYNTHETIC CKAN licence"):
    d = os.path.join(root, "derived", did, "2026-11-13")
    sha = _w(os.path.join(d, fname), fc)
    _w(os.path.join(d, "processing.json"), {"pipeline": "SYNTHETIC", "inputs": [{"file": "/nonexistent/x.kml", "sha256": "0", "url": "https://example.invalid/x",
                                                                                 "licence_as_stated": licence, "original_publisher": "SYNTHETIC publisher"}],
                                            "outputs": [{"file": fname, "sha256": sha}], "validation": {"geometry_types": {"LineString": len(fc["features"])}}})


@pytest.fixture(scope="module")
def infra_root():
    import geopandas as gpd
    from shapely.geometry import Polygon
    from pyproj import Transformer
    root = tempfile.mkdtemp(prefix="urbanos-infra-idx-")
    line = lambda dx: {"type": "LineString", "coordinates": [[X + dx, Y - 0.001], [X + dx, Y + 0.001]]}  # noqa: E731
    _derived(root, "pmc_sewage_pipelines", "sewer.geojson", _fc([
        {"type": "Feature", "id": "s1", "properties": {"pipeline_i": "SYN-1", "tl_start_m": "560.0", "start_inve": "557.5", "tl_end_man": "560.2",
                                                       "end_invert": "557.0", "pipeline_d": "600"}, "geometry": line(0.0)},
        {"type": "Feature", "id": "s2", "properties": {"pipeline_i": "SYN-2", "tl_start_m": "0", "start_inve": "0", "pipeline_d": "300"}, "geometry": line(0.0003)},
    ]))
    _derived(root, "pmc_stormwater_drains", "swd.geojson", _fc([
        {"type": "Feature", "properties": {"category": "Storm water drains", "basin_name": "SYN"}, "geometry": line(-0.0003)},
        {"type": "Feature", "properties": {"category": "Road_Sewer", "pipeline_i": "SYN-1"}, "geometry": line(0.0)},
        {"type": "Feature", "properties": {"category": "Nalla"}, "geometry": line(0.0006)},
    ]))
    # merged buildings layer (EPSG:32643 FlatGeobuf like the real one): one OSM footprint, one ML twin, one ML-only
    tr = Transformer.from_crs(4326, 32643, always_xy=True)
    sq = lambda cx, cy, h=0.00005: Polygon([tr.transform(cx + a, cy + b) for a, b in ((-h, -h), (h, -h), (h, h), (-h, h))])  # noqa: E731
    g = gpd.GeoDataFrame({"source": ["osm", "google_open_buildings_v3", "ms_global_ml_buildings"],
                          "source_id": ["way/1", "SYNPLUS", "q:1"], "confidence": [-1.0, 0.81, -1.0], "area_m2": [100.0, 98.0, 120.0],
                          "osm_overlap_frac": [1.0, 0.9, 0.0], "in_osm": ["True", "True", "False"], "in_google": [None, None, None],
                          "in_ms": [None, None, None], "height_m": [-1.0, -1.0, -1.0], "osm_building": ["yes", None, None],
                          "class": ["observed(community-mapped)", "derived(ML)", "derived(ML)"],
                          "status": ["osm", "agrees_with_osm", "ml_only_candidate"]},
                         geometry=[sq(X + 0.0001, Y), sq(X + 0.0001, Y), sq(X - 0.0001, Y + 0.0005)], crs=32643)
    d = os.path.join(root, "derived", "buildings_comparison", "v1")
    os.makedirs(d)
    fgb = os.path.join(d, "b.fgb")
    g.to_file(fgb, driver="FlatGeobuf")
    from datasets.pipelines.gov_common import sha256_file
    _w(os.path.join(d, "processing.json"), {"run_at": "SYNTHETIC", "inputs": [], "outputs": [{"path": "b.fgb", "sha256": sha256_file(fgb)}]})
    old = {k: os.environ.get(k) for k in ("URBANOS_DERIVED_DIR",)}
    os.environ["URBANOS_DERIVED_DIR"] = os.path.join(root, "derived")
    from datasets.pipelines import infra_index
    path = infra_index.run("v1", only=["sewer", "storm_drains", "buildings"])
    for k, v in old.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    return {"root": root, "index": str(path)}


def test_index_rules_storm_drains_sewer_depth_buildings(infra_root):
    import sqlite3
    con = sqlite3.connect(infra_root["index"])
    assert con.execute("select count(*) from f_storm_drains").fetchone()[0] == 1          # only the labelled row
    proc = json.load(open(os.path.join(os.path.dirname(infra_root["index"]), "processing.json")))
    dropped = proc["validation"]["layers"]["storm_drains"]["dropped"]
    assert dropped == {"sewer category (sewer rows inside the storm-water file)": 1, "category 'Nalla'": 1}
    s = {json.loads(p)["pipeline_i"]: json.loads(p) for (p,) in con.execute("select props from f_sewer")}
    a = s["SYN-1"]
    assert a["invert_depth_max_m"] == 3.2 and a["invert_depth_min_m"] == 2.5 and a["top_depth_m"] == 1.9
    assert "DESIGN" in a["depth_basis"] and a["levels_status"] == "design, unverified"
    assert s["SYN-2"]["invert_depth_max_m"] is None and s["SYN-2"]["top_depth_m"] is None   # zero levels → UNKNOWN, not 0
    b = [json.loads(p) for (p,) in con.execute("select props from f_buildings order by fid")]
    assert [x["data_class"] for x in b] == ["observed", "inferred", "inferred"]
    assert all(x["height_m"] is None for x in b) and b[1]["confidence"] == 0.81 and b[0]["confidence"] is None
    lic = con.execute("select licence from layers where id='sewer'").fetchone()[0]
    assert "SYNTHETIC CKAN licence" in lic and "NON-COMMERCIAL" in lic


def test_infra_api_bbox_cap_and_meta(client, infra_root, monkeypatch):
    monkeypatch.setenv("URBANOS_INFRA_INDEX", infra_root["index"])
    j = client.get("/api/infra/layers").json()
    ids = {l["id"]: l for g in j["groups"] for l in g["layers"]}
    assert {"sewer", "storm_drains", "buildings"} <= set(ids) and ids["sewer"]["data_class"] == "observed"
    assert j["traffic_counts"]["status"] == "none_from_official_sources" and "CAPTCHA" in j["traffic_counts"]["detail"]
    bb = f"{X - 0.01},{Y - 0.01},{X + 0.01},{Y + 0.01}"
    fc = client.get("/api/infra/layers/buildings/features", params={"bbox": bb, "limit": 1}).json()
    assert fc["returned"] == 1 and fc["truncated"] and fc["not_shown"] == 2 and "more in this view not shown" in fc["message"]
    assert fc["meta"]["licence"] and fc["meta"]["data_class"] == "derived"
    big = client.get("/api/infra/layers/buildings/features", params={"bbox": "73.7,18.4,74.05,18.7"}).json()
    assert big["too_large"] and big["features"] == []
    assert client.get("/api/infra/layers/nope/features", params={"bbox": bb}).status_code == 404
    pop = client.get("/api/infra/census2011").json()
    assert pop["mappable"] is False


# ── 3. coordination: reference networks as QL-D records + building footprints ──────────────────────────────────────
def test_detection_with_pmc_records_and_buildings(client, infra_root, monkeypatch):
    monkeypatch.setenv("URBANOS_INFRA_INDEX", infra_root["index"])
    from database.connection import SessionLocal
    from coordination.pmc_import import import_reference_networks
    with SessionLocal() as db:
        rep = import_reference_networks(db, "Importer T")
        db.commit()
        assert rep["sewer"]["records"] == 2 and rep["sewer"]["with_depth"] == 1 and rep["storm_drains"]["records"] == 1
        again = import_reference_networks(db, "Importer T")
        assert {v["result"] for v in again.values()} == {"unchanged"}
    recs = client.get("/api/coordination/subsurface/records").json()
    assert all(not r["dataset_id"].startswith("ssd_ref_") for r in recs["records"]) and recs["reference_datasets_not_listed"]
    near = client.get("/api/coordination/subsurface/records", params={"bbox": f"{X - 0.001},{Y - 0.002},{X + 0.001},{Y + 0.002}"}).json()["records"]
    syn1 = next(r for r in near if r["external_id"] == "SYN-1")
    assert syn1["quality_level"] == "QL-D" and syn1["z_certainty"] == "estimated" and syn1["z_min_m"] == -3.2 and syn1["z_max_m"] == -1.9
    assert next(r for r in near if r["external_id"] == "SYN-2")["z_certainty"] == "unknown"

    pid = client.post("/api/planning/projects", json={"name": "SYNTHETIC infra crossing", "description": "SYNTHETIC", "created_by": "Planner T"}).json()["id"]
    el = client.post(f"/api/coordination/projects/{pid}/elements", json={
        "kind": "tunnel", "name": "SYNTHETIC tunnel", "geometry": {"type": "LineString", "coordinates": [[X - 0.0008, Y], [X + 0.0008, Y]]},
        "width_m": 4, "z_min_m": -12, "z_max_m": -8, "certainty": "estimated", "created_by": "Planner T"}).json()
    run = client.post(f"/api/coordination/projects/{pid}/detect", json={"run_by": "Coordinator T"}).json()
    rows = [c for c in run["conflicts"] if c["element_a_id"] == el["id"]]
    util = {c["evidence"]["b"]["external_id"]: c for c in rows if c["b_type"] == "subsurface_utility"}
    # sewer with design levels: tunnel crown −8 m is below the pipe invert −3.2 m → separated, never "clear"
    assert util["SYN-1"]["class"] == "vertically_separated" and util["SYN-1"]["vertical_gap_m"] == pytest.approx(4.8)
    assert util["SYN-1"]["evidence"]["b"]["quality_level"] == "QL-D" and "DESIGN" in util["SYN-1"]["evidence"]["b"]["depth_basis"]
    assert util["SYN-2"]["class"] == "potential_conflict"            # no levels → depth UNKNOWN
    bld = [c for c in rows if c["b_type"] == "building"]
    srcs = sorted(c["evidence"]["b"]["source"] for c in bld)
    assert srcs == ["osm"]           # the ML twin of the OSM footprint is not reported again; the ML-only footprint is not crossed
    b0 = bld[0]
    assert b0["class"] == "potential_conflict" and b0["evidence"]["b"]["data_class"] == "observed"
    assert b0["evidence"]["b"]["height_m"] is None and b0["evidence"]["b"]["foundation_depth"] == "UNKNOWN"
    summary = client.get(f"/api/coordination/runs/{run['id']}").json()
    assert summary["summary"]["buildings"]["available"] is True and summary["summary"]["layers"]["building"] >= 1
