"""Terrain sampling + subsurface evidence API on tiny synthetic fixtures (SYNTHETIC test data, real code paths)."""
import json

import numpy as np
import pytest

X0, Y0, RES = 380000.0, 2050000.0, 30.0   # EPSG:32643, inside the Pune box


def _ll(x, y):
    from pyproj import Transformer
    return list(Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True).transform(x, y))


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    import pyogrio
    import geopandas as gpd
    import rasterio
    from rasterio.transform import from_origin
    from shapely.geometry import LineString

    for e in ("URBANOS_DATA_ROOT", "URBANOS_DATA_HOME", "URBANOS_RAW_DIR", "URBANOS_DERIVED_DIR", "URBANOS_DEM_VERSION"):
        monkeypatch.delenv(e, raising=False)
    monkeypatch.setenv("URBANOS_DATA_DIR", str(tmp_path))
    # DEM 6x6: z = 500 + col + 10*row; cell (5,5) nodata
    v = tmp_path / "derived/elevation_copdem30/v2"
    v.mkdir(parents=True)
    rows, cols = np.mgrid[0:6, 0:6]
    z = (500 + cols + 10 * rows).astype("float32")
    z[5, 5] = np.nan
    prof = dict(driver="GTiff", width=6, height=6, count=1, dtype="float32", crs="EPSG:32643",
                transform=from_origin(X0, Y0, RES, RES), nodata=np.nan)
    with rasterio.open(v / "dem_copglo30_epsg32643_30m.tif", "w", **prof) as d:
        d.write(z, 1)
    (v / "processing.json").write_text(json.dumps({"git_commit": "abc", "run_at": "2026-11-13T22:00:00+05:30",
                                                   "outputs": [{"path": "dem_copglo30_epsg32643_30m.tif", "sha256": "f" * 64}]}))
    (v / "overlay_slope_epsg4326.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (v / "overlays.json").write_text(json.dumps({"bounds_wgs84": {"west": 1, "south": 2, "east": 3, "north": 4},
                                                 "overlays": {"slope": {"file": "overlay_slope_epsg4326.png", "legend": []}}}))
    raw = tmp_path / "raw/copernicus_dem_glo30/2026-11-13"
    raw.mkdir(parents=True)
    (raw / "manifest.json").write_text(json.dumps({"spec_accuracy": "abs vertical <4 m LE90 (fixture)"}))
    # groundwater: one well 100 m north of the line start, one far away
    g = tmp_path / "derived/nwdp_groundwater_pune/2026-11-13"
    g.mkdir(parents=True)
    (g / "processing.json").write_text("{}")
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": _ll(X0 + 45, Y0 - 45 + 100)},
              "properties": {"station_id": "T:near", "agency": "CGWB", "village": "Near"}},
             {"type": "Feature", "geometry": {"type": "Point", "coordinates": _ll(X0 + 45 + 20000, Y0)},
              "properties": {"station_id": "T:far", "agency": "CGWB", "village": "Far"}}]
    (g / "gwl_stations_pune.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    (g / "gwl_observations_pune.csv").write_text(
        "station_id,agency,date,depth_to_water_m_bgl,source_file\nT:near,CGWB,2020-05-01,6.5,a\nT:near,CGWB,2024-11-01,3.25,a\n"
        "T:near,CGWB,2023-01-01,,a\nT:far,CGWB,2024-01-01,9,a\n")
    # soil: 2 cells, west one masked (urban -> NaN)
    s = tmp_path / "derived/soil_soilgrids250/v1"
    s.mkdir(parents=True)
    (s / "processing.json").write_text("{}")
    sp = dict(prof, width=2, height=1, transform=from_origin(X0 - 150, Y0, 250, 250))
    for k in ("clay", "sand", "silt", "bdod", "cfvo", "soc"):
        with rasterio.open(s / f"soil_{k}_0-30cm_epsg32643_250m.tif", "w", **sp) as d:
            d.write(np.array([[np.nan, 40.0]], "float32"), 1)
    # sewer crossing the line at x = X0+75, inverts 550 -> 548 from south to north
    w = tmp_path / "derived/pmc_sewage_pipelines_fgb/v1"
    w.mkdir(parents=True)
    (w / "processing.json").write_text("{}")
    pipe = LineString([_ll(X0 + 75, Y0 - 150), _ll(X0 + 75, Y0 - 30)])
    far = LineString([_ll(X0 + 75, Y0 - 160 - 5000), _ll(X0 + 80, Y0 - 5000)])
    near = LineString([_ll(X0 + 120, Y0 - 45 + 30), _ll(X0 + 140, Y0 - 45 + 30)])
    cols_ = dict(objectid=["1", "2", "3"], pipeline_i=["P1", "P2", "P3"], label=["L1", "L2", "L3"], drainaige_=["Collection_Sewer"] * 3,
                 material_o=["RCC"] * 3, pipeline_d=["300", "x", "450"], start_inve=["550", "1", "549"], end_invert=["548", "1", ""],
                 tl_start_m=["552", "1", "551"], tl_end_man=["551", "1", "551"], actual_dep=["2", "1", "2"], sd_name=["SD"] * 3,
                 remarks=["r"] * 3, start_manh=["m1"] * 3, end_manhol=["m2"] * 3)
    pyogrio.write_dataframe(gpd.GeoDataFrame(cols_, geometry=[pipe, far, near], crs="EPSG:4326"), w / "pmc_sewage_pipelines.fgb",
                            driver="FlatGeobuf", SPATIAL_INDEX="YES")
    return tmp_path


