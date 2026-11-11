# Infrastructure Feasibility Engine and Investigation Requirements Documents

Date: 2026-11-11. Mission §§7, 9, 10 (Phase 3). Rule data and research: `frontend/src/engine/feasibility/investigationRules.json`, `docs/INVESTIGATION_REQUIREMENTS.md`, `docs/RESEARCH_FEASIBILITY_AND_INVESTIGATION.md` (source register S1–S27). This file documents the implementation.

> The engine **screens**; it never decides. Its output has `verdict: 'screening_only'` (the backend rejects anything else). Missing data is reported as **unknown** and never removes an investigation. Generated documents state on every page that they are *not an engineering assessment or statutory approval*. No review status means approval.

## 1. What it does

1. In **Build**, select a drawn road, flyover or metro+road object → **Feasibility & investigations** (button at the top of the properties panel).
2. Choose the proposal type (road objects: new road, widening, additional lane, tunnel, underground road, underpass, bridge, ramp, junction redesign; flyover objects: flyover, elevated corridor, interchange, ramp, bridge), level (surface / elevated / underground), width and, if known, excavation depth. There is no separate tunnel drawing tool: a tunnel is a drawn road assessed as *Tunnel / Underground* (the topology/EditingEngine is out of scope for this task).
3. **Assess site** → the frontend fetches site data for the alignment, computes site attributes and findings (each with a certainty label and data source), applies the investigation rules, and stores the run as an immutable assessment.
4. The panel shows the critical/high flags, findings, the investigations checklist (methods, deliverables, disciplines, authorities; current review status per item), **PDF / DOCX** document generation, evidence upload and the review history with an "add review" form.

## 2. Architecture

| Part | File | Status |
|---|---|---|
| Geometry (local equirectangular plane; distances, crossings) | `frontend/src/engine/feasibility/geometry.ts` | UNIT-TESTED (via engine tests) |
| Site attributes + findings | `frontend/src/engine/feasibility/siteAssessment.ts` | UNIT-TESTED |
| Tri-state rule evaluation, de-duplication, flags, data gaps | `frontend/src/engine/feasibility/investigationPlanner.ts` | UNIT-TESTED |
| Object → proposal, scenario → city context | `frontend/src/engine/feasibility/proposal.ts` | type-checked; exercised in browser |
| API client | `frontend/src/engine/feasibility/feasibilityApi.ts` | exercised in browser |
| Panel | `frontend/src/components/FeasibilityPanel.tsx` (+ 1 button / early return in `PropertiesPanel.tsx`) | see §8 |
| Site-data layers builder/reader | `backend/feasibility/build_layers.py`, `layers.py` | built and read (§3) |
| Tables | `backend/feasibility/models.py` | UNIT-TESTED |
| Document model + DOCX/PDF renderers | `backend/feasibility/docgen.py` | UNIT-TESTED |
| Router `/api/feasibility` | `backend/api/feasibility_router.py`; `main.py` adds 2 lines (import + include) | UNIT-TESTED |

The engine runs in the frontend because the drawn proposal and the scenario's city model (including unsaved scenario objects, user-drawn buildings, utilities, metro lines) live there; the backend stores the result and generates documents from the stored JSON, so every document corresponds to a recorded engine run (assessment `sha256` kept).

## 3. Site data and certainty

`GET /api/feasibility/site-data?bbox=…&near_bbox=…` returns OSM elements and a per-layer `{available, source, dataTimestamp | reason}`:

| Layer | Source | Box |
|---|---|---|
| buildings, roads (incl. `bridge`/`tunnel`/`layer`/`width`/`lanes` tags), metro (`railway=subway`, incl. under construction) | existing local OSM index (`osm/index.py`) | buildings/roads: alignment + half width + influence zone + 120 m; metro: + 1 km |
| water (`waterway=*`, `natural=water/wetland`, `water=*`, `landuse=reservoir/basin`), heritage (`historic=*`, `heritage=*`), trees (`natural=tree/tree_row`), railway (rail/light_rail/narrow_gauge/tram) | **new** `feasibility_layers.db`, built by `python -m feasibility.build_layers` from the same Geofabrik extract (explicit maintenance; never automatic). Path: `TWINCITY_FEAS_LAYERS` (default `backend/data/osm/feasibility_layers.db`, git-ignored). Build on 2026-11-11: 74 s; water 1,409, heritage 71, trees 17,695, railway 659 features in the Pune bbox; OSM data of 2026-11-02. | water/heritage/railway: + 1 km; trees: narrow |

