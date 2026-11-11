"""
Investigation Requirements Document generator (mission §10; template in
docs/INVESTIGATION_REQUIREMENTS.md §7). One document model, two renderers:

- DOCX via python-docx (editable by the authority's teams);
- PDF via fpdf2 — pure Python (deps: fonttools, Pillow), no system libraries,
  ~0.5 MB installed. Chosen over reportlab (larger, partly C, more API than
  needed) and over HTML→PDF engines (WeasyPrint needs Cairo/Pango system libs;
  headless Chromium is far too heavy for a backend dependency).

Every page carries the disclaimer in header and footer. Section 16 leaves
blank space for findings and evidence. Nothing in the document states that a
proposal is feasible, safe, constructible, permitted or approved.
"""

from __future__ import annotations

import datetime
import io
import json
import os
from dataclasses import dataclass, field
from typing import Any

from .models import REVIEW_STATUS_LABEL

TEMPLATE_VERSION = "investigation-requirements-document 1.0 (2026-11-11)"
HEADER_TEXT = "Planning brief for professional investigation. Not an engineering assessment or statutory approval."
DISCLAIMER = (
    "IMPORTANT: This document is a planning and decision-support brief generated from available data. "
    "It is NOT an engineering assessment, NOT a certification of safety or constructibility, NOT evidence of land "
    "availability or ownership, and NOT a statutory or any other approval. Findings marked Unknown have not been "
    "established; missing data has not been treated as evidence that the proposal is feasible. Standards and "
    "authorities are listed for the responsible team to IDENTIFY AND VERIFY. Qualified geotechnical, civil, structural, "
    "environmental and other professionals and the relevant statutory authorities must conduct or review the investigations."
)
CERTAINTY_LABEL = {
    "verified_from_available_data": "Verified from available data",
    "estimated": "Estimated",
    "inferred": "Inferred",
    "unknown": "Unknown",
    "requires_field_investigation": "Requires field investigation",
    "requires_professional_assessment": "Requires professional assessment",
}
TYPE_LABEL = {
    "new_road": "New road", "road_widening": "Road widening", "additional_lane": "Additional lane", "junction_redesign": "Junction redesign",
    "bridge": "Bridge", "flyover": "Flyover", "underpass": "Underpass", "elevated_corridor": "Elevated corridor", "interchange": "Interchange",
    "ramp_link": "Ramp / connecting link", "tunnel": "Tunnel", "underground_road": "Underground road",
}
SECTION_TITLES = [
    "Project name",
    "Project location",
    "Proposal type",
    "Proposed geometry and coordinates",
    "Reason for considering the proposal",
    "Existing traffic conditions",
    "Preliminary simulation results",
    "Expected benefits",
    "Known constraints",
    "Required surveys and investigations",
    "Recommended investigation methods",
    "Expected technical deliverables",
    "Relevant professional disciplines",
    "Applicable standards and approval authorities to identify and verify",
    "Outstanding risks and unknowns",
    "Space for findings and supporting evidence",
    "Responsible team or reviewer",
    "Review status and dates",
]


@dataclass
class Block:
    kind: str  # para | bullets | table | blank | note
    text: str = ""
    items: list[str] = field(default_factory=list)
    header: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    lines: int = 0


@dataclass
class Section:
    num: int
    title: str
    blocks: list[Block]


@dataclass
class DocModel:
    title: str
    subtitle: str
    generated_at: str
    sections: list[Section]
    # Optional overrides so other documents (planning project report) reuse the renderers; empty = this document's text
    header_text: str = ""
    disclaimer: str = ""
    template_version: str = ""


def _cl(c: str | None) -> str:
    return CERTAINTY_LABEL.get(c or "unknown", c or "Unknown")


def _val(v: Any) -> str:
    if v is True:
        return "yes"
    if v is False:
        return "no"
    if v is None or v == "unknown":
        return "unknown"
    return str(v)


