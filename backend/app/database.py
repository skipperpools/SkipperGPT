"""SQLAlchemy engine, session, and Base for ORM models.

The DATABASE_URL is the single point that determines whether we're on SQLite
(local office PC) or Postgres / Supabase (future cloud deploy). Nothing else in
the codebase needs to change to switch.
"""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import PROJECT_ROOT, settings


def _resolve_sqlite_path(database_url: str) -> str:
    """Make the SQLite path absolute relative to the project root.

    Allows running uvicorn from any working directory while still pointing at
    `./data/skipper.db` from the project root. Produces the right URL shape
    on both POSIX (sqlite:////abs/path) and Windows (sqlite:///D:/abs/path).
    """
    prefix = "sqlite:///"
    if not database_url.startswith(prefix):
        return database_url
    raw_path = database_url[len(prefix):]
    # Already absolute on POSIX (leading /) or Windows (drive letter)?
    is_posix_abs = raw_path.startswith("/")
    is_win_abs = len(raw_path) >= 2 and raw_path[1] == ":"
    if is_posix_abs or is_win_abs:
        return database_url
    abs_path = (PROJECT_ROOT / raw_path).resolve()
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    return f"{prefix}{abs_path.as_posix()}"


def _normalize_postgres_scheme(database_url: str) -> str:
    """Force the SQLAlchemy + psycopg-3 driver scheme on Postgres URLs.

    Render Postgres (and many other providers) hands out connection strings as
    `postgres://...` or `postgresql://...`. SQLAlchemy 2 picks the wrong driver
    (psycopg2) for both, while we install psycopg 3. Rewriting the scheme to
    `postgresql+psycopg://...` keeps the rest of the URL (creds, host, query
    params like sslmode) intact.
    """
    for prefix in ("postgres://", "postgresql://"):
        if database_url.startswith(prefix) and not database_url.startswith("postgresql+"):
            return "postgresql+psycopg://" + database_url[len(prefix):]
    return database_url


def _strip_pgbouncer_param(database_url: str) -> str:
    """Drop Supabase template flag unsupported by psycopg connection kwargs."""
    cleaned = database_url.replace("?pgbouncer=true", "?").replace("&pgbouncer=true", "")
    return cleaned.replace("?&", "?").rstrip("?")


def _local_only_database_url() -> str:
    """Use SQLite only for runtime until cloud DB migration is revisited.

    If DATABASE_URL is set to a non-SQLite URL, ignore it intentionally and
    fall back to the project-local SQLite file.
    """
    candidate = settings.database_url.strip()
    if candidate.startswith("sqlite:///"):
        return _resolve_sqlite_path(candidate)
    return _resolve_sqlite_path("sqlite:///./data/skipper.db")


# Cloud DB integration (Postgres/Supabase) is intentionally paused for now.
# Keep helper functions above for later revisit, but force runtime to local SQLite.
#
# Previous runtime URL pipeline:
# _resolved_url = _strip_pgbouncer_param(
#     _prefer_ipv4_hostaddr(_normalize_postgres_scheme(_resolve_sqlite_path(settings.database_url)))
# )
_resolved_url = _local_only_database_url()
_is_sqlite = _resolved_url.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {"prepare_threshold": None}

engine = create_engine(
    _resolved_url,
    echo=False,
    future=True,
    connect_args=_connect_args,
)


@event.listens_for(engine, "connect")
def _enforce_sqlite_fk(dbapi_connection, _connection_record):  # type: ignore[no-redef]
    if _is_sqlite:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency that yields a session and ensures it closes."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def db_dialect() -> str:
    return engine.dialect.name
