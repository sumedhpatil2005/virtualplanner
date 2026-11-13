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

Harness `/workspace/work/uos-qa-e2e/smoke.py` = the 10-step pass of ENGINEERING_VALIDATION §10
(`/workspace/work/um-smoke-run/e2e/smoke.py`, reusing its `lib.js`/`topo.js`) ported to the UrbanOS shell: navigation by
the workspace rail (`ws-*`, Projects = `open-planning`), Data via Projects → `open-traffic-data`, Count checks and
Emissions via the Simulate drawer tabs (`#uos-drawer-tab-counts`, `#uos-drawer-tab-emissions`), project pages via
`ptab-*`, layout geometry from the shell regions (`.uos-topbar/.uos-rail/.uos-context/.uos-inspector/.uos-drawer`) instead
of the old `.pointer-events-auto` docks; plus 5 new steps (11–15). Built app (`vite build`, `VITE_API_BASE=http://127.0.0.1:8319`)
on :4519, backend (worktree) on :8319 against a **copy** of `twincity.db` + feasibility layers DB, `TWINCITY_OSM_INDEX` set.
Chromium headless 1440×900. All traffic counts, utility records and projects are **SYNTHETIC**.

Runs (results JSON in `/workspace/work/uos-qa-e2e/`, screenshots `shots/qa-*.png`):
- **Run A+C** `results_runAC.json` on head `0cd1cfa`: steps 1,2,5,6 then (page crash in 8, see below) 1,3,4,7,9,11,13,14,12,15,10 → all pass except 8.
- **Run B** `results_B.json` on `255be05` (QA fix, §5): 1,2,8,9,11,13 → all pass. Step 8 page crash in run A happened while another
  agent's Chromium (polish_check, 4 viewports) was running at the same time; cause inferred to be memory pressure (not inspected).
  Re-run alone it passed with the same numbers as on 2026-11-11.
- **Run D** `results_D.json` on `255be05`: 1,9,11,13 on a fresh project to verify the §5 fix → pass.

Console: only `Failed to load resource: net::ERR_FAILED` (blocked Google Fonts), no page errors.

