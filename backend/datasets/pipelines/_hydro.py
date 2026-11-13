"""D8 hydrology in plain numpy (replaces pysheds, which is GPL-3.0-or-later).

Algorithms (published, re-implemented here from the papers, no code copied):
- Priority-Flood + epsilon depression filling / flat resolution: Barnes, Lehman & Mulla (2014),
  Computers & Geosciences 62:117-127 (see _raster.priority_flood_epsilon).
- D8 single-flow-direction: O'Callaghan & Mark (1984); steepest drop with diagonal distance sqrt(2)*cell.
- Flow accumulation: each valid cell contributes 1 (itself) and passes its total to its D8 receiver; cells are
  processed in descending conditioned elevation, which is a valid topological order because every receiver is
  strictly lower after Priority-Flood+epsilon.

Direction encoding is the ESRI one used by the v1 pysheds outputs: 64=N 128=NE 1=E 2=SE 4=S 8=SW 16=W 32=NW,
0 = no receiver (outlet at the grid edge / next to nodata, or an unresolved pit).
"""
from __future__ import annotations

import math

import numpy as np

# (code, dy, dx) in the dirmap order (64,128,1,2,4,8,16,32); ties resolve to the first in this order.
D8 = ((64, -1, 0), (128, -1, 1), (1, 0, 1), (2, 1, 1), (4, 1, 0), (8, 1, -1), (16, 0, -1), (32, -1, -1))
OFFSETS = {c: (dy, dx) for c, dy, dx in D8}