def _provided(inputs: dict, key: str, missing: str) -> list[Block]:
    v = (inputs.get(key) or "").strip()
    prov = (inputs.get(f"{key}_provenance") or "").strip()
    if not v:
        return [Block("para", text=missing)]
    out = [Block("para", text=v)]
    out.append(Block("note", text=f"Provenance stated by the user: {prov}." if prov else "Provenance: not stated (treat as unverified)."))
    return out


def build_model(assessment: dict, meta: dict, inputs: dict, reviews: list[dict], evidence: list[dict], now: datetime.datetime | None = None) -> DocModel:
    a = assessment
    p = a.get("proposal", {})
    plan = a.get("plan", {})
    invs = plan.get("investigations", [])
    findings = a.get("findings", [])
    attrs = a.get("siteAttributes", {})
    flags = plan.get("flags", [])
    gaps = plan.get("dataGaps", [])
    ptype = p.get("proposalType", "unknown")
    generated = (now or datetime.datetime.utcnow()).strftime("%Y-%m-%d %H:%M UTC")
    S: list[list[Block]] = []

    # 1
    S.append([Block("para", text=(inputs.get("project_name") or p.get("name") or "Unnamed proposal").strip())])
    # 2
    c = a.get("centroid") or [None, None]
    loc = [Block("table", header=["Item", "Value"], rows=[
        ["Centroid (WGS84)", f"{c[1]:.6f} N, {c[0]:.6f} E" if c[0] is not None else "unknown"],
        ["Locality / ward", (inputs.get("location_description") or "Not provided (unknown)").strip()],
        ["Scenario", f"{meta.get('scenario_id')} (version: {meta.get('scenario_version') or 'not versioned'})"],
        ["Proposal object id(s)", ", ".join(meta.get("proposal_object_ids", [])) or "-"],
    ])]
    S.append(loc)
    # 3
    S.append([Block("table", header=["Item", "Value"], rows=[
        ["Proposal type", TYPE_LABEL.get(ptype, ptype)],
        ["Level", p.get("level", "unknown")],
        ["Drawn width", f"{p.get('widthM', 'unknown')} m (as drawn; not a design width)"],
        ["Drawn length", f"{a.get('lengthM', 'unknown')} m"],
        ["Excavation / foundation depth", _val(p.get("excavationDepthM")) + (" m (user planning assumption)" if p.get("excavationDepthM") is not None else " (not known at screening stage)")],
    ])])
    # 4
    line = p.get("line", [])
    rows = [[str(i + 1), f"{pt[1]:.6f}", f"{pt[0]:.6f}"] for i, pt in enumerate(line[:80])]
    blocks4 = [Block("note", text="Conceptual geometry, not a design. Coordinates in WGS84 (EPSG:4326)."), Block("table", header=["Vertex", "Latitude", "Longitude"], rows=rows)]
    if len(line) > 80:
        blocks4.append(Block("note", text=f"{len(line) - 80} further vertices are in the GeoJSON below."))
    blocks4.append(Block("para", text="GeoJSON: " + json.dumps({"type": "LineString", "coordinates": [[round(x, 7), round(y, 7)] for x, y in line]})))
    S.append(blocks4)
    # 5-8: user-supplied, never invented
    S.append(_provided(inputs, "reason", "Not provided. The diagnosed cause of the traffic problem, and the management alternatives considered (signal timing, turn restrictions, lane use, public transport, parking) with why they were insufficient, must be attached before this proposal is pursued."))
    S.append(_provided(inputs, "traffic_conditions", "Unknown. No existing traffic conditions are attached to this assessment. Measured counts and modelled values must be kept separate when added."))
    S.append(_provided(inputs, "simulation_results", "None attached. No preliminary simulation result is linked to this assessment; any result added must state the scenario version, frozen demand, seed, period and the model's validation status at this location."))
    S.append(_provided(inputs, "expected_benefits", "Not quantified. Any benefit must be a model output on frozen demand, subject to validation, and must show what gets worse as well as what improves."))
    # 9
    S.append([
        Block("note", text="Each finding carries the certainty label of the data behind it. 'Verified from available data' means a named dataset shows the fact; it never means the dataset is complete."),
        Block("table", header=["#", "Finding", "Certainty", "Data source"], rows=[[f.get("id", ""), f.get("statement", ""), _cl(f.get("certainty")), f.get("source", "")] for f in findings]),
        Block("para", text="Site attributes used by the investigation rules:"),
        Block("table", header=["Attribute", "Value", "Certainty", "Source / note"], rows=[[k, _val(v.get("value")), _cl(v.get("certainty")), (v.get("source", "") + (f" - {v['note']}" if v.get("note") else ""))] for k, v in attrs.items()]),
    ])
    # 10
    S.append([
        Block("note", text="Generated from the rule set " + str(plan.get("rulesVersion", "")) + ". 'On missing data' = required because the data needed to rule it out is not available; missing data never removes an investigation."),
        Block("table", header=["Investigation", "Triggered by rules", "Basis", "Certainty"], rows=[[i.get("name", i.get("id")), ", ".join(i.get("triggeredBy", [])), "On missing data" if i.get("firedOnMissingData") else "Data / proposal type", _cl(i.get("certainty"))] for i in invs]),
    ])
    # 11-13
    S.append([Block("note", text="Scope, spacing and depth of every investigation to be set by the responsible professional.")] + [b for i in invs for b in (Block("para", text=i.get("name", "")), Block("bullets", items=i.get("methods", [])))])
    S.append([b for i in invs for b in (Block("para", text=i.get("name", "")), Block("bullets", items=i.get("deliverables", [])))] or [Block("para", text="None generated.")])
    S.append([Block("bullets", items=plan.get("disciplines", []) or ["None generated."])])
    # 14
    th = plan.get("thresholdsUsed", [])
    S.append([
        Block("note", text="Every standard, edition and authority below is to be IDENTIFIED AND VERIFIED by the responsible team; inclusion here is not a determination that it applies or is sufficient."),
        Block("para", text="Standards and guidance to identify and verify:"), Block("bullets", items=plan.get("standards", []) or ["None generated."]),
        Block("para", text="Authorities to identify and verify:"), Block("bullets", items=plan.get("authorities", []) or ["None generated."]),
        Block("para", text="Screening thresholds used (basis shown; hypothetical values are configurable screening defaults with no statutory basis):"),
        Block("table", header=["Threshold", "Value", "Basis", "Note"], rows=[[t.get("key", ""), f"{t.get('value')} {t.get('unit', '')}".strip(), t.get("basis", ""), t.get("note", "") or ""] for t in th]),
        Block("para", text="Sources (evidence level as recorded in the research register):"),
        Block("table", header=["Id", "Source", "URL", "Evidence"], rows=[[s.get("id", ""), s.get("title", ""), s.get("url", "") or "", s.get("evidence", "") or ""] for s in plan.get("sources", [])]),
    ])
    # 15 — never empty for a physical proposal
    risks = [f"[{f.get('severity', '').upper()}] {f.get('text', '')} (rule {f.get('ruleId')}{', fired on missing data' if f.get('onMissingData') else ''})" for f in flags]
    risks += [f"Data gap - {g.get('title')} (rule {g.get('ruleId')}): unknown {', '.join(g.get('attrs', []))}" for g in gaps]
    unknown_attrs = [k for k, v in attrs.items() if v.get("value") in (None, "unknown")]
    if unknown_attrs:
        risks.append("Site attributes that are unknown: " + ", ".join(unknown_attrs) + ".")
    risks += [f"{f.get('statement')} [{_cl(f.get('certainty'))}]" for f in findings if f.get("kind") == "gap"]
    if not risks:
        risks = ["No risk was identified from the available data. This does not mean none exist: data coverage is incomplete."]
    S.append([Block("bullets", items=risks)])
    # 16 — blank space
    b16: list[Block] = [Block("note", text="To be completed by the investigating teams. Attach reports; this tool records files with a SHA-256 hash for integrity.")]
    for i in invs:
        b16.append(Block("para", text=i.get("name", "")))
        ev = [e for e in evidence if e.get("investigation_id") == i.get("id")]
        for e in ev:
            b16.append(Block("note", text=f"Evidence on file: {e['file_name']} - {e['description']} (uploaded by {e['uploaded_by']} {e['uploaded_at']}; provenance {e.get('provenance')}; sha256 {e['file_sha256'][:16]}...)"))
        b16.append(Block("blank", text="Findings:", lines=3))
        b16.append(Block("blank", text="Evidence reference(s):", lines=1))
    general = [e for e in evidence if not e.get("investigation_id")]
    if general:
        b16.append(Block("para", text="Other evidence on file:"))
        b16.append(Block("bullets", items=[f"{e['file_name']} - {e['description']} (uploaded by {e['uploaded_by']} {e['uploaded_at']}; sha256 {e['file_sha256'][:16]}...)" for e in general]))
    b16.append(Block("blank", text="Additional findings:", lines=4))
    S.append(b16)
    # 17
    team = (inputs.get("responsible_team") or "").strip()
    reviewers = sorted({f"{r['reviewer_name']} - {r['reviewer_role']}{', ' + r['organisation'] if r.get('organisation') else ''}" for r in reviews})
    b17 = [Block("table", header=["Item", "Value"], rows=[["Responsible team", team or "Not assigned"], ["Reviewers on record", "; ".join(reviewers) or "None"]])]
    b17 += [Block("blank", text="Name / role / organisation:", lines=1), Block("blank", text="Signature and date (acknowledges receipt of this brief only):", lines=1)]
    S.append(b17)
    # 18
    ev_names = {e["id"]: e["file_name"] for e in evidence}
    b18 = [Block("note", text="Review records are append-only. A review status records who looked at what and with which evidence. NO status in this document means engineering, statutory or any other approval. 'External approval recorded' means a user recorded an outside authority's reference; this tool has not verified it.")]
    if reviews:
        b18.append(Block("table", header=["#", "Date (UTC)", "Reviewer", "Item", "Status", "Evidence", "Notes"], rows=[[
            str(r["seq"]), r["created_at"], f"{r['reviewer_name']} ({r['reviewer_role']})", f"{r['item_type']}{': ' + r['item_id'] if r.get('item_id') else ''}",
            REVIEW_STATUS_LABEL.get(r["status"], r["status"]) + (f" - ref: {r['external_reference']}" if r.get("external_reference") else ""),
            ", ".join(ev_names.get(e, e) for e in r.get("evidence_ids", [])) or "none", r.get("notes", "")] for r in reviews]))
    else:
        b18.append(Block("para", text="Not started - no review records."))
    b18.append(Block("table", header=["Item", "Value"], rows=[["Assessment created", meta.get("created_at", "")], ["Document generated", generated], ["Engine", a.get("engineVersion", "")], ["Template", TEMPLATE_VERSION]]))
    S.append(b18)

    assert len(S) == 18
    name = (inputs.get("project_name") or p.get("name") or "Proposal").strip()
    return DocModel(
        title=f"Investigation Requirements Document - {name}",
        subtitle=f"{TYPE_LABEL.get(ptype, ptype)} | assessment {meta.get('id')} | generated {generated}",
        generated_at=generated,
        sections=[Section(i + 1, SECTION_TITLES[i], blocks) for i, blocks in enumerate(S)],
    )


