"""
Import the PMC sewer network and the labelled storm-water drains (OpenCity mirror, via the infrastructure index) as
coordination subsurface utility records. docs/urbanos/COORDINATION_AND_SUBSURFACE.md §6a, INFRASTRUCTURE_DATA.md §3.

- Quality level: ASCE 38 QL-D for every record (position from utility records / existing GIS, not designated or exposed).
- Depth: only where the publisher gives both a cover (top) level and an invert level for the pipe. Invert depth = cover − invert
  at each end; z_min = −(deepest invert depth), z_max = −(shallowest invert depth − internal diameter) (top of pipe; wall
  thickness UNKNOWN). The levels are DESIGN values, unverified by survey → z certainty `estimated` (QL-D), flagged in the
  record. No levels → depth UNKNOWN (z NULL, certainty `unknown`). Storm drains publish no levels or sizes → depth and width
  UNKNOWN for all 9,187.
- Coverage: NOT stated (NULL = UNKNOWN). The publisher does not state the completeness of either network, so a project with
  no record nearby gets `unknown_no_coverage`, never "clear".
- Idempotent: dataset id = ssd_ref_<layer>_<sha12 of the index layer input>; a re-run with the same input does nothing; a
  changed input is a new dataset that names the previous one in supersedes_id (nothing is edited or deleted).

CLI (backend/): python -m coordination.pmc_import --imported-by "Name" [--layers sewer,storm_drains]
"""
from __future__ import annotations

import argparse
import json
from typing import Optional

from sqlalchemy.orm import Session

from datasets import infra_store as IS

from .models import REFERENCE_DATASET_PREFIX, SubsurfaceDatasetEntity, SubsurfaceRecordEntity, SubsurfaceRecordExtentEntity

SPECS = {
    "sewer": {"utility_type": "sewer", "name": "PMC sewer network (OpenCity mirror) — QL-D records",
              "method": "records: PMC GIS sewer layer as published via OpenCity (ASCE 38 QL-D); cover/invert levels are DESIGN values, unverified"},
    "storm_drains": {"utility_type": "storm_drain", "name": "PMC storm-water drains, labelled rows only (OpenCity mirror) — QL-D records",
                     "method": "records: PMC GIS storm-water layer as published via OpenCity, rows labelled 'Storm water drains' only (ASCE 38 QL-D); no levels or sizes published"},
}


def _record_fields(layer: str, p: dict) -> dict:
    if layer != "sewer":
        return {"depth_m": None, "diameter_m": None, "z_min_m": None, "z_max_m": None, "z_certainty": "unknown",
                "depth_basis": "UNKNOWN (no levels or sizes published for storm drains)"}
    dia = p.get("diameter_m")
    inv_max, inv_min, top = p.get("invert_depth_max_m"), p.get("invert_depth_min_m"), p.get("top_depth_m")
    if inv_max is None:
        return {"depth_m": None, "diameter_m": dia, "z_min_m": None, "z_max_m": None, "z_certainty": "unknown",
                "depth_basis": p.get("depth_basis") or "UNKNOWN"}
    return {"depth_m": top, "diameter_m": dia, "z_min_m": -float(inv_max), "z_max_m": (-float(top) if top is not None else None),
            "z_certainty": "estimated", "depth_basis": p.get("depth_basis")}


