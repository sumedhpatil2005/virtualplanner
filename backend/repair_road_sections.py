"""Recover road profile ranges without changing geometry or source data.

Dry run (default): python repair_road_sections.py --database /absolute/twincity.db
Apply after review: add --apply --backup /absolute/road-sections-backup.json
Restore: --database /absolute/twincity.db --restore /absolute/road-sections-backup.json

This standalone tool targets SQLite. It never loads the app or its configured
database, and requires an explicit database path. The backup contains exact
original and repaired property strings for every affected row. Restoration
refuses to overwrite roads edited after the repair. Both writes are atomic.
"""

import argparse
import copy
import datetime
import json
import math
import os
from pathlib import Path
import sqlite3


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def complete_coverage(sections, vertex_count):
    if not sections:
        return False
    end = 0
    for section in sections:
        start, next_end = section.get("startNodeIndex"), section.get("endNodeIndex")
        if not _number(start) or not _number(next_end) or int(start) != start or int(next_end) != next_end:
            return False
        if start != end or next_end < end or (vertex_count > 1 and next_end == end):
            return False
        end = next_end
    return end == max(0, vertex_count - 1)


def normalize_sections(sections, vertex_count):
    """Matches frontend roadSections.ts: next profile starts own its segments."""
    if complete_coverage(sections, vertex_count):
        return sections
    last = max(0, vertex_count - 1)
    candidates = []
    for section in sections:
        start, end = section.get("startNodeIndex"), section.get("endNodeIndex")
        if _number(start) and _number(end) and end >= start and (last == 0 or start < last):
            candidates.append({**section, "startNodeIndex": max(0, math.floor(start))})
    candidates.sort(key=lambda section: section["startNodeIndex"])
    unique = []
    for section in candidates:
        if unique and unique[-1]["startNodeIndex"] == section["startNodeIndex"]:
            unique[-1] = section
        else:
            unique.append(section)
    return [
        {**section, "startNodeIndex": 0 if index == 0 else section["startNodeIndex"],
         "endNodeIndex": unique[index + 1]["startNodeIndex"] if index + 1 < len(unique) else last}
        for index, section in enumerate(unique)
    ]


def retained_indices(before, after):
    result, cursor = [], 0
    for point in before:
        while cursor < len(after) and point[:2] != after[cursor][:2]:
            cursor += 1
        if cursor == len(after):
            return None
        result.append(cursor)
        cursor += 1
    return result


def repair_properties(coordinates, properties):
    """Return repaired properties, or None when unchanged/unsafe to infer."""
    sections = properties.get("sections")
    if not isinstance(sections, list) or not sections or not all(isinstance(section, dict) for section in sections):
        return None
    if complete_coverage(sections, len(coordinates)):
        return None
    source = properties.get("sourceCoordinates")
    indices = None
    if (isinstance(source, list) and source and complete_coverage(sections, len(source))
            and not any(section.get("provenance", {}).get("geometryModified") for section in sections)):
        indices = retained_indices(source, coordinates)
    if indices is not None:
        fixed = normalize_sections([
            {**section, "startNodeIndex": indices[int(section["startNodeIndex"])],
             "endNodeIndex": indices[int(section["endNodeIndex"])]}
            for section in sections
        ], len(coordinates))
    else:
        fixed = normalize_sections(sections, len(coordinates))
    # Empty/invalid profiles require app-level synthesis; do not invent them.
    if not fixed:
        return None
    return {**copy.deepcopy(properties), "sections": fixed}


def _connect(database, *, write=False):
    path = Path(database).resolve(strict=True)
    connection = sqlite3.connect(path.as_uri() + ("?mode=rw" if write else "?mode=ro"), uri=True)
    connection.row_factory = sqlite3.Row
    return path, connection


def _plan(connection):
    changes, skipped = [], []
    for row in connection.execute("SELECT id, scenario_id, geometry_geojson, properties_json FROM city_objects WHERE type = 'road' ORDER BY id"):
        try:
            coordinates = json.loads(row["geometry_geojson"])
            properties = json.loads(row["properties_json"])
            if not isinstance(coordinates, list) or len(coordinates) < 2 or not isinstance(properties, dict):
                raise ValueError("Road has no valid line geometry/properties")
            if not all(isinstance(point, list) and len(point) >= 2 and all(_number(value) for value in point[:2]) for point in coordinates):
                raise ValueError("Road coordinates are invalid")
            fixed = repair_properties(coordinates, properties)
            if fixed is not None:
                changes.append({**dict(row), "repaired_properties_json": json.dumps(fixed, separators=(",", ":"), ensure_ascii=False)})
            elif not complete_coverage(properties.get("sections") or [], len(coordinates)):
                skipped.append(row["id"])
        except (TypeError, ValueError, KeyError, IndexError, AttributeError):
            skipped.append(row["id"])
    return changes, skipped


def repair_database(database, *, apply=False, backup=None):
    if apply and not backup:
        raise ValueError("--apply requires --backup")
    path, connection = _connect(database, write=apply)
    try:
        connection.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
        changes, skipped = _plan(connection)
        if apply and changes:
            payload = {"format": "virtualplanner-road-sections-v1", "database": str(path),
                       "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "rows": changes}
            # Exclusive creation prevents accidental overwrite of recovery data.
            with open(backup, "x", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            for row in changes:
                connection.execute("UPDATE city_objects SET properties_json = ? WHERE id = ?", (row["repaired_properties_json"], row["id"]))
            connection.commit()
        else:
            connection.rollback()
        return {"mode": "apply" if apply else "dry-run", "changed": len(changes), "ids": [row["id"] for row in changes], "skipped": skipped}
    finally:
        connection.close()


def restore_database(database, backup):
    path, connection = _connect(database, write=True)
    try:
        payload = json.loads(Path(backup).read_text(encoding="utf-8"))
        if payload.get("format") != "virtualplanner-road-sections-v1" or Path(payload["database"]).resolve() != path:
            raise ValueError("Backup format/database does not match")
        connection.execute("BEGIN IMMEDIATE")
        restored = 0
        for saved in payload["rows"]:
            row = connection.execute("SELECT type, scenario_id, geometry_geojson, properties_json FROM city_objects WHERE id = ?", (saved["id"],)).fetchone()
            if row is None or row["type"] != "road" or row["scenario_id"] != saved["scenario_id"] or row["geometry_geojson"] != saved["geometry_geojson"]:
                raise ValueError(f"Road {saved['id']} was removed or changed; restore aborted")
            if row["properties_json"] == saved["properties_json"]:
                continue
            if row["properties_json"] != saved["repaired_properties_json"]:
                raise ValueError(f"Road {saved['id']} was edited after repair; restore aborted")
            connection.execute("UPDATE city_objects SET properties_json = ? WHERE id = ?", (saved["properties_json"], saved["id"]))
            restored += 1
        connection.commit()
        return {"mode": "restore", "restored": restored}
    finally:
        # Closing rolls back any failed restoration, including earlier rows.
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", required=True, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--restore", type=Path)
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    try:
        result = restore_database(args.database, args.restore) if args.restore else repair_database(args.database, apply=args.apply, backup=args.backup)
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"Repair failed: {error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