def _line():  # west->east along row 1.5 (cell centres rows 1/2 -> y = Y0-45... use y = Y0 - 60 (between rows 1 and 2))
    return [_ll(X0 + 15, Y0 - 60), _ll(X0 + 135, Y0 - 60)]


def test_bilinear_point_and_status(data_dir):
    from terrain.dem import get_dem
    dem = get_dem()
    # cell centre (row 1, col 2) -> exact 512
    assert dem.sample_xy(X0 + 75, Y0 - 45) == (512.0, "ok")
    # midway between rows 1 and 2, cols 2 and 3 -> 500 + 2.5 + 15
    v, st = dem.sample_xy(X0 + 90, Y0 - 60)
    assert st == "ok" and abs(v - 517.5) < 1e-6
    assert dem.sample_xy(X0 + 160, Y0 - 160)[1] == "nodata"       # touches the NaN cell: never filled
    assert dem.sample_xy(X0 - 100, Y0)[1] == "outside_coverage"


def test_point_and_profile_api(client, data_dir):
    lon, lat = _ll(X0 + 75, Y0 - 45)
    r = client.get("/api/terrain/point", params={"lon": lon, "lat": lat}).json()
    assert r["elevation_m"] == pytest.approx(512.0, abs=0.01) and r["status"] == "ok"
    ds = r["dataset"]
    assert ds["dataset_id"] == "elevation_copdem30" and ds["version"] == "v2" and ds["surface"] == "DSM"
    assert ds["warning"] == "DSM: includes buildings/trees — screening only"
    assert "EGM2008" in ds["vertical_datum"] and "fixture" in ds["vertical_accuracy"] and ds["suitability"] == "screening"
    assert ds["file_sha256"] == "f" * 64
    far = client.get("/api/terrain/point", params={"lon": 72.0, "lat": 18.5}).json()
    assert far["elevation_m"] is None and far["status"] == "outside_coverage"
    p = client.post("/api/terrain/profile", json={"coordinates": _line(), "step_m": 30}).json()
    assert p["summary"]["n"] == len(p["samples"]) >= 5
    assert p["samples"][0]["chainage_m"] == 0 and p["samples"][-1]["chainage_m"] == pytest.approx(p["length_m_utm"], abs=0.05)
    assert p["samples"][0]["elevation_m"] == pytest.approx(515.0, abs=0.05)   # col 0, between rows 1-2
    assert all(s["segment"] == 0 for s in p["samples"]) and p["dataset"]["dataset_version_id"] is None  # not imported here
    assert client.post("/api/terrain/profile", json={"coordinates": [[73.8, 18.5]]}).status_code == 422
    assert client.get("/api/terrain/point", params={"lon": 999, "lat": 0}).status_code == 422


