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
from app.routers import jobs


class JobTypesAndCustomTasksTests(unittest.TestCase):
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

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_create_job_seeds_type_template_and_custom_template(self) -> None:
        template_res = self.client.post(
            "/api/jobs/job-type-task-templates",
            json={"job_type": "renovation", "task_label": "Special Renovation Step"},
        )
        self.assertEqual(template_res.status_code, 201, template_res.text)

        create_res = self.client.post(
            "/api/jobs",
            json={"customer_name": "Reno Job", "job_type": "renovation"},
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        payload = create_res.json()
        labels = [t["task_label"] for t in payload["tasks"]]
        self.assertIn("Scope Approved", labels)
        self.assertIn("Special Renovation Step", labels)
        self.assertEqual(payload["job_type"], "renovation")

    def test_job_type_cannot_be_changed_after_create(self) -> None:
        create_res = self.client.post(
            "/api/jobs",
            json={"customer_name": "Locked Type Job", "job_type": "new_construction"},
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        job_id = create_res.json()["id"]

        patch_res = self.client.patch(
            f"/api/jobs/{job_id}",
            json={"job_type": "misc"},
        )
        self.assertEqual(patch_res.status_code, 422, patch_res.text)
        self.assertIn("locked", patch_res.json().get("detail", ""))

    def test_custom_task_creation_requires_admin_or_office(self) -> None:
        create_res = self.client.post(
            "/api/jobs",
            json={"customer_name": "Custom Task Job", "job_type": "misc"},
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        job_id = create_res.json()["id"]

        ok_res = self.client.post(
            f"/api/jobs/{job_id}/tasks",
            json={"task_label": "Office Added Task"},
        )
        self.assertEqual(ok_res.status_code, 201, ok_res.text)
        self.assertIn("Office Added Task", [t["task_label"] for t in ok_res.json()["tasks"]])

        self.current_user.role = "field"
        deny_res = self.client.post(
            f"/api/jobs/{job_id}/tasks",
            json={"task_label": "Field Added Task"},
        )
        self.assertEqual(deny_res.status_code, 403, deny_res.text)

    def test_default_job_type_is_new_construction_when_omitted(self) -> None:
        create_res = self.client.post(
            "/api/jobs",
            json={"customer_name": "Default Type Job"},
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        payload = create_res.json()
        self.assertEqual(payload["job_type"], "new_construction")

    def test_reorder_and_delete_task_requires_admin_or_office(self) -> None:
        create_res = self.client.post(
            "/api/jobs",
            json={"customer_name": "Task Manage Job", "job_type": "misc"},
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        payload = create_res.json()
        job_id = payload["id"]
        first_key = payload["tasks"][0]["task_key"]
        second_key = payload["tasks"][1]["task_key"]

        move_res = self.client.patch(
            f"/api/jobs/{job_id}/tasks/{second_key}/move",
            json={"direction": "up"},
        )
        self.assertEqual(move_res.status_code, 200, move_res.text)
        moved_tasks = move_res.json()["tasks"]
        self.assertEqual(moved_tasks[0]["task_key"], second_key)
        self.assertEqual(moved_tasks[1]["task_key"], first_key)

        delete_res = self.client.delete(f"/api/jobs/{job_id}/tasks/{second_key}")
        self.assertEqual(delete_res.status_code, 200, delete_res.text)
        remaining_keys = [t["task_key"] for t in delete_res.json()["tasks"]]
        self.assertNotIn(second_key, remaining_keys)

        self.current_user.role = "field"
        denied_move = self.client.patch(
            f"/api/jobs/{job_id}/tasks/{first_key}/move",
            json={"direction": "down"},
        )
        self.assertEqual(denied_move.status_code, 403, denied_move.text)
        denied_delete = self.client.delete(f"/api/jobs/{job_id}/tasks/{first_key}")
        self.assertEqual(denied_delete.status_code, 403, denied_delete.text)

    def test_sales_jobs_start_empty_and_can_use_sales_templates(self) -> None:
        base_sales = self.client.post(
            "/api/jobs",
            json={"customer_name": "Sales Lead 1", "job_type": "sales"},
        )
        self.assertEqual(base_sales.status_code, 201, base_sales.text)
        self.assertEqual(base_sales.json()["job_type"], "sales")
        self.assertEqual(len(base_sales.json()["tasks"]), 0)

        template_res = self.client.post(
            "/api/jobs/job-type-task-templates",
            json={"job_type": "sales", "task_label": "Initial Contact"},
        )
        self.assertEqual(template_res.status_code, 201, template_res.text)

        seeded_sales = self.client.post(
            "/api/jobs",
            json={"customer_name": "Sales Lead 2", "job_type": "sales"},
        )
        self.assertEqual(seeded_sales.status_code, 201, seeded_sales.text)
        labels = [t["task_label"] for t in seeded_sales.json()["tasks"]]
        self.assertIn("Initial Contact", labels)

    def test_field_users_do_not_receive_sales_jobs_in_list(self) -> None:
        sales = self.client.post(
            "/api/jobs",
            json={"customer_name": "Sales Hidden", "job_type": "sales"},
        )
        self.assertEqual(sales.status_code, 201, sales.text)
        misc = self.client.post(
            "/api/jobs",
            json={"customer_name": "Visible Misc", "job_type": "misc"},
        )
        self.assertEqual(misc.status_code, 201, misc.text)

        self.current_user.role = "field"
        list_res = self.client.get("/api/jobs")
        self.assertEqual(list_res.status_code, 200, list_res.text)
        payload = list_res.json()
        self.assertTrue(all(item["job_type"] != "sales" for item in payload))
        self.assertTrue(any(item["job_type"] == "misc" for item in payload))

    def test_sales_conversion_creates_new_target_job_and_keeps_source_sales(self) -> None:
        create_res = self.client.post(
            "/api/jobs",
            json={"customer_name": "Sales Convert", "job_type": "sales"},
        )
        self.assertEqual(create_res.status_code, 201, create_res.text)
        job_id = create_res.json()["id"]
        added = self.client.post(
            f"/api/jobs/{job_id}/tasks",
            json={"task_label": "Sales Discovery"},
        )
        self.assertEqual(added.status_code, 201, added.text)

        convert = self.client.post(
            f"/api/jobs/{job_id}/convert-sales",
            json={"target_job_type": "renovation"},
        )
        self.assertEqual(convert.status_code, 200, convert.text)
        converted_job = convert.json()
        self.assertEqual(converted_job["job_type"], "renovation")
        self.assertNotEqual(converted_job["id"], job_id)
        converted_labels = [t["task_label"] for t in converted_job["tasks"]]
        self.assertIn("Scope Approved", converted_labels)
        self.assertNotIn("Sales Discovery", converted_labels)

        source = self.client.get(f"/api/jobs/{job_id}")
        self.assertEqual(source.status_code, 200, source.text)
        source_payload = source.json()
        self.assertEqual(source_payload["job_type"], "sales")
        source_labels = [t["task_label"] for t in source_payload["tasks"]]
        self.assertIn("Sales Discovery", source_labels)

        all_jobs = self.client.get("/api/jobs")
        self.assertEqual(all_jobs.status_code, 200, all_jobs.text)
        all_job_ids = [j["id"] for j in all_jobs.json()]
        self.assertIn(job_id, all_job_ids)
        self.assertIn(converted_job["id"], all_job_ids)

    def test_sales_conversion_restrictions(self) -> None:
        sales = self.client.post(
            "/api/jobs",
            json={"customer_name": "Sales Convert Restrict", "job_type": "sales"},
        )
        self.assertEqual(sales.status_code, 201, sales.text)
        sales_id = sales.json()["id"]
        non_sales = self.client.post(
            "/api/jobs",
            json={"customer_name": "Not Sales", "job_type": "misc"},
        )
        self.assertEqual(non_sales.status_code, 201, non_sales.text)
        non_sales_id = non_sales.json()["id"]

        bad_target = self.client.post(
            f"/api/jobs/{sales_id}/convert-sales",
            json={"target_job_type": "sales"},
        )
        self.assertEqual(bad_target.status_code, 422, bad_target.text)

        bad_source = self.client.post(
            f"/api/jobs/{non_sales_id}/convert-sales",
            json={"target_job_type": "renovation"},
        )
        self.assertEqual(bad_source.status_code, 422, bad_source.text)

        self.current_user.role = "field"
        denied = self.client.post(
            f"/api/jobs/{sales_id}/convert-sales",
            json={"target_job_type": "misc"},
        )
        self.assertEqual(denied.status_code, 403, denied.text)


if __name__ == "__main__":
    unittest.main()
