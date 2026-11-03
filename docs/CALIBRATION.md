# Calibration and validation of the micro-simulation at six counted Pune junctions

Branch `realistic-traffic`. This document covers what the simulation is checked against, how it was validated before and after the realism work, what was found at each junction, what was fixed, and what still does not match. The numbers are reported as measured; nothing was tuned to make a junction pass, and the observed counts were never altered.

## 1. Data sources

| Data | Source | Used for |
|---|---|---|
| Peak-hour classified turning counts (LV/HV/TW, per approach and turn) at Kokane, Panchratna, Kasturi, Ganraj, Sakharam Waghmare and Infosys Circle Phase 1 | Khandekar, Bagwan, Karande & Pilaka (2025), *Study of Traffic Management at Road Intersection in Pune*, NICMAR / Journal Press India, ch. 129, pp. 1462-1472, doi:10.17492/jpi/nicmar/2507129 (Tables 1-6). Cross-checked against Kureshi et al. (2026), *Int. J. Innovations in Research* 2(10) 33-39, doi:10.5281/zenodo.21712996 (same totals, survey method, PHF 0.82-0.94). Transcribed in `backend/data/observed_counts/pune_west_2026.json` | Observed flows for GEH; count-driven OD seeding and IPF; Webster design flows |
| PCU factors | IRC:106-1990, Table 1 (LV 1.0, HV 2.2, TW 0.75); see the count file for the rationale | Design flows in PCU/h |
| Saturation flow | Indo-HCM 2017 (CSIR-CRRI) width-based unit base saturation flow: 630 PCU/h/m below 7 m, 1140 − 60 w for 7-10.5 m, 500 above (as quoted in Indo-HCM worked applications, e.g. IJAEM 2(1) 2020 pp. 271-278) | Webster green split; discharge tests (`JunctionRealism.test.ts`) |
| Signal design | Webster (1958), RRL Technical Paper 39: C0 = (1.5 L + 5)/(1 − Y), g_i = (C0 − L) y_i / Y. Worked example checked in `SignalTiming.test.ts` (APSEd, q = 400/250, s = 1250/1000, L = 16 s → C0 = 67.44 s) | `signalTiming.ts` |
| Lost time | L = 2n + R (2 s per phase plus all-red): Nikhil, Anil, Pramod & Suresh (2019), IJERA 9(4) pp. 23-28, https://www.ijera.com/papers/vol9no4/Series-2/D0904022328.pdf — opened and checked, pp. 25 and 27. **Unverified against IRC:93 / Indo-HCM** (§6) | `STARTUP_LOST_S = 2` |
| Critical gaps | Indo-HCM 2017 base critical gap 2.7 s (major-road right) and 3.8 s (minor-road right), as tabulated in IJRESM (journal.ijresm.com) Table 4 | Gap acceptance at priority junctions, roundabouts, permissive right turns |
| LOS | HCM 2000 control-delay thresholds (Exhibit 16-2 signalised, 17-2 two-way stop). **Indo-HCM 2017 thresholds not verified** (§6) | `losFor()` |
| Hour-of-day profile | Gunjan Chowk, Pune hourly counts (IJETT 47(2) 2017); Mendeley Pune CCTV counts (doi:10.17632/xnf2k6n288.1); TomTom Traffic Index 2025 Pune; Pune CMP 2018 (7.8% peak-hour share). See `backend/data/diurnal/README.md` | Time-of-day demand scaling |
| Road network | OpenStreetMap, `western-zone-latest.osm.pbf` (OSM data timestamp 2026-11-01 21:21 UTC), plus the local correction layer `backend/data/network_corrections/pune_west_v1.json` (24 corrections; OSM itself is never edited) | Geometry, lanes, one-way, signals |

## 2. Validation protocol

`frontend/src/engine/testing/JunctionValidation.test.ts` (opt-in; runs only when `VAL_DUMP` is set) loads a dump of the running app (OSM roads, OSM signal nodes, project context, count file, one seed road per junction), builds the study area around the junction, seeds OD demand from the counts and fits it by bounded IPF (`fitPlan`), then runs 300 s of warm-up and 900 s of measurement (`WARMUP_S`, `MEASURE_S`) and compares simulated veh/h per counted movement with the counts. Three seeds (7, 11, 23) per configuration; tables give mean ± population standard deviation over the seeds.

Configurations:

- **base** — the real code at commit `4b885ad`, run with the same protocol from a separate checkout (`BaseValidation`, scratch harness, not committed). This is the true "before".
- **before** — current code with the realism toggles off: no correction layer, equal-split signals, no two-wheeler pairs, free-flow routes. It differs from `base` by changes that have no toggle: platoon discharge at signals and the grant fixes (§4), lane-range mapping, and lane-swap rules.
- **after** — everything on: correction layer (with OSM roundabout one-way implication), Webster signals from the observed approach flows, two-wheelers abreast, and three MSA iterations of congestion feedback into route costs (`VAL_ASSIGN=3`).