Plus the active scenario's city model (buildings, roads with section profiles, flyovers, metro lines, utility objects), de-duplicated against OSM by `osmId`.

**Asymmetry rule** (INVESTIGATION_REQUIREMENTS §3): data may *restrict*; absence never *clears*.

| Attribute | Value when data shows something | When data shows nothing / no layer |
|---|---|---|
| buildingsInInfluenceZone | count within half width + `influenceZoneM` (30 m, hypothetical), *verified from available data*, lower bound | **unknown** (spec: absence = unknown, not zero) |
| distanceToWaterwayM / crossesWaterway | distance to nearest *mapped* feature, *verified* (note: unmapped drains may be closer); crossing *verified* | no feature within 1 km → unknown; no crossing → `false`, *estimated* (small nallahs often unmapped); no layer → unknown |
| withinBlueLine / withinRedLine | — | always **unknown**: WRD flood-line plans are not imported, so R09/R10 always fire as data gaps (spec §9 noise trade-off, not filtered) |
| distanceToAsiProtectedLimitM | only if an OSM feature tagged `heritage=2` / ASI operator lies within 300 m: *estimated* (feature, not notified limit) | unknown (ASI limits not imported) |
| distanceToListedHeritageM | OSM `historic/heritage` feature within 50 m (hypothetical): *estimated* proxy | unknown — the PMC heritage list (S10) is not in the repository; nearby OSM historic features are still listed as findings |
| distanceToMetroM | nearest mapped metro alignment within 1 km, *verified* (centreline, not structure edge) | unknown |
| crossesRailway | *verified* | `false` *estimated* when the layer is loaded; unknown otherwise |
| treesInFootprint | mapped trees in footprint, *estimated* (OSM tree mapping sparse) | unknown |
| outsideExistingRoW | buildings inside a surface footprint → `true` *inferred*; widening wider than OSM `width` / section profile RoW → `true` *estimated* | **unknown** — no DP road-line/city-survey layer; an OSM width tag is not the legal RoW |
| utilityDataLevel | `records` if city-model utility objects are near (*verified* that records exist, positions unverified) | `none` |
| geotech/groundwaterDataAvailable | — | `false` (*verified*: nothing imported into this tool) → R14/R15 fire |
| excavationDepthM | user planning assumption (*estimated*) | unknown |

Findings additionally report: existing roads touched (with width/lanes tags), mapped bridges/tunnels/flyovers within the influence distance (foundations/depths not in data), named historic features near the alignment, and for underground proposals the sentence "This tool cannot state that the tunnel is safe or constructible."

## 4. Investigation rules

`planInvestigations()` implements INVESTIGATION_REQUIREMENTS §2 exactly: condition → `true|false|unknown`; `all`/`any` tri-state; rule `unknown` ⇒ investigations **and** a data-gap entry; rule `false` ⇒ not fired, with the excluding data and its certainty kept in `ruleResults[].evidence`; investigations de-duplicated with all triggering rules and source refs; flags sorted critical → high → info. Hypothetical thresholds (`waterProximityM`, `influenceZoneM`, `heritageProximityM`, `deepExcavationM`) can be overridden per run; statutory / authority-statement thresholds cannot. Thresholds used are carried into the document with their basis.

Proposal-specific outcome on the same site (vitest): tunnel → geological mapping, groundwater, seismic, tunnel engineering + critical R03 flag; flyover → structure design basis, ramp geometry/access, no tunnel studies; widening → pavement/drainage, land acquisition, no structure studies.

## 5. Storage (`fs_*` tables, additive)

