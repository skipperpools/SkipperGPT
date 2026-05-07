"""One-time task migration: wipe each job's tasks and reseed defaults.

Run from the `backend/` directory:

    python -m app.reseed_job_tasks
    python -m app.reseed_job_tasks --dry-run
"""
from __future__ import annotations

import argparse
import logging

from sqlalchemy import delete
from sqlalchemy.orm import Session

from .constants import STATUS_NOT_STARTED, TASK_DEFINITIONS
from .database import Base, SessionLocal, engine
from .models import Job, JobTask, User  # noqa: F401 — registers models in metadata

logger = logging.getLogger("skipper.reseed_job_tasks")


def reseed_tasks_for_all_jobs(db: Session, *, dry_run: bool = False) -> tuple[int, int]:
    """Replace all existing task rows with the canonical checklist for each job.

    Returns:
        (jobs_updated, tasks_inserted)
    """
    jobs = db.query(Job).all()
    if not jobs:
        logger.info("No jobs found; nothing to migrate.")
        return (0, 0)

    jobs_updated = len(jobs)
    tasks_inserted = jobs_updated * len(TASK_DEFINITIONS)

    if dry_run:
        logger.info(
            "Dry-run: would reseed %d job(s) with %d total tasks (%d each).",
            jobs_updated,
            tasks_inserted,
            len(TASK_DEFINITIONS),
        )
        return (jobs_updated, tasks_inserted)

    for job in jobs:
        db.execute(delete(JobTask).where(JobTask.job_id == job.id))
        for index, (task_key, task_label) in enumerate(TASK_DEFINITIONS):
            db.add(
                JobTask(
                    job_id=job.id,
                    task_key=task_key,
                    task_label=task_label,
                    status=STATUS_NOT_STARTED,
                    value=None,
                    completed_at=None,
                    completed_by=None,
                    note=None,
                    sort_order=index,
                )
            )

    db.commit()
    logger.info(
        "Reseed complete: updated %d job(s), inserted %d task row(s).",
        jobs_updated,
        tasks_inserted,
    )
    return (jobs_updated, tasks_inserted)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(
        description="Wipe all existing job task rows and reseed the current checklist."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show how many jobs/tasks would be updated, without writing changes.",
    )
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        reseed_tasks_for_all_jobs(db, dry_run=args.dry_run)
    finally:
        db.close()


if __name__ == "__main__":
    main()