Metrics: GEH per movement (`sqrt(2 (m − c)² / (m + c))`; the usual acceptance is GEH < 5 for 85% of movements), mean and max GEH, R² and slope of simulated against observed (regression through the origin), total simulated/observed volume, network mean speed, junction control delay, mean queue, HCM 2000 LOS, gridlock removals (vehicles stuck > 120 s removed), and movements the network cannot route at all.

Aggregation: `/workspace/work/cal/agg.py`, `/workspace/work/cal/table.py` (scratch, outside the repo); raw results `/workspace/work/cal/val/<junction>_<config>.json`.

## 3. Results (counted peak hour, 3 seeds, mean ± spread)

`base` is the true before (commit `4b885ad`); `after` is this branch with every realism feature on. 54 runs (6 junctions × 3 configs × 3 seeds). `base` ran from a checkout of `4b885ad`; `before` and `after` finished between 19:08 and 19:21 UTC on 2026-11-02, after commit `1c49b5c` (19:07 UTC), so they reflect that code (inferred from timestamps; the harness does not stamp a commit). The changes committed with this document touch comments and docs only, so no rerun was needed. Generated by `/workspace/work/cal/final_table.py` from `/workspace/work/cal/val/<junction>_<config>.json`.

The single-seed baseline figures quoted earlier during development (Kasturi 1/12 under GEH 5, mean 20.2; Sakharam 0/12, mean 12.2; Infosys 6/12, mean 11.5) are individual seeds; the 3-seed means below supersede them.

#### Summary per junction (3 seeds: 7, 11, 23; mean ± population SD)

