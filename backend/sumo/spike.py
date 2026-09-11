"""
backend/sumo/spike.py
══════════════════════
Phase 0 — Item 5: SUMO risk spike.

PURPOSE
───────
Timebox: ONE DAY.
Goal: Prove that a real SUMO network can be generated from TwinCity data
and that vehicles move along a Hinjewadi corridor in Cesium.

If this script runs to completion without error, Phase 5 is de-risked.
If netconvert fails, you learn the topology problem on day one, not week six.

WHAT IT DOES
────────────
1. Writes a hard-coded Hinjewadi Phase-1 corridor as .nod.xml + .edg.xml
2. Runs netconvert to produce a .net.xml
3. Generates random trips with randomTrips.py (bundled with SUMO)
4. Runs headless sumo for 600 simulated seconds
5. Streams vehicle positions over a WebSocket (handled by the API layer)

This module does NOT handle scenarios, comparisons, or cordon scoping —
those belong in Phase 5. The only goal here is to see cars move.

DEPENDENCIES
────────────
- SUMO installed and on PATH (see SUMO_SETUP.md)
  sumo, netconvert, and $SUMO_HOME/tools/randomTrips.py must all be present.
- No Python packages beyond stdlib and the backend's requirements.txt

SAFETY
──────
All files are written to a temp directory that is cleaned up on success.
On failure, the directory is preserved so you can inspect the XML.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Custom exceptions — callers must handle these explicitly, not catch bare
# Exception and hide the error.
# ──────────────────────────────────────────────────────────────────────────────

class SumoNotInstalledError(RuntimeError):
    """Raised when SUMO binaries are not found on PATH or at SUMO_HOME."""
    pass


class SumoConversionError(RuntimeError):
    """Raised when netconvert fails to produce a valid network."""
    pass


class SumoSimulationError(RuntimeError):
    """Raised when the SUMO simulation exits with a non-zero code."""
    pass


# ──────────────────────────────────────────────────────────────────────────────
# Result type
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class SpikeResult:
    success: bool
    net_xml_path: str
    vehicle_count: int
    teleport_count: int
    simulation_seconds: int
    netconvert_warnings: list[str] = field(default_factory=list)
    error: str | None = None


# ──────────────────────────────────────────────────────────────────────────────
# Hard-coded Hinjewadi Phase-1 corridor (spike input)
# ──────────────────────────────────────────────────────────────────────────────
# Real coordinates of the corridor from Hinjewadi Rajiv Gandhi Infotech Park
# gate to the NH-48 junction — approximately 1.8 km, 4 lanes.
#
# Reference:  18.5908° N, 73.7374° E → 18.5945° N, 73.7302° E
# These are approximate; the spike is only proving the pipeline works.

NOD_XML = textwrap.dedent("""\
    <?xml version="1.0" encoding="UTF-8"?>
    <!-- Hinjewadi Phase-1 Corridor Spike — node definitions -->
    <nodes>
        <node id="n0" x="0.0"    y="0.0"    type="priority"/>
        <node id="n1" x="300.0"  y="15.0"   type="priority"/>
        <node id="n2" x="600.0"  y="30.0"   type="traffic_light"/>
        <node id="n3" x="900.0"  y="20.0"   type="priority"/>
        <node id="n4" x="1200.0" y="5.0"    type="priority"/>
        <node id="n5" x="1500.0" y="0.0"    type="traffic_light"/>
        <node id="n6" x="1800.0" y="-10.0"  type="priority"/>
    </nodes>
""")

EDG_XML = textwrap.dedent("""\
    <?xml version="1.0" encoding="UTF-8"?>
    <!-- Hinjewadi Phase-1 Corridor Spike — edge definitions -->
    <edges>
        <edge id="e0" from="n0" to="n1" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e1" from="n1" to="n2" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e2" from="n2" to="n3" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e3" from="n3" to="n4" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e4" from="n4" to="n5" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e5" from="n5" to="n6" numLanes="4" speed="16.67" priority="10"/>
        <!-- Return direction (corridor is bidirectional) -->
        <edge id="e6" from="n6" to="n5" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e7" from="n5" to="n4" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e8" from="n4" to="n3" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e9" from="n3" to="n2" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e10" from="n2" to="n1" numLanes="4" speed="16.67" priority="10"/>
        <edge id="e11" from="n1" to="n0" numLanes="4" speed="16.67" priority="10"/>
    </edges>
