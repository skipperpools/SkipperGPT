"""User management (admin only)."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..auth_utils import get_password_hash
from ..database import get_db
from ..deps.auth import require_roles
from ..models import User
from ..repositories import users_repo
from ..schemas import UserCreate, UserRead, UserUpdate

router = APIRouter(prefix="/api/users", tags=["users"])
_admin = Depends(require_roles("admin"))


@router.get("", response_model=List[UserRead])
def list_users(
    db: Session = Depends(get_db),
    _: User = _admin,
) -> List[User]:
    return users_repo.list_users(db)


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user_route(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _: User = _admin,
) -> User:
    if users_repo.get_user_by_username(db, payload.username):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already taken",
        )
    hashed = get_password_hash(payload.password)
    return users_repo.create_user(
        db,
        username=payload.username,
        hashed_password=hashed,
        role=payload.role,
    )


@router.patch("/{user_id}", response_model=UserRead)
def update_user_route(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = _admin,
) -> User:
    user = users_repo.get_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    raw = payload.model_dump(exclude_unset=True)
    if not raw:
        return user
    fields: dict = {}
    if "username" in raw:
        other = users_repo.get_user_by_username(db, raw["username"])
        if other is not None and other.id != user.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Username already taken",
            )
        fields["username"] = raw["username"]
    if "password" in raw:
        fields["hashed_password"] = get_password_hash(raw["password"])
    if "role" in raw:
        fields["role"] = raw["role"]
    if "is_active" in raw:
        fields["is_active"] = raw["is_active"]
    return users_repo.update_user(db, user=user, fields=fields)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user_route(
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = _admin,
) -> None:
    user = users_repo.get_user(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete your own account",
        )
    users_repo.delete_user(db, user=user)
