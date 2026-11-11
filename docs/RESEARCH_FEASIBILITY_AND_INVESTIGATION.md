# Research: Spatial Feasibility, Interventions and Investigation Requirements (Pune / India)

Date: 2026-11-11. Scope: mission §§7–10, 13–14. Author: research workstream (documentation only; no code behaviour is claimed here).

## 0. How to read this document

Evidence labels used throughout:

- **[READ]** — the cited page/PDF was opened and the statement was checked against its text on 2026-11-11.
- **[EXCERPT]** — taken from a search-engine excerpt of the cited official page; the page itself was not fully opened (e.g. PDF too large or scanned). Treat as likely but re-check before relying on it in a report to an authority.
- **[SECONDARY]** — from a news report, NGO or third-party guide that quotes the primary text; primary not opened.
- **[TO VERIFY WITH AUTHORITY]** — the applicability, current version, threshold or responsible office could not be established from sources; the platform must present it as a question for the authority, not a fact.
- **[HYPOTHETICAL]** — a screening default chosen for the software, with no statutory or code basis found. Must be shown as configurable and labelled hypothetical in the UI.

No clause numbers are invented. Where a code is named without a clause, it is because only its title/edition was verified.

Source register (IDs are used in `docs/INVESTIGATION_REQUIREMENTS.md` and in `frontend/src/engine/feasibility/investigationRules.json`):