| Junction | Config | GEH<5 (of 12) | Share GEH<5 | Mean GEH | Max GEH | R² | Slope sim/obs | Sim/obs volume | Mean speed km/h | Control delay s | Mean queue m | LOS (per seed) | Gridlock removals | Unreachable movements |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kasturi | base | 0.3 ± 0.5 | 3 ± 4% | 20.6 ± 0.3 | 33.8 ± 0.0 | 0.04 ± 0.01 | 0.31 ± 0.01 | 31 ± 1% | 4.6 ± 0.3 | 181 ± 8 | 103 ± 2 | F/F/F | 4 ± 1 | 5 ± 0 |
| Kasturi | before | 4.0 ± 0.0 | 33 ± 0% | 17.1 ± 0.2 | 33.8 ± 0.0 | 0.08 ± 0.01 | 0.45 ± 0.00 | 45 ± 0% | 11.3 ± 1.7 | 93 ± 7 | 88 ± 3 | F/F/F | 0 ± 0 | 5 ± 0 |
| Kasturi | after | 0.0 ± 0.0 | 0 ± 0% | 15.8 ± 0.6 | 26.5 ± 1.2 | 0.02 ± 0.01 | 0.40 ± 0.02 | 41 ± 2% | 2.5 ± 0.3 | 246 ± 7 | 156 ± 5 | F/F/F | 18 ± 2 | 0 ± 0 |
| Panchratna | base | 2.0 ± 0.0 | 17 ± 0% | 21.5 ± 0.2 | 36.6 ± 0.0 | 0.04 ± 0.01 | 0.31 ± 0.01 | 31 ± 1% | 6.7 ± 0.7 | 4 ± 0 | 2 ± 0 | A/A/A | 26 ± 1 | 6 ± 0 |
| Panchratna | before | 3.0 ± 0.8 | 25 ± 7% | 20.2 ± 0.2 | 36.6 ± 0.0 | 0.06 ± 0.01 | 0.36 ± 0.01 | 35 ± 1% | 7.4 ± 1.3 | 5 ± 0 | 2 ± 0 | A/A/A | 25 ± 3 | 6 ± 0 |
| Panchratna | after | 4.3 ± 0.5 | 36 ± 4% | 17.9 ± 0.6 | 36.6 ± 0.0 | 0.11 ± 0.02 | 0.45 ± 0.02 | 43 ± 2% | 11.7 ± 1.3 | 16 ± 1 | 18 ± 2 | C/B/C | 8 ± 6 | 6 ± 0 |
| Ganraj | base | 0.0 ± 0.0 | 0 ± 0% | 28.9 ± 0.2 | 40.4 ± 1.4 | 0.13 ± 0.03 | 0.16 ± 0.00 | 16 ± 1% | 3.6 ± 0.3 | 77 ± 7 | 35 ± 2 | E/F/F | 28 ± 1 | 0 ± 0 |
| Ganraj | before | 0.0 ± 0.0 | 0 ± 0% | 26.7 ± 0.3 | 36.7 ± 0.4 | 0.24 ± 0.09 | 0.22 ± 0.01 | 22 ± 1% | 4.1 ± 0.8 | 59 ± 5 | 34 ± 1 | E/D/E | 21 ± 2 | 0 ± 0 |
| Ganraj | after | 0.0 ± 0.0 | 0 ± 0% | 26.1 ± 0.1 | 45.1 ± 0.0 | 0.01 ± 0.01 | 0.20 ± 0.01 | 22 ± 0% | 5.2 ± 0.8 | 113 ± 10 | 77 ± 8 | F/F/F | 19 ± 5 | 2 ± 0 |
| Kokane | base | 3.3 ± 0.5 | 28 ± 4% | 16.6 ± 0.6 | 31.6 ± 0.0 | 0.01 ± 0.01 | 0.35 ± 0.03 | 36 ± 2% | 3.7 ± 0.6 | 62 ± 9 | 34 ± 4 | F/F/E | 23 ± 11 | 2 ± 0 |
| Kokane | before | 2.7 ± 0.5 | 22 ± 4% | 16.4 ± 0.5 | 31.6 ± 0.0 | 0.00 ± 0.00 | 0.35 ± 0.02 | 36 ± 3% | 3.8 ± 1.1 | 74 ± 13 | 36 ± 4 | F/F/F | 18 ± 6 | 2 ± 0 |
| Kokane | after | 2.0 ± 0.8 | 17 ± 7% | 14.3 ± 0.3 | 31.6 ± 0.0 | 0.01 ± 0.01 | 0.41 ± 0.01 | 42 ± 1% | 3.8 ± 0.7 | 52 ± 3 | 30 ± 1 | F/E/F | 15 ± 10 | 2 ± 0 |
| Infosys Circle Ph. 1 | base | 6.0 ± 0.0 | 50 ± 0% | 11.6 ± 0.2 | 27.9 ± 0.0 | 0.28 ± 0.01 | 0.61 ± 0.00 | 58 ± 0% | 14.0 ± 1.8 | 36 ± 9 | 37 ± 6 | D/E/D | 5 ± 2 | 5 ± 0 |
| Infosys Circle Ph. 1 | before | 6.0 ± 0.0 | 50 ± 0% | 11.8 ± 0.1 | 27.9 ± 0.0 | 0.27 ± 0.01 | 0.61 ± 0.01 | 58 ± 1% | 13.6 ± 1.6 | 37 ± 12 | 39 ± 9 | D/F/D | 5 ± 1 | 5 ± 0 |
| Infosys Circle Ph. 1 | after | 3.0 ± 0.0 | 25 ± 0% | 10.4 ± 0.4 | 29.8 ± 0.0 | 0.02 ± 0.01 | 0.55 ± 0.02 | 58 ± 2% | 4.0 ± 0.2 | 66 ± 4 | 59 ± 7 | F/F/F | 33 ± 5 | 1 ± 0 |
| Sakharam Waghmare | base | 1.0 ± 0.8 | 8 ± 7% | 12.4 ± 0.2 | 20.2 ± 1.7 | 0.03 ± 0.03 | 0.41 ± 0.01 | 43 ± 0% | 6.7 ± 0.2 | 163 ± 5 | 82 ± 5 | F/F/F | 4 ± 2 | 0 ± 0 |
| Sakharam Waghmare | before | 1.0 ± 0.8 | 8 ± 7% | 12.6 ± 0.1 | 20.8 ± 1.1 | 0.03 ± 0.03 | 0.41 ± 0.00 | 42 ± 1% | 6.9 ± 0.5 | 163 ± 5 | 82 ± 5 | F/F/F | 5 ± 2 | 0 ± 0 |
| Sakharam Waghmare | after | 0.0 ± 0.0 | 0 ± 0% | 13.3 ± 0.2 | 16.6 ± 0.2 | 0.54 ± 0.06 | 0.39 ± 0.01 | 39 ± 1% | 7.0 ± 0.2 | 160 ± 12 | 88 ± 1 | F/F/F | 9 ± 3 | 0 ± 0 |

#### GEH per counted movement (base → after; mean ± SD over 3 seeds). Movement = approach-turn (L/S/R). Observed veh/h from the count file.

