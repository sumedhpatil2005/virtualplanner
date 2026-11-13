"""Spatially indexed FlatGeobuf of the PMC sewage pipelines for bbox-limited reads by the Underground API.

CLI: python -m datasets.pipelines.subsurface_index [--src-version 2026-11-13]
Input : $URBANOS_DATA_DIR/derived/pmc_sewage_pipelines/<src-version>/pmc_sewage_pipelines.geojson (opencity_pune pipeline)
Output: $URBANOS_DATA_DIR/derived/pmc_sewage_pipelines_fgb/v1/pmc_sewage_pipelines.fgb (+ processing.json)

Format conversion only: geometry and the kept attribute strings are copied unchanged (no repair, no reprojection). Levels
(start/end invert, top level) are the agency's published DESIGN/as-recorded values; survey method, accuracy and vertical
datum are not stated by the publisher -> ASCE 38 quality level D (records), unverified.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from .. import paths
from ._common import write_processing

SRC_ID = "pmc_sewage_pipelines"
OUT_ID = "pmc_sewage_pipelines_fgb"
VERSION = "v1"
KEEP = ["objectid", "pipeline_i", "label", "drainaige_", "material_o", "pipeline_d", "start_inve", "end_invert",
        "tl_start_m", "tl_end_man", "actual_dep", "sd_name", "remarks", "start_manh", "end_manhol"]


def build(src_version: str | None = None) -> Path:
    import pyogrio

    sd = paths.derived_version_dir(SRC_ID, src_version)
    if sd is None:
        raise SystemExit(f"no derived {SRC_ID} version under {paths.derived_dir()}")
    src = sd / "pmc_sewage_pipelines.geojson"
    df = pyogrio.read_dataframe(src, columns=KEEP)
    out = paths.derived_dir() / OUT_ID / VERSION
    out.mkdir(parents=True, exist_ok=True)
    dst = out / "pmc_sewage_pipelines.fgb"
    if dst.exists():
        dst.unlink()
    pyogrio.write_dataframe(df, dst, driver="FlatGeobuf", SPATIAL_INDEX="YES")
    back = pyogrio.read_info(dst)
    validation = {"features_in": int(len(df)), "features_out": int(back["features"]), "crs": str(back["crs"]),
                  "geometry_type": back["geometry_type"], "spatial_index": True, "fields": list(back["fields"])}
    assert validation["features_in"] == validation["features_out"]
    write_processing(out, pipeline="datasets.pipelines.subsurface_index", inputs=[src], parameters={
        "source_dataset": f"{SRC_ID}/{sd.name}", "kept_fields": KEEP, "driver": "FlatGeobuf SPATIAL_INDEX=YES"},
        outputs=[dst], validation=validation, classification="observed", suitability="screening",
        notes="Format conversion of the OpenCity copy of the PMC sewage network (publisher PMC; licence as stated in the "
              "source processing.json: CKAN 'Other (Public Domain)', OpenCity FAQ ODbL unless stated). Invert/top levels "
              "are design/as-recorded values, datum and survey accuracy NOT stated: ASCE 38 QL-D, unverified.")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src-version", default=None)
    print("derived:", build(ap.parse_args().src_version))
