"""Per-user job type grants: admins can give a user access to job types
beyond their role's defaults (add-only)."""
from __future__ import annotations

import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import get_db
from app.deps.auth import get_current_user
from app.models import Base, Job, User, UserJobTypeGrant
from app.routers import job_documents, jobs, users


class UserJobTypeGrantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, autocommit=False)

        with self.SessionLocal() as db:
            db.add_all(
                [
                    User(username="boss", hashed_password="x", role="admin"),
                    User(username="mike", hashed_password="x", role="field"),
                    Job(customer_name="Sales Lead", job_type="sales"),
                    Job(customer_name="Pool Build", job_type="new_construction"),
                ]
            )
            db.commit()
            self.admin_id = db.scalar(select(User.id).where(User.username == "boss"))
            self.field_id = db.scalar(select(User.id).where(User.username == "mike"))
            self.sales_job_id = db.scalar(select(Job.id).where(Job.job_type == "sales"))
        self.acting_as = self.admin_id

        app = FastAPI()
        app.include_router(jobs.router)
        app.include_router(users.router)
        app.include_router(job_documents.router)

        def _override_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        def _override_user(db=None):
            # Load a fresh, session-bound user each request like the real dep.
            db = self.SessionLocal()
            return db.get(User, self.acting_as)

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = _override_user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _job_types_visible(self) -> set[str]:
        res = self.client.get("/api/jobs")
        self.assertEqual(res.status_code, 200, res.text)
        return {j["job_type"] for j in res.json()}

    def test_field_user_has_no_sales_by_default(self) -> None:
        self.acting_as = self.field_id
        self.assertNotIn("sales", self._job_types_visible())
        self.assertEqual(self.client.get(f"/api/jobs/{self.sales_job_id}").status_code, 404)
        # Sub-routes are guarded too (previously open by direct ID).
        self.assertEqual(
            self.client.get(f"/api/jobs/{self.sales_job_id}/documents").status_code, 404
        )

    def test_admin_grant_gives_field_user_sales(self) -> None:
        res = self.client.patch(
            f"/api/users/{self.field_id}", json={"job_type_grants": ["sales"]}
        )
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["job_type_grants"], ["sales"])
        self.assertIn("sales", body["allowed_job_types"])
        self.assertNotIn("sales", body["role_job_types"])

        self.acting_as = self.field_id
        self.assertIn("sales", self._job_types_visible())
        self.assertEqual(self.client.get(f"/api/jobs/{self.sales_job_id}").status_code, 200)

    def test_revoking_grant_removes_access(self) -> None:
        self.client.patch(f"/api/users/{self.field_id}", json={"job_type_grants": ["sales"]})
        res = self.client.patch(f"/api/users/{self.field_id}", json={"job_type_grants": []})
        self.assertEqual(res.json()["job_type_grants"], [])
        self.acting_as = self.field_id
        self.assertNotIn("sales", self._job_types_visible())

    def test_grants_covered_by_role_are_not_stored(self) -> None:
        res = self.client.patch(
            f"/api/users/{self.field_id}",
            json={"job_type_grants": ["sales", "renovation"]},
        )
        # renovation is already a field default, so only sales is stored.
        self.assertEqual(res.json()["job_type_grants"], ["sales"])

        # Promote to office: sales is now covered by the role, grant dropped.
        res = self.client.patch(f"/api/users/{self.field_id}", json={"role": "office"})
        self.assertEqual(res.json()["job_type_grants"], [])
        # Demote back: no leftover grant resurrects sales access.
        res = self.client.patch(f"/api/users/{self.field_id}", json={"role": "field"})
        self.assertNotIn("sales", res.json()["allowed_job_types"])

    def test_create_user_with_grants(self) -> None:
        res = self.client.post(
            "/api/users",
            json={"username": "sam", "password": "pw", "role": "field", "job_type_grants": ["sales"]},
        )
        self.assertEqual(res.status_code, 201, res.text)
        self.assertEqual(res.json()["job_type_grants"], ["sales"])

    def test_unknown_job_type_rejected(self) -> None:
        res = self.client.patch(
            f"/api/users/{self.field_id}", json={"job_type_grants": ["warranty"]}
        )
        self.assertEqual(res.status_code, 422)

    def test_non_admin_cannot_grant(self) -> None:
        self.acting_as = self.field_id
        res = self.client.patch(
            f"/api/users/{self.field_id}", json={"job_type_grants": ["sales"]}
        )
        self.assertEqual(res.status_code, 403)

    def test_deleting_user_deletes_grants(self) -> None:
        self.client.patch(f"/api/users/{self.field_id}", json={"job_type_grants": ["sales"]})
        self.assertEqual(self.client.delete(f"/api/users/{self.field_id}").status_code, 204)
        with self.SessionLocal() as db:
            self.assertEqual(db.scalars(select(UserJobTypeGrant)).all(), [])


if __name__ == "__main__":
    unittest.main()
