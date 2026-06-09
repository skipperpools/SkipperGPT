"""Web Push delivery for task events."""
from __future__ import annotations

import json
import logging
from typing import Optional

from sqlalchemy.orm import Session

from ..config import settings
from ..repositories import push_subscriptions_repo

logger = logging.getLogger(__name__)


def _vapid_claims() -> Optional[dict]:
    if not settings.vapid_private_key or not settings.vapid_public_key:
        return None
    email = settings.vapid_contact_email or "mailto:admin@skipperpools.net"
    return {"sub": email}


def send_push_to_user(
    db: Session,
    *,
    user_id: int,
    title: str,
    body: str,
    url: str = "/",
) -> None:
    from ..models import User

    user = db.get(User, user_id)
    if user is None or not user.push_enabled:
        return
    claims = _vapid_claims()
    if claims is None:
        return

    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        logger.warning("pywebpush not installed; skipping push")
        return

    payload = json.dumps({"title": title, "body": body, "url": url})
    subs = push_subscriptions_repo.list_for_user(db, user_id)
    stale: list[str] = []
    for sub in subs:
        subscription_info = {
            "endpoint": sub.endpoint,
            "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=settings.vapid_private_key,
                vapid_claims=claims,
            )
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in {404, 410}:
                stale.append(sub.endpoint)
            else:
                logger.warning("Push failed for user %s: %s", user_id, exc)
        except Exception as exc:
            logger.warning("Push failed for user %s: %s", user_id, exc)

    for endpoint in stale:
        push_subscriptions_repo.delete_by_endpoint(db, endpoint)
