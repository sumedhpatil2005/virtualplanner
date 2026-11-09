#!/usr/bin/env python3
"""§24 analysis: model output (NetworkValidation.test.ts JSON lines) vs observations
(backend/data/observed_validation/pune_network_validation_v1.json). Writes sec24_tables.md and summary.json."""
import json, math, os, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__))
# Outputs of the harness (*.jsonl), the run lists and wayinfo.json live in a scratch directory: VAL24_DATA (default: this script's directory)
D = os.environ.get('VAL24_DATA', HERE)
_obs = [os.path.join(HERE, 'pune_network_validation_v1.json'), os.path.join(HERE, '../backend/data/observed_validation/pune_network_validation_v1.json')]
OBS = json.load(open(next(p for p in _obs if os.path.exists(p))))
# wayinfo.json: {way id: {name, roadClass, highway, lanes, maxspeed}} for the counted ways, from the database dump
def find(name):
    for p in (os.path.join(D, name), os.path.join(HERE, 'runs', name)):
        if os.path.exists(p): return p
    return None
WAY = {int(k): v for k, v in json.load(open(find('wayinfo.json'))).items()} if find('wayinfo.json') else {}
def load(name):
    p = os.path.join(D, name); rows = {}
    if os.path.exists(p):
        for l in open(p):
            r = json.loads(l)
            if r.get('settled') is False: continue
            rows[r['id']] = r
    return rows
SEEDS = {r['id']: r['seedRoadIds'] for f in ('runs_area.json',) if find(f) for r in json.load(open(find(f)))}
C, S, W, A, DS = load('counts.jsonl'), load('speeds.jsonl'), load('sweep.jsonl'), load('area.jsonl'), load('speedsweep.jsonl')
HYP = {k: load(f'hypo_{k}.jsonl') for k in ('pcu', 'cap50', 'edge18', 'scale')}
DSH = {k: load(f'speedsweep_{k}.jsonl') for k in ('cap50', 'pcu')}
geh = lambda m, c: math.sqrt(2 * (m - c) ** 2 / max(1, m + c))
def flow_ok(m, c):  # TAG M3.1 Table 2 / FHWA (Wisconsin DOT) individual-flow criterion
    if c < 700: return abs(m - c) <= 100
    if c <= 2700: return abs(m - c) <= 0.15 * c
    return abs(m - c) <= 400
INDO = [('A', .85), ('B', .67), ('C', .50), ('D', .40), ('E', .30)]
out = []; summ = {}
P = out.append
f0 = lambda x: '–' if x is None else f'{x:,.0f}'
pct = lambda x: '–' if x is None else f'{x:.0%}'

SITE = {'cmp08_shivaji': 'shivaji_18', 'cmp08_mhatre': 'mhatre_18', 'cmp08_shinde': 'shinde_18', 'cmp08_tilak': 'tilak_10', 'cmp08_zbridge': 'zbridge_10',
        'cmp08_smjoshi': 'smjoshi_11', 'cmp08_sambhaji': 'sambhaji_11', 'cmp08_rajaram': 'rajaram_10', 'cmp08_sangam': 'sangam_19', 'cmp08_yerwada_ambedkar': 'yerwada_18',
        'cmp08_wadia_rob': 'wadia_11', 'cmp08_rangehill_rub': 'rangehill_16', 'cmp08_sancheti_rob': 'sancheti_19', 'gunjan17_09': 'nagar_09', 'gunjan17_14': 'nagar_14', 'gunjan17_19': 'nagar_19'}
def wsum(ways):
    if not ways: return None
    vals = [v for k, v in ways.items() if not k.startswith('gunjan_e')]
    vals = [v['assigned'] if isinstance(v, dict) else v for v in vals]
    vals = [v for v in vals if v is not None]
    return sum(vals) if vals else None
def wsim(ways):
    if not ways: return None
    vals = [v.get('simulated') for k, v in ways.items() if not k.startswith('gunjan_e') and isinstance(v, dict)]
    vals = [v for v in vals if v is not None]
    return sum(vals) if vals else None
def site_class(o):
    hw = [WAY.get(w, {}) or {} for w in o.get('osmWays', [])]
    tags = [h.get('highway') for h in hw if h.get('highway')]
    return tags[0] if tags else 'not in DB (from OSM index)'
