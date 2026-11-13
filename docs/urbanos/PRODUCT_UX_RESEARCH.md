# UrbanOS — Product & UX Research

Author: product/UX research sub-agent · Date: 2026-11-13 (IST) · Scope: research only, no code changes.
Repo state read (read-only): `/workspace/work/virtualplanner` @ `837183c` — `frontend/src/components/ModeBar.tsx`, `frontend/src/components/tools.ts`.

**Evidence labels used in this doc**
- `[FETCHED]` — page opened and read on 2026-11-13.
- `[EXCERPT]` — claim taken from a search-result excerpt of an official page on 2026-11-13; the page itself was not opened. Re-verify before quoting externally.
- `[NOT RESEARCHED]` — named in the brief but not looked up in this pass. Anything said about it is general knowledge and must not be cited.
- `[PROPOSAL]` — this doc's own design recommendation, not a fact from a source.
- `[VERIFIED-LOCAL]` — checked against the repo's installed packages (e.g. lucide-react icon export names).

---

## 0. TL;DR — top 10 recommendations

1. **One shell, seven workspaces, one map.** Use a left **workspace rail** (icon + short label), a **context panel** next to it (layer tree or workspace tools), the **map in the centre**, a **right inspector** that opens on selection, and a **bottom drawer** for time, profiles and results. The map is never unmounted. This is the ArcGIS Map Viewer split (Contents on the left, Settings on the right), the Calcite Shell/Shell Panel/Action Bar pattern, and the ArcGIS Urban mode layout. (§1)
2. **Rename and regroup Build.** "Build" becomes the **Design** workspace with five tool groups: *Roads & lanes · Junctions & signals · Grade separation · Transit · Underground*. Replace the misleading icons now in `tools.ts`: Junction=`Compass`, Flyover=`Layers`, Metro+road=`Hammer`, Utility=`Settings`. (§2.3)
3. **Make Underground a first-class workspace, not a tool.** Its own rail entry, with a **depth slider**, **ground translucency**, **clip-box cutaway** and a **profile/cross-section drawer**. Utilities are coloured by the APWA convention and carry an ASCE 38 quality level. (§3)
4. **Build underground on CesiumJS features that already exist:** `globe.translucency.*`, `globe.undergroundColor`, `screenSpaceCameraController.enableCollisionDetection=false`, and `globe.clippingPolygons` / `ClippingPolygonCollection` for excavation cutaways. (§3.2)
5. **Model projects the way ArcGIS Urban and iTwin do.** A **Project** has a boundary and **Alternatives**. Existing conditions are locked, one alternative is marked as the preferred one shown citywide, and every alternative has frozen inputs. Add **Issues** (conflicts, review comments) with status and assignee, and **Version compare** that colours added/removed/modified elements. (§4)
6. **Certainty is part of the data.** Every number gets a `StatusBadge`: **Measured / Estimated / Hypothetical / Unknown**. Validation states (**Fails / Not validated / Stale**) are a separate axis. *Unknown* never renders as a pass, and the failed M3.1 traffic validation shows as a persistent red **Fails validation** badge on every traffic-derived output. (§5.7)
7. **A dark, map-first theme with a light option and a fixed token set.** Every text/status token in §5.1 was checked at WCAG AA (≥4.5:1) against the surfaces it may sit on. (§5.1)
8. **Fixed panel widths.** Rail 64 px, context panel 320 px (resizable 280–400), inspector 360 px, drawer 240 px (collapsible to a 40 px strip). On tablets (768–1024) the inspector and context panel overlay the map rather than squeezing it. (§5.4)
9. **Command search (Ctrl/⌘ K) for places, layers, tools and projects.** QGIS has a locator bar on Ctrl+K. One search box replaces scattered "how do I…" text. (§1)
10. **Cut text.** Use one-line hints, tooltips on icons, and "Details ▸" disclosure for engineering detail. No paragraphs in panels, no button without a working action, no metric without units and a certainty badge. (§6)

---

## 1. Recurring navigation patterns across products

| Pattern | Where seen (source) | What it means for UrbanOS |
|---|---|---|
| **Two-sided chrome: content on the left, configuration on the right** | ArcGIS Map Viewer: the "Contents (dark) toolbar" manages map contents and the "Settings (light) toolbar" configures layers and map components, with a "Hide interface" button that collapses both. Esri's blog: "High level map settings and options live to the left of the map, while layer-specific options… live on the right." `[EXCERPT]` doc.esri.com/en/arcgis-online/latest/get-started/get-started-with-mv.html; esri.com/arcgis-blog/…/interface-enhancements-for-the-new-map-viewer (2021-04-14) | Left = workspace + layers; right = inspector for the selected thing. Keep the sides consistent in every workspace. |
| **Action bar + shell panel** (icon strip that opens a panel) | Calcite Design System: Shell provides the layout; Shell Panel "house[s] primary application functionality"; Action Bar holds core actions and supports vertical layout and overflow. `[EXCERPT]` developers.arcgis.com/calcite-design-system/components/shell-panel, …/action-bar, …/foundations/layouts/ | Our **Rail** is the action bar and the **Context panel** is the shell panel. Shell Panel offers "dock" and "overlay" display modes and is resizable, which matches our tablet behaviour. |
| **Modes as a vertical icon list beside the header** | ArcGIS Urban plan editor modes: Details, Zoning/Land use, Development, Analysis, Dashboard, Discussion. Project editor: Info, Development, Analysis, Discussion, "on the left side of the view". It also has a separate *Workflow toolbar* (tools for the active mode) and *View toolbar* (navigate, analyse view). `[FETCHED]` doc.esri.com/en/arcgis-urban/latest/help/help-intro.html | Separate the **workflow toolbar** (changes per workspace) from the **view toolbar** (home, 2D/3D, measure, slice, daylight; always the same). |
| **Layer tree with visibility, order, group expansion** | QGIS Layers panel (Ctrl+1), drag to reorder for z-order, expandable groups. `[EXCERPT]` docs.qgis.org/…/qgis_gui.html; …/general_tools.html. InfraWorks Model Explorer: tree view controlling "visibility, display, selectability". `[EXCERPT]` Wiley InfraWorks excerpt; help.autodesk.com InfraWorks toolbar reference | LayerTree rows: eye toggle, lock/selectable toggle, legend swatch, source badge, overflow menu. Groups: *Base · Existing infrastructure · Underground · Environment · Proposals (per project) · Results*. |
| **Command / locator search** | QGIS locator bar in the status bar, opened with **Ctrl+K**. `[EXCERPT]` docs.qgis.org/3.44/…/training_manual/basic_map/overview.html; gis-training.heigit.org (Ctrl+K). Processing Toolbox has its own search for tools. `[EXCERPT]` | A single **⌘/Ctrl K** palette: places (geocode or OSM index), layers, tools ("draw flyover"), projects, alternatives, issues. |
| **Contextual inspector / property grid** | iTwin Viewer ships a "basic tree view and property grid" and a "status bar with tool-specific contextual information". `[EXCERPT]` developer.bentley.com/apis/visualization/. OpenRoads "Properties: review or modify information about an element". `[EXCERPT]` docs.bentley.com OpenRoads Primary toolbox | Right **Inspector**: header (type icon, name, project chip, certainty badge), key metrics, editable properties, a collapsed "Engineering details", and actions. |
| **Bottom time / analysis strip** | Kepler.gl: adding a time filter places a **playback window at the bottom of the map** with a histogram and play/speed controls. `[EXCERPT]` docs.kepler.gl/docs/user-guides/h-playback. ArcGIS JS Elevation Profile shows a ground vs. scene profile chart for a drawn line. `[EXCERPT]` developers.arcgis.com/javascript/latest/sample-code/elevation-profile/ | Bottom **Drawer** with tabs: *Time of day · Profile / Section · Results table · Compare*. One drawer only. |
| **Side-by-side / split compare** | Kepler.gl Split Map with synced camera. `[EXCERPT]` docs.kepler.gl/docs/user-guides/m-map-settings. ArcGIS Urban scenario switcher ("switch between scenarios to compare designs"). `[EXCERPT]` help-projects-scenarios | Compare mode: a swipe or split map between Existing and an Alternative, plus a delta table in the drawer. |
| **Phase-based ribbons** | InfraWorks Project Tools grouped by phase: **Manage, Create, Analyze, Present/Share**, with a Proposals menu in the toolbar. `[EXCERPT]` autodesk.com/learn/ondemand/tutorial/navigate-the-infraworks-user-interface | Our workspace order follows the same arc: Explore → Design → Underground → Environment → Simulate → Projects → Reports. |
| **Viewpoints / bookmarks, daylight, slice, measure in a view toolbar** | ArcGIS Urban viewing experience: viewpoints, daylight tool, measure, "slice through objects", screenshot. `[FETCHED]` help-intro. OpenCities Planner toolbar: View Mode, Free Flight, Measure, Sun & Shadows, Transparency. `[EXCERPT]` help.opencitiesplanner.bentley.com p=2762 | The view toolbar is the same in every workspace. Ship only tools that actually work (see §6). |
| **Light/dark UI modes** | ArcGIS Urban "has two UI appearance modes: light and dark". `[FETCHED]` help-intro. Calcite tokens have paired light/dark values (e.g. surface-1 `#f7f7f7`/`#212121`). `[EXCERPT]` calcite …/tokens/reference/ | Two themes from one token set (§5.1). |

