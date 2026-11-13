# UrbanOS — application shell, design system and navigation

Implements docs/urbanos/UX_ARCHITECTURE.md §2 and §5 (binding), using PRODUCT_UX_RESEARCH.md §1, §2, §5, §6 and
CODE_UI_AUDIT.md §1.1, §4. Status labels: **BROWSER-VERIFIED** (seen in Chromium/Playwright against a local backend),
**UNIT-TESTED** (vitest), **UNTESTED**.

## 1. Files

| Path | What |
|---|---|
| `frontend/src/styles/tokens.css` | Design tokens as CSS variables. Dark is the default (`:root`), light is `:root[data-theme="light"]`. Mapped to Tailwind v4 utilities with `@theme inline` (e.g. `bg-surface-1`, `text-text-2`, `text-fail`, `text-label`, `text-metric`, `rounded-ui-md`, `shadow-float`). Existing Tailwind names (`rounded-lg`, spacing) are not overridden, so existing components render as before. |
| `frontend/src/components/ui/{Panel,Tabs,Disclosure,MetricTile,EmptyState,IconButton,Drawer}.tsx` | Design-system primitives (§3). |
| `frontend/src/shell/workspaces.ts` | The 7 workspaces (id, rail label, title, lucide icon, purpose, Alt+n) and the workspace ↔ engine-mode mapping. |
| `frontend/src/shell/useShellStore.ts` | zustand store `useShellStore`: `workspace, contextOpen, inspectorOpen, drawerOpen, drawerTab` (+ `paletteOpen, viewport, openProjectId, projectsTab`). |
| `frontend/src/shell/AppShell.tsx` | The layout: top bar, rail, context panel, map stage, inspector, drawer, palette, dialogs, toast. |
| `frontend/src/shell/TopBar.tsx`, `TopBarTrustSlot.tsx`, `WorkspaceRail.tsx`, `CommandPalette.tsx` | Shell chrome. |
| `frontend/src/shell/contexts/*Context.tsx` | One context panel per workspace. `DesignContext.tsx` exports the `DesignToolPalette` mount point. |
| `frontend/src/App.tsx` | Now only `<AppShell/>`. |
| `frontend/src/index.css` | Old dock CSS (top-left dock, mode bar, panel dock, layers dock, Build toolbar placement) replaced by the shell CSS. |

Small edits to existing components (no engine logic touched; tools.ts and PropertiesPanel untouched):
`PlanningPanel` gains an optional `initialOpenId` prop (command palette opens a project);
`CoachMarks` points at the rail ("Workspaces") with a new `right` placement;
`useKeyboardShortcuts` toast texts say "Open Design (Alt+2)" instead of "Switch to Build at the top".

## 2. Layout and navigation

```
┌──────────────────────────── top bar 44 px: UrbanOS · workspace title · Alternative chip · Search ⌘K · [trust slot] · connection · shortcuts
├──────┬──────────────┬───────────────────────────────┬──────────────┐
│ rail │ context 320  │ map (Viewport3D, never        │ inspector    │
│ 72px │ (432 Projects│ unmounts) · compass · Cesium  │ (width of    │
│      │  & Data)     │ buttons top-right · drawer    │  the panel)  │
└──────┴──────────────┴───────────────────────────────┴──────────────┘
```

- **Workspace → engine** (UX_ARCHITECTURE §2): design/underground → `setAppMode('build')`, simulate → `'simulate'`,
  others → `'view'`. Only `useShellStore.setWorkspace` calls `setAppMode`. Engine-initiated changes (Simulate's close
  button, Esc in Simulate, "Edit in Build" from a Simulate problem) are mirrored back with `syncWorkspace`
  (`workspaceForMode`): build → Design, simulate → Simulate, view → Explore. Simulate still locks editing (engine).
