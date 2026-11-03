# Calibration and validation of the micro-simulation at six counted Pune junctions

Branch `realistic-traffic`. What the simulation is checked against, how it was validated, what was found at each junction, what was fixed, and what still does not match. Numbers are reported as measured. Nothing was tuned to make a junction pass: no per-junction adjustment, no parameter changed for a score, and the observed counts were never altered. Public OpenStreetMap was never edited; local corrections live in a separate layer and proposed OSM edits wait for the owner's approval (`docs/PROPOSED_OSM_EDITS.md`).

## 1. Data sources

| Data | Source | Used for | Status |
|---|---|---|---|
| Peak-hour classified turning counts (LV/HV/TW, per approach and turn) at Kokane, Panchratna, Kasturi, Ganraj, Sakharam Waghmare and Infosys Circle Phase 1 | Khandekar, Bagwan, Karande & Pilaka (2025), *Study of Traffic Management at Road Intersection in Pune*, NICMAR / Journal Press India, ch. 129, pp. 1462-1472, doi:10.17492/jpi/nicmar/2507129 (Tables 1-6); cross-checked against Kureshi et al. (2026), *Int. J. Innovations in Research* 2(10) 33-39, doi:10.5281/zenodo.21712996. Transcribed in `backend/data/observed_counts/pune_west_2026.json` | Observed flows for GEH; count-seeded OD and IPF; Webster design flows | Counts as printed. **AM or PM peak not stated by either source** (§7) |
| PCU factors | IRC:106-1990 Table 1 (two-wheeler 0.5 at 5% / 0.75 at 10%+ of the stream; car 1.0; truck/bus 2.2 / 3.7). Checked against the scanned code, https://archive.org/stream/gov.in.irc.106.1990/irc.gov.in.106.1990_djvu.txt (Table 1, p. 10). The project uses TW 0.75, HV 2.2, LV 1.0 (rationale in the count file) | Design flows in PCU/h | Table values verified. **Clause 2.1 limits IRC:106 to mid-block sections**, so its use at junctions is unverified (§7) |
| Saturation flow | Indo-HCM 2017 (CSIR-CRRI) width-based unit base saturation flow: 630 PCU/h/m below 7 m, 1140 − 60 w for 7-10.5 m, 500 above (as quoted in Indo-HCM worked applications, e.g. IJAEM 2(1) 2020 pp. 271-278). 7 m approach: 7 × (1140 − 420) = 5,040 PCU/h | Webster splits; discharge tests (`JunctionRealism.test.ts`) | Secondary quotation of Indo-HCM |
| Turn adjustment factors | HCM 2000 Exhibit 16-7: exclusive right-turn lane f_RT = 0.85, exclusive protected left-turn lane f_LT = 0.95 (US right-hand traffic; in India the kerb-side turn is the left, the far-side turn the right). Checked against a copy of HCM 2000 ch. 16, p. 16-11, https://content.civicplus.com/api/assets/66fec0ac-2f88-4eb6-974b-7b42d95d845d | Reference for the turning-platoon test only | **Verified** this round (was cited from memory) |
| Signal design | Webster (1958), RRL Technical Paper 39: C0 = (1.5 L + 5)/(1 − Y), g_i = (C0 − L) y_i / Y; worked example in `SignalTiming.test.ts` | `signalTiming.ts` | |
| Lost time | L = 2n + R (2 s per phase plus all-red), Nikhil et al. (2019), IJERA 9(4) pp. 23-28, https://www.ijera.com/papers/vol9no4/Series-2/D0904022328.pdf (pp. 25, 27) | `STARTUP_LOST_S = 2` | **Unverified as a standard** (not in IRC:93-1985; Indo-HCM not checked) (§7) |
| Critical gaps | Indo-HCM 2017 base critical gap 2.7 s (major-road right) and 3.8 s (minor-road right), as tabulated in IJRESM (journal.ijresm.com) Table 4 | Gap acceptance at priority junctions, roundabouts, permissive right turns | Secondary quotation |
| LOS | HCM 2000 control-delay thresholds. Exhibit 16-2 (signalised: A ≤ 10, B ≤ 20, C ≤ 35, D ≤ 55, E ≤ 80 s, F above) checked against the same HCM 2000 ch. 16 copy, p. 16-2; Exhibit 17-2 (two-way stop: 10/15/25/35/50 s) not opened this round | `losFor()` | Thresholds verified as HCM 2000's; **their fitness for Indian mixed traffic is unverified** (Indo-HCM LOS table not checked) |
| Hour-of-day profile | Gunjan Chowk, Pune hourly counts (IJETT 47(2) 2017); Mendeley Pune CCTV counts (doi:10.17632/xnf2k6n288.1); TomTom Traffic Index 2025 Pune; Pune CMP 2018. See `backend/data/diurnal/README.md` | Time-of-day scaling | **Weekend shape is derived**, not measured (§7) |
| Road network | OpenStreetMap `western-zone-latest.osm.pbf` (data timestamp 2026-11-01 21:21 UTC) plus the local correction layer `backend/data/network_corrections/pune_west_v1.json` (24 corrections) | Geometry, lanes, one-way, signals | |

## 2. Validation protocol

