"""
Coordination service: resolves proposal elements to geometry, runs detection for a project against every other project,
the baseline (city_objects roads, OSM metro index) and imported subsurface utility records, and computes stale-assessment
indicators on read (EGR §D5). Detection only INSERTS coordination_runs / coordination_conflicts rows; it never writes a
project, scenario, version, element or baseline row (tested).
"""
from __future__ import annotations

import datetime
import hashlib
import json
import uuid
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from api.scenario_router import baseline_fingerprint, change_set_hash, head_change_set
from feasibility.models import FeasibilityAssessmentEntity
from models.models import (AreaEntity, CityObjectEntity, ScenarioObjectChangeEntity, ScenarioRunEntity,
                           ScenarioVersionChangeEntity, ScenarioVersionEntity)
from planning.models import PlanningProjectEntity

from . import geometry as G
from .models import (ENGINE_VERSION, ClearanceRuleEntity, CoordinationConflictEntity, CoordinationRunEntity,
                     ProposalElementEntity, SubsurfaceDatasetEntity, SubsurfaceRecordEntity)

DEFAULT_SCREENING_RADIUS_M = 50.0


def _canon(o: Any) -> str:
    return json.dumps(o, sort_keys=True, separators=(",", ":"), default=str)


def _sha(o: Any) -> str:
    return "sha256:" + hashlib.sha256(_canon(o).encode()).hexdigest()


def _load(s: Optional[str], default=None):
    if not s:
        return default
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return default


# ── element resolution ───────────────────────────────────────────────────────

def resolve_object(db: Session, scenario_id: Optional[str], version_id: Optional[str], object_id: str) -> Optional[dict]:
    """The referenced object's {type, geometry(list), properties} in the version (if given) or the scenario head."""
    if version_id:
        c = db.get(ScenarioVersionChangeEntity, (version_id, object_id))
        if c is not None:
            if c.op == "delete":
                return None
            return {"type": c.type, "geometry": _load(c.geometry_geojson), "properties": _load(c.properties_json, {}), "source": f"scenario_version:{version_id}"}
    elif scenario_id:
        ch = db.get(ScenarioObjectChangeEntity, (scenario_id, object_id))
        if ch is not None:
            if ch.op == "delete":
                return None
            return {"type": ch.type, "geometry": _load(ch.geometry_geojson), "properties": _load(ch.properties_json, {}), "source": f"scenario_head:{scenario_id}"}
    o = db.get(CityObjectEntity, object_id)
    if o is None:
        return None
    if o.scenario_id not in ("base", scenario_id):
        return None  # another proposal's own object is not visible from this scenario
    return {"type": o.type, "geometry": _load(o.geometry_geojson), "properties": _load(o.properties_json, {}),
            "source": "baseline" if o.scenario_id == "base" else f"scenario_head:{scenario_id}"}


def element_geometry(db: Session, e: ProposalElementEntity) -> tuple[Optional[dict], Optional[float], list[str]]:
    """(GeoJSON, width_m, notes). Own geometry wins; else the referenced object."""
    notes: list[str] = []
    if e.geometry_geojson:
        return _load(e.geometry_geojson), e.width_m, notes
    if e.element_ref:
        obj = resolve_object(db, e.scenario_id, e.scenario_version_id, e.element_ref)
        if obj is None:
            return None, e.width_m, [f"referenced object {e.element_ref} not found in {e.scenario_version_id or e.scenario_id or 'baseline'}"]
        g = G.geojson_from_coords(obj["geometry"], obj.get("type"))
        w = e.width_m
        if w is None and isinstance(obj["properties"].get("width"), (int, float)) and obj["properties"]["width"] > 0:
            w = float(obj["properties"]["width"])
            notes.append("width taken from the referenced object's properties (estimated)")
        notes.append(f"geometry from {obj['source']}")
        return g, w, notes
    return None, e.width_m, ["element has neither geometry nor element_ref"]


def element_content(db: Session, e: ProposalElementEntity) -> dict:
    g, w, _ = element_geometry(db, e)
    return {"id": e.id, "kind": e.kind, "scenario_id": e.scenario_id, "scenario_version_id": e.scenario_version_id,
            "element_ref": e.element_ref, "geometry": g, "width_m": w, "z_min_m": e.z_min_m, "z_max_m": e.z_max_m,
            "z_ref": e.z_ref, "profile": _load(e.profile_json), "clearance_m": e.clearance_m, "certainty": e.certainty,
            "phase": e.construction_phase}


