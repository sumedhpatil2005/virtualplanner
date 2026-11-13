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
- **Tablet 768–1024**: rail 64 px with 10 px labels; context panel and inspector **overlay** the map; the store allows only
  one at a time (opening one closes the other); shell controls ≥ 40 px.
- **< 768**: rail becomes a bottom tab bar (scrolls sideways: 7 × 64 px); context or inspector is a bottom sheet (52 dvh)
  above it, one at a time; the old < 920 px sheet rules (whole sheet scrolls, sticky footer, 44 px targets, enlarged
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
- Light theme tokens exist but no toggle is exposed: existing panels still use hard-coded dark Tailwind colours, so a
  light shell around dark panels would be half-themed. Expose the toggle once panels use tokens.
- Underground has no ground translucency / depth slider / profile yet (UX_ARCHITECTURE §7) — listed as not available, no fake controls.
- `Bridge`, `Tunnel` tools: not shown (no mode behind them).

## 7. Verification

See the report at the end of the task for the run results; screenshots: `/workspace/work/urbanos/shots/after/shell-*.png`.