| ID | Source | Publisher / date | Label |
|---|---|---|---|
| S1 | National Monuments Authority FAQ — https://nma.gov.in/show_content.php?lang=1&level=0&lid=9&ls_id=14&nma_type=0 | NMA, Ministry of Culture; page last updated 24 Feb 2025 | READ |
| S2 | AMASR Act 1958 as amended 2010, ss. 20A/20B — https://prsindia.org/files/bills_acts/acts_parliament/2010/ancient-monuments-and-archaeological-sites-and-remains-act-2010.pdf ; https://asi.nic.in/pdf/act2010.pdf | Gazette of India, 29 Mar 2010 | EXCERPT |
| S3 | PIB release "Significant Conservation Works Undertaken by ASI in Maharashtra" — https://www.pib.gov.in/PressReleasePage.aspx?PRID=2198818 ; ASI list of centrally protected monuments (Jan 2024) — https://asi.nic.in/admin/whatsnew/download/585 | PIB 4 Dec 2025; ASI | EXCERPT |
| S4 | Maharashtra (Urban Areas) Protection and Preservation of Trees Act 1975, s. 8 — https://indiankanoon.org/doc/181710067/ | Indian Kanoon copy (pre-2021 text) | READ |
| S5 | Same Act, consolidated text as on 24 Jan 2025 — https://bombayhighcourt.gov.in/bhc/libweb/legislation/acts/1975.44.pdf ; Amendment Act 2021 (Mah. IX of 2021) — https://bombayhighcourt.gov.in/bhc/libweb/legislation/acts/Stateact/2021acts/2021.09.pdf | Govt of Maharashtra | EXCERPT |
| S6 | NGT Western Zone, Execution Application 02/2024 in OA 130/2018, judgment 04.02.2026 (quotes Irrigation Dept circular 21.09.1989 and UDCPR reg. 3.1.3) — https://www.greentribunal.gov.in/gen_pdf_test.php?filepath=L25ndF9kb2N1bWVudHMvbmd0L2Nhc2Vkb2MvanVkZ2VtZW50cy9QVU5FLzIwMjYtMDItMDQvMTc3MDIwNTY3NzEzNDg0OTg3NjE2OTgzMzFlZGM5OTdlLnBkZg%3D%3D | National Green Tribunal, 4 Feb 2026 | READ |
| S7 | SANDRP, "Flood Lines, Riverfront Development & Citizen Heroes: Story of Pune Floods" — https://sandrp.in/2024/08/30/flood-lines-riverfront-development-and-citizen-heroes-story-of-pune-floods | SANDRP, 30 Aug 2024 | SECONDARY (EXCERPT) |
| S8 | EIA Notification 2006 "as amended up to July 2026", item 7(f) and item 8, as quoted in All India Protest guide — https://allindiaprotest.com/guides/do-metro-highway-flyover-projects-need-environmental-clearance-india/ ; primary copy linked there: https://parivesh.nic.in/publicdocument/UPLOAD_OM_NOTIFICATION/IA_DOCS/1018_23072026010355.pdf ; original S.O. 1533(E) 14 Sep 2006 — https://environmentclearance.nic.in/writereaddata/EIA_notifications/2006_09_14_EIA.pdf | MoEFCC; guide dated 26 Oct 2026 | SECONDARY (guide READ; primary not opened) |
| S9 | Indian Express, "Pune Metro issues 'no-NOC, no-work' warning after Shukrawar Peth tunnel breach" — https://indianexpress.com/article/cities/pune/noc-mandatory-pune-metro-warns-of-action-over-borewell-drilling-near-tunnels-10641841/ (MahaMetro public notice: https://www.punemetrorail.org/download/Notice-for-NOC.pdf — scanned, not machine-readable) | Indian Express, 17 Apr 2026 | READ (news); notice not read |
| S10 | PMC Public Notice and Heritage List (DCPR-2017 cl. 39.2; 251 properties, Grades I–III) — https://adc-ecos.enlightcloud.com/1133pmcwebsitev2/s3fs-public/2025-04/The%20heritage%20list%20submitted%20to%20the%20government%20for%20approval%20on%202.4.25..pdf | Pune Municipal Corporation; list submitted to Govt 2 Apr 2025 | READ |
| S11 | UDCPR 2020 sanction notification, 2 Dec 2020 — https://dtp.maharashtra.gov.in/uploads/Gazette-for-UDCPR-Sanctioned.pdf ; PMC copy "Updated-UDCPR-2022" — http://autodcr.pmc.gov.in/swc.client/Downloads/Building%20regulations%20&%20related%20notifications/Updated-UDCPR-2022.pdf | Govt of Maharashtra UDD | EXCERPT |
| S12 | DCPR-2017 for PMC (sanctioned 05/01/2017) — https://adc-ecos.enlightcloud.com/1133pmcwebsitev2/s3fs-public/DP-Plan/old-limit/DCR_PUNE_FINAL.pdf ; PMC DP (old limit) map pages — https://www.pmc.gov.in/en/b/old-pmc-limit | PMC | EXCERPT |
| S13 | PMRDA Development Plan page — https://www.pmrda.gov.in/en/development-plan ; draft DP of PMR 2021–2041 — https://www.pmrda.gov.in/wp-content/uploads/2025/04/Draft_DP_of_PMR2021-2041.pdf | PMRDA | EXCERPT; status TO VERIFY |
| S14 | NRSC thematic maps overview (Bhuvan) — https://www.nrsc.gov.in/nrscnew/Dataproducts_Thematic_overview.php ; Bhuvan vector dataset list — https://bhuvan.nrsc.gov.in/wiki/index.php/List_of_Vector_%28Thematic_Maps%29_datasets | NRSC/ISRO | EXCERPT |
| S15 | OSM Wiki Key:heritage — https://wiki.openstreetmap.org/wiki/Key:heritage ; Key:historic — https://wiki.openstreetmap.org/wiki/Key%3Ahistoric | OpenStreetMap Wiki | EXCERPT |
| S16 | CGWB, Aquifer maps & groundwater management plan, Pune district — https://cgwb.gov.in/sites/default/files/2022-11/pune.pdf ; GSDA Pune district — https://gsda.maharashtra.gov.in/en-pune-district | CGWB / GSDA | EXCERPT |
| S17 | IRC publications catalogue (updated 11 Sep 2025) — https://irc.nic.in/WriteReadData/LINKS/Catalogue%20Updated%2011092025f15024ef-3b1b-4a56-aa71-2e01cc92350e.pdf | Indian Roads Congress | EXCERPT |
| S18 | Draft Amendment No.1 to IRC:SP:91-2019 "Guidelines for Road Tunnels" — https://irc.nic.in///admnis/admin/showimg.aspx?ID=3325 ; IRC:SP:91-2010 (first edition, contents) — https://law.resource.org/pub/in/bis/irc/irc.gov.in.sp.091.2010.pdf | IRC (draft 2026; 2010 edition) | EXCERPT |
| S19 | BIS: IS 1892:2021 "Subsurface investigation for foundations — Code of practice (second revision)"; IS 13365 (Part 1):2025 RMR — https://standards.bis.gov.in (standard-details pages) ; IS 1892:2021 archive — https://archive.org/details/gov.in.is.1892.2021 | BIS | EXCERPT |
| S20 | BIS: IS 15026:2002 "Tunnelling methods in rock masses — Guidelines" — https://archive.org/details/gov.in.is.15026.2002 ; IS 15026 (Part 1):2022 conventional methods — https://archive.org/details/gov.in.is.15026.1.2022 ; IS 15026 (Part 2):2023 TBM — BIS standard-details page | BIS | EXCERPT |
| S21 | PIB, "Shri Nitin Gadkari releases India's first ever Highway Capacity Manual" (Indo-HCM, CSIR-CRRI) — https://www.pib.gov.in/PressReleasePage.aspx?PRID=1520312 | PIB, 12 Feb 2018 | READ |
| S22 | IRC:124-2017 BRT Design Guidelines — https://law.resource.org/pub/in/bis/irc/irc.gov.in.124.2017.pdf ; IRC:70-2017 mixed traffic — https://law.resource.org/pub/in/bis/irc/irc.gov.in.070.2017.pdf ; IRC:SP:43-2022 traffic management techniques (bus priority ch. 8) — https://law.resource.org/pub/in/bis/irc/irc.gov.in.sp.135.2022.pdf ; IRC:SP:118-2018 — https://law.resource.org/pub/in/bis/irc/irc.gov.in.sp.118.2018.pdf ; UTTIPEC Street Design Guidelines (DDA, 2009/2010) — https://uttipec.org.in/PDF/Street%20Design%20Guidelines.pdf | IRC / DDA | EXCERPT |
| S23 | Draft third revision IRC:98 (2024) "Guidelines on accommodation of utility services on roads in urban areas" — https://cdnc.heyzine.com/files/uploaded/20ac93cd57d27de95be942963ed63c37be5134e5-2.pdf ; IRC:98-2011 — https://archive.org/details/gov.in.irc.098.2011 | IRC | EXCERPT |
| S24 | IRC:86-2018 Geometric design standards for urban roads and streets — https://law.resource.org/pub/in/bis/irc/irc.gov.in.086.2018.pdf | IRC | EXCERPT |
| S25 | MahaMetro Pune underground brochure — https://www.punemetrorail.org/download/commuters_guide/Pune-Metro-Underground-Brochure-English.pdf ; PMRDA Line 3 page — https://www.pmrda.gov.in/en/pune-metro-line-3 | MahaMetro / PMRDA | EXCERPT |
| S26 | PMRDA engineering projects menu listing "Yerwada-Katraj Twin Tunnel", "Double Decker Flyover – Pune University", "Outer Ring Road" — https://www.pmrda.gov.in/en/development-plan | PMRDA | EXCERPT |
| S27 | IRC:SP:90-2023 Guidelines for Grade Separators and Elevated Structures — https://law.resource.org/pub/in/bis/irc/irc.gov.in.sp.142.2024.pdf ; IRC:92-2017 Interchanges in urban areas — https://law.resource.org/pub/in/bis/irc/irc.gov.in.092.2017.pdf ; IRC:6-2017 — https://law.resource.org/pub/in/bis/irc/irc.gov.in.006.2017.pdf ; IRC:78 (Part 1)-2024 — https://law.resource.org/pub/in/bis/irc/irc.gov.in.135.2023.pdf ; IRC:78 (Part 2)-2020 — https://law.resource.org/pub/in/bis/irc/irc.gov.in.136.2023.pdf | IRC | EXCERPT |

