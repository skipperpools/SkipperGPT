"""Data access for Web Push subscriptions."""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import PushSubscription


def list_for_user(db: Session, user_id: int) -> List[PushSubscription]:
    stmt = select(PushSubscription).where(PushSubscription.user_id == user_id)
    return list(db.execute(stmt).scalars().all())


def get_by_endpoint(db: Session, endpoint: str) -> Optional[PushSubscription]:
    stmt = select(PushSubscription).where(PushSubscription.endpoint == endpoint)
    return db.execute(stmt).scalar_one_or_none()


def upsert_subscription(
    db: Session,
    *,
    user_id: int,
    endpoint: str,
    p256dh: str,
    auth: str,
) -> PushSubscription:
    existing = get_by_endpoint(db, endpoint)
    if existing is not None:
        existing.user_id = user_id
        existing.p256dh = p256dh
        existing.auth = auth
        db.commit()
        db.refresh(existing)
        return existing
    row = PushSubscription(
        user_id=user_id,
        endpoint=endpoint,
        p256dh=p256dh,
        auth=auth,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def delete_by_endpoint(db: Session, endpoint: str) -> None:
    row = get_by_endpoint(db, endpoint)
    if row is not None:
        db.delete(row)
        db.commit()


def delete_all_for_user(db: Session, user_id: int) -> None:
    for row in list_for_user(db, user_id):
        db.delete(row)
    db.commit()
