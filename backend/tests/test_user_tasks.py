from __future__ import annotations

import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import get_db
from app.deps.auth import get_current_user
from app.models import Base, User, UserTask
from app.routers import user_tasks


class UserTasksTests(unittest.TestCase):
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
            self.user_a = User(
                username="user_a",
                hashed_password="x",
                role="field",
                is_active=True,
            )
            self.user_b = User(
                username="user_b",
                hashed_password="x",
                role="field",
                is_active=True,
            )
            self.admin = User(
                username="admin_user",
                hashed_password="x",
                role="admin",
                is_active=True,
            )
            db.add_all([self.user_a, self.user_b, self.admin])
            db.commit()
            db.refresh(self.user_a)
            db.refresh(self.user_b)
            db.refresh(self.admin)

        self.current_user = self.user_a
        app = FastAPI()
        app.include_router(user_tasks.router)

        def _override_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        def _override_user() -> User:
            return self.current_user

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_user] = _override_user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _create_task_as(self, user: User, title: str = "Task one") -> dict:
        self.current_user = user
        res = self.client.post("/api/user-tasks", json={"title": title})
        self.assertEqual(res.status_code, 201, res.text)
        return res.json()

    def test_user_lists_only_own_tasks(self) -> None:
        self._create_task_as(self.user_a, "A task")
        self._create_task_as(self.user_b, "B task")

        self.current_user = self.user_a
        mine = self.client.get("/api/user-tasks/mine")
        self.assertEqual(mine.status_code, 200, mine.text)
        titles = [t["title"] for t in mine.json()]
        self.assertEqual(titles, ["A task"])

    def test_user_cannot_modify_other_users_task(self) -> None:
        created = self._create_task_as(self.user_a)
        task_id = created["id"]

        self.current_user = self.user_b
        patch = self.client.patch(f"/api/user-tasks/{task_id}", json={"title": "Hacked"})
        self.assertEqual(patch.status_code, 403, patch.text)

        delete = self.client.delete(f"/api/user-tasks/{task_id}")
        self.assertEqual(delete.status_code, 403, delete.text)

    def test_admin_can_list_and_edit_any_user_task(self) -> None:
        created = self._create_task_as(self.user_a, "Owned by A")
        task_id = created["id"]

        self.current_user = self.admin
        listed = self.client.get(f"/api/user-tasks?user_id={self.user_a.id}")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(len(listed.json()), 1)
        self.assertEqual(listed.json()[0]["owner_username"], "user_a")

        patch = self.client.patch(
            f"/api/user-tasks/{task_id}", json={"title": "Admin edit"}
        )
        self.assertEqual(patch.status_code, 200, patch.text)
        self.assertEqual(patch.json()["title"], "Admin edit")

        delete = self.client.delete(f"/api/user-tasks/{task_id}")
        self.assertEqual(delete.status_code, 204, delete.text)

    def test_completed_sets_and_clears_completed_at(self) -> None:
        created = self._create_task_as(self.user_a)
        task_id = created["id"]
        self.assertIsNone(created["completed_at"])

        done = self.client.patch(f"/api/user-tasks/{task_id}", json={"completed": True})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertTrue(done.json()["completed"])
        self.assertIsNotNone(done.json()["completed_at"])

        undone = self.client.patch(f"/api/user-tasks/{task_id}", json={"completed": False})
        self.assertEqual(undone.status_code, 200, undone.text)
        self.assertFalse(undone.json()["completed"])
        self.assertIsNone(undone.json()["completed_at"])

    def test_move_reorders_tasks(self) -> None:
        first = self._create_task_as(self.user_a, "First")
        second = self._create_task_as(self.user_a, "Second")

        move = self.client.patch(
            f"/api/user-tasks/{second['id']}/move", json={"direction": "up"}
        )
        self.assertEqual(move.status_code, 200, move.text)

        mine = self.client.get("/api/user-tasks/mine")
        titles = [t["title"] for t in mine.json()]
        self.assertEqual(titles, ["Second", "First"])

        with self.SessionLocal() as db:
            rows = list(
                db.execute(
                    select(UserTask)
                    .where(UserTask.user_id == self.user_a.id)
                    .order_by(UserTask.sort_order.asc())
                ).scalars()
            )
            self.assertEqual([r.sort_order for r in rows], [0, 1])


if __name__ == "__main__":
    unittest.main()
