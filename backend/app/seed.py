"""Database seeder for the Job Card Dashboard.

Run from the `backend/` directory:

    python -m app.seed
    python -m app.seed --reset
    python -m app.seed --reset --excel "D:\\SkipperGPT\\Schedules.xlsx"
    python -m app.seed --sample
    python -m app.seed --ensure-admin myuser mypassword

By default, if `Schedules.xlsx` exists at the project root (or `SCHEDULE_XLSX_PATH`),
jobs are imported from the **Schedules** sheet. Otherwise four demo jobs are used.

Use `--reset` to wipe all jobs/tasks and reload (destructive).
"""
from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy import delete
from sqlalchemy.orm import Session

from .constants import STATUS_COMPLETED, STATUS_IN_PROGRESS, STATUS_ISSUE
from .database import Base, SessionLocal, engine
from .models import Job, JobTask, User  # noqa: F401 — User registers with Base.metadata
from .repositories import users_repo
from .schedule_excel import (
    build_job_tasks_from_states,
    default_excel_path,
    load_jobs_from_excel,
)

logger = logging.getLogger("skipper.seed")


def _utc_date(iso: str) -> datetime:
    d = datetime.fromisoformat(iso)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def _completed_on(iso_date: str) -> dict:
    dt = _utc_date(iso_date)
    return {
        "status": STATUS_COMPLETED,
        "value": iso_date,
        "completed_at": dt,
        "note": None,
    }


def _in_progress(value: str = "", note: str = "") -> dict:
    return {
        "status": STATUS_IN_PROGRESS,
        "value": value or None,
        "completed_at": None,
        "note": note or None,
    }


def _issue(value: str = "", note: str = "") -> dict:
    return {
        "status": STATUS_ISSUE,
        "value": value or None,
        "completed_at": None,
        "note": note or None,
    }


def _make_demo_tasks(states: Dict[str, dict]) -> List[JobTask]:
    """Build tasks with explicit states; missing keys default to not_started."""
    return build_job_tasks_from_states(states)


def build_sample_jobs() -> List[Job]:
    """Four synthetic jobs (used when no Excel file is available)."""
    anderson_states = {
        "permit_application": _completed_on("2026-02-01"),
        "permit_received": _completed_on("2026-02-14"),
        "excavation": _completed_on("2026-02-18"),
        "form_steel": _completed_on("2026-02-20"),
        "qi_1": _completed_on("2026-02-21"),
        "gunite": _completed_on("2026-03-01"),
        "qi_2": _completed_on("2026-03-02"),
        "survey": _completed_on("2026-03-04"),
        "backfill": _completed_on("2026-03-08"),
        "plumbing": _completed_on("2026-03-11"),
        "qi_3": _completed_on("2026-03-14"),
        "electrical_inspection": _completed_on("2026-03-15"),
        "coping": _completed_on("2026-03-20"),
        "tile": _completed_on("2026-03-25"),
        "qi_4": _in_progress("Scheduled 2026-05-06", "Inspector confirmed for Wed"),
    }
    anderson = Job(
        customer_name="Anderson Residence",
        address="123 Lakeview Dr, Tampa, FL 33602",
        permit_status="Issued",
        permit_number="HC-2026-018473",
        field_manager="Jorge Ramirez",
        notes="Homeowner prefers morning crews. Gate code 4421.",
        tasks=_make_demo_tasks(anderson_states),
    )

    martinez_states = {
        "permit_application": _completed_on("2026-03-15"),
        "permit_received": _completed_on("2026-04-02"),
        "excavation": _completed_on("2026-04-10"),
        "form_steel": _completed_on("2026-04-14"),
        "qi_1": _completed_on("2026-04-16"),
        "gunite": _in_progress("Scheduled 2026-05-08"),
    }
    martinez = Job(
        customer_name="Martinez Pool Build",
        address="456 Palm Ct, St. Petersburg, FL 33701",
        permit_status="Issued",
        permit_number="PIN-2026-009912",
        field_manager="Travis Whitley",
        notes="Tight backyard access - small skid steer only.",
        tasks=_make_demo_tasks(martinez_states),
    )

    thompson_states = {
        "permit_application": _in_progress("Submitted 2026-04-28"),
    }
    thompson = Job(
        customer_name="Thompson Family",
        address="789 Oak Ridge Ln, Brandon, FL 33511",
        permit_status="Pending",
        permit_number=None,
        field_manager="Casey O'Neil",
        notes="Awaiting permit. Survey on file.",
        tasks=_make_demo_tasks(thompson_states),
    )

    williams_states = {
        "permit_application": _completed_on("2025-11-04"),
        "permit_received": _completed_on("2025-11-22"),
        "excavation": _completed_on("2025-11-28"),
        "form_steel": _completed_on("2025-12-01"),
        "qi_1": _completed_on("2025-12-03"),
        "gunite": _completed_on("2025-12-15"),
        "qi_2": _completed_on("2025-12-16"),
        "survey": _completed_on("2025-12-18"),
        "backfill": _completed_on("2026-01-05"),
        "plumbing": _completed_on("2026-01-08"),
        "qi_3": _completed_on("2026-01-10"),
        "electrical_inspection": _completed_on("2026-01-12"),
        "coping": _completed_on("2026-01-20"),
        "tile": _completed_on("2026-01-28"),
        "qi_4": _completed_on("2026-02-01"),
        "rail_anchor_grid_inspection": _completed_on("2026-02-04"),
        "inspection": _completed_on("2026-02-08"),
        "water_subdeck_installation": _completed_on("2026-02-15"),
        "qi_5": _completed_on("2026-02-17"),
        "equipment_installation": _issue(
            "Heater RMA pending",
            "Heater arrived damaged - waiting on replacement from supplier.",
        ),
        "equipment_wiring": _completed_on("2026-03-22"),
        "qi_6": _completed_on("2026-03-24"),
        "screen_fence": _completed_on("2026-04-05"),
        "electric_inspection": _completed_on("2026-04-08"),
        "safety_inspection": _completed_on("2026-04-15"),
        "plaster": _completed_on("2026-04-22"),
    }
    williams = Job(
        customer_name="Williams Estate",
        address="321 Bayshore Blvd, Tampa, FL 33606",
        permit_status="Issued",
        permit_number="HC-2025-094218",
        field_manager="Jorge Ramirez",
        notes="Premium build. Customer wants weekly photo updates.",
        tasks=_make_demo_tasks(williams_states),
    )

    return [anderson, martinez, thompson, williams]


