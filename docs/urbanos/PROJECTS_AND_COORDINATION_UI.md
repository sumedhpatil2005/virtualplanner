# Projects & Coordination and Reports workspaces (UI)

Branch `urbanos-city-planning-redesign`, worktree `uos-wt-proj`, 2026-11-13. Implements UX_ARCHITECTURE §2 (Projects,
Reports rows) and §6 on top of the backend in COORDINATION_AND_SUBSURFACE.md and PLANNING_WORKSPACE.md.
Labels: BROWSER-VERIFIED / UNIT-TESTED / UNTESTED. Status: IN PROGRESS (this file is updated at the end of the work).

## Model shown to the user
A project = one planning activity: purpose (description), status, study area, alternatives (attached scenarios /
versions, one "preferred"), proposal elements registered from an alternative (geometry + z range; null = UNKNOWN),
assessments (feasibility screenings, investigation documents, simulation/ODME/emissions run records, coordination
runs; each with a stale indicator), datasets (traffic + subsurface with provenance), conflicts (cross-project, by
class), reviews & decisions (append-only; never a statutory approval), activity (append-only audit).
