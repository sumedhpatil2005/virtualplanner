"""Own numpy D8 hydrology (replaces GPL pysheds)."""
import numpy as np

from datasets.pipelines import _hydro as H
from datasets.pipelines import _raster as R


def _valley():
    # V-shaped valley draining south; a pit in the middle
    y, x = np.mgrid[0:7, 0:5]
    z = 100.0 - y * 2.0 + np.abs(x - 2) * 3.0
    z[3, 2] = 80.0  # pit
    return z


def test_flow_direction_steepest_and_codes():
    z = np.array([[5.0, 4.0, 3.0], [4.0, 3.0, 2.0], [3.0, 2.0, 1.0]])
    fd = H.flow_direction(z, cell=1.0)
    assert fd[0, 0] == 2          # SE diagonal: drop 4/sqrt2 > 1
    assert fd[1, 1] == 2
    assert fd[2, 2] == 0          # lowest corner: no in-grid receiver -> outlet
    assert fd[0, 2] == 4          # S (drop 2) beats SW (drop 2/sqrt2)


def test_nodata_never_receives():
    z = np.array([[3.0, np.nan], [2.0, 1.0]])
    fd = H.flow_direction(z)
    assert fd[0, 1] == 0 and fd[0, 0] in (4, 2)


def test_accumulation_conserves_cells_and_catchments():
    z = R.priority_flood_epsilon(_valley(), eps=1e-3)
    valid = np.isfinite(z)
    fd = H.flow_direction(z, valid)
    acc = H.accumulation(fd, z, valid)
    outs = H.drainage_outlets(fd, acc, valid, 1)
    # every cell reaches an outlet: outlet accumulations sum to the cell count
    assert sum(acc[o] for o in outs) == z.size
    assert acc.min() == 1
    lab = H.label_catchments(fd, z, outs, valid)
    assert (lab > 0).all()
    assert all((lab == k + 1).sum() == acc[o] for k, o in enumerate(outs))


def test_stream_segments_split_at_confluence():
    # two tributaries joining then flowing south
    fd = np.array([[2, 0, 8], [0, 4, 0], [0, 4, 0]], "int32")  # (0,0)->SE, (0,2)->SW, centre S
    acc = np.array([[1, 0, 1], [0, 3, 0], [0, 4, 0]], float)
    segs = H.stream_segments(fd, acc, 0.5)
    assert sorted(map(tuple, segs)) == sorted([((0, 0), (1, 1)), ((0, 2), (1, 1)), ((1, 1), (2, 1))])


def test_compare_identical_runs_and_pysheds_codes():
    z = R.priority_flood_epsilon(_valley(), eps=1e-3)
    valid = np.isfinite(z)
    fd = H.flow_direction(z, valid)
    acc = H.accumulation(fd, z, valid)
    other = fd.copy()
    other[other == 0] = -1   # pysheds' unresolved-flat code
    c = H.compare(fd, other, acc, acc, valid, 2)
    assert c["flowdir_agreement"] == 1.0 and c["stream_cells"]["iou"] == 1.0
    assert c["no_receiver_cells"]["a"] == c["no_receiver_cells"]["same_cells"]


def test_pysheds_not_required():
    import ast
    import pathlib
    req = (pathlib.Path(H.__file__).parents[2] / "requirements.txt").read_text()
    assert not any(line.strip().startswith("pysheds") for line in req.splitlines())
    for f in pathlib.Path(H.__file__).parent.glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [a.name for a in node.names] + [getattr(node, "module", "") or ""]
                assert not any(n.startswith("pysheds") for n in names), f
