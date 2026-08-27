from __future__ import annotations

import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import get_db
from app.deps.auth import get_current_user
from app.models import Base, User
from app.repositories import jobs_repo
from app.routers import jobs


class TaskTemplatesEditingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, autocommit=False)
        self.current_user = User(
            username="office_user",
            hashed_password="x",
            role="office",
            is_active=True,
        )

        app = FastAPI()
        app.include_router(jobs.router)

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

    def _seed(self):
        with self.SessionLocal() as db:
            jobs_repo.seed_default_task_templates(db)

    def test_seeding_migrates_builtins_into_editable_table(self) -> None:
        self._seed()
        res = self.client.get("/api/jobs/job-type-task-templates", params={"job_type": "new_construction"})
        self.assertEqual(res.status_code, 200, res.text)
        rows = res.json()
        self.assertEqual(len(rows), 33)
        self.assertEqual(rows[0]["task_key"], "permit_application")
        self.assertEqual(rows[-1]["task_key"], "final_inspection")
        self.assertEqual([r["sort_order"] for r in rows], list(range(33)))

    def test_add_template_appends_to_end(self) -> None:
        self._seed()
        res = self.client.post(
            "/api/jobs/job-type-task-templates",
            json={"job_type": "new_construction", "task_label": "Owner Walkthrough"},
        )
        self.assertEqual(res.status_code, 201, res.text)
        new_row = res.json()
        self.assertEqual(new_row["sort_order"], 33)

        rows = self.client.get(
            "/api/jobs/job-type-task-templates", params={"job_type": "new_construction"}
        ).json()
        self.assertEqual(len(rows), 34)
        self.assertEqual(rows[-1]["task_label"], "Owner Walkthrough")

    def test_new_job_gets_added_template_task(self) -> None:
        self._seed()
        self.client.post(
            "/api/jobs/job-type-task-templates",
            json={"job_type": "new_construction", "task_label": "Owner Walkthrough"},
        )
        create_res = self.client.post(
            "/api/jobs", json={"customer_name": "Test Job", "job_type": "new_construction"}
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        tasks = create_res.json()["tasks"]
        self.assertEqual(len(tasks), 34)
        self.assertEqual(tasks[-1]["task_label"], "Owner Walkthrough")

    def test_delete_builtin_task_removes_it_and_survives_reseed(self) -> None:
        self._seed()
        rows = self.client.get(
            "/api/jobs/job-type-task-templates", params={"job_type": "new_construction"}
        ).json()
        gunite = next(r for r in rows if r["task_key"] == "gunite")

        del_res = self.client.delete(f"/api/jobs/job-type-task-templates/{gunite['id']}")
        self.assertEqual(del_res.status_code, 204, del_res.text)

        rows_after = self.client.get(
            "/api/jobs/job-type-task-templates", params={"job_type": "new_construction"}
        ).json()
        self.assertEqual(len(rows_after), 32)
        self.assertNotIn("gunite", {r["task_key"] for r in rows_after})
        # sort_order compacted with no gaps
        self.assertEqual([r["sort_order"] for r in rows_after], list(range(32)))

        # Simulate an app restart: seeding must NOT resurrect the deleted builtin.
        self._seed()
        rows_after_restart = self.client.get(
            "/api/jobs/job-type-task-templates", params={"job_type": "new_construction"}
        ).json()
        self.assertEqual(len(rows_after_restart), 32)
        self.assertNotIn("gunite", {r["task_key"] for r in rows_after_restart})

        # And new jobs no longer get a "Gunite" task.
        create_res = self.client.post(
            "/api/jobs", json={"customer_name": "No Gunite Job", "job_type": "new_construction"}
        )
        task_keys = {t["task_key"] for t in create_res.json()["tasks"]}
        self.assertNotIn("gunite", task_keys)

    def test_reorder_builtin_task(self) -> None:
        self._seed()
        rows = self.client.get(
            "/api/jobs/job-type-task-templates", params={"job_type": "new_construction"}
        ).json()
        permit_application = next(r for r in rows if r["task_key"] == "permit_application")

        move_res = self.client.patch(
            f"/api/jobs/job-type-task-templates/{permit_application['id']}",
            json={"target_index": 5},
        )
        self.assertEqual(move_res.status_code, 200, move_res.text)

        rows_after = self.client.get(
            "/api/jobs/job-type-task-templates", params={"job_type": "new_construction"}
        ).json()
        self.assertEqual(rows_after[5]["task_key"], "permit_application")
        self.assertEqual([r["sort_order"] for r in rows_after], list(range(33)))

    def test_rename_template_task(self) -> None:
        self._seed()
        rows = self.client.get(
            "/api/jobs/job-type-task-templates", params={"job_type": "new_construction"}
        ).json()
        plaster = next(r for r in rows if r["task_key"] == "plaster")

        rename_res = self.client.patch(
            f"/api/jobs/job-type-task-templates/{plaster['id']}",
            json={"task_label": "Plaster & Finish"},
        )
        self.assertEqual(rename_res.status_code, 200, rename_res.text)
        self.assertEqual(rename_res.json()["task_label"], "Plaster & Finish")
        # task_key (identity) is stable across renames
        self.assertEqual(rename_res.json()["task_key"], "plaster")

    def test_update_requires_at_least_one_field(self) -> None:
        self._seed()
        rows = self.client.get(
            "/api/jobs/job-type-task-templates", params={"job_type": "new_construction"}
        ).json()
        res = self.client.patch(f"/api/jobs/job-type-task-templates/{rows[0]['id']}", json={})
        self.assertEqual(res.status_code, 422, res.text)

    def test_delete_unknown_template_404(self) -> None:
        self._seed()
        res = self.client.delete("/api/jobs/job-type-task-templates/999999")
        self.assertEqual(res.status_code, 404, res.text)

    def test_pre_seeding_fallback_matches_old_merge_behavior(self) -> None:
        # No seeding call at all here: mirrors how the existing test suite's
        # bare-router harness exercises job creation without the app startup
        # migration ever running.
        create_res = self.client.post(
            "/api/jobs", json={"customer_name": "Unseeded Job", "job_type": "new_construction"}
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        tasks = create_res.json()["tasks"]
        self.assertEqual(len(tasks), 33)
        self.assertEqual(tasks[0]["task_key"], "permit_application")


if __name__ == "__main__":
    unittest.main()