## 1. Spatial feasibility data available for Pune / India

Rule for every layer below: **presence in a dataset can verify a constraint; absence never verifies feasibility.**

### 1.1 OpenStreetMap (already the network source in this repo)

| Layer | OSM tags | Use | Reliability for feasibility |
|---|---|---|---|
| Buildings | `building=*` (footprints), `building:levels` | Footprint clash with proposed widening/new alignment; count of buildings within an influence buffer | Coverage and accuracy in Pune not measured by this workstream **[unknown]**. Missing polygons are common in volunteered data generally → a clash is *verified from available data*, a non-clash is *unknown*. |
| Land use | `landuse=*`, `leisure=park`, `natural=wood`, `amenity=*` | Context (residential/commercial/green/institutional) | Indicative only; DP zoning (below) is the statutory layer. |
| Water | `waterway=river/stream/canal/drain`, `natural=water`, `water=*`, `waterway=riverbank` / `natural=water`+`water=river` | Proximity to rivers/nallas; bridge requirement | Centrelines are usually present for major rivers (Mula, Mutha, Pawana); bank polygons and minor nallas vary **[unknown coverage]**. Flood lines are **not** in OSM. |
| Heritage | `heritage=*`, `heritage:operator=*`, `historic=*`, `ref:*` (S15) | Locate monuments for AMASR buffers and local heritage listings | `heritage:operator` values for India (e.g. ASI) are community conventions; tagging completeness unknown. Must be cross-checked against the ASI list (S3) and PMC list (S10). |
| Rail / metro | `railway=rail/subway/light_rail`, `tunnel=yes`, `bridge=yes`, `layer=*` | Metro/rail proximity rules; elevation-aware topology | Underground metro alignment depth is not in OSM; treat depth as **unknown**. |
| Trees | `natural=tree`, `natural=tree_row` | Indicative tree presence | Very incomplete in most cities → *never* use absence as "no trees". Tree census by Tree Authority is the source (§1.6). |
| Road width | `width=*`, `lanes=*`, `sidewalk=*` | Existing carriageway estimate | Often missing; estimated widths must be labelled *estimated*. Right-of-way (boundary to boundary) is not an OSM concept. |