| Junction | Config | N-L | N-S | N-R | E-L | E-S | E-R | S-L | S-S | S-R | W-L | W-S | W-R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kasturi | observed veh/h | 512 | 427 | 475 | 543 | 654 | 487 | 686 | 505 | 529 | 411 | 570 | 401 |
| Kasturi | base | 32.0 ± 0.0 | 29.2 ± 0.0 | 30.8 ± 0.0 | 17.8 ± 1.5 | 21.1 ± 0.3 | 17.9 ± 0.6 | 11.8 ± 1.6 | 8.6 ± 1.3 | 32.5 ± 0.0 | 5.2 ± 0.4 | 33.8 ± 0.0 | 6.4 ± 0.1 |
| Kasturi | before | 32.0 ± 0.0 | 29.2 ± 0.0 | 30.8 ± 0.0 | 12.1 ± 0.6 | 15.2 ± 2.5 | 12.5 ± 1.3 | 1.2 ± 0.8 | 3.6 ± 0.7 | 32.5 ± 0.0 | 1.1 ± 0.5 | 33.8 ± 0.0 | 1.0 ± 0.7 |
| Kasturi | after | 12.0 ± 2.5 | 11.7 ± 3.3 | 10.2 ± 0.8 | 17.9 ± 1.8 | 17.0 ± 0.4 | 15.3 ± 1.8 | 26.5 ± 1.2 | 20.6 ± 1.5 | 18.8 ± 1.3 | 13.1 ± 1.1 | 14.8 ± 0.9 | 11.7 ± 0.3 |
| Panchratna | observed veh/h | 588 | 529 | 669 | 431 | 736 | 404 | 603 | 443 | 474 | 394 | 504 | 540 |
| Panchratna | base | 0.9 ± 0.7 | 32.5 ± 0.0 | 36.6 ± 0.0 | 19.9 ± 2.1 | 24.7 ± 2.7 | 28.4 ± 0.0 | 12.0 ± 3.1 | 29.8 ± 0.0 | 30.8 ± 0.0 | 6.3 ± 1.3 | 3.4 ± 0.8 | 32.9 ± 0.0 |
| Panchratna | before | 1.1 ± 0.5 | 32.5 ± 0.0 | 36.6 ± 0.0 | 17.9 ± 1.7 | 21.1 ± 2.4 | 28.4 ± 0.0 | 5.2 ± 2.1 | 29.8 ± 0.0 | 30.8 ± 0.0 | 3.7 ± 1.3 | 1.8 ± 0.9 | 32.9 ± 0.0 |
| Panchratna | after | 0.7 ± 0.7 | 32.5 ± 0.0 | 36.6 ± 0.0 | 8.0 ± 5.2 | 8.9 ± 0.6 | 28.4 ± 0.0 | 2.3 ± 1.5 | 29.8 ± 0.0 | 30.8 ± 0.0 | 1.8 ± 0.4 | 1.4 ± 1.0 | 32.9 ± 0.0 |
| Ganraj | observed veh/h | 491 | 410 | 657 | 604 | 1040 | 879 | 513 | 432 | 591 | 901 | 1019 | 759 |
| Ganraj | base | 29.7 ± 0.5 | 24.8 ± 1.2 | 18.7 ± 1.6 | 32.7 ± 0.3 | 40.4 ± 1.4 | 39.3 ± 1.1 | 18.9 ± 1.1 | 19.3 ± 0.9 | 31.4 ± 1.8 | 23.7 ± 1.7 | 31.5 ± 2.2 | 36.7 ± 0.7 |
| Ganraj | before | 30.6 ± 0.8 | 24.4 ± 1.2 | 16.6 ± 1.6 | 30.9 ± 0.4 | 35.4 ± 1.6 | 33.5 ± 0.7 | 16.1 ± 1.2 | 16.3 ± 1.8 | 30.9 ± 1.1 | 20.2 ± 0.9 | 29.5 ± 1.7 | 36.4 ± 0.1 |
| Ganraj | after | 15.9 ± 2.1 | 25.2 ± 1.0 | 12.1 ± 1.6 | 28.5 ± 0.5 | 29.9 ± 1.3 | 27.5 ± 1.5 | 23.6 ± 1.5 | 12.4 ± 1.2 | 15.1 ± 1.5 | 42.4 ± 0.0 | 45.1 ± 0.0 | 35.3 ± 0.1 |
| Kokane | observed veh/h | 440 | 365 | 325 | 275 | 425 | 395 | 344 | 245 | 500 | 445 | 307 | 360 |
| Kokane | base | 28.9 ± 0.6 | 25.7 ± 0.9 | 22.8 ± 1.6 | 16.1 ± 0.8 | 18.5 ± 1.6 | 20.2 ± 0.8 | 0.9 ± 0.5 | 22.1 ± 0.0 | 31.6 ± 0.0 | 4.3 ± 3.1 | 4.9 ± 2.4 | 2.9 ± 1.9 |
| Kokane | before | 29.2 ± 0.4 | 26.0 ± 0.5 | 22.9 ± 0.2 | 15.3 ± 1.1 | 16.4 ± 0.6 | 18.1 ± 1.2 | 1.0 ± 0.9 | 22.1 ± 0.0 | 31.6 ± 0.0 | 4.8 ± 1.6 | 5.8 ± 2.5 | 3.7 ± 4.2 |
| Kokane | after | 24.7 ± 1.9 | 22.3 ± 0.5 | 19.8 ± 1.0 | 9.3 ± 2.0 | 9.0 ± 0.7 | 11.3 ± 2.9 | 0.6 ± 0.4 | 22.1 ± 0.0 | 31.6 ± 0.0 | 6.9 ± 4.7 | 8.2 ± 1.1 | 5.5 ± 1.0 |
| Infosys Circle Ph. 1 | observed veh/h | 141 | 372 | 389 | 445 | 325 | 438 | 159 | 398 | 310 | 437 | 374 | 455 |
| Infosys Circle Ph. 1 | base | 16.8 ± 0.0 | 27.3 ± 0.0 | 27.9 ± 0.0 | 0.5 ± 0.2 | 2.0 ± 1.4 | 1.0 ± 1.2 | 1.0 ± 0.4 | 0.4 ± 0.2 | 24.9 ± 0.0 | 7.1 ± 0.7 | 27.3 ± 0.0 | 3.2 ± 1.0 |
| Infosys Circle Ph. 1 | before | 16.8 ± 0.0 | 27.3 ± 0.0 | 27.9 ± 0.0 | 0.4 ± 0.2 | 2.0 ± 1.4 | 1.0 ± 0.9 | 1.0 ± 0.6 | 1.2 ± 0.8 | 24.9 ± 0.0 | 8.6 ± 1.4 | 27.3 ± 0.0 | 3.4 ± 1.5 |
| Infosys Circle Ph. 1 | after | 6.9 ± 1.2 | 9.2 ± 1.3 | 11.4 ± 2.3 | 29.8 ± 0.0 | 7.3 ± 1.7 | 11.1 ± 2.0 | 1.3 ± 0.7 | 2.6 ± 1.1 | 3.4 ± 0.8 | 15.5 ± 1.1 | 13.2 ± 0.5 | 13.5 ± 2.0 |
| Sakharam Waghmare | observed veh/h | 320 | 262 | 362 | 460 | 345 | 265 | 242 | 228 | 385 | 405 | 370 | 330 |
| Sakharam Waghmare | base | 6.5 ± 1.7 | 5.9 ± 3.1 | 6.3 ± 1.4 | 17.1 ± 0.9 | 15.0 ± 2.4 | 11.4 ± 1.9 | 7.9 ± 2.4 | 10.3 ± 1.6 | 13.2 ± 1.9 | 18.7 ± 2.4 | 20.0 ± 1.9 | 16.5 ± 3.7 |
| Sakharam Waghmare | before | 6.7 ± 1.7 | 5.9 ± 3.1 | 6.0 ± 1.0 | 17.7 ± 1.7 | 15.9 ± 3.1 | 12.1 ± 2.7 | 8.0 ± 2.4 | 10.8 ± 1.1 | 13.8 ± 2.1 | 18.2 ± 3.1 | 19.5 ± 2.5 | 16.4 ± 3.9 |
| Sakharam Waghmare | after | 13.2 ± 1.5 | 10.8 ± 2.0 | 11.4 ± 1.0 | 16.4 ± 0.1 | 14.8 ± 2.5 | 13.0 ± 1.6 | 10.2 ± 1.4 | 11.5 ± 1.1 | 13.8 ± 1.0 | 15.2 ± 0.8 | 16.0 ± 0.5 | 13.3 ± 1.4 |