| # | Check | Result | Label | Evidence |
|---|---|---|---|---|
| 1 | App loads in the new shell | PASS | BROWSER-VERIFIED | 20,732 base objects (view SHA `76893603a3245f55`); shell opens on Explore/view; rail = Explore, Design, Underground, Environment, Simulate, Projects, Reports. `qa-01-loaded.png` |
| 2 | COEP area analysis 09:00 (`osm_218681353`, 1.5 km) via the Simulate workspace | PASS | BROWSER-VERIFIED; model output (estimated); model FAILS validation | ready in 105 s, "severe", headline "Towards the north-east … 2 km/h against a free-flow 50 km/h (LOS F)"; fuel 2,952.03 L/h (same as 2026-11-11). Red banner "Traffic model fails validation (TAG M3.1): 0 of 15 count sites within GEH 5; river screen line −30.5%" in the context panel and the top-bar pill. `qa-02-analysis-0900.png` |
| 3 | New proposal, road across an at-grade road → junction, undo/redo exact, base unchanged after reload | PASS | BROWSER-VERIFIED | Design workspace; `tool-import_osm` present in the "Data" group. Road `bbqhtjs4l` across Residential Road `osm_1010245033` (ground): shared node `node_73.85387_18.52541_0.0`, crossed road got a vertex, route passes the junction. Undo/redo/undo: 0 objects differ, network key and deleted list restored. After reload base view SHA identical (20,732), backend base rows identical, road persisted in proposal `scn_n30uprgn`. As in 2026-11-11, `osm_238836092` also changed (end snap, inferred). `qa-03a-junction.png` |
| 4 | Versions: save, undo, save, restore | PASS | BROWSER-VERIFIED | v1 "with road" (3 changes) → v2 "road removed" (0) → restore v1 → v3 "Restored version 1" (3 changes); backend v3 carries `restoredFromVersionId`. `qa-04-versions-restored.png` |
| 5 | Import SYNTHETIC CSV (Projects → Data) as validation, re-run → observed vs simulated (Simulate drawer → Count checks) | PASS | BROWSER-VERIFIED (SYNTHETIC counts) | Dataset `tds_faba5553ec19` role validation, kind measured, **synthetic=true** (the 2026-11-11 harness omission is fixed: box ticked). Row fwd 09:00–10:00: observed 1,169, routed 4,035 (GEH 56.2), simulated 1,168 (GEH 0.0); 1 count "not compared"; text "Nothing is fitted to these counts". Same coincidence as before (seeded run, fuel unchanged). `qa-05a…`, `qa-05b-observed-vs-simulated.png` |
| 6 | Emissions card (now in the Simulate drawer) | PASS | BROWSER-VERIFIED; values estimated | Exactly 1 `emissions-card` in the DOM, inside `.uos-drawer`; header "Traffic input fails validation (TAG M3.1)"; fuel 2,952.0 L/h, CO₂ 6,932.9 kg/h, NOx 15,442 g/h, PM 2,206.1 g/h, idling 77% of fuel, per-class rows (stand-ins labelled). `qa-06-emissions-card.png` |
| 7 | Feasibility on the drawn road → PDF | PASS | BROWSER-VERIFIED; screening (estimated / verified-from-available-data per finding) | 13 findings (e.g. "5 mapped building(s) within 35 m … buffer 30 m is a hypothetical screening value"); PDF 13 pages, 65,022 B, text extractable. `qa-07a-feasibility.png`, `qa-07b-feasibility-pdf-1.png` |
| 8 | Generator: 6 candidates, evaluate 2, Pareto table with fuel | PASS (run B; crash in run A) | BROWSER-VERIFIED; model output (estimated) | 6 candidates, 2 signal retimings kept, evaluated in 251 s, both ok (verdict "mixed"); rows baseline (Pareto ★) / 2 dominated; fuel 2,952 / 2,957 / 2,856 L/h, CO₂ 6,933 / 6,953 / 6,703 kg/h — identical to 2026-11-11. Base view unchanged after create and evaluate. `qa-08-pareto-table.png` |
| 9 | Planning project: create, attach scenario + dataset, export PDF | PASS | BROWSER-VERIFIED | Links "SCENARIO SMOKE proposal: new road crossing", "TRAFFIC DATASET SYNTHETIC smoke counts COEP [measured, synthetic]"; report PDF 39,709 B names both and contains the validation warning text. `qa-09a-planning-panel.png`, `qa-09b-planning-pdf-1.png` |
| 10 | 390×844 and 768×1024, Design and Simulate | PASS (geometry) with 2 observations | BROWSER-VERIFIED (layout geometry; no real touch device) | 0 overlaps among top bar/rail/context/inspector, 0 off-screen, no page overflow, 0 shell buttons < 40 px. Observations: at 390 the top bar's content is wider than the screen (`scrollWidth 515 > 390`, clipped, right items hidden) — the polish branch commit `f690c0d` ("phone top bar fits 390 px") targets this and is **not** in the tested head; at 768 the drawer strip lies under the context overlay (by design: one overlay at a time; the underground harness collapses the panel first). `qa-10-*.png` |
| 11 | **Underground**: draw tunnel, depths, profile, conflict check, leaving restores globe | PASS | BROWSER-VERIFIED; depths user-entered ESTIMATED / UNKNOWN; flat datum, no terrain | Globe before `{translucent:false, α 1, collision on}` → in `{true, 0.35, off}` → after leaving identical to before. 3-vertex 902 m bored tunnel, depths 18 m / 22 m estimated / blank = UNKNOWN; Profile: ground line "flat datum … no terrain data — UNKNOWN", 3 crossings, 1 UNKNOWN marker, 1 band. Conflict check against the smoke project: Potential conflict 4, No conflict within available data 1, Unknown — no data coverage 1 (run D: 7 / 1 / 1). Points are fed through `editing.addDrawingPoint/finalizeDrawing` (canvas clicks cannot hit globe tiles here: imagery 401, as in UNDERGROUND_WORKSPACE §4). `qa-11a-tunnel-profile.png`, `qa-11b-tunnel-conflicts.png` |
| 12 | **Environment** catalogue | PASS | BROWSER-VERIFIED | 8 groups (Water & flooding 4, Ground & geology 4, Air 1, Noise 1, Heat 1, Vegetation 3, Heritage & protected 1, Infrastructure constraints 2); 12 rows "Not imported" / UNKNOWN; water overlay "1,409 features drawn for the layer coverage box. Absence on the map proves nothing." Emissions summary empty (no analysis in that page session after the reload) — empty state, not a zero. `qa-12-environment.png` |
| 13 | **Projects** conflicts | PASS | BROWSER-VERIFIED; screening (depth UNKNOWN → potential conflict by design) | Alternatives → "Add proposal elements" → 5 drafts registered (road `bbqh` 10 m wide top 0 m, 2 crossed roads, alignments) → Conflicts → Run detection: run D 7 potential conflict + 1 unknown-no-coverage (tab "Conflicts 7"); conflict CSV 67 lines with the "Not an engineering assessment … NOC or permit" header; tabs Overview, Alternatives, Assessments, Datasets, Conflicts, Reviews & decisions, Activity. Run A found the duplicate-element regression fixed in §5; run D: 0 duplicate (scenario, element_ref) pairs. `qa-13-projects-conflicts.png` |
| 14 | **Reports** exports | PASS | BROWSER-VERIFIED (endpoints fetched) | Project PDF 200 `application/pdf` 39,839 B; DOCX 200 (OOXML) 41,408 B; conflict summary CSV 200, 36 lines; Investigation Requirements Document "Generate PDF" created a document (2 download links listed), download 200 PDF 65,022 B. `qa-14-reports.png` |
| 15 | **Ctrl+K palette** | PASS | BROWSER-VERIFIED | Ctrl+K opens `command-palette`; "flyover" → "Draw flyover · key 5 · Design" → Enter → Design workspace, `draw_flyover`, palette closed; "SYNTHETIC smoke project" → "Open project …" → Enter → Projects with the project page open. `qa-15-palette.png` |

