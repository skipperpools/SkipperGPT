"""Data access for user task attachments."""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import UserTaskAttachment


def list_for_task(db: Session, task_id: int) -> List[UserTaskAttachment]:
    stmt = (
        select(UserTaskAttachment)
        .where(UserTaskAttachment.user_task_id == task_id)
        .order_by(UserTaskAttachment.uploaded_at.asc(), UserTaskAttachment.id.asc())
    )
    return list(db.execute(stmt).scalars().all())


def get_attachment(db: Session, attachment_id: int) -> Optional[UserTaskAttachment]:
    return db.get(UserTaskAttachment, attachment_id)


def add_attachment(
    db: Session,
    *,
    task_id: int,
    original_filename: str,
    stored_path: str,
    content_type: str,
    attachment_kind: str,
    size_bytes: int,
    uploaded_by_user_id: Optional[int],
) -> UserTaskAttachment:
    row = UserTaskAttachment(
        user_task_id=task_id,
        original_filename=original_filename,
        stored_path=stored_path,
        content_type=content_type,
        attachment_kind=attachment_kind,
        size_bytes=size_bytes,
        uploaded_by_user_id=uploaded_by_user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def delete_attachment(db: Session, *, attachment: UserTaskAttachment) -> None:
    db.delete(attachment)
    db.commit()
