"""Parser tests for the Indian-government / Pune source pipelines (tiny fixtures, no network)."""
import array
import json
from pathlib import Path

import pytest

from datasets.pipelines import gov_common as gc
from datasets.pipelines import imd_rainfall, nwdp_groundwater, opencity_pune
from datasets.pipelines.kml_reader import iter_features

FIX = Path(__file__).parent / "fixtures" / "gov"


# ---------------------------------------------------------------- KML reader
def test_kml_reader_geometries_and_attributes():
    feats = list(iter_features(FIX / "tiny.kml"))
    assert len(feats) == 7
    pipe = feats[0]
    assert pipe["id"] == "t.1"
    assert pipe["properties"] == {"name": "pipe A", "objectid": "1", "start_inve": "552.4"}
    # single-part MultiGeometry collapses to its part
    assert pipe["geometry"] == {"type": "LineString", "coordinates": [[73.85, 18.52], [73.86, 18.53]]}
    chamber = feats[1]
    assert chamber["properties"]["kind"] == "chamber"  # ExtendedData/Data/value
    assert chamber["geometry"]["coordinates"] == [73.8918744, 18.43541796]  # zero altitude dropped
    poly = feats[2]["geometry"]
    assert poly["type"] == "Polygon" and len(poly["coordinates"]) == 2
    assert poly["coordinates"][0][0] == poly["coordinates"][0][-1]  # ring closed by reader
    assert feats[5]["geometry"] is None


def test_kmz_equals_kml():
    a = list(iter_features(FIX / "tiny.kml"))
    b = list(iter_features(FIX / "tiny.kmz"))
    assert a == b


def test_derive_layer_filters_validates_and_counts(tmp_path):
    out = tmp_path / "x.geojson"
    stats = opencity_pune.derive_layer(FIX / "tiny.kml", out, line_length=True)
    assert stats["features_read"] == 7
    assert stats["null_geometry"] == 1
    assert stats["outside_study_box"] == 1          # Mumbai point
    assert stats["invalid_repaired_make_valid"] == 1  # bow-tie
    assert stats["duplicate_geometries"] == 1        # t.7 == t.1
    assert stats["features_written"] == 5
    assert 1.4 < stats["total_line_length_km_utm43n"] < 3.2  # two ~1.5 km pipes
    fc = json.loads(out.read_text())
    assert len(fc["features"]) == 5
    assert all(-180 <= c <= 180 for f in fc["features"] if f["geometry"]["type"] == "Point" for c in f["geometry"]["coordinates"][:1])


def test_staged_name_strip():
    assert opencity_pune.staged_original_name(Path("pmc_swd_chambers-0332a087.kml")) == "pmc_swd_chambers.kml"
    assert opencity_pune.staged_original_name(Path("abc.kml")) == "abc.kml"


def test_catalogue_snapshot_is_complete():
    cat = opencity_pune.load_catalogue()
    names = {d["name"] for d in cat["datasets"]}
    assert len(names) == 57  # groups:pune count on 2026-11-13
    assert {"pune-stormwater-drains", "pune-sewage-network", "pune-tree-census-2019"} <= names


# ---------------------------------------------------------------- IMD gridded rainfall
def _fake_grd(year: int, value_at=None) -> bytes:
    import calendar
    nd = 366 if calendar.isleap(year) else 365
    a = array.array("f", [-999.0]) * (nd * imd_rainfall.NX * imd_rainfall.NY)
    if value_at:
        (lon, lat), v = value_at
        i, j = imd_rainfall.cell_index(lon, lat)
        for d in range(nd):
            a[d * imd_rainfall.NX * imd_rainfall.NY + j * imd_rainfall.NX + i] = v
    return a.tobytes()


def test_imd_grid_size_check_and_extract():
    data = _fake_grd(2024, ((73.75, 18.5), 12.5))
    a = imd_rainfall.read_grd(data, 2024)
    rows = list(imd_rainfall.extract(a, 2024, [(73.75, 18.5), (74.0, 18.75)]))
    assert len(rows) == 366 * 2
    assert rows[0] == ("2024-01-01", 73.75, 18.5, 12.5)
    assert rows[1][3] is None  # UNDEF -> None (never 0)
    with pytest.raises(ValueError):
        imd_rainfall.read_grd(data, 2023)  # wrong length for a non-leap year


def test_imd_cells_for_pune_bbox():
    cells = imd_rainfall.cells_for_bbox()
    assert sorted(cells) == [(73.75, 18.5), (73.75, 18.75), (74.0, 18.5), (74.0, 18.75)]


