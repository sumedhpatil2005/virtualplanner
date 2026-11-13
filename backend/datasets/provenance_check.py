"""Provenance integrity check of the data store (docs/urbanos/DATA_QUALITY_AND_PROVENANCE.md).

    python -m datasets.provenance_check [--hash] [--max-hash-mb N] [--json out.json]

For every derived/<dataset>/<version>/processing.json:
  * each input's recorded sha256 must equal the sha256 the raw manifest (raw/<source>/<date>/manifest.json) or the
    producing derived processing.json recorded for that file -> match | MISMATCH | unregistered (no manifest lists it)
  * --hash: the file on disk is re-hashed (inputs and outputs) -> disk_mismatch / missing
  * git_commit must be a commit in this repository (git cat-file) and git_dirty_datasets must not be true. A
    processing.json without the key (gov pipelines before 2026-11-13: the writer did not record it) reports
    git_dirty_datasets "UNKNOWN (not recorded)" - not a problem, and never rewritten into the old file.
Read-only: never modifies raw or derived files. Exit status 1 when any MISMATCH / disk_mismatch / bad commit is found.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from . import paths


def _sha(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _name(e: dict) -> str | None:
    return e.get("path") or e.get("file") or e.get("filename")


def _resolve(name: str, base: Path) -> Path:
    p = Path(name)
    return p if p.is_absolute() else base / p


def registered_files(root: Path) -> dict[str, dict]:
    """realpath -> {sha256, origin, url} for every file a raw manifest or a derived processing.json output lists."""
    reg: dict[str, dict] = {}
    for m in sorted((root / "raw").glob("*/*/manifest.json")):
        doc = json.loads(m.read_text())
        for f in doc.get("files") or []:
            if isinstance(f, dict) and _name(f) and f.get("sha256"):
                reg[os.path.realpath(_resolve(_name(f), m.parent))] = {"sha256": f["sha256"], "origin": str(m.relative_to(root)),
                                                                      "url": f.get("url"),
                                                                      "deleted": any(k.startswith("deleted") for k in f)}
    for pj in sorted((root / "derived").glob("*/*/processing.json")):
        doc = json.loads(pj.read_text())
        for f in doc.get("outputs") or []:
            if isinstance(f, dict) and _name(f) and f.get("sha256"):
                reg.setdefault(os.path.realpath(_resolve(_name(f), pj.parent)), {"sha256": f["sha256"], "origin": str(pj.relative_to(root))})
    return reg


def _commit_ok(c: str | None) -> bool:
    if not c or c == "UNKNOWN":
        return False
    try:
        subprocess.check_output(["git", "cat-file", "-e", f"{c}^{{commit}}"], cwd=Path(__file__).parent, stderr=subprocess.DEVNULL)
        return True
    except Exception:  # noqa: BLE001
        return False


def check(root: Path | None = None, hash_files: bool = False, max_hash_bytes: int = 6 * 1024 ** 3) -> dict:
    root = Path(root or paths.data_dir())
    reg = registered_files(root)
    rows, problems = [], []
    for pj in sorted((root / "derived").glob("*/*/processing.json")):
        doc = json.loads(pj.read_text())
        did = f"{pj.parent.parent.name}/{pj.parent.name}"
        commit = doc.get("git_commit")
        dirty = doc["git_dirty_datasets"] if "git_dirty_datasets" in doc else "UNKNOWN (not recorded)"
        r = {"derived": did, "pipeline": doc.get("pipeline"), "git_commit": commit, "commit_in_repo": _commit_ok(commit),
             "git_dirty_datasets": dirty, "inputs": [], "outputs": []}
        if not r["commit_in_repo"]:
            problems.append(f"{did}: git_commit {commit!r} is not a commit in this repository")
        if dirty is True:
            problems.append(f"{did}: produced from uncommitted pipeline code (git_dirty_datasets=true)")
        for e in doc.get("inputs") or []:
            if not isinstance(e, dict) or not _name(e):
                continue
            p = _resolve(_name(e), pj.parent)
            known = reg.get(os.path.realpath(p))
            if known is None and not Path(_name(e)).is_absolute():
                # gov pipelines record raw inputs by bare file name: find the raw manifest entry (same name; same URL if
                # several manifests list that name)
                cands = [(k, v) for k, v in reg.items() if os.path.basename(k) == os.path.basename(_name(e))]
                if len(cands) > 1 and e.get("url"):
                    cands = [(k, v) for k, v in cands if v.get("url") == e.get("url")] or cands
                if len(cands) == 1:
                    p, known = Path(cands[0][0]), cands[0][1]
            st = "unregistered" if known is None else ("match" if known["sha256"] == e.get("sha256") else "MISMATCH")
            item = {"file": str(p), "recorded": e.get("sha256"), "registry": known and known["sha256"],
                    "registered_in": known and known["origin"], "status": st}
            if st == "MISMATCH":
                problems.append(f"{did}: input {p.name} sha256 {str(e.get('sha256'))[:12]} != {known['origin']} {known['sha256'][:12]}")
            if hash_files:
                item["disk"] = _disk(p, e.get("sha256"), max_hash_bytes)
                if item["disk"] in ("disk_mismatch",):
                    problems.append(f"{did}: input {p.name} on disk does not match its recorded sha256")
            r["inputs"].append(item)
        for e in doc.get("outputs") or []:
            if not isinstance(e, dict) or not _name(e):
                continue
            p = _resolve(_name(e), pj.parent)
            item = {"file": str(p), "recorded": e.get("sha256")}
            if hash_files:
                item["disk"] = _disk(p, e.get("sha256"), max_hash_bytes)
                if item["disk"] == "disk_mismatch":
                    problems.append(f"{did}: output {p.name} on disk does not match its recorded sha256")
            r["outputs"].append(item)
        rows.append(r)
    tally: dict[str, int] = {}
    for r in rows:
        for i in r["inputs"]:
            tally[i["status"]] = tally.get(i["status"], 0) + 1
            if "disk" in i:
                tally["input_" + i["disk"]] = tally.get("input_" + i["disk"], 0) + 1
        for o in r["outputs"]:
            if "disk" in o:
                tally["output_" + o["disk"]] = tally.get("output_" + o["disk"], 0) + 1
    return {"root": str(root), "derived_versions": len(rows), "tally": tally, "problems": problems, "rows": rows}


def _disk(p: Path, recorded: str | None, max_bytes: int) -> str:
    if not p.exists():
        return "missing"
    if not recorded:
        return "no_recorded_sha"
    if p.stat().st_size > max_bytes:
        return "not_hashed_too_large"
    return "disk_match" if _sha(p) == recorded else "disk_mismatch"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=None)
    ap.add_argument("--hash", action="store_true", help="re-hash files on disk")
    ap.add_argument("--max-hash-mb", type=int, default=6144)
    ap.add_argument("--json", default=None)
    a = ap.parse_args(argv)
    rep = check(Path(a.root) if a.root else None, a.hash, a.max_hash_mb * 1024 * 1024)
    if a.json:
        Path(a.json).write_text(json.dumps(rep, indent=1))
    print(json.dumps({"root": rep["root"], "derived_versions": rep["derived_versions"], "tally": rep["tally"]}, indent=1))
    for p in rep["problems"]:
        print("PROBLEM:", p)
    unreg = sorted({(r["derived"], i["file"]) for r in rep["rows"] for i in r["inputs"] if i["status"] == "unregistered"})
    for d, f in unreg:
        print("unregistered input:", d, f)
    return 1 if rep["problems"] else 0


if __name__ == "__main__":
    sys.exit(main())
