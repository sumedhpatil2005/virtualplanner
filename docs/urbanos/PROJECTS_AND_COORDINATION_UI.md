# Projects & Coordination and Reports workspaces (UI)

Branch `urbanos-city-planning-redesign`, worktree `uos-wt-proj`, 2026-11-13. Implements UX_ARCHITECTURE §2 (Projects and
Reports rows) and §6 on top of the backend described in COORDINATION_AND_SUBSURFACE.md and PLANNING_WORKSPACE.md, following
PRODUCT_UX_RESEARCH §4.4 (project model, cross-project issues raised in both projects, stale badge, preferred star).
Labels: **BROWSER-VERIFIED** (built app, Chromium + SwiftShader, backend on a copy of twincity.db), **UNIT-TESTED** (vitest /
pytest), **UNTESTED**. All projects, scenarios and objects used in tests and screenshots are **SYNTHETIC** (named so).

## 1. What a project is in the UI
One project = one planning activity. Project list cards show name, status, study area, # alternatives, # proposal elements,
open conflicts (conflict + potential conflict with status *open*; "not checked" when no detection touches the project),
stale and stale-unknown assessments. A project page has tabs:

| Tab | Content (all real API calls) |
|---|---|
| Overview | purpose (description), status switch (draft/under study/under review), study area, baseline changed?, metric tiles with badges (elements: CertaintyBadge *unknown* when depth/height is missing; open conflicts: StaleBadge of the latest detection; assessments: TrustBadge *fails validation* when traffic runs are attached), report PDF/DOCX, all linked records (attach/detach any type) |
| Alternatives | attached scenarios; ★ preferred (PATCH `preferred_scenario_id`, audited; a working flag, not a decision); "Open & compare in Design" sets the active alternative and opens Design where the existing "Compare with base city" lives; **Add proposal elements** (§2); proposal element list (z range, width, certainty, fly-to, remove) |
| Assessments | feasibility screenings (+ generated investigation documents), simulation/ODME/emissions run records (each with TrustBadge fails_validation TAG M3.1), conflict-detection runs — every one with a StaleBadge from `/api/coordination/projects/{pid}/stale` (Stale + first reason / Current / **Stale: unknown** when inputs were not recorded) |
| Datasets | traffic datasets with provenance (provider, method, collection dates, entered by, file sha256, SYNTHETIC flag) and subsurface datasets (publisher, licence, data date, coverage — "UNKNOWN (absence of records proves nothing)") |
| Conflicts | run detection; findings grouped by class (conflict, potential conflict, vertically separated, unknown – no coverage); horizontal / vertical gap ("UNKNOWN", never 0); CertaintyBadge; permission triggers labelled "not an engineering clearance"; **"Shared with project X"** when the other side is a project (both projects see the same finding); Respond → Acknowledge / Resolve / Reopen with a required note (`PATCH /conflicts/{id}/status`), never edits either project; click / ⌖ flies the map to the element; Conflict summary CSV |
| Reviews & decisions | append-only decision record (unchanged form) with "Statutory approval: **No**" on every decision; reviews of attached screenings ("Approval: No") |
| Activity | append-only audit timeline (elements, detections, responses and exports appear here) |

Traffic Data Manager stays at Projects → Data (unchanged `TrafficDataPanel`, testid `open-traffic-data`).

## 2. Add proposal elements from an alternative
`lib/planningProjects.ts → draftsFromChangeSet` reads `GET /api/scenarios/{sid}/change-set` and maps each added/modified object
to `POST /api/coordination/projects/{pid}/elements` with `element_ref` (geometry resolved by the backend from the alternative
head, or from a chosen version). z is metres relative to ground, up positive; **null = UNKNOWN**; certainty *hypothetical*
(design inputs), *unknown* when no z is known. Mapping: road → top 0, bottom UNKNOWN; flyover / double-deck → bottom = design
`elevation`, top UNKNOWN (deck thickness, piers, foundations not modelled); metro line → metro_viaduct, bottom = elevation;
station → elevation … elevation+height; utility → top = −depth, bottom = −(depth+diameter) only with a diameter, depth
placeholder (`depthCertainty: unknown`) → both UNKNOWN; building → top = height, foundation UNKNOWN; width from the object or
UNKNOWN. Not registered: deletions, demand zones, gateways, junction edits, objects already registered. The basis for each
value is shown under "Technical details" before confirming.

## 3. Reports workspace
Catalogue (each entry: scope, inputs, validation status, last generated; every button real):
planning project report PDF/DOCX (`GET /api/planning/projects/{id}/report`), **conflict summary CSV** (new, below), Investigation
Requirements Document PDF/DOCX per saved screening (generate + download; stale badge per screening), scenario traffic report
listed as not available (no run wired) with the TAG M3.1 badge. "Last generated" = newest `export` audit event with that label
(`lib/planningReports.ts`) or the newest generated document.