- **Inspector precedence** is the old right panel's: Simulate → `SimulationPanel`; Build + `ljunction:` →
  `JunctionPanel`; Build or debug selection → `PropertiesPanel key={id}`; otherwise `InfoPanel` ("Your projects" list, or
  the selected object's details). A new selection opens the inspector.
- **Workspace content** (AUD §4.2, existing components mounted unchanged):
  | Workspace | Context panel | Inspector | Drawer |
  |---|---|---|---|
  | Explore | `LayerManager`; object counts in the active alternative (MetricTiles) | `InfoPanel` | — |
  | Design | `DesignToolPalette` (= existing `Toolbar` today); Alternatives = `ScenarioSelector` (+ its `ScenarioVersions`) | `PropertiesPanel` / `JunctionPanel` | — |
  | Underground | Utility objects in the scene: type, depth (m), "(drawing default)" when 1.5 m, certainty (Hypothetical on a proposal, Unknown on the base city; never Measured: no records/surveys exist); click flies to it. "Draw a utility" sets the real `draw_utility` tool. Lists what is not available (records, boreholes, tunnels). | `PropertiesPanel` | "Utility table" (name, type, depth, length, capacity, certainty) |
  | Environment | Feasibility constraint layers from `GET /api/feasibility/status` (water, heritage, buildings, metro, railway, trees, roads): Available (source, data date, ODbL) or "Not imported · Unknown"; emissions note + "Open Simulate"; flood, drainage, groundwater, soil, geology, air quality, noise, heat, green cover = "Not imported · Unknown". | `InfoPanel` | — |
  | Simulate | Fixed red banner "Traffic model fails validation (TAG M3.1)" with ENGINEERING_VALIDATION §5 figures; model list with standing; study hint | `SimulationPanel` (unchanged) | — (see §6) |
  | Projects | Tabs: Projects = `PlanningPanel`, Data = `TrafficDataPanel` | `InfoPanel` | — |
  | Reports | Planning project report PDF/DOCX links (`GET /api/planning/projects/{id}/report`, audited); Investigation Requirements Document: Generate PDF/DOCX (`POST /api/feasibility/assessments/{id}/documents`) and download (`GET /api/feasibility/documents/{id}/download`); `scenarioReport.ts` listed without a button (not wired to a run). | `InfoPanel` | — |
- **Alternative switcher**: the top-bar chip shows the active alternative. `ScenarioSelector` (which owns
  `#scenario-select`) is mounted exactly once: in Design's context panel while it is open (the chip scrolls to it),
  otherwise in the chip's popover on demand.
- **Command palette** (Ctrl/⌘K, also the top-bar search button): workspaces, all `TOOLS` from tools.ts (opens Design and
  calls `editing.setMode`), layers (show/hide), alternatives (`scenarios.setActiveScenario`), planning projects (fetched
  via `planningApi.projects()` when opened; opens Projects on that project), "Open traffic data", "Keyboard shortcuts".
  Keyboard: ↑/↓, Enter, Esc; combobox/listbox ARIA. Every result performs a real action.
- **Keys**: Alt+1…7 switch workspace; existing shortcuts (1–9 tools, Ctrl+Z/Y, Delete, `?`) unchanged.
- **Trust slot**: `TopBarTrustSlot` renders its children; `AppShell` accepts a `trust` prop that the
  `<ModelTrustPill/>` (ui/badges, design-tools work) is passed through. Until then nothing renders there. The Simulate
  context banner is plain text, not a TrustBadge.

## 3. Design-system primitives

- `IconButton` — required `label` → `aria-label` + CSS tooltip shown on hover and keyboard focus.
- `Panel`/`PanelSection` — flat bordered panel, header (title, one-line subtitle, actions, close), scrolling body, footer only for actions.
- `Tabs`/`TabPanel` — WAI-ARIA tabs with roving tabindex and ←/→/Home/End.
- `Disclosure` — native `<details>`, default summary "Technical details", collapsed by default.
- `MetricTile` — label, value + unit, badge slot, signed delta with ▲/▼ (not colour alone); null/NaN renders "—" + "Unknown", never 0.
- `EmptyState` — icon, one sentence, at most one real action.
- `Drawer` — bottom tab strip + body; collapsed shows the strip; rendered only when the workspace registers tabs.
- Not created here (owned by uos-design-tools in `ui/badges/`): CertaintyBadge, TrustBadge, DataStatus, ModelTrustPill.

## 4. Responsive behaviour

- ≥1280: docked context 320 (432 for Projects), inspector at its panel's own width (22 rem / 27 rem).
- 1025–1279: context 296.
- **Tablet 768–1024**: rail 72 px with 10 px labels; context panel and inspector **overlay** the map; shell controls ≥ 40 px.
  - **Dual overlay** (polish pass, `dualOverlay()` in `useShellStore.ts`): when the window is ≥ 1000 px wide
    (`DUAL_OVERLAY_MIN_WIDTH`) and the workspace is Explore, Design, Underground or Environment
    (`DUAL_OVERLAY_WORKSPACES`), context (296 px) and inspector may both be open; the inspector is capped so ≥ 280 px of
    map stays visible between them (measured 303 px at 1024×768). Shell carries `data-dual="true"`; Cesium's buttons and
    the compass move right of the context panel. Projects (432 px context) and Simulate (study panel = inspector) keep
    one at a time.
  - **Selection on one-overlay sizes** (768 portrait, phone): in Explore and Environment (`SUMMARY_IN_CONTEXT`), whose
    context panel shows the selection (Explore "Selected" summary; Environment "Screen …"), a new selection keeps the
    context panel and does not open the inspector; an **Open details** button (`open-inspector`, real: opens the
    inspector) appears there instead. Elsewhere the selection opens the inspector as before (`revealSelection`).
  - **Drawer**: the drawer spans the map width; context and inspector end above it (bottom = 40 px strip when collapsed,
    `--drawer-h` = min(240 px, 38 dvh) when open), so drawer tabs and body are never covered.
- **< 768**: rail becomes a bottom tab bar (scrolls sideways: 7 × 70 px); context or inspector is a bottom sheet (52 dvh)
  above it, one at a time; with a drawer the sheets sit above its 40 px tab strip, and drawer / context / inspector are
  mutually exclusive (opening one closes the others — store); the old < 920 px sheet rules (whole sheet scrolls, sticky footer, 44 px targets, enlarged
  Cesium buttons) are kept for the embedded panels.

## 5. Preserved contracts (AUD §4)

data-testids inside existing panels are untouched. Moved launchers: `open-planning` is now the rail's Projects button;
`open-traffic-data` is the Projects workspace's "Data" tab (it is only in the DOM while Projects is open — external
harnesses that clicked it from any state must click `open-planning` first). `#scenario-select`, "New proposal",
"Compare with base city", `aside[aria-label="Simulate traffic"]`, `aside[aria-label="Planning projects"]`,
"Keyboard shortcuts", "Dismiss notification" keep their names. `ModeBar` is no longer mounted (export kept). New ids:
`ws-<workspace>`, `alternative-switcher`, `open-command-palette`, `command-palette`, `context-panel`, `inspector`,
`reopen-context`, `underground-utilities`, `utility-table`, `environment-layers`, `environment-unknown`,
`simulate-validation-banner`, `reports-catalogue`, `report-project-{pdf|docx}-<id>`, `report-ird-{pdf|docx}-<id>`.

