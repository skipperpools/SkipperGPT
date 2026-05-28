"""Business logic on top of the repository layer.

Computes progress snapshots and overall status, and shapes ORM models into
response payloads with the extra derived fields the UI needs.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import List, Optional

from ..constants import (
    DOC_CATEGORY_FIELD,
    STATUS_COMPLETED,
    STATUS_IN_PROGRESS,
    STATUS_ISSUE,
    STATUS_NOT_STARTED,
)
from ..models import Job, JobTask
from ..schemas import (
    JobContactEntry,
    JobDocumentRead,
    JobNoteRead,
    JobPhotoRead,
    JobSketchRead,
    JobProgress,
    JobRead,
    JobTaskRead,
)
from .job_docs_paths import docs_dir_relative
from .job_photos_paths import photos_dir_relative
from .job_sketches_paths import sketches_dir_relative

_ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _parse_iso_date_from_task_value(value: Optional[str]) -> Optional[datetime]:
    """Parse YYYY-MM-DD task date from value for display (noon UTC)."""
    if not value:
        return None
    m = _ISO_DATE_RE.match(value.strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return datetime(y, mo, d, 12, 0, 0, tzinfo=timezone.utc)


def _compute_progress(tasks: List[JobTask]) -> JobProgress:
    total = len(tasks)
    completed_tasks = [t for t in tasks if t.status == STATUS_COMPLETED]
    completed = len(completed_tasks)
    percent = round((completed / total) * 100) if total else 0

    latest_label: Optional[str] = None
    latest_completed_at = None
    if completed_tasks:
        latest = max(
            completed_tasks,
            key=lambda t: t.completed_at or t.sort_order,  # fallback to sort order
        )
        latest_label = latest.task_label
        latest_completed_at = _parse_iso_date_from_task_value(latest.value)

    return JobProgress(
        completed=completed,
        total=total,
        percent=percent,
        latest_label=latest_label,
        latest_completed_at=latest_completed_at,
    )


def _compute_overall_status(tasks: List[JobTask], progress: JobProgress) -> str:
    if any(t.status == STATUS_ISSUE for t in tasks):
        return STATUS_ISSUE
    if progress.total > 0 and progress.completed == progress.total:
        return STATUS_COMPLETED
    if any(t.status in (STATUS_COMPLETED, STATUS_IN_PROGRESS) for t in tasks):
        return STATUS_IN_PROGRESS
    return STATUS_NOT_STARTED


def to_job_read(job: Job) -> JobRead:
    """Convert ORM Job (with tasks loaded) to API response schema."""
    tasks_sorted = sorted(job.tasks, key=lambda t: t.sort_order)
    progress = _compute_progress(tasks_sorted)
    overall_status = _compute_overall_status(tasks_sorted, progress)

    docs_sorted = sorted(job.documents, key=lambda d: (d.uploaded_at, d.id))
    documents = [
        JobDocumentRead(
            id=d.id,
            job_id=d.job_id,
            title=d.title,
            original_filename=d.original_filename,
            stored_path=d.stored_path,
            content_type=d.content_type,
            category=getattr(d, "category", DOC_CATEGORY_FIELD),
            size_bytes=int(d.size_bytes),
            uploaded_at=d.uploaded_at,
            uploaded_by_user_id=d.uploaded_by_user_id,
            uploaded_by_username=d.uploaded_by.username if d.uploaded_by else None,
        )
        for d in docs_sorted
    ]
    photos_sorted = sorted(job.photos, key=lambda p: (p.uploaded_at, p.id))
    photos = [
        JobPhotoRead(
            id=p.id,
            job_id=p.job_id,
            original_filename=p.original_filename,
            stored_path=p.stored_path,
            content_type=p.content_type,
            size_bytes=int(p.size_bytes),
            uploaded_at=p.uploaded_at,
            uploaded_by_user_id=p.uploaded_by_user_id,
            uploaded_by_username=p.uploaded_by.username if p.uploaded_by else None,
        )
        for p in photos_sorted
    ]
    sketches_sorted = sorted(job.sketches, key=lambda s: (s.updated_at, s.id), reverse=True)
    sketches = [
        JobSketchRead(
            id=s.id,
            job_id=s.job_id,
            title=s.title,
            grid_spacing_inches=int(s.grid_spacing_inches),
            content_version=int(s.content_version),
            created_at=s.created_at,
            updated_at=s.updated_at,
            created_by_user_id=s.created_by_user_id,
            created_by_username=s.created_by.username if s.created_by else None,
            updated_by_user_id=s.updated_by_user_id,
            updated_by_username=s.updated_by.username if s.updated_by else None,
        )
        for s in sketches_sorted
    ]
    notes_sorted = sorted(job.job_notes, key=lambda n: (n.created_at, n.id), reverse=True)
    job_notes = [
        JobNoteRead(
            id=n.id,
            job_id=n.job_id,
            author_user_id=n.author_user_id,
            author_username=n.author.username if n.author else None,
            author_role=n.author.role if n.author else None,
            body=n.body,
            created_at=n.created_at,
        )
        for n in notes_sorted
    ]

    links_sorted = sorted(job.contact_links, key=lambda x: x.sort_order)
    contacts_out: List[JobContactEntry] = []
    for link in links_sorted:
        c = link.contact
        if c is None:
            continue
        contacts_out.append(
            JobContactEntry(
                id=c.id,
                label=c.label,
                name=c.name,
                phone=c.phone,
                email=c.email,
            )
        )

    return JobRead(
        id=job.id,
        customer_name=job.customer_name,
        job_type=job.job_type,
        address=job.address,
        pool_type=job.pool_type,
        permit_status=job.permit_status,
        permit_number=job.permit_number,
        field_manager=job.field_manager,
        notes=job.notes,
        contacts=contacts_out,
        archived=job.archived,
        created_at=job.created_at,
        updated_at=job.updated_at,
        tasks=[JobTaskRead.model_validate(t) for t in tasks_sorted],
        documents=documents,
        photos=photos,
        sketches=sketches,
        job_notes=job_notes,
        progress=progress,
        overall_status=overall_status,
        docs_rel_path=docs_dir_relative(job.docs_folder_name)
        if job.docs_folder_name
        else None,
        photos_rel_path=photos_dir_relative(job.photos_folder_name)
        if job.photos_folder_name
        else None,
        sketches_rel_path=sketches_dir_relative(job.sketches_folder_name)
        if job.sketches_folder_name
        else None,
    )


def to_job_read_list(jobs: List[Job]) -> List[JobRead]:
    return [to_job_read(j) for j in jobs]
