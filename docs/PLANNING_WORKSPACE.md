# Planning & Approval Workspace (foundation)

Mission §14 (authority-ready planning and documentation workspace), §10 (review history; "reviewed" ≠ approval), §15 module 8,
§22 principles. Branch `urban-mobility-platform`, worktree `um-ws`. Date: 2026-11-11.

Labels: **UNIT-TESTED** (pytest), **BROWSER-VERIFIED** (built app in headless Chromium against a copy of the project
database), **UNTESTED**, **CODE-READ**. All data used in tests and the browser check is **SYNTHETIC** and labelled so.

> A "decision recorded" in this tool is a *planning decision recorded in this tool* by a named, self-declared person.
> It is **not** an engineering assessment and **not** a statutory approval, sanction or permit. No project status, review
> status or decision field means approval. The tool has no authentication: every actor name is self-declared.

## 1. What it is

A **planning project** groups the records that answer one planning question: the baseline network (by fingerprint),
proposal scenarios and their versions, simulation run records, traffic datasets, and feasibility assessments (with their
investigation documents, evidence and reviews). It adds three things that did not exist: the project itself, a decision
record, and one append-only **audit log** for every important record type. A project report (PDF / DOCX) is generated
from these records.

**No duplicate state.** A project *references* existing rows through links; it never copies scenarios, datasets or
assessments. Reviews, evidence and documents stay in the feasibility tables (`fs_*`), counts in `td_*`, versions and runs
in `scenario_versions` / `scenario_runs`. The report reads them at export time.

## 2. Data model (additive tables, `backend/planning/models.py`)