Note (repo constraint): Overpass is unreachable from the sandbox (brief); layers must come from the existing OSM extract/index or user import.

### 1.2 Pune Development Plan / statutory planning layers

- **PMC DP (old limits) 2007–2027**: DCPR-2017 sanctioned by Govt notification dated 05/01/2017 (S12 [EXCERPT]); sector-wise DP sheets published by PMC (S12). DP sheets show road lines/widenings, reservations, blue flood line (EP-167 annotation visible on a DP sheet excerpt) and metro alignment marked "indicative" (S12 excerpt). **Use**: import as georeferenced layer by the user; a proposal that follows an existing DP road line is *inferred* to have planning backing, not land availability. Merged villages (2017/2021) have separate plan status **[TO VERIFY WITH AUTHORITY]**.
- **UDCPR 2020** (Unified Development Control and Promotion Regulations for Maharashtra), sanctioned under MRTP Act 1966 s.37(1AA)(c) and s.20(4), notification dated 2 Dec 2020 (S11 [EXCERPT]); PMC hosts an updated 2022 compilation (S11). UDCPR regulation 3.1.3 on construction within blue/red flood lines is quoted verbatim in S6 [READ] (see §1.5). UDCPR also contains a heritage regulation (14.5, grading of listed buildings/precincts — PMC-hosted extract, [EXCERPT]).
- **PMRDA** (metropolitan region outside PMC/PCMC): PMRDA publishes a draft DP for PMR 2021–2041 (S13 [EXCERPT]). A secondary site states the 2021 draft was cancelled in 2025 — **status [TO VERIFY WITH AUTHORITY]**.
- **Right-of-way**: The authoritative RoW for a given road is the DP road line / city survey boundary, not a code minimum. UDCPR defines "road width" as the whole extent within the boundaries as laid down in the city survey or development plan (S11, definition quoted in a UDCPR copy [EXCERPT]). IRC:86-2018 (S24) gives *recommended* land widths for urban road classes [EXCERPT]; these are design guidance, **not** evidence of available land. The platform must treat RoW as *unknown* unless a DP/road-line layer is imported.

### 1.3 Bhuvan (ISRO/NRSC)

NRSC lists thematic datasets on Bhuvan including Carto DEM, LULC at 1:250K, 1:50K and 1:10K, Urban Land Use (NUIS), geomorphology, lineament, flood hazard zonation and flood annual layers, offered as OGC WMS/WMTS (S14 [EXCERPT]). LULC 1:50K cycles 2005-06, 2011-12, 2015-16 are listed with WMS endpoints (S14). **Use**: background context, lineament layer as a *prompt* for geological mapping (not as a fault map for design), Carto DEM for indicative gradients. Licensing/terms for redistribution **[TO VERIFY]**; use as WMS overlay only unless terms allow.

### 1.4 Heritage: ASI monuments and AMASR Act

- **Statutory distances [READ, S1; EXCERPT, S2]**: Under AMASR Act 1958 as amended in 2010, s.20A defines the **prohibited area** as every area beginning at the limit of the protected area/monument and extending **100 m** in all directions; s.20B defines the **regulated area** beginning at the limit of the prohibited area and extending a further **200 m** (i.e. 100–300 m from the protected limit). Both are *minimums* extendable by notification on NMA recommendation (S1, S2).
- **What is allowed [READ, S1]**: NMA FAQ: no permission for construction, including Government/public works, in the prohibited area; in the regulated area construction/reconstruction/repair may be permitted by the Competent Authority (on NMA recommendation for construction). S2's s.20A(3) contains provisions for public works that are "necessary or expedient" — the exact conditions were not read **[TO VERIFY]**. The prohibited area extends vertically, including below surface (UNESCO-hosted summary of the Act, search excerpt) → relevant for tunnels **[EXCERPT; TO VERIFY]**.
- **Pune monuments**: PIB (4 Dec 2025) names three monuments of national importance in Pune city: **Shaniwarwada, Aga Khan Palace, Pataleshwar Cave Temple** (S3 [EXCERPT]). The ASI list also includes "Old European Tombs, Poona" (Rajya Sabha annex excerpt) **[TO VERIFY whether in city limits / still listed]**. Pune district has 20 centrally protected monuments in total (Rajya Sabha, 20 Jul 2023 [EXCERPT]).
- **Boundary caveat**: the 100/300 m is measured from the *limit of the protected area*, not the monument's centroid. Protected-area boundaries are not in OSM; using a point or building footprint yields an *estimated* buffer.

