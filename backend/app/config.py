"""Application configuration loaded from environment variables / .env."""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    app_env: str = "local"
    database_url: str = "sqlite:///./data/skipper.db"
    # PDF library root; files live under {docs_root}/Docs/<job_folder>/...
    docs_root: Path = Field(default=PROJECT_ROOT)
    max_upload_mb: int = 25
    vapid_public_key: Optional[str] = None
    vapid_private_key: Optional[str] = None
    vapid_contact_email: Optional[str] = None
    # Optional override for the master `Schedules.xlsx` path (default: project root).
    schedule_xlsx_path: Optional[str] = None
    # JWT signing (HS256). Override with a long random string in production.
    secret_key: str = "dev-only-change-me"
    # ~180 days; override via ACCESS_TOKEN_EXPIRE_MINUTES (e.g. 60 for local dev).
    access_token_expire_minutes: int = 259_200
    # Comma-separated list of origins allowed for cross-origin API access.
    # Leave empty (default) when the frontend is served by this same FastAPI
    # process - no CORS headers are needed and none will be set.
    cors_allowed_origins: List[str] = Field(default_factory=list)

    @field_validator("cors_allowed_origins", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if v is None or v == "":
            return []
        if isinstance(v, str):
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE) if ENV_FILE.exists() else None,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )


settings = Settings()
