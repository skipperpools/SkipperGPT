"""Shared contacts directory (admin/office CRUD)."""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps.auth import get_current_user, require_roles
from ..models import User
from ..repositories import contacts_repo
from ..schemas import ContactCreate, ContactRead, ContactUpdate

router = APIRouter(prefix="/api/contacts", tags=["contacts"])
_office_admin = Depends(require_roles("admin", "office"))


@router.get("", response_model=List[ContactRead])
def list_contacts(
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[ContactRead]:
    return contacts_repo.list_contacts(db)


@router.post("", response_model=ContactRead, status_code=status.HTTP_201_CREATED)
def create_contact_route(
    payload: ContactCreate,
    db: Session = Depends(get_db),
    _: User = _office_admin,
) -> ContactRead:
    fields = payload.model_dump(exclude_unset=True)
    return contacts_repo.create_contact(db, fields=fields)


@router.patch("/{contact_id}", response_model=ContactRead)
def update_contact_route(
    contact_id: int,
    payload: ContactUpdate,
    db: Session = Depends(get_db),
    _: User = _office_admin,
) -> ContactRead:
    contact = contacts_repo.get_contact(db, contact_id)
    if contact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found")
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        return ContactRead.model_validate(contact)
    return contacts_repo.update_contact(db, contact=contact, fields=fields)


@router.delete("/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact_route(
    contact_id: int,
    db: Session = Depends(get_db),
    _: User = _office_admin,
) -> None:
    contact = contacts_repo.get_contact(db, contact_id)
    if contact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found")
    try:
        contacts_repo.delete_contact(db, contact=contact)
    except IntegrityError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Contact is assigned to one or more jobs; remove it from those jobs first.",
        ) from exc
