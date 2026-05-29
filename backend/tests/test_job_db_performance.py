from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect as sa_inspect, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.constants import STATUS_COMPLETED
from app.database import get_db
from app.deps.auth import get_current_user
from app.models import Base, Job, JobTask, User
from app.repositories import jobs_repo
from app.routers import jobs
from app.services import job_disk_sync


class JobDbPerformanceTests(unittest.TestCase):
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

        with self.SessionLocal() as db:
            db.add(self.current_user)
            job = Job(customer_name="Perf Test Job", job_type="new_construction")
            job.tasks.append(
                JobTask(
                    task_key="permit_application",
                    task_label="Permit Application",
                    status="not_started",
                    sort_order=0,
                )
            )
            db.add(job)
            db.commit()
            self.job_id = job.id

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_job_exists_without_loading_relations(self) -> None:
        with self.SessionLocal() as db:
            self.assertTrue(jobs_repo.job_exists(db, self.job_id))
            self.assertFalse(jobs_repo.job_exists(db, 99999))
            job = db.execute(select(Job).where(Job.id == self.job_id)).scalar_one()
            self.assertIn("tasks", sa_inspect(job).unloaded)

    def test_update_task_returns_updated_progress_without_second_get_job(self) -> None:
        with patch.object(jobs_repo, "get_job", wraps=jobs_repo.get_job) as get_job_mock:
            res = self.client.patch(
                f"/api/jobs/{self.job_id}/tasks/permit_application",
                json={"status": STATUS_COMPLETED, "value": "2026-05-15"},
            )
            self.assertEqual(res.status_code, 200, res.text)
            payload = res.json()
            self.assertEqual(payload["overall_status"], STATUS_COMPLETED)
            self.assertEqual(payload["progress"]["completed"], 1)
            task = next(t for t in payload["tasks"] if t["task_key"] == "permit_application")
            self.assertEqual(task["status"], STATUS_COMPLETED)
            self.assertEqual(get_job_mock.call_count, 1)

    def test_sync_job_attachments_if_stale_skips_within_interval(self) -> None:
        with self.SessionLocal() as db:
            job = jobs_repo.get_job(db, self.job_id)
            assert job is not None
            with patch.object(
                job_disk_sync,
                "sync_job_attachments_from_disk",
                wraps=job_disk_sync.sync_job_attachments_from_disk,
            ) as sync_mock:
                first = job_disk_sync.sync_job_attachments_if_stale(
                    db, job, Path("/tmp")
                )
                second = job_disk_sync.sync_job_attachments_if_stale(
                    db, job, Path("/tmp")
                )
                self.assertTrue(first)
                self.assertFalse(second)
                self.assertEqual(sync_mock.call_count, 1)

    def test_get_job_syncs_attachments_once_within_sixty_seconds(self) -> None:
        with patch.object(
            job_disk_sync,
            "sync_job_attachments_from_disk",
        ) as sync_mock:
            first = self.client.get(f"/api/jobs/{self.job_id}")
            second = self.client.get(f"/api/jobs/{self.job_id}")
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(second.status_code, 200, second.text)
            self.assertEqual(sync_mock.call_count, 1)

    def test_get_job_syncs_again_after_stale_interval(self) -> None:
        with self.SessionLocal() as db:
            job = db.execute(select(Job).where(Job.id == self.job_id)).scalar_one()
            job.attachments_synced_at = datetime.now(timezone.utc) - timedelta(seconds=120)
            db.commit()

        with patch.object(
            job_disk_sync,
            "sync_job_attachments_from_disk",
        ) as sync_mock:
            res = self.client.get(f"/api/jobs/{self.job_id}")
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(sync_mock.call_count, 1)


if __name__ == "__main__":
    unittest.main()
