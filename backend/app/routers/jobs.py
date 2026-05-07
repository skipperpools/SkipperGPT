"""HTTP routes for jobs and tasks."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..constants import (
    BILLING_NOTIFICATION_TASK_KEYS,
    NOTIFICATION_TYPE_BILLING,
    STATUS_COMPLETED,
)
from ..config import settings
from ..database import get_db
from ..deps.auth import get_current_user, require_roles
from ..models import User
from ..repositories import jobs_repo, notifications_repo
from ..schemas import JobCreate, JobRead, JobTaskUpdate, JobUpdate
from ..services.job_disk_sync import sync_job_attachments_from_disk
from ..services.job_docs_fs import move_job_docs_on_rename
from ..services.job_photos_fs import move_job_photos_on_rename
from ..services.jobs_service import to_job_read, to_job_read_list

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("", response_model=List[JobRead])
def list_jobs(
    include_archived: bool = False,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[JobRead]:
    jobs = jobs_repo.list_jobs(db, include_archived=include_archived)
    for j in jobs:
        sync_job_attachments_from_disk(db, j, settings.docs_root)
    jobs = jobs_repo.list_jobs(db, include_archived=include_archived)
    return to_job_read_list(jobs)


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
    try:
        job = jobs_repo.create_job(db, fields=data, contact_ids=contact_ids)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
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