`frontend/src/engine/testing/JunctionValidation.test.ts` (opt-in; runs only when `VAL_DUMP` is set) loads a dump of the running app (OSM roads, signal nodes, project context, count file, one seed road per junction), builds the study area around the junction, seeds OD demand from the counts, fits it by bounded IPF, runs 300 s warm-up and 900 s measurement, and compares simulated veh/h per counted movement with the counts. Seeds 7, 11 and 23; tables give mean ± population SD over the three seeds (not confidence intervals).

Configurations in §3:

- **before (4f5e11c)**: the code at pushed commit `4f5e11c` with every realism feature on (correction layer, Webster signals from the observed approach flows, two-wheelers abreast, 3 MSA iterations of congestion feedback computed before the count fit). Results `/workspace/work/cal/val/r0/<junction>_before4f5.json`; they equal the `after` rows of the previous version of this document.
- **after**: the final code of this round (commits `493bfbd`, `e516fd3`, `9c9aa0d`, `deb3d11`; the validation code is identical to `89911f3`), same harness settings (`VAL_CONFIG=after VAL_ASSIGN=3`), with the new defaults: stop-line counting, count-seeded trips pinned to their counted movement, fit → feedback → refit. All six junctions were run in one queue on the same working tree, which had no code change after 08:14:59 UTC on 2026-11-03 (the ring-lane fix) and before any run started; results `/workspace/work/cal/val/r3/<junction>_fx.json`.
- Ablations on the final code (§4): `VAL_STOPLINE=off` (zone-edge counting, the earlier layout), `VAL_ORDER=feedback-first`, `VAL_DISABLE=infosys-ring-1`, and Kokane label sensitivity (`VAL_MAX_CARD_ERR=65` with `VAL_LABEL_SHIFT=0` or `1`).

Metrics: GEH per movement (`sqrt(2 (m − c)² / (m + c))`; usual acceptance GEH < 5 for 85% of movements, i.e. 11 of 12), mean and max GEH, R² (Pearson) and slope (through the origin) of simulated against observed, simulated/observed total volume, network mean speed, control delay, mean queue and HCM 2000 LOS at the busiest model node within 90 m of the junction, gridlock removals (vehicles stuck > 120 s removed), and counted movements the network cannot route.

Aggregation: `/workspace/work/cal/agg.py`, `/workspace/work/cal/final_table4.py` (scratch, outside the repo).

## 3. Results (counted peak hour, 3 seeds, mean ± population SD)

#### Summary per junction (3 seeds: 7, 11, 23; mean ± population SD)

