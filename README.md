# Skipper Pools - Job Card Dashboard

A lightweight, local-first internal dashboard for tracking pool builds as digital job folders. Each job is a flippable card that shows a progress snapshot on the front and the full master-schedule checklist on the back.

Runs on the office PC against a local SQLite database.

---

## Features

- Responsive job-card grid: 1 column on mobile, 2 on tablet, 3 on desktop, 4 on wide screens.
- 3D card flip: front shows progress snapshot; back is the editable checklist.
- **33-step** master schedule per job (same order as `Schedules.xlsx`), plus per-task date and note.
- Status color system: Not started / In progress / Completed / Needs attention.
- Job-level notes and "needs attention" flag per task.
- New Job modal with auto-seeded default tasks (**admin** and **office** roles).
- JWT login with roles: **admin**, **office**, and **field** (field staff can update checklist and notes; document upload and job metadata follow role rules below).
- Job document uploads (PDF) with **field** vs **permit** category; job photo uploads (JPG/PNG/WEBP/GIF, plus HEIC/HEIF when optional backend dependency is installed).
- Billing milestone notifications for office/admin when certain steps are marked complete; mark items **billed** from the notifications list.
- User-submitted feedback (requests / bugs); admins can triage and reply with an admin note.
- Search by customer, address, manager, or permit number.
- SQLite-only runtime (local-first production mode).

---

## Project Structure

```
SkipperGPT/
  backend/
    app/
      main.py                 # FastAPI entry, mounts /static frontend
      config.py               # Settings via pydantic-settings
      database.py             # SQLAlchemy engine + Base + session
      models.py               # ORM: Job, JobTask, User, Feedback, notifications, …
      schemas.py              # Pydantic request/response schemas
      constants.py            # Master schedule task definitions + status enums
      auth_utils.py           # JWT + password hashing
      create_admin.py         # First admin when DB has no users
      sync_job_tasks.py       # Incremental task sync after constant changes
      reseed_job_tasks.py     # Full task row reset (destructive)
      deps/
        auth.py               # Bearer token + role dependencies
      repositories/
        jobs_repo.py          # Job/task/document SQL → main data seam
        users_repo.py
        feedback_repo.py
        notifications_repo.py
      services/
        jobs_service.py       # Progress + overall_status calculation
        job_disk_sync.py      # Import files dropped on disk into DB
        job_docs_fs.py        # PDF paths / uploads / renames
        job_photos_fs.py      # Photo paths / uploads / renames
        …
      routers/
        health.py             # GET /api/health
        auth.py               # POST /api/auth/login, GET /api/auth/me
        jobs.py               # /api/jobs CRUD + task patch
        job_documents.py      # /api/jobs/.../documents
        job_photos.py         # /api/jobs/.../photos
        users.py              # /api/users (admin)
        feedback.py           # /api/feedback
        notifications.py      # /api/notifications (office/admin)
      seed.py                 # python -m app.seed …
      schedule_excel.py       # Parses Schedules.xlsx → Job / JobTask rows
    requirements.txt
  frontend/
    index.html
    styles.css
    app.js
  data/                       # SQLite file lives here (gitignored)
  .env.example
  launch.bat                  # Starts uvicorn; optional ngrok
  .gitignore
  README.md
```

The frontend talks ONLY to `/api/*` routes. It never touches the database.

---

## Setup (Windows office PC)

Prerequisites: Python 3.12 recommended (for optional HEIC uploads), plus Python launcher (`py`).

Quick start (recommended):

```powershell
# from the project root: D:\SkipperGPT
cd backend
.\setup-backend.ps1
```

Manual setup:

```powershell
# from the project root: D:\SkipperGPT
cd backend
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
pip install -r requirements-heic.txt
```

`requirements-heic.txt` is optional. If it fails to install on your platform/Python, the app still runs, but HEIC uploads are rejected with a clear API message.

Copy the env template:

```powershell
# from project root
copy .env.example .env
```

(Defaults are fine for local SQLite.)

### First login (JWT)

Nearly all `/api/*` routes require `Authorization: Bearer <access_token>`. Exceptions: **`GET /api/health`** and **`POST /api/auth/login`**.

