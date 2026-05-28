from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import get_db
from app.deps.auth import get_current_user
from app.models import Base, Job, User
from app.routers import job_photos, jobs
from app.services.thumbnails import photo_display_relpath


def _large_png_bytes(width: int = 2500, height: int = 2500) -> bytes:
    buf = io.BytesIO()
    im = Image.new("RGB", (width, height), color=(120, 80, 200))
    for x in range(0, width, 50):
        for y in range(0, height, 50):
            im.putpixel((x, y), (x % 256, y % 256, (x + y) % 256))
    im.save(buf, format="PNG")
    return buf.getvalue()


class JobPhotosTests(unittest.TestCase):
    def setUp(self) -> None:
        self.docs_tmp = tempfile.TemporaryDirectory()
        self.docs_root = Path(self.docs_tmp.name)
        self.settings_patch = patch.object(settings, "docs_root", self.docs_root)
        self.settings_patch.start()

        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, autocommit=False)

        with self.SessionLocal() as db:
            self.user = User(
                username="photo_user",
                hashed_password="x",
                role="field",
                is_active=True,
            )
            db.add(self.user)
            db.commit()
            db.refresh(self.user)
            self.user_id = self.user.id
            job = Job(customer_name="Photo Customer", job_type="new_construction")
            db.add(job)
            db.commit()
            db.refresh(job)
            self.job_id = job.id

        self.app = FastAPI()
        self.app.include_router(jobs.router, prefix="/api/jobs")
        self.app.include_router(job_photos.router, prefix="/api/jobs")

        def override_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        def override_user():
            with self.SessionLocal() as db:
                return db.get(User, self.user_id)

        self.app.dependency_overrides[get_db] = override_db
        self.app.dependency_overrides[get_current_user] = override_user
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.settings_patch.stop()
        self.docs_tmp.cleanup()

    def test_display_smaller_than_original_and_file_unchanged(self) -> None:
        original_bytes = _large_png_bytes()
        upload = self.client.post(
            f"/api/jobs/{self.job_id}/photos",
            files={"file": ("large.png", original_bytes, "image/png")},
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        photos = upload.json()["photos"]
        self.assertEqual(len(photos), 1)
        photo_id = photos[0]["id"]
        stored_path = photos[0]["stored_path"]

        display = self.client.get(
            f"/api/jobs/{self.job_id}/photos/{photo_id}/display"
        )
        self.assertEqual(display.status_code, 200, display.text)
        self.assertEqual(display.headers.get("content-type"), "image/webp")
        self.assertLess(len(display.content), len(original_bytes) // 2)

        im_display = Image.open(io.BytesIO(display.content))
        self.assertLessEqual(max(im_display.size), 1920)

        file_resp = self.client.get(
            f"/api/jobs/{self.job_id}/photos/{photo_id}/file"
        )
        self.assertEqual(file_resp.status_code, 200, file_resp.text)
        self.assertEqual(file_resp.content, original_bytes)
        self.assertEqual(file_resp.headers.get("content-type"), "image/png")

        display_abs = self.docs_root / photo_display_relpath(stored_path)
        self.assertTrue(display_abs.is_file())

    def test_delete_removes_display_file(self) -> None:
        original_bytes = _large_png_bytes(800, 600)
        upload = self.client.post(
            f"/api/jobs/{self.job_id}/photos",
            files={"file": ("shot.png", original_bytes, "image/png")},
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        photo_id = upload.json()["photos"][0]["id"]
        stored_path = upload.json()["photos"][0]["stored_path"]

        display = self.client.get(
            f"/api/jobs/{self.job_id}/photos/{photo_id}/display"
        )
        self.assertEqual(display.status_code, 200, display.text)
        display_abs = self.docs_root / photo_display_relpath(stored_path)
        self.assertTrue(display_abs.is_file())

        delete = self.client.delete(f"/api/jobs/{self.job_id}/photos/{photo_id}")
        self.assertEqual(delete.status_code, 200, delete.text)
        self.assertFalse(display_abs.is_file())

    def test_requires_auth(self) -> None:
        app = FastAPI()
        app.include_router(job_photos.router, prefix="/api/jobs")
        client = TestClient(app)
        resp = client.get(f"/api/jobs/{self.job_id}/photos/1/display")
        self.assertIn(resp.status_code, (401, 403))
