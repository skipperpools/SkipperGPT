"""FastAPI application entrypoint.

Mounts the static frontend at /, exposes the JSON API under /api, and ensures
database tables exist on startup. Run with:

    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import SQLAlchemyError

from .config import PROJECT_ROOT, settings
from .constants import JOB_TYPE_NEW_CONSTRUCTION
from .database import Base, SessionLocal, engine
from .routers import (
    auth,
    contacts,
    feedback,
    health,
    job_documents,
    job_photos,
    job_sketches,
    jobs,
    notifications,
    push,
    user_task_attachments,
    user_task_notifications,
    user_tasks,
    users,
)

# Import models so SQLAlchemy registers them on Base before create_all.
from . import models  # noqa: F401
from .models import JobDocument, JobPhoto, JobSketch, User  # noqa: F401
from .services.contacts_migration import drop_jobs_contacts_legacy_column, migrate_legacy_json_column
from .services.thumbnails import ensure_pdf_thumbnail, ensure_photo_display, ensure_photo_thumbnail

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("skipper.app")

FRONTEND_DIR = PROJECT_ROOT / "frontend"
GRAPHICS_DIR = PROJECT_ROOT / "graphics"


def _jobs_column_names(conn, dialect: str) -> set[str]:
    """Columns present on table jobs (SQLite vs Postgres)."""
    if dialect == "sqlite":
        rows = conn.exec_driver_sql("PRAGMA table_info(jobs)").fetchall()
        return {row[1] for row in rows}
    result = conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :t"
        ),
        {"t": "jobs"},
    )
    return {row[0] for row in result}


def _notification_items_column_names(conn, dialect: str) -> set[str]:
    """Columns present on table notification_items (SQLite vs Postgres)."""
    if dialect == "sqlite":
        rows = conn.exec_driver_sql("PRAGMA table_info(notification_items)").fetchall()
        return {row[1] for row in rows}
    result = conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :t"
        ),
        {"t": "notification_items"},
    )
    return {row[0] for row in result}


def _job_documents_column_names(conn, dialect: str) -> set[str]:
    """Columns present on table job_documents (SQLite vs Postgres)."""
    if dialect == "sqlite":
        rows = conn.exec_driver_sql("PRAGMA table_info(job_documents)").fetchall()
        return {row[1] for row in rows}
    result = conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :t"
        ),
        {"t": "job_documents"},
    )
    return {row[0] for row in result}


def _job_tasks_column_names(conn, dialect: str) -> set[str]:
    """Columns present on table job_tasks (SQLite vs Postgres)."""
    if dialect == "sqlite":
        rows = conn.exec_driver_sql("PRAGMA table_info(job_tasks)").fetchall()
        return {row[1] for row in rows}
    result = conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :t"
        ),
        {"t": "job_tasks"},
    )
    return {row[0] for row in result}


def _ensure_pool_type_column() -> None:
    """Add pool_type if missing (existing DBs); migrate P/PS misfiled under permit_status."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _jobs_column_names(conn, dialect)
        if "pool_type" not in cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN pool_type VARCHAR(16)"))
            logger.info("Added column jobs.pool_type")
        conn.execute(
            text(
                "UPDATE jobs SET pool_type = TRIM(permit_status), permit_status = NULL "
                "WHERE pool_type IS NULL AND UPPER(TRIM(permit_status)) IN ('P', 'PS')"
            )
        )


def _ensure_docs_folder_name_column() -> None:
    """Add jobs.docs_folder_name if missing (existing SQLite/Postgres DBs)."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _jobs_column_names(conn, dialect)
        if "docs_folder_name" not in cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN docs_folder_name VARCHAR(180)"))
            logger.info("Added column jobs.docs_folder_name")


def _ensure_photos_folder_name_column() -> None:
    """Add jobs.photos_folder_name if missing (existing SQLite/Postgres DBs)."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _jobs_column_names(conn, dialect)
        if "photos_folder_name" not in cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN photos_folder_name VARCHAR(180)"))
            logger.info("Added column jobs.photos_folder_name")


def _ensure_sketches_folder_name_column() -> None:
    """Add jobs.sketches_folder_name if missing (existing SQLite/Postgres DBs)."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _jobs_column_names(conn, dialect)
        if "sketches_folder_name" not in cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN sketches_folder_name VARCHAR(180)"))
            logger.info("Added column jobs.sketches_folder_name")


def _ensure_attachments_synced_at_column() -> None:
    """Add jobs.attachments_synced_at if missing (existing SQLite/Postgres DBs)."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _jobs_column_names(conn, dialect)
        if "attachments_synced_at" not in cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN attachments_synced_at TIMESTAMP"))
            logger.info("Added column jobs.attachments_synced_at")