def flow_direction(z: np.ndarray, valid: np.ndarray | None = None, cell: float = 1.0) -> np.ndarray:
    """ESRI-coded D8 directions (int32). Off-grid and invalid neighbours are never receivers."""
    z = np.asarray(z, "float64")
    if valid is None:
        valid = np.isfinite(z)
    h, w = z.shape
    zp = np.pad(np.where(valid, z, np.nan), 1, constant_values=np.nan)
    best = np.zeros((h, w), "float64")
    out = np.zeros((h, w), "int32")
    with np.errstate(invalid="ignore"):
        for code, dy, dx in D8:
            nb = zp[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
            slope = (z - nb) / (cell * (math.sqrt(2.0) if dy and dx else 1.0))
            take = np.isfinite(slope) & (slope > best)
            best = np.where(take, slope, best)
            out = np.where(take, code, out)
    out[~valid] = 0
    return out


def receivers(fdir: np.ndarray) -> np.ndarray:
    """Flat index of each cell's receiver, -1 where none."""
    h, w = fdir.shape
    rec = np.full(h * w, -1, "int64")
    ys, xs = np.indices((h, w))
    for code, dy, dx in D8:
        m = fdir == code
        ny, nx = ys[m] + dy, xs[m] + dx
        ok = (ny >= 0) & (ny < h) & (nx >= 0) & (nx < w)
        idx = np.flatnonzero(m.ravel())
        rec[idx[ok]] = ny[ok] * w + nx[ok]
    return rec


def accumulation(fdir: np.ndarray, z: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """Number of cells (incl. itself) draining through each cell. z must be the conditioned DEM used for fdir."""
    z = np.asarray(z, "float64")
    if valid is None:
        valid = np.isfinite(z)
    rec = receivers(fdir)
    vflat = valid.ravel()
    acc = vflat.astype("float64")
    order = np.flatnonzero(vflat)
    order = order[np.argsort(-z.ravel()[order], kind="stable")]
    rec_l = rec.tolist()
    acc_l = acc.tolist()
    for i in order.tolist():
        r = rec_l[i]
        if r >= 0:
            acc_l[r] += acc_l[i]
    return np.asarray(acc_l, "float64").reshape(fdir.shape)


def label_catchments(fdir: np.ndarray, z: np.ndarray, outlets: list[tuple[int, int]],
                     valid: np.ndarray | None = None) -> np.ndarray:
    """Label every cell draining to outlets[k] with k+1 (0 = none). Ascending-z pass: receivers first."""
    z = np.asarray(z, "float64")
    if valid is None:
        valid = np.isfinite(z)
    h, w = fdir.shape
    rec = receivers(fdir).tolist()
    lab = [0] * (h * w)
    for k, (y, x) in enumerate(outlets):
        lab[y * w + x] = k + 1
    order = np.flatnonzero(valid.ravel())
    order = order[np.argsort(z.ravel()[order], kind="stable")].tolist()
    for i in order:
        if lab[i] == 0:
            r = rec[i]
            if r >= 0:
                lab[i] = lab[r]
    return np.asarray(lab, "int32").reshape(h, w)


def stream_segments(fdir: np.ndarray, acc: np.ndarray, threshold_cells: float) -> list[list[tuple[int, int]]]:
    """Stream network (acc > threshold) as cell-index polylines, split at confluences: each segment runs from a
    head (no upstream stream cell) or a confluence's downstream cell to the next confluence/outlet (inclusive)."""
    h, w = fdir.shape
    stream = (acc > threshold_cells).ravel()
    rec = receivers(fdir)
    rec_s = np.where((rec >= 0) & stream[np.clip(rec, 0, None)] & stream, rec, -1)
    indeg = np.bincount(rec_s[rec_s >= 0], minlength=h * w)
    starts = np.flatnonzero(stream & (indeg != 1))  # heads (0) and confluences (>=2)
    segs = []
    rec_l = rec_s.tolist()
    indeg_l = indeg.tolist()
    for s in starts.tolist():
        path = [s]
        cur = s
        while True:
            nxt = rec_l[cur]
            if nxt < 0:
                break
            path.append(nxt)
            if indeg_l[nxt] != 1:  # reached a confluence: segment ends here (the next one starts there)
                break
            cur = nxt
        if len(path) >= 2:
            segs.append([divmod(i, w) for i in path])
    return segs


def drainage_outlets(fdir: np.ndarray, acc: np.ndarray, valid: np.ndarray, min_cells: float) -> list[tuple[int, int]]:
    """Valid cells with acc >= min_cells and no valid in-grid receiver; largest accumulation first."""
    h, w = fdir.shape
    rec = receivers(fdir).reshape(h, w)
    vflat = valid.ravel()
    no_rec = (rec < 0) | ~vflat[np.clip(rec, 0, None)]
    ys, xs = np.where(valid & (acc >= min_cells) & no_rec)
    res = list(zip(ys.tolist(), xs.tolist()))
    res.sort(key=lambda p: -acc[p])
    return res


def compare(a_fdir, b_fdir, a_acc, b_acc, valid, stream_thr, a_cat=None, b_cat=None) -> dict:
    """Agreement metrics between two D8 runs on the same grid (e.g. numpy vs the archived pysheds version)."""
    codes = list(OFFSETS)
    a_has, b_has = np.isin(a_fdir, codes), np.isin(b_fdir, codes)  # 0 / -1 / -2 all mean "no receiver"
    v = valid & a_has & b_has
    sa, sb = (a_acc > stream_thr) & valid, (b_acc > stream_thr) & valid
    inter, union = int((sa & sb).sum()), int((sa | sb).sum())
    la, lb = np.log1p(a_acc[valid]), np.log1p(b_acc[valid])
    out = {
        "flowdir_cells_compared": int(v.sum()),
        "flowdir_agreement": float((a_fdir[v] == b_fdir[v]).mean()) if v.any() else None,
        "no_receiver_cells": {"a": int((~a_has & valid).sum()), "b": int((~b_has & valid).sum()),
                              "same_cells": int((~a_has & ~b_has & valid).sum())},
        "acc_exact_agreement": float((a_acc[valid] == b_acc[valid]).mean()),
        "acc_log1p_pearson_r": float(np.corrcoef(la, lb)[0, 1]) if la.size > 1 else None,
        "acc_max": {"a": float(a_acc[valid].max()), "b": float(b_acc[valid].max())},
        "stream_cells": {"a": int(sa.sum()), "b": int(sb.sum()), "intersection": inter,
                         "iou": inter / union if union else None},
    }
    if a_cat is not None and b_cat is not None:
        m = valid & ((a_cat > 0) | (b_cat > 0))
        # labels are matched by overlap (ids may be numbered differently)
        pairs = {}
        for la_, lb_ in zip(a_cat[m].tolist(), b_cat[m].tolist()):
            pairs[(la_, lb_)] = pairs.get((la_, lb_), 0) + 1
        best = {}
        for (la_, lb_), n in pairs.items():
            if la_ and lb_ and n > best.get(la_, (0, 0))[1]:
                best[la_] = (lb_, n)
        agree = sum(n for _, n in best.values())
        out["catchments"] = {"a_count": int(len(set(a_cat[a_cat > 0].tolist()))),
                             "b_count": int(len(set(b_cat[b_cat > 0].tolist()))),
                             "label_match": {str(k): int(v_[0]) for k, v_ in best.items()},
                             "cell_agreement_matched": agree / int(m.sum()) if m.any() else None}
    return out
