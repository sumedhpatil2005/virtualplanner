# UrbanOS — integrated QA and regression (uos-qa, 2026-11-13)

Branch `urbanos-city-planning-redesign`, integrated head **`0cd1cfa`** (code; the later tip `9550d07` only changes README.md).
Worktree `/workspace/work/uos-wt-qa` (detached), 2-CPU / 8 GB sandbox shared with other agents.
Labels: **BROWSER-VERIFIED** (Chromium 156 headless + SwiftShader, Playwright, against a local backend on a COPY of
`backend/twincity.db`), **UNIT-TESTED** (vitest / pytest), **UNTESTED**. Values: measured / estimated / hypothetical / unknown.
The traffic model still **fails validation (TAG M3.1)** (ENGINEERING_VALIDATION §5); nothing here changes that, and every
simulation number below is model output (estimated), not a forecast.

## 1. Automated gates

| Gate | Result on `0cd1cfa` | Pre-redesign baseline (ENGINEERING_VALIDATION §3, 2026-11-11) |
|---|---|---|
| vitest, full suite in one run (`npx vitest run`, run alone, 576 s) | **91 files: 85 passed, 6 skipped (opt-in harnesses); 712 tests passed, 7 skipped, 0 failed** | 86 files, 665 passed, 7 skipped (run one file at a time) |
| backend pytest (`python -m pytest`) | **115 passed, 3 skipped**, 0 failed. With `TWINCITY_OSM_INDEX` set: **117 passed, 1 skipped** (remaining skip: `test_network_corrections.py:73`, needs a different local index) | 102 passed |
| `npx tsc -p tsconfig.app.json --noEmit` | **0 errors** | 0 errors |
| `oxlint src` | **0 errors, 8 warnings** (unused vars / react-refresh only-export-components; new: `shell/contexts/SimulateDrawer.tsx:14`) | 0 errors, 7 warnings |
| `vite build` (`VITE_API_BASE=http://127.0.0.1:8319`) | **succeeds** (main chunk 1,437 kB / 421 kB gzip) | succeeds |

Differences from the baseline are additions: +5 vitest files / +47 tests (new: `DesignTools`, `EnvExploreModel`, `HonestyBadges`,
`ProjectsWorkspace`, `UndergroundWorkspace` in `src/engine/testing/`), +13 pytest (new files `test_coordination.py`, `test_projects_workspace.py`).
No assertion was weakened; no test or code was changed by this QA pass (see §5).

## 2. Browser smoke on the new shell

_(filled in below by the run)_

## 3. AFTER screenshots and contact sheet

_(filled in below)_

## 4. What is not tested

_(filled in below)_

## 5. Fixes made by QA

_(filled in below)_