**Products not covered in this pass:** Esri Indoors, Cesium Stories, Cityzenith, Twinmotion, Bentley iTwin UI design system `[NOT RESEARCHED]`. None of the recommendations below depend on them.

---

## 2. Workspaces, modes and tool naming

### 2.1 How the reference products structure work

| Product | Top-level structure | Tool naming style | Lessons |
|---|---|---|---|
| **ArcGIS Urban** `[FETCHED]` help-intro; `[EXCERPT]` get-started-plans, help-projects-scenarios, help-custom-indicators | 3 UIs: **Overview** (3D city plus a search panel listing plans, projects, indicators) → **view** a plan/project → **edit** a plan/project. Plans are long-range, zoning/land-use, across many lots. Projects are individual developments. **Indicators** are external analysis layers (e.g. flood) added to the overview. | Nouns for modes (Details, Zoning, Development, Analysis, Dashboard, Discussion); verbs for tools (Upload, Demolish, Measure). | A citywide overview listing every project is the right "home". Indicators = our Environment overlays. Read-only viewing is a first-class experience. |
| **ArcGIS Map Viewer / Pro** `[EXCERPT]` | Contents vs Settings toolbars. In Pro, underground navigation is a property of the Ground elevation surface. | Short nouns: Layers, Basemap, Legend, Styles, Filters, Pop-ups. | Underground is a *view state of the ground*, not a separate map. |
| **QGIS** `[EXCERPT]` | Dockable panels (Layers Ctrl+1, Browser Ctrl+2, Layer Styling Ctrl+3, Advanced Digitizing Ctrl+4, **Elevation Profile**, Processing Toolbox, Results Viewer), plus a locator bar. | Panel names are nouns; algorithms are searchable in the toolbox. | An *Elevation Profile* panel is standard GIS. The toolbox-with-search pattern fits our analysis catalogue. |
| **Autodesk InfraWorks** `[EXCERPT]` | Phases Manage/Create/Analyze/Present. **Proposals**: "Master" plus copies; recommended practice is existing conditions in Master and each alternative as its own proposal (WisDOT KB). Design tools: planning/component roads, bridges, **tunnels**, drainage, **pipelines that "do not drape on the surface but are placed under it"**. | Infrastructure nouns: Roads, Barriers, Pipelines, Bridges, Tunnels, Drainage. | A proposal = an alternative. Pipelines are a distinct object class placed below terrain. |
| **Bentley OpenRoads / iTwin / OpenCities Planner** `[EXCERPT]` | OpenRoads: Explorer, References, Models, Level Display, Properties. iTwin: iModel, **Changesets**, **Named Versions**, Issues, Version Compare. OCP: Project Editor vs Public View; groups/layers shown as **time-step sliders** for phasing; FormBuilder for public feedback. | Engineering-precise nouns. | Versions are named milestones; review happens against a named version; phasing via a stepped slider. |
| **Kepler.gl** `[EXCERPT]` | Side panel tabs **Layers · Filters · Interactions · Base map** (`toggleSidePanel` ids `layer|filter|interaction|map`). | One-word tabs. | Keep tab labels to one word. A time filter puts playback at the bottom. |
| **UrbanFootprint** `[EXCERPT]` urbanfootprint-v1.readthedocs.io; urbanfootprint.us.document360.io | **Base Canvas** (existing conditions) + painted **scenario increment** = **End State**. Analysis modules (land consumption, energy, water, fiscal, transport, health) run on a scenario; results appear as charts in an Analysis panel. | Explicit vocabulary: Base Canvas, Scenario, End State, Module. | Use "Existing", "Proposal / Alternative" and "Result". Run analyses as named modules with explicit inputs. |
| **Virtual Singapore / SG Digital Twin** `[EXCERPT]` sla.gov.sg (2022-05-17); sec.ethz.ch (2024-06-14) | National twin of 3D city, terrain, cadastre, **underground assets**, coastline. SLA's "Digital Underground" (2017–2023) built a subsurface utility twin with a data quality workflow, and notes that inaccurate utility records cause strikes. | n/a | Underground data quality is the central problem; show the provenance and quality of every utility. |