def stats(pairs):
    """pairs: [(model, count)]"""
    if not pairs: return None
    g = [geh(m, c) for m, c in pairs]; n = len(pairs)
    sm, sc = sum(m for m, _ in pairs), sum(c for _, c in pairs)
    return {'n': n, 'geh_lt5': sum(x < 5 for x in g), 'geh_lt10': sum(x < 10 for x in g), 'mean_geh': st.mean(g), 'flow_ok': sum(flow_ok(m, c) for m, c in pairs),
            'mape': st.mean(abs(m - c) / c for m, c in pairs), 'bias': (sm - sc) / sc, 'median_ratio': st.median(m / c for m, c in pairs),
            'rmse_pct': math.sqrt(st.mean((m - c) ** 2 for m, c in pairs)) / st.mean(c for _, c in pairs), 'sum_m': sm, 'sum_c': sc}
def stat_line(s):
    return (f"n={s['n']}: GEH<5 {s['geh_lt5']}/{s['n']} ({s['geh_lt5']/s['n']:.0%}), GEH<10 {s['geh_lt10']}/{s['n']}, flow criterion {s['flow_ok']}/{s['n']}, "
            f"mean GEH {s['mean_geh']:.1f}, MAPE {s['mape']:.0%}, bias {s['bias']:+.0%}, median model/count {s['median_ratio']:.2f}, %RMSE {s['rmse_pct']:.0%}")

# ───────────── 24.3 counts
crow = []
for o in OBS['counts']:
    key = SITE[o['id']]
    r = C.get('c_' + key) or S.get('s_' + key)
    a_area = A.get(f'x_{key}_r2000')
    a = wsum(r.get('ways')) if r and 'ways' in r else None
    if a is None and a_area: a = wsum(a_area['sweep'][0].get('ways'))
    s = wsim(r.get('ways')) if r and 'ways' in r else None
    row = {'obs': o, 'run': r['id'] if r else None, 'assigned': a, 'sim': s, 'cls': site_class(o)}
    if r and 'dirs' in r:
        row.update({'section': r['section']['name'], 'dirs': r['dirs'], 'served': r['load']['servedShare'], 'status': r.get('status')})
    crow.append(row)
P('### 24.3 Traffic counts: observed vs model (both directions, veh/h, at the counted hour)\n')
P('Model assigned = the area\'s user-equilibrium assignment (the demand routed onto the counted way); simulated = vehicles that got through in the micro-simulation (3 seeds, 42/7/11). '
  'GEH and the flow criterion are on the assigned volume (TAG M3.1 and FHWA compare assigned flows); the simulated column shows how much of it the simulated network actually passed.\n')
P('| Site (2008 / 2017 count) | Grade | OSM class | Hour | Count | Assigned | Assigned / count | GEH | Flow criterion | Simulated | Sim / count | GEH (sim) | Section speed km/h each dir (free) | LOS | Served |')
P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for c in crow:
    o = c['obs']; a, s = c['assigned'], c['sim']
    sp = ' / '.join(f"{d['speed'] if d['speed'] is not None else '–'} ({d['free']:g})" for d in c.get('dirs', [])) or '–'
    los = '/'.join(str(d['los'] or '–') for d in c.get('dirs', [])) or '–'
    P(f"| {o['name']} | {o['grade']} | {c['cls']} | {o['hour']:02d}:00 | {o['veh']:,} | {f0(a)} | {pct(a / o['veh']) if a is not None else '–'} | {geh(a, o['veh']):.1f} | {'pass' if flow_ok(a, o['veh']) else 'fail'} | "
      f"{f0(s)} | {pct(s / o['veh']) if s is not None else '–'} | {format(geh(s, o['veh']), '.1f') if s is not None else '–'} | {sp} | {los} | {pct(c.get('served'))} |" if a is not None else
      f"| {o['name']} | {o['grade']} | {c['cls']} | {o['hour']:02d}:00 | {o['veh']:,} | not run | | | | | | | | | |")
