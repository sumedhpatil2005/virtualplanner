# Proposed OpenStreetMap edits (for review, NOT submitted)

> **Nothing in this file has been submitted to OpenStreetMap, and nothing may be submitted without the project owner's explicit approval.** Each edit below was derived from the local correction layer `backend/data/network_corrections/pune_west_v1.json`, which TwinCity applies on top of the imported OSM roads at simulation time. OSM itself has not been touched. Before any edit is made, a mapper should check it against current street-level imagery (and preferably a site visit), follow the OSM changeset etiquette (one changeset per junction, a clear comment, the source tag), and reference this document.

Generated from correction layer `pune_west_v1` v1.0.0 (24 corrections). OSM snapshot: backend/data/osm/osm_index.db built from western-zone-latest.osm.pbf (OSM data timestamp 2026-11-01 21:21 UTC).

Confidence follows the layer: *high* = OSM contradicted by the survey turning counts **and** an independent geometric check (left-hand-traffic side rule via `backend/observed/oneway_audit.py`); *medium* = contradicted by the survey or study description, but the exact tagging needs imagery.

## Summary

| # | Correction id | Junction | OSM way | Action | Confidence | Proposed OSM edit |
|---|---|---|---|---|---|---|
| 1 | `kasturi-ne-1` | kasturi_chowk | [614201109](https://www.openstreetmap.org/way/614201109) | reverse  | high | Reverse the direction of way 614201109 (Dange Chowk Road, north-west carriageway), keeping oneway=yes. |
| 2 | `kasturi-ne-2` | kasturi_chowk | [1551258977](https://www.openstreetmap.org/way/1551258977) | reverse  | high | Reverse way 1551258977 (Dange Chowk Road), keeping oneway=yes. |
| 3 | `kasturi-ne-3` | kasturi_chowk | [1533733546](https://www.openstreetmap.org/way/1533733546) | set_two_way {"lanes_forward": 2, "lanes_backward": 2} | medium | Set oneway=no, lanes=4, lanes:forward=2, lanes:backward=2 on way 1533733546 (or split it into two oneway carriageways if imagery shows a median). |
| 4 | `kasturi-ne-4` | kasturi_chowk | [1533733544](https://www.openstreetmap.org/way/1533733544) | reverse  | high | Reverse way 1533733544, keeping oneway=yes. |
| 5 | `kasturi-nw-1` | kasturi_chowk | [1209324408](https://www.openstreetmap.org/way/1209324408) | reverse  | high | Reverse way 1209324408 (north-east carriageway of the arm), keeping oneway=yes. |
| 6 | `infosys-n-1` | infosys_circle_phase_1 | [60975032](https://www.openstreetmap.org/way/60975032) | reverse  | high | Reverse way 60975032 (Rajiv Gandhi MIDC Road, east carriageway), keeping oneway=yes. |
| 7 | `infosys-e-1` | infosys_circle_phase_1 | [568110941](https://www.openstreetmap.org/way/568110941) | reverse  | high | Reverse way 568110941 (Hinjawadi Phase 1 Road, north carriageway), keeping oneway=yes. |
| 8 | `infosys-ring-1` | infosys_circle_phase_1 | [761395844](https://www.openstreetmap.org/way/761395844) | set_oneway {"reverse": true} | medium | Remove oneway=no from way 761395844 and reverse it so it runs clockwise with the rest of the ring. |
| 9 | `sakharam-lanes-253976061` | sakharam_waghmare_chowk | [253976061](https://www.openstreetmap.org/way/253976061) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 253976061 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 10 | `sakharam-lanes-1174487504` | sakharam_waghmare_chowk | [1174487504](https://www.openstreetmap.org/way/1174487504) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1174487504 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 11 | `sakharam-lanes-1174487507` | sakharam_waghmare_chowk | [1174487507](https://www.openstreetmap.org/way/1174487507) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1174487507 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 12 | `sakharam-lanes-1219666726` | sakharam_waghmare_chowk | [1219666726](https://www.openstreetmap.org/way/1219666726) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1219666726 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 13 | `sakharam-lanes-1219666727` | sakharam_waghmare_chowk | [1219666727](https://www.openstreetmap.org/way/1219666727) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1219666727 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 14 | `sakharam-lanes-1523458525` | sakharam_waghmare_chowk | [1523458525](https://www.openstreetmap.org/way/1523458525) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1523458525 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 15 | `sakharam-lanes-1523458523` | sakharam_waghmare_chowk | [1523458523](https://www.openstreetmap.org/way/1523458523) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1523458523 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 16 | `sakharam-lanes-1523458524` | sakharam_waghmare_chowk | [1523458524](https://www.openstreetmap.org/way/1523458524) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1523458524 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 17 | `sakharam-lanes-1523458522` | sakharam_waghmare_chowk | [1523458522](https://www.openstreetmap.org/way/1523458522) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1523458522 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 18 | `sakharam-lanes-1356392030` | sakharam_waghmare_chowk | [1356392030](https://www.openstreetmap.org/way/1356392030) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1356392030 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 19 | `sakharam-lanes-1563742487` | sakharam_waghmare_chowk | [1563742487](https://www.openstreetmap.org/way/1563742487) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1563742487 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 20 | `sakharam-lanes-1563742488` | sakharam_waghmare_chowk | [1563742488](https://www.openstreetmap.org/way/1563742488) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1563742488 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 21 | `sakharam-lanes-1563742489` | sakharam_waghmare_chowk | [1563742489](https://www.openstreetmap.org/way/1563742489) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1563742489 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 22 | `sakharam-lanes-1563742490` | sakharam_waghmare_chowk | [1563742490](https://www.openstreetmap.org/way/1563742490) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1563742490 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 23 | `sakharam-lanes-1534819002` | sakharam_waghmare_chowk | [1534819002](https://www.openstreetmap.org/way/1534819002) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1534819002 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |
| 24 | `sakharam-lanes-1534819004` | sakharam_waghmare_chowk | [1534819004](https://www.openstreetmap.org/way/1534819004) | set_lanes {"lanes": 2} | medium | Set lanes=2 on way 1534819004 (Shankar Kalate Nagar Road), after checking the lane count on imagery. |

## Evidence per edit

### `kasturi-ne-1`: way 614201109 (kasturi_chowk)

- **Proposed edit:** Reverse the direction of way 614201109 (Dange Chowk Road, north-west carriageway), keeping oneway=yes.
- **Local correction applied in TwinCity:** `reverse`  (enabled: true)
- **Confidence:** high
- **Evidence:**
  - OSM: both carriageways of Dange Chowk Road north-east of the junction (ways 614201109 and 614201110, 16 m apart, lanes=2 each) are oneway=yes towards Kasturi Chowk, so the arm has no way out.
  - Left-hand-traffic side rule (Motor Vehicles Act / Rules of the Road Regulations 1989, keep left): on a dual carriageway each carriageway has its opposite carriageway on its RIGHT. Measured with backend/observed/oneway_audit.py: the partner carriageway lies on this way's LEFT, so this way is drawn against its real direction; its partner passes the same test the right way round. Partner: way 614201110.
  - Survey turning counts (pune_west_2026.json, kasturi_chowk; NICMAR Table 3) carry traffic both into and out of this arm: approach N 1414 veh/h in, 1403 veh/h out (E right + S straight + W left); approach E 1904 veh/h in, 1611 veh/h out.
- **Status:** awaiting owner approval; not submitted.

### `kasturi-ne-2`: way 1551258977 (kasturi_chowk)

- **Proposed edit:** Reverse way 1551258977 (Dange Chowk Road), keeping oneway=yes.
- **Local correction applied in TwinCity:** `reverse`  (enabled: true)
- **Confidence:** high
- **Evidence:**
  - Continuation of way 614201109 on the same (north-west) carriageway between 357 m and 229 m from the junction; same oneway error.
  - Survey turning counts (pune_west_2026.json, kasturi_chowk; NICMAR Table 3) carry traffic both into and out of this arm: approach N 1414 veh/h in, 1403 veh/h out (E right + S straight + W left); approach E 1904 veh/h in, 1611 veh/h out.
- **Status:** awaiting owner approval; not submitted.

### `kasturi-ne-3`: way 1533733546 (kasturi_chowk)

- **Proposed edit:** Set oneway=no, lanes=4, lanes:forward=2, lanes:backward=2 on way 1533733546 (or split it into two oneway carriageways if imagery shows a median).
- **Local correction applied in TwinCity:** `set_two_way` {"lanes_forward": 2, "lanes_backward": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Way 1533733546 (229 m to 143 m from the junction) is tagged oneway=yes, lanes=4: the two lanes=2 carriageways 614201110 and 1551258977 both join into it, so its 4 lanes are the 2 + 2 of the two directions drawn as one way.
  - Survey turning counts (pune_west_2026.json, kasturi_chowk; NICMAR Table 3) carry traffic both into and out of this arm: approach N 1414 veh/h in, 1403 veh/h out (E right + S straight + W left); approach E 1904 veh/h in, 1611 veh/h out.
- **Status:** awaiting owner approval; not submitted.

### `kasturi-ne-4`: way 1533733544 (kasturi_chowk)

- **Proposed edit:** Reverse way 1533733544, keeping oneway=yes.
- **Local correction applied in TwinCity:** `reverse`  (enabled: true)
- **Confidence:** high
- **Evidence:**
  - Way 1533733544 (Dange Chowk Road, the branch from 143 m north-east to the junction's north corner) and way 1533733545 (to the east corner) are both oneway=yes towards the junction.
  - Left-hand-traffic side rule (Motor Vehicles Act / Rules of the Road Regulations 1989, keep left): on a dual carriageway each carriageway has its opposite carriageway on its RIGHT. Measured with backend/observed/oneway_audit.py: the partner carriageway lies on this way's LEFT, so this way is drawn against its real direction; its partner passes the same test the right way round. Partner: way 1533733545.
  - Survey turning counts (pune_west_2026.json, kasturi_chowk; NICMAR Table 3) carry traffic both into and out of this arm: approach N 1414 veh/h in, 1403 veh/h out (E right + S straight + W left); approach E 1904 veh/h in, 1611 veh/h out.
- **Status:** awaiting owner approval; not submitted.

### `kasturi-nw-1`: way 1209324408 (kasturi_chowk)

- **Proposed edit:** Reverse way 1209324408 (north-east carriageway of the arm), keeping oneway=yes.
- **Local correction applied in TwinCity:** `reverse`  (enabled: true)
- **Confidence:** high
- **Evidence:**
  - OSM: both carriageways of the north-west arm (ways 838579438 and 1209324408, unnamed highway=secondary towards Laxmi Chowk) are oneway=yes away from the junction, so the arm has no way in.
  - Left-hand-traffic side rule (Motor Vehicles Act / Rules of the Road Regulations 1989, keep left): on a dual carriageway each carriageway has its opposite carriageway on its RIGHT. Measured with backend/observed/oneway_audit.py: the partner carriageway lies on this way's LEFT, so this way is drawn against its real direction; its partner passes the same test the right way round. Partner: way 838579438.
  - Survey turning counts (pune_west_2026.json, kasturi_chowk; NICMAR Table 3) carry traffic both into and out of this arm: approach N 1414 veh/h in, 1403 veh/h out (E right + S straight + W left); approach E 1904 veh/h in, 1611 veh/h out.
- **Status:** awaiting owner approval; not submitted.

### `infosys-n-1`: way 60975032 (infosys_circle_phase_1)

- **Proposed edit:** Reverse way 60975032 (Rajiv Gandhi MIDC Road, east carriageway), keeping oneway=yes.
- **Local correction applied in TwinCity:** `reverse`  (enabled: true)
- **Confidence:** high
- **Evidence:**
  - OSM: both carriageways of Rajiv Gandhi MIDC Road north of the roundabout (ways 60976073 and 60975032, 7.5 m apart, ~895 m long) are oneway=yes away from it, so the north arm has no way in.
  - Left-hand-traffic side rule (Motor Vehicles Act / Rules of the Road Regulations 1989, keep left): on a dual carriageway each carriageway has its opposite carriageway on its RIGHT. Measured with backend/observed/oneway_audit.py: the partner carriageway lies on this way's LEFT, so this way is drawn against its real direction; its partner passes the same test the right way round. Partner: way 60976073.
  - Survey turning counts (pune_west_2026.json, infosys_circle_phase_1; NICMAR Table 6) carry traffic both into and out of this arm: approach N 902 veh/h in; approach E 1208 veh/h in; every approach has right, straight and left flows, so every arm also has exiting traffic.
- **Status:** awaiting owner approval; not submitted.

### `infosys-e-1`: way 568110941 (infosys_circle_phase_1)

- **Proposed edit:** Reverse way 568110941 (Hinjawadi Phase 1 Road, north carriageway), keeping oneway=yes.
- **Local correction applied in TwinCity:** `reverse`  (enabled: true)
- **Confidence:** high
- **Evidence:**
  - OSM: both carriageways of Hinjawadi Phase 1 Road north-east of the roundabout (way 568110941, and ways 239840575 + 60975324) are oneway=yes towards it, so the east arm has no way out.
  - Left-hand-traffic side rule (Motor Vehicles Act / Rules of the Road Regulations 1989, keep left): on a dual carriageway each carriageway has its opposite carriageway on its RIGHT. Measured with backend/observed/oneway_audit.py: the partner carriageway lies on this way's LEFT, so this way is drawn against its real direction; its partner passes the same test the right way round. Partner: way 239840575.
  - Survey turning counts (pune_west_2026.json, infosys_circle_phase_1; NICMAR Table 6) carry traffic both into and out of this arm: approach N 902 veh/h in; approach E 1208 veh/h in; every approach has right, straight and left flows, so every arm also has exiting traffic.
- **Status:** awaiting owner approval; not submitted.

### `infosys-ring-1`: way 761395844 (infosys_circle_phase_1)

- **Proposed edit:** Remove oneway=no from way 761395844 and reverse it so it runs clockwise with the rest of the ring.
- **Local correction applied in TwinCity:** `set_oneway` {"reverse": true} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Way 761395844 is a two-node piece of the roundabout (junction=roundabout) tagged oneway=no; junction=roundabout implies one-way circulation (OSM wiki Tag:junction=roundabout).
  - The neighbouring ring pieces 1484133388 (ends at the 32 degree node) and 1484133387 (starts at the 42 degree node) circulate clockwise, as roundabouts do in left-hand traffic; this piece is drawn from 42 to 32 degrees, i.e. against them, so the clockwise direction is its reverse.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-253976061`: way 253976061 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 253976061 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1174487504`: way 1174487504 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1174487504 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1174487507`: way 1174487507 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1174487507 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1219666726`: way 1219666726 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1219666726 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1219666727`: way 1219666727 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1219666727 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1523458525`: way 1523458525 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1523458525 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1523458523`: way 1523458523 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1523458523 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1523458524`: way 1523458524 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1523458524 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1523458522`: way 1523458522 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1523458522 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1356392030`: way 1356392030 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1356392030 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1563742487`: way 1563742487 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1563742487 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1563742488`: way 1563742488 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1563742488 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1563742489`: way 1563742489 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1563742489 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1563742490`: way 1563742490 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1563742490 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1534819002`: way 1534819002 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1534819002 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

### `sakharam-lanes-1534819004`: way 1534819004 (sakharam_waghmare_chowk)

- **Proposed edit:** Set lanes=2 on way 1534819004 (Shankar Kalate Nagar Road), after checking the lane count on imagery.
- **Local correction applied in TwinCity:** `set_lanes` {"lanes": 2} (enabled: true)
- **Confidence:** medium
- **Evidence:**
  - Every oneway=yes carriageway of Shankar Kalate Nagar Road within 1.2 km of the junction is tagged lanes=4. On a one-way way OSM lanes counts the lanes in that direction (OSM wiki Key:lanes), which makes this an 8-lane road.
  - Kureshi et al. 2026 (Zenodo 21712996) Table I lists Sakharam Waghmare Chowk as four-lane, i.e. 2 lanes per direction; the one two-way piece of the same road (way 1534819001) is tagged lanes=4 for both directions together.
- **Status:** awaiting owner approval; not submitted.

## Approval checklist (per edit, before any OSM changeset)

1. Project owner approves the specific edit in writing.
2. Direction / lane count confirmed on current imagery (and ideally on site).
3. Changeset comment cites the survey (NICMAR turning counts) and imagery source; one junction per changeset.
4. After the OSM edit is live and re-imported, the matching local correction is disabled (`enabled: false`) so it is not applied twice.
