from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.constants import STATUS_COMPLETED
from app.models import JobTask
from app.services.jobs_service import _compute_progress, _parse_iso_date_from_task_value


class JobsProgressTests(unittest.TestCase):
    def test_parse_iso_date_from_task_value(self) -> None:
        dt = _parse_iso_date_from_task_value("2026-05-15")
        self.assertIsNotNone(dt)
        assert dt is not None
        self.assertEqual(dt, datetime(2026, 5, 15, 12, 0, 0, tzinfo=timezone.utc))

    def test_parse_iso_date_rejects_non_date(self) -> None:
        self.assertIsNone(_parse_iso_date_from_task_value("in progress"))
        self.assertIsNone(_parse_iso_date_from_task_value(None))

    def test_latest_completed_at_uses_value_not_completed_at(self) -> None:
        checkoff = datetime(2026, 5, 15, 18, 30, 0, tzinfo=timezone.utc)
        task = JobTask(
            task_key="permit_application",
            task_label="Permit Application",
            status=STATUS_COMPLETED,
            value="2026-03-25",
            completed_at=checkoff,
            sort_order=0,
        )
        progress = _compute_progress([task])
        self.assertEqual(progress.latest_label, "Permit Application")
        self.assertEqual(
            progress.latest_completed_at,
            datetime(2026, 3, 25, 12, 0, 0, tzinfo=timezone.utc),
        )
        self.assertNotEqual(progress.latest_completed_at, checkoff)

    def test_latest_completed_at_none_when_value_missing(self) -> None:
        task = JobTask(
            task_key="permit_application",
            task_label="Permit Application",
            status=STATUS_COMPLETED,
            value=None,
            completed_at=datetime(2026, 5, 15, 12, 0, 0, tzinfo=timezone.utc),
            sort_order=0,
        )
        progress = _compute_progress([task])
        self.assertEqual(progress.latest_label, "Permit Application")
        self.assertIsNone(progress.latest_completed_at)


if __name__ == "__main__":
    unittest.main()
