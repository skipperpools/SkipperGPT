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
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError

from .config import PROJECT_ROOT, settings
from .database import Base, SessionLocal, engine
from .routers import auth, contacts, feedback, health, job_documents, job_photos, jobs, notifications, users

# Import models so SQLAlchemy registers them on Base before create_all.
from . import models  # noqa: F401
from .models import JobDocument, JobPhoto, User  # noqa: F401
from .services.contacts_migration import drop_jobs_contacts_legacy_column, migrate_legacy_json_column
from .services.thumbnails import ensure_pdf_thumbnail, ensure_photo_thumbnail

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("skipper.app")

FRONTEND_DIR = PROJECT_ROOT / "frontend"


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
    if path in {"/", "/index.html", "/app.js", "/styles.css"}:
        # Force revalidation so users see fresh UI without clearing browser data.
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.on_event("startup")
def _on_startup() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_pool_type_column()
    _ensure_docs_folder_name_column()
    _ensure_photos_folder_name_column()
    _migrate_legacy_contacts_and_drop_column()
    _ensure_notification_billed_columns()
    _ensure_job_document_category_column()
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
app.include_router(users.router)
app.include_router(feedback.router)
app.include_router(notifications.router)


# Serve the static frontend. Mounting at "/" with html=True lets index.html
# load directly at http://localhost:8000/.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    @app.get("/")
    def _missing_frontend() -> FileResponse:
        raise RuntimeError(f"Frontend directory missing at {FRONTEND_DIR}")