def _ensure_job_type_column() -> None:
    """Add jobs.job_type if missing and backfill existing rows."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _jobs_column_names(conn, dialect)
        if "job_type" not in cols:
            conn.execute(text("ALTER TABLE jobs ADD COLUMN job_type VARCHAR(32)"))
            logger.info("Added column jobs.job_type")
        conn.execute(
            text(
                "UPDATE jobs SET job_type = :default_job_type "
                "WHERE job_type IS NULL OR TRIM(job_type) = ''"
            ),
            {"default_job_type": JOB_TYPE_NEW_CONSTRUCTION},
        )


def _migrate_legacy_contacts_and_drop_column() -> None:
    """Import legacy jobs.contacts JSON into relational tables; drop column after."""
    dialect = engine.dialect.name
    had_contacts_col = False
    with SessionLocal() as db:
        cols = _jobs_column_names(db.connection(), dialect)
        had_contacts_col = "contacts" in cols
        migrate_legacy_json_column(db, dialect, jobs_has_contacts_column=had_contacts_col)
    if not had_contacts_col:
        return
    try:
        with engine.begin() as conn:
            drop_jobs_contacts_legacy_column(conn, dialect)
        logger.info("Dropped legacy jobs.contacts column")
    except Exception as exc:
        logger.warning("Could not drop legacy jobs.contacts column: %s", exc)


def _ensure_notification_billed_columns() -> None:
    """Add billed-tracking columns to notification_items for existing DBs."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _notification_items_column_names(conn, dialect)
        if "billed" not in cols:
            conn.execute(
                text("ALTER TABLE notification_items ADD COLUMN billed BOOLEAN NOT NULL DEFAULT 0")
            )
            logger.info("Added column notification_items.billed")
        if "billed_at" not in cols:
            conn.execute(text("ALTER TABLE notification_items ADD COLUMN billed_at TIMESTAMP"))
            logger.info("Added column notification_items.billed_at")
        if "billed_by_user_id" not in cols:
            conn.execute(text("ALTER TABLE notification_items ADD COLUMN billed_by_user_id INTEGER"))
            logger.info("Added column notification_items.billed_by_user_id")
        if "completed_by" not in cols:
            conn.execute(text("ALTER TABLE notification_items ADD COLUMN completed_by VARCHAR(128)"))
            logger.info("Added column notification_items.completed_by")


def _user_tasks_column_names(conn, dialect: str) -> set[str]:
    if dialect == "sqlite":
        rows = conn.exec_driver_sql("PRAGMA table_info(user_tasks)").fetchall()
        return {row[1] for row in rows}
    result = conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :t"
        ),
        {"t": "user_tasks"},
    )
    return {row[0] for row in result}


def _users_column_names(conn, dialect: str) -> set[str]:
    if dialect == "sqlite":
        rows = conn.exec_driver_sql("PRAGMA table_info(users)").fetchall()
        return {row[1] for row in rows}
    result = conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = :t"
        ),
        {"t": "users"},
    )
    return {row[0] for row in result}


def _ensure_user_task_assignee_column() -> None:
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _user_tasks_column_names(conn, dialect)
        if "assignee_id" not in cols:
            conn.execute(text("ALTER TABLE user_tasks ADD COLUMN assignee_id INTEGER"))
            logger.info("Added column user_tasks.assignee_id")
        conn.execute(text("UPDATE user_tasks SET assignee_id = user_id WHERE assignee_id IS NULL"))


def _ensure_user_task_is_pinned_column() -> None:
    """Add user_tasks.is_pinned if missing (existing DBs)."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _user_tasks_column_names(conn, dialect)
        if "is_pinned" not in cols:
            conn.execute(
                text("ALTER TABLE user_tasks ADD COLUMN is_pinned BOOLEAN NOT NULL DEFAULT 0")
            )
            logger.info("Added column user_tasks.is_pinned")


def _ensure_user_task_category_column() -> None:
    """Add user_tasks.category if missing (existing DBs)."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _user_tasks_column_names(conn, dialect)
        if "category" not in cols:
            conn.execute(
                text(
                    "ALTER TABLE user_tasks ADD COLUMN category VARCHAR(32) NOT NULL DEFAULT 'general'"
                )
            )
            logger.info("Added column user_tasks.category")


def _ensure_user_push_enabled_column() -> None:
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _users_column_names(conn, dialect)
        if "push_enabled" not in cols:
            conn.execute(
                text("ALTER TABLE users ADD COLUMN push_enabled BOOLEAN NOT NULL DEFAULT 0")
            )
            logger.info("Added column users.push_enabled")


def _ensure_new_user_task_tables() -> None:
    table_names = set(inspect(engine).get_table_names())
    to_create = []
    for model_name in (
        "UserTaskAttachment",
        "UserTaskNotification",
        "PushSubscription",
    ):
        table = getattr(models, model_name).__table__
        if table.name not in table_names:
            to_create.append(table)
    if to_create:
        Base.metadata.create_all(bind=engine, tables=to_create)
        logger.info("Created tables: %s", ", ".join(t.name for t in to_create))