done = [c for c in crow if c['assigned'] is not None]
sa = stats([(c['assigned'], c['obs']['veh']) for c in done])
ss = stats([(c['sim'], c['obs']['veh']) for c in done if c['sim'] is not None])
summ['counts'] = sa; summ['counts_sim'] = ss
if sa:
    P(f"\n**All sites, assigned:** {stat_line(sa)}; total {sa['sum_m']:,.0f} vs {sa['sum_c']:,.0f}.")
if ss:
    P(f"**All sites, simulated (got through):** {stat_line(ss)}.\n")
groups = {
    'grade B': lambda c: c['obs']['grade'] == 'B', 'grade C (grouped or mapping inferred)': lambda c: c['obs']['grade'] == 'C',
    'morning 09-11 h': lambda c: c['obs']['hour'] < 12, 'afternoon 14-16 h': lambda c: 12 <= c['obs']['hour'] < 17, 'evening 18-19 h': lambda c: c['obs']['hour'] >= 17,
    'OSM trunk': lambda c: c['cls'] == 'trunk', 'OSM primary': lambda c: c['cls'] == 'primary', 'OSM secondary': lambda c: c['cls'] == 'secondary', 'OSM tertiary': lambda c: c['cls'] == 'tertiary',
    'river bridges (CMP 2008 screen line 2)': lambda c: c['obs']['source'] == 'cmp2008' and 'ROB' not in c['obs']['name'] and 'RUB' not in c['obs']['name'],
    'rail crossings (screen line 1)': lambda c: 'ROB' in c['obs']['name'] or 'RUB' in c['obs']['name'],
    'Nagar Road, Gunjan Chowk 2017': lambda c: c['obs']['source'] == 'gunjan2017'}
P('| Group | n | GEH < 5 | Flow criterion | Mean GEH | MAPE | Bias (sum) | Median assigned / count |'); P('|---|---|---|---|---|---|---|---|')
summ['counts_groups'] = {}
for k, fn in groups.items():
    v = [c for c in done if fn(c)]
    if not v: continue
    s = stats([(c['assigned'], c['obs']['veh']) for c in v]); summ['counts_groups'][k] = s
    P(f"| {k} | {s['n']} | {s['geh_lt5']} | {s['flow_ok']} | {s['mean_geh']:.1f} | {s['mape']:.0%} | {s['bias']:+.0%} | {s['median_ratio']:.2f} |")
# screen line 2 total
sl2 = [c for c in done if groups['river bridges (CMP 2008 screen line 2)'](c)]
if sl2:
    m, cc = sum(c['assigned'] for c in sl2), sum(c['obs']['veh'] for c in sl2)
    P(f"\nRiver screen line (CMP 2008 screen line 2, {len(sl2)} crossings, each at its own counted hour and from its own study area): model {m:,.0f} vs counted {cc:,.0f} veh/h ({m/cc-1:+.0%}); TAG M3.1 asks screen-line totals within 5%.\n")
    summ['screenline2'] = {'n': len(sl2), 'model': m, 'count': cc}

