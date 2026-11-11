# Investigation Requirements Generator — Specification

Date: 2026-11-11. Status: **specification + data, UNTESTED** (no code consumes it yet). Machine-readable rules: `frontend/src/engine/feasibility/investigationRules.json` (schemaVersion 1). Research and source register (S-ids): `docs/RESEARCH_FEASIBILITY_AND_INVESTIGATION.md`. Product context: `docs/PRODUCT_VISION.md`.

> The generator produces a list of investigations, methods, deliverables, disciplines, and standards/authorities **to identify and verify**. It is a planning brief. It never states that a proposal is safe, constructible, permitted, approved or that land is available.

## 1. Inputs

1. **Proposal** — a scenario object of one `proposalType` (management: signal_optimisation, signal_coordination, adaptive_signal_control, turn_restriction, one_way_system, lane_use_management, access_management, bus_priority, parking_loading_management, freight_time_restriction, pedestrian_crossing; surface: junction_redesign, road_widening, additional_lane, new_road, bridge; grade-separated: flyover, underpass, elevated_corridor, interchange, ramp_link; underground: tunnel, underground_road) with geometry, and optional depth/footprint.
2. **Site attributes** — computed by the Spatial Feasibility Engine from available layers (OSM extract, imported DP road lines, WRD flood lines, ASI/PMC heritage locations, metro alignment, survey results). Each attribute carries a value **or `unknown`**, plus the dataset and certainty used. Attribute list: see `siteAttributes` in the JSON (proposalType, hasConstructionFootprint, isUnderground, excavationDepthM, distanceToWaterwayM, crossesWaterway, withinBlueLine, withinRedLine, distanceToAsiProtectedLimitM, distanceToListedHeritageM, buildingsInInfluenceZone, distanceToMetroM, crossesRailway, geotechDataAvailable, groundwaterDataAvailable, utilityDataLevel, treesInFootprint, outsideExistingRoW).
3. **Thresholds** — each with a declared basis. Statutory and authority-stated values carry sources; hypothetical screening values must be displayed as *hypothetical, configurable*.

## 2. Evaluation logic (tri-state, conservative)

- Each condition → `true | false | unknown` (missing/null/`unknown` attribute ⇒ `unknown`).
- `all` block: false if any false; true if all true; else unknown. `any` block: true if any true; false if all false; else unknown. Empty `all` and no `any` ⇒ matches on proposal type.
- **Rule true** ⇒ add its investigations and flags.
- **Rule unknown** ⇒ add its investigations and flags **and** a data-gap finding (certainty `unknown`) naming the missing attributes. *Missing data never suppresses an investigation* (principle 8; mission §7 "missing data must not be interpreted as proof that a project is feasible").
- **Rule false** ⇒ not fired; the finding records the data that excluded it with that data's certainty (e.g. "metro >500 m — verified from available data (OSM railway=subway), dataset completeness not guaranteed").
- Investigations required by several rules are de-duplicated; the output lists every triggering rule id and the union of source refs.
- Output ordering: critical flags → sequencing prerequisites (e.g. metro NOC before boreholes; flood-line plans before hydraulic design) → investigations grouped by discipline.

Pseudo-code (for the implementation agent):

```ts
type Tri = true | false | 'unknown';
function evalCond(c, site, th): Tri {
  const v = site[c.attr]?.value;
  if (v === undefined || v === null || v === 'unknown') return 'unknown';
  const ref = c.threshold ? th[c.threshold].value : c.value;
  switch (c.op) { case 'eq': return v === ref; case 'gt': return v > ref;
    case 'lte': return v <= ref; case 'in': return ref.includes(v); }
}
function evalBlock(conds, mode): Tri { /* all/any tri-state as above */ }
```

## 3. Certainty labels (mission §7)

| id | Label | Use |
|---|---|---|
| verified_from_available_data | Verified from available data | A named dataset positively shows the fact. Never implies completeness. |
| estimated | Estimated | Calculated from approximate inputs (e.g. AMASR buffer from a monument point rather than its protected limit). |
| inferred | Inferred | Reasoned, not measured (e.g. CRZ not applicable to inland Pune). |
| unknown | Unknown | No data. Never shown as "clear"/"feasible". |
| requires_field_investigation | Requires field investigation | Only a site survey/test can establish it (default for every generated investigation). |
| requires_professional_assessment | Requires professional assessment | Needs a qualified professional's or statutory authority's judgement/sign-off. |