## 4. Backend additions (small, additive, pytest)
- `planning_projects.preferred_scenario_id` (nullable; added to existing DBs by `database/migrations.py`, idempotent);
  `PATCH /api/planning/projects/{id}` accepts it (must be an attached scenario; `''` clears; audited as a project update; does
  not change status).
- `GET /api/coordination/projects/{pid}/conflicts/export?format=csv&requested_by=` — CSV of the findings visible to the project
  (disclaimer line, class, status + note, distances with empty = UNKNOWN, certainty, permission triggers, reasons, stale verdict);
  recorded as an `export` audit entry with the file's sha256.
- Tests: `backend/tests/test_projects_workspace.py` (4).

## 5. Files
`frontend/src/components/PlanningPanel.tsx` (list + new project; exports and all testids/aria-labels kept),
`components/projects/{common.tsx, projectData.ts, ProjectList.tsx, ProjectPage.tsx, OverviewTab.tsx, AlternativesTab.tsx,
ConflictsTab.tsx, RecordsTabs.tsx}`, `lib/planningProjects.ts`, `lib/planningReports.ts`, `lib/planningClient.ts`,
`engine/planning/planningApi.ts` (+`setPreferred`, `preferred_scenario_id`), `shell/contexts/ReportsContext.tsx`,
`engine/testing/ProjectsWorkspace.test.ts`.

Preserved: every PlanningPanel testid (`planning-user, new-project, project-name, project-desc, create-project, open-project,
project-status, project-links, link-type, link-record, attach, decision, decision-text, decision-version, record-decision,
export-pdf, export-docx, audit-timeline`) and aria-label (`Planning projects`, `Detach`, `Record type`, `Record`, `Decision`,
`Role`, `Organisation`, `Scenario version`, `Project status`). **Change for harnesses:** they now live in tabs — links,
status, export: Overview; decision: Reviews & decisions (`ptab-decisions`); audit: Activity (`ptab-activity`). Reports keeps
`reports-catalogue`, `report-project-{pdf|docx}-<id>`, `report-ird-{pdf|docx}-<id>`.

## 6. Verification (2026-11-13)
- `npx tsc -p tsconfig.app.json --noEmit`: 0 errors. `oxlint src`: 0 errors, no warnings in new/changed files. `vite build`: OK.
- vitest **UNIT-TESTED**: `engine/testing/ProjectsWorkspace.test.ts` 10 pass (element mapping incl. UNKNOWN depth, skips,
  conflict grouping / open counts / other-side labels, stale UNKNOWN ≠ current, card summary, bounds, last-export);
  HonestControls + StartupTest still pass (no vitest covered PlanningPanel before).
- pytest **UNIT-TESTED**: `test_projects_workspace.py` 4 pass; full backend suite 115 passed, 3 skipped.
- **BROWSER-VERIFIED** (`/workspace/work/uos-proj-e2e/proj_check.py`, backend copy on :8316, static build on :4516):
  1440×900 — create project A, attach SYNTHETIC alternative A, ★ preferred, register 2 elements (flyover: bottom +6.5 m / top
  UNKNOWN; station +12…+20 m); create overlapping project B, attach alternative B, register 2 elements, run detection →
  classes conflict ×1, potential ×5, vertically separated ×2, unknown-no-coverage ×2; acknowledge the conflict with a note;
  project A shows the same findings as "Shared with project …" (3 rows); record a decision ("Statutory approval: No");
  Assessments, Datasets, Activity, Data (Traffic Data Manager) tabs; project PDF 200 application/pdf (35.8 kB), DOCX 200,
  conflict CSV 200 text/csv with disclaimer; Reports "Last generated" updated after the exports. 1024×768 — cards, overview,
  alternatives, conflicts, decisions, reports; fly-to: camera moved from (73.857, 18.520, 1500 m) to (73.777, 18.564, 576 m)
  = the finding's location. No horizontal overflow in the context panel at either size.
  Screenshots (viewed): `/workspace/work/urbanos/shots/after/projects-*-{1440x900,1024x768}.png`, `reports-*.png`.
  The fly-to screenshot itself timed out under SwiftShader (render-on-demand harness), so fly-to is verified by camera
  position, not by image. Console errors seen: blocked fonts / Cesium ion 401 (sandbox) and a minified "kre" message (not traced).

## 7. Not done / UNKNOWN
- Compare of alternatives inside the project (swipe / metric delta table) is not built; "Open & compare in Design" reuses the
  existing base-city comparison.
- Locks for alternatives in review/decided (PUX §4.4) not implemented.
- Investigation documents cannot be generated from the project page (they are in Reports and the Feasibility panel).
- Fly-to for findings whose side A is another project's element uses `GET /elements/{id}` (read only).