# ── DOCX ───────────────────────────────────────────────────────────────────────

def render_docx(m: DocModel) -> bytes:
    from docx import Document
    from docx.shared import Pt, RGBColor

    d = Document()
    st = d.styles["Normal"]
    st.font.name = "Calibri"
    st.font.size = Pt(10)
    sec = d.sections[0]
    sec.header.paragraphs[0].text = m.header_text or HEADER_TEXT
    sec.footer.paragraphs[0].text = (m.header_text or HEADER_TEXT) + " | " + (m.template_version or TEMPLATE_VERSION)
    d.add_heading(m.title, level=0)
    d.add_paragraph(m.subtitle)
    p = d.add_paragraph()
    r = p.add_run(m.disclaimer or DISCLAIMER)
    r.bold = True
    r.font.color.rgb = RGBColor(0x9F, 0x12, 0x39)
    for s in m.sections:
        d.add_heading(f"{s.num}. {s.title}", level=1)
        for b in s.blocks:
            if b.kind == "para":
                d.add_paragraph(b.text)
            elif b.kind == "note":
                q = d.add_paragraph()
                rr = q.add_run(b.text)
                rr.italic = True
                rr.font.size = Pt(9)
            elif b.kind == "bullets":
                for it in b.items:
                    d.add_paragraph(it, style="List Bullet")
            elif b.kind == "table":
                if not b.rows:
                    d.add_paragraph("(none)")
                    continue
                t = d.add_table(rows=1, cols=len(b.header))
                t.style = "Table Grid"
                for i, h in enumerate(b.header):
                    t.rows[0].cells[i].text = h
                    for run in t.rows[0].cells[i].paragraphs[0].runs:
                        run.bold = True
                for row in b.rows:
                    cells = t.add_row().cells
                    for i, v in enumerate(row):
                        cells[i].text = str(v)
            elif b.kind == "blank":
                d.add_paragraph(b.text)
                for _ in range(max(1, b.lines)):
                    d.add_paragraph("_" * 90)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