| Table | Content |
|---|---|
| `planning_projects` | id, name, description, optional `area_id` (existing `areas` row) and bbox, `baseline_id` ('base'), `baseline_fingerprint` at creation (same sha256 as scenario versions use), status, created_by/at, updated_at |
| `planning_project_links` | project_id, entity_type ∈ {scenario, scenario_version, run, dataset, assessment}, entity_id, note, added_by/at; unique per (project, type, id). One table for the three link kinds the brief names (plus versions and runs); the API checks the target exists. |
| `planning_decisions` | **append-only**: seq, decision text, decided_by, role, organisation, scenario_id + scenario_version_id (the version must belong to a scenario attached to the project), evidence refs `[{type,id}]` (evidence, review, document, assessment, dataset, run, scenario_version; each must exist), supersedes (a new decision supersedes the previous one by reference) |
| `audit_log` | **append-only**: at, actor, actor_source, action (create / update / delete / export), entity_type, entity_id, parent_type/id, label, changed_fields (updates), before_hash, after_hash (sha256 of the row's column values) |

Project status vocabulary: `draft`, `under_study`, `under_review`, `decision_recorded` ("Decision recorded (in this tool;
not a statutory approval)"). There is no `approved` value. `decision_recorded` is set only by recording a decision; PATCH
can move a project back to study/review (audited).

Append-only is enforced twice: SQLAlchemy `before_update` / `before_delete` listeners raise, and SQLite triggers
(`audit_log_no_update/_no_delete`, `planning_decisions_no_update/_no_delete`) abort any UPDATE/DELETE, including bulk SQL
that bypasses the ORM. Limitation: someone with direct file access can drop the triggers; there is no hash chain or
external anchoring yet.

## 3. Audit log: how it is written

`backend/planning/audit.py` registers SQLAlchemy **session events** once (imported by `main.py`). Every router's writes go
through a session flush or an ORM bulk statement, so the existing routers were **not edited**:

| Event | Captures |
|---|---|
| `before_flush` | updates (before values from attribute history, changed fields, skipped if no column changed except `updated_at`) and deletes |
| `after_flush_postexec` | creates (after the INSERT, so autoincrement ids and defaults are in the hash) |
| `do_orm_execute` | ORM bulk DELETE/UPDATE (`query(...).delete()`, e.g. a scenario's versions and change set on scenario delete, the change-set replacement on restore): each affected row is read as plain values first (not loaded as entities) |
| `before_commit` | resolves actors and inserts the entries in the same transaction (a rollback discards them) |

Tracked record types: scenario, scenario_change (a proposal's modify/tombstone), scenario_version, run, dataset,
count_record, pcu_set, vehicle_class, assessment, evidence, document, review, project, project_link, decision, plus an
explicit `project_report` / `export` entry for every report download (with the file's sha256). Not tracked: `city_objects`
rows (the baseline import writes tens of thousands; a proposal's own added objects are therefore only visible through
scenario versions) and `areas`.

**Actor** (`actor_source` says which): `header` — the client sent `X-Actor` (middleware in `main.py`); `request_field` —
the request's who-field (`edited_by`, `removed_by`, `decided_by`, `requested_by`); `td_audit` — the traffic-data
router's own audit row for the same entity in the same transaction (so a dataset PATCH by "Editor C" is attributed to
Editor C, a dataset delete to `deleted_by`); `record_field` — only for creates, the record's own who-field
(`created_by`, `entered_by`, `uploaded_by`, `reviewer_name`…); otherwise `unattributed`. A record's who-field names its
creator, so it is never used for an update or delete. The existing scenario/object endpoints carry no actor, so their
entries are `unattributed` unless the client sends `X-Actor` (the current frontend does not yet).

`td_audit_log` (traffic data, with before/after JSON) is kept as it was; `audit_log` is the single cross-module log and
stores hashes, not copies.

## 4. API (`/api/planning`, `backend/api/planning_router.py`)

| Endpoint | Behaviour |
|---|---|
| `GET /status-vocabulary` | statuses with labels, `decision_kind_label`, `has_approved_status: false` |
| `GET/POST /projects`, `GET/PATCH /projects/{id}` | create records the baseline fingerprint; GET adds the current fingerprint, `baseline_changed_since_created`, links (with a label and `exists`), decisions, area. PATCH needs `edited_by`; status ∈ draft/under_study/under_review only |
| `POST /projects/{id}/links`, `DELETE /projects/{id}/links/{link}?removed_by=` | attach (422 if the record does not exist, 409 if already attached); detach removes only the link |
| `GET /linkable` | existing scenarios, versions, runs, datasets, assessments to choose from |
| `POST/GET /projects/{id}/decisions` | see §2; response has `kind: planning_decision_recorded_in_tool`, `is_statutory_approval: false`, `is_engineering_assessment: false` |
| `GET /projects/{id}/audit` | timeline: events of the project, its links and decisions, every attached record, and their children (versions/runs/changes of an attached scenario, records of an attached dataset, reviews/evidence/documents of an attached assessment) |
| `GET /audit?entity_type=&entity_id=` | the global log (entity or parent id) |
| `GET /projects/{id}/report?format=pdf\|docx&requested_by=` | the report (§5); response header `X-Report-SHA256`; an `export` audit entry |

## 5. Project report

`backend/planning/report.py` builds one document model and renders it with the feasibility module's renderers
(`feasibility/docgen.py`: python-docx, fpdf2 — no new dependency; the only change there is optional header/disclaimer/
template fields on `DocModel`, defaulting to the investigation document's text). Header and footer on every page:
"Planning project report from records in this tool. Not an engineering assessment, statutory approval, sanction or
permit." A boxed disclaimer follows the title. Sections:

1. Project summary (status with the "no status means approval" note). 2. Baseline (fingerprint at creation vs now; flag
if changed). 3. Traffic datasets with **provenance labels** (Measured / Estimated / Manual, "+ SYNTHETIC (test/demo data,
not an observation)"), source, method, collection dates, period, role, PCU set + version, record count, import file hash.
4. Scenarios: versions (change count, change-set hash, on current baseline or not, key frozen assumptions) and each run's
frozen inputs. 5. **Comparison results read from run records**: each proposal run is paired with the latest baseline run
recorded before it; metrics (network flow veh/h, mean travel time s, mean delay s, completed trips) with difference and
the label "model output"; "FAIR comparison" only when both runs share the baseline fingerprint and every fairness-critical
input (`scenario_router.FAIR_KEYS`) matches, otherwise every differing input is listed. Comparisons made by the
scenario-comparison module are not read yet (that module is being built separately; when it stores comparison records,
the report should read them instead of pairing runs). 6. Feasibility findings with **certainty labels**, flags, counts
of investigations and data gaps. 7. Investigation documents and evidence (provenance, hashes). 8. Reviews (status labels,
"no review status means approval"). 9. Decision record with the decision-kind statement. 10. Assumptions (from datasets'
stated assumptions/adjustments) and unknowns (missing datasets/comparisons/assessments, estimated data, unversioned
scenarios, data gaps, unknown site attributes, changed baseline, self-declared actors). 11. Audit trail summary (counts
by entity × action, latest 25 events).

A missing item is stated as missing ("No comparison result is present…"), never filled.

## 6. UI

"Planning projects" pill under "Traffic data" (top-left; `App.tsx`: 1 import, 1 state, 1 panel branch, 1 button) opens
`components/PlanningPanel.tsx` (client `engine/planning/planningApi.ts`): your name (shared with the traffic-data panel,
self-declared), new project (name, description, optional study area), project list with status badges; a project view
with facts (creator, area, baseline changed or not), status switch, attached records (type + record pickers; detach),
decision record (warning notice, text, role, organisation, scenario version of an attached scenario, evidence checkboxes
for attached assessments/datasets/runs; recorded decisions shown as "Planning decision recorded in tool — not a statutory
approval"), report PDF/DOCX download, audit timeline (newest first, actor and actor source).

## 7. Tests and verification

`backend/tests/test_planning.py` — UNIT-TESTED (8 tests; full backend suite 100 passed, 2 skipped):
- audit entries written on create/update/delete for scenarios, scenario changes, versions, runs, datasets (incl. delete with
  its records), count records (create/delete), assessments, evidence, reviews; bulk deletes on scenario delete; hashes
  differ before/after; actor attribution incl. `td_audit` and `X-Actor` header; unattributed when nobody is named;
- append-only: ORM update/delete raise, raw `UPDATE`/bulk delete refused by the trigger, no PUT/PATCH/DELETE routes;
- links: attach/409/422, timeline includes later activity on attached records and excludes unrelated ones, status change
  audited with editor, `decision_recorded` and `approved` refused by PATCH, detach keeps the record;
- decision ≠ approval: vocabulary has no approved status, version must belong to an attached scenario, evidence refs
  must exist, response flags, append-only, supersedes chain;
- report: DOCX and PDF (pdftotext) contain the disclaimer, header, Measured + SYNTHETIC, Estimated, model output, FAIR
  comparison, certainty labels, "Reviewed — not an approval", decision wording, run numbers with difference (1,200 /
  1,150 / -50), and never the word "approved"; empty project states each missing item;
- migration on a **copy** of `twincity.db` run twice: every pre-existing table's rows identical (original columns), new
  tables empty, triggers present and effective. The original file was never opened for writing.

Browser verification: §8.

## 8. Browser verification

(see below; filled in after the run)

## 9. Limits / not done

- No authentication; actors are self-declared. The existing scenario/object endpoints carry no actor (entries
  `unattributed` unless `X-Actor` is sent; the frontend does not send it yet).
- No hash chain / external anchoring of the audit log; the SQLite triggers can be dropped by someone with file access.
- `city_objects` writes are not audited (volume); proposal-added objects are covered only through scenario versions.
- Comparison results come from pairing run records; stored comparison records from the comparison module are not read.
- No per-project permissions, no sign-off workflow, no document upload at project level (evidence stays on assessments).
- Report numbers are what the records hold; the report does not re-run or re-validate anything.