def project_elements_hash(db: Session, project_id: str) -> tuple[str, dict]:
    els = db.query(ProposalElementEntity).filter(ProposalElementEntity.project_id == project_id).order_by(ProposalElementEntity.id).all()
    per = {e.id: _sha(element_content(db, e)) for e in els}
    return _sha(per), per


def element_segments(db: Session, e: ProposalElementEntity) -> tuple[list[G.Segment], list[str]]:
    g, w, notes = element_geometry(db, e)
    if g is None:
        return [], notes
    if e.z_ref != "ground":
        notes.append(f"z reference '{e.z_ref}' is not 'ground': depth treated as UNKNOWN (no ground model to convert)")
        zmin = zmax = None
        prof = None
    else:
        zmin, zmax, prof = e.z_min_m, e.z_max_m, _load(e.profile_json)
    segs = G.segments_for(e.id, e.kind, g, width_m=w, z_min=zmin, z_max=zmax, certainty=e.certainty, profile=prof,
                          clearance_m=e.clearance_m, meta={"project_id": e.project_id, "name": e.name})
    return segs, notes


def rules_snapshot(db: Session) -> tuple[list[dict], str]:
    rows = db.query(ClearanceRuleEntity).filter(ClearanceRuleEntity.active.is_(True)).order_by(ClearanceRuleEntity.id).all()
    rules = [{"id": r.id, "label": r.label, "rule_type": r.rule_type, "subject_kind": r.subject_kind, "other_kind": r.other_kind,
              "horizontal_m": r.horizontal_m, "vertical_m": r.vertical_m, "basis": r.basis, "citation": r.citation} for r in rows]
    return rules, _sha(rules)


# ── reference layers ─────────────────────────────────────────────────────────

_BASE_CACHE: dict[str, tuple] = {}


def baseline_road_segments(db: Session) -> tuple[list[G.Segment], Optional[list[float]], str, str]:
    """Base roads (immutable baseline, city_objects scenario 'base'). At-grade: z_max = 0 (surface), structure depth
    (z_min) UNKNOWN. Coverage: union bbox of study areas, else extent of the imported roads (estimated)."""
    fp = baseline_fingerprint(db)
    key = f"{db.get_bind().url}|{fp}"
    if key in _BASE_CACHE:
        return _BASE_CACHE[key]
    segs: list[G.Segment] = []
    xs, ys = [], []
    for oid, geom, props in db.query(CityObjectEntity.id, CityObjectEntity.geometry_geojson, CityObjectEntity.properties_json).filter(
            CityObjectEntity.scenario_id == "base", CityObjectEntity.type == "road"):
        g = G.geojson_from_coords(_load(geom, []), "road")
        if not g or g["type"] != "LineString":
            continue
        p = _load(props, {}) or {}
        w = p.get("width") if isinstance(p.get("width"), (int, float)) and p.get("width") > 0 else None
        for c in g["coordinates"]:
            xs.append(c[0]); ys.append(c[1])
        try:
            segs += G.segments_for(oid, "road", g, width_m=w, z_min=None, z_max=0.0, certainty="estimated",
                                   meta={"layer": "baseline_road", "width_source": "object properties" if w else "UNKNOWN"}, max_segments=50)
        except Exception:  # noqa: BLE001 - malformed geometry rows are skipped, counted below
            continue
    areas = db.query(func.min(AreaEntity.min_lon), func.min(AreaEntity.min_lat), func.max(AreaEntity.max_lon), func.max(AreaEntity.max_lat)).one()
    if areas[0] is not None:
        cov, cov_src = list(areas), "study areas (union bbox)"
    elif xs:
        cov, cov_src = [min(xs), min(ys), max(xs), max(ys)], "extent of imported baseline roads (estimated)"
    else:
        cov, cov_src = None, "no baseline roads"
    _BASE_CACHE.clear()
    _BASE_CACHE[key] = (segs, cov, cov_src, fp)
    return _BASE_CACHE[key]


