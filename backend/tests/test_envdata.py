"""Environment data API (backend/envdata, /api/env-data) on tiny SYNTHETIC fixtures written to a temp derived/ tree.
No real dataset is needed; values here are test values only."""
import csv
import json
import os

import numpy as np
import pytest

from envdata import catalogue as cat
from envdata import render, series, trees


@pytest.fixture()
def derived(tmp_path, monkeypatch):
    d = tmp_path / "derived"
    monkeypatch.setenv("URBANOS_DERIVED_DIR", str(d))
    monkeypatch.setenv("URBANOS_RENDER_CACHE", str(tmp_path / "cache"))
    import rasterio
    from rasterio.transform import from_bounds
    # WorldCover: left half built-up (50), right half tree cover (10), one nodata column
    lc = d / "landcover_worldcover2021" / "v1"
    lc.mkdir(parents=True)
    arr = np.full((40, 40), 10, dtype="uint8")
    arr[:, :20] = 50
    arr[:, 39] = 0
    with rasterio.open(lc / "worldcover2021_epsg4326.tif", "w", driver="GTiff", width=40, height=40, count=1, dtype="uint8",
                       crs="EPSG:4326", transform=from_bounds(73.80, 18.50, 73.84, 18.54, 40, 40), nodata=0) as dst:
        dst.write(arr, 1)
    # UTM copy: 10 m pixels, 400 m x 400 m
    x0, y0 = 373000.0, 2047000.0
    utm = np.full((40, 40), 10, dtype="uint8")
    utm[:, :20] = 50
    with rasterio.open(lc / "worldcover2021_epsg32643_10m.tif", "w", driver="GTiff", width=40, height=40, count=1, dtype="uint8",
                       crs="EPSG:32643", transform=from_bounds(x0, y0, x0 + 400, y0 + 400, 40, 40), nodata=0) as dst:
        dst.write(utm, 1)
    (lc / "processing.json").write_text(json.dumps({"pipeline": "test", "git_commit": "abc", "run_at": "test",
                                                    "outputs": [{"path": "worldcover2021_epsg4326.tif", "sha256": "f" * 64}]}))
    # tree census CSV → index (the real pipeline's build())
    tc = d / "pmc_tree_census_2019" / "t"
    tc.mkdir(parents=True)
    with open(tc / "trees_pune.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["lon", "lat", "id", "girth_cm", "height_m", "canopy_dia_m", "condition", "ownership", "botanical_name",
                    "common_name", "local_name", "ward", "is_rare"])
        k = 1
        for i in range(30):
            for j in range(30):
                w.writerow([73.80 + i * 0.001, 18.50 + j * 0.001, k, 50 + i, 8, 4, "Healthy", "Private", "Mangifera indica L.",
                            "Mango", "Amba", "12", "TRUE" if k == 1 else "FALSE"])
                k += 1
    from datasets.pipelines import tree_index
    out = d / "pmc_tree_census_2019_index" / "v1"
    out.mkdir(parents=True)
    tree_index.build(tc / "trees_pune.csv", out / "trees_index.sqlite")
    trees._local.__dict__.clear()
    return d


def test_colourise_categorical_and_ramp():
    a = np.array([[10, 50], [0, 99]], dtype="uint8")
    out = render.colourise(a, {"mode": "categorical", "palette": {10: "#006400", 50: "#fa0000"}}, 0)
    assert tuple(out[0, 0]) == (0, 100, 0, 200) and tuple(out[0, 1]) == (250, 0, 0, 200)
    assert out[1, 0, 3] == 0 and out[1, 1, 3] == 0          # nodata and unknown class transparent
    f = np.array([[np.nan, -1.0, 0.8, 0.0]], dtype="float32")
    out = render.colourise(f, {"mode": "ramp", "stops": [(-0.2, "#000000"), (0.8, "#ffffff")], "transparent_below": None}, np.nan)
    assert out[0, 0, 3] == 0 and tuple(out[0, 1, :3]) == (0, 0, 0) and tuple(out[0, 2, :3]) == (255, 255, 255)
    occ = render.colourise(np.array([[0, 100]], dtype="uint8"), {"mode": "ramp", "stops": [(1, "#000000"), (100, "#0000ff")],
                                                                  "transparent_below": 1}, 255)
    assert occ[0, 0, 3] == 0 and occ[0, 1, 3] > 0             # 0 % occurrence is not drawn


def test_out_size_and_bbox_parse():
    assert render.out_size([73.7, 18.4, 74.05, 18.7], 1024)[0] == 1024
    w, h = render.out_size([0, 0, 1, 10], 1024)
    assert h == render.MAX_PX and w < 1024
    with pytest.raises(ValueError):
        render.parse_bbox("1,2,0,3")


