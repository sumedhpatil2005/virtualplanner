# Underground planning workspace (UrbanOS, 2026-11-13)

Implements docs/urbanos/UX_ARCHITECTURE.md §2 and §7 (binding), PRODUCT_UX_RESEARCH §3, ENGINEERING_GIS_RESEARCH §E1–E4,
on top of the backend in COORDINATION_AND_SUBSURFACE.md. Worktree `uos-wt-ug`. Status labels: **BROWSER-VERIFIED**,
**UNIT-TESTED**, **UNTESTED**. Value labels: measured / estimated / hypothetical / unknown.

_Status: in progress — sections below are filled as each piece lands._

## 1. What it is (planning geometry only)
- An **underground alignment** (`CityObject` type `underground_alignment`): plan polyline on the ground, a crown depth per
  vertex (m below ground, + down; `null` = UNKNOWN) with a certainty per vertex (default **hypothetical**), a kind
  (bored tunnel / underground metro / cut-and-cover / utility trunk / storm drain) and a typical cross-section (circular
  diameter or box width × height, metres, `null` = UNKNOWN, certainty default hypothetical).
- **Ground is a flat datum.** The repo has no DEM (ENGINEERING_GIS_RESEARCH §E7), so depths are relative to "ground = 0",
  and the profile's ground line is labelled "no terrain data — UNKNOWN". Nothing here is a design, a structural check, a
  geology model, or a settlement assessment.
- Stored like every other city object: scenario copy-on-write, versions and Undo/Redo apply.
