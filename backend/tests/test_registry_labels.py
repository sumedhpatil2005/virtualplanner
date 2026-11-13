"""Fill-only human-readable labels from classification_overrides.json (QA, 2026-11-13). Every file here is SYNTHETIC."""
import hashlib
import json
import os
import tempfile


def _w(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = data if isinstance(data, bytes) else json.dumps(data).encode()
    with open(path, "wb") as f:
        f.write(raw)
    return hashlib.sha256(raw).hexdigest()


def _raw(root, sid, extra=None):
    d = os.path.join(root, "raw", sid, "2026-11-13")
    sha = _w(os.path.join(d, "data.bin"), b"SYNTHETIC " + sid.encode())
    _w(os.path.join(d, "manifest.json"), {"url": "https://example.invalid/data.bin", "licence": "SYNTHETIC test licence",
                                          "files": [{"path": "data.bin", "sha256": sha}], **(extra or {})})


def test_labels_fill_bare_ids_only(client, monkeypatch):
    root = tempfile.mkdtemp(prefix="urbanos-labels-test-")
    _raw(root, "t_lbl_bare")
    _raw(root, "t_lbl_named", {"title": "Stated title", "source": {"id": "t_lbl_named", "name": "Stated source", "publisher": "Stated publisher"}})
    ov = os.path.join(root, "overrides.json")
    _w(ov, {"datasets": {"t_lbl_bare": {"title": "SYNTHETIC readable title", "theme": "other", "data_class": "observed", "suitability": "screening", "reason": "SYNTHETIC"},
                         "t_lbl_named": {"title": "must not replace", "theme": "other", "data_class": "observed", "suitability": "screening", "reason": "SYNTHETIC"}},
            "sources": {"t_lbl_bare": {"name": "SYNTHETIC source name", "publisher": "SYNTHETIC publisher", "reason": "SYNTHETIC"},
                        "t_lbl_named": {"name": "must not replace", "publisher": "must not replace", "reason": "SYNTHETIC"}}})
    monkeypatch.setenv("URBANOS_CLASSIFICATION_OVERRIDES", ov)
    rep = client.post("/api/datasets/import", json={"root": root}).json()
    assert "dataset t_lbl_bare: title" in rep["labels_filled"]
    bare = client.get("/api/datasets/t_lbl_bare").json()
    assert bare["title"] == "SYNTHETIC readable title"
    assert bare["source"]["name"] == "SYNTHETIC source name" and bare["source"]["publisher"] == "SYNTHETIC publisher"
    named = client.get("/api/datasets/t_lbl_named").json()
    assert named["title"] == "Stated title"
    assert named["source"]["name"] == "Stated source" and named["source"]["publisher"] == "Stated publisher"
    # idempotent
    rep2 = client.post("/api/datasets/import", json={"root": root}).json()
    assert not [x for x in rep2["labels_filled"] if "t_lbl" in x]


def test_committed_labels_are_well_formed():
    from datasets.importer import load_overrides, load_source_labels
    ov, _ = load_overrides()
    for did in ("datameet_municipal_wards", "pmc_zones", "pmc_electoral_wards_2025"):
        assert ov[did]["title"] and ov[did]["title"] != did
    src = load_source_labels()
    assert src and all(v.get("reason") and v.get("name") for v in src.values())