# ───────────── 24.3b area dependence
if A:
    P('### 24.3b The same counted crossing seen from different study areas (assignment only, counted hour)\n')
    P('| Site | Count | Assigned, area 1 km / 2 km / 3 km round the bridge | Max / min | Distance from counted way to nearest cordon point, m (1 / 2 / 3 km) | Area cordon inflow veh/h (1 / 2 / 3 km) | Through share of area demand (1 / 2 / 3 km) |')
    P('|---|---|---|---|---|---|---|')
    pairs = []
    summ['area'] = {}
    for o in OBS['counts']:
        key = SITE[o['id']]
        rs = [A.get(f'x_{key}_r{x}') for x in (1000, 2000, 3000)]
        if not any(rs): continue
        vols = [wsum(r['sweep'][0].get('ways')) if r else None for r in rs]
        dists = [min([v for k, v in r['wayCordonM'].items() if not k.startswith('gunjan_e') and v is not None] or [None]) if r and r.get('wayCordonM') else None for r in rs]
        cin = [r['cordon']['inVph'] if r else None for r in rs]
        thr = [(r['sweep'][0]['components']['through'] / r['sweep'][0]['planVph']) if r and r['sweep'][0].get('components') else None for r in rs]
        good = [v for v in vols if v]
        for v, dd, r in zip(vols, dists, rs):
            if v and dd is not None: pairs.append((dd, v / o['veh'], o['id'], r['id']))
        summ['area'][o['id']] = {'vols': vols, 'dists': dists, 'cordonIn': cin}
        P(f"| {o['name']} ({o['hour']:02d} h) | {o['veh']:,} | {' / '.join(f0(v) for v in vols)} | {(max(good)/min(good)) if len(good) > 1 and min(good) > 0 else float('nan'):.1f} | "
          f"{' / '.join(f0(x) for x in dists)} | {' / '.join(f0(x) for x in cin)} | {' / '.join(pct(x) for x in thr)} |")
    via = sorted(k for k in A if k.startswith('x_sambhaji_via_'))
    if via:
        P('\nSambhaji Bridge (count 5,042 veh/h, 11:00, no two-wheelers allowed) from areas grown round other roads (range 2 km):\n')
        P('| Area seeded on | Seed road | Assigned on the bridge | Bridge to nearest cordon point, m | Area demand veh/h | internal / to-from edge / through | Cordon points |'); P('|---|---|---|---|---|---|---|')
        for k in ['x_sambhaji_11_r2000'] + via:
            r = A[k]; sw = r['sweep'][0]; cp = sw.get('components') or {}
            P(f"| {k.replace('x_sambhaji_via_', '').replace('x_sambhaji_11_r2000', 'the bridge itself')} | {SEEDS[k][0]} ({r.get('sectionName')}) | {f0(wsum(sw.get('ways')))} | {f0(r['wayCordonM'].get('cmp08_sambhaji'))} | "
              f"{sw['planVph']:,} | {f0(cp.get('internal'))} / {f0((cp.get('inbound') or 0) + (cp.get('outbound') or 0))} / {f0(cp.get('through'))} | {r['cordon']['points']} |")
            pairs.append((r['wayCordonM'].get('cmp08_sambhaji'), wsum(sw.get('ways')) / 5042, 'via', 2000))
    if summ.get('area'):
        mm = []; mono_dec = mono_inc = mixed = 0
        for k, v in summ['area'].items():
            xs = [(d, x) for d, x in zip(v['dists'], v['vols']) if d is not None and x]
            if len(xs) < 2: continue
            vals = [x for _, x in xs]; mm.append(max(vals) / min(vals))
            xs.sort(); seq = [x for _, x in xs]
            if all(a >= b for a, b in zip(seq, seq[1:])): mono_dec += 1
            elif all(a <= b for a, b in zip(seq, seq[1:])): mono_inc += 1
            else: mixed += 1
        thr_all = all(abs(r['sweep'][0]['components']['through'] - r['sweep'][0]['planVph']) < 1 for r in A.values() if r['sweep'][0].get('components'))
        P(f"\nWithin a site, changing only the study area (1, 2 or 3 km round the same bridge) changed the bridge's assigned volume by max/min {min(mm):.1f}-{max(mm):.1f} (median {st.median(mm):.1f}, {len(mm)} sites). "
          f"Ordered by the bridge's distance from the area edge, the volume fell steadily at {mono_dec} sites, rose at {mono_inc} and went both ways at {mixed}: distance to the edge alone does not set it. "
          f"In {'every one' if thr_all else 'not every one'} of the {len(A)} areas the demand was 100% edge-to-edge through traffic (internal and land-use-to-edge parts 0).\n")
        summ['area_maxmin'] = {'min': min(mm), 'max': max(mm), 'median': st.median(mm), 'n': len(mm), 'dec': mono_dec, 'inc': mono_inc, 'mixed': mixed, 'through_all': thr_all}

# ───────────── 24.4 speeds
tc = {o['id']: o for o in OBS['speeds_hourly']}
def pick_dir(r, want):
    for d in r['dirs']:
        if any(w in d['label'] for w in want): return d
    return None
corr = [('tc_karve', 'karve', ['west']), ('tc_tilak', 'tilak', ['south-east', 'south', 'east']), ('tc_sinhagad', 'sinhagad', ['south-west', 'south', 'west']),
        ('tc_lawcollege', 'lawcollege', ['south']), ('tc_baner', 'baner', ['west'])]
