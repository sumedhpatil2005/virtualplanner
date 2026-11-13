"""
Dataset registry (docs/urbanos/DATA_QUALITY_AND_PROVENANCE.md). Every file, manifest and record written here is SYNTHETIC
test data in a temporary directory; nothing is Pune data.
"""
import hashlib
import json
import os
import tempfile
import uuid

import pytest

from datasets import updates


def _w(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = data if isinstance(data, bytes) else json.dumps(data).encode()
    with open(path, "wb") as f:
        f.write(raw)
    return hashlib.sha256(raw).hexdigest()


@pytest.fixture()
def root():
    return tempfile.mkdtemp(prefix="urbanos-data-test-")


def _ds(client, did):
    r = client.get(f"/api/datasets/{did}")
    assert r.status_code == 200, r.text
    return r.json()


def _feature(client, fid):
    return client.get(f"/api/datasets/features/{fid}").json()


def test_seeded_datasets_in_app(client):
    osm = _ds(client, "osm_geofabrik_western_zone")
    v = osm["active_version"]
    assert v["observation_end"] == "2026-11-01T21:21:36Z"
    assert v["sha256"] == "15660b2094c5414e0e2a2d7b4304ef3db42cbb123375cc10feab4d5bdb4bec19"
    assert v["data_class"] == "observed" and v["suitability"] == "screening"
    assert "ODbL" in v["licence_text"] and osm["source"]["publisher"].startswith("Geofabrik")
    checks = {c["check"]: c for c in v["quality_checks"]}
    assert checks["pune_coverage"]["status"] == "pass" and checks["crs"]["status"] == "pass"
    # the test environment has no pbf at the recorded path: checksum must fail, never pass
    assert checks["checksum"]["status"] in ("fail", "unknown")
    demo = _ds(client, "twincity_demo_seed")
    assert demo["status"] == "synthetic" and demo["active_version"]["data_class"] == "synthetic"
    cmp08 = _ds(client, "cmp2008_river_screenline")
    assert {c["check"]: c["status"] for c in cmp08["active_version"]["quality_checks"]}["staleness"] == "fail"
    assert client.get("/api/datasets/vocabulary").json()["pune_bbox"] == [73.70, 18.40, 74.05, 18.70]


def test_environment_catalogue_absorbed_not_duplicated(client):
    layers = client.get("/api/coordination/environment-layers").json()["layers"]   # existing API keeps working
    assert len(layers) == 17
    lst = {d["id"]: d for d in client.get("/api/datasets").json()}
    assert lst["env:flood_lines"]["catalogue_ref"] == "environment_layers:flood_lines"
    assert lst["env:flood_lines"]["status"] == "not_acquired" and lst["env:flood_lines"]["recommended_sources"]
    # OSM-derived catalogue rows are backed by the feasibility-layers dataset, not mirrored twice
    assert "env:osm_water" not in lst and "osm_water" in lst["osm_feasibility_layers"]["backs_catalogue"]
    assert "env:osm_metro" not in lst


def test_feature_status_blocked_with_reasons(client):
    f = _feature(client, "flood.screening")
    assert f["status"] == "blocked"
    assert any("Flood lines" in r and "not acquired" in r for r in f["reasons"])
    tr = _feature(client, "traffic.simulation")
    assert tr["status"] in ("partial", "blocked") and any("TAG M3.1" in r for r in tr["reasons"])
    allf = client.get("/api/datasets/features").json()
    caps = {x["capability"] for x in allf["features"]}
    assert {"Explore", "Design", "Underground", "Environment", "Flood/drainage", "Traffic", "Emissions", "Population", "Coordination"} <= caps


def test_population_synthetic_never_satisfies(client):
    # register a SYNTHETIC population dataset: the feature must stay blocked
    r = client.post("/api/datasets", json={"id": "test_synthetic_pop", "title": "SYNTHETIC population", "theme": "population", "created_by": "T"})
    assert r.status_code == 201
    r = client.post("/api/datasets/test_synthetic_pop/versions", json={"registered_by": "T", "data_class": "synthetic", "suitability": "screening",
                                                                       "coverage_bbox": [73.6, 18.3, 74.1, 18.8], "crs": "EPSG:4326"})
    assert r.status_code == 201 and r.json()["review_status"] == "active"
    f = _feature(client, "population.exposure")
    dep = next(d for d in f["dependencies"] if d["theme"] == "population")
    assert dep["state"] != "satisfied" and f["status"] == "blocked"


def _raw_tree(root, source="test_dem_src", date="2026-11-13", payload=b"SYNTHETIC DEM BYTES", **extra):
    d = os.path.join(root, "raw", source, date)
    sha = _w(os.path.join(d, "dem.tif"), payload)
    man = {"url": "https://example.invalid/dem.tif", "retrieved_at": "2026-11-13T20:00:00+05:30", "sha256": sha,
           "size": len(payload), "filename": "dem.tif", "licence": {"text": "SYNTHETIC test licence", "url": "https://example.invalid/licence"},
           "publisher": "SYNTHETIC publisher", "theme": "elevation", "crs": "EPSG:4326", "resolution": "30 m",
           "bbox": [73.6, 18.3, 74.1, 18.8], "data_class": "observed", "suitability": "screening",
           "http_headers": {"ETag": "\"abc\"", "Last-Modified": "Wed, 11 Nov 2026 10:00:00 GMT"}, "weird_key": 1, **extra}
    _w(os.path.join(d, "manifest.json"), man)
    return d, sha


def test_importer_registers_idempotent_and_unblocks_feature(client, root):
    before = _feature(client, "underground.alignment_profile")
    assert before["status"] == "blocked"
    _raw_tree(root)
    os.makedirs(os.path.join(root, "raw", "half_written", "2026-11-13"))
    with open(os.path.join(root, "raw", "half_written", "2026-11-13", "manifest.json"), "w") as f:
        f.write('{"url": "https://exa')   # concurrent writer, not finished
    rep = client.post("/api/datasets/import", json={"root": root, "actor": "Importer T"}).json()
    res = {e["dir"]: e for e in rep["entries"]}
    assert res[os.path.join("raw", "test_dem_src", "2026-11-13")]["result"] == "registered"
    assert res[os.path.join("raw", "half_written", "2026-11-13")]["result"] == "skipped"
    ds = _ds(client, "test_dem_src")
    v = ds["active_version"]
    assert ds["theme"] == "dem" and v["crs"] == "EPSG:4326" and v["licence_text"] == "SYNTHETIC test licence"
    assert v["http"]["etag"] == "\"abc\"" and v["stats"]["manifest_extra"] == {"weird_key": 1}
    assert {c["check"]: c["status"] for c in v["quality_checks"]}["checksum"] == "pass"
    assert ds["source"]["access_method"] == "download"
    after = _feature(client, "underground.alignment_profile")
    assert after["status"] == "ready", after
    assert after["wired"] is False   # data ready, but the profile still uses a flat datum: shown, not hidden
    # second scan: nothing new
    rep2 = client.post("/api/datasets/import", json={"root": root}).json()
    assert {e["result"] for e in rep2["entries"] if "test_dem_src" in e["dir"]} == {"unchanged"}
    assert len(_ds(client, "test_dem_src")["versions"]) == 1


def test_changed_manifest_is_new_pending_version_never_replacing_active(client, root):
    _raw_tree(root, source="test_dem_src2")
    client.post("/api/datasets/import", json={"root": root})
    first = _ds(client, "test_dem_src2")["active_version"]["id"]
    _raw_tree(root, source="test_dem_src2", date="2026-11-20", payload=b"SYNTHETIC DEM v2")
    client.post("/api/datasets/import", json={"root": root})
    ds = _ds(client, "test_dem_src2")
    assert ds["active_version"]["id"] == first and len(ds["pending_version_ids"]) == 1
    pending = ds["pending_version_ids"][0]
    r = client.post(f"/api/datasets/versions/{pending}/review", json={"decision": "activate", "reviewer": ""})
    assert r.status_code == 400
    r = client.post(f"/api/datasets/versions/{pending}/review", json={"decision": "activate", "reviewer": "Reviewer T", "note": "checked"})
    assert r.status_code == 200 and r.json()["review_status"] == "active"
    vs = {v["id"]: v for v in _ds(client, "test_dem_src2")["versions"]}
    assert vs[first]["review_status"] == "superseded" and vs[first]["sha256"]   # old version kept, readable


def test_versions_are_immutable(client, root):
    from database.connection import SessionLocal
    from datasets.models import DsDatasetVersionEntity, ImmutableVersionError
    _raw_tree(root, source="test_dem_immut")
    client.post("/api/datasets/import", json={"root": root})
    vid = _ds(client, "test_dem_immut")["active_version"]["id"]
    with SessionLocal() as db:
        v = db.get(DsDatasetVersionEntity, vid)
        v.sha256 = "0" * 64
        with pytest.raises(ImmutableVersionError):
            db.flush()
        db.rollback()
        v = db.get(DsDatasetVersionEntity, vid)
        db.delete(v)
        with pytest.raises(ImmutableVersionError):
            db.flush()
        db.rollback()


def test_derived_processing_lineage_quality_and_licence_inheritance(client, root):
    _, raw_sha = _raw_tree(root, source="test_lineage_src")
    d = os.path.join(root, "derived", "test_clip", "v1")
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": "a", "properties": {}, "geometry": {"type": "Point", "coordinates": [73.8, 18.5]}},
        {"type": "Feature", "id": "a", "properties": {}, "geometry": {"type": "Point", "coordinates": [73.8, 18.5]}},
        {"type": "Feature", "id": "b", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [[[73.8, 18.5], [73.9, 18.6], [73.9, 18.5], [73.8, 18.6], [73.8, 18.5]]]}},
    ]}
    out_sha = _w(os.path.join(d, "clip.geojson"), fc)
    _w(os.path.join(d, "processing.json"), {
        "pipeline": "datasets.pipelines.test_clip", "git_commit": "deadbeef", "parameters": {"bbox": [73.7, 18.4, 74.05, 18.7]},
        "inputs": [{"path": "raw/test_lineage_src/2026-11-13/dem.tif", "sha256": raw_sha}],
        "outputs": [{"path": "clip.geojson", "sha256": out_sha}], "validation": {"features": 3},
        "crs": "EPSG:4326", "bbox": [73.7, 18.4, 74.05, 18.7], "data_class": "derived", "suitability": "visualisation", "theme": "land_cover"})
    client.post("/api/datasets/import", json={"root": root})
    ds = _ds(client, "test_clip")
    v = ds["versions"][0]
    pr = v["processing_runs"][0]
    assert pr["git_commit"] == "deadbeef" and pr["inputs"][0]["version_id"]
    assert v["licence_text"].startswith("SYNTHETIC test licence") and "inherited" in v["notes"]
    checks = {c["check"]: c for c in v["quality_checks"]}
    assert checks["geometry_validity"]["status"] in ("warn", "fail") and "1 invalid" in checks["geometry_validity"]["detail"]
    assert checks["duplicates"]["status"] == "warn" and checks["pune_coverage"]["status"] == "pass"