def osm_metro_segments(boxes: list[tuple]) -> tuple[list[G.Segment], Optional[dict]]:
    """OSM metro (railway=subway etc.) from the local index. OSM carries no depth or deck height: z UNKNOWN; width UNKNOWN;
    centreline is OSM's, not the metro authority's alignment (certainty estimated)."""
    try:
        from osm.index import OsmIndex
        idx = OsmIndex()
        st = idx.status()
    except Exception:  # noqa: BLE001
        return [], None
    if not st.get("available") or "metro" not in st.get("capabilities", []):
        return [], {"available": False}
    segs: list[G.Segment] = []
    for el in idx.infrastructure("metro", boxes):
        tags = el.get("tags", {}) or {}
        try:
            layer = int(str(tags.get("layer", "0")).split(";")[0])
        except ValueError:
            layer = 0
        if el.get("type") == "node":
            g, kind = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}, "metro_station"
        else:
            coords = [[p["lon"], p["lat"]] for p in el.get("geometry", [])]
            if len(coords) < 2:
                continue
            g = {"type": "LineString", "coordinates": coords}
            kind = "metro_tunnel" if tags.get("tunnel") or layer < 0 else ("metro_viaduct" if tags.get("bridge") or layer > 0 else "metro")
        segs += G.segments_for(f"osm_{el.get('type')}_{el.get('id')}", kind, g, width_m=None, z_min=None, z_max=None,
                               certainty="estimated", meta={"layer": "osm_metro", "osm_tags": {k: tags[k] for k in ("name", "tunnel", "bridge", "layer", "railway") if k in tags}})
    return segs, {"available": True, "bbox": st.get("bbox"), "dataTimestamp": st.get("dataTimestamp"), "source": st.get("source")}


def utility_segments(db: Session) -> tuple[list[G.Segment], list[dict]]:
    segs: list[G.Segment] = []
    for r in db.query(SubsurfaceRecordEntity).filter(SubsurfaceRecordEntity.record_type == "utility", SubsurfaceRecordEntity.geometry_geojson.isnot(None)):
        g = _load(r.geometry_geojson)
        if not g:
            continue
        segs += G.segments_for(r.id, "utility", g, width_m=r.diameter_m, z_min=r.z_min_m, z_max=r.z_max_m, certainty=r.z_certainty,
                               meta={"layer": "subsurface_utility", "dataset_id": r.dataset_id, "quality_level": r.quality_level or "UNKNOWN",
                                     "utility_type": r.utility_type})
    ds = [{"id": d.id, "sha256": d.file_sha256, "coverage": _load(d.coverage_bbox_json)} for d in
          db.query(SubsurfaceDatasetEntity).filter(SubsurfaceDatasetEntity.record_type == "utility").order_by(SubsurfaceDatasetEntity.id)]
    return segs, ds


def subsurface_hash(db: Session) -> str:
    return _sha([[d.id, d.file_sha256, d.record_count] for d in db.query(SubsurfaceDatasetEntity).order_by(SubsurfaceDatasetEntity.id)])


def osm_state() -> Optional[str]:
    try:
        from osm.index import OsmIndex
        st = OsmIndex().status()
        return f"{st.get('source')}|{st.get('dataTimestamp')}" if st.get("available") else None
    except Exception:  # noqa: BLE001
        return None


# ── detection ────────────────────────────────────────────────────────────────

def _pair_key(a_el: str, b_type: str, b_ref: str) -> str:
    if b_type == "project_element":
        x, y = sorted([a_el, b_ref])
        return f"element|{x}|{y}"
    return f"{b_type}|{a_el}|{b_ref}"


