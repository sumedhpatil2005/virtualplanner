"""
backend/seed.py
═══════════════
Idempotent database seed script.

Usage:
    python seed.py

Creates the schema (if not present) and inserts the four canonical
scenario rows. Safe to re-run — uses INSERT OR IGNORE semantics.

Replace twincity.db with this script in version control:
  git rm --cached twincity.db
  git add seed.py
  echo "twincity.db" >> ../.gitignore
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

# Ensure the backend package root is on sys.path when run directly
sys.path.insert(0, str(Path(__file__).parent))

from database.connection import engine, Base, SessionLocal
from models.models import ScenarioEntity


# ──────────────────────────────────────────────────────────────────────────────
# Schema
# ──────────────────────────────────────────────────────────────────────────────

def create_schema() -> None:
    """Create all tables declared in the SQLAlchemy metadata (no-op if already exist)."""
    Base.metadata.create_all(bind=engine)
    print("[seed] Schema ready.")


# ──────────────────────────────────────────────────────────────────────────────
# Default scenarios
# ──────────────────────────────────────────────────────────────────────────────

DEFAULT_SCENARIOS: list[dict] = [
    {
        "id": "baseline",
        "name": "Baseline (Existing)",
        "description": "Current road network and zoning — no interventions.",
    },
    {
        "id": "flyover_nhwy48",
        "name": "NH-48 Flyover Proposal",
        "description": "Grade-separated flyover at the Hinjewadi Phase-1 junction.",
    },
    {
        "id": "metro_phase3",
        "name": "Metro Phase-3 Extension",
        "description": "Extend Pune Metro from Hinjewadi to Wakad with 4 new stations.",
    },
    {
        "id": "signal_retiming",
        "name": "Signal Re-timing Only",
        "description": "Optimise existing signal cycles — zero new construction.",
    },
]


def seed_scenarios(session) -> None:
    """Insert default scenarios, skipping rows that already exist."""
    inserted = 0
    for data in DEFAULT_SCENARIOS:
        exists = session.get(ScenarioEntity, data["id"])
        if exists is None:
            session.add(ScenarioEntity(**data))
            inserted += 1

    session.commit()
    print(f"[seed] Scenarios: {inserted} inserted, {len(DEFAULT_SCENARIOS) - inserted} already present.")


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

def main() -> None:
    create_schema()
    with SessionLocal() as session:
        seed_scenarios(session)
    print("[seed] Done. Database is ready.")


if __name__ == "__main__":
    main()