def test_unclassified_manifest_cannot_satisfy_until_review(client, root):
    _raw_tree(root, source="test_unclassified", data_class=None, suitability=None, theme="noise")
    m = os.path.join(root, "raw", "test_unclassified", "2026-11-13", "manifest.json")
    doc = json.load(open(m))
    doc.pop("data_class"), doc.pop("suitability")
    _w(m, doc)
    client.post("/api/datasets/import", json={"root": root})
    f = _feature(client, "environment.noise")
    assert f["status"] == "blocked" and any("not recorded" in r for r in f["reasons"])


def test_engineering_needs_accuracy_and_official_source(client):
    client.post("/api/datasets", json={"id": "test_eng", "title": "SYNTHETIC eng", "theme": "other", "created_by": "T"})
    v = client.post("/api/datasets/test_eng/versions", json={"registered_by": "T", "data_class": "observed", "suitability": "engineering"}).json()
    assert v["suitability"] == "screening" and "engineering suitability needs" in v["notes"]


def test_update_check(client, monkeypatch):
    client.post("/api/datasets", json={"id": "test_upd", "title": "SYNTHETIC upd", "theme": "other", "created_by": "T"})
    client.post("/api/datasets/test_upd/versions", json={"registered_by": "T", "data_class": "observed", "suitability": "screening"})
    from database.connection import SessionLocal
    from datasets.models import DsDatasetEntity
    with SessionLocal() as db:
        db.get(DsDatasetEntity, "test_upd").update_check_json = json.dumps({"method": "http_head", "url": "https://example.invalid/x"})
        db.commit()
    headers = {"etag": "\"v1\"", "last-modified": "Mon, 02 Nov 2026 00:00:00 GMT"}
    monkeypatch.setattr(updates, "HTTP", lambda m, u: (200, dict(headers), b""))
    assert client.post("/api/datasets/test_upd/update-check", json={"checked_by": "T"}).json()["result"] == "first_seen"
    assert client.post("/api/datasets/test_upd/update-check", json={}).json()["result"] == "unchanged"
    headers["etag"] = "\"v2\""
    r = client.post("/api/datasets/test_upd/update-check", json={}).json()
    assert r["result"] == "changed" and r["new_version_id"]
    ds = _ds(client, "test_upd")
    assert ds["active_version"]["id"] != r["new_version_id"] and r["new_version_id"] in ds["pending_version_ids"]
    nv = next(v for v in ds["versions"] if v["id"] == r["new_version_id"])
    assert nv["sha256"] is None and nv["origin"] == "update_check" and "NOT downloaded" in nv["notes"]

    def boom(m, u):
        raise OSError("network unreachable")
    monkeypatch.setattr(updates, "HTTP", boom)
    assert client.post("/api/datasets/test_upd/update-check", json={}).json()["result"] == "error"
    assert client.post("/api/datasets/gap_rainfall_idf/update-check", json={}).json()["result"] == "not_checkable"


