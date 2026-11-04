"""Screen-line count files: the shipped file validates and keeps the printed values."""
import copy

from observed import screenlines


def test_shipped_file_is_valid_and_as_printed():
    doc = screenlines.load("pune_cmp2008_river")
    by = {s["id"]: s for s in doc["stations"]}
    # PMC CMP 2008, peak hour (annexure Table 8) and 12-hour totals (Table 4.1)
    assert by["shivaji"]["peakVehicles"] == 7470 and by["shivaji"]["peakPcu"] == 8131 and by["shivaji"]["day12hVehicles"] == 61385
    assert by["shivaji"]["osmWays"] == [22841323]
    assert by["dengale"]["comparable"] is False
    assert doc["source"]["surveyYear"] == 2008


def test_validation_rejects_bad_values():
    doc = screenlines.load("pune_cmp2008_river")
    bad = copy.deepcopy(doc)
    bad["stations"][0]["peakVehicles"] = -1
    bad["stations"][1]["osmWays"] = []
    problems = screenlines.validate(bad)
    assert any("peakVehicles" in p for p in problems)
    assert any("osmWays" in p for p in problems)
