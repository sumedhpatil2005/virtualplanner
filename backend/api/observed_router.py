"""
Observed traffic counts (backend/data/observed_counts/), for calibrating the
simulator against real junction counts.
"""

from fastapi import APIRouter, HTTPException

from observed import counts
from observed.diurnal import profile as diurnal
from observed import network_corrections
from observed import screenlines

router = APIRouter(prefix="/observed-counts", tags=["observed counts"])
diurnal_router = APIRouter(prefix="/diurnal-profile", tags=["observed counts"])
corrections_router = APIRouter(prefix="/network-corrections", tags=["network corrections"])
screenline_router = APIRouter(prefix="/observed-screenlines", tags=["observed counts"])


@screenline_router.get("/{file_id}")
def get_screenline_counts(file_id: str):
    try:
        return screenlines.load(file_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No screen-line count file {file_id!r}")
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"Invalid screen-line count file {file_id!r}: {exc}")


@diurnal_router.get("/{profile_id}")
def get_diurnal_profile(profile_id: str):
    try:
        return diurnal.load(profile_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No diurnal profile {profile_id!r}")


@router.get("")
def list_count_datasets():
    return {"datasets": counts.list_datasets()}


@router.get("/{dataset_id}")
def get_count_dataset(dataset_id: str):
    try:
        return counts.load_dataset(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No valid count dataset {dataset_id!r}")


@corrections_router.get("")
def list_correction_layers():
    return {"layers": network_corrections.list_layers()}


@corrections_router.get("/{layer_id}")
def get_correction_layer(layer_id: str):
    try:
        return network_corrections.load(layer_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No network-correction layer {layer_id!r}")
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"Invalid network-correction layer {layer_id!r}: {exc}")