Labels for numbers: all simulation figures are model output (estimated) of a model that **fails validation**; counts are SYNTHETIC
and stored `synthetic=true`; feasibility and conflict findings are screening.

## 3. AFTER screenshots and contact sheet

_(filled in below)_

## 4. What is not tested (UNTESTED here)

- Real pointer drawing on the globe: tunnel points are fed through the engine's drawing API because globe tiles never
  render in this sandbox (Cesium ion imagery 401); road drawing uses the topology harness (`topo.js`), as on 2026-11-11.
- Through-the-day runs, an ODME estimation run, the Calibration drawer tab content, DOCX content (only HTTP 200 + size),
  evidence upload/review and decisions (covered on partial heads in PROJECTS_AND_COORDINATION_UI.md), borehole/utility
  record import in this pass (covered in UNDERGROUND_WORKSPACE.md §4), cross-section view, X-ray rendering.
- Light theme (no toggle), Alt+1…7 workspace keys, real touch input / real devices, browsers other than Chromium, GPU rendering.
- Polish-branch commits after `0cd1cfa` that were not on the branch tip when tested (e.g. `f690c0d` phone top bar,
  `591208f` ShellOverlay tests): this report is for `0cd1cfa` + the QA fix `255be05` only.
- The traffic model's accuracy: still FAILS TAG M3.1 (ENGINEERING_VALIDATION §5); no step here measures accuracy.

## 5. Fixes made by QA

**`255be05` — Underground conflict check created a duplicate proposal element** (found by smoke step 13, run A).
The Underground "Check conflicts" registered the alignment without `scenario_id`/`element_ref` (identified only by a
provenance marker), so Projects → Alternatives → "Add proposal elements" did not see it as registered and added the same
tunnel a second time (as kind `other`, depth UNKNOWN), doubling its findings. Fix (minimal, no layout/CSS):
`engine/underground/alignmentGeometry.ts` `alignmentElementPayload` now carries `scenario_id` + `element_ref`;
`components/underground/ConflictCheck.tsx` reuses an element with the same `element_ref` (or the old marker) and PATCHes it
(PATCH body without the non-patchable `scenario_id`/`element_ref`). Unit test extended
(`UndergroundWorkspace.test.ts`, assertions added, none weakened); UndergroundWorkspace + ProjectsWorkspace 22/22 pass;
tsc 0; oxlint 0 errors. BROWSER-VERIFIED in run D: element `ekoy3ni3q` registered from Underground as `tunnel` with
`element_ref`; Projects' register step then offered 5 drafts without it; 0 duplicate pairs in
`GET /api/coordination/projects/{id}/elements`.

Open item (not fixed, not a regression): an alignment registered only from Projects is mapped to kind `other` with depth
UNKNOWN (`lib/planningProjects.ts` `draftFromObject` has no `underground_alignment` case), so it loses the depth profile the
Underground check sends. Conservative (UNKNOWN → potential conflict), but less informative; mapping it via
`alignmentElementPayload` is the follow-up.
