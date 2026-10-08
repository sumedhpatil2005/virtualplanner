"""
Test setup: point the app at a throwaway SQLite file *before* anything imports
database.connection, so tests never touch the developer's twincity.db.
"""

import os
import sys
import tempfile
from pathlib import Path

_tmpdir = tempfile.mkdtemp(prefix="twincity-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{Path(_tmpdir) / 'test.db'}"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c
