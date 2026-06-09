"""Web Push subscription management."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps.auth import get_current_user
from ..models import User
from ..repositories import push_subscriptions_repo, users_repo
from ..schemas import PushEnabledUpdate, PushSubscriptionCreate, VapidPublicKeyRead

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/vapid-public-key", response_model=VapidPublicKeyRead)
def get_vapid_public_key(
    _user: User = Depends(get_current_user),
) -> VapidPublicKeyRead:
    key = settings.vapid_public_key
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Push notifications are not configured on this server",
        )
    return VapidPublicKeyRead(public_key=key)


@router.post("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
def subscribe_push(
    payload: PushSubscriptionCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> None:
    push_subscriptions_repo.upsert_subscription(
        db,
        user_id=current.id,
        endpoint=payload.endpoint,
        p256dh=payload.p256dh,
        auth=payload.auth,
    )


@router.delete("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
def unsubscribe_push(
    payload: PushSubscriptionCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> None:
    push_subscriptions_repo.delete_by_endpoint(db, payload.endpoint)


@router.patch("/me/push-enabled", response_model=dict)
def set_push_enabled(
    payload: PushEnabledUpdate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> dict:
    users_repo.update_user(db, user=current, fields={"push_enabled": payload.push_enabled})
    if not payload.push_enabled:
        push_subscriptions_repo.delete_all_for_user(db, current.id)
    db.refresh(current)
    return {"push_enabled": current.push_enabled}