### 1.5 Water bodies: Mula–Mutha blue/red flood lines; CRZ

- **Definition [READ, S6]**: Irrigation Dept circular dated 21.09.1989 (quoted in NGT judgment of 04.02.2026): *Prohibitive zone* — river bed and banks needed to carry a flood of average 25-year frequency or 1.5× the established river-bed carrying capacity, whichever is more; its edge is the **blue line**. *Restrictive zone* — the further area needed to carry the maximum flood (max dam discharge plus free catchment flow; where no dam, 1-in-100-year flood); its edge is the **red line**.
- **UDCPR 3.1.3 [READ, quoted in S6]**: area between river bank and blue line is prohibited for construction except listed uses (parking, open market, garden, open space, cremation ground, STP, water/gas/drainage pipelines, public toilet or like uses); area between blue and red line is restrictive — construction may be permitted at 0.45 m above red flood line level; lines stand modified when the Irrigation (Water Resources) Department modifies them.
- **Contested applicability to roads**: NGT (S6) recorded PMC's argument and an earlier NGT holding that a road within the blue line can be treated as a public-utility use akin to "parking"; this is a tribunal record in one case, not a general rule. → Any road/bridge/flyover proposal touching the river corridor must be flagged **[TO VERIFY WITH Water Resources Dept + PMC]** and **requires hydraulic study**.
- **Data**: flood lines are marked by the Water Resources Department on plans and on the ground (TOI reports, S7 context); they are **not** in OSM or this repo. Platform must accept an imported flood-line layer; without it, finding = *unknown — requires flood-line data from WRD*.
- **CRZ**: The Coastal Regulation Zone notification applies to coastal stretches; Pune is an inland city on the Deccan plateau, so CRZ is **inferred not applicable** for PMC/PCMC proposals. Marked *inferred*; confirm if a project extends to tidal-influenced areas (not expected).

### 1.6 Trees — Maharashtra (Urban Areas) Protection and Preservation of Trees Act 1975

- **[READ, S4]** s.8(1): no person shall fell any tree in an urban area where the Act is in force, whether on own land or not, except with previous permission of the Tree Officer; s.8(2): any person, *including an officer of the urban local authority, State or Central Government*, proposing to fell a tree applies in writing to the **Tree Authority** with tree description, site plan and reasons; s.8(3): Tree Officer inspection, public notice in newspapers and on the tree, decision timelines; s.8(5): replanting conditions. (The Indian Kanoon text pre-dates later amendments.)
- **[EXCERPT, S5]** 2021 amendment (Mah. IX of 2021): introduces "heritage tree", constitutes a **Maharashtra State Tree Authority**, and provides that applications for felling more than **200 trees** are referred onward, with an anti-splitting proviso (project not to be sub-divided to keep below 200). Exact current thresholds and referral path **[TO VERIFY — read consolidated text S5]**.
- **Implication**: any proposal with a construction footprint (widening, new road, flyover piers/ramps, tunnel portals, bus-lane kerb realignment) triggers a *tree survey/census* requirement regardless of OSM tree data, and Tree Authority permission is an **authority to verify**.

### 1.7 Metro proximity (Pune Metro / MahaMetro; PMRDA Line 3)

- **[READ, S9]** Pune Metro spokesperson (17 Apr 2026, after a borewell breached the underground tunnel roof at Shukrawar Peth): property owners/developers/organisations undertaking development within **20 m of either the elevated or underground metro route** must obtain permission/NOC from the metro authority; covered works include construction, demolition, digging, plinth work, excavation, **geotechnical study, borewell drilling**, well construction, and laying of cables/pipelines (water, drainage, stormwater, electric, telecom, gas). Reported legal basis: Metro Railways (Construction of Works) Act 1978 and UDCPR (as stated by MahaMetro official to TOI [SECONDARY]). The same report says Pune Metro is designated planning authority for **500 m on either side** of its route.
- **Network facts [EXCERPT, S25; READ, S9]**: PCMC–Swargate line elevated to Shivajinagar/Range Hill area then underground to Swargate, passing under the Mutha river; Vanaz–Ramwadi elevated; Swargate–Katraj underground extension (≈5.46 km) under construction; PMRDA Line 3 Hinjewadi–Shivajinagar elevated (23.2 km).
- **Implication**: the investigation itself (boreholes, trial pits) near the metro needs metro permission — the generator must put "metro NOC for investigation works" *before* geotechnical drilling in the sequence.

### 1.8 Geology and groundwater (for underground proposals)

