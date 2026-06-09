"""Filesystem operations for user task attachments."""
from __future__ import annotations

import uuid
from pathlib import Path

_ATTACHMENTS_PREFIX = "UserTaskAttachments"


def _is_under_attachments_root(docs_root: Path, candidate: Path) -> bool:
    root = (docs_root / _ATTACHMENTS_PREFIX).resolve()
    try:
        candidate.resolve().relative_to(root)
        return True
    except ValueError:
        return False


def task_attachments_dir(docs_root: Path, task_id: int) -> Path:
    d = (Path(docs_root) / _ATTACHMENTS_PREFIX / str(task_id)).resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def absolute_file_path(docs_root: Path, stored_path: str) -> Path:
    p = (Path(docs_root) / stored_path.replace("\\", "/")).resolve()
    if not _is_under_attachments_root(docs_root, p):
        raise ValueError("Invalid stored_path")
    return p


def stored_path_for_file(task_id: int, ext: str) -> str:
    name = f"{uuid.uuid4().hex}{ext.lower()}"
    return f"{_ATTACHMENTS_PREFIX}/{task_id}/{name}"


def write_attachment_upload(
    docs_root: Path,
    *,
    task_id: int,
    ext: str,
    data: bytes,
) -> str:
    stored_path = stored_path_for_file(task_id, ext)
    dest = absolute_file_path(docs_root, stored_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    part.write_bytes(data)
    part.replace(dest)
    return stored_path


def delete_attachment_file(docs_root: Path, stored_path: str) -> None:
    try:
        p = absolute_file_path(docs_root, stored_path)
    except ValueError:
        return
    if p.is_file():
        p.unlink(missing_ok=True)