### 2.2 Final workspace names and icons `[PROPOSAL]` `[VERIFIED-LOCAL]`
All icon names below exist as exports in the repo's installed `lucide-react@1.28.0` (checked 2026-11-13). Lucide has **no** `Bridge`, `Tunnel` or `TrafficLight` icon; don't import them.

| Order | Workspace (full title) | Rail label (≤ 11 chars) | Lucide icon | Alt icon | Purpose (one line, shown as tooltip) |
|---|---|---|---|---|---|
| 1 | City Explorer | Explore | `Map` | `Globe` | Browse the city: buildings, roads, land use, transport, utilities. |
| 2 | Infrastructure Planning | Design | `PencilRuler` | `DraftingCompass` | Draw and edit proposed surface infrastructure. |
| 3 | Underground Planning | Underground | `ArrowDownToLine` | `Shovel` | Tunnels, utilities, drainage, depth and sections. |
| 4 | Environmental Intelligence | Environment | `Leaf` | `CloudRain` | Flood, drainage, soil, geology, air, noise, heat, green cover. |
| 5 | Simulation & Analysis | Simulate | `Activity` | `Gauge` | Traffic, emissions and other models; run and inspect. |
| 6 | Projects & Coordination | Projects | `FolderKanban` | `GitCompareArrows` | Projects, alternatives, issues, reviews, decisions. |
| 7 | Reports | Reports | `FileText` | `FileChartColumn` | Feasibility, environmental, traffic and comparison reports. |

Rules:
- Rail labels are **always visible** under the icon (no icon-only rail). They are short and noun-like, matching Kepler and Urban.
- Keep `Activity` for Simulate, since the current `ModeBar.tsx` already uses it. This keeps continuity for existing users.
- Current modes map onto these workspaces: `view` → Explore, `build` → Design (plus Underground for subsurface tools), `simulate` → Simulate.
- Footer of the rail: `Search` (⌘K), theme toggle (`Sun`/`Moon`), `CircleHelp`. Nothing decorative.

### 2.3 Design (Infrastructure Planning) tool groups `[PROPOSAL]`
Current `tools.ts` problems: Junction uses `Compass` (reads as navigation), Flyover uses `Layers` (reads as layer list), "Metro + road" uses `Hammer`, Utility uses `Settings` (reads as preferences), and "Draw Area and Map Selected Area (import infrastructure)" is a sentence used as a tool name.

The toolbar shows **groups**. Clicking a group opens its tools as a flyout or segmented row. Show a tool only if a real mode backs it; tools without one are hidden, not greyed (see §6).

| Group | Group icon | Tools (label → existing `mode` if any) | Tool icon |
|---|---|---|---|
| **Select** (always first) | `MousePointer2` | Select → `select` | `MousePointer2` |
| **Roads & lanes** | `Road` | Road → `draw_road` · Lanes/widen (inspector edit on a selected road; no new mode needed if lane scope already exists) | `Road`, `Rows3` |
| **Junctions & signals** | `SquaresIntersect` | Junction → `draw_junction` · Signal plan (only if the existing JunctionPanel exposes signal timing; otherwise omit) | `SquaresIntersect`, `Timer` |
| **Grade separation** | `Layers2`* | Flyover → `draw_flyover` · Bridge / Underpass (only when backed by geometry types; else omit) | `Spline` (flyover), `ArrowUpDown` (underpass) |
| **Transit** | `TrainFront` | Metro line (elevated) → `draw_metro` · Metro + road deck → `draw_metro_flyover` · Station → `place_station` · BRT corridor (omit until implemented) | `TrainFront`, `TrainTrack`, `MapPin`, `BusFront` |
| **Underground** (shortcut; opens Underground workspace tools) | `ArrowDownToLine` | Tunnel (omit until implemented) · Utility conduit → `draw_utility` · Drain (omit until implemented) | `TrainFrontTunnel`, `Cable`, `Droplets` |
| **Demand & context** (secondary, overflow) | `Combine` | Zone → `draw_zone` · Gateway → `draw_gateway` · Import area → `import_osm` ("Import area") · Building → `draw_building` | `Square`, `DoorOpen`, `MapPlus`, `Building2` |

\* The group icon `Layers2` collides with the layer-tree metaphor. If testing shows confusion, use `Spline` for the group. Avoid `Layers` anywhere except the layer tree.

**Naming rules for tools:** a 1–2 word noun on the button ("Flyover", "Station"), and verb + noun in the tooltip and command palette ("Draw flyover", "Place station"). Hotkeys are shown in the tooltip only.

### 2.4 Underground Planning workspace (tools) `[PROPOSAL]`
Context panel sections: **Depth** (slider plus ground transparency), **Networks** (layer subtree by utility type, APWA colours), **Alignments** (tunnels, metro corridors), **Geology** (boreholes / strata, if available; otherwise an *Unknown* card), **Conflicts** (list of clearance violations that links to Issues).
Workflow toolbar: Tunnel · Utility · Drain · Section line (`Section`) · Clip box (`Slice`) · Measure depth (`Ruler`).

### 2.5 Other workspaces (panel contents, short) `[PROPOSAL]`
- **Explore:** LayerTree, search, info on click, basemap switch, 2D/3D.
- **Environment:** overlay catalogue grouped *Water (flood, drainage, groundwater) · Ground (soil, geology, terrain) · Air & noise · Heat & green*. Every overlay card shows source, date, licence and certainty. A missing dataset shows an **Unknown — no data** card with what's needed, never an empty map that looks like "no risk".
- **Simulate:** model list (Traffic micro-sim, ODME, Emissions, Feasibility), each with inputs (frozen snapshot id), run state and results. A validation banner (Fails / Not validated) sits pinned at the top of the panel.
- **Projects:** list → project → tabs *Overview · Alternatives · Issues · Data · Decisions · History*.
- **Reports:** template list → choose project + alternatives → preview → export. Each report section inherits the certainty and validation badges of its inputs.

---

## 3. Underground / subsurface presentation

