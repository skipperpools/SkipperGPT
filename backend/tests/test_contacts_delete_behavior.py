from __future__ import annotations

import unittest

from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.models import Base, Contact, Job, JobContactLink
from app.repositories import contacts_repo


class ContactsDeleteBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)

        @event.listens_for(self.engine, "connect")
        def _set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, autocommit=False)

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_delete_unlinked_contact_succeeds(self) -> None:
        with self.SessionLocal() as db:
            contact = Contact(name="Unlinked")
            db.add(contact)
            db.commit()

            contacts_repo.delete_contact(db, contact=contact)
            found = contacts_repo.get_contact(db, contact.id)
            self.assertIsNone(found)

    def test_delete_linked_contact_raises_integrity_error(self) -> None:
        with self.SessionLocal() as db:
            contact = Contact(name="Linked")
            job = Job(customer_name="Customer")
            db.add_all([contact, job])
            db.commit()

            db.add(JobContactLink(job_id=job.id, contact_id=contact.id, sort_order=0))
            db.commit()

            with self.assertRaises(IntegrityError):
                contacts_repo.delete_contact(db, contact=contact)


if __name__ == "__main__":
    unittest.main()
