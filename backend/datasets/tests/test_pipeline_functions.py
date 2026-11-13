"""Unit tests for pure functions of the global geospatial pipelines (tiny synthetic fixtures, no network)."""
import json

import numpy as np
import pytest

from datasets.pipelines import _common as C
from datasets.pipelines import _raster as R


# ---------- _common ----------
def test_bbox_coverage_and_tiles():
    assert C.bbox_coverage_fraction(C.PUNE_BBOX) == pytest.approx(1.0)
    assert C.bbox_coverage_fraction((73.70, 18.40, 73.875, 18.70)) == pytest.approx(0.5)
    assert C.bbox_coverage_fraction((80, 10, 81, 11)) == 0.0
    assert C.one_degree_tiles(C.PUNE_BBOX) == [(18, 73), (18, 74)]
    assert C.bbox_intersects((0, 0, 1, 1), (0.5, 0.5, 2, 2)) and not C.bbox_intersects((0, 0, 1, 1), (1, 1, 2, 2))


def test_manifest_merge_and_sha(tmp_path):
    f = tmp_path / "a.bin"
    f.write_bytes(b"abc")
    e = C.file_entry(f)
    assert e["sha256"] == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    C.write_manifest(tmp_path, {"source_id": "x"}, [e])
    C.write_manifest(tmp_path, {"licence": "L"}, [{**e, "size_bytes": 3, "notes": "again"}])
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert m["source_id"] == "x" and m["licence"] == "L" and len(m["files"]) == 1 and m["files"][0]["notes"] == "again"


# ---------- _raster ----------
def test_slope_of_known_plane():
    y, x = np.mgrid[0:20, 0:20]
    dem = 0.1 * x * 30.0  # rises 0.1 m per metre eastward on a 30 m grid
    s = R.slope_degrees(dem, 30, 30)
    assert np.allclose(s, np.degrees(np.arctan(0.1)), atol=1e-4)


def test_hillshade_flat_and_range():
    hs = R.hillshade(np.zeros((5, 5)), 30, 30, altitude=45)
    assert hs.dtype == np.uint8 and np.all(hs == int(np.sin(np.radians(45)) * 255))


def test_priority_flood_fills_pit_and_drains_flats():
    dem = np.full((5, 5), 10.0)
    dem[2, 2] = 5.0  # pit
    z = R.priority_flood_epsilon(dem, eps=0.01)
    assert z[2, 2] > 10.0  # filled above the rim plus epsilon gradient
    assert z.min() >= 10.0
    flat = np.ones((4, 6))
    zf = R.priority_flood_epsilon(flat, eps=0.001)
    # every interior cell must be strictly higher than at least one neighbour (drains)
    for yy in range(1, 3):
        for xx in range(1, 5):
            nb = zf[yy - 1:yy + 2, xx - 1:xx + 2]
            assert (nb < zf[yy, xx]).any()


def test_diff_stats():
    a = np.array([1.0, 2.0, np.nan]); b = np.array([0.0, 0.0, 1.0])
    d = R.diff_stats(a, b)
    assert d["n"] == 2 and d["mean"] == pytest.approx(1.5) and d["rmse"] == pytest.approx(np.sqrt(2.5))


def test_write_cog_roundtrip(tmp_path):
    import rasterio
    from rasterio.transform import from_origin

    arr = np.arange(1100 * 1100, dtype="float32").reshape(1100, 1100)
    prof = {"crs": "EPSG:32643", "transform": from_origin(370000, 2070000, 30, 30), "width": 1100, "height": 1100,
            "nodata": np.nan}
    p = R.write_cog(tmp_path / "t.tif", arr, prof)
    with rasterio.open(p) as s:
        assert s.crs.to_epsg() == 32643 and s.read(1)[3, 7] == arr[3, 7] and s.overviews(1)
    chk = R.raster_check(p)
    assert chk["crs"] == "EPSG:32643" and chk["is_cog"]


# ---------- elevation ----------
def test_elevation_helpers():
    from datasets.pipelines import elevation as E

    assert E.km2_to_cells(1.0, 30.0) == 1111
    urls = E.cop_tile_urls()
    assert len(urls) == 2 and "N18_00_E073_00" in urls[0] and "N18_00_E074_00" in urls[1]
    fdir = np.array([[1, 1, 1]])  # all flow east -> last cell drains off-grid
    acc = np.array([[1.0, 2.0, 3.0]])
    out = E.drainage_outlets(fdir, acc, np.ones_like(acc, bool), 2)
    assert out == [(0, 2)]
    fdir2 = np.array([[1, 1, -1]])  # unresolved flat counts as an outlet
    assert E.drainage_outlets(fdir2, acc, np.ones_like(acc, bool), 1) == [(0, 2)]