A GEH with spread ± 0.0 and the same value in every config is a movement the model routes no vehicle onto at all (GEH = sqrt(2 × observed)), e.g. Panchratna N-S, N-R, E-R, S-S, S-R, W-R; Kokane S-S, S-R; Ganraj W-L, W-S after; Infosys E-L after.

**Verdict.** No junction meets GEH < 5 on 85% of movements, before or after. Mean GEH falls from base to after at five of six junctions (Kasturi 20.6 → 15.8, Infosys 11.6 → 10.4, Kokane 16.6 → 14.3, Panchratna 21.5 → 17.9, Ganraj 28.9 → 26.1; Sakharam 12.4 → 13.3 is flat), Kasturi now routes all 12 counted movements (5 were unreachable), and the counted volume the junctions pass rises at Kasturi (31 → 41%), Kokane, Panchratna and Ganraj. But the simulation still passes only 22-58% of the counted volume at every junction, and the share of movements under GEH 5 went down at Kasturi (4 → 0 against `before`; the 4 were movements that happened to be near-empty in both counts and model) and Infosys (6 → 3). The model is **not calibrated** at any of the six junctions. The rest of this document is about why.

## 4. Root causes found, with evidence, and fixes

### 4.0 Per-junction summary

| Junction | Control (study / model) | Main root cause | Fix in this branch | Result base → after (3 seeds) |
|---|---|---|---|---|
| Kasturi | signalised / signalised | OSM north arm has no exit (both carriageways one-way inbound) → 5 movements unreachable; grants kept at red lines (§4.1); demand above modelled capacity, X ≈ 1.06 (§4.2) | Correction layer reverses/opens 5 ways (`kasturi-ne-1..4`, `kasturi-nw-1`); platoon grant release; Webster timing | Unreachable 5 → 0; mean GEH 20.6 → 15.8; volume 31 → 41%; GEH<5 0.3 → 0 of 12; delay 181 → 246 s, LOS F (the now-reachable movements add load to an already oversaturated box) |
| Panchratna | signalised / priority (no OSM signal node) | Six OSM arms, two unmatched to the study's four approaches → 6 movements unreachable; junction location itself inferred (see §6) | None specific (no correction yet); general grant/platoon fixes | Mean GEH 21.5 → 17.9; GEH<5 2 → 4.3 of 12; volume 31 → 43%; 6 still unreachable |
| Ganraj | signalised / signalised | Demand far above modelled capacity: Y = 1.45, X ≈ 1.6 from OSM widths (§4.2); short internal links of a dual-carriageway node cluster fill and block entry (§4.3) | Webster timing; grant fixes | Mean GEH 28.9 → 26.1; volume 16 → 22%; feedback-before-fit left W-L, W-S unrouted (0 → 2 unreachable, §4.5); still 0 of 12 under GEH 5 |
| Kokane | roundabout / roundabout | Roundabout entry capacity low (3.8 s critical gap applied to all vehicles incl. two-wheelers); S arm routing gives 0 flow on S-S, S-R; earlier harness crash | Crash fixed; correction layer (roundabout one-way implication) | Mean GEH 16.6 → 14.3; volume 36 → 42%; delay 62 → 52 s; GEH<5 3.3 → 2.0 of 12; 2 unreachable unchanged |
| Infosys Circle Ph. 1 | roundabout / roundabout | Two inbound carriageways mapped the wrong way (5 movements unreachable); ring segment mapped two-way | `infosys-n-1`, `infosys-e-1` (high confidence), `infosys-ring-1` (medium) | Unreachable 5 → 1 (E-L); mean GEH 11.6 → 10.4; but GEH<5 6 → 3 of 12, gridlock removals 5 → 33, speed 14 → 4 km/h — `infosys-ring-1` is suspect and should be checked on imagery |
| Sakharam Waghmare | unsignalised 4-arm / OSM roundabout | Ring-vs-study conflict (§6); lane counts missing on the approach ways; volume capped near 40% by entry capacity | 10 `sakharam-lanes-*` corrections (lanes = 2) | R² 0.03 → 0.54 (movement shares now follow the counts); mean GEH 12.4 → 13.3 (flat); volume 43 → 39%; 0 of 12 under GEH 5 |

