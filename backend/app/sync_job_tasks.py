"""Incrementally sync task definitions onto existing jobs.

Run from the `backend/` directory:

    python -m app.sync_job_tasks
    python -m app.sync_job_tasks --dry-run
    python -m app.sync_job_tasks --prune-removed
"""
from __future__ import annotations

import argparse
import logging
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .constants import STATUS_NOT_STARTED, TASK_DEFINITIONS
from .database import Base, SessionLocal, engine
from .models import Job, JobTask, User  # noqa: F401 - ensures model registration

logger = logging.getLogger("skipper.sync_job_tasks")


def sync_tasks_for_all_jobs(
    db: Session,
    *,
    dry_run: bool = False,
    prune_removed: bool = False,
    task_definitions: Sequence[tuple[str, str]] = TASK_DEFINITIONS,
) -> tuple[int, int, int, int]:
    """Apply canonical task adds/label edits/order edits onto existing jobs.

    Returns:
        (jobs_scanned, tasks_inserted, tasks_updated, tasks_deleted)
    """
    jobs = list(db.execute(select(Job).options(selectinload(Job.tasks))).scalars().all())
    if not jobs:
        logger.info("No jobs found; nothing to sync.")
        return (0, 0, 0, 0)

    canonical = {
        task_key: {"label": task_label, "sort_order": idx}
        for idx, (task_key, task_label) in enumerate(task_definitions)
    }

    inserted = 0
    updated = 0
    deleted = 0

    for job in jobs:
        existing_by_key = {task.task_key: task for task in job.tasks}

        for task_key, spec in canonical.items():
            existing = existing_by_key.get(task_key)
            if existing is None:
                inserted += 1
                if not dry_run:
                    db.add(
                        JobTask(
                            job_id=job.id,
                            task_key=task_key,
                            task_label=spec["label"],
                            status=STATUS_NOT_STARTED,
                            value=None,
                            completed_at=None,
                            completed_by=None,
                            note=None,
                            sort_order=spec["sort_order"],
                        )
                    )
                continue

            task_changed = (
                existing.task_label != spec["label"]
                or existing.sort_order != spec["sort_order"]
            )
            if task_changed:
                updated += 1
                if not dry_run:
                    existing.task_label = spec["label"]
                    existing.sort_order = spec["sort_order"]

        if prune_removed:
            for task in job.tasks:
                if task.task_key in canonical:
                    continue
                deleted += 1
                if not dry_run:
                    db.delete(task)

    if dry_run:
        logger.info(
            "Dry-run: scanned %d job(s); would insert %d, update %d, delete %d task row(s).",
            len(jobs),
            inserted,
            updated,
            deleted,
        )
        return (len(jobs), inserted, updated, deleted)

    db.commit()
    logger.info(
        "Sync complete: scanned %d job(s), inserted %d, updated %d, deleted %d task row(s).",
        len(jobs),
        inserted,
        updated,
        deleted,
    )
    return (len(jobs), inserted, updated, deleted)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(
        description="Incrementally sync canonical task definitions to existing jobs."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show pending inserts/updates/deletes without writing changes.",
    )
    parser.add_argument(
        "--prune-removed",
        action="store_true",
        help="Delete job tasks whose task_key is no longer in TASK_DEFINITIONS.",
    )
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        sync_tasks_for_all_jobs(
            db,
            dry_run=args.dry_run,
            prune_removed=args.prune_removed,
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
