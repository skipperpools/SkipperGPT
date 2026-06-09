"""One-shot copy of all rows from a local SQLite database into a fresh Postgres
database (Supabase / Render Postgres) while preserving primary keys.

Run from the `backend/` directory **on your local machine**, with
``DATABASE_URL`` pointed at the *target* Postgres instance (Render's external
connection string works fine):

    # PowerShell
    $env:DATABASE_URL = "postgresql+psycopg://USER:PASS@HOST:5432/skipper"
    python -m app.migrate_sqlite_to_postgres --source ../data/skipper.db

    # bash
    DATABASE_URL='postgresql+psycopg://USER:PASS@HOST:5432/skipper' \
        python -m app.migrate_sqlite_to_postgres --source ../data/skipper.db

The script:

* Refuses to run unless the target ``DATABASE_URL`` resolves to Postgres.
* Refuses to overwrite an already-populated target unless ``--force`` is
  passed (which truncates everything in dependency-safe order first).
* Copies rows table-by-table in FK dependency order, preserving ``id`` values.
* Resets each table's serial sequence so future inserts don't collide.

Pre-flight: make sure your source SQLite has been opened by the running app at
least once recently, so all ``_ensure_*`` schema migrations from
``app.main`` have been applied. Otherwise legacy databases may be missing
columns like ``pool_type`` or ``billed`` and the SELECT will fail.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import List

from sqlalchemy import Table, create_engine, insert, select, text
from sqlalchemy.orm import Session

from .config import PROJECT_ROOT
from .database import Base, _normalize_postgres_scheme

# Import models so SQLAlchemy registers them on Base.metadata.
from . import models  # noqa: F401

logger = logging.getLogger("skipper.migrate")


# Parents first; FK children later. Matches the foreign keys defined in models.py.
TABLE_ORDER: List[str] = [
    "users",
    "contacts",
    "jobs",
    "job_contacts",
    "job_type_task_templates",
    "job_tasks",
    "job_notes",
    "job_documents",
    "job_photos",
    "job_sketches",
    "feedback_items",
    "user_tasks",
    "user_task_attachments",
    "user_task_notifications",
    "push_subscriptions",
    "notification_items",
]


def _resolve_source_url(source: Path) -> str:
    """Build a SQLite SQLAlchemy URL for the given file path."""
    abs_path = source.expanduser().resolve()
    if not abs_path.is_file():
        raise FileNotFoundError(f"Source SQLite file not found: {abs_path}")
    return f"sqlite:///{abs_path.as_posix()}"


def _table_for(name: str) -> Table:
    table = Base.metadata.tables.get(name)
    if table is None:
        raise KeyError(f"Unknown table {name!r} (not registered on Base.metadata)")
    return table


def _truncate_target_tables(target_db: Session) -> None:
    """Wipe rows from every target table in reverse dependency order."""
    for name in reversed(TABLE_ORDER):
        target_db.execute(text(f'TRUNCATE TABLE "{name}" RESTART IDENTITY CASCADE'))
    logger.info("Truncated %d target table(s).", len(TABLE_ORDER))


def _target_has_any_rows(target_db: Session) -> bool:
    for name in TABLE_ORDER:
        count = target_db.execute(text(f'SELECT COUNT(*) FROM "{name}"')).scalar_one()
        if count and count > 0:
            return True
    return False


def _copy_table(src_db: Session, target_db: Session, name: str) -> int:
    table = _table_for(name)
    rows = src_db.execute(select(table)).mappings().all()
    if not rows:
        logger.info("  %s: 0 rows", name)
        return 0
    payload = [dict(r) for r in rows]
    target_db.execute(insert(table), payload)
    logger.info("  %s: copied %d row(s)", name, len(payload))
    return len(payload)


def _reset_sequence(target_db: Session, name: str) -> None:
    """Advance the table's id sequence to MAX(id) so future inserts don't collide."""
    table = _table_for(name)
    if "id" not in table.columns:
        return
    max_id = target_db.execute(text(f'SELECT MAX(id) FROM "{name}"')).scalar()
    if max_id is None:
        return
    target_db.execute(
        text(
            "SELECT setval(pg_get_serial_sequence(:tname, 'id'), :max_id)"
        ),
        {"tname": name, "max_id": int(max_id)},
    )


def migrate(source_url: str, target_url: str, force: bool) -> None:
    src_engine = create_engine(source_url, future=True)
    tgt_engine = create_engine(target_url, future=True)

    if not tgt_engine.dialect.name.startswith("postgres"):
        raise SystemExit(
            f"Target DATABASE_URL must be Postgres (got dialect "
            f"{tgt_engine.dialect.name!r}). Refusing to run."
        )

    logger.info("Source : %s", source_url)
    logger.info("Target : %s (%s)", tgt_engine.url, tgt_engine.dialect.name)

    Base.metadata.create_all(bind=tgt_engine)

    with Session(tgt_engine, future=True) as target_db:
        if _target_has_any_rows(target_db):
            if not force:
                raise SystemExit(
                    "Target database is not empty. Re-run with --force to "
                    "TRUNCATE all tables before importing."
                )
            _truncate_target_tables(target_db)
            target_db.commit()

    total = 0
    with Session(src_engine, future=True) as src_db, Session(tgt_engine, future=True) as target_db:
        try:
            logger.info("Copying rows...")
            for name in TABLE_ORDER:
                total += _copy_table(src_db, target_db, name)
            logger.info("Resetting sequences...")
            for name in TABLE_ORDER:
                _reset_sequence(target_db, name)
            target_db.commit()
        except Exception:
            target_db.rollback()
            raise

    logger.info("Migration complete: %d total row(s) copied.", total)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(
        description="Copy a Skipper Pools SQLite database into a fresh Postgres DB.",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=PROJECT_ROOT / "data" / "skipper.db",
        help="Path to the source SQLite file (default: <project>/data/skipper.db).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="TRUNCATE all target tables before importing (destructive).",
    )
    args = parser.parse_args()

    raw_target = os.environ.get("DATABASE_URL", "").strip()
    if not raw_target:
        raise SystemExit(
            "DATABASE_URL is not set. Point it at the target Postgres database "
            "(e.g. Render's external connection string) before running."
        )
    target_url = _normalize_postgres_scheme(raw_target)

    try:
        source_url = _resolve_source_url(args.source)
    except FileNotFoundError as exc:
        raise SystemExit(str(exc))

    migrate(source_url=source_url, target_url=target_url, force=args.force)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        logger.exception("Migration failed")
        sys.exit(1)
    sys.exit(0)
