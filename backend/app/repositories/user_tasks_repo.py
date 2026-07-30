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


def list_for_job(db: Session, job_id: int) -> List[UserTask]:
    """All tasks (any assignee) linked to a given job, for display on its Job Card."""
    stmt = (
        select(UserTask)
        .options(selectinload(UserTask.attachments))
        .where(UserTask.job_id == job_id)
        .order_by(UserTask.completed.asc(), UserTask.created_at.asc(), UserTask.id.asc())
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
    job_id: Optional[int] = None,
) -> UserTask:
    task = UserTask(
        user_id=creator_id,
        assignee_id=assignee_id,
        title=title.strip(),
        note=note.strip() if note else None,
        sort_order=_next_sort_order(db, assignee_id),
        category=category,
        job_id=job_id,
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


def reorder_user_task(
    db: Session,
    *,
    task: UserTask,
    target_index: int,
    category: Optional[str] = None,
) -> bool:
    """Move task to target_index (0-based) within its category column for its
    assignee, optionally recategorizing it first (a cross-column drag/drop).

    sort_order remains a single sequence per assignee across all categories;
    columns are just filtered views of that sequence. To land the task at
    target_index *within its column* while leaving every other task's
    relative order (in any column) untouched, we take the assignee's full
    order minus this task, locate where the same-category siblings sit
    within that sequence, splice the task in at the right spot, and
    renumber sort_order sequentially.
    """
    new_category = category if category is not None else task.category
    rows = list_for_assignee(db, task.assignee_id)
    if not any(row.id == task.id for row in rows):
        return False

    others = [row for row in rows if row.id != task.id]
    task.category = new_category

    sibling_positions = [i for i, row in enumerate(others) if row.category == new_category]
    if not sibling_positions:
        insert_at = len(others)
    else:
        clamped = max(0, min(target_index, len(sibling_positions)))
        if clamped >= len(sibling_positions):
            insert_at = sibling_positions[-1] + 1
        else:
            insert_at = sibling_positions[clamped]

    others.insert(insert_at, task)
    for i, row in enumerate(others):
        row.sort_order = i

    db.commit()
    return True
