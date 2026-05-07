"""Filesystem operations for job photos (paths relative to docs_root)."""
from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import Job, JobPhoto
from ..repositories import jobs_repo
from .job_photos_paths import (
    absolute_job_photos_dir,
    exclusive_photos_folder_name,
    stored_path_for_file,
)

_PHOTOS_PREFIX = "Photos"


def _is_under_photos_root(docs_root: Path, candidate: Path) -> bool:
    root = (docs_root / _PHOTOS_PREFIX).resolve()
    try:
        candidate.resolve().relative_to(root)
        return True
    except ValueError:
        return False


def absolute_file_path(docs_root: Path, stored_path: str) -> Path:
    """Resolve stored_path; raise if outside Photos/ under docs_root."""
    p = (Path(docs_root) / stored_path.replace("\\", "/")).resolve()
    if not _is_under_photos_root(docs_root, p):
        raise ValueError("Invalid stored_path")
    return p


def ensure_job_photos_folder(docs_root: Path, folder_name: str) -> Path:
    d = absolute_job_photos_dir(docs_root, folder_name)
    d.mkdir(parents=True, exist_ok=True)
    return d


def assign_photos_folder_if_needed(db: Session, job: Job, docs_root: Path) -> str:
    """Set job.photos_folder_name and return folder name."""
    name = exclusive_photos_folder_name(db, job.id, job.customer_name)
    if job.photos_folder_name != name:
        job.photos_folder_name = name
        db.add(job)
        db.commit()
        db.refresh(job)
    ensure_job_photos_folder(docs_root, name)
    return name


def move_job_photos_on_rename(
    db: Session,
    *,
    job: Job,
    new_customer_name: str,
    docs_root: Path,
) -> None:
    """When customer_name changes, move Photos folder and update rows."""
    if job.photos_folder_name is None:
        return
    new_folder = exclusive_photos_folder_name(db, job.id, new_customer_name)
    if new_folder == job.photos_folder_name:
        return

    old_dir = absolute_job_photos_dir(docs_root, job.photos_folder_name)
    new_dir = absolute_job_photos_dir(docs_root, new_folder)

    if old_dir.is_dir():
        if new_dir.exists():
            raise OSError(f"Target photos folder already exists: {new_dir}")
        new_dir.parent.mkdir(parents=True, exist_ok=True)
        old_dir.rename(new_dir)

    old_prefix = f"{_PHOTOS_PREFIX}/{job.photos_folder_name}/"
    new_prefix = f"{_PHOTOS_PREFIX}/{new_folder}/"
    for photo in job.photos:
        if photo.stored_path.startswith(old_prefix):
            photo.stored_path = new_prefix + photo.stored_path[len(old_prefix) :]

    job.photos_folder_name = new_folder
    db.add(job)
    db.commit()
    db.refresh(job)


def write_photo_upload(
    db: Session,
    *,
    job: Job,
    docs_root: Path,
    data: bytes,
    original_filename: str,
    ext: str,
    content_type: str,
    uploaded_by_user_id: int | None,
) -> JobPhoto:
    folder = assign_photos_folder_if_needed(db, job, docs_root)
    safe_ext = ext if ext.startswith(".") else f".{ext}"
    disk_name = f"{uuid.uuid4().hex}{safe_ext.lower()}"
    dest_dir = ensure_job_photos_folder(docs_root, folder)
    dest_path = dest_dir / disk_name
    tmp = dest_path.with_suffix(f"{dest_path.suffix}.part")
    try:
        tmp.write_bytes(data)
        tmp.replace(dest_path)
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise

    rel = stored_path_for_file(folder, disk_name)
    return jobs_repo.add_job_photo(
        db,
        job=job,
        original_filename=original_filename,
        stored_path=rel,
        content_type=content_type,
        size_bytes=len(data),
        uploaded_by_user_id=uploaded_by_user_id,
    )


def delete_photo_file(docs_root: Path, photo: JobPhoto) -> None:
    from .thumbnails import delete_thumbnail_for  # noqa: PLC0415 — avoid circular import

    delete_thumbnail_for(docs_root, photo.stored_path, "photo")
    p = absolute_file_path(docs_root, photo.stored_path)
    if p.is_file():
        p.unlink()


def remove_empty_job_photo_dir(docs_root: Path, job: Job) -> None:
    if not job.photos_folder_name:
        return
    d = absolute_job_photos_dir(docs_root, job.photos_folder_name)
    thumbs = d / ".thumbs"
    if thumbs.is_dir() and not any(thumbs.iterdir()):
        thumbs.rmdir()
    if d.is_dir() and not any(d.iterdir()):
        d.rmdir()
