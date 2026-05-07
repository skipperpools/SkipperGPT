"""One-time migration from legacy jobs.contacts JSON to contacts + job_contacts tables."""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from ..models import Contact, JobContactLink
from ..schemas import JobContactEntry

logger = logging.getLogger("skipper.app")


def _norm_field(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    return None


def _find_matching_contact(
    db: Session, label: Optional[str], name: Optional[str], phone: Optional[str], email: Optional[str]
) -> Optional[Contact]:
    stmt = select(Contact)
    for field, val in (
        (Contact.label, label),
        (Contact.name, name),
        (Contact.phone, phone),
        (Contact.email, email),
    ):
        if val is None:
            stmt = stmt.where(field.is_(None))
        else:
            stmt = stmt.where(field == val)
    return db.execute(stmt).scalar_one_or_none()


def _get_or_create_contact(db: Session, entry: JobContactEntry) -> Contact:
    label = _norm_field(entry.label)
    name = _norm_field(entry.name)
    phone = _norm_field(entry.phone)
    email = _norm_field(entry.email)
    existing = _find_matching_contact(db, label, name, phone, email)
    if existing is not None:
        return existing
    c = Contact(label=label, name=name, phone=phone, email=email)
    db.add(c)
    db.flush()
    return c


def migrate_legacy_json_column(db: Session, dialect: str, jobs_has_contacts_column: bool) -> None:
    """Import legacy JSON into relational tables; caller drops column afterward."""
    if not jobs_has_contacts_column:
        return

    raw_sql = text("SELECT id, contacts FROM jobs WHERE contacts IS NOT NULL")
    rows = list(db.execute(raw_sql).fetchall())
    migrated_jobs = 0
    for job_id, raw in rows:
        link_count = db.scalar(
            select(func.count()).select_from(JobContactLink).where(JobContactLink.job_id == job_id)
        )
        if link_count and int(link_count) > 0:
            continue

        parsed: Any = raw
        if isinstance(raw, str):
            raw_stripped = raw.strip()
            if not raw_stripped or raw_stripped.lower() == "null":
                continue
            try:
                parsed = json.loads(raw_stripped)
            except json.JSONDecodeError:
                logger.warning("Skipping invalid contacts JSON for job_id=%s", job_id)
                continue
        if not isinstance(parsed, list) or not parsed:
            continue

        sort_order = 0
        seen_contact_ids: set[int] = set()
        for item in parsed:
            if not isinstance(item, dict):
                continue
            try:
                entry = JobContactEntry.model_validate(item)
            except Exception:
                continue
            if not any(_norm_field(getattr(entry, k)) for k in ("label", "name", "phone", "email")):
                continue
            contact = _get_or_create_contact(db, entry)
            if contact.id in seen_contact_ids:
                continue
            seen_contact_ids.add(contact.id)
            db.add(
                JobContactLink(
                    job_id=job_id,
                    contact_id=contact.id,
                    sort_order=sort_order,
                )
            )
            sort_order += 1
        migrated_jobs += 1

    db.commit()
    if migrated_jobs:
        logger.info("Migrated legacy contacts JSON for %s job(s)", migrated_jobs)


def drop_jobs_contacts_legacy_column(conn, dialect: str) -> None:
    if dialect == "sqlite":
        conn.execute(text("ALTER TABLE jobs DROP COLUMN contacts"))
    else:
        conn.execute(text("ALTER TABLE jobs DROP COLUMN IF EXISTS contacts"))