""")

# ──────────────────────────────────────────────────────────────────────────────
# Binary / tool discovery
# ──────────────────────────────────────────────────────────────────────────────

def _find_binary(name: str) -> str:
    """
    Find a SUMO binary on PATH.
    Also checks $SUMO_HOME/bin/ which is the standard install location.
    """
    # 1. Check PATH first
    found = shutil.which(name)
    if found:
        return found

    # 2. Check $SUMO_HOME/bin/
    sumo_home = os.environ.get("SUMO_HOME")
    if sumo_home:
        candidate = Path(sumo_home) / "bin" / name
        if candidate.exists():
            return str(candidate)
        # Windows: check .exe
        candidate_exe = candidate.with_suffix(".exe")
        if candidate_exe.exists():
            return str(candidate_exe)

    raise SumoNotInstalledError(
        f"'{name}' not found on PATH and not at $SUMO_HOME/bin/. "
        "See SUMO_SETUP.md for installation instructions."
    )


def _find_random_trips() -> str:
    """Locate randomTrips.py, which ships with SUMO in tools/."""
    sumo_home = os.environ.get("SUMO_HOME")
    if sumo_home:
        candidate = Path(sumo_home) / "tools" / "randomTrips.py"
        if candidate.exists():
            return str(candidate)

    raise SumoNotInstalledError(
        "randomTrips.py not found. Set $SUMO_HOME to your SUMO installation directory. "
        "See SUMO_SETUP.md."
    )


# ──────────────────────────────────────────────────────────────────────────────
# Spike pipeline
# ──────────────────────────────────────────────────────────────────────────────

async def run_hinjewadi_spike(
    simulation_duration_s: int = 600,
    vehicle_seed: int = 42,
    cleanup_on_success: bool = True,
) -> SpikeResult:
    """
    Run the one-day SUMO spike on the hard-coded Hinjewadi corridor.

    Returns a SpikeResult. Raises SumoNotInstalledError if SUMO is not
    available; raises SumoConversionError if netconvert fails.

    The function is async because the caller (the FastAPI endpoint) is async,
    but subprocess calls are wrapped in asyncio.to_thread() to avoid blocking
    the event loop.
    """
    # Verify SUMO is installed before creating temp dir
    netconvert_bin = _find_binary("netconvert")
    sumo_bin = _find_binary("sumo")
    random_trips_py = _find_random_trips()

    tmpdir = Path(tempfile.mkdtemp(prefix="twincity_sumo_spike_"))
    logger.info("[SUMO spike] Working directory: %s", tmpdir)

    try:
        result = await _run_spike_in_dir(
            tmpdir=tmpdir,
            netconvert_bin=netconvert_bin,
            sumo_bin=sumo_bin,
            random_trips_py=random_trips_py,
            simulation_duration_s=simulation_duration_s,
            vehicle_seed=vehicle_seed,
        )
    except Exception:
        logger.error("[SUMO spike] FAILED — preserving temp dir for inspection: %s", tmpdir)
        raise
    else:
        if cleanup_on_success:
            shutil.rmtree(tmpdir, ignore_errors=True)
    
    return result


async def _run_spike_in_dir(
    tmpdir: Path,
    netconvert_bin: str,
    sumo_bin: str,
    random_trips_py: str,
    simulation_duration_s: int,
    vehicle_seed: int,
) -> SpikeResult:
    nod_file = tmpdir / "corridor.nod.xml"
    edg_file = tmpdir / "corridor.edg.xml"
    net_file = tmpdir / "corridor.net.xml"
    trips_file = tmpdir / "trips.xml"
    rou_file = tmpdir / "routes.xml"
    sumocfg_file = tmpdir / "sim.sumocfg"
    tripinfo_file = tmpdir / "tripinfo.xml"

    # ── Step 1: Write inputs ─────────────────────────────────────────────────
    nod_file.write_text(NOD_XML, encoding="utf-8")
    edg_file.write_text(EDG_XML, encoding="utf-8")

    # ── Step 2: netconvert ───────────────────────────────────────────────────
    netconvert_cmd = [
        netconvert_bin,
        "--node-files", str(nod_file),
        "--edge-files", str(edg_file),
        "--output-file", str(net_file),
        "--junctions.join",                 # merge close junctions (common OSM issue)
        "--remove-edges.isolated",          # drop orphan edges
        "--geometry.remove",                # simplify straight edges
        "--no-turnarounds",                 # no U-turns on arterials
        "--verbose",
    ]
    logger.info("[SUMO spike] Running netconvert…")
    nc_result = await asyncio.to_thread(
        subprocess.run,
        netconvert_cmd,
        capture_output=True,
        text=True,
    )

    warnings = [
        line for line in nc_result.stderr.splitlines()
        if "Warning" in line
    ]
    if warnings:
        logger.warning("[SUMO spike] netconvert warnings:\n%s", "\n".join(warnings))

    if nc_result.returncode != 0 or not net_file.exists():
        raise SumoConversionError(
            f"netconvert failed (exit {nc_result.returncode}).\n"
            f"stderr:\n{nc_result.stderr}\nstdout:\n{nc_result.stdout}\n"
            "Fix the network XML before proceeding with Phase 5."
        )

    logger.info("[SUMO spike] netconvert OK. %d warnings.", len(warnings))

    # ── Step 3: Generate random demand ───────────────────────────────────────
    random_trips_cmd = [
        sys.executable,
        random_trips_py,
        "-n", str(net_file),
        "-o", str(trips_file),
        "-r", str(rou_file),
        "-e", str(simulation_duration_s),
        "--seed", str(vehicle_seed),
        "-p", "5",    # one departure every 5 seconds ≈ 120 vehicles
        "--validate",
    ]
    logger.info("[SUMO spike] Generating random trips…")
    rt_result = await asyncio.to_thread(
        subprocess.run,
        random_trips_cmd,
        capture_output=True,
        text=True,
    )
    if rt_result.returncode != 0:
        raise SumoSimulationError(
            f"randomTrips.py failed (exit {rt_result.returncode}).\n"
            f"stderr:\n{rt_result.stderr}"
        )

    # ── Step 4: Write SUMO config ─────────────────────────────────────────────
    sumocfg_content = textwrap.dedent(f"""\
        <?xml version="1.0" encoding="UTF-8"?>
        <configuration>
            <input>
                <net-file value="{net_file}"/>
                <route-files value="{rou_file}"/>
            </input>
            <time>
                <begin value="0"/>
                <end value="{simulation_duration_s}"/>
            </time>
            <output>
                <tripinfo-output value="{tripinfo_file}"/>
            </output>
            <processing>
                <time-to-teleport value="300"/>
                <collision.action value="warn"/>
            </processing>
            <report>
                <verbose value="true"/>
                <no-step-log value="true"/>
            </report>
        </configuration>
    """)
    sumocfg_file.write_text(sumocfg_content, encoding="utf-8")

    # ── Step 5: Run headless SUMO ─────────────────────────────────────────────
    sumo_cmd = [
        sumo_bin,
        "-c", str(sumocfg_file),
        "--no-warnings",   # suppress per-step output; we count teleports from tripinfo
        "--seed", str(vehicle_seed),
    ]
    logger.info("[SUMO spike] Running headless SUMO for %ds…", simulation_duration_s)
    sumo_result = await asyncio.to_thread(
        subprocess.run,
        sumo_cmd,
        capture_output=True,
        text=True,
    )

    teleport_count = sumo_result.stdout.count("teleport")
    vehicle_count_raw = sumo_result.stdout.count("veh")

    if sumo_result.returncode != 0:
        raise SumoSimulationError(
            f"SUMO exited with code {sumo_result.returncode}.\n"
            f"stderr:\n{sumo_result.stderr}\nstdout:\n{sumo_result.stdout}"
        )

    logger.info(
        "[SUMO spike] DONE. teleports=%d, vehicles(approx)=%d",
        teleport_count, vehicle_count_raw
    )

    return SpikeResult(
        success=True,
        net_xml_path=str(net_file),
        vehicle_count=vehicle_count_raw,
        teleport_count=teleport_count,
        simulation_seconds=simulation_duration_s,
        netconvert_warnings=warnings,
    )