- **[EXCERPT, S16]** CGWB: Pune district geology is Deccan Trap basalt (Upper Cretaceous–Lower Eocene) with alluvium along main river channels; water-bearing formations are weathered/fractured/jointed vesicular and massive basalt under phreatic to semi-confined/confined conditions. GSDA describes massive jointed basalt with vesicular-amygdaloidal lava and ash layers. ACWADAM mapping of Pune city reported 17 compact and 16 vesicular-amygdaloidal basalt units (secondary summary) **[SECONDARY]**.
- **Implication**: rock is likely but *mixed* (compact vs vesicular/amygdaloidal, weathered zones, red bole interbeds, alluvium near rivers); groundwater conditions vary with jointing. None of this is site-specific → always *requires field investigation*.
- **Seismic zone**: Pune's zone under IS 1893 not verified this session (a revised IS 1893 zonation may apply) **[TO VERIFY]**.

### 1.9 Utilities

- **[EXCERPT, S23]** Draft IRC:98 (2024 third revision) describes accommodation of utilities in urban roads, a road-opening protocol, and GIS mapping: collect existing utility records from agencies, then field surveys to verify locations/dimensions. A Smart Cities RFP (NIUA SmartNet, 2019) shows GPR plus non-penetrating techniques used for municipal utility mapping in India [EXCERPT].
- Indian standard specifically for subsurface utility *quality levels* not found **[TO VERIFY]**; ASCE 38 (US) is a commonly used reference for quality levels but was not opened **[TO VERIFY]**.
- **Implication**: utilities are *unknown* in this tool unless imported; any excavation (widening, piers, portals, tunnels, underpasses) → utility records + GPR/EM locating + trial pits.

## 2. Intervention catalogue by bottleneck cause

Principle: choose by *diagnosed cause*; construction only where management cannot address the cause, and only with feasibility + investigation attached.

| Diagnosed cause (from simulation/validation) | First-line interventions (management) | Second-line (road-space / transit) | Physical (only if justified) | Guidance to identify & verify |
|---|---|---|---|---|
| Poor signal timing (isolated) | Re-time phases/cycle from measured saturation flow & demand; actuated control | Lane allocation at stop line | — | IRC:93-1985 *Guidelines on design and installation of road traffic signals* (S17, title/edition only); Indo-HCM 2017 signalised intersection chapter (S21; saturation flow, PCU, control-delay LOS per excerpts) |
| Uncoordinated signals on corridor | Offsets/green wave; common cycle; adaptive control | Bus signal priority | — | IRC:93; IRC:SP:43-2022 (S22, traffic management techniques) [EXCERPT]; IRC:SP:110 (ITS for urban roads) **[TO VERIFY edition]** |
| Turning conflicts (right turns in Indian left-hand traffic) | Turn bans with signed alternative routes; protected phases; U-turn relocation | Channelisation | Junction redesign; grade separation only for very high conflicting volumes | IRC:SP:41 at-grade intersections **[TO VERIFY edition]**; IRC:70-2017 (S22); IRC:92-2017 for interchanges (S27) |
| Merge bottleneck | Lane-drop relocation, merge control, access closure near merge | Lane-use management | Auxiliary lane (widening) | IRC:86-2018 (S24) |
| Downstream capacity restriction / spillback | Gating/metering upstream; fix the downstream cause first | Parking/loading removal at the restriction | Widening of the restriction | Model evidence: queue origin, OVERHAUL §§18, 28 methods |
| Incorrect lane usage / lane indiscipline | Markings, signage, enforcement | Physical separators | — | IRC:70-2017 (segregation of lanes) [EXCERPT] |
| Parking and loading activity | Parking prohibition/pricing, loading bays, freight time windows | Kerbside reallocation | — | IRC:SP:43-2022 (S22) [EXCERPT]; local Traffic Police notifications **[TO VERIFY]** |
| Pedestrian conflicts | Signalised/raised crossings, pedestrian phases, refuges | Footpath reclamation (encroachment removal) | FOB/underpass (last resort) | IRC:SP:118-2018, IRC:103 pedestrian facilities **[TO VERIFY edition]** |
| Bus interactions (stops blocking lanes, bunching) | Bus bays/stop relocation, bus signal priority | Bus lanes; BRT where demand warrants | — | IRC:124-2017 BRT guidelines (S22): BRT sited where PT demand > 3,000 pphpd [EXCERPT]; IRC:SP:43-2022 ch. 8 bus priority [EXCERPT]; UTTIPEC: exclusive bus lanes on RoW > 30 m (Delhi policy, S22) [EXCERPT] — Delhi guidance, applicability to Pune **[TO VERIFY]** |
| Excess demand (network-wide) | Demand management, PT capacity, timing | Transit integration, interchange improvements | Capacity additions rarely sufficient alone (induced demand risk — note as unknown, not modelled) | — |
| Poor network connectivity | Re-route via existing links, one-way pairs | — | New link road, bridge, underpass, tunnel | DP road lines (S12); IRC:86-2018 |
| Access management (frequent driveways/side streets) | Consolidate accesses, left-in/left-out, service-lane use | Median closure | Service road | IRC:86-2018; IRC:70-2017 |

