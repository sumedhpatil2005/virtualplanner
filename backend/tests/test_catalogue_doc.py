"""datasets.catalogue_doc: the generated catalogue lists every registered source and dataset, prints UNKNOWN for missing
values and never invents a licence. Registry rows here are the app seeds plus one SYNTHETIC dataset."""
import uuid


def test_catalogue_lists_everything_and_marks_unknowns(client):  # noqa: ARG001 — client seeds the registry
    from database.connection import SessionLocal
    from datasets import catalogue_doc as C
    from datasets.models import DsDatasetEntity, DsSourceEntity
    from datasets.registry import add_version, ensure_dataset
    with SessionLocal() as db:
        did = f"t_cat_{uuid.uuid4().hex[:8]}"
        ensure_dataset(db, did, title="SYNTHETIC catalogue entry", theme="other", origin="seed")
        add_version(db, did, version_label="v1", data_class="synthetic", suitability="visualisation", sha256="ab" * 32)
        db.flush()
        text = C.build(db)
        ids = [d.id for d in db.query(DsDatasetEntity).all()]
        srcs = [s.id for s in db.query(DsSourceEntity).all()]
        db.rollback()
    for i in ids:
        assert f"#### `{i}`" in text
    for s in srcs:
        assert f"| `{s}` |" in text
    block = text.split(f"#### `{did}`", 1)[1].split("####", 1)[0]
    assert "**Licence (verbatim as recorded):** UNKNOWN" in block and "**CRS:** UNKNOWN" in block
    assert "abababababab…" in block and "**Data class:** synthetic" in block and "never checked" in block
    # the OSM seed is used by features and points to its narrative catalogue
    osm = text.split("#### `osm_geofabrik_western_zone`", 1)[1].split("####", 1)[0]
    assert "ODbL" in osm and "Features using it:" in osm
