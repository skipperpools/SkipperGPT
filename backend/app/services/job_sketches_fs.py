"""Filesystem operations for job sketches (paths relative to docs_root)."""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..models import Job, JobSketch
from ..repositories import jobs_repo
from .job_sketches_paths import (
    absolute_job_sketches_dir,
    exclusive_sketches_folder_name,
    stored_path_for_file,
)

_SKETCHES_PREFIX = "Sketches"
_VALID_GRID_SPACING = {1, 3, 6, 12}


def _is_under_sketches_root(docs_root: Path, candidate: Path) -> bool:
    root = (docs_root / _SKETCHES_PREFIX).resolve()
    try:
        candidate.resolve().relative_to(root)
        return True
    except ValueError:
        return False


def absolute_file_path(docs_root: Path, stored_path: str) -> Path:
    p = (Path(docs_root) / stored_path.replace("\\", "/")).resolve()
    if not _is_under_sketches_root(docs_root, p):
        raise ValueError("Invalid stored_path")
    return p


def ensure_job_sketches_folder(docs_root: Path, folder_name: str) -> Path:
    d = absolute_job_sketches_dir(docs_root, folder_name)
    d.mkdir(parents=True, exist_ok=True)
    return d


def assign_sketches_folder_if_needed(db: Session, job: Job, docs_root: Path) -> str:
    name = exclusive_sketches_folder_name(db, job.id, job.customer_name)
    if job.sketches_folder_name != name:
        job.sketches_folder_name = name
        db.add(job)
        db.commit()
        db.refresh(job)
    ensure_job_sketches_folder(docs_root, name)
    return name


def move_job_sketches_on_rename(
    db: Session,
    *,
    job: Job,
    new_customer_name: str,
    docs_root: Path,
) -> None:
    if job.sketches_folder_name is None:
        return
    new_folder = exclusive_sketches_folder_name(db, job.id, new_customer_name)
    if new_folder == job.sketches_folder_name:
        return

    old_dir = absolute_job_sketches_dir(docs_root, job.sketches_folder_name)
    new_dir = absolute_job_sketches_dir(docs_root, new_folder)

    if old_dir.is_dir():
        if new_dir.exists():
            raise OSError(f"Target sketches folder already exists: {new_dir}")
        new_dir.parent.mkdir(parents=True, exist_ok=True)
        old_dir.rename(new_dir)

    old_prefix = f"{_SKETCHES_PREFIX}/{job.sketches_folder_name}/"
    new_prefix = f"{_SKETCHES_PREFIX}/{new_folder}/"
    for sketch in job.sketches:
        for attr in ("stored_json_path", "stored_preview_path", "stored_bg_path"):
            path_val = getattr(sketch, attr, None)
            if path_val and path_val.startswith(old_prefix):
                setattr(sketch, attr, new_prefix + path_val[len(old_prefix) :])

    job.sketches_folder_name = new_folder
    db.add(job)
    db.commit()
    db.refresh(job)


def default_sketch_document(*, grid_spacing_inches: int = 3) -> dict[str, Any]:
    spacing = grid_spacing_inches if grid_spacing_inches in _VALID_GRID_SPACING else 3
    return {
        "version": 1,
        "pixelsPerInch": 48,
        "canvas": {"width": 2400, "height": 1800},
        "gridSpacingInches": spacing,
        "snapEnabled": True,
        "snapSubdivisionInches": 0.25,
        "background": {
            "source": "none",
            "jobPhotoId": None,
            "storedBgPath": None,
            "transform": {"x": 0, "y": 0, "scale": 1, "opacity": 0.65},
        },
        "strokes": [],
    }


def _atomic_write_bytes(dest: Path, data: bytes) -> None:
    tmp = dest.with_suffix(f"{dest.suffix}.part")
    try:
        tmp.write_bytes(data)
        tmp.replace(dest)
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise


def write_json_file(docs_root: Path, stored_path: str, document: dict[str, Any]) -> None:
    path = absolute_file_path(docs_root, stored_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(document, separators=(",", ":")).encode("utf-8")
    _atomic_write_bytes(path, payload)


def read_json_file(docs_root: Path, stored_path: str) -> dict[str, Any]:
    path = absolute_file_path(docs_root, stored_path)
    if not path.is_file():
        raise FileNotFoundError(stored_path)
    return json.loads(path.read_text(encoding="utf-8"))


def create_job_sketch(
    db: Session,
    *,
    job: Job,
    docs_root: Path,
    title: str,
    grid_spacing_inches: int,
    user_id: int | None,
) -> JobSketch:
    folder = assign_sketches_folder_if_needed(db, job, docs_root)
    sketch_id = uuid.uuid4().hex
    json_name = f"{sketch_id}.json"
    preview_name = f"{sketch_id}.png"
    dest_dir = ensure_job_sketches_folder(docs_root, folder)
    json_rel = stored_path_for_file(folder, json_name)
    preview_rel = stored_path_for_file(folder, preview_name)

    spacing = grid_spacing_inches if grid_spacing_inches in _VALID_GRID_SPACING else 3
    document = default_sketch_document(grid_spacing_inches=spacing)
    write_json_file(docs_root, json_rel, document)

    # Minimal transparent-ish placeholder PNG (1x1) until first save
    preview_path = dest_dir / preview_name
    _write_placeholder_png(preview_path)

    return jobs_repo.add_job_sketch(
        db,
        job=job,
        title=title[:255],
        stored_json_path=json_rel,
        stored_preview_path=preview_rel,
        grid_spacing_inches=spacing,
        created_by_user_id=user_id,
        updated_by_user_id=user_id,
    )


def _write_placeholder_png(path: Path) -> None:
    # 1x1 white PNG
    data = bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000a49444154789c6300010000050001"
        "0d0a2db40000000049454e44ae426082"
    )
    _atomic_write_bytes(path, data)


def save_sketch_files(
    docs_root: Path,
    *,
    sketch: JobSketch,
    document: dict[str, Any],
    preview_bytes: bytes,
    background_bytes: bytes | None = None,
    background_ext: str | None = None,
) -> str | None:
    bg_rel: str | None = sketch.stored_bg_path

    preview_path = absolute_file_path(docs_root, sketch.stored_preview_path)
    _atomic_write_bytes(preview_path, preview_bytes)

    from .thumbnails import delete_thumbnail_for  # noqa: PLC0415

    delete_thumbnail_for(docs_root, sketch.stored_preview_path, "sketch")

    if background_bytes is not None:
        rel_parts = sketch.stored_json_path.replace("\\", "/").split("/")
        folder = rel_parts[1] if len(rel_parts) >= 3 else ""
        sketch_uuid = Path(rel_parts[-1]).stem
        ext = background_ext if background_ext and background_ext.startswith(".") else ".jpg"
        bg_name = f"{sketch_uuid}_bg{ext.lower()}"
        bg_rel = stored_path_for_file(folder, bg_name)
        bg_path = absolute_file_path(docs_root, bg_rel)
        _atomic_write_bytes(bg_path, background_bytes)
        if sketch.stored_bg_path and sketch.stored_bg_path != bg_rel:
            try:
                old = absolute_file_path(docs_root, sketch.stored_bg_path)
                if old.is_file():
                    old.unlink()
            except ValueError:
                pass

    if bg_rel:
        bg = document.setdefault("background", {})
        bg["storedBgPath"] = bg_rel
        if bg.get("source") == "none":
            bg["source"] = "device"

    write_json_file(docs_root, sketch.stored_json_path, document)

    return bg_rel


def delete_sketch_files(docs_root: Path, sketch: JobSketch) -> None:
    from .thumbnails import delete_thumbnail_for  # noqa: PLC0415

    for path_attr in ("stored_json_path", "stored_preview_path", "stored_bg_path"):
        rel = getattr(sketch, path_attr, None)
        if not rel:
            continue
        delete_thumbnail_for(docs_root, rel, "sketch")
        try:
            p = absolute_file_path(docs_root, rel)
            if p.is_file():
                p.unlink()
        except ValueError:
            pass


def remove_empty_job_sketch_dir(docs_root: Path, job: Job) -> None:
    if not job.sketches_folder_name:
        return
    d = absolute_job_sketches_dir(docs_root, job.sketches_folder_name)
    thumbs = d / ".thumbs"
    if thumbs.is_dir() and not any(thumbs.iterdir()):
        thumbs.rmdir()
    if d.is_dir() and not any(d.iterdir()):
        d.rmdir()