# ---------------------------------------------------------------- NWDP groundwater
def test_gwl_extract_dedupes_and_drops_implausible(tmp_path, monkeypatch):
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "gwl_manual_quarterly_cgwb_mh_1991_2020.csv").write_bytes((FIX / "cgwb_tiny.csv").read_bytes())
    (raw / "ground_water_level_manual_quarterly_maharashtra_1970_2025.csv").write_bytes((FIX / "gsda_tiny.csv").read_bytes())
    out = tmp_path / "out"
    out.mkdir()
    res = nwdp_groundwater.extract_gwl(raw, out)
    s = res["stats"]
    assert s["rows_in_bbox"] == 6           # Nashik row excluded by bbox
    assert s["duplicate_dropped"] == 1
    assert s["missing_value"] == 1
    assert s["implausible_value_dropped"] == 1
    assert s["observations_written"] == 3
    st = json.loads((out / "gwl_stations_pune.geojson").read_text())["features"]
    gsda = [f for f in st if f["properties"]["station_id"].startswith("GSDA:")][0]["properties"]
    assert gsda["last_date"] == "2025-09-26" and gsda["last_value_m_bgl"] == 1.5 and gsda["n_obs"] == 2
    assert gsda["classification"] == "observed"


def test_parse_date_formats():
    assert nwdp_groundwater.parse_date("10-01-2020 06:00") == "2020-01-10"
    assert nwdp_groundwater.parse_date("26-09-2025") == "2025-09-26"
    assert nwdp_groundwater.parse_date("garbage") is None


def test_manifest_roundtrip(tmp_path):
    f = tmp_path / "a.bin"
    f.write_bytes(b"hello")
    e = gc.manifest_entry(f, "https://example.org/a.bin", licence="X")
    gc.write_manifest(tmp_path, {"source_id": "t"}, [e])
    gc.write_manifest(tmp_path, {"source_id": "t"}, [e])  # idempotent merge
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert len(m["files"]) == 1
    assert m["files"][0]["sha256"] == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    assert m["files"][0]["retrieved_at"].endswith("+05:30")


def test_imd_suspect_flag_does_not_alter_values():
    annual = {(y, 74.0, 18.5): 700.0 for y in range(2000, 2010)}
    annual[(2005, 74.0, 18.5)] = 6495.4
    s = imd_rainfall.flag_suspect_years(annual)
    assert s == {(2005, 74.0, 18.5)}
    assert annual[(2005, 74.0, 18.5)] == 6495.4


def test_tree_point_parse_and_rows(tmp_path):
    import csv
    from collections import Counter
    from datasets.pipelines import opencity_trees as t
    assert t.parse_point("POINT (73.874158 18.564243)") == (73.874158, 18.564243)
    assert t.parse_point("") is None
    rows = [
        {"id": "1", "geom": "POINT (73.87 18.56)", "northing": "18.56", "easting": "73.87", "girth_cm": "26", "height_m": "5", "canopy_dia_m": "3", "condition": "Healthy", "is_rare": "FALSE"},
        {"id": "1", "geom": "POINT (73.87 18.56)", "girth_cm": "26"},                         # duplicate id
        {"id": "2", "geom": "POINT (72.80 19.00)"},                                           # outside box
        {"id": "3", "geom": "POINT (73.90 18.50)", "northing": "18.60", "easting": "73.90", "girth_cm": "9999", "height_m": "", "is_rare": "TRUE"},
    ]
    out = tmp_path / "t.csv"
    st, seen = Counter(), set()
    with open(out, "w", newline="") as fh:
        t.process_rows(rows, csv.writer(fh), st, seen)
    assert st["written"] == 2 and st["duplicate_id_dropped"] == 1 and st["outside_study_box"] == 1
    assert st["girth_cm_outside_1_2000"] == 1 and st["height_m_missing"] == 1
    assert st["geom_vs_northing_easting_mismatch"] == 1 and st["is_rare_true"] == 1


def test_cpcb_station_line_and_timestamp_parsing():
    from datasets.pipelines import cpcb_air_quality as aq
    txt = ("Pune              Karve Road, Pune                                 MPCB                 18.5012     73.8166      #292\n"
           "Mumbai            Colaba, Mumbai                                   MPCB                 18.9100     72.8200      #999\n")
    st = aq.parse_station_lines(txt)
    assert st == [{"station_id": "site_292", "name": "Karve Road, Pune", "agency": "MPCB", "city": "Pune", "lat": 18.5012, "lon": 73.8166}]
    assert aq.parse_ts("2024-01-01T00:00:00.000000+0000") == "2024-01-01T05:30+05:30"
    assert aq.parse_ts("not a time") is None
