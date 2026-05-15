"""HTTP routes for jobs and tasks."""
from __future__ import annotations

from datetime import date
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from ..constants import (
    BILLING_NOTIFICATION_TASK_KEYS,
    JOB_TYPE_MISC,
    JOB_TYPE_NEW_CONSTRUCTION,
    JOB_TYPE_RENOVATION,
    JOB_TYPE_SALES,
    NOTIFICATION_TYPE_BILLING,
    STATUS_COMPLETED,
    VALID_JOB_TYPES,
)
from ..config import settings
from ..database import get_db
from ..deps.auth import get_current_user, require_roles
from ..models import User
from ..repositories import jobs_repo, notifications_repo
from ..schemas import (
    JobCreate,
    JobNoteCreate,
    JobNoteRead,
    JobRead,
    JobTaskCreate,
    JobTaskMove,
    JobTaskUpdate,
    JobTypeConvertRequest,
    JobTypeTaskTemplateCreate,
    JobTypeTaskTemplateRead,
    JobUpdate,
)
from ..services.job_disk_sync import sync_job_attachments_from_disk
from ..services.job_docs_fs import move_job_docs_on_rename
from ..services.job_photos_fs import move_job_photos_on_rename
from ..schedule_pdf import build_schedule_pdf
from ..services.jobs_service import to_job_read, to_job_read_list

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _to_job_note_read(note) -> JobNoteRead:
    return JobNoteRead(
        id=note.id,
        job_id=note.job_id,
        author_user_id=note.author_user_id,
        author_username=note.author.username if note.author else None,
        author_role=note.author.role if note.author else None,
        body=note.body,
        created_at=note.created_at,
    )


@router.get("", response_model=List[JobRead])
def list_jobs(
    include_archived: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[JobRead]:
    jobs = jobs_repo.list_jobs(db, include_archived=include_archived)
    if user.role == "field":
        jobs = [job for job in jobs if job.job_type != JOB_TYPE_SALES]
    return to_job_read_list(jobs)


@router.get("/schedule.pdf")
def export_schedule_pdf(
    include_archived: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    jobs = jobs_repo.list_jobs(db, include_archived=include_archived)
    if user.role == "field":
        jobs = [job for job in jobs if job.job_type != JOB_TYPE_SALES]
    pdf_bytes = build_schedule_pdf(jobs, as_of=date.today())
    filename = f"Schedules-{date.today().isoformat()}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{job_id}", response_model=JobRead)
def get_job(
    job_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    sync_job_attachments_from_disk(db, job, settings.docs_root)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.post("", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_job(
    payload: JobCreate,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobRead:
    data = payload.model_dump(exclude_unset=True)
    contact_ids = data.pop("contact_ids", None)
    clone_from_job_id = data.pop("clone_from_job_id", None)
    source_job = None
    if clone_from_job_id is not None:
        source_job = jobs_repo.get_job(db, clone_from_job_id)
        if source_job is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Source job to clone from not found",
            )
    try:
        job = jobs_repo.create_job(db, fields=data, contact_ids=contact_ids)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    if source_job is not None:
        seeded_keys = jobs_repo.seeded_task_keys_for_job_type(
            db, job_type=source_job.job_type
        )
        for src_task in source_job.tasks:
            if src_task.task_key not in seeded_keys:
                jobs_repo.add_job_task(db, job=job, task_label=src_task.task_label)
    sync_job_attachments_from_disk(db, job, settings.docs_root)
    job = jobs_repo.get_job(db, job.id)
    assert job is not None
    return to_job_read(job)


@router.patch("/{job_id}", response_model=JobRead)
def update_job(
    job_id: int,
    payload: JobUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    fields = payload.model_dump(exclude_unset=True)
    contact_ids = fields.pop("contact_ids", None)
    next_job_type = fields.get("job_type")
    if next_job_type is not None and next_job_type != job.job_type:
        if user.role not in ("admin", "office"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only admin and office users can change job type",
            )
    if not fields and contact_ids is None:
        return to_job_read(job)
    wants_archive = "archived" in fields
    non_archive_fieldnames = {k for k in fields if k != "archived"}
    disallowed_for_field = non_archive_fieldnames - {"notes"}
    if wants_archive and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators can archive or unarchive jobs",
        )
    if disallowed_for_field and user.role == "field":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Field users cannot edit job details",
        )
    if user.role == "field" and contact_ids is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Field users cannot edit job contacts assignment",
        )
    if "customer_name" in fields and fields["customer_name"] != job.customer_name:
        try:
            move_job_docs_on_rename(
                db,
                job=job,
                new_customer_name=fields["customer_name"],
                docs_root=settings.docs_root,
            )
            move_job_photos_on_rename(
                db,
                job=job,
                new_customer_name=fields["customer_name"],
                docs_root=settings.docs_root,
            )
        except OSError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc
    if fields:
        jobs_repo.update_job(db, job=job, fields=fields)
    if contact_ids is not None:
        try:
            jobs_repo.replace_job_contact_links(db, job_id, contact_ids)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
            ) from exc
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_job(
    job_id: int,
    _user: User = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
) -> None:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    jobs_repo.delete_job(db, job=job)


