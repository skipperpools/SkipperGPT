"""Lightweight health endpoint for uptime checks and dialect inspection."""
from __future__ import annotations

from fastapi import APIRouter

from ..config import settings
from ..database import db_dialect
from ..schemas import HealthResponse

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        db_dialect=db_dialect(),
        app_env=settings.app_env,
    )
