"""
Planning project report (docs/PLANNING_WORKSPACE.md §5). Built only from stored records (project, links, td_datasets,
scenario versions, run records, fs_* rows, planning decisions, audit_log); rendered by the feasibility document
renderers (DOCX via python-docx, PDF via fpdf2). Every number carries its label: measured / estimated / manual /
synthetic for counts, "model output (run …)" for simulation values, the certainty label for feasibility findings.
"""
from __future__ import annotations

import datetime
import json
from collections import Counter

from sqlalchemy import func
from sqlalchemy.orm import Session

from api.scenario_router import FAIR_KEYS, assumption_differences, baseline_fingerprint
from feasibility import docgen
from feasibility.docgen import Block, DocModel, Section
from feasibility.models import REVIEW_STATUS_LABEL, EvidenceEntity, FeasibilityAssessmentEntity, InvestigationDocumentEntity, ReviewRecordEntity
from models.models import AreaEntity, ScenarioEntity, ScenarioRunEntity, ScenarioVersionEntity
from planning.models import DECISION_KIND_LABEL, PROJECT_STATUS_LABEL, PlanningDecisionEntity, PlanningProjectEntity, PlanningProjectLinkEntity
from traffic_data.models import CountRecordEntity, PcuFactorSetEntity, TrafficDatasetEntity

TEMPLATE_VERSION = "planning-project-report 1.0 (2026-11-11)"
HEADER_TEXT = "Planning project report from records in this tool. Not an engineering assessment, statutory approval, sanction or permit."
DISCLAIMER = (
    "IMPORTANT: This report is compiled from records held in this planning tool. It is NOT an engineering assessment, NOT a "
    "certification of safety or constructibility, and NOT a statutory or any other approval, sanction or permit. A 'decision "
    "recorded' is a planning decision recorded in this tool by the named person; this tool has not verified any authority or "
    "approval. Simulation values are MODEL OUTPUTS (estimates) from the stated run inputs and have not been validated at this "
    "location unless a validation record says so. Traffic data carry their provenance label (Measured / Estimated / Manual; "
    "Synthetic = test or demo data, not an observation). Feasibility findings are screening results with their certainty label; "
    "'Unknown' means not established. Actors are self-declared names (the tool has no authentication)."
)
SECTION_TITLES = [
    "Project summary", "Baseline network", "Traffic datasets and provenance", "Scenarios, versions and run inputs",
    "Comparison results (from run records)", "Feasibility findings", "Investigation documents and evidence", "Reviews",
    "Decision record", "Assumptions and unknowns", "Audit trail summary",
]
KIND_LABEL = {"measured": "Measured", "estimated": "Estimated", "manual": "Manual"}
RESULT_LABEL = {"totalVph": ("Network flow", "veh/h"), "meanTravelTimeS": ("Mean travel time", "s"),
                "meanDelayS": ("Mean delay", "s"), "completedTrips": ("Completed trips", "trips")}


def _iso(d: datetime.datetime | None) -> str:
    return d.strftime("%Y-%m-%d %H:%M UTC") if d else "unknown"


def _j(s: str | None, default):
    try:
        return json.loads(s) if s else default
    except ValueError:
        return default


def _num(v) -> str:
    if isinstance(v, bool) or v is None:
        return "unknown" if v is None else str(v)
    if isinstance(v, (int, float)):
        return f"{v:,.1f}" if isinstance(v, float) and not float(v).is_integer() else f"{int(v):,}"
    return str(v)


def _short(v, n: int = 60) -> str:
    s = v if isinstance(v, str) else json.dumps(v, sort_keys=True, default=str)
    return s if len(s) <= n else s[: n - 3] + "..."