srows = []
if S:
    P('### 24.4 Corridor speeds: TraffiCure 2026 (probe data, hour by hour) vs the simulated section\n')
    P('| Corridor (observed) | Model section | Hour | Observed km/h | Model km/h, matching direction (all dirs) | Model / observed | Within 15% | Model LOS | Model free flow | Served |')
    P('|---|---|---|---|---|---|---|---|---|---|')
    for oid, key, want in corr:
        o = tc[oid]
        for h in (3, 9, 19):
            r = S.get(f's_{key}_{h:02d}')
            if not r or 'dirs' not in r: continue
            d = pick_dir(r, want) or r['dirs'][0]
            obs = o['kmh_by_hour'][h]; m = d['speed']
            both = ' / '.join(f"{x['label'].replace('towards the ', '')} {x['speed']}" for x in r['dirs'])
            srows.append({'corr': oid, 'hour': h, 'obs': obs, 'model': m, 'src': 'trafficure'})
            P(f"| {o['corridor']} | {r['section']['name']} ({r['section']['lengthM']} m) | {h:02d}:00 | {obs} | {m} ({both}) | {(m / obs if m else float('nan')):.2f} | {'yes' if m and abs(m - obs) / obs <= .15 else 'no'} | {d['los']} | {d['free']} | {r['load']['servedShare']:.0%} |")
    P('\n| Corridor (CMP 2008 Table 4.10, peak hour) | Observed km/h each dir | Model section (09:00 run) | Model km/h each dir | Model mean / observed | Within 15% | Model LOS | Model free flow |')
    P('|---|---|---|---|---|---|---|---|')
    cmp_map = [('cmp08_karve', 's_karve_09'), ('cmp08_ganeshkhind', 's_ganeshkhind_09'), ('cmp08_shivajird', 's_shivajird_09'), ('cmp08_jm', 's_jm_09'),
               ('cmp08_deccancollege', 's_deccancollege_09'), ('cmp08_koregaon', 's_koregaon_09'), ('cmp08_nagar', 's_nagar_09'), ('cmp08_sinhagad', 's_sinhagad_09')]
    cmpo = {o['id']: o for o in OBS['speeds_corridor']}
    for oid, rid in cmp_map:
        o = cmpo[oid]; r = S.get(rid)
        if not r or 'dirs' not in r: continue
        ms = [x['speed'] for x in r['dirs'] if x['speed'] is not None]
        mm = st.mean(ms) if ms else None
        srows.append({'corr': oid, 'hour': 9, 'obs': o['kmh'], 'model': mm, 'src': 'cmp2008'})
        P(f"| {o['corridor']} | {' / '.join(map(str, o['dirs']))} | {r['section']['name']} ({r['section']['lengthM']} m) | {' / '.join(str(x['speed']) for x in r['dirs'])} | {(mm / o['kmh']) if mm else float('nan'):.2f} | {'yes' if mm and abs(mm - o['kmh']) / o['kmh'] <= .15 else 'no'} | {'/'.join(str(x['los'] or '–') for x in r['dirs'])} | {' / '.join(str(x['free']) for x in r['dirs'])} |")
    ok = [x for x in srows if x['model']]
    if ok:
        def sp(v): return {'n': len(v), 'mape': st.mean(abs(x['model'] - x['obs']) / x['obs'] for x in v), 'bias': st.mean((x['model'] - x['obs']) / x['obs'] for x in v),
                           'within15': sum(abs(x['model'] - x['obs']) / x['obs'] <= .15 for x in v), 'median_ratio': st.median(x['model'] / x['obs'] for x in v)}
        summ['speeds_sim'] = sp(ok)
        summ['speeds_sim_by'] = {lab: sp(v) for lab, v in [('03:00', [x for x in ok if x['hour'] == 3]), ('09:00', [x for x in ok if x['hour'] == 9]), ('19:00', [x for x in ok if x['hour'] == 19]),
                                                           ('TraffiCure', [x for x in ok if x['src'] == 'trafficure']), ('CMP 2008', [x for x in ok if x['src'] == 'cmp2008'])] if v}
        s = summ['speeds_sim']
        P(f"\n**Simulated section speeds, all {s['n']} comparisons:** MAPE {s['mape']:.0%}, mean bias {s['bias']:+.0%}, within 15% {s['within15']}/{s['n']} (TAG M3.1 journey-time criterion asks > 85%), median model/observed {s['median_ratio']:.2f}.\n")
        P('| Subset | n | MAPE | Mean bias | Within 15% | Median model / observed |'); P('|---|---|---|---|---|---|')
        for lab, v in summ['speeds_sim_by'].items(): P(f"| {lab} | {v['n']} | {v['mape']:.0%} | {v['bias']:+.0%} | {v['within15']} | {v['median_ratio']:.2f} |")
        P('')

