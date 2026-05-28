"""Job sketches under {docs_root}/Sketches/<job folder>/."""
from __future__ import annotations

import json
from pathlib import Path
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps.auth import get_current_user
from ..models import User
from ..repositories import jobs_repo
from ..schemas import JobRead, JobSketchRead
from ..services.job_sketches_fs import (
    absolute_file_path,
    create_job_sketch,
    delete_sketch_files,
    read_json_file,
    remove_empty_job_sketch_dir,
    save_sketch_files,
)
from ..services.job_sketches_service import grid_spacing_from_document, validate_sketch_document
from ..services.jobs_service import to_job_read
from ..services.thumbnails import ensure_sketch_thumbnail

router = APIRouter(tags=["job-sketches"])

_VALID_GRID = {1, 3, 6, 12}


class JobSketchCreateBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    grid_spacing_inches: int = Field(default=3)


class JobSketchUpdateBody(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)


@router.get("/{job_id}/sketches", response_model=List[JobSketchRead])
def list_job_sketches(
    job_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[JobSketchRead]:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return to_job_read(job).sketches


@router.post("/{job_id}/sketches", response_model=JobRead)
def create_sketch_route(
    job_id: int,
    payload: JobSketchCreateBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    spacing = payload.grid_spacing_inches
    if spacing not in _VALID_GRID:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="grid_spacing_inches must be 1, 3, 6, or 12",
        )

    try:
        create_job_sketch(
            db,
            job=job,
            docs_root=settings.docs_root,
            title=payload.title.strip(),
            grid_spacing_inches=spacing,
            user_id=user.id,
        )
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.get("/{job_id}/sketches/{sketch_id}")
def get_job_sketch_document(
    job_id: int,
    sketch_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sketch = jobs_repo.get_job_sketch(db, job_id=job_id, sketch_id=sketch_id)
    if sketch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sketch not found")
    try:
        return read_json_file(settings.docs_root, sketch.stored_json_path)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sketch data missing on server",
        ) from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Invalid sketch data",
        ) from exc


@router.put("/{job_id}/sketches/{sketch_id}", response_model=JobRead)
async def save_job_sketch_route(
    job_id: int,
    sketch_id: int,
    background_tasks: BackgroundTasks,
    document: str = Form(...),
    preview: UploadFile = File(...),
    background: UploadFile | None = File(default=None),
    content_version: int | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sketch = jobs_repo.get_job_sketch(db, job_id=job_id, sketch_id=sketch_id)
    if sketch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sketch not found")

    if content_version is not None and content_version != sketch.content_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Sketch was modified elsewhere; reload and try again",
        )

    try:
        doc = json.loads(document)
        doc = validate_sketch_document(doc)
    except (json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    preview_bytes = await preview.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(preview_bytes) < 8 or preview_bytes[:8] != b"\x89PNG\r\n\x1a\n":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Preview must be a PNG image",
        )

    bg_bytes: bytes | None = None
    bg_ext: str | None = None
    if background is not None and background.filename:
        bg_bytes = await background.read(settings.max_upload_mb * 1024 * 1024 + 1)
        bg_ext = Path(background.filename).suffix.lower() or ".jpg"

    try:
        bg_rel = save_sketch_files(
            settings.docs_root,
            sketch=sketch,
            document=doc,
            preview_bytes=preview_bytes,
            background_bytes=bg_bytes,
            background_ext=bg_ext,
        )
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    spacing = grid_spacing_from_document(doc)
    jobs_repo.update_job_sketch(
        db,
        sketch=sketch,
        fields={
            "grid_spacing_inches": spacing,
            "stored_bg_path": bg_rel if bg_rel else sketch.stored_bg_path,
            "content_version": sketch.content_version + 1,
            "updated_by_user_id": user.id,
        },
    )

    background_tasks.add_task(
        ensure_sketch_thumbnail,
        settings.docs_root,
        sketch.stored_preview_path,
    )

    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.patch("/{job_id}/sketches/{sketch_id}", response_model=JobRead)
def rename_job_sketch_route(
    job_id: int,
    sketch_id: int,
    payload: JobSketchUpdateBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sketch = jobs_repo.get_job_sketch(db, job_id=job_id, sketch_id=sketch_id)
    if sketch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sketch not found")

    if payload.title is not None:
        jobs_repo.update_job_sketch(
            db,
            sketch=sketch,
            fields={"title": payload.title.strip()[:255], "updated_by_user_id": user.id},
        )

    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.delete("/{job_id}/sketches/{sketch_id}", response_model=JobRead)
def delete_job_sketch_route(
    job_id: int,
    sketch_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sketch = jobs_repo.get_job_sketch(db, job_id=job_id, sketch_id=sketch_id)
    if sketch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sketch not found")

    try:
        delete_sketch_files(settings.docs_root, sketch)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid sketch path",
        ) from exc

    jobs_repo.delete_job_sketch(db, sketch=sketch)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    remove_empty_job_sketch_dir(settings.docs_root, job)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.get("/{job_id}/sketches/{sketch_id}/thumbnail")
def download_job_sketch_thumbnail(
    job_id: int,
    sketch_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sketch = jobs_repo.get_job_sketch(db, job_id=job_id, sketch_id=sketch_id)
    if sketch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sketch not found")
    stored_path = sketch.stored_preview_path

    thumb = ensure_sketch_thumbnail(settings.docs_root, stored_path)
    if thumb is None or not thumb.is_file():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not generate thumbnail",
        )
    return FileResponse(
        thumb,
        media_type="image/webp",
        headers={"Cache-Control": "private, no-cache"},
    )


@router.get("/{job_id}/sketches/{sketch_id}/preview")
def download_job_sketch_preview(
    job_id: int,
    sketch_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sketch = jobs_repo.get_job_sketch(db, job_id=job_id, sketch_id=sketch_id)
    if sketch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sketch not found")
    try:
        path = absolute_file_path(settings.docs_root, sketch.stored_preview_path)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid sketch path",
        ) from exc
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Preview missing on server",
        )
    safe_name = f"{sketch.title or 'sketch'}.png"
    return FileResponse(
        path,
        media_type="image/png",
        filename=safe_name,
        content_disposition_type="attachment",
    )


@router.get("/{job_id}/sketches/{sketch_id}/background")
def download_job_sketch_background(
    job_id: int,
    sketch_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sketch = jobs_repo.get_job_sketch(db, job_id=job_id, sketch_id=sketch_id)
    if sketch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sketch not found")
    if not sketch.stored_bg_path:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No background image")
    try:
        path = absolute_file_path(settings.docs_root, sketch.stored_bg_path)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid background path",
        ) from exc
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Background file missing on server",
        )
    return FileResponse(path, media_type="image/jpeg")