UI rule: a finding may only be labelled `verified_from_available_data` when it *restricts* (shows a constraint exists). Absence of a constraint in data is at best `unknown` unless the layer is an authoritative, complete, imported dataset (e.g. certified WRD flood-line plan) — then "outside blue line per WRD plan dated …" with `verified_from_available_data`.

## 4. Thresholds
| Key | Value | Basis | Note | Sources |
|---|---|---|---|---|
| `asiProhibitedM` | 100 m | statutory | AMASR s.20A minimum, measured from protected limit; extendable by notification | S1, S2 |
| `asiRegulatedM` | 300 m | statutory | 100 m prohibited + 200 m regulated (s.20B minimum); extendable | S1, S2 |
| `metroNocM` | 20 m | authority_statement | Pune Metro public statement (Apr 2026) as reported; confirm with MahaMetro | S9 |
| `metroPlanningAuthorityM` | 500 m | authority_statement | Reported metro planning-authority extent either side of route; confirm | S9 |
| `waterProximityM` | 50 m | hypothetical | Screening only; no statutory basis found. Flood-line layer supersedes it. | — |
| `influenceZoneM` | 30 m | hypothetical | Screening default for building-impact buffer; actual zone to be set by geotechnical engineer (depends on depth, ground, method). | — |
| `heritageProximityM` | 50 m | hypothetical | Screening buffer for PMC-listed heritage; no statutory buffer found for listed (non-ASI) properties. | — |
| `deepExcavationM` | 3 m | hypothetical | Screening depth above which groundwater/dewatering is flagged. | — |
| `stateTreeAuthorityTrees` | 200 trees | statutory_excerpt | 2021 amendment referral threshold as read in excerpt; verify consolidated text | S5 |

## 5. Rule table (proposal type × site attributes → investigations)

Generated from the JSON (keep them in sync — the JSON is canonical). "—" in Sources means the rule rests on general engineering practice; no statutory source was found and none is claimed.

