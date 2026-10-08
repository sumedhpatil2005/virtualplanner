import json
import sqlite3

import pytest

from repair_road_sections import repair_database, restore_database, repair_properties, normalize_sections


def section(start, end, lanes=1):
    return {"startNodeIndex": start, "endNodeIndex": end, "carriagewayA": {"lanes": lanes},
            "reservedSpaces": [{"width": lanes}], "provenance": {"geometryModified": False}}


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "repair.db"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE city_objects (id TEXT PRIMARY KEY, type TEXT, scenario_id TEXT, geometry_geojson TEXT, properties_json TEXT, updated_at TEXT)")
        for identity in ["a", "b"]:
            connection.execute("INSERT INTO city_objects VALUES (?, 'road', 'base', ?, ?, 'original timestamp')", (
                identity, json.dumps([[x, 0, 0] for x in range(6)]), json.dumps({"sections": [section(0, 2)], "sourceCoordinates": [[0, 0, 0], [5, 0, 0]], "notes": "keep this"})))
    return path


def rows(database):
    with sqlite3.connect(database) as connection:
        return connection.execute("SELECT * FROM city_objects ORDER BY id").fetchall()


def test_dry_run_never_changes_rows_or_creates_backup(database, tmp_path):
    original = rows(database)
    backup = tmp_path / "backup.json"
    result = repair_database(database, backup=backup)
    assert result["changed"] == 2
    assert result["mode"] == "dry-run"
    assert rows(database) == original
    assert not backup.exists()


def test_apply_backups_exact_originals_is_idempotent_and_restores(database, tmp_path):
    original = rows(database)
    backup = tmp_path / "backup.json"
    assert repair_database(database, apply=True, backup=backup)["changed"] == 2
    repaired = rows(database)
    assert repaired != original
    assert repaired[0][3] == original[0][3]  # Geometry untouched
    assert repaired[0][5] == original[0][5]  # Timestamp untouched
    assert json.loads(repaired[0][4])["sourceCoordinates"] == json.loads(original[0][4])["sourceCoordinates"]
    assert repair_database(database, apply=True, backup=backup)["changed"] == 0
    assert restore_database(database, backup)["restored"] == 2
    assert rows(database) == original
    assert restore_database(database, backup)["restored"] == 0


def test_apply_requires_backup_and_refuses_to_overwrite_one(database, tmp_path):
    original = rows(database)
    with pytest.raises(ValueError, match="requires"):
        repair_database(database, apply=True)
    backup = tmp_path / "backup.json"
    backup.write_text("existing backup")
    with pytest.raises(FileExistsError):
        repair_database(database, apply=True, backup=backup)
    assert rows(database) == original


def test_restore_does_not_overwrite_subsequent_edits_and_rolls_back_all_rows(database, tmp_path):
    backup = tmp_path / "backup.json"
    repair_database(database, apply=True, backup=backup)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE city_objects SET properties_json = '{}' WHERE id = 'b'")
    edited = rows(database)
    with pytest.raises(ValueError, match="edited after repair"):
        restore_database(database, backup)
    assert rows(database) == edited


def test_source_mapping_recovers_profiles_and_all_other_properties():
    coordinates = [[x, 0, 6.5] for x in range(11)]
    properties = {"sections": [section(0, 1), section(1, 2, 3)], "sourceCoordinates": [[0, 0, 0], [4, 0, 0], [10, 0, 0]], "notes": "keep"}
    repaired = repair_properties(coordinates, properties)
    assert [(s["startNodeIndex"], s["endNodeIndex"]) for s in repaired["sections"]] == [(0, 4), (4, 10)]
    assert repaired["sections"][1]["carriagewayA"]["lanes"] == 3
    assert repaired["notes"] == "keep"
    assert repaired["sourceCoordinates"] == properties["sourceCoordinates"]
    assert properties["sections"][0]["endNodeIndex"] == 1
    assert repair_properties(coordinates, repaired) is None


def test_legacy_gaps_fill_adjacent_profiles_and_clip_overlaps():
    profiles = [section(2, 3), section(6, 8, 3)]
    fixed = normalize_sections(profiles, 11)
    assert [(s["startNodeIndex"], s["endNodeIndex"]) for s in fixed] == [(0, 6), (6, 10)]
    assert fixed[1]["carriagewayA"] == profiles[1]["carriagewayA"]
    assert normalize_sections(fixed, 11) == fixed
    assert [(s["startNodeIndex"], s["endNodeIndex"]) for s in normalize_sections([section(0, 6), section(3, 8, 2)], 9)] == [(0, 3), (3, 8)]