def import_reference_networks(db: Session, imported_by: str, layers: Optional[list[str]] = None) -> dict:
    import shapely
    from shapely.geometry import mapping
    if not imported_by.strip():
        raise ValueError("imported_by is required")
    st = IS.status()
    if not st.get("available"):
        raise RuntimeError(st.get("reason") or "infrastructure index not available")
    out = {}
    for layer in layers or list(SPECS):
        spec = SPECS[layer]
        meta = IS.layer(layer)
        if meta is None:
            out[layer] = {"result": "skipped", "reason": "layer not in the index"}
            continue
        did = f"{REFERENCE_DATASET_PREFIX}{layer}_{meta['input_sha256'][:12]}"
        if db.get(SubsurfaceDatasetEntity, did) is not None:
            out[layer] = {"result": "unchanged", "dataset_id": did}
            continue
        prev = (db.query(SubsurfaceDatasetEntity).filter(SubsurfaceDatasetEntity.id.like(f"{REFERENCE_DATASET_PREFIX}{layer}_%"))
                .order_by(SubsurfaceDatasetEntity.imported_at.desc()).first())
        recs, ext = [], []
        n_depth = 0
        for fid, ext_id, props, wkb in IS.iter_layer(layer):
            p = json.loads(props)
            g = shapely.from_wkb(wkb)
            f = _record_fields(layer, p)
            n_depth += f["z_min_m"] is not None
            rid = f"ssr_{did[len(REFERENCE_DATASET_PREFIX):][:24]}_{fid}"
            keep = {k: v for k, v in p.items() if k not in ("depth_basis",)}
            recs.append(dict(id=rid, dataset_id=did, record_type="utility", external_id=str(p.get("pipeline_i") or ext_id),
                             geometry_geojson=json.dumps(mapping(g)), location_note="WGS84 as published (KML)",
                             utility_type=spec["utility_type"], owner="Pune Municipal Corporation", depth_m=f["depth_m"],
                             diameter_m=f["diameter_m"], quality_level="QL-D", survey_method=spec["method"],
                             z_min_m=f["z_min_m"], z_max_m=f["z_max_m"], z_certainty=f["z_certainty"],
                             properties_json=json.dumps({**keep, "depth_basis": f["depth_basis"], "levels_status": "design, unverified" if layer == "sewer" else "not published",
                                                         "index_layer": layer, "index_fid": fid, "data_class": "observed (agency records)",
                                                         "source": "PMC via OpenCity"}, ensure_ascii=False, separators=(",", ":"))))
            b = g.bounds
            ext.append(dict(record_id=rid, dataset_id=did, min_lon=b[0], min_lat=b[1], max_lon=b[2], max_lat=b[3]))
        if not recs:
            out[layer] = {"result": "skipped", "reason": "no features"}
            continue
        warnings = [f"{len(recs) - n_depth} of {len(recs)} records have no published levels: depth UNKNOWN",
                    "Coverage not stated by the publisher: completeness of the network UNKNOWN (absence of a record is not evidence)"]
        if layer == "sewer":
            warnings.append("Cover and invert levels are DESIGN values as published, unverified by survey (QL-D)")
        db.add(SubsurfaceDatasetEntity(
            id=did, project_id=None, record_type="utility", format="json", name=spec["name"], file_name=f"infra_index:{layer}",
            file_sha256="sha256:" + meta["input_sha256"], publisher=f"{meta['publisher']} (via OpenCity)", source_url=meta.get("source_url") or "",
            licence=meta["licence"][:1500], data_date=meta.get("source_updated"), coverage_bbox_json=None,
            provenance=(f"Imported from the UrbanOS infrastructure index layer '{layer}' (derived from {meta['dataset_dir']}, input sha256 "
                        f"{meta['input_sha256']}; index {st.get('path')}). ASCE 38 QL-D. Retrieved {meta.get('retrieved_at')}."),
            record_count=len(recs), warnings_json=json.dumps(warnings), supersedes_id=prev.id if prev else None, imported_by=imported_by))
        db.flush()
        for i in range(0, len(recs), 5000):
            db.bulk_insert_mappings(SubsurfaceRecordEntity, recs[i:i + 5000])
            db.bulk_insert_mappings(SubsurfaceRecordExtentEntity, ext[i:i + 5000])
        db.flush()
        out[layer] = {"result": "imported", "dataset_id": did, "records": len(recs), "with_depth": n_depth,
                      "supersedes": prev.id if prev else None}
    return out


def ensure_extents(db: Session) -> int:
    """Extent rows for records imported before the side table existed (any dataset). Idempotent."""
    from shapely.geometry import shape
    have = {r for (r,) in db.query(SubsurfaceRecordExtentEntity.record_id)}
    n = 0
    for r in db.query(SubsurfaceRecordEntity).filter(SubsurfaceRecordEntity.geometry_geojson.isnot(None)):
        if r.id in have:
            continue
        try:
            b = shape(json.loads(r.geometry_geojson)).bounds
        except Exception:  # noqa: BLE001 - malformed geometry: no extent row → always read
            continue
        db.add(SubsurfaceRecordExtentEntity(record_id=r.id, dataset_id=r.dataset_id, min_lon=b[0], min_lat=b[1], max_lon=b[2], max_lat=b[3]))
        n += 1
    db.flush()
    return n


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Import PMC sewer + storm-drain records (QL-D) from the infrastructure index")
    ap.add_argument("--imported-by", required=True)
    ap.add_argument("--layers", default=None)
    a = ap.parse_args(argv)
    import main as app_main  # noqa: F401  (creates tables, seeds)
    from database.connection import SessionLocal
    from planning.audit import acting_as
    with SessionLocal() as db, acting_as(a.imported_by):
        rep = import_reference_networks(db, a.imported_by, a.layers.split(",") if a.layers else None)
        db.commit()
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