### 3.1 Patterns observed
| Technique | Seen in | Notes |
|---|---|---|
| **Ground translucency / opacity slider** | ArcGIS JS `map.ground.opacity = 0.6` with `navigationConstraint = {type:"none"}`. `[EXCERPT]` developers.arcgis.com/javascript/latest/sample-code/scene-underground. ArcGIS Online Scene Viewer "Ground Transparency" slider plus "Underground navigation" toggle. `[EXCERPT]` doc.esri.com/…/configure-ground-in-scene.html. ArcGIS Earth "Ground Transparency" plus "Navigate Underground". `[EXCERPT]` doc.arcgis.com/en/arcgis-earth/use/environment-effects.htm | Universal pattern: **one transparency slider + one "go below ground" toggle**. Underground navigation is off by default "to avoid navigating underground accidentally" (ArcGIS 3D workflows `[EXCERPT]`). |
| **Slice / cutaway plane** | ArcGIS Utilities workflow: "use the slice tool… to slice through scene content such as the ground. Make sure you exclude the utilities layers from the slice." `[EXCERPT]` doc.arcgis.com/en/3d/workflows/visualization/utility-layers.htm. JS Slice component has `excludeGroundSurface` and `excludedLayers`. `[EXCERPT]` developers.arcgis.com/…/arcgis-slice/ | A clip box or plane that **cuts terrain and buildings but not utilities**. |
| **Local, clipped extent for subsurface** | ArcGIS recommends authoring a local scene and clipping the viewing extent for subsurface data. `[EXCERPT]` doc.arcgis.com/en/3d/workflows/visualization/subsurface-geological-layers.htm | Limit translucency and cutaways to the project or AOI rectangle, not the whole globe. |
| **Elevation profile / cross-section chart** | ArcGIS JS Elevation Profile: ground vs. scene (buildings) lines along a drawn polyline. `[EXCERPT]`. QGIS Elevation Profile panel. `[EXCERPT]` | Bottom-drawer **Profile** tab: chainage on the x-axis, elevation/depth on the y-axis, terrain line, structures, utilities as crossings with clearance bands. |
| **Fade ground near camera** | Cesium blog: "configure the camera to hide the ground when zooming in close so we can walk inside this tunnel". `[EXCERPT]` cesium.com/blog/2020/06/16/visualizing-underground (Omar Shehata, 2020-06-16) | Use `frontFaceAlphaByDistance` for a "walk-in" view of tunnels. |
| **Boreholes / geology strata** | Cesium blog borehole visualisation with materials along depth `[EXCERPT]`. swisstopo 3D viewer underground layers (Camptocamp) `[EXCERPT]` cesium.com/blog/2020/07/06/… | Geology appears as boreholes (sticks) and strata. Missing for Pune → *Unknown*. |
| **Quality of utility location** | ASCE 38-22 quality levels **QL-D** (records/recollection), **QL-C** (surveyed surface features correlated with records), **QL-B** (surface geophysics: horizontal position), **QL-A** (exposed/potholed: measured horizontal and vertical). FHWA: QL-D "useful primarily for project planning and route selection". `[EXCERPT]` fhwa.dot.gov/programadmin/sueindex.cfm; ascelibrary.org/doi/book/10.1061/9780784415870 (2022) | Every utility segment shows its QL. QL-D/C depth is **Estimated** or **Unknown**, never Measured. Only QL-A depth is Measured. |
| **Colour convention for utilities** | APWA Uniform Color Code: red electric, yellow gas/oil/steam, orange communications, blue potable water, purple reclaimed water/irrigation/slurry, green sewer/drain, white proposed excavation, pink temporary survey. `[EXCERPT]` apwa.org/wp-content/uploads/Uniform-Color-Code-1.pdf | This is a **US** convention. Whether it is used in India or Pune is **Unknown**; label the legend "Colour convention: APWA (US)". |

### 3.2 CesiumJS capabilities that enable it (doc links, CesiumJS 1.147 ref-doc)
| Need | API | Doc | Status |
|---|---|---|---|
| See through terrain | `scene.globe.translucency.enabled`, `.frontFaceAlpha`, `.backFaceAlpha`, `.frontFaceAlphaByDistance` (`NearFarScalar`), `.rectangle` (limit translucency to an area) | https://cesium.com/learn/cesiumjs/ref-doc/GlobeTranslucency.html | `[FETCHED]` — `enabled` default false. "When the camera is underground back faces and front faces are swapped." `rectangle` limits translucency to a cartographic area. |
| Underground tint/fog | `globe.undergroundColor` (default `Color.BLACK`; set `undefined` to disable), `globe.undergroundColorAlphaByDistance` | https://cesium.com/learn/cesiumjs/ref-doc/Globe.html | `[FETCHED]` |
| Excavation / cutaway | `globe.clippingPolygons` (`ClippingPolygonCollection`, `inverse` option), `globe.clippingPlanes` (`ClippingPlaneCollection`, `edgeWidth`, `edgeColor`); the same collections apply to `Cesium3DTileset` | Globe.html (above); https://cesium.com/learn/cesiumjs/ref-doc/ClippingPlaneCollection.html; https://cesium.com/learn/cesiumjs-learn/cesiumjs-clipping-polygons | Globe members `[FETCHED]`; clipping-polygon tutorial and `inverse` `[EXCERPT]`. Community note: clipping planes from a polygon need a **convex** polygon. Clipping polygons handle complex shapes but may struggle at very small areas `[EXCERPT]` community.cesium.com threads 19252, 36514. |
| Camera below ground | `scene.screenSpaceCameraController.enableCollisionDetection = false` | Cesium community announcement (2020-05-08) `[EXCERPT]` community.cesium.com/t/…/9581 | Introduced around CesiumJS 1.70 (June 2020) `[EXCERPT]` cesium.com/blog/2020/06/01/cesium-june-release |
| Depth testing so buried objects hide correctly | `globe.depthTestAgainstTerrain` (default false) | Globe.html `[FETCHED]` | Set true when ground is opaque; toggle off (or rely on translucency) in x-ray. |
| Back faces / skirts | `globe.backFaceCulling`, `globe.showSkirts`: skirts are always hidden and back faces not culled when underground or translucent | Globe.html `[FETCHED]` | No action needed; just be aware of it. |
| Sections through models | `ClippingPlaneCollection` on tilesets/models ("Useful for exploring interiors or cutting away parts of geometry") | Sandcastle "3D Tiles Clipping Planes" `[EXCERPT]` sandcastle.cesium.com | Section box for project AOI. |
| Profile chart | No built-in widget in CesiumJS `[NOT RESEARCHED — assume none]` | — | Build the profile from sampled terrain (`sampleTerrainMostDetailed`, listed in the ref index `[FETCHED]`) plus our own alignment/utility data; render in the drawer with the existing chart kit (`ui/viz.tsx`). |