Physical intervention families and their key references (title/edition only unless stated):

- **Flyovers / grade separators / elevated corridors**: IRC:SP:90-2023 *Guidelines for Grade Separators and Elevated Structures (First Revision)* (S27); bridge codes IRC:5-2024 (general features, Ninth Revision), IRC:6-2017 (loads and load combinations, Seventh Revision; includes vehicle collision loads on flyover supports per its contents list [EXCERPT]), IRC:78 (Part 1)-2024 foundations & substructure (working stress) and IRC:78 (Part 2)-2020 (limit state design of foundations) (S17, S27).
- **Interchanges**: IRC:92-2017 *Guidelines for the Design of Interchanges in Urban Areas (First Revision)* (S27).
- **Bridges over rivers/nallas**: IRC:5, IRC:6, IRC:78 as above; river-corridor rules §1.5; hydraulic study **required** (IRC river-training guidance exists, e.g. IRC:89, edition **[TO VERIFY]**).
- **Road widening / new roads**: IRC:86-2018 (S24); IRC:98 utilities (S23); DP road lines (S12); land acquisition (statute and authority **[TO VERIFY]**).
- **Tunnels / underground roads**: IRC:SP:91-2019 *Guidelines for Road Tunnels (First Revision)* (S17); its 2010 edition has chapters on planning, geotechnical investigations, structural design, construction methodology, safety during construction, ventilation & lighting, operation & maintenance (S18 [EXCERPT]); a 2026 draft amendment references a Geotechnical Baseline Report and Risk Register (S18 [EXCERPT]); MoRTH states NH tunnels follow IRC:SP:91-2019 (Rajya Sabha reply, 22 Jul 2026 [EXCERPT]). BIS: IS 15026 (2002; Part 1:2022 conventional methods; Part 2:2023 TBM) (S20); IS 1892:2021 subsurface investigation (S19); IS 13365 (Part 1):2025 RMR (S19). Q-system (Barton et al., NGI) is standard rock-mechanics literature; not opened this session **[TO VERIFY reference]**.
- **Pune precedent**: PMRDA lists a "Yerwada–Katraj Twin Tunnel" project and a "Double Decker Flyover – Pune University" (S26 [EXCERPT]) — useful as local reference cases for authority contacts; their status not verified.

## 3. Investigation requirements by infrastructure type (research basis)

The generator (see `docs/INVESTIGATION_REQUIREMENTS.md`) maps proposal type × site attributes to investigations. Research basis per type:

### 3.1 Tunnels / underground roads
- Geological mapping and **rock mass classification (RMR per IS 13365 Part 1; Q-system)**, core drilling with logging and laboratory tests per IS 1892:2021 and IS 15026 guidance (S19, S20) — spacing/depth to be set by the geotechnical engineer, not by the tool.
- Groundwater: piezometers, permeability (packer) tests, seasonal monitoring — Deccan basalt aquifers are heterogeneous (S16).
- Utilities and existing underground structures: records + GPR/EM + trial pits (S23); **metro tunnels**: MahaMetro NOC within 20 m, and the investigation works themselves need permission (S9).
- Building condition survey and settlement/vibration risk assessment for buildings in the zone of influence — zone width is an engineering judgement **[HYPOTHETICAL default in tool]**.
- Ventilation, fire safety, emergency egress, drainage, flood protection of portals (IRC:SP:91 chapters, S18).
- Heritage: AMASR prohibited area extends below surface (§1.4) → tunnels within 100 m of an ASI protected limit are a **critical flag**.
- Environmental: EIA Notification 2006 has no separate tunnel entry; MoEFCC reportedly told NGT (Bengaluru twin tunnel, Dec 2025) that a tunnel needs prior EC only as part of a listed project (S8 [SECONDARY]) → **[TO VERIFY WITH SEIAA/MoEFCC]**.

### 3.2 Bridges (river / nalla / rail)
- Hydrology & hydraulics (design flood, afflux, scour), flood-line check (§1.5), geotechnical investigation at pier/abutment locations (IS 1892; IRC:78), bathymetry/topography, river-morphology/training.
- Authorities to verify: Water Resources Dept (flood lines), PMC, MPCB (consent), Tree Authority; railway authority if over rail.

### 3.3 Flyovers / grade separators
- Pier/foundation geotechnical investigation (IRC:78, IS 1892), utility diversion survey (IRC:98), traffic diversion & construction staging plan, building/access impact along ramps, tree survey, heritage buffer check, metro clearance (if within 20 m), vertical clearance and geometry per IRC:SP:90-2023 / IRC:86.