| Junction | Config | GEH<5 (of 12) | Mean GEH | Max GEH | R² | Slope sim/obs | Sim/obs volume | Mean speed km/h | Control delay s | Mean queue m | LOS (per seed) | Gridlock removals | Unreachable movements |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kasturi | before (4f5e11c) | 0.0 ± 0.0 | 15.8 ± 0.6 | 26.5 ± 1.2 | 0.02 ± 0.01 | 0.40 ± 0.02 | 41 ± 2% | 2.5 ± 0.3 | 246 ± 7 | 156 ± 5 | F/F/F | 18 ± 2 | 0 ± 0 |
| Kasturi | after | 0.3 ± 0.5 | 8.9 ± 0.2 | 12.1 ± 0.3 | 0.73 ± 0.04 | 0.65 ± 0.01 | 65 ± 1% | 7.1 ± 0.6 | 167 ± 7 | 144 ± 10 | F/F/F | 0 ± 0 | 0 ± 0 |
| Panchratna | before (4f5e11c) | 4.3 ± 0.5 | 17.9 ± 0.6 | 36.6 ± 0.0 | 0.11 ± 0.02 | 0.45 ± 0.02 | 43 ± 2% | 11.7 ± 1.3 | 16 ± 1 | 18 ± 2 | C/B/C | 8 ± 6 | 6 ± 0 |
| Panchratna | after | 5.0 ± 0.8 | 17.1 ± 0.2 | 36.6 ± 0.0 | 0.16 ± 0.03 | 0.49 ± 0.01 | 47 ± 1% | 13.1 ± 1.0 | 62 ± 11 | 56 ± 16 | D/E/E | 0 ± 0 | 6 ± 0 |
| Ganraj | before (4f5e11c) | 0.0 ± 0.0 | 26.1 ± 0.1 | 45.1 ± 0.0 | 0.01 ± 0.01 | 0.20 ± 0.01 | 22 ± 0% | 5.2 ± 0.8 | 113 ± 10 | 77 ± 8 | F/F/F | 19 ± 5 | 2 ± 0 |
| Ganraj | after | 0.0 ± 0.0 | 18.2 ± 0.4 | 28.1 ± 0.5 | 0.40 ± 0.06 | 0.40 ± 0.00 | 41 ± 1% | 8.7 ± 1.6 | 130 ± 2 | 115 ± 4 | F/F/F | 0 ± 0 | 0 ± 0 |
| Kokane | before (4f5e11c) | 2.0 ± 0.8 | 14.3 ± 0.3 | 31.6 ± 0.0 | 0.01 ± 0.01 | 0.41 ± 0.01 | 42 ± 1% | 3.8 ± 0.7 | 52 ± 3 | 30 ± 1 | F/E/F | 15 ± 10 | 2 ± 0 |
| Kokane | after | not compared: The arms do not line up with the survey's N/E/S/W approaches (an arm is 53° off). | | | | | | | | | | | |
| Kokane | after, labels best fit (sensitivity) | 0.7 ± 0.9 | 20.0 ± 2.7 | 27.8 ± 0.9 | 0.06 ± 0.03 | 0.22 ± 0.09 | 21 ± 9% | 2.1 ± 2.7 | 76 ± 15 | 42 ± 4 | F/F/F | 65 ± 10 | 0 ± 0 |
| Kokane | after, labels rotated (sensitivity) | 3.7 ± 1.7 | 12.1 ± 2.0 | 23.8 ± 2.3 | 0.14 ± 0.06 | 0.50 ± 0.08 | 49 ± 8% | 1.8 ± 2.3 | 48 ± 11 | 37 ± 1 | F/E/E | 26 ± 13 | 0 ± 0 |
| Infosys Circle Ph. 1 | before (4f5e11c) | 3.0 ± 0.0 | 10.4 ± 0.4 | 29.8 ± 0.0 | 0.02 ± 0.01 | 0.55 ± 0.02 | 58 ± 2% | 4.0 ± 0.2 | 66 ± 4 | 59 ± 7 | F/F/F | 33 ± 5 | 1 ± 0 |
| Infosys Circle Ph. 1 | after | 5.0 ± 0.0 | 7.0 ± 1.2 | 13.6 ± 3.0 | 0.51 ± 0.14 | 0.69 ± 0.05 | 68 ± 5% | 10.6 ± 0.3 | 40 ± 3 | 35 ± 2 | E/E/E | 0 ± 0 | 0 ± 0 |
| Infosys Circle Ph. 1 | after, infosys-ring-1 off | 5.0 ± 0.0 | 7.0 ± 1.2 | 13.6 ± 3.0 | 0.51 ± 0.14 | 0.69 ± 0.05 | 68 ± 5% | 10.6 ± 0.3 | 40 ± 3 | 35 ± 2 | E/E/E | 0 ± 0 | 0 ± 0 |
| Sakharam Waghmare | before (4f5e11c) | 0.0 ± 0.0 | 13.3 ± 0.2 | 16.6 ± 0.2 | 0.54 ± 0.06 | 0.39 ± 0.01 | 39 ± 1% | 7.0 ± 0.2 | 160 ± 12 | 88 ± 1 | F/F/F | 9 ± 3 | 0 ± 0 |
| Sakharam Waghmare | after | 4.3 ± 1.2 | 10.3 ± 0.3 | 20.2 ± 1.8 | 0.02 ± 0.01 | 0.51 ± 0.02 | 53 ± 2% | 9.8 ± 2.6 | 92 ± 9 | 78 ± 7 | F/F/F | 5 ± 2 | 0 ± 0 |

#### GEH per counted movement (mean ± SD over 3 seeds). Movement = approach-turn (L/S/R).

