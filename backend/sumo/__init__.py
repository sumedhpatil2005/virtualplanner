"""
backend/sumo/__init__.py
════════════════════════
SUMO integration package.

Exposes the public surface used by the API layer:
  - SumoNotInstalledError
  - SumoConversionError
  - run_hinjewadi_spike  (Item 5 — one-day spike function)
  - SumoService          (Phase 5 — full simulation service, stubbed here)
"""

from .spike import run_hinjewadi_spike, SumoNotInstalledError, SumoConversionError
from .service import SumoService

__all__ = [
    "run_hinjewadi_spike",
    "SumoNotInstalledError",
    "SumoConversionError",
    "SumoService",
]