def run_detection(db: Session, project_id: str, run_by: str, screening_radius_m: float = DEFAULT_SCREENING_RADIUS_M) -> CoordinationRunEntity:
    rules, rules_hash = rules_snapshot(db)
    radius = max([screening_radius_m] + [r["horizontal_m"] or 0 for r in rules]) + 1.0
    own = db.query(ProposalElementEntity).filter(ProposalElementEntity.project_id == project_id).order_by(ProposalElementEntity.id).all()
    others = db.query(ProposalElementEntity).filter(ProposalElementEntity.project_id != project_id).order_by(ProposalElementEntity.id).all()

    a_segs: dict[str, list[G.Segment]] = {}
    skipped: list[dict] = []
    for e in own:
        s, notes = element_segments(db, e)
        if s:
            a_segs[e.id] = s
        else:
            skipped.append({"element_id": e.id, "reason": "; ".join(notes) or "geometry UNKNOWN"})
    other_segs: list[G.Segment] = []
    other_projects: dict[str, str] = {}
    for pid in sorted({e.project_id for e in others}):
        other_projects[pid] = project_elements_hash(db, pid)[0]
    for e in others:
        other_segs += element_segments(db, e)[0]
    base_segs, base_cov, base_cov_src, base_fp = baseline_road_segments(db)
    util_segs, util_ds = utility_segments(db)
    all_a = [s for ss in a_segs.values() for s in ss]
    pad = radius / 100000.0 + 0.001
    boxes = []
    for s in all_a:
        x0, y0, x1, y1 = s.geom.bounds
        lo0, la0 = G.from_utm(x0, y0)
        lo1, la1 = G.from_utm(x1, y1)
        boxes.append((lo0 - pad, la0 - pad, lo1 + pad, la1 + pad))
    metro_segs, metro_meta = osm_metro_segments(boxes) if boxes else ([], None)

    layers = {
        "project_element": other_segs,
        "baseline_road": base_segs,
        "osm_metro": metro_segs,
        "subsurface_utility": util_segs,
    }
    trees = {k: G.build_tree(v) for k, v in layers.items() if v}

    run = CoordinationRunEntity(id=f"crun_{uuid.uuid4().hex[:12]}", project_id=project_id, engine_version=ENGINE_VERSION,
                                created_by=run_by, inputs_json="{}", summary_json="{}")
    _, own_hashes = project_elements_hash(db, project_id)
    inputs = {
        "project_elements_hash": _sha(own_hashes), "project_elements": own_hashes,
        "scenario_versions": {e.scenario_id: e.scenario_version_id for e in own + others if e.scenario_id and e.scenario_version_id},
        "scenario_heads": {sid: change_set_hash(head_change_set(db, sid)) for sid in sorted({e.scenario_id for e in own + others if e.scenario_id and not e.scenario_version_id})},
        "other_projects": other_projects, "baseline_fingerprint": base_fp, "rule_set_hash": rules_hash, "rules": rules,
        "subsurface_hash": subsurface_hash(db), "osm_index": osm_state(), "screening_radius_m": screening_radius_m,
        "engine_version": ENGINE_VERSION,
    }
    rows: list[CoordinationConflictEntity] = []
    for eid, segs in a_segs.items():
        best: dict[tuple, dict] = {}
        for layer, lsegs in layers.items():
            if layer not in trees:
                continue
            for a in segs:
                for b in G.candidates(trees[layer], lsegs, a, radius):
                    r = G.evaluate_pair(a, b, rules, screening_radius_m)
                    if r["class"] == "no_conflict_within_available_data" and not r["permission_triggers"]:
                        continue
                    key = (layer, b.owner)
                    cur = best.get(key)
                    trig = (cur["permission_triggers"] if cur else []) + r["permission_triggers"]
                    if cur is None or (G.SEVERITY[r["class"]], r["horizontal_distance_m"]) < (G.SEVERITY[cur["class"]], cur["horizontal_distance_m"]):
                        best[key] = {**r, "a": a, "b": b}
                    best[key]["permission_triggers"] = list({(t["rule_id"]): t for t in sorted(trig, key=lambda t: -t["distance_m"])}.values())
        for (layer, bref), r in best.items():
            a, b = r["a"], r["b"]
            rows.append(CoordinationConflictEntity(
                id=f"cfl_{uuid.uuid4().hex[:12]}", run_id=run.id, project_a_id=project_id, element_a_id=eid, segment_a=a.index,
                b_type=layer, project_b_id=b.meta.get("project_id") if layer == "project_element" else None, b_ref=bref,
                segment_b=b.index, pair_key=_pair_key(eid, layer, bref), conflict_class=r["class"],
                horizontal_distance_m=r["horizontal_distance_m"], vertical_gap_m=r["vertical_gap_m"], certainty=r["certainty"],
                reasons_json=_canon(r["reasons"]), permission_triggers_json=_canon(r["permission_triggers"]),
                evidence_json=_canon({"a": {"kind": a.kind, "z_min_m": a.z_min, "z_max_m": a.z_max, "certainty": a.certainty, "width_known": a.width_known, **a.meta},
                                      "b": {"kind": b.kind, "z_min_m": b.z_min, "z_max_m": b.z_max, "certainty": b.certainty, "width_known": b.width_known, **b.meta},
                                      "rule_ids": r["rule_ids"], "crs": f"EPSG:{G.UTM_EPSG}"})))
        # layer-level rows: what can (not) be said where no pair was found
        hit_layers = {k[0] for k in best}
        hit_projects = {r2.project_b_id for r2 in rows if r2.element_a_id == eid and r2.b_type == "project_element"}
        e_box = None
        xs = [c for s in segs for c in s.geom.bounds]
        if xs:
            lo0, la0 = G.from_utm(min(xs[0::4]), min(xs[1::4]))
            lo1, la1 = G.from_utm(max(xs[2::4]), max(xs[3::4]))
            e_box = (lo0, la0, lo1, la1)
        cov = {
            "baseline_road": (bool(base_segs) and G.box_inside(e_box, base_cov), f"baseline roads; coverage: {base_cov_src}"),
            "osm_metro": (bool(metro_meta and metro_meta.get("available")) and G.box_inside(e_box, metro_meta.get("bbox")),
                          "OSM metro (local index; depth UNKNOWN)" if metro_meta and metro_meta.get("available") else "OSM metro index not available"),
            "subsurface_utility": (any(G.box_inside(e_box, d["coverage"]) for d in util_ds),
                                   "subsurface utility records; coverage = stated coverage of an imported dataset (none stated = UNKNOWN)"),
        }
        for layer, (covered, note) in cov.items():
            if layer in hit_layers:
                continue
            rows.append(_layer_row(run.id, project_id, eid, layer, layer, None,
                                   "no_conflict_within_available_data" if covered else "unknown_no_coverage", note))
        for pid in other_projects:
            if pid not in hit_projects:
                rows.append(_layer_row(run.id, project_id, eid, "project", f"project:{pid}", pid, "no_conflict_within_available_data",
                                       "no element of this project within the screening radius (elements as entered; their completeness is the project's)"))
    for s in skipped:
        rows.append(_layer_row(run.id, project_id, s["element_id"], "self", "geometry", None, "unknown_no_coverage", s["reason"]))

    # carry acknowledgements forward when the same pair keeps the same class (never across a class change)
    for r in rows:
        prev = (db.query(CoordinationConflictEntity).filter(CoordinationConflictEntity.pair_key == r.pair_key,
                                                            CoordinationConflictEntity.conflict_class == r.conflict_class,
                                                            CoordinationConflictEntity.status != "open")
                .order_by(CoordinationConflictEntity.created_at.desc()).first())
        if prev is not None:
            r.status, r.status_by, r.status_note, r.status_at, r.status_carried_from = prev.status, prev.status_by, prev.status_note, prev.status_at, prev.id
    counts: dict[str, int] = {}
    for r in rows:
        counts[r.conflict_class] = counts.get(r.conflict_class, 0) + 1
    run.inputs_json = _canon(inputs)
    run.summary_json = _canon({"counts": counts, "elements": len(own), "skipped_elements": skipped,
                               "other_projects": sorted(other_projects), "layers": {k: len(v) for k, v in layers.items()},
                               "osm_metro": metro_meta, "baseline_coverage": {"bbox": base_cov, "source": base_cov_src},
                               "permission_triggers": sum(len(_load(r.permission_triggers_json, [])) for r in rows)})
    db.add(run)
    db.add_all(rows)
    return run


