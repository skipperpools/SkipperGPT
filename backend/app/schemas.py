"""Pydantic schemas for request/response payloads."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .auth_utils import assert_password_within_bcrypt_limit
from .constants import (
    JOB_TYPE_NEW_CONSTRUCTION,
    MAX_JOB_CONTACTS,
    USER_TASK_CATEGORY_GENERAL,
    USER_TASK_NOTE_MAX,
    USER_TASK_TITLE_MAX,
    VALID_JOB_TYPES,
    VALID_DOC_CATEGORIES,
    VALID_FEEDBACK_KINDS,
    VALID_FEEDBACK_STATUS,
    VALID_ROLES,
    VALID_STATUSES,
    VALID_USER_TASK_CATEGORIES,
)


class JobTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    task_key: str
    task_label: str
    status: str
    value: Optional[str] = None
    completed_at: Optional[datetime] = None
    completed_by: Optional[str] = None
    note: Optional[str] = None
    sort_order: int
    is_billable: bool = False


class JobTaskUpdate(BaseModel):
    """All fields optional - PATCH semantics."""

    status: Optional[str] = None
    value: Optional[str] = None
    note: Optional[str] = None
    completed_by: Optional[str] = None

    @field_validator("status")
    @classmethod
    def _validate_status(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if v not in VALID_STATUSES:
            raise ValueError(
                f"status must be one of {sorted(VALID_STATUSES)}"
            )
        return v


class JobTaskCreate(BaseModel):
    task_label: str = Field(..., min_length=1, max_length=128)
    is_billable: bool = False


class JobTaskMove(BaseModel):
    direction: Optional[str] = Field(None, min_length=1, max_length=8)
    target_index: Optional[int] = Field(None, ge=0)

    @field_validator("direction")
    @classmethod
    def _validate_direction(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        vv = v.strip().lower()
        if vv not in {"up", "down"}:
            raise ValueError("direction must be 'up' or 'down'")
        return vv

    @model_validator(mode="after")
    def _validate_move_payload(self) -> "JobTaskMove":
        has_direction = self.direction is not None
        has_target = self.target_index is not None
        if has_direction == has_target:
            raise ValueError("Provide exactly one of direction or target_index")
        return self


class JobProgress(BaseModel):
    completed: int
    total: int
    percent: int
    latest_label: Optional[str] = None
    latest_completed_at: Optional[datetime] = None


class JobDocumentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_id: int
    title: str
    original_filename: str
    stored_path: str
    content_type: str
    category: str
    size_bytes: int
    uploaded_at: datetime
    uploaded_by_user_id: Optional[int] = None
    uploaded_by_username: Optional[str] = None


class JobDocumentUpdate(BaseModel):
    title: str


class JobDocumentUpload(BaseModel):
    title: Optional[str] = None
    category: str = "field"

    @field_validator("category")
    @classmethod
    def _category_allowed(cls, v: str) -> str:
        if v not in VALID_DOC_CATEGORIES:
            raise ValueError(f"category must be one of {sorted(VALID_DOC_CATEGORIES)}")
        return v


class JobPhotoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_id: int
    original_filename: str
    stored_path: str
    content_type: str
    size_bytes: int
    uploaded_at: datetime
    uploaded_by_user_id: Optional[int] = None
    uploaded_by_username: Optional[str] = None


class JobSketchRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_id: int
    title: str
    grid_spacing_inches: int
    content_version: int
    created_at: datetime
    updated_at: datetime
    created_by_user_id: Optional[int] = None
    created_by_username: Optional[str] = None
    updated_by_user_id: Optional[int] = None
    updated_by_username: Optional[str] = None


class JobNoteRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_id: int
    author_user_id: int
    author_username: Optional[str] = None
    author_role: Optional[str] = None
    body: str
    created_at: datetime


class JobNoteCreate(BaseModel):
    body: str = Field(..., min_length=1, max_length=8000)

    @field_validator("body", mode="before")
    @classmethod
    def _strip_body(cls, v: object) -> object:
        if v is None:
            return v
        if isinstance(v, str):
            return v.strip()
        return v

    @field_validator("body")
    @classmethod
    def _require_non_empty_body(cls, v: str) -> str:
        if not v:
            raise ValueError("Note body cannot be empty")
        return v


class JobContactEntry(BaseModel):
    """Contact row attached to a job (from shared contacts table)."""

    id: int
    label: Optional[str] = Field(None, max_length=64)
    name: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=64)
    email: Optional[str] = Field(None, max_length=255)

    @field_validator("label", "name", "phone", "email", mode="before")
    @classmethod
    def _strip_optional(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v


def _validate_contact_id_list(v: object) -> Optional[List[int]]:
    if v is None:
        return None
    if not isinstance(v, list):
        raise ValueError("contact_ids must be a list")
    if len(v) > MAX_JOB_CONTACTS:
        raise ValueError(f"at most {MAX_JOB_CONTACTS} contacts per job")
    out: List[int] = []
    for x in v:
        if not isinstance(x, int):
            raise ValueError("contact_ids must be integers")
        out.append(x)
    return out


class ContactRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    label: Optional[str] = None
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ContactCreate(BaseModel):
    label: Optional[str] = Field(None, max_length=64)
    name: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=64)
    email: Optional[str] = Field(None, max_length=255)

    @field_validator("label", "name", "phone", "email", mode="before")
    @classmethod
    def _strip_optional_contact(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v


class ContactUpdate(BaseModel):
    label: Optional[str] = Field(None, max_length=64)
    name: Optional[str] = Field(None, max_length=255)
    phone: Optional[str] = Field(None, max_length=64)
    email: Optional[str] = Field(None, max_length=255)

    @field_validator("label", "name", "phone", "email", mode="before")
    @classmethod
    def _strip_optional_contact_u(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v


class JobBase(BaseModel):
    customer_name: str = Field(..., min_length=1, max_length=255)
    job_type: str = Field(default=JOB_TYPE_NEW_CONSTRUCTION, min_length=1, max_length=32)
    address: Optional[str] = Field(None, max_length=500)
    @field_validator("job_type")
    @classmethod
    def _validate_job_type_base(cls, v: str) -> str:
        if v not in VALID_JOB_TYPES:
            raise ValueError(f"job_type must be one of {sorted(VALID_JOB_TYPES)}")
        return v

    pool_type: Optional[str] = Field(None, max_length=16)
    permit_status: Optional[str] = Field(None, max_length=64)
    permit_number: Optional[str] = Field(None, max_length=128)
    field_manager: Optional[str] = Field(None, max_length=128)
    notes: Optional[str] = None


class JobCreate(JobBase):
    contact_ids: Optional[List[int]] = None
    clone_from_job_id: Optional[int] = None

    @field_validator("contact_ids", mode="before")
    @classmethod
    def _contact_ids_job_create(cls, v: object) -> Optional[List[int]]:
        return _validate_contact_id_list(v)


class JobUpdate(BaseModel):
    """Partial update of job-level fields."""

    customer_name: Optional[str] = Field(None, min_length=1, max_length=255)
    job_type: Optional[str] = Field(None, min_length=1, max_length=32)
    address: Optional[str] = Field(None, max_length=500)
    pool_type: Optional[str] = Field(None, max_length=16)
    permit_status: Optional[str] = Field(None, max_length=64)
    permit_number: Optional[str] = Field(None, max_length=128)
    field_manager: Optional[str] = Field(None, max_length=128)
    notes: Optional[str] = None
    archived: Optional[bool] = None
    contact_ids: Optional[List[int]] = None

    @field_validator("contact_ids", mode="before")
    @classmethod
    def _contact_ids_job_update(cls, v: object) -> Optional[List[int]]:
        return _validate_contact_id_list(v)

    @field_validator("job_type")
    @classmethod
    def _validate_job_type_update(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if v not in VALID_JOB_TYPES:
            raise ValueError(f"job_type must be one of {sorted(VALID_JOB_TYPES)}")
        return v


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    customer_name: str
    job_type: str
    address: Optional[str] = None
    pool_type: Optional[str] = None
    permit_status: Optional[str] = None
    permit_number: Optional[str] = None
    field_manager: Optional[str] = None
    notes: Optional[str] = None
    contacts: List[JobContactEntry] = Field(default_factory=list)
    archived: bool
    created_at: datetime
    updated_at: datetime
    tasks: List[JobTaskRead] = []
    documents: List[JobDocumentRead] = []
    photos: List[JobPhotoRead] = []
    sketches: List[JobSketchRead] = []
    job_notes: List[JobNoteRead] = []
    progress: JobProgress
    overall_status: str
    docs_rel_path: Optional[str] = None
    photos_rel_path: Optional[str] = None
    sketches_rel_path: Optional[str] = None


class JobTypeTaskTemplateCreate(BaseModel):
    job_type: str = Field(..., min_length=1, max_length=32)
    task_label: str = Field(..., min_length=1, max_length=128)

    @field_validator("job_type")
    @classmethod
    def _validate_job_type_template(cls, v: str) -> str:
        if v not in VALID_JOB_TYPES:
            raise ValueError(f"job_type must be one of {sorted(VALID_JOB_TYPES)}")
        return v


class JobTypeTaskTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_type: str
    task_key: str
    task_label: str
    sort_order: int
    created_at: datetime


class JobTypeConvertRequest(BaseModel):
    target_job_type: str = Field(..., min_length=1, max_length=32)

    @field_validator("target_job_type")
    @classmethod
    def _validate_target_job_type(cls, v: str) -> str:
        if v not in VALID_JOB_TYPES:
            raise ValueError(f"target_job_type must be one of {sorted(VALID_JOB_TYPES)}")
        return v


class HealthResponse(BaseModel):
    status: str
    db_dialect: str
    app_env: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    role: str
    is_active: bool
    push_enabled: bool = False
    created_at: datetime


class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=128)
    role: str = Field(..., min_length=1, max_length=16)

    @field_validator("password")
    @classmethod
    def _password_bcrypt_limit(cls, v: str) -> str:
        assert_password_within_bcrypt_limit(v)
        return v

    @field_validator("role")
    @classmethod
    def _role_allowed(cls, v: str) -> str:
        if v not in VALID_ROLES:
            raise ValueError(f"role must be one of {sorted(VALID_ROLES)}")
        return v


class UserUpdate(BaseModel):
    username: Optional[str] = Field(None, min_length=1, max_length=64)
    password: Optional[str] = Field(None, min_length=1, max_length=128)
    role: Optional[str] = Field(None, min_length=1, max_length=16)
    is_active: Optional[bool] = None

    @field_validator("password")
    @classmethod
    def _password_bcrypt_limit_update(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        assert_password_within_bcrypt_limit(v)
        return v

    @field_validator("role")
    @classmethod
    def _role_allowed_update(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if v not in VALID_ROLES:
            raise ValueError(f"role must be one of {sorted(VALID_ROLES)}")
        return v


class FeedbackCreate(BaseModel):
    kind: str = Field(..., min_length=1, max_length=16)
    body: str = Field(..., min_length=1, max_length=8000)

    @field_validator("kind")
    @classmethod
    def _kind_allowed(cls, v: str) -> str:
        if v not in VALID_FEEDBACK_KINDS:
            raise ValueError(f"kind must be one of {sorted(VALID_FEEDBACK_KINDS)}")
        return v


class FeedbackRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    kind: str
    body: str
    status: str
    admin_note: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    author_username: Optional[str] = None


class FeedbackAdminUpdate(BaseModel):
    status: Optional[str] = Field(None, min_length=1, max_length=16)
    admin_note: Optional[str] = Field(None, max_length=8000)

    @field_validator("status")
    @classmethod
    def _status_allowed(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if v not in VALID_FEEDBACK_STATUS:
            raise ValueError(f"status must be one of {sorted(VALID_FEEDBACK_STATUS)}")
        return v


class UserTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    assignee_id: int
    title: str
    completed: bool
    note: Optional[str] = None
    sort_order: int
    is_pinned: bool = False
    category: str = USER_TASK_CATEGORY_GENERAL
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    creator_username: Optional[str] = None
    assignee_username: Optional[str] = None
    attachments: List["UserTaskAttachmentRead"] = Field(default_factory=list)


class UserTaskAttachmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_task_id: int
    original_filename: str
    content_type: str
    attachment_kind: str
    size_bytes: int
    uploaded_at: datetime
    uploaded_by_user_id: Optional[int] = None


class UserTaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=USER_TASK_TITLE_MAX)
    note: Optional[str] = Field(None, max_length=USER_TASK_NOTE_MAX)
    assignee_id: Optional[int] = None
    category: str = USER_TASK_CATEGORY_GENERAL

    @field_validator("category")
    @classmethod
    def _validate_category(cls, v: str) -> str:
        vv = (v or "").strip().lower()
        if vv not in VALID_USER_TASK_CATEGORIES:
            raise ValueError(f"category must be one of {sorted(VALID_USER_TASK_CATEGORIES)}")
        return vv


class UserTaskUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=USER_TASK_TITLE_MAX)
    note: Optional[str] = Field(None, max_length=USER_TASK_NOTE_MAX)
    completed: Optional[bool] = None
    assignee_id: Optional[int] = None
    is_pinned: Optional[bool] = None
    category: Optional[str] = None

    @field_validator("category")
    @classmethod
    def _validate_category(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        vv = v.strip().lower()
        if vv not in VALID_USER_TASK_CATEGORIES:
            raise ValueError(f"category must be one of {sorted(VALID_USER_TASK_CATEGORIES)}")
        return vv


class UserTaskMove(BaseModel):
    direction: str = Field(..., min_length=1, max_length=8)

    @field_validator("direction")
    @classmethod
    def _validate_direction(cls, v: str) -> str:
        vv = v.strip().lower()
        if vv not in {"up", "down"}:
            raise ValueError("direction must be 'up' or 'down'")
        return vv


class NotificationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    type: str
    title: str
    message: str
    job_id: Optional[int] = None
    task_key: Optional[str] = None
    billed: bool
    billed_at: Optional[datetime] = None
    billed_by_user_id: Optional[int] = None
    created_at: datetime


class NotificationUpdate(BaseModel):
    billed: bool


class NotificationCountsRead(BaseModel):
    billing_unbilled_count: int = 0
    assigned_open_count: int = 0
    creator_unread_count: int = 0


class UserTaskNotificationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    recipient_user_id: int
    user_task_id: int
    event: str
    title: str
    message: str
    read: bool
    created_at: datetime


class UserTaskNotificationUpdate(BaseModel):
    read: bool


class AssignableUserRead(BaseModel):
    id: int
    username: str


class PushSubscriptionCreate(BaseModel):
    endpoint: str = Field(..., min_length=1, max_length=512)
    p256dh: str = Field(..., min_length=1, max_length=255)
    auth: str = Field(..., min_length=1, max_length=255)


class PushEnabledUpdate(BaseModel):
    push_enabled: bool


class VapidPublicKeyRead(BaseModel):
    public_key: str
