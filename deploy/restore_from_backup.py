#!/usr/bin/env python3
"""
Restore skipper SQLite DB from a backup zip exported by the backup script.

Usage (run as root or skipper on the droplet):
    python3 restore_from_backup.py /path/to/skipper-backup-YYYYMMDD-HHMMSS.zip

What it does:
  1. Extracts the database/  CSV files from the zip
  2. Creates /home/skipper/app/data/skipper.db (fresh SQLite)
  3. Imports all CSVs in dependency order
  4. Updates /home/skipper/app/.env  ->  DATABASE_URL=sqlite:///./data/skipper.db
  5. Restarts the skipper systemd service
"""
import csv
import io
import os
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
APP_ROOT   = Path("/home/skipper/app")
DB_PATH    = APP_ROOT / "data" / "skipper.db"
ENV_PATH   = APP_ROOT / ".env"
DB_URL     = "sqlite:///./data/skipper.db"

# ── Helpers ──────────────────────────────────────────────────────────────────
def parse_dt(val):
    """Parse ISO datetime string (with or without tz) → UTC-aware datetime."""
    if not val or not str(val).strip():
        return None
    val = str(val).strip()
    try:
        dt = datetime.fromisoformat(val)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None

def to_bool(val):
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() in ("1", "true", "yes", "t")

def maybe_int(val):
    if val is None or str(val).strip() == "":
        return None
    return int(val)

def read_csv(zf, name):
    data = zf.read(f"database/{name}").decode("utf-8")
    return list(csv.DictReader(io.StringIO(data)))

# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print("Usage: restore_from_backup.py <backup.zip>")
        sys.exit(1)

    zip_path = Path(sys.argv[1])
    if not zip_path.exists():
        print(f"ERROR: {zip_path} not found")
        sys.exit(1)

    # ── 1. Import SQLite via SQLAlchemy (reuses the app's own engine) ─────────
    print("Setting up SQLite engine …")
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Temporarily point DATABASE_URL at the new file so the app's engine picks it up
    os.environ["DATABASE_URL"] = f"sqlite:///{DB_PATH}"
    os.environ["APP_ENV"]      = "production"

    # Add app to path so we can import its models
    sys.path.insert(0, str(APP_ROOT / "backend"))

    from app.database import engine, Base
    from app import models  # noqa: F401 – registers all ORM classes

    print("Creating tables …")
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)

    from sqlalchemy.orm import Session

    print(f"Extracting CSVs from {zip_path} …")
    with zipfile.ZipFile(zip_path) as zf, Session(engine) as session:

        # ── users ──────────────────────────────────────────────────────────
        rows = read_csv(zf, "users.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["users"].insert().values(
                    id              = int(r["id"]),
                    username        = r["username"],
                    hashed_password = r["hashed_password"],
                    role            = r["role"],
                    is_active       = to_bool(r.get("is_active", True)),
                    created_at      = parse_dt(r.get("created_at")),
                )
            )
        session.flush()
        print(f"  users: {len(rows)}")

        # ── contacts ───────────────────────────────────────────────────────
        rows = read_csv(zf, "contacts.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["contacts"].insert().values(
                    id         = int(r["id"]),
                    label      = r.get("label") or None,
                    name       = r.get("name") or None,
                    phone      = r.get("phone") or None,
                    email      = r.get("email") or None,
                    created_at = parse_dt(r.get("created_at")),
                    updated_at = parse_dt(r.get("updated_at")),
                )
            )
        session.flush()
        print(f"  contacts: {len(rows)}")

        # ── jobs ───────────────────────────────────────────────────────────
        rows = read_csv(zf, "jobs.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["jobs"].insert().values(
                    id                   = int(r["id"]),
                    customer_name        = r["customer_name"],
                    address              = r.get("address") or None,
                    permit_status        = r.get("permit_status") or None,
                    pool_type            = r.get("pool_type") or None,
                    permit_number        = r.get("permit_number") or None,
                    field_manager        = r.get("field_manager") or None,
                    notes                = r.get("notes") or None,
                    job_type             = r.get("job_type", "new_construction"),
                    archived             = to_bool(r.get("archived", False)),
                    created_at           = parse_dt(r.get("created_at")),
                    updated_at           = parse_dt(r.get("updated_at")),
                    docs_folder_name     = r.get("docs_folder_name") or None,
                    photos_folder_name   = r.get("photos_folder_name") or None,
                    sketches_folder_name = r.get("sketches_folder_name") or None,
                    attachments_synced_at= parse_dt(r.get("attachments_synced_at")),
                )
            )
        session.flush()
        print(f"  jobs: {len(rows)}")

        # ── job_contacts ───────────────────────────────────────────────────
        rows = read_csv(zf, "job_contacts.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["job_contacts"].insert().values(
                    job_id     = int(r["job_id"]),
                    contact_id = int(r["contact_id"]),
                    sort_order = int(r.get("sort_order", 0)),
                )
            )
        session.flush()
        print(f"  job_contacts: {len(rows)}")

        # ── job_tasks ──────────────────────────────────────────────────────
        rows = read_csv(zf, "job_tasks.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["job_tasks"].insert().values(
                    id           = int(r["id"]),
                    job_id       = int(r["job_id"]),
                    task_key     = r["task_key"],
                    task_label   = r["task_label"],
                    status       = r.get("status", "not_started"),
                    value        = r.get("value") or None,
                    completed_at = parse_dt(r.get("completed_at")),
                    completed_by = r.get("completed_by") or None,
                    note         = r.get("note") or None,
                    sort_order   = int(r.get("sort_order", 0)),
                )
            )
        session.flush()
        print(f"  job_tasks: {len(rows)}")

        # ── job_type_task_templates ────────────────────────────────────────
        rows = read_csv(zf, "job_type_task_templates.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["job_type_task_templates"].insert().values(
                    id         = int(r["id"]),
                    job_type   = r["job_type"],
                    task_key   = r["task_key"],
                    task_label = r["task_label"],
                    sort_order = int(r.get("sort_order", 0)),
                    created_at = parse_dt(r.get("created_at")),
                )
            )
        session.flush()
        print(f"  job_type_task_templates: {len(rows)}")

        # ── job_documents ──────────────────────────────────────────────────
        rows = read_csv(zf, "job_documents.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["job_documents"].insert().values(
                    id                   = int(r["id"]),
                    job_id               = int(r["job_id"]),
                    title                = r["title"],
                    original_filename    = r["original_filename"],
                    stored_path          = r["stored_path"],
                    content_type         = r["content_type"],
                    category             = r.get("category", "field"),
                    size_bytes           = int(r["size_bytes"]),
                    uploaded_at          = parse_dt(r.get("uploaded_at")),
                    uploaded_by_user_id  = maybe_int(r.get("uploaded_by_user_id")),
                )
            )
        session.flush()
        print(f"  job_documents: {len(rows)}")

        # ── job_photos ─────────────────────────────────────────────────────
        rows = read_csv(zf, "job_photos.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["job_photos"].insert().values(
                    id                  = int(r["id"]),
                    job_id              = int(r["job_id"]),
                    original_filename   = r["original_filename"],
                    stored_path         = r["stored_path"],
                    content_type        = r["content_type"],
                    size_bytes          = int(r["size_bytes"]),
                    uploaded_at         = parse_dt(r.get("uploaded_at")),
                    uploaded_by_user_id = maybe_int(r.get("uploaded_by_user_id")),
                )
            )
        session.flush()
        print(f"  job_photos: {len(rows)}")

        # ── job_sketches ───────────────────────────────────────────────────
        rows = read_csv(zf, "job_sketches.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["job_sketches"].insert().values(
                    id                   = int(r["id"]),
                    job_id               = int(r["job_id"]),
                    title                = r["title"],
                    stored_json_path     = r["stored_json_path"],
                    stored_preview_path  = r["stored_preview_path"],
                    stored_bg_path       = r.get("stored_bg_path") or None,
                    grid_spacing_inches  = int(r.get("grid_spacing_inches", 3)),
                    content_version      = int(r.get("content_version", 1)),
                    created_at           = parse_dt(r.get("created_at")),
                    updated_at           = parse_dt(r.get("updated_at")),
                    created_by_user_id   = maybe_int(r.get("created_by_user_id")),
                    updated_by_user_id   = maybe_int(r.get("updated_by_user_id")),
                )
            )
        session.flush()
        print(f"  job_sketches: {len(rows)}")

        # ── job_notes ──────────────────────────────────────────────────────
        rows = read_csv(zf, "job_notes.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["job_notes"].insert().values(
                    id             = int(r["id"]),
                    job_id         = int(r["job_id"]),
                    author_user_id = int(r["author_user_id"]),
                    body           = r["body"],
                    created_at     = parse_dt(r.get("created_at")),
                )
            )
        session.flush()
        print(f"  job_notes: {len(rows)}")

        # ── feedback_items ─────────────────────────────────────────────────
        rows = read_csv(zf, "feedback_items.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["feedback_items"].insert().values(
                    id         = int(r["id"]),
                    user_id    = int(r["user_id"]),
                    kind       = r["kind"],
                    body       = r["body"],
                    status     = r.get("status", "open"),
                    admin_note = r.get("admin_note") or None,
                    created_at = parse_dt(r.get("created_at")),
                    updated_at = parse_dt(r.get("updated_at")),
                )
            )
        session.flush()
        print(f"  feedback_items: {len(rows)}")

        # ── user_tasks ─────────────────────────────────────────────────────
        rows = read_csv(zf, "user_tasks.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["user_tasks"].insert().values(
                    id           = int(r["id"]),
                    user_id      = int(r["user_id"]),
                    assignee_id  = int(r.get("assignee_id") or r["user_id"]),
                    title        = r["title"],
                    completed    = to_bool(r.get("completed", False)),
                    note         = r.get("note") or None,
                    sort_order   = int(r.get("sort_order", 0)),
                    completed_at = parse_dt(r.get("completed_at")),
                    created_at   = parse_dt(r.get("created_at")),
                    updated_at   = parse_dt(r.get("updated_at")),
                )
            )
        session.flush()
        print(f"  user_tasks: {len(rows)}")

        # ── user_task_attachments ──────────────────────────────────────────
        if f"database/user_task_attachments.csv" in zf.namelist():
            rows = read_csv(zf, "user_task_attachments.csv")
            for r in rows:
                session.execute(
                    Base.metadata.tables["user_task_attachments"].insert().values(
                        id                  = int(r["id"]),
                        user_task_id        = int(r["user_task_id"]),
                        original_filename   = r["original_filename"],
                        stored_path         = r["stored_path"],
                        content_type        = r["content_type"],
                        attachment_kind     = r["attachment_kind"],
                        size_bytes          = int(r["size_bytes"]),
                        uploaded_at         = parse_dt(r.get("uploaded_at")),
                        uploaded_by_user_id = maybe_int(r.get("uploaded_by_user_id")),
                    )
                )
            session.flush()
            print(f"  user_task_attachments: {len(rows)}")

        # ── user_task_notifications ────────────────────────────────────────
        if f"database/user_task_notifications.csv" in zf.namelist():
            rows = read_csv(zf, "user_task_notifications.csv")
            for r in rows:
                session.execute(
                    Base.metadata.tables["user_task_notifications"].insert().values(
                        id                = int(r["id"]),
                        recipient_user_id = int(r["recipient_user_id"]),
                        user_task_id      = int(r["user_task_id"]),
                        event             = r["event"],
                        title             = r["title"],
                        message           = r["message"],
                        read              = to_bool(r.get("read", False)),
                        created_at        = parse_dt(r.get("created_at")),
                    )
                )
            session.flush()
            print(f"  user_task_notifications: {len(rows)}")

        # ── push_subscriptions ─────────────────────────────────────────────
        if f"database/push_subscriptions.csv" in zf.namelist():
            rows = read_csv(zf, "push_subscriptions.csv")
            for r in rows:
                session.execute(
                    Base.metadata.tables["push_subscriptions"].insert().values(
                        id         = int(r["id"]),
                        user_id    = int(r["user_id"]),
                        endpoint   = r["endpoint"],
                        p256dh     = r["p256dh"],
                        auth       = r["auth"],
                        created_at = parse_dt(r.get("created_at")),
                    )
                )
            session.flush()
            print(f"  push_subscriptions: {len(rows)}")

        # ── notification_items ─────────────────────────────────────────────
        rows = read_csv(zf, "notification_items.csv")
        for r in rows:
            session.execute(
                Base.metadata.tables["notification_items"].insert().values(
                    id               = int(r["id"]),
                    type             = r["type"],
                    title            = r["title"],
                    message          = r["message"],
                    job_id           = maybe_int(r.get("job_id")),
                    task_key         = r.get("task_key") or None,
                    billed           = to_bool(r.get("billed", False)),
                    billed_at        = parse_dt(r.get("billed_at")),
                    billed_by_user_id= maybe_int(r.get("billed_by_user_id")),
                    created_at       = parse_dt(r.get("created_at")),
                )
            )
        session.flush()
        print(f"  notification_items: {len(rows)}")

        session.commit()
        print("  ✓ All data committed.")

    # ── 2. Update .env ────────────────────────────────────────────────────────
    print(f"\nUpdating {ENV_PATH} …")
    env_text = ENV_PATH.read_text() if ENV_PATH.exists() else ""

    # Replace or add DATABASE_URL
    if re.search(r"^DATABASE_URL\s*=", env_text, re.MULTILINE):
        env_text = re.sub(r"^DATABASE_URL\s*=.*$", f"DATABASE_URL={DB_URL}", env_text, flags=re.MULTILINE)
    else:
        env_text += f"\nDATABASE_URL={DB_URL}\n"

    # Set APP_ENV=production
    if re.search(r"^APP_ENV\s*=", env_text, re.MULTILINE):
        env_text = re.sub(r"^APP_ENV\s*=.*$", "APP_ENV=production", env_text, flags=re.MULTILINE)
    else:
        env_text += "\nAPP_ENV=production\n"

    ENV_PATH.write_text(env_text)
    print("  ✓ .env updated.")

    # ── 3. Restart service ────────────────────────────────────────────────────
    print("\nRestarting skipper service …")
    result = subprocess.run(["systemctl", "restart", "skipper"], capture_output=True, text=True)
    if result.returncode == 0:
        print("  ✓ Service restarted.")
    else:
        print(f"  ✗ Restart failed: {result.stderr}")
        sys.exit(1)

    print("\n✓ Restore complete. Site should be live.")

if __name__ == "__main__":
    main()