def _layer_row(run_id, pid, eid, b_type, b_ref, pid_b, cls, note) -> CoordinationConflictEntity:
    return CoordinationConflictEntity(id=f"cfl_{uuid.uuid4().hex[:12]}", run_id=run_id, project_a_id=pid, element_a_id=eid,
                                      b_type="layer" if b_type != "project" else "project", project_b_id=pid_b, b_ref=b_ref,
                                      pair_key=_pair_key(eid, "layer", b_ref), conflict_class=cls, certainty="unknown" if cls == "unknown_no_coverage" else "estimated",
                                      reasons_json=_canon([note]), permission_triggers_json="[]", evidence_json="{}")


# ── staleness (computed on read) ─────────────────────────────────────────────

def _latest_version(db: Session, sid: str) -> Optional[ScenarioVersionEntity]:
    return db.query(ScenarioVersionEntity).filter(ScenarioVersionEntity.scenario_id == sid).order_by(ScenarioVersionEntity.number.desc()).first()


def _verdict(reasons: list[str], not_checked: list[str]) -> dict:
    return {"stale": True if reasons else (None if not_checked else False), "reasons": reasons, "not_checked": not_checked,
            "label": "STALE" if reasons else ("UNKNOWN (inputs not fully recorded)" if not_checked else "current"),
            "computed_at": datetime.datetime.utcnow().isoformat() + "Z"}


