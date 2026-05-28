"""Data access for per-user personal task lists."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import User, UserTask


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def list_for_user(db: Session, user_id: int) -> List[UserTask]:
    stmt = (
        select(UserTask)
        .where(UserTask.user_id == user_id)
        .order_by(UserTask.sort_order.asc(), UserTask.id.asc())
    )
    return list(db.execute(stmt).scalars().all())


def list_all_with_usernames(
    db: Session, *, user_id: Optional[int] = None
) -> List[Tuple[UserTask, str]]:
    stmt = (
        select(UserTask, User.username)
        .join(User, UserTask.user_id == User.id)
        .order_by(User.username.asc(), UserTask.sort_order.asc(), UserTask.id.asc())
    )
    if user_id is not None:
        stmt = stmt.where(UserTask.user_id == user_id)
    return list(db.execute(stmt).all())


def get_task(db: Session, task_id: int) -> Optional[UserTask]:
    return db.get(UserTask, task_id)


def _next_sort_order(db: Session, user_id: int) -> int:
    current = db.execute(
        select(func.coalesce(func.max(UserTask.sort_order), -1)).where(
            UserTask.user_id == user_id
        )
    ).scalar_one()
    return int(current) + 1


def create_task(
    db: Session, *, user_id: int, title: str, note: Optional[str] = None
) -> UserTask:
    task = UserTask(
        user_id=user_id,
        title=title.strip(),
        note=note.strip() if note else None,
        sort_order=_next_sort_order(db, user_id),
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def update_task(db: Session, *, task: UserTask, fields: dict) -> UserTask:
    new_completed = fields.get("completed")
    if new_completed is not None and new_completed != task.completed:
        if new_completed:
            if task.completed_at is None:
                task.completed_at = _utcnow()
        else:
            task.completed_at = None

    for key, value in fields.items():
        if key == "note" and value is not None:
            value = value.strip() or None
        if key == "title" and value is not None:
            value = value.strip()
        setattr(task, key, value)

    db.commit()
    db.refresh(task)
    return task


def delete_task(db: Session, *, task: UserTask) -> None:
    db.delete(task)
    db.commit()


def move_task(db: Session, *, task: UserTask, direction: str) -> bool:
    """Move task one position up/down. Returns True when order changed."""
    rows = list_for_user(db, task.user_id)
    if not rows:
        return False
    idx = next((i for i, row in enumerate(rows) if row.id == task.id), -1)
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
