"""Job PDF documents under {docs_root}/Docs/<job folder>/."""
from __future__ import annotations

from pathlib import Path
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..constants import DOC_CATEGORY_FIELD, VALID_DOC_CATEGORIES
from ..database import SessionLocal, get_db
from ..deps.auth import get_current_user, require_roles
from ..models import User
from ..repositories import jobs_repo
from ..schemas import JobDocumentRead, JobDocumentUpdate, JobRead
from ..services.job_disk_sync import sync_job_attachments_from_disk
from ..services.job_docs_fs import (
    absolute_file_path,
    delete_document_file,
    remove_empty_job_doc_dir,
    write_pdf_upload,
)
from ..services.thumbnails import ensure_pdf_thumbnail
from ..services.jobs_service import to_job_read

router = APIRouter(tags=["job-documents"])


def _pdf_magic_ok(data: bytes) -> bool:
    return len(data) >= 4 and data[:4] == b"%PDF"


@router.get("/{job_id}/documents", response_model=List[JobDocumentRead])
def list_job_documents(
    job_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[JobDocumentRead]:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sync_job_attachments_from_disk(db, job, settings.docs_root)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job).documents


@router.post("/{job_id}/documents", response_model=JobRead)
async def upload_job_document(
    job_id: int,
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    title: str | None = Form(None),
    category: str = Form(DOC_CATEGORY_FIELD),
    user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one file is required",
        )
    normalized_category = (category or DOC_CATEGORY_FIELD).strip().lower() or DOC_CATEGORY_FIELD
    if normalized_category not in VALID_DOC_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"category must be one of {sorted(VALID_DOC_CATEGORIES)}",
        )

    max_bytes = settings.max_upload_mb * 1024 * 1024
    prepared_files: list[tuple[str, bytes, str]] = []
    for upload in files:
        orig = (upload.filename or "document.pdf").strip()
        if not orig.lower().endswith(".pdf"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only PDF files are allowed",
            )

        ct = (upload.content_type or "").lower()
        if ct and "pdf" not in ct and ct != "application/octet-stream":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="File must be a PDF",
            )

        data = await upload.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File too large (max {settings.max_upload_mb} MB)",
            )
        if not _pdf_magic_ok(data):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Not a valid PDF file",
            )

        # Single explicit title only applies to single-file uploads.
        display_title = (
            (title or "").strip() if len(files) == 1 else ""
        ) or Path(orig).stem or "Document"
        prepared_files.append((orig, data, display_title))

    try:
        for orig, data, display_title in prepared_files:
            new_doc = write_pdf_upload(
                db,
                job=job,
                docs_root=settings.docs_root,
                data=data,
                original_filename=orig[:250],
                title=display_title[:255],
                content_type="application/pdf",
                category=normalized_category,
                uploaded_by_user_id=user.id,
            )
            background_tasks.add_task(
                ensure_pdf_thumbnail,
                settings.docs_root,
                new_doc.stored_path,
            )
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.get("/{job_id}/documents/{document_id}/thumbnail")
def download_job_document_thumbnail(
    job_id: int,
    document_id: int,
    _user: User = Depends(get_current_user),
) -> FileResponse:
    with SessionLocal() as db:
        job = jobs_repo.get_job(db, job_id)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
        doc = jobs_repo.get_job_document(db, job_id=job_id, document_id=document_id)
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
        stored_path = doc.stored_path
    thumb = ensure_pdf_thumbnail(settings.docs_root, stored_path)
    if thumb is None or not thumb.is_file():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not generate thumbnail",
        )
    return FileResponse(
        thumb,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/{job_id}/documents/{document_id}/file")
def download_job_document(
    job_id: int,
    document_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    doc = jobs_repo.get_job_document(db, job_id=job_id, document_id=document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    try:
        path = absolute_file_path(settings.docs_root, doc.stored_path)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid document path",
        ) from exc
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File missing on server",
        )
    safe_name = doc.original_filename or f"{doc.title}.pdf"
    if not safe_name.lower().endswith(".pdf"):
        safe_name = f"{safe_name}.pdf"
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=safe_name,
        content_disposition_type="attachment",
    )


@router.delete("/{job_id}/documents/{document_id}", response_model=JobRead)
def delete_job_document_route(
    job_id: int,
    document_id: int,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    doc = jobs_repo.get_job_document(db, job_id=job_id, document_id=document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    try:
        delete_document_file(settings.docs_root, doc)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid document path",
        ) from exc

    jobs_repo.delete_job_document(db, doc=doc)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    remove_empty_job_doc_dir(settings.docs_root, job)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.patch("/{job_id}/documents/{document_id}", response_model=JobRead)
def update_job_document_route(
    job_id: int,
    document_id: int,
    payload: JobDocumentUpdate,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    doc = jobs_repo.get_job_document(db, job_id=job_id, document_id=document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    new_title = payload.title.strip()
    if not new_title:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Title cannot be empty",
        )
    jobs_repo.update_job_document_title(db, doc=doc, title=new_title[:255])

    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)
