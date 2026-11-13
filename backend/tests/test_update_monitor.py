"""
Update monitor (datasets.update_monitor) with mocked HTTP. Every host, manifest, header and date here is SYNTHETIC
(hosts under .invalid; nothing is contacted, nothing is Pune data).
"""
import json
import os
import tempfile
import urllib.error
import uuid

import pytest

from datasets import update_monitor as UM
from datasets.models import DsDatasetVersionEntity, DsFileEntity, DsUpdateCheckEntity


class FakeClock:
    def __init__(self):
        self.t = 1000.0
        self.slept = []

    def clock(self):
        return self.t

    def sleep(self, s):
        self.slept.append(round(s, 3))
        self.t += s


def _fetcher(clock=None, delays=None):
    c = clock or FakeClock()
    return UM.Fetcher(delays or {}, 1.0, 5.0, sleep=c.sleep, clock=c.clock), c


@pytest.fixture()
def db(client, monkeypatch):  # noqa: ARG001 — client creates the tables and seeds
    from database.connection import SessionLocal
    root = tempfile.mkdtemp(prefix="urbanos-um-test-")
    monkeypatch.setenv("URBANOS_DATA_DIR", root)
    s = SessionLocal()
    s._um_root = root
    yield s
    s.rollback()
    s.close()


def _dataset(db, versions=0, **ver):
    from datasets.registry import add_version, ensure_dataset
    did = f"t_um_{uuid.uuid4().hex[:8]}"
    ensure_dataset(db, did, title="SYNTHETIC monitor test", theme="other", origin="seed")
    for _ in range(versions):
        add_version(db, did, version_label="v1", data_class="observed", suitability="screening", **ver)
    db.flush()
    return did


def _manifest(db, did, files):
    d = os.path.join(db._um_root, "raw", did, "2026-11-13")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "manifest.json"), "w") as f:
        json.dump({"source": {"source_id": did}, "files": files}, f)


class FakeHTTP:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, method, url, timeout=15.0, headers=None):
        self.calls.append((method, url))
        for key, resp in self.routes.items():
            if url.endswith(key) or key == url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        if url.endswith("/robots.txt"):
            return 404, {}, b""
        return 404, {}, b"not found"


# ── robots ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def test_robots_rfc9309_matching():
    txt = ("User-agent: *\nDisallow: *.osm.pbf\nDisallow: state.txt\nDisallow: *updates*\nCrawl-delay: 3\n\n"
           "User-agent: SomeBot\nDisallow: /\n")
    rules, delay = UM.parse_robots(txt)
    assert delay == 3.0
    assert not UM.robots_allows(rules, "https://h.invalid/asia/india/western-zone-latest.osm.pbf")
    assert not UM.robots_allows(rules, "https://h.invalid/asia/india/western-zone-updates/state.txt")
    assert UM.robots_allows(rules, "https://h.invalid/asia/india/western-zone.html")
    r2, _ = UM.parse_robots("User-agent: *\nDisallow: /api\nAllow: /api/records/*/files\nDisallow: /x$\n")
    assert not UM.robots_allows(r2, "https://z.invalid/api/records/1")
    assert UM.robots_allows(r2, "https://z.invalid/api/records/1/files")          # longer Allow wins
    assert not UM.robots_allows(r2, "https://z.invalid/x") and UM.robots_allows(r2, "https://z.invalid/xy")
    # a group naming our product token applies instead of '*'
    r3, _ = UM.parse_robots("User-agent: *\nAllow: /\n\nUser-agent: UrbanOS-dataset-registry\nDisallow: /private\n")
    assert not UM.robots_allows(r3, "https://h.invalid/private/a") and UM.robots_allows(r3, "https://h.invalid/public")


