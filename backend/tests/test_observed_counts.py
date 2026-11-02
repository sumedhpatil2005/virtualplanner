"""Observed count files: parsing, validation, derived totals and the API."""

import copy
import json
import os

import pytest

from observed import counts

FILE = os.path.join(counts.DATA_DIR, "pune_west_2026.json")


@pytest.fixture()
def raw():
    with open(FILE, encoding="utf-8") as f:
        return json.load(f)


def test_shipped_file_is_valid_and_cited(raw):
    assert counts.validate(raw) == []
    assert raw["data_source_type"] == "observed"
    dois = {s["doi"] for s in raw["sources"]}
    assert {"10.17492/jpi/nicmar/2507129", "10.5281/zenodo.21712996"} <= dois
    # What the sources do not say is recorded as missing, not filled in
    assert raw["survey"]["date"] is None and raw["survey"]["peak_hour_clock"] is None
    assert {m["field"] for m in raw["missing"]} >= {"survey.date", "survey.peak_hour_clock"}


def test_six_junctions_twelve_movements_each(raw):
    assert [j["id"] for j in raw["junctions"]] == [
        "kokane_chowk", "panchratna_chowk", "kasturi_chowk", "ganraj_chowk", "sakharam_waghmare_chowk", "infosys_circle_phase_1"]
    for j in raw["junctions"]:
        keys = {(m["approach"], m["turn"]) for m in j["movements"]}
        assert keys == {(a, t) for a in counts.APPROACHES for t in counts.TURNS}


def test_totals_match_the_published_peak_hour_volumes(raw):
    doc = counts.enrich(raw)
    by_id = {j["id"]: j for j in doc["junctions"]}
    # Table I of Kureshi et al. 2026 / Tables 1-6 of the NICMAR chapter
    for jid, total in [("kokane_chowk", 4426), ("panchratna_chowk", 6315), ("ganraj_chowk", 8296),
                       ("sakharam_waghmare_chowk", 3974), ("infosys_circle_phase_1", 4243)]:
        assert by_id[jid]["totals"]["veh"] == total
        assert by_id[jid]["totals"]["matches_published_total"]
    # Kasturi's printed table does not add up; rows are kept as printed and flagged
    k = by_id["kasturi_chowk"]
    assert k["totals"]["veh"] == 6200 and k["published_total_veh"] == 6190
    assert not k["totals"]["matches_published_total"]
    assert any("inconsistent" in n for n in k["notes"])
    # Ganraj east approach: 2,523 veh/h in the text of Kureshi et al.
    assert by_id["ganraj_chowk"]["totals"]["by_approach"]["E"]["veh"] == 2523


def test_pcu_uses_the_factors_the_file_states(raw):
    m = {"approach": "N", "turn": "right", "LV": 115, "HV": 10, "TW": 200}
    veh, pcu = counts.movement_totals(m, raw["pcu"]["factors"])
    assert veh == 325
    assert pcu == pytest.approx(115 * 1.0 + 10 * 2.2 + 200 * 0.75)
    first = counts.enrich(raw)["junctions"][0]["movements"][0]
    assert (first["approach"], first["turn"], first["veh"]) == ("N", "right", 325)


def test_missing_class_is_not_zero_filled(raw):
    veh, pcu = counts.movement_totals({"LV": 10, "TW": 4}, raw["pcu"]["factors"])
    assert (veh, pcu) == (14, 13.0)


@pytest.mark.parametrize("mutate, message", [
    (lambda d: d["junctions"][0]["movements"][0].__setitem__("LV", -3), "non-negative integer"),
    (lambda d: d["junctions"][0]["movements"][0].__setitem__("TW", 12.5), "non-negative integer"),
    (lambda d: d["junctions"][0]["movements"][1].__setitem__("turn", "right"), "duplicate movement"),
    (lambda d: d["junctions"][0]["movements"][0].__setitem__("approach", "NE"), "bad movement key"),
    (lambda d: d["junctions"][0]["location"].pop("lat"), "location needs lon/lat"),
    (lambda d: d["sources"][0].pop("doi") and d["sources"][0].pop("url"), "citation"),
    (lambda d: d["pcu"]["factors"].__setitem__("HV", 0), "pcu.factors.HV"),
    (lambda d: d.__setitem__("data_source_type", "estimated"), "data_source_type"),
    (lambda d: d.__setitem__("schema", "other"), "schema"),
])
def test_invalid_files_are_rejected(raw, mutate, message):
    bad = copy.deepcopy(raw)
    mutate(bad)
    problems = counts.validate(bad)
    assert any(message in p for p in problems), problems


def test_load_raises_with_all_problems(tmp_path, raw):
    bad = copy.deepcopy(raw)
    bad["junctions"][0]["movements"][0]["LV"] = "many"
    bad["junctions"][1]["movements"][0]["HV"] = -1
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(bad))
    with pytest.raises(counts.CountFileError) as e:
        counts.load(str(path))
    assert len(e.value.problems) == 2
    listing = counts.list_datasets(str(tmp_path))
    assert listing == [{"file": "bad.json", "valid": False, "error": str(e.value)}]


def test_api_lists_and_serves_the_dataset(client):
    r = client.get("/api/observed-counts")
    assert r.status_code == 200
    ds = [d for d in r.json()["datasets"] if d.get("dataset_id") == "pune_west_2026"]
    assert ds and ds[0]["valid"] and ds[0]["junctions"] == 6
    r = client.get("/api/observed-counts/pune_west_2026")
    assert r.status_code == 200
    body = r.json()
    assert body["junctions"][3]["totals"]["veh"] == 8296
    assert client.get("/api/observed-counts/nope").status_code == 404
