# Pune hour-of-day traffic profile (v1)

`pune_hourly_profile_v1.json` gives the share of daily motor-vehicle traffic in each hour, weekday and weekend,
with a Peak / Moderate / Low label and, for every hour, whether it was **measured** or **filled** and from what.

| Hours (weekday) | Basis |
|---|---|
| 08-19 | Measured: Gunjan Chowk, Pune, hourly classified counts (IJETT 47(2), 2017); 09-11 averaged with the Mendeley Pune CCTV counts (Alankar/Jehangir/RTO Chowk, Jan 2023) |
| 20-07 | Filled: TomTom Traffic Index 2025 Pune hourly congestion, inverted to volume, anchored at 19:00 / 08:00; exponent fixed so the peak-hour share equals the Pune CMP 2018 cordon average (7.8%) |
| 02-04 | Interpolated: TomTom shows no congestion signal (within 3% of the night minimum) |
| Weekend, all hours | Derived: weekday profile × weekend/weekday TomTom congestion ratio |

The Mendeley dataset (doi:10.17632/xnf2k6n288.1) was downloaded and parsed in full (`backend/observed/diurnal/parse_mendeley_pune.py`);
every camera recorded only about 09:00-12:00 each day, so it covers 3 hours. `mendeley_pune_2023_hourly.json` holds the
per-camera, per-day, per-hour aggregates (sha256 of the source zip recorded inside).

Rebuild: `cd backend/observed/diurnal && python build_profile.py --mendeley-records <records.json> --out ../../data/diurnal/pune_hourly_profile_v1.json`
(records = the `records` list of `mendeley_pune_2023_hourly.json`). Full method and citations are inside the JSON.
