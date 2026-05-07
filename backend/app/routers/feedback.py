"""User feedback (requests / bugs): submit, list own, admin list/update."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps.auth import get_current_user, require_roles
from ..models import FeedbackItem, User
from ..repositories import feedback_repo
from ..schemas import FeedbackAdminUpdate, FeedbackCreate, FeedbackRead

router = APIRouter(prefix="/api/feedback", tags=["feedback"])
_admin = Depends(require_roles("admin"))


def _to_read(item: FeedbackItem, author_username: str | None = None) -> FeedbackRead:
    return FeedbackRead(
        id=item.id,
        user_id=item.user_id,
        kind=item.kind,
        body=item.body,
        status=item.status,
        admin_note=item.admin_note,
        created_at=item.created_at,
        updated_at=item.updated_at,
        author_username=author_username,
    )


@router.post("", response_model=FeedbackRead, status_code=status.HTTP_201_CREATED)
def create_feedback_route(
    payload: FeedbackCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> FeedbackRead:
    item = feedback_repo.create_feedback(
        db, user_id=current.id, kind=payload.kind, body=payload.body
    )
    return _to_read(item)


@router.get("/mine", response_model=List[FeedbackRead])
def list_my_feedback(
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> List[FeedbackRead]:
    items = feedback_repo.list_for_user(db, current.id)
    return [_to_read(i) for i in items]


@router.get("", response_model=List[FeedbackRead])
def list_all_feedback(
    db: Session = Depends(get_db),
    _: User = _admin,
) -> List[FeedbackRead]:
    rows = feedback_repo.list_all_with_usernames(db)
    return [_to_read(item, author_username=uname) for item, uname in rows]


@router.patch("/{feedback_id}", response_model=FeedbackRead)
def update_feedback_route(
    feedback_id: int,
    payload: FeedbackAdminUpdate,
    db: Session = Depends(get_db),
    _: User = _admin,
) -> FeedbackRead:
    item = feedback_repo.get_feedback(db, feedback_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feedback not found")
    raw = payload.model_dump(exclude_unset=True)
    if not raw:
        uname = db.get(User, item.user_id)
        return _to_read(item, author_username=uname.username if uname else None)
    fields: dict = {}
    if "status" in raw:
        fields["status"] = raw["status"]
    if "admin_note" in raw:
        fields["admin_note"] = raw["admin_note"]
    feedback_repo.update_feedback(db, item=item, fields=fields)
    uname = db.get(User, item.user_id)
    return _to_read(item, author_username=uname.username if uname else None)