# assignment speed by hour on the TraffiCure corridors (24 h)
BANDS = [('night 00-05', range(0, 6)), ('morning 07-10', range(7, 11)), ('midday 11-16', range(11, 17)), ('evening 17-20', range(17, 21)), ('late 21-23', range(21, 24))]
def sec_speed(sw):
    v = [d['speed'] for d in (sw.get('section') or {}).values() if d.get('speed')]
    return st.mean(v) if v else None
def sweep_compare(DSx):
    rows = []
    for oid, key, _ in corr:
        r = DSx.get(f'd_{key}')
        if not r: continue
        for sw in r['sweep']:
            m = sec_speed(sw)
            if m: rows.append({'corr': oid, 'hour': sw['hour'], 'obs': tc[oid]['kmh_by_hour'][sw['hour']], 'model': m, 'free': st.mean([d['free'] for d in sw['section'].values() if d.get('free')])})
    return rows
def band_stats(rows):
    res = {}
    for lab, hrs in BANDS + [('all hours', range(24))]:
        v = [x for x in rows if x['hour'] in hrs]
        if v: res[lab] = {'n': len(v), 'mape': st.mean(abs(x['model'] - x['obs']) / x['obs'] for x in v), 'bias': st.mean((x['model'] - x['obs']) / x['obs'] for x in v),
                          'within15': sum(abs(x['model'] - x['obs']) / x['obs'] <= .15 for x in v)}
    return res
if DS:
    rows = sweep_compare(DS)
    if rows:
        P('### 24.4b Assignment speed on the TraffiCure corridors, every hour (mean of the two directions; user-equilibrium link times incl. signal delay)\n')
        present = [(o, k) for o, k, _ in corr if DS.get(f'd_{k}')]
        P('| Hour | ' + ' | '.join(f"{k} obs / model" for o, k in present) + ' |')
        P('|---|' + '---|' * len(present))
        for h in range(24):
            cells = []
            for o, k in present:
                x = next((y for y in rows if y['corr'] == o and y['hour'] == h), None)
                cells.append(f"{x['obs']} / {x['model']:.1f}" if x else '–')
            P(f"| {h:02d} | " + ' | '.join(cells) + ' |')
        bs = band_stats(rows); summ['speeds_assign'] = bs
        P('\n| Hours | n | MAPE | Mean bias | Within 15% |'); P('|---|---|---|---|---|')
        for lab, v in bs.items(): P(f"| {lab} | {v['n']} | {v['mape']:.0%} | {v['bias']:+.0%} | {v['within15']} |")
        P('')

