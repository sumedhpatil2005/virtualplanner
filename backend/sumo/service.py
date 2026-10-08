"""
backend/sumo/service.py
═══════════════════════
Phase 5 stub — SumoService interface.

The full implementation lives in Phase 5. This stub exists so that:
  - The API router can import SumoService without breaking
  - The interface is defined and won't change between phases
  - Tests can mock it cleanly

The interface mirrors the architecture in the execution plan (§5.2):
  POST /api/sim/run  →  SumoService.start_run()
  WS  /ws/sim/{id}  →  SumoService.stream_positions()
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import AsyncIterator

logger = logging.getLogger(__name__)


class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


@dataclass
class SimRun:
    run_id: str
    area_id: str
    scenario_id: str
    seed: int
    status: RunStatus = RunStatus.QUEUED
    error: str | None = None


@dataclass
class VehiclePosition:
    vehicle_id: str
    x: float       # longitude
    y: float       # latitude
    speed: float   # m/s
    heading: float # degrees (0 = north)
    edge_id: str


class SumoService:
    """
    Stateful SUMO simulation service.

    Phase 5 implementation will:
    - Accept cordon-scoped area + scenario
    - Export network via TrafficNetworkBuilder (Phase 5, item 37)
    - Export demand via DemandMatrixCompiler (Phase 5, item 38)
    - Run libsumo in-process
    - Stream vehicle positions via WebSocket at 10 Hz

    For now, all methods raise NotImplementedError so callers get a
    clear failure mode rather than silent wrong behaviour.
    """

    async def start_run(
        self,
        area_id: str,
        scenario_id: str,
        seed: int = 42,
    ) -> SimRun:
        """
        Start a new simulation run.
        Returns a SimRun with a run_id that can be passed to stream_positions.
        Phase 5 will implement the actual logic.
        """
        raise NotImplementedError(
            "SumoService.start_run() is not implemented yet. "
            "This will be implemented in Phase 5. "
            "Use POST /api/sim/spike for the Phase 0 proof of concept."
        )

    async def stream_positions(
        self,
        run_id: str,
    ) -> AsyncIterator[list[VehiclePosition]]:
        """
        Stream vehicle positions for a running simulation at ~10 Hz.
        Each yielded list is the positions of all vehicles at that timestep.
        Phase 5 will implement the actual WebSocket streaming logic.
        """
        raise NotImplementedError(
            "SumoService.stream_positions() is not implemented yet. "
            "This will be implemented in Phase 5."
        )
        # Make this a proper async generator (unreachable but satisfies type checker)
        yield []  # type: ignore[misc]

    async def get_run_status(self, run_id: str) -> SimRun:
        """Get the status of a simulation run by ID."""
        raise NotImplementedError("Phase 5 — not yet implemented.")