### 3.3 Recommended Underground UX `[PROPOSAL]`
1. **Entering the workspace** sets: translucency on, `frontFaceAlpha 0.35`, `translucency.rectangle` = project AOI (or the current view if there's no project), `undergroundColor` dark slate at about 0.6 alpha, and collision detection off. Leaving the workspace restores the previous state exactly.
2. **Depth control** (context panel, top): a vertical slider from 0 m to −40 m (range driven by the deepest loaded object; the default is not a standard) and a "Ground" opacity slider. The slider filters which buried objects render. It does **not** move the camera.
3. **View presets** (segmented control): *Surface · X-ray · Cutaway · Section*.
   - X-ray = translucent ground.
   - Cutaway = clipping-polygon box around the selection/AOI, with an edge highlight.
   - Section = draw a line, which opens the Profile tab in the drawer and shows the vertical plane on the map.
4. **Profile drawer:** terrain (solid), proposed alignment (accent, dashed if hypothetical), utilities as circles sized by diameter where known (hatched where the size is unknown), and required-clearance bands where a rule exists. A conflict draws a red band, adds a badge, and links to an Issue.
5. **Inspector for a utility/tunnel:** type, owner (or Unknown), diameter, invert/crown depth with certainty, **ASCE 38 QL chip**, source and date, and conflicts.
6. **Never imply precision.** A depth from QL-D/QL-C data is shown as a range or "Unknown" and drawn as a fuzzy/hatched tube. Only QL-A is a crisp line.

---

## 4. Projects, alternatives, scenarios, conflicts, reviews

### 4.1 ArcGIS Urban
- **Plan vs Project.** Plan = long-range, multi-lot land-use or zoning scenarios. Project = an individual development with a study area. `[EXCERPT]` get-started-plans; `[FETCHED]` help-intro.
- **Scenarios.** A project starts with **two scenarios: existing conditions and new (future) conditions**. You create scenarios from existing ones and switch between them to compare. "The scenario that is marked with a star icon is also visible in the overview as well as in other plans and projects." `[EXCERPT]` doc.esri.com/en/arcgis-urban/latest/help/help-projects-scenarios.html. Plan scenarios can be **locked**, reordered and deleted, and the Existing scenario "cannot [be] develop[ed]". `[EXCERPT]` help-configure-plan, help-create-plan.
- **Indicators.** External analysis layers and dashboards (e.g. flood simulation) "bring external analysis into the planning context". `[EXCERPT]` get-started-analysis, help-custom-indicators.
- **Metrics/dashboard** per scenario; **Discussion** mode for review comments and public feedback; **status types** for projects (data manager "Project status types"). `[FETCHED]`/`[EXCERPT]`.

### 4.2 Bentley iTwin
- **Changeset:** "a group of changes… every Changeset stores the identifier of its parent", forming the "timeline of changes". **Named Version:** a significant version (milestone, review version). **Version:** immutable state as of a changeset. **Lock:** the right to modify an element. `[FETCHED]` itwinjs.org/learning/glossary (last updated 2025-06-11).
- **Changed Elements / Version Compare:** colour-coded added/removed/modified elements and property changes between two named versions. Comparisons have states (*Available / Not processed / Processing*). `[EXCERPT]` developer.bentley.com/api-groups/project-delivery; Bentley community KB0036088.
- **Issues:** "create, analyze, and prioritize issues… assign… track the status, and record the resolution". Issues are opened from a panel and created against a selected element. `[EXCERPT]` developer.bentley.com/api-groups/project-delivery; Bentley Design Review blog.

### 4.3 InfraWorks / UrbanFootprint (supporting)
- InfraWorks **Proposals**: Master holds existing conditions and each alternative is a proposal copy. `[EXCERPT]` c3dkb.dot.wi.gov/…/iwx-lvl02-prpsl.htm.
- UrbanFootprint: Base Canvas + painted increment = End State; modules run on the scenario. `[EXCERPT]`.

### 4.4 Recommended UrbanOS project model (UI view) `[PROPOSAL]`
```
Project  (boundary, owner, status: Draft · Under study · In review · Decided · Archived)
├─ Existing conditions   🔒 baseline snapshot id + date (immutable)
├─ Alternatives          A, B, C … (one starred = "Preferred", shown citywide)
│    each: frozen inputs (dataset versions, demand, params) · results · stale flag
├─ Investigations        surveys / data requests (status, due, linked datasets)
├─ Datasets              referenced shared-city-model layers + versions (read-only links)
├─ Issues                conflicts (auto) + review comments (manual): severity, status, assignee, linked elements
├─ Decisions             decision record: chosen alternative, rationale, date, approver
└─ History               append-only audit (who/what/when), named versions ("Review v1")
```
UI rules:
- **Project header chip** is shown in every workspace when a project is active: name · active alternative (switcher) · status. This is like Urban's scenario switcher sitting in the header.
- **Cross-project conflicts:** when another project's element intersects or violates clearance with this one, raise an Issue in **both** projects. Show it as "⚠ 2 conflicts with Metro Line 3 Ext." Never auto-edit the other project.
- **Stale indicator:** if a referenced dataset or another project's geometry changed after results were computed, the alternative's result tiles get a **Stale** badge with "Inputs changed on <date>", plus a *Re-run* action (only if the run is real).
- **Compare view:** pick 2–3 alternatives (Existing is always available) to get a swipe or split map, a metric delta table with certainty and validation badges, and changed elements coloured **added (green) / removed (red) / modified (amber)**, following iTwin Version Compare.
- **Locks:** an alternative in review or decided is read-only (`Lock` icon). Editing it means duplicating it to a new alternative, like Urban's locked scenarios.

---

## 5. Design system proposal `[PROPOSAL]`

### 5.1 Colour tokens (dark default, light alternative)
WCAG 2.x SC 1.4.3 requires ≥ 4.5:1 for normal text and SC 1.4.11 requires ≥ 3:1 for UI component/graphical boundaries (https://www.w3.org/TR/WCAG22/). Ratios below were **computed** with the WCAG relative-luminance formula (script run 2026-11-13).

**Surfaces**
| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg-app` | `#0F1419` | `#F6F7F9` | Behind panels |
| `--surface-1` | `#161B22` | `#FFFFFF` | Panels, rail |
| `--surface-2` | `#1E252E` | `#F1F3F6` | Cards, inputs, tiles |
| `--surface-3` | `#283039` | `#E6E9EE` | Hover, selected row |
| `--border` | `#333C47` | `#D5DAE1` | Dividers (decorative) |
| `--border-strong` | `#4A5563` | `#8C96A3` | Input outlines, focus base (≥3:1 non-text) |
| `--map-scrim` | `rgba(15,20,25,.72)` | `rgba(255,255,255,.80)` | Floating controls on the map |

**Text / accent / status, with contrast on s1 / s2 / s3**
| Token | Dark hex | Dark s1/s2/s3 | Light hex | Light s1/s2/s3 |
|---|---|---|---|---|
| `--text-1` | `#E6EAF0` | 14.3 / 12.8 / 11.1 | `#1B1F24` | 16.6 / 14.9 / 13.6 |
| `--text-2` | `#A9B3C1` | 8.2 / 7.3 / 6.3 | `#4A5563` | 7.6 / 6.8 / 6.2 |
| `--text-3` (meta) | `#8B95A3` | 5.7 / 5.1 / **4.4** | `#5F6875` | 5.6 / 5.1 / 4.6 |
| `--accent` | `#5AA2FF` | 6.6 / 5.9 / 5.1 | `#0B63CE` | 5.7 / 5.1 / 4.7 |
| `--measured` | `#3FB950` | 6.8 / 6.1 / 5.3 | `#1A7F37` | 5.1 / 4.6 / **4.2** |
| `--estimated` | `#D29922` | 6.9 / 6.1 / 5.3 | `#8A5A00` | 5.9 / 5.3 / 4.9 |
| `--hypothetical` | `#B392F0` | 6.8 / 6.1 / 5.3 | `#7A45D6` | 5.8 / 5.2 / 4.7 |
| `--unknown` | `#9AA4B2` | 6.9 / 6.1 / 5.3 | `#57606A` | 6.4 / 5.7 / 5.3 |
| `--fail` (danger) | `#FF6B61` | 6.2 / 5.5 / 4.8 | `#C4202B` | 5.9 / 5.3 / 4.8 |
| `--warn` | `#E8833A` | 6.4 / 5.7 / 4.9 | `#A84300` | 6.1 / 5.4 / 5.0 |

Constraints: `--text-3` must not sit on dark `--surface-3`, and light `--measured` must not sit on light `--surface-3` (both are below 4.5). Badges always sit on s1/s2.

**Map semantic colours (layers, not chrome)**
- Existing infrastructure: neutral greys/whites. **Proposed**: `--accent` (cyan-blue), dashed when *Hypothetical*. **Removed**: red outline, 40% fill. **Modified**: amber.
- Utilities: APWA hues (labelled as a US convention; §3.1). Electric `#E5484D`, gas `#F5C518`, comms `#F28C28`, potable water `#3B82F6`, reclaimed `#9B59D0`, sewer/drain `#2E9E5B`, proposed excavation `#FFFFFF` (dark map) / `#111` outline (light map).
- Environment ramps: sequential single-hue for magnitude (flood depth: light→deep blue; heat: yellow→red; noise: lavender→purple). Never encode certainty with hue on the map; use **pattern/opacity** instead: Measured = solid, Estimated = 70% opacity, Hypothetical = dashed/hatched, Unknown = grey cross-hatch.

### 5.2 Typography
Font: `Inter` (or system UI stack) for UI. `JetBrains Mono` / `ui-monospace` for IDs and coordinates. Use tabular numerals (`font-variant-numeric: tabular-nums`) for all metrics.
| Token | Size / line | Weight | Use |
|---|---|---|---|
| `--fs-display` | 24/32 | 600 | Report titles only |
| `--fs-title` | 18/24 | 600 | Panel title |
| `--fs-heading` | 15/20 | 600 | Section heading |
| `--fs-body` | 13/18 | 400 | Default UI text |
| `--fs-label` | 12/16 | 500 | Field labels, tabs, rail labels (11/14 allowed on rail) |
| `--fs-meta` | 11/14 | 400 | Source/date lines, badges |
| `--fs-metric` | 22/26 | 600 tabular | MetricTile value |
Rail labels may be 11 px; never go below 11 px anywhere.

### 5.3 Spacing, radius, elevation
- 4-pt scale: `--sp-1 4 · --sp-2 8 · --sp-3 12 · --sp-4 16 · --sp-5 20 · --sp-6 24 · --sp-8 32`.
- Panel padding 12 (tablet) / 16 (desktop). Row height 32 (dense list) / 40 (default). Touch targets ≥ 40 px on tablet. WCAG 2.2 SC 2.5.8 minimum is 24×24 CSS px; we exceed it on purpose for touch.
- Radius: `--r-sm 4` (badges, inputs) · `--r-md 8` (cards, panels) · `--r-lg 12` (floating map controls).
- Elevation: panels flat with a border. Only floating map controls and popovers get a shadow (`0 4px 16px rgba(0,0,0,.35)` dark / `.12` light).
- Motion: 120–180 ms ease-out for panel open/close. Respect `prefers-reduced-motion`.

### 5.4 Layout and panel widths
```
┌────┬──────────────┬──────────────────────────────────┬──────────────┐
│Rail│ Context panel│ [Project chip][Workflow toolbar] │  Inspector   │
│ 64 │   320 (280–  │                MAP               │     360      │
│    │    400 resz.)│              (always)  [View tb] │ (on select)  │
│    │              ├──────────────────────────────────┤              │
│    │              │ Drawer 240 (tabs) / 40 collapsed │              │
└────┴──────────────┴──────────────────────────────────┴──────────────┘
```
| Region | Desktop ≥1280 | Laptop 1025–1279 | Tablet 768–1024 | <768 (not a target; must still work) |
|---|---|---|---|---|
| Rail | 64 px, icon + label | 64 | 56, icon + 10–11 px label | bottom tab bar, 56 high |
| Context panel | 320 docked, resizable 280–400 | 296 docked | **overlay** 320 (or 50% landscape), closes on map tap | full-height sheet |
| Inspector | 360 docked | 320 docked; context panel auto-collapses when the inspector opens | **overlay** right sheet 360 | bottom sheet |
| Drawer | 240 (resizable 160–400) | 220 | 200, swipe-down to collapse | sheet |
| Workflow toolbar | top-centre floating, icon + short label | icon + label | icons only (tooltips on long-press), 44 px targets | icons |
| View toolbar | bottom-right vertical stack | same | same | same |
Rule: on tablet, at most **one** overlay panel at a time. The map keeps at least 60% of the width in landscape.

### 5.5 Component list
| Component | Anatomy / behaviour |
|---|---|
| **Rail** | Vertical list of workspace buttons (icon 20 px + label). Active = accent bar on the left plus surface-3. `aria-current="page"`. Keyboard: ↑/↓, Enter. Footer: search, theme, help. |
| **ContextPanel** | Header (title, optional search, close/collapse). Body = sections (`Block` style, collapsible). Footer only for real actions. |
| **LayerTree** | Group rows (chevron, name, count, group eye). Layer rows: eye, legend swatch, name, `SourceBadge` (existing `ui/SourceBadge.tsx`), certainty dot, `⋯` menu (zoom to, opacity, details). Drag to reorder. Disabled layers (no data) show an `Unknown — no data` row with a reason, not a hidden layer. |
| **Inspector** | Header: type icon, name, project/alternative chip, `StatusBadge`. Section 1: up to 4 `MetricTile`s. Section 2: editable properties (form). Section 3: "Engineering details ▸" (collapsed). Section 4: Issues linked. Footer: primary action and secondary actions (only working ones). |
| **MetricTile** | Label (fs-label, text-2) · value (fs-metric) + unit · `StatusBadge` · optional delta vs. baseline (▲▼ with colour **and** sign) · optional sparkline. Unknown → value "—" with "Unknown" badge, never 0. |
| **StatusBadge** (certainty) | Pill: icon + text, 11 px, `--r-sm`. **Measured** `CircleCheck` green · **Estimated** `CircleDashed` amber · **Hypothetical** `FlaskConical` violet · **Unknown** `CircleHelp` grey. The tooltip gives the source, method and date. Text is always present; colour is never the only signal (WCAG 1.4.1). |
| **ValidationBadge** (separate axis) | **Fails validation** `OctagonAlert` red (solid fill) · **Not validated** `TriangleAlert` amber outline · **Validated** `BadgeCheck` green (only when a passing validation record exists) · **Stale** `History` amber. Links to the validation doc/record. |
| **Banner** | Pinned at the top of a panel or report for blocking context (e.g. "Traffic model fails validation M3.1 — results are indicative only"). Not dismissible while the condition holds. |
| **Drawer** | Tabbed bottom region: *Time · Profile · Results · Compare · Log*. Tab badge counts. Collapsed state shows the tab strip only. |
| **Toolbar / ToolGroup** | Floating segmented groups; group button opens a flyout with tools; the active tool is highlighted, and Esc returns to Select. A tool hint appears in a single status line under the toolbar ("Click to add vertices · Double-click to finish · Esc to cancel"). |
| **ViewToolbar** | Home, 2D/3D, compass/reset north, measure, slice/clip, daylight, screenshot: each only if implemented. |
| **ProjectChip** | Name · alternative switcher (dropdown with ★ preferred, 🔒 locked) · status pill. |
| **IssueRow** | Severity icon, title, linked element(s), project(s), status (Open/In review/Resolved/Won't fix), assignee. Click → fly to and select. |
| **CompareTable** | Rows = metrics. Columns = Existing + alternatives. Each cell is a value + StatusBadge. The delta column shows sign and colour. A failed-validation column gets the red ValidationBadge in its header. |
| **CommandPalette** | ⌘/Ctrl K, sections Places · Layers · Tools · Projects · Issues; recent items; keyboard-only operable. |
| **EmptyState** | Icon + one sentence + one real action (e.g. "No groundwater data for this area · Add dataset"). |
| **ConfirmDialog / Toast** | Reuse existing `ui/ConfirmDialog.tsx`. Toasts for completed background runs. |

### 5.6 Iconography rules
- Lucide only, 20 px in the rail and toolbars, 16 px inline, stroke 1.75–2.
- **One meaning per icon** across the app (e.g. `Layers` = layer tree only, `Settings` = app settings only, `Hammer` unused).
- Icon + label everywhere except dense toolbars on tablet, where the tooltip/long-press gives the label.

### 5.7 Warnings, validation and certainty treatment
Two independent axes, never merged:
1. **Certainty of a value**: Measured · Estimated · Hypothetical · Unknown (StatusBadge).
2. **Trust of a model/output**: Fails validation · Not validated · Stale · Validated (ValidationBadge).

Rules:
- Every number shown to a user has a certainty badge or inherits one from its tile/table header.
- **Unknown is never a pass.** A feasibility check with missing inputs shows **Unknown** (grey, `CircleHelp`), counts separately in summaries ("3 pass · 1 fail · 4 unknown"), and blocks "Feasible" as an overall verdict.
- **Failed traffic validation (M3.1)** appears as: a red banner in Simulate; a red ValidationBadge on every traffic-, ODME- and emissions-derived tile, table column, chart title and report section; and a report cover note. It is not collapsible, uses no green anywhere on those outputs, and makes no "accuracy %" claims unless they come from the validation record.
- Severity colours: danger red (fail/conflict), warn orange (attention/stale), info accent. Every severity also has a distinct icon shape (octagon / triangle / circle), so it reads in greyscale and for colour-blind users.
- Map: conflicts get a pulsing-free red halo plus an icon marker. Clearance bands in profiles are red hatched.

---

## 6. Anti-patterns to avoid

| Anti-pattern | Why (evidence / principle) | Do instead |
|---|---|---|
| **Text walls in panels** (multi-sentence hints, explanations inline) | User's explicit complaint; Map Viewer keeps panels to short labels and puts detail in panes. `[EXCERPT]` | One-line hint max. Explanations go in a `CircleHelp` popover or docs link. Engineering detail lives under "Details ▸". |
| **Sentence-length tool names** ("Draw Area and Map Selected Area (import infrastructure)") | Current `tools.ts` | 1–2 word noun on the button ("Import area"); verb phrase in the tooltip. |
| **Misleading metaphors** (Compass = junction, Layers = flyover, Settings = utility, Hammer = metro+road) | Current `tools.ts`. Icons collide with universal meanings (navigation, layers, preferences). | Icon table in §2.3. One meaning per icon. |
| **Decorative or fake controls** (buttons that do nothing, placeholder charts, "coming soon" tools in toolbars) | Mission brief: "Do not create decorative controls or fake functionality". | Hide unbacked tools. Show capability gaps as **EmptyState/Unknown** cards with what's needed. |
| **Unknown rendered as zero or green** | Brief rule: missing data = UNKNOWN, never a pass. FHWA: QL-D records are for planning only. `[EXCERPT]` | Use "—" plus the Unknown badge, and a separate count in summaries. |
| **Precision theatre** (3 decimal places on estimates, crisp tubes for record-only utilities) | ASCE 38 quality levels encode uncertainty. `[EXCERPT]` | Round to meaningful precision; hatched/fuzzy rendering for QL-D/C; ranges. |
| **Pretty charts hiding failed validation** | Brief: "Never make the failed traffic validation look reliable." | ValidationBadge on every derived output (§5.7). |
| **Multiple overlapping floating panels on tablet** | Map loses space; touch mis-hits. | One overlay at a time (§5.4). |
| **Mode traps** (drawing tool stays active, no exit hint) | Common GIS usability issue `[PROPOSAL]` | Esc → Select; status line shows how to finish/cancel. |
| **Hidden underground** (subsurface reachable only via a tool in Build) | Mission: make Underground easy to discover. | Rail workspace + Design toolbar shortcut (§2.2–2.4). |
| **Global ground transparency** making the whole city ghostly | ArcGIS suggests clipping to a local extent `[EXCERPT]`; Cesium `translucency.rectangle` `[FETCHED]` | Limit translucency/cutaway to the AOI. |
| **Silent cross-project edits** | Mission §6 | Issues in both projects; read-only links; duplicate-to-edit for locked alternatives. |
| **Colour as the only signal** | WCAG 2.2 SC 1.4.1 | Icon + text on every badge; patterns on the map. |
| **Icon-only rail** | Discoverability of 7 workspaces. | Always-visible short labels. |

---

## 7. Sources (all accessed 2026-11-13)
| # | Source | Publisher / date (if given) | Label |
|---|---|---|---|
| 1 | https://cesium.com/learn/cesiumjs/ref-doc/GlobeTranslucency.html | Cesium, CesiumJS 1.147 ref | FETCHED |
| 2 | https://cesium.com/learn/cesiumjs/ref-doc/Globe.html | Cesium, 1.147 | FETCHED |
| 3 | https://cesium.com/learn/cesiumjs/ref-doc/ClippingPlaneCollection.html | Cesium | EXCERPT |
| 4 | https://cesium.com/learn/cesiumjs-learn/cesiumjs-clipping-polygons | Cesium tutorial | EXCERPT |
| 5 | https://cesium.com/blog/2020/06/16/visualizing-underground | Cesium, O. Shehata, 2020-06-16 | EXCERPT |
| 6 | https://cesium.com/blog/2020/06/01/cesium-june-release | Cesium, 2020-06-01 | EXCERPT |
| 7 | https://community.cesium.com/t/help-us-test-the-new-underground-features-in-cesiumjs/9581 | Cesium forum, 2020-05-08 | EXCERPT |
| 8 | https://github.com/CesiumGS/cesium/pull/8867 | CesiumGS (undergroundColor), merged 2020-05-21 | EXCERPT |
| 9 | https://doc.esri.com/en/arcgis-urban/latest/help/help-intro.html | Esri, ArcGIS Urban | FETCHED |
| 10 | https://doc.esri.com/en/arcgis-urban/latest/help/help-projects-scenarios.html | Esri | EXCERPT |
| 11 | https://doc.esri.com/en/arcgis-urban/latest/get-started/get-started-plans.html | Esri | EXCERPT |
| 12 | https://doc.esri.com/en/arcgis-urban/latest/get-started/get-started-analysis.html | Esri | EXCERPT |
| 13 | https://doc.arcgis.com/en/urban/12.1/help/help-configure-plan.htm ; …/help-create-plan.htm | Esri | EXCERPT |
| 14 | https://doc.esri.com/en/arcgis-online/latest/get-started/get-started-with-mv.html | Esri, ArcGIS Online | EXCERPT |
| 15 | https://www.esri.com/arcgis-blog/products/arcgis-online/mapping/interface-enhancements-for-the-new-map-viewer | Esri blog, 2021-04-14 | EXCERPT |
| 16 | https://developers.arcgis.com/javascript/latest/sample-code/scene-underground | Esri | EXCERPT |
| 17 | https://doc.esri.com/en/arcgis-online/latest/create-maps/configure-ground-in-scene.html | Esri | EXCERPT |
| 18 | https://doc.arcgis.com/en/3d/workflows/visualization/utility-layers.htm ; …/subsurface-geological-layers.htm ; …/explore-layers-and-scenes.htm | Esri | EXCERPT |
| 19 | https://developers.arcgis.com/javascript/latest/references/map-components/arcgis-slice/ | Esri | EXCERPT |
| 20 | https://developers.arcgis.com/javascript/latest/sample-code/elevation-profile/ | Esri | EXCERPT |
| 21 | https://doc.arcgis.com/en/arcgis-earth/use/environment-effects.htm | Esri | EXCERPT |
| 22 | https://developers.arcgis.com/calcite-design-system/components/shell-panel ; …/action-bar ; …/foundations/layouts/ ; …/foundations/tokens/reference/ | Esri Calcite | EXCERPT |
| 23 | https://docs.qgis.org/latest/en/docs/user_manual/introduction/qgis_gui.html ; https://docs.qgis.org/3.44/en/docs/training_manual/basic_map/overview.html | QGIS | EXCERPT |
| 24 | https://www.itwinjs.org/learning/glossary/ | iTwin.js, updated 2025-06-11 | FETCHED |
| 25 | https://developer.bentley.com/api-groups/project-delivery ; https://developer.bentley.com/apis/visualization/ | Bentley | EXCERPT |
| 26 | https://bentleysystems.service-now.com/community?id=kb_article&sysparm_article=KB0036088 | Bentley community (Version Compare) | EXCERPT |
| 27 | https://help.opencitiesplanner.bentley.com/index.html@p=2762.html ; …@p=4069.html | Bentley OCP guide | EXCERPT |
| 28 | https://docs.bentley.com/LiveContent/web/OpenRoads%20Designer-v2025.1/Help/en/topics/1296840/GUID-5DFFFEF6-34BA-497C-8AEC-EDC54942A43D.html | Bentley OpenRoads | EXCERPT |
| 29 | https://www.autodesk.com/learn/ondemand/tutorial/navigate-the-infraworks-user-interface ; https://help.autodesk.com/cloudhelp/ENU/InfraWorks-Basics/files/GUID-81B693C0-930C-44D2-B251-F7841C7D79B0.htm ; https://c3dkb.dot.wi.gov/Content/c3d/infrawrks/iwx-lvl02/iwx-lvl02-prpsl.htm | Autodesk; WisDOT | EXCERPT |
| 30 | https://docs.kepler.gl/docs/user-guides/h-playback ; …/e-filters ; …/m-map-settings ; https://docs.kepler.gl/docs/api-reference/actions/actions | kepler.gl | EXCERPT |
| 31 | https://urbanfootprint-v1.readthedocs.io/en/latest/scenario_editor ; https://urbanfootprint.us.document360.io/docs/analysis-modules | UrbanFootprint | EXCERPT |
| 32 | https://www.sla.gov.sg/news/press-release/international-seminar-on-unggim----effective-land-administration----welcome-address-by-mr--colin-low--chief-executive--singapore-land-authority/ | SLA, 2022-05-17 | EXCERPT |
| 33 | https://sec.ethz.ch/news-events/news/2024/06/looking-underground-looking-to-the-future.html | Singapore-ETH Centre, 2024-06-14 | EXCERPT |
| 34 | https://www.fhwa.dot.gov/programadmin/sueindex.cfm | US FHWA | EXCERPT |
| 35 | https://ascelibrary.org/doi/book/10.1061/9780784415870 | ASCE/UESI/CI 38-22, 2022-07-20 | EXCERPT (standard text itself not read) |
| 36 | https://www.apwa.org/wp-content/uploads/Uniform-Color-Code-1.pdf | APWA | EXCERPT |
| 37 | https://www.w3.org/TR/WCAG22/ (SC 1.4.1, 1.4.3, 1.4.11, 2.5.8) | W3C | Not fetched this pass; SC numbers are stable public references |
| — | lucide-react 1.28.0 exports in `/workspace/work/virtualplanner/frontend/node_modules` | local | VERIFIED-LOCAL |

## 8. Open questions / gaps
- **Indian / Pune utility colour and quality conventions:** Unknown. No source checked for whether ASCE 38 or APWA is used in India; both are shown here as US references.
- **Esri Indoors, Cesium Stories, Cityzenith, Twinmotion, iTwin UI kit:** not researched.
- **Clearance rules between utilities and tunnels:** not in scope here. They must come from the engineering-research agent with cited standards. The UI must show "no rule → Unknown", never a default.
- **Depth slider range:** this doc gives no standard default. It derives from the loaded data.
