from __future__ import annotations

import unittest
from datetime import datetime, timezone

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, Job, JobTask
from app.sync_job_tasks import sync_tasks_for_all_jobs


class SyncJobTasksTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, autocommit=False)

    def tearDown(self) -> None:
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _session(self) -> Session:
        return self.SessionLocal()

    def test_adds_missing_tasks(self) -> None:
        defs = [("a", "Task A"), ("b", "Task B")]
        with self._session() as db:
            job = Job(customer_name="Job One")
            job.tasks.append(JobTask(task_key="a", task_label="Task A", status="not_started", sort_order=0))
            db.add(job)
            db.commit()

            jobs, inserted, updated, deleted = sync_tasks_for_all_jobs(db, task_definitions=defs)
            self.assertEqual((jobs, inserted, updated, deleted), (1, 1, 0, 0))

            refreshed = db.execute(select(Job).where(Job.id == job.id)).scalar_one()
            keys = {task.task_key for task in refreshed.tasks}
            self.assertEqual(keys, {"a", "b"})

    def test_updates_label_and_sort_order(self) -> None:
        defs = [("task_x", "Task X Updated"), ("task_y", "Task Y")]
        with self._session() as db:
            job = Job(customer_name="Job Two")
            job.tasks.append(
                JobTask(task_key="task_x", task_label="Task X Original", status="in_progress", sort_order=9)
            )
            db.add(job)
            db.commit()

            jobs, inserted, updated, deleted = sync_tasks_for_all_jobs(db, task_definitions=defs)
            self.assertEqual((jobs, inserted, updated, deleted), (1, 1, 1, 0))

            task_x = (
                db.execute(
                    select(JobTask).where(JobTask.job_id == job.id, JobTask.task_key == "task_x")
                ).scalar_one()
            )
            self.assertEqual(task_x.task_label, "Task X Updated")
            self.assertEqual(task_x.sort_order, 0)
            self.assertEqual(task_x.status, "in_progress")

    def test_preserves_progress_fields(self) -> None:
        defs = [("task_keep", "Task Keep Renamed")]
        completed_at = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
        with self._session() as db:
            job = Job(customer_name="Job Three")
            job.tasks.append(
                JobTask(
                    task_key="task_keep",
                    task_label="Task Keep Old",
                    status="completed",
                    value="2026-01-02",
                    completed_at=completed_at,
                    completed_by="tech",
                    note="Important context",
                    sort_order=12,
                )
            )
            db.add(job)
            db.commit()

            sync_tasks_for_all_jobs(db, task_definitions=defs)
            task = (
                db.execute(
                    select(JobTask).where(JobTask.job_id == job.id, JobTask.task_key == "task_keep")
                ).scalar_one()
            )
            self.assertEqual(task.task_label, "Task Keep Renamed")
            self.assertEqual(task.status, "completed")
            self.assertEqual(task.value, "2026-01-02")
            self.assertIsNotNone(task.completed_at)
            self.assertEqual(
                task.completed_at.replace(tzinfo=timezone.utc),
                completed_at,
            )
            self.assertEqual(task.completed_by, "tech")
            self.assertEqual(task.note, "Important context")

    def test_prune_removed_flag_controls_deletion(self) -> None:
        defs = [("stay", "Stay")]
        with self._session() as db:
            job = Job(customer_name="Job Four")
            job.tasks.extend(
                [
                    JobTask(task_key="stay", task_label="Stay", status="not_started", sort_order=0),
                    JobTask(task_key="remove", task_label="Remove", status="not_started", sort_order=1),
                ]
            )
            db.add(job)
            db.commit()

            result_no_prune = sync_tasks_for_all_jobs(db, task_definitions=defs, prune_removed=False)
            self.assertEqual(result_no_prune, (1, 0, 0, 0))
            still_there = (
                db.execute(
                    select(JobTask).where(JobTask.job_id == job.id, JobTask.task_key == "remove")
                ).scalar_one_or_none()
            )
            self.assertIsNotNone(still_there)

            result_prune = sync_tasks_for_all_jobs(db, task_definitions=defs, prune_removed=True)
            self.assertEqual(result_prune, (1, 0, 0, 1))
            removed = (
                db.execute(
                    select(JobTask).where(JobTask.job_id == job.id, JobTask.task_key == "remove")
                ).scalar_one_or_none()
            )
            self.assertIsNone(removed)


if __name__ == "__main__":
    unittest.main()