# ───────────── 24.5 network sweep vs citywide
city = tc['tc_citywide']['kmh_by_hour']
if W:
    hours = sorted({s['hour'] for r in W.values() for s in r.get('sweep', [])})
    P('### 24.5 Network-wide speed by hour: ten 2 km areas (assignment, vehicle-km weighted) vs citywide observations\n')
    P('| Hour | TraffiCure citywide km/h | ' + ' | '.join(k.replace('a_', '') for k in sorted(W)) + ' | Mean of areas | Model / observed |')
    P('|---|---|' + '---|' * len(W) + '---|---|')
    rows = []
    for h in hours:
        vals = [next((x['speedKmh'] for x in W[k].get('sweep', []) if x['hour'] == h), None) for k in sorted(W)]
        good = [v for v in vals if v]; mm = st.mean(good) if good else None
        rows.append({'hour': h, 'obs': city[h], 'model': mm})
        P(f"| {h:02d}:00 | {city[h]} | " + ' | '.join('' if v is None else f'{v:.1f}' for v in vals) + f" | {mm:.1f} | {mm / city[h]:.2f} |")
    summ['sweep'] = rows
    P('\nVKT-weighted free-flow speed of the same areas: ' + ', '.join(f"{k.replace('a_', '')} {next((x['freeSpeedKmh'] for x in W[k]['sweep'] if x['hour'] == 9), None)}" for k in sorted(W)) + ' km/h.\n')
    # AM vs PM components
    P('| Area | Demand 09:00 veh/h | Demand 19:00 veh/h | Through 09 / 19 | To-from edge 09 / 19 | Internal 09 / 19 | Speed 09 / 19 km/h |'); P('|---|---|---|---|---|---|---|')
    ampm = []
    for k in sorted(W):
        a9 = next((x for x in W[k]['sweep'] if x['hour'] == 9), None); a19 = next((x for x in W[k]['sweep'] if x['hour'] == 19), None)
        if not a9 or not a19: continue
        c9, c19 = a9.get('components') or {}, a19.get('components') or {}
        e = lambda c: (c.get('inbound') or 0) + (c.get('outbound') or 0)
        ampm.append((a9['speedKmh'], a19['speedKmh'], a9['demandVph'], a19['demandVph']))
        P(f"| {k.replace('a_', '')} | {a9['demandVph']:,} | {a19['demandVph']:,} | {f0(c9.get('through'))} / {f0(c19.get('through'))} | {f0(e(c9))} / {f0(e(c19))} | {f0(c9.get('internal'))} / {f0(c19.get('internal'))} | {a9['speedKmh']} / {a19['speedKmh']} |")
    if ampm:
        summ['ampm'] = {'speed_diff_pct': [ (b - a) / a for a, b, _, _ in ampm], 'demand_diff_pct': [(d - c) / c for _, _, c, d in ampm]}
        P(f"\nModel 19:00 vs 09:00: demand {st.mean(summ['ampm']['demand_diff_pct']):+.1%} (range {min(summ['ampm']['demand_diff_pct']):+.1%} to {max(summ['ampm']['demand_diff_pct']):+.1%}), "
          f"area speed {st.mean(summ['ampm']['speed_diff_pct']):+.1%} (range {min(summ['ampm']['speed_diff_pct']):+.1%} to {max(summ['ampm']['speed_diff_pct']):+.1%}). "
          f"Observed: TraffiCure citywide {city[9]} → {city[19]} km/h ({city[19]/city[9]-1:+.0%}); TomTom 2025 morning rush 15.7, evening rush 14.4 km/h (-8%); Gunjan Chowk counts 09:00 10,034, 19:00 9,460 veh/h (-6%).\n")
    # by class
    P('| Road class (model) | km in the 10 areas | Speed 03:00 | 09:00 | 19:00 | Free flow |'); P('|---|---|---|---|---|---|')
    cls = {}
    for k, r in W.items():
        for s in r['sweep']:
            for c, v in s['byClass'].items():
                e = cls.setdefault(c, {'km': 0, 3: [0, 0], 9: [0, 0], 19: [0, 0], 'free': [0, 0]})
                if s['hour'] == 3: e['km'] += v['km']
                if s['hour'] in (3, 9, 19) and v['speed']: e[s['hour']][0] += v['vkm']; e[s['hour']][1] += v['vkm'] / v['speed']
                if s['hour'] == 9 and v['free']: e['free'][0] += v['vkm']; e['free'][1] += v['vkm'] / v['free']
    summ['by_class'] = {}
    for c, e in sorted(cls.items(), key=lambda x: -x[1]['km']):
        fm = lambda p: p[0] / p[1] if p[1] else None
        summ['by_class'][c] = {h: fm(e[h]) for h in (3, 9, 19)}
        P(f"| {c} | {e['km']:.0f} | " + ' | '.join('–' if fm(e[h]) is None else f'{fm(e[h]):.1f}' for h in (3, 9, 19, 'free')) + ' |')
    ok = [x for x in rows if x['model']]
    P('')
    summ['city_stats'] = {lab: {'n': len(v), 'mape': st.mean(abs(x['model'] - x['obs']) / x['obs'] for x in v), 'bias': st.mean((x['model'] - x['obs']) / x['obs'] for x in v)}
                          for lab, v in [('all', ok), ('peaks 09/17/19', [x for x in ok if x['hour'] in (9, 17, 19)]), ('night 03/23', [x for x in ok if x['hour'] in (3, 23)])] if v}
    P('| Hours | n | MAPE vs TraffiCure citywide | Mean bias |'); P('|---|---|---|---|')
    for lab, v in summ['city_stats'].items(): P(f"| {lab} | {v['n']} | {v['mape']:.0%} | {v['bias']:+.0%} |")
    P('')