| Junction | Config | N-L | N-S | N-R | E-L | E-S | E-R | S-L | S-S | S-R | W-L | W-S | W-R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kasturi | observed veh/h | 512 | 427 | 475 | 543 | 654 | 487 | 686 | 505 | 529 | 411 | 570 | 401 |
| Kasturi | before (4f5e11c) | 12.0 ± 2.5 | 11.7 ± 3.3 | 10.2 ± 0.8 | 17.9 ± 1.8 | 17.0 ± 0.4 | 15.3 ± 1.8 | 26.5 ± 1.2 | 20.6 ± 1.5 | 18.8 ± 1.3 | 13.1 ± 1.1 | 14.8 ± 0.9 | 11.7 ± 0.3 |
| Kasturi | after | 9.0 ± 2.0 | 8.3 ± 0.3 | 7.7 ± 1.4 | 10.9 ± 0.4 | 11.2 ± 1.2 | 9.3 ± 0.8 | 5.7 ± 1.1 | 10.9 ± 1.1 | 9.7 ± 1.7 | 8.5 ± 2.0 | 8.8 ± 2.7 | 7.1 ± 1.0 |
| Panchratna | observed veh/h | 588 | 529 | 669 | 431 | 736 | 404 | 603 | 443 | 474 | 394 | 504 | 540 |
| Panchratna | before (4f5e11c) | 0.7 ± 0.7 | 32.5 ± 0.0 | 36.6 ± 0.0 | 8.0 ± 5.2 | 8.9 ± 0.6 | 28.4 ± 0.0 | 2.3 ± 1.5 | 29.8 ± 0.0 | 30.8 ± 0.0 | 1.8 ± 0.4 | 1.4 ± 1.0 | 32.9 ± 0.0 |
| Panchratna | after | 0.8 ± 0.1 | 32.5 ± 0.0 | 36.6 ± 0.0 | 2.7 ± 1.9 | 2.9 ± 2.8 | 28.4 ± 0.0 | 1.3 ± 0.7 | 29.8 ± 0.0 | 30.8 ± 0.0 | 3.5 ± 1.1 | 3.4 ± 1.5 | 32.9 ± 0.0 |
| Ganraj | observed veh/h | 491 | 410 | 657 | 604 | 1040 | 879 | 513 | 432 | 591 | 901 | 1019 | 759 |
| Ganraj | before (4f5e11c) | 15.9 ± 2.1 | 25.2 ± 1.0 | 12.1 ± 1.6 | 28.5 ± 0.5 | 29.9 ± 1.3 | 27.5 ± 1.5 | 23.6 ± 1.5 | 12.4 ± 1.2 | 15.1 ± 1.5 | 42.4 ± 0.0 | 45.1 ± 0.0 | 35.3 ± 0.1 |
| Ganraj | after | 13.0 ± 1.8 | 13.5 ± 3.8 | 9.8 ± 0.9 | 21.7 ± 1.9 | 27.8 ± 1.0 | 25.5 ± 1.5 | 15.6 ± 2.4 | 12.8 ± 2.7 | 15.9 ± 2.2 | 20.3 ± 0.1 | 24.0 ± 1.1 | 18.6 ± 2.3 |
| Kokane | observed veh/h | 440 | 365 | 325 | 275 | 425 | 395 | 344 | 245 | 500 | 445 | 307 | 360 |
| Kokane | before (4f5e11c) | 24.7 ± 1.9 | 22.3 ± 0.5 | 19.8 ± 1.0 | 9.3 ± 2.0 | 9.0 ± 0.7 | 11.3 ± 2.9 | 0.6 ± 0.4 | 22.1 ± 0.0 | 31.6 ± 0.0 | 6.9 ± 4.7 | 8.2 ± 1.1 | 5.5 ± 1.0 |
| Kokane | after, labels best fit (sensitivity) | 25.7 ± 1.9 | 25.0 ± 2.9 | 24.9 ± 0.6 | 17.4 ± 3.8 | 23.4 ± 3.5 | 23.5 ± 2.5 | 11.0 ± 5.0 | 9.0 ± 5.0 | 13.3 ± 11.1 | 23.9 ± 3.7 | 19.0 ± 5.4 | 23.9 ± 2.3 |
| Kokane | after, labels rotated (sensitivity) | 23.1 ± 1.4 | 21.1 ± 1.2 | 20.5 ± 1.7 | 9.9 ± 5.2 | 10.6 ± 6.7 | 14.4 ± 9.8 | 3.5 ± 2.0 | 2.3 ± 0.7 | 2.6 ± 1.8 | 12.3 ± 2.6 | 10.7 ± 4.0 | 14.8 ± 3.3 |
| Infosys Circle Ph. 1 | observed veh/h | 141 | 372 | 389 | 445 | 325 | 438 | 159 | 398 | 310 | 437 | 374 | 455 |
| Infosys Circle Ph. 1 | before (4f5e11c) | 6.9 ± 1.2 | 9.2 ± 1.3 | 11.4 ± 2.3 | 29.8 ± 0.0 | 7.3 ± 1.7 | 11.1 ± 2.0 | 1.3 ± 0.7 | 2.6 ± 1.1 | 3.4 ± 0.8 | 15.5 ± 1.1 | 13.2 ± 0.5 | 13.5 ± 2.0 |
| Infosys Circle Ph. 1 | after | 2.1 ± 0.7 | 1.2 ± 0.9 | 0.5 ± 0.5 | 5.3 ± 1.2 | 4.9 ± 0.5 | 1.5 ± 1.4 | 10.2 ± 2.2 | 12.1 ± 2.0 | 11.0 ± 2.8 | 10.9 ± 3.5 | 11.8 ± 2.9 | 12.0 ± 3.6 |
| Infosys Circle Ph. 1 | after, infosys-ring-1 off | 2.1 ± 0.7 | 1.2 ± 0.9 | 0.5 ± 0.5 | 5.3 ± 1.2 | 4.9 ± 0.5 | 1.5 ± 1.4 | 10.2 ± 2.2 | 12.1 ± 2.0 | 11.0 ± 2.8 | 10.9 ± 3.5 | 11.8 ± 2.9 | 12.0 ± 3.6 |
| Sakharam Waghmare | observed veh/h | 320 | 262 | 362 | 460 | 345 | 265 | 242 | 228 | 385 | 405 | 370 | 330 |
| Sakharam Waghmare | before (4f5e11c) | 13.2 ± 1.5 | 10.8 ± 2.0 | 11.4 ± 1.0 | 16.4 ± 0.1 | 14.8 ± 2.5 | 13.0 ± 1.6 | 10.2 ± 1.4 | 11.5 ± 1.1 | 13.8 ± 1.0 | 15.2 ± 0.8 | 16.0 ± 0.5 | 13.3 ± 1.4 |
| Sakharam Waghmare | after | 5.1 ± 5.0 | 4.0 ± 3.2 | 4.7 ± 5.1 | 20.1 ± 1.7 | 18.3 ± 3.8 | 15.2 ± 2.1 | 2.9 ± 0.9 | 4.7 ± 3.7 | 6.1 ± 3.1 | 14.5 ± 2.6 | 14.5 ± 3.2 | 13.2 ± 2.2 |

A GEH with spread ± 0.0 that is the same before and after is a movement the model routes no vehicle onto (GEH = sqrt(2 × observed)): Panchratna N-S, N-R, E-R, S-S, S-R, W-R (no median opening, §4.6).