def test_overlays_api(client, data_dir):
    m = client.get("/api/terrain/overlays").json()
    assert m["overlays"]["slope"]["url"] == "/api/terrain/overlays/slope.png" and m["warning"].startswith("DSM")
    assert client.get("/api/terrain/overlays/slope.png").status_code == 200
    assert client.get("/api/terrain/overlays/hillshade.png").status_code == 404   # not rendered in the fixture
    assert client.get("/api/terrain/overlays/etc.png").status_code == 404


def test_subsurface_evidence(client, data_dir):
    e = client.post("/api/terrain/subsurface-evidence", json={"coordinates": _line(), "radius_km": 2, "sewer_near_m": 50}).json()
    gw = e["groundwater"]
    assert [w["station_id"] for w in gw["wells"]] == ["T:near"]                     # far well outside 2 km
    w = gw["wells"][0]
    assert w["latest"] == {"date": "2024-11-01", "depth_m_bgl": 3.25} and w["n_obs"] == 2   # blank value skipped
    assert w["distance_m"] == pytest.approx(115, abs=2) and "not interpolated" in w["classification"]
    assert w["well_depth_m"] is None and "NOT interpolated" in gw["statement"]
    soil = e["soil"]
    assert soil["points"][0]["status"].startswith("UNKNOWN") and soil["points"][0]["values"]["clay"] is None
    assert soil["points"][-1]["values"]["clay"] == 40.0 and soil["n_unknown"] >= 1
    sw = e["sewers"]
    assert len(sw["crossings"]) == 1
    c = sw["crossings"][0]
    assert c["pipeline_id"] == "P1" and c["quality_level"] == "QL-D" and c["certainty"] == "design/unverified"
    assert c["invert_at_crossing_m"] == pytest.approx(548.5, abs=0.02)     # 3/4 of the way from 550 to 548
    assert c["chainage_m_utm"] == pytest.approx(60, abs=0.5) and c["diameter_m"] == 0.3
    assert c["dsm_at_crossing_m"] == pytest.approx(517.0, abs=0.01) and c["invert_below_dsm_m"] == pytest.approx(-31.5, abs=0.05)
    assert [n["pipeline_id"] for n in sw["near"]] == ["P3"] and sw["near"][0]["end_invert_m"] is None   # blank = UNKNOWN
    assert "QL-D" in sw["statement"] and sw["datum_check"]["n"] >= 1
    b = e["boreholes"]   # the shared test DB may hold boreholes imported by other tests: either listed, or the gap message
    if b["records"]:
        assert b["status"] == "ok" and all(r["distance_m"] <= 2000 for r in b["records"])
    else:
        assert b["message"] == "No borehole records — required: site investigation"
    from terrain import evidence as EV
    none = EV.boreholes(EV.Alignment(_line()), 2.0, db=None)
    assert none["records"] == [] and none["status"] == "none" and none["message"] == "No borehole records — required: site investigation"
    assert "AGS4" in none["import_hint"]


def test_evidence_missing_datasets(client, tmp_path, monkeypatch):
    for e in ("URBANOS_DATA_ROOT", "URBANOS_DATA_HOME", "URBANOS_RAW_DIR", "URBANOS_DERIVED_DIR"):
        monkeypatch.delenv(e, raising=False)
    monkeypatch.setenv("URBANOS_DATA_DIR", str(tmp_path / "empty"))
    assert client.get("/api/terrain/info").status_code == 503
    e = client.post("/api/terrain/subsurface-evidence", json={"coordinates": [[73.85, 18.5], [73.86, 18.51]]}).json()
    assert e["dem"] is None and e["groundwater"]["status"] == "dataset not on disk" and e["sewers"]["status"] == "dataset not on disk"
