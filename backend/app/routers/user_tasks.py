"""Per-user personal task lists (separate from job checklist tasks)."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps.auth import get_current_user, require_roles
from ..models import User, UserTask
from ..repositories import user_tasks_repo, users_repo
from ..schemas import (
    UserTaskAttachmentRead,
    UserTaskCreate,
    UserTaskMove,
    UserTaskRead,
    UserTaskUpdate,
)
from ..services import user_task_events

router = APIRouter(prefix="/api/user-tasks", tags=["user-tasks"])
_admin = Depends(require_roles("admin"))


def _can_access_task(user: User, task: UserTask) -> bool:
    return user.role == "admin" or user.id in {task.user_id, task.assignee_id}


def _can_modify_attachments(user: User, task: UserTask) -> bool:
    return user.id in {task.user_id, task.assignee_id}


def _resolve_assignee(db: Session, assignee_id: Optional[int], current: User) -> User:
    target_id = assignee_id if assignee_id is not None else current.id
    assignee = users_repo.get_user(db, target_id)
    if assignee is None or not assignee.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Assignee not found or inactive",
        )
    return assignee


def _to_read(
    item: UserTask,
    *,
    creator_username: str | None = None,
    assignee_username: str | None = None,
) -> UserTaskRead:
    attachments = [
        UserTaskAttachmentRead.model_validate(a) for a in (item.attachments or [])
    ]
    return UserTaskRead(
        id=item.id,
        user_id=item.user_id,
        assignee_id=item.assignee_id,
        title=item.title,
        completed=item.completed,
        note=item.note,
        sort_order=item.sort_order,
        completed_at=item.completed_at,
        created_at=item.created_at,
        updated_at=item.updated_at,
        creator_username=creator_username,
        assignee_username=assignee_username,
        attachments=attachments,
    )


def _usernames_for_task(db: Session, task: UserTask) -> tuple[str | None, str | None]:
    creator = db.get(User, task.user_id)
    assignee = db.get(User, task.assignee_id)
    return (
        creator.username if creator else None,
        assignee.username if assignee else None,
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
    items = user_tasks_repo.list_for_assignee(db, current.id)
    out: List[UserTaskRead] = []
    for item in items:
        cname, aname = _usernames_for_task(db, item)
        out.append(_to_read(item, creator_username=cname, assignee_username=aname))
    return out


@router.get("/created", response_model=List[UserTaskRead])
def list_created_user_tasks(
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> List[UserTaskRead]:
    items = user_tasks_repo.list_created_by(db, current.id)
    out: List[UserTaskRead] = []
    for item in items:
        cname, aname = _usernames_for_task(db, item)
        out.append(_to_read(item, creator_username=cname, assignee_username=aname))
    return out


@router.get("", response_model=List[UserTaskRead])
def list_all_user_tasks(
    assignee_id: Optional[int] = Query(None),
    user_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    _: User = _admin,
) -> List[UserTaskRead]:
    rows = user_tasks_repo.list_all_with_usernames(
        db, assignee_id=assignee_id, creator_id=user_id
    )
    return [
        _to_read(item, creator_username=cname, assignee_username=aname)
        for item, cname, aname in rows
    ]


@router.post("", response_model=UserTaskRead, status_code=status.HTTP_201_CREATED)
def create_user_task_route(
    payload: UserTaskCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> UserTaskRead:
    assignee = _resolve_assignee(db, payload.assignee_id, current)
    item = user_tasks_repo.create_task(
        db,
        creator_id=current.id,
        assignee_id=assignee.id,
        title=payload.title,
        note=payload.note,
    )
    if assignee.id != current.id:
        user_task_events.notify_assignee_assigned(
            db, task=item, actor_username=current.username
        )
    cname, aname = _usernames_for_task(db, item)
    return _to_read(item, creator_username=cname, assignee_username=aname)


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
        cname, aname = _usernames_for_task(db, task)
        return _to_read(task, creator_username=cname, assignee_username=aname)

    prev_completed = task.completed
    prev_assignee_id = task.assignee_id

    if "assignee_id" in raw:
        assignee = _resolve_assignee(db, raw["assignee_id"], current)
        raw["assignee_id"] = assignee.id

    user_tasks_repo.update_task(db, task=task, fields=raw)
    db.refresh(task)
    task = _get_task_or_404(db, task_id)

    if task.assignee_id != prev_assignee_id:
        user_task_events.notify_assignee_assigned(
            db, task=task, actor_username=current.username
        )
        user_task_events.notify_creator_reassigned(
            db,
            task=task,
            actor_username=current.username,
            new_assignee_id=task.assignee_id,
        )

    if not prev_completed and task.completed:
        user_task_events.notify_creator_completed(
            db, task=task, actor_username=current.username
        )

    cname, aname = _usernames_for_task(db, task)
    return _to_read(task, creator_username=cname, assignee_username=aname)


@router.patch("/{task_id}/move", response_model=UserTaskRead)
def move_user_task_route(
    task_id: int,
    payload: UserTaskMove,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> UserTaskRead:
    task = _get_task_or_404(db, task_id)
    _require_task_access(current, task)
    if task.assignee_id != current.id and current.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the assignee can reorder this task",
        )
    user_tasks_repo.move_task(db, task=task, direction=payload.direction)
    task = _get_task_or_404(db, task_id)
    cname, aname = _usernames_for_task(db, task)
    return _to_read(task, creator_username=cname, assignee_username=aname)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user_task_route(
    task_id: int,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> None:
    task = _get_task_or_404(db, task_id)
    _require_task_access(current, task)
    user_tasks_repo.delete_task(db, task=task)