# ---------- sentinel2 ----------
def test_s2_indices():
    from datasets.pipelines import sentinel2 as S

    nd = S.norm_diff(np.array([0.5, 0.0, 0.2]), np.array([0.1, 0.0, 0.2]))
    assert nd[0] == pytest.approx(0.6667, abs=1e-4) and np.isnan(nd[1]) and nd[2] == 0
    r = S.to_reflectance(np.array([0, 500, 2000], "uint16"), 1e-4, -0.1)
    assert np.isnan(r[0]) and r[1] == 0.0 and r[2] == pytest.approx(0.1)
    assert S.effective_offset(np.array([300, 700, 2000] * 50, "uint16"), 1e-4, -0.1) == 0.0
    assert S.effective_offset(np.array([1200, 1700, 3000] * 50, "uint16"), 1e-4, -0.1) == -0.1
    b0 = np.array([True, True, False, False]); b1 = np.array([True, False, True, False])
    assert S.change_classes(b0, b1, np.ones(4, bool)).tolist() == [2, 4, 3, 1]
    ag = S.agreement(b1, b0, np.ones(4, bool))
    assert ag["precision"] == 0.5 and ag["recall"] == 0.5 and ag["iou"] == pytest.approx(0.333, abs=1e-3)
    assert S.valid_mask_from_scl(np.array([3, 4, 8, 6])).tolist() == [False, True, False, True]


# ---------- landcover / water ----------
def test_landcover_and_water_helpers():
    from datasets.pipelines import landcover as L
    from datasets.pipelines import surface_water as W

    assert L.worldcover_tile(73.8, 18.5) == "N18E072"
    cls = np.array([[50, 50], [10, 0]], "uint8")
    a = L.class_areas(cls, 1e4)
    assert a["Built-up"]["km2"] == pytest.approx(0.02) and a["Built-up"]["pct"] == pytest.approx(66.67)
    assert W.gsw_tile(73.8, 18.5) == "70E_20N"
    s = W.occurrence_summary(np.array([0, 10, 60, 95, 255], "uint8"), 1e6)
    assert s["ever_water_km2"] == 3 and s["occ_ge_50_km2"] == 2 and s["occ_ge_90_km2"] == 1 and s["nodata_fraction"] == 0.2


# ---------- buildings ----------
def test_buildings_helpers():
    from shapely.geometry import box

    from datasets.pipelines import buildings as B

    assert B.quadkey(0.0001, 0.0001, 1) == "1"
    assert B.quadkey(-0.0001, -0.0001, 1) == "2"
    assert "123301200" in B.quadkeys_for_bbox(C.PUNE_BBOX)
    assert B.iou(box(0, 0, 2, 2), box(1, 0, 3, 2)) == pytest.approx(1 / 3)
    assert B.best_iou(box(0, 0, 1, 1), [box(5, 5, 6, 6), box(0, 0, 1, 1)]) == 1.0
    assert B.centroid_in_bbox(18.5, 73.8) and not B.centroid_in_bbox(18.8, 73.8)


# ---------- soil ----------
def test_soil_helpers():
    from datasets.pipelines import soil as S

    assert S.usda_texture(40, 40, 20) == "loam"
    assert S.usda_texture(20, 30, 50) == "clay"
    assert S.usda_texture(92, 5, 3) == "sand"
    assert S.usda_texture(5, 87, 8) == "silt"
    assert S.usda_texture(35, 26, 39) == "clay loam"
    assert S.usda_texture(float("nan"), 1, 1) == ""
    m = S.depth_weighted_mean([np.array([10.0]), np.array([20.0]), np.array([np.nan])], [5, 10, 15])
    assert np.isnan(m[0])
    m2 = S.depth_weighted_mean([np.array([10.0]), np.array([20.0]), np.array([30.0])], [5, 10, 15])
    assert m2[0] == pytest.approx((50 + 200 + 450) / 30)
    x0, y0, x1, y1 = S.igh_window()
    assert all(v % 250 == 0 for v in (x0, y0, x1, y1)) and x1 > x0 and y1 > y0


# ---------- chirps ----------
def test_chirps_parse_and_aggregate():
    from datasets.pipelines import chirps as CH

    payload = {"data": [{"date": "01/02/2001", "value": {"avg": 2.5}}, {"date": "01/01/2001", "value": {"avg": 0.0}},
                        {"date": "01/03/2001", "value": {"avg": -9999}}]}
    s = CH.parse_series(payload)
    assert s == [("2001-01-01", 0.0), ("2001-01-02", 2.5)]
    import datetime as dt

    days = [((dt.date(2001, 1, 1) + dt.timedelta(d)).isoformat(), 1.0 if d != 200 else 50.0) for d in range(365)]
    agg = CH.aggregate(days)
    assert agg["complete_years"] == [2001] and agg["annual_total_mm"][2001] == 414.0 and agg["annual_max_1day_mm"][2001] == 50.0
    assert CH.bbox_polygon()["coordinates"][0][0] == [73.70, 18.40]