def test_rate_limit_floor_host_delay_and_crawl_delay(monkeypatch):
    fake = FakeHTTP({"a.invalid/robots.txt": (200, {}, b"User-agent: *\nCrawl-delay: 3\n"),
                     "nwdp.invalid/robots.txt": (200, {}, b"User-agent: *\nAllow: /\nCrawl-Delay: 10\n"),
                     "/x": (200, {"etag": '"1"'}, b""), "/y": (200, {"etag": '"2"'}, b"")})
    monkeypatch.setattr(UM, "HTTP", fake)
    f, c = _fetcher(delays={"nwdp.invalid": 10.0})
    for u in ("https://a.invalid/x", "https://a.invalid/y", "https://b.invalid/x", "https://b.invalid/y",
              "https://nwdp.invalid/x", "https://nwdp.invalid/y"):
        f.fetch("HEAD", u)
    # a: robots, x (wait 3), y (wait 3); b: robots 404 -> floor 1 s; nwdp: 10 s
    assert c.slept == [3.0, 3.0, 1.0, 1.0, 10.0, 10.0]


# ── probes and comparisons ─────────────────────────────────────────────────────────────────────────────────────────
def test_http_head_unchanged_then_update_available_never_downloads(db, monkeypatch):
    did = _dataset(db, versions=1)
    url = "https://pub.invalid/data/tile.tif"
    _manifest(db, did, [{"file": "tile.tif", "url": url, "http": {"headers": {"ETag": '"abc"', "Last-Modified": "Mon, 09 May 2022 14:07:11 GMT", "Content-Length": "10"}}}])
    targets = {"datasets": {did: {"method": "http_head", "baseline": "manifest", "urls": [url]}}}
    fake = FakeHTTP({url: (200, {"etag": '"abc"', "last-modified": "Mon, 09 May 2022 14:07:11 GMT", "content-length": "10"}, b"")})
    monkeypatch.setattr(UM, "HTTP", fake)
    n_versions = db.query(DsDatasetVersionEntity).filter_by(dataset_id=did).count()
    n_files = db.query(DsFileEntity).count()
    rep = UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])
    assert rep["summary"] == {"unchanged": 1}
    fake.routes[url] = (200, {"etag": '"def"', "last-modified": "Tue, 10 Nov 2026 14:45:36 GMT", "content-length": "12"}, b"")
    rep = UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])
    row = rep["rows"][0]
    assert row["result"] == "update_available" and "Not downloaded" in row["detail"] and "last_modified" in row["detail"]
    assert all(m == "HEAD" for m, u in fake.calls if not u.endswith("robots.txt"))          # metadata only
    assert db.query(DsDatasetVersionEntity).filter_by(dataset_id=did).count() == n_versions  # nothing registered
    assert db.query(DsFileEntity).count() == n_files
    assert db.query(DsUpdateCheckEntity).filter_by(dataset_id=did).count() == 2
    from datasets.registry import update_status
    assert update_status(db, did)["result"] == "update_available"
    # older date than acquired: differs but not newer -> changed, never update_available
    fake.routes[url] = (200, {"etag": '"zzz"', "last-modified": "Mon, 01 Jan 2018 00:00:00 GMT"}, b"")
    assert UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])["rows"][0]["result"] == "changed"


def test_first_check_becomes_reference_when_acquisition_recorded_nothing(db, monkeypatch):
    did = _dataset(db)
    url = "https://pub.invalid/page.html"
    targets = {"datasets": {did: {"method": "http_head", "baseline": "first_check", "urls": [url]}}}
    fake = FakeHTTP({url: (200, {"etag": '"e1"'}, b"")})
    monkeypatch.setattr(UM, "HTTP", fake)
    assert UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])["rows"][0]["result"] == "first_seen"
    assert UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])["rows"][0]["result"] == "unchanged"
    fake.routes[url] = (200, {"etag": '"e2"'}, b"")
    assert UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])["rows"][0]["result"] == "update_available"