| Rule | Applies to | Condition | Required investigations | Key flag | Sources |
|---|---|---|---|---|---|
| R01 Any construction footprint: base surveys | all physical | `hasConstructionFootprint eq True` | topographic_survey, utility_survey, tree_census, construction_traffic_plan, environmental_screening | — | S4, S8, S12, S23 |
| R02 Management measure: traffic evidence | all management | `type only` | traffic_data_collection | info: No physical investigation expected unless civil works are added (then R01 applies). Statut… | S21, S22 |
| R03 Underground works: geology, groundwater, tunnel engineering | tunnel, underground_road, underpass | `isUnderground eq True` | geological_mapping, geotechnical_investigation, groundwater_investigation, seismic_assessment, tunnel_engineering_studies | critical: Underground conditions are unknown until investigated. The tool cannot state that a tunnel… | S16, S18, S19, S20 |
| R04 Underground/deep works near buildings | all physical | `isUnderground eq True AND buildingsInInfluenceZone gt 0` | building_condition_survey, construction_impact | high: Buildings within the (hypothetical) influence zone; settlement/vibration risk requires pro… | — (engineering practice) |
| R05 Foundations or excavation near buildings (surface/grade-separated) | junction_redesign, road_widening, additional_lane, new_road, bridge, flyover, underpass, elevated_corridor, interchange, ramp_link | `hasConstructionFootprint eq True AND buildingsInInfluenceZone gt 0` | building_condition_survey, construction_impact | — | — (engineering practice) |
| R06 Within 20 m of metro viaduct or tunnel | all physical | `distanceToMetroM lte metroNocM` | metro_interface | critical: MahaMetro NOC needed before any works, including boreholes/geotechnical study and utility … | S9 |
| R07 Within metro planning-authority area | all physical | `distanceToMetroM lte metroPlanningAuthorityM` | metro_planning_check | — | S9 |
| R08 Near or crossing a water body | all physical | `crossesWaterway eq True OR distanceToWaterwayM lte waterProximityM` | flood_line_verification, hydrology_hydraulics | high: River corridor: blue/red flood-line status must be obtained from the Water Resources Depar… | S6 |
| R09 Inside blue flood line (prohibitive zone) | all physical | `withinBlueLine eq True` | flood_line_verification, hydrology_hydraulics, environmental_screening | critical: UDCPR reg. 3.1.3 (as quoted by NGT, Feb 2026) prohibits construction between river bank an… | S6 |
| R10 Between blue and red flood lines (restrictive zone) | all physical | `withinRedLine eq True AND withinBlueLine eq False` | flood_line_verification, hydrology_hydraulics | high: Restrictive zone: UDCPR 3.1.3 permits construction at 0.45 m above red flood line level (b… | S6 |
| R11 Within ASI prohibited area (<=100 m of protected limit) | all physical | `distanceToAsiProtectedLimitM lte asiProhibitedM` | heritage_impact_assessment, building_condition_survey | critical: NMA: no construction, including Government/public works, permitted in the prohibited area … | S1, S2, S3 |
| R12 Within ASI regulated area (100-300 m) | all physical | `distanceToAsiProtectedLimitM gt asiProhibitedM AND distanceToAsiProtectedLimitM lte asiRegulatedM` | heritage_impact_assessment | high: Permission via ASI/NMA Competent Authority required for construction in regulated area. | S1, S2 |
| R13 Near PMC-listed heritage property | all physical | `distanceToListedHeritageM lte heritageProximityM` | heritage_impact_assessment, building_condition_survey | high: PMC Heritage Committee consultation (DCPR-2017 cl.39 / UDCPR heritage regulation) to verif… | S10, S11 |
| R14 Foundations with no site geotechnical data | bridge, flyover, underpass, elevated_corridor, interchange, ramp_link, tunnel, underground_road, road_widening, new_road, junction_redesign, additional_lane | `hasConstructionFootprint eq True AND geotechDataAvailable eq False` | geotechnical_investigation | high: Soil/rock conditions unknown. Pune is broadly Deccan Trap basalt with alluvium near rivers… | S16, S19 |
| R15 Deep excavation with no groundwater data | all physical | `excavationDepthM gt deepExcavationM AND groundwaterDataAvailable eq False` | groundwater_investigation | — | S16 |
| R16 Trees affected | all physical | `treesInFootprint gt 0` | tree_census | high: Tree Authority permission under s.8 of the 1975 Act applies to government bodies too. Larg… | S4, S5 |
| R17 Footprint beyond existing right-of-way | all physical | `outsideExistingRoW eq True` | topographic_survey, land_acquisition_social | high: Land availability cannot be established from maps. Ownership, acquisition and rehabilitati… | S12 |
| R18 Widening / new road | road_widening, additional_lane, new_road | `type only` | pavement_drainage, land_acquisition_social | info: Consider whether the diagnosed cause is addressable by management measures first. | S24 |
| R19 Bridge | bridge | `type only` | hydrology_hydraulics, flood_line_verification, structure_design_basis, geotechnical_investigation | — | S6, S17, S27 |
| R20 Flyover / elevated / interchange / ramp | flyover, elevated_corridor, interchange, ramp_link, underpass | `type only` | structure_design_basis, geometry_access_study, geotechnical_investigation, utility_survey, construction_traffic_plan | info: Check whether downstream junctions can absorb the added flow (simulate with frozen demand)… | S17, S27 |
| R21 Crosses railway | all physical | `crossesRailway eq True` | railway_interface | — | — (engineering practice) |
| R22 Utilities known only from records or not at all | all physical | `utilityDataLevel in ['none', 'records']` | utility_survey | high: Utility positions are not verified; GPR/EM locating and trial pits required. | S23 |

## 6. Investigation catalogue (methods, deliverables, disciplines, standards and authorities to verify)

Every standard/authority entry is something the authority's team must **identify and verify**; editions are those found in the IRC catalogue (Sep 2025) or BIS pages (S17, S19, S20). Clause numbers are deliberately absent.

| Investigation | Methods | Deliverables | Disciplines | Standards (to verify) | Authorities (to verify) |
|---|---|---|---|---|---|
| `topographic_survey` Topographic and right-of-way survey | DGPS/total-station survey; drone/LiDAR survey where permitted; overlay of DP road lines and city survey boundaries | Surveyed base map with levels; Existing RoW boundary plan; Encroachment/obstruction inventory | Land surveyor, Highway/civil engineer, Town planner | IRC:86-2018 (road widths, guidance only) | PMC/PCMC/PMRDA town planning (DP road lines); Land records (city survey) |
| `utility_survey` Existing utilities investigation | Collect records from all utility owners; Ground penetrating radar (GPR) and electromagnetic locating; Trial pits/trenches to confirm depth and type | Composite utility map with confidence level per line; Utility diversion/protection proposal; List of utility owners consulted | Utility survey specialist, Civil engineer | IRC:98 (accommodation of utilities in urban roads) to identify and verify; Indian standard for utility quality levels: not found (to identify and verify); ASCE 38 commonly referenced (to identify and verify) | PMC water supply/drainage; MSEDCL (power); MNGL (gas); Telecom operators |
| `tree_census` Tree census and impact survey | Tree-by-tree census in and near footprint: species, girth, age, condition, heritage status; Options: retain / transplant / fell | Tree inventory map and table; Avoidance/transplant plan; Tree Authority application package (if felling unavoidable) | Arborist/botanist, Environmental specialist | Maharashtra (Urban Areas) Protection and Preservation of Trees Act 1975, s.8 (permission); 2021 amendment (heritage trees, >200 trees) to identify and verify | PMC Tree Authority / Tree Officer; Maharashtra State Tree Authority (large applications) to identify and verify |
| `construction_traffic_plan` Construction staging and traffic diversion study | Simulate diversion scenarios in this tool on frozen baseline demand; Phasing plan; Emergency-access check | Staging drawings; Diversion plan with modelled impacts (model output, labelled); Emergency-service access statement | Traffic engineer, Construction planner | IRC:SP:43-2022 traffic management techniques to identify and verify | Pune City Traffic Police to identify and verify; Fire brigade/emergency services to identify and verify |
| `geotechnical_investigation` Subsurface (geotechnical) investigation | Boreholes with SPT/sampling in soil and core drilling in rock; Laboratory tests (index, strength, UCS on rock cores); Geophysical survey (e.g. seismic refraction/ERT) to interpolate between boreholes | Factual geotechnical report (borelogs, test results); Interpretative report with design parameters; Foundation recommendations (by geotechnical engineer) | Geotechnical engineer, Engineering geologist | IS 1892:2021 subsurface investigation for foundations to identify and verify; IRC:78 (Part 1)-2024 / (Part 2)-2020 foundations to identify and verify | Project owner's engineer; MahaMetro if within 20 m of metro |
| `geological_mapping` Geological mapping and rock mass classification | Surface and borehole geological mapping (basalt flow units, vesicular/amygdaloidal zones, red bole, weathering, joints, faults/lineaments); Rock mass classification (RMR; Q-system); Bhuvan lineament layer as a prompt only | Geological long-section along alignment; Rock mass class distribution with uncertainty; Geotechnical Baseline Report (GBR) input | Engineering geologist, Rock mechanics / tunnel engineer | IS 13365 (Part 1):2025 RMR to identify and verify; IS 15026 (Part 1):2022 / (Part 2):2023 to identify and verify; IRC:SP:91-2019 geotechnical investigations chapter to identify and verify | Project owner's engineer |
| `groundwater_investigation` Groundwater investigation | Piezometers with seasonal monitoring; Packer/permeability tests; Dewatering and drawdown impact assessment on nearby wells and buildings | Groundwater level and flow report; Inflow/dewatering estimate (by specialist); Monitoring plan | Hydrogeologist, Geotechnical engineer | IS 1892:2021 to identify and verify | CGWB/GSDA guidance to identify and verify |
| `seismic_assessment` Seismic hazard input | Confirm seismic zone and site class from current IS 1893 edition; Site-specific study if required by designer | Seismic design basis note | Structural/geotechnical engineer | IS 1893 (current edition; Pune zone to identify and verify) | Project owner's engineer |
| `tunnel_engineering_studies` Tunnel engineering studies | Alignment, depth and cross-section options; Excavation method study (conventional/NATM vs TBM vs cut-and-cover); Support and lining concept; Ventilation and fire-life-safety concept, emergency egress spacing; Portal drainage and flood protection; Risk register | Concept design report; Fire and life safety strategy; Ventilation concept; Risk register and GBR | Tunnel engineer, Ventilation/fire engineer, Drainage engineer, Structural engineer | IRC:SP:91-2019 Guidelines for Road Tunnels to identify and verify; IS 15026 to identify and verify | PMC/PMRDA (owner); Fire brigade to identify and verify |
| `building_condition_survey` Building condition and settlement-risk assessment | Pre-construction condition survey of buildings in zone of influence (photos, cracks, foundation type if known); Settlement and vibration impact assessment; Instrumentation and monitoring plan (settlement points, tiltmeters, vibration monitors) | Condition survey records; Damage-risk assessment by specialist; Monitoring plan with trigger levels set by engineer | Structural engineer, Geotechnical engineer | No Indian code identified for damage categories (to identify and verify) | PMC building permission department to identify and verify |
| `metro_interface` Metro interface and NOC | Obtain MahaMetro alignment/structure records (depth, lining, viaduct foundations); Apply for NOC before any investigation works (boreholes, trial pits) and before construction; Interface/impact study and monitoring of metro structure | MahaMetro NOC(s); Interface impact assessment; Metro structure monitoring plan | Tunnel/structural engineer, Geotechnical engineer | Metro Railways (Construction of Works) Act 1978 and UDCPR provisions as cited by MahaMetro to identify and verify | MahaMetro (Pune Metro) planning department; PMRDA / Line 3 concessionaire for Line 3 to identify and verify |
| `metro_planning_check` Metro planning-authority check | Confirm whether the site is within the metro planning-authority area (reported 500 m either side) and what permissions apply | Written confirmation from MahaMetro | Town planner | — | MahaMetro to identify and verify |
| `hydrology_hydraulics` Hydrology and hydraulic study | Design flood estimation; Hydraulic modelling (water levels, afflux, velocities); Scour assessment for piers/abutments; River morphology | H&H report; Afflux and scour assessment; Effect on blue/red flood lines | Hydrologist, Hydraulic engineer | IRC bridge codes (IRC:5-2024, IRC:78) to identify and verify; IRC river training guidance (edition to identify and verify) | Water Resources Department, GoM; PMC |
| `flood_line_verification` Flood-line verification | Obtain certified blue and red flood-line plans from Water Resources Department; Overlay on proposal; import into this tool as a layer | Flood-line overlay with source and date; Statement of zone (prohibitive/restrictive/outside) | Hydraulic engineer, Town planner | Irrigation Dept circular 21.09.1989; UDCPR reg. 3.1.3 (as quoted by NGT) to identify and verify | Water Resources Department, GoM; PMC |
| `heritage_impact_assessment` Heritage Impact Assessment | Measure distance from protected-area limit (not centroid); Visual, structural and vibration impact on monument/listed building; Consult heritage bodies | Heritage Impact Assessment report; NOC application package (if within regulated area) | Conservation architect, Structural engineer | AMASR Act 1958 as amended 2010, ss.20A/20B to identify and verify; UDCPR heritage regulation / DCPR-2017 cl.39 to identify and verify | NMA / ASI Competent Authority (centrally protected); PMC Heritage Committee (PMC list) |
| `land_acquisition_social` Land requirement, acquisition and social impact | Plot-level land requirement from surveyed footprint; Affected structures and households census; Title/ownership verification through land records | Land plan schedule; Affected structures inventory; Social impact and rehabilitation framework (by specialist) | Land acquisition officer, Social impact specialist, Town planner | Applicable land acquisition law and DP/TDR mechanisms to identify and verify | PMC/PMRDA land & estate; District Collector to identify and verify |
| `pavement_drainage` Pavement and drainage investigation | Pavement condition and subgrade testing; Storm-water drainage capacity check | Pavement investigation report; Drainage design basis | Pavement engineer, Drainage engineer | IRC pavement and drainage guidelines to identify and verify | PMC road / drainage departments |
| `structure_design_basis` Structure design basis (bridge/grade separator) | Span arrangement and clearance study; Load and code basis; Bearing/foundation concept from geotechnical results | Design basis report; General arrangement drawings (concept) | Bridge/structural engineer | IRC:5-2024; IRC:6-2017; IRC:78 (Part 1)-2024 / (Part 2)-2020; IRC:SP:90-2023 (grade separators); IRC:92-2017 (interchanges) | Owner's proof consultant to identify and verify |
| `geometry_access_study` Ramp geometry, clearance and frontage-access study | Vertical clearance and gradient check; Ramp landing locations vs junctions and frontage access; Service-road needs | Geometric concept; Access impact statement | Highway/traffic engineer | IRC:SP:90-2023; IRC:92-2017; IRC:86-2018 | PMC/PMRDA; Traffic Police to identify and verify |
| `railway_interface` Railway interface | Obtain railway land/structure records; Crossing design concept and clearance | Railway approval package to identify and verify | Bridge engineer | Railway standards to identify and verify | Indian Railways (Central Railway, Pune division) to identify and verify |
| `environmental_screening` Environmental screening and applicability check | Record facts deciding EIA applicability: road classification, length, additional RoW/land, built-up area, distance to protected/eco-sensitive areas; Noise, vibration, air-quality and construction-waste baseline | EIA applicability note for authority confirmation (never a self-determination); Environmental baseline/EMP scope | Environmental specialist | EIA Notification 2006 as amended (items 7(f), 8) to identify and verify | SEIAA Maharashtra / MoEFCC to identify and verify; MPCB to identify and verify |
| `construction_impact` Construction disruption, noise and vibration assessment | Sensitive receptor inventory (schools, hospitals, heritage); Noise/vibration/air baseline and prediction; Working-hours and access constraints | Construction impact assessment; Mitigation and monitoring plan | Environmental specialist, Acoustic/vibration engineer | to identify and verify | MPCB to identify and verify; PMC |
| `traffic_data_collection` Traffic evidence for management measures | Classified turning-movement counts (peak and off-peak); Saturation flow and queue length observation; Signal plan inventory; Bus dwell/bunching, parking accumulation surveys as relevant | Measured dataset with provenance, imported into the Traffic Data Manager; Before/after monitoring plan | Traffic engineer | IRC:93-1985 signals to identify and verify; Indo-HCM 2017 (saturation flow, PCU, control delay LOS) to identify and verify; IRC:124-2017 / IRC:SP:43-2022 for bus priority to identify and verify | Pune City Traffic Police to identify and verify; PMPML (bus operator) for bus measures to identify and verify |

### 6.1 Worked examples (illustrative, synthetic inputs)

- **Signal re-timing at a junction** → R02 only: `traffic_data_collection`. Output also states: no physical investigation unless civil works are added.
- **Flyover 15 m from the PCMC–Swargate viaduct, OSM shows buildings within 30 m, no geotech data, utilities known from records only, flood-line layer not imported, 400 m from river** → R01, R05, R06 (critical: metro NOC before boreholes), R07, R14, R20, R22; R08 false on distance (OSM, 400 m > 50 m hypothetical); R09/R10 evaluate *unknown* because flood lines are not imported → they fire with a data-gap finding "WRD flood lines not imported" (conservative by design; see §9 on noise). Tree census required (R01) regardless of OSM tree data.
- **Tunnel under the old city near Shaniwarwada** → R03 (critical), R04, R11 if within 100 m of the protected limit (critical: no construction in prohibited area; subsurface extent to verify), R06 if within 20 m of the underground metro, R14, R15, R22. Brief leads with: "Underground conditions are unknown; this tool cannot state that the tunnel is safe or constructible."

## 7. Document template — Investigation Requirements Document (mission §10, 18 sections)

Export format: PDF and DOCX (implementation choice belongs to the architecture docs). Every value carries a provenance tag: **measured / estimated / model output / assumption / unknown**. Header and footer on every page: *"Planning brief for professional investigation. Not an engineering assessment or statutory approval."*

| # | Section | Content source | Notes / required wording |
|---|---|---|---|
| 1 | Project name | User | — |
| 2 | Project location | Geometry centroid + ward/locality (reverse geocode or user) | Coordinates in WGS84 |
| 3 | Proposal type | Scenario object | One of the proposalTypes |
| 4 | Proposed geometry and coordinates | Scenario geometry export (GeoJSON appendix), plan figure | "Conceptual geometry, not a design" |
| 5 | Reason for considering the proposal | Diagnosis module: cause attribution and evidence | Include alternatives considered (management options) and why they were insufficient |
| 6 | Existing traffic conditions | Measured data (provenance) + baseline model | Separate measured vs modelled |
| 7 | Preliminary simulation results | Scenario comparison on frozen baseline demand, seed, period | State validation status of the model at this location (incl. failures) |
| 8 | Expected benefits | Comparison deltas | "Model output; subject to validation"; show what gets worse too |
| 9 | Known constraints | Feasibility findings with certainty labels | Each line: finding, dataset, certainty |
| 10 | Required surveys and investigations | Generator output (de-duplicated investigations) | Each with triggering rule ids |
| 11 | Recommended investigation methods | `investigations[*].methods` | "Scope, spacing and depth to be set by the responsible professional" |
| 12 | Expected technical deliverables | `investigations[*].deliverables` | — |
| 13 | Relevant professional disciplines | `investigations[*].disciplines` | — |
| 14 | Applicable standards and approval authorities to identify and verify | `standards`, `authorities`, rule flags, sources table | Heading must include "to identify and verify"; list S-sources with URL and evidence level |
| 15 | Outstanding risks and unknowns | Data-gap findings, critical flags, unknown attributes | Never empty for physical proposals |
| 16 | Space for findings and supporting evidence | Blank fields per investigation; attachment list | Filled via review records (§8) |
| 17 | Responsible team or reviewer | Review records | Name, role, organisation |
| 18 | Review status and dates | Review records | Status vocabulary from §8; explicit "not an approval" note |

## 8. Review record model (review ≠ approval)

```ts
interface ReviewRecord {
  id: string;                    // uuid
  projectId: string;
  scenarioId: string;
  scenarioVersion: string;       // immutable version the review refers to
  itemType: 'investigation' | 'finding' | 'document' | 'scenario';
  itemId: string;                // e.g. 'geotechnical_investigation' or finding id
  reviewer: { name: string; role: string; organisation: string; discipline?: string };
  status: 'not_started' | 'in_progress' | 'evidence_submitted' | 'reviewed_no_issues'
        | 'reviewed_issues_found' | 'further_investigation_required' | 'not_applicable_justified';
  evidence: Array<{
    fileId: string; fileName: string; sha256: string;   // tamper-evident
    kind: 'survey_report' | 'test_results' | 'drawing' | 'authority_letter' | 'photo' | 'other';
    issuedBy?: string; issuedOn?: string;               // ISO date
    provenance: 'measured' | 'estimated' | 'model_output' | 'assumption' | 'unknown';
  }>;
  comment: string;
  externalReference?: { authority: string; reference: string; date: string }; // e.g. an NOC number, recorded as data, not as an approval by this tool
  createdAt: string; createdBy: string;                 // append-only; edits create a new record
  supersedes?: string;
}
```

Rules:
- **No status means approval.** There is deliberately no `approved` value. A statutory permission obtained outside the tool may be recorded as `externalReference` with the authority's own reference; the UI shows it as "recorded by <user>, not verified by this tool".
- **Append-only audit trail**; a change creates a new record that `supersedes` the previous one. Records bind to an immutable scenario version; editing the scenario marks prior reviews *stale* (shown, not deleted).
- `not_applicable_justified` requires a comment and is shown in §15 of the document.
- A project-level summary may say "N of M investigation items reviewed" — never "project approved/cleared".
- Evidence files are hashed (sha256) at upload for integrity.

## 9. Open items for implementation

- Spatial Feasibility Engine must compute the attributes with per-attribute certainty and dataset name; imported layers (DP road lines, WRD flood lines, heritage boundaries, utility surveys) need a provenance record (source, date, issuing office).
- The hypothetical thresholds (`waterProximityM`, `influenceZoneM`, `heritageProximityM`, `deepExcavationM`) must be user-configurable per project and printed in §9/§15 of the document.
- Items marked *to verify* in the research doc §6 must stay visible in output until a user records the verification with evidence.
- Noise trade-off: with no flood-line layer, R09/R10 fire as data gaps for every physical proposal. Any pre-filter (e.g. skip when far from all waterways) would be a hypothetical threshold and must be labelled as such; the default here is not to filter.
- Tests to add when implemented: tri-state evaluation (unknown never suppresses), de-duplication, threshold basis rendering, no-"approved" vocabulary check across generated documents.
