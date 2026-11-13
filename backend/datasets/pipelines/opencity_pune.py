"""OpenCity (data.opencity.in) Pune datasets: ingest raw files + derive clean GeoJSON.

Why two steps: data.opencity.in sits behind a Cloudflare "verify you are human" check that
rejects scripted HTTP clients (HTTP 403 "Just a moment...", checked 2026-11-13 21:05 IST).
We do not bypass it. The files were downloaded with a normal browser session (the check was
passed by the browser, no login exists or was used) into a staging folder; `ingest` verifies
each file's byte size against the CKAN resource metadata and copies it unmodified into the raw
store with a manifest. `derive` converts KML/KMZ/GeoJSON layers to EPSG:4326 GeoJSON limited to
the Pune study box with validation stats.

  cd backend
  python -m datasets.pipelines.opencity_pune ingest --staging /workspace/web/downloads
  python -m datasets.pipelines.opencity_pune derive --raw-date 2026-11-13

Licence: CKAN licence_title per dataset (mostly "Other (Public Domain)"; water-bodies census
"Creative Commons Non-Commercial (Any)"). OpenCity FAQ: "All our data is under Open Data Commons
Open Database License (ODbL)" unless stated; credit OpenCity + original source
(https://opencity.in/faqs/). Site T&C (https://opencity.in/terms-and-conditions/) restrict page
downloads to non-commercial/personal use -> recorded as a licence conflict; see catalogue/india.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from collections import Counter
from pathlib import Path

from . import gov_common as gc
from .kml_reader import iter_features

SOURCE_ID = "opencity_pune"
CATALOGUE = Path(__file__).with_name("opencity_pune_catalogue.json")
FAQ_URL = "https://opencity.in/faqs/"

# original filename stem -> (dataset_id, short title)
GEO_LAYERS = {
    "24b7649d-0039-4dee-872a-621fa2b129d2": ("pmc_electoral_wards_2022", "PMC electoral wards 2022"),
    "b408de88-b9f0-48ad-af37-d6554088fb8d": ("pmc_electoral_wards_2017", "PMC electoral wards 2017"),
    "b26b0ee3-60a3-4f1a-a45c-94b24fb9434a": ("pmc_admin_wards_2017", "PMC administrative wards 2017"),
    "b7a3f392-238c-4c55-a3ed-0c13fd4aaa0a": ("pmc_electoral_wards_2025", "PMC electoral wards 2025"),
    "06209242-c2c6-40f7-b70c-db0783cb7ccd": ("pmc_electoral_wards_2012", "PMC electoral wards 2012"),
    "a97cdf95-402a-461b-8bd6-3eb55103ee91": ("pmc_prabhag_boundary", "PMC prabhag boundary"),
    "882111ee-f944-4bff-b796-7baf97cf55a6": ("pmc_zones", "PMC zones (PMZ zones map)"),
    "pmc_cremation_grounds": ("pmc_crematoriums", "Crematoriums and burial grounds"),
    "pmc_sewage_pipeline": ("pmc_sewage_pipelines", "PMC sewage pipeline network"),
    "4390b641-12ad-4438-bc6b-c938ea7ae5de": ("pmc_stormwater_drains", "PMC storm-water drains"),
    "3f7228b1-092e-4c66-a62f-6895cf33fbcd": ("pmc_nallas", "PMC nallas (streams)"),
    "b0d9ef1f-14d7-4c93-a498-3ffb7c86737c": ("pmc_rivers", "PMC river map"),
    "pmc_swd_utlitiy_chambers": ("pmc_swd_utility_chambers", "SWD utility chambers"),
    "pmc_swd_chambers": ("pmc_swd_chambers", "SWD chambers"),
    "bbbd1d45-23fd-442c-8b1d-6fc48a1064a0": ("pmc_parks_gardens", "Parks and gardens"),
    "f1d88eea-0aab-4d8c-8c23-2acc84c1bd6a": ("pmc_public_toilets", "Public toilets"),
    "d185bb0c-2307-4a7d-9106-11cd61570165": ("pmc_fire_stations", "Fire stations"),
    "a76a14a9-07ce-4a36-bba5-8f8c12351c6b": ("pmc_revenue_map", "Revenue (gut/village/TPS) map"),
    "46c96db4-af62-4b84-a479-5a0279a8f44a": ("pmpml_bus_stops", "PMPML bus stops"),
    "17f84424-1769-45a2-84d5-76f0089f7e3a": ("pmpml_bus_depots", "PMPML bus depots"),
    "9beb555b-b3b8-4f3b-947c-b33ba33615a5": ("pmc_stps", "Sewage treatment plants (existing + proposed)"),
    "9bb3235e-e9db-485d-b303-68ef8fd6bcd7": ("pmc_road_centerline", "PMC road centreline"),
    "20c62d61-11e7-4eee-8200-6dc0c3fe640b": ("water_bodies_census_pune_2023", "Water bodies census 2023 (Pune)"),
    "3121d40a-a37e-4936-86ce-c1872bf9446c": ("pune_libraries", "Libraries"),
    "pune_administative_wards_2025": ("pmc_admin_wards_2025", "PMC administrative wards 2025"),
    "pune_micro_watersheds": ("slusi_micro_watersheds_pune", "Micro-watersheds (SLUSI)"),
}


def load_catalogue() -> dict:
    return json.loads(CATALOGUE.read_text())


def resource_index(cat: dict) -> dict[str, dict]:
    idx = {}
    for d in cat["datasets"]:
        for r in d.get("resources", []):
            fname = r["url"].rsplit("/", 1)[-1]
            idx[fname] = {**r, "dataset": d["name"], "dataset_title": d.get("title"),
                          "organization": d.get("organization"), "license_title": d.get("license_title"),
                          "publisher_url": d.get("publisher_url")}
    return idx


def staged_original_name(p: Path) -> str:
    """Browser staging appends '-<8 hex>' before the extension; strip it."""
    stem, ext = p.stem, p.suffix
    if len(stem) > 9 and stem[-9] == "-" and all(c in "0123456789abcdef" for c in stem[-8:]):
        stem = stem[:-9]
    return stem + ext


def ingest(staging: Path, raw_date: str | None = None) -> Path:
    idx = resource_index(load_catalogue())
    rd = gc.raw_dir(SOURCE_ID, raw_date)
    entries, skipped = [], []
    for p in sorted(staging.iterdir()):
        if not p.is_file():
            continue
        orig = staged_original_name(p)
        meta = idx.get(orig)
        if not meta:
            continue
        size = p.stat().st_size
        if meta.get("size") and size != meta["size"]:
            skipped.append({"file": p.name, "reason": f"size {size} != CKAN size {meta['size']}"})
            continue
        dest = rd / orig
        if not dest.exists():
            shutil.copy2(p, dest)
        pub = meta.get("publisher_url") or ("Pune Municipal Corporation (PMC)" if meta["organization"] == "pune-municipal-corporation" else "UNKNOWN")
        entries.append(gc.manifest_entry(
            dest, meta["url"], retrieved_at=gc.now_ist(), http={"note": "browser download; HTTP headers not capturable (see notes)"},
            licence=f"CKAN licence_title: {meta['license_title']}; OpenCity FAQ: data under ODbL unless stated; credit OpenCity",
            licence_url=FAQ_URL,
            notes="Downloaded via browser session 2026-11-13 (Cloudflare check blocks scripted clients). Size verified == CKAN size.",
            extra={"ckan_dataset": meta["dataset"], "ckan_dataset_title": meta["dataset_title"],
                   "ckan_resource_name": meta["name"], "format": meta["format"],
                   "ckan_last_modified_utc": meta["last_modified"], "ckan_size": meta.get("size"),
                   "ckan_organization": meta["organization"], "original_publisher": pub}))
    gc.write_manifest(rd, {"source_id": SOURCE_ID, "portal": "https://data.opencity.in", "operator": "OpenCity (Oorvani Foundation)",
                           "catalogue_snapshot": str(CATALOGUE.name), "skipped": skipped}, entries)
    return rd


# ---------------------------------------------------------------- derive
def _bbox_of(coords, acc):
    if isinstance(coords[0], (int, float)):
        acc[0] = min(acc[0], coords[0]); acc[1] = min(acc[1], coords[1])
        acc[2] = max(acc[2], coords[0]); acc[3] = max(acc[3], coords[1])
    else:
        for c in coords:
            _bbox_of(c, acc)


def _round(coords, nd=7):
    if isinstance(coords[0], (int, float)):
        return [round(v, nd) for v in coords]
    return [_round(c, nd) for c in coords]


def feature_bbox(geom) -> list[float]:
    acc = [1e9, 1e9, -1e9, -1e9]
    if geom["type"] == "GeometryCollection":
        for g in geom["geometries"]:
            _bbox_of(g["coordinates"], acc)
    else:
        _bbox_of(geom["coordinates"], acc)
    return acc


def intersects_bbox(b, box=gc.PUNE_BBOX) -> bool:
    return not (b[2] < box[0] or b[0] > box[2] or b[3] < box[1] or b[1] > box[3])


def derive_layer(src: Path, out_path: Path, *, line_length: bool = False) -> dict:
    """Stream src (KML/KMZ/GeoJSON) -> GeoJSON FeatureCollection limited to the study box."""
    from shapely.geometry import shape, mapping
    from shapely.validation import make_valid
    from pyproj import Transformer
    import shapely
    import numpy as np

    _tr = Transformer.from_crs(4326, 32643, always_xy=True)
    to_utm = (lambda xy: np.column_stack(_tr.transform(xy[:, 0], xy[:, 1]))) if line_length else None
    if src.suffix.lower() in (".geojson", ".json"):
        feats_iter = iter(json.loads(src.read_text())["features"])
    else:
        feats_iter = iter_features(src)
    stats = Counter()
    gtypes, attr_fill, geom_hashes = Counter(), Counter(), Counter()
    data_bbox = [1e9, 1e9, -1e9, -1e9]
    total_len_m = 0.0
    keys: list[str] = []
    with open(out_path, "w") as fh:
        fh.write('{"type":"FeatureCollection","crs_note":"EPSG:4326 (KML 2.2 / RFC 7946)","features":[\n')
        first = True
        for f in feats_iter:
            stats["read"] += 1
            g = f.get("geometry")
            if not g:
                stats["null_geometry"] += 1
                continue
            b = feature_bbox(g)
            if not (-180 <= b[0] <= 180 and -90 <= b[1] <= 90):
                stats["coords_out_of_range"] += 1
                continue
            if not intersects_bbox(b):
                stats["outside_study_box"] += 1
                continue
            try:
                shp = shape(g)
            except Exception:
                stats["unparseable_geometry"] += 1
                continue
            if not shp.is_valid:
                stats["invalid_repaired"] += 1
                shp = make_valid(shp)
                g = mapping(shp)
            if shp.is_empty:
                stats["empty_after_repair"] += 1
                continue
            h = hashlib.sha1(shp.wkb).hexdigest()
            geom_hashes[h] += 1
            if geom_hashes[h] > 1:
                stats["duplicate_geometry"] += 1
            gtypes[shp.geom_type] += 1
            _bbox_of([b[:2], b[2:]], data_bbox)
            for k, v in f["properties"].items():
                if k not in keys:
                    keys.append(k)
                if v not in (None, "", "0", "0.0", "NULL", "null"):
                    attr_fill[k] += 1
            if to_utm is not None and shp.geom_type in ("LineString", "MultiLineString"):
                total_len_m += shapely.transform(shp, to_utm).length
            out = {"type": "Feature", "properties": f["properties"], "geometry": {"type": g["type"], **({"coordinates": _round(list(g["coordinates"]))} if "coordinates" in g else {"geometries": g["geometries"]})}}
            if "id" in f:
                out["id"] = f["id"]
            fh.write(("" if first else ",\n") + json.dumps(out, ensure_ascii=False, separators=(",", ":")))
            first = False
            stats["written"] += 1
        fh.write("\n]}\n")
    w = stats["written"] or 1
    return {
        "features_read": stats["read"], "features_written": stats["written"],
        "null_geometry": stats["null_geometry"], "outside_study_box": stats["outside_study_box"],
        "coords_out_of_range": stats["coords_out_of_range"], "invalid_repaired_make_valid": stats["invalid_repaired"],
        "empty_after_repair": stats["empty_after_repair"], "duplicate_geometries": stats["duplicate_geometry"],
        "geometry_types": dict(gtypes), "data_bbox": [round(v, 5) for v in data_bbox] if stats["written"] else None,
        "attributes": keys, "attribute_fill_ratio": {k: round(attr_fill[k] / w, 3) for k in keys},
        **({"total_line_length_km_utm43n": round(total_len_m / 1000, 2)} if line_length else {}),
    }


LINE_LAYERS = {"pmc_sewage_pipelines", "pmc_stormwater_drains", "pmc_nallas", "pmc_rivers", "pmc_road_centerline"}


def derive(raw_date: str, version: str | None = None, only: list[str] | None = None) -> list[Path]:
    rd = gc.data_home() / "raw" / SOURCE_ID / raw_date
    manifest = json.loads((rd / "manifest.json").read_text())
    outs = []
    for entry in manifest["files"]:
        stem = Path(entry["file"]).stem
        if stem not in GEO_LAYERS:
            continue
        ds_id, title = GEO_LAYERS[stem]
        if only and ds_id not in only:
            continue
        src = rd / entry["file"]
        out_dir = gc.derived_dir(ds_id, version or raw_date)
        out_path = out_dir / f"{ds_id}.geojson"
        stats = derive_layer(src, out_path, line_length=ds_id in LINE_LAYERS)
        gc.write_processing(out_dir, pipeline="datasets.pipelines.opencity_pune derive",
                            inputs=[{"file": str(src), "sha256": entry["sha256"], "url": entry["url"],
                                     "ckan_dataset": entry.get("ckan_dataset"), "original_publisher": entry.get("original_publisher"),
                                     "licence_as_stated": entry.get("licence_as_stated")}],
                            parameters={"study_bbox_wgs84": gc.PUNE_BBOX, "selection": "features whose bbox intersects study box (geometries not cut)",
                                        "crs_in": "EPSG:4326 (KML 2.2 mandates WGS84 lon,lat)", "crs_out": "EPSG:4326",
                                        "coordinate_rounding_decimals": 7, "repair": "shapely.make_valid on invalid geometries",
                                        "length_crs": "EPSG:32643"},
                            outputs=[out_path], validation=stats,
                            notes=f"{title}. Classification: observed (as published by the agency; survey method/accuracy UNKNOWN).")
        outs.append(out_dir)
        print(ds_id, stats["features_written"], stats["geometry_types"])
    return outs


def main(argv=None):
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("ingest"); a.add_argument("--staging", required=True); a.add_argument("--raw-date")
    b = sub.add_parser("derive"); b.add_argument("--raw-date", required=True); b.add_argument("--version"); b.add_argument("--only", nargs="*")
    args = p.parse_args(argv)
    if args.cmd == "ingest":
        print(ingest(Path(args.staging), args.raw_date))
    else:
        derive(args.raw_date, args.version, args.only)


if __name__ == "__main__":
    main()
