"""User task image/PDF attachments."""
from __future__ import annotations

import io
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
    _HEIF_SUPPORT = True
except Exception:
    _HEIF_SUPPORT = False

from ..config import settings
from ..constants import USER_TASK_ATTACHMENT_KIND_IMAGE, USER_TASK_ATTACHMENT_KIND_PDF
from ..database import get_db
from ..deps.auth import get_current_user
from ..models import User
from ..repositories import user_task_attachments_repo, user_tasks_repo
from ..schemas import UserTaskAttachmentRead
from ..services.thumbnails import ensure_pdf_thumbnail, ensure_photo_thumbnail
from ..services.user_task_attachments_fs import (
    absolute_file_path,
    delete_attachment_file,
    write_attachment_upload,
)
from .user_tasks import _can_access_task, _can_modify_attachments, _get_task_or_404

router = APIRouter(prefix="/api/user-tasks", tags=["user-task-attachments"])

_EXT_TO_CT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
}
_VALID_CONTENT_TYPES = set(_EXT_TO_CT.values())

_HEIF_MAJOR_BRANDS = {
    b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heim", b"heis", b"hevm", b"hevs",
}


def _magic_heif_ok(data: bytes) -> bool:
    if len(data) < 12:
        return False
    if data[4:8] != b"ftyp":
        return False
    return data[8:12] in _HEIF_MAJOR_BRANDS


def _magic_image_ok(data: bytes, ext: str) -> bool:
    low = ext.lower()
    if low in {".heic", ".heif"}:
        return _magic_heif_ok(data)
    if low in {".jpg", ".jpeg"}:
        return len(data) >= 3 and data[:3] == b"\xff\xd8\xff"
    if low == ".png":
        return len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n"
    if low == ".gif":
        return len(data) >= 6 and data[:6] in {b"GIF87a", b"GIF89a"}
    if low == ".webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


def _pdf_magic_ok(data: bytes) -> bool:
    return len(data) >= 4 and data[:4] == b"%PDF"


def _convert_heif_bytes_to_jpeg(data: bytes) -> bytes:
    if not _HEIF_SUPPORT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="HEIC processing is not available on this server",
        )
    try:
        with Image.open(io.BytesIO(data)) as im:
            rgb = im.convert("RGB")
            out = io.BytesIO()
            rgb.save(out, format="JPEG", quality=90, optimize=True)
            return out.getvalue()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="HEIC file could not be processed",
        ) from exc


@router.get("/{task_id}/attachments", response_model=list[UserTaskAttachmentRead])
def list_attachments(
    task_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> list[UserTaskAttachmentRead]:
    task = _get_task_or_404(db, task_id)
    if not _can_access_task(current, task):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    rows = user_task_attachments_repo.list_for_task(db, task_id)
    return [UserTaskAttachmentRead.model_validate(r) for r in rows]


@router.post("/{task_id}/attachments", response_model=UserTaskAttachmentRead)
async def upload_attachment(
    task_id: int,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> UserTaskAttachmentRead:
    task = _get_task_or_404(db, task_id)
    if not _can_modify_attachments(current, task):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")

    orig = (file.filename or "file").strip()
    ext = Path(orig).suffix.lower()
    max_bytes = settings.max_upload_mb * 1024 * 1024
    data = await file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {settings.max_upload_mb} MB)",
        )

    if ext == ".pdf":
        ct = (file.content_type or "").lower()
        if ct and "pdf" not in ct and ct != "application/octet-stream":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File must be a PDF")
        if not _pdf_magic_ok(data):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a valid PDF file")
        kind = USER_TASK_ATTACHMENT_KIND_PDF
        normalized_ct = "application/pdf"
    elif ext in _EXT_TO_CT:
        ct = (file.content_type or "").lower().strip()
        if ct and ct not in _VALID_CONTENT_TYPES and ct != "application/octet-stream":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File must be a supported image type")
        if not _magic_image_ok(data, ext):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a valid image file")
        if ext in {".heic", ".heif"}:
            data = _convert_heif_bytes_to_jpeg(data)
            ext = ".jpg"
            normalized_ct = "image/jpeg"
        else:
            normalized_ct = _EXT_TO_CT[ext]
        kind = USER_TASK_ATTACHMENT_KIND_IMAGE
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only image or PDF files are allowed",
        )

    try:
        stored_path = write_attachment_upload(
            settings.docs_root,
            task_id=task_id,
            ext=ext,
            data=data,
        )
    except OSError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc

    row = user_task_attachments_repo.add_attachment(
        db,
        task_id=task_id,
        original_filename=orig[:250],
        stored_path=stored_path,
        content_type=normalized_ct,
        attachment_kind=kind,
        size_bytes=len(data),
        uploaded_by_user_id=current.id,
    )
    if kind == USER_TASK_ATTACHMENT_KIND_IMAGE:
        background_tasks.add_task(ensure_photo_thumbnail, settings.docs_root, stored_path)
    else:
        background_tasks.add_task(ensure_pdf_thumbnail, settings.docs_root, stored_path)
    return UserTaskAttachmentRead.model_validate(row)


@router.get("/{task_id}/attachments/{attachment_id}/file")
def download_attachment(
    task_id: int,
    attachment_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> FileResponse:
    task = _get_task_or_404(db, task_id)
    if not _can_access_task(current, task):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    row = user_task_attachments_repo.get_attachment(db, attachment_id)
    if row is None or row.user_task_id != task_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    path = absolute_file_path(settings.docs_root, row.stored_path)
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File missing on disk")
    return FileResponse(path, media_type=row.content_type, filename=row.original_filename)


@router.get("/{task_id}/attachments/{attachment_id}/thumbnail")
def download_attachment_thumbnail(
    task_id: int,
    attachment_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> FileResponse:
    task = _get_task_or_404(db, task_id)
    if not _can_access_task(current, task):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    row = user_task_attachments_repo.get_attachment(db, attachment_id)
    if row is None or row.user_task_id != task_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    from ..services.thumbnails import ensure_pdf_thumbnail, ensure_photo_thumbnail, photo_thumb_relpath

    if row.attachment_kind == "image":
        thumb = ensure_photo_thumbnail(settings.docs_root, row.stored_path)
    else:
        thumb = ensure_pdf_thumbnail(settings.docs_root, row.stored_path)
    if thumb is None or not thumb.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Thumbnail not available")
    return FileResponse(thumb, media_type="image/webp")


@router.delete("/{task_id}/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_attachment_route(
    task_id: int,
    attachment_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> None:
    task = _get_task_or_404(db, task_id)
    if not _can_modify_attachments(current, task):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    row = user_task_attachments_repo.get_attachment(db, attachment_id)
    if row is None or row.user_task_id != task_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    delete_attachment_file(settings.docs_root, row.stored_path)
    user_task_attachments_repo.delete_attachment(db, attachment=row)
