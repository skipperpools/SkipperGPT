"""Per-user personal task lists (separate from job checklist tasks)."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps.auth import get_current_user, require_roles
from ..models import User, UserTask
from ..repositories import user_tasks_repo
from ..schemas import UserTaskCreate, UserTaskMove, UserTaskRead, UserTaskUpdate

router = APIRouter(prefix="/api/user-tasks", tags=["user-tasks"])
_admin = Depends(require_roles("admin"))


def _can_access_task(user: User, task: UserTask) -> bool:
    return task.user_id == user.id or user.role == "admin"


def _to_read(item: UserTask, owner_username: str | None = None) -> UserTaskRead:
    return UserTaskRead(
        id=item.id,
        user_id=item.user_id,
        title=item.title,
        completed=item.completed,
        note=item.note,
        sort_order=item.sort_order,
        completed_at=item.completed_at,
        created_at=item.created_at,
        updated_at=item.updated_at,
        owner_username=owner_username,
    )


def _get_task_or_404(db: Session, task_id: int) -> UserTask:
    task = user_tasks_repo.get_task(db, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


def _require_task_access(user: User, task: UserTask) -> None:
    if not _can_access_task(user, task):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")


@router.get("/mine", response_model=List[UserTaskRead])
def list_my_user_tasks(
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> List[UserTaskRead]:
    items = user_tasks_repo.list_for_user(db, current.id)
    return [_to_read(i) for i in items]


@router.get("", response_model=List[UserTaskRead])
def list_all_user_tasks(
    user_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    _: User = _admin,
) -> List[UserTaskRead]:
    rows = user_tasks_repo.list_all_with_usernames(db, user_id=user_id)
    return [_to_read(item, owner_username=uname) for item, uname in rows]


@router.post("", response_model=UserTaskRead, status_code=status.HTTP_201_CREATED)
def create_user_task_route(
    payload: UserTaskCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> UserTaskRead:
    item = user_tasks_repo.create_task(
        db, user_id=current.id, title=payload.title, note=payload.note
    )
    return _to_read(item)


@router.patch("/{task_id}", response_model=UserTaskRead)
def update_user_task_route(
    task_id: int,
    payload: UserTaskUpdate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> UserTaskRead:
    task = _get_task_or_404(db, task_id)
    _require_task_access(current, task)
    raw = payload.model_dump(exclude_unset=True)
    if not raw:
        uname = None
        if current.role == "admin" and task.user_id != current.id:
            owner = db.get(User, task.user_id)
            uname = owner.username if owner else None
        return _to_read(task, owner_username=uname)
    user_tasks_repo.update_task(db, task=task, fields=raw)
    uname = None
    if current.role == "admin":
        owner = db.get(User, task.user_id)
        uname = owner.username if owner else None
    return _to_read(task, owner_username=uname)


@router.patch("/{task_id}/move", response_model=UserTaskRead)
def move_user_task_route(
    task_id: int,
    payload: UserTaskMove,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> UserTaskRead:
    task = _get_task_or_404(db, task_id)
    _require_task_access(current, task)
    user_tasks_repo.move_task(db, task=task, direction=payload.direction)
    db.refresh(task)
    uname = None
    if current.role == "admin":
        owner = db.get(User, task.user_id)
        uname = owner.username if owner else None
    return _to_read(task, owner_username=uname)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user_task_route(
    task_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> None:
    task = _get_task_or_404(db, task_id)
    _require_task_access(current, task)
    user_tasks_repo.delete_task(db, task=task)
