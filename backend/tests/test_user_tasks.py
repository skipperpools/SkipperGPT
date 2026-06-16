from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import get_db
from app.deps.auth import get_current_user, require_roles
from app.models import Base, User, UserTask, UserTaskNotification
from app.routers import notifications, user_task_attachments, user_task_notifications, user_tasks


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
        app.include_router(user_task_attachments.router)
        app.include_router(user_task_notifications.router)
        app.include_router(notifications.router)

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
        app.dependency_overrides[require_roles("admin")] = _override_user
        app.dependency_overrides[require_roles("admin", "office")] = _override_user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _create_task_as(
        self, user: User, title: str = "Task one", assignee_id: int | None = None
    ) -> dict:
        self.current_user = user
        payload: dict = {"title": title}
        if assignee_id is not None:
            payload["assignee_id"] = assignee_id
        res = self.client.post("/api/user-tasks", json=payload)
        self.assertEqual(res.status_code, 201, res.text)
        return res.json()

    def test_mine_lists_assigned_tasks_only(self) -> None:
        self._create_task_as(self.user_a, "Self task")
        self._create_task_as(self.user_a, "For B", assignee_id=self.user_b.id)

        self.current_user = self.user_a
        mine = self.client.get("/api/user-tasks/mine")
        self.assertEqual(mine.status_code, 200, mine.text)
        titles = [t["title"] for t in mine.json()]
        self.assertEqual(titles, ["Self task"])

        self.current_user = self.user_b
        mine_b = self.client.get("/api/user-tasks/mine")
        self.assertEqual([t["title"] for t in mine_b.json()], ["For B"])

    def test_created_lists_delegated_tasks_only(self) -> None:
        self._create_task_as(self.user_a, "Self task")
        self._create_task_as(self.user_a, "Delegated", assignee_id=self.user_b.id)

        self.current_user = self.user_a
        created = self.client.get("/api/user-tasks/created")
        self.assertEqual(created.status_code, 200, created.text)
        titles = [t["title"] for t in created.json()]
        self.assertEqual(titles, ["Delegated"])

    def test_assignee_can_complete_task(self) -> None:
        created = self._create_task_as(self.user_a, "For B", assignee_id=self.user_b.id)
        task_id = created["id"]

        self.current_user = self.user_b
        done = self.client.patch(f"/api/user-tasks/{task_id}", json={"completed": True})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertTrue(done.json()["completed"])

    def test_user_cannot_modify_unrelated_task(self) -> None:
        created = self._create_task_as(self.user_a)
        task_id = created["id"]

        self.current_user = self.user_b
        patch = self.client.patch(f"/api/user-tasks/{task_id}", json={"title": "Hacked"})
        self.assertEqual(patch.status_code, 403, patch.text)

    def test_reassign_notifies_creator(self) -> None:
        created = self._create_task_as(self.user_a, "Delegated", assignee_id=self.user_b.id)
        task_id = created["id"]

        self.current_user = self.user_b
        with patch("app.services.user_task_events.send_push_to_user"):
            res = self.client.patch(
                f"/api/user-tasks/{task_id}", json={"assignee_id": self.admin.id}
            )
        self.assertEqual(res.status_code, 200, res.text)

        with self.SessionLocal() as db:
            rows = list(db.execute(select(UserTaskNotification)).scalars())
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].recipient_user_id, self.user_a.id)
            self.assertEqual(rows[0].event, "reassigned")

    def test_complete_notifies_creator_when_not_assignee(self) -> None:
        created = self._create_task_as(self.user_a, "Delegated", assignee_id=self.user_b.id)
        task_id = created["id"]

        self.current_user = self.user_b
        with patch("app.services.user_task_events.send_push_to_user"):
            res = self.client.patch(f"/api/user-tasks/{task_id}", json={"completed": True})
        self.assertEqual(res.status_code, 200, res.text)

        with self.SessionLocal() as db:
            rows = list(db.execute(select(UserTaskNotification)).scalars())
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].event, "completed")

    def test_notification_counts(self) -> None:
        self._create_task_as(self.user_a, "Open", assignee_id=self.user_b.id)

        self.current_user = self.user_b
        counts = self.client.get("/api/notifications/counts")
        self.assertEqual(counts.status_code, 200, counts.text)
        self.assertEqual(counts.json()["assigned_open_count"], 1)

    def test_move_reorders_within_assignee(self) -> None:
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
                    .where(UserTask.assignee_id == self.user_a.id)
                    .order_by(UserTask.sort_order.asc())
                ).scalars()
            )
            self.assertEqual([r.sort_order for r in rows], [0, 1])

    def test_attachment_upload_and_permissions(self) -> None:
        created = self._create_task_as(self.user_a, "With file")
        task_id = created["id"]

        self.current_user = self.user_b
        denied = self.client.post(
            f"/api/user-tasks/{task_id}/attachments",
            files={"file": ("x.pdf", b"%PDF-1.4 test", "application/pdf")},
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        self.current_user = self.user_a
        with tempfile.TemporaryDirectory() as tmp:
            with patch("app.routers.user_task_attachments.settings") as mock_settings:
                mock_settings.docs_root = Path(tmp)
                mock_settings.max_upload_mb = 25
                ok = self.client.post(
                    f"/api/user-tasks/{task_id}/attachments",
                    files={"file": ("note.pdf", b"%PDF-1.4 test content", "application/pdf")},
                )
            self.assertEqual(ok.status_code, 200, ok.text)
            att_id = ok.json()["id"]

            listed = self.client.get(f"/api/user-tasks/{task_id}/attachments")
            self.assertEqual(len(listed.json()), 1)

            delete = self.client.delete(f"/api/user-tasks/{task_id}/attachments/{att_id}")
            self.assertEqual(delete.status_code, 204, delete.text)


if __name__ == "__main__":
    unittest.main()
