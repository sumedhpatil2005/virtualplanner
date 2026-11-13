# Environment, Explore and Simulate-drawer workspaces (frontend, 2026-11-13)

Binding inputs: UX_ARCHITECTURE.md §2 (shell), §4 (honesty components), §8 (Environment); COORDINATION_AND_SUBSURFACE.md
(`GET /api/coordination/environment-layers`); ENGINEERING_GIS_RESEARCH.md §B/§C (recommended sources, carried by the
catalogue's `recommended_sources`, not re-typed in the UI); SHELL_AND_DESIGN_SYSTEM.md (tokens, Panel, Disclosure, Drawer).

## Environment (`src/shell/contexts/EnvironmentContext.tsx`, `src/components/environment/*`)
- Catalogue = `coordinationApi.environmentLayers()` → `groupCatalogue()` (pure, `envCatalogue.ts`) into: Water & flooding,
  Ground & geology, Air, Noise, Heat, Vegetation, Heritage & protected, plus "Infrastructure constraints" (metro, railway:
  constraint layers the catalogue carries) and "Other" (any unmapped domain, so no row disappears).
- Each row shows `DataStatus`: available → source · data date · licence (from the row); not imported → "Not imported ·
  UNKNOWN", the row's limitation note and its recommended sources (name, publisher, link, licence, notes) from the
  catalogue metadata. A missing source/date/licence renders "unknown", never blank-as-pass.
- Map toggles only where a real renderer exists (`MAP_TOGGLES`): `osm_water`, `osm_heritage`, `osm_railway` draw the
  features `GET /api/feasibility/site-data` returns (the data screening reads) as a Cesium `CustomDataSource`
  (`constraintOverlay.ts`, entity ids `env_overlay_*`, never treated as city objects); `osm_metro` toggles the engine's
  existing `metro` layer. Buildings: the engine `buildings` layer (catalogue has no buildings row, so it is a separate
  "Scene layers" toggle). Every other row has no toggle. The overlay states the box it requested (layer coverage or
  camera view) and the feature count; a failed fetch shows its error. No heatmaps, no interpolated surfaces.
- Emissions summary: the latest analysis result in this session (`sim.analysis.output.result.emissions` /
  `areaEmissions`), with `TrustBadge fails_validation`; empty state otherwise.
- "Screen this proposal": enabled only when the current selection is a road / flyover / metro_flyover; opens the existing
  `FeasibilityPanel` in the context panel (unchanged component).

## Explore (`src/shell/contexts/ExploreContext.tsx`, `src/components/explore/*`)
- Layer tree groups the existing LayerManager registry (`engineInstance.layers`) into Base map, Buildings, Transport,
  Utilities, Land use / demand zones, Environment (the overlays above), Proposals (objects not in the base alternative,
  counted only — there is no separate proposal layer, so no toggle). Toggles call `layers.setVisibility` (real).
- Search over loaded city objects by name or OSM id (`osmProvenance.osmId` for roads, `osmId` for buildings);
  choosing a result flies to it (`flyToObject`) and selects it (`selection.selectSingle`).
- Selected-object summary: type, key attributes per type, `CertaintyBadge` only where `valueCertainty` or provenance
  exists, source (OSM id / manual).
- City stats computed from loaded objects: road length (haversine over vertices, km), buildings, junctions.

## Simulate drawer (`src/shell/contexts/SimulateDrawer.tsx`)
- Tabs registered through AppShell's `DRAWER_TABS` map: Calibration, ODME, Emissions, Count checks, Through the day.
  Each renders the existing card once; the Details tab and Improve tab no longer render those cards (so every
  `data-testid` exists once). Without a study area each tab shows an empty state.
- SimulationPanel flow, `aria-label="Simulate traffic"` and all TrustBadges unchanged.

## Verification
See the run report at the end of this file (labels: BROWSER-VERIFIED / UNIT-TESTED / UNTESTED).

## Run report (2026-11-13)
Harness: /workspace/work/uos-env-e2e/env_check.py (backend :8317 on a copy of twincity.db + feasibility_layers.db, static
:4517, Chromium/swiftshader), results in /workspace/work/uos-env-e2e/results*.json, screenshots
/workspace/work/urbanos/shots/after/{env,explore,simulate}-*-{1440x900,1024x768}.png.
- BROWSER-VERIFIED (1440x900 and 1024x768): catalogue loads 17 rows in 8 groups (12 Not imported · UNKNOWN, 5 Available
  with source / date+zone / licence); water (1,409 features) and heritage (71) overlays draw and report their box; metro
  toggle flips the engine `metro` layer; selected road → "Screen …" opens FeasibilityPanel (1440 only: at 1024 the selection closes the context panel by the shell's one-overlay rule) in the context column (no
  horizontal overflow); Explore search by name and by OSM id → fly to + select, summary shows OSM id, lanes, width,
  speed limit, length; layer-tree toggle flips `buildings`; Simulate study with drawer tabs Calibration / ODME /
  Emissions / Count checks / Through the day — every card test id (emissions-card, odme-card, calibration-panel,
  count-checks, timeline, trust-emissions, trust-odme, trust-timeline) present exactly once in its tab and 0 times in
  Details; after an analysis the Environment emissions summary shows the session result with the fails-validation badge.
- UNIT-TESTED: src/engine/testing/EnvExploreModel.test.ts (grouping, DataStatus mapping, toggles only where a renderer
  exists, search, stats incl. network-node junctions, certainty only where recorded, layer tree).
- Known limits: junction count = placed junctions + road-network nodes (estimated from shared vertices, labelled);
  at 1024 (one-overlay tablet layout) the inspector overlays the right part of the drawer (shell layout, not changed);
  selecting a search hit there closes the context panel (shell rule) — reopen via the map button. Overlays are drawn
  1.5 m above the ellipsoid (terrain off by default); with terrain on they may be hidden — UNTESTED.
