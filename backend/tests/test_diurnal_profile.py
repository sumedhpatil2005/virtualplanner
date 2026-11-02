"""Hour-of-day profile: raw Mendeley CSV parsing, the shipped profile file, hour scaling and the API."""

import json
import os

import pytest

from observed.diurnal import profile
from observed.diurnal.build_profile import build
from observed.diurnal.parse_mendeley_pune import hourly_for_file, read_session_file

HEADER = "Time,Direction,car,motorbike,bus,truck\n"


def _rows(t, cum, frames=3):
    """One second of a Mendeley file: `frames` repeated frames for each direction, cumulative counts."""
    out = []
    for _ in range(frames):
        for d in ("UP", "DOWN", "RIGHT", "LEFT"):
            out.append(f"{t},{d},{','.join(str(x) for x in cum[d])}\n")
    return out


def test_parser_takes_last_frame_and_differences_cumulative_counts(tmp_path):
    zero = {d: (0, 0, 0, 0) for d in ("UP", "DOWN", "RIGHT", "LEFT")}
    lines = [HEADER] + _rows("09:59:58", zero) + _rows("09:59:59", zero)
    one = dict(zero, UP=(1, 2, 0, 0))
    lines += _rows("10:00:00", one) + _rows("10:00:01", dict(one, DOWN=(0, 1, 0, 0)))
    lines += [",,,,,\n"]
    f = tmp_path / "a2_11.csv"
    f.write_text("".join(lines))
    secs = list(read_session_file(f))
    assert [t for t, _ in secs] == [35998, 35999, 36000, 36001]
    hourly = hourly_for_file(f)
    # 1 car + 2 motorbikes appear between 09:59:59 and 10:00:00 (credited to hour 9), 1 motorbike after
    assert dict(hourly[9]["veh"]) == {"car": 1, "motorbike": 2, "bus": 0, "truck": 0}
    assert hourly[10]["veh"]["motorbike"] == 1
    assert hourly[9]["cover_s"] == 2 and hourly[10]["cover_s"] == 1


def test_parser_never_credits_resets_or_gaps(tmp_path):
    base = {d: (5, 5, 0, 0) for d in ("UP", "DOWN", "RIGHT", "LEFT")}
    zero = {d: (0, 0, 0, 0) for d in ("UP", "DOWN", "RIGHT", "LEFT")}
    lines = [HEADER] + _rows("09:00:00", base) + _rows("09:00:01", zero)  # counter reset: not negative flow
    lines += _rows("09:10:00", base)  # 10-minute gap: no coverage, no flow
    f = tmp_path / "r1_12.csv"
    f.write_text("".join(lines))
    h = hourly_for_file(f)
    assert sum(h[9]["veh"].values()) == 0 and h[9]["cover_s"] == 0


@pytest.fixture(scope="module")
def doc():
    return profile.load()


def test_shipped_profile_is_valid_cited_and_honest_about_coverage(doc):
    assert profile.validate(doc) == []
    ids = {s["id"] for s in doc["sources"]}
    assert {"gunjan2017", "mendeley2026", "tomtom2025", "cmp2018"} <= ids
    wd = doc["weekday"]
    # Measured hours are exactly those with real hourly volume (Gunjan 08-19); the rest say they are filled
    assert wd["measured_hours"] == list(range(8, 20))
    assert all(not h["measured"] and h["source"].split(":")[0] in ("filled", "interpolated") for h in wd["hours"] if h["hour"] not in range(8, 20))
    assert all(not h["measured"] for h in doc["weekend"]["hours"])
    # The Mendeley footage only covers 09-11
    assert set(doc["mendeley_coverage"]["by_hour"]["weekday"]) == {"9", "10", "11"}


def test_profile_shape_matches_pune_expectations(doc):
    hours = {h["hour"]: h for h in doc["weekday"]["hours"]}
    assert hours[3]["period"] == "Low" and hours[0]["period"] == "Low"
    assert hours[9]["period"] == "Peak" and hours[19]["period"] == "Peak"
    assert hours[15]["period"] == "Moderate"
    # Peak-hour share is pinned to the Pune CMP 2018 inner-cordon average (7.8%)
    assert doc["weekday"]["peak_hour_share"] == pytest.approx(0.078, abs=0.002)


def test_hour_factor_scales_from_the_count_hour(doc):
    assert profile.hour_factor(doc, 19, 19) == pytest.approx(1.0)
    f3 = profile.hour_factor(doc, 3, 19)
    assert 0 < f3 < 0.2
    assert profile.hour_factor(doc, 9, 19) == pytest.approx(doc["weekday"]["hours"][9]["share"] / doc["weekday"]["hours"][19]["share"])


def test_profile_rebuilds_from_the_aggregated_mendeley_records(doc):
    path = os.path.join(profile.DATA_DIR, "mendeley_pune_2023_hourly.json")
    with open(path, encoding="utf-8") as f:
        records = json.load(f)["records"]
    rebuilt = build(records)
    assert [h["share"] for h in rebuilt["weekday"]["hours"]] == [h["share"] for h in doc["weekday"]["hours"]]


def test_profile_api(client):
    r = client.get("/api/diurnal-profile/pune_hourly_profile_v1")
    assert r.status_code == 200 and r.json()["version"] == 1
    assert client.get("/api/diurnal-profile/nope").status_code == 404
