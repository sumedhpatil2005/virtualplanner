"""
Update checks (docs/urbanos/DATA_INGESTION_ARCHITECTURE.md §6). Read-only probes of the publisher:

- `http_head`: HEAD request; compares ETag / Last-Modified / Content-Length with what the active version recorded.
- `ckan`: GET a CKAN `package_show` URL; compares `metadata_modified`.

A change registers a NEW version with origin `update_check`, review status `pending_review`, no files and no sha256
(nothing is downloaded by a check). The active version is never replaced; a reviewer acquires and activates.
Network access goes through `HTTP` (monkeypatched in tests). One request per check; identifies itself; honours no
redirects to login pages (any non-2xx is an error, recorded).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from sqlalchemy.orm import Session

from .models import DsDatasetEntity, DsUpdateCheckEntity
from .registry import _j, active_version, add_version, new_id, versions_of

UA = "UrbanOS-dataset-registry/1.0 (update check; one request per manual check)"


def non_public_reason(url: str) -> str | None:
    """None when `url` is http(s) to a host that resolves only to public addresses; else why not (SSRF guard for the
    server-side probe: no loopback / private / link-local / reserved targets, no other schemes)."""
    import ipaddress
    import socket
    from urllib.parse import urlparse
    u = urlparse(str(url))
    if u.scheme not in ("http", "https") or not u.hostname:
        return "update_check.url must be an http(s) URL"
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(u.hostname, None)}
    except OSError:
        return None  # unresolvable now: the probe fails and is recorded as an error
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return f"update_check.url resolves to a non-public address ({ip})"
    return None


class _PublicRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        why = non_public_reason(newurl)
        if why:
            raise urllib.error.URLError(f"redirect refused: {why}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _http(method: str, url: str, timeout: float = 15.0) -> tuple[int, dict, bytes]:
    why = non_public_reason(url)
    if why:
        raise ValueError(why)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    with urllib.request.build_opener(_PublicRedirects).open(req, timeout=timeout) as r:  # noqa: S310 (public http(s) only)
        body = r.read(2_000_000) if method == "GET" else b""
        return r.status, {k.lower(): v for k, v in r.headers.items()}, body


HTTP = _http


def check(db: Session, dataset_id: str, checked_by: str = "system") -> DsUpdateCheckEntity:
    d = db.get(DsDatasetEntity, dataset_id)
    if d is None:
        raise KeyError(dataset_id)
    cfg = _j(d.update_check_json, {}) or {}
    method, url = cfg.get("method"), cfg.get("url")
    row = DsUpdateCheckEntity(id=new_id("dsu"), dataset_id=d.id, method=method or "none", url=url, checked_by=checked_by,
                              result="not_checkable", detail="")
    if not method or not url:
        row.detail = "no machine-checkable update endpoint recorded for this dataset (manual / RTI / streamed source)"
        db.add(row)
        db.flush()
        return row
    try:
        if method == "http_head":
            status, headers, _ = HTTP("HEAD", url)
            row.etag, row.last_modified, row.content_length = headers.get("etag"), headers.get("last-modified"), headers.get("content-length")
        elif method == "ckan":
            status, headers, body = HTTP("GET", url)
            doc = json.loads(body.decode("utf-8"))
            row.catalogue_modified = (doc.get("result") or {}).get("metadata_modified")
        else:
            raise ValueError(f"unknown method {method}")
        if not (200 <= status < 300):
            raise RuntimeError(f"HTTP {status}")
    except Exception as e:  # noqa: BLE001
        row.result, row.detail = "error", f"{type(e).__name__}: {e}"[:400]
        db.add(row)
        db.flush()
        return row

    act = active_version(db, d.id)
    seen = {"etag": row.etag, "last_modified": row.last_modified, "content_length": row.content_length,
            "catalogue_modified": row.catalogue_modified}
    seen = {k: v for k, v in seen.items() if v}
    if not seen:
        row.result, row.detail = "error", "the response carried no ETag, Last-Modified, Content-Length or metadata_modified"
        db.add(row)
        db.flush()
        return row
    # compare with the newest version of any status that recorded headers (a pending announcement is not re-registered)
    known = None
    for v in reversed(versions_of(db, d.id)):
        h = _j(v.http_json, {}) or {}
        if any(h.get(k) for k in seen):
            known = h
            break
    if known is None:
        prev = (db.query(DsUpdateCheckEntity).filter(DsUpdateCheckEntity.dataset_id == d.id,
                                                    DsUpdateCheckEntity.result.in_(("first_seen", "unchanged")))
                .order_by(DsUpdateCheckEntity.checked_at.desc()).first())
        if prev is not None:
            known = {"etag": prev.etag, "last_modified": prev.last_modified, "content_length": prev.content_length,
                     "catalogue_modified": prev.catalogue_modified}
    if known is None:
        row.result = "first_seen"
        row.detail = ("no version recorded these headers before; recorded as the reference. "
                      + ("Active version exists — headers cannot be compared with it." if act else "No active version."))
    else:
        diff = [k for k, v in seen.items() if known.get(k) and str(known.get(k)) != str(v)]
        if not diff:
            row.result, row.detail = "unchanged", "publisher metadata matches the last recorded version"
        else:
            row.result = "changed"
            row.detail = "changed: " + ", ".join(f"{k} {known.get(k)} → {seen[k]}" for k in diff)
            nv = add_version(db, d.id, activate_if_first=False, version_label=f"announced {seen.get('last_modified') or seen.get('catalogue_modified') or seen.get('etag')}",
                             source_updated_date=seen.get("last_modified") or seen.get("catalogue_modified"),
                             retrieved_at=None, sha256=None, licence_text=act.licence_text if act else "UNKNOWN",
                             licence_url=act.licence_url if act else "", http_json={**seen, "url": url},
                             data_class=None, suitability=None, origin="update_check",
                             notes="Announced by the publisher's metadata; NOT downloaded. Acquire, register and review before use.")
            row.new_version_id = nv.id
    db.add(row)
    db.flush()
    return row
