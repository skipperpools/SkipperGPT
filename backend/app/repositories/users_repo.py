"""Data access for application users."""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..constants import ROLE_JOB_TYPES
from ..models import User, UserJobTypeGrant


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
    job_type_grants: Optional[List[str]] = None,
) -> User:
    user = User(username=username, hashed_password=hashed_password, role=role)
    if job_type_grants:
        _apply_job_type_grants(user, job_type_grants)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _apply_job_type_grants(user: User, job_types: Optional[List[str]]) -> None:
    """Replace the user's grants. When job_types is None, keep the current set.
    Grants the (possibly new) role already covers are dropped, so only access
    beyond the role is stored and a role change never leaves stale extras."""
    wanted = set(user.job_type_grants if job_types is None else job_types)
    wanted -= ROLE_JOB_TYPES.get(user.role, frozenset())
    current = {g.job_type: g for g in user.job_type_grant_rows}
    for jt, row in current.items():
        if jt not in wanted:
            user.job_type_grant_rows.remove(row)
    for jt in sorted(wanted - current.keys()):
        user.job_type_grant_rows.append(UserJobTypeGrant(job_type=jt))


def update_user(
    db: Session,
    *,
    user: User,
    fields: dict,
    job_type_grants: Optional[List[str]] = None,
) -> User:
    for key, value in fields.items():
        setattr(user, key, value)
    if job_type_grants is not None or "role" in fields:
        _apply_job_type_grants(user, job_type_grants)
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, *, user: User) -> None:
    db.delete(user)
    db.commit()
