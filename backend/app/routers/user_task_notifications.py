"""HTTP routes for user task creator notifications."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps.auth import get_current_user
from ..models import User
from ..repositories import user_task_notifications_repo
from ..schemas import UserTaskNotificationRead, UserTaskNotificationUpdate

router = APIRouter(prefix="/api/user-task-notifications", tags=["user-task-notifications"])


@router.get("/mine", response_model=List[UserTaskNotificationRead])
def list_my_task_notifications(
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> List[UserTaskNotificationRead]:
    items = user_task_notifications_repo.list_for_recipient(db, current.id)
    return [UserTaskNotificationRead.model_validate(i) for i in items]


@router.patch("/{notification_id}", response_model=UserTaskNotificationRead)
def update_task_notification(
    notification_id: int,
    payload: UserTaskNotificationUpdate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> UserTaskNotificationRead:
    item = user_task_notifications_repo.get_notification(db, notification_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    if item.recipient_user_id != current.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
    updated = user_task_notifications_repo.set_read(db, item=item, read=payload.read)
    return UserTaskNotificationRead.model_validate(updated)
