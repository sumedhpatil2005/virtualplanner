"""URBANOS_DATA_DIR is canonical; URBANOS_DATA_ROOT / URBANOS_DATA_HOME are aliases; one helper for all callers."""
from pathlib import Path

import pytest

from datasets import paths, vocab
from datasets.pipelines import gov_common

ENVS = ("URBANOS_DATA_DIR", "URBANOS_DATA_ROOT", "URBANOS_DATA_HOME", "URBANOS_RAW_DIR", "URBANOS_DERIVED_DIR")


@pytest.fixture()
def clean_env(monkeypatch):
    for e in ENVS:
        monkeypatch.delenv(e, raising=False)
    return monkeypatch


def test_canonical_wins_over_aliases(clean_env, tmp_path):
    clean_env.setenv("URBANOS_DATA_ROOT", str(tmp_path / "root"))
    clean_env.setenv("URBANOS_DATA_HOME", str(tmp_path / "home"))
    clean_env.setenv("URBANOS_DATA_DIR", str(tmp_path / "canon"))
    assert paths.data_dir_info() == {"path": tmp_path / "canon", "source": "URBANOS_DATA_DIR"}
    assert vocab.data_root() == str(tmp_path / "canon")
    assert gov_common.data_home() == tmp_path / "canon"
    assert gov_common.raw_root() == tmp_path / "canon" / "raw"
    assert gov_common.derived_root() == tmp_path / "canon" / "derived"


@pytest.mark.parametrize("alias", ["URBANOS_DATA_ROOT", "URBANOS_DATA_HOME"])
def test_aliases_still_work(clean_env, tmp_path, alias):
    clean_env.setenv(alias, str(tmp_path))
    assert paths.data_dir() == tmp_path and paths.data_dir_info()["source"] == alias
    assert vocab.data_root() == str(tmp_path)


def test_sub_root_overrides(clean_env, tmp_path):
    clean_env.setenv("URBANOS_DATA_DIR", str(tmp_path))
    clean_env.setenv("URBANOS_DERIVED_DIR", str(tmp_path / "elsewhere"))
    assert paths.raw_dir() == tmp_path / "raw"
    assert paths.derived_dir() == tmp_path / "elsewhere"


def test_default_sandbox_then_repo(clean_env, tmp_path):
    clean_env.setattr(paths, "SANDBOX_DEFAULT", tmp_path / "missing")
    assert paths.data_dir_info() == {"path": paths.REPO_DEFAULT, "source": "repo_default"}
    assert paths.REPO_DEFAULT == Path(paths.__file__).resolve().parents[1] / "data" / "urbanos"
    clean_env.setattr(paths, "SANDBOX_DEFAULT", tmp_path)
    assert paths.data_dir_info() == {"path": tmp_path, "source": "sandbox_default"}


def test_derived_versions(clean_env, tmp_path):
    clean_env.setenv("URBANOS_DATA_DIR", str(tmp_path))
    for v, with_proc in (("v1", True), ("v2", True), ("tmp", False)):
        d = tmp_path / "derived" / "x" / v
        d.mkdir(parents=True)
        if with_proc:
            (d / "processing.json").write_text("{}")
    assert [p.name for p in paths.derived_versions("x")] == ["v1", "v2"]
    assert paths.derived_version_dir("x").name == "v2"
    assert paths.derived_version_dir("x", "v1").name == "v1"
    assert paths.derived_version_dir("x", "nope") is None
    assert paths.derived_versions("absent") == []