| Table | Content |
|---|---|
| `fs_assessments` | id, scenario_id, scenario_version (nullable until the scenario module provides immutable versions), proposal_object_ids, proposal_type, engine & rules version, full assessment JSON + sha256, created_by/at. Immutable; re-assessment = new row. |
| `fs_documents` | generated file (path, sha256, size), format, template version, the free-text inputs used, generated_by/at |
| `fs_evidence` | uploaded file (path, sha256, size, content type), description (required), provenance (measured/estimated/model_output/assumption/unknown), optional investigation id (must be one of the assessment's required investigations), uploaded_by/at |
| `fs_reviews` | **append-only** (no update/delete routes; SQLAlchemy `before_update`/`before_delete` raise): seq, reviewer name, role, organisation, item (assessment or investigation), status, notes, evidence ids (must exist on the assessment), external reference, supersedes, created_at |

Review status vocabulary (task brief; supersedes the draft list in INVESTIGATION_REQUIREMENTS §8): `not_started`, `in_review`, `information_requested`, `reviewed_not_approval` ("Reviewed — not an approval"), `external_approval_recorded_unverified` (requires the authority's reference; API returns `external_reference_verified: false`). There is no `approved` value; every review is returned with `is_approval: false`.

Files: `TWINCITY_FEAS_FILES` (default `backend/data/feasibility_files/`, git-ignored). Uploads are JSON base64 (same pattern as the traffic-data importer, so no `python-multipart` dependency), max 20 MB.

## 6. API (`/api/feasibility`)

`GET /status`, `GET /site-data`, `POST|GET /assessments`, `GET /assessments/{id}`, `POST|GET /assessments/{id}/evidence`, `GET /evidence/{id}/download` (re-checks sha256), `POST|GET /assessments/{id}/reviews`, `POST|GET /assessments/{id}/documents` (`{format: pdf|docx, project_name, location_description, reason, traffic_conditions, simulation_results, expected_benefits, responsible_team, *_provenance}`), `GET /documents/{id}/download`.

## 7. Document

Sections 1–18 exactly as mission §10, from `docgen.build_model()`; DOCX (python-docx) and PDF (fpdf2) render the same model. Header and footer on every page: "Planning brief for professional investigation. Not an engineering assessment or statutory approval." A boxed disclaimer follows the title. Sections 5–8 (reason, traffic, simulation, benefits) are user-supplied: when empty the document says *not provided / unknown / none attached* and what would be needed — nothing is invented and no simulation result is linked automatically yet (the scenario-comparison store belongs to another work package). §9 lists every finding with certainty and source plus the attribute table; §14 is titled "…to identify and verify" and lists standards, authorities, thresholds with basis, and sources with URL/evidence level; §15 is never empty; §16 has ruled blank space per investigation plus any evidence on file (with hash); §17–18 come from review records and carry the "no status means approval" note.

**PDF dependency decision:** fpdf2 (pure Python; deps fonttools + Pillow; no system libraries). Rejected: reportlab (larger, partly C, more API than needed), WeasyPrint (needs Cairo/Pango system libraries), headless Chromium (far too heavy for the backend). Unicode text uses DejaVu Sans when found (`TWINCITY_PDF_FONT_DIR` or common system paths); otherwise core Helvetica with a Latin-1 transliteration.

## 8. Tests and verification

- `backend/tests/test_feasibility.py` (11, synthetic fixtures): screening-only verdict enforced; round-trip; PDF and DOCX generated and downloadable; all 18 section headings present (DOCX text, PDF text via the core-font path), disclaimer in body and header/footer; missing inputs stated as missing; §15 contains data gaps and critical flags; findings keep certainty labels; no "approved / is feasible / land is available" wording; tunnel vs flyover documents differ; evidence hash, validation, download; reviews append-only (seq, superseding leaves the first record unchanged, no PUT/PATCH/DELETE, ORM refuses update/delete), no `approved` status, external approval needs a reference and is unverified; site-data reports missing layers as unavailable. **UNIT-TESTED.**
- `frontend/src/engine/testing/FeasibilityEngine.test.ts` (17, synthetic layers): tri-state logic; unknown never suppresses; threshold override limits; buildings verified vs unknown (not zero) vs no layer; city-model/OSM de-duplication; water distance/crossing/missing layer; flood lines always data gaps; heritage near/far; metro 15 m (critical NOC flag) vs 800 m; railway crossing; widening vs OSM width; missing geotech/utility data ⇒ investigations for every physical type; every finding has an allowed label + source and no feasibility claim; tunnel/flyover/widening plans differ and are de-duplicated. **UNIT-TESTED.**
- Browser: see §9.

## 9. Browser verification

(filled in below after the run)

## 10. Limits and open items

- Not available as data, therefore always unknown: WRD flood lines, ASI protected limits, PMC heritage list, DP road lines / property boundaries, utilities (beyond user-drawn utility objects), boreholes/groundwater, tree census, metro structure depths. Importers for these (GeoJSON with provenance) are the next step (`feasibility_layers` table in SYSTEM_ARCHITECTURE §2.4 not yet built).
- Scenario versions: assessments store `scenario_version = null` until the scenario module provides immutable versions; stale-review marking on scenario edit is therefore not implemented. The panel marks the result "settings changed, not yet re-assessed" when type/level/width differ.
- Reviewer identity is free text (no authentication in the backend).
- Distances are to OSM centrelines/outlines, not to structure edges or notified limits.
- `BridgeFeasibilityEngine` (pass/warn/fail) is untouched and still shown for flyovers; it has no `unknown` state (SYSTEM_ARCHITECTURE gap 16).
