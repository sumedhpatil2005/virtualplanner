# Scenario isolation and versioning

Mission §12 (scenario isolation and version management), §13 "Fair comparison", §22 principles 5, 10 and 12.
Branch `urban-mobility-platform`, worktree `um-scen`. Date: 2026-11-11.

Labels: **UNIT-TESTED** (a Vitest or pytest case checks it), **BROWSER-VERIFIED** (checked in the built app in Chromium
against a copy of the project database), **UNTESTED** (written, not checked), **CODE-READ** (read from the source, not executed).

## 1. Before: reproduced defects

The suspected defects of `docs/SYSTEM_ARCHITECTURE.md` §1.7 #1–#3 were reproduced with tests written for the
behaviour the mission requires. Then the same tests were run against the code before this work (commit `72ea0bd`).
`frontend/src/engine/testing/ScenarioIsolation.test.ts` calls the new API through optional calls, so the one file runs on both versions.

| # | Defect | How it was reproduced | Before | After |
|---|---|---|---|---|
| 1a | A lane edit of a base road while a proposal is active changes the baseline (`commitRoadFieldEdit` → `ObjectManager.update` on the base object; the backend row is re-saved). | ScenarioIsolation "a lane edit in a proposal…" | **FAIL**: the baseline view changed | pass |
| 1b | Deleting a base road while a proposal is active deletes it from the baseline (`deleteWithHistory` → `ObjectManager.delete`). It also adds the road to the device's `osm-deleted` list, so later imports skip it everywhere. | "deleting a base road in a proposal…" | **FAIL** | pass |
| 1c | Undo/Redo of proposal edits act on the baseline. | "Undo and Redo of proposal edits are exact…" | **FAIL** | pass |
| 2a | A proposal object with a base id (the override shape `scenarioFilter.ts` expects) replaces the base object in memory. `ObjectManager` is one `Map` keyed by id. | "an override with the base id…" | **FAIL** | pass |
| 2b | The same thing at the API: `city_objects.id` is the primary key, so `POST /api/objects` with a base id and a proposal's `scenarioId` moves the base row into the proposal. | `backend/tests/test_scenario_isolation_repro.py` | **FAIL** (base row lost) | pass (409) |
| 2c | Duplicating a proposal copied its objects with new ids `stem__scnId`, so a copied override would sit beside its base object instead of replacing it. | CODE-READ (old `TwinCityEngine.createScenarioFrom`); fork now tested in `test_fork_copies_the_change_set_keyed_by_base_ids` | defect by construction | pass |
| 3 | Lane-scope edits read the roads of other proposals. | "a carriageway lane edit in P does not reach a road that exists only in proposal Q" | **NOT REPRODUCED**: `carriagewayRun` (roadSection.ts) already keeps only pieces with the selected road's `scenarioId` | pass |
| 3' | Found while fixing: that same `scenarioId` filter would stop a carriageway lane edit at a piece the proposal had already changed. | "after one piece is overridden in P…" | **FAIL** (on the old code it fails at the baseline check) | pass |
| — | Three proposals from one baseline: an edit in C changes A or the baseline. | "edits in A, B and C change only their own view" | **FAIL** | pass |

Before counts: **frontend 6 of 7 cases failed** and **backend 1 of 1 failed** on `72ea0bd`. After: all pass (UNIT-TESTED).
Legacy leaks found by code reading: `TwinCityEngine.getTrafficNetwork` inputs (~line 1820) and `SimulationManager` (line
145) took `objects.getAll()` across **all** scenarios. These are fixed because `getAll()` is now the active scenario's view (CODE-READ).

## 2. After: the model

```
scenario (proposal) = baseline ref ('base') + change set keyed by object id
  add     the proposal's own object          city_objects row, scenario_id = proposal (legacy storage, unchanged)
  modify  its version of a BASE object       scenario_object_changes (scenario_id, object_id) op='modify', whole object
  delete  a BASE object hidden (tombstone)   scenario_object_changes op='delete'
materialised view = baseline ⊕ change set    (ObjectManager.viewOf, GET /api/scenarios/{id}/materialised)
```

- **The baseline cannot be changed from inside a proposal.** With a proposal active, `ObjectManager.update/delete/add/
  addMultiple/deleteMultiple` on a base id copies the object on write into that proposal's overlay. The base row
  and the device's `osm-deleted` list are never touched. Editing the baseline is still possible, but only with the base
  scenario active (imports, corrections). Versions record a baseline fingerprint, so such an edit shows up later (see §3).
- **Overrides keep the base id**, so rendering, topology, analysis and road-by-road comparisons see the same road id
  in every scenario. The key `(scenario_id, object_id)` cannot clash with the base row's primary key.