**Verdict.** Not calibrated: no junction reaches GEH < 5 on 11 of 12 movements. Against `4f5e11c`, mean GEH falls at all five comparable junctions (Kasturi 15.8 → 8.9, Ganraj 26.1 → 18.2, Infosys 10.4 → 7.0, Sakharam 13.3 → 10.3, Panchratna 17.9 → 17.1), the counted volume the junctions pass rises (Kasturi 41 → 65%, Ganraj 22 → 41%, Infosys 58 → 68%, Sakharam 39 → 53%, Panchratna 43 → 47%), gridlock removals fall to 0 at Kasturi, Ganraj, Infosys and Panchratna (5 at Sakharam), and no movement is unreachable except Panchratna's six. Kokane is not comparable under the default arm labelling (§4.7). Regressions are listed in §5.

#### Ablations on the final code (same 3 seeds)

| Junction | Config | GEH<5 (of 12) | Mean GEH | Max GEH | R² | Slope sim/obs | Sim/obs volume | Mean speed km/h | Control delay s | Mean queue m | LOS (per seed) | Gridlock removals | Unreachable movements |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Kasturi | after, zone-edge counting (VAL_STOPLINE=off) | 1.7 ± 0.5 | 8.6 ± 0.5 | 16.6 ± 0.9 | 0.52 ± 0.13 | 0.66 ± 0.02 | 66 ± 2% | 7.1 ± 1.0 | 160 ± 3 | 133 ± 12 | F/F/F | 0 ± 0 | 0 ± 0 |
| Kasturi | after, feedback-first order | 0.3 ± 0.5 | 8.8 ± 0.1 | 11.4 ± 0.3 | 0.78 ± 0.04 | 0.66 ± 0.01 | 65 ± 1% | 6.7 ± 0.5 | 163 ± 5 | 144 ± 8 | F/F/F | 0 ± 0 | 0 ± 0 |
| Panchratna | after, zone-edge counting (VAL_STOPLINE=off) | 6.0 ± 0.0 | 16.6 ± 0.1 | 36.6 ± 0.0 | 0.14 ± 0.03 | 0.52 ± 0.01 | 50 ± 1% | 19.6 ± 1.6 | 7 ± 1 | 8 ± 1 | A/A/A | 0 ± 0 | 6 ± 0 |
| Ganraj | after, zone-edge counting (VAL_STOPLINE=off) | 0.0 ± 0.0 | 19.1 ± 0.0 | 26.9 ± 0.7 | 0.74 ± 0.04 | 0.40 ± 0.00 | 39 ± 0% | 7.6 ± 1.0 | 137 ± 4 | 117 ± 3 | F/F/F | 0 ± 0 | 0 ± 0 |
| Ganraj | after, feedback-first order | 0.0 ± 0.0 | 18.1 ± 0.1 | 28.4 ± 0.0 | 0.32 ± 0.04 | 0.39 ± 0.00 | 41 ± 0% | 7.7 ± 1.2 | 134 ± 5 | 113 ± 4 | F/F/F | 0 ± 0 | 0 ± 0 |
| Kokane | after, zone-edge counting (VAL_STOPLINE=off) | 5.3 ± 1.7 | 10.5 ± 2.7 | 31.6 ± 0.0 | 0.03 ± 0.02 | 0.59 ± 0.12 | 60 ± 12% | 11.7 ± 4.8 | 41 ± 18 | 29 ± 10 | C/F/E | 17 ± 12 | 2 ± 0 |
| Infosys Circle Ph. 1 | after, zone-edge counting (VAL_STOPLINE=off) | 5.0 ± 0.0 | 7.0 ± 1.2 | 13.6 ± 3.0 | 0.51 ± 0.14 | 0.69 ± 0.05 | 68 ± 5% | 10.6 ± 0.3 | 40 ± 3 | 35 ± 2 | E/E/E | 0 ± 0 | 0 ± 0 |
| Infosys Circle Ph. 1 | after, feedback-first order | 6.3 ± 1.2 | 7.4 ± 1.2 | 18.6 ± 1.0 | 0.30 ± 0.07 | 0.66 ± 0.03 | 66 ± 4% | 9.2 ± 1.5 | 40 ± 1 | 33 ± 1 | E/E/E | 2 ± 1 | 0 ± 0 |
| Sakharam Waghmare | after, zone-edge counting (VAL_STOPLINE=off) | 4.3 ± 1.2 | 10.3 ± 0.3 | 20.2 ± 1.8 | 0.02 ± 0.01 | 0.51 ± 0.02 | 53 ± 2% | 9.8 ± 2.6 | 92 ± 9 | 78 ± 7 | F/F/F | 5 ± 2 | 0 ± 0 |

The Kokane zone-edge row uses the old layout (a side street as an arm), so it is not a valid comparison (§4.7). Infosys and Sakharam are identical with and without stop-line counting (the ring is the core either way).

## 4. Root causes, with verdicts and evidence

### 4.1 Side streets counted as arms: **confirmed; fixed by stop-line counting**