### 4.1 Grants kept at a red line (fixed)

Diagnostics added to the harness (`VAL_DIAG=1`: per-approach stop-line discharge per second of queued green, and the outcome of every grant request, with `TrafficMicroSim.traceGrants()`) showed at Kasturi (after, seed 7) that most refusals at every approach were conflicts with a vehicle **standing at a red approach that still held a grant to cross**: e.g. 2,831 refusals on one approach were "by osm_1533733545 approaching standing red". Two faults:

1. When the signal turned red only the front vehicle of a platoon had its grant withdrawn; the loop stopped at the first ungranted vehicle, so the followers (cleared together on green) kept their claims.
2. A turning follower can stand past the start of its own turn (a turn starts further back than the straight-on line) while queued behind a leader without a grant; being "past its line" it was never revoked.

Fix (`TrafficMicroSim.step`, part 1): every unused grant in the lane is checked each step, and a vehicle queued behind an ungranted leader counts as not yet in the junction. Effect at Kasturi, seed 7, same demand:

| Approach (OSM link) | Lanes | Discharge in queued green, before fix (PCU/h) | After fix (PCU/h) |
|---|---|---|---|
| 567724270 seg 14 | 2 | 461 | 1,830 |
| 613849580 seg 5 | 3 | 1,260 | 3,164 |
| 1209324408 seg 2 | 2 | 1,100 | 1,975 |
| 1533733545 seg 2 | 2 | 1,165 | 2,101 |

Junction throughput rose from 22% to 47% of the counted volume (single-seed diagnostic). A regression test (`JunctionRealism.test.ts`, "a platoon cut off by red gives back its grants") checks the invariant on a toy crossroads; it did not reproduce the fault itself on the toy before the fix (three geometries tried), so the Kasturi diagnostic remains the evidence.

### 4.2 Observed demand at or above modelled capacity (real; geometry)

With Webster timing from the observed approach flows (PCU, IRC:106) and Indo-HCM saturation flow from OSM approach widths (lanes × lane width):

| Junction | Phases | Y = Σ q/s | Cycle (capped) | L = 2n + R | Degree of saturation X = Y·C/(C − L) |
|---|---|---|---|---|---|
| Kasturi | 4 | 0.95 | 150 s | 16 s | 1.06 |
| Ganraj (no feedback, seed 7) | 4 | 1.45 | 150 s | 16 s | 1.62 |
| Ganraj (with feedback) | 4 | 1.01 | 150 s | 16 s | 1.13 (two W movements unrouted, see 4.5) |

