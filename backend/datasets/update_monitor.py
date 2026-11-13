"""
Update monitor (docs/urbanos/DATA_INGESTION_ARCHITECTURE.md §6): for every registered dataset with a machine-checkable
upstream endpoint, probe the publisher's METADATA once and record a `ds_update_checks` row.

    python -m datasets.update_monitor [--only id,id] [--exclude id,id] [--plan] [--dry-run] [--timeout S] [--json FILE]

Methods (backend/datasets/update_targets.json, plus any dataset whose own update_check is http_head / ckan):
  http_head     HEAD each URL; ETag / Last-Modified / Content-Length vs the raw manifest's recorded headers
  ckan          GET <api>/package_show?id=<pkg>; metadata_modified and each acquired resource's last_modified
  stac_latest   GET <api>/search?collections=…&bbox=…&sortby=-properties.datetime&limit=1; newest scene date vs acquired
  github_release GET https://api.github.com/repos/<repo>/releases/latest; tag / published_at
  geofabrik     region page 'contains all OSM data up to …' (state.txt only when robots.txt allows it)

Results: first_seen (no acquired reference: recorded as the reference) | unchanged | update_available (the publisher
reports newer content) | changed (differs but not demonstrably newer) | error | not_checkable (robots / no endpoint).
NEVER downloads, registers or replaces data: an available update is a row for a reviewer, who acquires it with the
pipeline, registers it with the importer (pending review) and activates it explicitly.

Politeness and safety: one robots.txt read per host and run (RFC 9309 matching: longest rule wins, * and $ wildcards;
4xx = no rules, 5xx = disallow all); Crawl-delay honoured with a floor of 1 s per host (NWDP / Zenodo 10 s from the
targets file); public http(s) only, also for every redirect (datasets.updates SSRF guard); per-request timeout; a host
that fails at network level, or refuses with 401/403/429, is not contacted again in the run. Offline: every probe is
recorded as an error and the run exits 0.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from sqlalchemy.orm import Session

from . import paths
from .models import DsDatasetEntity, DsUpdateCheckEntity
from .registry import _j, active_version, new_id
from .timeutil import parse_ts
from .updates import _PublicRedirects, non_public_reason

UA = "UrbanOS-dataset-registry/1.0 (update monitor; read-only metadata checks, never downloads data)"
UA_TOKEN = "urbanos-dataset-registry"
TARGETS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "update_targets.json")
CHECKED_BY = "update_monitor (CLI)"
MAX_BODY = 5_000_000
REFUSAL_CODES = (401, 403, 429)


class HostDown(Exception):
    pass


def _http(method: str, url: str, timeout: float = 15.0) -> tuple[int, dict, bytes]:
    """(status, lower-cased headers, body) — HTTP error statuses are returned, not raised; network failures raise."""
    why = non_public_reason(url)
    if why:
        raise ValueError(why)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.build_opener(_PublicRedirects).open(req, timeout=timeout) as r:  # noqa: S310 (public http(s) only)
            body = r.read(MAX_BODY) if method == "GET" else b""
            return r.status, {k.lower(): v for k, v in r.headers.items()}, body
    except urllib.error.HTTPError as e:
        try:
            body = e.read(20_000)
        except Exception:  # noqa: BLE001
            body = b""
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, body


HTTP: Callable[..., tuple[int, dict, bytes]] = _http   # monkeypatched in tests


# ── robots.txt (RFC 9309) ──────────────────────────────────────────────────────────────────────────────────────────
def parse_robots(text: str, token: str = UA_TOKEN) -> tuple[list[tuple[bool, str]], float | None]:
    """Rules (allow?, pattern) and Crawl-delay of the group that applies to `token` (else the '*' group)."""
    groups: list[tuple[list[str], list[tuple[bool, str]], list[float]]] = []
    agents: list[str] = []
    rules: list[tuple[bool, str]] = []
    delay: list[float] = []
    last_was_agent = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        k, v = (x.strip() for x in line.split(":", 1))
        k = k.lower()
        if k == "user-agent":
            if not last_was_agent and agents:
                groups.append((agents, rules, delay))
                agents, rules, delay = [], [], []
            agents.append(v.lower())
            last_was_agent = True
            continue
        last_was_agent = False
        if not agents:
            continue
        if k in ("allow", "disallow"):
            if v:
                rules.append((k == "allow", v))
        elif k == "crawl-delay":
            try:
                delay.append(float(v))
            except ValueError:
                pass
    if agents:
        groups.append((agents, rules, delay))
    mine = [g for g in groups if any(a != "*" and a in token.lower() for a in g[0])]
    chosen = mine or [g for g in groups if "*" in g[0]]
    out_rules = [r for g in chosen for r in g[1]]
    delays = [d for g in chosen for d in g[2]]
    return out_rules, (max(delays) if delays else None)


def _pattern_re(p: str) -> re.Pattern:
    if not p.startswith(("/", "*")):
        p = "*" + p   # non-standard relative rule (e.g. Geofabrik 'Disallow: state.txt'): read conservatively, anywhere
    anchored = p.endswith("$")
    body = re.escape(p[:-1] if anchored else p).replace(r"\*", ".*")
    return re.compile("^" + body + ("$" if anchored else ""))


def robots_allows(rules: list[tuple[bool, str]], url: str) -> bool:
    u = urllib.parse.urlsplit(url)
    path = (u.path or "/") + (("?" + u.query) if u.query else "")
    best: tuple[int, bool] | None = None
    for allow, pat in rules:
        if _pattern_re(pat).match(path) or _pattern_re(pat).match(urllib.parse.unquote(path)):
            cand = (len(pat), allow)
            if best is None or cand[0] > best[0] or (cand[0] == best[0] and allow):
                best = cand
    return True if best is None else best[1]


# ── polite fetcher ──────────────────────────────────────────────────────────────────────────────────────────────────
class Fetcher:
    def __init__(self, host_delays: dict[str, float] | None = None, default_delay: float = 1.0, timeout: float = 15.0,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic):
        self.host_delays = host_delays or {}
        self.default_delay = max(1.0, float(default_delay))
        self.timeout = timeout
        self.sleep, self.clock = sleep, clock
        self.robots: dict[str, tuple[list, float | None, str]] = {}   # origin -> (rules, crawl_delay, note)
        self.down: dict[str, str] = {}
        self.last: dict[str, float] = {}
        self.requests: list[tuple[str, str]] = []

    def delay_for(self, host: str) -> float:
        rd = None
        for origin, (_r, d, _n) in self.robots.items():
            if urllib.parse.urlsplit(origin).hostname == host and d:
                rd = d
        return max(1.0, self.default_delay, float(self.host_delays.get(host, 0.0)), float(rd or 0.0))

    def _raw(self, method: str, url: str) -> tuple[int, dict, bytes]:
        host = urllib.parse.urlsplit(url).hostname or ""
        if host in self.down:
            raise HostDown(self.down[host])
        wait = self.delay_for(host) - (self.clock() - self.last[host]) if host in self.last else 0.0
        if wait > 0:
            self.sleep(wait)
        self.last[host] = self.clock()
        self.requests.append((method, url))
        try:
            return HTTP(method, url, self.timeout)
        except ValueError:
            raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
            self.down[host] = f"host unreachable earlier in this run ({type(e).__name__}: {e})"[:300]
            raise HostDown(self.down[host]) from e

    def _robots(self, url: str) -> tuple[list, float | None, str]:
        u = urllib.parse.urlsplit(url)
        origin = f"{u.scheme}://{u.netloc}"
        if origin not in self.robots:
            status, _h, body = self._raw("GET", origin + "/robots.txt")
            if 200 <= status < 300:
                rules, delay = parse_robots(body.decode("utf-8", "replace"))
                self.robots[origin] = (rules, delay, f"robots.txt: {len(rules)} rule(s), crawl-delay {delay if delay else 'none'}")
            elif 400 <= status < 500:
                self.robots[origin] = ([], None, f"robots.txt HTTP {status}: no rules (RFC 9309)")
            else:
                self.robots[origin] = ([(False, "/")], None, f"robots.txt HTTP {status}: treated as disallow-all (RFC 9309)")
        return self.robots[origin]

    def allowed(self, url: str) -> tuple[bool, str]:
        rules, _d, note = self._robots(url)
        return robots_allows(rules, url), note

    def fetch(self, method: str, url: str) -> tuple[int, dict, bytes]:
        """Robots-checked, rate-limited request. Raises PermissionError (robots), HostDown, ValueError (SSRF)."""
        why = non_public_reason(url)
        if why:
            raise ValueError(why)
        ok, note = self.allowed(url)
        if not ok:
            raise PermissionError(f"robots.txt disallows {urllib.parse.urlsplit(url).path} for automated agents ({note})")
        status, headers, body = self._raw(method, url)
        if status in REFUSAL_CODES:
            host = urllib.parse.urlsplit(url).hostname or ""
            cf = " (Cloudflare challenge)" if ("cf-mitigated" in headers or "cloudflare" in str(headers.get("server", "")).lower()) else ""
            self.down[host] = f"host refused automated access earlier in this run (HTTP {status}{cf}); not retried, not bypassed"
        return status, headers, body


# ── baselines (what was acquired) ──────────────────────────────────────────────────────────────────────────────────
def load_targets(path: str | None = None) -> dict:
    p = path or os.environ.get("URBANOS_UPDATE_TARGETS") or TARGETS_PATH
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"datasets": {}}


def latest_manifest(dataset_id: str, root: str | None = None) -> tuple[dict | None, str | None]:
    base = os.path.join(root or str(paths.raw_dir()), dataset_id)
    cands = sorted(glob.glob(os.path.join(base, "*", "manifest.json")), key=lambda p: paths.version_key(os.path.basename(os.path.dirname(p))))
    for p in reversed(cands):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f), p
        except (OSError, ValueError):
            continue
    return None, None


def _headers_of(entry: dict) -> dict:
    h = entry.get("http_headers") or (entry.get("http") or {}).get("headers") or entry.get("headers") or {}
    return {str(k).lower(): v for k, v in h.items()} if isinstance(h, dict) else {}


def manifest_entry_for(man: dict | None, url: str) -> dict | None:
    for f in (man or {}).get("files") or []:
        if isinstance(f, dict) and f.get("url") == url:
            return f
    return None


def _prior_reference(db: Session, dataset_id: str, url: str) -> DsUpdateCheckEntity | None:
    return (db.query(DsUpdateCheckEntity)
            .filter(DsUpdateCheckEntity.dataset_id == dataset_id, DsUpdateCheckEntity.url == url,
                    DsUpdateCheckEntity.result == "first_seen")
            .order_by(DsUpdateCheckEntity.checked_at.asc()).first())


def _prior_known(row: DsUpdateCheckEntity) -> dict:
    """The comparable fields an earlier check stored in its columns (catalogue_modified carries the method's main value)."""
    k: dict[str, Any] = {"etag": row.etag, "last_modified": row.last_modified, "content_length": row.content_length}
    cm = row.catalogue_modified
    if cm:
        if row.method in ("ckan", "ckan_url"):
            k["metadata_modified"] = cm
        elif row.method == "stac_latest":
            k["latest_datetime"] = cm
        elif row.method == "geofabrik":
            k["data_up_to"] = cm
        elif row.method == "github_release":
            k["tag"] = cm.split(" (", 1)[0]
    return {kk: v for kk, v in k.items() if v not in (None, "")}


# ── comparison ─────────────────────────────────────────────────────────────────────────────────────────────────────
DATE_KEYS = ("last_modified", "metadata_modified", "latest_datetime", "published_at", "data_up_to")
ID_KEYS = ("etag", "content_length", "tag", "sequence", "latest_id")


def compare(seen: dict, known: dict | None) -> tuple[str, str]:
    """(result, explanation). Newer date or a new resource revision -> update_available; identity change without a
    comparable date -> update_available; differs but older/equal date -> changed."""
    if not known:
        return "first_seen", "no acquired reference recorded these fields; recorded as the reference"
    newer, older, diffs = [], [], []
    for k in DATE_KEYS:
        if seen.get(k) and known.get(k):
            a, b = parse_ts(seen[k]), parse_ts(known[k])
            if a is None or b is None:
                if str(seen[k]) != str(known[k]):
                    diffs.append(f"{k} {known[k]} → {seen[k]} (not comparable as dates)")
            elif a > b:
                newer.append(f"{k} {known[k]} → {seen[k]}")
            elif a < b:
                older.append(f"{k} {known[k]} → {seen[k]} (older)")
    for k in ID_KEYS:
        if seen.get(k) and known.get(k) and str(seen[k]).strip('W/"') != str(known[k]).strip('W/"'):
            diffs.append(f"{k} {known[k]} → {seen[k]}")
    res_new, res_gone = [], []
    kr, sr = known.get("resources") or {}, seen.get("resources") or {}
    for rid, lm in kr.items():
        if rid not in sr:
            res_gone.append(rid)
            continue
        a, b = parse_ts(sr[rid]), parse_ts(lm)
        if a and b and a > b:
            res_new.append(f"resource {rid[:8]}… {lm} → {sr[rid]}")
    compared = [k for k in (*DATE_KEYS, *ID_KEYS) if seen.get(k) and known.get(k)] + (["resources"] if kr else [])
    if not compared:
        return "first_seen", "the acquisition recorded none of the fields the publisher returned; recorded as the reference"
    if newer or res_new:
        return "update_available", "; ".join(newer + res_new + diffs)
    if res_gone:
        return "changed", "acquired resource(s) no longer listed upstream: " + ", ".join(r[:8] + "…" for r in res_gone)
    if diffs and not older and not any(seen.get(k) and known.get(k) for k in DATE_KEYS):
        return "update_available", "; ".join(diffs) + " (no date to compare: content identity changed)"
    if diffs or older:
        return "changed", "; ".join(older + diffs) + " — differs, but not demonstrably newer"
    return "unchanged", "publisher metadata matches the acquired version (" + ", ".join(compared) + ")"


# ── probes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def _ok(status: int) -> None:
    if not (200 <= status < 300):
        raise RuntimeError(f"HTTP {status}")


def probe_http_head(f: Fetcher, url: str) -> dict:
    status, h, _ = f.fetch("HEAD", url)
    if status in (405, 501):
        raise RuntimeError(f"HTTP {status}: HEAD not supported; a GET would download the resource — not done")
    _ok(status)
    return {k: v for k, v in {"etag": h.get("etag"), "last_modified": h.get("last-modified"),
                              "content_length": h.get("content-length")}.items() if v}


def probe_ckan(f: Fetcher, api: str, package: str) -> dict:
    url = f"{api.rstrip('/')}/package_show?id={urllib.parse.quote(package)}"
    status, _h, body = f.fetch("GET", url)
    _ok(status)
    doc = json.loads(body.decode("utf-8"))
    if not doc.get("success", True):
        raise RuntimeError("CKAN success=false")
    r = doc.get("result") or {}
    return {"metadata_modified": r.get("metadata_modified"),
            "resources": {x.get("id"): x.get("last_modified") or x.get("metadata_modified") for x in r.get("resources") or [] if x.get("id")}}


def probe_stac_latest(f: Fetcher, api: str, collection: str, bbox: list[float]) -> dict:
    q = urllib.parse.urlencode({"collections": collection, "bbox": ",".join(str(x) for x in bbox), "limit": 1,
                                "sortby": "-properties.datetime"})
    status, _h, body = f.fetch("GET", f"{api.rstrip('/')}/search?{q}")
    _ok(status)
    feats = json.loads(body.decode("utf-8")).get("features") or []
    if not feats:
        raise RuntimeError("STAC search returned no items for the bbox")
    p = feats[0].get("properties") or {}
    return {"latest_datetime": p.get("datetime"), "latest_id": feats[0].get("id"), "cloud_cover": p.get("eo:cloud_cover")}


def probe_github_release(f: Fetcher, repo: str) -> dict:
    status, _h, body = f.fetch("GET", f"https://api.github.com/repos/{repo}/releases/latest")
    _ok(status)
    d = json.loads(body.decode("utf-8"))
    return {"tag": d.get("tag_name"), "published_at": d.get("published_at")}


_GF = re.compile(r"contains all OSM data up to\s+(.+?)(?:\.\s|\.$|\. File|$)", re.S)


def probe_geofabrik(f: Fetcher, page: str, state_url: str | None) -> tuple[dict, str]:
    if state_url:
        ok, _note = f.allowed(state_url)
        if ok:
            status, _h, body = f.fetch("GET", state_url)
            _ok(status)
            kv = dict(line.split("=", 1) for line in body.decode("utf-8", "replace").splitlines() if "=" in line)
            return {"sequence": kv.get("sequenceNumber"), "data_up_to": (kv.get("timestamp") or "").replace("\\:", ":")}, state_url
    status, _h, body = f.fetch("GET", page)
    _ok(status)
    text = re.sub(r"<[^>]+>", " ", body.decode("utf-8", "replace"))
    m = _GF.search(text)
    if not m:
        raise RuntimeError("region page has no 'contains all OSM data up to' statement")
    return {"data_up_to": m.group(1).strip()}, page


# ── per-dataset plan ───────────────────────────────────────────────────────────────────────────────────────────────
def plan(db: Session, targets: dict) -> list[dict]:
    """One item per probe: {dataset_id, method, url, args, baseline, note} or a not_checkable item with its reason."""
    items: list[dict] = []
    tds = targets.get("datasets") or {}
    registered = {d.id: d for d in db.query(DsDatasetEntity).all()}
    for did in sorted(set(tds) | {d for d, e in registered.items() if (_j(e.update_check_json, {}) or {}).get("url")}):
        if did not in registered:
            continue
        t = tds.get(did)
        if t is None:
            uc = _j(registered[did].update_check_json, {}) or {}
            t = {"method": uc.get("method"), "urls": [uc["url"]], "baseline": "manifest"} if uc.get("method") == "http_head" else (
                {"method": "ckan_url", "urls": [uc["url"]], "baseline": "first_check"} if uc.get("method") == "ckan" else {"method": "none", "reason": f"unknown method {uc.get('method')}"})
        m = t.get("method")
        base = {"dataset_id": did, "method": m, "baseline": t.get("baseline", "first_check"), "note": t.get("note", "")}
        if m == "none":
            items.append({**base, "url": None, "reason": t.get("reason", "")})
        elif m in ("http_head", "ckan_url"):
            items += [{**base, "url": u} for u in t.get("urls") or []]
        elif m == "ckan":
            pk = t.get("packages")
            if pk == "from_manifest":
                man, _p = latest_manifest(did)
                pk = sorted({x.get("ckan_dataset") for x in (man or {}).get("files") or [] if isinstance(x, dict) and x.get("ckan_dataset")})
            items += [{**base, "url": f"{t['api'].rstrip('/')}/package_show?id={p}", "api": t["api"], "package": p} for p in pk or []]
        elif m == "stac_latest":
            items.append({**base, "url": f"{t['api'].rstrip('/')}/search?collections={t['collection']}", "api": t["api"],
                          "collection": t["collection"], "bbox": t["bbox"]})
        elif m == "github_release":
            items.append({**base, "url": f"https://api.github.com/repos/{t['repo']}/releases/latest", "repo": t["repo"]})
        elif m == "geofabrik":
            items.append({**base, "url": t["page"], "page": t["page"], "state_url": t.get("state_url")})
        else:
            items.append({**base, "method": "none", "url": None, "reason": f"unknown method {m}"})
    return items


def acquired_reference(db: Session, item: dict) -> tuple[dict | None, str]:
    """What the acquisition recorded for this probe, and where it came from."""
    did, b = item["dataset_id"], item["baseline"]
    if b == "manifest":
        man, mp = latest_manifest(did)
        if item["method"] == "http_head":
            e = manifest_entry_for(man, item["url"])
            h = _headers_of(e) if e else {}
            k = {kk: v for kk, v in {"etag": h.get("etag"), "last_modified": h.get("last-modified"),
                                      "content_length": h.get("content-length")}.items() if v}
            if k:
                return k, f"raw manifest {os.path.relpath(mp, str(paths.data_dir())) if mp else ''}"
        elif item["method"] == "ckan":
            res = {}
            for e in (man or {}).get("files") or []:
                if isinstance(e, dict) and e.get("ckan_dataset") == item["package"]:
                    rid = re.search(r"/resource/([0-9a-f-]{36})/", e.get("url") or "")
                    if rid and e.get("ckan_last_modified_utc"):
                        res[rid.group(1)] = e["ckan_last_modified_utc"] + ("" if str(e["ckan_last_modified_utc"]).endswith("Z") or "+" in str(e["ckan_last_modified_utc"]) else "+00:00")
            if res:
                return {"resources": res}, f"raw manifest {os.path.relpath(mp, str(paths.data_dir())) if mp else ''} (ckan_last_modified_utc per resource)"
        elif item["method"] == "stac_latest":
            dates = []
            for e in (man or {}).get("files") or []:
                mm = re.search(r"_(\d{8})_", str(e.get("file") or e.get("filename") or ""))
                if mm:
                    dates.append(mm.group(1))
            if dates:
                d = max(dates)
                return {"latest_datetime": f"{d[:4]}-{d[4:6]}-{d[6:]}T23:59:59+00:00"}, "newest acquired scene date in the raw manifest (end of that UTC day)"
    elif b == "stored_package_json" and item["method"] == "ckan":
        for p in sorted(glob.glob(os.path.join(str(paths.raw_dir()), did, "*", f"pk_{item['package']}.json")), reverse=True):
            try:
                with open(p, encoding="utf-8") as fh:
                    r = (json.load(fh).get("result") or {})
                return ({"metadata_modified": _utc(r.get("metadata_modified")),
                         "resources": {x["id"]: _utc(x.get("last_modified") or x.get("metadata_modified")) for x in r.get("resources") or [] if x.get("id")}},
                        f"stored package_show {os.path.relpath(p, str(paths.data_dir()))}")
            except (OSError, ValueError, KeyError):
                continue
    elif b == "active_version":
        v = active_version(db, did)
        if v is not None and (v.observation_end or v.source_updated_date):
            return {"data_up_to": v.observation_end or v.source_updated_date}, f"active registry version {v.id} (observation_end)"
    prior = _prior_reference(db, did, item["url"])
    if prior is not None:
        k = _prior_known(prior)
        if k:
            return k, f"first update check {prior.id} ({prior.checked_at.isoformat(timespec='seconds') + 'Z' if prior.checked_at else 'time UNKNOWN'}) — the acquisition recorded no comparable fields"
    return None, "no acquired reference"


def _utc(s):
    """CKAN timestamps are naive UTC: state the zone."""
    if not s:
        return s
    s = str(s)
    return s if (s.endswith("Z") or re.search(r"[+-]\d{2}:?\d{2}$", s)) else s + "+00:00"


def run_item(db: Session, f: Fetcher, item: dict, checked_by: str = CHECKED_BY) -> DsUpdateCheckEntity:
    row = DsUpdateCheckEntity(id=new_id("dsu"), dataset_id=item["dataset_id"], method=item["method"], url=item.get("url"),
                              checked_by=checked_by, result="error", detail="")
    note = (" Note: " + item["note"]) if item.get("note") else ""
    if item["method"] == "none" or not item.get("url"):
        row.method, row.result, row.detail = "none", "not_checkable", (item.get("reason") or "no machine-checkable endpoint") + note
        db.add(row)
        db.flush()
        return row
    try:
        m = item["method"]
        if m == "http_head":
            seen = probe_http_head(f, item["url"])
        elif m == "ckan":
            seen = probe_ckan(f, item["api"], item["package"])
            seen["metadata_modified"] = _utc(seen.get("metadata_modified"))
            seen["resources"] = {k: _utc(v) for k, v in (seen.get("resources") or {}).items()}
        elif m == "ckan_url":
            status, _h, body = f.fetch("GET", item["url"])
            _ok(status)
            seen = {"metadata_modified": _utc(((json.loads(body.decode("utf-8")).get("result")) or {}).get("metadata_modified"))}
        elif m == "stac_latest":
            seen = probe_stac_latest(f, item["api"], item["collection"], item["bbox"])
        elif m == "github_release":
            seen = probe_github_release(f, item["repo"])
        elif m == "geofabrik":
            seen, used = probe_geofabrik(f, item["page"], item.get("state_url"))
            row.url = used
        else:
            raise ValueError(f"unknown method {m}")
    except PermissionError as e:
        row.result, row.detail = "not_checkable", f"{e}.{note}"
        db.add(row)
        db.flush()
        return row
    except Exception as e:  # noqa: BLE001 — offline, refused, malformed: recorded, never raised
        row.result, row.detail = "error", f"{type(e).__name__}: {e}"[:500] + note
        db.add(row)
        db.flush()
        return row
    seen = {k: v for k, v in seen.items() if v not in (None, "", {})}
    row.etag, row.last_modified, row.content_length = seen.get("etag"), seen.get("last_modified"), seen.get("content_length")
    row.catalogue_modified = (seen.get("metadata_modified") or seen.get("latest_datetime") or seen.get("data_up_to")
                              or (f"{seen.get('tag')} ({seen.get('published_at')})" if seen.get("tag") else None))
    known, src = acquired_reference(db, item)
    result, why = compare({k: v for k, v in seen.items() if k != "cloud_cover"}, known)
    row.result = result
    extra = f" Latest scene {seen.get('latest_id')} (cloud {seen.get('cloud_cover')}%)." if m == "stac_latest" else ""
    tail = " Not downloaded: acquire with the pipeline, register with the importer (pending review) and activate explicitly." if result == "update_available" else ""
    nres = f" {len(seen['resources'])} resource(s) listed upstream." if seen.get("resources") else ""
    row.detail = f"{why}. Compared with: {src}.{extra}{nres}{tail}{note}"
    db.add(row)
    db.flush()
    return row


def run(db: Session, only: list[str] | None = None, exclude: list[str] | None = None, targets: dict | None = None,
        fetcher: Fetcher | None = None, checked_by: str = CHECKED_BY) -> dict:
    t = targets if targets is not None else load_targets()
    items = [i for i in plan(db, t) if (not only or i["dataset_id"] in only) and i["dataset_id"] not in (exclude or [])]
    f = fetcher or Fetcher(t.get("_host_min_delay_s"), t.get("_default_min_delay_s", 1.0))
    rows = [run_item(db, f, i, checked_by) for i in items]
    summary: dict[str, int] = {}
    for r in rows:
        summary[r.result] = summary.get(r.result, 0) + 1
    return {"summary": summary, "requests": len(f.requests),
            "rows": [{"dataset_id": r.dataset_id, "method": r.method, "url": r.url, "result": r.result,
                      "detail": r.detail} for r in rows]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Record update checks for every dataset with a machine-checkable upstream (never downloads)")
    ap.add_argument("--only", default="", help="comma-separated dataset ids")
    ap.add_argument("--exclude", default="", help="comma-separated dataset ids")
    ap.add_argument("--plan", action="store_true", help="print the probe plan; no network, nothing recorded")
    ap.add_argument("--dry-run", action="store_true", help="probe but roll back (nothing recorded)")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--json", default=None, help="write the report to this file")
    a = ap.parse_args(argv)
    import main as app_main  # noqa: F401  (creates tables, seeds)
    from database.connection import SessionLocal
    from planning.audit import acting_as
    only = [x for x in a.only.split(",") if x]
    excl = [x for x in a.exclude.split(",") if x]
    t = load_targets()
    with SessionLocal() as db:
        if a.plan:
            items = [i for i in plan(db, t) if (not only or i["dataset_id"] in only) and i["dataset_id"] not in excl]
            print(json.dumps([{k: i.get(k) for k in ("dataset_id", "method", "url", "baseline", "reason")} for i in items], indent=1))
            return 0
        with acting_as(CHECKED_BY):
            rep = run(db, only, excl, t, Fetcher(t.get("_host_min_delay_s"), t.get("_default_min_delay_s", 1.0), a.timeout))
            if a.dry_run:
                db.rollback()
            else:
                db.commit()
    out = json.dumps(rep, indent=1, default=str)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            fh.write(out)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
