"""Filesystem paths for job photos under {docs_root}/Photos/<folder_name>/."""
from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Job

_PHOTOS_SEGMENT = "Photos"
_MAX_BASE_LEN = 120
_WIN_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_customer_to_folder_base(customer_name: str) -> str:
    """Slug customer_name for a single path segment (before uniqueness suffix)."""
    raw = (customer_name or "").strip()
    raw = _WIN_FORBIDDEN.sub("_", raw)
    raw = re.sub(r"\s+", "_", raw)
    raw = raw.strip("._ ")
    if not raw:
        return ""
    if len(raw) > _MAX_BASE_LEN:
        raw = raw[:_MAX_BASE_LEN].rstrip("._ ")
    return raw or ""


def photos_dir_relative(folder_name: str) -> str:
    return f"{_PHOTOS_SEGMENT}/{folder_name}"


def absolute_job_photos_dir(docs_root: Path, folder_name: str) -> Path:
    return (Path(docs_root) / _PHOTOS_SEGMENT / folder_name).resolve()


def stored_path_for_file(folder_name: str, filename: str) -> str:
    """POSIX-style relative path under docs_root."""
    return f"{_PHOTOS_SEGMENT}/{folder_name}/{filename}"


def exclusive_photos_folder_name(db: Session, job_id: int, customer_name: str) -> str:
    """Folder name for this job; appends __{job_id} if another job already uses the base slug."""
    base = sanitize_customer_to_folder_base(customer_name)
    if not base:
        base = f"job_{job_id}"
    stmt = select(Job.id).where(Job.photos_folder_name == base, Job.id != job_id)
    taken = db.execute(stmt).scalar_one_or_none() is not None
    if not taken:
        return base
    suffix = f"__{job_id}"
    max_base = _MAX_BASE_LEN - len(suffix)
    trimmed = base[:max_base].rstrip("._ ") if max_base > 0 else ""
    if not trimmed:
        trimmed = f"job_{job_id}"
    return f"{trimmed}{suffix}"
