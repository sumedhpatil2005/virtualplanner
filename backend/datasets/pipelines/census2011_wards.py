"""
Census of India 2011 ward table for Pune Municipal Corporation (OpenCity mirror, resource "Pune - Ward-wise Census Data 2011")
→ derived JSON with a mappability verdict. docs/urbanos/INFRASTRUCTURE_DATA.md §5.

Historical data (2011). The table is keyed by 144 census ward numbers grouped under 15 ward-office names. No boundary file
of the 2011 census wards has been acquired, and no acquired polygon layer is keyed by those numbers (electoral wards
2012/2017/2022/2025 and prabhags use other numbering; the 2017 administrative wards changed boundaries and names after 2011),
so the table is NOT mappable: it is listed, never drawn or joined to a polygon. Rows "<office> Total" are the publisher's
subtotals and are kept separately (checked against the sum of their wards).

CLI: python -m datasets.pipelines.census2011_wards
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from .gov_common import derived_root, raw_root, write_processing

RESOURCE = "aa1addf9-77d6-4990-b65c-20f0439fa1f5.csv"
FIELDS = {"No of House Holds": "households", "TOT_P": "population", "TOT_M": "male", "TOT_F": "female", "P_06": "age_0_6",
          "P_SC": "sc", "P_ST": "st"}


def run(date: str = "2026-11-13") -> Path:
    src_dir = raw_root() / "opencity_pune" / date
    src = src_dir / RESOURCE
    man = json.loads((src_dir / "manifest.json").read_text())
    entry = next(e for e in man["files"] if e["file"] == RESOURCE)
    rows, totals = [], {}
    with open(src, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            num = (r.get("Census Ward Number") or "").strip()
            vals = {FIELDS[k]: int(r[k]) for k in FIELDS if (r.get(k) or "").strip().lstrip("-").isdigit()}
            if num.isdigit():
                rows.append({"census_ward": int(num), "ward_office": r["Ward Name"].strip(), **vals})
            elif num.lower().endswith("total"):
                totals[r["Ward Name"].strip()] = vals
    check = {}
    for office, t in totals.items():
        s = sum(x.get("population", 0) for x in rows if x["ward_office"] == office)
        check[office] = {"published_total": t.get("population"), "sum_of_wards": s, "match": s == t.get("population")}
    from collections import Counter
    dup = sorted(k for k, n in Counter(r["census_ward"] for r in rows).items() if n > 1)
    out_dir = derived_root() / "census2011_pune_wards" / date
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "census2011_pune_wards.json"
    doc = {"title": "Census 2011 — PMC ward table (historical)", "vintage": "Census of India 2011", "unit": "census ward (2011)",
           "rows": rows, "office_totals": totals,
           "duplicate_ward_numbers": {str(k): sorted(r["ward_office"] for r in rows if r["census_ward"] == k) for k in dup}, "subtotal_check": check,
           "total_population": sum(x.get("population", 0) for x in rows),
           "mappable": False,
           "not_mappable_reasons": [
               "No 2011 census-ward boundary file has been acquired (144 census wards).",
               "Acquired PMC polygons use other units: electoral wards 2012 (76), 2017 (41), 2022 (58), 2025 (41), prabhags (72), administrative wards 2017 (15).",
               "Ward-office names resemble the 2017 administrative wards, but those boundaries were redrawn after 2011 (15 offices in 2017 incl. Kondhwa-Wanavdi; the 2011 table has Yewalewadi): a name match is not a geography match."],
           "source": {"url": entry["url"], "sha256": entry["sha256"], "retrieved_at": entry["retrieved_at"],
                      "publisher": "Census of India (Office of the Registrar General) via PMC / OpenCity", "licence_as_stated": entry.get("licence_as_stated")}}
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False))
    write_processing(out_dir, pipeline="datasets.pipelines.census2011_wards", inputs=[{"file": str(src), "sha256": entry["sha256"], "url": entry["url"],
                     "licence_as_stated": entry.get("licence_as_stated")}],
                     parameters={"keep": list(FIELDS.values()), "subtotal_rows": "kept separately"}, outputs=[out],
                     validation={"wards": len(rows), "offices": len({r['ward_office'] for r in rows}), "subtotal_check_all_match": all(c["match"] for c in check.values())},
                     notes="Historical (Census 2011). NOT mappable — listed only. Classification: observed (census enumeration), screening.")
    p = out_dir / "processing.json"
    d = json.loads(p.read_text())
    d.update({"dataset_id": "census2011_pune_wards", "theme": "population", "data_class": "observed", "suitability": "screening",
              "observation_start": "2011", "observation_end": "2011", "title": "Census 2011 PMC ward table (historical, not mappable)"})
    p.write_text(json.dumps(d, indent=1, ensure_ascii=False))
    return out


if __name__ == "__main__":
    print(run())