The count zone took every road crossing its 60-70 m circle for an arm. Side streets joining an approach inside the circle became arms of their own: at `4f5e11c` Panchratna had six arms (two unlabelled), Sakharam's east arm had two inbound links, Ganraj's north, south and west seeds started on one-lane local roads merging at priority junctions, and Kasturi's west seeds sat on a lane that cannot reach the junction. Seeds, IPF targets and Webster design flows were spread over those side streets. `e516fd3` counts at the stop lines of the junction core and traces each arm back along its own road; seeds start on the arm's principal carriageway (`StopLineCounting.test.ts`). With it Panchratna's core has exactly the study's four arms, Sakharam's east arm one inbound link.

Effect on the scores is mixed, and it is a measurement-definition fix, not a score fix: on the final code, zone-edge counting (`VAL_STOPLINE=off`) gives Ganraj mean GEH 19.1 vs 18.2 with stop lines, but Kasturi 8.6 vs 8.9 and Panchratna 16.6 vs 17.1 (Infosys and Sakharam identical). Stop-line counting also raises the design flow ratio Y (Ganraj 1.29 → 1.46, Kasturi 0.95 → 1.11), because flows that zone-edge counting split onto side-street "arms" are now on the real approaches.

### 4.2 Queue discharge stalls: **confirmed bugs; fixed** (`493bfbd`)

Toy 7 m two-lane approach, Pune mix, PCU/h over the saturated 10-50 s of green, against Indo-HCM 7 × (1140 − 60 × 7) = 5,040 PCU/h:

| Case | Before the fix | After (this round's test run) |
|---|---|---|
| Straight, queue orders that stalled (two of five orders) | 1,323 and 2,511 | all five orders within 0.8-1.3 × 5,040 (4,900-6,300 when measured for the commit) |
| Right (far-side) turning queue | 2,493 (0.49) | 4,226 (0.84) |
| Left (kerb-side) turning queue | 3,866 (0.77) | 4,541 (0.90) |
| Mixed L/S/R queue | | 5,418 |
| Mixed straight queue, single file / two-wheelers abreast | | 5,189 / 5,729 |

HCM 2000 Exhibit 16-7 reduces saturation flow to 0.85 for an exclusive kerb-side turn lane and 0.95 for a protected far-side turn, so the turning results are of the expected order. Three faults: a two-wheeler cleared beside its partner was refused every step once the partner had gone (its lane stalled until red); keep-clear room was projected only over the time to the stop line, not over the movement, so turning queues discharged one vehicle at a time; and a lane counted as blocked when one rider braked behind the vehicle ahead. At the real junctions queued-green discharge (seed 7 diagnostics) is now 1,876-3,099 PCU/h on Kasturi's 2-lane approaches and 3,463 on its 3-lane one, and 1,422 (2-lane) and 2,623-3,406 (3-lane) at Ganraj: roughly 30-65% of Indo-HCM for lanes × 3.5 m (5,040 PCU/h for 2 lanes, 5,355 for 3), because most of the green is spent with the queue not standing at the line or with the phase oversaturated downstream (§4.4).

### 4.3 Approach widths from OSM too narrow: **partly rejected**

The previous round attributed most of the shortfall at Ganraj and Kasturi to OSM widths. With the discharge stalls fixed the toy approach reaches Indo-HCM saturation for its width, and the junctions pass 65% (Kasturi) and 41% (Ganraj) of the counted volume instead of 41% and 22% on the same widths, so a large part of the old shortfall was the model, not the widths. Widths may still matter (stop-line flares and two-wheelers using the full paved width are not in OSM), but no width was changed and the remaining gap is not attributed to them without measurement.

### 4.4 Demand above the modelled signal capacity: **open; points to phasing or PCU factors, not tuned**

Webster with one phase per approach, IRC:106 PCU and Indo-HCM saturation flow from OSM widths gives Y = Σ q/s = 1.46 at Ganraj and 1.11 at Kasturi (cycle capped at 150 s, oversaturated in every seed). The counts are discharge counts, so the real junctions passed these flows; a modelled Y above 1 means the modelled capacity is short. Possible causes, none tested by tuning: (a) the real phasing is not approach-wise (e.g. opposing approaches together, or left turns free/unsignalised, which Pune junctions often have); (b) IRC:106 PCU factors are mid-block values (clause 2.1), and two-wheeler PCU at a stop line may be lower than 0.75; (c) widths (§4.3). Phasing and PCU factors were left as they are because nothing measured at these junctions fixes them. The signal phase is now the dominant refusal: at seed 7, about 90% (Kasturi 23,393 of 26,120; Ganraj 21,515 of 24,013) of refused grant requests on the signalised approaches were "signal" (red).

### 4.5 Short internal links of dual carriageways block discharge: **rejected for the current code**

Suspicion from the previous round: OSM draws dual-carriageway junctions as clusters of nodes joined by 17-42 m links, and those links fill and block entry. Evidence on the final code (seed 7, `VAL_DIAG=1`, compared with the same diagnostics at `4f5e11c`-era code, whose Kasturi discharge figures match §4.1 of the previous version of this document):

| Junction | Room / room-wait refusals | Share of all refusals | Conflict refusals | Gridlock removals (3 seeds) | Internal-link occupancy (both ends < 45 m) |
|---|---|---|---|---|---|
| Ganraj, before | 7,626 / 1,704 | 37% | 50 | 19 ± 5 | 0.05-0.65 |
| Ganraj, after | 1,449 / 566 | 8% | 483 | 0 ± 0 | 0.07-0.16, except one 28 m link feeding the second stop line of the cluster (0.84, a queue held at red) |
| Kasturi, before | 2,051 / 4,416 | 23% | 15,765 | 18 ± 2 | 0.10 |
| Kasturi, after | 549 / 1,660 | 8% | 518 | 0 ± 0 | 0.14 |

The internal links run mostly empty, refusals for lack of room fell by 4-5×, and the one internal link that is full is a stop-line approach queued at red, not a blocked exit. The blocking came from the discharge stalls (§4.2) and grants held at red, not from the link lengths. Treating a node cluster as one box is not needed for these junctions now; Panchratna (no median opening) is a different problem (§4.6).

### 4.6 Panchratna: no median opening in OSM: **open; candidate OSM edit, not applied**

Six counted movements (N-S, N-R, E-R, S-S, S-R, W-R; 3,059 veh/h) are unreachable in every run: in OSM the north arm ends on the eastbound carriageway and the south arm on the westbound one, with nothing joining them. Proposed for imagery check and owner approval in `docs/PROPOSED_OSM_EDITS.md`; not applied locally. The measured node also changed: at `4f5e11c` the busiest node was an unsignalised one (LOS C/B/C, 16 s), on the final code it is the signalised T on the westbound carriageway (LOS D/E/E, 62 s), so Panchratna's delay and LOS are not like-for-like across the two rows.

### 4.7 Kokane: arms about 45° off the compass: **not comparable; sensitivity only**

With stop-line counting Kokane's four arms lie at 44°, 118°, 232° and 323°; the worst arm is 53° from its compass direction, above the 50° the layout accepts (`MAX_CARDINAL_ERROR_DEG`), so the default run reports no comparison. The `4f5e11c` row used a side street as the "south" arm and left the north-east arm unlabelled, so it is not a valid comparison either. Sensitivity runs with the threshold raised to 65°:

- best-fit labels (44° = N): mean GEH 20.0 ± 2.7, 0.7 of 12 under 5, volume 21 ± 9%, gridlock removals 65 ± 10;
- labels rotated one step (323° = N): mean GEH 12.1 ± 2.0, 3.7 of 12, volume 49 ± 8%, gridlock removals 26 ± 13.

The labelling changes which movement each count is seeded on, so the two runs are different demands and the result depends entirely on a labelling the geometry cannot settle. The rotated labelling fits better, which is weak evidence for it, not proof; the survey's arm names need checking against the study's sketch or the site. Both runs gridlock on the ring (§5).

### 4.8 Sakharam Waghmare: ring in OSM vs four-arm junction in the study: **open**

OSM maps a roundabout; the study tabulates an unsignalised four-approach junction. The model follows OSM. On the final code the east approach, which carries the largest counts (E-L 460 veh/h), is starved (E-S 32-136 veh/h simulated vs 345 observed), while N and S now carry close to their counts. Entering from the east, vehicles give way to ring traffic from the north arm, whose flows are now near the counts; this is the roundabout entry-capacity effect, and it would not exist if the junction is not a roundabout on the ground. R² fell from 0.54 to 0.02 for that reason (§5).

### 4.9 Ring lanes halved by the one-way implication: **confirmed bug; fixed** (`deb3d11`)

An untagged `junction=roundabout` way imported as two-way was made one-way with one direction's share of its lanes, so Kokane's ring became 1 lane. One-way ring pieces now keep their whole carriageway (the OSM `lanes` tag, which on a one-way way counts its direction's lanes, else the importer's lane count; the importer gives an untagged `oneway=yes` way 2 lanes). `set_oneway` corrections keep it the same way (`NetworkCorrections.test.ts`).

### 4.10 Infosys `infosys-ring-1`: **kept**

Disabling the correction (`VAL_DISABLE=infosys-ring-1`) gives bit-identical results on all three seeds (every metric and every movement). The suspicion that it caused Infosys's gridlock (5 → 33 removals in the previous round) is rejected: on the final code Infosys has 0 removals with or without it, and the earlier rise came from the grant and discharge problems fixed since. The piece is 4.5 m long; that it changes nothing suggests no route in the study area uses it in either direction (inferred). It stays enabled because its evidence is about OSM's tags (a `junction=roundabout` piece tagged `oneway=no`, drawn against the ring's clockwise circulation), not about the fit, and it is still listed for imagery confirmation in `docs/PROPOSED_OSM_EDITS.md`.

### 4.11 Feedback order: **fit-first adopted; the order matters little once trips are pinned**

At `4f5e11c` congestion feedback was computed on the uncalibrated project demand before the fit, and Ganraj W-L and W-S ended unrouted. `9c9aa0d` fits on free-flow costs, runs MSA feedback on the fitted plan and refits, and pins each count-seeded trip to its counted approach and exit (only the legs before and after are chosen by cost). On the final code the feedback-first order gives Ganraj 18.1 vs 18.2 and Kasturi 8.8 vs 8.9 (both 0 unreachable), Infosys 7.4 vs 7.0 (6.3 vs 5.0 of 12 under GEH 5). The unrouted movements were fixed by pinning, not by the order; fit-first is kept as the principled order.

## 5. Regressions investigated

| Where | What | Cause found | Fixed? |
|---|---|---|---|
| Sakharam | R² 0.54 → 0.02, max GEH 16.6 → 20.2 (mean GEH and volume improved) | East approach starved by ring priority (§4.8); the counts' narrow range (228-460 veh/h) makes R² sensitive to one approach | No; depends on whether the junction is a roundabout |
| Panchratna | Delay 16 → 62 s, LOS C → E | Different node measured: the core is now the OSM-signalised T (§4.6) | Not a model regression |
| Kokane | Gridlock removals 15 ± 10 (`4f5e11c`) → 26-65 in the sensitivity runs; 17 ± 12 with zone-edge counting on the final code | Ring deadlocks at one ring node (7 deadlock events, longest stuck 183 s, seed 7, best-fit labels). Present before the ring-lane fix too (57 removals, seed 7), so it follows the stop-line seeding and pinned routes loading the ring, not the lane fix | No. Open: roundabout entry and ring deadlock handling (§8) |
| Kasturi | GEH<5 count 1.7 with zone-edge counting vs 0.3 with stop lines | Same demand definition change as §4.1; mean GEH 8.6 vs 8.9 | By design |
| Ganraj, Kasturi | Control delay 130 and 167 s, LOS F | Y > 1 (§4.4) | No |

## 6. Fixes made in this round

- `493bfbd` Queue discharge without stalls: pair crossing, keep-clear anticipation over the movement, blocked-lane test (§4.2).
- `e516fd3` Turning movements counted at the stop lines of the junction core (§4.1).
- `9c9aa0d` Count-seeded trips pinned to their counted movement; fit → feedback → refit; harness switches for the ablations (§4.11).
- `deb3d11` One-way ring pieces keep their whole carriageway (§4.9).
- `d1e986f` Calibrated demand labelled with the counts' peak (AM/PM) and relabelled when the user changes it (the demand card read "AM peak" after a PM calibration).
- `89911f3` Panchratna median-opening candidate in `docs/PROPOSED_OSM_EDITS.md` (awaiting owner approval; not applied).
- No parameter was changed to improve a fit; no per-junction adjustment.

## 7. Limitations and unverified items

- **Not calibrated.** No junction meets GEH < 5 for 85% of movements (§3).
- **Unverified, still used:** lost time L = 2n + R (secondary source only; IRC:93-1985 Appendix 3 uses amber plus 4 s per phase instead); fitness of HCM 2000 LOS thresholds (Exhibits 16-2, 17-2) for Indian mixed traffic (the thresholds themselves are verified as HCM 2000's; Indo-HCM 2017's LOS table was not checked); whether the counts are the AM or the PM peak (neither source says; the app lets the user choose, default PM 19:00); the weekend profile (weekday profile × TomTom weekend/weekday ratio, derived, not measured); IRC:106 PCU factors at junctions (the code's own scope is mid-block, clause 2.1).
- **Verified this round:** HCM 2000 Exhibit 16-7 turn factors (0.85 exclusive right-turn lane, 0.95 exclusive protected left-turn lane) and Exhibit 16-2 signalised LOS thresholds, from a copy of HCM 2000 ch. 16; IRC:106-1990 Table 1 values.
- **Kokane** is not comparable (§4.7); **Panchratna** lacks six movements (§4.6) and its location is inferred (east end of way 475607455); **Sakharam** may not be a roundabout (§4.8).
- **Kasturi** depends on local corrections (`kasturi-ne-1..4`, `kasturi-nw-1`) not yet confirmed on imagery; on raw OSM its north arm has no exit.
- **Kasturi's published table does not add up** (rows 6,200 veh/h, printed total 6,190); rows used as printed.
- Queues still grow at the end of the 900 s window at Ganraj and Kasturi (no steady state at the counted flows).
- Three seeds; spreads are population SD over three runs. Harness results do not stamp a commit; the commit for each set is inferred from file and run timestamps (§2).

## 8. Remaining work

1. Phasing at Ganraj and Kasturi: find the real phase plan (site or a published plan) before changing approach-wise Webster phasing; separately, a junction PCU source for two-wheelers.
2. Panchratna median opening: imagery check, owner approval, then local correction (`docs/PROPOSED_OSM_EDITS.md`).
3. Roundabouts: ring deadlocks at Kokane; entry capacity against Indo-HCM's roundabout method; two-wheelers' shorter accepted gaps.
4. Kokane arm naming: check the study's sketch or the site.
5. Sakharam: confirm on imagery or site whether it is a roundabout.
6. Re-run the before/after table after each.

## 9. Checks run on the final state

- Frontend `npx vitest run --config vitest.config.ts`: 41 committed test files, 38 passed and 3 skipped (opt-in harnesses); 331 tests, 328 passed, 3 skipped, 0 failed. (The working tree also holds two uncommitted `*.scratch.test.ts` files, giving 43 files / 333 tests / 329 passed / 4 skipped in the same run.)
- `tsc -b`: no errors. `oxlint`: 0 errors, 5 warnings (unused variables, pre-existing).
- Backend `pytest`: 50 passed.