## 6. Deviations and open items

- Rail is 72 px on desktop (spec 64) so "Underground"/"Environment" fit untruncated at 11 px; 64 px on tablet (10 px labels, within §5.4's 10–11 px).
- Inspector width follows the mounted panel (352 / 432 px) instead of a fixed 360, so existing panels are not reflowed.
- Simulate drawer tabs (Calibration, ODME, Emissions, Count checks, Through the day) are **not** moved: the same
  components (with data-testids such as `emissions-card`, `timeline-*`) render inside SimulationPanel's Details/Improve
  tabs, and mounting them twice would duplicate test ids. Moving them needs SimulationPanel to drop its copies.
- **Light theme: left off (decision of the polish pass, 2026-11-13).** Tokens exist, but the embedded panels
  (`PropertiesPanel`, `SimulationPanel`, `FeasibilityPanel`, `TrafficDataPanel`, `JunctionPanel`, `InfoPanel`, `ui/kit.tsx`,
  RoadAnalysis/ODME/Calibration cards) still hard-code dark Tailwind colours (`bg-slate-950/90`, `text-slate-*`,
  `border-white/10`, …). A light shell around them would be half-themed and fail contrast, so no toggle is exposed.
  Prerequisite: move `ui/kit.tsx` and those panels to token utilities (`bg-surface-*`, `text-text-*`).
- Underground has no ground translucency / depth slider / profile yet (UX_ARCHITECTURE §7) — listed as not available, no fake controls.
- `Bridge`, `Tunnel` tools: not shown (no mode behind them).

## 7. Verification

Run 2026-11-13 on this branch (worktree uos-wt-shell), backend on a copy of twincity.db, Chromium 156 + SwiftShader.

- `npx tsc -p tsconfig.app.json --noEmit`: 0 errors. `oxlint src`: 0 errors (7 pre-existing warnings, none in new files). `vite build`: OK.
- vitest, one file at a time, all pass (103 tests): RoadAnalysisPanelPieces 16, TimelineStalePanel 3, TimeOfDay 4,
  ThroughTrafficOff 1, ScenarioPanelPieces 8, LaneBottleneckCard 4, LaneScopeStore 3, JunctionEditing 29, StartupTest 2,
  HonestControls 17, SimulateFlow 7, EditingWorkflow 9. **UNIT-TESTED** (existing tests; no new unit tests for the shell).
- Playwright (`/workspace/work/uos-shell-e2e/shell_check.py`) at 1440×900, 1024×768, 390×844: all 7 workspaces, select a
  road (Explore → InfoPanel; Design → PropertiesPanel), Simulate a road (SimulationPanel opens; its Close returns the shell to
  Explore/view), Projects (PlanningPanel) and Data (TrafficDataPanel), alternative popover (exactly one `#scenario-select`),
  palette "flyover" → Enter (Design / build / draw_flyover), Reports PDF link fetched → 200 application/pdf.
  Layout checks on every step: no overlap between top bar, rail, context, inspector; nothing off-screen; no horizontal
  overflow in panels; at 1024 and 390 every shell/panel button ≥ 40 px (0 smaller). **BROWSER-VERIFIED.** Screenshots
  `/workspace/work/urbanos/shots/after/shell-<WxH>-*.png` were viewed. Console errors seen were environmental only (Google
  Fonts blocked, Cesium ion 401 for asset 2 via the sandbox proxy).
- Not browser-verified: Investigation Requirements Document generate/download from Reports (no saved assessment in the
  test DB); Alt+1…7; drawer expand; light theme (no toggle).

## 8. Tablet layout and visual consistency pass (2026-11-13, worktree uos-wt-polish)

Shell changes: `useShellStore.ts` (`width`, `dualOverlay`, `revealSelection`, phone drawer exclusivity), `AppShell.tsx`
(uses them; `data-dual`), `SelectionDetailsButton.tsx` (new), Explore/Environment contexts (Open details), Underground
alignment list (selects when dual overlay allows), `index.css` (tablet dual/drawer rules, phone sheet above drawer strip,
inspector flattens div-rooted panels such as PropertiesPanel, Environment screening fills the context column).
Consistency: in embedded panels, text below 11 px raised to 11 px (`text-[10px]` → `text-[11px]`: PropertiesPanel,
TrafficDataPanel, RoadAnalysisPanel, OdmeAndEmissions) and `text-slate-600` → `text-slate-500` (contrast on dark);
`ui/kit.tsx` `Segmented` wraps instead of clipping its last option in a 296 px column; the Simulate drawer's "Hourly
demand profile" heading uses the token heading style. Text walls moved under the design-system `Disclosure` (text
unchanged, data-testids unchanged): SimulationPanel "What the distance means", TrafficDataPanel "How datasets are used"
and import "File format". FeasibilityPanel's one-line screening disclaimer and SimulationPanel/TrafficDataPanel
headers stay visible (honesty notices, one sentence). No engine logic, backend or test expectation changed.

