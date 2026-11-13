# UrbanOS — target product & UX architecture (coordinator decision, 2026-11-13)

Synthesised from research/PRODUCT_UX_RESEARCH.md (PUX), research/ENGINEERING_GIS_RESEARCH.md (EGR) and audit/CODE_UI_AUDIT.md (AUD). Those files are the detail; this file is the decision. Implementation agents follow this; deviations must be written into their report.

## 1. Product statement
UrbanOS: a map-first city planning, infrastructure and digital-twin workspace for Pune (city-agnostic architecture). Explore the existing city → design proposals (surface + underground) → screen constraints & environment → simulate → coordinate projects (alternatives, conflicts, reviews, decisions) → report. Honesty layer everywhere: certainty of values and trust of models are always visible.

## 2. Shell (one layout, map never unmounts)
- **Top bar (44 px):** UrbanOS wordmark, active Project / Alternative switcher (existing scenario select `#scenario-select` keeps its id), Ctrl/⌘K command search, model-trust indicator (red "Traffic model fails validation" pill → opens validation summary), help.
- **Workspace rail (left, 64 px, icon + always-visible short label):**
  | id | Label | lucide icon | Content |
  |---|---|---|---|
  | explore | Explore | Map | layer tree, search, object inspector, city stats |
  | design | Design | PencilRuler | categorised tool palette (§3), inspector (PropertiesPanel/JunctionPanel), alternatives & versions |
  | underground | Underground | ArrowDownToLine | depth/ground-opacity controls, subsurface tools, profile/cross-section drawer, borehole/utility records |
  | environment | Environment | Leaf | environmental layer catalogue with data status (Available / Not imported = UNKNOWN), constraint screening, emissions summary |
  | simulate | Simulate | Activity | SimulationPanel/RoadAnalysisPanel, generator, compare; drawer tabs: Calibration, ODME, Emissions, Count checks, Through the day |
  | projects | Projects | FolderKanban | PlanningPanel redesigned: project = real planning activity (alternatives, investigations, datasets, conflicts, assessments, reviews, decisions, audit); Traffic Data Manager under "Data" |
  | reports | Reports | FileText | catalogue of real report endpoints (feasibility/investigation PDF/DOCX, planning project PDF/DOCX, scenario report) with what each contains |
- **Context panel (left of map, 320 px, collapsible)** per workspace; **Inspector (right, 360 px)** opens on selection; **Bottom drawer (240 px, resizable, tabs)** for profiles, charts, tables, timelines.
- **Tablet 768–1024:** rail stays; only one of context/inspector overlays the map at a time; drawer becomes sheet; touch targets ≥40 px. <768: keep the existing bottom-sheet behaviour (ENGINEERING_VALIDATION §9).
- State: zustand store `useShellStore` {workspace, contextOpen, inspectorOpen, drawerTab, drawerOpen}. Engine contract unchanged: workspace→`engine.setAppMode` (design/underground → Build; simulate → Simulate; others → View). Simulate still locks editing.

## 3. Design (was Build) tool palette — categories
Keep EditingMode ids + hotkeys 1–9 (tests). Add `category`, `shortLabel`, `icon`, `description`, `status` to tools.ts.
- **Select** (MousePointer2)
- **Roads & lanes:** Road (Route)
- **Junctions & signals:** Junction (SquaresIntersect / fallback GitMerge)
- **Grade separation:** Flyover (Spline), Metro + road deck (renamed "Double-deck"), (Bridge = flyover over water — only if real; else absent)
- **Transit:** Metro line (TrainFront), Station (MapPin→ TrainTrack/ CircleDot)
- **Underground:** Utility line (Cable) with type/depth/diameter inputs; Tunnel / underground alignment (TrainFrontTunnel) — new in wave 3, only when real
- **Land & demand:** Building (Building2) — height from user input, no random; Demand zone (Shapes) — defaults labelled HYPOTHETICAL; Gateway (DoorOpen)
- **Data:** "Import area from OSM" (Download) — renamed from "Draw area"; moved out of drawing tools.
No tool is shown that has no working mode behind it.

## 4. Honesty components (one implementation, used everywhere)
- `CertaintyBadge` value: measured | estimated | hypothetical | unknown (unknown never rendered as 0 or pass).
- `TrustBadge` model: fails_validation | not_validated | stale | validated. Traffic/ODME/emissions outputs and report sections show "Fails validation (TAG M3.1)" non-dismissable, linking to the validation summary. The "3/3 runs agree" chip is relabelled "Run-to-run stability" (not accuracy).
- `DataStatus`: available (source, date, licence) | not imported (UNKNOWN).

## 5. Design system
Tokens per PUX §5 (dark default, light alt) as CSS variables in `src/styles/tokens.css`, Tailwind v4 `@theme` mapping. 4 px grid, type 11–24 px, tabular nums. Components in `src/components/ui/`: Rail, Panel, Inspector, Drawer, Tabs, ToolGroup, MetricTile, StatusBadge/CertaintyBadge/TrustBadge, EmptyState, Disclosure ("Technical details").

## 6. Shared city model & coordination (backend, EGR §D)
New additive tables (never alter existing semantics): `city_assets` view over baseline (immutable), `project_proposal_elements` (project_id, alternative/scenario_id, element ref, geometry WGS84 + UTM43N, z_min/z_max (m, relative to ground; null=unknown), clearance_m user-set, provenance, certainty), `coordination_conflicts` (computed, with status open/acknowledged/resolved, never auto-edits either project), `clearance_rules` (user-configurable; defaults only where cited: metro 20 m NOC, heritage 100/300 m AMASR — labelled permission distances, not engineering standards), `subsurface_records` (boreholes AGS4/CSV, utility records with ASCE 38 quality level, provenance), `environment_layers` (catalogue + status). Conflict result classes: conflict | potential_conflict (depth unknown) | vertically_separated | no_conflict_within_available_data | unknown_no_coverage. Stale flags computed on read from hashes (scenario version, baseline fingerprint, dataset hashes, other projects' versions, rule set, engine version). All writes audited via the existing append-only audit_log.

## 7. Underground (EGR §E, PUX §3)
Cesium globe.translucency (front/back alpha, by distance, limited to rectangle), undergroundColor, depth slider, X-ray toggle, collision off while underground; alignment with depth profile (polyline + vertical profile editor in drawer) and SVG cross-section; utilities and boreholes from records; everything without data shows UNKNOWN.

## 8. Environment
Layer catalogue with data status; nothing without data shows as a result. Existing feasibility constraint layers (water, heritage, buildings, metro) and emissions summary surface here. Flood/groundwater/soil/geology/AQ/noise/heat/vegetation: "Not imported — UNKNOWN", with recommended source (EGR §C) and an import path only where we implement one.

## 9. Preservation
AUD §2 checklist is binding; AUD §4 test ids/aria-labels/exports must remain. All 86 vitest files + 102 pytest must stay green.
