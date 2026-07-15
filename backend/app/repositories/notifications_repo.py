"""Data access helpers for in-app notifications."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import NotificationItem


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def create_notification(
    db: Session,
    *,
    type: str,
    title: str,
    message: str,
    job_id: Optional[int] = None,
    task_key: Optional[str] = None,
    completed_by: Optional[str] = None,
) -> NotificationItem:
    item = NotificationItem(
        type=type,
        title=title,
        message=message,
        job_id=job_id,
        task_key=task_key,
        completed_by=completed_by,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def list_notifications(db: Session, *, limit: int = 200) -> List[NotificationItem]:
    stmt = (
        select(NotificationItem)
        .order_by(NotificationItem.created_at.desc(), NotificationItem.id.desc())
        .limit(limit)
    )
    return list(db.execute(stmt).scalars().all())


def count_unbilled(db: Session) -> int:
    from sqlalchemy import func

    stmt = (
        select(func.count())
        .select_from(NotificationItem)
        .where(NotificationItem.billed.is_(False))
    )
    return int(db.execute(stmt).scalar_one())


def get_notification(db: Session, *, notification_id: int) -> Optional[NotificationItem]:
    stmt = select(NotificationItem).where(NotificationItem.id == notification_id)
    return db.execute(stmt).scalar_one_or_none()


def set_notification_billed(
    db: Session,
    *,
    item: NotificationItem,
    billed: bool,
    billed_by_user_id: Optional[int],
) -> NotificationItem:
    item.billed = billed
    if billed:
        item.billed_at = _utcnow()
        item.billed_by_user_id = billed_by_user_id
    else:
        item.billed_at = None
        item.billed_by_user_id = None
    db.commit()
    db.refresh(item)
    return item
