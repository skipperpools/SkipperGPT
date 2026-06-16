"""Data access for per-user personal task lists."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..models import User, UserTask


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def list_for_assignee(db: Session, assignee_id: int) -> List[UserTask]:
    stmt = (
        select(UserTask)
        .options(selectinload(UserTask.attachments))
        .where(UserTask.assignee_id == assignee_id)
        .order_by(UserTask.is_pinned.desc(), UserTask.sort_order.asc(), UserTask.id.asc())
    )
    return list(db.execute(stmt).scalars().all())


def list_created_by(db: Session, creator_id: int) -> List[UserTask]:
    """Tasks created by user and assigned to someone else (excludes self-assigned)."""
    stmt = (
        select(UserTask)
        .options(selectinload(UserTask.attachments))
        .where(UserTask.user_id == creator_id, UserTask.assignee_id != UserTask.user_id)
        .order_by(UserTask.created_at.desc(), UserTask.id.desc())
    )
    return list(db.execute(stmt).scalars().all())


def list_all_with_usernames(
    db: Session,
    *,
    assignee_id: Optional[int] = None,
    creator_id: Optional[int] = None,
) -> List[Tuple[UserTask, str, str]]:
    from sqlalchemy.orm import aliased

    Creator = aliased(User)
    Assignee = aliased(User)
    stmt = (
        select(UserTask, Creator.username, Assignee.username)
        .join(Creator, UserTask.user_id == Creator.id)
        .join(Assignee, UserTask.assignee_id == Assignee.id)
        .options(selectinload(UserTask.attachments))
        .order_by(
            Assignee.username.asc(),
            UserTask.is_pinned.desc(),
            UserTask.sort_order.asc(),
            UserTask.id.asc(),
        )
    )
    if assignee_id is not None:
        stmt = stmt.where(UserTask.assignee_id == assignee_id)
    if creator_id is not None:
        stmt = stmt.where(UserTask.user_id == creator_id)
    return list(db.execute(stmt).all())


def count_open_for_assignee(db: Session, assignee_id: int) -> int:
    stmt = (
        select(func.count())
        .select_from(UserTask)
        .where(UserTask.assignee_id == assignee_id, UserTask.completed.is_(False))
    )
    return int(db.execute(stmt).scalar_one())


def get_task(db: Session, task_id: int) -> Optional[UserTask]:
    stmt = (
        select(UserTask)
        .options(selectinload(UserTask.attachments))
        .where(UserTask.id == task_id)
    )
    return db.execute(stmt).scalar_one_or_none()


def _next_sort_order(db: Session, assignee_id: int) -> int:
    current = db.execute(
        select(func.coalesce(func.max(UserTask.sort_order), -1)).where(
            UserTask.assignee_id == assignee_id
        )
    ).scalar_one()
    return int(current) + 1


def create_task(
    db: Session,
    *,
    creator_id: int,
    assignee_id: int,
    title: str,
    note: Optional[str] = None,
    category: str = "general",
) -> UserTask:
    task = UserTask(
        user_id=creator_id,
        assignee_id=assignee_id,
        title=title.strip(),
        note=note.strip() if note else None,
        sort_order=_next_sort_order(db, assignee_id),
        category=category,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return get_task(db, task.id) or task


def update_task(db: Session, *, task: UserTask, fields: dict) -> UserTask:
    new_completed = fields.get("completed")
    if new_completed is not None and new_completed != task.completed:
        if new_completed:
            if task.completed_at is None:
                task.completed_at = _utcnow()
        else:
            task.completed_at = None

    new_assignee = fields.get("assignee_id")
    if new_assignee is not None and new_assignee != task.assignee_id:
        task.assignee_id = new_assignee
        task.sort_order = _next_sort_order(db, new_assignee)
        fields = {k: v for k, v in fields.items() if k != "assignee_id"}

    for key, value in fields.items():
        if key == "note" and value is not None:
            value = value.strip() or None
        if key == "title" and value is not None:
            value = value.strip()
        if key == "assignee_id":
            continue
        setattr(task, key, value)

    db.commit()
    db.refresh(task)
    return get_task(db, task.id) or task


def delete_task(db: Session, *, task: UserTask) -> None:
    db.delete(task)
    db.commit()


def move_task(db: Session, *, task: UserTask, direction: str) -> bool:
    """Move task one position up/down within assignee list. Returns True when order changed."""
    rows = list_for_assignee(db, task.assignee_id)
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