# ───────────── 24.6 hypotheticals
base = {}
for o in OBS['counts']:
    r = A.get(f"x_{SITE[o['id']]}_r2000")
    if r: base[o['id']] = (wsum(r['sweep'][0].get('ways')), o['veh'], r['sweep'][0]['speedKmh'])
P('### 24.6 Hypothetical calibrations (prototype, harness only; defaults unchanged)\n')
P('| Option | Sites | GEH < 5 | Flow criterion | Mean GEH | MAPE | Bias | Median assigned / count | Area speed at the counted hour, mean km/h |'); P('|---|---|---|---|---|---|---|---|---|')
summ['hypo'] = {}
def hyp_row(lab, data):
    pairs = [(v[0], v[1]) for v in data.values() if v[0]]
    spd = [v[2] for v in data.values() if v[2]]
    if not pairs: return
    s = stats(pairs); s['speed'] = st.mean(spd) if spd else None; summ['hypo'][lab] = s
    spd_txt = '–' if s['speed'] is None else f"{s['speed']:.1f}"
    P(f"| {lab} | {s['n']} | {s['geh_lt5']} | {s['flow_ok']} | {s['mean_geh']:.1f} | {s['mape']:.0%} | {s['bias']:+.0%} | {s['median_ratio']:.2f} | {spd_txt} |")
hyp_row('current model (2 km area, same runs)', base)
for k, lab in [('pcu', 'PCU TRR 2021 mid-range (all links)'), ('cap50', '50 km/h cap on tagged maxspeed'), ('edge18', 'edge flow per lane x1.8'), ('scale', 'all demand scaled')]:
    H = HYP[k]; data = {}
    for o in OBS['counts']:
        r = H.get(f"h_{SITE[o['id']]}")
        if r: data[o['id']] = (wsum(r['sweep'][0].get('ways')), o['veh'], r['sweep'][0]['speedKmh'])
    if data and k == 'scale': lab = f"all demand x{next(iter(H.values()))['hypothetical']['demandScale']} (sum counts / sum assigned)"
    if data: hyp_row(lab, data)
P('')
if DS and any(DSH.values()):
    # Each option is compared with the current model on the SAME corridors (an option run on fewer corridors gets its own baseline row)
    P('| Corridor speed option (assignment, TraffiCure corridors, 24 h) | Corridors | Night 00-05 MAPE / bias | Evening 17-20 MAPE / bias | All hours MAPE / bias |'); P('|---|---|---|---|---|')
    tck = [k for _, k, _ in corr]
    for lab, d in [('50 km/h cap on tagged maxspeed', DSH['cap50']), ('PCU TRR 2021 (all links)', DSH['pcu'])]:
        keys = [k for k in tck if d.get(f'd_{k}') and DS.get(f'd_{k}')]
        if not keys: continue
        for l2, src in [(f'current model (same {len(keys)} corridors)', DS), (lab, d)]:
            b = band_stats(sweep_compare({f'd_{k}': src[f'd_{k}'] for k in keys})); summ.setdefault('hypo_speed', {})[l2] = b
            g = lambda k: f"{b[k]['mape']:.0%} / {b[k]['bias']:+.0%}" if k in b else '–'
            P(f"| {l2} | {', '.join(keys)} | {g('night 00-05')} | {g('evening 17-20')} | {g('all hours')} |")
    P('')
open(os.path.join(D, 'sec24_tables.md'), 'w').write('\n'.join(out))
json.dump(summ, open(os.path.join(D, 'summary.json'), 'w'), indent=1, default=str)
print('\n'.join(out))
