from __future__ import annotations

import io
import json
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import get_db
from app.deps.auth import get_current_user
from app.models import Base, Job, User
from app.routers import job_sketches, jobs


def _png_bytes(width: int = 8, height: int = 8, color: tuple[int, int, int] = (255, 255, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=color).save(buf, format="PNG")
    return buf.getvalue()


def _minimal_sketch_document() -> dict:
    return {
        "version": 1,
        "pixelsPerInch": 48,
        "canvas": {"width": 2400, "height": 1800},
        "gridSpacingInches": 3,
        "snapEnabled": True,
        "snapSubdivisionInches": 0.25,
        "background": {
            "source": "none",
            "jobPhotoId": None,
            "transform": {"x": 0, "y": 0, "scale": 1, "opacity": 0.65},
        },
        "strokes": [],
    }


class JobSketchesTests(unittest.TestCase):
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
            self.user = User(
                username="sketch_user",
                hashed_password="x",
                role="field",
                is_active=True,
            )
            db.add(self.user)
            db.commit()
            db.refresh(self.user)
            self.user_id = self.user.id
            job = Job(customer_name="Sketch Customer", job_type="new_construction")
            db.add(job)
            db.commit()
            db.refresh(job)
            self.job_id = job.id

        self.app = FastAPI()
        self.app.include_router(jobs.router, prefix="/api/jobs")
        self.app.include_router(job_sketches.router, prefix="/api/jobs")

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

    def test_create_save_load_delete_sketch(self) -> None:
        create = self.client.post(
            f"/api/jobs/{self.job_id}/sketches",
            json={"title": "Pool layout", "grid_spacing_inches": 3},
        )
        self.assertEqual(create.status_code, 200, create.text)
        sketches = create.json()["sketches"]
        self.assertEqual(len(sketches), 1)
        sketch_id = sketches[0]["id"]

        doc = _minimal_sketch_document()
        doc["strokes"] = [
            {
                "tool": "pen",
                "color": "#111111",
                "width": 2,
                "points": [[48, 48], [96, 96]],
            }
        ]

        save = self.client.put(
            f"/api/jobs/{self.job_id}/sketches/{sketch_id}",
            data={"document": json.dumps(doc), "content_version": "1"},
            files={"preview": ("preview.png", _png_bytes(), "image/png")},
        )
        self.assertEqual(save.status_code, 200, save.text)

        loaded = self.client.get(f"/api/jobs/{self.job_id}/sketches/{sketch_id}")
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(len(loaded.json()["strokes"]), 1)

        delete = self.client.delete(f"/api/jobs/{self.job_id}/sketches/{sketch_id}")
        self.assertEqual(delete.status_code, 200, delete.text)
        self.assertEqual(delete.json()["sketches"], [])

    def test_thumbnail_regenerates_after_save(self) -> None:
        create = self.client.post(
            f"/api/jobs/{self.job_id}/sketches",
            json={"title": "Thumb regen", "grid_spacing_inches": 3},
        )
        self.assertEqual(create.status_code, 200, create.text)
        sketch_id = create.json()["sketches"][0]["id"]

        thumb_before = self.client.get(
            f"/api/jobs/{self.job_id}/sketches/{sketch_id}/thumbnail"
        )
        self.assertEqual(thumb_before.status_code, 200, thumb_before.text)
        im_before = Image.open(io.BytesIO(thumb_before.content))
        self.assertLessEqual(max(im_before.size), 1)

        save = self.client.put(
            f"/api/jobs/{self.job_id}/sketches/{sketch_id}",
            data={
                "document": json.dumps(_minimal_sketch_document()),
                "content_version": "1",
            },
            files={"preview": ("preview.png", _png_bytes(64, 64, (255, 0, 0)), "image/png")},
        )
        self.assertEqual(save.status_code, 200, save.text)

        thumb_after = self.client.get(
            f"/api/jobs/{self.job_id}/sketches/{sketch_id}/thumbnail"
        )
        self.assertEqual(thumb_after.status_code, 200, thumb_after.text)
        im_after = Image.open(io.BytesIO(thumb_after.content))
        self.assertGreater(max(im_after.size), max(im_before.size))
        self.assertGreater(len(thumb_after.content), len(thumb_before.content))

        delete = self.client.delete(f"/api/jobs/{self.job_id}/sketches/{sketch_id}")
        self.assertEqual(delete.status_code, 200, delete.text)

    def test_requires_auth(self) -> None:
        app = FastAPI()
        app.include_router(job_sketches.router, prefix="/api/jobs")
        client = TestClient(app)
        resp = client.get(f"/api/jobs/{self.job_id}/sketches")
        self.assertIn(resp.status_code, (401, 403))