# ── PDF ────────────────────────────────────────────────────────────────────────

_FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu", "/Library/Fonts", "C:/Windows/Fonts"]


def _find_font() -> tuple[str, str] | None:
    env = os.environ.get("TWINCITY_PDF_FONT_DIR")
    for d in ([env] if env else []) + _FONT_DIRS:
        reg, bold = os.path.join(d, "DejaVuSans.ttf"), os.path.join(d, "DejaVuSans-Bold.ttf")
        if os.path.exists(reg) and os.path.exists(bold):
            return reg, bold
    return None


def _latin1(s: str) -> str:
    rep = {"\u2014": "-", "\u2013": "-", "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2264": "<=", "\u2265": ">=", "\u00d7": "x", "\u2192": "->", "\u2026": "..."}
    for k, v in rep.items():
        s = s.replace(k, v)
    return s.encode("latin-1", "replace").decode("latin-1")


def render_pdf(m: DocModel) -> bytes:
    from fpdf import FPDF
    from fpdf.fonts import FontFace

    font = _find_font()
    HDR = m.header_text or HEADER_TEXT

    class Doc(FPDF):
        def header(self):
            self.set_font(FAM, "", 7)
            self.set_text_color(120, 20, 50)
            self.cell(0, 4, T(HDR), align="C", new_x="LMARGIN", new_y="NEXT")
            self.set_text_color(0, 0, 0)
            self.ln(2)

        def footer(self):
            self.set_y(-12)
            self.set_font(FAM, "", 7)
            self.set_text_color(120, 20, 50)
            self.cell(0, 4, T(f"{HDR}  |  Page {self.page_no()}/{{nb}}"), align="C")
            self.set_text_color(0, 0, 0)

    pdf = Doc(format="A4")
    if font:
        pdf.add_font("DejaVu", "", font[0])
        pdf.add_font("DejaVu", "B", font[1])
        FAM = "DejaVu"
        T = lambda s: s  # noqa: E731
    else:
        FAM = "Helvetica"
        T = _latin1
    pdf.alias_nb_pages()
    pdf.set_auto_page_break(True, margin=16)
    pdf.set_margins(15, 14, 15)
    pdf.add_page()
    pdf.set_font(FAM, "B", 15)
    pdf.multi_cell(0, 7, T(m.title), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font(FAM, "", 9)
    pdf.multi_cell(0, 5, T(m.subtitle), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)
    pdf.set_fill_color(253, 236, 240)
    pdf.set_font(FAM, "B", 9)
    pdf.multi_cell(0, 4.6, T(m.disclaimer or DISCLAIMER), border=1, fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    W = pdf.epw
    for s in m.sections:
        if pdf.get_y() > 250:
            pdf.add_page()
        pdf.set_font(FAM, "B", 12)
        pdf.set_text_color(10, 60, 110)
        pdf.multi_cell(0, 6.5, T(f"{s.num}. {s.title}"), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0, 0, 0)
        for b in s.blocks:
            if b.kind == "para":
                pdf.set_font(FAM, "", 9.5)
                pdf.multi_cell(0, 4.8, T(b.text), new_x="LMARGIN", new_y="NEXT")
            elif b.kind == "note":
                pdf.set_font(FAM, "", 8.5)
                pdf.set_text_color(80, 80, 80)
                pdf.multi_cell(0, 4.4, T(b.text), new_x="LMARGIN", new_y="NEXT")
                pdf.set_text_color(0, 0, 0)
            elif b.kind == "bullets":
                pdf.set_font(FAM, "", 9.5)
                for it in b.items:
                    pdf.set_x(pdf.l_margin + 3)
                    pdf.multi_cell(W - 3, 4.8, T(("\u2022 " if font else "- ") + it), new_x="LMARGIN", new_y="NEXT")
            elif b.kind == "table":
                if not b.rows:
                    pdf.set_font(FAM, "", 9)
                    pdf.multi_cell(0, 4.8, "(none)", new_x="LMARGIN", new_y="NEXT")
                    continue
                pdf.set_font(FAM, "", 8)
                n = len(b.header)
                widths = _col_widths(b, W)
                with pdf.table(col_widths=widths, line_height=4.2, headings_style=FontFace(emphasis="BOLD", fill_color=(230, 238, 246)), text_align="LEFT") as t:
                    hr = t.row()
                    for h in b.header:
                        hr.cell(T(h))
                    for row in b.rows:
                        r = t.row()
                        for v in (row + [""] * n)[:n]:
                            r.cell(T(str(v)))
            elif b.kind == "blank":
                pdf.set_font(FAM, "", 9)
                pdf.multi_cell(0, 5, T(b.text), new_x="LMARGIN", new_y="NEXT")
                for _ in range(max(1, b.lines)):
                    y = pdf.get_y() + 6
                    pdf.set_draw_color(160, 160, 160)
                    pdf.line(pdf.l_margin, y, pdf.l_margin + W, y)
                    pdf.ln(7)
            pdf.ln(1.2)
        pdf.ln(2)
    return bytes(pdf.output())


def _col_widths(b: Block, W: float, min_mm: float = 14.0) -> tuple[float, ...]:
    """Column widths proportional to content length, each at least `min_mm` (a too-narrow column cannot hold one glyph)."""
    n = len(b.header)
    lens = [max([len(b.header[i])] + [len(str(r[i])) if i < len(r) else 0 for r in b.rows]) for i in range(n)]
    lens = [min(max(L, 4), 80) for L in lens]
    tot = sum(lens)
    raw = [W * L / tot for L in lens]
    small = [i for i, w in enumerate(raw) if w < min_mm]
    if small and len(small) < n:
        free = W - min_mm * len(small)
        big_tot = sum(raw[i] for i in range(n) if i not in small)
        raw = [min_mm if i in small else raw[i] * free / big_tot for i in range(n)]
    return tuple(raw)


def render(m: DocModel, fmt: str) -> bytes:
    if fmt == "docx":
        return render_docx(m)
    if fmt == "pdf":
        return render_pdf(m)
    raise ValueError("format must be pdf or docx")
