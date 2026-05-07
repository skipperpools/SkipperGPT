"""Data access for shared contacts directory."""
from __future__ import annotations

from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Contact


def list_contacts(db: Session) -> List[Contact]:
    """All contacts, stable sort by name then id."""
    name_sort = func.lower(func.coalesce(Contact.name, ""))
    stmt = select(Contact).order_by(name_sort, Contact.id)
    return list(db.execute(stmt).scalars().all())


def get_contact(db: Session, contact_id: int) -> Optional[Contact]:
    return db.execute(select(Contact).where(Contact.id == contact_id)).scalar_one_or_none()


def create_contact(db: Session, *, fields: dict) -> Contact:
    c = Contact(**fields)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def update_contact(db: Session, *, contact: Contact, fields: dict) -> Contact:
    for key, value in fields.items():
        setattr(contact, key, value)
    db.commit()
    db.refresh(contact)
    return contact


def delete_contact(db: Session, *, contact: Contact) -> None:
    db.delete(contact)
    db.commit()
