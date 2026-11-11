"""
Additive, idempotent schema migrations run at startup (docs/SCENARIOS_AND_VERSIONING.md §Migration).

`Base.metadata.create_all` creates missing tables but never adds columns to an existing table, so columns added to
`scenarios` are added here with ALTER TABLE ... ADD COLUMN (nullable, no default rewrite). Nothing is dropped,
renamed or rewritten: existing scenarios and city_objects rows keep every value. Existing proposal objects are the
proposal's 'add' changes, exactly as before.
"""
from sqlalchemy import inspect, text

SCENARIO_COLUMNS = {
    "kind": "VARCHAR",
    "baseline_id": "VARCHAR",
    "parent_scenario_id": "VARCHAR",
    "created_at": "DATETIME",
}


def migrate(engine) -> list[str]:
    """Adds missing columns; returns the statements run (empty when the schema is current)."""
    done: list[str] = []
    insp = inspect(engine)
    if "scenarios" not in insp.get_table_names():
        return done
    have = {c["name"] for c in insp.get_columns("scenarios")}
    with engine.begin() as conn:
        for name, sql_type in SCENARIO_COLUMNS.items():
            if name not in have:
                stmt = f"ALTER TABLE scenarios ADD COLUMN {name} {sql_type}"
                conn.execute(text(stmt))
                done.append(stmt)
        # The base row is the baseline; legacy proposals are proposals on it (values only fill NULLs)
        conn.execute(text("UPDATE scenarios SET kind = 'baseline' WHERE id = 'base' AND kind IS NULL"))
        conn.execute(text("UPDATE scenarios SET kind = 'proposal' WHERE id != 'base' AND kind IS NULL"))
        conn.execute(text("UPDATE scenarios SET baseline_id = 'base' WHERE id != 'base' AND baseline_id IS NULL"))
    return done