The counts are **discharge** counts (vehicles counted crossing the junction), so the real junctions passed these flows. A modelled X above 1 therefore means the model's capacity is short of reality: at Ganraj the OSM approach widths (and/or phasing) give only about 62% of the capacity the counts show the junction has. Real approaches in Pune flare at the stop line and two-wheelers use the full paved width, neither of which OSM lane counts carry. LOS F in the model at these two junctions follows from the geometry, and GEH cannot reach 5 there until approach widths are measured (imagery or site). For the arrival-vs-discharge question: since counts are discharge, the right comparison is simulated discharge against counts, which is what the harness does; the counts give no arrival demand above capacity to compare with.

### 4.3 Discharge still below Indo-HCM saturation flow at real junctions (open)

On a toy 7 m approach the platoon discharge reaches 5,190-5,730 PCU/h against Indo-HCM 5,040 PCU/h (`JunctionRealism.test.ts`). At Kasturi after the fix, queued-green discharge is 1,830-3,164 PCU/h on 2-3 lane approaches, i.e. roughly 40-60% of Indo-HCM. Grant outcomes show what remains: conflicts with vehicles from other approaches moving through the box on green (permissive movements in the same phase), and "room" / "room-wait" refusals — the next link lacks space. OSM draws dual-carriageway junctions as clusters of nodes joined by very short links (17-28 m at Kasturi, Ganraj and Panchratna), and those internal links fill and block entry (Panchratna: 2,233 "room" and 2,309 "room-wait" refusals on its main approach; Ganraj: 3,612-3,993 "room" refusals on two approaches). Treating a node cluster as one junction box with its own storage is the next structural fix.

### 4.4 Demand that cannot enter or cannot be routed

At every junction many vehicles are still waiting at the area edge at the end of the run (Kasturi after: 742; Ganraj after: 835; Kokane: 439), and some OD pairs have no route (Sakharam: 663 unroutable trips; Panchratna: 204). Queues back up to the area edge within the 20-minute run because the approaches are jammed (4.2-4.3), so the upstream area is not the cause, but it does hide how long the real queue would be. Panchratna keeps 6 counted movements unreachable in every configuration: the junction has six arms in OSM, two of them unlabelled by the arm-to-cardinal match, and no correction covers it yet. Kokane keeps 2 (S right, S straight).

### 4.5 Congestion feedback (implemented and unit-tested; limited effect here)

`assignment.ts` runs the demand, measures each link's congested/free-flow time ratio and averages it into route costs by MSA (Sheffi 1985). Fixed in this round: a link unused in an iteration now enters the average at ratio 1 (free flow), so the factors are the true running mean instead of keeping their last congested value. `AssignmentFeedback.test.ts` checks the MSA identity, rerouting off a signal-congested route on a toy two-route network, shrinking steps, and route costs ending closer together than at free flow. In the validation the feedback is computed on the project demand *before* the count fit, then the fit is made with those costs; at Ganraj this left W straight and W left unrouted (2 unreachable movements after vs 0 before), and with all-or-nothing routing per OD about half the flow switches route at each iteration (Kasturi: rerouted share 0.53-0.57 at iterations 2-3). The order should be fit → feedback on the fitted plan → refit (remaining work).

### 4.6 Network corrections

Kasturi's north arm had no way out in OSM (both carriageways one-way towards the junction), which made 5 counted movements unreachable; the correction layer fixes it (0 unreachable after). At Sakharam the lane corrections raised R² from 0.03 to 0.54 (movement shares now follow the counts) while volume stays at ~40%. At Infosys the ring made one-way (`infosys-ring-1`, medium confidence) coincides with more gridlock removals (5 → 33) and slower speeds; that correction should be checked on imagery first. Every correction and its evidence is listed in `docs/PROPOSED_OSM_EDITS.md`.

### 4.7 Warm-up

300 s warm-up + 900 s measurement. Queues at the jammed junctions are still growing at the end (waiting-to-enter counts rise through the run), i.e. the model never reaches a steady state at the counted flows. A longer warm-up would not raise throughput (capped by 4.2-4.3); it would only lengthen queues. Not changed.

## 5. Fixes made in this round

- Signal grants released for the whole platoon on red, and for followers queued behind an ungranted leader (§4.1).
- Signal state checked before box conflicts in grant requests (same outcome; clearer diagnostics).
- MSA treats unused links as free flow (§4.5); `onIteration` hook.
- Tests: `AssignmentFeedback.test.ts` (2 tests), platoon-red invariant in `JunctionRealism.test.ts`.
- Harness diagnostics: link occupancy within 400 m, queued-green discharge, grant outcomes (`VAL_DIAG=1`).
- Lost-time citation corrected (§6).
- No parameter was changed to improve a fit.

## 6. Limitations

