"""Job photos under {docs_root}/Photos/<job folder>/."""
from __future__ import annotations

import io
from pathlib import Path
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
    _HEIF_SUPPORT = True
except Exception:  # noqa: BLE001 - missing wheel or libheif at runtime; fall back gracefully
    _HEIF_SUPPORT = False

from ..config import settings
from ..database import SessionLocal, get_db
from ..deps.auth import get_current_user
from ..models import User
from ..repositories import jobs_repo
from ..schemas import JobPhotoRead, JobRead
from ..services.job_disk_sync import sync_job_attachments_from_disk
from ..services.job_photos_fs import (
    absolute_file_path,
    delete_photo_file,
    remove_empty_job_photo_dir,
    write_photo_upload,
)
from ..services.thumbnails import ensure_photo_display, ensure_photo_thumbnail
from ..services.jobs_service import to_job_read

router = APIRouter(tags=["job-photos"])

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
    b"heic",
    b"heix",
    b"hevc",
    b"hevx",
    b"mif1",
    b"msf1",
    b"heim",
    b"heis",
    b"hevm",
    b"hevs",
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


def _convert_heif_bytes_to_jpeg(data: bytes) -> bytes:
    if not _HEIF_SUPPORT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="HEIC processing is not available on this server (install pillow-heif; see requirements-heic.txt)",
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


@router.get("/{job_id}/photos", response_model=List[JobPhotoRead])
def list_job_photos(
    job_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[JobPhotoRead]:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sync_job_attachments_from_disk(db, job, settings.docs_root)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job).photos


@router.post("/{job_id}/photos", response_model=JobRead)
async def upload_job_photo(
    job_id: int,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    orig = (file.filename or "photo.jpg").strip()
    ext = Path(orig).suffix.lower()
    if ext not in _EXT_TO_CT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only JPG, PNG, WebP, GIF, HEIC, or HEIF files are allowed",
        )

    ct = (file.content_type or "").lower().strip()
    if ct and ct not in _VALID_CONTENT_TYPES and ct != "application/octet-stream":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must be a supported image type",
        )

    max_bytes = settings.max_upload_mb * 1024 * 1024
    data = await file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large (max {settings.max_upload_mb} MB)",
        )
    if not _magic_image_ok(data, ext):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Not a valid image file",
        )

    if ext in {".heic", ".heif"}:
        data = _convert_heif_bytes_to_jpeg(data)
        ext = ".jpg"
        normalized_ct = "image/jpeg"
    else:
        normalized_ct = _EXT_TO_CT[ext]
    try:
        new_photo = write_photo_upload(
            db,
            job=job,
            docs_root=settings.docs_root,
            data=data,
            original_filename=orig[:250],
            ext=ext,
            content_type=normalized_ct,
            uploaded_by_user_id=user.id,
        )
        background_tasks.add_task(
            ensure_photo_thumbnail,
            settings.docs_root,
            new_photo.stored_path,
        )
        background_tasks.add_task(
            ensure_photo_display,
            settings.docs_root,
            new_photo.stored_path,
        )
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.get("/{job_id}/photos/{photo_id}/thumbnail")
def download_job_photo_thumbnail(
    job_id: int,
    photo_id: int,
    _user: User = Depends(get_current_user),
) -> FileResponse:
    with SessionLocal() as db:
        job = jobs_repo.get_job(db, job_id)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
        photo = jobs_repo.get_job_photo(db, job_id=job_id, photo_id=photo_id)
        if photo is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")
        stored_path = photo.stored_path
    thumb = ensure_photo_thumbnail(settings.docs_root, stored_path)
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


@router.get("/{job_id}/photos/{photo_id}/display")
def download_job_photo_display(
    job_id: int,
    photo_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    photo = jobs_repo.get_job_photo(db, job_id=job_id, photo_id=photo_id)
    if photo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")
    stored_path = photo.stored_path
    display = ensure_photo_display(settings.docs_root, stored_path)
    if display is None or not display.is_file():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not generate display image",
        )
    return FileResponse(
        display,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/{job_id}/photos/{photo_id}/file")
def download_job_photo(
    job_id: int,
    photo_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    photo = jobs_repo.get_job_photo(db, job_id=job_id, photo_id=photo_id)
    if photo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")
    try:
        path = absolute_file_path(settings.docs_root, photo.stored_path)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid photo path",
        ) from exc
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File missing on server",
        )
    safe_name = photo.original_filename or f"photo{Path(photo.stored_path).suffix}"
    return FileResponse(
        path,
        media_type=photo.content_type,
        filename=safe_name,
        content_disposition_type="attachment",
    )


@router.delete("/{job_id}/photos/{photo_id}", response_model=JobRead)
def delete_job_photo_route(
    job_id: int,
    photo_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    photo = jobs_repo.get_job_photo(db, job_id=job_id, photo_id=photo_id)
    if photo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")

    try:
        delete_photo_file(settings.docs_root, photo)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid photo path",
        ) from exc

    jobs_repo.delete_job_photo(db, photo=photo)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    remove_empty_job_photo_dir(settings.docs_root, job)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)
