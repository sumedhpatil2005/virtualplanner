# Design tools & honesty badges (UrbanOS — tools agent, 2026-11-13)

Implements docs/urbanos/UX_ARCHITECTURE.md §3–4 (binding), CODE_UI_AUDIT §1.2/§3/§6 findings 1, 3, 6 and PRODUCT_UX_RESEARCH §2.3/§5.7.
Not touched (shell agent's scope): App.tsx, index.css, shell layout, tokens.css. All colours are `var(--token, fallback)` using the PUX §5.1 token names (`--fail`, `--warn`, `--measured`, `--estimated`, `--hypothetical`, `--unknown`, `--accent`, `--surface-1..3`, `--border(-strong)`, `--text-1..3`).

## 1. Honesty components — `frontend/src/components/ui/badges/` (UNIT-TESTED, BROWSER-VERIFIED in harness)
| Component | Values | Rules enforced |
|---|---|---|
| `CertaintyBadge` | measured · estimated · hypothetical · unknown | own icon per level (CircleCheck / Sigma / CircleDashed / CircleQuestionMark) so it reads without colour; hypothetical has a dashed border. `formatOrUnknown()` / `certaintyOf()` turn missing/NaN into "Unknown", never 0. `certaintyFromProvenance(undefined)` = unknown (not estimated). |
| `TrustBadge` | fails_validation · not_validated · stale · validated | `fails_validation` renders "Fails validation (TAG M3.1)" as a button opening the recorded results (not dismissable). Others are plain labels. |
| `DataStatus` | available (source, date, licence, url?) · not_imported | not imported = "Not imported · UNKNOWN"; a blank source/date/licence shows "unknown". |
| `ModelTrustPill` | — | top-bar pill "Traffic model fails validation" → popover `ValidationSummary`. For the shell to mount in the top bar. |
| `ValidationSummary` | — | table from `validationSummary.ts`, copied from docs/ENGINEERING_VALIDATION.md §5.0 (code c916854): counts GEH<5 0/15 (mean 32.3), flow criterion 0/15, river screen line 54,493 vs 78,357 (−30.5%), section speeds 4/21, corridor-hour 27/120, city speed 2/9 — all FAIL; criteria link UK DfT TAG M3.1 (May 2026) https://assets.publishing.service.gov.uk/media/6a033d074fb0713aa63ea802/tag-m3-1-highway-assignment-modelling.pdf. Recorded values: update only when that document is re-run. |
| `ui/AnchoredPopover` | — | portal, fixed position, viewport-clamped, flips side/above; used by badges and the palette. |
`Certainty` type lives in `engine/objects/certainty.ts` (engine must not import components); badges re-export it.

## 2. Where "Fails validation (TAG M3.1)" is now shown (UNIT-TESTED for headline/KPIs; others UNTESTED in browser)
Simulate headline `StatusHeader` (`trust-headline`), KPI block `WorstKpis` (`trust-kpis`), "Through the day" (`trust-timeline`), ODME card (`trust-odme`), `EmissionsCard` ("Traffic input fails validation", `trust-emissions`), generator comparison (`trust-generator`).
- "3/3 runs agree" → **"Run-to-run stability 3/3"**, tooltip says it is stability of the simulation, not accuracy (test updated to the new label and asserts the tooltip; not weakened).
- ODME card: green "within limits"/"ok" made neutral (PUX §5.7: no green on traffic-derived outputs).
- Stale texts fixed: TrafficDataPanel "Calibration … not implemented yet" → calibration datasets can adjust demand (ODME / Calibrate demand) and are never reported as validation evidence; header "Evidence for checking the model, never demand" → "Validation counts check the model; Calibration counts can adjust demand"; generator "n/a: no emissions model in this build" → "n/a: that run produced no value for the metric (fuel and CO₂: no emissions result in that run)" + comparison-only note.

## 3. Tool palette — `frontend/src/components/design/ToolPalette.tsx` (default export; BROWSER-VERIFIED in harness)
- `tools.ts`: each tool has `category`, `shortLabel` (`short` kept = same), `icon`, `description`, `status: 'available'`; `TOOL_CATEGORIES`, `toolsInCategory()`. EditingMode ids and hotkeys 1–9 unchanged.
- Groups (§3 order): Select · Roads & lanes (Road/Route) · Junctions & signals (Junction/SquaresIntersect) · Grade separation (Flyover/Spline, Double-deck/Rows2) · Transit (Metro line (elevated)/TrainFront, Station/CircleDot) · Underground (Utility/Cable) · Land & demand (Building/Building2, Demand zone/Shapes, Gateway/DoorOpen) · Data (Import area (OSM)/Download). No Compass/Layers/Hammer/Settings and no shared icons (tested). Bridge/tunnel/BRT/drain absent (no mode behind them).
- Labels: verb + noun in tooltip/aria-label ("Draw road", "Import area (OSM)"); hotkey + description in the tooltip.
- Collapsible groups (collapsed group shows its tool count; a group containing the active tool re-opens), active state (accent border + `aria-pressed`), undo/redo, `OPEN_TOOLBAR_EVENT` expands all groups.
- Settings open in an `AnchoredPopover` beside the palette, top-aligned to the active tool, max-height = viewport, own scroll: never over another group, never clipped by the panel (fixes AUD §3 overlap/clipping). Click the active tool again or × / Esc to hide.
- Shared with the legacy `Toolbar.tsx` (still mounted by App.tsx until the shell swaps): `design/ToolSettings.tsx` (per-tool fields) and `design/ImportAreaPanel.tsx` (OSM import UI + name dialog moved verbatim from Toolbar; `ImportProgressOverlay`). Both bars carry `data-testid` `tool-<mode>`, `tool-settings`, `tool-undo`, `tool-redo` and `data-coach="toolbar"`. Mount only one bar at a time (each mounts one `ImportProgressOverlay`).
- **Harness break to note:** old harness steps click `button[aria-label^='Draw Area and Map']` (vp-ux2-e2e/steps_*.json). Use `[data-testid=tool-import_osm]` or `aria-label="Import area (OSM)"`.

## 4. Honest tool defaults (EditingEngine; UNIT-TESTED)
- Building: floors = tool input `buildingFloors` (default `DEFAULT_BUILDING_FLOORS` = 4, clamped 1–200), height = floors × 3 m; **no Math.random**. Object gets `valueCertainty` {floors, height, population, parkingSpaces, waterDemand, electricityDemand: 'hypothetical'}; inspector shows the badge. (Population = floors×15 etc. unchanged formulas, now labelled hypothetical.)
- Demand zone: residents/jobs from tool inputs (defaults 10,000 / 5,000, shown HYPOTHETICAL); `provenance.source = 'hypothetical'`, `confidence = 0` (was 'estimated' 0.8). `DemandSourceType` and zone/gateway provenance unions gained `'hypothetical'` (sourceOf already mapped it; nothing else reads `provenance.source` for logic — grep). Inspector ProvenancePicker gained "Hypothetical".
- Gateway: now gets `provenance {source:'hypothetical', confidence:0}` (had none); snap distance is ground metres (equirectangular) with `GATEWAY_SNAP_M = 440` — keeps the old ≈0.004° behaviour; message "within 440 m of a road node" matches (was "300m"). Test: 442 m rejected, 420 m accepted.
- Utility: type adds **Gas** (the `gas_util` "Gas Mains" layer and `UtilityType 'gas'` already existed; the tool just didn't offer it), depth input (default 1.5 m), `depthCertainty` (default hypothetical; measured/estimated/unknown selectable), `diameterMm` (blank = null = unknown, never 0). Inspector edits all three. Layer "Zoning Map" renamed "Demand zones (traffic)".

## 5. Verification
- `npx tsc -p tsconfig.app.json --noEmit`: clean. `oxlint src`: 0 errors, 7 warnings (all pre-existing). `tsc -b && vite build`: EXIT 0.
- vitest (one file at a time): HonestyBadges 8/8 (new), DesignTools 7/7 (new), HonestControls 20/20 (+3), ZoningWorkflow 6/6 (assertions added), RoadAnalysisPanelPieces 16/16, TimelineStalePanel 3/3, ScenarioPanelPieces 8/8, EditingWorkflow 9/9, StudyAreaImport 12/12, MapSelectedArea 17/17. Full suite not run (shared CPU).
- Browser (BROWSER-VERIFIED, Chromium headless, harness page mounting ToolPalette + badges in a 320 px scrolling column; harness kept outside the repo at /workspace/work/urbanos/tools-e2e/{palette-harness.html,paletteHarness.tsx,palette.py}, results palette-results.json): at 1440×900 and 1024×768, for Road/Utility/Building/Import area the settings popover is inside the viewport and does not intersect the palette; group collapse, Select hides settings, pill popover contains 0/15, −30.5%, 4/21, 27/120, 2/9; no page errors. Shots: /workspace/work/urbanos/shots/after/tools-{1440x900,1024x768}-{01-palette,draw_road,draw_utility,draw_building,import_osm,trust-pill,trust-badge}.png.
- UNTESTED in browser: the legacy Toolbar in the running app, the TrustBadges inside the real Simulate panels (unit-rendered only), OSM import end-to-end from the palette (code moved verbatim; StudyAreaImport/MapSelectedArea engine tests pass).

## 6. Deviations / not done
- PropertiesPanel not split (not needed); only utility/building fields added.
- Station icon CircleDot (spec offered TrainTrack/CircleDot); Double-deck icon Rows2 (spec gave none; Layers/Hammer avoided).
- Demo/seed objects with `confidence 0.8` in TwinCityEngine Hinjewadi seed are untouched (outside the tool defaults).