def test_ckan_resource_revision_and_removed_resource(db, monkeypatch):
    did = _dataset(db, versions=1)
    rid = "11111111-2222-3333-4444-555555555555"
    _manifest(db, did, [{"file": "a.csv", "url": f"https://ckan.invalid/dataset/x/resource/{rid}/download/a.csv",
                         "ckan_dataset": "pkg-a", "ckan_last_modified_utc": "2025-11-25T15:53:17.599795"}])
    targets = {"datasets": {did: {"method": "ckan", "api": "https://ckan.invalid/api/3/action", "baseline": "manifest", "packages": "from_manifest"}}}
    doc = {"success": True, "result": {"metadata_modified": "2026-01-01T00:00:00", "resources": [{"id": rid, "last_modified": "2025-11-25T15:53:17.599795"}]}}
    fake = FakeHTTP({"package_show?id=pkg-a": (200, {}, json.dumps(doc).encode())})
    monkeypatch.setattr(UM, "HTTP", fake)
    assert UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])["rows"][0]["result"] == "unchanged"
    doc["result"]["resources"][0]["last_modified"] = "2026-11-12T10:00:00"
    fake.routes["package_show?id=pkg-a"] = (200, {}, json.dumps(doc).encode())
    r = UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])["rows"][0]
    assert r["result"] == "update_available" and "resource 11111111" in r["detail"]
    doc["result"]["resources"] = [{"id": "other", "last_modified": "2026-11-12T10:00:00"}]
    fake.routes["package_show?id=pkg-a"] = (200, {}, json.dumps(doc).encode())
    assert UM.run(db, only=[did], targets=targets, fetcher=_fetcher()[0])["rows"][0]["result"] == "changed"


def test_stac_latest_and_github_release_and_geofabrik(db, monkeypatch):
    s2 = _dataset(db, versions=1)
    _manifest(db, s2, [{"filename": "S2C_43QCA_20251114_0_L2A.stac-item.json", "url": "https://stac.invalid/v1/items/x"}])
    gh = _dataset(db)
    gf = _dataset(db, versions=1, observation_end="Mon 2026-11-02 2:51 AM IST (UTC+05:30)")
    targets = {"datasets": {
        s2: {"method": "stac_latest", "api": "https://stac.invalid/v1", "collection": "sentinel-2-l2a", "bbox": [73.7, 18.4, 74.05, 18.7], "baseline": "manifest"},
        gh: {"method": "github_release", "repo": "synthetic/repo", "baseline": "first_check"},
        gf: {"method": "geofabrik", "page": "https://gf.invalid/asia/zone.html", "state_url": "https://gf.invalid/asia/zone-updates/state.txt", "baseline": "active_version"}}}
    stac = {"features": [{"id": "S2A_43QCA_20261111_0_L2A", "properties": {"datetime": "Wed 2026-11-11 11:14 AM IST (UTC+05:30)", "eo:cloud_cover": 0.1}}]}
    fake = FakeHTTP({
        "sortby=-properties.datetime": (200, {}, json.dumps(stac).encode()),
        "/repos/synthetic/repo/releases/latest": (200, {}, b'{"tag_name": "v1_20_0", "published_at": "2026-05-01T00:00:00Z"}'),
        "gf.invalid/robots.txt": (200, {}, b"User-agent: *\nDisallow: state.txt\nDisallow: *updates*\n"),
        "/asia/zone.html": (200, {}, b"<li>modified 18 hours ago and contains all OSM data up to 2026-11-12T21:23:05Z. File size: 211 MB.</li>")})
    monkeypatch.setattr(UM, "HTTP", fake)
    rows = {r["dataset_id"]: r for r in UM.run(db, only=[s2, gh, gf], targets=targets, fetcher=_fetcher()[0])["rows"]}
    assert rows[s2]["result"] == "update_available" and "S2A_43QCA_20261111" in rows[s2]["detail"]
    assert rows[gh]["result"] == "first_seen"
    assert rows[gf]["result"] == "update_available" and rows[gf]["url"].endswith("zone.html")
    assert not any("state.txt" in u for _m, u in fake.calls)            # robots honoured: state.txt never requested
    fake.routes["/repos/synthetic/repo/releases/latest"] = (200, {}, b'{"tag_name": "v1_21_0", "published_at": "2026-11-01T00:00:00Z"}')
    assert UM.run(db, only=[gh], targets=targets, fetcher=_fetcher()[0])["rows"][0]["result"] == "update_available"


