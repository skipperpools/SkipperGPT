"""Data access for application users."""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import User


def count_users(db: Session) -> int:
    stmt = select(func.count()).select_from(User)
    return int(db.execute(stmt).scalar_one())


def ensure_first_admin(db: Session, username: str, password: str) -> bool:
    """If there are no users, create an admin. Returns True if created."""
    from ..auth_utils import get_password_hash

    if count_users(db) > 0:
        return False
    create_user(
        db,
        username=username,
        hashed_password=get_password_hash(password),
        role="admin",
    )
    return True


def list_users(db: Session) -> List[User]:
    stmt = select(User).order_by(User.username)
    return list(db.execute(stmt).scalars().all())


def get_user(db: Session, user_id: int) -> Optional[User]:
    return db.get(User, user_id)


def get_user_by_username(db: Session, username: str) -> Optional[User]:
    stmt = select(User).where(User.username == username)
    return db.execute(stmt).scalar_one_or_none()


def create_user(
    db: Session,
    *,
    username: str,
    hashed_password: str,
    role: str,
) -> User:
    user = User(username=username, hashed_password=hashed_password, role=role)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def update_user(db: Session, *, user: User, fields: dict) -> User:
    for key, value in fields.items():
        setattr(user, key, value)
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, *, user: User) -> None:
    db.delete(user)
    db.commit()
