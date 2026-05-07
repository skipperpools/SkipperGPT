"""Import job PDFs and images from disk into the database (manual drops under Docs/Photos)."""
from __future__ import annotations

from pathlib import Path

from sqlalchemy.orm import Session

from ..constants import DOC_CATEGORY_FIELD
from ..models import Job
from ..repositories import jobs_repo
from .job_docs_fs import assign_docs_folder_if_needed
from .job_docs_paths import absolute_job_docs_dir, stored_path_for_file
from .job_photos_fs import assign_photos_folder_if_needed
from .job_photos_paths import absolute_job_photos_dir, stored_path_for_file as photo_stored_path_for_file

_MAX_MAGIC_READ = 16_384

_EXT_TO_CT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


def _norm_path(p: str) -> str:
    return p.replace("\\", "/")


def _pdf_magic_ok(data: bytes) -> bool:
    return len(data) >= 4 and data[:4] == b"%PDF"


def _magic_image_ok(data: bytes, ext: str) -> bool:
    low = ext.lower()
    if low in {".jpg", ".jpeg"}:
        return len(data) >= 3 and data[:3] == b"\xff\xd8\xff"
    if low == ".png":
        return len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n"
    if low == ".gif":
        return len(data) >= 6 and data[:6] in {b"GIF87a", b"GIF89a"}
    if low == ".webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


def sync_job_attachments_from_disk(db: Session, job: Job, docs_root: Path) -> None:
    """Ensure Docs/Photos folders exist and register any on-disk files not yet in the DB."""
    assign_docs_folder_if_needed(db, job, docs_root)
    assign_photos_folder_if_needed(db, job, docs_root)

    docs_folder = job.docs_folder_name
    photos_folder = job.photos_folder_name
    if not docs_folder or not photos_folder:
        return

    existing_docs = {_norm_path(d.stored_path) for d in job.documents}
    existing_photos = {_norm_path(p.stored_path) for p in job.photos}

    docs_dir = absolute_job_docs_dir(docs_root, docs_folder)
    if docs_dir.is_dir():
        for entry in docs_dir.iterdir():
            if not entry.is_file():
                continue
            name = entry.name
            if name.startswith("."):
                continue
            if name.lower().endswith(".part"):
                continue
            if not name.lower().endswith(".pdf"):
                continue
            rel = _norm_path(stored_path_for_file(docs_folder, name))
            if rel in existing_docs:
                continue
            try:
                head = entry.read_bytes()[:_MAX_MAGIC_READ]
            except OSError:
                continue
            if not _pdf_magic_ok(head):
                continue
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            jobs_repo.add_job_document(
                db,
                job=job,
                title=(Path(name).stem or "Document")[:255],
                original_filename=name[:250],
                stored_path=rel,
                content_type="application/pdf",
                category=DOC_CATEGORY_FIELD,
                size_bytes=size,
                uploaded_by_user_id=None,
            )
            existing_docs.add(rel)

    photos_dir = absolute_job_photos_dir(docs_root, photos_folder)
    if photos_dir.is_dir():
        for entry in photos_dir.iterdir():
            if not entry.is_file():
                continue
            name = entry.name
            if name.startswith("."):
                continue
            ext = Path(name).suffix.lower()
            if ext not in _EXT_TO_CT:
                continue
            rel = _norm_path(photo_stored_path_for_file(photos_folder, name))
            if rel in existing_photos:
                continue
            try:
                head = entry.read_bytes()[:_MAX_MAGIC_READ]
            except OSError:
                continue
            if not _magic_image_ok(head, ext):
                continue
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            jobs_repo.add_job_photo(
                db,
                job=job,
                original_filename=name[:250],
                stored_path=rel,
                content_type=_EXT_TO_CT[ext],
                size_bytes=size,
                uploaded_by_user_id=None,
            )
            existing_photos.add(rel)
