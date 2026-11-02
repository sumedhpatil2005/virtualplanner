"""
Observed traffic counts (backend/data/observed_counts/), for calibrating the
simulator against real junction counts.
"""

from fastapi import APIRouter, HTTPException

from observed import counts

router = APIRouter(prefix="/observed-counts", tags=["observed counts"])


@router.get("")
def list_count_datasets():
    return {"datasets": counts.list_datasets()}


@router.get("/{dataset_id}")
def get_count_dataset(dataset_id: str):
    try:
        return counts.load_dataset(dataset_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No valid count dataset {dataset_id!r}")
