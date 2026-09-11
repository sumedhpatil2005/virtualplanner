"""
backend/api/sim_router.py
══════════════════════════
Simulation API routes.

Phase 0 (now):
  POST /api/sim/spike   — Run the Hinjewadi corridor spike
  GET  /api/sim/status  — Check SUMO availability

Phase 5 (TODO):
  POST /api/sim/run     — Start a full cordon-scoped simulation run
  GET  /api/sim/run/{id} — Get run status
  WS   /ws/sim/{id}    — Stream vehicle positions at 10 Hz
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from sumo.spike import (
    SumoNotInstalledError,
    SumoConversionError,
    SumoSimulationError,
    run_hinjewadi_spike,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sim", tags=["simulation"])


# ──────────────────────────────────────────────────────────────────────────────
# Schemas
# ──────────────────────────────────────────────────────────────────────────────

class SpikeRequest(BaseModel):
    simulation_duration_s: int = Field(
        default=600,
        ge=30,
        le=3600,
        description="Simulated time in seconds (30–3600).",
    )
    vehicle_seed: int = Field(
        default=42,
        ge=0,
        description="Random seed for reproducible vehicle generation.",
    )


class SpikeResponse(BaseModel):
    success: bool
    net_xml_path: str
    vehicle_count: int
    teleport_count: int
    simulation_seconds: int
    netconvert_warnings: list[str]
    message: str


class SumoStatusResponse(BaseModel):
    sumo_available: bool
    sumo_home: str | None
    message: str


# ──────────────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/status", response_model=SumoStatusResponse, summary="Check SUMO availability")
async def get_sumo_status() -> SumoStatusResponse:
    """
    Check whether SUMO is installed and discoverable.
    Use this to confirm setup before running the spike.
    """
    import os
    import shutil

    sumo_home = os.environ.get("SUMO_HOME")
    sumo_bin = shutil.which("sumo") or (
        str(__import__("pathlib").Path(sumo_home) / "bin" / "sumo")
        if sumo_home else None
    )

    available = sumo_bin is not None and __import__("pathlib").Path(sumo_bin).exists()

    return SumoStatusResponse(
        sumo_available=available,
        sumo_home=sumo_home,
        message=(
            "SUMO is available. Run POST /api/sim/spike to start the Phase 0 spike."
            if available
            else "SUMO not found. See SUMO_SETUP.md for installation instructions."
        ),
    )


@router.post("/spike", response_model=SpikeResponse, summary="Run Phase-0 Hinjewadi spike")
async def run_spike(request: SpikeRequest) -> SpikeResponse:
    """
    Phase 0 — Item 5: Run the Hinjewadi corridor risk spike.

    Writes a hard-coded corridor network, runs netconvert, generates random
    demand, and runs headless SUMO. Returns a structured result.

    This endpoint is the acceptance gate for Phase 5: if it succeeds,
    the SUMO pipeline is proven and Phase 5 work can begin.

    Errors:
    - 503 if SUMO is not installed
    - 422 if netconvert fails to produce a valid network
    - 500 for unexpected simulation errors
    """
    logger.info(
        "[spike] Starting Hinjewadi spike: duration=%ds seed=%d",
        request.simulation_duration_s,
        request.vehicle_seed,
    )

    try:
        result = await run_hinjewadi_spike(
            simulation_duration_s=request.simulation_duration_s,
            vehicle_seed=request.vehicle_seed,
            cleanup_on_success=True,
        )
    except SumoNotInstalledError as e:
        raise HTTPException(
            status_code=503,
            detail=f"SUMO not installed: {e}. See SUMO_SETUP.md.",
        ) from e
    except SumoConversionError as e:
        raise HTTPException(
            status_code=422,
            detail=f"netconvert failed: {e}",
        ) from e
    except SumoSimulationError as e:
        raise HTTPException(
            status_code=500,
            detail=f"SUMO simulation error: {e}",
        ) from e

    teleport_verdict = (
        "✓ No teleports" if result.teleport_count == 0
        else f"⚠ {result.teleport_count} teleport(s) — investigate network quality before Phase 5"
    )

    return SpikeResponse(
        success=result.success,
        net_xml_path=result.net_xml_path,
        vehicle_count=result.vehicle_count,
        teleport_count=result.teleport_count,
        simulation_seconds=result.simulation_seconds,
        netconvert_warnings=result.netconvert_warnings,
        message=(
            f"Spike completed in {result.simulation_seconds}s. "
            f"Vehicles: ~{result.vehicle_count}. {teleport_verdict}. "
            "Phase 5 is de-risked if teleport_count is near zero."
        ),
    )