@router.get("/{job_id}/notes", response_model=List[JobNoteRead])
def list_job_notes(
    job_id: int,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[JobNoteRead]:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    notes = jobs_repo.list_job_notes(db, job_id=job_id)
    return [_to_job_note_read(note) for note in notes]


@router.post("/{job_id}/notes", response_model=JobNoteRead, status_code=status.HTTP_201_CREATED)
def create_job_note(
    job_id: int,
    payload: JobNoteCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobNoteRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    note = jobs_repo.create_job_note(
        db,
        job_id=job_id,
        author_user_id=user.id,
        body=payload.body,
    )
    note = jobs_repo.get_job_note(db, job_id=job_id, note_id=note.id)
    assert note is not None
    return _to_job_note_read(note)


@router.delete("/{job_id}/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_job_note(
    job_id: int,
    note_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    note = jobs_repo.get_job_note(db, job_id=job_id, note_id=note_id)
    if note is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job note not found")
    if user.role != "admin" and note.author_user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only delete notes you posted",
        )
    jobs_repo.delete_job_note(db, note=note)


@router.post("/{job_id}/tasks", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def create_custom_task(
    job_id: int,
    payload: JobTaskCreate,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobRead:
    job = jobs_repo.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    jobs_repo.add_job_task(db, job=job, task_label=payload.task_label)
    refreshed = jobs_repo.get_job(db, job_id)
    assert refreshed is not None
    return to_job_read(refreshed)


@router.post("/{job_id}/convert-sales", response_model=JobRead)
def convert_sales_job(
    job_id: int,
    payload: JobTypeConvertRequest,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobRead:
    source_job = jobs_repo.get_job(db, job_id)
    if source_job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if source_job.job_type != JOB_TYPE_SALES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only Sales jobs can be converted with this route",
        )
    if payload.target_job_type not in {
        JOB_TYPE_NEW_CONSTRUCTION,
        JOB_TYPE_RENOVATION,
        JOB_TYPE_MISC,
    }:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="target_job_type must be one of ['misc', 'new_construction', 'renovation']",
        )
    create_fields = {
        "customer_name": source_job.customer_name,
        "job_type": payload.target_job_type,
        "address": source_job.address,
        "pool_type": source_job.pool_type,
        "permit_status": source_job.permit_status,
        "permit_number": source_job.permit_number,
        "field_manager": source_job.field_manager,
        "notes": source_job.notes,
        "archived": False,
    }
    contact_ids = [link.contact_id for link in source_job.contact_links]
    created_job = jobs_repo.create_job(
        db,
        fields=create_fields,
        contact_ids=contact_ids,
    )
    final_job = jobs_repo.get_job(db, created_job.id)
    assert final_job is not None
    return to_job_read(final_job)


@router.patch("/{job_id}/tasks/{task_key}/move", response_model=JobRead)
def move_task(
    job_id: int,
    task_key: str,
    payload: JobTaskMove,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobRead:
    task = jobs_repo.get_task(db, job_id=job_id, task_key=task_key)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_key}' not found on job {job_id}",
        )
    jobs_repo.move_job_task(
        db,
        job_id=job_id,
        task_key=task_key,
        direction=payload.direction,
    )
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.delete("/{job_id}/tasks/{task_key}", response_model=JobRead)
def delete_task(
    job_id: int,
    task_key: str,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobRead:
    task = jobs_repo.get_task(db, job_id=job_id, task_key=task_key)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_key}' not found on job {job_id}",
        )
    jobs_repo.delete_job_task(db, task=task)
    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.patch("/{job_id}/tasks/{task_key}", response_model=JobRead)
def update_task(
    job_id: int,
    task_key: str,
    payload: JobTaskUpdate,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobRead:
    task = jobs_repo.get_task(db, job_id=job_id, task_key=task_key)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task '{task_key}' not found on job {job_id}",
        )
    fields = payload.model_dump(exclude_unset=True)
    prev_status = task.status
    if fields:
        jobs_repo.update_task(db, task=task, fields=fields)
        new_status = fields.get("status")
        if (
            prev_status != STATUS_COMPLETED
            and new_status == STATUS_COMPLETED
            and task.task_key in BILLING_NOTIFICATION_TASK_KEYS
        ):
            job_for_message = jobs_repo.get_job(db, job_id)
            if job_for_message is not None:
                notifications_repo.create_notification(
                    db,
                    type=NOTIFICATION_TYPE_BILLING,
                    title="Billing milestone completed",
                    message=(
                        f"{job_for_message.customer_name}: "
                        f"{task.task_label} was marked complete."
                    ),
                    job_id=job_id,
                    task_key=task.task_key,
                )

    job = jobs_repo.get_job(db, job_id)
    assert job is not None
    return to_job_read(job)


@router.get("/job-type-task-templates", response_model=List[JobTypeTaskTemplateRead])
def list_task_templates(
    job_type: str,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> List[JobTypeTaskTemplateRead]:
    if job_type not in VALID_JOB_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"job_type must be one of {sorted(VALID_JOB_TYPES)}",
        )
    return jobs_repo.list_job_type_task_templates(db, job_type=job_type)


@router.post(
    "/job-type-task-templates",
    response_model=JobTypeTaskTemplateRead,
    status_code=status.HTTP_201_CREATED,
)
def create_task_template(
    payload: JobTypeTaskTemplateCreate,
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> JobTypeTaskTemplateRead:
    row = jobs_repo.add_job_type_task_template(
        db,
        job_type=payload.job_type,
        task_label=payload.task_label,
    )
    return row
