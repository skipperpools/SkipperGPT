"""Data access layer for jobs and tasks.

This module is the ONLY place in the codebase that issues SQL / SQLAlchemy
queries. Routers and services depend on these functions, never on the engine
or session directly. Swapping SQLite for Postgres / Supabase later means
changing DATABASE_URL - this file does not need to be rewritten.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from typing import Iterable, List, Optional

from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..constants import MAX_JOB_CONTACTS, STATUS_NOT_STARTED, TASK_DEFINITIONS_BY_JOB_TYPE
from ..models import (
    Contact,
    Job,
    JobContactLink,
    JobDocument,
    JobNote,
    JobPhoto,
    JobSketch,
    JobTask,
    JobTypeTaskTemplate,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _job_load_options() -> tuple:
    return (
        selectinload(Job.tasks),
        selectinload(Job.documents).selectinload(JobDocument.uploaded_by),
        selectinload(Job.photos).selectinload(JobPhoto.uploaded_by),
        selectinload(Job.sketches).selectinload(JobSketch.created_by),
        selectinload(Job.sketches).selectinload(JobSketch.updated_by),
        selectinload(Job.contact_links).selectinload(JobContactLink.contact),
        selectinload(Job.job_notes).selectinload(JobNote.author),
    )


def _slugify_task_key(label: str) -> str:
    normalized = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode("ascii")
    key = re.sub(r"[^a-z0-9]+", "_", normalized.lower()).strip("_")
    return key[:56] if key else "task"


def _unique_task_key(base_key: str, existing_keys: set[str]) -> str:
    if base_key not in existing_keys:
        return base_key
    i = 2
    while True:
        candidate = f"{base_key}_{i}"
        if candidate not in existing_keys:
            return candidate
        i += 1


def list_job_type_task_templates(db: Session, *, job_type: str) -> List[JobTypeTaskTemplate]:
    stmt = (
        select(JobTypeTaskTemplate)
        .where(JobTypeTaskTemplate.job_type == job_type)
        .order_by(JobTypeTaskTemplate.sort_order.asc(), JobTypeTaskTemplate.id.asc())
    )
    return list(db.execute(stmt).scalars().all())


def _task_definitions_for_job_type(db: Session, *, job_type: str) -> list[tuple[str, str]]:
    base = list(TASK_DEFINITIONS_BY_JOB_TYPE.get(job_type, []))
    custom = list_job_type_task_templates(db, job_type=job_type)
    base.extend((row.task_key, row.task_label) for row in custom)
    return base


def seeded_task_keys_for_job_type(db: Session, *, job_type: str) -> set[str]:
    """Public: keys of tasks auto-seeded for a job_type (base + admin templates)."""
    return {k for k, _label in _task_definitions_for_job_type(db, job_type=job_type)}


def append_template_tasks_for_job_type(db: Session, *, job: Job, job_type: str) -> int:
    """Append missing template tasks for job_type onto an existing job.

    Returns number of tasks inserted.
    """
    task_defs = _task_definitions_for_job_type(db, job_type=job_type)
    existing_keys = {t.task_key for t in job.tasks}
    inserted = 0
    next_sort = max((t.sort_order for t in job.tasks), default=-1) + 1
    for task_key, task_label in task_defs:
        if task_key in existing_keys:
            continue
        db.add(
            JobTask(
                job_id=job.id,
                task_key=task_key,
                task_label=task_label,
                status=STATUS_NOT_STARTED,
                sort_order=next_sort,
            )
        )
        existing_keys.add(task_key)
        next_sort += 1
        inserted += 1
    if inserted:
        db.commit()
    return inserted


def add_job_type_task_template(
    db: Session, *, job_type: str, task_label: str
) -> JobTypeTaskTemplate:
    existing = list_job_type_task_templates(db, job_type=job_type)
    existing_keys = set(TASK_DEFINITIONS_BY_JOB_TYPE.get(job_type, []))
    custom_keys = {t.task_key for t in existing}
    fixed_keys = {k for (k, _label) in existing_keys}
    all_keys = fixed_keys | custom_keys
    base_key = _slugify_task_key(task_label)
    task_key = _unique_task_key(base_key, all_keys)
    sort_order = existing[-1].sort_order + 1 if existing else 0
    row = JobTypeTaskTemplate(
        job_type=job_type,
        task_key=task_key,
        task_label=task_label.strip(),
        sort_order=sort_order,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_jobs(db: Session, *, include_archived: bool = False) -> List[Job]:
    """List jobs: active only by default; when include_archived is True, archived only."""
    stmt = (
        select(Job)
        .options(*_job_load_options())
        .order_by(Job.created_at.desc())
    )
    if include_archived:
        stmt = stmt.where(Job.archived.is_(True))
    else:
        stmt = stmt.where(Job.archived.is_(False))
    return list(db.execute(stmt).scalars().all())


def get_job(db: Session, job_id: int) -> Optional[Job]:
    stmt = select(Job).options(*_job_load_options()).where(Job.id == job_id)
    return db.execute(stmt).scalar_one_or_none()


def job_exists(db: Session, job_id: int) -> bool:
    return (
        db.execute(select(Job.id).where(Job.id == job_id)).scalar_one_or_none()
        is not None
    )


def reload_job_tasks(db: Session, job: Job) -> None:
    db.expire(job, ["tasks"])
    db.execute(
        select(Job).options(selectinload(Job.tasks)).where(Job.id == job.id)
    )
    _ = job.tasks


def reload_job_contact_links(db: Session, job: Job) -> None:
    db.expire(job, ["contact_links"])
    db.execute(
        select(Job)
        .options(selectinload(Job.contact_links).selectinload(JobContactLink.contact))
        .where(Job.id == job.id)
    )
    _ = job.contact_links


def reload_job_notes(db: Session, job: Job) -> None:
    db.expire(job, ["job_notes"])
    db.execute(
        select(Job)
        .options(selectinload(Job.job_notes).selectinload(JobNote.author))
        .where(Job.id == job.id)
    )
    _ = job.job_notes


def reload_job_documents(db: Session, job: Job) -> None:
    db.expire(job, ["documents"])
    db.execute(
        select(Job)
        .options(selectinload(Job.documents).selectinload(JobDocument.uploaded_by))
        .where(Job.id == job.id)
    )
    _ = job.documents


def reload_job_photos(db: Session, job: Job) -> None:
    db.expire(job, ["photos"])
    db.execute(
        select(Job)
        .options(selectinload(Job.photos).selectinload(JobPhoto.uploaded_by))
        .where(Job.id == job.id)
    )
    _ = job.photos


def reload_job_attachments(db: Session, job: Job) -> None:
    reload_job_documents(db, job)
    reload_job_photos(db, job)


def replace_job_contact_links(db: Session, job_id: int, contact_ids: List[int]) -> None:
    """Replace all job–contact links with ordered ids (deduped, max MAX_JOB_CONTACTS)."""
    seen: set[int] = set()
    ordered: List[int] = []
    for cid in contact_ids:
        if cid in seen:
            continue
        seen.add(cid)
        ordered.append(cid)
    if len(ordered) > MAX_JOB_CONTACTS:
        raise ValueError(f"At most {MAX_JOB_CONTACTS} contacts per job")
    if not ordered:
        db.execute(sql_delete(JobContactLink).where(JobContactLink.job_id == job_id))
        db.commit()
        return
    stmt = select(Contact.id).where(Contact.id.in_(ordered))
    found = set(db.execute(stmt).scalars().all())
    if len(found) != len(set(ordered)):
        raise ValueError("Unknown contact id in contact_ids")
    db.execute(sql_delete(JobContactLink).where(JobContactLink.job_id == job_id))
    for i, cid in enumerate(ordered):
        db.add(
            JobContactLink(job_id=job_id, contact_id=cid, sort_order=i)
        )
    db.commit()


def create_job(
    db: Session, *, fields: dict, contact_ids: Optional[List[int]] = None
) -> Job:
    """Create a job and seed it with the default task list atomically."""
    job = Job(**fields)
    task_defs = _task_definitions_for_job_type(db, job_type=job.job_type)
    for index, (task_key, task_label) in enumerate(task_defs):
        job.tasks.append(
            JobTask(
                task_key=task_key,
                task_label=task_label,
                status=STATUS_NOT_STARTED,
                sort_order=index,
            )
        )
    db.add(job)
    db.commit()
    db.refresh(job)
    if contact_ids is not None:
        replace_job_contact_links(db, job.id, contact_ids)
    return job


def update_job(db: Session, *, job: Job, fields: dict) -> Job:
    for key, value in fields.items():
        setattr(job, key, value)
    db.commit()
    db.refresh(job)
    return job


def delete_job(db: Session, *, job: Job) -> None:
    db.delete(job)
    db.commit()


def get_task(db: Session, *, job_id: int, task_key: str) -> Optional[JobTask]:
    stmt = select(JobTask).where(
        JobTask.job_id == job_id, JobTask.task_key == task_key
    )
    return db.execute(stmt).scalar_one_or_none()


def update_task(
    db: Session,
    *,
    task: JobTask,
    fields: dict,
) -> JobTask:
    """Apply a partial update to a task with completed_at side-effects.

    - When status transitions TO 'completed' and completed_at is empty,
      stamp it with the current UTC time.
    - When status transitions AWAY FROM 'completed', clear completed_at.
    """
    new_status = fields.get("status")
    if new_status is not None and new_status != task.status:
        if new_status == "completed":
            if task.completed_at is None:
                task.completed_at = _utcnow()
        else:
            task.completed_at = None

    for key, value in fields.items():
        setattr(task, key, value)

    db.commit()
    db.refresh(task)
    return task


def add_job_task(db: Session, *, job: Job, task_label: str) -> JobTask:
    """Append a custom task to a job with a unique task_key."""
    existing_keys = {t.task_key for t in job.tasks}
    base_key = _slugify_task_key(task_label)
    task_key = _unique_task_key(base_key, existing_keys)
    next_sort = (max((t.sort_order for t in job.tasks), default=-1) + 1)
    task = JobTask(
        job_id=job.id,
        task_key=task_key,
        task_label=task_label.strip(),
        status=STATUS_NOT_STARTED,
        sort_order=next_sort,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def move_job_task(
    db: Session, *, job_id: int, task_key: str, direction: str
) -> bool:
    """Move task one position up/down. Returns True when order changed."""
    rows = list(
        db.execute(
            select(JobTask)
            .where(JobTask.job_id == job_id)
            .order_by(JobTask.sort_order.asc(), JobTask.id.asc())
        ).scalars()
    )
    if not rows:
        return False
    idx = next((i for i, row in enumerate(rows) if row.task_key == task_key), -1)
    if idx < 0:
        return False
    if direction == "up":
        if idx == 0:
            return False
        other_idx = idx - 1
    else:
        if idx >= len(rows) - 1:
            return False
        other_idx = idx + 1
    rows[idx].sort_order, rows[other_idx].sort_order = (
        rows[other_idx].sort_order,
        rows[idx].sort_order,
    )
    db.commit()
    return True


def reorder_job_task(
    db: Session, *, job_id: int, task_key: str, target_index: int
) -> bool:
    """Move task to target_index (0-based). Returns True when order changed."""
    rows = list(
        db.execute(
            select(JobTask)
            .where(JobTask.job_id == job_id)
            .order_by(JobTask.sort_order.asc(), JobTask.id.asc())
        ).scalars()
    )
    if not rows:
        return False
    idx = next((i for i, row in enumerate(rows) if row.task_key == task_key), -1)
    if idx < 0:
        return False
    clamped = max(0, min(target_index, len(rows) - 1))
    if idx == clamped:
        return False
    row = rows.pop(idx)
    rows.insert(clamped, row)
    for i, row_item in enumerate(rows):
        row_item.sort_order = i
    db.commit()
    return True


def delete_job_task(db: Session, *, task: JobTask) -> None:
    """Delete a task and compact remaining sort_order values for the job."""
    job_id = task.job_id
    db.delete(task)
    db.flush()
    remaining = list(
        db.execute(
            select(JobTask)
            .where(JobTask.job_id == job_id)
            .order_by(JobTask.sort_order.asc(), JobTask.id.asc())
        ).scalars()
    )
    for i, row in enumerate(remaining):
        row.sort_order = i
    db.commit()


def count_jobs(db: Session) -> int:
    stmt = select(Job)
    return len(list(db.execute(stmt).scalars().all()))


def insert_jobs_bulk(db: Session, jobs: Iterable[Job]) -> None:
    """Used by the seed script."""
    for job in jobs:
        db.add(job)
    db.commit()


def get_job_document(
    db: Session, *, job_id: int, document_id: int
) -> Optional[JobDocument]:
    stmt = select(JobDocument).where(
        JobDocument.job_id == job_id,
        JobDocument.id == document_id,
    )
    return db.execute(stmt).scalar_one_or_none()


def add_job_document(
    db: Session,
    *,
    job: Job,
    title: str,
    original_filename: str,
    stored_path: str,
    content_type: str,
    category: str,
    size_bytes: int,
    uploaded_by_user_id: Optional[int],
) -> JobDocument:
    doc = JobDocument(
        job_id=job.id,
        title=title,
        original_filename=original_filename,
        stored_path=stored_path,
        content_type=content_type,
        category=category,
        size_bytes=size_bytes,
        uploaded_by_user_id=uploaded_by_user_id,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


def delete_job_document(db: Session, *, doc: JobDocument) -> None:
    db.delete(doc)
    db.commit()


def update_job_document_title(
    db: Session, *, doc: JobDocument, title: str
) -> JobDocument:
    doc.title = title
    db.commit()
    db.refresh(doc)
    return doc


def get_job_photo(
    db: Session, *, job_id: int, photo_id: int
) -> Optional[JobPhoto]:
    stmt = select(JobPhoto).where(
        JobPhoto.job_id == job_id,
        JobPhoto.id == photo_id,
    )
    return db.execute(stmt).scalar_one_or_none()


def add_job_photo(
    db: Session,
    *,
    job: Job,
    original_filename: str,
    stored_path: str,
    content_type: str,
    size_bytes: int,
    uploaded_by_user_id: Optional[int],
) -> JobPhoto:
    photo = JobPhoto(
        job_id=job.id,
        original_filename=original_filename,
        stored_path=stored_path,
        content_type=content_type,
        size_bytes=size_bytes,
        uploaded_by_user_id=uploaded_by_user_id,
    )
    db.add(photo)
    db.commit()
    db.refresh(photo)
    return photo


def delete_job_photo(db: Session, *, photo: JobPhoto) -> None:
    db.delete(photo)
    db.commit()


def get_job_sketch(
    db: Session, *, job_id: int, sketch_id: int
) -> Optional[JobSketch]:
    stmt = select(JobSketch).where(
        JobSketch.job_id == job_id,
        JobSketch.id == sketch_id,
    )
    return db.execute(stmt).scalar_one_or_none()


def add_job_sketch(
    db: Session,
    *,
    job: Job,
    title: str,
    stored_json_path: str,
    stored_preview_path: str,
    grid_spacing_inches: int,
    created_by_user_id: Optional[int],
    updated_by_user_id: Optional[int],
) -> JobSketch:
    sketch = JobSketch(
        job_id=job.id,
        title=title,
        stored_json_path=stored_json_path,
        stored_preview_path=stored_preview_path,
        grid_spacing_inches=grid_spacing_inches,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=updated_by_user_id,
    )
    db.add(sketch)
    db.commit()
    db.refresh(sketch)
    return sketch


def update_job_sketch(
    db: Session,
    *,
    sketch: JobSketch,
    fields: dict,
) -> JobSketch:
    for key, val in fields.items():
        setattr(sketch, key, val)
    db.add(sketch)
    db.commit()
    db.refresh(sketch)
    return sketch


def delete_job_sketch(db: Session, *, sketch: JobSketch) -> None:
    db.delete(sketch)
    db.commit()


def list_job_notes(db: Session, *, job_id: int) -> List[JobNote]:
    stmt = (
        select(JobNote)
        .options(selectinload(JobNote.author))
        .where(JobNote.job_id == job_id)
        .order_by(JobNote.created_at.desc(), JobNote.id.desc())
    )
    return list(db.execute(stmt).scalars().all())


def create_job_note(
    db: Session,
    *,
    job_id: int,
    author_user_id: int,
    body: str,
) -> JobNote:
    note = JobNote(
        job_id=job_id,
        author_user_id=author_user_id,
        body=body.strip(),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


def get_job_note(db: Session, *, job_id: int, note_id: int) -> Optional[JobNote]:
    stmt = (
        select(JobNote)
        .options(selectinload(JobNote.author))
        .where(JobNote.job_id == job_id, JobNote.id == note_id)
    )
    return db.execute(stmt).scalar_one_or_none()


def delete_job_note(db: Session, *, note: JobNote) -> None:
    db.delete(note)
    db.commit()