def stale_coordination_run(db: Session, run: CoordinationRunEntity) -> dict:
    inp = _load(run.inputs_json, {})
    reasons: list[str] = []
    if project_elements_hash(db, run.project_id)[0] != inp.get("project_elements_hash"):
        reasons.append("project_elements_changed")
    for sid, vid in (inp.get("scenario_versions") or {}).items():
        lv = _latest_version(db, sid)
        if lv is not None and lv.id != vid:
            reasons.append(f"scenario_version_superseded:{sid}")
    for sid, h in (inp.get("scenario_heads") or {}).items():
        if change_set_hash(head_change_set(db, sid)) != h:
            reasons.append(f"scenario_head_changed:{sid}")
    now_projects = {pid for (pid,) in db.query(ProposalElementEntity.project_id).filter(ProposalElementEntity.project_id != run.project_id).distinct()}
    old = inp.get("other_projects") or {}
    for pid in sorted(now_projects | set(old)):
        if pid not in old:
            reasons.append(f"other_project_added:{pid}")
        elif project_elements_hash(db, pid)[0] != old[pid]:
            reasons.append(f"other_project_changed:{pid}")
    if baseline_fingerprint(db) != inp.get("baseline_fingerprint"):
        reasons.append("baseline_changed")
    if rules_snapshot(db)[1] != inp.get("rule_set_hash"):
        reasons.append("clearance_rules_changed")
    if subsurface_hash(db) != inp.get("subsurface_hash"):
        reasons.append("subsurface_data_changed")
    if osm_state() != inp.get("osm_index"):
        reasons.append("osm_index_changed")
    if run.engine_version != ENGINE_VERSION:
        reasons.append("engine_version_changed")
    return _verdict(reasons, [])


def run_kind(r: ScenarioRunEntity) -> str:
    blob = (r.inputs_json or "") + (r.results_json or "")
    low = blob.lower()
    kinds = [k for k, w in (("odme", "odme"), ("emissions", "emission")) if w in low]
    return "+".join(["simulation"] + kinds)


def stale_sim_run(db: Session, r: ScenarioRunEntity) -> dict:
    reasons, nc = [], ["engine build (the frontend build id is not known to the server)"]
    if r.scenario_version_id:
        lv = _latest_version(db, r.scenario_id)
        if lv is not None and lv.id != r.scenario_version_id:
            reasons.append("newer_scenario_version")
    if r.scenario_id != "base" and change_set_hash(head_change_set(db, r.scenario_id)) != r.change_set_hash:
        reasons.append("scenario_changed_since_run")
    if baseline_fingerprint(db) != r.baseline_fingerprint:
        reasons.append("baseline_changed")
    v = _verdict(reasons, [])
    v["not_checked"] = nc
    v["run_kind"] = run_kind(r)
    return v


def stale_assessment(db: Session, a: FeasibilityAssessmentEntity) -> dict:
    reasons, nc = [], ["feasibility engine / rules version (the frontend engine version is not known to the server)"]
    v = db.get(ScenarioVersionEntity, a.scenario_version) if a.scenario_version else None
    if v is None:
        nc.insert(0, "scenario version not recorded (or not a version id): whether the proposal changed is UNKNOWN")
    else:
        lv = _latest_version(db, v.scenario_id)
        if lv is not None and lv.id != v.id:
            reasons.append("newer_scenario_version")
        if change_set_hash(head_change_set(db, v.scenario_id)) != v.change_set_hash:
            reasons.append("scenario_changed_since_version")
        if baseline_fingerprint(db, v.baseline_id) != v.baseline_fingerprint:
            reasons.append("baseline_changed")
    out = _verdict(reasons, nc if (v is None and not reasons) else [])
    out["not_checked"] = nc
    return out


def project_exists(db: Session, pid: str) -> bool:
    return db.get(PlanningProjectEntity, pid) is not None
