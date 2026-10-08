# SUMO Setup Guide

> Required for Phase 0 (spike) and Phase 5 (full simulation engine).

SUMO (Simulation of Urban MObility) is the validated microsimulator at the
core of TwinCity's traffic engine. It is a native C++ binary — it cannot run
in the browser, which is why TwinCity uses a FastAPI backend to drive it.

---

## 1. Installation

### Windows (recommended: Installer)

1. Download the latest stable installer from https://sumo.dlr.de/docs/Downloads.php
2. Run the installer; note the installation path (default: `C:\Program Files (x86)\Eclipse\Sumo`)
3. Add the `bin/` subdirectory to your PATH:
   ```
   C:\Program Files (x86)\Eclipse\Sumo\bin
   ```
4. Set the `SUMO_HOME` environment variable:
   ```
   SUMO_HOME=C:\Program Files (x86)\Eclipse\Sumo
   ```

   In PowerShell (permanent, user scope):
   ```powershell
   [System.Environment]::SetEnvironmentVariable("SUMO_HOME","C:\Program Files (x86)\Eclipse\Sumo","User")
   $env:PATH += ";C:\Program Files (x86)\Eclipse\Sumo\bin"
   ```

5. Verify:
   ```
   sumo --version
   netconvert --version
   ```

---

### Ubuntu / Debian

```bash
sudo add-apt-repository ppa:sumo/stable
sudo apt-get update
sudo apt-get install sumo sumo-tools sumo-doc

# Set SUMO_HOME
echo 'export SUMO_HOME=/usr/share/sumo' >> ~/.bashrc
echo 'export PATH=$PATH:$SUMO_HOME/bin' >> ~/.bashrc
source ~/.bashrc

sumo --version
```

---

### macOS (Homebrew)

```bash
brew tap dlr-ts/sumo
brew install sumo

export SUMO_HOME=/opt/homebrew/opt/sumo/share/sumo
export PATH=$PATH:$SUMO_HOME/bin
```

---

### Docker (alternative — no local install required)

A `docker-compose.sumo.yml` is provided for teams without a local SUMO install.
This is the approach to use at demo time if the local install fights you.

```bash
# Start backend + SUMO container
docker compose -f docker-compose.sumo.yml up

# The backend will auto-detect SUMO inside the container
# POST http://localhost:8000/api/sim/spike should return success
```

> The Docker image pins SUMO to version 1.20.0. Do not upgrade without
> re-running the spike and verifying netconvert output.

---

## 2. Verify the Phase 0 spike

With SUMO installed and the backend running:

```bash
curl -X POST http://localhost:8000/api/sim/spike \
     -H "Content-Type: application/json" \
     -d '{"simulation_duration_s": 300, "vehicle_seed": 42}'
```

**Success response** (abridged):
```json
{
  "success": true,
  "vehicle_count": 42,
  "teleport_count": 0,
  "message": "Spike completed in 300s. ✓ No teleports. Phase 5 is de-risked."
}
```

**If `teleport_count > 0`:** The corridor network has topology issues.
Review `netconvert_warnings` in the response and refer to the network
quality section in the execution plan (Phase 5, §5.4).

**If `sumo_available: false`** from `GET /api/sim/status`:
Double-check that `SUMO_HOME` is set and `sumo` is on PATH.

---

## 3. Required tools (all ship with SUMO)

| Tool | Purpose |
|------|---------|
| `sumo` | Headless microsimulator |
| `netconvert` | Converts node/edge XML → SUMO net.xml |
| `$SUMO_HOME/tools/randomTrips.py` | Generates synthetic demand for testing |
| `duarouter` | Dynamic User Assignment routing (Phase 5, item 39) |
| `od2trips` | OD matrix → trip list (Phase 5, item 38) |

---

## 4. Pinned version

The project is developed and tested against **SUMO 1.20.0**.

Newer versions may change:
- `netconvert` warning IDs (affects our warning triager)
- `randomTrips.py` CLI flags
- Default simulation parameters

Pin the version in `docker-compose.sumo.yml`. If you upgrade, re-run the
spike and confirm `teleport_count` stays near zero.

---

## 5. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `SumoNotInstalledError: 'sumo' not found` | Verify `SUMO_HOME` and PATH; restart your terminal after setting env vars |
| `netconvert` exits with code 1 | Check `netconvert_warnings` in the response; common cause is isolated edges |
| `randomTrips.py` not found | Confirm `$SUMO_HOME/tools/randomTrips.py` exists |
| High teleport count | Add `--junctions.join-dist 10` to netconvert and check for disconnected nodes |
| Cars stuck at junction | Junction right-of-way issue — add `--junctions.corner-detail 5` |