- **Exact Undo/Redo.** History is kept per scenario (`HistoryManager` stacks keyed by the active scenario). If a
  replacement object (Undo) has the baseline's content, the change is dropped and the proposal shows the base object
  itself again. Content is compared without `updatedAt`/`scenarioId`.
- **Proposals are independent.** Each proposal has its own overlay and its own adds. `getAll()` / `getById()` return only
  the active scenario's view, so other proposals' objects are invisible to editing, simulation and lane scope.
- **Lane scope** (`roadSection.carriagewayRun`) takes base pieces and the active proposal's pieces as one carriageway.
  Pieces of two different proposals never mix.
- **Duplicate** (`POST /api/scenarios/{src}/fork`): modifies and deletes keep the base ids. The source's own objects get new ids `stem__newId`.
- **Legacy upsert guard**: `POST /api/objects` and `/objects/batch` answer 409 instead of moving a row into another scenario.

## 3. Versions and frozen inputs

| Endpoint | Behaviour |
|---|---|
| `POST /api/scenarios/{id}/versions` `{label, note, assumptions}` | Saves an immutable snapshot of the whole change set (adds, modifies, tombstones) in `scenario_versions` + `scenario_version_changes`, together with the assumptions in force (`SimulationMode.frozenAssumptions()`: frozen baseline demand key, demand settings, hour, day, seeds, warm-up, measured period, signal timing mode, signal source mapped/estimated, network corrections, demand level, engine build), the change-set hash and the baseline fingerprint (sha256 of the base objects' content + count). |
| `GET /api/scenarios/{id}/versions` | Newest first, plus the head's change-set hash (the UI shows "Unsaved changes" when it differs from the latest version) and the current baseline fingerprint. |
| `GET /api/scenario-versions/{vid}` / `…/objects` | A version's change set / baseline ⊕ that change set. `baselineChanged` is true if the baseline is no longer the one the version was saved on. |
| `POST /api/scenario-versions/{vid}/restore` | If the head is not already a version, it is saved first ("Unsaved changes before restore"). Then the version's change set becomes the head, and a **new** version "Restored version N" with `restoredFromVersionId` is recorded. No version is ever edited or removed (only by deleting the whole proposal, after a confirmation). |
| `POST /api/runs`, `GET /api/runs[/{id}]`, `POST /api/runs/compare` | Each baseline and proposal run of the Compare flow records its frozen inputs. It also records the scenario's change-set hash and the baseline fingerprint. Compare lists every differing input and is `fair` only when the baseline and the fairness-critical inputs match. |

Frontend: `ScenarioVersions.tsx` (in the scenario panel, for proposals) has Save version, the version list with each
version's assumptions compared with the current settings, a "baseline has changed" flag, and Restore (with confirmation).
After a restore, the proposal's Undo history is cleared, because it describes the state before the restore.

Fair comparison: `RunInputs` / `checkRunInputs` (simulation/ScenarioComparison.ts) now compare more than demand, hour,
seeds and duration. They also compare warm-up, day type, signal timing, signal locations, network corrections, demand
level and engine build, each when both runs recorded it. Each difference is listed with both values in "Assumptions of
this comparison". When everything matches, the frozen inputs of both runs are listed there too. Before this work, the
comparison did not check signal timing or network corrections at all (CODE-READ: `runComparison` checks seed, volume,
focus, hour; `checkRunInputs` checked demand, hour, seeds, duration).

## 4. Migration (backward compatible)

`backend/database/migrations.py` runs at startup after `create_all`. It adds nullable columns to `scenarios` (`kind`,
`baseline_id`, `parent_scenario_id`, `created_at`) and fills only NULLs ('baseline' for `base`, 'proposal' on 'base'
for the others). New tables are created empty. No row of `city_objects`, `areas` or `scenarios` changes: the existing
proposal objects are those proposals' `add` changes, exactly as before. `GET /api/objects` returns exactly what it
returned before (overrides and tombstones are served separately by `GET /api/scenario-changes`), so older clients keep
working but do not see a proposal's changes to base objects.

UNIT-TESTED: a synthetic legacy database and a copy of the project database (`twincity.db`, 18,273 roads + 2,459 other
objects, with one synthetic legacy proposal added to the copy) were both migrated twice (idempotent). Every row of the
old tables was identical afterwards, and versioning a migrated proposal captured exactly its objects. The project
database itself holds no proposals, so no real proposal data existed to migrate. The original file was never opened for writing.

## 5. Tests and verification

| Check | Where | Label |
|---|---|---|
| Baseline isolation (edit, delete, override, Undo/Redo), lane scope, 3 independent proposals, reload from the synced changes (incl. an undone edit dropped), restore replaces one proposal only | `frontend/src/engine/testing/ScenarioIsolation.test.ts` (9 of 10) | UNIT-TESTED |
| Modify/tombstone/revert, refusal for non-base ids and the baseline, 3 independent proposals, legacy upsert guard, versions immutable, restore = new head + auto-save, baseline-changed flag, fork, delete cascade, run inputs + compare differences, migration (synthetic + project DB copy) | `backend/tests/test_scenario_versions.py` (11), `test_scenario_isolation_repro.py` (1), existing `test_scenarios.py` (6) | UNIT-TESTED |
| Fair-comparison input differences | `frontend/src/engine/testing/ScenarioIsolation.test.ts` "checkRunInputs…" (1 of 10) | UNIT-TESTED |
| Existing suites that touch the changed code, run one file at a time: EditScope 11, LaneScopeStore 3, CarriagewayDefinition 7, CarriagewayProperties 2 (+1 skipped as before), EditingWorkflow 9, JunctionEditing 29, EditRecompute 14, ComparisonAgreement 9, HistoryManager 7, HonestControls 17 (one call adapted to the new `compareScenario(baseView, scenarioView)` signature, assertions unchanged), EditIsolationFixes 9; backend full suite 62 passed, 2 skipped (no local OSM index; skipped before too) | — | UNIT-TESTED (all pass) |
| Also run after the change: NetworkEditIsolation 10 (whole-network edit isolation and exact Undo on the project DB), RoadAnalysis 11, Directions 17 — all pass. Not re-run: the rest of the full Vitest suite (validation harnesses and other heavy suites; 2-CPU sandbox shared with other agents) | — | UNIT-TESTED / rest UNTESTED after this change |
| Browser: 2 proposals, delete a base road in one, modify it in the other, reload, restore an older version | §6 | see §6 |

## 6. Browser verification (BROWSER-VERIFIED, 2026-11-11)

Built app (`vite build`, served on 127.0.0.1:4502) against the backend on 127.0.0.1:8302, using a fresh copy of the
project database (20,732 base objects). Chromium (swiftshader). External requests were aborted (globe imagery not
needed). Script: `/workspace/work/um-scen-run/browser.py` (phases one/two/three = before reload, after reload,
after a second reload). Results: `/workspace/work/um-scen-run/out/result_*.json`, screenshots `out/1_…png`–`5_…png`.
Road under test: base road `osm_1052214584` (speed limit 60, 2 lanes).

| Step | How | Result |
|---|---|---|
| Create proposal P1 | "New proposal" button + form (DOM) | created, active |
| Delete the base road in P1 | `engineInstance.deleteObjectWithHistory` (the method behind the Build panel's Delete button and the Delete key) | P1: road absent. Baseline: road present, 60 km/h. Backend change row `delete` |
| Save version "P1 tombstone" | Versions panel (DOM) | v1 saved, assumptions recorded (hour 9, seeds 42/7/11, Webster, signals estimated, corrections on) |
| Create proposal P2, modify the same road | Properties panel "Speed Limit" field (DOM input) → 25. Save version "P2 speed 25". Then 15 (unsaved) | P2 25 → 15. **P1 still has no road; the baseline is still 60.** Backend base row byte-identical |
| Reload | new page load | baseline 60 (equal to before, in memory and the backend row), P1 road absent, P2 15. Panel shows "Unsaved changes" |
| Restore v1 in P2 | Restore button + confirmation (DOM) | P2 25. List: v3 "Restored version 1", v2 "Unsaved changes before restore", v1. Status "At version 3". P1 and the baseline unchanged |
| Reload again | new page load | the same: baseline equal, P1 absent, P2 25, versions v3/v2/v1 in the API and the DOM |

Console errors during the runs: only the aborted external requests (`net::ERR_FAILED`, and Cesium's minified `kre`
from the aborted ion request). No page errors. Not exercised in the browser: run recording (`/api/runs`) from the
Simulate → Compare flow (frontend recorder UNTESTED in the browser; the endpoint is UNIT-TESTED) and Duplicate (fork; UNIT-TESTED on the backend only).

## 7. Limitations (honest)

- Bridge deck heights (`liftBridges`) are worked out for the stored base and own objects only. If a proposal tombstones a
  deck, its approach heights are not worked out again inside that proposal (UNTESTED; heights are derived in memory and never stored).
- The baseline itself has no versions: a version records a fingerprint of the baseline and flags it when it has
  changed, but it cannot bring back an old baseline. Baseline versioning is a separate piece of work.
- A version stores the change set and the assumptions, not simulation results. Runs store frozen inputs and a small
  result summary (`POST /api/runs`). Full run artefacts are not stored.
- `engineVersion` is `VITE_GIT_SHA` when the build sets it, otherwise `'unknown'`. The current build does not set it.
- Object edits are still synced one request per change (as before). A failed sync shows a toast but is not retried.
