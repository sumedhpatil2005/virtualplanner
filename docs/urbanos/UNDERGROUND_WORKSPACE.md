# Underground planning workspace (UrbanOS, 2026-11-13)

Implements docs/urbanos/UX_ARCHITECTURE.md §2 and §7 (binding), PRODUCT_UX_RESEARCH §3, ENGINEERING_GIS_RESEARCH §E1–E4,
on top of the backend in COORDINATION_AND_SUBSURFACE.md (no backend change). Worktree `uos-wt-ug`. Status labels:
**BROWSER-VERIFIED** (Chromium + SwiftShader against a local backend on a copy of twincity.db), **UNIT-TESTED** (vitest),
**UNTESTED**. Value labels: measured / estimated / hypothetical / unknown. All test geometry and records are **SYNTHETIC**.

## 1. What it is (planning geometry only)
- **Underground alignment** — new `CityObject` type `underground_alignment` (`engine/objects/types.ts`): plan polyline on the
  ground, `depths[i] = { crownDepthM, certainty }` per vertex (m below ground, + down; `null` = UNKNOWN, never 0), kind
  (bored tunnel · underground metro · cut-and-cover · utility trunk · storm drain), typical section (circular outer
  diameter, or box width × height; m; `null` = UNKNOWN) with its own certainty.
- **Ground is a flat datum.** The repo has no DEM (ENGINEERING_GIS_RESEARCH §E7), so depths are relative to "ground = 0" and
  the profile's ground line says "Ground = flat datum 0 m · no terrain data — UNKNOWN". Not a design, structural check,
  geology model or settlement assessment.
- Stored like every other city object (ObjectManager): scenario copy-on-write, versions (change sets) and Undo/Redo apply;
  backend rows carry depths/section in `properties` (no backend change needed).

## 2. Files
| Path | What |
|---|---|
| `engine/underground/alignmentGeometry.ts` | pure: chainage, long-section (crown/invert/gradient), crown depth at a chainage (interpolated only between two known vertices), plan crossings with other model objects and their vertical extent (road structure, pier foundations, basements = UNKNOWN), cross-section at a chainage, coordination element payload |
| `engine/underground/alignmentFactory.ts` | drawing defaults per kind (**placeholders, not standards**, stored HYPOTHETICAL), `buildAlignment`, `withVertexDepth/withAllDepths/withSection/withKind` |
| `engine/underground/sectionLayout.ts` | pure SVG layout for Profile and Cross-section |
| `engine/underground/UndergroundView.ts` | globe state: `translucency.enabled/frontFaceAlpha/backFaceAlpha/rectangle`, `undergroundColor`, `depthTestAgainstTerrain`, `enableCollisionDetection=false`; `leave()` restores exactly what `enter()` found |
| `engine/underground/UndergroundRenderer.ts` | Cesium entities (own CustomDataSources): alignment = `polylineVolume` (circle/box of the entered size) at −(crown + h/2); runs with UNKNOWN depth = grey dashed line on the surface; unknown size = dashed line at crown depth; paler when hypothetical; plan trace on the surface; records: utility line at −depth (or dashed on surface when depth UNKNOWN), borehole stick to final depth |
| `engine/underground/viewRect.ts` | lon/lat box around alignments ("Only around alignments") |
| `engine/editing/EditingEngine.ts` | new mode `draw_underground` (no snapping to the surface network) + tool settings |
| `components/tools.ts` | tool "Draw underground alignment" (Tunnel, `TrainFrontTunnel`, category Underground, no hotkey) |
| `components/underground/*` | `AlignmentForms` (tool settings + profile editor table), `SectionViews` (Profile/Cross-section SVG), `SubsurfaceRecords` (list + AGS4/CSV/JSON import), `ConflictCheck`, `ViewControls`, `undergroundStore`, `useSubsurfaceRecords`, `conflictClasses`, `common` |
| `shell/contexts/UndergroundContext.tsx` (+ `.runtime.ts`, `.tabs.tsx`) | context panel; runtime wiring (view on enter/leave workspace, renderer on object/alternative/selection change); drawer tabs |

Small edits outside owned files: `AppShell.tsx` (one import + `underground: UNDERGROUND_DRAWER_TABS` in the existing
`DRAWER_TABS` registry; layout untouched), `ToolSettings.tsx` (one branch → `UndergroundToolSettings`), `Viewport3D.tsx`
(HUD text for the new mode), `TwinCityEngine.ts` (rubber-band/preview clamp-to-ground includes the new mode),
`builtBy.ts` (type label), `DesignTools.test.ts` (expected tool list includes `draw_underground`; no assertion removed).

