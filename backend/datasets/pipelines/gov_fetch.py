"""Fetch a list of public URLs into the raw store with a manifest (rate limited, resumable).

  python -m datasets.pipelines.gov_fetch --source-id bhuvan_ogc_capabilities \
      --licence "..." --licence-url URL  name1=URL1 name2=URL2 ...
Existing files are skipped; the manifest is updated after every file.
"""
from __future__ import annotations

import argparse

from . import gov_common as gc


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--source-id", required=True)
    p.add_argument("--raw-date")
    p.add_argument("--publisher", default="")
    p.add_argument("--licence", default="UNKNOWN")
    p.add_argument("--licence-url")
    p.add_argument("--notes", default="")
    p.add_argument("--timeout", type=int, default=180)
    p.add_argument("--min-interval", type=float, default=gc.MIN_REQUEST_INTERVAL_S, help="seconds between requests (honour robots Crawl-Delay)")
    p.add_argument("items", nargs="+", help="name=url")
    a = p.parse_args(argv)
    gc.MIN_REQUEST_INTERVAL_S = max(a.min_interval, 1.0)
    rd = gc.raw_dir(a.source_id, a.raw_date)
    src = {"source_id": a.source_id, "publisher": a.publisher}
    for item in a.items:
        name, url = item.split("=", 1)
        dest = rd / name
        if dest.exists():
            continue
        try:
            h = gc.http_download(url, dest, timeout=a.timeout)
        except Exception as e:  # record failures too
            print(name, "FAIL", repr(e)[:200], flush=True)
            continue
        gc.write_manifest(rd, src, [gc.manifest_entry(dest, url, http=h, licence=a.licence,
                                                      licence_url=a.licence_url, notes=a.notes)])
        print(name, "OK", dest.stat().st_size, flush=True)


if __name__ == "__main__":
    main()