# ── safety: offline, refusal, robots, SSRF, not checkable ──────────────────────────────────────────────────────────
def test_offline_refusal_robots_ssrf_and_not_checkable(db, monkeypatch):
    off, cf, rb, ssrf, none = (_dataset(db) for _ in range(5))
    targets = {"datasets": {
        off: {"method": "http_head", "urls": ["https://down.invalid/a", "https://down.invalid/b"]},
        cf: {"method": "ckan", "api": "https://cf.invalid/api/3/action", "packages": ["p1", "p2", "p3"]},
        rb: {"method": "http_head", "urls": ["https://rb.invalid/secret/file"]},
        ssrf: {"method": "http_head", "urls": ["http://127.0.0.1:8000/x"]},
        none: {"method": "none", "reason": "SYNTHETIC: per-request jobs"}}}
    fake = FakeHTTP({"down.invalid/robots.txt": urllib.error.URLError("Temporary failure in name resolution"),
                     "package_show?id=p1": (403, {"server": "cloudflare", "cf-mitigated": "challenge"}, b""),
                     "rb.invalid/robots.txt": (200, {}, b"User-agent: *\nDisallow: /secret\n")})
    monkeypatch.setattr(UM, "HTTP", fake)
    rep = UM.run(db, only=[off, cf, rb, ssrf, none], targets=targets, fetcher=_fetcher()[0])
    by = {}
    for r in rep["rows"]:
        by.setdefault(r["dataset_id"], []).append(r)
    assert [r["result"] for r in by[off]] == ["error", "error"] and "unreachable" in by[off][1]["detail"]
    assert [r["result"] for r in by[cf]] == ["error", "error", "error"]
    assert "Cloudflare" in by[cf][1]["detail"] and "not bypassed" in by[cf][1]["detail"]
    assert sum(1 for _m, u in fake.calls if "package_show" in u) == 1          # refused host not contacted again
    assert sum(1 for _m, u in fake.calls if "down.invalid" in u) == 1          # unreachable host: one attempt
    assert by[rb][0]["result"] == "not_checkable" and "robots.txt disallows" in by[rb][0]["detail"]
    assert not any("rb.invalid/secret" in u for _m, u in fake.calls)
    assert by[ssrf][0]["result"] == "error" and "non-public" in by[ssrf][0]["detail"]
    assert not any("127.0.0.1" in u for _m, u in fake.calls)
    assert by[none][0]["result"] == "not_checkable" and "per-request jobs" in by[none][0]["detail"]


def test_committed_targets_file_is_consistent():
    t = UM.load_targets(UM.TARGETS_PATH)
    assert t["_host_min_delay_s"]["nwdp.nwic.gov.in"] >= 10 and t["_default_min_delay_s"] >= 1
    for did, spec in t["datasets"].items():
        m = spec["method"]
        assert m in ("http_head", "ckan", "stac_latest", "github_release", "geofabrik", "none"), did
        if m == "none":
            assert spec.get("reason"), did
            continue
        urls = spec.get("urls") or [spec.get("api") or spec.get("page") or f"https://api.github.com/repos/{spec.get('repo')}"]
        assert all(u.startswith("https://") for u in urls), did
    # Geofabrik's robots.txt forbids the .pbf and state.txt: the monitor must target the HTML page
    assert t["datasets"]["osm_geofabrik_western_zone"]["page"].endswith(".html")


def test_api_exposes_update_status(client, monkeypatch):
    from database.connection import SessionLocal
    with SessionLocal() as s:
        did = _dataset(s)
        s.add(DsUpdateCheckEntity(id=f"dsu_{uuid.uuid4().hex[:8]}", dataset_id=did, method="http_head", url="https://pub.invalid/a",
                                  result="update_available", detail="SYNTHETIC newer"))
        s.add(DsUpdateCheckEntity(id=f"dsu_{uuid.uuid4().hex[:8]}", dataset_id=did, method="http_head", url="https://pub.invalid/b",
                                  result="unchanged", detail="SYNTHETIC same"))
        s.commit()
    st = client.get(f"/api/datasets/{did}").json()["update_status"]
    assert st["result"] == "update_available" and st["urls_checked"] == 2 and st["results"] == {"update_available": 1, "unchanged": 1}