## 3. Workspace (context panel + drawer)
- **View**: Ground opacity slider (0–100 %, default 35 %), X-ray (forces ≤ 50 % and turns the terrain depth test off),
  "Only around alignments" (translucency rectangle = alignments' bbox + 300 m). Entering Underground saves and applies;
  leaving restores (BROWSER-VERIFIED: before `{translucent:false, front:1, collision:true}` → in `{true, 0.35, false}` → after
  leaving identical to before).
- **Underground alignments**: list (kind, plan length, deepest known depth, count of UNKNOWN depths, worst certainty);
  "Draw an alignment" sets the real `draw_underground` mode.
- **Profile editor**: type, section (shape, dimensions; blank = UNKNOWN), section certainty, "Set all vertices", and a table
  per vertex: chainage, grade to next vertex (or "grade ?"), crown depth (blank = UNKNOWN), certainty. Every edit is one
  Undo step (`history.recordUpdate` + `objects.update`, coalesced per field while typing).
- **Drawer tabs**: *Profile* — chainage vs depth, ground line labelled UNKNOWN, crown→invert band per run of known vertices
  (dashed when hypothetical), "?" marker per UNKNOWN vertex (never interpolated across), crossing markers for every model
  object crossed in plan (baseline roads, flyovers/metro decks, buildings, drawn utilities, other alignments; dotted when the
  object's depth extent is UNKNOWN, solid bar when known), click sets the section chainage. *Cross-section* — chainage
  slider, ± window, own structure (ellipse/box; "position UNKNOWN here" when depth or size missing), objects cut by the
  section line with their extents. *Utility table* (existing).
- **Subsurface records**: datasets (publisher, licence, data date, stated coverage, sha256, warnings) and records
  (ASCE 38 QL chip — QL-A/B/C/D or "QL ?" — and depth certainty; only QL-A is measured, per the backend); empty state
  "No records imported · Unknown — absence of records is not absence of utilities"; import form (AGS4 subset / CSV
  template / JSON, file sha256 + provenance recorded by the backend, optional stated coverage bbox). Records are drawn in 3D.
- **Conflict check**: choose a planning project + your name → the alignment is registered (or PATCHed if already
  registered — matched by `provenance` "alignment <id> ") as a proposal element with `alignmentElementPayload` (z relative to
  ground, up positive; per-vertex profile; width; worst certainty), then `POST /detect`. Findings for this element are shown
  by class badge: Conflict · Potential conflict · Vertically separated · **No conflict within available data** · **Unknown —
  no data coverage** (never "clear"), with plan distance, vertical gap (or Unknown), certainty, reasons and NOC permission
  triggers ("permission trigger, not an engineering clearance"). A note appears when the alignment was edited after the check.

## 4. Verification
- `npx tsc -p tsconfig.app.json --noEmit`: clean · `oxlint src`: 0 errors, 7 warnings (all pre-existing) · `tsc -b` +
  `vite build`: exit 0.
- **UNIT-TESTED** `engine/testing/UndergroundWorkspace.test.ts` (12): profile chainage/crown/invert/gradient; UNKNOWN depth
  stays null, not interpolated, not placed below ground; blank section → invert / z_min / width UNKNOWN; crossings with model
  objects (road depth UNKNOWN, utility extent from depth + diameter); cross-section offsets and side; own structure UNKNOWN
  where depth unknown; element payload (z convention, worst certainty, provenance); persistence: drawn in a proposal only,
  Undo/Redo of depth edits, delete + undo, baseline and other proposal byte-identical; baseline alignment edited in a
  proposal is copy-on-write; backend schema round trip; globe view enter/X-ray/opacity/rectangle/leave restores exactly.
- Existing, one at a time: ScenarioIsolation 10/10, EditIsolation 2/2, EditingWorkflow 9/9, HonestControls 20/20,
  DesignTools 7/7.
- **BROWSER-VERIFIED** (`/workspace/work/uos-ug-e2e/ug_check.py`, results `r_both.json`) at 1440×900 and 1024×768: enter
  workspace, draw a 3-vertex tunnel (1.59 km), set vertex 2 = 22 m estimated and vertex 3 blank (UNKNOWN), opacity 30 % +
  X-ray, Profile (11 crossings, 1 UNKNOWN marker, ground line), Cross-section at 25 %, CSV utility import with stated
  coverage (1440), conflict check (14 potential conflicts with baseline roads — road depth UNKNOWN — and 1 "no conflict
  within available data" for the covered utility layer), leave → globe restored. No horizontal overflow in the panel.
  Screenshots `/workspace/work/urbanos/shots/after/underground-<WxH>-0[1-6]-*.png` (viewed; 1024 has no 05-records, the
  import was exercised at 1440). 3D: `underground-alignments` data source holds the `polylineVolume` + UNKNOWN-span line +
  plan trace; the buried tube and an imported utility record at −3 m are visible in 02/04/05. The 1024 run reused the DB of
  the 1440 run, so its findings include "Other project" potential conflicts (cross-project detection seen working).
- Shell observation (not changed, AppShell layout is not mine): at 1024×768 the context panel overlays the drawer's tab
  strip; the drawer tabs are reachable only after collapsing the panel (harness does this).
- Sandbox limitation: Cesium globe tiles never render here (ion imagery 401 → `globe._surface._tilesToRender = 0`), so
  `globe.pick` returns nothing and **mouse clicks cannot place points in this sandbox for any drawing tool**. The harness
  converts screen points with `camera.pickEllipsoid` and calls `editing.addDrawingPoint` / `finalizeDrawing` — the same
  calls the LEFT_CLICK / LEFT_DOUBLE_CLICK handlers make. The click path itself is **UNTESTED** here; the visual effect of
  translucency on imagery is likewise not visible (no imagery), only the globe state is verified.

## 5. Not done / UNKNOWN
- No terrain ground line (needs an imported DEM, EGR §E7). No cutaway/clipping polygon, no depth-filter slider (PUX §3.3
  items 2–3 beyond opacity/X-ray). Boreholes are not projected onto the long-section. Records are not shown in the profile.
- Vertex depths are edited in the table, not by dragging in the SVG. Plan vertices are edited by redrawing (no vertex drag).
- No engineering clearances are pre-filled (none cited); conflict results are screening only. OSM metro and road structure
  depths are UNKNOWN, so most crossings are "Potential conflict" by design.
- Phone (<768) layout not checked for the new panels.
