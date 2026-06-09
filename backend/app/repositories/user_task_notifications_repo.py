"""Data access for user task creator notifications."""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import UserTaskNotification


def create_notification(
    db: Session,
    *,
    recipient_user_id: int,
    user_task_id: int,
    event: str,
    title: str,
    message: str,
) -> UserTaskNotification:
    item = UserTaskNotification(
        recipient_user_id=recipient_user_id,
        user_task_id=user_task_id,
        event=event,
        title=title,
        message=message,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def list_for_recipient(db: Session, recipient_user_id: int, *, limit: int = 200) -> List[UserTaskNotification]:
    stmt = (
        select(UserTaskNotification)
        .where(UserTaskNotification.recipient_user_id == recipient_user_id)
        .order_by(UserTaskNotification.created_at.desc(), UserTaskNotification.id.desc())
        .limit(limit)
    )
    return list(db.execute(stmt).scalars().all())


def count_unread_for_recipient(db: Session, recipient_user_id: int) -> int:
    stmt = (
        select(func.count())
        .select_from(UserTaskNotification)
        .where(
            UserTaskNotification.recipient_user_id == recipient_user_id,
            UserTaskNotification.read.is_(False),
        )
    )
    return int(db.execute(stmt).scalar_one())


def get_notification(db: Session, notification_id: int) -> Optional[UserTaskNotification]:
    return db.get(UserTaskNotification, notification_id)


def set_read(db: Session, *, item: UserTaskNotification, read: bool) -> UserTaskNotification:
    item.read = read
    db.commit()
    db.refresh(item)
    return item
