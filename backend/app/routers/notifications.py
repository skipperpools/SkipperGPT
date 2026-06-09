"""HTTP routes for in-app notifications."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps.auth import get_current_user, require_roles
from ..models import User
from ..repositories import notifications_repo, user_task_notifications_repo, user_tasks_repo
from ..schemas import NotificationCountsRead, NotificationRead, NotificationUpdate

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("/counts", response_model=NotificationCountsRead)
def notification_counts(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationCountsRead:
    billing = 0
    if user.role in {"admin", "office"}:
        billing = notifications_repo.count_unbilled(db)
    assigned = user_tasks_repo.count_open_for_assignee(db, user.id)
    creator = user_task_notifications_repo.count_unread_for_recipient(db, user.id)
    return NotificationCountsRead(
        billing_unbilled_count=billing,
        assigned_open_count=assigned,
        creator_unread_count=creator,
    )


@router.get("", response_model=List[NotificationRead])
def list_notifications(
    _user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> List[NotificationRead]:
    return notifications_repo.list_notifications(db)


@router.patch("/{notification_id}", response_model=NotificationRead)
def update_notification(
    notification_id: int,
    payload: NotificationUpdate,
    user: User = Depends(require_roles("admin", "office")),
    db: Session = Depends(get_db),
) -> NotificationRead:
    item = notifications_repo.get_notification(db, notification_id=notification_id)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Notification not found",
        )
    return notifications_repo.set_notification_billed(
        db,
        item=item,
        billed=payload.billed,
        billed_by_user_id=user.id,
    )
