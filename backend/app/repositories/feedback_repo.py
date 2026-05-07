"""Data access for user feedback (requests / bugs)."""
from __future__ import annotations

from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import FeedbackItem, User


def create_feedback(db: Session, *, user_id: int, kind: str, body: str) -> FeedbackItem:
    item = FeedbackItem(user_id=user_id, kind=kind, body=body.strip())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def list_for_user(db: Session, user_id: int) -> List[FeedbackItem]:
    stmt = (
        select(FeedbackItem)
        .where(FeedbackItem.user_id == user_id)
        .order_by(FeedbackItem.created_at.desc())
    )
    return list(db.execute(stmt).scalars().all())


def list_all_with_usernames(db: Session) -> List[Tuple[FeedbackItem, str]]:
    stmt = (
        select(FeedbackItem, User.username)
        .join(User, FeedbackItem.user_id == User.id)
        .order_by(FeedbackItem.created_at.desc())
    )
    return list(db.execute(stmt).all())


def get_feedback(db: Session, feedback_id: int) -> Optional[FeedbackItem]:
    return db.get(FeedbackItem, feedback_id)


def update_feedback(db: Session, *, item: FeedbackItem, fields: dict) -> FeedbackItem:
    for key, value in fields.items():
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item
