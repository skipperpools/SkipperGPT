"""My tasks: a task can only be linked to a job that both the acting user and
the assignee are allowed to view (role job types + per-user grants)."""
from __future__ import annotations

import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import get_db
from app.deps.auth import get_current_user
from app.models import Base, Job, User, UserJobTypeGrant, UserTask
from app.routers import user_tasks, users


class UserTaskJobAccessTests(unittest.TestCase):
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
                    User(username="nick", hashed_password="x", role="field"),
                    Job(customer_name="Sales Lead", job_type="sales"),
                    Job(customer_name="Pool Build", job_type="new_construction"),
                ]
            )
            db.commit()
            self.admin_id = db.scalar(select(User.id).where(User.username == "boss"))
            self.mike_id = db.scalar(select(User.id).where(User.username == "mike"))
            self.nick_id = db.scalar(select(User.id).where(User.username == "nick"))
            self.sales_id = db.scalar(select(Job.id).where(Job.job_type == "sales"))
            self.build_id = db.scalar(select(Job.id).where(Job.job_type == "new_construction"))
            # nick has been granted Sales; mike has not.
            db.add(UserJobTypeGrant(user_id=self.nick_id, job_type="sales"))
            db.commit()
        self.acting_as = self.admin_id

        app = FastAPI()
        app.include_router(user_tasks.router)
        app.include_router(users.router)

        def _db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = lambda: self.SessionLocal().get(User, self.acting_as)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _create(self, **payload):
        return self.client.post("/api/user-tasks", json={"title": "t", **payload})

    def test_assignable_users_expose_allowed_job_types(self) -> None:
        res = self.client.get("/api/users/assignable")
        self.assertEqual(res.status_code, 200, res.text)
        by_name = {u["username"]: set(u["allowed_job_types"]) for u in res.json()}
        self.assertIn("sales", by_name["boss"])
        self.assertNotIn("sales", by_name["mike"])
        self.assertIn("sales", by_name["nick"])  # grant counts

    def test_field_user_cannot_link_job_they_cannot_view(self) -> None:
        self.acting_as = self.mike_id
        res = self._create(job_id=self.sales_id)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], "Job not found")  # doesn't reveal it exists
        self.assertEqual(self._create(job_id=self.build_id).status_code, 201)

    def test_cannot_link_job_assignee_cannot_view(self) -> None:
        res = self._create(job_id=self.sales_id, assignee_id=self.mike_id)
        self.assertEqual(res.status_code, 400)
        self.assertIn("mike", res.json()["detail"])
        # A granted user is fine.
        self.assertEqual(self._create(job_id=self.sales_id, assignee_id=self.nick_id).status_code, 201)

    def test_update_job_and_reassign_are_checked(self) -> None:
        tid = self._create(job_id=self.sales_id, assignee_id=self.nick_id).json()["id"]
        # Reassigning a Sales-linked task to someone without Sales is rejected.
        res = self.client.patch(f"/api/user-tasks/{tid}", json={"assignee_id": self.mike_id})
        self.assertEqual(res.status_code, 400)
        # Unlinking + reassigning in one go is fine.
        res = self.client.patch(f"/api/user-tasks/{tid}", json={"assignee_id": self.mike_id, "job_id": None})
        self.assertEqual(res.status_code, 200, res.text)
        # Linking the Sales job to mike's task afterwards is rejected.
        res = self.client.patch(f"/api/user-tasks/{tid}", json={"job_id": self.sales_id})
        self.assertEqual(res.status_code, 400)

    def test_legacy_link_does_not_block_unrelated_edits(self) -> None:
        with self.SessionLocal() as db:
            task = UserTask(user_id=self.admin_id, assignee_id=self.mike_id, title="old", job_id=self.sales_id)
            db.add(task)
            db.commit()
            tid = task.id
        self.acting_as = self.mike_id
        res = self.client.patch(f"/api/user-tasks/{tid}", json={"completed": True})
        self.assertEqual(res.status_code, 200, res.text)


if __name__ == "__main__":
    unittest.main()