def _ensure_job_document_category_column() -> None:
    """Add job_documents.category if missing and default legacy docs to field."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _job_documents_column_names(conn, dialect)
        if "category" not in cols:
            conn.execute(
                text("ALTER TABLE job_documents ADD COLUMN category VARCHAR(16) NOT NULL DEFAULT 'field'")
            )
            logger.info("Added column job_documents.category")
        conn.execute(
            text(
                "UPDATE job_documents SET category = 'field' "
                "WHERE category IS NULL OR TRIM(category) = ''"
            )
        )


def _ensure_job_notes_table() -> None:
    """Ensure job_notes table exists for older deployments."""
    table_names = set(inspect(engine).get_table_names())
    if "job_notes" not in table_names:
        Base.metadata.create_all(bind=engine, tables=[models.JobNote.__table__])
        logger.info("Created table job_notes")


def _ensure_job_tasks_is_billable_column() -> None:
    """Add job_tasks.is_billable if missing (existing DBs)."""
    dialect = engine.dialect.name
    with engine.begin() as conn:
        cols = _job_tasks_column_names(conn, dialect)
        if "is_billable" not in cols:
            conn.execute(
                text("ALTER TABLE job_tasks ADD COLUMN is_billable BOOLEAN NOT NULL DEFAULT 0")
            )
            logger.info("Added column job_tasks.is_billable")


app = FastAPI(
    title="Skipper Pools - Job Card Dashboard",
    version="0.1.0",
    description="Local-first job card dashboard using project SQLite storage.",
)

# CORS is only needed when the API is consumed from a different origin than
# the FastAPI process serving the static frontend. By default we serve the UI
# at the same origin, so no Access-Control-Allow-Origin header is required.
# Set CORS_ALLOWED_ORIGINS (comma-separated) in the env to opt in.
if settings.cors_allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allowed_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.middleware("http")
async def _set_frontend_cache_headers(request: Request, call_next):
    """Avoid sticky mobile browser caches for frontend shell/assets."""
    response = await call_next(request)
    path = request.url.path
    if path in {"/", "/index.html", "/app.js", "/sketch-editor.js", "/styles.css", "/sw.js"}:
        # Force revalidation so users see fresh UI without clearing browser data.
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.on_event("startup")
def _on_startup() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_job_notes_table()
    _ensure_pool_type_column()
    _ensure_job_type_column()
    _ensure_docs_folder_name_column()
    _ensure_photos_folder_name_column()
    _ensure_sketches_folder_name_column()
    _ensure_attachments_synced_at_column()
    _migrate_legacy_contacts_and_drop_column()
    _ensure_notification_billed_columns()
    _ensure_user_task_assignee_column()
    _ensure_user_task_is_pinned_column()
    _ensure_user_task_category_column()
    _ensure_user_push_enabled_column()
    _ensure_new_user_task_tables()
    _ensure_job_document_category_column()
    _ensure_job_tasks_is_billable_column()
    logger.info(
        "Skipper dashboard ready | env=%s dialect=%s db=%s",
        settings.app_env,
        engine.dialect.name,
        engine.url,
    )


async def _backfill_thumbnails_loop() -> None:
    loop = asyncio.get_running_loop()
    try:
        with SessionLocal() as db:
            photos = list(db.scalars(select(JobPhoto.stored_path)).all())
            docs = list(db.scalars(select(JobDocument.stored_path)).all())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            for sp in photos:
                await loop.run_in_executor(pool, ensure_photo_thumbnail, settings.docs_root, sp)
                await loop.run_in_executor(pool, ensure_photo_display, settings.docs_root, sp)
            for sp in docs:
                await loop.run_in_executor(pool, ensure_pdf_thumbnail, settings.docs_root, sp)
        logger.info("Thumbnail backfill complete (%s photos, %s documents)", len(photos), len(docs))
    except Exception:
        logger.exception("Thumbnail backfill failed")


@app.on_event("startup")
async def _thumbnail_backfill_startup() -> None:
    asyncio.create_task(_backfill_thumbnails_loop())


@app.exception_handler(SQLAlchemyError)
async def _sqlalchemy_error_handler(_request: Request, exc: SQLAlchemyError) -> JSONResponse:
    logger.exception("Database error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Database error"})


@app.exception_handler(RequestValidationError)
async def _validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


app.include_router(health.router)
app.include_router(auth.router)
app.include_router(contacts.router)
app.include_router(jobs.router)
app.include_router(job_documents.router, prefix="/api/jobs")
app.include_router(job_photos.router, prefix="/api/jobs")
app.include_router(job_sketches.router, prefix="/api/jobs")
app.include_router(users.router)
app.include_router(feedback.router)
app.include_router(user_tasks.router)
app.include_router(user_task_attachments.router)
app.include_router(user_task_notifications.router)
app.include_router(notifications.router)
app.include_router(push.router)


# Shared brand assets (favicon, logos) live next to the repo root `graphics/` folder.
if GRAPHICS_DIR.exists():
    app.mount("/graphics", StaticFiles(directory=str(GRAPHICS_DIR)), name="graphics")

# Serve the static frontend. Mounting at "/" with html=True lets index.html
# load directly at http://localhost:8000/.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    @app.get("/")
    def _missing_frontend() -> FileResponse:
        raise RuntimeError(f"Frontend directory missing at {FRONTEND_DIR}")