def choose_jobs(
    *,
    use_sample: bool,
    excel_path: Optional[Path],
) -> List[Job]:
    """Excel master schedule if present, unless `--sample` forces demos."""
    if use_sample:
        logger.info("Using built-in demo jobs (--sample).")
        return build_sample_jobs()

    if excel_path is not None:
        logger.info("Loading jobs from Excel (--excel): %s", excel_path.resolve())
        return load_jobs_from_excel(excel_path.resolve())

    p = default_excel_path()
    if p.is_file():
        logger.info("Loading jobs from Excel: %s", p)
        return load_jobs_from_excel(p)

    logger.warning(
        "No Schedules.xlsx found at %s — using built-in demo jobs.", p
    )
    return build_sample_jobs()


def seed(
    db: Session,
    *,
    reset: bool = False,
    use_sample: bool = False,
    excel_path: Optional[Path] = None,
) -> int:
    if reset:
        # SQLite CASCADE removes job_tasks when their job is deleted.
        db.execute(delete(Job))
        db.commit()
        logger.info("Reset: cleared all jobs and tasks.")

    existing = db.query(Job).count()
    if existing > 0 and not reset:
        logger.info("Seed skipped: %d job(s) already in database.", existing)
        return 0

    jobs = choose_jobs(use_sample=use_sample, excel_path=excel_path)
    for job in jobs:
        db.add(job)
    db.commit()
    logger.info("Seeded %d job(s).", len(jobs))
    return len(jobs)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Seed Skipper Pools job dashboard data.")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete ALL jobs and tasks, then import fresh data (destructive).",
    )
    parser.add_argument(
        "--sample",
        action="store_true",
        help="Force the four built-in demo jobs instead of Schedules.xlsx.",
    )
    parser.add_argument(
        "--excel",
        type=Path,
        default=None,
        help="Path to Schedules.xlsx (overrides SCHEDULE_XLSX_PATH / default).",
    )
    parser.add_argument(
        "--ensure-admin",
        nargs=2,
        metavar=("USERNAME", "PASSWORD"),
        help="If the users table is empty, create an admin with this username and password.",
    )
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if args.ensure_admin:
            uname, pwd = args.ensure_admin[0], args.ensure_admin[1]
            if users_repo.ensure_first_admin(db, uname, pwd):
                logger.info("Created initial admin user %r.", uname)
            else:
                logger.info(
                    "ensure-admin skipped: at least one user already exists (no changes).",
                )
        seed(
            db,
            reset=args.reset,
            use_sample=args.sample,
            excel_path=args.excel,
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
