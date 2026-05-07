"""Filesystem operations for job PDFs (paths relative to docs_root)."""
from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from ..models import Job, JobDocument
from ..repositories import jobs_repo
from .job_docs_paths import absolute_job_docs_dir, exclusive_docs_folder_name, stored_path_for_file

_DOCS_PREFIX = "Docs"


def _is_under_docs_root(docs_root: Path, candidate: Path) -> bool:
    root = (docs_root / _DOCS_PREFIX).resolve()
    try:
        candidate.resolve().relative_to(root)
        return True
    except ValueError:
        return False


def absolute_file_path(docs_root: Path, stored_path: str) -> Path:
    """Resolve stored_path; raise if outside Docs/ under docs_root."""
    p = (Path(docs_root) / stored_path.replace("\\", "/")).resolve()
    if not _is_under_docs_root(docs_root, p):
        raise ValueError("Invalid stored_path")
    return p


def ensure_job_docs_folder(docs_root: Path, folder_name: str) -> Path:
    d = absolute_job_docs_dir(docs_root, folder_name)
    d.mkdir(parents=True, exist_ok=True)
    return d


def assign_docs_folder_if_needed(db: Session, job: Job, docs_root: Path) -> str:
    """Set job.docs_folder_name and return folder name."""
    name = exclusive_docs_folder_name(db, job.id, job.customer_name)
    if job.docs_folder_name != name:
        job.docs_folder_name = name
        db.add(job)
        db.commit()
        db.refresh(job)
    ensure_job_docs_folder(docs_root, name)
    return name


def move_job_docs_on_rename(
    db: Session,
    *,
    job: Job,
    new_customer_name: str,
    docs_root: Path,
) -> None:
    """When customer_name changes, move Docs folder and update rows."""
    if job.docs_folder_name is None:
        return
    new_folder = exclusive_docs_folder_name(db, job.id, new_customer_name)
    if new_folder == job.docs_folder_name:
        return

    old_dir = absolute_job_docs_dir(docs_root, job.docs_folder_name)
    new_dir = absolute_job_docs_dir(docs_root, new_folder)

    if old_dir.is_dir():
        if new_dir.exists():
            raise OSError(f"Target docs folder already exists: {new_dir}")
        new_dir.parent.mkdir(parents=True, exist_ok=True)
        old_dir.rename(new_dir)

    old_prefix = f"{_DOCS_PREFIX}/{job.docs_folder_name}/"
    new_prefix = f"{_DOCS_PREFIX}/{new_folder}/"
    for doc in job.documents:
        if doc.stored_path.startswith(old_prefix):
            doc.stored_path = new_prefix + doc.stored_path[len(old_prefix) :]

    job.docs_folder_name = new_folder
    db.add(job)
    db.commit()
    db.refresh(job)


def write_pdf_upload(
    db: Session,
    *,
    job: Job,
    docs_root: Path,
    data: bytes,
    original_filename: str,
    title: str,
    content_type: str,
    category: str,
    uploaded_by_user_id: int | None,
) -> JobDocument:
    folder = assign_docs_folder_if_needed(db, job, docs_root)
    disk_name = f"{uuid.uuid4().hex}.pdf"
    dest_dir = ensure_job_docs_folder(docs_root, folder)
    dest_path = dest_dir / disk_name
    tmp = dest_path.with_suffix(".pdf.part")
    try:
        tmp.write_bytes(data)
        tmp.replace(dest_path)
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise

    rel = stored_path_for_file(folder, disk_name)
    return jobs_repo.add_job_document(
        db,
        job=job,
        title=title,
        original_filename=original_filename,
        stored_path=rel,
        content_type=content_type,
        category=category,
        size_bytes=len(data),
        uploaded_by_user_id=uploaded_by_user_id,
    )


def delete_document_file(docs_root: Path, doc: JobDocument) -> None:
    from .thumbnails import delete_thumbnail_for  # noqa: PLC0415 — avoid circular import

    delete_thumbnail_for(docs_root, doc.stored_path, "document")
    p = absolute_file_path(docs_root, doc.stored_path)
    if p.is_file():
        p.unlink()


def remove_empty_job_doc_dir(docs_root: Path, job: Job) -> None:
    if not job.docs_folder_name:
        return
    d = absolute_job_docs_dir(docs_root, job.docs_folder_name)
    thumbs = d / ".thumbs"
    if thumbs.is_dir() and not any(thumbs.iterdir()):
        thumbs.rmdir()
    if d.is_dir() and not any(d.iterdir()):
        d.rmdir()