# ── classification gaps (step 2) ───────────────────────────────────────────────────────────────────────────────────
def test_worldcover_stated_derived_is_corrected_to_inferred():
    from datasets.importer import _class_correction, load_overrides
    ov, _sha = load_overrides()
    raw = _class_correction({"classification": "derived (classifier on Sentinel-1/2 2021)"}, None, ov["esa_worldcover_2021_v200"])
    clip = _class_correction(None, {"classification": "derived"}, ov["landcover_worldcover2021"])
    assert raw["to"] == "inferred" and clip["to"] == "inferred"
    assert _class_correction({"classification": "observed"}, None, ov["esa_worldcover_2021_v200"]) is None  # only the stated word 'derived'


def test_gov_processing_records_git_dirty_and_old_files_report_unknown(tmp_path):
    from pathlib import Path

    from datasets import provenance_check as PC
    from datasets.pipelines import gov_common as gc
    out = tmp_path / "derived" / "t_gov" / "2026-11-13"
    out.mkdir(parents=True)
    f = out / "x.csv"
    f.write_text("SYNTHETIC")
    doc = json.loads(gc.write_processing(out, pipeline="t", inputs=[], parameters={}, outputs=[f], validation={}).read_text())
    assert "git_dirty_datasets" in doc and doc["git_dirty_datasets"] in (True, False, None)
    old = tmp_path / "derived" / "t_old" / "v1"
    old.mkdir(parents=True)
    (old / "processing.json").write_text(json.dumps({"pipeline": "t", "git_commit": "UNKNOWN", "inputs": [], "outputs": []}))
    rows = {r["derived"]: r for r in PC.check(Path(tmp_path))["rows"]}
    assert rows["t_old/v1"]["git_dirty_datasets"] == "UNKNOWN (not recorded)"


def test_gzip_representation_and_tags_fallback(db, monkeypatch):
    did = _dataset(db, versions=1)
    url = "https://raw.invalid/repo/master/wards.geojson"
    _manifest(db, did, [{"file": "wards.geojson", "url": url, "http_headers": {"Etag": 'W/"gz1"', "Content-Length": "42"}}])
    gh = _dataset(db)
    targets = {"datasets": {did: {"method": "http_head", "baseline": "manifest", "urls": [url]},
                            gh: {"method": "github_release", "repo": "synthetic/tagsonly", "baseline": "first_check"}}}

    class EncHTTP(FakeHTTP):
        def __call__(self, method, u, timeout=15.0, headers=None):
            if u == url:
                self.calls.append((method, u, (headers or {}).get("Accept-Encoding")))
                return (200, {"etag": 'W/"gz1"', "content-length": "42", "content-encoding": "gzip"}, b"") if (headers or {}).get("Accept-Encoding") == "gzip" \
                    else (200, {"etag": '"plain1"', "content-length": "168"}, b"")
            return super().__call__(method, u, timeout, headers)
    fake = EncHTTP({"/repos/synthetic/tagsonly/releases/latest": (404, {"_reason": "Not Found"}, b""),
                    "/repos/synthetic/tagsonly/tags?per_page=1": (200, {}, b'[{"name": "v1_28_0"}]')})
    monkeypatch.setattr(UM, "HTTP", fake)
    rows = {r["dataset_id"]: r for r in UM.run(db, only=[did, gh], targets=targets, fetcher=_fetcher()[0])["rows"]}
    assert rows[did]["result"] == "unchanged" and "gzip representation" in rows[did]["detail"]   # no false 'update available'
    assert rows[gh]["result"] == "first_seen" and "tags API" in rows[gh]["detail"]
    fake.routes["/repos/synthetic/tagsonly/tags?per_page=1"] = (200, {}, b'[{"name": "v1_29_0"}]')
    assert UM.run(db, only=[gh], targets=targets, fetcher=_fetcher()[0])["rows"][0]["result"] == "update_available"


def test_error_keeps_reason_phrase(db, monkeypatch):
    did = _dataset(db)
    url = "https://blob.invalid/c/x.tif"
    monkeypatch.setattr(UM, "HTTP", FakeHTTP({url: (409, {"_reason": "Public access is not permitted on this storage account."}, b"")}))
    r = UM.run(db, only=[did], targets={"datasets": {did: {"method": "http_head", "urls": [url]}}}, fetcher=_fetcher()[0])["rows"][0]
    assert r["result"] == "error" and "409 Public access is not permitted" in r["detail"]
