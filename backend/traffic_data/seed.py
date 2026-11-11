"""
Seed rows for the Traffic Data Manager. Idempotent and insert-only: an existing
row (by code, or by set_key + version 1) is never overwritten, so a user's edits
and later versions survive restarts.
"""

from __future__ import annotations

import json

from .models import PcuFactorSetEntity, VehicleClassEntity

VEHICLE_CLASSES = [
    ("two_wheeler", "Two-wheeler", "Motorcycle, scooter, moped", 10),
    ("car", "Car", "Passenger car, jeep, pick-up van", 20),
    ("auto_rickshaw", "Auto-rickshaw", "Three-wheeled passenger auto-rickshaw", 30),
    ("bus", "Bus", "Bus (city, private, school)", 40),
    ("lcv", "LCV", "Light commercial vehicle (goods tempo, mini-truck)", 50),
    ("hcv", "HCV", "Heavy commercial vehicle (truck, multi-axle)", 60),
    ("other", "Other", "Anything not above (state what in the dataset assumptions)", 90),
]

IRC106_CITATION = (
    "IRC:106-1990, Guidelines for Capacity of Urban Roads in Plain Areas, Indian Roads Congress, "
    "New Delhi, November 1990 (reprinted 2007, 2016), clause 7 and Table 1 'Recommended PCU factors "
    "for various types of vehicles on urban roads'. Scanned text opened 2026-11-11 at "
    "https://archive.org/stream/gov.in.irc.106.1990/irc.gov.in.106.1990_djvu.txt"
)
IRC106_URL = "https://archive.org/stream/gov.in.irc.106.1990/irc.gov.in.106.1990_djvu.txt"
IRC106_SCOPE = (
    "IRC:106 clause 2.1: applicable essentially to mid-block sections of urban roads (between junctions); "
    "not a stop-line / signalised-approach factor. 'Bus' and 'HCV' both take the code's 'Truck or Bus' row. "
    "The code gives no factor for 'other': conversion of counts with 'other' vehicles is refused until a "
    "factor is added in a new version with its source."
)

# Table 1 as printed: (5% composition, 10% and above)
IRC106_TABLE1 = {
    "two_wheeler": (0.5, 0.75),
    "car": (1.0, 1.0),
    "auto_rickshaw": (1.2, 2.0),
    "lcv": (1.4, 2.0),
    "bus": (2.2, 3.7),
    "hcv": (2.2, 3.7),
}

PCU_SETS = [
    {
        "set_key": "irc106-1990-t1-5pct",
        "name": "IRC:106-1990 Table 1, 5% composition column",
        "factors": {k: v[0] for k, v in IRC106_TABLE1.items()},
        "assumptions": IRC106_SCOPE + " Uses the column for a class making up 5% of the stream for every class.",
    },
    {
        "set_key": "irc106-1990-t1-10pct",
        "name": "IRC:106-1990 Table 1, 10%-and-above composition column",
        "factors": {k: v[1] for k, v in IRC106_TABLE1.items()},
        "assumptions": IRC106_SCOPE + " Uses the column for a class making up 10% or more of the stream for every class.",
    },
    {
        "set_key": "irc106-1990-t1-app-mix",
        "name": "IRC:106-1990 Table 1, column per class by the app's default mix",
        "factors": {"two_wheeler": 0.75, "car": 1.0, "auto_rickshaw": 2.0, "bus": 2.2, "hcv": 2.2, "lcv": 1.4},
        "assumptions": IRC106_SCOPE + (
            " Column chosen per class from the composition the simulator assumes (frontend TrafficMicroSim.ts "
            "VEHICLE_TYPES: two-wheeler 52%, car 31%, auto 11% -> 10%+ column; bus 3.5%, truck 2.1% -> 5% column). "
            "LCV share is unknown and assumed below 10% (5% column, 1.4). IRC gives two columns only; shares "
            "between 5% and 10% are not interpolated. The mix itself is an estimate, not a count."
        ),
    },
]


def seed_traffic_data(session) -> None:
    for code, label, desc, order in VEHICLE_CLASSES:
        if session.get(VehicleClassEntity, code) is None:
            session.add(VehicleClassEntity(code=code, label=label, description=desc, sort_order=order, builtin=True, created_by="system"))
    for s in PCU_SETS:
        exists = session.query(PcuFactorSetEntity).filter_by(set_key=s["set_key"], version=1).first()
        if exists is None:
            session.add(PcuFactorSetEntity(
                set_key=s["set_key"], version=1, name=s["name"], context="midblock",
                source_citation=IRC106_CITATION, source_url=IRC106_URL, assumptions=s["assumptions"],
                factors_json=json.dumps(s["factors"], sort_keys=True), change_note="seeded from the printed table",
                builtin=True, created_by="system",
            ))
    session.commit()