def _linked(db: Session, pid: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for l in db.query(PlanningProjectLinkEntity).filter(PlanningProjectLinkEntity.project_id == pid).order_by(PlanningProjectLinkEntity.id):
        out.setdefault(l.entity_type, []).append(l.entity_id)
    return out


def build_model(db: Session, p: PlanningProjectEntity, now: datetime.datetime | None = None) -> DocModel:
    from api.planning_router import project_events  # late import (router imports this module lazily)

    generated = _iso(now or datetime.datetime.utcnow())
    L = _linked(db, p.id)
    S: list[list[Block]] = []
    unknowns: list[str] = []
    assumptions: list[str] = []

    # 1 Project summary
    area = db.get(AreaEntity, p.area_id) if p.area_id else None
    bbox = f"{p.min_lon:.5f}, {p.min_lat:.5f} to {p.max_lon:.5f}, {p.max_lat:.5f} (WGS84 lon, lat)" if p.min_lon is not None else "not set"
    S.append([
        Block("table", header=["Item", "Value"], rows=[
            ["Project", p.name], ["Project id", p.id], ["Description", p.description or "(none)"],
            ["Status", PROJECT_STATUS_LABEL.get(p.status, p.status)], ["Study area", f"{area.name} ({area.id})" if area else ("(area record missing)" if p.area_id else "not set")],
            ["Bounding box", bbox], ["Created by / at", f"{p.created_by} / {_iso(p.created_at)}"], ["Report generated", generated],
            ["Attached records", ", ".join(f"{k}: {len(v)}" for k, v in sorted(L.items())) or "none"],
        ]),
        Block("note", text="Project statuses: Draft, Under study, Under review, Decision recorded. No status in this tool means approval."),
    ])

    # 2 Baseline
    cur = baseline_fingerprint(db, p.baseline_id)
    changed = cur != p.baseline_fingerprint
    S.append([Block("table", header=["Item", "Value"], rows=[
        ["Baseline scenario", p.baseline_id],
        ["Baseline fingerprint when the project was created", p.baseline_fingerprint],
        ["Baseline fingerprint now", cur],
        ["Changed since project creation", "YES - the baseline network has been edited since the project was created" if changed else "no"],
    ]), Block("note", text="Fingerprint = sha256 over the baseline objects' content and the object count (docs/SCENARIOS_AND_VERSIONING.md). The baseline itself is not versioned: an old baseline cannot be restored from this record.")])
    if changed:
        unknowns.append("The baseline network changed after the project was created; results recorded on the earlier baseline may not be reproducible.")

    # 3 Datasets
    ds_rows, ds_blocks = [], []
    for did in L.get("dataset", []):
        d = db.get(TrafficDatasetEntity, did)
        if d is None:
            ds_rows.append([did, "(record no longer exists)", "", "", "", "", "", "", ""])
            continue
        n = db.query(func.count(CountRecordEntity.id)).filter(CountRecordEntity.dataset_id == did).scalar()
        pcu = db.get(PcuFactorSetEntity, d.pcu_factor_set_id) if d.pcu_factor_set_id else None
        label = KIND_LABEL.get(d.kind, d.kind) + (" + SYNTHETIC (test/demo data, not an observation)" if d.synthetic else "")
        ds_rows.append([d.name, label, d.provider, d.method or "-", f"{d.collected_from or '?'} to {d.collected_to or '?'}", d.period_desc,
                        d.role, f"{pcu.name} (v{pcu.version})" if pcu else "none", f"{n:,} records"])
        if d.assumptions:
            assumptions.append(f"Dataset '{d.name}': {d.assumptions}")
        if d.adjustments:
            assumptions.append(f"Dataset '{d.name}' adjustments: {d.adjustments}")
        if d.imported_file_sha256:
            ds_blocks.append(Block("note", text=f"'{d.name}' imported from {d.imported_file_name} (sha256 {d.imported_file_sha256[:16]}...), entered by {d.entered_by}."))
        if d.kind == "estimated":
            unknowns.append(f"Dataset '{d.name}' is ESTIMATED, not counted.")
    S.append([Block("note", text="Counts are evidence at a place, never demand. Measured, estimated and manual data are kept apart and never averaged."),
              Block("table", header=["Dataset", "Provenance", "Source / provider", "Method", "Collected", "Period", "Role", "PCU set", "Size"], rows=ds_rows)]
             + ds_blocks if ds_rows else [Block("para", text="No traffic dataset is attached to this project.")])
    if not ds_rows:
        unknowns.append("No traffic dataset is attached: existing traffic conditions are not evidenced by counts in this project.")

    # 4 Scenarios, versions, run inputs
    scen_ids = list(dict.fromkeys(L.get("scenario", []) + [v.scenario_id for v in (db.get(ScenarioVersionEntity, x) for x in L.get("scenario_version", [])) if v]))
    run_ids = set(L.get("run", []))
    b4: list[Block] = []
    runs_by_scn: dict[str, list[ScenarioRunEntity]] = {}
    for sid in scen_ids:
        s = db.get(ScenarioEntity, sid)
        b4.append(Block("para", text=f"Scenario: {s.name if s else '(record no longer exists)'} ({sid}, {s.kind if s else '?'})"))
        if s and s.description:
            b4.append(Block("note", text=s.description))
        vs = db.query(ScenarioVersionEntity).filter(ScenarioVersionEntity.scenario_id == sid).order_by(ScenarioVersionEntity.number).all()
        if vs:
            b4.append(Block("table", header=["Version", "Label", "Saved (UTC)", "Changes", "Change-set hash", "On current baseline", "Key assumptions"], rows=[[
                f"v{v.number}" + (" (attached)" if v.id in L.get("scenario_version", []) else ""), v.label, _iso(v.created_at), str(v.change_count),
                v.change_set_hash[:19] + "...", "yes" if v.baseline_fingerprint == cur else "NO (baseline changed)",
                "; ".join(f"{k}={_short(a)}" for k, a in sorted(_j(v.assumptions_json, {}).items()) if k in ("hour", "day", "seeds", "signalTiming", "signalSource", "demandLevel", "networkCorrections", "demandFrozen", "engineVersion"))]
                for v in vs]))
        else:
            b4.append(Block("note", text="No saved version: the scenario's current change set is not frozen."))
            if s and s.kind != "baseline":
                unknowns.append(f"Scenario '{s.name if s else sid}' has no saved version; its state at decision time is not frozen.")
        runs = db.query(ScenarioRunEntity).filter(ScenarioRunEntity.scenario_id == sid).order_by(ScenarioRunEntity.created_at).all()
        runs_by_scn[sid] = runs
        if runs:
            b4.append(Block("table", header=["Run", "Recorded (UTC)", "Version", "Inputs (frozen)"], rows=[[
                r.id, _iso(r.created_at), r.scenario_version_id or "head (not versioned)",
                "; ".join(f"{k}={_short(a, 40)}" for k, a in _j(r.inputs_json, {}).items() if k in FAIR_KEYS)] for r in runs]))
    for rid in run_ids:
        r = db.get(ScenarioRunEntity, rid)
        if r and r.scenario_id not in runs_by_scn:
            runs_by_scn.setdefault(r.scenario_id, []).append(r)
            b4.append(Block("para", text=f"Attached run {r.id} of scenario {r.scenario_id} ({_iso(r.created_at)}): " + "; ".join(f"{k}={_short(a, 40)}" for k, a in _j(r.inputs_json, {}).items() if k in FAIR_KEYS)))
    S.append(b4 or [Block("para", text="No scenario is attached to this project.")])

    # 5 Comparison from run records
    b5: list[Block] = [Block("note", text="All values below are MODEL OUTPUTS (estimates) of the named runs. A comparison is marked fair only when both runs are on the same baseline and every fairness-critical input matches (docs/SCENARIOS_AND_VERSIONING.md).")]
    base_runs = db.query(ScenarioRunEntity).filter(ScenarioRunEntity.scenario_id == p.baseline_id).order_by(ScenarioRunEntity.created_at).all()
    pairs = 0
    for sid, runs in runs_by_scn.items():
        if sid == p.baseline_id:
            continue
        for r in runs:
            prior = [b for b in base_runs if b.created_at and r.created_at and b.created_at <= r.created_at]
            if not prior:
                continue
            b = prior[-1]
            ra, rb = _j(b.inputs_json, {}), _j(r.inputs_json, {})
            diffs = assumption_differences(ra, rb)
            fair = b.baseline_fingerprint == r.baseline_fingerprint and not any(d["fairnessCritical"] for d in diffs)
            resa, resb = _j(b.results_json, {}) or {}, _j(r.results_json, {}) or {}
            rows = []
            for k, (name, unit) in RESULT_LABEL.items():
                if k in resa or k in resb:
                    va, vb = resa.get(k), resb.get(k)
                    dlt = _num(vb - va) if isinstance(va, (int, float)) and isinstance(vb, (int, float)) else "-"
                    rows.append([f"{name} ({unit})", _num(va), _num(vb), dlt, "model output"])
            b5.append(Block("para", text=f"Baseline run {b.id} vs proposal run {r.id} (scenario {sid}): {'FAIR comparison' if fair else 'NOT a fair comparison'}"))
            b5.append(Block("table", header=["Metric", "Baseline", "Proposal", "Difference", "Label"], rows=rows or [["(no result summary recorded)", "-", "-", "-", "-"]]))
            if diffs:
                b5.append(Block("bullets", items=[f"Input differs: {d['field']}: {_short(d['a'], 40)} vs {_short(d['b'], 40)}{' (fairness-critical)' if d['fairnessCritical'] else ''}" for d in diffs]))
            pairs += 1
    if not pairs:
        b5.append(Block("para", text="No comparison result is present: no proposal run with an earlier baseline run is recorded for the attached scenarios."))
        unknowns.append("No recorded simulation comparison: expected benefits are not quantified in this project.")
    S.append(b5)

    # 6 Feasibility findings
    b6: list[Block] = [Block("note", text="Screening results only (verdict 'screening_only'). Each finding carries the certainty label of the data behind it; missing data is Unknown, never cleared.")]
    ass = [a for a in (db.get(FeasibilityAssessmentEntity, x) for x in L.get("assessment", [])) if a]
    for a in ass:
        aj = _j(a.assessment_json, {})
        plan = aj.get("plan", {})
        b6.append(Block("para", text=f"Assessment {a.id}: {a.name} - {docgen.TYPE_LABEL.get(a.proposal_type, a.proposal_type)} (scenario {a.scenario_id}, created {_iso(a.created_at)} by {a.created_by}; rules {a.rules_version}; sha256 {a.assessment_sha256[:16]}...)"))
        b6.append(Block("table", header=["#", "Finding", "Certainty", "Data source"], rows=[[f.get("id", ""), f.get("statement", ""), docgen._cl(f.get("certainty")), f.get("source", "")] for f in aj.get("findings", [])]))
        flags = plan.get("flags", [])
        if flags:
            b6.append(Block("bullets", items=[f"[{f.get('severity', '').upper()}] {f.get('text', '')} (rule {f.get('ruleId')}{', on missing data' if f.get('onMissingData') else ''})" for f in flags]))
        b6.append(Block("note", text=f"{len(plan.get('investigations', []))} investigations required; {len(plan.get('dataGaps', []))} data gaps."))
        for g in plan.get("dataGaps", []):
            unknowns.append(f"Assessment '{a.name}': data gap - {g.get('title')} (unknown {', '.join(g.get('attrs', []))})")
        ua = [k for k, v in aj.get("siteAttributes", {}).items() if isinstance(v, dict) and v.get("value") in (None, "unknown")]
        if ua:
            unknowns.append(f"Assessment '{a.name}': site attributes unknown - {', '.join(ua)}")
    if not ass:
        b6.append(Block("para", text="No feasibility assessment is attached to this project."))
        unknowns.append("No feasibility screening is attached.")
    S.append(b6)

    # 7 Documents and evidence
    aids = [a.id for a in ass]
    docs = db.query(InvestigationDocumentEntity).filter(InvestigationDocumentEntity.assessment_id.in_(aids)).order_by(InvestigationDocumentEntity.generated_at).all() if aids else []
    evs = db.query(EvidenceEntity).filter(EvidenceEntity.assessment_id.in_(aids)).order_by(EvidenceEntity.uploaded_at).all() if aids else []
    S.append([
        Block("para", text="Investigation requirements documents:"),
        Block("table", header=["File", "Format", "Assessment", "Generated by / at", "sha256"], rows=[[d.file_name, d.format, d.assessment_id, f"{d.generated_by} / {_iso(d.generated_at)}", d.file_sha256[:16] + "..."] for d in docs]),
        Block("para", text="Evidence on file (provenance as stated by the uploader):"),
        Block("table", header=["File", "Description", "Provenance", "Investigation", "Uploaded by / at", "sha256"], rows=[[e.file_name, e.description, e.provenance, e.investigation_id or "-", f"{e.uploaded_by} / {_iso(e.uploaded_at)}", e.file_sha256[:16] + "..."] for e in evs]),
    ])

    # 8 Reviews
    revs = db.query(ReviewRecordEntity).filter(ReviewRecordEntity.assessment_id.in_(aids)).order_by(ReviewRecordEntity.assessment_id, ReviewRecordEntity.seq).all() if aids else []
    S.append([Block("note", text="Review records are append-only. A review status records who looked at what with which evidence. NO review status means engineering, statutory or any other approval; 'External approval recorded' is unverified by this tool."),
              Block("table", header=["Assessment", "#", "Date", "Reviewer", "Item", "Status", "Evidence", "Notes"], rows=[[
                  r.assessment_id, str(r.seq), _iso(r.created_at), f"{r.reviewer_name} ({r.reviewer_role}{', ' + r.organisation if r.organisation else ''})",
                  r.item_type + (f": {r.item_id}" if r.item_id else ""), REVIEW_STATUS_LABEL.get(r.status, r.status) + (f" - ref {r.external_reference} (unverified)" if r.external_reference else ""),
                  str(len(_j(r.evidence_ids_json, []))) + " file(s)", r.notes] for r in revs])])

    # 9 Decision record
    decs = db.query(PlanningDecisionEntity).filter(PlanningDecisionEntity.project_id == p.id).order_by(PlanningDecisionEntity.seq).all()
    b9: list[Block] = [Block("note", text=DECISION_KIND_LABEL + ".")]
    for d in decs:
        refs = _j(d.evidence_refs_json, [])
        b9.append(Block("table", header=["Item", "Value"], rows=[
            ["Decision #", str(d.seq) + (f" (supersedes {d.supersedes})" if d.supersedes else "")], ["Kind", "Planning decision recorded in tool (not a statutory approval)"],
            ["Decision", d.decision_text], ["Recorded by", f"{d.decided_by}{' - ' + d.role if d.role else ''}{', ' + d.organisation if d.organisation else ''}"],
            ["Recorded at", _iso(d.created_at)], ["Scenario version", f"{d.scenario_version_id} (scenario {d.scenario_id})" if d.scenario_version_id else "none referenced"],
            ["Evidence referenced", ", ".join(f"{r['type']} {r['id']}" for r in refs) or "none"],
        ]))
    if not decs:
        b9.append(Block("para", text="No decision has been recorded."))
    S.append(b9)

    # 10 Assumptions and unknowns
    unknowns.append("Actor names in this report are self-declared; the tool has no authentication.")
    S.append([Block("para", text="Assumptions stated in the records:"), Block("bullets", items=assumptions or ["None stated in the attached records."]),
              Block("para", text="Unknowns and open points:"), Block("bullets", items=unknowns)])

    # 11 Audit summary
    ev = project_events(db, p.id, None)
    cnt = Counter((e.entity_type, e.action) for e in ev)
    S.append([Block("note", text="From the append-only audit log (entries cannot be updated or deleted; before/after are sha256 of the row's values)."),
              Block("table", header=["Entity", "Action", "Events"], rows=[[t, a, str(n)] for (t, a), n in sorted(cnt.items())]),
              Block("para", text="Latest 25 events:"),
              Block("table", header=["When (UTC)", "Actor", "Action", "Entity", "Label"], rows=[[_iso(e.at), f"{e.actor} [{e.actor_source}]", e.action, f"{e.entity_type} {e.entity_id}", e.label] for e in ev[:25]])])

    assert len(S) == len(SECTION_TITLES)
    return DocModel(title=f"Planning project report - {p.name}", subtitle=f"Project {p.id} | status {PROJECT_STATUS_LABEL.get(p.status, p.status)} | generated {generated}",
                    generated_at=generated, sections=[Section(i + 1, SECTION_TITLES[i], b) for i, b in enumerate(S)],
                    header_text=HEADER_TEXT, disclaimer=DISCLAIMER, template_version=TEMPLATE_VERSION)


def render(m: DocModel, fmt: str) -> bytes:
    return docgen.render(m, fmt)