- **Not calibrated.** No junction meets GEH < 5 for 85% of movements in any configuration (§3).
- **Kasturi arm layout.** In OSM as published, Kasturi's north arm has no outbound carriageway, so 5 counted movements are unreachable (`base`, `before`). They are reachable only through the local correction layer, whose edits are not yet confirmed on imagery; until the OSM arms are corrected (subject to the owner's approval, `docs/PROPOSED_OSM_EDITS.md`), anyone running on raw OSM gets those movements unreachable.
- **Panchratna location is inferred.** No OSM node is named Panchratna Chowk; the junction is placed at the east end of way 475607455 "Panchratna Chowk Road" (four arms, matching the study), not its west-end T. If that is the wrong end, every Panchratna result is for a different junction. It also has six arms in OSM against four in the study (6 movements unreachable), and no OSM signal node although the study calls it signalised, so the model runs it as a priority junction (LOS A-C is therefore not comparable).
- **AM vs PM unknown for the counts.** Neither source gives the clock time of the counted peak hour; the app lets the user choose (default PM 19:00), and the hourly scaling depends on that choice (the two peaks differ by under 5% in the profile).
- **Weekend shape is derived, not measured** (weekday profile × TomTom weekend/weekday ratio).
- **Sakharam Waghmare: ring vs study.** OSM maps it as a roundabout (the count file's match: `kind: roundabout`) while the study tabulates a four-approach unsignalised junction. The model follows OSM; the approach-to-cardinal mapping assumes the study's four arms. Which is right on the ground is unresolved.
- **Lost time L = 2n + R is unverified as a standard.** It is taken from a secondary source (Nikhil et al., IJERA 9(4) 2019, pp. 25, 27, which states the formula). It is *not* in IRC:93-1985 (scanned copy at law.resource.org, Appendix 3, p. 37 takes amber time per cycle plus 4 s first-vehicle reaction per phase, with 525 W PCU/h saturation flow), and it has not been checked against Indo-HCM 2017. The code comments that attributed it to IRC:93 were corrected. With IRC:93's 4 s per phase, cycles would be longer and capacity slightly lower.
- **LOS thresholds are HCM 2000** (Exhibit 16-2 signalised, 17-2 two-way stop), not Indo-HCM 2017; the Indo-HCM LOS table could not be checked against an accessible copy, so whether these thresholds suit Indian mixed traffic is unverified. Roundabouts are graded with the unsignalised table.
- **Kasturi's published table does not add up** (rows 6,200 veh/h, printed total 6,190); rows used as printed.
- **PCU factors** are IRC:106 mid-block values, indicative only at junctions.
- The `before` configuration is not bit-identical to `4b885ad` (§2); the `base` rows are.
- Three seeds per configuration; spreads are population SD over three runs, not confidence intervals.
- **Panel label.** After calibrating with "Counts are: PM peak 19:00" selected, the demand card still reads "Demand calibrated to counts · AM peak" (it shows the project estimate's period). Cosmetic; not fixed in this round.
- Screenshots fast-forward the simulation by calling its step function from the page (headless SwiftShader renders too slowly to reach a built-up queue in real time); this changes nothing in the model.

## 7. Remaining work

1. Measure approach widths (stop-line flare) at Ganraj and Kasturi on imagery and add them to the correction layer as width/lane corrections; re-validate. Expected to matter most (§4.2).
2. Model an OSM node cluster (dual-carriageway crossing) as one junction box with internal storage, so short internal links do not block discharge (§4.3).
3. Run feedback on the fitted plan, then refit; consider splitting each OD's flow over routes (path-based MSA) instead of all-or-nothing (§4.5).
4. Panchratna: resolve the six-arm layout and the missing signal (confirm on imagery); Kokane S arm routing.
5. Roundabout entry capacity (Sakharam, Infosys, Kokane): compare with Indo-HCM roundabout entry capacity; two-wheelers accept shorter gaps than the 3.8 s applied to all minor movements.
6. Review `infosys-ring-1` before keeping it enabled.
7. Re-run the full before/after table after each of the above.

## 8. Checks run for this commit

- Frontend unit tests (`npx vitest run --config vitest.config.ts`): 37 files passed, 3 skipped (opt-in harnesses); 318 tests passed, 3 skipped, 0 failed. Includes `AssignmentFeedback.test.ts` (MSA congestion feedback) and `SignalTiming.test.ts` (Webster worked example).
- `tsc -b`: no errors. `oxlint`: 0 errors, 5 warnings (unused imports, pre-existing).
- Backend `pytest`: 50 passed.
- Screenshots (local, not committed): time-of-day selector at 09:00 (peak, ~2,027 veh/h entering) and 02:00 (low, ~142 veh/h); calibration panel after "Calibrate demand" at Kasturi (in-app: mean GEH 27.7 → 15.5, 0/12 under GEH 5, consistent with §3); and four frames ~7 s apart of queues forming and discharging at Kasturi's signals with the calibrated PM-peak demand.