### 3.4 Road widening / additional lanes
- RoW verification (DP road line, city survey/property cards), land acquisition and affected-structure survey, utility relocation survey, tree census, pavement investigation, drainage, heritage frontage check (PMC list Grade I/II/III, S10), access/frontage impacts.

### 3.5 New roads / link roads
- All widening items plus alignment topographic survey, geotechnical along alignment, cross-drainage, flood lines, environmental screening (EIA item 7(f) for new State Highways is Category B per S8 [SECONDARY]; ordinary municipal roads not named — **[TO VERIFY]**), social impact/rehabilitation if displacement.

### 3.6 Management measures (signals, turn bans, one-ways, bus priority, parking)
- No physical investigation; required evidence is *traffic data* (classified turning counts, saturation flow, queue lengths, bus dwell, parking accumulation), stakeholder/enforcement review with Traffic Police, and before/after monitoring. Statutory notification by traffic authority **[TO VERIFY mechanism]**.

## 4. EIA Notification 2006 applicability (summary)

From S8 [SECONDARY quoting the MoEFCC copy "as amended up to July 2026"]:
- Item 7(f) Highways — Category A: new National Highways; expansion of NH > 100 km with additional RoW/land acquisition > 40 m on existing alignment and 60 m on re-alignments/bypasses. Category B: all new State Highway projects; SH expansion in hilly terrain (> 1,000 m AMSL) and/or ecologically sensitive areas. General Condition (Category B treated as A within 5 km of listed areas).
- No entry names metro, flyover, bridge or elevated road; NGT Southern Zone (2017) held one Bengaluru elevated road fell under item 8(b) on built-up area; item 8 has since been reworded (29 Jan 2025 footnote). Supreme Court (2023) left the metro EC question open.
- **Platform rule**: never output "EC required" or "EC not required". Output: "EIA Notification 2006 applicability — to verify with SEIAA Maharashtra / MoEFCC", plus the facts that would decide it (road classification, length, land take, built-up area, distance to protected/eco-sensitive areas).

## 5. Approval / consultation authorities — all [TO VERIFY WITH AUTHORITY]

| Authority | Likely role (to verify) | Basis found |
|---|---|---|
| Pune Municipal Corporation (PMC) — Road, Traffic Planning, Building Permission, Heritage Cell / Heritage Committee, Tree Authority | Planning authority for PMC area; DP road lines; heritage list (DCPR-2017 cl. 39.2); tree felling permissions | S10, S12, S4 |
| Pimpri Chinchwad Municipal Corporation (PCMC) | Same roles in PCMC area | inferred |
| PMRDA | Planning authority in metropolitan region; implements some flyovers, tunnels, metro Line 3 | S13, S25, S26 |
| MSRDC (Maharashtra State Road Development Corporation) | State road corporation; listed as separate planning authority excluded from UDCPR (S11 excerpt) | S11 [EXCERPT]; role in Pune projects **[TO VERIFY]** |
| MahaMetro (Pune Metro) | NOC within 20 m of metro route; planning authority within 500 m | S9 |
| Pune City Traffic Police | Traffic management notifications (one-ways, turn bans, parking) | **[TO VERIFY legal basis]** |
| Water Resources Department (Irrigation), GoM | Blue/red flood lines | S6 |
| MPCB | Consent / public hearing conduct under EIA process | S6 (party), S8 [SECONDARY] |
| SEIAA Maharashtra / MoEFCC | Environmental clearance where an EIA entry applies | S8 |
| NMA / ASI Competent Authority | Permissions in AMASR regulated area; no construction in prohibited area | S1 |
| Maharashtra State Tree Authority | Large felling applications (> 200 trees) after 2021 amendment | S5 [EXCERPT] |
| Indian Railways / Central Railway (Pune division) | Works over/under rail | **[TO VERIFY]** |
| Utility owners (water, sewer, MSEDCL power, MNGL gas, telecom) | Utility records, diversion approvals | **[TO VERIFY]** |

## 6. What could not be verified this session

- Exact text of AMASR s.20A(3) public-works provisions; vertical extent wording.
- Current consolidated thresholds in the Trees Act after 2021/2023 amendments.
- Current PMRDA DP status; DP status for merged villages.
- IS 1893 seismic zone for Pune under the current edition.
- An Indian standard for subsurface utility quality levels; ASCE 38 details.
- Editions of IRC:SP:41, IRC:SP:110, IRC:103, IRC:89.
- Legal mechanism for traffic notifications in Pune.
- OSM building/tree/water completeness in Pune (requires measurement against ground truth — not done).
