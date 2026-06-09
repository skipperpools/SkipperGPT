"""Side effects when user tasks are assigned, completed, or reassigned."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..constants import (
    USER_TASK_NOTIFICATION_EVENT_COMPLETED,
    USER_TASK_NOTIFICATION_EVENT_REASSIGNED,
)
from ..models import User, UserTask
from ..repositories import user_task_notifications_repo
from .push_service import send_push_to_user


def _creator_username(db: Session, task: UserTask) -> str:
    creator = db.get(User, task.user_id)
    return creator.username if creator else "Someone"


def _assignee_username(db: Session, task: UserTask) -> str:
    assignee = db.get(User, task.assignee_id)
    return assignee.username if assignee else "Someone"


def notify_assignee_assigned(
    db: Session,
    *,
    task: UserTask,
    actor_username: str,
) -> None:
    if task.assignee_id == task.user_id:
        return
    title = "Task assigned to you"
    body = f'{actor_username} assigned "{task.title}" to you.'
    send_push_to_user(db, user_id=task.assignee_id, title=title, body=body, url="/")


def notify_creator_reassigned(
    db: Session,
    *,
    task: UserTask,
    actor_username: str,
    new_assignee_id: int,
) -> None:
    if task.user_id == new_assignee_id:
        return
    assignee_name = _assignee_username(db, task)
    title = "Task reassigned"
    message = (
        f'{actor_username} reassigned "{task.title}" to {assignee_name}.'
    )
    user_task_notifications_repo.create_notification(
        db,
        recipient_user_id=task.user_id,
        user_task_id=task.id,
        event=USER_TASK_NOTIFICATION_EVENT_REASSIGNED,
        title=title,
        message=message,
    )
    send_push_to_user(
        db,
        user_id=task.user_id,
        title=title,
        body=message,
        url="/",
    )


def notify_creator_completed(
    db: Session,
    *,
    task: UserTask,
    actor_username: str,
) -> None:
    if task.user_id == task.assignee_id:
        return
    title = "Task completed"
    message = f'{actor_username} completed "{task.title}".'
    user_task_notifications_repo.create_notification(
        db,
        recipient_user_id=task.user_id,
        user_task_id=task.id,
        event=USER_TASK_NOTIFICATION_EVENT_COMPLETED,
        title=title,
        message=message,
    )
    send_push_to_user(
        db,
        user_id=task.user_id,
        title=title,
        body=message,
        url="/",
    )
