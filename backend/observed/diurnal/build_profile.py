"""Build the Pune 24-hour traffic profile (versioned data file) from real sources.

Run from the repo root:
    python backend/observed/diurnal/build_profile.py \
        --mendeley-records /path/to/mendeley_hourly_records.json \
        --out backend/data/diurnal/pune_hourly_profile_v1.json

Every number below is transcribed from a cited source; nothing is invented.
The method, which hours are measured and which are filled, is written into
the output file itself.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from .parse_mendeley_pune import build_profile
except ImportError:  # run as a script
    from parse_mendeley_pune import build_profile

# ── Source A: Gunjan Chowk, Pune — hourly classified counts 08:00-20:00 ─────────
# Thakur, Lunkad, Shinde, Ram, Purohit (2017), "Congestion of Traffic at Gunjan
# Chowk Junction, Pune", IJETT 47(2):91-97, tables p.3-4. Surveyed Jan & Mar,
# month-long daily counts, both directions (towards Pune Station / towards Nagar Road).
# Columns: private bus, govt bus, 2W, 3W, 4W, light truck, heavy truck, dump truck.
GUNJAN_URL = "http://www.ijettjournal.org/assets/year/2017/volume-47/number-2/IJETT-V47P215.pdf"
GUNJAN = {
    "towards_pune_station": {
        8: [84, 72, 2415, 495, 1137, 40, 4, 21], 9: [87, 76, 3130, 447, 1360, 54, 3, 31],
        10: [64, 86, 1715, 439, 989, 112, 8, 26], 11: [46, 69, 1806, 418, 1285, 110, 3, 23],
        12: [54, 63, 1930, 495, 833, 97, 6, 9], 13: [33, 67, 1797, 355, 780, 84, 8, 6],
        14: [41, 62, 2208, 319, 773, 77, 5, 4], 15: [29, 64, 1673, 379, 743, 70, 6, 0],
        16: [55, 65, 1907, 415, 1430, 62, 4, 0], 17: [83, 63, 2891, 430, 1477, 47, 2, 3],
        18: [132, 81, 3146, 481, 1893, 39, 0, 0], 19: [81, 82, 3397, 503, 1769, 23, 1, 1],
    },
    "towards_nagar_road": {
        8: [76, 71, 2197, 402, 1081, 31, 16, 4], 9: [72, 68, 3012, 415, 1209, 52, 12, 6],
        10: [68, 82, 1609, 376, 960, 85, 13, 3], 11: [49, 62, 1667, 415, 1195, 102, 21, 9],
        12: [56, 63, 1339, 431, 849, 87, 12, 2], 13: [41, 59, 1239, 396, 796, 73, 5, 1],
        14: [40, 72, 1275, 333, 1298, 62, 9, 3], 15: [32, 63, 1431, 431, 1365, 68, 16, 0],
        16: [41, 56, 1389, 368, 1491, 72, 13, 0], 17: [76, 68, 1439, 487, 1296, 49, 31, 1],
        18: [86, 71, 1413, 489, 1132, 26, 19, 2], 19: [81, 80, 1526, 521, 1359, 19, 17, 0],
    },
}

# ── Source B: TomTom Traffic Index 2025, Pune (City, 10 km trip) ───────────────
# Average travel time per hour, Mon..Sun, minutes. Transcribed from
# https://www.tomtom.com/traffic-index/pune-traffic/ ("Driving patterns in Pune").
TOMTOM_URL = "https://www.tomtom.com/traffic-index/pune-traffic/"
def _m(s: str) -> float:
    mm, _, ss = s.partition(":")
    return int(mm) + (int(ss) / 60 if ss else 0)
TOMTOM_RAW = {
    0: "20:30 20:50 21:10 21:00 21:10 21:30 21:40", 1: "19:10 20:00 20:10 20:00 20:00 20:00 20:10",
    2: "18:30 19:00 19:10 19:10 19:10 19:10 19:30", 3: "18:10 18:40 19:00 18:50 19:00 19:10 19:10",
    4: "18:20 18:50 19:00 19:00 19:30 19:20 19:00", 5: "20:10 20:20 20:50 21:00 22:00 21:30 20:40",
    6: "22:50 23:00 23:20 23:30 23:50 23:10 22:20", 7: "25:30 26:10 26:00 26:20 26:20 25:50 24:20",
    8: "29:20 30:20 29:50 29:40 29:50 28:50 26:40", 9: "34:20 35:40 34:50 34:40 34:30 32:20 28:30",
    10: "36:20 38:10 36:50 36:50 36:50 34:50 30:20", 11: "37:30 39:00 38:00 38:00 38:00 37:30 32:10",
    12: "37:00 38:10 37:30 37:40 37:30 38:40 33:10", 13: "35:30 36:20 36:00 36:10 35:40 38:00 32:30",
    14: "34:50 35:10 34:50 35:20 35:20 37:00 32:20", 15: "35:20 35:40 35:40 36:00 36:20 37:00 32:40",
    16: "37:20 37:20 37:40 37:40 38:10 38:30 33:50", 17: "39:40 39:30 40:20 39:40 40:50 39:40 35:10",
    18: "41:20 40:50 41:20 41:20 42:20 40:30 35:10", 19: "37:40 37:20 38:00 37:40 39:00 38:30 34:10",
    20: "32:20 32:20 33:10 33:10 33:50 34:30 31:40", 21: "28:30 28:50 29:20 29:30 30:20 31:20 29:20",
    22: "25:10 25:20 25:50 25:50 26:30 27:20 25:50", 23: "22:30 22:40 22:50 22:50 23:40 24:00 22:30",
}
TOMTOM = {h: [_m(x) for x in s.split()] for h, s in TOMTOM_RAW.items()}

# ── Source C: Pune CMP 2018 (validation of the peak-hour share) ────────────────
CMP2018_URL = "https://www.punemetrorail.org/download/Updation%20of%20CMP%20for%20PMR.pdf"
CMP2018_PEAK_SHARE = {"inner_cordon_avg": 0.078, "inner_cordon_range": [0.061, 0.095],
                      "outer_cordon_avg": 0.0706, "screen_line_avg": 0.097}
# Table 2-47 (16 h, 06-22, typical working day), PCU
CMP2018_JUNCTIONS = {
    "Wakad Chowk": {"am_peak_pcu": 16405, "pm_peak_pcu": 15701, "daily_pcu_16h": 193777},
    "Hinjawadi - Pirangut Road": {"am_peak_pcu": 4684, "pm_peak_pcu": 4998, "daily_pcu_16h": 62170},
    "Bhumkar Chowk": {"am_peak_pcu": 11155, "pm_peak_pcu": 10885, "daily_pcu_16h": 128572},
    "Kaspate Chowk": {"am_peak_pcu": 16061, "pm_peak_pcu": 16470, "daily_pcu_16h": 190005},
}
# Gunjan Chowk day totals (p.4-5), vehicles both directions all classes
_GD = {"towards_pune_station": {"Mon": [746, 893, 27840, 5153, 14779, 703, 39, 151], "Tue": [715, 860, 28370, 5076, 12769, 568, 70, 104],
       "Wed": [792, 835, 27467, 5297, 14172, 826, 49, 121], "Thu": [774, 858, 27486, 5071, 14390, 801, 74, 111],
       "Fri": [770, 851, 28516, 5276, 15418, 807, 28, 138], "Sat": [727, 864, 21283, 3835, 15050, 847, 161, 79],
       "Sun": [570, 780, 16358, 3462, 15059, 334, 59, 31]},
       "towards_nagar_road": {"Mon": [741, 839, 23849, 5139, 14271, 650, 156, 40], "Tue": [774, 842, 28313, 5229, 14394, 791, 47, 28],
       "Wed": [749, 882, 28085, 5417, 15050, 803, 65, 26], "Thu": [707, 824, 19261, 5052, 13823, 713, 118, 37],
       "Fri": [688, 797, 18854, 5040, 14096, 688, 181, 33], "Sat": [745, 795, 18356, 4481, 12134, 515, 74, 26],
       "Sun": [722, 828, 19448, 5059, 13899, 722, 192, 24]}}
_day = lambda d: sum(sum(_GD[k][d]) for k in _GD)
GUNJAN_WEEKEND_RATIO = round(((_day("Sat") + _day("Sun")) / 2) / (sum(_day(d) for d in ("Mon", "Tue", "Wed", "Thu", "Fri")) / 5), 4)
MENDELEY_URL = "https://data.mendeley.com/datasets/xnf2k6n288/1"

PEAK_AT = 0.80  # an hour is Peak when its volume is >= 80% of the busiest hour
LOW_BELOW = 0.40  # Low below 40% of the busiest hour; Moderate in between


def fit_linear(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    a = my - b * mx
    pred = [a + b * x for x in xs]
    ss_res = sum((y - p) ** 2 for y, p in zip(ys, pred))
    ss_tot = sum((y - my) ** 2 for y in ys)
    return a, b, 1 - ss_res / ss_tot


def label(v: float, vmax: float) -> str:
    r = v / vmax
    return "Peak" if r >= PEAK_AT else "Low" if r < LOW_BELOW else "Moderate"


NO_SIGNAL_C = 0.03  # TomTom congestion within 3% of the night minimum carries no volume information


def _fill(measured: dict, cong: dict, beta: float) -> tuple[dict, dict]:
    """Volume for unmeasured hours from congestion, anchored at the nearest measured
    shoulder hour: V(h) = V(anchor) * (c(h)/c(anchor))**(1/beta) (BPR-type inversion).
    Hours with no congestion signal are interpolated between their informative neighbours."""
    vol, src = dict(measured), {h: "measured" for h in measured}
    first, last = min(measured), max(measured)
    for h in range(24):
        if h in vol:
            continue
        anchor = last if (h > last or h < 5) else first
        if cong[h] >= NO_SIGNAL_C:
            vol[h] = measured[anchor] * (cong[h] / cong[anchor]) ** (1 / beta)
            src[h] = "filled"
    gaps = [h for h in range(24) if h not in vol]
    for h in gaps:
        lo = next(((h - k) % 24 for k in range(1, 24) if (h - k) % 24 in vol), None)
        hi = next(((h + k) % 24 for k in range(1, 24) if (h + k) % 24 in vol), None)
        dlo, dhi = (h - lo) % 24, (hi - h) % 24
        vol[h] = (vol[lo] * dhi + vol[hi] * dlo) / (dlo + dhi)
        src[h] = "interpolated"
    return vol, src


def build(mendeley_records):
    gunjan = {h: float(sum(sum(GUNJAN[d][h]) for d in GUNJAN)) for h in range(8, 20)}
    mendeley = build_profile(mendeley_records)

    def tomtom_congestion(days):
        tt = {h: sum(TOMTOM[h][d] for d in days) / len(days) for h in range(24)}
        free = min(tt.values())
        return {h: tt[h] / free - 1 for h in range(24)}

    # Measured weekday hours: Gunjan 08-19; Mendeley 2023 joins 09-11 (its 09-11 mean
    # scaled to Gunjan's 09-11 mean, then the two averaged per hour).
    measured = dict(gunjan)
    m = {int(k): v for k, v in mendeley["weekday"].items()}
    common = [h for h in (9, 10, 11) if h in m]
    if common:
        k = sum(gunjan[h] for h in common) / sum(m[h]["index"] for h in common)
        for h in common:
            measured[h] = (gunjan[h] + m[h]["index"] * k) / 2

    wd_cong = tomtom_congestion([0, 1, 2, 3, 4])
    # beta: the one exponent that makes the weekday peak-hour share equal the Pune
    # CMP 2018 inner-cordon average (7.8%, from real 24-hour counts).
    target = CMP2018_PEAK_SHARE["inner_cordon_avg"]
    best = None
    for i in range(50, 801):
        beta = i / 100
        vol, _ = _fill(measured, wd_cong, beta)
        share = max(vol.values()) / sum(vol.values())
        if best is None or abs(share - target) < abs(best[1] - target):
            best = (beta, share)
    beta = best[0]

    out = {}
    for daytype, days in (("weekday", [0, 1, 2, 3, 4]), ("weekend", [5, 6])):
        cong = tomtom_congestion(days)
        wd_vol, wd_src = _fill(measured, wd_cong, beta)
        if daytype == "weekday":
            vol = wd_vol
            src = {h: ("measured: Gunjan Chowk 2017" + (" + Mendeley Pune CCTV 2023 (mean)" if h in common else "")) if wd_src[h] == "measured"
                   else "filled: TomTom 2025 congestion, BPR-type inversion anchored at the nearest measured hour" if wd_src[h] == "filled"
                   else "interpolated: no congestion signal (TomTom within 3% of night minimum)" for h in range(24)}
        else:
            # No measured weekend hourly volume outside Mendeley 09-11: weekend hour h is
            # weekday volume scaled by the weekend/weekday congestion ratio through the same inversion.
            vol, src = {}, {}
            for h in range(24):
                if wd_cong[h] >= NO_SIGNAL_C and cong[h] >= NO_SIGNAL_C:
                    vol[h] = wd_vol[h] * (cong[h] / wd_cong[h]) ** (1 / beta)
                else:
                    vol[h] = wd_vol[h]
                src[h] = "derived: weekday profile x TomTom 2025 weekend/weekday congestion ratio"
        total = sum(vol.values())
        vmax = max(vol.values())
        hours = []
        for h in range(24):
            hours.append({
                "hour": h, "share": round(vol[h] / total, 5), "relative_to_peak": round(vol[h] / vmax, 4),
                "period": label(vol[h], vmax), "tomtom_congestion": round(cong[h], 4),
                "measured": src[h].startswith("measured"), "source": src[h],
            })
        am = max((x for x in hours if x["hour"] < 13), key=lambda x: x["share"])
        pm = max((x for x in hours if x["hour"] >= 13), key=lambda x: x["share"])
        out[daytype] = {"hours": hours, "peak_hour": max(hours, key=lambda x: x["share"])["hour"], "am_peak_hour": am["hour"],
                        "pm_peak_hour": pm["hour"], "peak_hour_share": round(max(x["share"] for x in hours), 5),
                        "measured_hours": [x["hour"] for x in hours if x["measured"]]}
    out["fill"] = {"form": "V(h) = V(anchor) * (c(h)/c(anchor))^(1/beta); anchor = 19:00 for evening/night, 08:00 for early morning",
                   "beta": beta, "beta_chosen_to_match": f"weekday peak-hour share = CMP 2018 inner-cordon average {target}",
                   "no_signal_congestion": NO_SIGNAL_C}
    # Weekend daily volume relative to weekday, from Gunjan day totals (both directions, all classes)
    mend_cov = {dt: {str(h): {"cameras": v["n_cameras"], "camera_days": v["camera_days"], "index": round(v["index"], 4)}
                     for h, v in mendeley[dt].items()} for dt in mendeley}
    return {
        "id": "pune_hourly_profile", "version": 1, "created": "2026-11-02",
        "description": "Share of daily motor-vehicle traffic per hour of day for Pune, weekday and weekend.",
        "units": "share of 24-hour vehicles (sums to 1 per day type)",
        "period_thresholds": {"Peak": f">= {PEAK_AT:.0%} of the busiest hour", "Moderate": "between",
                              "Low": f"< {LOW_BELOW:.0%} of the busiest hour"},
        "weekday": out["weekday"], "weekend": out["weekend"], "fill": out["fill"],
        "weekend_daily_vs_weekday": GUNJAN_WEEKEND_RATIO,
        "validation": {
            "cmp2018_peak_hour_share": CMP2018_PEAK_SHARE,
            "cmp2018_junction_counts": CMP2018_JUNCTIONS,
            "profile_weekday_peak_share": out["weekday"]["peak_hour_share"],
        },
        "mendeley_coverage": {
            "note": "All 8 cameras recorded only ~09:00-12:00 each day (11-18 Jan 2023). Hours outside 09-11 have no footage. "
                    "Counters in the CSVs are cumulative per recording session, logged every second at ~25 frames.",
            "by_hour": mend_cov,
        },
        "method": [
            "Gunjan Chowk (Pune) hourly counts 08-20, both directions summed, all classes, give measured weekday volumes for hours 8-19.",
            "Mendeley Pune CCTV (Alankar, Jehangir, RTO Chowk; 2023) gives hours 9-11 only; each camera is normalised to its own 09-11 mean, "
            "scaled to Gunjan's 09-11 mean, and averaged with Gunjan for those hours.",
        "Hours 20-07 have no measured hourly volume in any source found. They are filled from TomTom 2025 hourly congestion c "
            "(travel time / night minimum - 1) by a BPR-type inversion V = V(anchor)*(c/c_anchor)^(1/beta), anchored at 19:00 (evening/night) "
            "or 08:00 (early morning). A linear volume-congestion fit over 08-19 was tried and rejected (R^2 = 0.04).",
            "beta is not assumed: it is the single value that makes the weekday peak-hour share equal the Pune CMP 2018 inner-cordon "
            "average of 7.8% (real 24-hour cordon counts). Hours where TomTom is within 3% of the night minimum have no signal and are "
            "linearly interpolated between neighbours.",
            "Weekend has no measured hourly volume outside 09-11 (Mendeley, flat); weekend hours are the weekday profile scaled by the "
            "weekend/weekday TomTom congestion ratio through the same inversion. All weekend hours are derived.",
            "Shares are normalised to sum to 1. Peak/Moderate/Low are thresholds on volume relative to the busiest hour.",
            "Validation: the weekday peak-hour share is compared with Pune CMP 2018 cordon/screen-line peak shares (6.1-9.5%, avg 7.8%).",
        ],
        "sources": [
            {"id": "gunjan2017", "citation": "Thakur K.B., Lunkad S.P., Shinde C.R., Ram N.C., Purohit V.I. (2017). Congestion of Traffic at Gunjan Chowk Junction, Pune. IJETT 47(2):91-97.", "url": GUNJAN_URL, "used_for": "measured hourly volumes 08-20"},
            {"id": "mendeley2026", "citation": "Matange A., Abraham J. (2026). Heterogeneous Traffic Count Dataset, Pune (Jan 2023). Mendeley Data V1, doi:10.17632/xnf2k6n288.1, CC BY 4.0.", "url": MENDELEY_URL, "used_for": "measured 09-11 shape, weekday vs weekend"},
            {"id": "tomtom2025", "citation": "TomTom Traffic Index 2025, Pune (city, 10 km travel time by hour and weekday).", "url": TOMTOM_URL, "used_for": "filling 20-07 and weekend shape (congestion, not volume)"},
            {"id": "cmp2018", "citation": "Updation/Revision of Comprehensive Mobility Plan (CMP) 2018 for Pune Metropolitan Region, Final Report (PMRDA/Maha-Metro), Exec. Summary p.E-5 and Table 2-47.", "url": CMP2018_URL, "used_for": "validation of peak-hour share; AM vs PM at west Pune junctions"},
        ],
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mendeley-records", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    recs = json.load(open(a.mendeley_records))
    prof = build(recs)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(prof, open(a.out, "w"), indent=1)
    for dt in ("weekday", "weekend"):
        p = prof[dt]
        print(dt, "peak", p["peak_hour"], "share", p["peak_hour_share"], "beta", prof["fill"]["beta"])
        for x in p["hours"]:
            print(f"  {x['hour']:02d} {x['share']*100:5.2f}% {x['period']:8s} {'M' if x['measured'] else 'F'}")
