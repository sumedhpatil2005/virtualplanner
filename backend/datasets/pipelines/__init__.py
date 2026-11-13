"""Reproducible dataset pipelines: `python -m datasets.pipelines.<name>` (docs/urbanos/DATA_INGESTION_ARCHITECTURE.md).

Each pipeline writes derived outputs under `<URBANOS_DATA_DIR>/derived/<dataset_id>/<version>/` together with a
`processing.json` that the registry importer (`python -m datasets.importer`) registers as an immutable version.
"""