### 8.1 Verification (2026-11-13)
- `npx tsc -p tsconfig.app.json --noEmit` 0 errors · `oxlint src` 0 errors (8 warnings, none in changed files) · `vite build` OK.
- vitest, one file at a time (**UNIT-TESTED**): RoadAnalysisPanelPieces 16, TimelineStalePanel 3, ScenarioPanelPieces 8,
  HonestControls 20, DesignTools 7, UndergroundWorkspace 12, EnvExploreModel 7, ProjectsWorkspace 10, HonestyBadges 8 — all
  pass; new `engine/testing/ShellOverlay.test.ts` 4 pass (dual-overlay rule, Environment keeps context at 1024, portrait
  selection rule, phone drawer/sheet exclusivity).
- **BROWSER-VERIFIED** (`/workspace/work/uos-polish-e2e/polish_check.py`, backend :8318 on a copy of twincity.db, static
  :4518, Chromium + SwiftShader) at 1440×900, 1024×768, 768×1024, 390×844: all 7 workspaces with an object selected, the
  Underground and Simulate drawers open. On every step: context ∩ inspector = ∅, neither covers the drawer, every drawer tab
  and the drawer body hit-test inside the drawer, nothing off-screen, no horizontal overflow, 0 shell/panel buttons
  < 40 px at ≤ 1024. 1024: dual overlay in Explore/Design/Underground/Environment, 303 px of map between panels; Explore
  search → summary kept; Environment "Screen …" → FeasibilityPanel opens with the inspector still open. 768/390: selection
  keeps the Explore/Environment panel, "Open details" opens the inspector. Screenshots (viewed)
  `/workspace/work/urbanos/shots/after/polish-<WxH>-*.png`.
- Known: at 390 px the drawer tab strip scrolls sideways ("Through the day" is off-screen until scrolled; reachable).