def test_subsurface_and_traffic_datasets_mirrored(client):
    csv = "utility_id,utility_type,owner,geometry,depth_m,diameter_m,quality_level,survey_method\nU1,water,SYNTHETIC,73.85 18.52;73.86 18.52,1.2,0.3,QL-B,SYNTHETIC\n"
    r = client.post("/api/coordination/subsurface/import", json={"record_type": "utility", "format": "csv", "content": csv,
                                                                 "name": "SYNTHETIC utilities " + uuid.uuid4().hex[:6], "imported_by": "T"})
    assert r.status_code in (200, 201), r.text
    sid = r.json()["dataset"]["id"] if "dataset" in r.json() else r.json()["id"]
    lst = {d["id"]: d for d in client.get("/api/datasets").json()}
    m = lst[f"subsurface:{sid}"]
    assert m["theme"] == "utilities" and m["active_version"]["data_class"] == "synthetic"
    # the original subsurface API still answers
    assert client.get(f"/api/coordination/subsurface/datasets/{sid}").status_code == 200
    f = _feature(client, "underground.utility_conflicts")
    assert next(d for d in f["dependencies"] if d["theme"] == "utilities")["state"] != "satisfied"


def test_manifest_shapes_written_by_acquisition_agents(client, root):
    """The shape the 2026-11-13 acquisition pipelines write (files[] with per-file headers, classification text, licence dict,
    processing run_at + parameters.bbox). Content SYNTHETIC."""
    d = os.path.join(root, "raw", "test_shape_dem_src", "2026-11-13")
    sha = _w(os.path.join(d, "tile.tif"), b"SYNTHETIC tile")
    _w(os.path.join(d, "manifest.json"), {
        "source_id": "test_shape_dem_src", "dataset": "SYNTHETIC DEM title", "classification": "observed (DSM)",
        "licence": {"publisher": "SYNTHETIC agency", "licence_name": "SYNTHETIC free licence", "quote": "free to use", "url": "https://example.invalid/l",
                    "attribution_required": "© SYNTHETIC", "verified_at": "Fri 2026-11-13 9:30 PM IST (UTC+05:30)"},
        "files": [{"filename": "tile.tif", "url": "https://example.invalid/tile.tif", "retrieved_at": "Fri 2026-11-13 9:07 PM IST (UTC+05:30)",
                   "http_headers": {"ETag": "\"e1\"", "Last-Modified": "Mon, 09 May 2022 14:07:11 GMT"}, "size_bytes": 14, "sha256": sha}],
        "manifest_updated_at": "Fri 2026-11-13 9:07 PM IST (UTC+05:30)", "vertical_datum": "EGM2008"})
    dd = os.path.join(root, "derived", "test_shape_elevation", "v1")
    osha = _w(os.path.join(dd, "dem_epsg32643.tif"), b"SYNTHETIC derived")
    _w(os.path.join(dd, "processing.json"), {
        "pipeline": "datasets.pipelines.elevation", "git_commit": "abc", "run_at": "Fri 2026-11-13 9:11 PM IST (UTC+05:30)",
        "classification": "derived", "suitability": "screening", "inputs": [{"path": os.path.join(d, "tile.tif"), "sha256": sha}],
        "parameters": {"bbox": [73.7, 18.4, 74.05, 18.7]}, "outputs": [{"path": "dem_epsg32643.tif", "sha256": osha}],
        "validation": {"nan_stat": float("nan")}})
    client.post("/api/datasets/import", json={"root": root})
    raw = _ds(client, "test_shape_dem_src")
    v = raw["active_version"]
    assert raw["title"] == "SYNTHETIC DEM title" and raw["theme"] == "dem"
    assert v["data_class"] == "observed" and v["suitability"] is None          # not stated → not assumed
    assert v["licence_text"].startswith("SYNTHETIC free licence") and "free to use" in v["licence_text"]
    assert v["http"]["etag"] == "\"e1\"" and v["retrieved_at"].startswith("Fri 2026-11-13 9:07 PM IST")
    assert raw["source"]["publisher"] == "SYNTHETIC agency" and "EGM2008" in v["notes"]
    der = _ds(client, "test_shape_elevation")
    dv = der["active_version"]
    assert der["theme"] == "dem" and dv["crs"].startswith("EPSG:32643") and dv["coverage_bbox"] == [73.7, 18.4, 74.05, 18.7]
    assert dv["processing_runs"][0]["finished_at"].startswith("Fri 2026-11-13 9:11") and dv["stats"]["validation"]["nan_stat"] is None
    assert {c["check"]: c["status"] for c in dv["quality_checks"]}["crs"] == "pass"


def test_patch_dataset_metadata_not_versions(client):
    client.post("/api/datasets", json={"id": "test_patch", "title": "SYNTHETIC", "theme": "other", "created_by": "T"})
    r = client.patch("/api/datasets/test_patch", json={"edited_by": "T", "theme": "drainage_network"})
    assert r.status_code == 200 and r.json()["theme"] == "drainage_network"
    assert client.patch("/api/datasets/test_patch", json={"edited_by": "T", "theme": "nonsense"}).status_code == 400
    from datasets.vocab import guess_theme
    assert guess_theme("pmc_stormwater_drains") == "drainage_network" and guess_theme("water_bodies_census_pune_2023") == "water_features"
    assert guess_theme("pmc_sewage_pipelines") == "utilities" and guess_theme("rainfall_chirps_boxavg") == "rainfall"
