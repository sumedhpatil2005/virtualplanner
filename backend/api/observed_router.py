"""
Observed traffic counts (backend/data/observed_counts/), for calibrating the
simulator against real junction counts.
"""

from fastapi import APIRouter, HTTPException

from observed import counts
from observed.diurnal import profile as diurnal

router = APIRouter(prefix="/observed-counts", tags=["observed counts"])
diurnal_router = APIRouter(prefix="/diurnal-profile", tags=["observed counts"])


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