Create the first admin if the database has no users yet (from `backend\` with venv active):

```powershell
python -m app.create_admin YOUR_USERNAME YOUR_PASSWORD
```

Alternatively, combine with seeding:

```powershell
python -m app.seed --ensure-admin YOUR_USERNAME YOUR_PASSWORD
```

Log in via **`POST /api/auth/login`** (OAuth2 password form: `username`, `password`). The UI stores the token and sends it on subsequent requests.

### Master schedule import (`Schedules.xlsx`)

Place your **`Schedules.xlsx`** in the project root (next to this `README.md`), with a sheet named **`Schedules`**. Row 1 must use the same column titles as `_SCHEDULE_SHEET_HEADERS` in **`backend/app/schedule_excel.py`** (**33 columns**, one task per column—for example **Permit Application**, **Quality Inspection (QI) 1**, **Electrical Inspection** for the column that displays as **PSI Inspection** in the app, … through **Final Inspection** maps to label **Final Inspections**). The in-app labels are defined in `backend/app/constants.py` (`TASK_DEFINITIONS`). Date cells become completed tasks; long text becomes in-progress with the text stored on the task.

- First run (empty database): `python -m app.seed` loads from Excel if the file exists; otherwise it uses four built-in demo jobs.
- **Replace everything with a fresh import from the spreadsheet** (destructive): `python -m app.seed --reset`
- Force demo data only: `python -m app.seed --sample`
- Custom file path: `python -m app.seed --reset --excel "D:\path\to\Schedules.xlsx"`

Override the default file location anytime with `SCHEDULE_XLSX_PATH` in `.env` (see `.env.example`).

### Updating existing jobs after task definition changes

When you add a new task to `backend/app/constants.py` or rename an existing label, use the incremental sync command:

- Preview changes only: `python -m app.sync_job_tasks --dry-run`
- Apply incremental updates: `python -m app.sync_job_tasks`
- Also remove old task keys no longer in `TASK_DEFINITIONS`: `python -m app.sync_job_tasks --prune-removed`

`app.sync_job_tasks` preserves existing task progress (`status`, `value`, `completed_at`, `completed_by`, `note`) and only adds missing tasks plus updates labels/sort order. Keep `python -m app.reseed_job_tasks` for intentional full resets, because it deletes and recreates every task row.

Run the app:

```powershell
# from backend\, with venv activated
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The root **`launch.bat`** starts the server on **`127.0.0.1:8000`** and opens the browser; use `--host 0.0.0.0` manually if other machines on the LAN need to connect.

For backend-only startup with dependency sync on every launch, run **`backend\start-backend.bat`** (or `backend/start-backend.ps1`). It checks/installs `backend/requirements.txt` before starting Uvicorn.

Open http://localhost:8000 in your browser.

The SQLite file is created automatically at `data/skipper.db` on first run.

### Backup export/import (move data to another machine)

Use the root launcher script to bundle and restore local data:

```powershell
# from project root
backup-data.bat export
```

This creates a zip in `backups/` (for example `backups/skipper-backup-20260508-160000.zip`) containing:
- `database/skipper.db` (jobs, **all user accounts** including password hashes, docs/photos metadata, and every other app table)
- `exports/users_manifest.json` (read-only list of usernames/roles for sanity-checking the backup; logins are restored from the database file above)
- `files/Docs/**`
- `files/Photos/**`
- `manifest.json` (includes `user_count`)

Import on another machine (with the same project + backend venv setup):

```powershell
# from project root
backup-data.bat import "D:\Backups\skipper-backup-20260508-160000.zip"
```

Import behavior:
- Creates a safety pre-import backup in `backups/pre-import-*.zip` by default.
- Restores `data/skipper.db`, `Docs/`, and `Photos/` from the archive.
- Refuses malformed archives (missing `manifest.json` or required paths).

Optional flags:
- Custom export destination: `backup-data.bat export --output "D:\Backups\my-export.zip"`
- Skip safety backup on import: `backup-data.bat import "<zip>" --skip-pre-backup`

### Job Docs and Photos folders

Uploaded PDFs and images are stored under the configured **`DOCS_ROOT`** (defaults to the project root; see `backend/app/config.py`). Each job has stable folder names stored on the row (`docs_folder_name`, `photos_folder_name`), derived from the customer name (sanitized for Windows paths). If two jobs would share the same base name, the folder ends with `__<job_id>` so paths stay unique.

- **`Docs/<folder_name>/`** — PDFs only
- **`Photos/<folder_name>/`** — JPG, PNG, WEBP, GIF

When you create a job or load the job list or job detail in the app, the server ensures those directories exist and **imports any valid files you placed there manually** into the database so they appear alongside uploads.

Each job in the API includes **`docs_rel_path`** and **`photos_rel_path`** (for example `Docs/Anderson_Residence` and `Photos/Anderson_Residence`) so you know exactly where to copy files relative to `DOCS_ROOT`.

### Launching with ngrok (public URL)

Double-click **`launch.bat`** in the project root and answer **`Y`** at the `Launch with ngrok (skipper.ngrok.app)? [y/N]:` prompt. The launcher starts the app and opens **`https://skipper.ngrok.app/`** via the permanent ngrok tunnel (`ngrok http 8000 --url=https://skipper.ngrok.app`). Press **Enter** or **`N`** to open the app locally only (`http://127.0.0.1:8000/`).

Requires **`ngrok`** on your PATH, **`ngrok config add-authtoken`** (or equivalent) once, and the reserved domain **`skipper.ngrok.app`** on your ngrok account. If ngrok is missing from PATH, the script falls back to the local URL with a message.

---

## API Reference

Send `Authorization: Bearer <token>` on protected routes (obtained from **`POST /api/auth/login`**). Errors usually return JSON with a **`detail`** field; validation errors (`422`) use FastAPI’s list-of-errors shape for **`detail`**.

### Auth & users

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/auth/login` | OAuth2 password form (`username`, `password`) → `{ access_token, token_type }` |
| GET | `/api/auth/me` | Current user profile |
| GET | `/api/users` | List users (**admin**) |
| POST | `/api/users` | Create user (**admin**) |
| PATCH | `/api/users/{id}` | Update user (**admin**) |
| DELETE | `/api/users/{id}` | Delete user (**admin**; cannot delete self) |

### Jobs & tasks

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/health` | Liveness check; returns DB dialect and env name (**no auth**) |
| GET | `/api/jobs` | List jobs; query `include_archived=true` to include archived |
| GET | `/api/jobs/{id}` | Single job with tasks + progress |
| POST | `/api/jobs` | Create a job (**admin**, **office**); auto-seeds **33** default tasks |
| PATCH | `/api/jobs/{id}` | Partial update. **Field** role may only change **`notes`**. **Admin** only for **archive**/unarchive. |
| PATCH | `/api/jobs/{id}/tasks/{task_key}` | Update one task: `status`, `value`, `note`, `completed_by` |

### Documents & photos

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/jobs/{id}/documents` | List PDF documents |
| POST | `/api/jobs/{id}/documents` | Multipart: one or more **`files`**, optional **`title`** (single-file), **`category`** = `field` or `permit` (**admin**, **office**) |
| PATCH | `/api/jobs/{id}/documents/{docId}` | Rename document (`title`) (**admin**, **office**) |
| GET | `/api/jobs/{id}/documents/{docId}/file` | Download PDF |
| DELETE | `/api/jobs/{id}/documents/{docId}` | Delete document (**admin**, **office**) |
| GET | `/api/jobs/{id}/photos` | List photos |
| POST | `/api/jobs/{id}/photos` | Upload one image (any authenticated user) |
| GET | `/api/jobs/{id}/photos/{photoId}/file` | Download image |
| DELETE | `/api/jobs/{id}/photos/{photoId}` | Delete photo (any authenticated user) |

### Feedback & notifications

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/feedback` | Submit feedback (`kind`: `request` or `bug`, `body`) |
| GET | `/api/feedback/mine` | List current user’s submissions |
| GET | `/api/feedback` | List all (**admin**) |
| PATCH | `/api/feedback/{id}` | Admin update (`status`, `admin_note`) |
| GET | `/api/notifications` | List notifications (**admin**, **office**) |
| PATCH | `/api/notifications/{id}` | Set **`billed`** on a notification (**admin**, **office**) |

### Job response shape

```json
{
  "id": 1,
  "customer_name": "Anderson Residence",
  "address": "123 Lakeview Dr, Tampa, FL 33602",
  "pool_type": "PS",
  "permit_status": "Issued",
  "permit_number": "HC-2026-018473",
  "field_manager": "Jorge Ramirez",
  "notes": "Homeowner prefers morning crews.",
  "archived": false,
  "created_at": "2026-02-01T10:00:00Z",
  "updated_at": "2026-04-22T14:13:00Z",
  "tasks": [
    {
      "id": 17,
      "task_key": "permit_application",
      "task_label": "Permit Application",
      "status": "completed",
      "value": "2026-02-01",
      "completed_at": "2026-02-01T10:00:00Z",
      "completed_by": null,
      "note": null,
      "sort_order": 0
    }
  ],
  "progress": {
    "completed": 14,
    "total": 33,
    "percent": 42,
    "latest_label": "Tile",
    "latest_completed_at": "2026-03-25T00:00:00Z"
  },
  "overall_status": "in_progress",
  "documents": [],
  "photos": [],
  "docs_rel_path": "Docs/Anderson_Residence",
  "photos_rel_path": "Photos/Anderson_Residence"
}
```

Documents include **`category`** (`field` | `permit`), **`uploaded_by_user_id`**, and **`uploaded_by_username`** when available. Photos similarly include uploader fields.

### Task `status` values

| Value | Meaning | Color |
| ----- | ------- | ----- |
| `not_started` | Default state | Gray |
| `in_progress` | Scheduled / WIP | Blue |
| `completed` | Done | Green |
| `issue` | Needs attention | Red |

When a task is set to `completed`, the server stamps `completed_at` automatically. Unchecking it clears the timestamp.

---

## Master Schedule (default tasks)

Every new job is seeded with these **33** tasks in this order (labels as shown in the app; Excel headers may differ slightly—see `schedule_excel.py`):

1. Permit Application  
2. Permit Received  
3. Excavation  
4. Form & Steel  
5. QI 1  
6. Shell Bonding Inspection  
7. Shell Steel Inspection  
8. Rough Plumbing Inspection  
9. Gunite  
10. QI 2  
11. Survey  
12. Backfill  
13. Plumbing  
14. QI 3  
15. PSI Inspection  
16. Coping  
17. Tile  
18. QI 4  
19. Rail Anchor/Grid Inspection  
20. Footer/Deck Inspection  
21. Footer/Sub-Deck Installation  
22. Paver Installation  
23. QI 5  
24. Equipment Installation  
25. Equipment Wiring  
26. QI 6  
27. Screen/Fence  
28. Electric Inspection  
29. Safety Inspection  
30. Plaster  
31. Startup  
32. Final QI  
33. Final Inspections  

Job-level "Notes / issue" notes go on the `jobs.notes` field and render at the top of the card back.

---

## Cloud Deploy Notes (Paused)

Hosted Postgres/Supabase deployment work is intentionally paused while the app
operates in local production mode (SQLite + ngrok). Existing migration helpers
remain in the repository for future investigation.

---

## Configuration

`backend/app/config.py` reads from `.env` at the project root via `pydantic-settings` (env names are case-insensitive).

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `APP_ENV` | `local` | Tagged in `/api/health`; informational |
| `DATABASE_URL` | `sqlite:///./data/skipper.db` | SQLite URL used by the app runtime |
| `DOCS_ROOT` | project root | PDF/photo filesystem root (`Path`) |
| `MAX_UPLOAD_MB` | `25` | Per-upload size limit |
| `SCHEDULE_XLSX_PATH` | *(unset)* | Optional full path to `Schedules.xlsx` |
| `SECRET_KEY` | `dev-only-change-me` | JWT signing secret; set a long random value in production |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `259200` (~180 days) | Browser UI keeps the token in `localStorage`; shorten for local testing |

Relative SQLite paths are auto-resolved against the project root, so the path works regardless of the directory uvicorn is launched from.

### Job files on disk

- PDF docs: `{docs_root}/Docs/<folder_name>/...`
- Photos: `{docs_root}/Photos/<folder_name>/...`
- By default `docs_root` is the project root, so folders appear as `Docs/` and `Photos/` at the root.

---

## Out of scope (intentionally, for now)

- OAuth / SSO / external identity providers
- Email or SMS notifications
- Webhooks
- Google Tasks / Calendar integration
- Push alerts

The schema already has `completed_by` on `job_tasks`, so richer attribution can grow without breaking the core model.

---

## Troubleshooting

- **401 Unauthorized / "Could not validate credentials"**: log in via **`POST /api/auth/login`**, or create the first admin with `python -m app.create_admin …`. Ensure the UI sends the `Authorization: Bearer …` header.
- **Page is blank / 404**: confirm uvicorn is running and you opened http://localhost:8000 (or http://127.0.0.1:8000). Check the terminal for errors.
- **`No module named 'app'`**: run uvicorn from the `backend/` directory, with the venv activated.
- **HEIC upload says processing is unavailable**: run the backend in a Python 3.12 venv and install optional deps: `pip install -r backend/requirements-heic.txt`.
- **`/api/health` works but no jobs render**: run `python -m app.seed` once (after logging in if using the UI), or create a job from the UI.
- **Reset the local DB**: stop the server, delete `data/skipper.db`, restart, run `create_admin` / `seed` as needed.
- **`ERR_NGROK_3200` / “endpoint is offline” on `skipper.ngrok.app`**: the ngrok agent is not connected for that URL. Confirm the **`Skipper Pools ngrok`** window stays open (the launcher runs ngrok under `cmd /k` so errors are not lost) and shows no failure text, uvicorn is running on port 8000, and the tunnel command is `ngrok http 8000 --url=https://skipper.ngrok.app` (port before `--url`, full `https://` URL). See [ngrok: ERR_NGROK_3200](https://ngrok.com/docs/errors/err_ngrok_3200) and your [endpoints dashboard](https://dashboard.ngrok.com/endpoints).