def test_parse_ist_and_pick_level():
    assert series.parse_ist("Mon 2024-01-01 5:30 PM IST (UTC+05:30)") == "2024-01-01" + "T17:30:00+05:30"
    assert series.parse_ist("nonsense") is None
    levels = [0.04, 0.01, 0.0025, 0.000625]
    assert trees.pick_level([73.7, 18.4, 74.05, 18.7], levels) == 1   # whole city: 0.01° (0.0025° would be ~17k cells)
    assert trees.pick_level([73.85, 18.51, 73.86, 18.52], levels) == 3


def test_catalogue_statuses(client, derived):
    rows = {r["id"]: r for r in client.get("/api/env-data/catalogue").json()["layers"]}
    assert rows["landcover_worldcover2021"]["status"] == "available"
    assert rows["landcover_worldcover2021"]["processing"]["sha256"] == "f" * 64
    assert rows["s2_ndvi"]["status"] == "missing"            # not in the fixture tree: never claimed
    assert rows["flood_lines_pmc"]["status"] == "blocked" and "PMC permission" in rows["flood_lines_pmc"]["status_reason"]
    assert rows["s2_builtup_change"]["status"] == "rejected" and "F1 0.457" in rows["s2_builtup_change"]["status_reason"]
    for r in rows.values():
        assert r["licence"] and r["data_class"] in ("observed", "inferred", "estimated", "derived", "synthetic")
        assert r["suitability"] in ("visualisation", "screening", "engineering")
        assert r["suitability"] != "engineering"
    assert client.get("/api/env-data/layers/flood_lines_pmc/render.png", params={"bbox": "73.8,18.5,73.9,18.6"}).status_code == 409


def test_render_png_and_cache(client, derived):
    r = client.get("/api/env-data/layers/landcover_worldcover2021/render.png", params={"bbox": "73.79,18.49,73.85,18.55", "width": 120})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.headers["x-uos-bounds"] == "73.79,18.49,73.85,18.55" and r.headers["x-uos-cache"] == "miss"
    from PIL import Image
    import io
    im = np.array(Image.open(io.BytesIO(r.content)))
    assert im[0, 0, 3] == 0                                    # outside the data → transparent
    assert tuple(im[im.shape[0] // 2, 30, :3]) == (250, 0, 0)  # built-up half
    r2 = client.get("/api/env-data/layers/landcover_worldcover2021/render.png", params={"bbox": "73.79,18.49,73.85,18.55", "width": 120})
    assert r2.headers["x-uos-cache"] == "hit" and r2.content == r.content
    assert client.get("/api/env-data/layers/landcover_worldcover2021/render.png", params={"bbox": "x"}).status_code == 422


def test_landcover_areas_polygon(client, derived):
    from pyproj import Transformer
    t = Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True)
    ring = [t.transform(x, y) for x, y in [(373000, 2047000), (373400, 2047000), (373400, 2047400), (373000, 2047400), (373000, 2047000)]]
    j = client.post("/api/env-data/layers/landcover_worldcover2021/areas", json={"geometry": {"type": "Polygon", "coordinates": [ring]}}).json()
    by = {c["label"]: c for c in j["classes"]}
    assert abs(by["Built-up"]["km2"] - 0.08) < 0.005 and abs(by["Tree cover"]["km2"] - 0.08) < 0.005
    assert abs(by["Built-up"]["pct"] - 50) < 3


def test_trees_points_clusters_and_cap(client, derived):
    small = client.get("/api/env-data/trees", params={"bbox": "73.8,18.5,73.8045,18.5045", "limit": 100}).json()
    assert small["mode"] == "points" and small["total"] == 25 and small["returned"] == 25
    p = next(x for x in small["points"] if x["id"] == 1)
    assert p["common_name"] == "Mango" and p["girth_cm"] == 50 and p["is_rare"] == 1
    big = client.get("/api/env-data/trees", params={"bbox": "73.79,18.49,73.84,18.54", "limit": 100}).json()
    assert big["mode"] == "clusters" and big["total"] == 900 and sum(c["n"] for c in big["clusters"]) == 900
    assert "more than the 100-point cap" in big["message"]
    ring = [[73.7995, 18.4995], [73.8015, 18.4995], [73.8015, 18.5015], [73.7995, 18.5015], [73.7995, 18.4995]]
    cnt = client.post("/api/env-data/trees/count", json={"geometry": {"type": "Polygon", "coordinates": [ring]}}).json()
    assert cnt["count"] == 4 and cnt["rare"] == 1 and cnt["vintage"] == "2019"


def test_feature_wiring_flags(client):
    fs = {f["id"]: f for f in client.get("/api/datasets/features").json()["features"]}
    for fid in ("environment.vegetation", "environment.air_quality", "environment.surface_water", "environment.rainfall",
                "environment.soil", "environment.terrain_hydrology"):
        assert fs[fid]["wired"] is True, fid
    assert fs["flood.screening"]["wired"] is False            # no flood screening code: context layers only
    assert fs["environment.noise"]["wired"] is False
